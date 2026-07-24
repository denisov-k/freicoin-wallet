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
import { covenantSpk, ownerHashOf, covenantPrice, readCovenant } from '@core/covenant.mjs';
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
 *  (a HRBG output is just host FRC paid to the covenant script, so this reuses the ordinary FRC send). */
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
  const spk = covSpkOf(name, floorV);
  const r = await api('utxos', { spks: [spk] }).catch(() => null);
  if (!r) return null;
  const u = (r.utxos || []).find(x => (x.script || x.spk) === spk);
  if (!u) return null;
  const [txid, vout] = (u.outpoint ?? `${u.txid}:${u.vout}`).split(':');
  return { spk, txid, vout: +vout, value: Number(u.value), refheight: u.refheight, height: r.height };
}

/** My names + their live price (= present value of the melting deposit, what a forced buy pays). */
export async function myNames() {
  const out = [];
  for (const rec of load()) {
    const c = await nameCoin(rec.name, rec.floorV);
    if (!c) continue;                                    // spent (bought from me) or not yet confirmed
    out.push({ name: rec.name, price: covenantPrice(c.value, c.refheight, c.height), deposit: BigInt(c.value),
      floorV: rec.floorV, coin: c });
  }
  return out;
}

/** Live availability of a name FOR ME (my own registry mirror). A definitive «is this name taken by
 *  anyone» check needs the indexer; here we only know about names in this wallet. */
export async function resolveName(name) {
  return (await nameCoin(name)) ? { taken: true, mine: true } : null;
}

/** REVALUE (top up) my own name to a higher self-assessment via the path-A buy-your-own: spend the
 *  HRBG (anyone-can-spend) plus my FRC coins, pay V to myself, carry newDeposit into the successor.
 *  Only raising is possible (consensus: successor >= current price V); lowering happens via demurrage. */
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

// Discovery of OTHERS' names needs an HRBG indexer (a scan of all covenant outputs). Until one exists
// these throw NEEDS_INDEXER so the UI can gracefully show only the trustless «my names» flow.
export async function listNames() { throw new Error(NEEDS_INDEXER); }
export async function buyName() { throw new Error(NEEDS_INDEXER); }
