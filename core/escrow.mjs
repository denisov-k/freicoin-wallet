// escrow.mjs — arbiter-free 2-of-2 escrow. Buyer and seller lock funds in a 2-of-2
// multisig; release needs BOTH signatures. There is no third party, ever, and no on-chain
// dispute resolver. The penalty for a stalemate is demurrage itself: a locked, unresolved
// escrow melts for BOTH parties every block, so the rational move is always to settle on
// some split rather than watch it evaporate. On a non-decaying chain you'd have to burn
// funds to make deadlock costly; on Freicoin deadlock is self-punishing for free.
//
// Reuses the same engine as the HTLC/swap core: MAST P2WSH (long-hash), refheight sighash,
// tx serialization. The only new piece is a 2-signature (CHECKMULTISIG) spend.
import { pubkeyCompressed, signEcdsa } from './ecdsa.mjs';
import { sha256d } from './crypto.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from './sighash.mjs';
import { serializeTx, txid } from './tx.mjs';
import { encodeWitness } from './address.mjs';

const OP = { CMS: 0xae, N2: 0x52 };            // OP_CHECKMULTISIG, OP_2 (OP_1..16 = 0x51..0x60)
const op = x => x.toString(16).padStart(2, '0');
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const push = hex => { const n = hex.length / 2; if (n >= 0x4c) throw new Error('push>75'); return op(n) + hex; };

/** 2-of-2 multisig witness script (hex). Pubkeys are sorted (BIP67) so both parties derive
 *  the identical script/address regardless of who is "buyer" vs "seller". */
export function escrowLeaf(pubkeys) {
  if (pubkeys.length !== 2) throw new Error('2-of-2 needs exactly two pubkeys');
  const sorted = [...pubkeys].sort();          // equal-length hex → lexicographic == byte order
  return op(OP.N2) + sorted.map(push).join('') + op(OP.N2) + op(OP.CMS);
}

// P2WSH-MAST single leaf: program = HASH256(0x00 || leaf); reveal = 0x00 || leaf, empty proof.
const wshProgram = leafHex => bytesToHex(sha256d(hexToBytes('00' + leafHex)));
export const escrowSpk = leafHex => '0020' + wshProgram(leafHex);
export const escrowAddress = (leafHex, net) => encodeWitness(net, 0, wshProgram(leafHex));

/** Cooperatively release the escrow. `keys` are the two private keys (any order); `outputs`
 *  is the agreed division [{ value(BigInt kria), spk }]. Both parties must sign the same tx. */
export function escrowRelease({ prevTxid, vout, value, refheight, leafHex, keys, outputs, fee = 2000n }) {
  const paid = outputs.reduce((a, o) => a + o.value, 0n);
  if (paid + fee !== value) throw new Error('outputs + fee must equal the escrow value');
  const tx = {
    version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: refheight,
    vin: [{ prevout: { txid: prevTxid.match(/../g).reverse().join(''), vout }, scriptSig: '', sequence: 0xffffffff, witness: [] }],
    vout: outputs.map(o => ({ value: o.value, scriptPubKey: o.spk })),
  };
  const sh = segwitV0Sighash(tx, 0, leafHex, value, refheight, SIGHASH_ALL);
  // CHECKMULTISIG needs the signatures in the SAME order the pubkeys appear in the (sorted)
  // script — not signer order — plus a leading empty item for its off-by-one pop.
  const sigByPub = Object.fromEntries(keys.map(k => [pubkeyCompressed(k), signEcdsa(k, sh) + '01']));
  const sigs = Object.keys(sigByPub).sort().map(p => sigByPub[p]);
  tx.vin[0].witness = ['', ...sigs, '00' + leafHex, ''];
  return { rawtx: serializeTx(tx), txid: txid(tx) };
}
