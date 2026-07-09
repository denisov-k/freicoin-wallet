// balance.mjs — Freicoin wallet balance is a PRESENT VALUE: each UTXO's nominal
// amount decayed by demurrage over (tip_height - refheight) blocks, summed.
// This is *the* thing that makes a Freicoin balance shrink over time.
import { timeAdjustValue } from './demurrage.mjs';

/** @param utxos [{value: bigint (kria), refheight: number}]  @param atHeight number */
export function presentValueBalance(utxos, atHeight) {
  return utxos.reduce((sum, u) => sum + timeAdjustValue(u.value, atHeight - u.refheight), 0n);
}
