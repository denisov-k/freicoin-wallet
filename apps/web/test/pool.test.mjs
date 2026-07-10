// Multi-peer (NeutrinoPool) tests against the live fw-bdev regtest node + bridge.
//   1. filter-hash equality: sha256d(cfilter) == the node's cfheaders filter_hash (no false disputes)
//   2. honest pool == single-peer full sync, zero disputes
//   3. a single tampered peer CAN hide a payment (shows the defense is needed)
//   4. a tampered PRIMARY cannot hide a payment when a secondary is honest:
//        4a coherent liar (also fakes its cfheader) -> caught by cross-peer disagreement
//        4b incoherent liar (honest cfheader, dishonest filter) -> caught by consistency check
import { execFileSync } from 'node:child_process';
import { Neutrino, NeutrinoPool } from '../src/net/client.mjs';
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
const FAKE = 'de'.repeat(32);

const bal = r => r.balance.toString();
let pass = true; const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ('+extra+')' : ''}`); if (!ok) pass = false; };

// Wrap a peer to HIDE the payment at height H from its filter (and optionally its cfheader).
function makeLiar(peer, H, alsoCfheader) {
  const of = peer.filtersWithHashes.bind(peer);
  peer.filtersWithHashes = async (s, from = 1) => {
    const r = await of(s, from);
    for (const e of r) if (e.height === H) { e.matched = false; e.filterHash = FAKE; }
    return r;
  };
  if (alsoCfheader) {
    const og = peer.getCFHeaders.bind(peer);
    peer.getCFHeaders = async (from = 1) => { const a = await og(from); const i = H - from; if (i >= 0 && i < a.length) a[i] = FAKE; return a; };
  }
}

(async () => {
  // Fund the wallet with two fresh blocks; the last is our "payment" block H.
  cli('generatetoaddress', '2', addr);
  const H = Number(cli('getblockcount'));
  console.log('payment block H =', H, ' addr', addr);

  // --- 1. filter-hash equality (honest single peer) ---
  const probe = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await probe.connect(); await probe.syncHeaders();
  const cfh = await probe.getCFHeaders(1);
  const fwh = await probe.filtersWithHashes(scripts, 1);
  let eqAll = true, mism = 0;
  for (const f of fwh) if (cfh[f.height - 1] !== f.filterHash) { eqAll = false; mism++; }
  check('sha256d(cfilter) == node cfheaders filter_hash', eqAll, `${fwh.length} heights, ${mism} mismatch`);
  const hasPayment = fwh.some(f => f.height === H && f.matched);
  check('honest filter matches our payment block H', hasPayment);
  probe.close();

  // --- 2. honest pool == single-peer ---
  const single = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await single.connect(); const rs = await single.syncWallet(scripts); single.close();

  const honestPool = new NeutrinoPool({ urls: [URL, URL], net: NET, genesis: GENESIS });
  await honestPool.connect(); const rp = await honestPool.syncWallet(scripts); honestPool.close();
  check('honest pool balance == single-peer', bal(rp) === bal(rs), `pool ${bal(rp)} vs single ${bal(rs)}`);
  check('honest pool: zero disputes, no forced-extra beyond matches', rp.agreement.disputed === 0, JSON.stringify(rp.agreement));

  // --- 3. a single tampered peer hides the payment (defense is needed) ---
  const badSingle = new Neutrino({ url: URL, net: NET, genesis: GENESIS });
  await badSingle.connect(); await badSingle.syncHeaders();
  // patch matchFilters to drop block H (the single-peer path uses matchFilters)
  badSingle._dl = null;   // single-connection so the patched matchFilters is the one used
  const omf = badSingle.matchFilters.bind(badSingle);
  badSingle.matchFilters = async (s, from = 1) => (await omf(s, from)).filter(h => badSingle.chain.heightOf(h) !== H);
  const rbad = await badSingle.syncWallet(scripts); badSingle.close();
  check('single tampered peer HIDES funds (balance lower)', BigInt(bal(rbad)) < BigInt(bal(rs)), `hidden ${bal(rbad)} < true ${bal(rs)}`);

  // --- 4a. coherent liar as primary, honest secondary -> caught by disagreement ---
  const pool4a = new NeutrinoPool({ urls: [URL, URL], net: NET, genesis: GENESIS });
  await pool4a.connect(); await Promise.all(pool4a.peers.map(p => p.syncHeaders()));
  makeLiar(pool4a.primary, H, true);
  const r4a = await pool4a.syncWallet(scripts); pool4a.close();
  check('4a coherent lying primary cannot hide (balance correct)', bal(r4a) === bal(rs), `${bal(r4a)} vs ${bal(rs)} agr=${JSON.stringify(r4a.agreement)}`);

  // --- 4b. incoherent liar (honest cfheader, dishonest filter) -> caught by consistency check ---
  const pool4b = new NeutrinoPool({ urls: [URL, URL], net: NET, genesis: GENESIS });
  await pool4b.connect(); await Promise.all(pool4b.peers.map(p => p.syncHeaders()));
  makeLiar(pool4b.primary, H, false);
  const r4b = await pool4b.syncWallet(scripts); pool4b.close();
  check('4b incoherent lying primary cannot hide (balance correct)', bal(r4b) === bal(rs), `${bal(r4b)} vs ${bal(rs)} agr=${JSON.stringify(r4b.agreement)}`);

  console.log(pass ? '\nALL PASS ✅' : '\nFAILED ❌');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
