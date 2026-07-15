// dex-ladder.fuzz.mjs — is the pre-signed rung LADDER safe? dex-floatL.fuzz.mjs proved that
// ONE signature valid at EVERY L hands the counterparty an unbounded choice of maker outcomes.
// The ladder is the sanctioned replacement: N SEPARATE signatures at grid heights L0..Ln (each
// committing its own L), bounded by a maker-chosen span, expiring at the last rung. The
// counterparty still chooses — but only among rungs the maker individually signed.
//
// Properties fuzzed here, across random worlds (melting AND growing give assets, k 8..30,
// random grids/spans/prices):
//   1. BOUNDED: holding one fill, the spread of maker outcomes across rung choice never
//      exceeds the total time-value drift of (pay + fill) over the offer's life Hm−H —
//      pay·(1−m_pay(D)) + |fill·m_give(D) − fill| (+ a few kria of truncation slack).
//   2. NOT WORSE THAN FLOATING: the ladder spread is never above the floating-L spread in the
//      same world (it is a strict subset of the same freedom).
//   3. EXPIRY: once the chain passes the ladder's nExpireTime (= the last rung), NO rung
//      materializes — an abandoned offer dies where its signatures end.
// Price/fill-bound integrity per rung is consensus-enforced (bad-txns-ranged-price/-fill-bounds)
// and re-checked in every materialization below.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf, assetPresentValue } from '../../../core/assets.mjs';
import { Nv3State } from '../../../core/nv3chain.mjs';
import { makeRangedBundle, rangedId } from '../../../core/dex.mjs';

const prng = seed => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = prng(0x1adde7);
const ri = n => Math.floor(R() * n);
const rb = v => BigInt(1 + ri(Math.max(1, Number(v))));
const spk = t => '0014' + t.toString(16).padStart(2, '0').repeat(20);
const abs = v => v < 0n ? -v : v;

// honest materialization of one rung at ITS committed L for a chosen fill (rounded-up payout —
// exactly the consensus-minimal payout, i.e. the counterparty's most adversarial legal choice)
const materialize = (st, sub, fill) => {
  const givePv = sub.inputs.reduce((a, op) => a + assetPresentValue(sub.coins[op].value, sub.lockHeight - sub.coins[op].refheight, st.rate(sub.coins[op].assetId, null, null)), 0n);
  const change = givePv - fill;
  if (change < 0n || fill < sub.minFill || fill > sub.maxFill) return null;
  const pay = (fill * sub.payout.priceNum + sub.payout.priceDen - 1n) / sub.payout.priceDen;
  // consensus re-check (mirrors tx_verify.cpp): destinations fixed by construction; price + bounds:
  if (pay * sub.payout.priceDen < fill * sub.payout.priceNum) return null;
  return { ...sub, outputs: [
    { assetId: sub.payout.assetId, value: pay, scriptPubKey: sub.payout.scriptPubKey },
    { assetId: sub.giveAsset, value: change, scriptPubKey: sub.changeScript },
  ] };
};

// real value of the maker's received coins at the mining height (coins stamped refheight = L)
const makerValueAt = (st, sub, Hm) => {
  const [pay, change] = sub.outputs;
  return assetPresentValue(pay.value, Hm - sub.lockHeight, st.rate(pay.assetId, null, null))
       + assetPresentValue(change.value, Hm - sub.lockHeight, st.rate(change.assetId, null, null));
};

let worlds = 0, spreadWorlds = 0, boundViol = 0, floatViol = 0, expiryWorlds = 0, expiryLeaks = 0;
let worstRel = 0;
const VIOL = [];

for (let world = 0; world < 300; world++) {
  const st = new Nv3State();
  const H = 1000;
  const STEP = 5 + ri(16);                       // rung grid step (prod: 10)
  const SPAN = STEP * (2 + ri(12));              // ladder length in blocks
  const expired = R() < 0.15;                    // some worlds: the chain OUTLIVES the ladder
  const Hm = expired ? H + SPAN + 1 + ri(40) : H + 1 + ri(SPAN);
  const giveDef = { k: 8 + ri(23), interest: R() < 0.4, granularity: 1, contractHash: 'b' + world.toString(16).padStart(63, '0') };
  const gid = assetIdOf(giveDef);
  const fund = st.seed('cb', 0, { assetId: FRC, value: 10n ** 12n, refheight: H, scriptPubKey: spk(1) });
  st.apply({ txid: 'iss', lockHeight: H, def: giveDef, inputs: [fund],
    outputs: [{ assetId: gid, value: 1000000n, scriptPubKey: spk(10) }, { assetId: FRC, value: 10n ** 12n - 1000n, scriptPubKey: spk(1) }] });

  const giveCoin = { assetId: gid, value: 1000000n, refheight: H };
  const rateG = st.rate(gid, null, null), rateP = st.rate(FRC, null, null);
  // fill must stay realizable at EVERY rung: under demurrage givePv shrinks toward the last
  // rung, under interest it shrinks toward the first — bound the fill by the smaller end.
  const pvEnds = [assetPresentValue(giveCoin.value, 0, rateG), assetPresentValue(giveCoin.value, SPAN, rateG)];
  const pvMin = pvEnds[0] < pvEnds[1] ? pvEnds[0] : pvEnds[1];
  if (pvMin < 16n) continue;
  const minFill = rb(pvMin / 4n), maxFill = minFill + rb(pvMin - minFill);
  const exp = H + SPAN;                          // prod invariant: nExpireTime = the last rung

  // the LADDER: separate maker signatures (ids) at H and every grid height up to H+SPAN
  const rungHeights = [H];
  for (let Li = Math.floor(H / STEP + 1) * STEP; Li <= H + SPAN; Li += STEP) rungHeights.push(Li);
  const ladder = rungHeights.map(L => makeRangedBundle({
    inputs: [{ outpoint: 'iss:0', coin: giveCoin }],
    payout: { assetId: FRC, scriptPubKey: spk(11), priceNum: rb(5000n), priceDen: 1n },
    changeScript: spk(10), minFill, maxFill, lockHeight: L, nExpireTime: exp,
  }));
  // (one price per world — regenerate rung 0's price into all rungs so the descriptor is uniform)
  const price = ladder[0].payout;
  const rungs = rungHeights.map(L => makeRangedBundle({
    inputs: [{ outpoint: 'iss:0', coin: giveCoin }],
    payout: { ...price }, changeScript: spk(10), minFill, maxFill, lockHeight: L, nExpireTime: exp,
  }));

  // adversary's menu: rungs already reachable (L <= Hm) and unexpired (Hm <= nExpireTime),
  // exactly what consensus admits (IsFinalTx + bad-txns-bundle-expired)
  const usable = rungs.filter(s => s.lockHeight <= Hm && Hm <= s.nExpireTime);
  if (expired) {
    expiryWorlds++;
    if (usable.length !== 0) { expiryLeaks++; VIOL.push(`world ${world}: EXPIRED ladder still usable (${usable.length} rungs)`); }
    continue;
  }
  if (usable.length < 2) continue;

  // hold ONE fill, sweep the adversary's rung choice; every candidate must carry an INTACT id
  const fixFill = minFill + (maxFill - minFill) / 2n;
  let lo = null, hi = null, pay = null, usedLo = null, usedHi = null;
  for (const sub of usable) {
    const cand = materialize(st, sub, fixFill);
    if (!cand) continue;
    if (rangedId(cand) !== rangedId(sub)) continue;      // signature scope intact (always true — id ignores outputs)
    const got = makerValueAt(st, cand, Hm);
    pay = cand.outputs[0].value;
    if (lo === null || got < lo) { lo = got; }
    if (hi === null || got > hi) { hi = got; }
    usedLo = usedLo === null || sub.lockHeight < usedLo ? sub.lockHeight : usedLo;
    usedHi = usedHi === null || sub.lockHeight > usedHi ? sub.lockHeight : usedHi;
  }
  if (lo === null || pay === null || usedHi === usedLo) continue;
  worlds++;
  const spread = hi - lo;
  if (spread > 2n) spreadWorlds++;

  // 1. the analytic bound: the adversary's rung freedom cannot exceed the total time-value
  // drift of (pay + fill) over the offer's whole life D = Hm−H. Provably majorizes the spread
  // for BOTH directions — for growth the naive per-span bound is wrong: m(b+s)−m(b) =
  // m(b)·(m(s)−1), i.e. drift over a span is AMPLIFIED by growth already accrued (this fuzzer
  // caught exactly that on its first run — 11 interest-asset worlds broke the span-only bound).
  const D = Hm - H;
  const payTerm = pay - assetPresentValue(pay, D, rateP);
  const fillTerm = abs(assetPresentValue(fixFill, D, rateG) - fixFill);
  const bound = payTerm + fillTerm + 32n;                // fixed-point truncation slack
  if (spread > bound) {
    boundViol++;
    VIOL.push(`world ${world}: spread ${spread} > bound ${bound} (k=${giveDef.k} ${giveDef.interest ? 'grow' : 'melt'}, D ${D}, pay ${pay}, fill ${fixFill})`);
  }
  const rel = Number(spread) / Math.max(1, Number(pay + fixFill));
  if (rel > worstRel) worstRel = rel;

  // 2. the ladder can never give the adversary MORE than floating L would in the same world
  let flo = null, fhi = null;
  for (let L = H; L <= Hm; L++) {
    const sub = { ...rungs[0], lockHeight: L };
    const cand = materialize(st, sub, fixFill);
    if (!cand) continue;
    const got = makerValueAt(st, cand, Hm);
    if (flo === null || got < flo) flo = got;
    if (fhi === null || got > fhi) fhi = got;
  }
  if (flo !== null && spread > (fhi - flo) + 4n) {
    floatViol++;
    VIOL.push(`world ${world}: ladder spread ${spread} EXCEEDS floating spread ${fhi - flo}`);
  }
}

for (const v of VIOL.slice(0, 8)) console.log('  ' + v);
check(`ladder: enough worlds (${worlds})`, worlds >= 120);
check(`ladder: fuzzer has teeth — rung choice does move the outcome (${spreadWorlds} worlds)`, spreadWorlds >= worlds * 0.3);
console.log(`  worst relative spread across ${worlds} worlds: ${(worstRel * 100).toFixed(3)}% of (pay+fill)`);
check(`ladder: adversary freedom BOUNDED by span melt (0 violations of the analytic bound)`, boundViol === 0, `${boundViol} bound violations`);
check(`ladder: never grants more freedom than floating L (strict subset)`, floatViol === 0, `${floatViol} violations`);
check(`ladder: expired ladders are dead (${expiryWorlds} expiry worlds)`, expiryWorlds >= 20 && expiryLeaks === 0, `${expiryLeaks} leaks of ${expiryWorlds}`);

finish();
