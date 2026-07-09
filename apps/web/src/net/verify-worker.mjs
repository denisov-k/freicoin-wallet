// verify-worker.mjs — aux-pow verification worker. Header PoW checks are independent
// per header, so the client fans batches out to a pool of these workers instead of
// verifying ~197k merged-mining proofs on one thread (the dominant first-sync CPU cost).
// Message in: {id, net, raws: Uint8Array[]} (full header bytes: 80-byte base + dummy +
// flags + AuxProofOfWork); reply: {id, ok, badIndex}.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
import { parseAuxPow, checkAuxPoW } from './auxpow.mjs';
import { filterMatchesAny } from './bip158.mjs';

export function verifyRaws(net, raws) {
  for (let i = 0; i < raws.length; i++) {
    const raw = Buffer.from(raws[i]);
    try {
      const { aux } = parseAuxPow(raw, 82);
      if (!checkAuxPoW({ prev: raw.subarray(4, 36), time: raw.readUInt32LE(68) }, aux, net === 'main' ? 'main' : net))
        return { ok: false, badIndex: i };
    } catch { return { ok: false, badIndex: i }; }
  }
  return { ok: true };
}

/** GCS filter matching for a batch — pure CPU, so it parallelizes the same way. */
export function matchBatch(filters, scripts) {
  const matched = [];
  for (const { h, f } of filters) if (filterMatchesAny(Buffer.from(f), h, scripts)) matched.push(h);
  return matched;
}

const handler = (msg, post) => {
  if (msg.kind === 'match') { post({ id: msg.id, matched: matchBatch(msg.filters, msg.scripts) }); return; }
  const r = verifyRaws(msg.net, msg.raws); post({ id: msg.id, ...r });
};

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  // browser (nested) worker
  self.onmessage = e => handler(e.data, m => self.postMessage(m));
} else if (typeof process !== 'undefined' && process.versions?.node) {
  // node worker_threads (tests)
  import(/* @vite-ignore */ 'node:worker_threads').then(({ parentPort }) => {
    parentPort?.on('message', m => handler(m, r => parentPort.postMessage(r)));
  }).catch(() => {});
}
