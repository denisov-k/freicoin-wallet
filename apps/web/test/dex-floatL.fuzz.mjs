// dex-floatL.fuzz.mjs — does the ranged (2b) descriptor NEED to commit the valuation
// lock_height? The spec says lock_height is MANDATORY in every DEX signature (a 2a mutation
// fuzzer found a real re-valuation hole). This asks the same question for 2b, where — unlike
// 2a — the outputs are MATERIALIZED from L rather than signed. If floating L is safe here, the
// offline-maker problem dissolves; if not, we've reproduced the spec's reason on 2b's own turf.
//
// Model of "L not committed": (a) the maker's id omits lock_height (idNoL), so their signature
// verifies for ANY L; (b) consensus values the give coin at the tx's chosen lock_height (which
// is what tx_verify.cpp does — asset_pv at tx.lock_height); (c) the two REAL consensus bounds
// refheight <= L <= mineHeight are imposed (the C++ enforces them; the JS model does not, so we
// add them here to avoid fake negative-age holes).
//
// HOLE = a matcher-chosen L that passes consensus with the maker's id intact, yet leaves the
// maker STRICTLY worse off (real value at the mining height) than the honest L = mineHeight —
// i.e. the matcher silently pre-ages the maker's own payout/change coins.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf, assetPresentValue } from '../../../core/assets.mjs';
import { Nv3State } from '../../../core/nv3chain.mjs';
import { makeRangedBundle, rangedId, fillRanged } from '../../../core/dex.mjs';

const prng = seed => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = prng(0x2b_10ad);
const ri = n => Math.floor(R() * n);
const rb = v => BigInt(1 + ri(Math.max(1, Number(v))));
const spk = t => '0014' + t.toString(16).padStart(2, '0').repeat(20);

// id WITHOUT the lock_height component — models a signature that does not commit L.
const idNoL = sub => JSON.stringify({
  r: 1, in: [...sub.inputs].sort(),
  pa: [sub.payout.assetId, sub.payout.scriptPubKey, String(sub.payout.priceNum), String(sub.payout.priceDen)],
  cs: sub.changeScript, mn: String(sub.minFill), mx: String(sub.maxFill), exp: sub.nExpireTime ?? 0,
});

// re-materialize the ranged outputs at an arbitrary L (the matcher's freedom under floating L):
// pick the change the matcher WANTS, clamped so the fill stays in the signed [minFill,maxFill].
const materializeAt = (state, sub, L, wantChange) => {
  const givePv = sub.inputs.reduce((a, op) => a + assetPresentValue(sub.coins[op].value, L - sub.coins[op].refheight, state.rate(sub.coins[op].assetId, null, null)), 0n);
  let change = wantChange;
  if (givePv - change > sub.maxFill) change = givePv - sub.maxFill;
  if (givePv - change < sub.minFill) change = givePv - sub.minFill;
  if (change < 0n) change = 0n;
  const fill = givePv - change;
  if (fill < 0n || fill < sub.minFill || fill > sub.maxFill) return null;
  const pay = (fill * sub.payout.priceNum + sub.payout.priceDen - 1n) / sub.payout.priceDen;   // rounded up, honest
  return { ...sub, lockHeight: L, outputs: [
    { assetId: sub.payout.assetId, value: pay, scriptPubKey: sub.payout.scriptPubKey },
    { assetId: sub.giveAsset, value: change, scriptPubKey: sub.changeScript },
  ] };
};

// checkRanged with L FLOATING: value give at the passed lock_height, do NOT require sub.lockHeight==L.
const checkRangedFloat = (state, sub, L) => {
  if (!sub.outputs || sub.outputs.length !== 2) return 'bad shape';
  const [pay, change] = sub.outputs;
  if (pay.assetId !== sub.payout.assetId || pay.scriptPubKey !== sub.payout.scriptPubKey) return 'payout mismatch';
  if (change.assetId !== sub.giveAsset || change.scriptPubKey !== sub.changeScript) return 'change mismatch';
  const givePv = sub.inputs.reduce((a, op) => a + assetPresentValue(sub.coins[op].value, L - sub.coins[op].refheight, state.rate(sub.coins[op].assetId, null, null)), 0n);
  const fill = givePv - change.value;
  if (fill < sub.minFill || fill > sub.maxFill || fill < 0n) return 'fill out of bounds';
  if (pay.value * sub.payout.priceDen < fill * sub.payout.priceNum) return 'below price';
  return null;
};

// real value of the maker's received coins AT the mining height Hm (coins stamped refheight=L)
const makerValueAt = (state, sub, Hm) => {
  const [pay, change] = sub.outputs;
  return assetPresentValue(pay.value, Hm - sub.lockHeight, state.rate(pay.assetId, null, null))
       + assetPresentValue(change.value, Hm - sub.lockHeight, state.rate(change.assetId, null, null));
};

// The unarguable property: a signature must PIN the maker's economic outcome. Under floating
// L we collect, per world, the real value (at Hm) of EVERY consensus-valid variant whose id is
// intact, and measure the spread. A nonzero spread means one signature yields many outcomes —
// the counterparty, not the maker, picks which. That is the security failure, no baseline needed.
let worlds = 0, trials = 0, spreadWorlds = 0, committedSpreadWorlds = 0, worstSpread = 0n;
const SPREADS = [];

for (let world = 0; world < 200; world++) {
  const st = new Nv3State();
  const H = 1000, Hm = H + 1 + ri(60);                 // mined 1..60 blocks after signing
  const giveDef = { k: 8 + ri(23), interest: R() < 0.4, granularity: 1, contractHash: 'a' + world.toString(16).padStart(63, '0') };
  const gid = assetIdOf(giveDef);
  const fund = st.seed('cb', 0, { assetId: FRC, value: 10n ** 12n, refheight: H, scriptPubKey: spk(1) });
  st.apply({ txid: 'iss', lockHeight: H, def: giveDef, inputs: [fund],
    outputs: [{ assetId: gid, value: 1000000n, scriptPubKey: spk(10) }, { assetId: FRC, value: 10n ** 12n - 1000n, scriptPubKey: spk(1) }] });

  const giveCoin = { assetId: gid, value: 1000000n, refheight: H };
  const givePvH = st.presentValueOf(giveCoin, H);
  if (givePvH < 10n) continue;
  const minFill = rb(givePvH / 4n), maxFill = minFill + rb(givePvH - minFill);
  const ranged = makeRangedBundle({
    inputs: [{ outpoint: 'iss:0', coin: giveCoin }],
    payout: { assetId: FRC, scriptPubKey: spk(11), priceNum: rb(5000n), priceDen: 1n },
    changeScript: spk(10), minFill, maxFill, lockHeight: H, nExpireTime: 0,
  });

  // HONEST match at L = Hm: matcher materializes with the maker's expected change (keep = maxFill-slack)
  const honestChange = st.presentValueOf(giveCoin, Hm) > maxFill ? st.presentValueOf(giveCoin, Hm) - maxFill : 0n;
  const honest = materializeAt(st, ranged, Hm, honestChange);
  if (!honest || checkRangedFloat(st, honest, Hm)) continue;
  worlds++;
  const baseId = idNoL(ranged), baseIdCommit = rangedId(ranged);
  void honest;

  // FIX THE FILL, vary only L. The maker consents to any fill in [minFill,maxFill] (that spread
  // is a feature — the taker's choice). What they do NOT consent to is the counterparty choosing
  // the valuation height that pre-ages their coins. So we hold ONE fill and sweep L:
  //   floating L  → every L in [refheight,Hm] materializes THE SAME fill, id intact → many outcomes
  //   committed L → only L == signed passes the id → exactly one outcome
  const fixFill = minFill + (maxFill - minFill) / 2n;   // one representative fill the maker signed for
  let flo = null, fhi = null, clo = null, chi = null;
  for (let L = H; L <= Hm; L++) {
    const givePvL = assetPresentValue(giveCoin.value, L - giveCoin.refheight, st.rate(gid, null, null));
    const change = givePvL - fixFill;
    if (change < 0n) continue;                          // this L can't realize the fixed fill
    const cand = materializeAt(st, ranged, L, change);
    if (!cand || cand.outputs[1].value !== change) continue;
    trials++;
    // floating L: give valued at the chosen L, id without lock_height
    if (checkRangedFloat(st, cand, L) === null && idNoL(cand) === baseId) {
      const got = makerValueAt(st, cand, Hm);
      flo = flo === null || got < flo ? got : flo; fhi = fhi === null || got > fhi ? got : fhi;
    }
    // committed L: only the signed height verifies (real rangedId commits lock_height)
    if (rangedId(cand) === baseIdCommit && checkRangedFloat(st, cand, cand.lockHeight) === null) {
      const got = makerValueAt(st, cand, Hm);
      clo = clo === null || got < clo ? got : clo; chi = chi === null || got > chi ? got : chi;
    }
  }
  if (flo !== null && fhi - flo > 2n) {
    spreadWorlds++;
    if (fhi - flo > worstSpread) worstSpread = fhi - flo;
    SPREADS.push(`world ${world}: ONE fill, ONE signature ⇒ maker value in [${flo}, ${fhi}] as counterparty picks L (spread ${fhi - flo}, ${giveDef.interest ? 'grow' : 'melt'} k=${giveDef.k})`);
  }
  if (clo !== null && chi - clo > 2n) committedSpreadWorlds++;
}

check(`floatL: enough worlds (${worlds})`, worlds >= 60);
check(`floatL: swept enough (L,change) trials (${trials})`, trials >= 2000);
console.log(`  floating L: ${spreadWorlds}/${worlds} worlds where ONE intact signature yields MANY maker outcomes; worst spread ${worstSpread}`);
console.log(`  committed L (current design): ${committedSpreadWorlds}/${worlds} worlds with a spread`);
// The fuzzer has teeth: without L in the signature the outcome is NOT pinned (this must reproduce).
check(`floatL: dropping lock_height from the signature UN-pins the outcome (proves it must stay)`, spreadWorlds >= worlds * 0.5,
  `only ${spreadWorlds} spread — fuzzer may be toothless`);
// The property that matters: the CURRENT design (lock_height committed) pins the maker's outcome.
check(`floatL: committed lock_height PINS the outcome (2b is safe as designed)`, committedSpreadWorlds === 0,
  `${committedSpreadWorlds} worlds leaked under committed L`);

finish();
