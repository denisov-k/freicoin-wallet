// swap.mjs — the trustless FRC side of a cross-chain atomic swap. Our wallet always drives
// the Freicoin leg; the counterparty runs their own Bitcoin side (their bitcoind/wallet).
// This layer turns the HTLC engine into role-based operations keyed off the wallet seed.
//
// Roles (by who locks the FRC):
//   'give'    — we lock FRC (claimPub = counterparty, refundPub = us); we refund on timeout.
//   'receive' — the counterparty locks FRC (claimPub = us); we claim once we learn the preimage.
import { sha256 } from './crypto.mjs';
import { pubkeyCompressed } from './ecdsa.mjs';
import { htlcLeaf, htlcAddress, htlcSpk, htlcClaim, htlcRefund } from './htlc.mjs';

const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const utf8Hex = s => bytesToHex(new TextEncoder().encode(s));

/** Deterministic, seed-recoverable private key for one swap: SHA256(seed || "fw-swap:" || id).
 *  Keeping it off the payment path means a swap key leak never touches wallet funds. */
export function swapKey(seedHex, swapId) {
  return bytesToHex(sha256(hexToBytes(seedHex + utf8Hex('fw-swap:' + swapId))));
}

/** Build the FRC HTLC for our role. Returns the leaf script, its address (fund this) and spk. */
export function frcLeg({ role, ourKey, theirPub, paymentHash, cltv, net }) {
  const ourPub = pubkeyCompressed(ourKey);
  const [claimPub, refundPub] = role === 'give' ? [theirPub, ourPub] : [ourPub, theirPub];
  const leaf = htlcLeaf({ paymentHash, claimPub, refundPub, cltv });
  return { leaf, address: htlcAddress(leaf, net), spk: htlcSpk(leaf) };
}

/** role 'receive': claim the counterparty-funded FRC HTLC once the preimage is known
 *  (e.g. read from the Bitcoin chain where they claimed our BTC). */
export function claimReceived({ funding, leaf, preimage, ourKey, toSpk, fee }) {
  return htlcClaim({ prevTxid: funding.txid, vout: funding.vout, value: funding.value,
    refheight: funding.refheight, leafHex: leaf, preimage, claimKey: ourKey, toSpk, fee });
}

/** role 'give': refund our own FRC HTLC after its timeout (the swap did not complete). */
export function refundGiven({ funding, leaf, cltv, ourKey, toSpk, fee }) {
  return htlcRefund({ prevTxid: funding.txid, vout: funding.vout, value: funding.value,
    refheight: funding.refheight, leafHex: leaf, cltv, refundKey: ourKey, toSpk, fee });
}
