// harberger-verifydb-regtest.mjs — regression for the VerifyDB name-registry split bug (audit
// 2026-07-24, Finding 1). VerifyDB runs on every startup and dry-runs DisconnectBlock (default
// checklevel=3 / checkblocks=6) against a throwaway coins view. DisconnectBlock mutates
// m_name_registry directly with no internal RAII rollback, so unless the VerifyDB registry guard
// snapshots/restores m_name_registry too, a normal restart leaves the registry rolled back ~6
// blocks behind the tip: names claimed in the last 6 blocks look FREE, the node accepts a duplicate
// claim that every synced peer rejects (bad-txns-harberger-name-taken) => chain split.
//   1. claim name N, keep it within the last 6 blocks;
//   2. STOP + START the daemon (VerifyDB dry-runs DisconnectBlock at startup);
//   3. a duplicate claim of N must be REJECTED (name-taken) — proving the registry survived VerifyDB.
// Self-contained: manages its own daemon + datadir. Sign-free (OP_TRUE funding, legacy v2 txs).
//   node --import ./apps/web/test/register-aliases.mjs research/harberger-verifydb-regtest.mjs
import { execFileSync, spawn } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const BIN = '/root/fc-nv3-cov/build/bin';
const DATADIR = '/root/cov-regtest';
const CLI = [`${BIN}/freicoin-cli`, '-regtest', `-datadir=${DATADIR}`];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const sleep = ms => execFileSync('sleep', [String(ms / 1000)]);
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

function start() {
  spawn(`${BIN}/freicoind`, ['-regtest', `-datadir=${DATADIR}`, '-daemon'], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 40; i++) { try { cli('getblockchaininfo'); return; } catch { sleep(1000); } }
  throw new Error('daemon did not come up');
}
function stop() { try { cli('stop'); } catch {} sleep(2500); }

const ownerHex = 'bb'.repeat(20), floorV = 1, V = 10, FEE = 5, OP_TRUE = '51';
const opIn = (txid, vout) => ({ prevout: { txid: rev(txid), vout }, scriptSig: '', sequence: 0xffffffff, witness: [] });
const mineAddr = () => cli('getnewaddress');
function freshCoin() {
  const b = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', mineAddr());
  return { txid: b.tx[0], val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8), h: b.height };
}
function claim(nameHash) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(V), scriptPubKey: encodeHarbergerSpk(nameHash, ownerHex, floorV) }, { value: BigInt(c.val - V - FEE), scriptPubKey: OP_TRUE }] };
  try { return { ok: true, hash: cliJSON('generateblock', mineAddr(), JSON.stringify([serializeTx(t)])).hash }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString().replace(/\s+/g, ' ') }; }
}

// fresh datadir + daemon
stop(); rmSync(DATADIR, { recursive: true, force: true }); mkdirSync(DATADIR, { recursive: true });
writeFileSync(`${DATADIR}/freicoin.conf`, 'regtest=1\nserver=1\nnv3assets=1\ntxindex=1\nfallbackfee=0.0001\n[regtest]\nrpcport=19770\nrpcuser=cov\nrpcpassword=cov\n');
start(); try { cli('createwallet', 'cov'); } catch {}
cli('generatetoaddress', '200', mineAddr());

// 1. claim N, keep within the last 6 blocks (so VerifyDB's default 6-block disconnect covers it)
const nameHash = sha256(Buffer.from('verifydb-' + Date.now(), 'utf8')).toString('hex');
ok('claim N accepted', claim(nameHash).ok);
cli('generatetoaddress', '2', mineAddr());
const tipBefore = cliJSON('getblockchaininfo').blocks;

// 2. restart → VerifyDB dry-runs DisconnectBlock over the last 6 blocks at startup
stop(); start(); try { cli('loadwallet', 'cov'); } catch {}
ok('chain tip unchanged across restart', cliJSON('getblockchaininfo').blocks === tipBefore);

// 3. a duplicate claim of N must still be rejected — registry survived VerifyDB
const dup = claim(nameHash);
ok('duplicate claim of N REJECTED after VerifyDB restart', !dup.ok);
ok('rejection is name-taken (registry intact, no split)', /name-taken/i.test(dup.err || ''));
if (dup.ok) console.log('   SPLIT BUG: node accepted a uniqueness-violating block after restart');

stop();
console.log(`\n${pass} checks passed — VerifyDB no longer corrupts the name registry (split bug closed) ✅`);
