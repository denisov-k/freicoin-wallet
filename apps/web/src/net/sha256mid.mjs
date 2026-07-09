// sha256mid.mjs — SHA-256 with midstate support, matching Freicoin's CSHA256:
// load a saved state (m_midstate_hash + buffer + length), continue writing, and
// either Finalize (padded digest) or Midstate (raw state, no padding). Needed to
// reconstruct the merged-mining commitment in aux-pow verification.
import { Buffer } from 'buffer';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rBE32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const wBE32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };

const w = new Uint32Array(64);
function transform(s, data, off, blocks) {
  for (let blk = 0; blk < blocks; blk++, off += 64) {
    for (let i = 0; i < 16; i++) w[i] = rBE32(data, off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    s[0] = (s[0] + a) >>> 0; s[1] = (s[1] + b) >>> 0; s[2] = (s[2] + c) >>> 0; s[3] = (s[3] + d) >>> 0;
    s[4] = (s[4] + e) >>> 0; s[5] = (s[5] + f) >>> 0; s[6] = (s[6] + g) >>> 0; s[7] = (s[7] + h) >>> 0;
  }
}

export class SHA256 {
  constructor() { this.s = Uint32Array.from(IV); this.buf = new Uint8Array(64); this.bytes = 0; }
  /** Resume from a saved 32-byte state, a partial buffer, and a byte count. */
  loadMidstate(hash32, buffer, lengthBytes) {
    for (let i = 0; i < 8; i++) this.s[i] = rBE32(hash32, i * 4);
    this.bytes = lengthBytes;
    const r = lengthBytes % 64;
    if (r && buffer) this.buf.set(Buffer.from(buffer).subarray(0, r));
    return this;
  }
  write(data) {
    data = Buffer.from(data);
    let p = 0, len = data.length, bufsize = this.bytes % 64;
    if (bufsize && bufsize + len >= 64) {
      this.buf.set(data.subarray(0, 64 - bufsize), bufsize);
      this.bytes += 64 - bufsize; p += 64 - bufsize;
      transform(this.s, this.buf, 0, 1); bufsize = 0;
    }
    if (len - p >= 64) {
      const blocks = (len - p) >> 6;
      transform(this.s, data, p, blocks);
      p += 64 * blocks; this.bytes += 64 * blocks;
    }
    if (len > p) { this.buf.set(data.subarray(p), bufsize); this.bytes += len - p; }
    return this;
  }
  /** Raw state (8 words, big-endian) — no padding. Assumes a block boundary. */
  midstate() { const out = new Uint8Array(32); for (let i = 0; i < 8; i++) wBE32(out, i * 4, this.s[i]); return Buffer.from(out); }
  /** Padded SHA-256 digest. */
  finalize() {
    const sizedesc = new Uint8Array(8);
    const bits = BigInt(this.bytes) * 8n;
    for (let i = 0; i < 8; i++) sizedesc[7 - i] = Number((bits >> (8n * BigInt(i))) & 0xffn);
    const pad = new Uint8Array(1 + ((119 - (this.bytes % 64)) % 64)); pad[0] = 0x80;
    this.write(pad); this.write(sizedesc);
    return this.midstate();
  }
}

/** Convenience: standard SHA-256 of `data`. */
export const sha256 = data => new SHA256().write(data).finalize();
