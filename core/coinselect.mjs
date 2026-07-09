// coinselect.mjs — Freicoin refheight-aware coin selection + fee math.
//
// The Freicoin-specific parts (vs a stock bitcoin coin selector):
//  1. A spent coin is only worth its DEMURRAGE-ADJUSTED present value at the
//     transaction's lock_height: present = timeAdjustValue(nominal, lock_height - refheight).
//  2. tx.lock_height must be >= the refheight of EVERY spent coin, else the node
//     rejects with `bad-txns-non-monotonic-lock-height` (consensus.tx_verify.cpp).
//  3. Every output created by the tx gets refheight = tx.lock_height.
//
// Reference: test_framework/wallet.py create_self_transfer_multi (lines ~405-427)
// and the C++ rule in src/consensus/tx_verify.cpp.
import { timeAdjustValue } from './demurrage.mjs';

/** Present value (kria) of `utxo` {value: bigint, refheight: number} valued at `lockHeight`. */
export function presentValueAt(utxo, lockHeight) {
  if (lockHeight < utxo.refheight) {
    throw new Error(
      `non-monotonic lock_height: ${lockHeight} < coin.refheight ${utxo.refheight} ` +
      `(would be rejected bad-txns-non-monotonic-lock-height)`);
  }
  return timeAdjustValue(utxo.value, lockHeight - utxo.refheight);
}

/** Minimal legal tx.lock_height for spending `utxos` = max(refheight). A wallet
 *  normally uses the current chain tip (>= this) so the tx is valid now. */
export function minLockHeight(utxos) {
  return utxos.reduce((m, u) => Math.max(m, u.refheight), 0);
}

// --- vsize model for Freicoin P2WPK (witness v0 pubkey) spends ---------------
// Weights in weight units; vsize = ceil(weight/4). Non-witness bytes cost 4 WU,
// witness bytes 1 WU. Freicoin appends a trailing uint32 lock_height to every tx
// => +4 non-witness bytes = +16 WU vs the bitcoin equivalent.
// NOTE: these are the standard P2WPKH figures + Freicoin's lock_height delta;
// they should be re-calibrated byte-exactly against a node before shipping.
const NONWIT_OVERHEAD_B = 4 /*version*/ + 1 /*vin count*/ + 1 /*vout count*/ + 4 /*nLockTime*/ + 4 /*lock_height*/;
const WITNESS_HEADER_WU = 2;                 // segwit marker+flag, 1 WU each (Freicoin marker is 0xff)
const IN_NONWIT_B = 32 + 4 + 1 + 4;          // prevout(36) + empty scriptSig len(1) + nSequence(4)
const IN_WIT_WU = 1 + 1 + 72 + 1 + 33;       // stack items(1) + sig len(1)+sig(72) + pk len(1)+pk(33)
const OUT_B = 8 + 1 + 22;                     // value(8) + spk len(1) + P2WPK spk(22)

/** Estimate vsize (vbytes) of a P2WPK tx with nIn inputs and nOut outputs. */
export function estimateVsize(nIn, nOut) {
  const nonWitB = NONWIT_OVERHEAD_B + nIn * IN_NONWIT_B + nOut * OUT_B;
  const witWU = WITNESS_HEADER_WU + nIn * IN_WIT_WU;
  const weight = nonWitB * 4 + witWU;
  return Math.ceil(weight / 4);
}

/**
 * Select coins to fund `target` kria at `feerate` (kria per vbyte), building the
 * tx at `lockHeight` (typically the current tip). Greedy over descending present
 * value. Fee is nominal (feerate * vsize); inputs are counted at present value.
 *
 * @returns {selected, lockHeight, fee, inputsPresentValue, change, vsize} or throws if unfundable.
 */
export function selectCoins(utxos, target, feerate, lockHeight, { dustThreshold = 294n, nOut = 2 } = {}) {
  target = BigInt(target);
  feerate = BigInt(feerate);
  if (target <= 0n) throw new Error('target must be > 0');
  // Only coins whose refheight <= lockHeight are spendable at this lock_height.
  const spendable = utxos
    .filter(u => u.refheight <= lockHeight)
    .map(u => ({ utxo: u, pv: presentValueAt(u, lockHeight) }))
    .filter(c => c.pv > 0n)
    .sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0));

  const selected = [];
  let inputsPV = 0n;
  for (const c of spendable) {
    selected.push(c.utxo);
    inputsPV += c.pv;
    const fee = feerate * BigInt(estimateVsize(selected.length, nOut));
    if (inputsPV >= target + fee) {
      let change = inputsPV - target - fee;
      let vsize = estimateVsize(selected.length, nOut);
      if (change < dustThreshold) {
        // Drop the dust change output: recompute fee without it, fold remainder into fee.
        const feeNoChange = feerate * BigInt(estimateVsize(selected.length, nOut - 1));
        if (inputsPV >= target + feeNoChange) {
          return {
            selected, lockHeight,
            fee: inputsPV - target,        // everything above target becomes fee
            inputsPresentValue: inputsPV,
            change: 0n,
            vsize: estimateVsize(selected.length, nOut - 1),
          };
        }
        continue; // need more inputs to also cover a change output
      }
      return { selected, lockHeight, fee, inputsPresentValue: inputsPV, change, vsize };
    }
  }
  throw new Error(
    `insufficient funds: present value ${inputsPV} kria at lock_height ${lockHeight} ` +
    `cannot cover target ${target} + fee`);
}
