// ladder_offline_e2e.mjs — LIVE proof of the OFFLINE-MAKER pre-signed ladder (DEX phase 2b).
//
// The ranged digest pins lock_height (mutation-fuzzer mandated), and consensus demands
// tx.lock_height >= every input's refheight — so an offer signed once at height H slowly
// becomes unbuyable: any coin minted after H is "too young" to pay with. The wallet solves
// this by pre-signing a LADDER of rungs on the absolute LADDER_STEP grid; the relay serves
// the highest rung <= tip. This script proves the whole loop with the maker OFFLINE:
//
//   1. issue an asset to the maker, post a ranged offer with a 7-rung ladder, maker goes dark
//   2. advance the chain well past the posting height; fund the taker with FRESH coins
//      (refheight > posting height — the exact coins a ladderless offer cannot accept)
//   3. NEGATIVE: fill pinned at the POSTING rung with those coins -> bad-txns-non-monotonic-lock-height
//   4. POSITIVE: fill at the relay-served CURRENT rung (maker still dark) -> accepted
//   5. the remainder repoints to the change coin with needsResign=true (maker re-ladders on return)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { segwitV0Sighash, rangedSighash, SIGHASH_ALL, SIGHASH_BUNDLE } from '../../core/sighash.mjs';
import { serializeTx, txid as computeTxid } from '../../core/tx.mjs';
import { assetPresentValue } from '../../core/assets.mjs';

const DATADIR = '/root/nv3-playground/chain';
const cookie = Buffer.from(readFileSync(`${DATADIR}/regtest/.cookie`)).toString('base64');
const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const rev = h => Buffer.from(h, 'hex').reverse().toString('hex');
const HOST_TAG = '00'.repeat(20);

async function rpc(method, ...params) {
  const res = await fetch(`http://127.0.0.1:19660/wallet/w`, {
    method: 'POST', headers: { Authorization: `Basic ${cookie}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function api(path, body) {
  const r = await fetch(`http://127.0.0.1:5181/api/${path}`,
    body ? { method: 'POST', body: JSON.stringify(body, (k, v) => typeof v === 'bigint' ? String(v) : v) } : undefined);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

const key = s => {
  const sec = s.repeat(32), pub = pubkeyCompressed(sec);
  const leaf = '21' + pub + 'ac';
  return { sec, pub, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') };
};
const maker = key('e3'), taker = key('f4');
const prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });

// mirror exchange.mjs signRangedGive: SIGHASH_BUNDLE digest over the descriptor
const HT = SIGHASH_ALL | SIGHASH_BUNDLE;
function signRung(desc, giveOp, coin, k, L) {
  const give = { prevout: prevout(giveOp), sequence: 0xffffffff };
  const dg = rangedSighash({ vin: [give], desc, nExpireTime: desc.nExpireTime ?? 0 }, 0, k.leaf,
    BigInt(coin.value), BigInt(coin.refheight), { lockHeight: L, hashtype: HT });
  return [signEcdsa(k.sec, dg) + HT.toString(16).padStart(2, '0'), '00' + k.leaf, ''];
}
const signTakerInput = (tx, i, k, value, refheight) => {
  const dg = segwitV0Sighash(tx, i, k.leaf, BigInt(value), BigInt(refheight), SIGHASH_ALL);
  tx.vin[i].witness = [signEcdsa(k.sec, dg) + '01', '00' + k.leaf, ''];
};

// build the fill composite exactly like fillRangedNow (payout asset = FRC, fee from FRC surplus)
function buildFill({ offer, L, giveWitness, give, fill, takerCoin, tag }) {
  const d = offer.desc;
  const priceNum = BigInt(d.priceNum), priceDen = BigInt(d.priceDen);
  const givePv = assetPresentValue(BigInt(give.value), L - give.refheight, { k: 20, interest: false });
  const payout = (fill * priceNum + priceDen - 1n) / priceDen;
  const change = givePv - fill;
  const fee = 10000n;
  // taker coin newer than L (the negative case): nominal stands in — the node rejects the tx
  // on non-monotonic lock_height before any value math anyway
  const takerPv = L >= takerCoin.refheight
    ? assetPresentValue(BigInt(takerCoin.value), L - takerCoin.refheight, { k: 20, interest: false })
    : BigInt(takerCoin.value);
  const tx = {
    version: 0x80000003, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
    vin: [
      { prevout: prevout(offer.giveOutpoint), scriptSig: '', sequence: 0xffffffff, witness: giveWitness },
      { prevout: prevout(takerCoin.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] },
    ],
    vout: [
      { value: payout, scriptPubKey: d.payoutScript, assetTag: HOST_TAG },   // [payout] to maker
      { value: change, scriptPubKey: d.changeScript, assetTag: tag },        // [change] to maker
      { value: fill, scriptPubKey: taker.spk, assetTag: tag },               // fill to taker
      { value: takerPv - payout - fee, scriptPubKey: taker.spk, assetTag: HOST_TAG },
    ],
    ranged: [{ nIn: 1, payoutAsset: HOST_TAG, payoutScript: d.payoutScript, priceNum, priceDen,
               changeScript: d.changeScript, minFill: BigInt(d.minFill), maxFill: BigInt(d.maxFill),
               nExpireTime: offer.nExpireTime ?? 0 }],
  };
  signTakerInput(tx, 1, taker, takerCoin.value, takerCoin.refheight);
  return tx;
}

const main = async () => {
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  const nonce = await rpc('getblockcount');

  // 1. issue 500 units of a fresh asset straight to the maker's spk
  const iss = await api('issue', { name: 'LDR' + nonce, shift: 20, interest: false, amount: 500, spk: maker.spk, decimals: 0 });
  const tag = iss.tag, giveOutpoint = `${iss.txid}:0`;
  const rawMint = await rpc('getrawtransaction', iss.txid, true);
  const giveCoin = { value: 500n, refheight: rawMint.lockheight };
  console.log(`1. issued LDR${nonce} (${tag.slice(0, 12)}…) 500 units -> maker`);

  // 2. maker signs a 7-rung ladder (posting height + grid every 10 blocks) and goes DARK
  const H0 = await rpc('getblockcount');
  const LAST = Math.floor(H0 / 10 + 1) * 10 + 50;
  const desc = { payoutAsset: HOST_TAG, payoutScript: maker.spk, priceNum: 1000n, priceDen: 1n,
                 changeScript: maker.spk, minFill: 10n, maxFill: 500n, nExpireTime: LAST };
  const rungs = [H0];
  for (let Li = Math.floor(H0 / 10 + 1) * 10; Li <= LAST; Li += 10) rungs.push(Li);
  const ladder = rungs.map(L => ({ lockHeight: L, witness: signRung(desc, giveOutpoint, giveCoin, maker, L) }));
  const { id } = await api('rangedOffer', { makerSpk: maker.spk, giveOutpoint, desc, nExpireTime: LAST,
    lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder, makerPub: maker.pub });
  console.log(`2. ranged offer #${id} posted at H=${H0}, ladder ${rungs[0]}..${rungs.at(-1)} (${rungs.length} rungs) — maker OFFLINE from here`);

  // 3. advance the chain PAST several rungs, then fund the taker with a FRESH coin
  await rpc('generatetoaddress', 25, mine);
  const dec = await rpc('decodescript', taker.spk);
  const ftx = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, '0.01');
  await rpc('generatetoaddress', 12, mine);   // bury it AND cross the next rung boundary
  const rawF = await rpc('getrawtransaction', ftx, true);
  const fVout = rawF.vout.findIndex(o => o.scriptPubKey.hex === taker.spk);
  const takerCoin = { outpoint: `${ftx}:${fVout}`, value: BigInt(Math.round(rawF.vout[fVout].value * 1e8)), refheight: rawF.lockheight };
  const H1 = await rpc('getblockcount');
  console.log(`3. chain ${H0} -> ${H1}; taker coin minted at refheight ${takerCoin.refheight} (> ${H0}: ${takerCoin.refheight > H0 ? 'yes' : 'NO?!'})`);

  // 4. NEGATIVE: fill pinned at the POSTING rung — the fresh coin must be rejected
  const giveNow = { ...giveCoin };
  let neg = null;
  try {
    const tx = buildFill({ offer: { desc: { ...desc, priceNum: '1000', priceDen: '1', minFill: '10', maxFill: '500' }, giveOutpoint, nExpireTime: LAST },
      L: H0, giveWitness: ladder[0].witness, give: giveNow, fill: 100n, takerCoin, tag });
    await api('tx', { rawtx: serializeTx(tx), kind: 'rangedfill', offerId: id });
  } catch (e) { neg = e.message; }
  const negOk = neg && neg.includes('non-monotonic-lock-height');
  console.log(`4. fill @posting rung H=${H0} with fresh coin: ${negOk ? 'rejected ✅ (' : 'WRONG ❌ ('}${neg || 'ACCEPTED'})`);

  // 5. POSITIVE: fill at the relay-served CURRENT rung (maker still dark)
  const list = await api('info');
  const served = list.book.find(o => o.id === id);
  const L1 = served.lockHeight;
  console.log(`5. relay serves rung H=${L1} (> posting ${H0}: ${L1 > H0 ? 'yes' : 'NO?!'}; >= taker refheight: ${L1 >= takerCoin.refheight ? 'yes' : 'NO?!'})`);
  const tx = buildFill({ offer: served, L: L1, giveWitness: served.witness, give: giveNow, fill: 100n, takerCoin, tag });
  await api('tx', { rawtx: serializeTx(tx), kind: 'rangedfill', offerId: id });
  const fillTxid = computeTxid(tx);
  console.log(`6. fill 100 units @rung ${L1} accepted ✅ (${fillTxid.slice(0, 16)}…) — maker was OFFLINE the whole time`);

  // 6. verify: payout landed on-chain; the offer repointed to the change coin, needsResign
  const rawFill = await rpc('getrawtransaction', fillTxid, true);
  const payoutOk = rawFill.vout[0].scriptPubKey.hex === maker.spk && Math.round(rawFill.vout[0].value * 1e8) === 100 * 1000;
  const after = (await api('info')).book.find(o => o.id === id);
  const repointOk = after && after.needsResign && after.giveOutpoint === `${fillTxid}:1`;
  console.log(`7. payout 100000 kria -> maker on-chain: ${payoutOk ? '✅' : '❌'}; remainder repointed + needsResign: ${repointOk ? '✅' : '❌ ' + JSON.stringify({ st: after?.status, nr: after?.needsResign, op: after?.giveOutpoint })}`);
};
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
