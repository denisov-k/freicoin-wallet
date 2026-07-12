// Both snapshots e2e: full first-import sync — filters come from the static file
// (P2P getcfilters only for the tail), balance == node, scan tracks the download.
import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';
import { Neutrino } from './src/net/client.mjs';
const cliM = (...a) => execFileSync('/root/fcbuild-31/bin/freicoin-cli', ['-datadir=/root/fw-mainnet-filter', '-rpcport=18951', ...a]).toString().trim();
const G_M = '000000005b1e3d23ecfd2dd4a6e1a35238aa0392c0a8528c40df52376d7efe2c';
const spkM = '0014016c1b5d358a3c63b8645cabc0be15f719615a6c';
let pass = true; const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ('+x+')' : ''}`); if (!ok) pass = false; };

(async () => {
  const scan = JSON.parse(cliM('scantxoutset', 'start', '["addr(fc1qq9kpkhf43g7x8wrytj4up0s47uvkzknvxa3lkn)"]'));
  const n = new Neutrino({ url: 'ws://127.0.0.1:3041', net: 'main', genesis: G_M,
    snapshotUrl: 'http://127.0.0.1:3050/main-headers.bin',
    filterSnapshotUrl: 'http://127.0.0.1:3050/main-filters.bin' });
  await n.connect();
  let p2pFilterReqs = 0;
  const os = n._send.bind(n);
  n._send = (cmd, pl) => { if (cmd === 'getcfilters') p2pFilterReqs++; return os(cmd, pl); };
  let partials = 0;
  const t0 = Date.now();
  const r = await n.syncWallet([spkM], { onPartial: () => partials++ });
  const dt = (Date.now() - t0) / 1000;
  n.close();
  const truth = BigInt(Math.round(scan.total_amount * 1e8));
  console.log(`full import, both snapshots: ${dt.toFixed(1)}s, ${partials} partials, p2p getcfilters (main conn): ${p2pFilterReqs}`);
  check('balance == scantxoutset', r.balance === truth, `${r.balance} vs ${truth}`);
  check('filters came from the file (few P2P reqs on main conn)', p2pFilterReqs <= 3, `${p2pFilterReqs} (full P2P would be ~486)`);
  check('fully verified', n.verifiedHeight === r.tipHeight);
  check('partials streamed', partials > 20, `${partials}`);
  console.log(pass ? '\nALL PASS ✅' : '\nFAILED ❌');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
