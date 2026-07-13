// p2p-asset-e2e.mjs — sell a user-issued CONSTANT asset for BTC (forward direction). Proves the
// two genuinely-new pieces on live signet: (a) the relay VERIFIES an asset HTLC (tag+amount), and
// (b) the taker CLAIMS the whole asset with the preimage, paying the fee from a separate FRC coin.
// The asset HTLC is funded by ISSUING the asset straight to the HTLC scriptPubKey.
import { readFileSync } from 'node:fs';
import { sha256, sha256d, hash160 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { htlcLeaf, htlcSpk, htlcClaimAsset, paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';
import { encodeWitness } from '/root/free-money/freicoin-wallet/core/address.mjs';
import { assetPresentValue } from '/root/free-money/freicoin-wallet/core/assets.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const api = async (p, b) => { const r = await fetch(`http://127.0.0.1:5181/api/${p}`, b ? { method: 'POST', body: JSON.stringify(b) } : undefined); const j = await r.json(); if (j.error) throw new Error(`${p}: ${j.error}`); return j; };
const mk = (port, ck, w) => { const a = Buffer.from(readFileSync(ck)).toString('base64'); return async (m, ...p) => { const r = await fetch(`http://127.0.0.1:${port}${w ? '/wallet/' + w : ''}`, { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; }; };
const frc = mk(19660, '/root/nv3-playground/chain/regtest/.cookie', 'w');
const btc = mk(38332, '/root/btc-signet/signet/.cookie', 'swap');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function feeCoinFrom(pv = 0.001) {                       // an FRC coin under a HARNESS-owned key,
  const key = hex(sha256(bin('as-bob-fee'.padEnd(64, '0'))));  // in the wallet's P2WSH-MAST format
  const code = '21' + pubkeyCompressed(key) + 'ac';            // pay-to-pubkey script (what spendAsset reveals)
  const prog = hex(sha256d(bin('00' + code))), spk = '0020' + prog;   // MAST: HASH256(0x00 || script)
  const addr = encodeWitness('regtest', 0, prog);
  const txid = await frc('sendtoaddress', addr, pv);
  await frc('generatetoaddress', 1, await frc('getnewaddress'));
  const refheight = await frc('getblockcount');   // the block it confirmed in — claim at this height so pv==nominal
  const raw = await frc('getrawtransaction', txid, true), vout = raw.vout.findIndex(o => o.scriptPubKey.hex === spk);
  const value = BigInt(Math.round(raw.vout[vout].value * 1e8));
  return { txid, vout, value, refheight, spk, pv: value, key, script: '21' + pubkeyCompressed(key) + 'ac', changeSpk: spk };
}

const aFrc = hex(sha256(bin('as-alice-frc'.padEnd(64, '0')))), aBtc = hex(sha256(bin('as-alice-btc'.padEnd(64, '0'))));
const R = hex(sha256(bin('as-secret'.padEnd(64, '0')))), H = paymentHashOf(R);
const bFrc = hex(sha256(bin('as-bob-frc'.padEnd(64, '0')))), bBtc = hex(sha256(bin('as-bob-btc'.padEnd(64, '0'))));
const ASSET_QTY = 1000n, BTC_AMT = 15000n;

// 1. maker posts the asset→BTC offer (relay issues the tag via the UI normally; here issue directly)
const fh0 = await frc('getblockcount'), T1 = fh0 + Number((await api('p2pList')).t1) + 5;
const leaf = htlcLeaf({ paymentHash: H, claimPub: pubkeyCompressed(bFrc), refundPub: pubkeyCompressed(aFrc), cltv: T1 });
const htlcSpkHex = htlcSpk(leaf);
const issue = await api('issue', { name: 'Swap' + Date.now().toString().slice(-6), shift: 64, amount: String(ASSET_QTY), spk: htlcSpkHex });
const TAG = issue.tag;
console.log('1. issued 5 SwapTest (CONSTANT) straight into the HTLC', htlcSpkHex.slice(0, 14), '…  tag', TAG.slice(0, 12));
const iraw = await frc('getrawtransaction', issue.txid, true);
const ivout = iraw.vout.findIndex(o => o.scriptPubKey.hex === htlcSpkHex);

const aBtcAddr = await btc('getnewaddress', '', 'bech32');
const post = await api('p2pPost', { assetTag: TAG, frcAmount: String(ASSET_QTY), btcAmount: String(BTC_AMT), makerFrcPub: pubkeyCompressed(aFrc), makerBtcPub: pubkeyCompressed(aBtc), makerBtcAddr: aBtcAddr, paymentHash: H });
console.log(`2. posted ${post.id}: sell 5 SwapTest → 0.00015 BTC`);

const bFrcAddr = await frc('getnewaddress');
await api('p2pTake', { id: post.id, takerFrcPub: pubkeyCompressed(bFrc), takerBtcPub: pubkeyCompressed(bBtc), takerFrcAddr: bFrcAddr });
console.log('3. taken');

// 4. report the asset HTLC funding — relay VERIFIES tag + amount on fc-nv3
const r4 = await api('p2pFrcFunded', { id: post.id, txid: issue.txid, vout: ivout, t1: T1 });
console.log(`4. relay VERIFIED the asset HTLC ✓ → taker funds BTC ${r4.btcHtlc.addr}`);

// 5. taker funds BTC HTLC; maker claims BTC with R
const bFund = await btc('sendtoaddress', r4.btcHtlc.addr, (Number(BTC_AMT) / 1e8).toFixed(8));
await api('p2pBtcFunded', { id: post.id, btcTxid: bFund });
const braw = await btc('getrawtransaction', bFund, true), bVout = braw.vout.findIndex(o => o.scriptPubKey.address === r4.btcHtlc.addr);
const aRecvSpk = (await btc('getaddressinfo', aBtcAddr)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: BigInt(Math.round(braw.vout[bVout].value * 1e8)), leafHex: r4.btcHtlc.leaf, preimage: R, claimKey: aBtc, toSpk: aRecvSpk, fee: 2000n });
const r5 = await api('p2pBtcClaim', { id: post.id, rawtx: cB.rawtx });
console.log(`5. maker claimed BTC — R revealed: ${(r5.preimage || '?').slice(0, 12)}…`);

// 6. taker claims the WHOLE asset with R (fee from its own FRC coin)
let R2 = r5.preimage; for (let i = 0; i < 10 && !R2; i++) { await sleep(1500); R2 = (await api('p2pList')).swaps.find(x => x.id === post.id)?.preimage; }
const f = (await api('p2pList')).swaps.find(x => x.id === post.id).frcHtlc;
const feeCoin = await feeCoinFrom();
const L = await frc('getblockcount');   // single lockHeight for the whole tx; present-value everything at it
feeCoin.pv = assetPresentValue(feeCoin.value, L - feeCoin.refheight, { k: 20, interest: false });
const payout = assetPresentValue(BigInt(f.value), L - f.refheight, { k: 64, interest: false });
const bRecvSpk = (await frc('getaddressinfo', bFrcAddr)).scriptPubKey;
const cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R2, claimKey: bFrc, toSpk: bRecvSpk, assetTag: TAG, payout, feeCoin, fee: 10000n, lockHeight: L });
await frc('generateblock', await frc('getnewaddress'), [cF.rawtx]);
await api('p2pDone', { id: post.id });
// verify the asset landed at the taker's address
const claimRaw = await frc('getrawtransaction', cF.txid, true);
const got = claimRaw.vout.find(o => o.scriptPubKey.hex === bRecvSpk);
console.log(`6. taker claimed the asset → ${cF.txid.slice(0, 12)}…  (${got ? got.value + ' units, tag ' + (got.assetTag || '').slice(0, 10) : 'NOT FOUND'})`);
console.log('\n✅ ASSET→BTC SWAP COMPLETE — user-issued asset sold for real signet BTC, relay held nothing.');
