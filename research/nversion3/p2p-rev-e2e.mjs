// p2p-rev-e2e.mjs — REVERSE direction: maker SELLS BTC for FRC. Maker holds R and funds the BTC
// HTLC first; taker funds the FRC HTLC; maker claims FRC (reveals R); taker claims BTC. Proves the
// mirrored protocol + timelock ordering end-to-end on live signet, relay holding no keys/funds.
import { readFileSync } from 'node:fs';
import { sha256 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { frcLeg, claimReceived } from '/root/free-money/freicoin-wallet/core/swap.mjs';
import { paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcLeaf, btcHtlcAddress, btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const api = async (p, b) => { const r = await fetch(`http://127.0.0.1:5181/api/${p}`, b ? { method: 'POST', body: JSON.stringify(b) } : undefined); const j = await r.json(); if (j.error) throw new Error(`${p}: ${j.error}`); return j; };
const mk = (port, ck, w) => { const a = Buffer.from(readFileSync(ck)).toString('base64'); return async (m, ...p) => { const r = await fetch(`http://127.0.0.1:${port}${w ? '/wallet/' + w : ''}`, { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; }; };
const frc = mk(19660, '/root/nv3-playground/chain/regtest/.cookie', 'w');
const btc = mk(38332, '/root/btc-signet/signet/.cookie', 'swap');   // stands in for the maker's own BTC wallet
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Maker (Alice): SELLS BTC, wants FRC, holds R.
const aFrc = hex(sha256(bin('rev-alice-frc'.padEnd(64, '0')))), aBtc = hex(sha256(bin('rev-alice-btc'.padEnd(64, '0'))));
const R = hex(sha256(bin('rev-p2p-secret'.padEnd(64, '0')))), H = paymentHashOf(R);
// Taker (Bob): provides FRC, wants BTC.
const bFrc = hex(sha256(bin('rev-bob-frc'.padEnd(64, '0')))), bBtc = hex(sha256(bin('rev-bob-btc'.padEnd(64, '0'))));

const FRC_AMT = 500000n;   // Alice wants 0.005 FRC
const BTC_AMT = 12000n;    // for her 0.00012 BTC  (HER price)

// 1. Alice posts the reverse offer at her price
const aFrcAddr = await frc('getnewaddress');   // where Alice receives FRC
const post = await api('p2pPostB', { frcAmount: String(FRC_AMT), btcAmount: String(BTC_AMT), makerFrcPub: pubkeyCompressed(aFrc), makerBtcPub: pubkeyCompressed(aBtc), makerFrcAddr: aFrcAddr, paymentHash: H });
console.log(`1. Alice posted ${post.id}: sell 0.00012 BTC → wants 0.005 FRC (HER price)`);

// 2. Bob takes it
const bBtcAddr = await btc('getnewaddress', '', 'bech32');   // where Bob receives BTC
await api('p2pTakeB', { id: post.id, takerFrcPub: pubkeyCompressed(bFrc), takerBtcPub: pubkeyCompressed(bBtc), takerBtcAddr: bBtcAddr });
console.log(`2. Bob took ${post.id}`);

// 3. Alice funds the BTC HTLC FIRST (claim=Bob, refund=Alice, cltv=tb) from her own signet wallet
const bh = await btc('getblockcount'), tb = bh + 12;
const bleaf = btcHtlcLeaf({ paymentHash: H, claimPub: pubkeyCompressed(bBtc), refundPub: pubkeyCompressed(aBtc), cltv: tb });
const baddr = btcHtlcAddress(bleaf, 'tb');
const bFund = await btc('sendtoaddress', baddr, (Number(BTC_AMT) / 1e8).toFixed(8));
const r3 = await api('p2pBtcFundedB', { id: post.id, btcTxid: bFund, tb });
console.log(`3. Alice locked BTC (${bFund.slice(0, 12)}…); relay says Bob must fund FRC HTLC ${r3.frcHtlc.spk.slice(0, 12)}…`);

// 4. Bob funds the FRC HTLC (claim=Alice, refund=Bob, cltv=tf) on fc-nv3
const legF = frcLeg({ role: 'give', ourKey: bFrc, theirPub: pubkeyCompressed(aFrc), paymentHash: H, cltv: r3.frcHtlc.cltv, net: 'regtest' });
if (legF.spk !== r3.frcHtlc.spk) throw new Error('FRC leg mismatch — relay and taker disagree');
const fFund = await frc('sendtoaddress', legF.address, (Number(FRC_AMT) / 1e8).toFixed(8));
await frc('generatetoaddress', 1, await frc('getnewaddress'));
const fRaw = await frc('getrawtransaction', fFund, true);
const fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
await api('p2pFrcFundedB', { id: post.id, txid: fFund, vout: fVout });
console.log(`4. Bob funded the FRC HTLC (${fFund.slice(0, 12)}… vout ${fVout})`);

// 5. Alice claims the FRC with R (REVEALS R on fc-nv3). Relay broadcasts + surfaces R.
let w = (await api('p2pList')).swaps.find(x => x.id === post.id);
const f = w.frcHtlc;
const aRecvSpk = (await frc('getaddressinfo', aFrcAddr)).scriptPubKey;
const cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: aFrc, toSpk: aRecvSpk, fee: 10000n });
const r5 = await api('p2pFrcClaimB', { id: post.id, rawtx: cF.rawtx });
console.log(`5. Alice claimed the FRC — R revealed: ${(r5.preimage || '?').slice(0, 12)}…`);
if (!r5.preimage) throw new Error('relay did not surface R from the FRC claim');

// 6. Bob reads R from the board and claims the BTC HTLC
let R2 = r5.preimage;
const braw = await btc('getrawtransaction', bFund, true);
const bVout = braw.vout.findIndex(o => o.scriptPubKey.address === baddr);
const bVal = BigInt(Math.round(braw.vout[bVout].value * 1e8));
const bRecvSpk = (await btc('getaddressinfo', bBtcAddr)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: bVal, leafHex: bleaf, preimage: R2, claimKey: bBtc, toSpk: bRecvSpk, fee: 2000n });
const bClaim = await btc('sendrawtransaction', cB.rawtx);
await api('p2pDoneB', { id: post.id });
console.log(`6. Bob claimed the BTC with R → ${bClaim.slice(0, 12)}…`);
console.log('\n✅ REVERSE P2P SWAP COMPLETE — maker sold BTC for FRC, user↔user, real signet BTC, relay held nothing.');
