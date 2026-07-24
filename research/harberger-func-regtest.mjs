// harberger-func.mjs — functional test of Harberger path-A on the covenant regtest daemon.
// Sign-free: funds from an OP_TRUE (anyone-can-spend) coinbase, so no wallet signing is needed —
// the HRBG inputs are anyone-can-spend too (witness v2). Validates the 3 committed consensus
// increments END-TO-END in real freicoind (block-connect + coin serialization + generateblock
// enforcement), which the CheckTxInputs unit tests don't cover.
//   1. create a HRBG deposit output; 2. VALID forced buy → block accepted;
//   3. INVALID forced buy (no payout) → block REJECTED (bad-txns-harberger-unpaid).
// Run from the wallet repo root: node --import ./apps/web/test/register-aliases.mjs <this file>
import { execFileSync } from 'node:child_process';
import { serializeTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const mineAddr = cli('getnewaddress');

// ---- name / owner / deposit ----
const nameHash = sha256(Buffer.from('covtest-alice', 'utf8')).toString('hex');
const ownerHex = 'bb'.repeat(20), buyerHex = 'cc'.repeat(20);
const floorV = 1000000, V = 100000000;                 // 0.01 FRC floor, 1 FRC deposit
const ownerSpk = '0014' + ownerHex;
const OP_TRUE = '51';
const hrbgSpk = encodeHarbergerSpk(nameHash, ownerHex, floorV);
const succSpk = encodeHarbergerSpk(nameHash, buyerHex, floorV);
const opIn = (txid, vout) => ({ prevout: { txid: rev(txid), vout }, scriptSig: '', sequence: 0xffffffff, witness: [] });

// fresh OP_TRUE coinbase → mature it → sign-free funding at refheight = its block height
const cbBlockHash = cliJSON('generateblock', 'raw(51)', '[]').hash;
const cbHeight = cliJSON('getblock', cbBlockHash).height;
const cbTxid = cliJSON('getblock', cbBlockHash).tx[0];
cli('generatetoaddress', '100', mineAddr);                                        // maturity
const cbVal = Math.round(cliJSON('gettxout', cbTxid, '0').value * 1e8);
const LH = cbHeight;                                                              // all txs at distance 0

let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

// mine a raw tx directly into a block (block-validation path = active rules). Returns {ok,err,txid}
function mineRaw(txObj) {
  const hex = serializeTx(txObj);
  try { const r = cliJSON('generateblock', mineAddr, JSON.stringify([hex])); return { ok: true, txid: r.txid?.[0] ?? cbTxid, hash: r.hash }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString() }; }
}
const tx = (vin, vout) => ({ version: 2, hasWitness: false, nLockTime: 0, lockHeight: LH, vin, vout });

// ---------- 1. create the HRBG deposit output (from the OP_TRUE coinbase) ----------
const t1 = tx([opIn(cbTxid, 0)], [
  { value: BigInt(V), scriptPubKey: hrbgSpk },
  { value: BigInt(cbVal - V - 10000), scriptPubKey: OP_TRUE },      // change to OP_TRUE, fee 10000
]);
const r1 = mineRaw(t1);
ok('HRBG create tx mined', r1.ok); if (!r1.ok) console.log('  ', r1.err.slice(0, 200));
const createTxid = cliJSON('getblock', r1.hash).tx.find(x => x !== cbTxid && x !== cliJSON('getblock', r1.hash).tx[0]) || cliJSON('getblock', r1.hash).tx[1];
const utxo = cliJSON('gettxout', createTxid, '0');
ok('HRBG output in UTXO set with our spk', utxo && utxo.scriptPubKey.hex === hrbgSpk);
ok('HRBG output is host FRC (value=deposit)', Math.round(utxo.value * 1e8) === V);
const changeTxid = createTxid, changeVout = 1;   // the OP_TRUE change

// ---------- 2. VALID forced buy ----------
const t2 = tx([opIn(createTxid, 0), opIn(changeTxid, changeVout)], [
  { value: BigInt(V), scriptPubKey: ownerSpk },                    // (1) pay V to owner
  { value: BigInt(V), scriptPubKey: succSpk },                     // (2) successor HRBG
  { value: BigInt(cbVal - V - V - 20000), scriptPubKey: OP_TRUE }, // change
]);
const r2 = mineRaw(t2);
ok('valid forced buy accepted by block validation', r2.ok); if (!r2.ok) console.log('  ', r2.err.slice(0, 200));

// ---------- 3. INVALID forced buy (no payout) → block rejected ----------
// make a fresh HRBG + OP_TRUE change to spend
const cb2h = cliJSON('generateblock', 'raw(51)', '[]').hash;
const cb2 = cliJSON('getblock', cb2h);
cli('generatetoaddress', '100', mineAddr);
const cb2Val = Math.round(cliJSON('gettxout', cb2.tx[0], '0').value * 1e8);
const LH2 = cb2.height;
const tx2b = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: LH2,
  vin: [opIn(cb2.tx[0], 0)], vout: [{ value: BigInt(V), scriptPubKey: hrbgSpk }, { value: BigInt(cb2Val - V - 10000), scriptPubKey: OP_TRUE }] };
const r1b = mineRaw(tx2b);
ok('second HRBG create mined', r1b.ok);
const hb = cliJSON('getblock', r1b.hash);
const hrbg2 = hb.tx.find((x, i) => i > 0);
const t3 = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: LH2,
  vin: [opIn(hrbg2, 0)], vout: [{ value: BigInt(V - 10000), scriptPubKey: OP_TRUE }] };  // NO payout, NO successor
const r3 = mineRaw(t3);
ok('invalid forced buy (no payout) REJECTED', !r3.ok);
ok('rejection cites the Harberger rule', /harberger/i.test(r3.err || ''));
if (!r3.ok) console.log('   reject:', (r3.err || '').replace(/\s+/g, ' ').slice(0, 180));

console.log(`\n${pass} checks passed — path-A validated on the real regtest daemon ✅`);
