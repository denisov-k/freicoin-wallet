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
import { sha256, hash160 } from '../../../core/crypto.mjs';
import { frcLeg, refundGiven, claimReceived } from '../../../core/swap.mjs';
import { paymentHashOf, htlcClaimAsset } from '../../../core/htlc.mjs';
import { btcHtlcClaim, btcAddress, btcHtlcRefund, btcHtlcLeaf, btcHtlcAddress, btcP2wpkhAddress, btcP2wpkhSpk, btcDecodeAddress, btcP2wpkhSend } from '../../../core/btc.mjs';
import { tr, getLang } from './i18n.mjs';

const API = location.protocol === 'https:' ? `${location.origin}/api` : `http://${location.hostname}:5181/api`;
const HOST_TAG = '00'.repeat(20);
// kria per DISPLAY unit: FRC = 1e8 (8 decimals); user assets = 10^decimals from their
// self-certified name suffix (legacy assets without one are indivisible integer tokens).
const decimalsOf = tag => Number(state?.defs?.[tag]?.decimals ?? state?.info?.assets?.find(a => a.tag === tag)?.decimals ?? 0);
const scaleOf = tag => (tag == null || tag === HOST_TAG || tag === 'FRC') ? 100000000 : 10 ** decimalsOf(tag);
const ACCOUNT = "m/84'/1'/0'";              // nv3 = coin type 1 (Freimarkets shares the regtest branch)
/** @type {(s: string) => any} */   // any: elements are used dynamically (.onclick/.value); checkJs would else flag Element
const $ = s => document.querySelector(s);
/** @type {(el: any, s: string) => any} */
const q = (el, s) => el.querySelector(s);
const rev = h => h.match(/../g).reverse().join('');
const frc = v => (Number(BigInt(v)) / 1e8).toLocaleString('ru-RU', { maximumFractionDigits: 8 });
const num = v => parseFloat(String(v ?? '').replace(',', '.'));   // locale-tolerant: accept a comma decimal separator
const toast = (m, cls = '') => { const t = $('#toast'); if (t) { t.textContent = m; t.className = 'show ' + cls; setTimeout(() => t.className = '', 3500); } };

let seed = null, km = {}, spks = [], myAddress = '', state = null, _ds = null;
// wired from the wallet: initMarketView(ds) injects its light source; mvSetSeed(hexSeed) on unlock.
export function initMarketView(ds) { _ds = ds; }
export function mvSetSeed(hexSeed) { seed = hexSeed; deriveKeys(); }
export function mvMyAddress() { return myAddress; }

// Relay-known asset names (UNVERIFIED — display fallback only; scan-verified defs win).
export const mvRelayAssets = () => api('info').then(i => i.assets || []);
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
  const [info, r, swap, p2p] = await Promise.all([api('info'), _ds().assets(), api('swapInfo').catch(() => null), api('p2pList').catch(() => null)]);
  // A wiped/replaced test chain invalidates every local swap record — detect via the genesis hash
  // and drop them, or ghosts of the old chain's swaps haunt the balance/activity forever.
  try {
    // versioned marker: v2 forces ONE clear on devices where an earlier build recorded the new
    // chainId without clearing (its guard skipped pre-feature records) — then behaves normally
    const mark = 'v2:' + info.chainId;
    if (info.chainId && localStorage.getItem('fw_mkt_chain') !== mark) {
      // NB: fw_btc_nonces survives — it derives BTC-side addresses, and the BTC chain (signet)
      // is NOT wiped with the test chain; dropping it would orphan real proceeds.
      for (const k of ['fw_p2p', 'fw_swap_hist', 'fw_swaps', 'fw_reldefs']) localStorage.removeItem(k);
      localStorage.setItem('fw_mkt_chain', mark);
      btcRecoveredKey = '';   // let recovery re-run against the new chain
    }
  } catch {}
  state = { info, defs: r.assetDefs, mine: { height: r.tipHeight, utxos: r.assetUtxos }, swap, p2p };
  // cache relay defs for the light client's next boot (seedDefs) — rates for history valuation
  try { localStorage.setItem('fw_reldefs', JSON.stringify(Object.fromEntries(
    (info.assets || []).map(a => [a.tag, { shift: a.shift, interest: a.interest, name: a.name, decimals: a.decimals }])))); } catch {}
  if ($('#bookBody')) paint();                 // Exchange tab mounted → repaint the book
  if ($('#assetBalBody')) paintAssetBalance(); // Freimarkets Balance tab mounted → per-asset table
  maybeResignRanged();                                      // keep my ranged offers alive after partial fills
  checkMySwaps();                                           // refund any of my swaps stalled past their timeout
  driveP2p();                                               // advance my P2P swaps (both roles) on my turn
  refreshBtc();                                             // refresh the in-wallet BTC balance (watch-only)
}

// ---- actions ----
async function faucet() { try { await api('faucet', { address: myAddress }); toast(tr('Faucet: +1 FRC'), 'ok'); mvRefresh(); } catch (e) { toast(e.message, 'err'); } }

async function issue() {
  try {
    const name = $('#iName').value.trim() || 'актив';
    // 'constant' = shift-64 INTEREST: growth of 2^-64/block floors to exactly zero at any age
    // and any amount — truly flat. (The demurrage side would round ONE base unit off, which
    // on a whole-unit asset is a visible token.)
    const kind = $('#iKind').value;
    await api('issue', { name, shift: kind === 'c' ? 64 : Math.min(63, Math.max(1, Math.round(+$('#iShift').value || 16))), interest: kind === 'i' || kind === 'c', amount: $('#iAmt').value, decimals: $('#iDec')?.value ?? 0, spk: spks[0] });
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

// spendable FRC (kria), present-valued, EXCLUDING coins that back my open ranged offers — this is
// exactly what sendFrcToSpk can gather to fund a swap HTLC. The offer modal shows it so a maker
// can't post a P2P swap larger than they can actually lock (which stalls the swap at 'taken').
const freeFrcKria = () => {
  if (!state) return 0n;
  const L = state.mine.height, reserved = committedOutpoints();
  return state.mine.utxos
    .filter(u => (u.assetTag ?? null) === null && u.refheight <= L && !reserved.has(u.outpoint))
    .reduce((a, u) => a + assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }), 0n);
};

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
  return [...byAsset.entries()].map(([tag, pv]) => ({ tag, name: assetName(tag), qty: Number(pv) / scaleOf(tag), decimals: decimalsOf(tag) }));
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

// Pre-signed offer LADDER: one rung every LADDER_STEP blocks out to LADDER_SPAN (~24h at
// 20s blocks); desc.nExpireTime = the last rung, so the offer dies where the signatures end.
// An OFFLINE maker's offer stays fillable until then (first fill only — the remainder is a
// new coin no pre-signed rung can cover; the maker re-ladders it when back online). While
// online, maybeResignRanged still tops the ladder up with a tip rung for 1-block freshness.
const LADDER_STEP = 10, LADDER_SPAN = 4320;
// Rungs sit on the ABSOLUTE grid (heights divisible by LADDER_STEP) plus one rung at the
// exact posting height: two offers' ladders then share heights, which is what lets a matcher
// splice them into ONE tx (both ranged signatures must commit the same lock_height).
async function signLadder(desc, coin, giveOutpoint, fromL, toL) {
  const rungs = [fromL];
  for (let Li = Math.floor(fromL / LADDER_STEP + 1) * LADDER_STEP; Li <= toL; Li += LADDER_STEP) rungs.push(Li);
  const ladder = [];
  for (let i = 0; i < rungs.length; i++) {
    ladder.push({ lockHeight: rungs[i], witness: signRangedGive(desc, giveOutpoint, coin, rungs[i]) });
    if (i % 32 === 31) await new Promise(r => setTimeout(r));   // yield — keep the UI alive
  }
  return ladder;
}

async function postRangedOffer() {
  try {
    // I sell = BTC ⇒ REVERSE cross-chain swap: sell BTC for FRC at MY price (BTC qty → FRC wanted).
    if ($('#rAsset').value === 'BTC') {
      const btcQ = num($('#rQty').value), wantV = num($('#rPrice').value);
      const wantTag = $('#rWant').value === 'FRC' ? null : $('#rWant').value;   // FRC or a constant asset to BUY
      if (!(btcQ > 0)) throw new Error(tr('enter a quantity'));
      if (!(wantV > 0)) throw new Error(tr('enter a quantity'));
      const bal = mvBtc().balance, maxSats = bal ? BigInt(bal) - 1000n : 0n;
      if (BigInt(Math.round(btcQ * 1e8)) > maxSats)
        throw new Error(`${tr('only')} ${(Number(maxSats > 0n ? maxSats : 0n) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC ${tr('free to lock (rest backs your open offers)')}`);
      $('#modal')?.remove();
      return postP2pOfferB(btcQ, wantV, wantTag);
    }
    // want = BTC ⇒ post a P2P swap offer at YOUR price (FRC quantity → BTC amount). The board
    // matches it with a taker; the HTLC dance runs non-custodially. (Not a ranged offer.)
    if ($('#rWant').value === 'BTC') {
      const sell = $('#rAsset').value, btcQ = num($('#rPrice').value);
      if (!(btcQ > 0)) throw new Error(tr('enter a quantity'));
      if (sell !== 'FRC') {   // sell a user-issued CONSTANT asset for BTC
        const qty = num($('#rQty').value);
        const units = BigInt(Math.round(qty * scaleOf(sell)));
        if (!(units > 0n)) throw new Error(tr('enter a quantity'));
        const held = myCoinsOf(sell, state.mine.height).reduce((s, c) => s + c.pv, 0n);
        if (units > held) throw new Error(`${tr('only')} ${(Number(held) / scaleOf(sell)).toLocaleString(getLang())} ${assetName(sell)} ${tr('free to lock (rest backs your open offers)')}`);
        $('#modal')?.remove();
        return postP2pOffer(qty, btcQ, sell);
      }
      const frcQ = num($('#rQty').value);
      if (!(frcQ > 0)) throw new Error(tr('enter a quantity'));
      const maxK = freeFrcKria() - 10000n;                             // fee-reserved free FRC
      if (BigInt(Math.round(frcQ * 1e8)) > maxK)                       // can't lock more than we have free
        throw new Error(`${tr('only')} ${frc(maxK > 0n ? maxK : 0n)} FRC ${tr('free to lock (rest backs your open offers)')}`);
      $('#modal')?.remove();
      return postP2pOffer(frcQ, btcQ);
    }
    const giveTag = $('#rAsset').value === 'FRC' ? HOST_TAG : $('#rAsset').value;
    const wantTag = $('#rWant').value === 'FRC' ? HOST_TAG : $('#rWant').value;
    if (!giveTag) throw new Error(tr('no coins yet'));
    if (giveTag === wantTag) throw new Error(tr('give and want must be different assets'));
    const T = num($('#rPrice').value);   // TOTAL want for the whole quantity
    if (!(T > 0)) throw new Error(tr('enter a price'));
    const L = state.mine.height;
    const coins = myCoinsOf(giveTag, L);
    const total = coins.reduce((a, c) => a + c.pv, 0n);
    if (total <= 0n) throw new Error(tr('no coins of that asset'));
    const qtyAsked = num($('#rQty').value);
    let Q = BigInt(Math.round(qtyAsked * scaleOf(giveTag)));              // quantity in give units
    if (!(Q > 0n)) throw new Error(tr('enter a quantity'));
    // price ratio from the REQUESTED quantity (payout-kria per give-kria = T·wantScale / qty·giveScale):
    // a full fill pays exactly T; if the quantity gets capped below, the unit price holds.
    const priceNum = BigInt(Math.round(T * scaleOf(wantTag))), priceDen = BigInt(Math.round(qtyAsked * scaleOf(giveTag)));
    if (Q > total) Q = total;                                             // cap at the whole balance
    const partial = $('#rPartial')?.checked ?? true;                      // unchecked ⇒ all-or-nothing (minFill = the whole lot)
    const give = await prepareGiveCoin(giveTag, Q, L, coins);
    const expireAt = give.L + LADDER_SPAN;
    const desc = { payoutAsset: wantTag, payoutScript: give.spk, priceNum, priceDen, changeScript: give.spk, minFill: partial ? 0n : Q, maxFill: Q, nExpireTime: expireAt };
    toast(tr('signing the offer ladder…'));
    const ladder = await signLadder(desc, give, give.outpoint, give.L, expireAt);
    await api('rangedOffer', { makerSpk: give.spk, giveOutpoint: give.outpoint, desc, nExpireTime: expireAt, lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder });
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
    <div class="row offer-row"><label>${tr('I sell')}<select id="rAsset"></select></label><label class="numfield">${tr('Quantity')}<input id="rQty" type="text" inputmode="decimal"></label></div>
    <div class="row offer-row"><label>${tr('I want')}<select id="rWant"></select></label><label id="rPriceLbl" class="numfield">${tr('Quantity')}<input id="rPrice" type="text" inputmode="decimal"></label></div>
    <label class="chk" id="rPartialLbl"><input type="checkbox" id="rPartial" checked>${tr('allow partial fills')}</label>
    <button id="rOfferBtn">${tr('Post offer')}</button>
    <p class="sub" style="font-size:12px" id="rHint">${tr('Buyers fill any amount; the remainder keeps trading while you are online.')}</p></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };   // tap outside the card = close
  q(m, '#offerClose').onclick = () => m.remove();
  q(m, '#rOfferBtn').onclick = postRangedOffer;
  q(m, '#rPartial').onchange = e => { $('#rHint').textContent = e.target.checked
    ? tr('Buyers fill any amount; the remainder keeps trading while you are online.')
    : tr('The offer can only be taken whole — one buyer, the full quantity.'); };
  // update the "Free to lock" hint for a →BTC swap based on what's selected in "I sell"
  const swapHint = () => {
    const sell = $('#rAsset').value, pre = tr('You post a swap offer at your price; a taker fills it non-custodially (refundable).');
    let free;
    if (sell === 'BTC') { const b = mvBtc().balance, s = b ? BigInt(b) - 1000n : 0n; free = `${(Number(s > 0n ? s : 0n) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC`; }
    else if (sell === 'FRC') { const k = freeFrcKria() - 10000n; free = `${frc(k > 0n ? k : 0n)} FRC`; }
    else { const pv = myCoinsOf(sell, state.mine.height).reduce((s, c) => s + c.pv, 0n); free = `${(Number(pv) / scaleOf(sell)).toLocaleString(getLang())} ${assetName(sell)}`; }
    $('#rHint').innerHTML = `${pre}<br><b>${tr('Free to lock')}: ${free}</b>`;
  };
  // I sell = BTC ⇒ reverse swap (want FRC). I sell = FRC/asset with want=BTC ⇒ forward swap.
  q(m, '#rAsset').onchange = e => {
    if (e.target.value === 'BTC') {   // sell BTC → want FRC or a CONSTANT asset (buy that asset)
      const consts = (state.info.assets || []);   // any user-issued asset (melt/grow settle via present value)
      setOptions('#rWant', '<option value="FRC">FRC</option>' + consts.map(a => `<option value="${a.tag}">${assetName(a.tag)}</option>`).join(''));
      $('#rPartialLbl').hidden = true; $('#rPriceLbl').childNodes[0].textContent = tr('Quantity'); swapHint(); return;
    }
    if ($('#rWant').value === 'BTC') { swapHint(); return; }             // still a →BTC swap, just a different sell asset
    paint(); $('#rPartialLbl').hidden = false; $('#rHint').textContent = tr('Buyers fill any amount; the remainder keeps trading while you are online.');
  };
  // want = BTC ⇒ cross-chain swap: no partial; sell side may be FRC or a held CONSTANT asset.
  q(m, '#rWant').onchange = e => {
    const btc = e.target.value === 'BTC';
    $('#rPartialLbl').hidden = btc;
    $('#rPriceLbl').childNodes[0].textContent = tr('Quantity');   // the want field IS your price
    if (btc) {
      const consts = heldConstAssets();
      setOptions('#rAsset', '<option value="FRC">FRC</option>'
        + consts.map(([t, pv]) => `<option value="${t}">${assetName(t)} (${(Number(pv) / scaleOf(t)).toLocaleString(getLang())})</option>`).join(''));
      swapHint();
    } else {
      $('#rHint').textContent = tr('Buyers fill any amount; the remainder keeps trading while you are online.');
    }
  };
  paint();                                 // populate #rAsset / #rWant now
}
// held user-issued assets with present-valued balance — all are swappable for BTC (melt/grow settle at claim)
function heldConstAssets() {
  const L = state.mine.height, m = new Map();
  for (const u of state.mine.utxos) {
    const t = u.assetTag ?? null; if (!t) continue;   // any held user-issued asset is swappable
    m.set(t, (m.get(t) ?? 0n) + assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(t)));
  }
  return [...m.entries()];
}

// ---- cross-chain swap FRC → BTC (relay = BTC liquidity bot; we stay non-custodial) ----
// deterministic swap keys from the wallet seed (kept off the payment path — a swap key leak
// never touches wallet funds), one FRC key + one BTC key per swap id.
const swapPriv = (id, leg) => sha256(Buffer.from(seed + 'fw-swap:' + id + ':' + leg, 'utf8')).toString('hex');

// Persisted swap records — the SAFETY NET: whatever the relay or the network does, a swap we
// funded is refundable from these (+ the seed) after its T1. Survives reloads.
const SWAP_LS = 'fw_swaps';
const loadMySwaps = () => { try { return JSON.parse(localStorage.getItem(SWAP_LS) || '[]'); } catch { return []; } };
const saveMySwaps = a => { try { localStorage.setItem(SWAP_LS, JSON.stringify(a)); } catch {} };
const putMySwap = rec => { const a = loadMySwaps().filter(x => x.id !== rec.id); a.push(rec); saveMySwaps(a); };
const dropMySwap = id => saveMySwaps(loadMySwaps().filter(x => x.id !== id));

// Reconcile my funded swaps against the chain: settled ones drop; any still-unspent FRC HTLC
// past its T1 is refunded back to me (relay down, counterparty vanished — funds come home).
async function checkMySwaps() {
  const mine = loadMySwaps();
  if (!mine.length || !state) return;
  const h = state.mine.height;
  for (const w of mine) {
    try {
      // is the FRC HTLC coin still unspent? ask the relay's index for the HTLC spk.
      const r = await api('utxos', { spks: [w.spk] });
      const live = (r.utxos || []).find(u => u.outpoint === `${w.funding.txid}:${w.funding.vout}`);
      if (!live) { dropMySwap(w.id); continue; }          // spent → swap settled (or already refunded)
      if (h <= w.T1 + 1) continue;                        // not yet refundable — CLTV not reached
      const key = swapPriv(w.nonce, 'frc');
      const rf = refundGiven({ funding: { txid: w.funding.txid, vout: w.funding.vout, value: BigInt(w.funding.value), refheight: w.funding.refheight },
        leaf: w.leaf, cltv: w.T1, ourKey: key, toSpk: spks[0], fee: 10000n });
      await api('tx', { rawtx: rf.rawtx, kind: 'send' });
      dropMySwap(w.id);
      toast(`${tr('swap refunded')}: ${Number(BigInt(w.funding.value)) / 1e8} FRC`, 'ok');
      mvRefresh();
    } catch { /* coin gone or too early — retry next cycle */ }
  }
}
const opIn = op => ({ prevout: { txid: rev(op.split(':')[0]), vout: +op.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] });

// pay `amount` kria of FRC to an arbitrary scriptPubKey (funds the FRC HTLC). Fee + change to us.
async function sendFrcToSpk(spk, amount) {
  const L = state.mine.height, fee = 10000n, reserved = committedOutpoints();
  const coins = state.mine.utxos.filter(u => (u.assetTag ?? null) === null && u.refheight <= L && !reserved.has(u.outpoint))
    .map(u => ({ outpoint: u.outpoint, spk: u.spk, value: BigInt(u.value), refheight: u.refheight,
                 pv: assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) }))
    .sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += c.pv; if (S >= amount + fee) break; }
  if (S < amount + fee) throw new Error(tr('not enough FRC for this swap'));
  const vout = [{ value: amount, scriptPubKey: spk, assetTag: HOST_TAG }];
  if (S - amount - fee > 0n) vout.push({ value: S - amount - fee, scriptPubKey: spks[0], assetTag: HOST_TAG });
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: picked.map(c => opIn(c.outpoint)), vout };
  picked.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  return { txid, vout: 0 };
}

// pick an unreserved host coin worth ≥ `need` (present value) for a network fee, with the material
// the asset-HTLC spend builder needs (its private key + witness scriptCode).
function hostFeeCoin(L, need, reserved = committedOutpoints()) {
  const c = state.mine.utxos.find(u => (u.assetTag ?? null) === null && u.refheight <= L && !reserved.has(u.outpoint)
    && assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) >= need);
  if (!c) return null;
  const sec = km[c.spk].priv.toString(16).padStart(64, '0');
  const [txid, vout] = c.outpoint.split(':');
  return { txid, vout: +vout, value: BigInt(c.value), refheight: c.refheight, spk: c.spk,
    pv: assetPresentValue(BigInt(c.value), L - c.refheight, { k: 20, interest: false }),
    key: sec, script: '21' + pubkeyCompressed(sec) + 'ac', changeSpk: spks[0] };
}

// lock exactly `amount` base units of `tag` into the HTLC spk. Like mvSendAsset but paying an HTLC
// (asset conserves; the fee is a separate host coin). Returns the funding outpoint for the swap.
async function lockAssetToHtlc(spk, tag, amount) {
  const L = state.mine.height, fee = 10000n, reserved = committedOutpoints();
  const coins = myCoinsOf(tag, L, reserved);
  if (coins.reduce((s, c) => s + c.pv, 0n) < amount) throw new Error(tr('not enough of that asset'));
  const picked = []; let S = 0n;
  for (const c of [...coins].sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0))) { picked.push(c); S += c.pv; if (S >= amount) break; }
  const feeCoin = hostFeeCoin(L, fee + 1000n, new Set([...reserved, ...picked.map(c => c.outpoint)]));
  if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
  const vout = [{ value: amount, scriptPubKey: spk, assetTag: tag }];
  if (S - amount > 0n) vout.push({ value: S - amount, scriptPubKey: spks[0], assetTag: tag });   // asset change
  if (feeCoin.pv - fee > 0n) vout.push({ value: feeCoin.pv - fee, scriptPubKey: spks[0], assetTag: HOST_TAG });   // host change
  const inputs = [...picked.map(c => ({ outpoint: c.outpoint, spk: c.spk, value: c.value, refheight: c.refheight })),
    { outpoint: `${feeCoin.txid}:${feeCoin.vout}`, spk: feeCoin.spk, value: feeCoin.value, refheight: feeCoin.refheight }];
  const tx = { version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(c => opIn(c.outpoint)), vout };
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  return { txid, vout: 0, value: String(amount), refheight: L };
}

function openSwapModal(prefill) {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Swap FRC → BTC')}</b><button id="swClose" class="icon">✕</button></div>
    <label>${tr('FRC to swap')}<input id="swAmt" type="text" inputmode="decimal" value="${(prefill > 0 ? prefill : 1)}"></label>
    <div class="rrow"><span>${tr('You receive')}</span><b id="swGet">—</b></div>
    <button id="swGo">${tr('Start swap')}</button>
    <div id="swLog" class="sub" style="font-size:12px;white-space:pre-line"></div>
    <p class="warn" style="font-size:12px">${tr('Experimental, on the test chains. Your FRC is refundable if the swap stalls.')}</p></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#swClose').onclick = () => m.remove();
  let rate = 0.2;
  api('swapInfo').then(s => { rate = s.rate; upd(); }).catch(() => {});
  const upd = () => { const a = num($('#swAmt').value) || 0; $('#swGet').textContent = (a * rate).toLocaleString(getLang(), { maximumFractionDigits: 8 }) + ' BTC'; };
  q(m, '#swAmt').oninput = upd;
  q(m, '#swGo').onclick = () => runSwap(num($('#swAmt').value));
}

async function runSwap(frcUnits) {
  const log = t => { const el = $('#swLog'); if (el) el.textContent += (el.textContent ? '\n' : '') + t; };
  const go = $('#swGo'); if (go) { go.disabled = true; go.textContent = tr('swapping…'); }
  try {
    if (!(frcUnits > 0)) throw new Error(tr('enter an amount'));
    const frcAmount = BigInt(Math.round(frcUnits * 1e8));
    // secret R + the two swap keys, all bound to a per-swap nonce (seed-derived ⇒ a refund is
    // always reconstructable from the seed alone). H commits R.
    const nonce = sha256(Buffer.from(seed + 'fw-swap-nonce:' + frcAmount + ':' + (state.mine.height), 'utf8')).toString('hex').slice(0, 16);
    const R = swapPriv(nonce, 'R'), H = paymentHashOf(R);
    const frcKey = swapPriv(nonce, 'frc'), btcKey = swapPriv(nonce, 'btc');
    const frcPub = pubkeyCompressed(frcKey), btcPub = pubkeyCompressed(btcKey);
    // 1. open the swap — the relay reserves ITS per-swap pubkeys and echoes ours back
    log(tr('opening the swap…'));
    const c = await api('swapCreate', { paymentHash: H, frcAmount: String(frcAmount), makerFrcPub: frcPub, makerBtcPub: btcPub });
    // 2. build + fund the FRC HTLC (claim=relay, refund=us) — same key whose pub we just sent
    const L = state.mine.height, T1 = L + (state.swap?.t1 || 40);   // FRC refund offset per the relay (scaled to the BTC net)
    const leg = frcLeg({ role: 'give', ourKey: frcKey, theirPub: c.relayFrcPub, paymentHash: H, cltv: T1, net: 'regtest' });
    log(`${tr('locking')} ${frcUnits} FRC…`);
    const fund = await sendFrcToSpk(leg.spk, frcAmount);
    // persist BEFORE we hand control to the relay — if anything below fails, checkMySwaps refunds
    putMySwap({ id: c.id, nonce, spk: leg.spk, leaf: leg.leaf, T1,
      funding: { txid: fund.txid, vout: fund.vout, value: String(frcAmount), refheight: L } });
    await mvRefresh();
    const r2 = await api('swapFrcFunded', { id: c.id, txid: fund.txid, vout: fund.vout, leaf: leg.leaf, t1: T1 });
    log(tr('relay locked the BTC — claiming it…'));
    // 3. claim the BTC with R (reveals R); the relay broadcasts and then settles the FRC leg
    const myBtcSpk = '0014' + hash160(Buffer.from(btcPub, 'hex')).toString('hex');
    const cB = btcHtlcClaim({ prevTxid: r2.btcHtlc.txid, vout: r2.btcHtlc.vout, valueSats: BigInt(r2.btcHtlc.value), leafHex: r2.btcHtlc.leaf, preimage: R, claimKey: btcKey, toSpk: myBtcSpk, fee: 2000n });
    await api('swapBtcBroadcast', { id: c.id, rawtx: cB.rawtx });
    dropMySwap(c.id);   // settled — the relay claimed the FRC, our BTC is in hand
    log(`✅ ${(Number(c.btcAmount) / 1e8)} BTC → ${btcAddress(hash160(Buffer.from(btcPub, 'hex')).toString('hex'), state.swap?.btcHrp || 'bcrt')}`);
    log(tr('swap complete ✅'));
    toast(tr('swap complete ✅'), 'ok'); mvRefresh();
  } catch (e) { log('⚠ ' + e.message); toast(e.message, 'err'); if (go) { go.disabled = false; go.textContent = tr('Start swap'); } }
}

// ===== P2P swap board (maker-priced, user↔user). Local records track MY role in each swap so
// the drive loop can advance it (and refund on stall). Keys/secret derive from the seed. =====
const P2P_LS = 'fw_p2p';
const loadP2p = () => { try { return JSON.parse(localStorage.getItem(P2P_LS) || '[]'); } catch { return []; } };
const saveP2pLocal = a => { try { localStorage.setItem(P2P_LS, JSON.stringify(a)); } catch {} };
const putP2p = rec => { const a = loadP2p().filter(x => x.id !== rec.id); a.push(rec); saveP2pLocal(a); };
const dropP2p = id => saveP2pLocal(loadP2p().filter(x => x.id !== id));
const p2pKey = (nonce, leg) => sha256(Buffer.from(seed + 'fw-p2p:' + nonce + ':' + leg, 'utf8')).toString('hex');

// MAKER: post an FRC→BTC (or ASSET→BTC) offer at my price. I hold R; keys from a fresh nonce.
// `sellTag` set ⇒ sell that user-issued asset; sellUnits are display units (scaled to base units).
async function postP2pOffer(sellUnits, btcUnits, sellTag = null) {
  try {
    const amount = sellTag ? BigInt(Math.round(sellUnits * scaleOf(sellTag))) : BigInt(Math.round(sellUnits * 1e8));
    const btcAmount = BigInt(Math.round(btcUnits * 1e8));
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-nonce:' + (sellTag || '') + amount + ':' + btcAmount + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16);
    const R = p2pKey(nonce, 'R'), H = paymentHashOf(R);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const myBtcAddr = btcAddress(hash160(Buffer.from(btcPub, 'hex')).toString('hex'), state.swap?.btcHrp || 'tb');
    const r = await api('p2pPost', { assetTag: sellTag || undefined, frcAmount: String(amount), btcAmount: String(btcAmount), makerFrcPub: frcPub, makerBtcPub: btcPub, makerBtcAddr: myBtcAddr, paymentHash: H });
    addBtcNonce(nonce);
    putP2p({ id: r.id, role: 'maker', nonce, status: 'open', assetTag: sellTag || null, frcAmount: String(amount), btcAmount: String(btcAmount) });
    toast(tr('offer posted'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// MAKER (reverse): SELL BTC, want FRC or an ASSET (buy that asset with BTC). I hold R; fresh nonce.
async function postP2pOfferB(btcUnits, wantUnits, wantTag = null) {
  try {
    const frcAmount = wantTag ? BigInt(Math.round(wantUnits * scaleOf(wantTag))) : BigInt(Math.round(wantUnits * 1e8));
    const btcAmount = BigInt(Math.round(btcUnits * 1e8));
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-nonce:B:' + (wantTag || '') + frcAmount + ':' + btcAmount + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16);
    const R = p2pKey(nonce, 'R'), H = paymentHashOf(R);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const r = await api('p2pPostB', { assetTag: wantTag || undefined, frcAmount: String(frcAmount), btcAmount: String(btcAmount), makerFrcPub: frcPub, makerBtcPub: btcPub, makerFrcAddr: deriveAddress(seed, 0, 0), paymentHash: H });
    addBtcNonce(nonce);
    putP2p({ id: r.id, role: 'maker', dir: 'sellBtc', nonce, status: 'open', assetTag: wantTag || null, frcAmount: String(frcAmount), btcAmount: String(btcAmount) });
    toast(tr('offer posted'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}
// TAKER (reverse): accept a sell-BTC offer — I pay FRC/asset, receive BTC into my account.
async function takeP2pB(offer) {
  try {
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    await api('p2pTakeB', { id: offer.id, takerFrcPub: frcPub, takerBtcPub: btcPub, takerBtcAddr: btcAcctAddr() });
    addBtcNonce(nonce);
    putP2p({ id: offer.id, role: 'taker', dir: 'sellBtc', nonce, status: 'taken', assetTag: offer.assetTag ?? null, frcAmount: offer.frcAmount, btcAmount: offer.btcAmount, paymentHash: offer.paymentHash });
    toast(tr('offer taken — follow the steps'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// TAKER: accept someone's offer — I provide BTC (from my own wallet), receive FRC.
function openP2pTakeModal(offer) {
  if ($('#modal')) return;
  const btcHrp = state.swap?.btcHrp || 'tb';
  const m = document.createElement('div'); m.id = 'modal';
  const getStr = offer.assetTag ? `${(Number(BigInt(offer.frcAmount)) / scaleOf(offer.assetTag)).toLocaleString(getLang())} ${assetName(offer.assetTag)}` : `${Number(BigInt(offer.frcAmount)) / 1e8} FRC`;
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${offer.assetTag ? assetName(offer.assetTag) : 'FRC'}</b><button id="tkClose" class="icon">✕</button></div>
    <div class="rrow"><span>${tr('You receive')}</span><b>${getStr}</b></div>
    <div class="rrow"><span>${tr('You pay')}</span><b>${Number(BigInt(offer.btcAmount)) / 1e8} BTC</b></div>
    <button id="tkGo">${tr('Buy')}</button>
    <div id="tkLog" class="sub" style="font-size:12px;white-space:pre-line"></div></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#tkClose').onclick = () => m.remove();
  q(m, '#tkGo').onclick = () => takeP2p(offer, t => { const el = $('#tkLog'); if (el) el.textContent += (el.textContent ? '\n' : '') + t; });
}

// TAKER (reverse): sell BTC-buyer's counter-asset — you receive BTC, pay FRC or an asset. You lock
// after the seller locks BTC; the BTC arrives automatically.
function openP2pTakeModalB(offer) {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  const payStr = offer.assetTag ? `${(Number(BigInt(offer.frcAmount)) / scaleOf(offer.assetTag)).toLocaleString(getLang())} ${assetName(offer.assetTag)}` : `${frc(offer.frcAmount)} FRC`;
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Sell')} ${offer.assetTag ? assetName(offer.assetTag) : 'FRC'} → BTC</b><button id="tkClose" class="icon">✕</button></div>
    <div class="rrow"><span>${tr('You receive')}</span><b>${Number(BigInt(offer.btcAmount)) / 1e8} BTC</b></div>
    <div class="rrow"><span>${tr('You pay')}</span><b>${payStr}</b></div>
    <button id="tkGo">${tr('Sell')}</button>
    <p class="sub" style="font-size:12px">${tr('You lock FRC after the seller locks BTC; the BTC arrives automatically. Refundable if it stalls.')}</p></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#tkClose').onclick = () => m.remove();
  q(m, '#tkGo').onclick = () => { m.remove(); takeP2pB(offer); };
}

async function takeP2p(offer, log) {
  const go = $('#tkGo'); if (go) { go.disabled = true; go.textContent = tr('awaiting the seller…'); }
  try {
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const myFrcAddr = deriveAddress(seed, 0, 0);
    await api('p2pTake', { id: offer.id, takerFrcPub: frcPub, takerBtcPub: btcPub, takerFrcAddr: myFrcAddr });
    addBtcNonce(nonce);
    putP2p({ id: offer.id, role: 'taker', nonce, status: 'taken', assetTag: offer.assetTag ?? null, frcAmount: offer.frcAmount, btcAmount: offer.btcAmount, paymentHash: offer.paymentHash, funded: false });
    toast(tr('offer taken — follow the steps'), 'ok'); mvRefresh();
  } catch (e) { log('⚠ ' + e.message); toast(e.message, 'err'); if (go) { go.disabled = false; go.textContent = tr('Buy'); } }
}

// DRIVE: advance each of MY p2p swaps on every refresh, acting only on my turn.
// Serialized: overlapping invocations (interval + visibility kick) must not both act on the same
// swap — that is how an HTLC got funded twice when a report to the relay failed mid-cycle.
let p2pDriving = false;
async function driveP2p() {
  if (p2pDriving) return;
  p2pDriving = true;
  try { await driveP2pInner(); } finally { p2pDriving = false; }
}
async function driveP2pInner() {
  const mine = loadP2p(); if (!mine.length || !state) return;
  let info; try { info = await api('p2pList'); } catch { return; }
  const byId = new Map(info.swaps.map(s => [s.id, s]));
  for (const rec of mine) {
    const w = byId.get(rec.id); if (!w) { continue; }
    try {
      if (rec.dir === 'sellBtc') { await driveP2pRev(rec, w, info); if (w.status === 'done') dropP2p(rec.id); continue; }
      if (rec.role === 'maker') {
        if (w.status === 'taken') {                       // taker committed → fund the FRC HTLC
          // IDEMPOTENT: if we already funded but the report never reached the relay (restart,
          // network), RE-REPORT the existing funding — never fund the same swap twice.
          if (rec.status === 'frc_funded' && rec.funding?.txid) {
            await api('p2pFrcFunded', { id: rec.id, txid: rec.funding.txid, vout: rec.funding.vout, t1: rec.T1 });
            toast(`${w.id}: ${tr('FRC locked — awaiting BTC')}`, 'ok'); mvRefresh();
            continue;
          }
          const H = w.paymentHash, T1 = state.mine.height + (info.t1 || 40);
          const leg = frcLeg({ role: 'give', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.taker.frcPub, paymentHash: H, cltv: T1, net: 'regtest' });
          // FRC HTLC (host coin) OR an asset HTLC (asset coin + separate FRC fee coin)
          const fund = w.assetTag ? await lockAssetToHtlc(leg.spk, w.assetTag, BigInt(w.frcAmount)) : await sendFrcToSpk(leg.spk, BigInt(w.frcAmount));
          putP2p({ ...rec, status: 'frc_funded', leaf: leg.leaf, T1, funding: { txid: fund.txid, vout: fund.vout, value: w.frcAmount, refheight: fund.refheight ?? state.mine.height } });
          await api('p2pFrcFunded', { id: rec.id, txid: fund.txid, vout: fund.vout, t1: T1 });
          toast(`${w.id}: ${tr('FRC locked — awaiting BTC')}`, 'ok'); mvRefresh();
        } else if (w.status === 'btc_funded' && w.btcHtlc?.txid) {   // taker funded BTC → claim it with R
          const R = p2pKey(rec.nonce, 'R'), btcKey = p2pKey(rec.nonce, 'btc'), b = w.btcHtlc;
          // claim straight into the in-wallet BTC ACCOUNT (not the per-nonce address) so proceeds
          // land in the visible balance — the claim auth key stays the per-nonce swap key
          const cB = btcHtlcClaim({ prevTxid: b.txid, vout: b.vout, valueSats: BigInt(b.value), leafHex: b.leaf, preimage: R, claimKey: btcKey, toSpk: btcP2wpkhSpk(btcAcctPub()), fee: 2000n });
          await api('p2pBtcClaim', { id: rec.id, rawtx: cB.rawtx });
          putP2p({ ...rec, status: 'btc_claimed' });
          addSwapHist({ id: rec.id, category: 'purchase', frcAmount: w.frcAmount, btcAmount: String(BigInt(b.value) - 2000n), btcTxid: cB.txid, frcTxid: rec.funding?.txid ?? null, time: Math.floor(Date.now() / 1000) });
          toast(`${w.id}: ${tr('BTC received ✅')}`, 'ok'); mvRefresh();
        }
      } else {   // taker
        if (w.status === 'frc_funded' && rec.status !== 'need_btc' && !w.btcHtlc?.txid) {   // seller locked FRC → I must fund BTC
          putP2p({ ...rec, status: 'need_btc', btcHtlc: w.btcHtlc });
          toast(`${w.id}: ${tr('pay BTC to complete — tap the swap')}`, 'warn');
        } else if ((w.status === 'btc_claimed' || w.preimage) && rec.status !== 'done') {   // R revealed → claim FRC/asset
          const R = w.preimage; if (!R) continue;
          const f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
          let cF;
          if (tag) {   // asset HTLC → claim the asset's PRESENT VALUE (demurrage haircut, even for
            // "constant" k=64 there's a one-off rounding unit), fee from a separate host coin
            const feeCoin = hostFeeCoin(state.mine.height, 11000n);
            if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
            const payout = assetPresentValue(BigInt(f.value), state.mine.height - f.refheight, rateOf(tag));
            cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'frc'), toSpk: spks[0], assetTag: tag, payout, feeCoin, fee: 10000n, lockHeight: state.mine.height });
          } else {
            cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: p2pKey(rec.nonce, 'frc'), toSpk: spks[0], fee: 10000n });
          }
          await api('tx', { rawtx: cF.rawtx, kind: 'send' });
          await api('p2pDone', { id: rec.id });
          addSwapHist({ id: rec.id, category: 'sale', assetTag: tag, frcAmount: w.frcAmount, btcAmount: w.btcAmount, btcTxid: null, btcFundTxid: rec.btcHtlc?.txid ?? null, frcTxid: cF.txid ?? null, time: Math.floor(Date.now() / 1000) });
          dropP2p(rec.id);
          toast(`${w.id}: ${tr('FRC received ✅')}`, 'ok'); mvRefresh();
        }
      }
      if (w.status === 'done') dropP2p(rec.id);
    } catch (e) {
      // surface the reason a swap won't advance (once per id per minute) instead of silently
      // retrying forever — this is how a stuck 'taken' offer stays stuck invisibly
      const key = rec.id + ':' + w.status;
      if (driveErr.get(key) !== e.message) { driveErr.set(key, e.message); toast(`${rec.id}: ${e.message}`, 'err'); }
    }
  }
}
const driveErr = new Map();   // last surfaced error per (id,status) — avoid toast spam

// REVERSE swap drive (maker SELLS BTC): maker funds the BTC HTLC first, then claims FRC (reveals R);
// taker funds the FRC HTLC, then claims BTC with R. Mirror of the forward flow above.
async function driveP2pRev(rec, w, info) {
  if (rec.role === 'maker') {
    if (w.status === 'taken') {                                   // taker committed → lock BTC first
      // IDEMPOTENT: already funded but the report didn't land (relay restart) → re-report, never
      // fund twice (this exact race once double-funded an HTLC).
      if (rec.status === 'btc_funded_rev' && rec.btcHtlc?.txid) {
        await api('p2pBtcFundedB', { id: rec.id, btcTxid: rec.btcHtlc.txid, tb: rec.btcHtlc.cltv });
        toast(`${w.id}: ${tr('BTC locked — awaiting FRC')}`, 'ok'); mvRefresh();
        return;
      }
      const tb = (info.btcHeight || 0) + (info.revTb || 12);
      const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.btcPub, refundPub: pubkeyCompressed(p2pKey(rec.nonce, 'btc')), cltv: tb });
      const baddr = btcHtlcAddress(bleaf, btcHrp());
      const fund = await btcFundHtlc(baddr, BigInt(w.btcAmount));
      putP2p({ ...rec, status: 'btc_funded_rev', btcHtlc: { addr: baddr, leaf: bleaf, cltv: tb, txid: fund.txid, vout: fund.vout, value: fund.value } });
      await api('p2pBtcFundedB', { id: rec.id, btcTxid: fund.txid, tb });
      toast(`${w.id}: ${tr('BTC locked — awaiting FRC')}`, 'ok'); mvRefresh();
    } else if (w.status === 'frc_funded_rev' && w.frcHtlc?.txid) {  // taker locked FRC/asset → claim it with R (reveals R)
      const R = p2pKey(rec.nonce, 'R'), f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
      let cF;
      if (tag) {   // BUY asset: claim the asset's present value, fee from a host coin
        const feeCoin = hostFeeCoin(state.mine.height, 11000n);
        if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
        const payout = assetPresentValue(BigInt(f.value), state.mine.height - f.refheight, rateOf(tag));
        cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'frc'), toSpk: spks[0], assetTag: tag, payout, feeCoin, fee: 10000n, lockHeight: state.mine.height });
      } else {
        cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: p2pKey(rec.nonce, 'frc'), toSpk: spks[0], fee: 10000n });
      }
      await api('p2pFrcClaimB', { id: rec.id, rawtx: cF.rawtx });
      putP2p({ ...rec, status: 'frc_claimed_rev' });
      addSwapHist({ id: rec.id, category: 'purchase', assetTag: tag, frcAmount: w.frcAmount, btcAmount: w.btcAmount, btcTxid: null, btcFundTxid: rec.btcHtlc?.txid ?? null, frcTxid: cF.txid ?? null, time: Math.floor(Date.now() / 1000) });
      toast(`${w.id}: ${tr(tag ? 'asset received ✅' : 'FRC received ✅')}`, 'ok'); mvRefresh();
    }
  } else {   // taker
    if (w.status === 'btc_funded_rev' && w.frcHtlc?.spk && rec.status !== 'frc_funded_rev') {   // maker locked BTC → I lock FRC/asset
      const tag = w.assetTag ?? w.frcHtlc.assetTag ?? null;
      const leg = frcLeg({ role: 'give', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.maker.frcPub, paymentHash: w.paymentHash, cltv: w.frcHtlc.cltv, net: 'regtest' });
      if (leg.spk !== w.frcHtlc.spk) throw new Error(tr('FRC HTLC mismatch'));
      const fund = tag ? await lockAssetToHtlc(leg.spk, tag, BigInt(w.frcAmount)) : await sendFrcToSpk(leg.spk, BigInt(w.frcAmount));
      putP2p({ ...rec, status: 'frc_funded_rev', funding: { txid: fund.txid, vout: fund.vout } });
      await api('p2pFrcFundedB', { id: rec.id, txid: fund.txid, vout: fund.vout });
      toast(`${w.id}: ${tr(tag ? 'asset locked — awaiting the secret' : 'FRC locked — awaiting the secret')}`, 'ok'); mvRefresh();
    } else if (w.status === 'btc_funded_rev' && rec.status === 'frc_funded_rev' && rec.funding?.txid && !w.frcHtlc?.txid) {
      // IDEMPOTENT: funded but the report never landed — re-report the existing funding
      await api('p2pFrcFundedB', { id: rec.id, txid: rec.funding.txid, vout: rec.funding.vout ?? 0 });
      toast(`${w.id}: ${tr('FRC locked — awaiting the secret')}`, 'ok'); mvRefresh();
    } else if ((w.status === 'frc_claimed_rev' || w.preimage) && rec.status !== 'done') {   // R revealed → claim BTC
      const R = w.preimage; if (!R) return;
      const b = w.btcHtlc;
      const cB = btcHtlcClaim({ prevTxid: b.txid, vout: b.vout, valueSats: BigInt(b.value), leafHex: b.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(btcAcctPub()), fee: 2000n });
      await api('btcBroadcast', { rawtx: cB.rawtx });
      await api('p2pDoneB', { id: rec.id });
      addSwapHist({ id: rec.id, category: 'purchase', frcAmount: w.frcAmount, btcAmount: String(BigInt(b.value) - 2000n), btcTxid: cB.txid, frcTxid: rec.funding?.txid ?? null, time: Math.floor(Date.now() / 1000) });
      putP2p({ ...rec, status: 'done' }); dropP2p(rec.id);
      toast(`${w.id}: ${tr('BTC received ✅')}`, 'ok'); mvRefresh();
    }
  }
}
// pay `sats` to a BTC address (e.g. an HTLC) FROM the account — build+sign locally, broadcast via
// the relay. The paid output is always vout 0 (change, if any, is vout 1).
async function btcFundHtlc(toAddr, sats) {
  const toSpk = btcDecodeAddress(toAddr, btcHrp());
  const amount = BigInt(sats), fee = 1000n;
  const ring = btcKeyring();
  const acct = await api('btcAccount', { addresses: Object.keys(ring) });
  const coins = [...acct.utxos].filter(c => ring[c.address]).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += BigInt(c.value); if (S >= amount + fee) break; }
  if (S < amount + fee) throw new Error(tr('not enough BTC'));
  const outputs = [{ spk: toSpk, value: amount }], change = S - amount - fee;
  if (change > 546n) outputs.push({ spk: btcP2wpkhSpk(btcAcctPub()), value: change });
  const inputs = picked.map(c => ({ prevTxid: c.txid, vout: c.vout, valueSats: BigInt(c.value), key: ring[c.address] }));
  const { rawtx, txid } = btcP2wpkhSend({ inputs, outputs });
  await api('btcBroadcast', { rawtx });
  return { txid, vout: 0, value: String(amount) };
}

// TAKER: pay the BTC HTLC from your own wallet (manual), then report the txid to the relay.
function openP2pPayModal(rec) {
  if ($('#modal')) return;
  const b = rec.btcHtlc; if (!b) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Pay BTC')} ${rec.id}</b><button id="pyClose" class="icon">✕</button></div>
    <p class="sub">${tr('Send exactly this amount from your Bitcoin wallet to the address. The swap continues automatically once the payment is seen.')}</p>
    <div class="rrow"><span>${tr('Amount')}</span><b>${Number(BigInt(rec.btcAmount)) / 1e8} BTC</b></div>
    <label>${tr('HTLC address')}<div class="addr" style="user-select:all">${b.addr}</div></label>
    <div id="pyStatus" class="sub" style="font-size:13px"></div>
    <button id="pyCancel" class="ghost">${tr('Cancel purchase')}</button></div>`;
  document.body.appendChild(m);
  const close = () => { clearInterval(poll); m.remove(); };
  m.onclick = e => { if (e.target === m) close(); };
  q(m, '#pyClose').onclick = close;
  // auto-detect: poll the relay until it sees the payment, then close (drive loop finishes it)
  const poll = setInterval(async () => {
    try {
      const w = (await api('p2pList')).swaps.find(x => x.id === rec.id);
      if (w && w.status !== 'frc_funded' && w.status !== 'need_btc') {
        clearInterval(poll); putP2p({ ...rec, status: 'btc_funded' });
        const st = $('#pyStatus'); if (st) st.textContent = tr('payment seen ✓ — finishing the swap');
        setTimeout(() => m.remove(), 1500); mvRefresh();
      }
    } catch {}
  }, 4000);
  // back out: the taker committed nothing on-chain, so drop the swap locally and stop driving it.
  // The maker's FRC is refunded to them automatically once its T1 passes (their checkMySwaps).
  q(m, '#pyCancel').onclick = () => { dropP2p(rec.id); close(); toast(tr('swap declined'), 'ok'); mvRefresh(); };
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
    if (payPv < need) {
      // the age filter (refheight <= offer lockHeight) may be what starves us — say so
      const ageless = state.mine.utxos.filter(x => (x.assetTag ?? null) === payTagNorm && !reserved.has(x.outpoint))
        .reduce((s, x) => s + BigInt(x.value), 0n);
      throw new Error(ageless >= need ? tr('your coins are newer than this offer — the seller must refresh it')
        : isFrcPayout ? tr('you need more FRC (tap Faucet) to pay for this fill') : tr('you need more of the requested asset to pay for this fill'));
    }
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
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

// Buy modal: quantity (prefilled with the whole remainder) + live total; Buy = fill.
function openBuyModal(o) {
  if ($('#modal')) return;
  const giveTag = o.give.assetTag ?? null;
  const wantTag = (o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : null;
  const pn = BigInt(o.desc.priceNum), pd = BigInt(o.desc.priceDen);   // NB: not `num` — that's the global comma-parser
  const L = o.lockHeight;
  const maxK = assetPresentValue(BigInt(o.give.value), L - o.give.refheight, rateOf(o.give.assetTag));
  const maxU = Number(maxK) / scaleOf(giveTag);
  const whole = BigInt(o.desc.minFill) > 0n && BigInt(o.desc.minFill) >= maxK;   // all-or-nothing offer
  const costOf = u => { let f = BigInt(Math.round(u * scaleOf(giveTag))); if (f > maxK) f = maxK; return (f * pn + pd - 1n) / pd; };
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${assetName(giveTag)}</b><button id="bClose" class="icon">✕</button></div>
    <label>${tr('Quantity')}<div class="amtrow"><input id="bQty" type="text" inputmode="decimal" value="${maxU}"${whole ? ' disabled' : ''}>${whole ? '' : `<button id="bMax" class="ghost">${tr('Max')}</button>`}</div></label>
    ${whole ? `<p class="sub" style="font-size:12px">${tr('this offer sells only as a whole')}</p>` : ''}
    <div class="rrow"><span>${tr('You pay')}</span><b id="bCost"></b></div>
    <p class="warn" id="bMelt" hidden>${tr('⚠ this amount is so small it will melt to zero within a few blocks — buy more')}</p>
    <button id="bBuy">${tr('Buy')}</button></div>`;
  document.body.appendChild(m);
  const rate = rateOf(o.give.assetTag);
  const cost = () => { const u = num($('#bQty').value);
    $('#bCost').textContent = (u > 0) ? fmtA(wantTag ?? 'FRC', costOf(u)) : '—';
    // an integer-floored melting asset eats tiny holdings whole — warn before the trap
    $('#bMelt').hidden = !(u > 0) || assetPresentValue(BigInt(Math.round(u * scaleOf(giveTag))), 10, rate) > 0n; };
  cost();
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#bClose').onclick = () => m.remove();
  q(m, '#bQty').oninput = cost;
  const bm = q(m, '#bMax'); if (bm) bm.onclick = () => { $('#bQty').value = maxU; cost(); };
  q(m, '#bBuy').onclick = async () => {
    const u = num($('#bQty').value);
    if (!(u > 0)) return toast(tr('enter a quantity'), 'err');
    const btn = q(m, '#bBuy'); btn.disabled = true;
    if (await fillRangedNow(o, u)) m.remove(); else btn.disabled = false;
  };
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
    // re-sign after a partial fill (needsResign) AND periodically: the signature pins the
    // tx lockHeight, and takers can only pay with coins no younger than it — an offer left
    // at an old height slowly becomes unbuyable for everyone with fresh coins.
    // resign as soon as the offer trails the tip at all: any coin minted after lockHeight
    // (a fresh faucet, a buyer's change) is otherwise too young to pay — signatures are cheap
    const stale = o.status === 'open' && state.mine.height - o.lockHeight > 1;
    if (!o.ranged || !(o.needsResign || stale) || !spks.includes(o.makerSpk)) continue;
    const u = state.mine.utxos.find(x => x.outpoint === o.giveOutpoint);
    if (!u) continue;                    // the change coin isn't in my verified set yet
    const d = o.desc, L = state.mine.height;
    const expireAt = Number(o.nExpireTime) || 0;
    if (expireAt && L > expireAt) continue;                       // past the signed expiry — dead, let it expire
    // the digest commits desc.nExpireTime — reconstruct EXACTLY what was originally signed
    const desc = { payoutAsset: d.payoutAsset ?? HOST_TAG, payoutScript: d.payoutScript, priceNum: BigInt(d.priceNum), priceDen: BigInt(d.priceDen), changeScript: d.changeScript, minFill: BigInt(d.minFill), maxFill: BigInt(d.maxFill), ...(d.nExpireTime != null ? { nExpireTime: Number(d.nExpireTime) } : {}) };
    try {
      const coin = { spk: u.spk, value: BigInt(u.value), refheight: u.refheight };
      if (o.needsResign && expireAt) {
        // fill re-pointed the offer at a NEW coin: the old ladder is dead — sign a fresh one
        // from here to the original expiry, so the remainder survives us going offline again
        const ladder = await signLadder(desc, coin, o.giveOutpoint, L, expireAt);
        if (ladder.length) await api('resignRanged', { id: o.id, giveOutpoint: o.giveOutpoint, lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder });
      } else {
        // online freshness: top the ladder up with a single tip rung
        const witness = signRangedGive(desc, o.giveOutpoint, coin, L);
        await api('resignRanged', { id: o.id, giveOutpoint: o.giveOutpoint, lockHeight: L, witness });
      }
    } catch { /* next sync retries */ }
  }
}

// ---- UI ----
// render() builds the STATIC shell (nav, inputs, buttons) ONCE and wires handlers; paint()
// refreshes only the data regions (balances, order book, log, offer selects) every sync — so
// a periodic refresh never wipes what the user is typing.
const fmtA = (tag, v) => tag === 'FRC' ? frc(v) + ' FRC'
  : (Number(BigInt(v)) / scaleOf(tag)).toLocaleString(getLang(), { maximumFractionDigits: decimalsOf(tag) }) + ' ' + assetName(tag);
// The three Freimarkets surfaces mounted into the wallet's own tab sections (called by main.mjs
// on the nv3 network). Each builds its section and wires its handlers; data arrives via mvRefresh.
export function openIssueModal() {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Issue asset')}</b><button id="issClose" class="icon">✕</button></div>
    <p class="sub">${tr('Issue an asset that lives on the chain: constant, melting (demurrage) or growing (interest).')}</p>
    <label>${tr('Name')}<input id="iName" maxlength="24" placeholder="часы-труда"></label>
    <div class="row">
      <label>${tr('Type')}<select id="iKind"><option value="c">${tr('constant')}</option><option value="d">${tr('melts')}</option><option value="i">${tr('grows')}</option></select></label>
      <label id="iRateLbl" hidden>${tr('Rate k')}<input id="iShift" type="number" value="16" min="1" max="63" step="1"></label>
    </div>
    <p class="sub" id="iRateHint" style="font-size:12px" hidden></p>
    <div class="row">
      <label>${tr('Quantity')}<input id="iAmt" type="number" value="1000000"></label>
      <label>${tr('Decimals')}<select id="iDec"><option value="2">0,01</option><option value="3">0,001</option><option value="0">${tr('whole only')}</option></select></label>
    </div>
    <p class="sub" id="iMeltHint" style="font-size:12px" hidden>${tr('Melting eats whole units on indivisible assets — decimals let it shave fractions instead.')}</p>
    <button id="issueBtn">${tr('Issue asset')}</button></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#issClose').onclick = () => m.remove();
  q(m, '#issueBtn').onclick = issue;
  const rateHint = () => {
    const kind = $('#iKind').value, el = $('#iRateHint');
    el.hidden = kind === 'c';
    if (el.hidden) return;
    const k = Math.min(63, Math.max(1, Math.round(+$('#iShift').value || 16)));
    const perBlock = 2 ** -k;
    const blocksDay = 86400 / ((state?.info?.mineEveryMs ?? 20000) / 1000);
    const over = days => kind === 'd' ? 1 - (1 - perBlock) ** (blocksDay * days) : (1 + perBlock) ** (blocksDay * days) - 1;
    // extreme k values compound into astronomy — anything past 9 999% reads as "practically infinite"
    const f = x => { const pc = x * 100; return (!isFinite(pc) || pc > 9999) ? '∞' : pc.toLocaleString(getLang(), { maximumSignificantDigits: 3 }); };
    el.textContent = `≈ ${f(over(1))}% ${tr('per day')} · ≈ ${f(over(30))}% ${tr('per month')} · ≈ ${f(over(365))}% ${tr('per year')}`;
  };
  q(m, '#iShift').oninput = e => {   // hard-clamp typed values (min/max only guard the spinner)
    const v = e.target.value;
    if (v !== '') { const c = Math.min(63, Math.max(1, Math.round(+v || 1))); if (String(c) !== v) e.target.value = c; }
    rateHint();
  };
  q(m, '#iKind').onchange = e => {
    $('#iRateLbl').hidden = e.target.value === 'c';        // constant has no rate at all
    // rounding hint per type: melting EATS whole units; growth STALLS below a whole unit
    const hint = $('#iMeltHint');
    hint.hidden = e.target.value === 'c';
    if (!hint.hidden) hint.textContent = e.target.value === 'd'
      ? tr('Melting eats whole units on indivisible assets — decimals let it shave fractions instead.')
      : tr('Growth rounds down — small indivisible holdings stall until a whole unit accrues; decimals make it smooth.');
    rateHint();
  };
}
// ---- in-wallet BTC account (signet) — same seed, non-custodial via the relay's watch-only index ----
// The relay never holds keys or funds: it imports our addresses watch-only, reports their UTXOs and
// rebroadcasts what we sign locally. Trust note: it can hide/mislabel a balance, but never spend it.
const btcHrp = () => state?.swap?.btcHrp || 'tb';
const btcAcctPriv = () => sha256(Buffer.from(seed + 'fw-btc-acct:0', 'utf8')).toString('hex');
const btcAcctPub = () => pubkeyCompressed(btcAcctPriv());
const btcAcctAddr = () => btcP2wpkhAddress(btcAcctPub(), btcHrp());
// Persistent BTC address book: the nonce of every P2P swap this wallet took part in. The live swap
// record is dropped on completion (which would lose the nonce and orphan the per-swap BTC address);
// this book keeps it, so swap proceeds/refunds stay visible AND spendable forever.
const BTCADDR_LS = 'fw_btc_nonces';
const loadBtcNonces = () => { try { return JSON.parse(localStorage.getItem(BTCADDR_LS) || '[]'); } catch { return []; } };
const addBtcNonce = n => { try { const a = loadBtcNonces(); if (!a.includes(n)) { a.push(n); localStorage.setItem(BTCADDR_LS, JSON.stringify(a)); } } catch {} };

// Completed-swap history (persistent): each entry becomes a TRADE row in Activity — Buy/Sell BTC
// with BOTH legs (FRC paid/received AND BTC received/paid) — instead of a bare one-sided leg.
// frcTxid lets Activity hide the raw FRC HTLC leg the trade row replaces; btcTxid/btcAddr tie the
// BTC receive to the swap. category: 'purchase' = bought BTC (paid FRC), 'sale' = sold BTC.
const SWHIST_LS = 'fw_swap_hist';
const loadSwapHist = () => { try { return JSON.parse(localStorage.getItem(SWHIST_LS) || '[]'); } catch { return []; } };
// upsert by id: a later, better-informed write WINS for non-empty fields (values are derived
// deterministically from the chain/archive, so re-runs converge — and corrected upstream data,
// e.g. a fixed funding txid, must be able to replace an earlier wrong value)
const addSwapHist = e => { try {
  const a = loadSwapHist(), i = a.findIndex(x => x.id === e.id);
  if (i >= 0) { for (const [k, v] of Object.entries(e)) if (v != null && v !== 0) a[i][k] = v; }
  else a.push(e);
  localStorage.setItem(SWHIST_LS, JSON.stringify(a));
} catch {} };

// Every BTC address this wallet controls → its private key: the fixed account PLUS each P2P swap's
// per-nonce BTC key (live records AND the persistent address book). Balance sums them; sends spend any.
function btcKeyring() {
  const ring = { [btcAcctAddr()]: btcAcctPriv() };
  const nonces = new Set([...loadP2p().map(r => r.nonce).filter(Boolean), ...loadBtcNonces()]);
  for (const n of nonces) { try { const k = p2pKey(n, 'btc'); ring[btcP2wpkhAddress(pubkeyCompressed(k), btcHrp())] = k; } catch {} }
  return ring;
}
// Recover BTC addresses of PAST swaps whose local record was already dropped: match each live relay
// offer against my derivable keys — the taker nonce is deterministic (from the offer id); the maker
// nonce brute-forces the post height. Found nonces go into the address book. One-time per session.
let btcRecoveredKey = '';
async function recoverBtcNonces() {
  const offers = [...(state?.p2p?.swaps || []), ...(state?.p2p?.archive || [])];   // live board + completed archive
  // re-run whenever the offer set (or its statuses/known fundings) changes — a one-shot flag left
  // stale synthesis in place when the archive was corrected under a long-lived tab
  const key = offers.map(o => `${o.id}:${o.status}:${(o.btcHtlc || {}).txid || ''}`).join(',');
  if (!offers.length || key === btcRecoveredKey) return;
  btcRecoveredKey = key;
  const tip = state.mine.height, known = new Set(loadBtcNonces());
  // A completed swap whose local record is gone still deserves a trade row — synthesize the
  // history entry from the relay offer once we prove the role (keys match). Idempotent (by id).
  const doneish = o => ['btc_claimed', 'frc_claimed_rev', 'done'].includes(o.status);
  const synth = (o, role, nonce) => {
    if (!doneish(o)) return;
    const boughtBtc = (role === 'maker') !== (o.dir === 'sellBtc');   // forward maker & reverse taker BUY btc
    // The FRC leg's txid: the maker's HTLC funding is on the offer; a CLAIM (forward taker /
    // reverse maker) is rebuilt deterministically (RFC6979) to learn its txid without broadcasting.
    let frcTxid = (role === 'maker' && o.dir !== 'sellBtc') ? (o.frcHtlc?.txid ?? null) : null;
    const claimsFrc = (role === 'taker') !== (o.dir === 'sellBtc');   // forward taker & reverse maker claim FRC
    if (claimsFrc && o.preimage && o.frcHtlc?.txid != null) {
      try { frcTxid = claimReceived({ funding: { txid: o.frcHtlc.txid, vout: o.frcHtlc.vout, value: BigInt(o.frcHtlc.value), refheight: o.frcHtlc.refheight },
        leaf: o.frcHtlc.leaf, preimage: o.preimage, ourKey: p2pKey(nonce, 'frc'), toSpk: spks[0], fee: 10000n }).txid; } catch {}
    }
    addSwapHist({ id: o.id, category: boughtBtc ? 'purchase' : 'sale', frcAmount: o.frcAmount, btcAmount: o.btcHtlc?.value || o.btcAmount,
      btcTxid: null, btcFundTxid: boughtBtc ? null : (o.btcHtlc?.txid ?? null),   // the maker's HTLC-funding spend, covered by the trade row
      btcAddr: boughtBtc ? btcP2wpkhAddress(pubkeyCompressed(p2pKey(nonce, 'btc')), btcHrp()) : null,
      frcTxid, time: 0 });
  };
  for (const o of offers) {
    try {
      const tn = sha256(Buffer.from(seed + 'fw-p2p-take:' + o.id, 'utf8')).toString('hex').slice(0, 16);
      if (o.taker && pubkeyCompressed(p2pKey(tn, 'frc')) === o.taker.frcPub) {
        if (!known.has(tn)) { addBtcNonce(tn); known.add(tn); }
        synth(o, 'taker', tn);
        // RESURRECT an unclaimed taker swap whose local record was dropped: the offer still on the
        // board at *_claimed means MY payout is still locked (the relay prunes once it's spent) —
        // put the record back so driveP2p claims it on the next cycle.
        if (o.preimage && ['btc_claimed', 'frc_claimed_rev'].includes(o.status) && !loadP2p().some(r => r.id === o.id))
          putP2p({ id: o.id, role: 'taker', ...(o.dir === 'sellBtc' ? { dir: 'sellBtc' } : {}), nonce: tn, status: 'taken', frcAmount: o.frcAmount, btcAmount: o.btcAmount, paymentHash: o.paymentHash });
        continue;
      }
      const prefix = o.dir === 'sellBtc' ? 'fw-p2p-nonce:B:' : 'fw-p2p-nonce:';   // maker: brute-force the post height
      for (let h = tip + 5; h >= 0; h--) {
        const n = sha256(Buffer.from(seed + prefix + o.frcAmount + ':' + o.btcAmount + ':' + h, 'utf8')).toString('hex').slice(0, 16);
        if (pubkeyCompressed(p2pKey(n, 'frc')) === o.maker.frcPub) { if (!known.has(n)) { addBtcNonce(n); known.add(n); } synth(o, 'maker', n); break; }
        if ((h & 511) === 0) await new Promise(r => setTimeout(r, 0));   // yield so the UI stays responsive
      }
    } catch {}
  }
}
let btcAcct = null;   // last { balance, utxos, hrp, net } from the relay
const btcToStr = sats => (Number(BigInt(sats)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 });
async function refreshBtc() {
  if (!state?.swap?.available) return;
  await recoverBtcNonces();   // one-time: rebuild the address book for swaps whose record was dropped
  try { btcAcct = await api('btcAccount', { addresses: Object.keys(btcKeyring()) }); } catch { return; }
  const cell = $('#btcBalCell'); if (cell) cell.textContent = btcToStr(btcAcct.balance);   // BTC row in the assets table
}

// ---- exports so BTC lives in the wallet's MAIN flow (assets table + Send/Receive), not a side panel ----
/** Is a BTC account available, and its current balance (sats) + address prefix. */
export function mvBtc() { return { available: !!state?.swap?.available, balance: btcAcct?.balance ?? null, hrp: btcHrp() }; }
/** BTC history for the Activity feed: completed swaps become TRADE items (both legs — FRC and
 *  BTC), remaining receives stay plain legs. Returns { legs, hideFrc } where hideFrc lists FRC
 *  txids the trade rows replace (the raw HTLC legs must not show twice). */
export async function mvBtcHistory() {
  if (!state) { try { await doRefresh(); } catch {} }   // first load: the market state isn't in yet — wait for it, don't return an empty list
  if (!state?.swap?.available) return { legs: [], hideFrc: [] };
  try {
    await recoverBtcNonces();
    const r = await api('btcHistory', { addresses: Object.keys(btcKeyring()) });
    const all = (r.txs || []).map(t => ({ txid: t.txid, category: t.category, amount: t.amount, confirmations: t.confirmations, time: t.time, addresses: t.addresses || [], assetTag: null, btc: true }));
    const hist = loadSwapHist(), used = new Set(), items = [];
    const receives = all.filter(t => t.category === 'receive');
    // sends already represented by a trade row (the maker's HTLC funding) must not show twice
    const fundTxids = new Set(hist.map(h => h.btcFundTxid).filter(Boolean));
    const sends = all.filter(t => t.category === 'send' && !fundTxids.has(t.txid));
    for (const h of hist) {
      const buy = h.category === 'purchase';   // bought BTC (recv BTC, paid FRC) vs sold BTC
      // tie the swap to its BTC receive: by claim txid; by the per-swap address (old claims); or by
      // amount at the ACCOUNT address (new claims land there) — each receive consumed at most once
      const recv = receives.find(t => t.txid === h.btcTxid)
        || (h.btcAddr ? receives.find(t => !used.has(t.txid) && t.addresses.includes(h.btcAddr)) : null)
        || (buy ? receives.find(t => !used.has(t.txid) && t.addresses.includes(btcAcctAddr()) && Math.abs(Math.round(t.amount * 1e8) - (Number(h.btcAmount) - 2000)) <= 1) : null);
      if (recv) used.add(recv.txid);
      const frcAmt = Number(BigInt(h.frcAmount)) / 1e8, btcAmt = recv ? recv.amount : Number(BigInt(h.btcAmount)) / 1e8;
      items.push({ trade: true, txid: recv?.txid || h.btcTxid || h.id, time: recv?.time || h.time || 0, confirmations: recv?.confirmations ?? 1, category: h.category, frcTxid: h.frcTxid ?? null,
        recv: buy ? { amount: btcAmt, btc: true } : { amount: frcAmt },
        paid: buy ? { amount: -frcAmt } : { amount: -btcAmt, btc: true } });
    }
    items.push(...receives.filter(t => !used.has(t.txid)), ...sends);   // non-swap receives + real outgoing sends
    return { legs: items, hideFrc: hist.map(h => h.frcTxid).filter(Boolean) };
  } catch { return { legs: [], hideFrc: [] }; }
}
/** The account's receive address (and start watching it so incoming funds are seen). */
export function mvBtcAddress() { const a = btcAcctAddr(); api('btcAccount', { addresses: [a] }).catch(() => {}); return a; }
/** True if `a` is a valid address on the BTC network we're on. */
export function mvBtcValidAddr(a) { try { btcDecodeAddress(a, btcHrp()); return true; } catch { return false; } }
/** Build + sign a P2WPKH send LOCALLY (key never leaves the device) and broadcast via the relay. */
export async function mvSendBtc(dest, amountBtc) {
  if (!(amountBtc > 0)) throw new Error(tr('enter a quantity'));
  let toSpk; try { toSpk = btcDecodeAddress(dest, btcHrp()); } catch (e) { throw new Error(tr('bad address')); }
  const amount = BigInt(Math.round(amountBtc * 1e8)), fee = 1000n;   // signet: a flat, generous fee
  const ring = btcKeyring();
  const acct = await api('btcAccount', { addresses: Object.keys(ring) });
  const coins = [...acct.utxos].filter(c => ring[c.address]).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += BigInt(c.value); if (S >= amount + fee) break; }
  if (S < amount + fee) throw new Error(tr('not enough BTC'));
  const outputs = [{ spk: toSpk, value: amount }], change = S - amount - fee;
  if (change > 546n) outputs.push({ spk: btcP2wpkhSpk(btcAcctPub()), value: change });   // change back to the account
  const inputs = picked.map(c => ({ prevTxid: c.txid, vout: c.vout, valueSats: BigInt(c.value), key: ring[c.address] }));
  const { rawtx, txid } = btcP2wpkhSend({ inputs, outputs });
  await api('btcBroadcast', { rawtx });
  refreshBtc();
  return txid;
}

export function renderExchange(el) {
  el.innerHTML = `
    <div class="row">
      <label>${tr('Selling')}<select id="fGive"></select></label>
      <label>${tr('Wants')}<select id="fWant"></select></label>
    </div>
    <label class="chk"><input type="checkbox" id="fOpen" checked>${tr('open only')}</label>
    <table class="mkt"><thead><tr><th>#</th><th>${tr('Give')}</th><th>${tr('Want')}</th><th></th></tr></thead><tbody id="bookBody"><tr><td colspan="4" class="sub">${tr('first sync…')}</td></tr></tbody></table>
    <div class="row"><button id="openOffer">${tr('Post an offer')}</button></div>`;
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
  const amt = (tag, v) => tag === 'FRC' ? frc(v)
    : (Number(BigInt(v)) / scaleOf(tag)).toLocaleString(getLang(), { maximumFractionDigits: decimalsOf(tag) });
  const rows = [...byAsset.entries()].map(([tag, e]) => {
    const constant = tag !== 'FRC' && rateOf(tag).k >= 64;   // k=64 ≈ constant: the one-off rounding unit isn't "melting"
    const melt = !constant && e.pv < e.nominal, grow = !constant && e.pv > e.nominal;
    return `<tr><td${tag === 'FRC' ? '' : ` title="${tag}"`}>${assetName(tag === 'FRC' ? null : tag)}</td><td class="r ${melt ? 'melt' : grow ? 'grow' : ''}">${amt(tag, e.pv)}</td></tr>`;
  });
  // BTC sits in the same table (held in-wallet on signet); the cell fills in when refreshBtc returns.
  if (state.swap?.available) rows.push(`<tr><td>BTC</td><td class="r" id="btcBalCell">${btcAcct ? btcToStr(btcAcct.balance) : '…'}</td></tr>`);
  body.innerHTML = rows.join('') || `<tr><td colspan="2" class="sub">${tr('empty — tap Faucet')}</td></tr>`;
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
  // BTC is a cross-chain leg (settled by swap, not a ranged offer) — only when a BTC node is up
  const btcOpt = state.swap?.available ? `<optgroup label="${tr('Cross-chain')}"><option value="BTC">BTC</option></optgroup>` : '';
  setOptions('#rAsset', (((frcHeld ? `<optgroup label="${tr('Currency')}">${sellOpt(['FRC', frcHeld])}</optgroup>` : '')
    + (heldAssets.length ? `<optgroup label="${tr('Assets')}">${heldAssets.map(sellOpt).join('')}</optgroup>` : '')) + btcOpt)   // + sell BTC
    || `<option value="">${tr('no coins yet')}</option>`);
  setOptions('#rWant', grouped('<option value="FRC">FRC</option>') + btcOpt);

  // order-book filters (grouped the same way; 'all' stays ungrouped at the top)
  const fopt = `<option value="">${tr('all')}</option>` + grouped('<option value="FRC">FRC</option>');
  setOptions('#fGive', fopt); setOptions('#fWant', fopt + btcOpt);

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
        // desc price is a kria/kria ratio; the Want cell shows the TOTAL for the remainder
        // (what a full fill pays, maker-rounding matched), with the unit price in the tooltip
        const price = Number(BigInt(o.desc.priceNum)) / Number(BigInt(o.desc.priceDen)) * scaleOf(giveTag) / scaleOf(wantTag);
        const wantTotal = o.give ? (BigInt(o.give.pv) * BigInt(o.desc.priceNum) + BigInt(o.desc.priceDen) - 1n) / BigInt(o.desc.priceDen) : null;
        const act = mine
          ? (o.status === 'open' ? `<button class="rcancel" data-id="${o.id}">${tr('Cancel')}</button>` : o.status)
          : (o.status === 'open' && o.give && !o.needsResign)
            ? `<button class="rbtn" data-id="${o.id}">${tr('Buy')}</button>`
            : (o.status === 'open' && o.needsResign) ? `<span class="sub">${tr('awaiting seller')}</span>`   // remainder needs the maker's fresh signature (auto while their wallet is open)
            : o.status;
        return `<tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td><td>${give}</td>
          <td title="@ ${price.toLocaleString(getLang(), { maximumFractionDigits: 8 })} ${assetName(wantTag)}">${wantTotal !== null ? fmtA(wantTag ?? 'FRC', wantTotal) : '—'}</td><td class="act-cell">${act}</td></tr>`;
      }
      return `<tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td><td>${give}</td>
        <td>${fmtA(o.want.assetTag ?? 'FRC', BigInt(o.want.value))}</td><td class="act-cell">${o.status}</td></tr>`;
    };
    const rows = state.info.book.filter(o => (!fg || giveOf(o) === fg) && (!fw || wantOf(o) === fw) && (!fo || o.status === 'open')).reverse();
    // cross-chain BTC swaps ride the SAME table: the relay LP listing (FRC→BTC) + my in-flight
    // swaps, shown only when the filters don't exclude a BTC pair. Settlement is HTLC, not an
    // on-chain splice — marked with the ⇄ badge so it reads as cross-chain, not a ranged offer.
    const btcMatch = (!fg || fg === 'FRC') && (!fw || fw === 'BTC');
    let swapRows = '';
    const myP2p = new Map(loadP2p().map(r => [r.id, r]));
    if (state.swap) {
      // P2P board offers (BOTH directions): open ones from OTHERS get a Buy button; mine/in-flight
      // show status. Reverse (sell-BTC) offers give BTC / want FRC — the mirror of the forward row.
      for (const o of [...(state.p2p?.swaps || [])].reverse()) {
        const isRev = o.dir === 'sellBtc', gTag = isRev ? 'BTC' : 'FRC', wTag = isRev ? 'FRC' : 'BTC';
        if ((fg && fg !== gTag) || (fw && fw !== wTag)) continue;   // per-offer filter, both directions
        const mineRec = myP2p.get(o.id);
        const btcStr = `${(Number(BigInt(o.btcAmount)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC`;
        const sellStr = o.assetTag ? `${(Number(BigInt(o.frcAmount)) / scaleOf(o.assetTag)).toLocaleString(getLang())} ${assetName(o.assetTag)}` : `${frc(o.frcAmount)} FRC`;
        const give = isRev ? btcStr : sellStr, want = isRev ? sellStr : btcStr;
        // drop my FINISHED offers (role-aware!): btc_claimed/frc_claimed_rev end the MAKER's part,
        // but the TAKER still has a claim to make — dropping their record there orphans locked coins
        const makerDone = mineRec?.role === 'maker' && ((!isRev && o.status === 'btc_claimed') || (isRev && o.status === 'frc_claimed_rev'));
        if (mineRec && (o.status === 'done' || makerDone)) { dropP2p(o.id); continue; }
        let act;
        if (mineRec) act = (!isRev && mineRec.status === 'need_btc') ? `<button class="p2ppay rbtn" data-id="${o.id}">${tr('Pay BTC')}</button>`
          // my own OPEN offer (nothing locked yet) → let me cancel it
          : (o.status === 'open' && !o.frcHtlc && !o.btcHtlc) ? `<button class="p2pcancel" data-id="${o.id}">${tr('Cancel')}</button>`
          : `<span class="sub">${tr(o.status)}</span>`;
        else act = o.status === 'open' ? `<button class="p2ptake rbtn" data-id="${o.id}">${tr('Buy')}</button>` : `<span class="sub">${tr(o.status)}</span>`;
        if (o.status === 'open' || mineRec)
          swapRows += `<tr class="swap ${o.status === 'open' ? '' : 'filled'}"><td>${o.id.replace(/^p2p/, '')}</td><td>${give}</td><td>${want}</td><td class="act-cell">${act}</td></tr>`;
      }
      for (const w of (btcMatch ? loadMySwaps() : [])) {
        const past = state.mine.height > w.T1;
        swapRows += `<tr class="swap ${past ? '' : 'filled'}"><td></td><td>${Number(BigInt(w.funding.value)) / 1e8} FRC</td><td>BTC</td><td class="act-cell sub">${past ? tr('refundable') : tr('in progress')}</td></tr>`;
      }
    }
    $('#bookBody').innerHTML = (rows.map(bookRow).join('') + swapRows)
      || `<tr><td colspan="4" class="sub">${state.info.book.length ? tr('no offers match') : tr('no offers yet')}</td></tr>`;
    // (LP swap button removed with the listing)
    $('#bookBody').querySelectorAll('.p2ptake').forEach(b => b.onclick = () => {
      const o = (state.p2p?.swaps || []).find(x => x.id === b.dataset.id); if (!o) return;
      o.dir === 'sellBtc' ? openP2pTakeModalB(o) : openP2pTakeModal(o);
    });
    $('#bookBody').querySelectorAll('.p2ppay').forEach(b => b.onclick = () => {
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (rec) openP2pPayModal(rec);
    });
    $('#bookBody').querySelectorAll('.p2pcancel').forEach(b => b.onclick = async () => {
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (!rec) return;
      try { await api('p2pCancel', { id: rec.id, makerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) }); dropP2p(rec.id); toast(tr('offer cancelled'), 'ok'); mvRefresh(); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('#bookBody').querySelectorAll('.rbtn:not(.p2ptake):not(.p2ppay)').forEach(b => b.onclick = () => {
      const offer = state.info.book.find(o => o.id === +b.dataset.id);
      if (offer) openBuyModal(offer);
    });
    $('#bookBody').querySelectorAll('.rcancel').forEach(b => b.onclick = () => {
      const offer = state.info.book.find(o => o.id === +b.dataset.id);
      if (offer) cancelRanged(offer);
    });
  }
}
