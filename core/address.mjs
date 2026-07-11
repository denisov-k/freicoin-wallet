// address.mjs — Freicoin address encode/decode (bech32 BIP173 + base58check).
// Freicoin params: bech32 HRP fc/tf/fcrt; base58 prefixes identical to Bitcoin.
// Witness v0 = MAST program (20-byte short / 32-byte long), NO taproot (no v1/bech32m).

import { sha256 } from './crypto.mjs';

export const NETWORKS = {
  main:    { hrp: "fc",   p2pkh: 0x00, p2sh: 0x05, wif: 0x80 },
  test:    { hrp: "tf",   p2pkh: 0x6f, p2sh: 0xc4, wif: 0xef },
  regtest: { hrp: "fcrt", p2pkh: 0x6f, p2sh: 0xc4, wif: 0xef },
  nv3:     { hrp: "fcrt", p2pkh: 0x6f, p2sh: 0xc4, wif: 0xef },   // Freimarkets nV3 chain = regtest addresses
};

// ---- bech32 (BIP173) ----
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3; // Freicoin uses bech32m (BIP350) for witness v0 (no taproot; unlike Bitcoin which uses bech32 for v0)
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const r = [];
  for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
  r.push(0);
  for (const c of hrp) r.push(c.charCodeAt(0) & 31);
  return r;
}
function bech32Encode(hrp, data) {
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((chk >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...out].map(d => CHARSET[d]).join("");
}
function bech32Decode(s) {
  const pos = s.lastIndexOf("1");
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map(c => CHARSET.indexOf(c));
  if (data.some(d => d < 0)) throw new Error("bad bech32 char");
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) throw new Error("bad checksum");
  return { hrp, data: data.slice(0, -6) };
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [];
  const maxv = (1 << to) - 1;
  for (const b of data) {
    acc = (acc << from) | b; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  return out;
}

/** Encode a witness program (v0 MAST) to a Freicoin bech32 address. */
export function encodeWitness(net, version, programHex) {
  const prog = Uint8Array.from(programHex.match(/../g).map(h => parseInt(h, 16)));
  return bech32Encode(NETWORKS[net].hrp, [version, ...convertBits([...prog], 8, 5, true)]);
}
/** Decode a Freicoin bech32 address → {version, programHex}. */
export function decodeWitness(addr) {
  const { hrp, data } = bech32Decode(addr);
  const version = data[0];
  const prog = convertBits(data.slice(1), 5, 8, false);
  return { hrp, version, programHex: prog.map(b => b.toString(16).padStart(2, "0")).join("") };
}

// ---- base58check ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
function b58decode(str) {
  let n = 0n; for (const c of str) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
/** Encode a hash160 to a base58check address with given version byte. */
export async function encodeBase58Check(version, hash160Hex) {
  const h = Uint8Array.from(hash160Hex.match(/../g).map(x => parseInt(x, 16)));
  const payload = Uint8Array.from([version, ...h]);
  const chk = (await sha256(await sha256(payload))).slice(0, 4);
  return b58encode(Uint8Array.from([...payload, ...chk]));
}
/** Decode a base58check address → {version, hash160Hex}. */
export async function decodeBase58Check(addr) {
  const raw = b58decode(addr);
  const payload = raw.slice(0, -4), chk = raw.slice(-4);
  const good = (await sha256(await sha256(payload))).slice(0, 4);
  if (chk.some((b, i) => b !== good[i])) throw new Error("bad checksum");
  return { version: payload[0], hash160Hex: [...payload.slice(1)].map(b => b.toString(16).padStart(2, "0")).join("") };
}
