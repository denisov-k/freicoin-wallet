// HTLC engine test: exercise core/htlc.mjs against a live regtest node — fund an HTLC,
// then claim it with the preimage, refund another after its timeout, and confirm a wrong
// preimage is rejected. This proves the swap settlement primitive works from the wallet's
// own JS (not the python prototype).
import { randomBytes } from 'node:crypto';
import { cliR, check, finish } from './helpers.mjs';
import { configureNetwork } from '../src/wallet.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';
import { htlcLeaf, htlcAddress, htlcSpk, htlcClaim, htlcRefund, paymentHashOf } from '../../../core/htlc.mjs';

configureNetwork('regtest');
const NET = 'regtest';
const rand = () => randomBytes(32).toString('hex');
const height = () => Number(cliR('getblockcount'));
const mineAddr = cliR('getnewaddress');
const mine = (n = 1) => cliR('generatetoaddress', String(n), mineAddr);
const spent = (txid, vout) => !cliR('gettxout', txid, String(vout));   // gettxout empty ⇒ spent
const outSpk = JSON.parse(cliR('getaddressinfo', cliR('getnewaddress'))).scriptPubKey;

// Send `amountFrc` to an HTLC address; return its outpoint, value (kria) and refheight.
function fund(leafHex, amountFrc) {
  const txid = cliR('sendtoaddress', htlcAddress(leafHex, NET), String(amountFrc));
  const raw = JSON.parse(cliR('getrawtransaction', txid, 'true'));   // still in mempool → no txindex needed
  const spk = htlcSpk(leafHex);
  const vout = raw.vout.find(o => o.scriptPubKey.hex === spk).n;
  const value = BigInt(Math.round(raw.vout[vout].value * 1e8));
  const refheight = raw.lock_height ?? raw.lockheight ?? raw.refheight;
  mine();
  return { txid, vout, value, refheight };
}

const claimKey = rand(), refundKey = rand();
const claimPub = pubkeyCompressed(claimKey), refundPub = pubkeyCompressed(refundKey);
const preimage = rand();
const H = paymentHashOf(preimage);

// 1. claim with the correct preimage
const leaf1 = htlcLeaf({ paymentHash: H, claimPub, refundPub, cltv: height() + 30 });
const f1 = fund(leaf1, 5);
const claim = htlcClaim({ ...f1, prevTxid: f1.txid, leafHex: leaf1, preimage, claimKey, toSpk: outSpk });
cliR('sendrawtransaction', claim.rawtx); mine();
check('HTLC claimed with preimage (funding output spent)', spent(f1.txid, f1.vout), claim.txid.slice(0, 12));

// 2. refund after the timeout
const cltv2 = height() + 6;
const leaf2 = htlcLeaf({ paymentHash: H, claimPub, refundPub, cltv: cltv2 });
const f2 = fund(leaf2, 3);
// refund before the timeout must be rejected (non-final locktime)
const early = htlcRefund({ ...f2, prevTxid: f2.txid, leafHex: leaf2, cltv: cltv2, refundKey, toSpk: outSpk });
let earlyRejected = false;
try { cliR('sendrawtransaction', early.rawtx); } catch { earlyRejected = true; }
check('refund before timeout rejected', earlyRejected);
mine(cltv2 - height() + 1);                                          // advance past the timeout
const refund = htlcRefund({ ...f2, prevTxid: f2.txid, leafHex: leaf2, cltv: cltv2, refundKey, toSpk: outSpk });
cliR('sendrawtransaction', refund.rawtx); mine();
check('HTLC refunded after timeout', spent(f2.txid, f2.vout), refund.txid.slice(0, 12));

// 3. a wrong preimage cannot claim
const leaf3 = htlcLeaf({ paymentHash: H, claimPub, refundPub, cltv: height() + 30 });
const f3 = fund(leaf3, 2);
const bad = htlcClaim({ ...f3, prevTxid: f3.txid, leafHex: leaf3, preimage: rand(), claimKey, toSpk: outSpk });
let wrongRejected = false;
try { cliR('sendrawtransaction', bad.rawtx); } catch { wrongRejected = true; }
check('wrong preimage rejected', wrongRejected);
check('honest funds still claimable after (control)', !spent(f3.txid, f3.vout));

finish();
