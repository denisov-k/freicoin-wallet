// nVersion=3-lite reference-model tests: pin down every consensus rule of user-issued assets
// with per-asset demurrage/interest. Pure model (no node) — this IS the executable spec.
import { check, finish } from './helpers.mjs';
import { timeAdjustValue } from '../../../core/demurrage.mjs';
import {
  FRC, assetIdOf, serializeAssetDef, assetPresentValue, validateTransfer, validateIssuance, _demurragePV,
} from '../../../core/assets.mjs';

const FRC_RATE = { k: 20, interest: false };

// asset identity is deterministic and rate-sensitive
const coop = { k: 18, interest: false, granularity: 1 };          // a community currency, melts faster than FRC
const bond = { k: 18, interest: true, granularity: 1 };           // a bond, GROWS at the same shift
const idCoop = assetIdOf(coop), idBond = assetIdOf(bond);
check('asset id deterministic', assetIdOf(coop) === idCoop);
check('different policy ⇒ different asset', idCoop !== idBond);
check('asset id is a 20-byte tag', idCoop.length === 40);

// per-asset demurrage: k=20 matches the canonical FRC kernel; k=18 melts faster
check('model reduces to FRC kernel at k=20', assetPresentValue(1000000000n, 5000, FRC_RATE) === timeAdjustValue(1000000000n, 5000));
// the GENERAL guard-bit method (not the fast path) is itself bit-exact vs the canonical kernel
let genOk = true; for (const d of [1,2,7,96,1000,52560,485000]) if (_demurragePV(1234567890n, d, 20) !== timeAdjustValue(1234567890n, d)) genOk = false;
check('general guard-bit kernel is bit-exact at k=20', genOk);
const meltCoop = 1000000000n - assetPresentValue(1000000000n, 5000, coop);
const meltFrc = 1000000000n - timeAdjustValue(1000000000n, 5000);
check('faster-shift asset melts more than FRC', meltCoop > meltFrc, `coop −${meltCoop} vs frc −${meltFrc} kria`);

// interest asset GROWS: present value exceeds nominal
check('interest (bond) asset grows over time', assetPresentValue(1000000000n, 5000, bond) > 1000000000n);

const assets = { [idCoop]: coop, [idBond]: bond };

// ISSUANCE: mint coop from nothing, FRC pays the fee
const iss = validateIssuance({
  def: coop,
  mintOutputs: [{ assetId: idCoop, value: 100000000n, refheight: 1000 }],
  frcInputs: [{ assetId: FRC, value: 1000000n, refheight: 1000 }],
  frcFeeOutputs: [{ assetId: FRC, value: 998000n }],
  lockHeight: 1000,
});
check('asset issuance valid, id + fee reported', iss.ok && iss.assetId === idCoop && iss.fee === 2000n);
const badIss = validateIssuance({ def: coop, mintOutputs: [{ assetId: idBond, value: 1n, refheight: 1000 }],
  frcInputs: [], frcFeeOutputs: [], lockHeight: 1000 });
check('mint output mis-tagged ⇒ rejected', !badIss.ok);

// TRANSFER: coop conserves present value; the aged input covers a fresh, smaller output
const inCoop = { assetId: idCoop, value: 100000000n, refheight: 1000 };
const agedPv = assetPresentValue(inCoop.value, 1500 - 1000, coop);
const okXfer = validateTransfer({
  inputs: [inCoop, { assetId: FRC, value: 500000n, refheight: 1000 }],
  outputs: [{ assetId: idCoop, value: agedPv, refheight: 1500 }, { assetId: FRC, value: 498000n, refheight: 1500 }],
  lockHeight: 1500, assets,
});
// the fee is the FRC input's PRESENT value minus the output — even the fee melts over 500 blocks
const expectedFee = timeAdjustValue(500000n, 500) - 498000n;
check('transfer conserves the asset in present value; FRC leaves a (melted) fee', okXfer.ok && okXfer.fee === expectedFee, `fee ${expectedFee} kria`);

// inflation is rejected: output claims more coop present-value than the input holds
const inflate = validateTransfer({
  inputs: [inCoop], outputs: [{ assetId: idCoop, value: inCoop.value, refheight: 1500 }],  // full nominal, but input has melted
  lockHeight: 1500, assets,
});
check('cannot output more asset present-value than input (no inflation)', !inflate.ok);

// interest asset: because it GREW, you may output MORE nominal than went in
const inBond = { assetId: idBond, value: 100000000n, refheight: 1000 };
const grownPv = assetPresentValue(inBond.value, 1500 - 1000, bond);
const bondXfer = validateTransfer({
  inputs: [inBond], outputs: [{ assetId: idBond, value: grownPv, refheight: 1500 }], lockHeight: 1500, assets,
});
check('interest asset lets output nominal exceed input nominal', bondXfer.ok && grownPv > inBond.value);

// unknown asset is rejected (can't move an undefined asset)
check('unknown asset rejected', !validateTransfer({
  inputs: [{ assetId: 'deadbeef'.repeat(5), value: 1n, refheight: 1000 }], outputs: [], lockHeight: 1001, assets,
}).ok);

finish();
