// swap-board-e2e.mjs — drive the RELAY swap board as a browser would (Alice: FRC -> BTC).
// The relay is the BTC liquidity counterparty. Alice stays non-custodial (refund on timeout).
import { readFileSync } from 'node:fs';
import { sha256 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { frcLeg } from '/root/free-money/freicoin-wallet/core/swap.mjs';
import { paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const api = async (path, body) => { const r = await fetch(`http://127.0.0.1:5181/api/${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined); const j = await r.json(); if (j.error) throw new Error(`${path}: ${j.error}`); return j; };
const frcRpc = (() => { const a = Buffer.from(readFileSync('/root/nv3-playground/chain/regtest/.cookie')).toString('base64'); return async (m, ...p) => { const r = await fetch('http://127.0.0.1:19660/wallet/w', { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; }; })();
const btcRpc = (() => { const a = Buffer.from(readFileSync('/root/btc-regtest/regtest/.cookie')).toString('base64'); return async (m, ...p) => { const r = await fetch('http://127.0.0.1:19332/wallet/swap', { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; }; })();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Alice's swap keys (deterministic from her seed)
const seed = 'a1'.repeat(32);
const aFrcKey = hex(sha256(bin(seed + '00'))), aBtcKey = hex(sha256(bin(seed + '01')));
const aFrcPub = pubkeyCompressed(aFrcKey), aBtcPub = pubkeyCompressed(aBtcKey);
const R = hex(sha256(bin('a11ce5ecret'.padEnd(64, '0')))), H = paymentHashOf(R);

// 1. Alice opens the swap (commits H, gives 1 FRC)
const frcAmount = 100000000n;
const c = await api('swapCreate', { paymentHash: H, frcAmount: String(frcAmount), makerFrcPub: aFrcPub, makerBtcPub: aBtcPub });
console.log(`1. swap ${c.id} created: 1 FRC -> ${Number(c.btcAmount) / 1e8} BTC, relayFrcPub ${c.relayFrcPub.slice(0, 12)}…`);

// 2. Alice builds her FRC HTLC (claim=relay, refund=Alice) and funds it, then reports it
const h = await frcRpc('getblockcount'); const T1 = h + 40;
const legF = frcLeg({ role: 'give', ourKey: aFrcKey, theirPub: c.relayFrcPub, paymentHash: H, cltv: T1, net: 'regtest' });
// fund from the node's FRC wallet (stands in for Alice's coins)
const fFund = await frcRpc('sendtoaddress', legF.address, (Number(frcAmount) / 1e8).toFixed(8));
await frcRpc('generatetoaddress', 1, await frcRpc('getnewaddress'));
const fRaw = await frcRpc('getrawtransaction', fFund, true);
const fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
const r2 = await api('swapFrcFunded', { id: c.id, txid: fFund, vout: fVout, leaf: legF.leaf, t1: T1 });
console.log(`2. Alice funded FRC HTLC; relay funded BTC HTLC ${r2.btcHtlc.txid.slice(0, 12)}…:${r2.btcHtlc.vout} refund@${r2.t2} (T2<T1 ✓)`);

// 3. Alice claims the BTC with R (browser builds it; relay broadcasts). This reveals R.
const aliceBtcAddr = await btcRpc('getnewaddress', '', 'bech32');
const aliceSpk = (await btcRpc('getaddressinfo', aliceBtcAddr)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: r2.btcHtlc.txid, vout: r2.btcHtlc.vout, valueSats: BigInt(r2.btcHtlc.value), leafHex: r2.btcHtlc.leaf, preimage: R, claimKey: aBtcKey, toSpk: aliceSpk, fee: 2000n });
const r3 = await api('swapBtcBroadcast', { id: c.id, rawtx: cB.rawtx });
console.log(`3. Alice claimed BTC (${r3.btcClaim.slice(0, 12)}…) — R now public on the BTC chain`);

// 4. the relay watcher reads R and claims the FRC. Poll swapInfo for 'done'.
for (let i = 0; i < 15; i++) {
  await sleep(2000);
  const info = await api('swapInfo');
  const w = info.swaps.find(x => x.id === c.id);
  if (w.status === 'done') { console.log(`4. relay read R and claimed the FRC — swap DONE ✅ (preimage ${w.preimage.slice(0, 12)}…)`); process.exit(0); }
  if (w.status === 'expired') { console.log('swap expired ✗'); process.exit(1); }
}
console.log('TIMEOUT — relay did not settle'); process.exit(1);
