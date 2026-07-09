// tx.mjs — Freicoin transaction parse/serialize. Two Freicoin-isms vs Bitcoin:
//   (1) a trailing uint32 `lock_height` after nLockTime;
//   (2) the segwit marker byte is 0xff (Bitcoin uses 0x00).
// Reference format: primitives/transaction.h {Un,}SerializeTransaction.

class Reader {
  constructor(hex) { this.b = Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16))); this.p = 0; }
  u8() { return this.b[this.p++]; }
  u32() { let v = 0; for (let i = 0; i < 4; i++) v += this.b[this.p++] * 2 ** (8 * i); return v >>> 0; }
  u64() { let v = 0n; for (let i = 0n; i < 8n; i++) v += BigInt(this.b[this.p++]) << (8n * i); return v; }
  bytes(n) { const s = this.b.slice(this.p, this.p + n); this.p += n; return s; }
  hex(n) { return [...this.bytes(n)].map(x => x.toString(16).padStart(2, "0")).join(""); }
  varint() {
    const n = this.u8();
    if (n < 0xfd) return n;
    if (n === 0xfd) return this.u8() | (this.u8() << 8);
    if (n === 0xfe) return this.u32();
    let v = this.u64(); return Number(v);
  }
  varbytes() { return this.hex(this.varint()); }
}

const MARKER = 0xff; // Freicoin segwit marker

export function parseTx(hex) {
  const r = new Reader(hex);
  const version = r.u32();
  let hasWitness = false, flags = 0;
  const save = r.p;
  if (r.u8() === MARKER) { flags = r.u8(); hasWitness = (flags & 1) !== 0; }
  else r.p = save;
  const nvin = r.varint();
  const vin = [];
  for (let i = 0; i < nvin; i++) {
    const prevout = { txid: r.hex(32), vout: r.u32() };
    const scriptSig = r.varbytes();
    const sequence = r.u32();
    vin.push({ prevout, scriptSig, sequence, witness: [] });
  }
  const nvout = r.varint();
  const vout = [];
  for (let i = 0; i < nvout; i++) vout.push({ value: r.u64(), scriptPubKey: r.varbytes() });
  if (hasWitness) for (let i = 0; i < nvin; i++) {
    const items = r.varint(); const w = [];
    for (let j = 0; j < items; j++) w.push(r.varbytes());
    vin[i].witness = w;
  }
  const nLockTime = r.u32();
  const lockHeight = r.u32();          // <-- Freicoin
  return { version, hasWitness, flags, vin, vout, nLockTime, lockHeight, nvin, nvout };
}

// --- serializer (for round-trip parity) ---
function pushU32(a, v) { for (let i = 0; i < 4; i++) a.push((v >>> (8 * i)) & 0xff); }
function pushU64(a, v) { for (let i = 0n; i < 8n; i++) a.push(Number((v >> (8n * i)) & 0xffn)); }
function pushVarint(a, n) {
  if (n < 0xfd) a.push(n);
  else if (n <= 0xffff) { a.push(0xfd, n & 0xff, (n >> 8) & 0xff); }
  else { a.push(0xfe); pushU32(a, n); }
}
function pushVarbytes(a, hex) { const b = hex.match(/../g)?.map(h => parseInt(h, 16)) ?? []; pushVarint(a, b.length); a.push(...b); }

export function serializeTx(tx) {
  const a = [];
  pushU32(a, tx.version);
  if (tx.hasWitness) a.push(MARKER, tx.flags);
  pushVarint(a, tx.vin.length);
  for (const i of tx.vin) {
    a.push(...i.prevout.txid.match(/../g).map(h => parseInt(h, 16)));
    pushU32(a, i.prevout.vout);
    pushVarbytes(a, i.scriptSig);
    pushU32(a, i.sequence);
  }
  pushVarint(a, tx.vout.length);
  for (const o of tx.vout) { pushU64(a, o.value); pushVarbytes(a, o.scriptPubKey); }
  if (tx.hasWitness) for (const i of tx.vin) {
    pushVarint(a, i.witness.length);
    for (const w of i.witness) pushVarbytes(a, w);
  }
  pushU32(a, tx.nLockTime);
  pushU32(a, tx.lockHeight);
  return a.map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- txid: double-SHA256 of the no-witness serialization, displayed byte-reversed.
// Freicoin's txid commits to lock_height (it is part of the basic serialization).
import { sha256d } from './crypto.mjs';
export function txid(tx) {
  const noWit = serializeTx({ ...tx, hasWitness: false });
  const bytes = Buffer.from(noWit, 'hex');
  const h = sha256d(bytes);
  return Buffer.from(h).reverse().toString('hex');
}
