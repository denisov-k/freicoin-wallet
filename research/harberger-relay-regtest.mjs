// harberger-relay-regtest.mjs — RELAY standardness + mempool enforcement for the Harberger covenant
// (docs spec §Осталось). A HRBG covenant output is an anyone-can-spend UNKNOWN-witness-version
// program. Making forced buys broadcastable means relaxing two STANDARD-policy rejections for the
// HRBG format (AreInputsStandard's WITNESS_UNKNOWN reject, and the DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM
// script flag). But relaxing relay WITHOUT also enforcing the covenant at the mempool would let an
// INVALID forced buy (spends a HRBG input, doesn't pay the owner) sit in the mempool and poison block
// production (a block containing it fails harberger-unpaid at connect). So the mempool now enforces the
// HARBERGER ruleset. This test proves that safety property end-to-end (sign-free — HRBG/unknown inputs
// are anyone-can-spend):
//   1. an INVALID forced buy (bare HRBG spend) is REJECTED by sendrawtransaction with harberger-unpaid
//      — it reached CheckTxInputs (past output/version checks) and the mempool enforced the covenant;
//   2. a spend of a GENERIC unknown-witness output is REJECTED with nonstandard-inputs — the relay
//      exemption is NARROW to the HRBG format (the general witness-version reservation is intact);
//   3. after both rejections the mempool is clean, so generateblock still works — no DoS.
//   node --import ./apps/web/test/register-aliases.mjs research/harberger-relay-regtest.mjs
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const addr = () => cli('getnewaddress');
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

const opIn = (txid, vout) => ({ prevout: { txid: rev(txid), vout }, scriptSig: '', sequence: 0xffffffff, witness: [] });
const OP_TRUE = '51', p2wpkh = '0014' + 'ee'.repeat(20), V = 100000000, FEE = 200000;

function freshCoin() {                                   // matured OP_TRUE coinbase (sign-free funding)
  const b = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', addr());
  return { txid: b.tx[0], h: b.height, val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8) };
}
// create a CONFIRMED anyone-can-spend output with scriptPubKey `spk` (value V) via a regular tx
function coinWith(spk) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(V), scriptPubKey: spk }, { value: BigInt(c.val - V - 10000), scriptPubKey: OP_TRUE }] };
  return { txid: cliJSON('getblock', cliJSON('generateblock', addr(), JSON.stringify([serializeTx(t)])).hash).tx[1] };
}
// try to RELAY a bare spend of that output (no owner payout, no successor) to a standard output
function relaySpend(coin) {
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: cliJSON('getblockcount'),
    vin: [opIn(coin.txid, 0)], vout: [{ value: BigInt(V - FEE), scriptPubKey: p2wpkh }] };
  try { return { ok: true, txid: cli('sendrawtransaction', serializeTx(t)) }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString().replace(/\s+/g, ' ') }; }
}

// 1. invalid forced buy (bare HRBG spend) → rejected by the covenant rules at the mempool
const nameHash = sha256(Buffer.from('relay-' + Date.now(), 'utf8')).toString('hex');
const rHrbg = relaySpend(coinWith(encodeHarbergerSpk(nameHash, 'bb'.repeat(20), 1000000)));
ok('invalid forced buy REJECTED at the mempool', !rHrbg.ok);
ok('rejection is harberger-unpaid (reached CheckTxInputs — covenant enforced at relay)', /harberger-unpaid/i.test(rHrbg.err || ''));
if (rHrbg.ok) console.log('   BUG: invalid forced buy entered the mempool — would poison block production');

// 2. generic unknown-witness output (OP_1 + 32-byte push, no OP_3 suffix) → rejected as nonstandard input
const rUnknown = relaySpend(coinWith('51' + '20' + '77'.repeat(32)));
ok('spend of a generic unknown-witness input REJECTED (exemption is narrow to HRBG)', !rUnknown.ok);
ok('rejection is nonstandard-inputs (not exempted, unlike HRBG)', /nonstandard-inputs/i.test(rUnknown.err || ''));
if (!/nonstandard-inputs/i.test(rUnknown.err || '')) console.log('   got:', (rUnknown.err || '').slice(0, 120));

// 3. mempool stayed clean → block production is not poisoned
ok('mempool is empty after the rejections', cliJSON('getrawmempool').length === 0);
ok('generateblock still works (no forced-buy DoS)', !!cliJSON('generateblock', addr(), '[]').hash);

console.log(`\n${pass} checks passed — forced-buy relay + mempool enforcement (no DoS, narrow exemption) ✅`);
