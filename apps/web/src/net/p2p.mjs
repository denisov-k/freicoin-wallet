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

/** Streaming decoder: push a chunk, get back an array of {command, payload, ok}. */
export function createDecoder(net) {
  const magic = Buffer.from(MAGIC[net]);
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    const out = [];
    while (buf.length >= 24) {
      if (!buf.subarray(0, 4).equals(magic)) { buf = buf.subarray(1); continue; }  // resync
      const len = buf.readUInt32LE(16);
      if (buf.length < 24 + len) break;
      const command = buf.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
      const payload = buf.subarray(24, 24 + len);
      const ok = Buffer.from(sha256d(payload)).subarray(0, 4).equals(buf.subarray(20, 24));
      out.push({ command, payload, ok });
      buf = buf.subarray(24 + len);
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
  u32le(height); push(Buffer.from([0]));   // relay = false
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

/** getheaders payload: version + block locator (display-hex hashes) + hash_stop. */
export function buildGetHeaders(protoVer, locatorHex, hashStopHex = '00'.repeat(32)) {
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(protoVer);
  parts.push(writeVarint(locatorHex.length));
  for (const h of locatorHex) parts.push(Buffer.from(h, 'hex').reverse());   // display -> internal
  parts.push(Buffer.from(hashStopHex, 'hex').reverse());
  return Buffer.concat(parts);
}

/** Parse a `headers` message into [{hash, prevHash, version, time, bits, nonce}].
 *  Regtest/native-PoW headers are 80 bytes; aux-pow (mainnet) headers are not yet
 *  supported here (they carry a merged-mining proof after the 80-byte base). */
export function parseHeaders(payload) {
  payload = Buffer.from(payload);
  let [count, o] = readVarint(payload, 0);
  const headers = [];
  for (let i = 0; i < count; i++) {
    const base = payload.subarray(o, o + 80);
    const bits = base.readUInt32LE(72) >>> 0;
    if (bits & AUX_FLAG) throw new Error('aux-pow header parsing not yet implemented (mainnet)');
    const hash = Buffer.from(sha256d(base)).reverse().toString('hex');
    const prevHash = Buffer.from(base.subarray(4, 36)).reverse().toString('hex');
    headers.push({ hash, prevHash, version: base.readInt32LE(0), time: base.readUInt32LE(68), bits, nonce: base.readUInt32LE(76) >>> 0 });
    o += 80;
    [, o] = readVarint(payload, o);   // tx_count (0 in headers)
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
/** Parse a `cfilter` message: filter_type(1) + block_hash(32) + filter(varint+bytes). */
export function parseCFilter(payload) {
  payload = Buffer.from(payload);
  const blockHash = Buffer.from(payload.subarray(1, 33)).reverse().toString('hex');
  const [len, o] = readVarint(payload, 33);
  return { blockHash, filter: payload.subarray(o, o + len) };
}

export const MSG_WITNESS_BLOCK = 0x40000002;
/** getdata payload: varint(count) + [type(4 LE) + hash(32)]. */
export function buildGetData(items) {
  const parts = [writeVarint(items.length)];
  for (const it of items) { const b = Buffer.alloc(4); b.writeUInt32LE(it.type >>> 0); parts.push(b); parts.push(Buffer.from(it.hashHex, 'hex').reverse()); }
  return Buffer.concat(parts);
}
