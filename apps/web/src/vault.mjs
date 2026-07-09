// vault.mjs — passphrase-encrypted secret storage. Uses @noble (PBKDF2 + AES-GCM)
// rather than WebCrypto SubtleCrypto so it works over plain http too (subtle is
// restricted to secure contexts). The decrypted secret only ever lives in memory.
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u => btoa(String.fromCharCode(...u));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const keyFrom = (pass, salt) => pbkdf2(sha256, enc.encode(pass), salt, { c: 200000, dkLen: 32 });

/** Encrypt `secret` (string) under `passphrase`. Returns a JSON-serialisable vault. */
export function encryptSecret(secret, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(keyFrom(passphrase, salt), nonce).encrypt(enc.encode(secret));
  return { v: 1, salt: b64(salt), nonce: b64(nonce), ct: b64(ct) };
}

/** Decrypt a vault with `passphrase`. Throws if the passphrase is wrong. */
export function decryptSecret(vault, passphrase) {
  const pt = gcm(keyFrom(passphrase, unb64(vault.salt)), unb64(vault.nonce)).decrypt(unb64(vault.ct));
  return dec.decode(pt);
}
