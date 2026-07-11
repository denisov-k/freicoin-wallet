// DEX phase 1 (partial offers, SIGHASH_SINGLE|ANYONECANPAY): two makers post crossing offers,
// a matcher splices them into one balanced tx, keeps the spread, and the consensus model
// (Nv3State) accepts it — with per-asset demurrage applied to what each maker gives.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf, assetPresentValue } from '../../../core/assets.mjs';
import { Nv3State } from '../../../core/nv3chain.mjs';
import { makeOffer, offersCross, matchOffers, matchMany, findCross, findRing, offerPrice,
         makeBundle, bundleId, bundleDelta, composeBundles,
         makeRangedBundle, rangedId, fillRanged, checkRanged } from '../../../core/dex.mjs';

const spk = t => '0014' + t.repeat(20);
const st = new Nv3State();

// world: a coop currency (melts at k=18) + FRC. Alice holds coop, Bob holds FRC.
const coop = { k: 18, interest: false, granularity: 1 };
const idCoop = assetIdOf(coop);
const frcCb = st.seed('cb', 0, { assetId: FRC, value: 100000000n, refheight: 1000, scriptPubKey: spk('11') });
st.apply({ txid: 'iss', lockHeight: 1000, def: coop, inputs: [frcCb],
  outputs: [{ assetId: idCoop, value: 10000000n, scriptPubKey: spk('aa') },      // Alice: 0.1 coop
            { assetId: FRC, value: 99000000n, scriptPubKey: spk('11') }] });
const bobFrc = st.seed('bob', 0, { assetId: FRC, value: 50000000n, refheight: 1000, scriptPubKey: spk('bb') });
const matFrc = st.seed('mat', 0, { assetId: FRC, value: 1000000n, refheight: 1000, scriptPubKey: spk('cc') });

// offers 20 blocks later: coop has melted a little; the makers price that in.
const H = 1020;
const alicePv = st.presentValueOf({ assetId: idCoop, value: 10000000n, refheight: 1000 }, H);

// Alice: gives her (melted) coop, wants 40 FRC-units. Bob: gives 45 FRC-units worth of his
// coin, wants slightly less coop than Alice's give is worth → both surpluses positive.
const aliceOffer = makeOffer({ outpoint: 'iss:0',
  coin: { assetId: idCoop, value: 10000000n, refheight: 1000 },
  want: { assetId: FRC, value: 40000000n, scriptPubKey: spk('a2') } });
const bobOffer = makeOffer({ outpoint: 'bob:0',
  coin: { assetId: FRC, value: 50000000n, refheight: 1000 },
  want: { assetId: idCoop, value: alicePv - 1000n, scriptPubKey: spk('b2') } });

check('crossing offers detected', offersCross(st, aliceOffer, bobOffer, H));
check('order book finds the pair', String(findCross(st, [aliceOffer, bobOffer], H)) === '0,1');
check('price is a rational (no floats)', offerPrice(aliceOffer).num === 40000000n);

const { tx, spread } = matchOffers(st, aliceOffer, bobOffer,
  { lockHeight: H, txid: 'match1', matcher: { funds: [{ outpoint: 'mat:0', coin: { assetId: FRC, value: 1000000n, refheight: 1000 } }], script: spk('c2'), fee: 10000n } });

check('matched tx passes consensus', st.apply(tx, H).ok !== false);
check('matcher earns the coop spread (1000 kria)', spread.get(idCoop) === 1000n);
const frcPv = (v) => assetPresentValue(v, H - 1000, { k: 20, interest: false });
check('matcher earns the FRC spread (bob give – alice want)', spread.get(FRC) === frcPv(50000000n) - 40000000n - 10000n);
check('alice got her FRC', st.utxos.get('match1:0')?.value === 40000000n && st.utxos.get('match1:0')?.assetId === FRC);
check('bob got his coop', st.utxos.get('match1:1')?.value === alicePv - 1000n && st.utxos.get('match1:1')?.assetId === idCoop);

// non-crossing: bob wants more coop than alice's give is worth
const greedy = makeOffer({ outpoint: 'bob:0',
  coin: { assetId: FRC, value: 50000000n, refheight: 1000 },
  want: { assetId: idCoop, value: alicePv + 1n, scriptPubKey: spk('b2') } });
check('non-crossing offers rejected', !offersCross(st, aliceOffer, greedy, H));

// same-asset offer is nonsense
let threw = false;
try { makeOffer({ outpoint: 'x:0', coin: { assetId: FRC, value: 1n, refheight: 0 }, want: { assetId: FRC, value: 1n, scriptPubKey: spk('00') } }); }
catch { threw = true; }
check('same-asset offer refused', threw);

// ---- N-way RING (transitive payments): X gives coop wants bond, Y gives bond wants FRC,
// Z gives FRC wants coop — no pair crosses, but the cycle does. ----
const bond = { k: 18, interest: true, granularity: 1 };
const idBond = assetIdOf(bond);
st.apply({ txid: 'issb', lockHeight: H, def: bond, inputs: ['match1:0'],   // alice's FRC funds the def
  outputs: [{ assetId: idBond, value: 2000000n, scriptPubKey: spk('dd') },
            { assetId: FRC, value: 39990000n, scriptPubKey: spk('aa') }] });
const xCoop = st.seed('xc', 0, { assetId: idCoop, value: 1000000n, refheight: H, scriptPubKey: spk('e1') });
const zFrc = st.seed('zf', 0, { assetId: FRC, value: 30000000n, refheight: H, scriptPubKey: spk('e3') });
const m2 = st.seed('m2', 0, { assetId: FRC, value: 500000n, refheight: H, scriptPubKey: spk('cc') });

const oX = makeOffer({ outpoint: 'xc:0', coin: { assetId: idCoop, value: 1000000n, refheight: H },
  want: { assetId: idBond, value: 1999000n, scriptPubKey: spk('e1') } });
const oY = makeOffer({ outpoint: 'issb:0', coin: { assetId: idBond, value: 2000000n, refheight: H },
  want: { assetId: FRC, value: 29000000n, scriptPubKey: spk('dd') } });
const oZ = makeOffer({ outpoint: 'zf:0', coin: { assetId: FRC, value: 30000000n, refheight: H },
  want: { assetId: idCoop, value: 999000n, scriptPubKey: spk('e3') } });

check('no PAIR crosses in the ring book', findCross(st, [oX, oY, oZ], H) === null);
const ring = findRing(st, [oX, oY, oZ], H);
check('3-way ring found', ring !== null && ring.length === 3);

// mine the ring FIVE blocks after the offers were signed — same-height offers stay matchable
const { tx: ringTx, spread: ringSpread } = matchMany(st, ring,
  { lockHeight: H, atHeight: H + 5, txid: 'ring1', matcher: { funds: [{ outpoint: 'm2:0', coin: { assetId: FRC, value: 500000n, refheight: H } }], script: spk('c9'), fee: 10000n } });
check('ring tx passes consensus, mined later than signing height', st.apply(ringTx, H + 5).ok !== false);
check('ring: X got bonds', st.utxos.get('ring1:0')?.assetId === idBond && st.utxos.get('ring1:0')?.value === 1999000n);
check('ring: Y got FRC', st.utxos.get('ring1:1')?.assetId === FRC);
check('ring: Z got coop', st.utxos.get('ring1:2')?.assetId === idCoop);
check('ring: matcher spread in coop + bond + FRC',
  (ringSpread.get(idCoop) ?? 0n) === 1000n && (ringSpread.get(idBond) ?? 0n) === 1000n && (ringSpread.get(FRC) ?? 0n) > 0n);

// a ring that shorts one leg must refuse
const oZbad = makeOffer({ outpoint: 'zf:0', coin: { assetId: FRC, value: 30000000n, refheight: H },
  want: { assetId: idCoop, value: 1000001n, scriptPubKey: spk('e3') } });   // wants more coop than X gives
let ringThrew = false;
try { matchMany(st, [oX, oY, oZbad], { lockHeight: H, txid: 'ring2', matcher: { funds: [], script: spk('c9'), fee: 0n } }); }
catch { ringThrew = true; }
check('short ring refused', ringThrew);

// ---- phase 2a: BUNDLES (sub-transactions, all-or-nothing, with CHANGE) ----
const st2 = new Nv3State();
st2.apply({ txid: 'iss2', lockHeight: 2000, def: coop,
  inputs: [st2.seed('cb2', 0, { assetId: FRC, value: 100000000n, refheight: 2000, scriptPubKey: spk('11') })],
  outputs: [{ assetId: idCoop, value: 150n, scriptPubKey: spk('aa') },      // Alice: 150 coop
            { assetId: FRC, value: 99000000n, scriptPubKey: spk('11') }] });
const bobFrc2 = st2.seed('bob2', 0, { assetId: FRC, value: 50000000n, refheight: 2000, scriptPubKey: spk('bb') });
const mat2 = st2.seed('mat2', 0, { assetId: FRC, value: 1000000n, refheight: 2000, scriptPubKey: spk('cc') });

// Alice sells only 100 of her 150 coop — the other 50 come BACK to her as change.
// Impossible in phase 1 (one committed output); natural in a bundle.
const aliceBundle = makeBundle({
  inputs: [{ outpoint: 'iss2:0', coin: { assetId: idCoop, value: 150n, refheight: 2000 } }],
  outputs: [{ assetId: FRC, value: 40000000n, scriptPubKey: spk('a2') },     // payout
            { assetId: idCoop, value: 50n, scriptPubKey: spk('aa') }],       // CHANGE
  lockHeight: 2000,
});
const bobBundle = makeBundle({
  inputs: [{ outpoint: 'bob2:0', coin: { assetId: FRC, value: 50000000n, refheight: 2000 } }],
  outputs: [{ assetId: idCoop, value: 99n, scriptPubKey: spk('b2') },        // wants 99 coop
            { assetId: FRC, value: 9000000n, scriptPubKey: spk('bb') }],     // FRC change
  lockHeight: 2000,
});
const dA = bundleDelta(st2, aliceBundle, 2000);
check('bundle delta: alice nets +100 coop, -0.4 FRC', dA.get(idCoop) === 100n && dA.get(FRC) === -40000000n);

const { ctx, spread: sp2 } = composeBundles(st2, [aliceBundle, bobBundle],
  { lockHeight: 2000, txid: 'comp1', matcher: { funds: [{ outpoint: 'mat2:0', coin: { assetId: FRC, value: 1000000n, refheight: 2000 } }], script: spk('c2'), fee: 10000n } });
check('composite passes consensus', st2.applyComposite(ctx).ok !== false);
check('alice got payout AND change', st2.utxos.get('comp1:0')?.value === 40000000n && st2.utxos.get('comp1:1')?.value === 50n && st2.utxos.get('comp1:1')?.assetId === idCoop);
check('bob got coop and his change', st2.utxos.get('comp1:2')?.value === 99n && st2.utxos.get('comp1:3')?.value === 9000000n);
check('matcher coop spread = 1 (100 given - 99 taken)', sp2.get(idCoop) === 1n);

// bundle identity: splice-invariant, tamper-sensitive
check('bundle id survives composition', bundleId(aliceBundle) === aliceBundle.id);
const tampered2 = { ...aliceBundle, outputs: [{ ...aliceBundle.outputs[0], value: 40000001n }, aliceBundle.outputs[1]] };
check('tampering a bundle changes its id', bundleId(tampered2) !== aliceBundle.id);

// per-bundle expiry: a stale bundle only spoils a composite that INCLUDES it
const expiring = makeBundle({
  inputs: [{ outpoint: 'comp1:1', coin: { assetId: idCoop, value: 50n, refheight: 2000 } }],
  outputs: [{ assetId: FRC, value: 1000n, scriptPubKey: spk('a2') }],
  nExpireTime: 2005, lockHeight: 2000,
});
const freshMat = st2.seed('mat3', 0, { assetId: FRC, value: 500000n, refheight: 2000, scriptPubKey: spk('cc') });
let expThrew = false;
try { composeBundles(st2, [expiring], { lockHeight: 2000, atHeight: 2010, txid: 'comp2', matcher: { funds: [{ outpoint: 'mat3:0', coin: { assetId: FRC, value: 500000n, refheight: 2000 } }], script: spk('c2'), fee: 0n } }); }
catch (e) { expThrew = /expired/.test(e.message); }
check('expired bundle rejected at mining height', expThrew);

// practical partial fill in 2a: the maker posts denominations; the matcher takes SOME
const denoms = [25n, 26n, 48n].map((v, n) => makeBundle({
  inputs: [{ outpoint: `comp1:2`, coin: { assetId: idCoop, value: 99n, refheight: 2000 } }],
  outputs: [{ assetId: FRC, value: v * 400000n, scriptPubKey: spk('b2') }],
  lockHeight: 2000,
}));
check('denomination bundles have distinct ids (outputs differ)', new Set(denoms.map(b => b.id)).size === 3);
// …but they all spend the SAME coin, so a matcher can take only ONE — taking two is a
// double-spend the composite check refuses
const bigMat = st2.seed('mat4', 0, { assetId: FRC, value: 30000000n, refheight: 2000, scriptPubKey: spk('cc') });
let dblThrew = false;
try { composeBundles(st2, [denoms[0], denoms[1]], { lockHeight: 2000, txid: 'comp3', matcher: { funds: [{ outpoint: 'mat4:0', coin: { assetId: FRC, value: 30000000n, refheight: 2000 } }], script: spk('c2'), fee: 0n } }); }
catch (e) { dblThrew = /duplicate input/.test(e.message); }
check('two bundles spending the same coin refused (duplicate input)', dblThrew);

// ---- phase 2b: RANGED bundles — the MINER picks the fill inside a signed constraint ----
const st3 = new Nv3State();
st3.apply({ txid: 'iss3', lockHeight: 3000, def: coop,
  inputs: [st3.seed('cb3', 0, { assetId: FRC, value: 200000000n, refheight: 3000, scriptPubKey: spk('11') })],
  outputs: [{ assetId: idCoop, value: 1000n, scriptPubKey: spk('aa') },
            { assetId: FRC, value: 199000000n, scriptPubKey: spk('11') }] });
st3.seed('buyer', 0, { assetId: FRC, value: 90000000n, refheight: 3000, scriptPubKey: spk('bb') });
st3.seed('matr', 0, { assetId: FRC, value: 1000000n, refheight: 3000, scriptPubKey: spk('cc') });

// Alice: "sell 100..800 of my 1000 coop at >= 30000 FRC-kria per coop-kria, payout here,
// change there" — one signature, ANY fill in range.
const ranged = makeRangedBundle({
  inputs: [{ outpoint: 'iss3:0', coin: { assetId: idCoop, value: 1000n, refheight: 3000 } }],
  payout: { assetId: FRC, scriptPubKey: spk('a2'), priceNum: 30000n, priceDen: 1n },
  changeScript: spk('aa'), minFill: 100n, maxFill: 800n, lockHeight: 3000,
});

// miner fills 700 of it; buyer's fixed bundle takes the coop
const filled = fillRanged(st3, ranged, 700n);
check('fill materializes payout at the signed price (rounded up)', filled.outputs[0].value === 21000000n && filled.outputs[1].value === 300n);
check('descriptor id ignores the fill (300 vs 700 fill, same signature)',
  rangedId(fillRanged(st3, ranged, 300n)) === rangedId(filled) && rangedId(filled) === ranged.id);

const buyerBundle = makeBundle({
  inputs: [{ outpoint: 'buyer:0', coin: { assetId: FRC, value: 90000000n, refheight: 3000 } }],
  outputs: [{ assetId: idCoop, value: 700n, scriptPubKey: spk('b2') },
            { assetId: FRC, value: 60000000n, scriptPubKey: spk('bb') }],   // ~2.1e7 pays alice, rest change
  lockHeight: 3000,
});
const { ctx: ctx3 } = composeBundles(st3, [filled, buyerBundle],
  { lockHeight: 3000, txid: 'comp2b', matcher: { funds: [{ outpoint: 'matr:0', coin: { assetId: FRC, value: 1000000n, refheight: 3000 } }], script: spk('c2'), fee: 10000n } });
check('ranged composite passes consensus', st3.applyComposite(ctx3).ok !== false);
check('alice: payout + 300 coop change', st3.utxos.get('comp2b:0')?.value === 21000000n && st3.utxos.get('comp2b:1')?.value === 300n);

// consensus catches every constraint violation
const stale = new Nv3State(); stale.utxos = new Map(st3.utxos); stale.assets = new Map(st3.assets);
const probe = (mutate) => {
  const bad = structuredClone(filled);
  mutate(bad);
  return checkRanged(st3, bad, 3000) !== null;
};
check('underpaying the price rejected', probe(b => { b.outputs[0].value -= 1n; }));
check('overfilling past maxFill rejected', probe(b => { b.outputs[1].value = 100n; }));   // fill = 900 > 800
check('underfilling below minFill rejected', probe(b => { b.outputs[1].value = 950n; })); // fill = 50 < 100
check('stealing the payout destination rejected', probe(b => { b.outputs[0].scriptPubKey = spk('99'); }));
check('stealing the change destination rejected', probe(b => { b.outputs[1].scriptPubKey = spk('99'); }));
check('swapping the payout asset rejected', probe(b => { b.outputs[0].assetId = idCoop; }));
// …and mutating the CONSTRAINT itself changes the id (breaks the signature)
check('price tamper changes the descriptor id', rangedId({ ...ranged, payout: { ...ranged.payout, priceNum: 29999n } }) !== ranged.id);
check('bounds tamper changes the descriptor id', rangedId({ ...ranged, maxFill: 900n }) !== ranged.id);

// ---- application pattern: a DUTCH AUCTION is just a ladder of expiring ranged offers ----
// The seller signs K offers over the SAME coin at descending prices with staggered expiries:
// price 40000 valid to height 3005, 35000 to 3010, 30000 to 3015. Only one can ever fill
// (same input = double-spend protection). A buyer at height 3012 can only take the 30000 one:
// the better-for-seller offers have expired; the model enforces exactly the auction schedule.
const rung = (price, expire) => makeRangedBundle({
  inputs: [{ outpoint: 'comp2b:1', coin: { assetId: idCoop, value: 300n, refheight: 3000 } }],
  payout: { assetId: FRC, scriptPubKey: spk('a2'), priceNum: price, priceDen: 1n },
  changeScript: spk('aa'), minFill: 50n, maxFill: 300n, lockHeight: 3000, nExpireTime: expire,
});
const auction = [rung(40000n, 3005), rung(35000n, 3010), rung(30000n, 3015)];
const live = h => auction.filter(r => r.nExpireTime >= h);
check('dutch auction: at h=3003 all rungs live', live(3003).length === 3);
check('dutch auction: at h=3012 only the cheapest survives', live(3012).length === 1 && live(3012)[0].payout.priceNum === 30000n);
// an expired rung really is dead at consensus level
const deadRung = fillRanged(st3, auction[0], 100n);
const mat5 = st3.seed('mat5', 0, { assetId: FRC, value: 90000000n, refheight: 3000, scriptPubKey: spk('cc') });
let deadThrew = false;
try { composeBundles(st3, [deadRung], { lockHeight: 3000, atHeight: 3012, txid: 'dead', matcher: { funds: [{ outpoint: 'mat5:0', coin: { assetId: FRC, value: 90000000n, refheight: 3000 } }], script: spk('c2'), fee: 0n } }); }
catch (e) { deadThrew = /expired/.test(e.message); }
check('dutch auction: expired rung rejected by consensus', deadThrew);

finish();
