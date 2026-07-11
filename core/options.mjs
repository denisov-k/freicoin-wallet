// options.mjs — American CALL/PUT options as an APPLICATION PATTERN over the nV3 DEX
// primitives. No new consensus:
//
//   setup     the writer locks the underlying into a two-branch script
//             (IF 2-of-2(writer,buyer) ELSE CLTV(expiry)+writer ENDIF — the proven HTLC
//             machinery) and PRE-SIGNS the exercise bundle with SIGHASH_BUNDLE:
//             "the locked coin → [strike to me, underlying to the buyer]", with the BUNDLE
//             nExpireTime = the option expiry. The buyer pays the premium up front.
//   exercise  any time before expiry the buyer completes the 2-of-2, adds their own
//             strike-funding leg and mines. The writer can be offline and cannot renege
//             (2-of-2) or double-spend the underlying.
//   expiry    the exercise bundle is consensus-dead (bad-txns-bundle-expired); the writer
//             reclaims the underlying unilaterally via the CLTV branch.
//
// A PUT is the mirror image: the writer locks the STRIKE money and the pre-signed bundle
// reads "my locked strike → [underlying to me, strike to the buyer]".
//
// This model captures the economics against Nv3State (what consensus enforces: bundle
// expiry + per-asset conservation); the script-level enforcement (2-of-2, CLTV) is
// exercised for real in research/nversion3/options_demo.mjs.
import { makeBundle, composeBundles } from './dex.mjs';

/** Write a covered CALL: `underlying` is the writer's locked coin (already behind the
 *  2-of-2|CLTV script in the real chain), strike is what exercising must pay the writer.
 *  Returns the option: the pre-signed exercise bundle + metadata. */
export function writeCall({ underlying, strike, buyerScript, writerScript, expiry, lockHeight }) {
  const exercise = makeBundle({
    inputs: [underlying],
    outputs: [
      { assetId: strike.assetId, value: strike.value, scriptPubKey: writerScript },   // strike -> writer
      { assetId: underlying.coin.assetId, value: underlying.coin.value, scriptPubKey: buyerScript }, // underlying -> buyer
    ],
    nExpireTime: expiry,
    lockHeight,
  });
  return { kind: 'call', exercise, strike, expiry, buyerScript, writerScript };
}

/** Write a covered PUT: the writer locks the strike money; exercising delivers the
 *  underlying to the writer and releases the strike to the buyer. */
export function writePut({ lockedStrike, underlying, buyerScript, writerScript, expiry, lockHeight }) {
  const exercise = makeBundle({
    inputs: [lockedStrike],
    outputs: [
      { assetId: underlying.assetId, value: underlying.value, scriptPubKey: writerScript },  // asset -> writer
      { assetId: lockedStrike.coin.assetId, value: lockedStrike.coin.value, scriptPubKey: buyerScript }, // strike -> buyer
    ],
    nExpireTime: expiry,
    lockHeight,
  });
  return { kind: 'put', exercise, underlying, expiry, buyerScript, writerScript };
}

/** Exercise: compose the writer's pre-signed bundle with the buyer's own funding leg.
 *  `buyerLeg` must give what the exercise bundle's first output demands (the strike for a
 *  call; the underlying for a put) — the buyer keeps their change inside their own bundle.
 *  Throws (consensus) if the option expired or anything is short. */
export function exercise(state, option, buyerLeg, { atHeight, txid, matcher }) {
  return composeBundles(state, [option.exercise, buyerLeg], {
    lockHeight: option.exercise.lockHeight, atHeight, txid,
    matcher: matcher ?? { funds: [], script: option.writerScript, fee: 0n },
  });
}
