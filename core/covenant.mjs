// covenant.mjs — client builders + reader for the Freiland Harberger COVENANT (the consensus
// soft-fork version, docs/freiland-covenant-spec.md), as opposed to the relay MVP in freiland.mjs +
// services/market/land.mjs. No relay, no online owner: the forced sale is enforced by the HRBG
// output format (a witness-v2 extension output, anyone-can-spend to old nodes) plus CheckTxInputs.
//
// This module is pure (no network/UI): it turns a human name + keys into the exact consensus bytes,
// reads a covenant output back, prices the melting deposit, and assembles/signs the three spends —
// claim, forced buy, revalue — reusing the already-proven primitives (encodeHarbergerSpk, the
// Freicoin MAST-v0 wpk spend from htlc.mjs, segwitV0Sighash, serializeTx). Every builder returns a
// node-ready {rawtx, txid}; see research/covenant-e2e-regtest.mjs for the end-to-end proof.
import { sha256 } from './crypto.mjs';
import { encodeHarbergerSpk, decodeAssetSpk } from './asset-spk.mjs';
import { frcWpkSpk } from './freiland.mjs';
import { pubkeyCompressed, signEcdsa } from './ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from './sighash.mjs';
import { serializeTx, txid } from './tx.mjs';
import { assetPresentValue } from './assets.mjs';

const HOST_K = { k: 20, interest: false };   // host FRC demurrage (shift 20), same kernel the consensus uses

/** A human name → its 32-byte registry key (the covenant's nameHash), hex. */
export const nameHashOf = name => sha256(Buffer.from(name, 'utf8')).toString('hex');

/** The 20-byte owner commitment = the owner's wpk program, so the forced-sale payout `0014{owner}`
 *  is exactly the owner's own address (they receive V and can spend it). Hex. */
export const ownerHashOf = ownerPub => frcWpkSpk(ownerPub).slice(4);

/** The covenant output scriptPubKey for `name`, owned by `ownerPub`, with a self-assessed floor. */
export const covenantSpk = (name, ownerPub, floorV) =>
  encodeHarbergerSpk(nameHashOf(name), ownerHashOf(ownerPub), floorV);

/** Decode a covenant output → {nameHash, owner, floorV:BigInt} | null (null if not a HRBG output). */
export function readCovenant(spk) {
  const d = decodeAssetSpk(spk);
  return d?.harberger ? { nameHash: d.harberger.nameHash, owner: d.harberger.owner, floorV: d.harberger.floorV } : null;
}

/** The current forced-sale price V = present value of the melting deposit at `height` (BigInt).
 *  This is exactly what the consensus charges (asset_pv on the host coin). */
export const covenantPrice = (depositNominal, refheight, height) =>
  /** @type {bigint} */ (assetPresentValue(BigInt(depositNominal), height - refheight, HOST_K));

const revh = t => t.match(/../g).reverse().join('');
const opIn = (t, v) => ({ prevout: { txid: revh(t), vout: v }, scriptSig: '', sequence: 0xfffffffd, witness: [] });

/** Sign a Freicoin MAST-v0 wpk input in place: witness = [sig, '00'+leaf, ''], scriptCode = the P2PK
 *  leaf (the pattern core/htlc.mjs uses and swap.test.mjs proves the node accepts). */
function signWpk(tx, idx, key, value, refheight) {
  const leaf = '21' + pubkeyCompressed(key) + 'ac';
  const sh = segwitV0Sighash(tx, idx, leaf, BigInt(value), refheight, SIGHASH_ALL);
  tx.vin[idx].witness = [signEcdsa(key, sh) + '01', '00' + leaf, ''];
}

// a spendable wpk coin: {txid, vout, value, refheight, key}
const fundPv = (coin, lockHeight) => /** @type {bigint} */ (assetPresentValue(BigInt(coin.value), lockHeight - coin.refheight, HOST_K));

/** CLAIM a free name: create a HRBG output with `deposit`, funded by the owner's wpk `funding` coin,
 *  change back to `changeSpk`. Signs the funding input. */
export function buildClaim({ name, ownerPub, floorV, deposit, funding, changeSpk, lockHeight, fee = 10000n }) {
  const change = fundPv(funding, lockHeight) - BigInt(deposit) - BigInt(fee);
  if (change < 0n) throw new Error('funding below deposit + fee');
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight,
    vin: [opIn(funding.txid, funding.vout)],
    vout: [
      { value: BigInt(deposit), scriptPubKey: covenantSpk(name, ownerPub, floorV) },
      { value: change, scriptPubKey: changeSpk },
    ] };
  signWpk(tx, 0, funding.key, funding.value, funding.refheight);
  return { rawtx: serializeTx(tx), txid: txid(tx) };
}

/** FORCED BUY of a live name: spend its HRBG holder `hrbg` (anyone-can-spend) plus the buyer's wpk
 *  `funding`, pay V to the current owner, and re-create a successor for the same name owned by
 *  `newOwnerPub`. `currentOwner` is the 20-byte owner hash read from the HRBG being bought. */
export function buildForcedBuy({ name, hrbg, currentOwner, newOwnerPub, floorV, funding, changeSpk, lockHeight, fee = 10000n }) {
  const V = covenantPrice(hrbg.value, hrbg.refheight, lockHeight);
  const change = fundPv(funding, lockHeight) - V - BigInt(fee);
  if (change < 0n) throw new Error('funding below price + fee');
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight,
    vin: [opIn(hrbg.txid, hrbg.vout), opIn(funding.txid, funding.vout)],
    vout: [
      { value: V, scriptPubKey: '0014' + currentOwner },                    // (1) pay the owner V
      { value: V, scriptPubKey: covenantSpk(name, newOwnerPub, floorV) },   // (2) successor for the name
      { value: change, scriptPubKey: changeSpk },                           // buyer's change
    ] };
  tx.vin[0].witness = [];                                                    // HRBG: anyone-can-spend
  signWpk(tx, 1, funding.key, funding.value, funding.refheight);
  return { rawtx: serializeTx(tx), txid: txid(tx), price: V };
}

/** REVALUE (top up / lower) one's own name: the owner-as-buyer forced buy — pay V to oneself and
 *  carry a new deposit `newDeposit` into the successor (raise = deposit forward rent, lower = take
 *  the surplus back as change). A path-A spend, so no owner signature on the covenant is needed. */
export function buildRevalue({ name, hrbg, ownerPub, floorV, newDeposit, funding, changeSpk, lockHeight, fee = 10000n }) {
  const V = covenantPrice(hrbg.value, hrbg.refheight, lockHeight);
  const owner = ownerHashOf(ownerPub);
  if (BigInt(newDeposit) < V) throw new Error('successor deposit below the current price'); // consensus: successor >= V
  // the payout V (to self) is funded by the HRBG input's own V, so they cancel — the owner's coin
  // funds only the new deposit + fee; a lower revalue is impossible via path A (successor must be >= V).
  const change = fundPv(funding, lockHeight) - BigInt(newDeposit) - BigInt(fee);
  if (change < 0n) throw new Error('funding below the revalue cost');
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight,
    vin: [opIn(hrbg.txid, hrbg.vout), opIn(funding.txid, funding.vout)],
    vout: [
      { value: V, scriptPubKey: '0014' + owner },                          // pay V to self (owner)
      { value: BigInt(newDeposit), scriptPubKey: covenantSpk(name, ownerPub, floorV) }, // successor at new deposit
      { value: change, scriptPubKey: changeSpk },
    ] };
  tx.vin[0].witness = [];
  signWpk(tx, 1, funding.key, funding.value, funding.refheight);
  return { rawtx: serializeTx(tx), txid: txid(tx), price: V };
}
