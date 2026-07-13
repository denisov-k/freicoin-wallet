// htlc.mjs — Freicoin HTLC (hash-time-locked contract) primitive: lock coins redeemable
// by a preimage or refundable after a timeout. This is the settlement core under
// cross-chain atomic swaps (FRC leg) and demurrage escrow. Proven end-to-end against a
// real bitcoind in research/lightning/ln_phase3_btc_swap.py; this is its product-code port.
//
// Freicoin specifics baked in: witness v0 is a MAST program (P2WSH long-hash =
// HASH256(0x00 || script), NOT sha256(script)); the segwit-v0 sighash commits refheight
// and lock_height; CLTV CONSUMES its argument (no OP_DROP). Amounts are BigInt kria.
import { sha256, sha256d } from './crypto.mjs';
import { signEcdsa } from './ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from './sighash.mjs';
import { serializeTx, txid, NV3_TX_VERSION } from './tx.mjs';
import { encodeWitness } from './address.mjs';

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, SHA256: 0xa8, EQUALVERIFY: 0x88, CHECKSIG: 0xac, CLTV: 0xb1 };
const op = x => x.toString(16).padStart(2, '0');
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

// minimal data push for items ≤ 75 bytes (all our pushes: 32-byte hash, 33-byte pubkey, small numbers)
function push(hex) {
  const n = hex.length / 2;
  if (n === 0) return '00';                 // OP_0 / empty push (false)
  if (n >= 0x4c) throw new Error('htlc push >75B unsupported');
  return op(n) + hex;
}

// CScriptNum minimal encoding of a positive integer (a block height), as a data push.
function scriptNum(n) {
  if (n <= 0) throw new Error('cltv height must be > 0');
  const b = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.push(v & 0xff);
  if (b[b.length - 1] & 0x80) b.push(0x00);  // extra byte so the top bit isn't read as sign
  return push(bytesToHex(Uint8Array.from(b)));
}

/** The HTLC witness script (hex): claim with (preimage, claimPub) or refund after cltv with refundPub. */
export function htlcLeaf({ paymentHash, claimPub, refundPub, cltv }) {
  return op(OP.IF) + op(OP.SHA256) + push(paymentHash) + op(OP.EQUALVERIFY) + push(claimPub)
       + op(OP.ELSE) + scriptNum(cltv) + op(OP.CLTV) + push(refundPub)   // Freicoin CLTV: no OP_DROP
       + op(OP.ENDIF) + op(OP.CHECKSIG);
}

// P2WSH-MAST for a single-leaf tree: program = HASH256(0x00 || leaf); reveal = 0x00 || leaf, empty proof.
const wshProgram = leafHex => bytesToHex(sha256d(hexToBytes('00' + leafHex)));
export const htlcSpk = leafHex => '0020' + wshProgram(leafHex);
export const htlcAddress = (leafHex, net) => encodeWitness(net, 0, wshProgram(leafHex));

// Shared spend builder. `satisfier` is the branch-select stack below the script reveal.
function spend({ prevTxid, vout, value, refheight, leafHex, toSpk, key, satisfier, nLockTime = 0, fee = 2000n }) {
  const tx = {
    version: 2, hasWitness: true, flags: 1, nLockTime, lockHeight: refheight,
    // prevout txid is serialized in internal (little-endian) byte order — reverse the display txid
    vin: [{ prevout: { txid: prevTxid.match(/../g).reverse().join(''), vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
    vout: [{ value: value - fee, scriptPubKey: toSpk }],
  };
  const sh = segwitV0Sighash(tx, 0, leafHex, value, refheight, SIGHASH_ALL);
  const sig = signEcdsa(key, sh) + '01';                       // DER + SIGHASH_ALL
  tx.vin[0].witness = [sig, ...satisfier, '00' + leafHex, ''];  // …, script reveal, empty MAST proof
  return { rawtx: serializeTx(tx), txid: txid(tx) };
}

/** Claim a funded HTLC by revealing the preimage (claimant signs). */
export function htlcClaim({ prevTxid, vout, value, refheight, leafHex, preimage, claimKey, toSpk, fee }) {
  // satisfier: [preimage, TRUE] → OP_IF takes the claim branch, OP_SHA256 hashes the preimage.
  return spend({ prevTxid, vout, value, refheight, leafHex, toSpk, key: claimKey,
    satisfier: [preimage, '01'], fee });
}

/** Refund a funded HTLC after its timeout (maker signs; requires chain height ≥ cltv). */
export function htlcRefund({ prevTxid, vout, value, refheight, leafHex, cltv, refundKey, toSpk, fee }) {
  // satisfier: [FALSE] → OP_IF takes the refund branch; nLockTime = cltv enforces the timelock.
  return spend({ prevTxid, vout, value, refheight, leafHex, toSpk, key: refundKey,
    satisfier: [''], nLockTime: cltv, fee });
}

/** paymentHash = SHA256(preimage), both hex. */
export const paymentHashOf = preimageHex => bytesToHex(sha256(hexToBytes(preimageHex)));

// ---- ASSET HTLC spend: the locked coin carries an nV3 assetTag, so the fee cannot come out of
// the payout (it is not host currency). Two inputs — [HTLC asset coin, host fee coin] — and the
// asset passes WHOLE to `toSpk` with its tag preserved; host change returns to the fee owner.
// `payout` is the asset value to emit (present value at lockHeight — for constant assets, the
// nominal). feeCoin: {txid, vout, value, refheight, pv, key, script, changeSpk} — pv is the host
// coin's present value at lockHeight; script is its witness script hex ('21<pub>ac'-style).
const HOST20 = '00'.repeat(20);
function spendAsset({ funding, leafHex, toSpk, key, satisfier, assetTag, payout, feeCoin, fee = 10000n, lockHeight, nLockTime = 0 }) {
  const revh = h => h.match(/../g).reverse().join('');
  const tx = {
    // NV3 version (high-bit set) is REQUIRED: only then does serializeTx emit the per-output
    // assetTag — with plain version 2 the tag is dropped and the asset appears not-conserved.
    version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime, lockHeight, nExpireTime: 0,
    vin: [
      { prevout: { txid: revh(funding.txid), vout: funding.vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] },
      { prevout: { txid: revh(feeCoin.txid), vout: feeCoin.vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] },
    ],
    vout: [{ value: payout, scriptPubKey: toSpk, assetTag }],
  };
  const change = BigInt(feeCoin.pv) - fee;
  if (change > 0n) tx.vout.push({ value: change, scriptPubKey: feeCoin.changeSpk, assetTag: HOST20 });
  const sh0 = segwitV0Sighash(tx, 0, leafHex, BigInt(funding.value), BigInt(funding.refheight), SIGHASH_ALL);
  tx.vin[0].witness = [signEcdsa(key, sh0) + '01', ...satisfier, '00' + leafHex, ''];
  const sh1 = segwitV0Sighash(tx, 1, feeCoin.script, BigInt(feeCoin.value), BigInt(feeCoin.refheight), SIGHASH_ALL);
  tx.vin[1].witness = [signEcdsa(feeCoin.key, sh1) + '01', '00' + feeCoin.script, ''];
  return { rawtx: serializeTx(tx), txid: txid(tx) };
}
/** Claim an asset HTLC with the preimage (claimant signs; fee from a separate host coin). */
export function htlcClaimAsset({ funding, leafHex, preimage, claimKey, toSpk, assetTag, payout, feeCoin, fee, lockHeight }) {
  return spendAsset({ funding, leafHex, toSpk, key: claimKey, satisfier: [preimage, '01'], assetTag, payout, feeCoin, fee, lockHeight });
}
/** Refund an asset HTLC after its timeout. */
export function htlcRefundAsset({ funding, leafHex, cltv, refundKey, toSpk, assetTag, payout, feeCoin, fee, lockHeight }) {
  return spendAsset({ funding, leafHex, toSpk, key: refundKey, satisfier: [''], assetTag, payout, feeCoin, fee, lockHeight, nLockTime: cltv });
}
