// swap-refund-e2e.mjs — the SAFETY NET: a swap stalls (relay never settles), and the user
// reclaims their FRC after T1 from seed alone. Mirrors market-view's checkMySwaps refund path.
import { readFileSync } from 'node:fs';
import { sha256 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { frcLeg, refundGiven } from '/root/free-money/freicoin-wallet/core/swap.mjs';
import { paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const frcRpc = (() => { const a = Buffer.from(readFileSync('/root/nv3-playground/chain/regtest/.cookie')).toString('base64'); return async (m, ...p) => { const r = await fetch('http://127.0.0.1:19660/wallet/w', { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; }; })();

const seed = 'refund'.padEnd(64, '0');
const nonce = 'n1';
const swapPriv = leg => hex(sha256(bin(seed + hex(new TextEncoder().encode('fw-swap:' + nonce + ':' + leg)))));
const frcKey = swapPriv('frc'), frcPub = pubkeyCompressed(frcKey);
const relayPub = pubkeyCompressed(hex(sha256(bin('deadbeef'.padEnd(64, '0')))));   // stand-in relay claim key
const R = swapPriv('R'), H = paymentHashOf(R);

// 1. user funds the FRC HTLC (claim=relay, refund=user), cltv=T1 — then the relay VANISHES.
const L = await frcRpc('getblockcount');
const T1 = L + 8;
const leg = frcLeg({ role: 'give', ourKey: frcKey, theirPub: relayPub, paymentHash: H, cltv: T1, net: 'regtest' });
const fund = await frcRpc('sendtoaddress', leg.address, '1.0');
await frcRpc('generatetoaddress', 1, await frcRpc('getnewaddress'));
const fRaw = await frcRpc('getrawtransaction', fund, true);
const vout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === leg.spk);
const value = BigInt(Math.round(fRaw.vout[vout].value * 1e8));
console.log(`1. locked 1.0 FRC in HTLC ${fund.slice(0, 12)}…:${vout}, refund@${T1} — relay then vanishes`);

// 2. try to refund BEFORE T1 → consensus must reject (timelock not reached)
const early = refundGiven({ funding: { txid: fund, vout, value, refheight: fRaw.lockheight }, leaf: leg.leaf, cltv: T1, ourKey: frcKey, toSpk: '0014' + '11'.repeat(20), fee: 10000n });
let rejected = false;
try { await frcRpc('generateblock', await frcRpc('getnewaddress'), [early.rawtx]); } catch { rejected = true; }
console.log(`2. refund attempt before T1 rejected by consensus: ${rejected ? 'yes ✓' : 'NO ✗'}`);

// 3. advance the chain past T1, then refund succeeds
while (await frcRpc('getblockcount') <= T1 + 1) await frcRpc('generatetoaddress', 1, await frcRpc('getnewaddress'));
const back = '0014' + '22'.repeat(20);
const rf = refundGiven({ funding: { txid: fund, vout, value, refheight: fRaw.lockheight }, leaf: leg.leaf, cltv: T1, ourKey: frcKey, toSpk: back, fee: 10000n });
await frcRpc('generateblock', await frcRpc('getnewaddress'), [rf.rawtx]);
const spent = !(await frcRpc('gettxout', fund, vout));
const got = (await frcRpc('getrawtransaction', rf.txid, true)).vout[0];
console.log(`3. after T1: refund broadcast, HTLC spent=${spent}, ${got.value} FRC returned to us`);
console.log(spent && rejected ? '\nSAFETY NET WORKS ✅  a stalled swap returns the user\'s FRC after T1.' : '\nFAILED ✗');
process.exit(spent && rejected ? 0 : 1);
