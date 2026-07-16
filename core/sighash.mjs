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
import { NV3_TX_VERSION } from './tx.mjs';
import { encodeAssetSpk } from './asset-spk.mjs';

export const SIGHASH_ALL = 1;
export const SIGHASH_NONE = 2;
export const SIGHASH_SINGLE = 3;
export const SIGHASH_ANYONECANPAY = 0x80;
export const SIGHASH_NO_LOCK_HEIGHT = 0x100; // Freicoin-specific
export const SIGHASH_BUNDLE = 0x40;          // nV3 DEX phase 2a: bundle-scoped signature

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
// nVersion=3 EXTENSION-OUTPUT: the asset tag rides INSIDE scriptPubKey (asset-spk.mjs), so the
// classic (value, spk) serialization already binds which asset an output pays — no separate tag
// field. Only the TOKEN SET (still a parallel block on v3 txs, token phase pending) needs an
// explicit commit against token-swap malleability. Mirrors the node's GetOutputsSHA256.
const HOST_TAG_HEX = '00'.repeat(20);   // still used by the ranged DESCRIPTOR digest (payoutAsset is a descriptor field, not an output)
const serTokens = toks => [...compactSize(toks.length), ...toks.flatMap(t => serString(t))];
// fold the asset tag into the spk (extension push) so the sighash binds it via the ordinary
// (value, scriptPubKey) serialization — exactly what the node commits. Full-spk outputs pass through.
const outSpkS = o => (o.assetTag && o.assetTag !== HOST_TAG_HEX) ? encodeAssetSpk(o.scriptPubKey, o.assetTag, o.tokens ?? [], o.tokenHash ?? null) : o.scriptPubKey;
const serOutput = (o, version) => version === NV3_TX_VERSION
  ? [...i64le(o.value), ...serString(outSpkS(o)), ...serTokens(o.tokens ?? [])]
  : [...i64le(o.value), ...serString(outSpkS(o))];

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
    hashOutputs = [...hash256(tx.vout.flatMap(o => serOutput(o, tx.version)))];
  } else if (base === SIGHASH_SINGLE && inIdx < tx.vout.length) {
    hashOutputs = [...hash256(serOutput(tx.vout[inIdx], tx.version))];
  }

  const ss = [
    ...u32le(tx.version),
    ...hashPrevouts,
    ...hashSequence,
    ...serPrevout(tx.vin[inIdx]),
    ...serString(scriptCodeHex),
    ...i64le(amount),
    // LATENT/UNRESOLVED: interpreter.cpp gates refheight+lock_height on !NO_LOCK_HEIGHT (drops
    // them), but the test-framework oracle (SegwitV0SignatureMsg) and our golden vectors KEEP
    // them under that flag — the two disagree. No wallet path sets NO_LOCK_HEIGHT, so it is moot
    // today; before any such signing path ships, settle which is authoritative with a live-node
    // signing test and regenerate the ht=257/321 vectors. Kept matching the vectors for now.
    ...i64le(refheight),                                    // Freicoin
    ...u32le(tx.vin[inIdx].sequence),
    ...hashOutputs,
    ...u32le(tx.nLockTime),
    ...u32le(tx.lockHeight),                                // Freicoin
    // nVersion=3-lite: commit nExpireTime (the mirror of nLockTime) — else a third party
    // could impose an expiry on a signed tx without breaking any signature.
    ...(tx.version === NV3_TX_VERSION ? u32le(tx.nExpireTime ?? 0) : []),
    ...u32le(hashtype & ~SIGHASH_NO_LOCK_HEIGHT),           // Freicoin: mask NO_LOCK_HEIGHT
  ];
  return bytesToHex(ss);
}

/** The signature hash itself = HASH256(preimage). Returns hex. */
export function segwitV0Sighash(tx, inIdx, scriptCodeHex, amount, refheight, hashtype) {
  return bytesToHex(hash256(hexToBytes(
    segwitV0SighashPreimage(tx, inIdx, scriptCodeHex, amount, refheight, hashtype))));
}

/** nV3 DEX phase 2a — the BUNDLE-scoped digest (SIGHASH_BUNDLE, 0x40): BIP143 with the
 *  prevouts/sequences/outputs hashes computed over the maker's BUNDLE SLICE instead of the
 *  whole transaction, plus the bundle's nExpireTime right after lock_height. The maker's
 *  signature therefore commits: their inputs (prevouts+sequences), their outputs (with asset
 *  tags + tokens — v3 rules), their expiry, and the valuation lock_height — and NOTHING
 *  outside, which is what makes bundles splice-safe. A signer needs only their own bundle:
 *  `bundle` = {vin:[...], vout:[...], nExpireTime}, `inIdx` indexes INTO THE BUNDLE. */
export function bundleSighash(bundle, inIdx, scriptCodeHex, amount, refheight,
                              { version = NV3_TX_VERSION, nLockTime = 0, lockHeight, hashtype = SIGHASH_ALL | SIGHASH_BUNDLE }) {
  const hashPrevouts = [...hash256(bundle.vin.flatMap(serPrevout))];
  const hashSequence = [...hash256(bundle.vin.flatMap(i => u32le(i.sequence)))];
  const hashOutputs = [...hash256(bundle.vout.flatMap(o => serOutput(o, version)))];
  const ss = [
    ...u32le(version),
    ...hashPrevouts,
    ...hashSequence,
    ...serPrevout(bundle.vin[inIdx]),
    ...serString(scriptCodeHex),
    ...i64le(amount),
    ...i64le(refheight),                                    // Freicoin
    ...u32le(bundle.vin[inIdx].sequence),
    ...hashOutputs,
    ...u32le(nLockTime),
    ...u32le(lockHeight),                                   // the fuzzer-mandated pin
    ...u32le(bundle.nExpireTime ?? 0),                      // bundle expiry (0 = never)
    ...u32le(hashtype & ~SIGHASH_NO_LOCK_HEIGHT),
  ];
  return bytesToHex(hash256(ss));
}

/** nV3 DEX phase 2b — the RANGED digest: same shape as bundleSighash, but the outputs hash
 *  is replaced by the hash of the maker-signed DESCRIPTOR (payout asset+script, price ratio,
 *  change script, fill bounds). The fill amount is deliberately absent — one signature serves
 *  every fill the constraint admits; consensus checks the miner's materialized outputs
 *  against the descriptor. desc = {payoutAsset(hex20), payoutScript, priceNum, priceDen,
 *  changeScript, minFill, maxFill}. */
export function rangedSighash(bundle, inIdx, scriptCodeHex, amount, refheight,
                              { version = NV3_TX_VERSION, nLockTime = 0, lockHeight, hashtype = SIGHASH_ALL | SIGHASH_BUNDLE }) {
  const d = bundle.desc;
  const descBytes = [
    ...hexToBytes(d.payoutAsset ?? HOST_TAG_HEX),
    ...serString(d.payoutScript),
    ...i64le(d.priceNum), ...i64le(d.priceDen),
    ...serString(d.changeScript),
    ...i64le(d.minFill), ...i64le(d.maxFill),
  ];
  const ss = [
    ...u32le(version),
    ...hash256(bundle.vin.flatMap(serPrevout)),
    ...hash256(bundle.vin.flatMap(i => u32le(i.sequence))),
    ...serPrevout(bundle.vin[inIdx]),
    ...serString(scriptCodeHex),
    ...i64le(amount),
    ...i64le(refheight),
    ...u32le(bundle.vin[inIdx].sequence),
    ...hash256(descBytes),                                  // the descriptor, NOT the outputs
    ...u32le(nLockTime),
    ...u32le(lockHeight),
    ...u32le(bundle.nExpireTime ?? 0),
    ...u32le(hashtype & ~SIGHASH_NO_LOCK_HEIGHT),
  ];
  return bytesToHex(hash256(ss));
}
