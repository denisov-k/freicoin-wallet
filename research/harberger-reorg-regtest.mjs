// harberger-reorg-regtest.mjs — functional test of the Harberger NAME REGISTRY on the covenant
// regtest daemon: uniqueness enforcement + reorg rollback (the stateful behaviour unit tests can't
// reach). Sign-free (OP_TRUE coinbase funding, legacy v2 txs — see harberger-func-regtest.mjs).
//   1. claim name N → block accepted;
//   2. claim N AGAIN without spending its holder → block REJECTED (bad-txns-harberger-name-taken);
//   3. invalidateblock the block that claimed N → registry rolls back (N released);
//   4. claim N again after the rollback → ACCEPTED (N is free) — proves reorg-safe rollback.
// Run from the wallet repo root: node --import ./apps/web/test/register-aliases.mjs <this file>
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const DATADIR = '/root/cov-regtest';
const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', `-datadir=${DATADIR}`];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const mineAddr = cli('getnewaddress');

const nameHash = sha256(Buffer.from('reorg-name-' + Date.now(), 'utf8')).toString('hex');
const ownerHex = 'bb'.repeat(20), floorV = 1000000, V = 100000000, OP_TRUE = '51';
const hrbgSpk = encodeHarbergerSpk(nameHash, ownerHex, floorV);
const opIn = (txid, vout) => ({ prevout: { txid: rev(txid), vout }, scriptSig: '', sequence: 0xffffffff, witness: [] });

let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

// a fresh OP_TRUE coinbase → maturity → sign-free funding coin (txid, value, height)
function freshCoin() {
  const bh = cliJSON('generateblock', 'raw(51)', '[]').hash;
  const b = cliJSON('getblock', bh);
  cli('generatetoaddress', '100', mineAddr);
  return { txid: b.tx[0], val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8), h: b.height };
}
// build a "claim name N from coin c" tx (HRBG output + OP_TRUE change), mine it; returns {ok,err,hash}
function claim(c) {
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(V), scriptPubKey: hrbgSpk }, { value: BigInt(c.val - V - 10000), scriptPubKey: OP_TRUE }] };
  try { const r = cliJSON('generateblock', mineAddr, JSON.stringify([serializeTx(t)])); return { ok: true, hash: r.hash }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString() }; }
}

// 1. claim N
const r1 = claim(freshCoin());
ok('claim N accepted', r1.ok);
const claimBlock = r1.hash;

// 2. claim N again (duplicate, no spend of the holder) → rejected by uniqueness (name-taken)
const r2 = claim(freshCoin());
ok('duplicate claim of N REJECTED', !r2.ok);
ok('rejection is name-taken', /name-taken/i.test(r2.err || ''));

// 3. invalidate the block that claimed N → the registry must roll back (DisconnectBlock)
cli('invalidateblock', claimBlock);
ok('chain reorged past the claim', cli('getbestblockhash') !== claimBlock);

// 4. after rollback N is FREE again — a fresh claim must now be ACCEPTED
//    (if the registry did NOT roll back, this would fail with name-taken → catches the bug)
const r4 = claim(freshCoin());
ok('claim N ACCEPTED after reorg rollback (registry released N)', r4.ok);
if (!r4.ok) console.log('   err:', (r4.err || '').replace(/\s+/g, ' ').slice(0, 160));

console.log(`\n${pass} checks passed — NameRegistry uniqueness + reorg rollback validated ✅`);
