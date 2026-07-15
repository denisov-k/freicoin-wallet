// webpush.mjs — minimal Web Push sender: VAPID (RFC 8292) + aes128gcm content encryption
// (RFC 8291), hand-rolled on node:crypto — no dependencies, same policy as the rest of the stack.
// The relay uses it to ping a swap party when it's THEIR turn (the pushes carry no secrets:
// just a swap id + status; the wallet still needs its password-unlocked seed to act).
import { createECDH, createCipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const b64u = b => Buffer.from(b).toString('base64url');

// ---- VAPID keys: one P-256 pair per relay instance, persisted next to the relay state ----
export function loadOrCreateVapid(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j.publicKey && j.privateJwk) return j;
  } catch { /* first run */ }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  // the `k=` / applicationServerKey form: 65-byte uncompressed point 04 || X || Y
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, 'base64url'), Buffer.from(pubJwk.y, 'base64url')]);
  const rec = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) };
  writeFileSync(file, JSON.stringify(rec));
  return rec;
}

// ---- VAPID Authorization header: ES256 JWT over the push service origin ----
function vapidAuth(vapid, endpoint, sub = 'mailto:admin@testtty.ru') {
  const aud = new URL(endpoint).origin;
  const seg = o => b64u(JSON.stringify(o));
  const signingInput = `${seg({ typ: 'JWT', alg: 'ES256' })}.${seg({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub })}`;
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---- RFC 8291 aes128gcm encryption of the payload for one subscription ----
function encrypt(subscription, payload) {
  const uaPub = Buffer.from(subscription.keys.p256dh, 'base64url');   // client's P-256 point
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();                                   // 65-byte uncompressed
  const shared = ecdh.computeSecret(uaPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // single record: payload ++ 0x02 delimiter (last record), no extra padding
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  // aes128gcm body header: salt(16) | rs(4) | idlen(1) | keyid(=as_public, 65)
  const head = Buffer.concat([salt, Buffer.from([0, 0, 16, 0]), Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([head, ct]);
}

// Send one push. Resolves {ok, gone} — `gone` means the subscription is dead (unsubscribe it).
export async function sendPush(vapid, subscription, payloadObj, ttl = 3600) {
  const body = encrypt(subscription, JSON.stringify(payloadObj));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(vapid, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
    },
    body,
  });
  // 404/410 = endpoint expired; anything else non-2xx is transient
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}
