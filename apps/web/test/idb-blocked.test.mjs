// A zombie connection holding the DB at an older version must not freeze the wallet:
// open() times out / handles onblocked and the sync proceeds without persistence.
import 'fake-indexeddb/auto';
import { ENV, SEED, check, finish } from './helpers.mjs';
import { IdbStore } from '../src/store-idb.mjs';
import { createLightSource } from '../src/light.mjs';
import { walletScripts, configureNetwork } from '../src/wallet.mjs';
configureNetwork('regtest');
await new Promise((res, rej) => {   // zombie at v1, never closed, no onversionchange
  const r = indexedDB.open(`fw-light-regtest-${ENV.REG_GENESIS.slice(0, 12)}`, 1);
  r.onupgradeneeded = () => {}; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const t0 = Date.now();
const st = new IdbStore('regtest', ENV.REG_GENESIS);
check('blocked open returns false instead of hanging', await st.open() === false && Date.now() - t0 < 6000, `${Date.now() - t0}ms`);
const src = createLightSource({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, scripts: walletScripts(SEED) });
const b = await src.balance();
check('wallet still syncs without persistence', b.balance > 0, `${b.balance}`);
src.close();
finish();
