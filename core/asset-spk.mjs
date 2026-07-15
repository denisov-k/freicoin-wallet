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

// provisional extended-output versions (our fork): OP_1 = fungible asset, OP_2 = asset+tokens.
export const ASSET_V_FUNGIBLE = 1, ASSET_V_TOKENS = 2;
const opN = v => v === 0 ? '00' : (0x50 + v).toString(16);   // small-int opcode for a version 0..16
const dataPush = hex => (hex.length / 2).toString(16).padStart(2, '0') + hex;   // <len><bytes>, len ≤ 75

/** Append the asset extension SUFFIX (§XI: data pushes + trailing version opcode) to a base
 *  witness program. tag null/host ⇒ returns baseSpk unchanged (host outputs carry no suffix). */
export function encodeAssetSpk(baseSpkHex, assetTagHex, tokens = []) {
  if (!assetTagHex || assetTagHex === HOST_TAG) {
    if (tokens.length) throw new Error('tokens require a non-host asset tag');
    return baseSpkHex;
  }
  if (!/^[0-9a-f]{40}$/.test(assetTagHex)) throw new Error('asset tag must be 20 bytes');
  if (tokens.length) {
    return baseSpkHex + dataPush(assetTagHex) + dataPush(tokenSetHash(tokens)) + opN(ASSET_V_TOKENS);
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
  // optional shard prefix — skip (unused today); 0x01<byte> or OP_1NEGATE/OP_1..OP_16
  const sp = b[pos];
  if (sp === 0x01) pos += 2; else if (sp === 0x4f || (sp >= 0x51 && sp <= 0x60)) pos += 1;
  if (pos >= b.length) return { baseSpk: base, assetTag: null, tokenHash: null };
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
  if (data.length !== 20 && data.length !== 52) return null;   // tag | tag++tokenHash
  return { baseSpk: base, assetTag: bytesToHex(data.slice(0, 20)), tokenHash: data.length === 52 ? bytesToHex(data.slice(20)) : null, version };
}
