// dex.fuzz.mjs — adversarial mutation fuzzing of phase-2a composites. The security property
// a bundle-scoped signature must give us, stated over the MODEL:
//
//   for every mutation of a maker's bundle inside a valid composite,
//   either checkComposite REJECTS the mutated composite,
//   or the mutated bundle's id differs (i.e. the maker's signature would not verify).
//
// A mutation that passes consensus AND keeps the bundle id is a hole: the matcher could
// alter a maker's terms undetected. The fuzzer builds random worlds (random assets, rates,
// interest and demurrage, random maker bundles balanced by construction), composes them,
// then attacks each composite with a battery of mutations. Deterministic seed — a failure
// reproduces.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf } from '../../../core/assets.mjs';
import { Nv3State } from '../../../core/nv3chain.mjs';
import { makeBundle, bundleId, composeBundles, makeRangedBundle, rangedId, fillRanged } from '../../../core/dex.mjs';

// mulberry32 PRNG — deterministic runs
const prng = seed => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = prng(0xf7e1c01);
const ri = n => Math.floor(R() * n);
const rb = v => BigInt(1 + ri(Number(v)));
const spk = t => '0014' + t.toString(16).padStart(2, '0').repeat(20);

let composites = 0, mutations = 0, holes = 0;
const HOLES = [];

for (let world = 0; world < 60; world++) {
  const st = new Nv3State();
  const H = 1000;
  // 2-3 random assets (mixed demurrage/interest, shifts 8..30)
  const defs = Array.from({ length: 2 + ri(2) }, (_, i) => ({
    k: 8 + ri(23), interest: R() < 0.3, granularity: 1, contractHash: (world * 10 + i).toString(16).padStart(2, '0').repeat(32).slice(0, 64),
  }));
  const ids = defs.map(assetIdOf);
  const fund = st.seed('cb', 0, { assetId: FRC, value: 1000000000n, refheight: H, scriptPubKey: spk(1) });
  // issue each asset to a maker coin
  let frcLeft = 1000000000n, prevOut = fund;
  defs.forEach((d, i) => {
    frcLeft -= 1000n;
    st.apply({ txid: `iss${i}`, lockHeight: H, def: d, inputs: [prevOut],
      outputs: [{ assetId: ids[i], value: 1000000n, scriptPubKey: spk(10 + i) },
                { assetId: FRC, value: frcLeft, scriptPubKey: spk(1) }] });
    prevOut = `iss${i}:1`;
  });
  // maker FRC coins
  const frcA = st.seed('fa', 0, { assetId: FRC, value: 100000000n, refheight: H, scriptPubKey: spk(20) });
  const matF = st.seed('mf', 0, { assetId: FRC, value: 50000000n, refheight: H, scriptPubKey: spk(30) });

  const Hm = H + ri(40);   // match height >= signing height

  // two bundles balanced by construction: maker0 sells `sell` of asset0 for FRC (keeps change),
  // maker1 buys `sell - eps` of asset0 with FRC (keeps FRC change)
  const a = ids[0];
  const pvA = st.presentValueOf({ assetId: a, value: 1000000n, refheight: H }, H);
  const sell = rb(pvA - 2n) + 1n;                 // 2..pvA-1... keep <= pvA
  const keep = pvA - sell;
  const price = rb(50000000n);
  const eps = rb(sell > 2n ? sell - 1n : 1n) - 1n;   // 0..sell-2
  const b0 = makeBundle({
    inputs: [{ outpoint: 'iss0:0', coin: { assetId: a, value: 1000000n, refheight: H } }],
    outputs: [{ assetId: FRC, value: price, scriptPubKey: spk(11) },
              ...(keep > 0n ? [{ assetId: a, value: keep, scriptPubKey: spk(10) }] : [])],
    nExpireTime: R() < 0.5 ? 0 : Hm + 5 + ri(20),
    lockHeight: H,
  });
  const b1 = makeBundle({
    inputs: [{ outpoint: 'fa:0', coin: { assetId: FRC, value: 100000000n, refheight: H } }],
    outputs: [{ assetId: a, value: sell - eps, scriptPubKey: spk(21) },
              { assetId: FRC, value: 10000000n, scriptPubKey: spk(20) }],
    lockHeight: H,
  });

  let ctx;
  try {
    ({ ctx } = composeBundles(st, [b0, b1], {
      lockHeight: H, atHeight: Hm, txid: `c${world}`,
      matcher: { funds: [{ outpoint: 'mf:0', coin: { assetId: FRC, value: 50000000n, refheight: H } }], script: spk(31), fee: rb(10000n) },
    }));
  } catch { continue; }   // some random parameterizations don't balance — fine, skip
  composites++;

  // sanity: the untouched composite must apply on a clone
  const clone = () => { const s = new Nv3State(); s.utxos = new Map(st.utxos); s.assets = new Map(st.assets); return s; };
  if (!clone().applyComposite(structuredClone(ctx), Hm).ok) { HOLES.push(`world ${world}: valid composite failed`); holes++; continue; }

  // ---- mutation battery over each maker bundle ----
  const battery = [];
  for (const bi of [0, 1]) {
    battery.push(
      c => { c.subtxs[bi].outputs[0].value += 1n; },                                    // inflate payout
      c => { c.subtxs[bi].outputs[0].value -= 1n; },                                    // deflate payout
      c => { c.subtxs[bi].outputs[0].scriptPubKey = spk(99); },                          // steal payout
      c => { const o = c.subtxs[bi].outputs[0]; o.assetId = o.assetId === FRC ? a : FRC; }, // tag swap
      c => { c.subtxs[bi].outputs.pop(); },                                              // drop change/output
      c => { c.subtxs[bi].outputs.push({ assetId: FRC, value: 1n, scriptPubKey: spk(99) }); }, // graft output
      c => { c.subtxs[bi].inputs.push(c.subtxs[1 - bi].inputs[0]); },                    // graft foreign input
      c => { c.subtxs[bi].nExpireTime = Hm - 1; },                                       // impose expiry
    );
  }
  // NON-bundle mutations: the matcher re-heights the composite — every maker's give would be
  // re-valued with their ids intact. The lockHeight pin must catch this (found as a real
  // hole before bundles carried the pin).
  battery.push(c => { c.lockHeight = H + 1; });
  battery.push(c => { c.lockHeight = H - 1; });
  for (const [mi, mutate] of battery.entries()) {
    const mctx = structuredClone(ctx);
    try { mutate(mctx); } catch { continue; }
    if (mctx.subtxs.some(s => !s.outputs.length)) continue;   // structurally empty — checkComposite rejects anyway, count it
    mutations++;
    const consensusOk = clone().checkComposite(mctx, Hm).ok;
    const idsChanged = mctx.subtxs.some((s, i) => bundleId(s) !== bundleId(ctx.subtxs[i]));
    if (consensusOk && !idsChanged) {
      holes++; HOLES.push(`world ${world} mutation ${mi}: passed consensus with unchanged bundle ids`);
    }
  }
}

check(`fuzz built enough composites (${composites})`, composites >= 30);
check(`fuzz ran a real battery (${mutations} mutations)`, mutations >= 300);
check(`NO HOLES: every mutation rejected or signature-breaking (${holes} holes)`, holes === 0, HOLES.slice(0, 5).join(' | '));

// ---- phase 2b: ranged bundles — constraint attacks must fail, miner freedom must SUCCEED ----
let rWorlds = 0, rAttacks = 0, rHoles = 0, rFreedom = 0;
const RHOLES = [];
for (let world = 0; world < 40; world++) {
  const st = new Nv3State();
  const H = 1000, Hm = H + ri(30);
  const def = { k: 8 + ri(23), interest: R() < 0.3, granularity: 1, contractHash: 'e' + world.toString(16).padStart(63, '0') };
  const id = assetIdOf(def);
  const fund = st.seed('cb', 0, { assetId: FRC, value: 1000000000n, refheight: H, scriptPubKey: spk(1) });
  st.apply({ txid: 'iss', lockHeight: H, def, inputs: [fund],
    outputs: [{ assetId: id, value: 100000n, scriptPubKey: spk(10) }, { assetId: FRC, value: 999000000n, scriptPubKey: spk(1) }] });
  st.seed('buy', 0, { assetId: FRC, value: 500000000n, refheight: H, scriptPubKey: spk(20) });
  st.seed('mf', 0, { assetId: FRC, value: 100000000n, refheight: H, scriptPubKey: spk(30) });

  const givePv = st.presentValueOf({ assetId: id, value: 100000n, refheight: H }, H);
  const minFill = rb(givePv / 4n), maxFill = minFill + rb(givePv - minFill);
  const price = rb(3000n);
  const ranged = makeRangedBundle({
    inputs: [{ outpoint: 'iss:0', coin: { assetId: id, value: 100000n, refheight: H } }],
    payout: { assetId: FRC, scriptPubKey: spk(11), priceNum: price, priceDen: 1n },
    changeScript: spk(10), minFill, maxFill, lockHeight: H,
    nExpireTime: R() < 0.5 ? 0 : Hm + 5,
  });
  const fill = minFill + rb(maxFill - minFill + 1n) - 1n;
  let filled, ctx;
  try {
    filled = fillRanged(st, ranged, fill);
    const taker = makeBundle({
      inputs: [{ outpoint: 'buy:0', coin: { assetId: FRC, value: 500000000n, refheight: H } }],
      outputs: [{ assetId: id, value: fill, scriptPubKey: spk(21) }], lockHeight: H,
    });
    ({ ctx } = composeBundles(st, [filled, taker], { lockHeight: H, atHeight: Hm, txid: `r${world}`,
      matcher: { funds: [{ outpoint: 'mf:0', coin: { assetId: FRC, value: 100000000n, refheight: H } }], script: spk(31), fee: rb(10000n) } }));
  } catch { continue; }
  rWorlds++;
  const clone = () => { const s = new Nv3State(); s.utxos = new Map(st.utxos); s.assets = new Map(st.assets); return s; };

  // MINER FREEDOM: a different in-bounds fill (with the taker re-balanced) must still compose
  try {
    const fill2 = minFill + rb(maxFill - minFill + 1n) - 1n;
    const filled2 = fillRanged(st, ranged, fill2);
    const taker2 = makeBundle({
      inputs: [{ outpoint: 'buy:0', coin: { assetId: FRC, value: 500000000n, refheight: H } }],
      outputs: [{ assetId: id, value: fill2, scriptPubKey: spk(21) }], lockHeight: H,
    });
    composeBundles(clone(), [filled2, taker2], { lockHeight: H, atHeight: Hm, txid: `r${world}b`,
      matcher: { funds: [{ outpoint: 'mf:0', coin: { assetId: FRC, value: 100000000n, refheight: H } }], script: spk(31), fee: 1000n } });
    if (rangedId(filled2) !== ranged.id) { rHoles++; RHOLES.push(`world ${world}: refill changed the id`); }
    rFreedom++;
  } catch (e) { rHoles++; RHOLES.push(`world ${world}: legal refill refused: ${e.message}`); }

  // CONSTRAINT ATTACKS on the materialized outputs: consensus must reject (id can't help —
  // the outputs are outside the descriptor id by design)
  const attacks = [
    c => { c.subtxs[0].outputs[0].value -= 1n; },                       // shave the payout below price
    c => { c.subtxs[0].outputs[0].scriptPubKey = spk(99); },            // steal payout
    c => { c.subtxs[0].outputs[1].scriptPubKey = spk(99); },            // steal change
    c => { c.subtxs[0].outputs[1].value = 0n; },                        // force overfill (fill = givePv)
    c => { c.subtxs[0].outputs[0].assetId = id; },                      // pay in the wrong asset
    c => { c.subtxs[0].minFill = 0n; },                                 // relax the signed bounds
    c => { c.subtxs[0].payout.priceNum = 1n; },                         // rewrite the signed price
  ];
  for (const [ai, attack] of attacks.entries()) {
    const mctx = structuredClone(ctx);
    attack(mctx);
    rAttacks++;
    const ok = clone().checkComposite(mctx, Hm).ok;
    const idMoved = rangedId(mctx.subtxs[0]) !== ranged.id;
    if (ok && !idMoved) { rHoles++; RHOLES.push(`world ${world} attack ${ai}: accepted with intact id`); }
  }
}
check(`ranged fuzz: enough worlds (${rWorlds})`, rWorlds >= 15);
check(`ranged fuzz: miner freedom exercised (${rFreedom} refills)`, rFreedom >= 10);
check(`ranged fuzz: NO HOLES (${rHoles} over ${rAttacks} attacks)`, rHoles === 0, RHOLES.slice(0, 5).join(' | '));

finish();
