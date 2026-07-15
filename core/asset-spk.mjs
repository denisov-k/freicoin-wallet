// asset-spk.mjs — the nVersion=3 EXTENSION-OUTPUT encoding: an asset's 20-byte tag rides INSIDE
// the output's scriptPubKey (the reserved Freicoin witness "extension output" push), instead of a
// parallel version-3 serialization block. This makes an asset-bearing transaction a STANDARD tx
// that pre-nv3 nodes parse and relay unchanged — asset rules become a soft-fork overlay, not a
// hard-fork wire change.
//
// Freicoin witness-program grammar (src/script/script.cpp IsWitnessProgram):
//   <version opcode> <commitment push 2..75> [shard prefix] [extension push 2..75]
// We append the extension push to a normal program:
//   host  output:  0014{hash20}                       (unchanged)
//   asset output:  0014{hash20} <push ext>             (ext carries the tag, +token hash)
//   ext = tag(20)                     when the output holds no smart-property tokens
//   ext = tag(20) ++ H(tokenset)(32)  when it does; the tokens are revealed witness-side and
//                                     checked against this 32-byte commitment (like approvals).
// Length (20 vs 52) distinguishes the two; the tag's 20 bytes are always public in the output.

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

/** Append the asset extension push to a base witness program. tag null/host ⇒ returns baseSpk
 *  unchanged (host-currency outputs carry no extension). */
export function encodeAssetSpk(baseSpkHex, assetTagHex, tokens = []) {
  if (!assetTagHex || assetTagHex === HOST_TAG) {
    if (tokens.length) throw new Error('tokens require a non-host asset tag');
    return baseSpkHex;
  }
  if (!/^[0-9a-f]{40}$/.test(assetTagHex)) throw new Error('asset tag must be 20 bytes');
  const ext = hexToBytes(assetTagHex).concat(tokens.length ? hexToBytes(tokenSetHash(tokens)) : []);
  if (ext.length < 2 || ext.length > 75) throw new Error('extension push out of range');
  return baseSpkHex + ext.length.toString(16).padStart(2, '0') + bytesToHex(ext);
}

/** Split a scriptPubKey into { baseSpk, assetTag, tokenHash }. A program with no extension push is
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
  const elen = b[pos];
  if (elen < 2 || elen > 75 || pos + 1 + elen !== b.length) return null;
  const ext = b.slice(pos + 1);
  if (ext.length !== 20 && ext.length !== 52) return null;   // tag | tag++tokenHash
  return { baseSpk: base, assetTag: bytesToHex(ext.slice(0, 20)), tokenHash: ext.length === 52 ? bytesToHex(ext.slice(20)) : null };
}
