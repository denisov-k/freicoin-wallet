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
// Computed in Q64 fixed point by square-and-multiply, deterministic and integer-truncating.
// NOTE: at k=20/demurrage this closely tracks the canonical FRC kernel but is not bit-identical
// (the kernel uses a specific term-by-term truncation); the C++ port MUST reuse the canonical
// kernel generalised to k. The model is exact-as-defined and self-consistent.
const S = 1n << 64n;
function powFactor(factorQ64, distance) {
  let result = S, base = factorQ64, e = BigInt(distance);
  while (e > 0n) { if (e & 1n) result = (result * base) / S; base = (base * base) / S; e >>= 1n; }
  return result;
}
export function assetPresentValue(nominal, distance, { k, interest }) {
  if (distance === 0) return nominal;
  if (k === 20 && !interest) return timeAdjustValue(nominal, distance);   // FRC: use the canonical kernel exactly
  const factor = interest ? S + (S >> BigInt(k)) : S - (S >> BigInt(k));
  return (nominal * powFactor(factor, distance)) / S;
}

// ---- asset identity ------------------------------------------------------------------
// An asset's 20-byte tag = RIPEMD160(SHA256(canonical asset-definition bytes)), mirroring the
// whitepaper (FRC's tag is the same hash of the genesis block). Deterministic → the same
// definition always yields the same id, and a different rate/granularity is a different asset.
export const FRC = 'frc';   // sentinel tag for the host currency in this model
export function serializeAssetDef(def) {
  // fields fixed & ordered so the id is canonical: shift(1) | flags(1) | granularity(8) | contractHash(32)
  const flags = (def.interest ? 1 : 0);
  const gran = []; let g = BigInt(def.granularity ?? 1); for (let i = 0; i < 8; i++) { gran.push(Number(g & 0xffn)); g >>= 8n; }
  return bytesToHex(Uint8Array.from([def.k & 0xff, flags, ...gran, ...hexToBytes((def.contractHash ?? '').padEnd(64, '0'))]));
}
export function assetIdOf(def) {
  return bytesToHex(ripemd160(sha256(hexToBytes(serializeAssetDef(def)))));
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
