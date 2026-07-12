// market-view.mjs — the Freimarkets Issue + Exchange tabs, mounted inside the WALLET on the
// Freimarkets (nv3) network. Non-custodial: keys/signing on the client (the seed is handed in
// from the wallet's unlocked session via mvSetSeed), chain reads come from the wallet's own
// light client (ds().assets()), and the relay (:5181, proxied at /api) provides only the order
// book, issuance funding and broadcast — it can mislabel but never steal.
import { deriveAddress } from './wallet.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '../../../core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '../../../core/ecdsa.mjs';
import { segwitV0Sighash, rangedSighash, SIGHASH_ALL, SIGHASH_BUNDLE } from '../../../core/sighash.mjs';
import { serializeTx, NV3_TX_VERSION } from '../../../core/tx.mjs';
import { assetPresentValue } from '../../../core/assets.mjs';
import { tr, getLang } from './i18n.mjs';

const API = location.protocol === 'https:' ? `${location.origin}/api` : `http://${location.hostname}:5181/api`;
const HOST_TAG = '00'.repeat(20);
// kria per DISPLAY unit: FRC = 1e8 (8 decimals); user assets = 1 (indivisible integer tokens).
const scaleOf = tag => (tag == null || tag === HOST_TAG || tag === 'FRC') ? 100000000 : 1;
const ACCOUNT = "m/84'/1'/0'";              // nv3 = coin type 1 (Freimarkets shares the regtest branch)
const $ = s => document.querySelector(s);
const rev = h => h.match(/../g).reverse().join('');
const frc = v => (Number(BigInt(v)) / 1e8).toLocaleString('ru-RU', { maximumFractionDigits: 8 });
const toast = (m, cls = '') => { const t = $('#toast'); if (t) { t.textContent = m; t.className = 'show ' + cls; setTimeout(() => t.className = '', 3500); } };

let seed = null, km = {}, spks = [], myAddress = '', state = null, _ds = null;
// wired from the wallet: initMarketView(ds) injects its light source; mvSetSeed(hexSeed) on unlock.
export function initMarketView(ds) { _ds = ds; }
export function mvSetSeed(hexSeed) { seed = hexSeed; deriveKeys(); }
export function mvMyAddress() { return myAddress; }

async function api(path, body) {
  const r = await fetch(`${API}/${path}`, body ? { method: 'POST', body: JSON.stringify(body, (k, v) => typeof v === 'bigint' ? String(v) : v) } : undefined);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

// ---- keys: same vault, market derivation on the regtest branch ----
function deriveKeys() {
  const acct = derivePath(seed, ACCOUNT);
  km = {}; spks = [];
  for (const chain of [0, 1]) {
    const c = ckdPriv(acct, chain);
    for (let i = 0; i < 12; i++) {
      const node = ckdPriv(c, i);
      const spk = '0014' + wpkProgramHex(node);
      km[spk] = node; spks.push(spk);
    }
  }
  myAddress = deriveAddress(seed, 0, 0);
}
const signInput = (tx, i, spk, value, refheight, hashtype) => {
  const node = km[spk];
  const sec = node.priv.toString(16).padStart(64, '0');
  const code = '21' + pubkeyCompressed(sec) + 'ac';
  const sh = segwitV0Sighash(tx, i, code, BigInt(value), BigInt(refheight), hashtype);
  tx.vin[i].witness = [signEcdsa(sec, sh) + hashtype.toString(16).padStart(2, '0'), '00' + code, ''];
};

// ---- data ----
// asset RATES come from the light client's self-certified defs (tag = Hash160(def)); the
// relay's names are cosmetic (a lie only mislabels, it can't misprice).
// name preference: the light client's from-chain name (trustless, read from the defining block)
// first, then the relay's (untrusted, cosmetic), then the tag prefix. A name only ever mislabels.
const assetName = tag => tag === null || tag === HOST_TAG ? 'FRC'
  : (state?.defs?.[tag]?.name ?? state?.info.assets.find(a => a.tag === tag)?.name ?? tag.slice(0, 8) + '…');
const rateOf = tag => {
  if (tag === null || tag === HOST_TAG) return { k: 20, interest: false };
  const d = state?.defs?.[tag];                       // self-certified by the light client
  if (d) return { k: d.shift, interest: d.interest };
  const a = state?.info.assets.find(x => x.tag === tag);   // fallback: relay (untrusted, flagged)
  return a ? { k: a.shift, interest: a.interest } : { k: 20, interest: false };
};

// ---- trustless reads: the wallet's own light client (ds().assets()) gives per-asset UTXOs +
// self-certified defs (headers PoW-checked, BIP158 filters, block scan). The relay (/api) is
// used only for the order book, issuance funding, tx broadcast and mining — external roles.
let inflight = null;
// Pull the order book (relay) + my asset coins/defs (wallet light client), rebuild `state`, and
// repaint whatever Freimarkets surface is mounted. Serialized (concurrent syncs deadlock).
export function mvRefresh() {
  if (inflight) return inflight;
  inflight = doRefresh().catch(() => {}).finally(() => { inflight = null; });
  return inflight;
}
async function doRefresh() {
  if (!_ds || !seed) return;
  const [info, r] = await Promise.all([api('info'), _ds().assets()]);
  state = { info, defs: r.assetDefs, mine: { height: r.tipHeight, utxos: r.assetUtxos } };
  if ($('#bookBody')) paint();                 // Exchange tab mounted → repaint the book
  if ($('#assetBalBody')) paintAssetBalance(); // Freimarkets Balance tab mounted → per-asset table
  maybeResignRanged();                                      // keep my ranged offers alive after partial fills
}

// ---- actions ----
async function faucet() { try { await api('faucet', { address: myAddress }); toast(tr('Faucet: +1 FRC'), 'ok'); mvRefresh(); } catch (e) { toast(e.message, 'err'); } }

async function issue() {
  try {
    const name = $('#iName').value.trim() || 'актив';
    await api('issue', { name, shift: $('#iShift').value, interest: $('#iKind').value === 'i', amount: $('#iAmt').value, spk: spks[0] });
    $('#modal')?.remove();
    toast(`«${name}» ${tr('issued to your address')}`, 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- DEX phase 2b: RANGED offers (partial fills). The maker signs a DESCRIPTOR (a price ratio
// + fill bounds) over one give coin, NOT amounts; a taker fills any amount in range and the
// remainder returns as change, which the maker re-signs to keep trading. Any direction: give and
// want are any two DIFFERENT assets (FRC↔asset, asset↔asset). Amounts are in each asset's own
// units via scaleOf() (FRC = 1e8 kria/unit; user assets = 1 kria/unit).
// sign a ranged give input over the descriptor (SIGHASH_BUNDLE ⇒ the digest commits the
// descriptor, not the fill — one signature serves every admissible fill).
function signRangedGive(desc, giveOp, coin, L) {
  const node = km[coin.spk];
  const sec = node.priv.toString(16).padStart(64, '0');
  const code = '21' + pubkeyCompressed(sec) + 'ac';
  const give = { prevout: { txid: rev(giveOp.split(':')[0]), vout: +giveOp.split(':')[1] }, sequence: 0xffffffff };
  const HT = SIGHASH_ALL | SIGHASH_BUNDLE;
  const dg = rangedSighash({ vin: [give], desc, nExpireTime: desc.nExpireTime ?? 0 }, 0, code, BigInt(coin.value), BigInt(coin.refheight), { lockHeight: L, hashtype: HT });
  return [signEcdsa(sec, dg) + HT.toString(16).padStart(2, '0'), '00' + code, ''];
}

// outpoints that back my own OPEN ranged offers — reserved, so coin selection (new offers, fills,
// fees, cancels) never spends a coin out from under a live offer and orphans it.
const committedOutpoints = () => new Set((state?.info?.book || [])
  .filter(o => o.ranged && o.status === 'open' && spks.includes(o.makerSpk) && o.giveOutpoint)
  .map(o => o.giveOutpoint));

// my spendable coins of one asset (null tag = FRC), present-valued at height L, minus reserved ones
function myCoinsOf(tag, L, reserved = committedOutpoints()) {
  const norm = tag === HOST_TAG ? null : tag;
  return state.mine.utxos.filter(u => (u.assetTag ?? null) === norm && u.refheight <= L && !reserved.has(u.outpoint))
    .map(u => ({ outpoint: u.outpoint, spk: u.spk, value: BigInt(u.value), refheight: u.refheight,
                 pv: assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(norm)) }));
}

// Produce a single coin worth exactly Q of `giveTag` at height L to back an offer, so the sale is
// capped at Q and the rest stays the maker's (a separate coin, never in the offer). If one coin
// already IS the whole sale, use it; otherwise self-send the needed coins into [Q, rest, feeChange]
// and return the fresh Q-coin. Afterwards the tested single-input offer path is reused unchanged.
// Owned assets (for the wallet's Send selector): [{tag, name, qty}] — qty in display units.
export async function mvOwnedAssets() {
  if (!state) await doRefresh();
  const L = state.mine.height, byAsset = new Map();
  for (const u of state.mine.utxos) {
    const k = u.assetTag ?? null; if (k === null) continue;   // FRC is the wallet's own business
    byAsset.set(k, (byAsset.get(k) ?? 0n) + assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(k)));
  }
  return [...byAsset.entries()].map(([tag, pv]) => ({ tag, name: assetName(tag), qty: Number(pv) / scaleOf(tag) }));
}

// Send Q display-units of an asset to an address — the exchange's coin machinery with
// vout[0] pointed at the recipient instead of self. Fee rides a separate FRC coin.
export async function mvSendAsset(tag, qty, toSpk) {
  if (!state) await doRefresh();
  const L = state.mine.height, fee = 10000n, changeSpk = spks[0];
  const Q = BigInt(Math.round(qty * scaleOf(tag)));
  if (Q <= 0n) throw new Error(tr('enter an amount'));
  const coins = myCoinsOf(tag, L);
  if (coins.reduce((s, c) => s + c.pv, 0n) < Q) throw new Error(tr('amount exceeds available'));
  const picked = []; let S = 0n;
  for (const c of [...coins].sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0))) { picked.push(c); S += c.pv; if (S >= Q) break; }
  const opIn = c => ({ prevout: { txid: rev(c.outpoint.split(':')[0]), vout: +c.outpoint.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] });
  const inputs = [...picked];
  const vout = [{ value: Q, scriptPubKey: toSpk, assetTag: tag }];
  if (S - Q > 0n) vout.push({ value: S - Q, scriptPubKey: changeSpk, assetTag: tag });   // asset conserves exactly
  const reserved = committedOutpoints();
  const feeCoin = state.mine.utxos.find(x => (x.assetTag ?? null) === null && x.refheight <= L && !reserved.has(x.outpoint)
    && assetPresentValue(BigInt(x.value), L - x.refheight, { k: 20, interest: false }) >= fee + 1000n);
  if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
  const feePv = assetPresentValue(BigInt(feeCoin.value), L - feeCoin.refheight, { k: 20, interest: false });
  inputs.push({ outpoint: feeCoin.outpoint, spk: feeCoin.spk, value: BigInt(feeCoin.value), refheight: feeCoin.refheight });
  if (feePv - fee > 0n) vout.push({ value: feePv - fee, scriptPubKey: changeSpk, assetTag: HOST_TAG });
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(opIn), vout };
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  mvRefresh();
  return txid;
}

async function prepareGiveCoin(giveTag, Q, L, coins) {
  const isFrc = giveTag === HOST_TAG, fee = 10000n, changeSpk = spks[0];
  if (coins.length === 1 && coins[0].pv === Q) return { ...coins[0], L };   // sell one whole coin
  const picked = []; let S = 0n;                                            // greedy: largest first
  for (const c of [...coins].sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0))) { picked.push(c); S += c.pv; if (S >= Q) break; }
  const opIn = c => ({ prevout: { txid: rev(c.outpoint.split(':')[0]), vout: +c.outpoint.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] });
  const inputs = [...picked];                                              // signing order == vin order
  const vout = [{ value: Q, scriptPubKey: changeSpk, assetTag: giveTag }];  // vout[0] = the Q-coin
  if (isFrc) {
    const rest = S - Q - fee;                                              // FRC pays its own fee from surplus
    if (rest < 0n) throw new Error(tr('need a little more FRC to cover the fee'));
    if (rest > 0n) vout.push({ value: rest, scriptPubKey: changeSpk, assetTag: HOST_TAG });
  } else {
    if (S - Q > 0n) vout.push({ value: S - Q, scriptPubKey: changeSpk, assetTag: giveTag });   // asset conserves exactly
    const reserved = committedOutpoints();
    const feeCoin = state.mine.utxos.find(x => (x.assetTag ?? null) === null && x.refheight <= L && !reserved.has(x.outpoint) && assetPresentValue(BigInt(x.value), L - x.refheight, { k: 20, interest: false }) >= fee + 1000n);
    if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
    const feePv = assetPresentValue(BigInt(feeCoin.value), L - feeCoin.refheight, { k: 20, interest: false });
    inputs.push({ outpoint: feeCoin.outpoint, spk: feeCoin.spk, value: BigInt(feeCoin.value), refheight: feeCoin.refheight });
    if (feePv - fee > 0n) vout.push({ value: feePv - fee, scriptPubKey: changeSpk, assetTag: HOST_TAG });
  }
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(opIn), vout };
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'consolidate' });
  return { outpoint: `${txid}:0`, spk: changeSpk, value: Q, refheight: L, L };
}

async function postRangedOffer() {
  try {
    const giveTag = $('#rAsset').value === 'FRC' ? HOST_TAG : $('#rAsset').value;
    const wantTag = $('#rWant').value === 'FRC' ? HOST_TAG : $('#rWant').value;
    if (!giveTag) throw new Error(tr('no coins yet'));
    if (giveTag === wantTag) throw new Error(tr('give and want must be different assets'));
    const T = parseFloat($('#rPrice').value);   // TOTAL want for the whole quantity
    if (!(T > 0)) throw new Error(tr('enter a price'));
    const L = state.mine.height;
    const coins = myCoinsOf(giveTag, L);
    const total = coins.reduce((a, c) => a + c.pv, 0n);
    if (total <= 0n) throw new Error(tr('no coins of that asset'));
    const qtyAsked = parseFloat($('#rQty').value);
    let Q = BigInt(Math.round(qtyAsked * scaleOf(giveTag)));              // quantity in give units
    if (!(Q > 0n)) throw new Error(tr('enter a quantity'));
    // price ratio from the REQUESTED quantity (payout-kria per give-kria = T·wantScale / qty·giveScale):
    // a full fill pays exactly T; if the quantity gets capped below, the unit price holds.
    const priceNum = BigInt(Math.round(T * scaleOf(wantTag))), priceDen = BigInt(Math.round(qtyAsked * scaleOf(giveTag)));
    if (Q > total) Q = total;                                             // cap at the whole balance
    const give = await prepareGiveCoin(giveTag, Q, L, coins);
    const desc = { payoutAsset: wantTag, payoutScript: give.spk, priceNum, priceDen, changeScript: give.spk, minFill: 0n, maxFill: Q };
    const witness = signRangedGive(desc, give.outpoint, give, give.L);
    await api('rangedOffer', { makerSpk: give.spk, giveOutpoint: give.outpoint, desc, nExpireTime: 0, lockHeight: give.L, witness });
    $('#modal')?.remove();                 // close the offer modal on success
    toast(tr('Offer signed and posted'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// the offer form in a modal — the fields (#rAsset/#rWant) are filled by paint() once they exist
function openOfferModal() {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Post an offer')}</b><button id="offerClose" class="icon">✕</button></div>
    <div class="row"><label>${tr('I sell')}<select id="rAsset"></select></label><label>${tr('Quantity')}<input id="rQty" type="text" inputmode="decimal"></label></div>
    <div class="row"><label>${tr('I want')}<select id="rWant"></select></label><label>${tr('Total price')}<input id="rPrice" type="text" inputmode="decimal"></label></div>
    <button id="rOfferBtn">${tr('Post offer')}</button>
    <p class="sub" style="font-size:12px">${tr('Buyers fill any amount; the remainder keeps trading while you are online.')}</p></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };   // tap outside the card = close
  m.querySelector('#offerClose').onclick = () => m.remove();
  m.querySelector('#rOfferBtn').onclick = postRangedOffer;
  paint();                                 // populate #rAsset / #rWant now
}

// build + broadcast a partial fill of a ranged offer, in EITHER direction. The ranged bundle's
// [payout, change] are the first two outputs; the taker's fill + change follow. The maker's give
// input keeps its (fill-independent) SIGHASH_BUNDLE signature; the taker signs its own inputs.
// The taker pays `payout` in the want asset; the network fee is always in FRC (a separate coin
// when the want asset isn't FRC, else taken from the FRC payout's surplus).
async function fillRangedNow(offer, fillUnits) {
  try {
    const d = offer.desc;
    if (!offer.give) throw new Error(tr('offer coin is gone'));
    const L = offer.lockHeight, fee = 10000n, prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
    const giveTag = offer.give.assetTag ?? HOST_TAG;
    const payoutTag = d.payoutAsset ?? HOST_TAG;
    const isFrcPayout = payoutTag === HOST_TAG;
    const givePv = assetPresentValue(BigInt(offer.give.value), L - offer.give.refheight, rateOf(offer.give.assetTag));
    const priceNum = BigInt(d.priceNum), priceDen = BigInt(d.priceDen), minFill = BigInt(d.minFill), maxFill = BigInt(d.maxFill);
    let fill = BigInt(Math.round(fillUnits * scaleOf(giveTag)));   // amount to buy, in give units
    const cap = givePv < maxFill ? givePv : maxFill;
    if (fill > cap) fill = cap;
    if (fill < minFill) throw new Error(tr('amount is below the offer minimum'));
    const payout = (fill * priceNum + priceDen - 1n) / priceDen;   // rounded up (never short the maker)
    const change = givePv - fill;
    const pvAt = (c, rate) => assetPresentValue(BigInt(c.value), L - c.refheight, rate);
    const gather = (norm, rate, need, exclude) => {   // pick coins of one asset (largest first) covering `need`
      const pool = state.mine.utxos.filter(x => (x.assetTag ?? null) === norm && x.refheight <= L && !exclude.has(x.outpoint))
        .map(x => ({ outpoint: x.outpoint, spk: x.spk, value: BigInt(x.value), refheight: x.refheight, pv: pvAt(x, rate) }))
        .sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0));
      const got = []; let sum = 0n;
      for (const c of pool) { got.push(c); sum += c.pv; if (sum >= need) break; }
      return { got, sum };
    };
    // pay the maker in the want asset — combine as many of my coins as needed (covers the fee too
    // when want = FRC). No single "banknote" has to be big enough.
    const payRate = isFrcPayout ? { k: 20, interest: false } : rateOf(payoutTag);
    const payTagNorm = isFrcPayout ? null : payoutTag;
    const need = payout + (isFrcPayout ? fee : 0n);
    const reserved = committedOutpoints();   // don't spend coins backing my own open offers
    const { got: payCoins, sum: payPv } = gather(payTagNorm, payRate, need, reserved);
    if (payPv < need) throw new Error(isFrcPayout ? tr('you need more FRC (tap Faucet) to pay for this fill') : tr('you need more of the requested asset to pay for this fill'));
    const vin = [{ prevout: prevout(offer.giveOutpoint), scriptSig: '', sequence: 0xffffffff, witness: offer.witness }];
    const takerInputs = [];
    for (const c of payCoins) { vin.push({ prevout: prevout(c.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }); takerInputs.push(c); }
    const vout = [
      { value: payout, scriptPubKey: d.payoutScript, assetTag: payoutTag },   // [payout] to maker
      { value: change, scriptPubKey: d.changeScript, assetTag: giveTag },     // [change] to maker
      { value: fill, scriptPubKey: spks[0], assetTag: giveTag },              // fill to me
    ];
    const payChange = payPv - payout - (isFrcPayout ? fee : 0n);   // my want-asset change (fee taken here iff want=FRC)
    if (payChange > 0n) vout.push({ value: payChange, scriptPubKey: spks[0], assetTag: payoutTag });
    // when the want asset isn't FRC, add FRC coin(s) for the network fee
    if (!isFrcPayout) {
      const { got: feeCoins, sum: feePv } = gather(null, { k: 20, interest: false }, fee, new Set([...reserved, ...payCoins.map(c => c.outpoint)]));
      if (feePv < fee) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
      for (const c of feeCoins) { vin.push({ prevout: prevout(c.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }); takerInputs.push(c); }
      if (feePv - fee > 0n) vout.push({ value: feePv - fee, scriptPubKey: spks[0], assetTag: HOST_TAG });
    }
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin, vout,
      ranged: [{ nIn: 1, payoutAsset: payoutTag, payoutScript: d.payoutScript, priceNum, priceDen, changeScript: d.changeScript, minFill, maxFill, nExpireTime: offer.nExpireTime ?? 0 }],
    };
    takerInputs.forEach((c, i) => signInput(tx, i + 1, c.spk, c.value, c.refheight, SIGHASH_ALL));   // maker give at 0 already signed
    await api('tx', { rawtx: serializeTx(tx), kind: 'rangedfill', offerId: offer.id });
    toast(`${tr('Bought')} ${(Number(fill) / scaleOf(giveTag)).toLocaleString(getLang())} ${assetName(offer.give.assetTag)}`, 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// Cancel my ranged offer. A real cancel SPENDS the give coin back to me — the maker's descriptor
// signature is public, so only spending the coin makes the offer truly unfillable; then delist it.
async function cancelRanged(offer) {
  try {
    if (!spks.includes(offer.makerSpk)) throw new Error(tr('not your offer'));
    if (offer.give) {
      const L = state.mine.height, fee = 10000n, prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
      const giveTag = offer.give.assetTag ?? HOST_TAG, isFrc = giveTag === HOST_TAG;
      const givePv = assetPresentValue(BigInt(offer.give.value), L - offer.give.refheight, isFrc ? { k: 20, interest: false } : rateOf(giveTag));
      const vin = [{ prevout: prevout(offer.giveOutpoint), scriptSig: '', sequence: 0xffffffff, witness: [] }];
      const inputs = [{ spk: offer.makerSpk, value: BigInt(offer.give.value), refheight: offer.give.refheight }];
      const vout = [];
      if (isFrc) {
        if (givePv <= fee) throw new Error(tr('coin too small to cancel on-chain'));
        vout.push({ value: givePv - fee, scriptPubKey: spks[0], assetTag: HOST_TAG });
      } else {
        vout.push({ value: givePv, scriptPubKey: spks[0], assetTag: giveTag });
        const reserved = committedOutpoints();   // don't grab a coin backing another open offer
        const feeCoin = state.mine.utxos.find(x => (x.assetTag ?? null) === null && x.refheight <= L && !reserved.has(x.outpoint) && assetPresentValue(BigInt(x.value), L - x.refheight, { k: 20, interest: false }) >= fee + 1000n);
        if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) to cancel'));
        const feePv = assetPresentValue(BigInt(feeCoin.value), L - feeCoin.refheight, { k: 20, interest: false });
        vin.push({ prevout: prevout(feeCoin.outpoint), scriptSig: '', sequence: 0xffffffff, witness: [] });
        inputs.push({ spk: feeCoin.spk, value: BigInt(feeCoin.value), refheight: feeCoin.refheight });
        if (feePv - fee > 0n) vout.push({ value: feePv - fee, scriptPubKey: spks[0], assetTag: HOST_TAG });
      }
      const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin, vout };
      inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
      await api('tx', { rawtx: serializeTx(tx), kind: 'cancel' });
    }
    try { await api('cancel', { id: offer.id, makerSpk: offer.makerSpk }); } catch {}
    toast(tr('Offer cancelled'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// keep my own ranged offers alive: after a partial fill the relay re-points the offer at my
// change coin and flags it; I re-sign the descriptor over that coin (only I hold the key).
async function maybeResignRanged() {
  if (!state?.info?.book) return;
  for (const o of state.info.book) {
    if (!o.ranged || !o.needsResign || !spks.includes(o.makerSpk)) continue;
    const u = state.mine.utxos.find(x => x.outpoint === o.giveOutpoint);
    if (!u) continue;                    // the change coin isn't in my verified set yet
    const d = o.desc, L = state.mine.height;
    const desc = { payoutAsset: d.payoutAsset ?? HOST_TAG, payoutScript: d.payoutScript, priceNum: BigInt(d.priceNum), priceDen: BigInt(d.priceDen), changeScript: d.changeScript, minFill: BigInt(d.minFill), maxFill: BigInt(d.maxFill) };
    try {
      const witness = signRangedGive(desc, o.giveOutpoint, u, L);
      await api('resignRanged', { id: o.id, giveOutpoint: o.giveOutpoint, lockHeight: L, witness });
    } catch { /* next sync retries */ }
  }
}

// ---- UI ----
// render() builds the STATIC shell (nav, inputs, buttons) ONCE and wires handlers; paint()
// refreshes only the data regions (balances, order book, log, offer selects) every sync — so
// a periodic refresh never wipes what the user is typing.
const fmtA = (tag, v) => tag === 'FRC' ? frc(v) + ' FRC' : String(v) + ' ' + assetName(tag);
// The three Freimarkets surfaces mounted into the wallet's own tab sections (called by main.mjs
// on the nv3 network). Each builds its section and wires its handlers; data arrives via mvRefresh.
export function openIssueModal() {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Issue asset')}</b><button id="issClose" class="icon">✕</button></div>
    <p class="sub">${tr('Issue an asset that lives on the chain with its own demurrage (melts) or interest (grows) rate.')}</p>
    <label>${tr('Name')}<input id="iName" maxlength="24" placeholder="часы-труда"></label>
    <div class="row">
      <label>${tr('Rate k')}<input id="iShift" type="number" value="16" min="1" max="64"></label>
      <label>${tr('Type')}<select id="iKind"><option value="d">${tr('melts')}</option><option value="i">${tr('grows')}</option></select></label>
    </div>
    <label>${tr('Quantity')}<input id="iAmt" type="number" value="1000000"></label>
    <button id="issueBtn">${tr('Issue asset')}</button></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  m.querySelector('#issClose').onclick = () => m.remove();
  m.querySelector('#issueBtn').onclick = issue;
}
export function renderExchange(el) {
  el.innerHTML = `
    <div class="row"><button id="openOffer">${tr('Post an offer')}</button></div>
    <p class="label" style="margin-top:14px">${tr('Order book')}</p>
    <div class="row">
      <label>${tr('Selling')}<select id="fGive"></select></label>
      <label>${tr('Wants')}<select id="fWant"></select></label>
    </div>
    <label class="chk"><input type="checkbox" id="fOpen" checked>${tr('open only')}</label>
    <table class="mkt"><thead><tr><th>#</th><th>${tr('Give')}</th><th>${tr('Want')}</th><th></th></tr></thead><tbody id="bookBody"><tr><td colspan="4" class="sub">${tr('first sync…')}</td></tr></tbody></table>`;
  $('#openOffer').onclick = openOfferModal;
  ['#fGive', '#fWant', '#fOpen'].forEach(s => { const e = $(s); if (e) e.onchange = paint; });
  if (state) paint(); else mvRefresh();
}
// per-asset balance table (FRC + user assets) — the wallet's Balance tab shows this on nv3
const skelRows = n => Array.from({ length: n }, () =>
  '<tr><td><div class="skel-line" style="height:16px;width:70%;margin:4px 0"></div></td><td><div class="skel-line" style="height:16px;width:45%;margin:4px 0 4px auto"></div></td></tr>').join('');
export function renderAssetBalance(el) {
  el.innerHTML = `
    <table class="mkt"><thead><tr><th>${tr('Asset')}</th><th class="r">${tr('Quantity')}</th></tr></thead><tbody id="assetBalBody">${skelRows(3)}</tbody></table>`;
  const f = $('#faucetBtn'); if (f) f.onclick = faucet;   // the button itself lives with the other Balance actions
  if (state) paintAssetBalance(); else mvRefresh();
}
function paintAssetBalance() {
  const body = $('#assetBalBody'); if (!body || !state) return;
  const h = state.mine.height;
  const pvU = u => assetPresentValue(BigInt(u.value), h - u.refheight, rateOf(u.assetTag));
  const byAsset = new Map();
  for (const u of state.mine.utxos) { const k = u.assetTag ?? 'FRC'; const e = byAsset.get(k) ?? { nominal: 0n, pv: 0n }; e.nominal += BigInt(u.value); e.pv += pvU(u); byAsset.set(k, e); }
  const amt = (tag, v) => tag === 'FRC' ? frc(v) : String(v);
  body.innerHTML = [...byAsset.entries()].map(([tag, e]) => {
    const melt = e.pv < e.nominal, grow = e.pv > e.nominal;
    return `<tr><td${tag === 'FRC' ? '' : ` title="${tag}"`}>${assetName(tag === 'FRC' ? null : tag)}</td><td class="r ${melt ? 'melt' : grow ? 'grow' : ''}">${amt(tag, e.pv)}</td></tr>`;
  }).join('') || `<tr><td colspan="2" class="sub">${tr('empty — tap Faucet')}</td></tr>`;
}

// fill a <select> preserving the current selection (so a refresh doesn't reset it)
function setOptions(sel, html) {
  const el = $(sel); if (!el) return;
  const cur = el.value; el.innerHTML = html;
  if ([...el.options].some(o => o.value === cur)) el.value = cur;
}
function paint() {
  if (!state || !$('#bookBody')) return;
  const h = state.mine.height;
  const pvU = u => assetPresentValue(BigInt(u.value), h - u.refheight, rateOf(u.assetTag));
  const byAsset = new Map();
  for (const u of state.mine.utxos) {
    const k = u.assetTag ?? 'FRC';
    const e = byAsset.get(k) ?? { nominal: 0n, pv: 0n };
    e.nominal += BigInt(u.value); e.pv += pvU(u);
    byAsset.set(k, e);
  }

  // grouped asset options (used by the offer form and the filters): the host currency in a
  // Currency group, user-issued assets in an Assets group.
  const assetOpts = state.info.assets.map(a => `<option value="${a.tag}">${assetName(a.tag)}</option>`).join('');
  const grouped = curOpt => `<optgroup label="${tr('Currency')}">${curOpt}</optgroup>`
    + (assetOpts ? `<optgroup label="${tr('Assets')}">${assetOpts}</optgroup>` : '');

  // "I sell": only the assets I actually hold, with my balance (present value, in units)
  const sellOpt = ([k, e]) => `<option value="${k}">${assetName(k === 'FRC' ? null : k)} (${(Number(e.pv) / scaleOf(k)).toLocaleString(getLang())})</option>`;
  const frcHeld = byAsset.get('FRC'), heldAssets = [...byAsset.entries()].filter(([k]) => k !== 'FRC');
  setOptions('#rAsset', ((frcHeld ? `<optgroup label="${tr('Currency')}">${sellOpt(['FRC', frcHeld])}</optgroup>` : '')
    + (heldAssets.length ? `<optgroup label="${tr('Assets')}">${heldAssets.map(sellOpt).join('')}</optgroup>` : ''))
    || `<option value="">${tr('no coins yet')}</option>`);
  setOptions('#rWant', grouped('<option value="FRC">FRC</option>'));

  // order-book filters (grouped the same way; 'all' stays ungrouped at the top)
  const fopt = `<option value="">${tr('all')}</option>` + grouped('<option value="FRC">FRC</option>');
  setOptions('#fGive', fopt); setOptions('#fWant', fopt);

  // skip repainting the book while a fill amount is being typed into it (else the 15s refresh
  // wipes the input) — same reason the offer selects are preserved.
  if (!$('#bookBody').contains(document.activeElement)) {
    const giveOf = o => o.give ? (o.give.assetTag ?? 'FRC') : '';
    const wantOf = o => o.ranged ? ((o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : 'FRC') : (o.want?.assetTag ?? 'FRC');
    const fg = $('#fGive')?.value || '', fw = $('#fWant')?.value || '', fo = $('#fOpen')?.checked;
    const bookRow = o => {
      const mine = spks.includes(o.makerSpk);
      const give = o.give ? fmtA(o.give.assetTag ?? 'FRC', BigInt(o.give.pv)) : '—';
      if (o.ranged) {
        const wantTag = (o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : null;
        const giveTag = o.give ? (o.give.assetTag ?? null) : null;
        // desc price is a kria/kria ratio; convert to want-units per give-unit for display
        const price = Number(BigInt(o.desc.priceNum)) / Number(BigInt(o.desc.priceDen)) * scaleOf(giveTag) / scaleOf(wantTag);
        const maxU = o.give ? Number(BigInt(o.give.pv)) / scaleOf(giveTag) : 0;
        const act = mine
          ? (o.status === 'open' ? `${tr('mine')} <button class="rcancel" data-id="${o.id}">${tr('Cancel')}</button>` : `${tr('mine')} ${o.status}`)
          : (o.status === 'open' && o.give && !o.needsResign)
            ? `<span class="fillbox"><input class="rfill" data-id="${o.id}" type="text" inputmode="decimal" placeholder="${maxU}"><button class="rbtn" data-id="${o.id}">${tr('Buy')}</button></span>`
            : o.status;
        return `<tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td><td>${give}</td>
          <td>@ ${price.toLocaleString(getLang(), { maximumFractionDigits: 8 })} ${assetName(wantTag)}</td><td>${act}</td></tr>`;
      }
      return `<tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td><td>${give}</td>
        <td>${fmtA(o.want.assetTag ?? 'FRC', BigInt(o.want.value))}</td><td>${mine ? tr('mine') : ''} ${o.status}</td></tr>`;
    };
    const rows = state.info.book.filter(o => (!fg || giveOf(o) === fg) && (!fw || wantOf(o) === fw) && (!fo || o.status === 'open')).reverse();
    $('#bookBody').innerHTML = rows.map(bookRow).join('')
      || `<tr><td colspan="4" class="sub">${state.info.book.length ? tr('no offers match') : tr('no offers yet')}</td></tr>`;
    $('#bookBody').querySelectorAll('.rbtn').forEach(b => b.onclick = () => {
      const id = +b.dataset.id, offer = state.info.book.find(o => o.id === id);
      const inp = $(`.rfill[data-id="${id}"]`), amt = parseFloat(inp?.value || inp?.placeholder || '0');
      if (offer && amt > 0) fillRangedNow(offer, amt);
    });
    $('#bookBody').querySelectorAll('.rcancel').forEach(b => b.onclick = () => {
      const offer = state.info.book.find(o => o.id === +b.dataset.id);
      if (offer) cancelRanged(offer);
    });
  }
}
