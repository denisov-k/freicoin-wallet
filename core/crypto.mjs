// crypto.mjs — hash/HMAC primitives for the wallet core (Node implementation).
//
// This is the ONLY module that touches an environment-specific crypto backend.
// The rest of core/ imports its hashes from here, so it stays environment-neutral.
// A browser build aliases this file to `crypto.web.mjs` (identical signatures,
// backed by @noble/hashes) via the package.json "browser" field / a bundler
// alias — no other core file changes.
//
// All functions take and return Buffer/Uint8Array (Buffer here, in Node).
import { createHash, createHmac } from 'crypto';

// Accept a Buffer, Uint8Array, or plain array of byte values (never a string).
const buf = b => Buffer.isBuffer(b) ? b : Buffer.from(b);

export const sha256 = b => createHash('sha256').update(buf(b)).digest();
export const ripemd160 = b => createHash('ripemd160').update(buf(b)).digest();
export const sha256d = b => sha256(sha256(b));                         // double SHA-256 (HASH256)
export const hash160 = b => ripemd160(sha256(b));                      // RIPEMD160(SHA256(x))
export const hmacSha256 = (key, msg) => createHmac('sha256', buf(key)).update(buf(msg)).digest();
export const hmacSha512 = (key, msg) => createHmac('sha512', buf(key)).update(buf(msg)).digest();
