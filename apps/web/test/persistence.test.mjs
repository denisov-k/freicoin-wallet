// IndexedDB persistence tests (fake-indexeddb) against the live fw-bdev regtest node.
//   1. round-trip: loadInto restores chain+scannedHeight+UTXOs with NO network
//   2. resume: a reloaded client syncs only NEW blocks, balance == fresh full sync
//   3. scriptsKey mismatch (different wallet) → store cleared, no false resume
//   4. reorg: persisted headers truncate; reloaded state matches a fresh full sync
import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';
import { Neutrino } from '../src/net/client.mjs';
import { IdbStore } from '../src/store-idb.mjs';
import { walletScripts, deriveAddress } from '../src/wallet.mjs';
import { configureNetwork } from '../src/wallet.mjs';
configureNetwork('regtest');   // the app default is mainnet now

const URL = 'ws://127.0.0.1:3040', NET = 'regtest';
const GENESIS = '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8';
const CLI = ['-regtest', '-datadir=/root/fw-bdev', '-rpcport=19560'];
const cli = (...a) => execFileSync('/root/fcbuild-31/bin/freicoin-cli', [...CLI, ...a]).toString().trim();
const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const scripts = walletScripts(SEED);
const addr = deriveAddress(SEED, 0);
const skey = (() => { let h = 5381 >>> 0; const s = scripts.join(''); for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return scripts.length + ':' + h.toString(16); })();

let pass = true; const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ('+x+')' : ''}`); if (!ok) pass = false; };
const freshFull = async () => { const c = new Neutrino({ url: URL, net: NET, genesis: GENESIS }); await c.connect(); const r = await c.syncWallet(scripts); c.close(); return r; };

(async () => {
  cli('generatetoaddress', '2', addr);

  // --- 1+2. persist, then resume in a fresh client ---
  const s1 = new IdbStore(NET, GENESIS); await s1.open();
  const c1 = new Neutrino({ url: URL, net: NET, genesis: GENESIS }); await c1.connect();
  const r1 = await c1.syncWallet(scripts); await s1.save(c1, skey); c1.close();
  const T = r1.tipHeight;
  console.log(`initial sync: tip=${T} bal=${r1.balance} utxos=${r1.utxos.length}, persistedTip=${s1.persistedTip}`);

  // fresh client loads persisted state WITHOUT any network
  const s2 = new IdbStore(NET, GENESIS); await s2.open();
  const c2 = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  const loaded = await s2.loadInto(c2, skey);
  check('loadInto resumed (no network)', loaded && c2.chain.length === T + 1, `chain=${c2.chain.length} want ${T+1}`);
  check('resumed scannedHeight', c2.scannedHeight === c1.scannedHeight, `${c2.scannedHeight}`);
  check('resumed UTXO set', c2.utxos.size === r1.utxos.length, `${c2.utxos.size} want ${r1.utxos.length}`);

  // mine one more, then the resumed client should fetch only the NEW block
  cli('generatetoaddress', '1', addr);
  let fetched = 0; const of = c2.fetchBlocks.bind(c2); c2.fetchBlocks = async (h) => { fetched += h.length; return of(h); };
  await c2.connect(); const r2 = await c2.syncWallet(scripts); await s2.save(c2, skey); c2.close();
  const truth = await freshFull();
  check('resumed sync == fresh full sync', r2.balance.toString() === truth.balance.toString(), `${r2.balance} vs ${truth.balance}`);
  check('resume fetched only the new block(s), not the whole chain', fetched <= 2, `fetched ${fetched} blocks for 1 new`);
  check('persistedTip advanced to new tip', s2.persistedTip === r2.tipHeight);

  // --- 3. scriptsKey mismatch ---
  const s3 = new IdbStore(NET, GENESIS); await s3.open();
  const c3 = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  const loaded3 = await s3.loadInto(c3, 'different-wallet-key');
  check('different wallet → no resume + store cleared', loaded3 === false && c3.chain.length === 1);

  // --- 4. reorg persistence ---
  // re-persist current chain, then reorg the node and reload
  const s4 = new IdbStore(NET, GENESIS); await s4.open();
  const c4 = new Neutrino({ url: URL, net: NET, genesis: GENESIS }); await c4.connect();
  await c4.syncWallet(scripts); await s4.save(c4, skey); c4.close();
  const tipBefore = s4.persistedTip;
  const forkHash = cli('getblockhash', String(tipBefore - 1));
  cli('invalidateblock', forkHash); cli('generatetoaddress', '3', 'ff'.repeat(0) || deriveAddress('ff'.repeat(32), 0));
  const c5 = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await s4.loadInto(c5, skey);                     // resume the pre-reorg chain
  await c5.connect(); const r5 = await c5.syncWallet(scripts); await s4.save(c5, skey); c5.close();
  const truth5 = await freshFull();
  check('post-reorg resumed sync == fresh full', r5.balance.toString() === truth5.balance.toString(), `${r5.balance} vs ${truth5.balance}`);
  check('persisted headers truncated to new tip', s4.persistedTip === r5.tipHeight, `persistedTip ${s4.persistedTip} tip ${r5.tipHeight}`);
  // reload once more to prove the store holds the reorged chain (not the orphaned one)
  const s6 = new IdbStore(NET, GENESIS); await s6.open();
  const c6 = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await s6.loadInto(c6, skey);
  check('reloaded chain == reorged tip', c6.chain.length === r5.tipHeight + 1 && c6.utxos.size === truth5.utxos.length);

  console.log(pass ? '\nALL PASS ✅' : '\nFAILED ❌');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
