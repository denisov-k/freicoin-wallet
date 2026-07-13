// p2p-e2e.mjs — user-to-user FRC↔signet-BTC swap via the relay's P2P BOARD. No LP: the maker
// sells FRC at their OWN price, a taker provides real signet BTC. The relay only coordinates
// and reads the revealed secret — it holds no keys and no funds. This is the price-discovery
// venue (a non-custodial FreiExchange replacement), proven on live signet.
import { readFileSync } from 'node:fs';
import { sha256 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { frcLeg, claimReceived } from '/root/free-money/freicoin-wallet/core/swap.mjs';
import { paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const api = async (p, b) => { const r = await fetch(`http://127.0.0.1:5181/api/${p}`, b ? { method: 'POST', body: JSON.stringify(b) } : undefined); const j = await r.json(); if (j.error) throw new Error(`${p}: ${j.error}`); return j; };
const mk = (port, ck, w) => { const a = Buffer.from(readFileSync(ck)).toString('base64'); return async (m, ...p) => { const r = await fetch(`http://127.0.0.1:${port}${w ? '/wallet/' + w : ''}`, { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; }; };
const frc = mk(19660, '/root/nv3-playground/chain/regtest/.cookie', 'w');
const btc = mk(38332, '/root/btc-signet/signet/.cookie', 'swap');   // stands in for the taker's own BTC wallet
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Maker (Alice): sells FRC, wants BTC, holds R.
const aFrc = hex(sha256(bin('alice-frc'.padEnd(64, '0')))), aBtc = hex(sha256(bin('alice-btc'.padEnd(64, '0'))));
const R = hex(sha256(bin('p2p-secret'.padEnd(64, '0')))), H = paymentHashOf(R);
// Taker (Bob): provides BTC, wants FRC.
const bFrc = hex(sha256(bin('bob-frc'.padEnd(64, '0')))), bBtc = hex(sha256(bin('bob-btc'.padEnd(64, '0'))));

const FRC_AMT = 500000n;   // Alice sells 0.005 FRC
const BTC_AMT = 100000n;   // for 0.001 BTC — HER price (0.2 BTC/FRC), set by the maker

// 1. Alice posts the offer at her price
const aBtcAddr = (await btc('getnewaddress', '', 'bech32'));   // where Alice receives BTC
const post = await api('p2pPost', { frcAmount: String(FRC_AMT), btcAmount: String(BTC_AMT), makerFrcPub: pubkeyCompressed(aFrc), makerBtcPub: pubkeyCompressed(aBtc), makerBtcAddr: aBtcAddr, paymentHash: H });
console.log(`1. Alice posted ${post.id}: 0.005 FRC → 0.001 BTC (HER price)`);

// 2. Bob takes it
const bFrcAddr = await frc('getnewaddress');
await api('p2pTake', { id: post.id, takerFrcPub: pubkeyCompressed(bFrc), takerBtcPub: pubkeyCompressed(bBtc), takerFrcAddr: bFrcAddr });
console.log(`2. Bob took ${post.id} — both sides committed keys`);

// 3. Alice funds the FRC HTLC (claim=Bob, refund=Alice, T1)
const fh = await frc('getblockcount'), T1 = fh + Number((await api('p2pList')).t1);
const legF = frcLeg({ role: 'give', ourKey: aFrc, theirPub: pubkeyCompressed(bFrc), paymentHash: H, cltv: T1, net: 'regtest' });
const fFund = await frc('sendtoaddress', legF.address, (Number(FRC_AMT) / 1e8).toFixed(8));
await frc('generatetoaddress', 1, await frc('getnewaddress'));
const fRaw = await frc('getrawtransaction', fFund, true);
const fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
const r3 = await api('p2pFrcFunded', { id: post.id, txid: fFund, vout: fVout, t1: T1 });
console.log(`3. Alice locked FRC; relay says Bob must fund BTC HTLC → ${r3.btcHtlc.addr}`);

// 4. Bob funds the BTC HTLC from his OWN signet wallet (the relay only verifies it on-chain)
const bFund = await btc('sendtoaddress', r3.btcHtlc.addr, (Number(BTC_AMT) / 1e8).toFixed(8));
await api('p2pBtcFunded', { id: post.id, btcTxid: bFund });
console.log(`4. Bob funded the signet BTC HTLC → ${bFund.slice(0, 12)}…`);

// 5. Alice claims the BTC with R (reveals R); relay broadcasts + surfaces R
const bl = r3.btcHtlc; const braw = await btc('getrawtransaction', bFund, true);
const bVout = braw.vout.findIndex(o => o.scriptPubKey.address === bl.addr);
const bVal = BigInt(Math.round(braw.vout[bVout].value * 1e8));
const aRecvSpk = (await btc('getaddressinfo', aBtcAddr)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: bVal, leafHex: bl.leaf, preimage: R, claimKey: aBtc, toSpk: aRecvSpk, fee: 2000n });
const r5 = await api('p2pBtcClaim', { id: post.id, rawtx: cB.rawtx });
console.log(`5. Alice claimed the BTC (${r5.btcClaim.slice(0, 12)}…) — R revealed: ${(r5.preimage || '?').slice(0, 12)}…`);

// 6. Bob reads R from the board and claims the FRC
let R2 = r5.preimage;
for (let i = 0; i < 10 && !R2; i++) { await sleep(2000); R2 = (await api('p2pList')).swaps.find(x => x.id === post.id)?.preimage; }
if (!R2) throw new Error('Bob could not read R');
const bRecvSpk = (await frc('getaddressinfo', bFrcAddr)).scriptPubKey;
const cF = claimReceived({ funding: { txid: fFund, vout: fVout, value: BigInt(r3 && fRaw.vout[fVout].value ? Math.round(fRaw.vout[fVout].value * 1e8) : 0), refheight: fRaw.lockheight }, leaf: legF.leaf, preimage: R2, ourKey: bFrc, toSpk: bRecvSpk, fee: 2000n });
await frc('generateblock', await frc('getnewaddress'), [cF.rawtx]);
await api('p2pDone', { id: post.id });
console.log(`6. Bob read R and claimed the FRC → ${cF.txid.slice(0, 12)}…`);
console.log('\n✅ P2P SWAP COMPLETE — user↔user, maker-set price, real signet BTC, relay held nothing.');
