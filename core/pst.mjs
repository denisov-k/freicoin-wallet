// pst.mjs — parse + serialize Freicoin PST (Partially Signed Transaction).
//
// Freicoin's PST is its rename/fork of BIP174 PSBT. Two things a stock PSBT lib
// gets wrong:
//   1. Magic is `pst\xff` (4 bytes) — NOT PSBT's `psbt\xff` (5 bytes).
//   2. The embedded unsigned tx (global key 0x00) is a FREICOIN transaction
//      (trailing lock_height; segwit marker 0xff) — parsed via tx.mjs.
// Layout: magic ++ global-map ++ one input-map per vin ++ one output-map per vout.
// Each map: repeated <compactsize(keylen)|key|compactsize(vallen)|val>, then 0x00.
// Ref: test/functional/test_framework/pst.py.
import { parseTx, serializeTx } from './tx.mjs';

const MAGIC = [0x70, 0x73, 0x74, 0xff]; // "pst\xff"
const PST_GLOBAL_UNSIGNED_TX = 0x00;

const hexToBytes = h => (h.match(/../g) ?? []).map(x => parseInt(x, 16));
const bytesToHex = b => b.map(x => x.toString(16).padStart(2, '0')).join('');

class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  u8() { return this.b[this.p++]; }
  take(n) { const s = this.b.slice(this.p, this.p + n); this.p += n; return s; }
  eof() { return this.p >= this.b.length; }
  compactSize() {
    const n = this.u8();
    if (n < 0xfd) return n;
    if (n === 0xfd) return this.u8() | (this.u8() << 8);
    if (n === 0xfe) { let v = 0; for (let i = 0; i < 4; i++) v |= this.u8() << (8 * i); return v >>> 0; }
    let v = 0n; for (let i = 0n; i < 8n; i++) v |= BigInt(this.u8()) << (8n * i); return Number(v);
  }
}

function pushCompactSize(a, n) {
  if (n < 0xfd) a.push(n);
  else if (n <= 0xffff) a.push(0xfd, n & 0xff, (n >> 8) & 0xff);
  else { a.push(0xfe); for (let i = 0; i < 4; i++) a.push((n >>> (8 * i)) & 0xff); }
}

// A map is a list of {key: hex, value: hex} pairs (key includes its type byte).
function readMap(r) {
  const entries = [];
  for (;;) {
    const klen = r.compactSize();
    if (klen === 0) break;               // 0x00 separator terminates the map
    const key = r.take(klen);
    const vlen = r.compactSize();
    const val = r.take(vlen);
    entries.push({ key: bytesToHex(key), value: bytesToHex(val) });
  }
  return { entries };
}

function writeMap(a, map) {
  for (const { key, value } of map.entries) {
    const kb = hexToBytes(key), vb = hexToBytes(value);
    pushCompactSize(a, kb.length); a.push(...kb);
    pushCompactSize(a, vb.length); a.push(...vb);
  }
  a.push(0x00);
}

const keyType = e => hexToBytes(e.key)[0];

/** Parse a PST from hex. Returns {global, inputs, outputs, tx}. */
export function parsePst(hex) {
  const r = new Reader(hexToBytes(hex));
  for (let i = 0; i < 4; i++) {
    if (r.u8() !== MAGIC[i]) throw new Error('bad PST magic (expected pst\\xff)');
  }
  const global = readMap(r);
  const txEntry = global.entries.find(e => keyType(e) === PST_GLOBAL_UNSIGNED_TX);
  if (!txEntry) throw new Error('PST missing global unsigned tx (key 0x00)');
  const tx = parseTx(txEntry.value);      // Freicoin tx: lock_height + 0xff marker aware
  const inputs = tx.vin.map(() => readMap(r));
  const outputs = tx.vout.map(() => readMap(r));
  if (!r.eof()) throw new Error('trailing bytes after PST');
  return { global, inputs, outputs, tx };
}

/** Serialize a parsed PST ({global, inputs, outputs}) back to hex, byte-exact. */
export function serializePst(pst) {
  const a = [...MAGIC];
  writeMap(a, pst.global);
  for (const m of pst.inputs) writeMap(a, m);
  for (const m of pst.outputs) writeMap(a, m);
  return bytesToHex(a);
}

/** Base64 wrappers (PST is exchanged as base64, like PSBT). */
export function pstToBase64(hex) { return Buffer.from(hexToBytes(hex)).toString('base64'); }
export function pstFromBase64(b64) { return bytesToHex([...Buffer.from(b64, 'base64')]); }
