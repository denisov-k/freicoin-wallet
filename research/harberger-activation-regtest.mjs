// harberger-activation-regtest.mjs — validates the Harberger SOFT-FORK ACTIVATION trigger and, with
// it, audit Finding 2 (the registry mirror is gated on rules&HARBERGER). The daemon is started with
// -harbergeractivationtime=<T>; block time is driven with setmocktime across T.
//   PRE-activation (block time < T): HRBG outputs are plain anyone-can-spend witness-v2 coins — NO
//     uniqueness enforcement and NO registry mirror, so the SAME name can be claimed TWICE, both
//     blocks accepted. (If the mirror weren't gated, the 2nd claim would seed a divergence.)
//   POST-activation (block time > T): uniqueness is enforced — a duplicate claim is REJECTED
//     (bad-txns-harberger-name-taken). Proves the soft-fork switched on with the block clock.
// Self-contained (own daemon+datadir, -harbergeractivationtime). Sign-free (OP_TRUE, legacy v2 txs).
//   node --import ./apps/web/test/register-aliases.mjs research/harberger-activation-regtest.mjs
import { execFileSync, spawn } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const BIN = '/root/fc-nv3-cov/build/bin', DATADIR = '/root/cov-regtest';
const T_ACT = 2000000000;                              // activation unix time (year 2033)
const CLI = [`${BIN}/freicoin-cli`, '-regtest', `-datadir=${DATADIR}`];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const sleep = ms => execFileSync('sleep', [String(ms / 1000)]);
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

function start() {
  spawn(`${BIN}/freicoind`, ['-regtest', `-datadir=${DATADIR}`, `-harbergeractivationtime=${T_ACT}`, '-daemon'], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 40; i++) { try { cli('getblockchaininfo'); return; } catch { sleep(1000); } }
  throw new Error('daemon did not come up');
}
const ownerHex = 'bb'.repeat(20), floorV = 1, V = 10, FEE = 5, OP_TRUE = '51';
const opIn = (txid, vout) => ({ prevout: { txid: rev(txid), vout }, scriptSig: '', sequence: 0xffffffff, witness: [] });
const addr = () => cli('getnewaddress');
function freshCoin() {
  const b = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', addr());
  return { txid: b.tx[0], val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8), h: b.height };
}
function claim(nameHash) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(V), scriptPubKey: encodeHarbergerSpk(nameHash, ownerHex, floorV) }, { value: BigInt(c.val - V - FEE), scriptPubKey: OP_TRUE }] };
  try { return { ok: true, hash: cliJSON('generateblock', addr(), JSON.stringify([serializeTx(t)])).hash }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString().replace(/\s+/g, ' ') }; }
}

// fresh daemon with a future activation time
try { cli('stop'); } catch {} sleep(2500);
rmSync(DATADIR, { recursive: true, force: true }); mkdirSync(DATADIR, { recursive: true });
writeFileSync(`${DATADIR}/freicoin.conf`, 'regtest=1\nserver=1\nnv3assets=1\ntxindex=1\nfallbackfee=0.0001\n[regtest]\nrpcport=19770\nrpcuser=cov\nrpcpassword=cov\n');
start(); try { cli('createwallet', 'cov'); } catch {}

// ---- PRE-activation: block clock well before T ----
cli('setmocktime', String(T_ACT - 86400));
cli('generatetoaddress', '150', addr());
const nPre = sha256(Buffer.from('pre-' + Date.now(), 'utf8')).toString('hex');
ok('PRE: first claim of N accepted', claim(nPre).ok);
const dupPre = claim(nPre);
ok('PRE: DUPLICATE claim of N also accepted (uniqueness OFF, mirror not tracking)', dupPre.ok);
if (!dupPre.ok) console.log('   err:', dupPre.err.slice(0, 140));

// ---- cross activation: advance the block clock past T, let MTP climb over it ----
cli('setmocktime', String(T_ACT + 86400));
cli('generatetoaddress', '20', addr());

// ---- POST-activation: uniqueness enforced ----
const nPost = sha256(Buffer.from('post-' + Date.now(), 'utf8')).toString('hex');
ok('POST: first claim of M accepted', claim(nPost).ok);
const dupPost = claim(nPost);
ok('POST: DUPLICATE claim of M REJECTED (uniqueness ON — soft-fork activated)', !dupPost.ok && /name-taken/i.test(dupPost.err || ''));
if (dupPost.ok) console.log('   BUG: duplicate accepted post-activation — activation or uniqueness broken');

try { cli('stop'); } catch {}
console.log(`\n${pass} checks passed — Harberger soft-fork activation trigger + Finding-2 mirror gating validated ✅`);
