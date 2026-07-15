// mv-push.mjs — Web-Push «ваш ход»: the relay pings a swap party when a transition needs them
// (pay confirmed → lock; locked → claim; cancel requested → authorize…). A push carries NO
// secrets — just swap id + status; acting still requires the password-unlocked seed in the tab.
// Notifications are a UX accelerant, not a safety mechanism: an unreachable party is protected
// by the HTLC timeouts regardless.
import { api, ctx, p2pKey } from './mv-ctx.mjs';
import { loadP2p } from './mv-storage.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';

const LS = 'fw_push_on';   // browser-global toggle; the subscription registers per-network relay
export const pushSupported = () =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
export const pushEnabled = () => { try { return localStorage.getItem(LS) === '1'; } catch { return false; } };

const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function ensureSub() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api('pushInfo');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  }
  return sub;
}

// MUST be called from a user gesture (the Settings toggle) — permission prompts require one.
export async function enablePush() {
  if (!pushSupported()) throw new Error('браузер не поддерживает уведомления (на iOS — добавьте сайт на экран «Домой»)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('уведомления запрещены в браузере');
  await ensureSub();
  try { localStorage.setItem(LS, '1'); } catch {}
  lastSig = ''; lastAt = 0;          // force an immediate key registration
  await refreshPushSubs();
}

export async function disablePush() {
  try { localStorage.removeItem(LS); } catch {}
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api('pushUnsub', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  } catch { /* already gone */ }
}

// Register my CURRENT swap keys (offer-level maker keys + per-swap taker keys — both live in the
// local records' nonces) with this network's relay. Piggybacks on the drive cycle; throttled to
// «changed, or 10-minute TTL refresh» so it costs one write call, not one per poll.
let lastSig = '', lastAt = 0;
export async function refreshPushSubs() {
  if (!pushEnabled() || !pushSupported() || !ctx.seed) return;
  try {
    const pubs = [...new Set(loadP2p()
      .map(r => { try { return pubkeyCompressed(p2pKey(r.nonce, 'frc')); } catch { return null; } })
      .filter(Boolean))];
    if (!pubs.length) return;
    const sig = pubs.join(',');
    if (sig === lastSig && Date.now() - lastAt < 10 * 60e3) return;
    const sub = await ensureSub();
    await api('pushSub', { sub: sub.toJSON(), pubs });
    lastSig = sig; lastAt = Date.now();
  } catch { /* best-effort — timeouts protect an unnotified party anyway */ }
}
