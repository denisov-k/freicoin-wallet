// token_ui_e2e.mjs — live proof of the WALLET-FACING token path, end to end:
//   1. relay `issue` with tokens → mint tx carries the v2 suffix (tag ++ H(set)) + FRT1 reveal
//   2. the light-client extractor (scan.txTokenMap) recovers the token strings from that tx
//      and verifies them against the output's own commitment — exactly what the wallet displays
//   3. the coin moves A → B with a two-sided reveal (mvSendTokenCoin's construction)
//   4. NEGATIVE: the same spend WITHOUT the reveal is consensus-rejected
// Run: node --import ../../apps/web/test/register-aliases.mjs token_ui_e2e.mjs  (from this dir)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
import { serializeTx, parseTx, txid as computeTxid } from '@core/tx.mjs';
import { makeTokenReveal } from '@core/nv3wire.mjs';
import { tokenSetHash } from '@core/asset-spk.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { txTokenMap } from '../../apps/web/src/services/light/net/scan.mjs';

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
  return { sec, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') };
};
const A = key('a1'), B = key('b2');
const prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
const sign = (tx, i, k, value, refheight) => {
  const dg = segwitV0Sighash(tx, i, k.leaf, BigInt(value), BigInt(refheight), SIGHASH_ALL);
  tx.vin[i].witness = [signEcdsa(k.sec, dg) + '01', '00' + k.leaf, ''];
};
const opret = payload => {
  const n = payload.length / 2;
  return '6a' + (n <= 75 ? n.toString(16).padStart(2, '0') : '4c' + n.toString(16).padStart(2, '0')) + payload;
};
const utf8hex = s => Buffer.from(s, 'utf8').toString('hex');

const main = async () => {
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  const nonce = await rpc('getblockcount');
  const NAMES = ['билет-001', 'билет-002'];

  // 1. issue with tokens through the RELAY endpoint the wallet uses
  const iss = await api('issue', { name: 'TKT' + nonce, shift: 64, interest: true, amount: 1, decimals: 0, spk: A.spk, tokens: NAMES });
  const raw = await rpc('getrawtransaction', iss.txid, false);
  const mintTx = parseTx(raw);
  const expectHex = NAMES.map(utf8hex);
  const commitOk = mintTx.vout[0].tokenHash === tokenSetHash(expectHex) && mintTx.vout[0].assetTag === iss.tag;
  console.log(`1. issue with tokens: v2 suffix commit ${commitOk ? '✅' : '❌'} (tag ${iss.tag.slice(0, 12)}…)`);

  // 2. the wallet-side extractor recovers + verifies the strings from the tx alone
  const tokMap = txTokenMap(mintTx);
  const got = tokMap.get(0) ?? [];
  const extractOk = got.length === 2 && got.every((h, i) => h === expectHex[i]);
  console.log(`2. light-client extraction (txTokenMap): ${extractOk ? '✅' : '❌ ' + JSON.stringify(got)}`);

  // fee coin for A
  const decA = await rpc('decodescript', A.spk);
  const ftx = await rpc('sendtoaddress', decA.address ?? decA.segwit?.address, '0.01');
  await rpc('generatetoaddress', 1, mine);
  const rawF = await rpc('getrawtransaction', ftx, true);
  const fV = rawF.vout.findIndex(o => o.scriptPubKey.hex === A.spk);
  const feeCoin = { outpoint: `${ftx}:${fV}`, value: BigInt(Math.round(rawF.vout[fV].value * 1e8)), refheight: rawF.lockheight };

  // 3. NEGATIVE first: spend the token coin A→B WITHOUT any reveal
  const H = await rpc('getblockcount');
  const mintRef = (await rpc('getrawtransaction', iss.txid, true)).lockheight;
  const coinPv = assetPresentValue(1n, H - mintRef, { k: 64, interest: true });
  const feePv = assetPresentValue(feeCoin.value, H - feeCoin.refheight, { k: 20, interest: false });
  const mkTx = withReveal => {
    const vout = [{ value: coinPv, scriptPubKey: B.spk, assetTag: iss.tag, ...(withReveal ? { tokens: expectHex } : {}) },
                  { value: feePv - 10000n, scriptPubKey: A.spk, assetTag: HOST_TAG }];
    if (withReveal) vout.push({ value: 0n, scriptPubKey: opret(makeTokenReveal(vout, [{ tokens: expectHex }, {}])) });
    const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H, nExpireTime: 0,
      vin: [{ prevout: prevout(`${iss.txid}:0`), scriptSig: '', sequence: 0xffffffff, witness: [] },
            { prevout: prevout(feeCoin.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }], vout };
    sign(tx, 0, A, 1n, mintRef); sign(tx, 1, A, feeCoin.value, feeCoin.refheight);
    return tx;
  };
  let neg = null;
  try { await api('tx', { rawtx: serializeTx(mkTx(false)), kind: 'send' }); } catch (e) { neg = e.message; }
  const negOk = neg && neg.includes('token');
  console.log(`3. spend WITHOUT reveal: ${negOk ? 'rejected ✅ (' : 'WRONG ❌ ('}${(neg || 'ACCEPTED').slice(0, 90)})`);

  // 4. POSITIVE: the two-sided reveal spend (mvSendTokenCoin's exact construction)
  const tx = mkTx(true);
  await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  const sendId = computeTxid(tx);
  const rawSend = parseTx(await rpc('getrawtransaction', sendId, false));
  const bOk = rawSend.vout[0].tokenHash === tokenSetHash(expectHex) && txTokenMap(rawSend).get(0)?.length === 2;
  console.log(`4. A→B with two-sided reveal: accepted ✅ (${sendId.slice(0, 16)}…); B's coin re-commits the set: ${bOk ? '✅' : '❌'}`);

  // 5. SPLIT: B sends ONE of the two items back to A, keeps the other on a change coin
  //    (mvSendTokenCoin's picked-subset construction: pro-rata units, two committed outputs)
  const decB = await rpc('decodescript', B.spk);
  const ftx2 = await rpc('sendtoaddress', decB.address ?? decB.segwit?.address, '0.01');
  await rpc('generatetoaddress', 1, mine);
  const rawF2 = await rpc('getrawtransaction', ftx2, true);
  const f2V = rawF2.vout.findIndex(o => o.scriptPubKey.hex === B.spk);
  const feeB = { outpoint: `${ftx2}:${f2V}`, value: BigInt(Math.round(rawF2.vout[f2V].value * 1e8)), refheight: rawF2.lockheight };
  const H2 = await rpc('getblockcount');
  const bCoinRef = (await rpc('getrawtransaction', sendId, true)).lockheight;
  const bPv = assetPresentValue(coinPv, H2 - bCoinRef, { k: 64, interest: true });
  const feeBPv = assetPresentValue(feeB.value, H2 - feeB.refheight, { k: 20, interest: false });
  const sendSet = [expectHex[0]], keepSet = [expectHex[1]];
  const vShare = bPv * 1n / 2n;
  const vout5 = [
    { value: vShare, scriptPubKey: A.spk, assetTag: iss.tag, tokens: sendSet },
    { value: bPv - vShare, scriptPubKey: B.spk, assetTag: iss.tag, tokens: keepSet },
    { value: feeBPv - 10000n, scriptPubKey: B.spk, assetTag: HOST_TAG },
  ];
  vout5.push({ value: 0n, scriptPubKey: opret(makeTokenReveal(vout5, [{ tokens: expectHex }, {}])) });
  const tx5 = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H2, nExpireTime: 0,
    vin: [{ prevout: prevout(`${sendId}:0`), scriptSig: '', sequence: 0xffffffff, witness: [] },
          { prevout: prevout(feeB.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }], vout: vout5 };
  sign(tx5, 0, B, coinPv, bCoinRef); sign(tx5, 1, B, feeB.value, feeB.refheight);
  await api('tx', { rawtx: serializeTx(tx5), kind: 'send' });
  const splitId = computeTxid(tx5);
  const rawSplit = parseTx(await rpc('getrawtransaction', splitId, false));
  const splitOk = rawSplit.vout[0].tokenHash === tokenSetHash(sendSet)
               && rawSplit.vout[1].tokenHash === tokenSetHash(keepSet)
               && txTokenMap(rawSplit).get(0)?.[0] === sendSet[0]
               && txTokenMap(rawSplit).get(1)?.[0] === keepSet[0];
  console.log(`5. SPLIT 1-of-2 back to A (keep 1 on change): accepted ✅ (${splitId.slice(0, 16)}…); both outputs commit their subsets: ${splitOk ? '✅' : '❌'}`);
};
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
