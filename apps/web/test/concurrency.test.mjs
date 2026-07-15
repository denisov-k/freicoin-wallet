// Concurrent tab calls (balance+history+utxos) must share one sync — they used to
// interleave two syncWallet runs and deadlock both.
import 'fake-indexeddb/auto';
import { ENV, SEED, check, finish, makeWorkerClient } from './helpers.mjs';
import { walletScripts, configureNetwork } from '../src/services/wallet.mjs';
configureNetwork('regtest');
const c = await makeWorkerClient();
await c.call('init', { url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, scripts: walletScripts(SEED) });
const t = setTimeout(() => { console.log('HUNG'); process.exit(1); }, 90000);
const [b, h, u] = await Promise.all([c.call('balance'), c.call('history'), c.call('utxos')]);
clearTimeout(t);
check('concurrent balance/history/utxos all resolve', b.balance > 0 && h.txs.length > 0 && u.utxos.length > 0,
  `${b.balance} / ${h.txs.length} txs / ${u.utxos.length} utxos`);
await c.call('close');
finish();
