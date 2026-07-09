// ecdsa.web.mjs — browser secp256k1 backend (@noble/secp256k1), swapped in for the
// pure-JS ecdsa.mjs via core/package.json "browser" + the Vite alias. Same exports
// (N, pubkeyCompressed, signEcdsa) the wallet uses. @noble is orders of magnitude
// faster than the pure-JS point multiplication, so the browser key scan + signing
// are instant. Public keys are identical to ecdsa.mjs (verified), so addresses are
// unchanged; signatures are canonical (low-S) DER that the node accepts (they need
// only be valid, not byte-identical to the Node/key.py reference).
import { Buffer } from 'buffer';
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// @noble/secp256k1 v3 needs the hash functions provided (for RFC6979).
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const hexBuf = h => Buffer.from(h.padStart(64, '0'), 'hex');

export function pubkeyCompressed(secretHex) {
  return Buffer.from(secp.getPublicKey(hexBuf(secretHex), true)).toString('hex');
}

// DER integer, standard minimal-positive encoding (matches ecdsa.mjs).
const bitLen = x => (x === 0n ? 0 : x.toString(2).length);
function derInt(x) {
  const len = (bitLen(x) + 8) >> 3;
  const b = Buffer.from(x.toString(16).padStart(len * 2, '0'), 'hex');
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
}

export function signEcdsa(secretHex, msgHashHex) {
  // v3 sign() returns a 64-byte compact (r||s), low-S by default, no re-hashing.
  const sig = secp.sign(hexBuf(msgHashHex), hexBuf(secretHex), { prehash: false });
  const r = BigInt('0x' + Buffer.from(sig.slice(0, 32)).toString('hex'));
  const s = BigInt('0x' + Buffer.from(sig.slice(32, 64)).toString('hex'));
  const der = Buffer.concat([derInt(r), derInt(s)]);
  return Buffer.concat([Buffer.from([0x30, der.length]), der]).toString('hex');
}
