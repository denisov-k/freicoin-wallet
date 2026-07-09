// rpc.mjs — minimal freicoind JSON-RPC client (Node 18 global fetch, no deps).
import { config, rpcAuth } from './config.mjs';

let idCounter = 0;

/** Call a freicoind RPC method. `path` targets a wallet endpoint, e.g. "/wallet/name".
 *  Throws on RPC error or transport failure. */
export async function rpc(method, params = [], path = '') {
  const res = await fetch(config.rpc.url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: rpcAuth() },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++idCounter, method, params }),
  });
  if (!res.ok && res.status !== 500) {
    throw new Error(`RPC HTTP ${res.status} for ${method}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message} (code ${json.error.code})`);
  return json.result;
}
