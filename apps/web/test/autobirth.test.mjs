// Auto birth: learned from the first completed scan (first-activity height + a verified
// anchor ~100 below); a post-eviction rescan windowed from it matches the full scan.
import 'fake-indexeddb/auto';
import { ENV, SEED, check, finish } from './helpers.mjs';
import { createLightSource } from '../src/light.mjs';
import { walletScripts, configureNetwork } from '../src/wallet.mjs';
configureNetwork('regtest');
const scripts = walletScripts(SEED);
const mk = extra => createLightSource({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, scripts, ...extra });
const a = mk({});
const r1 = await a.utxos(); a.close();
check('birthAuto learned (first activity)', r1.birthAuto > 1 && r1.birthAuto <= r1.tipHeight, `birth ${r1.birthAuto}`);
check('birth anchor has height+hash', r1.birthAnchor && /^[0-9a-f]{64}$/.test(r1.birthAnchor.hash), `anchor ${r1.birthAnchor?.height}`);
await new Promise((res, rej) => { const d = indexedDB.deleteDatabase(`fw-light-regtest-${ENV.REG_GENESIS.slice(0, 12)}`); d.onsuccess = res; d.onerror = () => rej(d.error); });
const b = mk({ birthHeight: r1.birthAuto, checkpoint: r1.birthAnchor });
const r2 = await b.utxos(); b.close();
check('anchored rescan == full scan balance', r2.balance === r1.balance, `${r2.balance}`);
finish();
