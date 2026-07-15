// chain.mjs — compact in-memory header chain. A mainnet chain is ~485k headers; storing
// them as JS objects with hex-string hashes (+ a plain-object hash→height index) costs
// ~250MB. This columnar layout costs ~40MB: hashes in one growable Uint8Array (32B each),
// times in a Uint32Array, and the index as a numeric Map keyed by the hash's first 52
// bits (collisions — ~1e-5 odds chain-wide — spill into a small array and every lookup
// verifies the full 32 bytes). prevHash is not stored at all: after verification it is
// redundant (prevHash of height h === hash at h-1).
import { Buffer } from 'buffer';

// Key on the TAIL of the display hex: the head is the PoW target's leading zeros (the
// deeper the native-difficulty era, the more zeros), which collapses a head-based key's
// entropy and turns the index into huge collision chains. The tail bytes are uniformly
// random for every era. 52 bits — exact as a Number.
const keyOf = hashHex => parseInt(hashHex.slice(-13), 16);

export class HeaderChain {
  /** `base` > 0 anchors the chain at a CHECKPOINT instead of genesis: heights below the
   *  anchor simply don't exist in this instance (fast-sync mode). */
  constructor(anchorHex, base = 0) {
    this.cap = 4096;
    this.base = base;
    this.hashes = new Uint8Array(this.cap * 32);
    this.times = new Uint32Array(this.cap);
    this.len = 0;
    this.index = new Map();          // key -> internal idx | [idxs] (prefix collisions)
    this.push(anchorHex, 0);
  }
  get length() { return this.base + this.len; }

  _grow(min) {
    let cap = this.cap; while (cap < min) cap *= 2;
    const h = new Uint8Array(cap * 32); h.set(this.hashes.subarray(0, this.len * 32)); this.hashes = h;
    const t = new Uint32Array(cap); t.set(this.times.subarray(0, this.len)); this.times = t;
    this.cap = cap;
  }

  hashAt(h) { const i = h - this.base; return Buffer.from(this.hashes.subarray(i * 32, i * 32 + 32)).toString('hex'); }
  timeAt(h) { return this.times[h - this.base]; }
  tipHash() { return this.hashAt(this.base + this.len - 1); }

  push(hashHex, time) {
    if (this.len === this.cap) this._grow(this.len + 1);
    this.hashes.set(Buffer.from(hashHex, 'hex'), this.len * 32);
    this.times[this.len] = time >>> 0;
    const k = keyOf(hashHex), cur = this.index.get(k);
    if (cur === undefined) this.index.set(k, this.len);
    else if (Array.isArray(cur)) cur.push(this.len);
    else this.index.set(k, [cur, this.len]);
    this.len++;
  }

  /** Height of a display-hex block hash, or undefined. Verifies full 32 bytes. */
  heightOf(hashHex) {
    const cur = this.index.get(keyOf(hashHex));
    if (cur === undefined) return undefined;
    for (const i of Array.isArray(cur) ? cur : [cur]) if (i < this.len && this.hashAt(this.base + i) === hashHex) return this.base + i;
    return undefined;
  }

  /** Drop everything at height >= newLen (reorg rollback). */
  truncate(newLen) {
    const newInternal = newLen - this.base;
    for (let i = this.len - 1; i >= newInternal; i--) {
      const k = keyOf(this.hashAt(this.base + i)), cur = this.index.get(k);
      if (Array.isArray(cur)) { const j = cur.indexOf(i); if (j >= 0) cur.splice(j, 1); if (cur.length === 1) this.index.set(k, cur[0]); }
      else if (cur === i) this.index.delete(k);
    }
    this.len = newInternal;
  }
}
