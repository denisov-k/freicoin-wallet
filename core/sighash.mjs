// sighash.mjs — Freicoin SegwitV0 (witness v0) signature hash.
//
// This is BIP143 with three Freicoin-specific changes (all consensus, all
// exercised below). Vs bitcoin's BIP143 preimage:
//   1. after `amount` (int64 LE) comes `refheight` (int64 LE)  <-- Freicoin
//   2. after `nLockTime` comes `lock_height` (uint32 LE)       <-- Freicoin
//   3. the sighash-type word is (hashtype & ~SIGHASH_NO_LOCK_HEIGHT) so the
//      0x100 NO_LOCK_HEIGHT flag never enters the preimage      <-- Freicoin
// Reference: test/functional/test_framework/script.py SegwitV0SignatureMsg.
import { sha256 } from './crypto.mjs';

export const SIGHASH_ALL = 1;
export const SIGHASH_NONE = 2;
export const SIGHASH_SINGLE = 3;
export const SIGHASH_ANYONECANPAY = 0x80;
export const SIGHASH_NO_LOCK_HEIGHT = 0x100; // Freicoin-specific

export const hash256 = b => sha256(sha256(b));

const hexToBytes = h => (h.match(/../g) ?? []).map(x => parseInt(x, 16));
const bytesToHex = b => Buffer.from(b).toString('hex');

const u32le = v => [0, 1, 2, 3].map(i => (v >>> (8 * i)) & 0xff);
// signed int64 little-endian from a BigInt (two's complement)
function i64le(v) {
  let x = BigInt(v) & ((1n << 64n) - 1n);
  return Array.from({ length: 8 }, (_, i) => Number((x >> (8n * BigInt(i))) & 0xffn));
}
function compactSize(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff];
  return [0xfe, ...u32le(n >>> 0)];
}
const serString = hex => { const b = hexToBytes(hex); return [...compactSize(b.length), ...b]; };
const serPrevout = i => [...hexToBytes(i.prevout.txid), ...u32le(i.prevout.vout)];
const serOutput = o => [...i64le(o.value), ...serString(o.scriptPubKey)];

/**
 * Build the Freicoin SegwitV0 signature-hash preimage (returns hex).
 * @param tx     parsed tx (tx.mjs): {version, vin:[{prevout:{txid,vout},sequence}], vout:[{value,scriptPubKey}], nLockTime, lockHeight}
 * @param inIdx  index of the input being signed
 * @param scriptCodeHex  the BIP143 scriptCode (e.g. the implicit P2PKH for a wpk spend)
 * @param amount bigint kria of the output being spent
 * @param refheight  the spent coin's refheight (Freicoin)
 * @param hashtype  e.g. SIGHASH_ALL, optionally |ANYONECANPAY |NO_LOCK_HEIGHT
 */
export function segwitV0SighashPreimage(tx, inIdx, scriptCodeHex, amount, refheight, hashtype) {
  const ZERO = new Array(32).fill(0);
  const anyonecanpay = (hashtype & SIGHASH_ANYONECANPAY) !== 0;
  const base = hashtype & 0x1f;

  let hashPrevouts = ZERO, hashSequence = ZERO, hashOutputs = ZERO;
  if (!anyonecanpay) {
    hashPrevouts = [...hash256(tx.vin.flatMap(serPrevout))];
  }
  if (!anyonecanpay && base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) {
    hashSequence = [...hash256(tx.vin.flatMap(i => u32le(i.sequence)))];
  }
  if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) {
    hashOutputs = [...hash256(tx.vout.flatMap(serOutput))];
  } else if (base === SIGHASH_SINGLE && inIdx < tx.vout.length) {
    hashOutputs = [...hash256(serOutput(tx.vout[inIdx]))];
  }

  const ss = [
    ...u32le(tx.version),
    ...hashPrevouts,
    ...hashSequence,
    ...serPrevout(tx.vin[inIdx]),
    ...serString(scriptCodeHex),
    ...i64le(amount),
    ...i64le(refheight),                                    // Freicoin
    ...u32le(tx.vin[inIdx].sequence),
    ...hashOutputs,
    ...u32le(tx.nLockTime),
    ...u32le(tx.lockHeight),                                // Freicoin
    ...u32le(hashtype & ~SIGHASH_NO_LOCK_HEIGHT),           // Freicoin: mask NO_LOCK_HEIGHT
  ];
  return bytesToHex(ss);
}

/** The signature hash itself = HASH256(preimage). Returns hex. */
export function segwitV0Sighash(tx, inIdx, scriptCodeHex, amount, refheight, hashtype) {
  return bytesToHex(hash256(hexToBytes(
    segwitV0SighashPreimage(tx, inIdx, scriptCodeHex, amount, refheight, hashtype))));
}
