// American options over the DEX primitives — the economics the consensus enforces:
// exercise composes the writer's PRE-SIGNED bundle (expiry = the option's) with the buyer's
// funding leg; after expiry the bundle is consensus-dead. No new consensus anywhere.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf } from '../../../core/assets.mjs';
import { Nv3State } from '../../../core/nv3chain.mjs';
import { makeBundle, bundleId } from '../../../core/dex.mjs';
import { writeCall, writePut, exercise } from '../../../core/options.mjs';

const spk = t => '0014' + t.repeat(20);
const st = new Nv3State();
const H = 5000;

// world: coop asset; writer holds 1000 coop (locked in the 2-of-2|CLTV script — script-level
// enforcement is the live demo's job, the model tracks the coin), buyer holds FRC.
const coop = { k: 18, interest: false, granularity: 1 };
const idCoop = assetIdOf(coop);
st.apply({ txid: 'iss', lockHeight: H, def: coop,
  inputs: [st.seed('cb', 0, { assetId: FRC, value: 100000000n, refheight: H, scriptPubKey: spk('11') })],
  outputs: [{ assetId: idCoop, value: 1000n, scriptPubKey: spk('e5') },       // "escrow" (2-of-2|CLTV)
            { assetId: FRC, value: 99000000n, scriptPubKey: spk('11') }] });
st.seed('buyer', 0, { assetId: FRC, value: 50000000n, refheight: H, scriptPubKey: spk('bb') });

// ---- CALL: strike 30000 kria/coop * 1000 coop = 3e7 FRC-kria, expires at H+100 ----
const call = writeCall({
  underlying: { outpoint: 'iss:0', coin: { assetId: idCoop, value: 1000n, refheight: H } },
  strike: { assetId: FRC, value: 30000000n },
  buyerScript: spk('b1'), writerScript: spk('a1'),
  expiry: H + 100, lockHeight: H,
});
check('call: exercise bundle pre-signed with the option expiry', call.exercise.nExpireTime === H + 100);

// buyer funds the strike + fee, keeps exact change (no residue)
const fee = 10000n;
const buyerLeg = makeBundle({
  inputs: [{ outpoint: 'buyer:0', coin: { assetId: FRC, value: 50000000n, refheight: H } }],
  outputs: [{ assetId: FRC, value: 50000000n - 30000000n - fee, scriptPubKey: spk('bb') }],
  lockHeight: H,
});

// exercised 50 blocks in — well before expiry
const stEx = new Nv3State(); stEx.utxos = new Map(st.utxos); stEx.assets = new Map(st.assets);
const { ctx } = exercise(stEx, call, buyerLeg, { atHeight: H + 50, txid: 'exr',
  matcher: { funds: [], script: spk('a1'), fee } });
check('call: exercise passes consensus before expiry', stEx.applyComposite(ctx, H + 50).ok !== false);
check('call: writer got the strike', stEx.utxos.get('exr:0')?.value === 30000000n && stEx.utxos.get('exr:0')?.assetId === FRC);
check('call: buyer got the underlying', stEx.utxos.get('exr:1')?.value === 1000n && stEx.utxos.get('exr:1')?.assetId === idCoop);

// after expiry the SAME pre-signed bundle is consensus-dead
const stLate = new Nv3State(); stLate.utxos = new Map(st.utxos); stLate.assets = new Map(st.assets);
let lateThrew = false;
try { exercise(stLate, call, buyerLeg, { atHeight: H + 101, txid: 'late', matcher: { funds: [], script: spk('a1'), fee } }); }
catch (e) { lateThrew = /expired/.test(e.message); }
check('call: exercise after expiry rejected by consensus', lateThrew);

// tampering the pre-signed terms (cheaper strike) breaks the writer's signature (bundle id)
const tampered = structuredClone(call.exercise);
tampered.outputs[0].value = 29999999n;
check('call: strike tamper breaks the writer signature', bundleId(tampered) !== call.exercise.id);

// ---- PUT: writer locks 3e7 FRC strike; buyer may deliver 1000 coop for it until expiry ----
const st2 = new Nv3State(); st2.utxos = new Map(st.utxos); st2.assets = new Map(st.assets);
st2.seed('wlock', 0, { assetId: FRC, value: 30000000n, refheight: H, scriptPubKey: spk('e6') });
st2.seed('bcoop', 0, { assetId: idCoop, value: 1000n, refheight: H, scriptPubKey: spk('b3') });
st2.seed('bfee', 0, { assetId: FRC, value: 100000n, refheight: H, scriptPubKey: spk('b3') });
const put = writePut({
  lockedStrike: { outpoint: 'wlock:0', coin: { assetId: FRC, value: 30000000n, refheight: H } },
  underlying: { assetId: idCoop, value: 1000n },
  buyerScript: spk('b4'), writerScript: spk('a2'),
  expiry: H + 100, lockHeight: H,
});
const putLeg = makeBundle({
  inputs: [{ outpoint: 'bcoop:0', coin: { assetId: idCoop, value: 1000n, refheight: H } },
           { outpoint: 'bfee:0', coin: { assetId: FRC, value: 100000n, refheight: H } }],
  outputs: [{ assetId: FRC, value: 100000n - fee, scriptPubKey: spk('b3') }],
  lockHeight: H,
});
const { ctx: pctx } = exercise(st2, put, putLeg, { atHeight: H + 99, txid: 'pex',
  matcher: { funds: [], script: spk('a2'), fee } });
check('put: exercise passes consensus', st2.applyComposite(pctx, H + 99).ok !== false);
check('put: writer got the underlying', st2.utxos.get('pex:0')?.assetId === idCoop && st2.utxos.get('pex:0')?.value === 1000n);
check('put: buyer got the strike', st2.utxos.get('pex:1')?.assetId === FRC && st2.utxos.get('pex:1')?.value === 30000000n);

finish();
