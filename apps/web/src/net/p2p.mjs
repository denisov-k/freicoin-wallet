// p2p.mjs — Freicoin P2P wire protocol (message framing + version handshake).
// Transport-agnostic: the caller supplies bytes in (createDecoder) and sends
// bytes out (encodeMessage). Works over a Node TCP socket or a browser WebSocket
// (via a WS↔TCP bridge, since browsers can't open raw TCP).
import { Buffer } from 'buffer';
import { sha256d } from '../../../../core/crypto.mjs';

export const MAGIC = {
  main: [0x2c, 0xfe, 0x7e, 0x6d], test: [0x5e, 0xd6, 0x7c, 0xf3],
  regtest: [0xed, 0x99, 0x9c, 0xf6], signet: [0x0a, 0x03, 0xcf, 0x40],
};

/** Frame a message: magic(4) ++ command(12) ++ len(4 LE) ++ checksum(4) ++ payload. */
export function encodeMessage(net, command, payload = Buffer.alloc(0)) {
  payload = Buffer.from(payload);
  const cmd = Buffer.alloc(12); cmd.write(command, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32LE(payload.length);
  const chk = Buffer.from(sha256d(payload)).subarray(0, 4);
  return Buffer.concat([Buffer.from(MAGIC[net]), cmd, len, chk, payload]);
}

/** Streaming decoder: push a chunk, get back an array of {command, payload, ok}.
 *  Chunks are accumulated in a list and merged only once a full message is available
 *  (`needed` tracks the message boundary) — a naive per-chunk Buffer.concat is O(n²)
 *  on large messages (a mainnet aux-pow headers batch is ~730KB across many chunks). */
export function createDecoder(net) {
  const magic = Buffer.from(MAGIC[net]);
  let acc = [], total = 0, needed = 24;
  return chunk => {
    acc.push(Buffer.from(chunk)); total += chunk.length;
    const out = [];
    while (total >= needed) {
      let b = acc.length === 1 ? acc[0] : (acc = [Buffer.concat(acc)])[0];
      if (!b.subarray(0, 4).equals(magic)) {                       // resync (rare)
        let off = 1;
        while (off + 4 <= b.length && !b.subarray(off, off + 4).equals(magic)) off++;
        b = b.subarray(off); acc = [b]; total = b.length; needed = 24;
        if (total < 24) break; else continue;
      }
      const len = b.readUInt32LE(16);
      if (total < 24 + len) { needed = 24 + len; break; }          // wait — no concat per chunk
      const command = b.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
      const payload = b.subarray(24, 24 + len);
      const ok = Buffer.from(sha256d(payload)).subarray(0, 4).equals(b.subarray(20, 24));
      out.push({ command, payload, ok });
      const rest = b.subarray(24 + len);
      acc = [rest]; total = rest.length; needed = 24;
    }
    return out;
  };
}

const randNonce = () => { const b = Buffer.alloc(8); globalThis.crypto.getRandomValues(b); return b; };

/** Build a `version` payload. */
export function buildVersion({ protoVer = 70016, services = 0n, height = 0, ua = '/freicoin-wallet:0.1/' } = {}) {
  const parts = [];
  const push = b => parts.push(b);
  const u32le = v => { const x = Buffer.alloc(4); x.writeInt32LE(v); push(x); };
  const u64le = v => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(v)); push(x); };
  const i64le = v => { const x = Buffer.alloc(8); x.writeBigInt64LE(BigInt(v)); push(x); };
  const netaddr = () => { u64le(0n); push(Buffer.alloc(16)); const p = Buffer.alloc(2); p.writeUInt16BE(0); push(p); };
  u32le(protoVer); u64le(services); i64le(Math.floor(Date.now() / 1000));
  netaddr(); netaddr(); push(randNonce());
  const uab = Buffer.from(ua, 'ascii'); push(Buffer.from([uab.length])); push(uab);
  u32le(height); push(Buffer.from([1]));   // relay = true (we want mempool tx invs)
  return Buffer.concat(parts);
}

/** Parse a peer `version` payload into a summary. */
export function parseVersion(p) {
  p = Buffer.from(p);
  const version = p.readInt32LE(0);
  const services = p.readBigUInt64LE(4);
  let o = 4 + 8 + 8 + 26 + 26 + 8;             // skip services,ts,addr_recv,addr_from,nonce
  const uaLen = p[o]; o += 1;
  const ua = p.subarray(o, o + uaLen).toString('ascii'); o += uaLen;
  const startHeight = p.readInt32LE(o);
  return { version, services, ua, startHeight };
}

// --- varint (compact size) ---
export function writeVarint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}
export function readVarint(buf, o) {
  const n = buf[o];
  if (n < 0xfd) return [n, o + 1];
  if (n === 0xfd) return [buf.readUInt16LE(o + 1), o + 3];
  if (n === 0xfe) return [buf.readUInt32LE(o + 1), o + 5];
  return [Number(buf.readBigUInt64LE(o + 1)), o + 9];
}

const AUX_FLAG = 1 << 23;   // nBits sign bit: set => an AuxProofOfWork follows the 80-byte header

/** Bitcoin VARINT (base-128; distinct from the compactSize used for vector lengths). */
export function readBVarint(buf, o) {
  let n = 0n;
  for (;;) { const b = buf[o++]; n = (n << 7n) | BigInt(b & 0x7f); if (b & 0x80) n++; else break; }
  return [Number(n), o];
}

/** Advance past an AuxProofOfWork serialization starting at `o`. Returns the new offset. */
export function skipAuxPow(buf, o) {
  o += 4 + 32 + 4 + 4 + 4 + 8 + 8;                        // commit_version..secret_hi
  let n; [n, o] = readVarint(buf, o); o += n * (1 + 32); // commit_branch: N*(uchar+uint256)
  o += 32;                                                // midstate_hash
  [n, o] = readVarint(buf, o); o += n;                   // midstate_buffer
  [, o] = readBVarint(buf, o);                            // VARINT midstate_length
  o += 4;                                                 // aux_lock_time
  [n, o] = readVarint(buf, o); o += n * 32;              // aux_branch: N*uint256
  [, o] = readBVarint(buf, o);                            // VARINT aux_pos
  o += 4 + 32 + 4 + 4;                                    // aux_version,aux_prev,aux_bits,aux_nonce
  return o;
}

/** getheaders payload: version + block locator (display-hex hashes) + hash_stop. */
export function buildGetHeaders(protoVer, locatorHex, hashStopHex = '00'.repeat(32)) {
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(protoVer);
  parts.push(writeVarint(locatorHex.length));
  for (const h of locatorHex) parts.push(Buffer.from(h, 'hex').reverse());   // display -> internal
  parts.push(Buffer.from(hashStopHex, 'hex').reverse());
  return Buffer.concat(parts);
}

/** Parse a `headers` message into [{hash, prevHash, version, time, bits, nonce, hasAux}].
 *  Handles native-PoW (80-byte, regtest) and aux-pow (mainnet) headers. The block hash is
 *  HASH256 of the 80-byte base with the aux flag cleared from nBits; an aux-pow header also
 *  carries a dummy(0xff)+flags pair and a merged-mining proof, which is parsed past.
 *  (Aux-pow *PoW verification* — GetAuxiliaryHash — is a separate step.) */
export function parseHeaders(payload) {
  payload = Buffer.from(payload);
  let [count, o] = readVarint(payload, 0);
  const headers = [];
  for (let i = 0; i < count; i++) {
    const start = o;
    const base = Buffer.from(payload.subarray(o, o + 80));
    const serBits = base.readUInt32LE(72) >>> 0;
    const hasAux = (serBits & AUX_FLAG) !== 0;
    const bits = serBits & ~AUX_FLAG;                     // real nBits (aux flag cleared)
    base.writeUInt32LE(bits >>> 0, 72);
    const hash = Buffer.from(sha256d(base)).reverse().toString('hex');
    const prevHash = Buffer.from(base.subarray(4, 36)).reverse().toString('hex');
    o += 80;
    if (hasAux) o = skipAuxPow(payload, o + 2);           // dummy(0xff) + flags + aux_pow
    // raw = the full header bytes (base + aux-pow), for aux-pow PoW verification
    const raw = hasAux ? Buffer.from(payload.subarray(start, o)) : base;
    headers.push({ hash, prevHash, version: base.readInt32LE(0), time: base.readUInt32LE(68), bits, nonce: base.readUInt32LE(76) >>> 0, hasAux, raw });
    [, o] = readVarint(payload, o);                       // tx_count (0 in headers)
  }
  return headers;
}

/** Native (non-aux) PoW check: SHA256d(header) <= target(nBits). Regtest passes at min difficulty. */
export function checkNativePoW(header) {
  const target = compactToTarget(header.bits);
  return BigInt('0x' + header.hash) <= target;   // hash is display (big-endian) hex
}
function compactToTarget(bits) {
  const exp = bits >>> 24, mant = BigInt(bits & 0x007fffff);
  return exp <= 3 ? mant >> (8n * BigInt(3 - exp)) : mant << (8n * BigInt(exp - 3));
}

/** getcfilters payload (BIP157): filter_type(1) + start_height(4 LE) + stop_hash(32). */
export function buildGetCFilters(startHeight, stopHashHex, filterType = 0) {
  const b = Buffer.alloc(5); b[0] = filterType; b.writeUInt32LE(startHeight, 1);
  return Buffer.concat([b, Buffer.from(stopHashHex, 'hex').reverse()]);
}
/** getcfheaders payload (BIP157): filter_type(1) + start_height(4 LE) + stop_hash(32). */
export function buildGetCFHeaders(startHeight, stopHashHex, filterType = 0) {
  const b = Buffer.alloc(5); b[0] = filterType; b.writeUInt32LE(startHeight, 1);
  return Buffer.concat([b, Buffer.from(stopHashHex, 'hex').reverse()]);
}
/** Parse a `cfheaders` message: filter_type(1) + stop_hash(32) + prev_filter_header(32) +
 *  varint(count) + count × filter_hash(32). Returns display-hex {prevHeader, filterHashes[]}.
 *  filter_hash = double-SHA256 of the serialized BIP158 filter (one per block in range). */
export function parseCFHeaders(payload) {
  payload = Buffer.from(payload);
  const prevHeader = Buffer.from(payload.subarray(33, 65)).reverse().toString('hex');
  let [count, o] = readVarint(payload, 65);
  const filterHashes = [];
  for (let i = 0; i < count; i++) { filterHashes.push(Buffer.from(payload.subarray(o, o + 32)).reverse().toString('hex')); o += 32; }
  return { prevHeader, filterHashes };
}

/** Parse a `cfilter` message: filter_type(1) + block_hash(32) + filter(varint+bytes). */
export function parseCFilter(payload) {
  payload = Buffer.from(payload);
  const blockHash = Buffer.from(payload.subarray(1, 33)).reverse().toString('hex');
  const [len, o] = readVarint(payload, 33);
  return { blockHash, filter: payload.subarray(o, o + len) };
}

export const MSG_WITNESS_BLOCK = 0x40000002;
export const MSG_WITNESS_TX = 0x40000001;
export const MSG_TX = 1;
/** Parse an `inv` message: varint(count) + count × (type u32 LE + hash 32). Display-hex hashes. */
export function parseInv(payload) {
  payload = Buffer.from(payload);
  let [count, o] = readVarint(payload, 0);
  const items = [];
  for (let i = 0; i < count; i++) {
    const type = payload.readUInt32LE(o) >>> 0;
    const hashHex = Buffer.from(payload.subarray(o + 4, o + 36)).reverse().toString('hex');
    items.push({ type, hashHex }); o += 36;
  }
  return items;
}
/** getdata payload: varint(count) + [type(4 LE) + hash(32)]. */
export function buildGetData(items) {
  const parts = [writeVarint(items.length)];
  for (const it of items) { const b = Buffer.alloc(4); b.writeUInt32LE(it.type >>> 0); parts.push(b); parts.push(Buffer.from(it.hashHex, 'hex').reverse()); }
  return Buffer.concat(parts);
}
