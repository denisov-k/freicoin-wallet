// preview(): instant last-known state with NO network after a completed scan; null for a
// fresh wallet (scannedOnce gate — a headers-only checkpoint must not masquerade as 0).
import 'fake-indexeddb/auto';
import { ENV, SEED, check, finish, makeWorkerClient } from './helpers.mjs';
import { walletScripts, configureNetwork } from '../src/services/wallet.mjs';
configureNetwork('regtest');
const scripts = walletScripts(SEED);
const a = await makeWorkerClient();
await a.call('init', { url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, scripts });
const fresh = await a.call('balance');
await a.call('close');
const b = await makeWorkerClient();
await b.call('init', { url: 'ws://127.0.0.1:9', net: 'regtest', genesis: ENV.REG_GENESIS, scripts });   // dead bridge
const t0 = Date.now();
const pv = await b.call('preview');
check('preview = last state, no network', pv && pv.balance === fresh.balance, `${pv?.balance} in ${Date.now() - t0}ms (dead bridge)`);
check('preview marked stale', pv?.stale === true);
const failed = await b.call('balance').then(() => false, () => true);
check('real sync against dead bridge fails (preview was network-free)', failed);
await b.call('close');
const c = await makeWorkerClient();
const otherScripts = walletScripts('ff'.repeat(32));   // a DIFFERENT wallet (birth is not part of the fingerprint)
await c.call('init', { url: 'ws://127.0.0.1:9', net: 'regtest', genesis: ENV.REG_GENESIS, scripts: otherScripts });
check('preview null when nothing persisted for this wallet', await c.call('preview') === null);
await c.call('close');
finish();
