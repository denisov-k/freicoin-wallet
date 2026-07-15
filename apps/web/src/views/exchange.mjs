// market-view.mjs — the Freimarkets Issue + Exchange tabs, mounted inside the WALLET on the
// Freimarkets (nv3) network. Non-custodial: keys/signing on the client (the seed is handed in
// from the wallet's unlocked session via mvSetSeed), chain reads come from the wallet's own
// light client (ds().assets()), and the relay (:5181, proxied at /api) provides only the order
// book, issuance funding and broadcast — it can mislabel but never steal.
import { deriveAddress, currentNet, addrToSpk } from '@/services/wallet.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '@core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, rangedSighash, SIGHASH_ALL, SIGHASH_BUNDLE } from '@core/sighash.mjs';
import { serializeTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { makeTokenReveal } from '@core/nv3wire.mjs';
import { sha256, hash160 } from '@core/crypto.mjs';
import { frcLeg, refundGiven } from '@core/swap.mjs';
import { paymentHashOf } from '@core/htlc.mjs';
import { btcHtlcClaim, btcAddress } from '@core/btc.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import { loadMySwaps, putMySwap, dropMySwap, loadP2p, putP2p, dropP2p, addBtcNonce, addFeeTxid, lsKey } from '@/services/storage.mjs';
import { refreshPushSubs } from '@/services/push.mjs';
import { api, ctx, p2pKey, HOST_TAG, decimalsOf, scaleOf, assetName, rateOf, swapNet, btcFeeFor, VB_HTLC_SPEND } from '@/state/market-ctx.mjs';
import { opIn, signInput, committedOutpoints, myCoinsOf, freeFrcKria, sendFrcToSpk, hostFeeCoin, lockAssetToHtlc } from '@/services/market/swap-lib.mjs';
import { btcHrp, btcAcctAddr, btcFundHtlc, btcToStr, refreshBtc,
  mvBtc, mvBtcAddress, mvBtcValidAddr, mvSendBtc, initBtcAccount, btcResetAcct } from '@/services/market/btc-account.mjs';
import { recoverBtcNonces, mvBtcHistory, initActivity, resetRecovery } from '@/services/market/activity.mjs';
import { driveP2p, checkP2pRefunds, checkBtcRefunds, initDrive } from '@/services/market/swap-drive.mjs';
import { $, q, rev, frc, num, setOptions, skel, skelRows } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { armOverlay, closeOverlay } from '@/components/modal.mjs';
export { mvBtc, mvBtcAddress, mvBtcValidAddr, mvSendBtc };   // BTC account lives in its own module; re-exported so the wallet imports stay stable
export { mvBtcHistory };                                      // activity/recovery in mv-activity.mjs; re-exported for the wallet

const ACCOUNT = "m/84'/1'/0'";              // nv3 = coin type 1 (Freimarkets shares the regtest branch)
// $/q/rev/frc/num/setOptions/skelRows → @/components/dom.mjs; toast → @/components/toast.mjs

let seed = null, km = {}, spks = [], myAddress = '', state = null, _ds = null;
// wired from the wallet: initMarketView(ds) injects its light source; mvSetSeed(hexSeed) on unlock.
export function initMarketView(ds) { _ds = ds; initBtcAccount(recoverBtcNonces); initActivity(doRefresh); initDrive({ toast, mvRefresh }); }
export function mvSetSeed(hexSeed) {
  // A DIFFERENT key ⇒ drop the previous seed's snapshot (asset balances + BTC account) so the
  // balance repaints a skeleton, not the old account's numbers, until the next mvRefresh lands —
  // same reason mvResetNet clears on a network switch. Gated on an actual change because this runs
  // on EVERY renderApp; resetting unconditionally would flicker the balance to a skeleton each time.
  if (hexSeed !== seed) { state = null; ctx.state = null; btcResetAcct(); }
  seed = hexSeed; ctx.seed = hexSeed; deriveKeys();
}
// Network switch: drop the OLD network's snapshot so the new net paints a skeleton, not stale
// numbers. The next mvRefresh rebuilds everything against the new net's relay/light client.
export function mvResetNet() { state = null; ctx.state = null; btcResetAcct(); }
export function mvMyAddress() { return myAddress; }

// Relay-known asset names (UNVERIFIED — display fallback only; scan-verified defs win).
export const mvRelayAssets = () => api('info').then(i => i.assets || []);

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
  ctx.spks = spks; ctx.km = km;               // mirror for the extracted modules (read via ctx)
}
// signInput / opIn / coin-selection / HTLC-funding helpers moved to mv-swap-lib.mjs (shared with the drive)

// ---- data ----
// asset RATES come from the light client's self-certified defs (tag = Hash160(def)); the
// relay's names are cosmetic (a lie only mislabels, it can't misprice).
// name preference: the light client's from-chain name (trustless, read from the defining block)
// (HOST_TAG / decimalsOf / scaleOf / assetName / rateOf moved to mv-ctx — shared across modules)

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
  const net0 = currentNet();   // a refresh that STARTED on the old network must not write its snapshot after a switch
  // The BALANCE must never depend on the relay: the wallet's own light client is the source of
  // truth for coins, the relay only adds the order book / swap surfaces. A dark relay (crashed,
  // deploying, blocked) therefore degrades the EXCHANGE, not the wallet — info falls back to an
  // empty board and everything below keeps painting from `r` (the trustless scan).
  const [infoRaw, r, swap, p2p] = await Promise.all([api('info').catch(() => null), _ds().assets(), api('swapInfo').catch(() => null), api('p2pList').catch(() => null)]);
  if (currentNet() !== net0) return;   // network switched mid-flight — discard the stale snapshot
  const info = infoRaw ?? { assets: [], book: [], events: [], height: 0, chainId: null };
  // A wiped/replaced test chain invalidates every local swap record — detect via the genesis hash
  // and drop them, or ghosts of the old chain's swaps haunt the balance/activity forever.
  try {
    // versioned marker keyed on the chain EPOCH (block-1 hash), not the genesis hash: a wiped
    // REGTEST chain regenerates the SAME deterministic genesis (so chainId is useless for detecting
    // a reset) but a FRESH block 1 — so the epoch changes on every reset and stays stable across mere
    // relay restarts. Falls back to chainId if the relay is too old to send an epoch. Bumping the
    // version prefix also forces ONE clear on deploy, dropping any pre-fix ghost records.
    const epoch = info.chainEpoch ?? info.chainId;
    const mark = 'v4:' + epoch;
    if (epoch && localStorage.getItem(lsKey('fw_mkt_chain')) !== mark) {
      // NB: fw_btc_nonces survives — it derives BTC-side addresses, and the BTC chain (signet)
      // is NOT wiped with the test chain; dropping it would orphan real proceeds.
      for (const k of ['fw_p2p', 'fw_swap_hist', 'fw_swaps', 'fw_reldefs']) localStorage.removeItem(lsKey(k));
      localStorage.setItem(lsKey('fw_mkt_chain'), mark);
      resetRecovery();   // let recovery re-run against the new chain
    }
  } catch {}
  state = { info, defs: r.assetDefs, mine: { height: r.tipHeight, utxos: r.assetUtxos }, swap, p2p };
  ctx.state = state;                          // mirror for the extracted modules (read via ctx)
  // cache relay defs for the light client's next boot (seedDefs) — rates for history valuation only.
  // Deliberately WITHOUT decimals: display decimals are self-certified on-chain, so they must come from
  // the trustless scan or fresh relay info — never a cached seed (a stale one rendered "1 Test1" as "0.0001").
  // (skip when the relay is dark — an empty write would wipe a perfectly good cache)
  if (infoRaw) try { localStorage.setItem(lsKey('fw_reldefs'), JSON.stringify(Object.fromEntries(
    (info.assets || []).map(a => [a.tag, { shift: a.shift, interest: a.interest, name: a.name }])))); } catch {}
  if ($('#bookBody')) paint();                 // Exchange tab mounted → repaint the book
  if ($('#assetBalBody')) paintAssetBalance(); // Freimarkets Balance tab mounted → per-asset table
  maybeResignRanged();                                      // keep my ranged offers alive after partial fills
  checkMySwaps();                                           // refund any of my LP swaps stalled past their timeout
  checkP2pRefunds();                                        // auto-refund a P2P HTLC I locked once its CLTV passes
  checkBtcRefunds();                                        // auto-refund my BTC HTLC (buyer paid, seller vanished) once T2 passes
  driveP2p();                                               // advance my P2P swaps (both roles) on my turn
  refreshBtc();                                             // refresh the in-wallet BTC balance (watch-only)
  refreshPushSubs();                                        // keep the relay's push book pointed at my swap keys (throttled)
}

// checkP2pRefunds (FRC/asset leg) + checkBtcRefunds (my BTC leg) moved to mv-swap-drive.mjs

// ---- actions ----
async function faucet() { try { await api('faucet', { address: myAddress }); toast(tr('Faucet: +1 FRC'), 'ok'); mvRefresh(); } catch (e) { toast(e.message, 'err'); } }


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

// committedOutpoints / freeFrcKria / myCoinsOf moved to mv-swap-lib.mjs (shared with the drive)

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
  const feeCoin = state.mine.utxos.find(x => (x.assetTag ?? null) === null && !x.tokenHash && x.refheight <= L && !reserved.has(x.outpoint)
    && assetPresentValue(BigInt(x.value), L - x.refheight, { k: 20, interest: false }) >= fee + 1000n);
  if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
  const feePv = assetPresentValue(BigInt(feeCoin.value), L - feeCoin.refheight, { k: 20, interest: false });
  inputs.push({ outpoint: feeCoin.outpoint, spk: feeCoin.spk, value: BigInt(feeCoin.value), refheight: feeCoin.refheight });
  if (feePv - fee > 0n) vout.push({ value: feePv - fee, scriptPubKey: changeSpk, assetTag: HOST_TAG });
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(opIn), vout };   // plain asset move ⇒ standard v2 (tag rides the spk; conservation is version-independent)
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  mvRefresh();
  return txid;
}

// token coins of one asset (Send view routes these through the whole-coin flow)
export function mvTokenCoins(tag) {
  return (state?.mine.utxos ?? []).filter(u => (u.assetTag ?? null) === tag && u.tokenHash)
    .map(u => ({ outpoint: u.outpoint, tokens: u.tokens ?? [] }));
}

// Send tokens off a committed coin. `picked` = the token hexes to send (default: all). A
// committed coin only spends with a two-sided FRT1 reveal: the input section proves what the
// coin held (vs its stored hash); the output section commits the sent subset to the
// recipient's coin and — when items remain — the rest to a change coin of ours. Units split
// pro-rata with the items (our token issues mint one flat unit per item).
export async function mvSendTokenCoin(outpoint, toSpk, picked = null) {
  if (!state) await doRefresh();
  const u = state.mine.utxos.find(x => x.outpoint === outpoint);
  if (!u || !u.tokenHash) throw new Error(tr('offer coin is gone'));
  if (!u.tokens?.length) throw new Error(tr('this coin\u2019s token list is not recovered yet \u2014 wait for a full sync'));
  const all = u.tokens;
  const send = picked === null ? all : all.filter(h => picked.includes(h));
  if (!send.length) throw new Error(tr('add at least one item'));
  const keep = all.filter(h => !send.includes(h));
  const L = state.mine.height, fee = 10000n, changeSpk = spks[0];
  const reserved = committedOutpoints();
  const feeCoin = state.mine.utxos.find(x => (x.assetTag ?? null) === null && !x.tokenHash && x.refheight <= L && !reserved.has(x.outpoint)
    && assetPresentValue(BigInt(x.value), L - x.refheight, { k: 20, interest: false }) >= fee + 1000n);
  if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
  const feePv = assetPresentValue(BigInt(feeCoin.value), L - feeCoin.refheight, { k: 20, interest: false });
  const pv = /** @type {bigint} */ (assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(u.assetTag)));
  const vShare = keep.length ? pv * BigInt(send.length) / BigInt(all.length) : pv;
  /** @type {{value: bigint, scriptPubKey: string, assetTag?: string|null, tokens?: string[]}[]} */
  const vout = [{ value: vShare, scriptPubKey: toSpk, assetTag: u.assetTag, tokens: send }];
  if (keep.length) vout.push({ value: pv - vShare, scriptPubKey: changeSpk, assetTag: u.assetTag, tokens: keep });
  if (feePv - fee > 0n) vout.push({ value: feePv - fee, scriptPubKey: changeSpk, assetTag: HOST_TAG });
  const reveal = makeTokenReveal(vout, [{ tokens: all }, {}]);
  const n = reveal.length / 2;
  vout.push({ value: 0n, scriptPubKey: '6a' + (n <= 75 ? n.toString(16).padStart(2, '0') : '4c' + n.toString(16).padStart(2, '0')) + reveal });
  const inputs = [u, feeCoin].map(c => ({ outpoint: c.outpoint, spk: c.spk, value: BigInt(c.value), refheight: c.refheight }));
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(c => opIn(c.outpoint)), vout };
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  mvRefresh();
  return txid;
}

// modal: pick the destination for a token coin (address -> spk via the wallet's decoder)
function openTokenSendModal(outpoint) {
  const u = state?.mine.utxos.find(x => x.outpoint === outpoint);
  if (!u || $('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>\ud83c\udf9f ${tr('Send tokens')}</b><button id="tsClose" class="icon">\u2715</button></div>
    <p class="sub" style="font-size:12px">${tr('Pick the items to send — the rest come back to you on a new coin.')}</p>
    <div class="stack" id="tsList">${(u.tokens ?? []).map((h, i) => `<label class="chk"><input type="checkbox" data-h="${h}">${tokLabel(h)}</label>`).join('')}</div>
    <label>${tr('Recipient address')}<input id="tsAddr" placeholder="fcrt1\u2026"></label>
    <button id="tsSend">${tr('Send')}</button></div>`;
  document.body.appendChild(m);
  armOverlay(m);
  q(m, '#tsClose').onclick = () => closeOverlay(m);
  q(m, '#tsSend').onclick = async () => {
    try {
      const picked = [...m.querySelectorAll('#tsList input:checked')].map(x => /** @type {HTMLElement} */(x).dataset.h);
      const spk = addrToSpk(q(m, '#tsAddr').value.trim());
      await mvSendTokenCoin(outpoint, spk, picked);
      m.remove(); toast(tr('Sent'), 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// display label for a token bitstring: utf8 when printable, else short hex
export function tokLabel(hex) {
  try {
    const s = decodeURIComponent(hex.replace(/(..)/g, '%$1'));
    if (/^[^\x00-\x1f\x7f<>&"']+$/.test(s)) return s;
  } catch { /* not utf8 */ }
  return hex.slice(0, 16) + (hex.length > 16 ? '\u2026' : '');
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
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(opIn), vout };   // plain asset move ⇒ standard v2 (tag rides the spk; conservation is version-independent)
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'consolidate' });
  addFeeTxid(txid);   // net-zero self-spend — Activity labels it "exchange fee", not a send
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
      // partial sell of BTC: buyers take pieces (min/max in BTC); remaining tracked in BTC
      let opts = null;
      if ($('#rPartial')?.checked) {
        // the relay bounces a fill whose BTC leg is below its fee-derived floor (minSwap sats), so
        // enforce it HERE — else the offer advertises a min the taker can never fill (e.g. "1–99"
        // that the counterparty sees as "37–99"). Reverse offer sells BTC ⇒ the floor is in sats.
        const floorSats = BigInt(Math.round(Number(state?.p2p?.minSwap ?? 0)));
        let mn = $('#rMin')?.value ? BigInt(Math.round(num($('#rMin').value) * 1e8)) : 1n;
        const mx = $('#rMax')?.value ? BigInt(Math.round(num($('#rMax').value) * 1e8)) : BigInt(Math.round(btcQ * 1e8));
        const raised = mn < floorSats; if (raised) mn = floorSats;
        if (mn <= 0n || mn > mx || mx > BigInt(Math.round(btcQ * 1e8)))
          throw new Error(raised ? tr('the whole offer is below the network-fee floor — increase the amount or price') : tr('bad min/max'));
        if (raised) toast(`${tr('minimum raised to')} ${(Number(mn) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC ${tr('(network-fee floor)')}`);
        opts = { partial: true, minSats: mn, maxSats: mx };
      }
      $('#modal')?.remove();
      return postP2pOfferB(btcQ, wantV, wantTag, opts);
    }
    // want = BTC ⇒ post a P2P swap offer at YOUR price (FRC quantity → BTC amount). The board
    // matches it with a taker; the HTLC dance runs non-custodially. (Not a ranged offer.)
    if ($('#rWant').value === 'BTC') {
      const sell = $('#rAsset').value, btcQ = num($('#rPrice').value), qty = num($('#rQty').value);
      if (!(btcQ > 0)) throw new Error(tr('enter a quantity'));
      if (!(qty > 0)) throw new Error(tr('enter a quantity'));
      const scale = sell === 'FRC' ? 1e8 : scaleOf(sell);
      // partial fill: buyers take pieces within [min, max]; the offer keeps selling the remainder
      let opts = null;
      if ($('#rPartial')?.checked) {
        // Forward offer sells FRC/asset for BTC. The relay's fee floor (minSwap sats) maps to a
        // minimum in the SOLD unit via the offer price — ceil(minSwap · qtyKria / btcSats), the same
        // conversion the taker applies. Enforce it now so the advertised min matches what fills.
        const minSwap = Math.round(Number(state?.p2p?.minSwap ?? 0));
        const qtyK = Math.round(qty * scale), btcSats = Math.round(btcQ * 1e8);
        const floorUnits = (minSwap > 0 && btcSats > 0) ? BigInt(Math.ceil(minSwap * qtyK / btcSats)) : 0n;
        let mn = $('#rMin')?.value ? BigInt(Math.round(num($('#rMin').value) * scale)) : 1n;
        const mx = $('#rMax')?.value ? BigInt(Math.round(num($('#rMax').value) * scale)) : BigInt(Math.round(qty * scale));
        const raised = mn < floorUnits; if (raised) mn = floorUnits;
        if (mn <= 0n || mn > mx || mx > BigInt(Math.round(qty * scale)))
          throw new Error(raised ? tr('the whole offer is below the network-fee floor — increase the amount or price') : tr('bad min/max'));
        if (raised) toast(`${tr('minimum raised to')} ${(Number(mn) / scale).toLocaleString(getLang())} ${sell === 'FRC' ? 'FRC' : assetName(sell)} ${tr('(network-fee floor)')}`);
        opts = { partial: true, minUnits: mn, maxUnits: mx };
      }
      if (sell !== 'FRC') {   // sell a user-issued asset for BTC
        const units = BigInt(Math.round(qty * scaleOf(sell)));
        const held = myCoinsOf(sell, state.mine.height).reduce((s, c) => s + c.pv, 0n);
        if (units > held) throw new Error(`${tr('only')} ${(Number(held) / scaleOf(sell)).toLocaleString(getLang())} ${assetName(sell)} ${tr('free to lock (rest backs your open offers)')}`);
        $('#modal')?.remove();
        return postP2pOffer(qty, btcQ, sell, opts);
      }
      const maxK = freeFrcKria() - 10000n;                             // fee-reserved free FRC
      if (BigInt(Math.round(qty * 1e8)) > maxK)                        // can't lock more than we have free
        throw new Error(`${tr('only')} ${frc(maxK > 0n ? maxK : 0n)} FRC ${tr('free to lock (rest backs your open offers)')}`);
      $('#modal')?.remove();
      return postP2pOffer(qty, btcQ, null, opts);
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
    // Min/Max are in GIVE-asset display units (like the swap paths). Defaults: min 0 (any), max Q.
    const gs = scaleOf(giveTag);
    let minFill = !partial ? Q : ($('#rMin')?.value ? BigInt(Math.round(num($('#rMin').value) * gs)) : 0n);
    let maxFill = !partial ? Q : ($('#rMax')?.value ? BigInt(Math.round(num($('#rMax').value) * gs)) : Q);
    if (maxFill > Q) maxFill = Q;
    if (minFill < 0n || minFill > maxFill) throw new Error(tr('bad min/max'));
    const give = await prepareGiveCoin(giveTag, Q, L, coins);
    const expireAt = give.L + LADDER_SPAN;
    const desc = { payoutAsset: wantTag, payoutScript: give.spk, priceNum, priceDen, changeScript: give.spk, minFill, maxFill, nExpireTime: expireAt };
    toast(tr('signing the offer ladder…'));
    const ladder = await signLadder(desc, give, give.outpoint, give.L, expireAt);
    // makerPub lets the relay push «переподпишите» when a partial fill orphans the remainder
    const makerPub = pubkeyCompressed(km[give.spk].priv.toString(16).padStart(64, '0'));
    await api('rangedOffer', { makerSpk: give.spk, giveOutpoint: give.outpoint, desc, nExpireTime: expireAt, lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder, makerPub });
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
    <div class="sub" id="rAvail" style="font-size:13px"></div>
    <div class="row offer-row"><label>${tr('I sell')}<select id="rAsset"></select></label><label class="numfield">${tr('Quantity')}<input id="rQty" type="text" inputmode="decimal"></label></div>
    <div class="row offer-row"><label>${tr('I want')}<select id="rWant"></select></label><label id="rPriceLbl" class="numfield">${tr('Quantity')}<input id="rPrice" type="text" inputmode="decimal"></label></div>
    <label class="chk" id="rPartialLbl"><input type="checkbox" id="rPartial">${tr('allow partial fills')}</label>
    <div class="row offer-row" id="rMinMax"><label class="numfield">${tr('Min')}<input id="rMin" type="text" inputmode="decimal"></label><label class="numfield">${tr('Max')}<input id="rMax" type="text" inputmode="decimal"></label></div>
    <p class="sub" style="font-size:12px;margin-top:0" id="rHint">${tr('Buyers fill any amount; the remainder keeps trading while you are online.')}</p>
    <p class="warn" id="rWarn" hidden></p>
    <button id="rOfferBtn">${tr('Post offer')}</button></div>`;
  document.body.appendChild(m);
  armOverlay(m);   // tap outside the card = close
  q(m, '#offerClose').onclick = () => closeOverlay(m);
  q(m, '#rOfferBtn').onclick = postRangedOffer;
  // ONE partial-fill control for EVERY offer type (DEX FRC↔asset, forward →BTC swap, reverse
  // BTC→ swap). Min/Max appear whenever it's on; the hint explains the state and, for cross-chain
  // swaps, adds the per-fill BTC claim fee. No per-currency checkbox juggling ⇒ the partial state
  // survives a currency switch, and both min/max and the hint are consistent everywhere.
  const isSwap = () => $('#rWant')?.value === 'BTC' || $('#rAsset')?.value === 'BTC';
  const updateHint = () => {
    const partial = $('#rPartial')?.checked;
    let msg = partial
      ? tr('Buyers fill any amount; the remainder keeps trading while you are online.')
      : tr('The offer can only be taken whole — one buyer, the full quantity.');
    if (isSwap()) {
      const btcQ = num(($('#rWant')?.value === 'BTC' ? $('#rPrice') : $('#rQty'))?.value || '');
      if (btcQ > 0) msg += ` · ${Number(btcFeeFor(VB_HTLC_SPEND))} ${tr('sat network fee per fill')}`;
    }
    $('#rHint').textContent = msg;
  };
  // The relay's fee floor (minSwap sats) as a MINIMUM in the Min/Max field's own unit: BTC for a
  // reverse (sell-BTC) offer, the sold asset for a forward (want-BTC) one, none for a DEX offer.
  const floorOf = () => {
    if (!$('#rPartial')?.checked) return 0;
    const ms = Number(state?.p2p?.minSwap ?? 0); if (!ms) return 0;
    const sell = $('#rAsset')?.value, want = $('#rWant')?.value;
    if (sell === 'BTC') return ms / 1e8;                                   // reverse: Min/Max in BTC
    if (want === 'BTC') {                                                  // forward: Min/Max in the sold unit
      const scale = sell === 'FRC' ? 1e8 : scaleOf(sell);
      const qtyK = Math.round(num($('#rQty')?.value || '') * scale), btcSats = Math.round(num($('#rPrice')?.value || '') * 1e8);
      if (!(qtyK > 0) || !(btcSats > 0)) return 0;
      return Math.ceil(ms * qtyK / btcSats) / scale;                      // floor in display units
    }
    return 0;                                                             // DEX FRC↔asset: no BTC fee floor
  };
  // Live guard: show a warning + BLOCK the button while the offer's min would be below the floor
  // (or the whole offer is), instead of only clamping at submit. The floor rides the Min placeholder.
  const validate = () => {
    const btn = $('#rOfferBtn'); if (!btn) return;
    const floor = floorOf(); const fs = floor > 0 ? floor.toLocaleString(getLang(), { maximumFractionDigits: 8 }) : '';
    if ($('#rMin')) $('#rMin').placeholder = fs;
    const minRaw = $('#rMin')?.value, maxRaw = $('#rMax')?.value;
    let bad = '';
    if (floor > 0 && maxRaw && num(maxRaw) < floor) bad = tr('the whole offer is below the network-fee floor — increase the amount or price');
    else if (floor > 0 && minRaw && num(minRaw) < floor) bad = `${tr('minimum must be at least')} ${fs}`;
    else if (minRaw && maxRaw && num(minRaw) > num(maxRaw)) bad = tr('bad min/max');
    const warn = $('#rWarn'); if (warn) { warn.textContent = bad; warn.hidden = !bad; }
    btn.disabled = !!bad;
  };
  const refresh = () => { updateHint(); validate(); };
  const syncPartial = () => { $('#rMinMax').hidden = !$('#rPartial')?.checked; refresh(); };
  q(m, '#rPartial').onchange = syncPartial;
  for (const id of ['#rPrice', '#rQty', '#rMin', '#rMax']) q(m, id).addEventListener('input', refresh);
  // I sell = BTC ⇒ reverse swap (want FRC or a constant asset). Otherwise the want side drives it.
  q(m, '#rAsset').onchange = e => {
    paintOfferAvail();
    if (e.target.value === 'BTC') {   // sell BTC → want FRC or a CONSTANT asset (buy that asset)
      const consts = (state.info.assets || []);   // any user-issued asset (melt/grow settle via present value)
      setOptions('#rWant', '<option value="FRC">FRC</option>' + consts.map(a => `<option value="${a.tag}">${assetName(a.tag)}</option>`).join(''));
    } else if ($('#rWant').value !== 'BTC') {
      paint();                                     // a plain DEX offer: repopulate the want options
    }
    $('#rPriceLbl').childNodes[0].textContent = tr('Quantity');
    syncPartial();
  };
  // want = BTC ⇒ forward cross-chain swap; the sell side may be FRC or a held CONSTANT asset.
  q(m, '#rWant').onchange = e => {
    if (e.target.value === 'BTC') {
      // NO balance in the option label (same rule as the main list) — the Available line shows it
      const consts = heldConstAssets();
      setOptions('#rAsset', '<option value="FRC">FRC</option>' + consts.map(([t]) => `<option value="${t}">${assetName(t)}</option>`).join(''));
    }
    $('#rPriceLbl').childNodes[0].textContent = tr('Quantity');   // the want field IS your price
    syncPartial();
  };
  paint(); syncPartial();                // populate #rAsset / #rWant now
}
// human, role-aware status for a P2P swap row — the SELLER sees "waiting for the buyer" once
// they've locked, "claiming…" while collecting; the buyer sees "waiting for the seller" / progress.
// v2 order — forward: taken (buyer pays) → btc_funded (seller locks) → frc_funded (buyer claims)
// → frc_claimed (seller collects BTC) → done; reverse: taken → frc_funded_rev (maker locks BTC)
// → btc_funded_rev (taker claims BTC) → btc_claimed_rev (maker collects) → done.
function p2pStatusLabel(o, mineRec) {
  const st = o.status, maker = mineRec?.role === 'maker';
  if (maker) {
    if (st === 'taken') return tr('awaiting the buyer');                              // their payment pending
    if (st === 'btc_funded' || st === 'frc_funded_rev') return tr('locking…');        // my turn to lock
    if (st === 'frc_funded' || st === 'btc_funded_rev') return tr('awaiting the buyer');   // they claim now
    if (st === 'frc_claimed' || st === 'btc_claimed_rev') return tr('claiming…');     // I collect
  } else {
    if (st === 'taken') return tr('pay to continue');                                 // my payment opens the swap
    if (st === 'frc_funded' || st === 'btc_funded_rev') return tr('claiming…');       // my funds are up — claiming
    if (st.startsWith('btc_funded') || st.startsWith('frc_funded')) return tr('awaiting the seller');
    if (st === 'frc_claimed' || st === 'btc_claimed_rev') return tr('swap complete ✅');
  }
  return tr(st);
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
// show the AVAILABLE balance of the currently-selected "I sell" asset as a line under the offer
// title (updated on selection + each refresh). Everything is toppable externally, so this is
// informational, not a hard cap (the offer-post still validates the free-to-lock amount).
function paintOfferAvail() {
  const el = $('#rAvail'); if (!el || !state) return;
  const sell = $('#rAsset')?.value;
  if (!sell) { el.textContent = ''; return; }
  if (sell === 'BTC') {
    const b = mvBtc().balance;
    el.textContent = `${tr('Available')}: ${b != null ? (Number(BigInt(b)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 }) : '…'} BTC`;
    return;
  }
  const tag = sell === 'FRC' ? HOST_TAG : sell;
  const pv = myCoinsOf(tag, state.mine.height).reduce((s, c) => s + c.pv, 0n);
  el.textContent = `${tr('Available')}: ${(Number(pv) / scaleOf(tag)).toLocaleString(getLang(), { maximumFractionDigits: sell === 'FRC' ? 8 : decimalsOf(tag) })} ${assetName(sell === 'FRC' ? null : sell)}`;
}

// ---- cross-chain swap FRC → BTC (relay = BTC liquidity bot; we stay non-custodial) ----
// deterministic swap keys from the wallet seed (kept off the payment path — a swap key leak
// never touches wallet funds), one FRC key + one BTC key per swap id.
const swapPriv = (id, leg) => sha256(Buffer.from(seed + 'fw-swap:' + id + ':' + leg, 'utf8')).toString('hex');

// Persisted swap records — the SAFETY NET: whatever the relay or the network does, a swap we
// funded is refundable from these (+ the seed) after its T1. Survives reloads. (persistence in mv-storage)

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
// opIn / sendFrcToSpk / hostFeeCoin / lockAssetToHtlc moved to mv-swap-lib.mjs (shared with the drive)

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
  armOverlay(m);
  q(m, '#swClose').onclick = () => closeOverlay(m);
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
    const leg = frcLeg({ role: 'give', ourKey: frcKey, theirPub: c.relayFrcPub, paymentHash: H, cltv: T1, net: swapNet() });
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
// (P2P record persistence lives in mv-storage; p2pKey moved to mv-ctx — it needs the seed.)

// MAKER: post an FRC→BTC (or ASSET→BTC) offer at my price. v2 (taker-first): the SECRET lives
// with the taker, so the offer commits NO paymentHash — only my offer-level keys. Keys from a
// fresh nonce; children of a partial offer reuse them (uniqueness comes from each taker's H).
async function postP2pOffer(sellUnits, btcUnits, sellTag = null, opts = null) {
  try {
    const amount = sellTag ? BigInt(Math.round(sellUnits * scaleOf(sellTag))) : BigInt(Math.round(sellUnits * 1e8));
    const btcAmount = BigInt(Math.round(btcUnits * 1e8));
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-nonce:' + (sellTag || '') + amount + ':' + btcAmount + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const myBtcAddr = btcAddress(hash160(Buffer.from(btcPub, 'hex')).toString('hex'), state.swap?.btcHrp || 'tb');
    const body = { assetTag: sellTag || undefined, frcAmount: String(amount), btcAmount: String(btcAmount), makerFrcPub: frcPub, makerBtcPub: btcPub, makerBtcAddr: myBtcAddr,
      ...(opts?.partial ? { partial: true, minFill: String(opts.minUnits), maxFill: String(opts.maxUnits) } : {}) };
    const r = await api('p2pPost', body);
    addBtcNonce(nonce);
    putP2p({ id: r.id, role: 'maker', nonce, status: 'open', partial: !!opts?.partial, assetTag: sellTag || null, frcAmount: String(amount), btcAmount: String(btcAmount) });
    toast(tr('offer posted'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// MAKER (reverse): SELL BTC, want FRC or an ASSET (buy that asset with BTC). v2: no H here either.
async function postP2pOfferB(btcUnits, wantUnits, wantTag = null, opts = null) {
  try {
    const frcAmount = wantTag ? BigInt(Math.round(wantUnits * scaleOf(wantTag))) : BigInt(Math.round(wantUnits * 1e8));
    const btcAmount = BigInt(Math.round(btcUnits * 1e8));
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-nonce:B:' + (wantTag || '') + frcAmount + ':' + btcAmount + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const body = { assetTag: wantTag || undefined, frcAmount: String(frcAmount), btcAmount: String(btcAmount), makerFrcPub: frcPub, makerBtcPub: btcPub, makerFrcAddr: deriveAddress(seed, 0, 0),
      ...(opts?.partial ? { partial: true, minFill: String(opts.minSats), maxFill: String(opts.maxSats) } : {}) };
    const r = await api('p2pPostB', body);
    addBtcNonce(nonce);
    putP2p({ id: r.id, role: 'maker', dir: 'sellBtc', nonce, status: 'open', partial: !!opts?.partial, assetTag: wantTag || null, frcAmount: String(frcAmount), btcAmount: String(btcAmount) });
    toast(tr('offer posted'), 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}
// TAKER (reverse): accept a sell-BTC offer — I pay FRC/asset, receive BTC into my account.
// v2: I hold R and fund my FRC/asset HTLC RIGHT NOW (far timeout); the maker responds with BTC.
async function takeP2pB(offer, fillSats = null) {
  try {
    const nonce = fillSats != null
      ? sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id + ':' + fillSats + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16)
      : sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const H = paymentHashOf(p2pKey(nonce, 'R'));
    const r = await api('p2pTakeB', { id: offer.id, ...(fillSats != null ? { fill: String(fillSats) } : {}), takerFrcPub: frcPub, takerBtcPub: btcPub, takerBtcAddr: btcAcctAddr(), paymentHash: H });
    addBtcNonce(nonce);
    const tag = offer.assetTag ?? null;
    // fund my give-side HTLC immediately — this IS the commitment that makes the take real
    const fund = tag ? await lockAssetToHtlc(r.frcHtlc.spk, tag, BigInt(r.frcAmount)) : await sendFrcToSpk(r.frcHtlc.spk, BigInt(r.frcAmount));
    putP2p({ id: r.id, role: 'taker', dir: 'sellBtc', ...(fillSats != null ? { parent: offer.id } : {}), nonce, status: 'frc_funded_rev',
      assetTag: tag, frcAmount: r.frcAmount, btcAmount: r.btcAmount, paymentHash: H, leaf: r.frcHtlc.leaf, T1: r.frcHtlc.cltv,
      funding: { txid: fund.txid, vout: fund.vout, value: r.frcAmount, refheight: fund.refheight ?? state.mine.height } });
    await api('p2pFrcFundedB', { id: r.id, txid: fund.txid, vout: fund.vout });
    toast(tr('locked — the seller sends BTC, it arrives automatically'), 'ok'); mvRefresh();
    return r.id;
  } catch (e) { toast(e.message, 'err'); return null; }
}

// TAKER (partial): pick an amount within [min, max] ≤ remaining, buy that piece; the window then
// continues to the pay-BTC step in place (like the whole-offer take).
function openP2pTakePartial(offer) {
  if ($('#modal')) return;
  const isRev = offer.dir === 'sellBtc';
  const wsc = offer.assetTag ? scaleOf(offer.assetTag) : 1e8, wname = offer.assetTag ? assetName(offer.assetTag) : 'FRC';
  // pick amount in the SOLD unit: forward = FRC/asset, reverse = BTC
  const asc = isRev ? 1e8 : wsc, aname = isRev ? 'BTC' : wname;
  const rem = Number(BigInt(offer.remaining)) / asc, mnOffer = Number(BigInt(offer.minFill || '1')) / asc, mx = Math.min(Number(BigInt(offer.maxFill || offer.remaining)) / asc, rem);
  // the relay refuses a fill whose BTC side is below its fee-derived floor (minSwap sats) — fold
  // that into the shown minimum, or "за раз 1–91" advertises pieces the relay will bounce
  const minSwap = Number(state?.p2p?.minSwap ?? 0);
  const aFloor = isRev ? minSwap / 1e8
    : minSwap * Number(BigInt(offer.frcAmount)) / Number(BigInt(offer.btcAmount)) / asc;
  const mn = Math.max(mnOffer, Math.ceil(aFloor * asc) / asc);
  // cost unit price: forward pays BTC per sold-unit; reverse pays FRC/asset per sold-BTC
  const costOf = a => isRev
    ? Math.ceil(a * 1e8 * Number(BigInt(offer.frcAmount)) / Number(BigInt(offer.btcAmount))) / wsc + ' ' + wname
    : Math.ceil(a * wsc * Number(BigInt(offer.btcAmount)) / Number(BigInt(offer.frcAmount))) / 1e8 + ' BTC';
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${aname}</b><button id="tkClose" class="icon">✕</button></div>
    <div class="sub" style="font-size:13px">${tr('Available')}: ${rem.toLocaleString(getLang())} ${aname} · ${tr('per-buy')} ${mn.toLocaleString(getLang())}–${mx.toLocaleString(getLang())}</div>
    <label class="numfield">${tr('Amount')}<input id="tpAmt" type="text" inputmode="decimal" placeholder="${mn}–${mx}"></label>
    <div class="rrow"><span>${tr('You pay')}</span><b id="tpCost">—</b></div>
    <button id="tkGo">${tr('Buy')}</button>
    <div id="tkLog" class="sub" style="font-size:12px;white-space:pre-line"></div></div>`;
  document.body.appendChild(m);
  let waitTimer = null; const stop = () => { clearInterval(waitTimer); m.remove(); };
  m.onclick = e => { if (e.target === m) stop(); };
  q(m, '#tkClose').onclick = stop;
  if (mn > mx) {   // even the largest allowed piece is under the relay's fee floor — nothing to buy
    q(m, '#tkGo').disabled = true; q(m, '#tpAmt').disabled = true;
    q(m, '#tkLog').textContent = tr('pieces are below the network fee floor — this offer cannot be bought right now');
  }
  const cost = () => { const a = num($('#tpAmt').value) || 0; $('#tpCost').textContent = a > 0 ? costOf(a) : '—'; };
  q(m, '#tpAmt').oninput = cost; cost();
  q(m, '#tkGo').onclick = async () => {
    const a = num($('#tpAmt').value);
    if (!(a >= mn && a <= mx)) { toast(`${mn}–${mx} ${aname}`, 'err'); return; }
    const go = $('#tkGo'); go.disabled = true; go.textContent = isRev ? tr('locking…') : '…';
    const cid = await takeP2pPart(offer, a, t => { const el = $('#tkLog'); if (el) el.textContent += (el.textContent ? '\n' : '') + t; });
    if (!cid) { go.disabled = false; go.textContent = tr('Buy'); return; }
    if (isRev) { stop(); return; }   // reverse v2: FRC/asset just locked; BTC arrives via the drive
    // forward v2: I pay FIRST — the take returned the BTC HTLC, morph into the pay step now
    const rec = loadP2p().find(x => x.id === cid);
    if (rec?.btcHtlc?.addr) renderP2pPay(m, rec); else stop();
  };
}
async function takeP2pPart(offer, fillUnits, log) {
  try {
    const isRev = offer.dir === 'sellBtc';
    const fill = BigInt(Math.round(fillUnits * (isRev ? 1e8 : (offer.assetTag ? scaleOf(offer.assetTag) : 1e8))));
    if (isRev) return await takeP2pB(offer, fill);   // v2: the reverse taker funds FRC/asset right away
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id + ':' + fill + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const H = paymentHashOf(p2pKey(nonce, 'R'));
    const r = await api('p2pTake', { id: offer.id, fill: String(fill), takerFrcPub: frcPub, takerBtcPub: btcPub, takerFrcAddr: deriveAddress(seed, 0, 0), paymentHash: H });
    addBtcNonce(nonce);
    // v2: the relay hands the BTC HTLC right away — the pay step opens immediately
    putP2p({ id: r.id, role: 'taker', dir: offer.dir, parent: offer.id, nonce, status: 'need_btc', assetTag: offer.assetTag ?? null, frcAmount: r.frcAmount, btcAmount: r.btcAmount, paymentHash: H, btcHtlc: r.btcHtlc });
    mvRefresh();
    return r.id;
  } catch (e) { log('⚠ ' + e.message); toast(e.message, 'err'); return null; }
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
  let waitTimer = null;
  const stop = () => { clearInterval(waitTimer); m.remove(); };
  m.onclick = e => { if (e.target === m) stop(); };
  q(m, '#tkClose').onclick = stop;
  q(m, '#tkGo').onclick = async () => {
    const ok = await takeP2p(offer, t => { const el = $('#tkLog'); if (el) el.textContent += (el.textContent ? '\n' : '') + t; });
    if (!ok) return;
    // forward v2: I pay FIRST — the take returned the BTC HTLC, morph into the pay step in place
    const rec = loadP2p().find(x => x.id === offer.id);
    if (rec?.btcHtlc?.addr) renderP2pPay(m, rec); else stop();
  };
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
    <p class="sub" style="font-size:12px">${tr('Your FRC/asset is locked right away; the BTC arrives automatically. Refundable if it stalls.')}</p></div>`;
  document.body.appendChild(m);
  armOverlay(m);
  q(m, '#tkClose').onclick = () => closeOverlay(m);
  q(m, '#tkGo').onclick = () => { m.remove(); takeP2pB(offer); };
}

async function takeP2p(offer, log) {
  const go = $('#tkGo'); if (go) { go.disabled = true; go.textContent = '…'; }
  try {
    const nonce = sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const H = paymentHashOf(p2pKey(nonce, 'R'));   // v2: I hold the secret and pay first
    const r = await api('p2pTake', { id: offer.id, takerFrcPub: frcPub, takerBtcPub: btcPub, takerFrcAddr: deriveAddress(seed, 0, 0), paymentHash: H });
    addBtcNonce(nonce);
    putP2p({ id: offer.id, role: 'taker', nonce, status: 'need_btc', assetTag: offer.assetTag ?? null, frcAmount: offer.frcAmount, btcAmount: offer.btcAmount, paymentHash: H, btcHtlc: r.btcHtlc });
    mvRefresh();
    return true;
  } catch (e) { log('⚠ ' + e.message); toast(e.message, 'err'); if (go) { go.disabled = false; go.textContent = tr('Buy'); } return false; }
}

// driveP2p / driveP2pInner / driveP2pRev (the swap engine) moved to mv-swap-drive.mjs
// btcFundHtlc (fund a BTC HTLC from the account) lives in mv-btc-account.mjs

// TAKER: pay the BTC HTLC from your own wallet (manual), then report the txid to the relay.
function openP2pPayModal(rec) {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  document.body.appendChild(m);
  renderP2pPay(m, rec);
}
// Render the pay-BTC step INTO an existing modal `m` (used both standalone and as the in-window
// continuation of the take modal) — HTLC address, auto-detect polling, cooperative cancel.
function renderP2pPay(m, rec) {
  const b = rec.btcHtlc; if (!b) return;
  const amt = BigInt(rec.btcAmount);
  const hasWallet = mvBtc().available;
  const rcvTag = rec.assetTag ?? null;   // what the buyer receives for the BTC (FRC or a user asset)
  const rcv = rec.frcAmount ? `${(Number(rec.frcAmount) / scaleOf(rcvTag)).toLocaleString(getLang(), { maximumFractionDigits: rcvTag ? decimalsOf(rcvTag) : 8 })} ${assetName(rcvTag)}` : '';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Pay BTC')}</b><button id="pyClose" class="icon">✕</button></div>
    <div class="sub" style="margin:-4px 0 8px;font-size:13px">${tr('Order')} ${rec.id}</div>
    ${hasWallet ? `<div class="seg" id="paySeg"><button data-pay="wallet" class="on">${tr('From wallet')}</button><button data-pay="ext">${tr('External payment')}</button></div>` : ''}
    <div class="rrow" id="pyBalRow"${hasWallet ? '' : ' style="display:none"'}><span>${tr('Available')}</span><b id="pyBal" class="sub">${tr('checking balance…')}</b></div>
    <div class="rrow"><span>${tr('Amount')}</span><b>${Number(amt) / 1e8} BTC</b></div>
    ${rcv ? `<div class="rrow"><span>${tr('You receive')}</span><b>${rcv}</b></div>` : ''}
    <div id="pyWalletPane"${hasWallet ? '' : ' style="display:none"'}>
      <button id="pyWallet" style="width:100%" disabled>${tr('Pay')}</button>
    </div>
    <div id="pyExtPane"${hasWallet ? ' style="display:none"' : ''}>
      <p class="sub">${tr('Send exactly this amount from any Bitcoin wallet to the address. The swap continues automatically once the payment is seen.')}</p>
      <label>${tr('HTLC address')}<div class="addr" style="user-select:all">${b.addr}</div></label>
    </div>
    <div id="pyStatus" class="sub" style="font-size:13px"></div>
    <button id="pyCancel" class="ghost">${tr('Cancel purchase')}</button></div>`;
  const close = () => { clearInterval(poll); clearInterval(balTimer); m.remove(); };
  m.onclick = e => { if (e.target === m) close(); };
  q(m, '#pyClose').onclick = close;
  // wallet / external toggle: swap which pane is visible, highlight the active segment.
  // the Available line belongs to the wallet path, so it follows the toggle too.
  const seg = $('#paySeg');
  if (seg) seg.querySelectorAll('button').forEach(sb => sb.onclick = () => {
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === sb));
    const wallet = sb.dataset.pay === 'wallet';
    const wp = $('#pyWalletPane'), ep = $('#pyExtPane'), br = $('#pyBalRow');
    if (wp) wp.style.display = wallet ? '' : 'none';
    if (br) br.style.display = wallet ? '' : 'none';
    if (ep) ep.style.display = wallet ? 'none' : '';
  });
  // pay the HTLC straight from the in-wallet BTC account (one tap); auto-detect finishes the swap
  let paying = false;
  const payFromWallet = async () => {
    const pw = $('#pyWallet'); if (!pw) return;
    paying = true; pw.disabled = true; pw.textContent = tr('awaiting the seller');
    try {
      const fund = await btcFundHtlc(b.addr, amt);
      // remember the funding txid on the local record so this BTC spend is folded into the trade row
      // (btcFundTxid) and never surfaces as a standalone "−0.00011 send" in the activity feed
      const rl = loadP2p().find(r => r.id === rec.id) || rec;
      putP2p({ ...rl, btcHtlc: { ...(rl.btcHtlc || b), txid: fund.txid, vout: fund.vout, value: fund.value } });
      try { await api('p2pBtcFunded', { id: rec.id, btcTxid: fund.txid }); } catch {}   // nudge the relay; auto-detect is the fallback
      // paid — the (disabled) button keeps reading "Ожидание продавца"; no separate status line for it
      refreshBtc();
    } catch (e) { toast(e.message, 'err'); paying = false; updateWalletBtn(); }
  };
  // the BTC balance loads async — keep the wallet button + the Available line in step with it,
  // don't lock them to a stale read. Balance lives on its own row now; the button just acts.
  const updateWalletBtn = () => {
    const pw = $('#pyWallet'), bl = $('#pyBal'), info = mvBtc(); if (!pw || !info.available || paying) return;
    if (info.balance == null) { pw.disabled = true; if (bl) bl.textContent = tr('checking balance…'); return; }
    const bal = BigInt(info.balance), ok = bal >= amt + 1000n;
    if (bl) bl.textContent = `${(Number(bal) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC`;
    pw.disabled = !ok;
    pw.textContent = ok ? tr('Pay') : tr('not enough BTC in wallet');
    pw.onclick = ok ? payFromWallet : null;
  };
  refreshBtc().then(updateWalletBtn);                       // kick a load now
  const balTimer = setInterval(updateWalletBtn, 1500);      // and track it until it lands
  // auto-detect + follow-through: poll until the swap is FULLY settled (the buyer's FRC/asset is
  // claimed), not merely until the payment is seen. The background drive claims the funds and drops
  // the local record; the modal stays open through the seller's turn and only closes on completion.
  let paidSeen = false;
  const poll = setInterval(async () => {
    try {
      const w = (await api('p2pList')).swaps.find(x => x.id === rec.id);
      const rlocal = loadP2p().find(r => r.id === rec.id);
      const st = $('#pyStatus');
      // v2 completion for the BUYER = my FRC/asset is claimed (frc_claimed); 'done' is just the
      // seller collecting their BTC afterwards. A dropped local record also means the drive finished.
      if (!rlocal || !w || w.status === 'done' || w.status === 'frc_claimed') {
        clearInterval(poll); clearInterval(balTimer);
        if (st) st.textContent = tr('swap complete ✅');
        setTimeout(() => m.remove(), 1800); mvRefresh(); return;
      }
      if (w.status !== 'taken') {                            // payment landed — now on the seller
        if (!paidSeen) { paidSeen = true; putP2p({ ...rlocal, status: 'btc_funded' }); mvRefresh(); }
        // the awaiting state lives on the button ("Ожидание продавца"); only surface the claiming step here
        if (st && w.status === 'frc_funded') st.textContent = tr('claiming your funds…');
      }
    } catch {}
  }, 4000);
  // back out. v2: BEFORE paying nothing is at stake — just drop the record (the relay zombie-expires
  // the take). AFTER paying, the BTC comes home automatically at the HTLC timeout (checkBtcRefunds).
  q(m, '#pyCancel').onclick = async () => {
    const rlocal = loadP2p().find(r => r.id === rec.id);
    if (rlocal?.btcHtlc?.txid) {
      // ALREADY PAID: ask the seller to authorize an instant coop refund. Allowed only while they
      // haven't locked (server-enforced); if they have, the BTC comes home at the timeout instead.
      const w = await api('p2pList').then(l => l.swaps.find(s => s.id === rec.id)).catch(() => null);
      if (w?.frcHtlc?.txid) { toast(tr('seller already locked — BTC auto-refunds at the timeout'), 'warn'); return; }
      try {
        await api('p2pBtcCancelReq', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) });
        toast(tr('cancel requested — waiting for the seller to authorize the refund'), 'ok');
        // the drive (checkBtcRefunds) completes the coop refund once btcCoopSig lands, even if this closes
      } catch (e) { toast(e.message, 'err'); }
      return;
    }
    // not paid yet: release the reservation right away (best-effort; zombie grace backs it up)
    try { await api('p2pUntake', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) }); } catch {}
    dropP2p(rec.id); close(); toast(tr('purchase cancelled'), 'ok'); mvRefresh();
  };
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
      const pool = state.mine.utxos.filter(x => (x.assetTag ?? null) === norm && !x.tokenHash && x.refheight <= L && !exclude.has(x.outpoint))
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
  // partial-buy bounds in display units: min from the offer descriptor, max = what's actually left
  // (the give coin's present value) capped by the offer's per-fill maximum
  const minU = Number(BigInt(o.desc.minFill) > 0n ? BigInt(o.desc.minFill) : 1n) / scaleOf(giveTag);
  const capK = BigInt(o.desc.maxFill) > 0n && BigInt(o.desc.maxFill) < maxK ? BigInt(o.desc.maxFill) : maxK;
  const capU = Number(capK) / scaleOf(giveTag);
  const costOf = u => { let f = BigInt(Math.round(u * scaleOf(giveTag))); if (f > maxK) f = maxK; return (f * pn + pd - 1n) / pd; };
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${assetName(giveTag)}</b><button id="bClose" class="icon">✕</button></div>
    ${whole ? '' : `<div class="sub" style="font-size:13px">${tr('Available')}: ${maxU.toLocaleString(getLang())} ${assetName(giveTag)} · ${tr('per-buy')} ${minU.toLocaleString(getLang())}–${capU.toLocaleString(getLang())}</div>`}
    <label>${tr('Quantity')}<div class="amtrow"><input id="bQty" type="text" inputmode="decimal" ${whole ? `value="${maxU}" disabled` : `placeholder="${minU.toLocaleString(getLang())}–${capU.toLocaleString(getLang())}"`}>${whole ? '' : `<button id="bMax" class="ghost">${tr('Max')}</button>`}</div></label>
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
  armOverlay(m);
  q(m, '#bClose').onclick = () => closeOverlay(m);
  q(m, '#bQty').oninput = cost;
  const bm = q(m, '#bMax'); if (bm) bm.onclick = () => { $('#bQty').value = capU; cost(); };
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
      const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin, vout };   // offer cancel = plain asset move ⇒ standard v2
      inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
      const cr = await api('tx', { rawtx: serializeTx(tx), kind: 'cancel' });
      addFeeTxid(cr.txid);   // net-zero self-spend — Activity labels it "exchange fee", not a send
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
// ---- in-wallet BTC account (signet) → mv-btc-account.mjs; Activity/recovery (recoverBtcNonces,
//      mvBtcHistory) → mv-activity.mjs; mvBtcAddress/mvBtcValidAddr/mvSendBtc → mv-btc-account.mjs.
//      All re-exported / injected at the top of this file. ----

// filter options from CACHED relay defs — shown instantly (before the first sync populates state);
// paint() refines them once state loads (drops BTC if no node, adds newly-seen assets).
function cachedFilterOpts() {
  let defs = {}; try { defs = JSON.parse(localStorage.getItem('fw_reldefs') || '{}'); } catch {}
  const assetOpts = Object.entries(defs).map(([tag, d]) => `<option value="${tag}">${d.name || tag.slice(0, 8) + '…'}</option>`).join('');
  return `<option value="">${tr('all')}</option><optgroup label="${tr('Currency')}"><option value="FRC">FRC</option><option value="BTC">BTC</option></optgroup>`
    + (assetOpts ? `<optgroup label="${tr('Assets')}">${assetOpts}</optgroup>` : '');
}
export function renderExchange(el) {
  const fopt = cachedFilterOpts();
  el.innerHTML = `
    <div class="row">
      <label>${tr('Selling')}<select id="fGive">${fopt}</select></label>
      <label>${tr('Wants')}<select id="fWant">${fopt}</select></label>
    </div>
    <label class="chk"><input type="checkbox" id="fOpen" checked>${tr('open only')}</label>
    <table class="mkt"><thead><tr><th>#</th><th>${tr('Give')}</th><th>${tr('Want')}</th><th></th></tr></thead><tbody id="bookBody"><tr><td colspan="4" style="padding:14px 2px 4px;border-bottom:none">${skel(3)}</td></tr></tbody></table>
    <div class="row"><button id="openOffer">${tr('Post an offer')}</button></div>`;
  $('#openOffer').onclick = openOfferModal;
  ['#fGive', '#fWant', '#fOpen'].forEach(s => { const e = $(s); if (e) e.onchange = paint; });
  if (state) paint(); else mvRefresh();
}
// per-asset balance table (FRC + user assets) — the wallet's Balance tab shows this on nv3
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
    // token coins of this asset get their own sub-rows: the set travels whole, so each COIN
    // (not each token) is the unit the user can act on
    const tokRows = state.mine.utxos
      .filter(u => (u.assetTag ?? 'FRC') === tag && u.tokenHash)
      .map(u => `<tr class="tokrow"><td class="sub" style="padding-left:18px">\ud83c\udf9f ${(u.tokens ?? []).map(tokLabel).join(' \u00b7 ') || tr('recovering\u2026')}</td><td class="r"><button class="ghost tokSend" data-op="${u.outpoint}" ${u.tokens?.length ? '' : 'disabled'}>\u27a4</button></td></tr>`)
      .join('');
    return `<tr><td${tag === 'FRC' ? '' : ` title="${tag}"`}>${assetName(tag === 'FRC' ? null : tag)}</td><td class="r ${melt ? 'melt' : grow ? 'grow' : ''}">${amt(tag, e.pv)}</td></tr>` + tokRows;
  });
  // BTC sits in the same table (held in-wallet on signet); the cell fills in when refreshBtc returns.
  if (state.swap?.available) rows.push(`<tr><td>BTC</td><td class="r" id="btcBalCell">${mvBtc().balance != null ? btcToStr(mvBtc().balance) : '…'}</td></tr>`);
  body.innerHTML = rows.join('') || `<tr><td colspan="2" class="sub">${tr('empty — tap Faucet')}</td></tr>`;
  body.querySelectorAll('button.tokSend').forEach(b => b.onclick = () => openTokenSendModal(b.dataset.op));
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

  // grouped asset options (used by the offer form and the filters): the currencies (FRC + BTC) in a
  // Currency group, user-issued assets in an Assets group.
  const assetOpts = state.info.assets.map(a => `<option value="${a.tag}">${assetName(a.tag)}</option>`).join('');
  const btcCur = state.swap?.available ? '<option value="BTC">BTC</option>' : '';   // BTC is a currency here, not a separate group
  const grouped = curOpt => `<optgroup label="${tr('Currency')}">${curOpt}${btcCur}</optgroup>`
    + (assetOpts ? `<optgroup label="${tr('Assets')}">${assetOpts}</optgroup>` : '');

  // "I sell": the assets I hold + BTC. NO balance in the option label — the selected balance shows
  // in the form (paintOfferAvail); everything is toppable externally, so a fixed label misleads.
  const sellOpt = k => `<option value="${k}">${assetName(k === 'FRC' ? null : k)}</option>`;
  const frcHeld = byAsset.get('FRC'), heldAssets = [...byAsset.entries()].filter(([k]) => k !== 'FRC');
  const sellCur = (frcHeld ? sellOpt('FRC') : '') + btcCur;
  setOptions('#rAsset', ((sellCur ? `<optgroup label="${tr('Currency')}">${sellCur}</optgroup>` : '')
    + (heldAssets.length ? `<optgroup label="${tr('Assets')}">${heldAssets.map(([k]) => sellOpt(k)).join('')}</optgroup>` : ''))
    || `<option value="">${tr('no coins yet')}</option>`);
  setOptions('#rWant', grouped('<option value="FRC">FRC</option>'));
  paintOfferAvail();   // reflect the selected sell asset's available balance in the form

  // order-book filters (grouped the same way — BTC lives in Currency; 'all' stays ungrouped at the top)
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
        const mineRec = myP2p.get(o.id);
        if (o.parent && !mineRec) continue;                        // others' in-flight sub-swaps: hidden
        const isOffer = o.kind === 'offer';                        // partial-offer container
        const isRev = o.dir === 'sellBtc', gTag = isRev ? 'BTC' : 'FRC', wTag = isRev ? 'FRC' : 'BTC';
        if ((fg && fg !== gTag) || (fw && fw !== wTag)) continue;   // per-offer filter, both directions
        // an offer shows what's LEFT; remaining is in the SOLD unit (FRC/asset forward, BTC reverse),
        // the other side is proportional to it
        let frcShown = o.frcAmount, btcShown = o.btcAmount;
        if (isOffer) {
          if (isRev) { btcShown = o.remaining; frcShown = String((BigInt(o.frcAmount) * BigInt(o.remaining) + BigInt(o.btcAmount) - 1n) / BigInt(o.btcAmount)); }
          else { frcShown = o.remaining; btcShown = String((BigInt(o.btcAmount) * BigInt(o.remaining) + BigInt(o.frcAmount) - 1n) / BigInt(o.frcAmount)); }
        }
        const btcStr = `${(Number(BigInt(btcShown)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC`;
        const sellStr = o.assetTag ? `${(Number(BigInt(frcShown)) / scaleOf(o.assetTag)).toLocaleString(getLang())} ${assetName(o.assetTag)}` : `${frc(frcShown)} FRC`;
        const give = isRev ? btcStr : sellStr, want = isRev ? sellStr : btcStr;
        // drop my FINISHED swaps (role-aware!): v1 btc_claimed/frc_claimed_rev ended the MAKER's
        // part; v2 frc_claimed/btc_claimed_rev end the TAKER's (their funds are claimed — the row
        // lingering while the maker collects their own side is just noise).
        const makerDone = mineRec?.role === 'maker' && ((!isRev && o.status === 'btc_claimed') || (isRev && o.status === 'frc_claimed_rev'));
        const takerDone = mineRec?.role === 'taker' && ['frc_claimed', 'btc_claimed_rev'].includes(o.status);
        if (mineRec && !isOffer && (o.status === 'done' || makerDone || takerDone)) { dropP2p(o.id); continue; }
        let act;
        if (isOffer) act = mineRec ? `<button class="p2pcancel" data-id="${o.id}">${tr('Cancel')}</button>`
          : `<button class="p2ptakepart rbtn" data-id="${o.id}">${tr('Buy')}</button>`;   // pick an amount
        else if (mineRec) act = (!isRev && mineRec.status === 'need_btc') ? `<button class="p2ppay rbtn" data-id="${o.id}">${tr('Pay')}</button>`
          : (o.status === 'open' && !o.frcHtlc && !o.btcHtlc) ? `<button class="p2pcancel" data-id="${o.id}">${tr('Cancel')}</button>`
          : `<span class="sub">${p2pStatusLabel(o, mineRec)}</span>`;
        else act = o.status === 'open' ? `<button class="p2ptake rbtn" data-id="${o.id}">${tr('Buy')}</button>` : `<span class="sub">${p2pStatusLabel(o, mineRec)}</span>`;
        // MY in-progress swaps carry a live action (Pay / a status) — never dim them; .filled is for
        // settled/other rows only (here that never actually triggers, but keep the intent explicit)
        if (o.status === 'open' || (mineRec && !isOffer))
          swapRows += `<tr class="swap ${o.status === 'open' || mineRec ? '' : 'filled'}"><td>${o.id.replace(/^p2p/, '')}</td><td>${give}</td><td>${want}</td><td class="act-cell">${act}</td></tr>`;
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
    $('#bookBody').querySelectorAll('.p2ptakepart').forEach(b => b.onclick = () => {
      const o = (state.p2p?.swaps || []).find(x => x.id === b.dataset.id); if (o) openP2pTakePartial(o);
    });
    $('#bookBody').querySelectorAll('.p2ppay').forEach(b => b.onclick = () => {
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (rec) openP2pPayModal(rec);
    });
    $('#bookBody').querySelectorAll('.p2pcancel').forEach(b => b.onclick = async () => {
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (!rec) return;
      try {
        await api('p2pCancel', { id: rec.id, makerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) });
        dropP2p(rec.id);
        b.closest('tr')?.remove();   // OPTIMISTIC: the relay confirmed — don't wait for a repaint
        toast(tr('offer cancelled'), 'ok');
        // an ALREADY-inflight refresh carries a pre-cancel snapshot and would resurrect the row —
        // chain a fresh one behind it so the next paint reflects the cancel
        Promise.resolve(inflight).then(() => mvRefresh());
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#bookBody').querySelectorAll('.rbtn:not(.p2ptake):not(.p2ppay):not(.p2ptakepart)').forEach(b => b.onclick = () => {
      const offer = state.info.book.find(o => o.id === +b.dataset.id);
      if (offer) openBuyModal(offer);
    });
    $('#bookBody').querySelectorAll('.rcancel').forEach(b => b.onclick = () => {
      const offer = state.info.book.find(o => o.id === +b.dataset.id);
      if (offer) cancelRanged(offer);
    });
  }
}
