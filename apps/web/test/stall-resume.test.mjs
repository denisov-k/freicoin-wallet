// Snapshot stall watchdog + HTTP Range resume: a request that hangs mid-stream resumes
// from the stall offset; a server that always hangs falls back to pure P2P.
import 'fake-indexeddb/auto';
import http from 'node:http';
import { ENV, SEED, check, finish } from './helpers.mjs';
import { Neutrino } from '../src/services/light/net/client.mjs';
import { encodeMessage } from '../src/services/light/net/p2p.mjs';
import { walletScripts, configureNetwork } from '../src/services/wallet.mjs';
configureNetwork('regtest');
const scripts = walletScripts(SEED);
// build a regtest headers snapshot in-process
const cap = [];
const gen = new Neutrino({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS });
const oon = gen.on.bind(gen);
gen.on = (cmd, fn) => oon(cmd, m => { if (cmd === 'headers' && m.payload.length > 1) cap.push(encodeMessage('regtest', 'headers', m.payload)); fn(m); });
await gen.connect(); await gen.syncHeaders(); gen.close();
const snap = Buffer.concat(cap);
let firstHangs = true, ranges = 0;
const srv = http.createServer((req, res) => {
  const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!range && firstHangs) { res.writeHead(200); res.write(snap.subarray(0, Math.min(20000, snap.length >> 1))); return; }   // hang
  const start = range ? parseInt(range[1], 10) : 0;
  if (range) ranges++;
  res.writeHead(range ? 206 : 200); res.end(snap.subarray(start));
});
await new Promise(r => srv.listen(3779, r));
const n = new Neutrino({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, snapshotUrl: 'http://127.0.0.1:3779/s.bin' });
await n.connect();
const r = await n.syncWallet(scripts);
check('sync completed despite the stalled first request', r.tipHeight >= gen.chain.length - 1, `tip ${r.tipHeight}`);
check('resumed via Range from the stall offset', ranges >= 1, `${ranges} range request(s)`);
n.close();
const srv2 = http.createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.writeHead(200); res.write(snap.subarray(0, 9000)); });
await new Promise(r2 => srv2.listen(3780, r2));
const n2 = new Neutrino({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, snapshotUrl: 'http://127.0.0.1:3780/s.bin' });
await n2.connect();
const r2 = await n2.syncWallet(scripts);
check('always-stalling snapshot → P2P fallback completes', r2.balance === r.balance, `${r2.balance}`);
n2.close(); srv.close(); srv2.close();
finish();
