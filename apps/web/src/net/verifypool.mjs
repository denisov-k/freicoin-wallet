// verifypool.mjs — a pool of verify-worker threads for parallel aux-pow verification.
// Works with browser Workers (nested workers — inside the light-client worker) and
// node worker_threads (tests). Returns null when neither is available; the client
// falls back to inline verification.

async function spawn() {
  if (typeof Worker !== 'undefined') {
    const w = new Worker(new URL('./verify-worker.mjs', import.meta.url), { type: 'module' });
    return { post: m => w.postMessage(m), on: f => { w.onmessage = e => f(e.data); }, kill: () => w.terminate() };
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { Worker: NodeWorker } = await import(/* @vite-ignore */ 'node:worker_threads');
    const w = new NodeWorker(new URL('./verify-worker.mjs', import.meta.url));
    w.unref?.();
    return { post: m => w.postMessage(m), on: f => w.on('message', f), kill: () => w.terminate() };
  }
  return null;
}

/** Create a verification pool of `k` workers (defaults to cores-1, clamped). Null if
 *  worker threads are unavailable in this environment. */
export async function makePool(k) {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  k = k || Math.max(1, Math.min(4, cores - 1));
  let workers;
  try {
    workers = await Promise.all(Array.from({ length: k }, spawn));
    if (workers.some(w => !w)) throw new Error('unavailable');
  } catch { return null; }
  let seq = 0;
  const waits = new Map();
  for (const w of workers) w.on(m => { const p = waits.get(m.id); if (p) { waits.delete(m.id); p(m); } });
  const call = (w, net, raws) => new Promise(res => { const id = ++seq; waits.set(id, res); w.post({ id, net, raws }); });
  return {
    size: k,
    /** Verify a batch of raw aux-pow headers across all workers. Throws on any failure. */
    async verify(net, raws) {
      if (!raws.length) return;
      const per = Math.ceil(raws.length / workers.length);
      const parts = [];
      for (let i = 0; i < raws.length; i += per) parts.push(raws.slice(i, i + per));
      const rs = await Promise.all(parts.map((p, i) => call(workers[i % workers.length], net, p)));
      const bad = rs.find(r => !r.ok);
      if (bad) throw new Error('aux-pow invalid (parallel verify)');
    },
    close() { for (const w of workers) { try { w.kill(); } catch {} } },
  };
}
