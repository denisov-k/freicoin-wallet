// worker.mjs — the neutrino light client running in a Web Worker, off the main thread.
// Mainnet header verification is ~20s of pure CPU (485k headers, aux-pow each); on the
// main thread that freezes the page. The worker owns the network + scan + persistence
// (WebSocket, IndexedDB and @noble all work in workers); the main thread keeps the KEYS
// and only sends watch scripts in and signed raw txs out — the seed never enters the
// worker. Protocol: {id, method, params} in; {id, result|error} out; unsolicited
// {type:'progress', p} events stream sync progress.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
import { createLightSource } from './light.mjs';

let src = null;

/** Handle one protocol message. Exported so the protocol is testable outside a browser. */
export async function handle(msg, post) {
  const { id, method, params } = msg;
  try {
    let result = null;
    if (method === 'init') {
      src?.close();
      src = createLightSource({ ...params, onProgress: p => post({ type: 'progress', p }) });
    } else if (method === 'close') {
      src?.close(); src = null;
    } else if (!src) {
      throw new Error('not initialized');
    } else if (method === 'broadcast') {
      result = await src.broadcast(params);
    } else {
      result = await src[method]();          // health | balance | utxos | history | refresh
    }
    post({ id, result });
  } catch (e) {
    post({ id, error: e?.message || String(e) });
  }
}

// Browser worker glue (self exists, window doesn't — skipped in node tests).
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = e => handle(e.data, m => self.postMessage(m));
}
