// bip158.mjs — BIP158 compact block filter matching (Golomb-Coded Set + SipHash).
// Freicoin uses the standard basic filter: P=19, M=784931, elements = every output
// scriptPubKey + every spent prevout scriptPubKey in the block, keyed by SipHash
// over the block hash. A wallet script that appears in a block's filter means the
// block *may* touch that script (then the full block is fetched and checked).
import { Buffer } from 'buffer';
import { readVarint } from './p2p.mjs';

const MASK = (1n << 64n) - 1n;
const rotl = (x, b) => ((x << b) | (x >> (64n - b))) & MASK;
const u64le = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };

function sip(v) {
  v[0] = (v[0] + v[1]) & MASK; v[1] = rotl(v[1], 13n); v[1] ^= v[0]; v[0] = rotl(v[0], 32n);
  v[2] = (v[2] + v[3]) & MASK; v[3] = rotl(v[3], 16n); v[3] ^= v[2];
  v[0] = (v[0] + v[3]) & MASK; v[3] = rotl(v[3], 21n); v[3] ^= v[0];
  v[2] = (v[2] + v[1]) & MASK; v[1] = rotl(v[1], 17n); v[1] ^= v[2]; v[2] = rotl(v[2], 32n);
}
function siphash(k0, k1, data) {
  const v = [0x736f6d6570736575n ^ k0, 0x646f72616e646f6dn ^ k1, 0x6c7967656e657261n ^ k0, 0x7465646279746573n ^ k1];
  const len = data.length; let i = 0;
  for (; i + 8 <= len; i += 8) { const m = u64le(data, i); v[3] ^= m; sip(v); sip(v); v[0] ^= m; }
  let b = BigInt(len & 0xff) << 56n;
  for (let j = 0; i + j < len; j++) b |= BigInt(data[i + j]) << (8n * BigInt(j));
  v[3] ^= b; sip(v); sip(v); v[0] ^= b;
  v[2] ^= 0xffn; sip(v); sip(v); sip(v); sip(v);
  return (v[0] ^ v[1] ^ v[2] ^ v[3]) & MASK;
}
const hashToRange = (item, F, k0, k1) => (siphash(k0, k1, item) * F) >> 64n;

class BitReader {
  constructor(b) { this.b = b; this.pos = 0; }
  bit() { const x = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return x; }
  bits(n) { let v = 0n; for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(this.bit()); return v; }
}
function golomb(br, P) { let q = 0n; while (br.bit() === 1) q++; return (q << BigInt(P)) + br.bits(P); }

/**
 * Does the filter (Buffer) for block `blockHashHex` (display order) match any of
 * `scriptsHex` (hex scriptPubKeys)? P/M are the basic-filter params.
 */
export function filterMatchesAny(filter, blockHashHex, scriptsHex, P = 19, M = 784931n) {
  filter = Buffer.from(filter);
  const key = Buffer.from(blockHashHex, 'hex').reverse();      // internal byte order
  const k0 = u64le(key, 0), k1 = u64le(key, 8);
  const [N, o] = readVarint(filter, 0);
  if (N === 0) return false;
  const F = BigInt(N) * M;
  const targets = scriptsHex.map(s => hashToRange(Buffer.from(s, 'hex'), F, k0, k1)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const br = new BitReader(filter.subarray(o));
  let val = 0n, ti = 0;
  for (let i = 0; i < N && ti < targets.length; i++) {
    val += golomb(br, P);
    while (ti < targets.length && targets[ti] < val) ti++;
    if (ti < targets.length && targets[ti] === val) return true;
  }
  return false;
}
