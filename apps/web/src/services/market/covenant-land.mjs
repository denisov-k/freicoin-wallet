// covenant-land.mjs — consensus-COVENANT backend for Freiland «Владение», a drop-in alternative to
// the relay MVP (land.mjs) that talks to core/covenant.mjs instead of a relay registry. Because a
// name is a HRBG covenant output enforced by consensus (docs/freiland-covenant-spec.md), the
// trustless part needs NO relay index: the wallet derives its own covenant scripts from the seed and
// reads their coins directly, and claiming a name is just paying host FRC to that script.
//
// Client-side today: registerName (claim) + myNames (my holdings + live price) + revalueName (top up
// my own). DISCOVERY of OTHERS' names — the public «for sale» list and buying an arbitrary name —
// needs an HRBG indexer (a scan of all covenant outputs); those methods throw NEEDS_INDEXER until one
// exists, so the UI can show the trustless «my names» flow now and light up the market later.
//
// NOTE: the covenant is only enforced once HARBERGER activates on the target chain; on a chain where
// it is not yet active these outputs are ordinary anyone-can-spend coins (see spec §6). This module
// is wired but dormant until the covenant is deployed to the network the wallet talks to.
import { ctx, api, HOST_TAG } from '@/state/market-ctx.mjs';
import { sha256 } from '@core/crypto.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { annualRent, validLandName } from '@core/freiland.mjs';
import { covenantSpk, ownerHashOf, covenantPrice, readCovenant, nameHashOf } from '@core/covenant.mjs';
import { sendFrcToSpk, signInput, myCoinsOf, opIn } from '@/services/market/swap-lib.mjs';
import { serializeTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { SIGHASH_ALL } from '@core/sighash.mjs';
import { Buffer } from 'buffer';

export { validLandName, annualRent };

export const NEEDS_INDEXER = 'covenant-needs-indexer';
const FLOOR = 1000000;                                   // Gesell dust floor (kria): self-assessed lapse floor
const FEE = 10000n;
const frcToKria = v => BigInt(Math.round(Number(v) * 1e8));

// per-name covenant key — own seed domain, distinct from trade/land keys. The owner commitment is
// this key's wpk program, so the forced-sale payout 0014{owner} is an address the wallet can spend.
const covKey = name => sha256(Buffer.from(ctx.seed + 'fw-covenant:' + name, 'utf8')).toString('hex');
export const covOwnerPub = name => pubkeyCompressed(covKey(name));
export const covSpkOf = (name, floorV = FLOOR) => covenantSpk(name, covOwnerPub(name), floorV);

// localStorage mirror of names I've claimed (name + the floorV I committed, to rederive the exact spk)
const load = () => { try { return JSON.parse(localStorage.getItem('fw_covenant') || '[]'); } catch { return []; } };
const save = a => localStorage.setItem('fw_covenant', JSON.stringify(a));

// present-value spendable FRC coins for funding a spend (mirrors sendFrcToSpk's selection)
const pickFrc = (need, L) => {
  const coins = myCoinsOf(null, L).sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += c.pv; if (S >= need) break; }
  if (S < need) throw new Error('not enough FRC');
  return { picked, total: S };
};

/** CLAIM a free name: fund a covenant output to my owner-key with a deposit that holds V for ~a week
 *  (a HRBG output is just host FRC paid to the covenant script, so this reuses the ordinary FRC send).
 *  @param {{name:string, valueFrc:number|string, progress?:(p:string)=>void}} o */
export async function registerName({ name, valueFrc, progress = () => {} }) {
  if (!validLandName(name)) throw new Error('bad name');
  const V = frcToKria(valueFrc);
  const deposit = V + annualRent(V) / 52n;               // week-of-rent buffer so it doesn't lapse next block
  progress('lock');
  const { txid } = await sendFrcToSpk(covSpkOf(name), deposit);
  const rec = { name, floorV: FLOOR, value: Number(valueFrc), claimTxid: txid, at: Date.now() };
  save(load().filter(x => x.name !== name).concat(rec));
  progress('done');
  return rec;
}

// the live covenant coin backing one of my names, read via the relay's utxo view of my own spk
async function nameCoin(name, floorV = FLOOR) {
  // read from the AUTHORITATIVE registry indexer (getharbergernames), NOT the relay's utxo index —
  // the latter keys a HRBG coin by its witness BASE (5120{nameHash}), not the full covenant spk, so a
  // lookup by the full spk misses it. The indexer returns the coin plus the consensus price/owner.
  const e = (await idx({ namehash: nameHashOf(name) }).catch(() => []))[0];
  if (!e) return null;
  const [txid, vout] = e.outpoint.split(':');
  return { spk: covSpkOf(name, floorV), txid, vout: +vout, value: Number(e.deposit),
    refheight: e.refheight, owner: e.owner, price: BigInt(e.price) };
}

/** My names + their live price (= present value of the melting deposit, what a forced buy pays). */
export async function myNames() {
  const out = [];
  for (const rec of load()) {
    const c = await nameCoin(rec.name, rec.floorV);
    if (!c) continue;                                              // not live (spent / not yet confirmed)
    if (c.owner !== ownerHashOf(covOwnerPub(rec.name))) continue;  // no longer mine (someone bought it)
    out.push({ name: rec.name, price: c.price, deposit: BigInt(c.value), floorV: rec.floorV, coin: c });
  }
  return out;
}

// the authoritative HRBG indexer, exposed by the relay as a proxy of the node's getharbergernames RPC
// (dump of the consensus name registry). Returns entries {namehash, outpoint, owner, floorV, deposit,
// refheight, price}. Discovery is by name HASH (the human name is not recoverable from the chain).
const idx = params => api('harbergernames', params || {});
const mapEntry = e => ({ nameHash: e.namehash, outpoint: e.outpoint, owner: e.owner,
  floorV: e.floorV, deposit: BigInt(e.deposit), refheight: e.refheight, price: BigInt(e.price) });

/** Look a specific name up on-chain: is it live, at what price, held by whom. null if free. */
export async function resolveName(name) {
  const r = await idx({ namehash: nameHashOf(name) }).catch(() => []);
  const e = (r || [])[0];
  return e ? { taken: true, name, ...mapEntry(e), mine: e.owner === ownerHashOf(covOwnerPub(name)) } : null;
}

/** REVALUE (top up) my own name to a higher self-assessment via the path-A buy-your-own: spend the
 *  HRBG (anyone-can-spend) plus my FRC coins, pay V to myself, carry newDeposit into the successor.
 *  Only raising is possible (consensus: successor >= current price V); lowering happens via demurrage.
 *  @param {{name:string, valueFrc:number|string, progress?:(p:string)=>void}} o */
export async function revalueName({ name, valueFrc, progress = () => {} }) {
  const rec = load().find(x => x.name === name);
  if (!rec) throw new Error('not my name');
  const c = await nameCoin(name, rec.floorV);
  if (!c) throw new Error('name coin not found');
  const L = ctx.state.mine.height;
  const V = covenantPrice(c.value, c.refheight, L);      // consensus charges this now
  const newV = frcToKria(valueFrc);
  const newDeposit = newV + annualRent(newV) / 52n;
  if (newDeposit < V) throw new Error('revalue below current price (lower only melts down over time)');
  const owner = ownerHashOf(covOwnerPub(name));
  const { picked, total } = pickFrc(newDeposit + FEE, L);   // funds the new deposit; payout V returns from the HRBG's own V
  const change = total - newDeposit - FEE;
  const nv3 = true;                                         // covenant lives on the nv3-class asset chain
  const out = (value, spk) => ({ value, scriptPubKey: spk, assetTag: HOST_TAG });
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: [opIn(`${c.txid}:${c.vout}`), ...picked.map(p => opIn(p.outpoint))],
    vout: [ out(V, '0014' + owner), out(newDeposit, covSpkOf(name, rec.floorV)),
            ...(change > 0n ? [out(change, ctx.spks[0])] : []) ] };
  tx.vin[0].witness = [];                                   // HRBG: anyone-can-spend
  picked.forEach((p, i) => signInput(tx, i + 1, p.spk, p.value, p.refheight, SIGHASH_ALL));
  progress('confirm');
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  save(load().map(x => x.name === name ? { ...x, value: Number(valueFrc) } : x));
  progress('done');
  return { txid, price: V };
}

/** Minimum self-assessed value (FRC) — the Gesell dust floor, so a name's deposit can't be dust. */
export async function minValueFrc() { return FLOOR / 1e8; }

/** All live names on-chain, each with its current forced-sale price. Addressed by name HASH (the
 *  human name is not recoverable from the chain). The relay must expose `harbergernames`. */
export async function listNames() {
  const r = await idx().catch(() => { throw new Error(NEEDS_INDEXER); });
  return { names: (r || []).map(mapEntry), height: ctx.state?.mine?.height };
}

/** FORCED BUY a live name: pay its current price V to the owner and carry the deposit into a successor
 *  owned by me. Funded from my FRC coins; the HRBG input is anyone-can-spend (empty witness).
 *  @param {{name:string, progress?:(p:string)=>void}} o */
export async function buyName({ name, progress = () => {} }) {
  const info = await resolveName(name);
  if (!info) throw new Error('name not found');
  const L = ctx.state.mine.height;
  const V = covenantPrice(info.deposit, info.refheight, L);   // exact price the consensus charges at L
  const { picked, total } = pickFrc(V + FEE, L);              // buyer brings V (+fee); the HRBG's own V carries the successor
  const change = total - V - FEE;
  const out = (value, spk) => ({ value, scriptPubKey: spk, assetTag: HOST_TAG });
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: [opIn(info.outpoint), ...picked.map(p => opIn(p.outpoint))],
    vout: [ out(V, '0014' + info.owner),                      // pay the current owner V
            out(V, covSpkOf(name, FLOOR)),                    // successor owned by me (carries V)
            ...(change > 0n ? [out(change, ctx.spks[0])] : []) ] };
  tx.vin[0].witness = [];                                     // HRBG: anyone-can-spend
  picked.forEach((p, i) => signInput(tx, i + 1, p.spk, p.value, p.refheight, SIGHASH_ALL));
  progress('confirm');
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  save(load().filter(x => x.name !== name).concat({ name, floorV: FLOOR, value: Number(V) / 1e8, claimTxid: txid, at: Date.now() }));
  progress('done');
  return { txid, price: V };
}
