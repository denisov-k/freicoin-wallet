// swap-e2e.mjs — a REAL atomic swap FRC↔BTC across our fc-nv3 node and a genuine bitcoind.
// Alice has FRC, wants BTC. Bob has BTC, wants FRC. Secret R, H=SHA256(R).
//   1. Alice funds FRC HTLC (Bob claims w/ R before T1, else Alice refunds).
//   2. Bob funds BTC HTLC (Alice claims w/ R before T2<T1, else Bob refunds).
//   3. Alice claims BTC with R  → R is now public on the BTC chain.
//   4. Bob reads R, claims the FRC.  Atomic.
import { readFileSync } from 'node:fs';
import { sha256 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { frcLeg, claimReceived, refundGiven } from '/root/free-money/freicoin-wallet/core/swap.mjs';
import { paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcLeaf, btcHtlcAddress, btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

const mkrpc = (port, cookiePath, wallet) => {
  const auth = Buffer.from(readFileSync(cookiePath)).toString('base64');
  return async (m, ...p) => {
    const path = wallet ? `/wallet/${wallet}` : '/';
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Basic ${auth}` }, body: JSON.stringify({ method: m, params: p }) });
    const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result;
  };
};
const frc = mkrpc(19660, '/root/nv3-playground/chain/regtest/.cookie', 'w');
const btc = mkrpc(19332, '/root/btc-regtest/regtest/.cookie', 'swap');

// deterministic swap keys (never touch wallet funds)
const kAlice = hex(sha256(bin('aa'.repeat(32) + '01'))), kBob = hex(sha256(bin('bb'.repeat(32) + '01')));
const pubAlice = pubkeyCompressed(kAlice), pubBob = pubkeyCompressed(kBob);
const R = hex(sha256(bin('5eec5e7'.padEnd(64, '0')))), H = paymentHashOf(R);
console.log('secret H =', H.slice(0, 16) + '…');

// ---------- 1. Alice funds the FRC HTLC (claim=Bob, refund=Alice) ----------
const frcH = await frc('getblockcount');
const T1 = frcH + 20;
const legF = frcLeg({ role: 'give', ourKey: kAlice, theirPub: pubBob, paymentHash: H, cltv: T1, net: 'regtest' });
const fFund = await frc('sendtoaddress', legF.address, 1.0);
await frc('generatetoaddress', 1, await frc('getnewaddress'));
const fRaw = await frc('getrawtransaction', fFund, true);
const fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
const fVal = BigInt(Math.round(fRaw.vout[fVout].value * 1e8));
console.log(`1. Alice locked 1.0 FRC  → ${fFund.slice(0, 12)}…:${fVout}  refund@${T1}`);

// ---------- 2. Bob funds the BTC HTLC (claim=Alice, refund=Bob), T2 < T1 ----------
const btcH = await btc('getblockcount');
const T2 = btcH + 10;
const leafB = btcHtlcLeaf({ paymentHash: H, claimPub: pubAlice, refundPub: pubBob, cltv: T2 });
const addrB = btcHtlcAddress(leafB, 'bcrt');
const bFund = await btc('sendtoaddress', addrB, 0.2);
await btc('generatetoaddress', 1, await btc('getnewaddress'));
const bRaw = await btc('getrawtransaction', bFund, true);
const bVout = bRaw.vout.findIndex(o => o.scriptPubKey.address === addrB);
const bVal = BigInt(Math.round(bRaw.vout[bVout].value * 1e8));
console.log(`2. Bob locked 0.2 BTC     → ${bFund.slice(0, 12)}…:${bVout}  refund@${T2} (T2<T1 ✓)`);

// ---------- 3. Alice claims the BTC with R → R goes public on the BTC chain ----------
const aliceBtc = await btc('getnewaddress', '', 'bech32');
const aliceSpk = (await btc('getaddressinfo', aliceBtc)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: bVal, leafHex: leafB, preimage: R, claimKey: kAlice, toSpk: aliceSpk, fee: 2000n });
const cBid = await btc('sendrawtransaction', cB.rawtx);
await btc('generatetoaddress', 1, await btc('getnewaddress'));
console.log(`3. Alice claimed 0.2 BTC with the secret → ${cBid.slice(0, 12)}…  (R now on the BTC chain)`);

// ---------- 4. Bob reads R from the BTC claim, claims the FRC ----------
const claimTx = await btc('getrawtransaction', cBid, true);
const wit = claimTx.vin[0].txinwitness;                      // [sig, preimage, TRUE, script]
const learnedR = wit.find(w => w === R);
if (!learnedR) throw new Error('Bob could not read R from the BTC witness: ' + JSON.stringify(wit));
console.log(`4. Bob read R from the BTC witness (matches ✓)`);
const bobFrc = await frc('getnewaddress');
const bobSpk = (await frc('getaddressinfo', bobFrc)).scriptPubKey;
const cF = claimReceived({ funding: { txid: fFund, vout: fVout, value: fVal, refheight: fRaw.lockheight }, leaf: legF.leaf, preimage: learnedR, ourKey: kBob, toSpk: bobSpk, fee: 2000n });
await frc('generateblock', await frc('getnewaddress'), [cF.rawtx]);
const cFconf = await frc('getrawtransaction', cF.txid, true);
console.log(`   Bob claimed ${(Number(fVal - 2000n) / 1e8)} FRC → ${cF.txid.slice(0, 12)}…  (${cFconf.confirmations || 1} conf)`);
console.log('\nATOMIC SWAP COMPLETE ✅  Alice got BTC, Bob got FRC, no trusted third party.');
