// server.mjs — thin REST backend for the Freicoin wallet (variant C).
// Pure Node http, no dependencies. The client owns the keys and signs locally;
// this backend derives addresses, reports present-value balance/UTXOs, and relays
// signed transactions through freicoind.
//
//   FW_ACCOUNT_XPUB=<xpub> FW_RPC_COOKIE=<datadir>/regtest/.cookie \
//   FW_RPC_URL=http://127.0.0.1:19445 node server.mjs
import { createServer } from 'http';
import { config } from './config.mjs';
import { deriveAddress, scan, broadcast, txStatus, history } from './wallet.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), ...CORS });
  res.end(s);
};
const readBody = req => new Promise((ok, err) => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => ok(b)); req.on('error', err);
});

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/health') {
      return json(res, 200, { ok: true, network: config.network });
    }
    if (req.method === 'GET' && p === '/address') {
      const index = parseInt(url.searchParams.get('index') || '0', 10);
      const chain = parseInt(url.searchParams.get('chain') || '0', 10);
      return json(res, 200, { index, chain, address: await deriveAddress(index, chain) });
    }
    if (req.method === 'GET' && p === '/balance') {
      const { balance, tipHeight } = await scan();
      return json(res, 200, { balance, tipHeight, unit: 'present-value' });
    }
    if (req.method === 'GET' && p === '/utxos') {
      return json(res, 200, await scan());
    }
    if (req.method === 'GET' && p === '/history') {
      return json(res, 200, { txs: await history() });
    }
    if (req.method === 'POST' && p === '/broadcast') {
      const { rawtx } = JSON.parse((await readBody(req)) || '{}');
      if (!rawtx) return json(res, 400, { error: 'missing rawtx' });
      return json(res, 200, { txid: await broadcast(rawtx) });
    }
    const m = p.match(/^\/tx\/([0-9a-fA-F]{64})$/);
    if (req.method === 'GET' && m) {
      return json(res, 200, await txStatus(m[1]));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(config.port, () => {
  console.log(`freicoin-wallet backend on :${config.port} (${config.network}) -> ${config.rpc.url}`);
});
