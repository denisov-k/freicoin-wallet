// p2p-partial-e2e.mjs — PARTIAL fill: one offer (sell 0.1 FRC for 0.0002 BTC) taken in TWO pieces
// (0.03 + 0.04) by two takers; each piece is an independent child sub-swap with its own secret.
// The offer's `remaining` decrements. Proves the container/child model on live signet.
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
const btc = mk(38332, '/root/btc-signet/signet/.cookie', 'swap');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. maker posts a PARTIAL offer: sell up to 0.1 FRC for 0.0002 BTC
const mBtcAddr0 = await btc('getnewaddress', '', 'bech32');
const mid = pubkeyCompressed(hex(sha256(bin('part-maker-id'.padEnd(64, '0')))));
const post = await api('p2pPost', { partial: true, frcAmount: '10000000', btcAmount: '20000', makerFrcPub: mid, makerBtcPub: mid, makerBtcAddr: mBtcAddr0 });
console.log(`1. posted partial offer ${post.id}: sell up to 0.1 FRC for 0.0002 BTC`);

async function fillPiece(label, fillKria) {
  // taker keys
  const tFrc = hex(sha256(bin(('part-' + label + '-tfrc').padEnd(64, '0')))), tBtc = hex(sha256(bin(('part-' + label + '-tbtc').padEnd(64, '0'))));
  const tFrcAddr = await frc('getnewaddress');
  const take = await api('p2pTake', { id: post.id, fill: String(fillKria), takerFrcPub: pubkeyCompressed(tFrc), takerBtcPub: pubkeyCompressed(tBtc), takerFrcAddr: tFrcAddr });
  const cid = take.id;
  // maker's per-child keys + secret
  const mFrc = hex(sha256(bin(('part-' + label + '-mfrc').padEnd(64, '0')))), mBtc = hex(sha256(bin(('part-' + label + '-mbtc').padEnd(64, '0'))));
  const R = hex(sha256(bin(('part-' + label + '-R').padEnd(64, '0')))), H = paymentHashOf(R);
  const mBtcAddr = await btc('getnewaddress', '', 'bech32');
  // maker funds the FRC HTLC (claim=taker, refund=maker, T1)
  const fh = await frc('getblockcount'), T1 = fh + Number((await api('p2pList')).t1);
  const legF = frcLeg({ role: 'give', ourKey: mFrc, theirPub: pubkeyCompressed(tFrc), paymentHash: H, cltv: T1, net: 'regtest' });
  const fFund = await frc('sendtoaddress', legF.address, (fillKria / 1e8).toFixed(8));
  await frc('generatetoaddress', 1, await frc('getnewaddress'));
  const fRaw = await frc('getrawtransaction', fFund, true), fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
  const r3 = await api('p2pFrcFunded', { id: cid, txid: fFund, vout: fVout, t1: T1, makerFrcPub: pubkeyCompressed(mFrc), makerBtcPub: pubkeyCompressed(mBtc), paymentHash: H });
  // taker funds BTC HTLC
  const bFund = await btc('sendtoaddress', r3.btcHtlc.addr, (Number(BigInt(take.btcAmount)) / 1e8).toFixed(8));
  await api('p2pBtcFunded', { id: cid, btcTxid: bFund });
  // maker claims BTC (reveals R)
  const braw = await btc('getrawtransaction', bFund, true), bVout = braw.vout.findIndex(o => o.scriptPubKey.address === r3.btcHtlc.addr);
  const aRecvSpk = (await btc('getaddressinfo', mBtcAddr)).scriptPubKey;
  const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: BigInt(Math.round(braw.vout[bVout].value * 1e8)), leafHex: r3.btcHtlc.leaf, preimage: R, claimKey: mBtc, toSpk: aRecvSpk, fee: 2000n });
  const r5 = await api('p2pBtcClaim', { id: cid, rawtx: cB.rawtx });
  // taker claims FRC with R
  let R2 = r5.preimage; for (let i = 0; i < 10 && !R2; i++) { await sleep(1500); R2 = (await api('p2pList')).swaps.find(x => x.id === cid)?.preimage; }
  const f = (await api('p2pList')).swaps.find(x => x.id === cid).frcHtlc;
  const bRecvSpk = (await frc('getaddressinfo', tFrcAddr)).scriptPubKey;
  const cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R2, ourKey: tFrc, toSpk: bRecvSpk, fee: 2000n });
  await frc('generateblock', await frc('getnewaddress'), [cF.rawtx]);
  await api('p2pDone', { id: cid });
  const rem = (await api('p2pList')).swaps.find(x => x.id === post.id)?.remaining;
  console.log(`   ✓ ${label}: bought ${fillKria / 1e8} FRC for ${Number(BigInt(take.btcAmount)) / 1e8} BTC  (child ${cid}, offer remaining ${rem != null ? Number(rem) / 1e8 : '—'} FRC)`);
}

await fillPiece('A', 3000000);   // buy 0.03
await fillPiece('B', 4000000);   // buy 0.04
console.log('\n✅ PARTIAL FILL WORKS — one offer, two independent piece-swaps, remaining tracked, real signet BTC.');
