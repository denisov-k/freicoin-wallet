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
import { annualRent, validLandName, validHoldingId, tickerId, isTickerId, isPlotId, plotId, plotShapeOf, holdingLabel, validTicker, validPlot, frcWpkSpk } from '@core/freiland.mjs';
import { covenantSpk, ownerHashOf, covenantPrice, readCovenant, nameHashOf } from '@core/covenant.mjs';
import { sendFrcToSpk, signInput, myCoinsOf, opIn, markSpent, hasPendingSpend } from '@/services/market/swap-lib.mjs';
import { serializeTx, parseTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { SIGHASH_ALL, segwitV0Sighash } from '@core/sighash.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { encodePolygon, decodePolygon, polygonsOverlap, polygonArea, polygonCentre } from '@core/geopoly.mjs';
import { encodeWitness } from '@core/address.mjs';
import { currentNet } from '@/services/wallet.mjs';
import { Buffer } from 'buffer';

export { validLandName, validHoldingId, tickerId, isTickerId, isPlotId, plotId, plotShapeOf, holdingLabel, validTicker, validPlot, annualRent };
export { encodePolygon, decodePolygon, polygonArea, polygonCentre } from '@core/geopoly.mjs';

export const NEEDS_INDEXER = 'covenant-needs-indexer';
// The covenant's trailing 8 bytes are RESERVED padding (see core/asset-spk.mjs): they keep the
// extension suffix out of the 20/52 asset-tag sizes so the deposit stays host FRC. Consensus never
// reads their value, so new names carry zero. MIN_VALUE is a separate UI guard — the smallest
// self-assessment worth claiming, unrelated to those bytes.
const RESERVED = 0;
const MIN_VALUE = 1000000;                               // 0.01 FRC — smallest sensible declaration
const FEE = 10000n;
const frcToKria = v => BigInt(Math.round(Number(v) * 1e8));

// per-name covenant key — own seed domain, distinct from trade/land keys. The owner commitment is
// this key's wpk program, so the forced-sale payout 0014{owner} is an address the wallet can spend.
const covKey = name => sha256(Buffer.from(ctx.seed + 'fw-covenant:' + name, 'utf8')).toString('hex');
export const covOwnerPub = name => pubkeyCompressed(covKey(name));
export const covSpkOf = (name, reserved = RESERVED) => covenantSpk(name, covOwnerPub(name), reserved);

// localStorage mirror of names I've claimed
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
// ── TICKER BINDING (which asset a symbol stands for) ────────────────────────────────────────────
// A symbol is only useful if a third party can tell WHICH «USD» is the real one. The binding needs
// no signature: it rides in the very transaction that created the holding's current output, and the
// author of that transaction IS the current holder (a forced buy replaces the output, so the new
// owner writes their own). Verification is one registry lookup + one raw-tx read — no scanning.
// A PLOT publishes its id IN CLEAR — a map has to be readable by everyone, and unlike a name (whose
// text we deliberately encrypt) a plot's whole point is that others can see what is taken. Same
// self-certification as everywhere here: hash the announced id and it must be the registry key the
// announcement was found under. This is also what makes overlap VISIBLE — the chain refuses to
// adjudicate it, so the wallet needs the neighbours' cells to warn about it.
const PLT1 = '504c5431';                                  // 'PLT1' — the BOUNDARY this holding is
const plotOut = polyHex => ({ value: 0n,
  scriptPubKey: '6a' + (4 + polyHex.length / 2).toString(16).padStart(2, '0') + PLT1 + polyHex, assetTag: HOST_TAG });
const readPlotShape = tx => {
  for (const o of tx.vout || []) {
    const spk = o.scriptPubKey || '';
    const i = spk.indexOf(PLT1);
    if (spk.startsWith('6a') && i > 0) { const hex = spk.slice(i + 8); if (hex) return hex; }
  }
  return null;
};
const PLN1 = '504c4e31';                                  // 'PLN1' — what its HOLDER calls this plot
/** The plot's name is a LABEL, not its identity: the ground is the boundary, and two holders may
 *  well call neighbouring fields the same thing. It is authentic the way a ticker binding is —
 *  written by whoever held the plot when the transaction was made — and a forced buy therefore does
 *  NOT carry it over: the taker writes their own, or none. Kept to 40 bytes so it fits one memo. */
export const MAX_PLOT_LABEL = 40;
export const plotLabelBytes = text => Buffer.from(String(text ?? ''), 'utf8').length;
const labelOut = text => {
  const b = Buffer.from(String(text), 'utf8');
  if (!b.length || b.length > MAX_PLOT_LABEL) throw new Error('bad plot name');
  return { value: 0n, scriptPubKey: '6a' + (4 + b.length).toString(16).padStart(2, '0') + PLN1 + b.toString('hex'), assetTag: HOST_TAG };
};
const readPlotLabel = tx => {
  for (const o of tx.vout || []) {
    const spk = o.scriptPubKey || '';
    const i = spk.indexOf(PLN1);
    if (!spk.startsWith('6a') || i <= 0) continue;
    const text = Buffer.from(spk.slice(i + 8), 'hex').toString('utf8').trim();
    if (text) return text;
  }
  return null;
};

/** The id a boundary commits to: plot:sha256(canonical bytes). */
export const plotIdOf = points => plotId(sha256(Buffer.from(encodePolygon(points), 'hex')).toString('hex'));

const TKR1 = '544b5231';                                  // 'TKR1' — «this symbol stands for that asset»
// Payload: TKR1 ‖ assetTag(20) ‖ symbol(utf8). The symbol travels IN CLEAR and is self-certifying:
// a reader checks sha256('ticker:'+symbol) against the registry entry the announcement was found
// under, so a wrong symbol simply fails to match. That is what frees an asset from having to be
// NAMED like its ticker — «Acme Dollar» can trade as ACD, which is the point of having symbols.
const bindOut = (tag, symbol) => {
  const sym = Buffer.from(String(symbol), 'utf8').toString('hex');
  const len = (4 + 20 + sym.length / 2).toString(16).padStart(2, '0');
  return { value: 0n, scriptPubKey: '6a' + len + TKR1 + tag + sym, assetTag: HOST_TAG };
};
const readBind = tx => {
  for (const o of tx.vout || []) {
    const spk = o.scriptPubKey || '';
    const i = spk.indexOf(TKR1);
    if (!spk.startsWith('6a') || i <= 0 || spk.length < i + 8 + 40) continue;
    const tag = spk.slice(i + 8, i + 8 + 40);
    const sym = Buffer.from(spk.slice(i + 8 + 40), 'hex').toString('utf8');
    if (tag && sym) return { tag, symbol: sym };
  }
  return null;
};

// a value-0 OP_RETURN output carrying the encrypted name (host FRC, no asset). ≤75-byte direct push.
const frlnOut = async name => { const p = await encName(name); return { value: 0n, scriptPubKey: '6a' + (p.length / 2).toString(16).padStart(2, '0') + p, assetTag: HOST_TAG }; };

// present-value spendable FRC coins for funding a spend (mirrors sendFrcToSpk's selection)
const pickFrc = (need, L) => {
  const coins = myCoinsOf(null, L).sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += c.pv; if (S >= need) break; }
  if (S < need) throw new Error(hasPendingSpend()
    ? 'coins are tied up in a transaction still waiting for a block — try again in a minute'
    : 'not enough FRC');
  return { picked, total: S };
};

/** CLAIM a free name: fund a covenant output to my owner-key with a deposit that holds V for ~a week
 *  (a HRBG output is just host FRC paid to the covenant script, so this reuses the ordinary FRC send).
 *  @param {{name:string, valueFrc:number|string, bind?:string|null, shape?:string|null,
 *           label?:string|null, progress?:(p:string)=>void}} o */
export async function registerName({ name, valueFrc, bind = null, shape = null, label = null, progress = () => {} }) {
  if (!validHoldingId(name)) throw new Error('bad name');
  const V = frcToKria(valueFrc);
  // The deposit IS the declaration — no rent buffer on top. A buffer would lock more than the holder
  // asked for and make the forced-buy price start ABOVE the declared figure; letting the price sit at
  // the declaration and slide down from there is both honest and the mechanism working as intended
  // (it getting cheaper is exactly the signal to top up).
  const deposit = V;
  progress('lock');
  // The name book encrypts the id so a fresh device can recover it — but a PLOT's id is a 76-char
  // commitment to a boundary that is already published in clear, and encrypting it would overflow
  // the 48-byte memo. Plots recover from their public boundary instead (see recoverFromChain).
  const extra = [...(isPlotId(name) ? [] : [await frlnOut(name)]),
    ...(bind ? [bindOut(bind, holdingLabel(name))] : []),
    ...(shape ? [plotOut(shape)] : []),
    ...(label ? [labelOut(label)] : [])];
  const { txid } = await sendFrcToSpk(covSpkOf(name), deposit, extra);
  const rec = { name, value: Number(valueFrc), bind, label, claimTxid: txid, at: Date.now() };
  save(load().filter(x => x.name !== name).concat(rec));
  invalidateChainCaches();
  progress('done');
  return rec;
}

/** The memos a SUCCESSOR must carry. For a name that is the encrypted name book; for a plot it is
 *  the boundary — which lives in the transaction that created the plot's current output, so every
 *  spend has to republish it or the plot silently falls off the map. Copying it is not taking the
 *  previous holder's word for anything: the id IS the hash of exactly these bytes, and that is
 *  checked here before the bytes are re-announced. (A plot gets no FRLN: its id is a 76-character
 *  commitment that would overflow the 48-byte memo, and its boundary is public anyway.)
 *  @param {string} name */
async function carryMemos(name, { keepLabel = true, label = undefined } = {}) {
  if (!isPlotId(name)) return [await frlnOut(name)];
  const c = await nameCoin(name);
  if (!c) return [];
  let tx = null;
  try { tx = await rawTx(c.txid); } catch {}
  if (!tx) return [];
  const hex = readPlotShape(tx);
  if (!hex || plotId(sha256(Buffer.from(hex, 'hex')).toString('hex')) !== name) return [];
  // `label === undefined` means «whatever it is now»; null clears it; a string replaces it
  const text = label !== undefined ? label : keepLabel ? readPlotLabel(tx) : null;
  return [plotOut(hex), ...(text ? [labelOut(text)] : [])];
}

// the live covenant coin backing one of my names, read via the relay's utxo view of my own spk
async function nameCoin(name) {
  // read from the AUTHORITATIVE registry indexer (getharbergernames), NOT the relay's utxo index —
  // the latter keys a HRBG coin by its witness BASE (5120{nameHash}), not the full covenant spk, so a
  // lookup by the full spk misses it. The indexer returns the coin plus the consensus price/owner.
  const e = (await idx({ namehash: nameHashOf(name) }).catch(() => []))[0];
  if (!e) return null;
  const [txid, vout] = e.outpoint.split(':');
  return { spk: covSpkOf(name), txid, vout: +vout, value: Number(e.deposit),
    refheight: e.refheight, owner: e.owner, price: BigInt(e.price) };
}

// txids already inspected this session (skip re-fetching the same registry tx on every render)
const _seenTx = new Set();
const _sweptOps = new Set();     // outpoints already swept this session (a broadcast is not instant)

// Chain reads are cached (the map and the symbol table are re-read on every render), so anything
// that CHANGES the registry has to drop them — otherwise a fresh claim is invisible to the very
// overlap warning that is supposed to notice it.
export const invalidateChainCaches = () => { _plotCache = { at: 0, list: [] }; _vCache = { at: 0, map: new Map() }; };

/** RECOVER path-A payouts stranded on a name's own covenant address. Consensus pays a raise (and a
 *  forced buy) to 0014{owner}; for a name we hold that is OUR per-name covenant key — derived from
 *  the seed, but not in the wallet's watch set, so the coin is spendable yet invisible. Raises now
 *  sweep inline, so this is for payouts made before that (and a safety net if an inline sweep fails).
 *  Silent and idempotent: nothing stranded ⇒ no transaction. Returns the kria brought back. */
export async function sweepPayouts() {
  const L = ctx.state?.mine?.height; if (!L) return 0n;
  const names = load().map(x => x.name); if (!names.length) return 0n;
  const spkOfName = new Map(names.map(n => [frcWpkSpk(covOwnerPub(n)), n]));
  const r = await api('utxos', { spks: [...spkOfName.keys()] }).catch(() => null);
  let swept = 0n;
  for (const [spk, name] of spkOfName) {
    const coins = (r?.utxos || []).filter(u => u.spk === spk && !u.coinbase && !_sweptOps.has(u.outpoint));
    if (!coins.length) continue;
    // value at OUR height, not the relay's — a block in between would make the outputs exceed the inputs
    const pvAt = u => assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false });
    const total = coins.reduce((s, u) => s + pvAt(u), 0n);
    if (total <= FEE) continue;
    const key = covKey(name), leaf = '21' + covOwnerPub(name) + 'ac';
    const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
      vin: coins.map(u => opIn(u.outpoint)),
      vout: [ { value: total - FEE, scriptPubKey: ctx.spks[0], assetTag: HOST_TAG } ] };
    coins.forEach((u, i) => {
      const sh = segwitV0Sighash(tx, i, leaf, BigInt(u.value), u.refheight, SIGHASH_ALL);
      tx.vin[i].witness = [signEcdsa(key, sh) + '01', '00' + leaf, ''];
    });
    try {
      await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
      coins.forEach(u => _sweptOps.add(u.outpoint));
      swept += total - FEE;
    } catch {}
  }
  return swept;
}
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
    let tx; try { tx = await rawTx(txid); } catch { continue; }
    // A PLOT carries no name book — its id is a 76-character commitment that would overflow the
    // memo — but it does not need one: the boundary is published in clear, the id is the hash of
    // exactly those bytes, and whether it is mine follows from the seed. So plots recover from the
    // ground itself, which is why this device can be told «that plot is yours» and mean it.
    const shape = readPlotShape(tx);
    if (shape) {
      const pid = plotId(sha256(Buffer.from(shape, 'hex')).toString('hex'));
      if (nameHashOf(pid) !== e.namehash || have.has(pid)) continue;
      let mine = false;
      try { mine = e.owner === ownerHashOf(covOwnerPub(pid)); } catch {}
      if (!mine) continue;
      save(load().filter(x => x.name !== pid).concat({ name: pid, label: readPlotLabel(tx), claimTxid: txid, at: Date.now() }));
      have.add(pid); added++;
      continue;
    }
    const memo = tx.vout.map(o => o.scriptPubKey || '').find(s => s.startsWith('6a') && s.indexOf(FRLN) > 0);
    if (!memo) continue;
    const name = await decName(memo.slice(memo.indexOf(FRLN)));
    if (!name) continue;                                             // not mine (wrong key)
    if (nameHashOf(name) !== e.namehash || e.owner !== ownerHashOf(covOwnerPub(name))) continue;   // integrity + mine
    if (have.has(name)) continue;
    // no `value`: the DECLARED figure is local knowledge and the chain does not carry it. Filling it
    // with the current price would invent a declaration that happens to equal the price, so the panel
    // showed «self-assessed value» and «forced-buy price» as the same number.
    save(load().filter(x => x.name !== name).concat({ name, claimTxid: txid, at: Date.now() }));
    have.add(name); added++;
  }
  return added;
}

/** Live plots, straight from the chain: [{id, points, area, centre, price, mine}]. Each holding's own
 *  transaction announces its id in clear, and the announcement is checked by hashing it back to the
 *  registry key it was found under — so a plot cannot claim to be ground it does not hold. This is
 *  the map, and the input to overlap warnings. Cached briefly; the registry is small. */
let _plotCache = { at: 0, list: [] };
export async function livePlots() {
  if (Date.now() - _plotCache.at < 30000) return _plotCache.list;
  const list = [];
  try {
    for (const e of (await idx()) || []) {
      const txid = (e.outpoint || '').split(':')[0]; if (!txid) continue;
      let tx, hex;
      try { tx = await rawTx(txid); hex = readPlotShape(tx); } catch { continue; }
      if (!hex) continue;
      let points; try { points = decodePolygon(hex); } catch { continue; }
      // the boundary self-certifies: hash it and it must reproduce the registry key it was found under
      const id = plotId(sha256(Buffer.from(hex, 'hex')).toString('hex'));
      if (nameHashOf(id) !== e.namehash) continue;
      // «is it mine» needs the seed; a locked or half-woken session must still get the MAP — knowing
      // what ground is taken does not depend on knowing whose it is
      let mine = false;
      try { mine = e.owner === ownerHashOf(covOwnerPub(id)); } catch {}
      list.push({ id, points, label: readPlotLabel(tx), area: polygonArea(points), centre: polygonCentre(points),
        price: BigInt(e.price), outpoint: e.outpoint, owner: e.owner, mine });
    }
    // never cache «no plots»: an empty answer is what a hiccuped registry read looks like, and
    // caching it would keep the map blank for the next half minute of taps
    if (list.length) _plotCache = { at: Date.now(), list };
  } catch {}
  return _plotCache.list;
}

/** Live plots whose ground overlaps the boundary being drawn. The chain refuses to adjudicate this,
 *  so the wallet has to show it. */
export async function overlapsOf(points) {
  if (!points || points.length < 3) return [];
  return (await livePlots()).filter(p => polygonsOverlap(p.points, points));
}

/** VERIFIED symbols, straight from the chain: Map(assetTag → symbol). For every live holding we
 *  read the transaction that created its current output and take the TKR1 announcement from it —
 *  authentic by construction, since that transaction's author IS the current holder (a forced buy
 *  replaces the output, so a taker publishes their own claim and inherits nobody's word). The
 *  announced symbol is checked by hashing it back to the registry key it was found under, so it
 *  cannot claim to be a symbol it does not hold. Cached: this runs on every market refresh. */
let _vCache = { at: 0, map: new Map() };
export async function verifiedSymbols() {
  if (Date.now() - _vCache.at < 60000) return _vCache.map;
  const map = new Map();
  try {
    for (const e of (await idx()) || []) {
      const txid = (e.outpoint || '').split(':')[0]; if (!txid) continue;
      let b; try { b = readBind(await rawTx(txid)); } catch { continue; }
      if (!b || !validTicker(b.symbol.toUpperCase())) continue;
      if (nameHashOf(tickerId(b.symbol)) !== e.namehash) continue;   // the symbol must hash to THIS entry
      map.set(b.tag, b.symbol.toUpperCase());
    }
    _vCache = { at: Date.now(), map };
  } catch {}
  return map;
}

/** My names + their live price (= present value of the melting deposit, what a forced buy pays). */
/** What THIS device recorded as its own — including a holding whose transaction is still waiting
 *  for a block. The registry only knows confirmed ownership, so this is the difference between
 *  «not yours» and «not yours yet». */
export const localHoldings = () => load();

/** Forget a holding this device recorded but the chain never gave us — a takeover that lost the
 *  race, a transaction that never confirmed. Nothing is destroyed by this: the record is local
 *  bookkeeping, and if the holding IS ours the chain says so and recovery brings it back. */
export const forgetHolding = name => save(load().filter(x => x.name !== name));

/** Does this transaction still exist anywhere — a block or the mempool? Deliberately uncached: the
 *  question is about NOW, and the answer flips when a competing spend wins. */
export const txAlive = async txid => { try { await api('rawFrcTx', { txid }); return true; } catch { return false; } };

export async function myNames() {
  const out = [];
  for (const rec of load()) {
    const c = await nameCoin(rec.name);
    if (!c) continue;                                              // not live (spent / not yet confirmed)
    if (c.owner !== ownerHashOf(covOwnerPub(rec.name))) continue;  // no longer mine (someone bought it)
    out.push({ name: rec.name, price: c.price, deposit: BigInt(c.value), coin: c });
  }
  return out;
}

// the authoritative HRBG indexer, exposed by the relay as a proxy of the node's getharbergernames RPC
// (dump of the consensus name registry). Returns entries {namehash, outpoint, owner, floorV, deposit,
// refheight, price}. Discovery is by name HASH (the human name is not recoverable from the chain).
const idx = params => api('harbergernames', params || {});

// A confirmed transaction never changes, and four readers here want the same ones: the map (a plot's
// boundary), the verified symbols (a ticker's binding), recovery (the name book) and every successor
// that carries a memo forward. Fetching each of them separately per repaint is what put the wallet
// over the relay's read limit — the same txids, over and over, several times a minute.
const _txCache = new Map();
async function rawTx(txid) {
  let tx = _txCache.get(txid);
  if (tx) return tx;
  tx = parseTx((await api('rawFrcTx', { txid })).rawtx);
  if (_txCache.size > 400) _txCache.delete(_txCache.keys().next().value);
  _txCache.set(txid, tx);
  return tx;
}
const mapEntry = e => ({ nameHash: e.namehash, outpoint: e.outpoint, owner: e.owner,
  reserved: e.reserved ?? e.floorV, deposit: BigInt(e.deposit), refheight: e.refheight, price: BigInt(e.price) });

/** RESOLVE a name to a payable address. The covenant already commits the holder's `owner` — the wpk
 *  program consensus pays a forced buy to — so the name resolves to its holder's own address with NO
 *  extra record, no relay index and no trust: the answer comes from the consensus registry and follows
 *  the name automatically when it changes hands. null if the name is free. @param {string} name */
export async function resolveAddress(name) {
  const e = (await idx({ namehash: nameHashOf(name) }).catch(() => []))[0];
  return e ? encodeWitness(currentNet(), 0, e.owner) : null;
}

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
  const rec = { name, claimTxid: (info.outpoint || '').split(':')[0], at: Date.now() };   // no invented declaration
  save(load().filter(x => x.name !== name).concat(rec));
  return true;
}

/** RELEASE (withdraw) my name: free it and reclaim its melting deposit via the owner path — spend the
 *  HRBG with NO successor, authorized by co-spending a coin at 0014{owner} whose sig the interpreter
 *  verifies (consensus tx_verify.cpp §path-A else-branch). Two CHAINED txs: (1) fund the owner address
 *  0014{owner} from my FRC, (2) spend HRBG + that owner coin back to my wallet. A forced buyer cannot
 *  do this (no owner key), so only the holder frees a name. @param {{name:string, progress?:(p:string)=>void}} o */
export async function releaseName({ name, progress = () => {} }) {
  const { txid, reclaimed } = await ownerPathSpend({ name, successor: null, progress });
  save(load().filter(x => x.name !== name));
  invalidateChainCaches();
  progress('done');
  return { txid, reclaimed };
}

/** LOWER the self-assessment. Path-A («buy your own») cannot do this — consensus caps the successor
 *  at >= the current price V there. The OWNER path can: with no successor worth >= V the rule only
 *  asks for a co-spent 0014{owner} input, so a smaller successor is legal and the freed difference
 *  comes back. Lowering is part of Harberger, not a loophole: cheaper to hold, cheaper to take away.
 *  @param {{name:string, valueFrc:number|string, progress?:(p:string)=>void}} o */
export async function lowerName({ name, valueFrc, progress = () => {} }) {
  const newV = frcToKria(valueFrc);
  const r = await ownerPathSpend({ name, successor: newV, progress });
  save(load().map(x => x.name === name ? { ...x, value: Number(valueFrc) } : x));
  progress('done');
  return r;
}

/** The owner path in one place: fund 0014{owner}, then spend the HRBG together with that coin.
 *  `successor === null` frees the name; a value creates a smaller successor (a lowered assessment).
 *  @param {{name:string, successor:bigint|null, progress:(p:string)=>void}} o */
async function ownerPathSpend({ name, successor, progress }) {
  const rec = load().find(x => x.name === name);
  const c = await nameCoin(name);
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
  markSpent(picked.map(p => p.outpoint));
  // 2) release: HRBG (anyone-can-spend) + the owner coin (signed with the covenant key), NO successor.
  //    Present value V of the melting deposit is what the HRBG input is worth at L; reclaim V + FUND − fee.
  const V = covenantPrice(c.value, c.refheight, L);
  // A successor worth >= V would flip consensus into the forced-buy branch (which then demands a
  // payout to the owner) — the owner path only covers freeing the name or lowering it.
  if (successor !== null && successor >= V) throw new Error('use revalue to raise the value');
  const back = V + FUND - FEE - (successor ?? 0n);         // what returns to the wallet
  const rel = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: [opIn(`${c.txid}:${c.vout}`), opIn(`${fundTxid}:0`)],
    vout: [ ...(successor !== null ? [out(successor, covSpkOf(name)), ...(await carryMemos(name))] : []),
            out(back, ctx.spks[0]) ] };
  rel.vin[0].witness = [];                                 // HRBG: anyone-can-spend
  const sh = segwitV0Sighash(rel, 1, ownerLeaf, FUND, L, SIGHASH_ALL);
  rel.vin[1].witness = [signEcdsa(ownerKey, sh) + '01', '00' + ownerLeaf, ''];
  progress(successor === null ? 'release' : 'lower');
  const { txid } = await api('tx', { rawtx: serializeTx(rel), kind: 'send' });
  markSpent([`${c.txid}:${c.vout}`, `${fundTxid}:0`]);
  return { txid, reclaimed: back };
}

/** REVALUE (top up) my own name to a higher self-assessment via the path-A buy-your-own: spend the
 *  HRBG (anyone-can-spend) plus my FRC coins, pay V to myself, carry newDeposit into the successor.
 *  Only raising is possible (consensus: successor >= current price V); lowering happens via demurrage.
 *  @param {{name:string, valueFrc:number|string|null, bind?:string|null, label?:string|null,
 *           progress?:(p:string)=>void}} o */
export async function revalueName({ name, valueFrc, bind = undefined, label = undefined, progress = () => {} }) {
  const rec = load().find(x => x.name === name);
  if (!rec) throw new Error('not my name');
  const c = await nameCoin(name);
  if (!c) throw new Error('name coin not found');
  const L = ctx.state.mine.height;
  const V = covenantPrice(c.value, c.refheight, L);      // consensus charges this now
  // `null` = republish at exactly today's price (used when only the announcement changes). Otherwise
  // tolerate a hair's shortfall: the indexer prices at tip+1 while we build at tip, so «the price I
  // was just shown» is a few kria under V and would otherwise be rejected as a lowering.
  let newDeposit = valueFrc == null ? V : frcToKria(valueFrc);
  if (newDeposit < V && V - newDeposit <= V / 100000n) newDeposit = V;
  if (newDeposit < V) throw new Error('revalue below current price (lower only melts down over time)');
  const owner = ownerHashOf(covOwnerPub(name));
  const { picked, total } = pickFrc(newDeposit + FEE, L);   // funds the new deposit; payout V returns from the HRBG's own V
  const change = total - newDeposit - FEE;
  const nv3 = true;                                         // covenant lives on the nv3-class asset chain
  const out = (value, spk) => ({ value, scriptPubKey: spk, assetTag: HOST_TAG });
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: [opIn(`${c.txid}:${c.vout}`), ...picked.map(p => opIn(p.outpoint))],
    vout: [ out(V, '0014' + owner), out(newDeposit, covSpkOf(name)),
            ...(await carryMemos(name, { label })),           // name book, or a plot's boundary + name
            ...(((bind === undefined ? rec.bind : bind)) ? [bindOut(bind === undefined ? rec.bind : bind, holdingLabel(name))] : []),
            ...(change > 0n ? [out(change, ctx.spks[0])] : []) ] };
  tx.vin[0].witness = [];                                   // HRBG: anyone-can-spend
  picked.forEach((p, i) => signInput(tx, i + 1, p.spk, p.value, p.refheight, SIGHASH_ALL));
  progress('confirm');
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  markSpent([`${c.txid}:${c.vout}`, ...picked.map(p => p.outpoint)]);
  // Consensus makes the raise pay V to 0014{owner} — the per-name covenant key's address, which the
  // wallet does NOT scan. Left there, raising looks like it costs the WHOLE new value instead of the
  // difference (the money is recoverable from the seed, just invisible). Sweep it straight back.
  const ownerKey = covKey(name), ownerLeaf = '21' + covOwnerPub(name) + 'ac';
  const sweep = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, nExpireTime: 0, lockHeight: L,
    vin: [opIn(`${txid}:0`)], vout: [out(V - FEE, ctx.spks[0])] };
  const sh = segwitV0Sighash(sweep, 0, ownerLeaf, V, L, SIGHASH_ALL);
  sweep.vin[0].witness = [signEcdsa(ownerKey, sh) + '01', '00' + ownerLeaf, ''];
  await api('tx', { rawtx: serializeTx(sweep), kind: 'send' });
  save(load().map(x => x.name === name ? { ...x, ...(valueFrc == null ? {} : { value: Number(valueFrc) }), ...(bind === undefined ? {} : { bind }), ...(label === undefined ? {} : { label }) } : x));
  invalidateChainCaches();
  progress('done');
  return { txid, price: V };
}

/** RENAME a plot: republish at today's price with a new label (or none). The price is untouched —
 *  `valueFrc: null` locks exactly what the plot is worth right now, so only the announcement moves.
 *  @param {{name:string, label:string|null, progress?:(p:string)=>void}} o */
export async function renamePlot({ name, label, progress = () => {} }) {
  if (!isPlotId(name)) throw new Error('not a plot');
  if (label && plotLabelBytes(label) > MAX_PLOT_LABEL) throw new Error('bad plot name');
  return revalueName({ name, valueFrc: null, label: label || null, progress });
}

/** Minimum self-assessed value (FRC) — the Gesell dust floor, so a name's deposit can't be dust. */
export async function minValueFrc() { return MIN_VALUE / 1e8; }

/** All live names on-chain, each with its current forced-sale price. Addressed by name HASH (the
 *  human name is not recoverable from the chain). The relay must expose `harbergernames`. */
export async function listNames() {
  const r = await idx().catch(() => { throw new Error(NEEDS_INDEXER); });
  return { names: (r || []).map(mapEntry), height: ctx.state?.mine?.height };
}

/** FORCED BUY a live name: pay its current price V to the owner and carry the deposit into a successor
 *  owned by me. Funded from my FRC coins; the HRBG input is anyone-can-spend (empty witness).
 *  @param {{name:string, label?:string|null, progress?:(p:string)=>void}} o */
export async function buyName({ name, label = null, progress = () => {} }) {
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
            out(V, covSpkOf(name)),                           // successor owned by me (carries V)
            ...(await carryMemos(name, { keepLabel: false, label })),   // name book, or boundary + YOUR name
            // deliberately NO binding, and no inherited plot name: taking a symbol does not inherit the previous holder's claim
            // about which asset it stands for — the new holder announces their own (or none).
            ...(change > 0n ? [out(change, ctx.spks[0])] : []) ] };
  tx.vin[0].witness = [];                                     // HRBG: anyone-can-spend
  picked.forEach((p, i) => signInput(tx, i + 1, p.spk, p.value, p.refheight, SIGHASH_ALL));
  progress('confirm');
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  markSpent([info.outpoint, ...picked.map(p => p.outpoint)]);
  save(load().filter(x => x.name !== name).concat({ name, value: Number(V) / 1e8, label, claimTxid: txid, at: Date.now() }));
  invalidateChainCaches();
  progress('done');
  return { txid, price: V };
}
