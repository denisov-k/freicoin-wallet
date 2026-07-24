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
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { annualRent, validLandName, frcWpkSpk } from '@core/freiland.mjs';
import { covenantSpk, ownerHashOf, covenantPrice, readCovenant, nameHashOf } from '@core/covenant.mjs';
import { sendFrcToSpk, signInput, myCoinsOf, opIn } from '@/services/market/swap-lib.mjs';
import { serializeTx, parseTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { SIGHASH_ALL, segwitV0Sighash } from '@core/sighash.mjs';
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

// ── On-chain NAME BOOK (auto-recovery across devices) ───────────────────────────────────────────
// localStorage is the ONLY record of WHICH names I hold (the chain keeps sha256(name), not the text),
// so a fresh device shows nothing. Fix: every claim/buy/revalue also writes an OP_RETURN carrying the
// name ENCRYPTED under a seed-derived key. On any device the wallet scans the registry, tries to
// decrypt each name's tx, and the ones that decrypt (AES-GCM tag verifies ⇒ my key) are mine. Others
// see only ciphertext. Names issued BEFORE this (no FRLN) still need the one-time manual recover.
const FRLN = '46524c4e';                                  // 'FRLN' — Freiland name-book memo magic
const nbKeyBytes = () => Buffer.from(sha256(Buffer.from(ctx.seed + 'fw-covenant-namebook', 'utf8')));
const te = new TextEncoder(), td = new TextDecoder();
/** Encrypt a name → OP_RETURN payload hex (FRLN + iv(12) + ciphertext+tag). */
async function encName(name) {
  const key = await crypto.subtle.importKey('raw', nbKeyBytes(), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(name)));
  return FRLN + Buffer.from(iv).toString('hex') + Buffer.from(ct).toString('hex');
}
/** Decrypt an FRLN payload with MY key → the name, or null if it isn't mine (wrong key / tampered). */
async function decName(payloadHex) {
  if (!payloadHex?.startsWith(FRLN)) return null;
  const b = Buffer.from(payloadHex.slice(8), 'hex');
  if (b.length < 13) return null;
  try {
    const key = await crypto.subtle.importKey('raw', nbKeyBytes(), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
    return td.decode(pt);
  } catch { return null; }
}
// a value-0 OP_RETURN output carrying the encrypted name (host FRC, no asset). ≤75-byte direct push.
const frlnOut = async name => { const p = await encName(name); return { value: 0n, scriptPubKey: '6a' + (p.length / 2).toString(16).padStart(2, '0') + p, assetTag: HOST_TAG }; };

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
  const { txid } = await sendFrcToSpk(covSpkOf(name), deposit, [await frlnOut(name)]);   // + encrypted name book
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

// txids already inspected this session (skip re-fetching the same registry tx on every render)
const _seenTx = new Set();
/** AUTO-RECOVER my names from the chain: for each live registry entry, fetch its tx, try to decrypt
 *  the FRLN name-book memo with MY seed key — the ones that decrypt (and hash-match + owner-match)
 *  are mine, so add them to the local list. Lets «my names» populate on a fresh device with no manual
 *  step. Names issued before the name book (no FRLN memo) fall back to manual recoverName(). */
export async function recoverFromChain() {
  let reg; try { reg = await idx(); } catch { return 0; }
  const have = new Set(load().map(x => x.name));
  let added = 0;
  for (const e of (reg || [])) {
    const txid = (e.outpoint || '').split(':')[0];
    if (!txid || _seenTx.has(txid)) continue;
    _seenTx.add(txid);
    let tx; try { tx = parseTx((await api('rawFrcTx', { txid })).rawtx); } catch { continue; }
    const memo = tx.vout.map(o => o.scriptPubKey || '').find(s => s.startsWith('6a') && s.indexOf(FRLN) > 0);
    if (!memo) continue;
    const name = await decName(memo.slice(memo.indexOf(FRLN)));
    if (!name) continue;                                             // not mine (wrong key)
    if (nameHashOf(name) !== e.namehash || e.owner !== ownerHashOf(covOwnerPub(name))) continue;   // integrity + mine
    if (have.has(name)) continue;
    save(load().filter(x => x.name !== name).concat({ name, floorV: e.floorV ?? FLOOR, value: Number(e.price) / 1e8, claimTxid: txid, at: Date.now() }));
    have.add(name); added++;
  }
  return added;
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

/** RECOVER an already-owned name into the local «my names» list. localStorage is the ONLY record of
 *  WHICH names to show (the chain keeps just sha256(name), not the text), so a cleared store / another
 *  device makes an owned name invisible though the seed still holds it. Verify on-chain ownership by
 *  the seed-derived key, then re-add it. Returns false if the name is free or owned by someone else.
 *  @param {string} name */
export async function recoverName(name) {
  const info = await resolveName(name);
  if (!info || !info.mine) return false;                 // free, or not derivable from THIS seed
  const rec = { name, floorV: info.floorV ?? FLOOR, value: Number(info.price) / 1e8,
    claimTxid: (info.outpoint || '').split(':')[0], at: Date.now() };
  save(load().filter(x => x.name !== name).concat(rec));
  return true;
}

/** RELEASE (withdraw) my name: free it and reclaim its melting deposit via the owner path — spend the
 *  HRBG with NO successor, authorized by co-spending a coin at 0014{owner} whose sig the interpreter
 *  verifies (consensus tx_verify.cpp §path-A else-branch). Two CHAINED txs: (1) fund the owner address
 *  0014{owner} from my FRC, (2) spend HRBG + that owner coin back to my wallet. A forced buyer cannot
 *  do this (no owner key), so only the holder frees a name. @param {{name:string, progress?:(p:string)=>void}} o */
export async function releaseName({ name, progress = () => {} }) {
  const rec = load().find(x => x.name === name);
  const c = await nameCoin(name, rec?.floorV ?? FLOOR);
  if (!c) throw new Error('name coin not found');
  if (c.owner !== ownerHashOf(covOwnerPub(name))) throw new Error('not my name');
  const ownerPub = covOwnerPub(name), ownerKey = covKey(name);
  const ownerLeaf = '21' + ownerPub + 'ac';
  const ownerSpk = frcWpkSpk(ownerPub);                    // 0014{owner} — the owner's own address
  const L = ctx.state.mine.height;
  const FUND = 50000n;                                     // the owner-auth coin (well above dust)
  const out = (value, spk) => ({ value, scriptPubKey: spk, assetTag: HOST_TAG });
  // 1) fund 0014{owner} from my FRC (a fresh coin the interpreter will check the owner's sig on)
  const { picked, total } = pickFrc(FUND + FEE, L);
  const fchange = total - FUND - FEE;
  const fund = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: picked.map(p => opIn(p.outpoint)),
    vout: [ out(FUND, ownerSpk), ...(fchange > 0n ? [out(fchange, ctx.spks[0])] : []) ] };
  picked.forEach((p, i) => signInput(fund, i, p.spk, p.value, p.refheight, SIGHASH_ALL));
  progress('fund');
  const { txid: fundTxid } = await api('tx', { rawtx: serializeTx(fund), kind: 'send' });
  // 2) release: HRBG (anyone-can-spend) + the owner coin (signed with the covenant key), NO successor.
  //    Present value V of the melting deposit is what the HRBG input is worth at L; reclaim V + FUND − fee.
  const V = covenantPrice(c.value, c.refheight, L);
  const rel = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: [opIn(`${c.txid}:${c.vout}`), opIn(`${fundTxid}:0`)],
    vout: [ out(V + FUND - FEE, ctx.spks[0]) ] };
  rel.vin[0].witness = [];                                 // HRBG: anyone-can-spend
  const sh = segwitV0Sighash(rel, 1, ownerLeaf, FUND, L, SIGHASH_ALL);
  rel.vin[1].witness = [signEcdsa(ownerKey, sh) + '01', '00' + ownerLeaf, ''];
  progress('release');
  const { txid } = await api('tx', { rawtx: serializeTx(rel), kind: 'send' });
  save(load().filter(x => x.name !== name));
  progress('done');
  return { txid, reclaimed: V };
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
            await frlnOut(name),                              // encrypted name book (cross-device recovery)
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
            await frlnOut(name),                              // encrypted name book (cross-device recovery)
            ...(change > 0n ? [out(change, ctx.spks[0])] : []) ] };
  tx.vin[0].witness = [];                                     // HRBG: anyone-can-spend
  picked.forEach((p, i) => signInput(tx, i + 1, p.spk, p.value, p.refheight, SIGHASH_ALL));
  progress('confirm');
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  save(load().filter(x => x.name !== name).concat({ name, floorV: FLOOR, value: Number(V) / 1e8, claimTxid: txid, at: Date.now() }));
  progress('done');
  return { txid, price: V };
}
