// token_dex_e2e.mjs — sell a TOKEN COIN on the DEX, fitting the existing ranged-offer flow.
//
// A token coin is indivisible, so it sells WHOLE: a ranged offer with minFill = maxFill = V
// (its unit count). Token coins are "constant" rate (shift-64 interest ⇒ present value == nominal
// at every height), so that fixed min=max matches givePV at every ladder rung. The taker fills
// like any ranged offer, with one addition: the fill output carries the tokens and the tx carries
// the two-sided FRT1 reveal (input section = the give coin's set, output section = the fill's).
//   1. maker issues a 2-token coin, signs a ranged offer over it (min=max=V), goes offline
//   2. taker fills WHOLE: maker's ranged witness + taker FRC payment; outputs [payout, change=0,
//      fill(V+tokens)] + reveal — consensus accepts, taker's coin re-commits the set, maker paid
//   3. NEGATIVE: the same fill WITHOUT the reveal ⇒ bad-txns-token-input-unrevealed
//   4. NEGATIVE: taker tries to underpay-and-grab (fill < V so change>0 to maker, all tokens to
//      taker) ⇒ rejected by the min=max bound (can't take the tokens without buying the whole coin)
// Run from research/nversion3: node --import ../../apps/web/test/register-aliases.mjs token_dex_e2e.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, rangedSighash, SIGHASH_ALL, SIGHASH_BUNDLE } from '@core/sighash.mjs';
import { serializeTx, parseTx, txid as computeTxid } from '@core/tx.mjs';
import { makeTokenReveal } from '@core/nv3wire.mjs';
import { tokenSetHash } from '@core/asset-spk.mjs';
import { assetPresentValue } from '@core/assets.mjs';

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
const key = s => { const sec = s.repeat(32), pub = pubkeyCompressed(sec); const leaf = '21' + pub + 'ac';
  return { sec, pub, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') }; };
const maker = key('c1'), taker = key('d2');
const prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
const HT = SIGHASH_ALL | SIGHASH_BUNDLE;
const opret = payload => { const n = payload.length / 2; return '6a' + (n <= 75 ? n.toString(16).padStart(2, '0') : '4c' + n.toString(16).padStart(2, '0')) + payload; };
const utf8hex = s => Buffer.from(s, 'utf8').toString('hex');
const signRung = (desc, giveOp, coin, k, L) => {
  const give = { prevout: prevout(giveOp), sequence: 0xffffffff };
  const dg = rangedSighash({ vin: [give], desc, nExpireTime: desc.nExpireTime ?? 0 }, 0, k.leaf, BigInt(coin.value), BigInt(coin.refheight), { lockHeight: L, hashtype: HT });
  return [signEcdsa(k.sec, dg) + HT.toString(16).padStart(2, '0'), '00' + k.leaf, ''];
};
const signIn = (tx, i, k, value, refheight) => { const dg = segwitV0Sighash(tx, i, k.leaf, BigInt(value), BigInt(refheight), SIGHASH_ALL); tx.vin[i].witness = [signEcdsa(k.sec, dg) + '01', '00' + k.leaf, '']; };

const main = async () => {
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  const nonce = await rpc('getblockcount');
  const NAMES = ['ложа-A1', 'ложа-A2'], toks = NAMES.map(utf8hex);

  // 1. maker issues a 2-token coin (constant rate: PV == nominal 2 at every height)
  const iss = await api('issue', { name: 'СЕЗОН' + nonce, shift: 64, interest: true, amount: 2, decimals: 0, spk: maker.spk, tokens: NAMES });
  const tag = iss.tag, giveOutpoint = `${iss.txid}:0`;
  const mintRef = (await rpc('getrawtransaction', iss.txid, true)).lockheight;
  const V = 2n;   // constant-rate ⇒ givePV == 2 at any L
  console.log(`1. issued 2-token coin СЕЗОН${nonce} (${tag.slice(0, 12)}…) to maker`);

  // maker signs a ranged offer: sell the whole coin for 500000 kria FRC. min=max=V (whole only).
  const H0 = await rpc('getblockcount');
  const LAST = Math.floor(H0 / 10 + 1) * 10 + 50;
  const PRICE = 500000n;   // total FRC (kria) for the whole coin
  const desc = { payoutAsset: HOST_TAG, payoutScript: maker.spk, priceNum: PRICE, priceDen: V, changeScript: maker.spk, minFill: V, maxFill: V, nExpireTime: LAST };
  const rungs = [H0]; for (let Li = Math.floor(H0 / 10 + 1) * 10; Li <= LAST; Li += 10) rungs.push(Li);
  const ladder = rungs.map(L => ({ lockHeight: L, witness: signRung(desc, giveOutpoint, { value: V, refheight: mintRef }, maker, L) }));
  const { id } = await api('rangedOffer', { makerSpk: maker.spk, giveOutpoint, desc, nExpireTime: LAST, lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder, makerPub: maker.pub });
  console.log(`2. ranged offer #${id} posted: whole 2-token coin for ${PRICE} kria FRC (min=max=${V}); maker OFFLINE`);

  // fund the taker EARLY (refheight ≈ H0+1), THEN mine past a rung so the served rung ≥ that
  // refheight (else the taker's coin is 'too young' for the fill — the rung-lag from the ladder).
  const decT = await rpc('decodescript', taker.spk);
  const ftx = await rpc('sendtoaddress', decT.address ?? decT.segwit?.address, '0.02');
  await rpc('generatetoaddress', 14, mine);
  const rawF = await rpc('getrawtransaction', ftx, true);
  const fV = rawF.vout.findIndex(o => o.scriptPubKey.hex === taker.spk);
  const takerCoin = { outpoint: `${ftx}:${fV}`, value: BigInt(Math.round(rawF.vout[fV].value * 1e8)), refheight: rawF.lockheight };

  const list = await api('info');
  const served = list.book.find(o => o.id === id);
  const L = served.lockHeight;
  const rung = ladder.find(r => r.lockHeight === L) ?? ladder[0];

  // build the WHOLE-coin fill (taker), optionally with the reveal
  const buildFill = ({ withReveal = true, fill = V } = {}) => {
    const payout = (fill * PRICE + V - 1n) / V;                 // rounded up
    const change = V - fill;                                    // 0 for a whole fill
    const takerPv = assetPresentValue(takerCoin.value, L - takerCoin.refheight, { k: 20, interest: false });
    /** @type {any[]} */
    const vout = [
      { value: payout, scriptPubKey: maker.spk, assetTag: HOST_TAG },              // [payout] → maker
      { value: change, scriptPubKey: maker.spk, assetTag: tag },                   // [change] → maker (0)
      { value: fill, scriptPubKey: taker.spk, assetTag: tag, ...(withReveal ? { tokens: toks } : {}) },   // fill (+tokens) → taker
      { value: takerPv - payout - 10000n, scriptPubKey: taker.spk, assetTag: HOST_TAG },  // taker FRC change (fee 10000)
    ];
    if (withReveal) vout.push({ value: 0n, scriptPubKey: opret(makeTokenReveal(vout, [{ tokens: toks }, {}])) });
    const tx = {
      version: 0x80000003, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: [{ prevout: prevout(giveOutpoint), scriptSig: '', sequence: 0xffffffff, witness: rung.witness },
            { prevout: prevout(takerCoin.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }],
      vout,
      ranged: [{ nIn: 1, payoutAsset: HOST_TAG, payoutScript: maker.spk, priceNum: PRICE, priceDen: V, changeScript: maker.spk, minFill: V, maxFill: V, nExpireTime: LAST }],
    };
    signIn(tx, 1, taker, takerCoin.value, takerCoin.refheight);
    return tx;
  };

  // 3. NEGATIVE: fill without the reveal
  let neg = null;
  try { await api('tx', { rawtx: serializeTx(buildFill({ withReveal: false })), kind: 'rangedfill', offerId: id }); } catch (e) { neg = e.message; }
  console.log(`3. fill WITHOUT reveal: ${neg && neg.includes('token') ? 'rejected ✅' : 'WRONG ❌'} (${(neg || 'ACCEPTED').slice(0, 80)})`);

  // 4. NEGATIVE: underpay-and-grab — take 1 unit but all tokens (fill=1 < min=2)
  let neg2 = null;
  try { await api('tx', { rawtx: serializeTx(buildFill({ fill: 1n })), kind: 'rangedfill', offerId: id }); } catch (e) { neg2 = e.message; }
  console.log(`4. underpay-and-grab (fill<min): ${neg2 && neg2.includes('fill-bounds') ? 'rejected ✅' : 'WRONG ❌'} (${(neg2 || 'ACCEPTED').slice(0, 80)})`);

  // 5. POSITIVE: whole fill with reveal
  const tx = buildFill();
  await api('tx', { rawtx: serializeTx(tx), kind: 'rangedfill', offerId: id });
  const fillId = computeTxid(tx);
  const raw = parseTx(await rpc('getrawtransaction', fillId, false));
  const takerGot = raw.vout[2].tokenHash === tokenSetHash(toks);
  const makerPaid = raw.vout[0].scriptPubKey === maker.spk && BigInt(Math.round((await rpc('getrawtransaction', fillId, true)).vout[0].value * 1e8)) >= PRICE;
  console.log(`5. WHOLE fill with reveal: accepted ✅ (${fillId.slice(0, 16)}…); taker's coin commits the set: ${takerGot ? '✅' : '❌'}; maker paid ≥ ${PRICE}: ${makerPaid ? '✅' : '❌'}`);
};
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
