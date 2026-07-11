// assets.mjs — executable reference model for nVersion=3-lite: fungible, user-issued assets
// with per-asset demurrage or interest. This is the SPEC as running, tested code — every
// consensus rule pinned down here BEFORE any C++ touches the node. It is a deliberate STRICT
// SUBSET of the 2013 Freimarkets whitepaper, chosen to remove every fatal risk we catalogued:
//
//   IN  : fungible assets; integer-kria amounts; per-asset rate = signed power-of-two shift
//         (reuses the proven demurrage kernel family); FRC as the fee currency; per-asset
//         balance conservation in present value; asset-definition (mint) transactions.
//   OUT : decimal64 amounts; unique/indivisible tokens; extrospection opcodes; private
//         accounting servers; authorizer/KYC signatories; arbitrary (non-power-of-two) rates.
//
// Everything here maps 1:1 to a future C++ port + testnet activation. Nothing here runs on
// the live chain — a model is even safer than testnet.
import { sha256, ripemd160 } from './crypto.mjs';
import { timeAdjustValue } from './demurrage.mjs';

const hexToBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const u32 = n => { const a = []; for (let i = 0; i < 4; i++) a.push((n >>> (8 * i)) & 0xff); return a; };

// ---- per-asset present value ---------------------------------------------------------
// FRC melts by factor (1 − 2^-20) per block. A user asset picks its own shift k (rate
// 2^-k per block) and a sign: DEMURRAGE (melts, like FRC) or INTEREST (grows — a bond).
//
// CANONICAL GENERALISATION (empirically resolved — research/nversion3/verify_kernel.py):
// the existing FRC kernel is an exponentiation ladder of (1 − 2^-20)^(2^bit) in 0.64 fixed
// point. Regenerating that ladder for an arbitrary shift k requires ≥96 fractional GUARD
// BITS during the squaring (naive 64-bit squaring drifts by a few ULPs and does NOT match
// the shipped table). With 96 guard bits the ladder + the kernel's own 64-bit truncating
// multiplies reproduce FRC bit-for-bit at k=20 over every test vector — so demurrage assets
// share one canonical algorithm with the host currency. This is what the C++ port implements.
const M64 = (1n << 64n) - 1n;
function demurrageLadder(k) {                    // 26 entries, 64 fractional bits each
  const P = 96n; let c = (1n << P) - (1n << (P - BigInt(k))); const L = [];
  for (let bit = 0; bit < 26; bit++) { L.push((c >> (P - 64n)) & M64); c = (c * c) >> P; }
  return L;
}
function demurragePV(nominal, distance, k) {     // exact structural port of TimeAdjustValueForward
  if (distance === 0) return nominal;
  if (distance >= (1 << 26)) return 0n;
  const sign = nominal > 0n ? 1n : nominal < 0n ? -1n : 0n, v = nominal < 0n ? -nominal : nominal;
  const L = demurrageLadder(k); let w = null;
  for (let bit = 0; bit < 26; bit++) if ((distance >> bit) & 1) { const e = L[bit]; if (w === null) { w = e; continue; } w = (w * e) >> 64n; }
  if (w === null) return nominal;
  return sign * ((v * w) >> 64n);
}
function interestPV(nominal, distance, k) {      // model-only: growth needs a >1.0 representation
  const P = 96n; let acc = 1n << P, base = (1n << P) + (1n << (P - BigInt(k))), e = BigInt(distance);
  while (e > 0n) { if (e & 1n) acc = (acc * base) >> P; base = (base * base) >> P; e >>= 1n; }
  return (nominal * acc) >> P;
}
export function assetPresentValue(nominal, distance, { k, interest }) {
  if (distance === 0) return nominal;
  if (interest) return interestPV(nominal, distance, k);
  if (k === 20) return timeAdjustValue(nominal, distance);   // FRC fast path (== demurragePV(…,20))
  return demurragePV(nominal, distance, k);
}
// exposed so the test can assert the general method is canonical-consistent with the kernel
export const _demurragePV = demurragePV;

// ---- asset identity ------------------------------------------------------------------
// An asset's 20-byte tag = RIPEMD160(SHA256(canonical asset-definition bytes)), mirroring the
// whitepaper (FRC's tag is the same hash of the genesis block). Deterministic → the same
// definition always yields the same id, and a different rate/granularity is a different asset.
export const FRC = 'frc';   // sentinel tag for the host currency in this model
export function serializeAssetDef(def) {
  // fields fixed & ordered so the id is canonical: shift(1) | flags(1) | granularity(8) | contractHash(32)
  // | optional authorizer pubkey (appended only when present, so authorizer-less defs are unchanged).
  const flags = (def.interest ? 1 : 0) | (def.authorizer ? 2 : 0);
  const gran = []; let g = BigInt(def.granularity ?? 1); for (let i = 0; i < 8; i++) { gran.push(Number(g & 0xffn)); g >>= 8n; }
  const base = [def.k & 0xff, flags, ...gran, ...hexToBytes((def.contractHash ?? '').padEnd(64, '0'))];
  return bytesToHex(Uint8Array.from(def.authorizer ? [...base, ...hexToBytes(def.authorizer)] : base));
}
export function assetIdOf(def) {
  return bytesToHex(ripemd160(sha256(hexToBytes(serializeAssetDef(def)))));
}

// ---- nVersion=3-lite wire format -----------------------------------------------------
// The ONLY structural change vs the current tx format: version==3 and every output gains a
// 20-byte asset tag prefix. FRC uses a reserved sentinel tag (the real chain uses
// RIPEMD160(SHA256(genesis))). nV3-lite deliberately OMITS the whitepaper's per-output token
// list, signatories, validation scripts and nExpireTime. Inputs, witness, nLockTime and the
// Freicoin lock_height are unchanged, so parsers reuse the existing machinery for everything
// but the vout loop. Assets ride in the same tx as FRC (the fee currency).
export const FRC_WIRE_TAG = 'ff'.repeat(20);      // 20-byte host-currency sentinel in the model
const tagOf = id => id === FRC ? FRC_WIRE_TAG : id;
const idOfTag = t => t === FRC_WIRE_TAG ? FRC : t;
const u32le = n => { const a = []; for (let i = 0; i < 4; i++) a.push((n >>> (8 * i)) & 0xff); return a; };
const u64le = v => { const a = []; for (let i = 0n; i < 8n; i++) a.push(Number((v >> (8n * i)) & 0xffn)); return a; };
const cs = n => n < 0xfd ? [n] : [0xfd, n & 0xff, (n >> 8) & 0xff];
const toHex = a => a.map(b => b.toString(16).padStart(2, '0')).join('');

/** Serialize an nV3-lite output list (asset-tagged). out = {assetId, value(BigInt), scriptPubKey(hex)}. */
export function serializeNv3Outputs(outputs) {
  const a = [...cs(outputs.length)];
  for (const o of outputs) {
    a.push(...hexToBytes(tagOf(o.assetId)));       // 20-byte asset tag
    a.push(...u64le(o.value));                     // amount of THAT asset
    const spk = hexToBytes(o.scriptPubKey); a.push(...cs(spk.length), ...spk);
  }
  return toHex(a);
}

/** The BIP143 `hashOutputs` for an nV3 tx: hash256 over each output's (assetTag‖value‖spk),
 *  WITHOUT a count prefix. Because the asset tag is inside the preimage, a signature commits to
 *  WHICH asset each output pays — an attacker cannot swap an output's tag without invalidating
 *  every signature. This is the one change the C++ SegwitV0 sighash needs for nV3. */
export function nv3HashOutputs(outputs) {
  const a = [];
  for (const o of outputs) {
    a.push(...hexToBytes(tagOf(o.assetId)));
    a.push(...u64le(o.value));
    const spk = hexToBytes(o.scriptPubKey); a.push(...cs(spk.length), ...spk);
  }
  return bytesToHex(sha256(sha256(Uint8Array.from(a))));
}

/** Parse it back — round-trip inverse of serializeNv3Outputs. */
export function parseNv3Outputs(hex) {
  const b = hexToBytes(hex); let p = 0;
  const rd = n => { const s = b.slice(p, p + n); p += n; return s; };
  const csz = () => { const n = b[p++]; return n < 0xfd ? n : (b[p++] | (b[p++] << 8)); };
  const n = csz(), outs = [];
  for (let i = 0; i < n; i++) {
    const assetId = idOfTag(bytesToHex(rd(20)));
    let value = 0n; for (let j = 0n; j < 8n; j++) value += BigInt(b[p++]) << (8n * j);
    const spk = bytesToHex(rd(csz()));
    outs.push({ assetId, value, scriptPubKey: spk });
  }
  return outs;
}

// ---- validation ----------------------------------------------------------------------
// A UTXO in the model: { assetId, value (BigInt kria of that asset), refheight }.
// Outputs of a transfer are minted at the tx's lockHeight (refheight = lockHeight, distance 0).
const groupBy = (items, key) => items.reduce((m, x) => ((m[key(x)] ??= []).push(x), m), {});

/** Validate a TRANSFER (no minting): every asset must conserve present value at lockHeight;
 *  FRC may leave a positive remainder (the miner fee); other assets must balance exactly. */
export function validateTransfer({ inputs, outputs, lockHeight, assets }) {
  const rate = id => id === FRC ? { k: 20, interest: false } : assets[id];
  const ins = groupBy(inputs, u => u.assetId), outs = groupBy(outputs, u => u.assetId);
  const ids = new Set([...Object.keys(ins), ...Object.keys(outs)]);
  let frcFee = 0n;
  for (const id of ids) {
    if (id !== FRC && !assets[id]) return { ok: false, err: `unknown asset ${id}` };
    const inPv = (ins[id] || []).reduce((a, u) => a + assetPresentValue(u.value, lockHeight - u.refheight, rate(id)), 0n);
    const outPv = (outs[id] || []).reduce((a, u) => a + u.value, 0n);   // fresh outputs: pv == nominal
    if (outPv > inPv) return { ok: false, err: `asset ${id} inflated: out ${outPv} > in ${inPv}` };
    if (id === FRC) frcFee = inPv - outPv;
    else if (inPv !== outPv) return { ok: false, err: `asset ${id} not conserved: in ${inPv} != out ${outPv}` };
  }
  return { ok: true, fee: frcFee };
}

/** Validate an ASSET DEFINITION (mint) tx: it creates a new asset from nothing (its outputs
 *  are the only source), the FRC inputs cover the fee, and the tag matches the definition. */
export function validateIssuance({ def, mintOutputs, frcInputs, frcFeeOutputs, lockHeight }) {
  const id = assetIdOf(def);
  if (mintOutputs.some(o => o.assetId !== id)) return { ok: false, err: 'mint output not tagged with the defined asset' };
  if (mintOutputs.reduce((a, o) => a + o.value, 0n) <= 0n) return { ok: false, err: 'issuance must mint a positive amount' };
  const frcIn = frcInputs.reduce((a, u) => a + assetPresentValue(u.value, lockHeight - u.refheight, { k: 20, interest: false }), 0n);
  const frcOut = frcFeeOutputs.reduce((a, o) => a + o.value, 0n);
  if (frcOut > frcIn) return { ok: false, err: 'FRC fee inputs insufficient' };
  return { ok: true, assetId: id, fee: frcIn - frcOut };
}
