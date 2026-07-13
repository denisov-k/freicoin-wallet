// p2p-rev-partial-e2e.mjs — PARTIAL sell of BTC: one offer (sell up to 0.0002 BTC for 2 FRC) taken
// in TWO pieces by two takers; each piece is an independent reverse child sub-swap. Proven on signet.
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
const btc = mk(38332, '/root/btc-signet/signet/.cookie', 'swap');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// maker posts a PARTIAL sell-BTC offer: sell up to 0.0002 BTC for 2 FRC
const mFrcAddr0 = await frc('getnewaddress');
const mid = pubkeyCompressed(hex(sha256(bin('rp-maker-id'.padEnd(64, '0')))));
const post = await api('p2pPostB', { partial: true, frcAmount: '200000000', btcAmount: '20000', makerFrcPub: mid, makerBtcPub: mid, makerFrcAddr: mFrcAddr0 });
console.log(`1. posted partial sell-BTC offer ${post.id}: sell up to 0.0002 BTC for 2 FRC`);

async function buyPiece(label, fillSats) {
  const tFrc = hex(sha256(bin(('rp-' + label + '-tfrc').padEnd(64, '0')))), tBtc = hex(sha256(bin(('rp-' + label + '-tbtc').padEnd(64, '0'))));
  const tBtcAddr = await btc('getnewaddress', '', 'bech32');
  const take = await api('p2pTakeB', { id: post.id, fill: String(fillSats), takerFrcPub: pubkeyCompressed(tFrc), takerBtcPub: pubkeyCompressed(tBtc), takerBtcAddr: tBtcAddr });
  const cid = take.id;
  // maker's per-child keys + secret
  const mFrc = hex(sha256(bin(('rp-' + label + '-mfrc').padEnd(64, '0')))), mBtc = hex(sha256(bin(('rp-' + label + '-mbtc').padEnd(64, '0'))));
  const R = hex(sha256(bin(('rp-' + label + '-R').padEnd(64, '0')))), H = paymentHashOf(R);
  const mFrcAddr = await frc('getnewaddress');
  // maker funds the BTC HTLC first (claim=taker, refund=maker, tb)
  const bh = await btc('getblockcount'), tb = bh + 12;
  const bleaf = btcHtlcLeaf({ paymentHash: H, claimPub: pubkeyCompressed(tBtc), refundPub: pubkeyCompressed(mBtc), cltv: tb });
  const baddr = btcHtlcAddress(bleaf, 'tb');
  const bFund = await btc('sendtoaddress', baddr, (fillSats / 1e8).toFixed(8));
  const r3 = await api('p2pBtcFundedB', { id: cid, btcTxid: bFund, tb, makerFrcPub: pubkeyCompressed(mFrc), makerBtcPub: pubkeyCompressed(mBtc), paymentHash: H });
  // taker funds the FRC HTLC (claim=maker, refund=taker, tf)
  const legF = frcLeg({ role: 'give', ourKey: tFrc, theirPub: pubkeyCompressed(mFrc), paymentHash: H, cltv: r3.frcHtlc.cltv, net: 'regtest' });
  const fFund = await frc('sendtoaddress', legF.address, (Number(BigInt(take.frcAmount)) / 1e8).toFixed(8));
  await frc('generatetoaddress', 1, await frc('getnewaddress'));
  const fRaw = await frc('getrawtransaction', fFund, true), fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
  await api('p2pFrcFundedB', { id: cid, txid: fFund, vout: fVout });
  // maker claims the FRC (reveals R)
  const f = (await api('p2pList')).swaps.find(x => x.id === cid).frcHtlc;
  const mRecvSpk = (await frc('getaddressinfo', mFrcAddr)).scriptPubKey;
  const cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: mFrc, toSpk: mRecvSpk, fee: 10000n });
  const r5 = await api('p2pFrcClaimB', { id: cid, rawtx: cF.rawtx });
  // taker claims the BTC with R
  const braw = await btc('getrawtransaction', bFund, true), bVout = braw.vout.findIndex(o => o.scriptPubKey.address === baddr);
  const tRecvSpk = (await btc('getaddressinfo', tBtcAddr)).scriptPubKey;
  const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: BigInt(Math.round(braw.vout[bVout].value * 1e8)), leafHex: bleaf, preimage: r5.preimage, claimKey: tBtc, toSpk: tRecvSpk, fee: 2000n });
  await btc('sendrawtransaction', cB.rawtx);
  await api('p2pDoneB', { id: cid });
  const rem = (await api('p2pList')).swaps.find(x => x.id === post.id)?.remaining;
  console.log(`   ✓ ${label}: sold ${fillSats / 1e8} BTC for ${Number(BigInt(take.frcAmount)) / 1e8} FRC  (child ${cid}, offer remaining ${rem != null ? Number(rem) / 1e8 : '—'} BTC)`);
}

await buyPiece('A', 8000);   // 0.00008 BTC
await buyPiece('B', 6000);   // 0.00006 BTC
console.log('\n✅ PARTIAL SELL-BTC WORKS — one offer, two independent reverse piece-swaps, remaining tracked.');
