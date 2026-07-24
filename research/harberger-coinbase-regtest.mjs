// harberger-coinbase-regtest.mjs — audit-fix regression: a coinbase must NOT be able to create a
// Harberger covenant. The coinbase skips CheckTxInputs (deposit/forced-buy/uniqueness) and the
// registry mirror, so a coinbase HRBG output would be an unregistered free name claim. ConnectBlock
// must reject such a block (bad-cb-harberger-output). generateblock's first arg is the coinbase
// output script, so `raw(<hrbgSpk>)` mines exactly that block.
//   1. a normal coinbase (raw(51)) is still accepted (no regression);
//   2. a coinbase paying to a HRBG script is REJECTED (bad-cb-harberger-output).
// Run: node --import ./apps/web/test/register-aliases.mjs research/harberger-coinbase-regtest.mjs
import { execFileSync } from 'node:child_process';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

const nameHash = sha256(Buffer.from('cb-' + Date.now(), 'utf8')).toString('hex');
const hrbgSpk = encodeHarbergerSpk(nameHash, 'bb'.repeat(20), 1000000);

// 1. a normal OP_TRUE coinbase is accepted (regression guard for the new coinbase check)
let normalOk = false;
try { cliJSON('generateblock', 'raw(51)', '[]'); normalOk = true; } catch (e) { console.log('   ', (e.stderr || e.message || '').slice(0, 160)); }
ok('normal coinbase still accepted', normalOk);

// 2. a coinbase whose output IS a HRBG covenant must be rejected
let rejected = false, reason = '';
try { cliJSON('generateblock', `raw(${hrbgSpk})`, '[]'); }
catch (e) { rejected = true; reason = (e.stderr || e.message || '').toString(); }
ok('coinbase HRBG output REJECTED', rejected);
ok('rejection is bad-cb-harberger-output', /bad-cb-harberger-output/i.test(reason));
if (!/bad-cb-harberger-output/i.test(reason)) console.log('   got:', reason.replace(/\s+/g, ' ').slice(0, 160));

console.log(`\n${pass} checks passed — coinbase covenant-bypass closed ✅`);
