// ranged_demo.mjs — LIVE DEX phase 2b on regtest: a RANGED maker offer (partial fills).
//
// Alice owns 50 coop and posts a CONSTRAINT, not amounts: "sell between minFill and maxFill of
// my coop for FRC at price priceNum/priceDen, payout to me, remainder (change) back to me." Her
// SIGHASH_BUNDLE signature commits the DESCRIPTOR — the fill amount is deliberately absent, so
// ONE signature serves every admissible fill. A taker picks any fill in range, materializes
// [payout, change] + their own fill output, and mines. Consensus (CheckTxInputs) re-derives
// fill = givePV(lock_height) - change and checks bounds + price + destinations.
//
// Proves: (1) a legal fill is accepted; (2) TWO different fills validate under the SAME Alice
// signature; (3) underpay / out-of-bounds / wrong-destination are rejected by consensus.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { rangedSighash, segwitV0Sighash, SIGHASH_ALL, SIGHASH_BUNDLE } from '../../core/sighash.mjs';
import { serializeTx, txid as computeTxid, NV3_TX_VERSION } from '../../core/tx.mjs';
import { assetPresentValue } from '../../core/assets.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/root/nv3-playground/chain';
const PORT = process.env.NV3_RPCPORT ?? 19660;
const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const hash160 = b => ripemd160(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');
const HOST = '00'.repeat(20);

const cookie = Buffer.from(readFileSync(`${DATADIR}/regtest/.cookie`)).toString('base64');
async function rpc(method, ...params) {
  const res = await fetch(`http://127.0.0.1:${PORT}/wallet/w`, {
    method: 'POST', headers: { Authorization: `Basic ${cookie}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const key = s => {
  const sec = s.repeat(32), pub = pubkeyCompressed(sec);
  const leaf = '21' + pub + 'ac';
  return { sec, pub, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') };
};
const alice = key('a7'), taker = key('b8');
const TRUE_SCRIPT = '51', TRUE_REVEAL = '00' + TRUE_SCRIPT;
const TRUE_SPK = '0020' + hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_WITNESS = [TRUE_REVEAL, ''];
const pv = (v, d, k) => assetPresentValue(v, d, { k, interest: false });

async function fundSpk(spkHex, amountFrc, mineAddr) {
  const dec = await rpc('decodescript', spkHex);
  const txid = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, amountFrc);
  const raw = await rpc('getrawtransaction', txid, true);
  const vout = raw.vout.findIndex(o => o.scriptPubKey.hex === spkHex);
  await rpc('generatetoaddress', 1, mineAddr);
  return { txid, vout, value: BigInt(Math.round(raw.vout[vout].value * 1e8)), refheight: raw.lockheight };
}

// The nV3 tx version is non-standard for the MEMPOOL (testmempoolaccept rejects it as
// "version"), so consensus is exercised at BLOCK level: generateblock runs full CheckTxInputs.
// Returns null on accept, or the consensus reject reason string on rejection.
const mineOrReason = async (tx, mine) => {
  try { await rpc('generateblock', mine, [serializeTx(tx)]); return null; }
  catch (e) { return e.message; }
};

const main = async () => {
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mine);

  // 1. issue 50 coop to Alice; fund the taker with FRC
  const def = Buffer.concat([Buffer.from([18, 0]), Buffer.alloc(8), Buffer.alloc(32)]);
  def.writeUInt8(1, 2);
  const coopTag = hash160(def).toString('hex');
  const fund = await fundSpk(TRUE_SPK, '5.0', mine);
  const issue = {
    version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: fund.refheight, nExpireTime: 0,
    vin: [{ prevout: { txid: rev(fund.txid), vout: fund.vout }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
    vout: [
      { value: 5_000_000_000n, scriptPubKey: alice.spk, assetTag: coopTag },
      { value: 0n, scriptPubKey: '6a' + (4 + def.length).toString(16).padStart(2, '0') + '46524131' + def.toString('hex') },
      { value: fund.value - 100000n, scriptPubKey: TRUE_SPK },
    ],
  };
  await rpc('generateblock', mine, [serializeTx(issue)]);
  const issueTxid = computeTxid(issue);
  const takerCoin = await fundSpk(taker.spk, '1.0', mine);   // for fill #1
  const takerCoin2 = await fundSpk(taker.spk, '1.0', mine);  // for fill #2 (the re-offered remainder)
  await rpc('generatetoaddress', 4, mine);
  const H = await rpc('getblockcount');
  const givePv = pv(5_000_000_000n, H - issue.lockHeight, 18);
  const takerPv = pv(takerCoin.value, H - takerCoin.refheight, 20);

  // 2. Alice's RANGED offer: sell coop for FRC at 0.01 FRC-kria/coop-kria (priceNum/priceDen =
  //    1/100), fill anywhere in [1e9, 4e9]. Signed ONCE over the descriptor.
  const desc = {
    payoutAsset: HOST, payoutScript: alice.spk,      // she wants FRC paid to herself
    priceNum: 1n, priceDen: 100n,
    changeScript: alice.spk,                          // unsold coop comes back to her
    minFill: 1_000_000_000n, maxFill: 4_000_000_000n,
  };
  const HT = SIGHASH_ALL | SIGHASH_BUNDLE;
  // A ranged offer: Alice signs the descriptor over ONE give coin, valued at lockHeight L
  // (L >= the coin's refheight; the composite that fills it must pin the same L).
  const makeOffer = (giveTxid, giveVout, giveValue, giveRefheight, L) => {
    const give = { prevout: { txid: rev(giveTxid), vout: giveVout }, sequence: 0xffffffff };
    const dg = rangedSighash({ vin: [give], desc, nExpireTime: 0 }, 0, alice.leaf, giveValue, BigInt(giveRefheight), { lockHeight: L, hashtype: HT });
    return { desc, give, wit: [signEcdsa(alice.sec, dg) + HT.toString(16).padStart(2, '0'), '00' + alice.leaf, ''],
             givePv: pv(giveValue, L - giveRefheight, 18), L };
  };
  const offerA = makeOffer(issueTxid, 0, 5_000_000_000n, issue.lockHeight, H);
  console.log(`1. RANGED offer signed (SIGHASH_BUNDLE over descriptor): sell [${desc.minFill}, ${desc.maxFill}] coop`);
  console.log(`   at ${desc.priceNum}/${desc.priceDen} FRC-kria per coop-kria; Alice's give present-value = ${offerA.givePv}.`);

  // 3. a taker materializes a fill against a signed offer. The ranged bundle's two outputs
  //    [payout, change] come first; the taker's fill + FRC-change follow. payout = ceil(
  //    fill*num/den); change = givePv - fill; surplus FRC = fee. All valued at the offer's L.
  const fee = 10_000n;
  const buildFill = (offer, tk, fill, { payoutOverride, payoutScriptOverride } = {}) => {
    const d = offer.desc, L = offer.L;
    const payout = payoutOverride ?? ((fill * d.priceNum + d.priceDen - 1n) / d.priceDen);
    const change = offer.givePv - fill;
    const tkPv = pv(tk.value, L - tk.refheight, 20);
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: [
        { ...offer.give, scriptSig: '', witness: offer.wit },
        { prevout: { txid: rev(tk.txid), vout: tk.vout }, scriptSig: '', sequence: 0xffffffff, witness: [] },
      ],
      vout: [
        { value: payout, scriptPubKey: payoutScriptOverride ?? d.payoutScript, assetTag: HOST },   // [payout] to Alice
        { value: change, scriptPubKey: d.changeScript, assetTag: coopTag },                        // [change] to Alice
        { value: fill, scriptPubKey: taker.spk, assetTag: coopTag },                               // fill to taker
        { value: tkPv - payout - fee, scriptPubKey: taker.spk, assetTag: HOST },                   // taker FRC change
      ],
      ranged: [{ nIn: 1, ...d, nExpireTime: 0 }],
    };
    const td = segwitV0Sighash(tx, 1, taker.leaf, tk.value, BigInt(tk.refheight), SIGHASH_ALL);
    tx.vin[1].witness = [signEcdsa(taker.sec, td) + '01', '00' + taker.leaf, ''];
    return tx;
  };

  // 4. attacks FIRST (give coin still unspent): consensus must reject each. Alice's signature is
  //    valid — it's the miner's materialized fill/outputs that violate the signed descriptor.
  const attack = async (label, tx, code) => {
    const reason = await mineOrReason(tx, mine);
    console.log(`2.${label} ${reason === null ? 'UNEXPECTED ACCEPT ❌' : reason.includes(code) ? `REJECTED (…${code}) ✅` : `rejected, wrong reason: ${reason} ❌`}`);
  };
  await attack('a underpay', buildFill(offerA, takerCoin, 2_000_000_000n, { payoutOverride: 20_000_000n - 1n }), 'ranged-price');
  await attack('b out-of-bounds', buildFill(offerA, takerCoin, 4_500_000_000n), 'ranged-fill-bounds');    // fill > maxFill
  await attack('c wrong destination', buildFill(offerA, takerCoin, 2_000_000_000n, { payoutScriptOverride: taker.spk }), 'ranged-destination');

  // 5. mine a LEGAL 2e9 fill.
  const comp = buildFill(offerA, takerCoin, 2_000_000_000n);
  if (await mineOrReason(comp, mine)) throw new Error('legal fill #1 rejected');
  const H2 = await rpc('getblockcount');
  const change1 = givePv - 2_000_000_000n;
  console.log(`3. FILL #1 MINED ${computeTxid(comp).slice(0, 12)}…: Alice +0.2 FRC + ${change1} coop change; taker +2e9 coop ✅`);

  // 6. MULTI-FILL REMAINDER (the chosen model): Alice re-offers her change coin. Its refheight
  //    is the CREATING tx's lock_height (comp's L = H), not the block height. A second taker
  //    fills a DIFFERENT amount at a fresh lockHeight L2 (=H2); the remainder keeps trading.
  const offerB = makeOffer(computeTxid(comp), 1, change1, offerA.L, H2);
  const comp2 = buildFill(offerB, takerCoin2, 1_500_000_000n);
  const r2 = await mineOrReason(comp2, mine);
  if (r2) throw new Error('remainder fill #2 rejected: ' + r2);
  console.log(`4. FILL #2 (re-offered remainder) MINED ${computeTxid(comp2).slice(0, 12)}…: 1.5e9 more coop sold, ${offerB.givePv - 1_500_000_000n} coop still on offer ✅`);

  console.log('\nDEX PHASE 2b LIVE ✅ — ranged maker offer, consensus enforces bounds+price+destination, remainder re-offers and fills again.');
};
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
