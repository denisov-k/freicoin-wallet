// Interrupting the VERIFY TAIL must not lose progress: the store checkpoints on every
// verification batch, so the persisted chain includes the verified-so-far prefix.
// Mainnet-gated (needs the aux-pow era + snapshots).
import 'fake-indexeddb/auto';
import { ENV, check, finish, mainnetAvailable, makeWorkerClient } from './helpers.mjs';
import { Neutrino } from '../src/services/light/net/client.mjs';
import { IdbStore } from '../src/services/light/store-idb.mjs';
if (!mainnetAvailable()) { console.log('SKIP: mainnet infra unreachable'); process.exit(0); }

const spk = '0014' + 'ab'.repeat(20);
const c = await makeWorkerClient();
let doneAtClose = null;
const origPush = c.events.push.bind(c.events);
c.events.push = p => {   // intercept progress: close mid-verify, capture the baseline THEN
  if (p.phase === 'verify' && doneAtClose === null && p.done > 100000) {
    doneAtClose = p.done;
    c.call('close').catch(() => {});
  }
  return origPush(p);
};
await c.call('init', { url: ENV.MAIN_BRIDGE, net: 'main', genesis: ENV.MAIN_GENESIS, scripts: [spk],
  snapshotUrl: `${ENV.SNAP}/main-headers.bin` });
await c.call('balance').catch(() => {});
check('interrupted mid-verify', doneAtClose > 0, `closed at ${doneAtClose} verified aux proofs`);

const n = new Neutrino({ url: 'ws://127.0.0.1:9', net: 'main', genesis: ENV.MAIN_GENESIS });
const st = new IdbStore('main', ENV.MAIN_GENESIS);
await st.open();
const skey = (() => { let h = 5381 >>> 0; const s = spk; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return '1:' + h.toString(16); })();
const ok = await st.loadInto(n, skey);
const persistedTip = n.chain.length - 1;
const expectedMin = 288287 + doneAtClose - 8000;   // native prefix + verified-at-close aux, minus a couple of batches
check('persisted tip covers the verified-so-far prefix', ok && persistedTip >= expectedMin, `${persistedTip} ≥ ${expectedMin}`);
finish();
