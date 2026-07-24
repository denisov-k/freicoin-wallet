// tx.mjs — Freicoin transaction parse/serialize. Two Freicoin-isms vs Bitcoin:
//   (1) a trailing uint32 `lock_height` after nLockTime;
//   (2) the segwit marker byte is 0xff (Bitcoin uses 0x00).
// Reference format: primitives/transaction.h {Un,}SerializeTransaction.
//
// nVersion=3 EXTENSION-OUTPUT: an output's asset tag rides INSIDE its scriptPubKey (asset-spk.mjs),
// not a parallel wire block. Callers still work with the convenient {value, scriptPubKey(base),
// assetTag} shape; serialize FOLDS the tag into the spk, parse DECODES it back — so an asset
// transfer is a plain standard tx. Only smart-property TOKENS still ride a v3 parallel block.
import { encodeAssetSpk, decodeAssetSpk } from './asset-spk.mjs';

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

// nV3-lite transaction version. The whitepaper said nVersion=3, but upstream took tx v3 for
// TRUC (BIP431); the top bit is the Freicoin extension namespace (upstream keeps versions
// small non-negative ints), the low bits keep the whitepaper's 3. Checked by EXACT equality.
export const NV3_TX_VERSION = 0x80000003;

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
  // nVersion=3 EXTENSION-OUTPUT: decode each output's asset tag from its scriptPubKey (the tag
  // rides an extension push there), exposing the convenient {scriptPubKey(base), assetTag} shape.
  for (const o of vout) {
    const dec = decodeAssetSpk(o.scriptPubKey);
    // Harberger covenant: host FRC whose baseSpk (51 20{nameHash}) DROPS the 14{owner} 08{floorV} 53
    // suffix. Folding it to baseSpk would make serializeTx emit a 34-byte script for a 65-byte one,
    // so parseBlock's `hex.slice(serializeTx(tx).length)` desyncs on the block carrying a claim/buy
    // tx — the ONLY block a claiming wallet ever downloads (matched via its own change), which froze
    // that wallet's sync at "reconnecting". Keep the full script opaque; it's host FRC (assetTag null).
    if (dec && dec.harberger) { o.assetTag = null; continue; }
    if (dec) { o.scriptPubKey = dec.baseSpk; o.assetTag = dec.assetTag; if (dec.tokenHash) o.tokenHash = dec.tokenHash; }
    else o.assetTag = null;
  }
  // Smart-property TOKENS still ride a v3 parallel block (token phase pending).
  if (version === NV3_TX_VERSION) {
    for (const o of vout) {
      const n = r.varint(); o.tokens = [];
      for (let j = 0; j < n; j++) o.tokens.push(r.varbytes());
    }
  }
  if (hasWitness) for (let i = 0; i < nvin; i++) {
    const items = r.varint(); const w = [];
    for (let j = 0; j < items; j++) w.push(r.varbytes());
    vin[i].witness = w;
  }
  // nVersion=3-lite: authorizer approvals, witness-side (flag bit 2)
  let approvals = [];
  if (version === NV3_TX_VERSION && (flags & 2) !== 0) {
    const n = r.varint();
    for (let i = 0; i < n; i++) approvals.push({ assetTag: r.hex(20), sig: r.varbytes() });
  }
  // nVersion=3 DEX: the bundle partition, witness-side (flag bit 4)
  let bundles = [];
  if (version === NV3_TX_VERSION && (flags & 4) !== 0) {
    const n = r.varint();
    for (let i = 0; i < n; i++) bundles.push({ nIn: r.u32(), nOut: r.u32(), nExpireTime: r.u32() });
  }
  // nVersion=3 DEX 2b: ranged bundles, witness-side (flag bit 8). Field order mirrors the C++
  // CRangedBundle (primitives/transaction.h): nIn, payoutAsset(20), payoutScript, priceNum,
  // priceDen, changeScript, minFill, maxFill, nExpireTime.
  let ranged = [];
  if (version === NV3_TX_VERSION && (flags & 8) !== 0) {
    const n = r.varint();
    for (let i = 0; i < n; i++) ranged.push({
      nIn: r.u32(), payoutAsset: r.hex(20), payoutScript: r.varbytes(),
      priceNum: r.u64(), priceDen: r.u64(), changeScript: r.varbytes(),
      minFill: r.u64(), maxFill: r.u64(), nExpireTime: r.u32(),
    });
  }
  const nLockTime = r.u32();
  const lockHeight = r.u32();          // <-- Freicoin
  const nExpireTime = version === NV3_TX_VERSION ? r.u32() : 0;   // nVersion=3-lite
  return { version, hasWitness, flags, vin, vout, nLockTime, lockHeight, nExpireTime, approvals, bundles, ranged, nvin, nvout };
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

const HOST_TAG = '00'.repeat(20);   // null tag = the host currency
// Fold an output's asset tag into its scriptPubKey for the wire (extension push). An output that
// already carries a full ext-push spk (no separate assetTag) passes through unchanged.
const outSpk = o => (o.assetTag && o.assetTag !== HOST_TAG) ? encodeAssetSpk(o.scriptPubKey, o.assetTag, o.tokens ?? [], o.tokenHash ?? null) : o.scriptPubKey;

export function serializeTx(tx) {
  const a = [];
  const approvals = tx.approvals ?? [];
  const bundles = tx.bundles ?? [];
  const ranged = tx.ranged ?? [];
  const withApprovals = tx.version === NV3_TX_VERSION && approvals.length > 0 && tx.hasWitness !== false;
  const withBundles = tx.version === NV3_TX_VERSION && bundles.length > 0 && tx.hasWitness !== false;
  const withRanged = tx.version === NV3_TX_VERSION && ranged.length > 0 && tx.hasWitness !== false;
  pushU32(a, tx.version);
  if (tx.hasWitness || withApprovals || withBundles || withRanged)
    a.push(MARKER, (tx.hasWitness ? 1 : 0) | (withApprovals ? 2 : 0) | (withBundles ? 4 : 0) | (withRanged ? 8 : 0));
  pushVarint(a, tx.vin.length);
  for (const i of tx.vin) {
    a.push(...i.prevout.txid.match(/../g).map(h => parseInt(h, 16)));
    pushU32(a, i.prevout.vout);
    pushVarbytes(a, i.scriptSig);
    pushU32(a, i.sequence);
  }
  pushVarint(a, tx.vout.length);
  // nVersion=3 EXTENSION-OUTPUT: fold each output's asset tag INTO its scriptPubKey (a standard
  // extension push) — no parallel tag block, so the tx is a plain tx old nodes accept.
  for (const o of tx.vout) { pushU64(a, o.value); pushVarbytes(a, outSpk(o)); }
  // Smart-property TOKENS still ride a v3 parallel block (token phase pending).
  if (tx.version === NV3_TX_VERSION) {
    for (const o of tx.vout) {
      const toks = o.tokens ?? [];
      pushVarint(a, toks.length);
      for (const t of toks) pushVarbytes(a, t);
    }
  }
  if (tx.hasWitness) for (const i of tx.vin) {
    pushVarint(a, i.witness.length);
    for (const w of i.witness) pushVarbytes(a, w);
  }
  if (withApprovals) {
    pushVarint(a, approvals.length);
    for (const ap of approvals) { a.push(...ap.assetTag.match(/../g).map(h => parseInt(h, 16))); pushVarbytes(a, ap.sig); }
  }
  if (withBundles) {
    pushVarint(a, bundles.length);
    for (const b of bundles) { pushU32(a, b.nIn); pushU32(a, b.nOut); pushU32(a, b.nExpireTime ?? 0); }
  }
  if (withRanged) {
    pushVarint(a, ranged.length);
    for (const rb of ranged) {
      pushU32(a, rb.nIn);
      a.push(...(rb.payoutAsset ?? HOST_TAG).match(/../g).map(h => parseInt(h, 16)));
      pushVarbytes(a, rb.payoutScript);
      pushU64(a, BigInt(rb.priceNum)); pushU64(a, BigInt(rb.priceDen));
      pushVarbytes(a, rb.changeScript);
      pushU64(a, BigInt(rb.minFill)); pushU64(a, BigInt(rb.maxFill));
      pushU32(a, rb.nExpireTime ?? 0);
    }
  }
  pushU32(a, tx.nLockTime);
  pushU32(a, tx.lockHeight);
  if (tx.version === NV3_TX_VERSION) pushU32(a, tx.nExpireTime ?? 0);
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
