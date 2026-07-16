// token_split_e2e.mjs — prove a 1→N token split: one coin holding N tokens splits into N coins
// of one token each (each 1 unit + 1 token), via a single self-send with one two-sided FRT1
// reveal (input = the whole set, output = each per-item coin's singleton set). This is what
// "sell tickets individually" does before listing each coin as its own whole offer.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
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
async function rpc(m, ...p) { const r = await fetch('http://127.0.0.1:19660/wallet/w', { method: 'POST', headers: { Authorization: `Basic ${cookie}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; }
async function api(path, body) { const r = await fetch(`http://127.0.0.1:5181/api/${path}`, body ? { method: 'POST', body: JSON.stringify(body, (k, v) => typeof v === 'bigint' ? String(v) : v) } : undefined); const j = await r.json(); if (j.error) throw new Error(j.error); return j; }
const key = s => { const sec = s.repeat(32), pub = pubkeyCompressed(sec); const leaf = '21' + pub + 'ac'; return { sec, pub, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') }; };
const alice = key('e1');
const prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
const signIn = (tx, i, k, v, rh) => { const dg = segwitV0Sighash(tx, i, k.leaf, BigInt(v), BigInt(rh), SIGHASH_ALL); tx.vin[i].witness = [signEcdsa(k.sec, dg) + '01', '00' + k.leaf, '']; };
const opret = p => { const n = p.length / 2; return '6a' + (n <= 75 ? n.toString(16).padStart(2, '0') : '4c' + n.toString(16).padStart(2, '0')) + p; };
const utf8hex = s => Buffer.from(s, 'utf8').toString('hex');

const main = async () => {
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  const nonce = await rpc('getblockcount');
  const NAMES = ['A1', 'B2', 'C3'], toks = NAMES.map(utf8hex);

  const iss = await api('issue', { name: 'SPLIT' + nonce, shift: 64, interest: true, amount: 3, decimals: 0, spk: alice.spk, tokens: NAMES });
  const coinRef = (await rpc('getrawtransaction', iss.txid, true)).lockheight;
  console.log(`1. issued 3-token coin (${iss.tag.slice(0, 10)}…)`);

  // fee coin
  const dec = await rpc('decodescript', alice.spk);
  const ftx = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, '0.01');
  await rpc('generatetoaddress', 1, mine);
  const rf = await rpc('getrawtransaction', ftx, true);
  const fv = rf.vout.findIndex(o => o.scriptPubKey.hex === alice.spk);
  const fee = { outpoint: `${ftx}:${fv}`, value: BigInt(Math.round(rf.vout[fv].value * 1e8)), refheight: rf.lockheight };

  // SPLIT: 3-token coin → 3 coins of one token each
  const L = await rpc('getblockcount');
  const feePv = assetPresentValue(fee.value, L - fee.refheight, { k: 20, interest: false });
  const vout = toks.map(tk => ({ value: 1n, scriptPubKey: alice.spk, assetTag: iss.tag, tokens: [tk] }));   // one coin per item
  vout.push({ value: feePv - 10000n, scriptPubKey: alice.spk, assetTag: HOST_TAG });
  vout.push({ value: 0n, scriptPubKey: opret(makeTokenReveal(vout, [{ tokens: toks }, {}])) });
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
    vin: [{ prevout: prevout(`${iss.txid}:0`), scriptSig: '', sequence: 0xffffffff, witness: [] },
          { prevout: prevout(fee.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }], vout };
  signIn(tx, 0, alice, 3n, coinRef); signIn(tx, 1, alice, fee.value, fee.refheight);
  await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  const sid = computeTxid(tx);
  const raw = parseTx(await rpc('getrawtransaction', sid, false));
  const ok = toks.every((tk, i) => raw.vout[i].tokenHash === tokenSetHash([tk]));
  console.log(`2. split into 3 one-token coins: accepted ✅ (${sid.slice(0, 16)}…); each commits its singleton: ${ok ? '✅' : '❌'}`);
  for (let i = 0; i < 3; i++) { const ut = await rpc('gettxout', sid, i); console.log(`   coin ${sid.slice(0,8)}…:${i} = ${NAMES[i]}  unspent=${ut && ut !== null ? '✅' : '❌'}`); }
};
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
