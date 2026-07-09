// Validate coinselect.mjs against golden vectors + algorithmic self-tests. NO node.
//   node coinselect.parity.mjs
import { readFileSync } from 'fs';
import { presentValueAt, minLockHeight, estimateVsize, selectCoins } from '../coinselect.mjs';

let ok = 0, fail = 0, firstfail = null;
const check = (cond, label, extra) => {
  if (cond) ok++;
  else { fail++; if (!firstfail) firstfail = { label, ...extra }; }
};

// --- 1. present-value parity against the consensus reference -----------------
const cases = JSON.parse(readFileSync('./coinselect_vectors.json', 'utf8'));
for (const c of cases) {
  const utxos = c.utxos.map(u => ({ value: BigInt(u.value), refheight: u.refheight }));
  // per-coin present value must match time_adjust_value_forward bit-for-bit
  utxos.forEach((u, i) => {
    const got = presentValueAt(u, c.lockheight);
    check(got === BigInt(c.per_coin_pv[i]), 'per_coin_pv',
      { i, got: got.toString(), want: c.per_coin_pv[i] });
  });
  // summed inputs present value must match
  const total = utxos.reduce((s, u) => s + presentValueAt(u, c.lockheight), 0n);
  check(total === BigInt(c.inputs_present_value), 'inputs_present_value',
    { got: total.toString(), want: c.inputs_present_value });
}

// --- 2. monotonicity guard: lock_height < refheight must throw ---------------
try { presentValueAt({ value: 100n, refheight: 10 }, 5); check(false, 'monotonic_should_throw'); }
catch { check(true, 'monotonic_throws'); }
check(minLockHeight([{ refheight: 3 }, { refheight: 9 }, { refheight: 5 }]) === 9, 'minLockHeight');

// --- 3. selection covers the target, honours lock_height, balances the ledger -
const COIN = 100000000n;
const rand = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(99);
for (let t = 0; t < 200; t++) {
  const n = 3 + Math.floor(rand() * 10);
  const utxos = Array.from({ length: n }, () => ({
    value: BigInt(1 + Math.floor(rand() * 100)) * COIN / 10n,
    refheight: Math.floor(rand() * 100000),
  }));
  const lockHeight = minLockHeight(utxos) + Math.floor(rand() * 20000);
  const feerate = BigInt(1 + Math.floor(rand() * 50));
  const totalPV = utxos.reduce((s, u) => s + presentValueAt(u, lockHeight), 0n);
  const target = totalPV / 3n;                       // always fundable
  if (target <= 0n) continue;
  let r;
  try { r = selectCoins(utxos, target, feerate, lockHeight); }
  catch (e) { check(false, 'select_threw', { msg: e.message }); continue; }

  // 3a. selected inputs' present value covers target + fee exactly (ledger identity)
  const selPV = r.selected.reduce((s, u) => s + presentValueAt(u, lockHeight), 0n);
  check(selPV === r.inputsPresentValue, 'selPV_matches', { t });
  check(r.inputsPresentValue === target + r.fee + r.change, 'ledger_identity',
    { t, lhs: r.inputsPresentValue.toString(), rhs: (target + r.fee + r.change).toString() });
  // 3b. every selected coin's refheight <= tx lock_height (consensus monotonicity)
  check(r.selected.every(u => u.refheight <= r.lockHeight), 'lockheight_monotonic', { t });
  // 3c. fee is positive and change non-negative
  check(r.fee > 0n && r.change >= 0n, 'fee_change_sign', { t, fee: r.fee.toString() });
}

// --- 4. insufficient funds throws --------------------------------------------
try { selectCoins([{ value: COIN, refheight: 0 }], 1000n * COIN, 1n, 100); check(false, 'insufficient_should_throw'); }
catch { check(true, 'insufficient_throws'); }

// --- 5. vsize sanity: adding an input increases vsize; Freicoin +4 vs no-lockheight
check(estimateVsize(2, 2) > estimateVsize(1, 2), 'vsize_grows_with_input');

console.log(`coinselect parity+logic: ${ok}/${ok + fail} checks pass`);
if (firstfail) { console.log('FIRST FAIL:', JSON.stringify(firstfail)); process.exit(1); }
