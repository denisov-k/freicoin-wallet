// asset-spk.mjs — the nVersion=3 EXTENSION-OUTPUT encoding: an asset's 20-byte tag rides INSIDE
// the output's scriptPubKey (the Freicoin witness "extension output" suffix), instead of a
// parallel version-3 serialization block. An asset-bearing tx is thus a STANDARD tx that pre-nv3
// nodes parse and relay unchanged — asset rules become a soft-fork overlay, not a hard fork.
//
// The suffix follows the Forward Blocks paper §XI form: after the base witness program (and the
// optional shard prefix) come one or more data pushes, then a MANDATORY trailing "extended output
// version" opcode (OP_0..OP_16). The version-last shape makes the field self-describing so future
// extension types (confidential outputs, …) can share it unambiguously.
//
//   host  output:  0014{hash20}                                    (no suffix)
//   asset (v1):    0014{hash20} 14{tag}                OP_1        (fungible asset)
//   asset (v2):    0014{hash20} 14{tag} 20{H(tokenset)} OP_2       (asset + smart-property tokens;
//                                                                   tokens revealed witness-side,
//                                                                   checked against the 32-byte hash)
// The 20-byte tag is always public in the output. Version numbers are provisional (our fork):
// v1 = fungible asset, v2 = asset+token-commitment; higher versions reserved for future types.

import { sha256d } from './crypto.mjs';

const HOST_TAG = '00'.repeat(20);
const hexToBytes = h => (h.match(/../g) ?? []).map(x => parseInt(x, 16));
const bytesToHex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');

// serialize a token set the same way the sighash/serializer does: compactSize(n) then each
// varbytes(token) — so the commitment matches whatever the witness later reveals.
function serTokens(tokens) {
  const a = [];
  const n = tokens.length;
  if (n < 0xfd) a.push(n); else if (n <= 0xffff) a.push(0xfd, n & 0xff, (n >> 8) & 0xff); else { a.push(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); }
  for (const t of tokens) { const b = hexToBytes(t); if (b.length < 0xfd) a.push(b.length); else { a.push(0xfd, b.length & 0xff, (b.length >> 8) & 0xff); } a.push(...b); }
  return a;
}

/** The 32-byte commitment to a token set (double-SHA256 of its canonical serialization). */
export const tokenSetHash = tokens => bytesToHex(sha256d(Uint8Array.from(serTokens(tokens))));

// provisional extended-output versions (our fork): OP_1 = fungible asset, OP_2 = asset+tokens,
// OP_3 = Freiland Harberger covenant (see docs/freiland-covenant-spec.md §3, variant A). A HRBG
// output is HOST currency (assetTag null) — the version opcode, not a tag, is the discriminator;
// the suffix carries nameHash(32) ‖ ownerHash160(20) ‖ floorV(8 LE), NOT an asset tag.
export const ASSET_V_FUNGIBLE = 1, ASSET_V_TOKENS = 2, HARBERGER_V = 3;
const opN = v => v === 0 ? '00' : (0x50 + v).toString(16);   // small-int opcode for a version 0..16
const dataPush = hex => (hex.length / 2).toString(16).padStart(2, '0') + hex;   // <len><bytes>, len ≤ 75
// 8-byte little-endian kria amount ⇄ BigInt
const le8 = v => { let b = BigInt(v), s = ''; for (let i = 0; i < 8; i++) { s += Number(b & 0xffn).toString(16).padStart(2, '0'); b >>= 8n; } return s; };
const unLe8 = bytes => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); return v; };

/** Append the Harberger covenant SUFFIX (variant A) to a base HOST witness program.
 *  base is a plain host program (e.g. 0014{hash20}); the coin stays host FRC (its value = the
 *  melting deposit, its asset_pv = the current forced-sale price V). Commits the registry key
 *  (nameHash), the forced-sale payout target (ownerHash160 → 0014{owner}), and the Gesell dust
 *  floor (floorV, kria). Mirror the C++ extension-suffix walk; version OP_3 marks it as HRBG. */
export function encodeHarbergerSpk(baseSpkHex, nameHashHex, ownerHash160Hex, floorV) {
  if (!/^[0-9a-f]{64}$/.test(nameHashHex)) throw new Error('nameHash must be 32 bytes');
  if (!/^[0-9a-f]{40}$/.test(ownerHash160Hex)) throw new Error('ownerHash160 must be 20 bytes');
  const f = BigInt(floorV);
  if (f < 0n || f > 0xffffffffffffffffn) throw new Error('floorV out of range');
  return baseSpkHex + dataPush(nameHashHex) + dataPush(ownerHash160Hex) + dataPush(le8(f)) + opN(HARBERGER_V);
}

/** Append the asset extension SUFFIX (§XI: data pushes + trailing version opcode) to a base
 *  witness program. tag null/host ⇒ returns baseSpk unchanged (host outputs carry no suffix). */
export function encodeAssetSpk(baseSpkHex, assetTagHex, tokens = [], commitHex = null) {
  if (!assetTagHex || assetTagHex === HOST_TAG) {
    if (tokens.length || commitHex) throw new Error('tokens require a non-host asset tag');
    return baseSpkHex;
  }
  if (!/^[0-9a-f]{40}$/.test(assetTagHex)) throw new Error('asset tag must be 20 bytes');
  // A parsed coin knows its 32-byte token COMMITMENT but not the token list (that lives in the
  // FRT1 reveal). Re-serializing such an output MUST reproduce the v2 suffix from the stored
  // commitment — recomputing from an empty token list would emit v1 (tag only) and change the
  // scriptPubKey, hence the txid (found: token coins landed under a ghost outpoint, unspendable).
  const commit = commitHex || (tokens.length ? tokenSetHash(tokens) : null);
  if (commit) {
    if (!/^[0-9a-f]{64}$/.test(commit)) throw new Error('token commitment must be 32 bytes');
    return baseSpkHex + dataPush(assetTagHex) + dataPush(commit) + opN(ASSET_V_TOKENS);
  }
  return baseSpkHex + dataPush(assetTagHex) + opN(ASSET_V_FUNGIBLE);
}

/** Split a scriptPubKey into { baseSpk, assetTag, tokenHash, version }. A program with no suffix is
 *  the host currency (assetTag null). Mirrors the C++ IsWitnessProgram walk. Returns null for
 *  non-witness scripts (OP_RETURN etc.) — those are always host by construction. */
export function decodeAssetSpk(spkHex) {
  const b = hexToBytes(spkHex);
  if (b.length < 4 || b.length > 155) return null;
  const ver = b[0];
  // outer version opcodes: OP_0(0x00), OP_1NEGATE(0x4f), OP_1..OP_16(0x51..0x60)
  const isVer = ver === 0x00 || ver === 0x4f || (ver >= 0x51 && ver <= 0x60);
  if (!isVer) return null;
  const clen = b[1];
  if (clen < 2 || clen > 75) return null;
  let pos = 2 + clen;
  if (pos > b.length) return null;
  const base = bytesToHex(b.slice(0, pos));
  if (pos === b.length) return { baseSpk: base, assetTag: null, tokenHash: null };   // host
  // A valid asset suffix starts with a data push (the 20-byte tag). Anything else in this
  // position — a shard prefix (0x01<byte>, OP_1NEGATE, OP_1..OP_16) or garbage — is REJECTED,
  // not skipped: skipping would decompose the script into parts that omit the prefix, and a
  // re-serialization then emits a DIFFERENT script — wrong txid, ghost outpoints (audit
  // 2026-07-16, same class as the tokenHash ghost bug). No shard outputs exist; returning null
  // keeps such a script as opaque raw bytes end to end.
  if (!(b[pos] >= 0x02 && b[pos] <= 0x4b)) return null;
  // suffix: data pushes (2..75) then a trailing version opcode (OP_0..OP_16)
  const data = [];
  let version = null;
  while (pos < b.length) {
    const op = b[pos];
    if (op >= 0x02 && op <= 0x4b) {
      if (pos + 1 + op > b.length) return null;
      data.push(...b.slice(pos + 1, pos + 1 + op));
      pos += 1 + op;
    } else if (op === 0x00 || (op >= 0x51 && op <= 0x60)) {
      version = op === 0x00 ? 0 : op - 0x50;
      pos += 1;
      break;   // version is the last element
    } else return null;
  }
  if (version === null || pos !== b.length) return null;
  // Harberger covenant (OP_3, variant A): HOST output — the suffix is nameHash(32)‖owner(20)‖floorV(8),
  // NOT an asset tag. The version opcode discriminates; assetTag stays null (value is host FRC).
  if (version === HARBERGER_V) {
    if (data.length !== 60) return null;
    return { baseSpk: base, assetTag: null, tokenHash: null, version,
      harberger: { nameHash: bytesToHex(data.slice(0, 32)), owner: bytesToHex(data.slice(32, 52)), floorV: unLe8(data.slice(52, 60)) } };
  }
  if (data.length !== 20 && data.length !== 52) return null;   // tag | tag++tokenHash
  return { baseSpk: base, assetTag: bytesToHex(data.slice(0, 20)), tokenHash: data.length === 52 ? bytesToHex(data.slice(20)) : null, version };
}
