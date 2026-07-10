// Reorg test: sync, then force the node to orphan our tail (invalidateblock +
// mine a different branch), re-sync incrementally, and confirm the client rolls
// back the orphaned UTXOs and matches a fresh full-sync client.
import { execFileSync } from 'node:child_process';
import { Neutrino } from '../src/net/client.mjs';
import { walletScripts, deriveAddress } from '../src/wallet.mjs';
import { configureNetwork } from '../src/wallet.mjs';
configureNetwork('regtest');   // the app default is mainnet now

const URL = 'ws://127.0.0.1:3040', NET = 'regtest';
const GENESIS = '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8';
const CLI = ['-regtest', '-datadir=/root/fw-bdev', '-rpcport=19560'];
const cli = (...a) => execFileSync('/root/fcbuild-31/bin/freicoin-cli', [...CLI, ...a]).toString().trim();

const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const scripts = walletScripts(SEED);
const mine = deriveAddress(SEED, 0);
// A throwaway address we do NOT own (mine the new branch here so our tail is orphaned).
const other = deriveAddress('ff'.repeat(32), 0);

const norm = r => ({ tipHeight: r.tipHeight, balance: r.balance.toString(),
  utxos: r.utxos.map(u => `${u.txid}:${u.vout}@${u.refheight}`).sort() });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const tip = Number(cli('getblockcount'));
  console.log('tip before reorg test:', tip);

  const inc = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await inc.connect();
  const a = norm(await inc.syncWallet(scripts));
  console.log(`pre-reorg : tip=${a.tipHeight} bal=${a.balance} utxos=${a.utxos.length}`);

  // Orphan the last 2 blocks (mined to us) by invalidating block tip-1, then build a
  // longer branch on a foreign address.
  const forkHash = cli('getblockhash', String(tip - 1));   // orphan tip-1 and tip
  cli('invalidateblock', forkHash);
  cli('generatetoaddress', '3', other);                    // new branch, none ours
  const newTip = Number(cli('getblockcount'));
  console.log(`reorg done: invalidated @${tip-1}, new tip=${newTip} (branch not ours)`);

  const b = norm(await inc.syncWallet(scripts));
  console.log(`post-reorg: tip=${b.tipHeight} bal=${b.balance} utxos=${b.utxos.length}`);
  inc.close();

  // Ground truth: fresh full sync of the new chain.
  const full = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await full.connect();
  const f = norm(await full.syncWallet(scripts));
  full.close();
  console.log(`full fresh: tip=${f.tipHeight} bal=${f.balance} utxos=${f.utxos.length}`);

  const rolledBack = b.utxos.length < a.utxos.length;
  const matchesFull = eq(b, f);
  console.log('\n=== RESULTS ===');
  console.log('reorg rolled back orphaned UTXOs      :', rolledBack ? 'PASS' : 'FAIL');
  console.log('incremental post-reorg == full fresh  :', matchesFull ? 'PASS' : 'FAIL');
  console.log(rolledBack && matchesFull ? '\nALL PASS ✅' : '\nFAILED ❌');
  process.exit(rolledBack && matchesFull ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
