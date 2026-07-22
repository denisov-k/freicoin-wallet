// bip158.mjs — BIP158 compact block filter matching (Golomb-Coded Set + SipHash).
// Freicoin uses the standard basic filter: P=19, M=784931, elements = every output
// scriptPubKey + every spent prevout scriptPubKey in the block, keyed by SipHash
// over the block hash. A wallet script that appears in a block's filter means the
// block *may* touch that script (then the full block is fetched and checked).
//
// Hot path: a full mainnet scan runs this ~485k times × ~40 wallet scripts. The
// SipHash core uses 32-bit integer lanes (a u64 as hi/lo uint32 pair) and the GCS
// decoder plain Numbers — an earlier BigInt implementation was ~20× slower in
// browsers. BigInt survives only in the one map-to-range multiply per target
// (hash × N·M needs >64-bit intermediate); its result < N·M fits a Number.
import { Buffer } from 'buffer';
// локальный varint (не тянем p2p.mjs: этот модуль импортирует и релей, у которого нет alias-лоадера)
function readVarint(buf, o) {
  const n = buf[o];
  if (n < 0xfd) return [n, o + 1];
  if (n === 0xfd) return [buf.readUInt16LE(o + 1), o + 3];
  if (n === 0xfe) return [buf.readUInt32LE(o + 1), o + 5];
  return [Number(buf.readBigUInt64LE(o + 1)), o + 9];
}

// SipHash-2-4 over 32-bit lanes. v = [v0h,v0l, v1h,v1l, v2h,v2l, v3h,v3l].
function sipround(v) {
  // v0 += v1
  let l = v[1] + v[3]; v[0] = (v[0] + v[2] + (l > 0xffffffff ? 1 : 0)) >>> 0; v[1] = l >>> 0;
  // v1 = rotl(v1, 13)
  let h = v[2], lo = v[3];
  v[2] = ((h << 13) | (lo >>> 19)) >>> 0; v[3] = ((lo << 13) | (h >>> 19)) >>> 0;
  // v1 ^= v0
  v[2] = (v[2] ^ v[0]) >>> 0; v[3] = (v[3] ^ v[1]) >>> 0;
  // v0 = rotl(v0, 32)
  h = v[0]; v[0] = v[1]; v[1] = h;
  // v2 += v3
  l = v[5] + v[7]; v[4] = (v[4] + v[6] + (l > 0xffffffff ? 1 : 0)) >>> 0; v[5] = l >>> 0;
  // v3 = rotl(v3, 16)
  h = v[6]; lo = v[7];
  v[6] = ((h << 16) | (lo >>> 16)) >>> 0; v[7] = ((lo << 16) | (h >>> 16)) >>> 0;
  // v3 ^= v2
  v[6] = (v[6] ^ v[4]) >>> 0; v[7] = (v[7] ^ v[5]) >>> 0;
  // v0 += v3
  l = v[1] + v[7]; v[0] = (v[0] + v[6] + (l > 0xffffffff ? 1 : 0)) >>> 0; v[1] = l >>> 0;
  // v3 = rotl(v3, 21)
  h = v[6]; lo = v[7];
  v[6] = ((h << 21) | (lo >>> 11)) >>> 0; v[7] = ((lo << 21) | (h >>> 11)) >>> 0;
  // v3 ^= v0
  v[6] = (v[6] ^ v[0]) >>> 0; v[7] = (v[7] ^ v[1]) >>> 0;
  // v2 += v1
  l = v[5] + v[3]; v[4] = (v[4] + v[2] + (l > 0xffffffff ? 1 : 0)) >>> 0; v[5] = l >>> 0;
  // v1 = rotl(v1, 17)
  h = v[2]; lo = v[3];
  v[2] = ((h << 17) | (lo >>> 15)) >>> 0; v[3] = ((lo << 17) | (h >>> 15)) >>> 0;
  // v1 ^= v2
  v[2] = (v[2] ^ v[4]) >>> 0; v[3] = (v[3] ^ v[5]) >>> 0;
  // v2 = rotl(v2, 32)
  h = v[4]; v[4] = v[5]; v[5] = h;
}

const rd32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

/** SipHash-2-4(k, data) -> {hi, lo} (uint32 halves of the 64-bit hash). Key = k0h..k1l. */
function siphash(k0h, k0l, k1h, k1l, data) {
  const v = new Uint32Array([
    0x736f6d65 ^ k0h, 0x70736575 ^ k0l, 0x646f7261 ^ k1h, 0x6e646f6d ^ k1l,
    0x6c796765 ^ k0h, 0x6e657261 ^ k0l, 0x74656462 ^ k1h, 0x79746573 ^ k1l,
  ]);
  const len = data.length; let i = 0;
  for (; i + 8 <= len; i += 8) {
    const ml = rd32(data, i), mh = rd32(data, i + 4);
    v[6] = (v[6] ^ mh) >>> 0; v[7] = (v[7] ^ ml) >>> 0;
    sipround(v); sipround(v);
    v[0] = (v[0] ^ mh) >>> 0; v[1] = (v[1] ^ ml) >>> 0;
  }
  let bl = 0, bh = (len & 0xff) << 24;
  for (let j = 0; i + j < len; j++) { const byte = data[i + j]; if (j < 4) bl |= byte << (8 * j); else bh |= byte << (8 * (j - 4)); }
  bl >>>= 0; bh >>>= 0;
  v[6] = (v[6] ^ bh) >>> 0; v[7] = (v[7] ^ bl) >>> 0;
  sipround(v); sipround(v);
  v[0] = (v[0] ^ bh) >>> 0; v[1] = (v[1] ^ bl) >>> 0;
  v[5] = (v[5] ^ 0xff) >>> 0;   // v2 ^= 0xff (low half)
  sipround(v); sipround(v); sipround(v); sipround(v);
  return { hi: (v[0] ^ v[2] ^ v[4] ^ v[6]) >>> 0, lo: (v[1] ^ v[3] ^ v[5] ^ v[7]) >>> 0 };
}

// map-to-range: (hash * F) >> 64. F = N·M can reach ~2^33 and the product ~2^97, so
// this one step stays BigInt; the result (< F) is returned as a Number.
const mapToRange = (h, F) => Number((((BigInt(h.hi) << 32n) | BigInt(h.lo)) * F) >> 64n);

/** Golomb-Rice bit reader over plain Numbers (values < N·M < 2^53). */
class BitReader {
  constructor(b) { this.b = b; this.pos = 0; this.acc = 0; this.cnt = 0; }
  bit() {
    if (this.cnt === 0) { this.acc = this.b[this.pos++] | 0; this.cnt = 8; }
    this.cnt--;
    return (this.acc >> this.cnt) & 1;
  }
  bits(n) {
    let v = 0;
    while (n > 0) {
      if (this.cnt === 0) { this.acc = this.b[this.pos++] | 0; this.cnt = 8; }
      const take = Math.min(n, this.cnt);
      v = v * (1 << take) + ((this.acc >> (this.cnt - take)) & ((1 << take) - 1));
      this.cnt -= take; n -= take;
    }
    return v;
  }
}
function golomb(br, P) { let q = 0; while (br.bit() === 1) q++; return q * 2 ** P + br.bits(P); }

// ---- построение фильтра (обратная сторона матчера). Нужно реле: pruned-узел не может достроить
// исторический blockfilterindex, поэтому реле считает basic-фильтры для НОВЫХ блоков само и кормит
// ими браузерный LN-узел. Байт-в-байт с Core (golden-тест против getblockfilter в сьюте).
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.cnt = 0; }
  bit(b) { this.acc = (this.acc << 1) | b; if (++this.cnt === 8) { this.bytes.push(this.acc); this.acc = 0; this.cnt = 0; } }
  bits(v, n) { for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1); }   // v < 2^P ≤ 2^19 — обычный Number
  done() { if (this.cnt) this.bytes.push((this.acc << (8 - this.cnt)) & 0xff); return Buffer.from(this.bytes); }
}
const writeVarint = n => {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.from([0xfd, n & 0xff, n >> 8]);
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
};

/**
 * BIP158 basic-фильтр блока: элементы = уникальные scriptPubKey всех выходов (кроме пустых и
 * OP_RETURN) + prevout-скрипты всех входов (кроме пустых; у coinbase prevout нет).
 * @param {string} blockHashHex — хеш блока (display order), ключ SipHash
 * @param {string[]} scriptsHex — сырые скрипты элементов (hex), ДО дедупликации
 * @returns {Buffer} varint(N) + GCS-битстрим — ровно то, что отдаёт getblockfilter
 */
export function buildFilter(blockHashHex, scriptsHex, P = 19, M = 784931n) {
  const key = Buffer.from(blockHashHex, 'hex').reverse();
  const k0h = rd32(key, 4), k0l = rd32(key, 0), k1h = rd32(key, 12), k1l = rd32(key, 8);
  const uniq = [...new Set(scriptsHex.filter(s => s && s.length > 0))];
  if (!uniq.length) return writeVarint(0);
  const F = BigInt(uniq.length) * M;
  // ВАЖНО: хэш-коллизии НЕ дедуплицируются (Core кодирует дельту 0) — N = числу уникальных
  // СКРИПТОВ, не уникальных хэшей, иначе байты разойдутся с getblockfilter при коллизии.
  const vals = uniq.map(s => mapToRange(siphash(k0h, k0l, k1h, k1l, Buffer.from(s, 'hex')), F)).sort((a, b) => a - b);
  const bw = new BitWriter();
  let prev = 0;
  for (const v of vals) {
    const delta = v - prev; prev = v;
    let q = Math.floor(delta / 2 ** P);
    while (q--) bw.bit(1);
    bw.bit(0);
    bw.bits(delta % 2 ** P, P);
  }
  return Buffer.concat([writeVarint(vals.length), bw.done()]);
}

/**
 * Does the filter (Buffer) for block `blockHashHex` (display order) match any of
 * `scriptsHex` (hex scriptPubKeys)? P/M are the basic-filter params.
 */
export function filterMatchesAny(filter, blockHashHex, scriptsHex, P = 19, M = 784931n) {
  filter = Buffer.from(filter);
  const key = Buffer.from(blockHashHex, 'hex').reverse();      // internal byte order
  const k0h = rd32(key, 4), k0l = rd32(key, 0), k1h = rd32(key, 12), k1l = rd32(key, 8);
  const [N, o] = readVarint(filter, 0);
  if (N === 0) return false;
  const F = BigInt(N) * M;
  const targets = scriptsHex.map(s => mapToRange(siphash(k0h, k0l, k1h, k1l, Buffer.from(s, 'hex')), F)).sort((a, b) => a - b);
  const br = new BitReader(filter.subarray(o));
  let val = 0, ti = 0;
  for (let i = 0; i < N && ti < targets.length; i++) {
    val += golomb(br, P);
    while (ti < targets.length && targets[ti] < val) ti++;
    if (ti < targets.length && targets[ti] === val) return true;
  }
  return false;
}
