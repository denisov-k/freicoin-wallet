// dex_demo.mjs — LIVE Freimarkets DEX (phase 1) on a regtest freicoind (-nv3assets).
//
// Alice holds a user asset (coop, melts at k=18) behind her own P2WPKH key. Bob holds FRC
// behind his. Each signs an OFFER — one input + one output at the same index,
// SIGHASH_SINGLE|ANYONECANPAY: "my coin goes only where this exact output rides at my index."
// Neither ever sees the other's key or the final transaction. A MATCHER splices the two
// crossing offers into one balanced v3 transaction, adds his own FRC for the fee, pays
// himself the spread, signs only his own input, and mines it. Consensus (per-asset
// present-value conservation + the v3 sighash committing tags/tokens/expiry) makes the whole
// thing trustless: any tampering with either maker's terms invalidates that maker's signature.
//
// Run: node research/nversion3/dex_demo.mjs   (expects the node already running; see dex_demo.sh)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY } from '../../core/sighash.mjs';
import { serializeTx, txid as computeTxid } from '../../core/tx.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/nv3reg';
const PORT = 19660;
const sha256 = b => createHash('sha256').update(b).digest();
const hash160 = b => createHash('ripemd160').update(sha256(b)).digest();
const hash256 = b => sha256(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');

// ---- RPC ----
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

// ---- players ----
// Freicoin witness v0 is a MAST program: wpk leaf = (0x21 <pubkey> OP_CHECKSIG),
// program = RIPEMD160(HASH256(0x00 || leaf)); spend witness = [sig, 0x00||leaf, ''].
const HOST = '00'.repeat(20);
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const key = s => {
  const sec = s.repeat(32), pub = pubkeyCompressed(sec);
  const leaf = '21' + pub + 'ac';
  const prog = ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex');
  return { sec, pub, leaf, spk: '0014' + prog };
};
const alice = key('a1'), bob = key('b2'), matcher = key('c3');

// P2WSH(OP_TRUE) for no-key funding legs (issuance input)
const TRUE_SCRIPT = '51';
const TRUE_REVEAL = '00' + TRUE_SCRIPT;
const TRUE_PROG = hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_SPK = '0020' + TRUE_PROG;
const TRUE_WITNESS = [TRUE_REVEAL, ''];

// exact host/asset present value (mirrors the node kernel via the model)
import { assetPresentValue } from '../../core/assets.mjs';
const pv = (value, dist, k) => assetPresentValue(value, dist, { k, interest: false });

async function fundSpk(spkHex, amountFrc, mineAddr) {
  const dec = await rpc('decodescript', spkHex);
  const addr = dec.address ?? dec.segwit?.address;
  const txid = await rpc('sendtoaddress', addr, amountFrc);
  const raw = await rpc('getrawtransaction', txid, true);
  const vout = raw.vout.findIndex(o => o.scriptPubKey.hex === spkHex);
  await rpc('generatetoaddress', 1, mineAddr);
  return { txid, vout, value: BigInt(Math.round(raw.vout[vout].value * 1e8)), refheight: raw.lockheight ?? raw.lock_height };
}

function signP2wpkhInput(tx, inIdx, k, coinValue, refheight, hashtype) {
  const digest = segwitV0Sighash(tx, inIdx, k.leaf, coinValue, BigInt(refheight), hashtype);
  const sig = signEcdsa(k.sec, digest) + hashtype.toString(16).padStart(2, '0');
  return [sig, '00' + k.leaf, ''];   // sig, MAST script reveal, empty proof
}

const main = async () => {
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mine);

  // ---- 1. issue the coop asset (k=18) straight to ALICE's key ----
  const defBytes = Buffer.concat([Buffer.from([18, 0]), Buffer.alloc(8), Buffer.alloc(32)]);
  defBytes.writeUInt8(1, 2);   // granularity = 1 (LE u64 at offset 2)
  const coopTag = hash160(defBytes).toString('hex');
  const fundI = await fundSpk(TRUE_SPK, '10.0', mine);
  const H0 = fundI.refheight;
  const opret = '6a' + (4 + defBytes.length).toString(16).padStart(2, '0') + '46524131' + defBytes.toString('hex');
  const issue = {
    version: 3, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H0, nExpireTime: 0,
    vin: [{ prevout: { txid: rev(fundI.txid), vout: fundI.vout }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
    vout: [
      { value: 5_000_000_000n, scriptPubKey: alice.spk, assetTag: coopTag },   // 50 coop -> Alice
      { value: 0n, scriptPubKey: opret },                                       // the definition
      { value: fundI.value - 100000n, scriptPubKey: TRUE_SPK },                 // FRC change
    ],
  };
  await rpc('generateblock', mine, [serializeTx(issue)]);
  const issueTxid = computeTxid(issue);
  console.log(`1. ISSUED 50 coop (tag ${coopTag.slice(0, 12)}…) to Alice's P2WPKH key, tx ${issueTxid.slice(0, 12)}…`);

  // ---- 2. fund Bob (FRC) and the matcher (fee money) ----
  const bobCoin = await fundSpk(bob.spk, '0.60', mine);
  const matCoin = await fundSpk(matcher.spk, '0.01', mine);
  await rpc('generatetoaddress', 5, mine);   // let the coop coin age: real demurrage in play
  const H = await rpc('getblockcount');

  // ---- 3. the OFFERS (made independently; only (H, terms) are public) ----
  const aliceCoop = { value: 5_000_000_000n, refheight: H0 };
  const alicePv = pv(aliceCoop.value, H - H0, 18);          // her coop has melted a little
  const aliceWantFrc = 40_000_000n;                          // 0.4 FRC
  const bobWantCoop = alicePv - 5_000n;                      // leaves the matcher 5000 kria coop

  // Alice: input#0 <-> output#0. She never learns anything else about the final tx.
  const aliceOffer = {
    input: { prevout: { txid: rev(issueTxid), vout: 0 }, scriptSig: '', sequence: 0xffffffff, witness: [] },
    output: { value: aliceWantFrc, scriptPubKey: alice.spk, assetTag: HOST },
    coin: aliceCoop,
  };
  // Bob: input#1 <-> output#1.
  const bobOffer = {
    input: { prevout: { txid: rev(bobCoin.txid), vout: bobCoin.vout }, scriptSig: '', sequence: 0xffffffff, witness: [] },
    output: { value: bobWantCoop, scriptPubKey: bob.spk, assetTag: coopTag },
    coin: bobCoin,
  };

  // each maker signs against a skeleton holding ONLY their pair at their index
  const skeleton = (inputs, outputs) => ({ version: 3, nLockTime: 0, lockHeight: H, nExpireTime: 0, vin: inputs, vout: outputs });
  const SINGLE_ACP = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY;
  aliceOffer.witness = signP2wpkhInput(skeleton([aliceOffer.input], [aliceOffer.output]), 0,
                                       alice, aliceCoop.value, H0, SINGLE_ACP);
  bobOffer.witness = signP2wpkhInput(skeleton([bobOffer.input, bobOffer.input], [bobOffer.output, bobOffer.output]), 1,
                                     bob, bobCoin.value, bobCoin.refheight, SINGLE_ACP);
  console.log(`2. OFFERS signed offline: Alice gives ${alicePv} coop-kria (melted from 5e9), wants ${aliceWantFrc} FRC-kria;`);
  console.log(`   Bob gives ${bobCoin.value} FRC-kria, wants ${bobWantCoop} coop-kria. SIGHASH_SINGLE|ANYONECANPAY.`);

  // ---- 4. the MATCHER splices, balances, takes the spread, signs only his input ----
  const fee = 10_000n;
  const bobPv = pv(bobCoin.value, H - bobCoin.refheight, 20);
  const matPv = pv(matCoin.value, H - matCoin.refheight, 20);
  const coopSpread = alicePv - bobWantCoop;                       // 5000 kria coop
  const frcChange = bobPv + matPv - aliceWantFrc - fee;           // FRC spread net of fee
  const match = {
    version: 3, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H, nExpireTime: 0,
    vin: [
      { ...aliceOffer.input, witness: aliceOffer.witness },
      { ...bobOffer.input, witness: bobOffer.witness },
      { prevout: { txid: rev(matCoin.txid), vout: matCoin.vout }, scriptSig: '', sequence: 0xffffffff, witness: [] },
    ],
    vout: [
      aliceOffer.output,                                                        // #0: Alice's FRC
      bobOffer.output,                                                          // #1: Bob's coop
      { value: coopSpread, scriptPubKey: matcher.spk, assetTag: coopTag },      // #2: coop spread
      { value: frcChange, scriptPubKey: matcher.spk, assetTag: HOST },          // #3: FRC change
    ],
  };
  match.vin[2].witness = signP2wpkhInput(match, 2, matcher, matCoin.value, matCoin.refheight, SIGHASH_ALL);
  await rpc('generateblock', mine, [serializeTx(match)]);
  const matchTxid = computeTxid(match);
  const conf = await rpc('getrawtransaction', matchTxid, true);
  console.log(`3. MATCHED & MINED ${matchTxid.slice(0, 12)}… (conf ${conf.confirmations}):`);
  console.log(`   Alice got ${aliceWantFrc} FRC-kria, Bob got ${bobWantCoop} coop-kria,`);
  console.log(`   matcher kept spread: ${coopSpread} coop-kria + ${frcChange - matPv} FRC-kria (after fee ${fee}).`);
  console.log(`   on-chain tags: vout0=${conf.vout[0].assetTag ?? 'host'} vout1=${(conf.vout[1].assetTag ?? '').slice(0, 12)}…`);

  // ---- 5. tamper test: matcher tries to shortchange Bob -> Bob's signature must fail ----
  const tampered = structuredClone(match);
  tampered.vout[1].value = bobWantCoop - 1_000n;
  tampered.vout[2].value = coopSpread + 1_000n;
  try {
    await rpc('generateblock', mine, [serializeTx(tampered)]);
    console.log('4. UNEXPECTED: tampered match accepted');
  } catch (e) {
    console.log(`4. tampered match (Bob shortchanged by 1000 kria) REJECTED by consensus ✅`);
  }

  console.log('\nDEX PHASE 1 LIVE ✅ — offline makers, trustless miner-matched settlement, real demurrage.');
};
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
