// ln-client.mjs — фасад ⚡-счёта в главном потоке: поднимает ln-worker по требованию (ленивая
// загрузка 24МБ LDK-wasm), RPC поверх postMessage, события узла — подписчикам. Прогресс чейн-фида
// персистится в localStorage (после рестарта кормим с последней обработанной высоты, гэп дочитает
// реле). Сид уходит ТОЛЬКО в воркер (тот же origin), наружу — никогда.
let worker = null, seq = 0;
const pending = new Map();
const listeners = new Map();   // event → Set<fn>

const HKEY = () => 'fw_ln_height:' + (localStorage.getItem('fw_net') || 'main');

export function lnOn(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
const fire = (event, data) => { for (const fn of listeners.get(event) ?? []) try { fn(data); } catch {} };

function call(callName, args) {
  if (!worker) throw new Error('LN-узел не запущен');
  return new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    worker.postMessage({ id, call: callName, args });
  });
}

/** Запуск узла. cfg: {seedBytes, net, apiBase, lspWsUrl, lspNodeId, anchor} */
export async function lnStart(cfg) {
  if (worker) return call('status');
  worker = new Worker(new URL('./ln-worker.mjs', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.id != null) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.err ? p.rej(new Error(m.err)) : p.res(m.ok); } return; }
    if (m.event === 'height') { try { localStorage.setItem(HKEY(), String(m.data)); } catch {} }
    fire(m.event, m.data);
  };
  worker.onerror = e => fire('log', 'worker error: ' + e.message);
  const fromHeight = (() => { try { const v = localStorage.getItem(HKEY()); return v == null ? null : +v + 1; } catch { return null; } })();
  return call('init', { ...cfg, fromHeight });
}
export const lnRunning = () => !!worker;
export const lnStatus = () => worker ? call('status') : Promise.resolve({ running: false });
export const lnInvoice = (sats, memo, hashHex) => call('invoice', { sats, memo, hashHex });
export const lnPayBolt11 = bolt11 => call('pay', { bolt11 });
export const lnClaim = preimageHex => call('claim', { preimageHex });
export const lnOpenChannel = sats => call('openChannel', { sats });
export const lnFundingComplete = rawtxHex => call('fundingComplete', { rawtxHex });
export const lnFlush = () => call('flush');
