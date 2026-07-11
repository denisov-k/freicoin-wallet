// hd.mjs — BIP32 hierarchical-deterministic key derivation for Freicoin, with
// BIP44/84 paths. Freicoin uses the standard Bitcoin ext-key version bytes
// (mainnet xprv/xpub 0x0488ADE4/0x0488B21E, test 0x04358394/0x043587CF) and
// SLIP44 coin types 0 (mainnet) / 1 (test/regtest), so the canonical BIP32 test
// vectors apply directly. The one Freicoin-ism appears only at the address layer
// (bech32m for witness v0, HRP fc/tf/fcrt) — handled by address.mjs.
import { sha256, ripemd160, hmacSha512 } from './crypto.mjs';
import { N, pubkeyCompressed } from './ecdsa.mjs';

const VERSIONS = {
  main: { priv: 0x0488ade4, pub: 0x0488b21e },
  test: { priv: 0x04358394, pub: 0x043587cf },   // testnet/regtest/signet
};
const HARDENED = 0x80000000;

const hash160 = b => ripemd160(sha256(b));
const hmac512 = (key, msg) => hmacSha512(key, msg);
const hexToBuf = h => Buffer.from(h, 'hex');
const big = buf => BigInt('0x' + buf.toString('hex'));
const ser32 = n => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const priv32 = k => Buffer.from(k.toString(16).padStart(64, '0'), 'hex');

// --- base58check (node-free) ---
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let x = big(buf), out = '';
  while (x > 0n) { out = B58[Number(x % 58n)] + out; x /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
function base58check(payload) {
  const chk = sha256(sha256(payload)).subarray(0, 4);
  return base58(Buffer.concat([payload, chk]));
}

/** Master node from a BIP32 seed (hex). Returns {priv:bigint, chain:Buffer, depth, index, parentFp}. */
export function fromSeed(seedHex) {
  const I = hmac512(Buffer.from('Bitcoin seed'), hexToBuf(seedHex));
  return { priv: big(I.subarray(0, 32)) % N, chain: I.subarray(32), depth: 0, index: 0, parentFp: Buffer.alloc(4) };
}

/** Compressed public key (33-byte Buffer) of a node. */
export function pubkey(node) { return hexToBuf(pubkeyCompressed(priv32(node.priv).toString('hex'))); }
function fingerprint(node) { return hash160(pubkey(node)).subarray(0, 4); }

/** CKDpriv: derive child private node at `index` (add HARDENED for a hardened child). */
export function ckdPriv(node, index) {
  const data = index >= HARDENED
    ? Buffer.concat([Buffer.from([0]), priv32(node.priv), ser32(index)])       // hardened: 0x00||ser256(kpar)||i
    : Buffer.concat([pubkey(node), ser32(index)]);                             // normal: serP(point(kpar))||i
  const I = hmac512(node.chain, data);
  const childPriv = (big(I.subarray(0, 32)) + node.priv) % N;
  return { priv: childPriv, chain: I.subarray(32), depth: node.depth + 1, index, parentFp: fingerprint(node) };
}

/** Derive an absolute path like "m/84'/1'/0'/0/0" from a seed. */
export function derivePath(seedHex, path) {
  let node = fromSeed(seedHex);
  for (const part of path.replace(/^m\/?/, '').split('/').filter(Boolean)) {
    const hard = part.endsWith("'") || part.endsWith('h');
    const idx = parseInt(part, 10) + (hard ? HARDENED : 0);
    node = ckdPriv(node, idx);
  }
  return node;
}

/** Serialize a node as xprv (base58check), Freicoin/Bitcoin version bytes. */
export function toXprv(node, net = 'main') {
  const v = (VERSIONS[net] || VERSIONS.test).priv;   // regtest/nv3/signet share testnet version bytes
  const payload = Buffer.concat([ser32(v).subarray(0, 4), Buffer.from([node.depth]),
    node.parentFp, ser32(node.index), node.chain, Buffer.concat([Buffer.from([0]), priv32(node.priv)])]);
  return base58check(payload);
}
/** Serialize a node's public half as xpub (base58check). */
export function toXpub(node, net = 'main') {
  const v = (VERSIONS[net] || VERSIONS.test).pub;
  const payload = Buffer.concat([ser32(v).subarray(0, 4), Buffer.from([node.depth]),
    node.parentFp, ser32(node.index), node.chain, pubkey(node)]);
  return base58check(payload);
}

// Freicoin wpk (witness v0 pubkey) program — NOT bitcoin's hash160(pubkey).
// Witness v0 is a MAST Merkle-root program: WitnessV0ShortHash(0, pubkey) =
// RIPEMD160( HASH256( version(0x00) || (0x21 <pubkey> OP_CHECKSIG) ) ), where
// HASH256 is double-SHA256 (addresstype.cpp WitnessV0LongHash/ShortHash).
const hash256d = b => sha256(sha256(b));
export function wpkProgramHex(node) {
  const pk = pubkey(node);                                   // 33-byte compressed
  const p2pk = Buffer.concat([Buffer.from([0x21]), pk, Buffer.from([0xac])]); // push pk + OP_CHECKSIG
  const longid = hash256d(Buffer.concat([Buffer.from([0x00]), p2pk]));        // HASH256(ver||p2pk)
  return ripemd160(longid).toString('hex');                                    // 20-byte short hash
}
