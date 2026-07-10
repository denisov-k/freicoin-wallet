// Mainnet end-to-end (SKIPPED when the mainnet infra is unreachable): a full first
// import over both snapshots must equal the node's scantxoutset, stream partials,
// and verify every PoW.
import 'fake-indexeddb/auto';
import { ENV, check, finish, cliM, mainnetAvailable, makeWorkerClient } from './helpers.mjs';
if (!mainnetAvailable()) { console.log('SKIP: mainnet infra unreachable'); process.exit(0); }
const spk = '0014016c1b5d358a3c63b8645cabc0be15f719615a6c';   // the dominant miner (heavy history)
const scan = JSON.parse(cliM('scantxoutset', 'start', '["addr(fc1qq9kpkhf43g7x8wrytj4up0s47uvkzknvxa3lkn)"]'));
const c = await makeWorkerClient();
const t0 = Date.now();
await c.call('init', { url: ENV.MAIN_BRIDGE, net: 'main', genesis: ENV.MAIN_GENESIS, scripts: [spk],
  snapshotUrl: `${ENV.SNAP}/main-headers.bin`, filterSnapshotUrl: `${ENV.SNAP}/main-filters.bin` });
const fin = await c.call('balance');
console.log(`full import: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${c.partials.length} partials`);
check('balance == scantxoutset', fin.balance.toFixed(8) === scan.total_amount.toFixed(8), `${fin.balance} vs ${scan.total_amount}`);
check('partials streamed during the sweep', c.partials.length > 10, `${c.partials.length}`);
check('verify phase ran', c.events.some(p => p.phase === 'verify'));
await c.call('close');
finish();
