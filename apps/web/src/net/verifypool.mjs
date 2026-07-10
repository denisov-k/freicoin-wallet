// verifypool.mjs — a pool of verify-worker threads for parallel aux-pow verification and
// GCS filter matching. Works with browser Workers (nested workers — inside the light-client
// worker) and node worker_threads (tests). Returns null when neither is available; the
// client falls back to inline execution.
//
// The pool schedules jobs ITSELF (one in flight per worker, priority queues) instead of
// dumping them into worker FIFOs: a fast header bootstrap queues minutes of verify work
// up front, and filter-match jobs — which the scan follower BLOCKS on — would otherwise
// sit behind the whole verification backlog (a head-of-line convoy that made the scan
// crawl). Matching is high priority; verification fills the remaining capacity.

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

const VERIFY_CHUNK = 400;   // proofs per scheduled job (~0.1s) — keeps priority latency low

/** Create a verification/matching pool of `k` workers (defaults to cores-1, clamped).
 *  Null if worker threads are unavailable in this environment. */
export async function makePool(k) {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  // during the CPU-heavy phase the client thread is mostly idle (downloads done), so on
  // small machines use every core; on bigger ones leave one for the client thread
  k = k || Math.max(1, Math.min(4, cores <= 2 ? cores : cores - 1));
  let workers;
  try {
    workers = await Promise.all(Array.from({ length: k }, spawn));
    if (workers.some(w => !w)) throw new Error('unavailable');
  } catch { return null; }

  let seq = 0;
  const waits = new Map();     // id -> {worker, resolve}
  const hi = [], lo = [];      // priority queues of {payload, res}
  const idle = [...workers];
  const pump = () => {
    while (idle.length && (hi.length || lo.length)) {
      const job = hi.length ? hi.shift() : lo.shift();
      const w = idle.pop();
      const id = ++seq;
      waits.set(id, { w, res: job.res });
      w.post({ id, ...job.payload });
    }
  };
  for (const w of workers) w.on(m => {
    const p = waits.get(m.id); if (!p) return;
    waits.delete(m.id);
    idle.push(p.w);
    p.res(m);
    pump();
  });
  const call = (payload, prio) => new Promise(res => { (prio === 'hi' ? hi : lo).push({ payload, res }); pump(); });

  return {
    size: k,
    /** Verify a batch of raw aux-pow headers (low priority, chunked). Throws on failure. */
    async verify(net, raws) {
      if (!raws.length) return;
      const parts = [];
      for (let i = 0; i < raws.length; i += VERIFY_CHUNK) parts.push(raws.slice(i, i + VERIFY_CHUNK));
      const rs = await Promise.all(parts.map(p => call({ net, raws: p }, 'lo')));
      if (rs.some(r => !r.ok)) throw new Error('aux-pow invalid (parallel verify)');
    },
    /** Match one filter batch against the wallet scripts (HIGH priority — the scan
     *  follower blocks on these; they must not queue behind the verify backlog). */
    async matchBatch(filters, scripts) {
      const r = await call({ kind: 'match', filters, scripts }, 'hi');
      return r.matched;
    },
    close() { for (const w of workers) { try { w.kill(); } catch {} } },
  };
}
