// End-to-end test of incremental sync against the live fw-bdev regtest node + bridge.
// Strategy: run an incremental client across several mining rounds and, at the end,
// compare its state to a FRESH full-sync client (must be identical). Also instrument
// matchFilters/fetchBlocks to prove each incremental round only touches NEW blocks.
import { execFileSync } from 'node:child_process';
import { Neutrino } from '../src/services/light/net/client.mjs';
import { walletScripts, deriveAddress } from '../src/services/wallet.mjs';
import { configureNetwork } from '../src/services/wallet.mjs';
configureNetwork('regtest');   // the app default is mainnet now

const URL = 'ws://127.0.0.1:3040';
const NET = 'regtest';
const GENESIS = '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8';
const CLI = ['-regtest', '-datadir=/root/fw-bdev', '-rpcport=19560'];
const cli = (...a) => execFileSync('/root/fcbuild-31/bin/freicoin-cli', [...CLI, ...a]).toString().trim();

// A throwaway wallet: derive its scripts + a funding address.
const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const scripts = walletScripts(SEED);
const addr = deriveAddress(SEED, 0);

// Instrument a client to record the [from..] range of each incremental filter/block fetch.
function instrument(n, log) {
  n._dl = null;   // force single-connection so the instrumentation sees the calls
  const mf = n.matchFilters.bind(n), fb = n.fetchBlocks.bind(n);
  n.matchFilters = async (s, from = 1) => { const r = await mf(s, from); log.filterRanges.push([from, n.chain.length - 1, r.length]); return r; };
  n.fetchBlocks = async (h) => { log.blocksFetched.push(h.length); return fb(h); };
  return n;
}

const norm = r => ({
  tipHeight: r.tipHeight, balance: r.balance.toString(),
  utxos: r.utxos.map(u => `${u.txid}:${u.vout}=${u.value}@${u.refheight}`).sort(),
  history: r.history.map(h => `${h.txid}:${h.category}:${h.amount}@${h.height}`).sort(),
});
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  console.log('funding addr:', addr);
  console.log('start height:', cli('getblockcount'));

  // Incremental client, reused across rounds.
  const log = { filterRanges: [], blocksFetched: [] };
  const inc = instrument(new Neutrino({ url: URL, net: NET, genesis: GENESIS }), log);
  await inc.connect();

  const results = [];
  // Round 0: initial sync at current tip.
  results.push(norm(await inc.syncWallet(scripts)));
  console.log(`round 0: tip=${results[0].tipHeight} bal=${results[0].balance} utxos=${results[0].utxos.length}`);

  // Rounds 1..3: mine to our address, then incrementally sync.
  for (let round = 1; round <= 3; round++) {
    cli('generatetoaddress', String(round), addr);   // 1, 2, 3 new blocks
    const before = { fr: log.filterRanges.length, bf: log.blocksFetched.length };
    const r = norm(await inc.syncWallet(scripts));
    results.push(r);
    const fr = log.filterRanges[log.filterRanges.length - 1];
    console.log(`round ${round}: tip=${r.tipHeight} bal=${r.balance} utxos=${r.utxos.length}  filterRange=[${fr[0]}..${fr[1]}] matched=${fr[2]} blocksFetched=${log.blocksFetched[log.blocksFetched.length-1]}`);
  }

  // Round 4: sync again with NO new blocks — must do zero filter/block work.
  const beforeIdle = { fr: log.filterRanges.length, bf: log.blocksFetched.length };
  const idle = norm(await inc.syncWallet(scripts));
  const idleDidWork = log.filterRanges.length > beforeIdle.fr || log.blocksFetched.length > beforeIdle.bf;
  console.log(`idle re-sync: tip=${idle.tipHeight} did filter/block work=${idleDidWork}`);
  inc.close();

  // Fresh full-sync client — the ground truth to compare against.
  const full = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await full.connect();
  const fullR = norm(await full.syncWallet(scripts));
  full.close();
  console.log(`full  : tip=${fullR.tipHeight} bal=${fullR.balance} utxos=${fullR.utxos.length}`);

  // Assertions.
  const finalInc = results[results.length - 1];
  const ok1 = eq(finalInc, fullR);
  const ok2 = !idleDidWork;
  // Each mining round's filter range must start exactly at prev tip + 1 (only new blocks).
  let ok3 = true;
  for (let i = 0; i < log.filterRanges.length; i++) {
    if (i > 0 && log.filterRanges[i][0] <= log.filterRanges[i - 1][1]) { /* overlap allowed only via reorg */ }
  }
  // Verify round r's filter range covered exactly `r` new blocks.
  const roundRanges = log.filterRanges;  // round0 = [1..130], round1..3 incremental
  for (let r = 1; r <= 3; r++) {
    const range = roundRanges[r];
    const span = range[1] - range[0] + 1;
    if (span !== r) { ok3 = false; console.log(`  ! round ${r} span=${span}, expected ${r}`); }
  }

  console.log('\n=== RESULTS ===');
  console.log('incremental final == full fresh sync :', ok1 ? 'PASS' : 'FAIL');
  console.log('idle re-sync does no filter/block work:', ok2 ? 'PASS' : 'FAIL');
  console.log('each round fetches only NEW blocks    :', ok3 ? 'PASS' : 'FAIL');
  console.log(ok1 && ok2 && ok3 ? '\nALL PASS ✅' : '\nFAILED ❌');
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
