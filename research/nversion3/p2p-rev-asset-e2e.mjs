// p2p-rev-asset-e2e.mjs — BUY a user-issued CONSTANT asset WITH BTC (reverse direction). Maker
// holds R and funds the BTC HTLC first; taker funds the ASSET HTLC; maker claims the ASSET (reveals
// R on fc-nv3, via htlcClaimAsset + a fee coin); taker claims BTC with R. Proven on live signet.
import { readFileSync } from 'node:fs';
import { sha256, sha256d, hash160 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { htlcSpk, htlcClaimAsset, paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcLeaf, btcHtlcAddress, btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';
import { encodeWitness } from '/root/free-money/freicoin-wallet/core/address.mjs';
import { assetPresentValue } from '/root/free-money/freicoin-wallet/core/assets.mjs';
import { serializeTx, txid as txidOf, NV3_TX_VERSION } from '/root/free-money/freicoin-wallet/core/tx.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '/root/free-money/freicoin-wallet/core/sighash.mjs';
import { signEcdsa } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';

const HOST20 = '00'.repeat(20), rev = h => h.match(/../g).reverse().join('');
// a MAST pay-to-pubkey coin under `key`: {spk, addr, code, sign(tx,i,value,refheight)}
function mastCoin(key) {
  const code = '21' + pubkeyCompressed(key) + 'ac', prog = hex(sha256d(bin('00' + code)));
  return { key, code, spk: '0020' + prog, addr: encodeWitness('regtest', 0, prog),
    witness: (tx, i, value, refheight) => { const sh = segwitV0Sighash(tx, i, code, BigInt(value), BigInt(refheight), SIGHASH_ALL); return [signEcdsa(key, sh) + '01', '00' + code, '']; } };
}

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const api = async (p, b) => { const r = await fetch(`http://127.0.0.1:5181/api/${p}`, b ? { method: 'POST', body: JSON.stringify(b) } : undefined); const j = await r.json(); if (j.error) throw new Error(`${p}: ${j.error}`); return j; };
const mk = (port, ck, w) => { const a = Buffer.from(readFileSync(ck)).toString('base64'); return async (m, ...p) => { const r = await fetch(`http://127.0.0.1:${port}${w ? '/wallet/' + w : ''}`, { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; }; };
const frc = mk(19660, '/root/nv3-playground/chain/regtest/.cookie', 'w');
const btc = mk(38332, '/root/btc-signet/signet/.cookie', 'swap');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function feeCoinFrom(label, pv = 0.001) {               // FRC coin in the wallet's P2WSH-MAST format
  const key = hex(sha256(bin(label.padEnd(64, '0'))));
  const code = '21' + pubkeyCompressed(key) + 'ac';
  const prog = hex(sha256d(bin('00' + code))), spk = '0020' + prog, addr = encodeWitness('regtest', 0, prog);
  const txid = await frc('sendtoaddress', addr, pv);
  await frc('generatetoaddress', 1, await frc('getnewaddress'));
  const raw = await frc('getrawtransaction', txid, true), vout = raw.vout.findIndex(o => o.scriptPubKey.hex === spk);
  const refheight = raw.lockheight;   // a coin's refheight is the creating tx's lockHeight, not the block height
  const value = BigInt(Math.round(raw.vout[vout].value * 1e8));
  return { txid, vout, value, refheight, spk, pv: value, key, script: code, changeSpk: spk };
}

// Maker (Alice): BUYS the asset, pays BTC, holds R.
const aFrc = hex(sha256(bin('ra-alice-frc'.padEnd(64, '0')))), aBtc = hex(sha256(bin('ra-alice-btc'.padEnd(64, '0'))));
const R = hex(sha256(bin('ra-secret'.padEnd(64, '0')))), H = paymentHashOf(R);
// Taker (Bob): SELLS the asset, gets BTC.
const bFrc = hex(sha256(bin('ra-bob-frc'.padEnd(64, '0')))), bBtc = hex(sha256(bin('ra-bob-btc'.padEnd(64, '0'))));
const ASSET_QTY = 1000n, BTC_AMT = 18000n;

// 0. issue the whole supply to a TAKER-controlled asset coin (Bob owns the asset he'll sell)
const iName = 'RevAsset' + Date.now().toString().slice(-6);
const assetCoinKey = mastCoin(hex(sha256(bin('ra-bob-asset'.padEnd(64, '0')))));
const seed0 = await api('issue', { name: iName, shift: 64, amount: String(ASSET_QTY + 20n), spk: assetCoinKey.spk });
const TAG = seed0.tag;
const acRaw = await frc('getrawtransaction', seed0.txid, true), acVout = acRaw.vout.findIndex(o => o.scriptPubKey.hex === assetCoinKey.spk);
const acRefh = acRaw.lockheight;   // a coin's refheight is the creating tx's lockHeight
console.log('0. issued 1000', iName, 'to Bob (asset coin', seed0.txid.slice(0, 10), `vout ${acVout})`);

const aFrcAddr = await frc('getnewaddress');
const post = await api('p2pPostB', { assetTag: TAG, frcAmount: String(ASSET_QTY), btcAmount: String(BTC_AMT), makerFrcPub: pubkeyCompressed(aFrc), makerBtcPub: pubkeyCompressed(aBtc), makerFrcAddr: aFrcAddr, paymentHash: H });
console.log(`1. Alice posted ${post.id}: buy 1000 ${iName} for 0.00018 BTC`);

const bBtcAddr = await btc('getnewaddress', '', 'bech32');
await api('p2pTakeB', { id: post.id, takerFrcPub: pubkeyCompressed(bFrc), takerBtcPub: pubkeyCompressed(bBtc), takerBtcAddr: bBtcAddr });
console.log('2. Bob took it');

// 3. Alice funds the BTC HTLC first (claim=Bob, refund=Alice, tb)
const bh = await btc('getblockcount'), tb = bh + 12;
const bleaf = btcHtlcLeaf({ paymentHash: H, claimPub: pubkeyCompressed(bBtc), refundPub: pubkeyCompressed(aBtc), cltv: tb });
const baddr = btcHtlcAddress(bleaf, 'tb');
const bFund = await btc('sendtoaddress', baddr, (Number(BTC_AMT) / 1e8).toFixed(8));
const r3 = await api('p2pBtcFundedB', { id: post.id, btcTxid: bFund, tb });
console.log(`3. Alice locked BTC; taker must fund the ASSET HTLC ${r3.frcHtlc.spk.slice(0, 14)}…`);

// 4. Bob funds the ASSET HTLC by SPENDING his asset coin into the relay-dictated spk (+ FRC fee)
const bobFee = await feeCoinFrom('ra-bob-fee');
const Lb = await frc('getblockcount');
const acPv = assetPresentValue(BigInt(Math.round(acRaw.vout[acVout].value * 1e8)), Lb - acRefh, { k: 64, interest: false });
const feePvB = assetPresentValue(bobFee.value, Lb - bobFee.refheight, { k: 20, interest: false });
const lockTx = {
  version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: Lb, nExpireTime: 0,
  vin: [{ prevout: { txid: rev(seed0.txid), vout: acVout }, scriptSig: '', sequence: 0xfffffffd, witness: [] },
        { prevout: { txid: rev(bobFee.txid), vout: bobFee.vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
  vout: [{ value: ASSET_QTY, scriptPubKey: r3.frcHtlc.spk, assetTag: TAG }],   // lock EXACTLY the offered amount
};
if (acPv - ASSET_QTY > 0n) lockTx.vout.push({ value: acPv - ASSET_QTY, scriptPubKey: assetCoinKey.spk, assetTag: TAG });   // asset change
if (feePvB - 10000n > 0n) lockTx.vout.push({ value: feePvB - 10000n, scriptPubKey: bobFee.spk, assetTag: HOST20 });
lockTx.vin[0].witness = assetCoinKey.witness(lockTx, 0, Math.round(acRaw.vout[acVout].value * 1e8), acRefh);
lockTx.vin[1].witness = mastCoin(bobFee.key).witness(lockTx, 1, bobFee.value, bobFee.refheight);
const lockRaw = serializeTx(lockTx), lockTxid = txidOf(lockTx);
await frc('generateblock', await frc('getnewaddress'), [lockRaw]);   // NV3-version tx: mine directly (non-standard for mempool)
await api('p2pFrcFundedB', { id: post.id, txid: lockTxid, vout: 0 });
console.log(`4. Bob locked ${ASSET_QTY} ${iName} in the ASSET HTLC (${lockTxid.slice(0, 12)}…)`);

// 5. Alice claims the ASSET with R (reveals R) — htlcClaimAsset + a fee coin
let w = (await api('p2pList')).swaps.find(x => x.id === post.id);
const f = w.frcHtlc;
const feeCoin = await feeCoinFrom('ra-alice-fee');
const L = await frc('getblockcount');
feeCoin.pv = assetPresentValue(feeCoin.value, L - feeCoin.refheight, { k: 20, interest: false });
const payout = assetPresentValue(BigInt(f.value), L - f.refheight, { k: 64, interest: false });
const aRecvSpk = (await frc('getaddressinfo', aFrcAddr)).scriptPubKey;
const cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: aFrc, toSpk: aRecvSpk, assetTag: TAG, payout, feeCoin, fee: 10000n, lockHeight: L });
const r5 = await api('p2pFrcClaimB', { id: post.id, rawtx: cF.rawtx });
console.log(`5. Alice claimed the ASSET — R revealed: ${(r5.preimage || '?').slice(0, 12)}…`);
if (!r5.preimage) throw new Error('relay did not surface R');

// 6. Bob claims the BTC with R
const braw = await btc('getrawtransaction', bFund, true), bVout = braw.vout.findIndex(o => o.scriptPubKey.address === baddr);
const bRecvSpk = (await btc('getaddressinfo', bBtcAddr)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: BigInt(Math.round(braw.vout[bVout].value * 1e8)), leafHex: bleaf, preimage: r5.preimage, claimKey: bBtc, toSpk: bRecvSpk, fee: 2000n });
const bClaim = await btc('sendrawtransaction', cB.rawtx);
await api('p2pDoneB', { id: post.id });
console.log(`6. Bob claimed the BTC → ${bClaim.slice(0, 12)}…`);

const claimRaw = await frc('getrawtransaction', cF.txid, true), got = claimRaw.vout.find(o => o.scriptPubKey.hex === aRecvSpk);
console.log(`   Alice got ${got ? Number(got.value * 1e8) + ' units' : '??'} of the asset`);
console.log('\n✅ REVERSE ASSET SWAP COMPLETE — bought a user-issued asset with real signet BTC, relay held nothing.');
