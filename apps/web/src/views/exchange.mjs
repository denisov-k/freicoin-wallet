// market-view.mjs — the Freimarkets Issue + Exchange tabs, mounted inside the WALLET on the
// Freimarkets (nv3) network. Non-custodial: keys/signing on the client (the seed is handed in
// from the wallet's unlocked session via mvSetSeed), chain reads come from the wallet's own
// light client (ds().assets()), and the relay (:5181, proxied at /api) provides only the order
// book, issuance funding and broadcast — it can mislabel but never steal.
import { deriveAddress, currentNet, addrToSpk } from '@/services/wallet.mjs';
import { NETWORKS } from '@/state/network-params.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '@core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
import { serializeTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { makeTokenReveal, opReturnScript } from '@core/nv3wire.mjs';
import { sha256, hash160 } from '@core/crypto.mjs';
import { frcLeg, refundGiven } from '@core/swap.mjs';
import { paymentHashOf } from '@core/htlc.mjs';
import { btcHtlcClaim, btcAddress } from '@core/btc.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import QRCode from 'qrcode';
import { loadMySwaps, putMySwap, dropMySwap, loadP2p, putP2p, dropP2p, addBtcNonce, addFeeTxid, lsKey } from '@/services/storage.mjs';
import { refreshPushSubs } from '@/services/push.mjs';
import { api, ctx, p2pKey, HOST_TAG, decimalsOf, scaleOf, assetName, rateOf, swapNet, btcFeeFor, VB_HTLC_SPEND, VB_HTLC_FUND } from '@/state/market-ctx.mjs';
import { opIn, signInput, committedOutpoints, myCoinsOf, freeFrcKria, sendFrcToSpk, hostFeeCoin, lockAssetToHtlc, signRangedGive, signLadder, LADDER_SPAN } from '@/services/market/swap-lib.mjs';
import { btcHrp, btcAcctAddr, btcFundHtlc, btcToStr, refreshBtc,
  mvBtc, mvBtcAddress, mvBtcValidAddr, mvSendBtc, mvBtcSendFee, mvBtcMax, initBtcAccount, btcResetAcct } from '@/services/market/btc-account.mjs';
import { recoverBtcNonces, mvBtcHistory, initActivity, resetRecovery } from '@/services/market/activity.mjs';
import { driveP2p, checkP2pRefunds, checkBtcRefunds, initDrive } from '@/services/market/swap-drive.mjs';
import { recoverOrphanBtcHtlcs } from '@/services/market/btc-recovery.mjs';
import { browserSwapEnv } from '@/services/market/swap-env.mjs';
import { $, q, rev, frc, num, setOptions, skel, skelRows, copy } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { armOverlay, closeOverlay } from '@/components/modal.mjs';
export { mvBtc, mvBtcAddress, mvBtcValidAddr, mvSendBtc, mvBtcSendFee, mvBtcMax };   // BTC account lives in its own module; re-exported so the wallet imports stay stable
export { mvBtcHistory };                                      // activity/recovery in mv-activity.mjs; re-exported for the wallet

// BIP84 account for swap keys/payout — MUST match the main wallet's derivation (m/84'/coinType'/0')
// or claimed coins land on addresses the wallet doesn't watch. Was hardcoded to coin type 1 (nv3/
// regtest), which on MAINNET (coin 0) sent bought FRC to an unwatched coin-1 address.
const accountPath = () => `m/84'/${NETWORKS[currentNet()].coinType}'/0'`;
// $/q/rev/frc/num/setOptions/skelRows → @/components/dom.mjs; toast → @/components/toast.mjs

let seed = null, km = {}, spks = [], myAddress = '', state = null, _ds = null;
// wired from the wallet: initMarketView(ds) injects its light source; mvSetSeed(hexSeed) on unlock.
export function initMarketView(ds) { _ds = ds; initBtcAccount(recoverBtcNonces); initActivity(doRefresh); initDrive(browserSwapEnv({ toast, mvRefresh, observe: rawtx => _ds().observe(rawtx) })); }
export function mvSetSeed(hexSeed) {
  // A DIFFERENT key ⇒ drop the previous seed's snapshot (asset balances + BTC account) so the
  // balance repaints a skeleton, not the old account's numbers, until the next mvRefresh lands —
  // same reason mvResetNet clears on a network switch. Gated on an actual change because this runs
  // on EVERY renderApp; resetting unconditionally would flicker the balance to a skeleton each time.
  if (hexSeed !== seed) { state = null; ctx.state = null; btcResetAcct(); }
  seed = hexSeed; ctx.seed = hexSeed;
  if (!hexSeed) { km = {}; spks = []; myAddress = null; ctx.km = {}; ctx.spks = []; return; }   // lock/logout: wipe derived keys
  deriveKeys();
}
// Network switch: drop the OLD network's snapshot so the new net paints a skeleton, not stale
// numbers. The next mvRefresh rebuilds everything against the new net's relay/light client.
export function mvResetNet() { state = null; ctx.state = null; btcResetAcct(); }
export function mvMyAddress() { return myAddress; }

// Relay-known asset names (UNVERIFIED — display fallback only; scan-verified defs win).
export const mvRelayAssets = () => api('info').then(i => i.assets || []);

// ---- keys: same vault, market derivation on the regtest branch ----
function deriveKeys() {
  const acct = derivePath(seed, accountPath());
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

// ONE-TIME RECOVERY: mainnet swaps briefly derived swap keys/payout on coin type 1 (a hardcoded
// regtest path), so bought FRC landed on m/84'/1'/0' addresses the coin-0 wallet never watches.
// Sweep any funds sitting on those legacy addresses back to a watched coin-0 address. Runs once
// (localStorage flag), no-op on the coin-1 nets (there the wallet IS coin 1 — nothing legacy).
async function sweepLegacyCoin1() {
  if (!seed || NETWORKS[currentNet()].coinType === 1 || !ctx.state?.mine) return;
  const MIG = lsKey('fw_coin1_swept');
  try { if (localStorage.getItem(MIG)) return; } catch {}
  try {
    const acct = derivePath(seed, "m/84'/1'/0'");
    const km1 = {}, spks1 = [];
    for (const chain of [0, 1]) { const c = ckdPriv(acct, chain); for (let i = 0; i < 12; i++) { const node = ckdPriv(c, i); const spk = '0014' + wpkProgramHex(node); km1[spk] = node; spks1.push(spk); } }
    const utxos = ((await api('utxos', { spks: spks1 })).utxos || []).filter(u => (u.assetTag ?? null) === null && km1[u.spk]);
    if (!utxos.length) { try { localStorage.setItem(MIG, '1'); } catch {} return; }   // nothing on the old branch — done
    const L = ctx.state.mine.height, fee = 10000n;
    const coins = utxos.map(u => ({ outpoint: u.outpoint, spk: u.spk, value: BigInt(u.value), refheight: u.refheight, pv: assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) }));
    let S = 0n; for (const c of coins) S += c.pv;
    if (S <= fee) return;
    const dest = ctx.spks[0];   // a watched coin-0 wallet address (deriveKeys now uses the network coin type)
    const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, vin: coins.map(c => opIn(c.outpoint)), vout: [{ value: S - fee, scriptPubKey: dest }] };
    coins.forEach((c, i) => {   // sign with the LEGACY coin-1 keys (km1), not ctx.km
      const sec = km1[c.spk].priv.toString(16).padStart(64, '0'), code = '21' + pubkeyCompressed(sec) + 'ac';
      const sh = segwitV0Sighash(tx, i, code, c.value, BigInt(c.refheight), SIGHASH_ALL);
      tx.vin[i].witness = [signEcdsa(sec, sh) + SIGHASH_ALL.toString(16).padStart(2, '0'), '00' + code, ''];
    });
    await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
    try { localStorage.setItem(MIG, '1'); } catch {}
    toast(`${tr('recovered')} ${frc(S - fee)} FRC`, 'ok'); mvRefresh();
  } catch { /* relay/utxo hiccup — retry on the next load (flag only set on success or empty) */ }
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
  // The exchange BOARD is relay-data and must not wait for the (minutes-long, on a restore) full
  // scan behind assets(): race it with a short timeout — on timeout paint the board with an EMPTY
  // own-coin set (post/take buttons naturally read "not enough" until coins land) and upgrade in
  // place when the real scan resolves.
  const assetsP = _ds().assets();
  const [infoRaw, r0, swap, p2p] = await Promise.all([api('info').catch(() => null),
    Promise.race([assetsP, new Promise(res => setTimeout(() => res(null), 6000))]),
    api('swapInfo').catch(() => null), api('p2pList').catch(() => null)]);
  if (currentNet() !== net0) return;   // network switched mid-flight — discard the stale snapshot
  const r = r0 ?? { tipHeight: infoRaw?.height || Number(p2p?.frcHeight || 0), assetUtxos: [], assetDefs: {}, provisional: true };
  if (!r0) assetsP.then(() => { if (currentNet() === net0) mvRefresh(); }).catch(() => {});   // upgrade once coins are in
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
  state = { info, defs: r.assetDefs, mine: { height: r.tipHeight, utxos: r.assetUtxos, pendingChange: BigInt(r.pendingChange || '0'), ...(r.provisional ? { provisional: true } : {}) }, swap, p2p };
  ctx.state = state;                          // mirror for the extracted modules (read via ctx)
  // cache relay defs for the light client's next boot (seedDefs) — rates for history valuation only.
  // Deliberately WITHOUT decimals: display decimals are self-certified on-chain, so they must come from
  // the trustless scan or fresh relay info — never a cached seed (a stale one rendered "1 Test1" as "0.0001").
  // (skip when the relay is dark — an empty write would wipe a perfectly good cache)
  if (infoRaw) try { localStorage.setItem(lsKey('fw_reldefs'), JSON.stringify(Object.fromEntries(
    (info.assets || []).map(a => [a.tag, { shift: a.shift, interest: a.interest, name: a.name }])))); } catch {}
  if ($('#bookBody')) paint();                 // Exchange tab mounted → repaint the book
  if ($('#curBalBody')) paintAssetBalance();   // Freimarkets Balance tab mounted → per-class asset tables
  if ($('#nameMktBody')) paintNameMarket();    // Exchange tab → «Names for sale» board
  if ($('#myNamesBody')) paintMyNames();       // Balance tab → «My names»
  maybeResignRanged();                                      // keep my ranged offers alive after partial fills
  if (currentNet() === 'nv3') import('@/services/market/land.mjs').then(L => L.maybeResignLand()).catch(() => {});   // keep my Freiland standing offers fresh (land-key signed)
  checkMySwaps();                                           // refund any of my LP swaps stalled past their timeout
  checkP2pRefunds();                                        // auto-refund a P2P HTLC I locked once its CLTV passes
  recoverOrphanBtcHtlcs().then(checkBtcRefunds).catch(() => {}); // rebuild any orphaned BTC HTLC record (lost swap), then sweep it home
  checkBtcRefunds();                                        // auto-refund my BTC HTLC (buyer paid, seller vanished) once T2 passes
  sweepLegacyCoin1().catch(() => {});                       // one-time: bring home FRC bought to a legacy coin-1 address
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
// signRangedGive / signLadder / LADDER_* moved to mv-swap-lib.mjs (shared with Freiland,
// which signs a name-NFT offer with its LAND key — the optional `sec` parameter there).

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
  // Asset moves are 0-FEE: small asset amounts are "dust", and Freicoin policy admits dust
  // outputs only in fee-less transactions. Our signet relays and mines 0-fee txs, so every
  // asset/token builder in this file rides free (host-FRC flows keep paying fees).
  const L = state.mine.height, changeSpk = spks[0];
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
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(opIn), vout };   // plain asset move ⇒ standard v2 (tag rides the spk; conservation is version-independent)
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  // relay-broadcast paths bypass ds().broadcast, so force a fresh scan — assets() reads a
  // cache that FRC's utxos() (always sync) refreshes but this path otherwise wouldn't, leaving
  // a just-spent coin selectable on a fast repeat (bad-txns-inputs-missingorspent).
  if (_ds) { try { await _ds().refresh(); } catch {} }
  mvRefresh();
  return txid;
}

// Split held token coins so each PICKED ticket is on its own 1-token coin (a self-send with a
// two-sided reveal), and return those per-ticket coins. A coin that already holds exactly one
// picked token is used as-is. Assumes 1 unit per token (our issuance guarantee).
async function splitToTicketCoins(tag, picked, individual = true) {
  if (!state) await doRefresh();
  const srcCoins = state.mine.utxos.filter(u => (u.assetTag ?? null) === tag && u.tokenHash && (u.tokens ?? []).some(h => picked.includes(h)));
  const L = state.mine.height, spk = spks[0];   // 0-fee (see mvSendAsset — dust admits no fee)
  const buildAndSend = (giveIns, vout, inRevealTokens) => {
    const reveal = makeTokenReveal(vout, inRevealTokens.map(ts => ({ tokens: ts })));
    vout.push({ value: 0n, scriptPubKey: opReturnScript(reveal) });
    const inputs = giveIns.map(c => ({ outpoint: c.outpoint, spk: c.spk, value: BigInt(c.value), refheight: c.refheight }));
    const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(c => opIn(c.outpoint)), vout };
    inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
    return api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  };
  const result = [];
  if (individual) {
    // one coin per picked ticket: split each source coin into 1-token coins, collect picked
    for (const u of srcCoins) {
      const here = (u.tokens ?? []).filter(h => picked.includes(h));
      if ((u.tokens ?? []).length === 1) { result.push({ outpoint: u.outpoint, spk: u.spk, refheight: u.refheight }); continue; }
      /** @type {{value: bigint, scriptPubKey: string, assetTag?: string|null, tokens?: string[]}[]} */
      const vout = (u.tokens ?? []).map(h => ({ value: 1n, scriptPubKey: spk, assetTag: tag, tokens: [h] }));
      const { txid } = await buildAndSend([u], vout, [u.tokens]);
      (u.tokens ?? []).forEach((h, i) => { if (here.includes(h)) result.push({ outpoint: `${txid}:${i}`, spk, refheight: L }); });
    }
  } else {
    // one coin holding ALL picked tickets (sold together). If they already sit alone on one coin
    // that exactly matches, use it; else combine the source coins into [picked, unpicked-change].
    if (srcCoins.length === 1 && (srcCoins[0].tokens ?? []).every(h => picked.includes(h)) && (srcCoins[0].tokens ?? []).length === picked.length) {
      const u = srcCoins[0]; result.push({ outpoint: u.outpoint, spk: u.spk, refheight: u.refheight, value: BigInt(u.value) });
    } else {
      const all = srcCoins.flatMap(u => u.tokens ?? []);
      const keep = all.filter(h => !picked.includes(h));
      /** @type {{value: bigint, scriptPubKey: string, assetTag?: string|null, tokens?: string[]}[]} */
      const vout = [{ value: BigInt(picked.length), scriptPubKey: spk, assetTag: tag, tokens: picked }];
      if (keep.length) vout.push({ value: BigInt(keep.length), scriptPubKey: spk, assetTag: tag, tokens: keep });
      const { txid } = await buildAndSend([...srcCoins], vout, [...srcCoins.map(u => u.tokens)]);
      result.push({ outpoint: `${txid}:0`, spk, refheight: L, value: BigInt(picked.length) });
    }
  }
  if (_ds) { try { await _ds().refresh(); } catch {} }
  return result;
}

// every held ticket of an asset, flattened across coins — [{token, outpoint}] (offer form)
export function mvTokenItems(tag) {
  const out = [];
  for (const u of (state?.mine.utxos ?? [])) if ((u.assetTag ?? null) === tag && u.tokenHash)
    for (const h of (u.tokens ?? [])) out.push({ token: h, outpoint: u.outpoint });
  return out;
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
  const L = state.mine.height, changeSpk = spks[0];   // 0-fee (see mvSendAsset — dust admits no fee)
  const pv = /** @type {bigint} */ (assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(u.assetTag)));
  const vShare = keep.length ? pv * BigInt(send.length) / BigInt(all.length) : pv;
  /** @type {{value: bigint, scriptPubKey: string, assetTag?: string|null, tokens?: string[]}[]} */
  const vout = [{ value: vShare, scriptPubKey: toSpk, assetTag: u.assetTag, tokens: send }];
  if (keep.length) vout.push({ value: pv - vShare, scriptPubKey: changeSpk, assetTag: u.assetTag, tokens: keep });
  const reveal = makeTokenReveal(vout, [{ tokens: all }]);
  vout.push({ value: 0n, scriptPubKey: opReturnScript(reveal) });
  const inputs = [u].map(c => ({ outpoint: c.outpoint, spk: c.spk, value: BigInt(c.value), refheight: c.refheight }));
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(c => opIn(c.outpoint)), vout };
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  // relay-broadcast paths bypass ds().broadcast, so force a fresh scan — assets() reads a
  // cache that FRC's utxos() (always sync) refreshes but this path otherwise wouldn't, leaving
  // a just-spent coin selectable on a fast repeat (bad-txns-inputs-missingorspent).
  if (_ds) { try { await _ds().refresh(); } catch {} }
  mvRefresh();
  return txid;
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
    // asset branch is 0-fee (see mvSendAsset — dust admits no fee); asset conserves exactly
    if (S - Q > 0n) vout.push({ value: S - Q, scriptPubKey: changeSpk, assetTag: giveTag });
  }
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(opIn), vout };   // plain asset move ⇒ standard v2 (tag rides the spk; conservation is version-independent)
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'consolidate' });
  addFeeTxid(txid);   // net-zero self-spend — Activity labels it "exchange fee", not a send
  return { outpoint: `${txid}:0`, spk: changeSpk, value: Q, refheight: L, L };
}

async function postRangedOffer() {
  try {
    // I sell = BTC ⇒ REVERSE cross-chain swap: sell BTC for FRC at MY price (BTC qty → FRC wanted).
    if ($('#rAsset').value === 'BTC') {
      const btcQ = num($('#rQty').value), wantV = num($('#rPrice').value);
      const wantTag = $('#rWant').value === 'FRC' ? null : $('#rWant').value;   // FRC or a constant asset to BUY
      if (!(btcQ > 0)) throw new Error(tr('enter a quantity'));
      if (!(wantV > 0)) throw new Error(tr('enter a quantity'));
      const bal = mvBtc().balance, maxSats = bal ? BigInt(bal) - btcFeeFor(VB_HTLC_FUND) : 0n;
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
    // TOKEN asset: sell tickets INDIVIDUALLY. Selected items are split into one-token coins
    // (a self-send, if they share a coin), then each coin is listed WHOLE (min=max=1) at the
    // per-ticket price. Token coins are constant-rate so V=1 is stable across the ladder.
    if (mvTokenCoins(giveTag).length) {
      const picked = [...(document.querySelectorAll('#rTokPick input:checked'))].map(x => /** @type {HTMLElement} */(x).dataset.h);
      if (!picked.length) throw new Error(tr('pick at least one ticket'));
      const individual = $('#rPartial')?.checked ?? false;
      toast(tr('preparing the tickets…'));
      const coins = await splitToTicketCoins(giveTag, picked, individual);
      // individual: price is PER ticket (each coin = 1). whole: T is the TOTAL for the one coin.
      $('#modal')?.remove();
      toast(tr('signing the offer ladder…'));
      for (const c of coins) {
        const V = c.value ?? 1n;
        const priceNum = BigInt(Math.round(T * scaleOf(wantTag))), priceDen = individual ? 1n : V;
        const give = { outpoint: c.outpoint, spk: c.spk, value: V, refheight: c.refheight, L: c.refheight };
        const expireAt = c.refheight + LADDER_SPAN;
        const desc = { payoutAsset: wantTag, payoutScript: c.spk, priceNum, priceDen, changeScript: c.spk, minFill: V, maxFill: V, nExpireTime: expireAt };
        const ladder = await signLadder(desc, give, give.outpoint, c.refheight, expireAt);
        const makerPub = pubkeyCompressed(km[c.spk].priv.toString(16).padStart(64, '0'));
        await api('rangedOffer', { makerSpk: c.spk, giveOutpoint: give.outpoint, desc, nExpireTime: expireAt, lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder, makerPub });
      }
      toast(individual ? `${coins.length} ${tr('tickets listed')}` : tr('Offer signed and posted'), 'ok'); mvRefresh();
      return;
    }
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
    // GRIEFING FLOOR (audit 2026-07-16): minFill=0 lets a taker fill 1 base unit — every such
    // fill strands an offline maker's remainder (the pre-signed ladder covers the first fill
    // only) and forces an online maker to re-sign. Empty Min defaults to 5% of the lot
    // (≥1 base unit); an explicit Min still wins, but never below 1 unit.
    const griefFloor = Q / 20n > 0n ? Q / 20n : 1n;
    let minFill = !partial ? Q : ($('#rMin')?.value ? BigInt(Math.round(num($('#rMin').value) * gs)) : griefFloor);
    let maxFill = !partial ? Q : ($('#rMax')?.value ? BigInt(Math.round(num($('#rMax').value) * gs)) : Q);
    if (maxFill > Q) maxFill = Q;
    if (partial && minFill < 1n) minFill = 1n;
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
    <div class="stack" id="rTokPick" hidden></div>
    <div class="sub" id="rRate" style="font-size:12px;margin:2px 0" hidden></div>
    <div class="sub" id="rFee" style="font-size:12px;margin:2px 0" hidden></div>
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
    if (tokenSell()) return;   // the token path sets its own hint in syncPartial — don't clobber it
    const partial = $('#rPartial')?.checked;
    $('#rHint').textContent = partial
      ? tr('Buyers fill any amount; the remainder keeps trading while you are online.')
      : tr('The offer can only be taken whole — one buyer, the full quantity.');
  };
  // Two info lines above the partial-fills toggle: the price coefficient (want per one unit sold),
  // and — for cross-chain swaps — the per-fill BTC claim fee. Each on its own line.
  const updateInfo = () => {
    const nm = v => v === 'FRC' || v === 'BTC' ? v : assetName(v);
    const rEl = $('#rRate'), fEl = $('#rFee');
    if (rEl) {
      const sellQ = num($('#rQty')?.value || ''), wantQ = num($('#rPrice')?.value || '');
      const show = !tokenSell() && sellQ > 0 && wantQ > 0;
      rEl.hidden = !show;
      if (show) rEl.textContent = `1 ${nm($('#rAsset').value)} = ${(wantQ / sellQ).toLocaleString(getLang(), { maximumFractionDigits: 8 })} ${nm($('#rWant').value)}`;
    }
    if (fEl) {
      const btcQ = isSwap() ? num(($('#rWant')?.value === 'BTC' ? $('#rPrice') : $('#rQty'))?.value || '') : 0;
      fEl.hidden = !(btcQ > 0);
      if (btcQ > 0) fEl.textContent = `${Number(btcFeeFor(VB_HTLC_SPEND))} ${tr('sat network fee per fill')}`;
    }
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
  const MIN_WANT = 1e-7;   // smallest sensible want-quantity (guards against a dust/zero price)
  const g = n => n.toLocaleString(getLang(), { maximumFractionDigits: 8 });
  const sellName = () => { const s = $('#rAsset')?.value; return s === 'FRC' || s === 'BTC' ? s : assetName(s); };
  // available balance of the selected sell asset in its DISPLAY units (null = token/unknown, no cap)
  const availUnits = () => {
    const s = $('#rAsset')?.value; if (!s) return null;
    if (s === 'BTC') { const b = mvBtc().balance; return b != null ? Number(BigInt(b)) / 1e8 : null; }
    if (tokenSell()) return null;   // sold by ticket count — Min/Max are hidden
    const tag = s === 'FRC' ? HOST_TAG : s;
    return Number(myCoinsOf(tag, state.mine.height).reduce((a, c) => a + c.pv, 0n)) / scaleOf(tag);
  };
  // Live guard: show a warning + BLOCK the button on any out-of-range field, instead of only
  // clamping/throwing at submit. Symmetric across both quantities and both Min/Max bounds.
  const validate = () => {
    const btn = $('#rOfferBtn'); if (!btn) return;
    if (tokenSell()) { const w = $('#rWarn'); if (w) w.hidden = true; btn.disabled = false; return; }   // token path: Min/Max hidden, own rules
    const floor = floorOf(); const fs = floor > 0 ? g(floor) : '';
    // Min placeholder: the relay fee floor when there is one (swaps), else the anti-griefing
    // default that an empty field gets — 5% of the lot, at least the smallest fillable unit
    // (a fill of 0 is impossible, and a 0 floor lets dust fills strand the remainder).
    const sel = $('#rAsset')?.value;
    const unit = sel === 'BTC' ? 1e-8 : sel ? 1 / scaleOf(sel === 'FRC' ? HOST_TAG : sel) : 0;
    const minRaw = $('#rMin')?.value, maxRaw = $('#rMax')?.value, partial = $('#rPartial')?.checked;
    const sellQ = num($('#rQty')?.value || ''), wantQ = num($('#rPrice')?.value || ''), avail = availUnits();
    const griefDflt = sellQ > 0 && unit > 0 ? Math.max(unit, sellQ / 20) : unit;
    if ($('#rMin')) $('#rMin').placeholder = floor > 0 ? fs : (griefDflt > 0 ? g(griefDflt) : '');
    // Max placeholder hints the upper bound: the quantity being sold (or the free balance)
    const cap = sellQ > 0 ? sellQ : (avail != null ? avail : 0);
    if ($('#rMax')) $('#rMax').placeholder = cap > 0 ? g(cap) : '';
    // The whole BTC side of the offer must clear the relay's floor (round-trip network fee + one
    // deliverable satoshi) — below it the swap can never net anything, so no fill would ever land.
    // The BTC total is the sell quantity on a reverse (sell-BTC) offer, the want price on a forward one.
    const minBtc = Number(state?.p2p?.minSwap ?? 0) / 1e8;
    const totalBtc = sel === 'BTC' ? sellQ : ($('#rWant')?.value === 'BTC' ? wantQ : 0);
    let bad = '';
    if (minBtc > 0 && totalBtc > 0 && totalBtc < minBtc)
      bad = `${tr('minimum offer is')} ${g(minBtc)} BTC`;                                     // whole offer below the fee floor
    else if ($('#rQty')?.value && sellQ > 0 && avail != null && sellQ > avail)
      bad = `${tr('you only have')} ${g(avail)} ${sellName()}`;                              // sell qty > balance
    else if ($('#rPrice')?.value && wantQ > 0 && wantQ < MIN_WANT)
      bad = `${tr('minimum must be at least')} ${g(MIN_WANT)}`;                              // want qty below the dust floor
    else if (floor > 0 && maxRaw && num(maxRaw) < floor) bad = tr('the whole offer is below the network-fee floor — increase the amount or price');
    else if (floor > 0 && minRaw && num(minRaw) < floor) bad = `${tr('minimum must be at least')} ${fs}`;
    else if (partial && maxRaw && sellQ > 0 && num(maxRaw) > sellQ) bad = tr('maximum can’t exceed the quantity');   // symmetric upper bound
    else if (minRaw && maxRaw && num(minRaw) > num(maxRaw)) bad = tr('bad min/max');
    const warn = $('#rWarn'); if (warn) { warn.textContent = bad; warn.hidden = !bad; }
    btn.disabled = !!bad;
  };
  const refresh = () => { updateHint(); updateInfo(); validate(); };
  // a token asset sells WHOLE: lock quantity to the coin, hide the partial control + min/max
  const tokenSell = () => { const s = $('#rAsset')?.value; return s && s !== 'BTC' && s !== 'FRC' && mvTokenCoins(s).length > 0; };
  const syncPartial = () => {
    const tok = tokenSell();
    const pick = $('#rTokPick'), qLbl = $('#rQty')?.closest('label'), part = $('#rPartial')?.checked;
    if (tok) {
      // pick WHICH tickets to sell; the 'allow partial fills' box decides HOW: on ⇒ each ticket
      // is listed separately (buy 1..N), off ⇒ the selected tickets sell together as one coin.
      const items = mvTokenItems($('#rAsset').value);
      if (pick) { pick.hidden = false; pick.innerHTML = items.map(it => `<label class="chk"><input type="checkbox" checked data-h="${it.token}">\ud83c\udf9f ${tokLabel(it.token)}</label>`).join('') || `<span class="sub">${tr('recovering\u2026')}</span>`; }
      if (qLbl) qLbl.hidden = true;
      if ($('#rPartialLbl')) $('#rPartialLbl').hidden = false;
      $('#rMinMax').hidden = true;
      if ($('#rPriceLbl')) $('#rPriceLbl').childNodes[0].textContent = part ? tr('Price per ticket') : tr('Total price');
      if ($('#rHint')) $('#rHint').textContent = part ? tr('Each selected ticket is listed separately (buyers take any number).') : tr('The selected tickets sell together, to one buyer.');
    } else {
      if (pick) { pick.hidden = true; pick.innerHTML = ''; }
      if (qLbl) qLbl.hidden = false;
      if ($('#rPartialLbl')) $('#rPartialLbl').hidden = false;
      if ($('#rPriceLbl')) $('#rPriceLbl').childNodes[0].textContent = tr('Quantity');
      $('#rMinMax').hidden = !part;
    }
    refresh();
  };
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
// action-cell icons (Feather, MIT) — the book's action column is one compact square per row, so a
// long status like "подтверждение оплаты сетью" never stretches the table past the screen. The full
// text lives in the button's title/aria-label (and, for in-flight swaps, inside the modal it opens).
const SVG = {
  buy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
  cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};
const actBtn = (cls, id, ic, label) => `<button class="${cls}" data-id="${id}" title="${label}" aria-label="${label}">${SVG[ic]}</button>`;

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
    if (st.startsWith('btc_funded') || st.startsWith('frc_funded')) return `${tr('confirming receipt')} (0/1)`;   // I paid; the seller's lock confirms next
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
  // a token asset: count the TICKETS held (token coins are excluded from myCoinsOf)
  const items = sell !== 'FRC' ? mvTokenItems(sell) : [];
  if (items.length) { el.textContent = `${tr('Available')}: ${items.length} ${assetName(sell)}`; return; }
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
      toast(`${tr('swap refunded')}: ${frc(w.funding.value)} FRC`, 'ok');
      mvRefresh();
    } catch { /* coin gone or too early — retry next cycle */ }
  }
}
// opIn / sendFrcToSpk / hostFeeCoin / lockAssetToHtlc moved to mv-swap-lib.mjs (shared with the drive)

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
// what the reverse taker can actually lock, in the pay asset's base units (FRC keeps a fee reserve)
export const takerPayCapacity = tag => tag
  ? myCoinsOf(tag, state.mine.height).reduce((s, c) => s + c.pv, 0n)
  : freeFrcKria() - 10000n;
async function takeP2pB(offer, fillSats = null) {
  try {
    const tag = offer.assetTag ?? null;
    // PRE-FLIGHT: the reverse taker funds FRC/asset immediately after the take registers — check
    // the coins BEFORE reserving the offer, or a broke taker leaves it hostage in 'taken'
    const need = fillSats != null
      ? (BigInt(offer.frcAmount) * BigInt(fillSats) + BigInt(offer.btcAmount) - 1n) / BigInt(offer.btcAmount)
      : BigInt(offer.frcAmount);
    if (takerPayCapacity(tag) < need) throw new Error(tag ? tr('not enough of that asset') : tr('not enough FRC'));
    const nonce = fillSats != null
      ? sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id + ':' + fillSats + ':' + state.mine.height, 'utf8')).toString('hex').slice(0, 16)
      : sha256(Buffer.from(seed + 'fw-p2p-take:' + offer.id, 'utf8')).toString('hex').slice(0, 16);
    const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
    const H = paymentHashOf(p2pKey(nonce, 'R'));
    const r = await api('p2pTakeB', { id: offer.id, ...(fillSats != null ? { fill: String(fillSats) } : {}), takerFrcPub: frcPub, takerBtcPub: btcPub, takerBtcAddr: btcAcctAddr(), paymentHash: H });
    addBtcNonce(nonce);
    // fund my give-side HTLC immediately — this IS the commitment that makes the take real.
    // If the funding still fails (coins raced away), UNDO the take so the offer frees instantly.
    let fund;
    try {
      fund = tag ? await lockAssetToHtlc(r.frcHtlc.spk, tag, BigInt(r.frcAmount)) : await sendFrcToSpk(r.frcHtlc.spk, BigInt(r.frcAmount));
    } catch (e) {
      await api('p2pUntake', { id: r.id, takerFrcPub: frcPub }).catch(() => {});
      throw e;
    }
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
    ? (Math.ceil(a * 1e8 * Number(BigInt(offer.frcAmount)) / Number(BigInt(offer.btcAmount))) / wsc).toLocaleString(getLang(), { maximumFractionDigits: 8 }) + ' ' + wname
    : (Math.ceil(a * wsc * Number(BigInt(offer.btcAmount)) / Number(BigInt(offer.frcAmount))) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 }) + ' BTC';
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${aname}</b><button id="tkClose" class="icon">✕</button></div>
    <div class="sub" style="font-size:13px">${tr('Available')}: ${rem.toLocaleString(getLang())} ${aname}<br>${tr('Per buy:')} ${mn.toLocaleString(getLang())} – ${mx.toLocaleString(getLang())}</div>
    <label class="numfield">${tr('Amount')}<input id="tpAmt" type="text" inputmode="decimal" placeholder="${mn.toLocaleString(getLang())} – ${mx.toLocaleString(getLang())}"></label>
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
  const cost = () => {
    const a = num($('#tpAmt').value) || 0; $('#tpCost').textContent = a > 0 ? costOf(a) : '—';
    // reverse: the pay side comes from the wallet only — block the button on a shortfall
    if (isRev && mn <= mx) {
      const needBase = a > 0 ? BigInt(Math.ceil(a * 1e8 * Number(BigInt(offer.frcAmount)) / Number(BigInt(offer.btcAmount)))) : 0n;
      const shortP = needBase > takerPayCapacity(offer.assetTag ?? null);
      const go = q(m, '#tkGo'); go.disabled = shortP;
      go.textContent = shortP ? tr(offer.assetTag ? 'not enough of that asset' : 'not enough FRC') : tr('Buy');
    }
  };
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
    putP2p({ id: r.id, role: 'taker', dir: offer.dir, parent: offer.id, nonce, status: 'need_btc', assetTag: offer.assetTag ?? null, frcAmount: r.frcAmount, btcAmount: r.btcAmount, paymentHash: H, btcHtlc: r.btcHtlc, ln: !!offer.ln });
    mvRefresh();
    return r.id;
  } catch (e) { log('⚠ ' + e.message); toast(e.message, 'err'); return null; }
}

// TAKER: accept someone's offer — I provide BTC (from my own wallet), receive FRC.
function openP2pTakeModal(offer) {
  if ($('#modal')) return;
  const btcHrp = state.swap?.btcHrp || 'tb';
  const m = document.createElement('div'); m.id = 'modal';
  const getStr = offer.assetTag ? `${(Number(BigInt(offer.frcAmount)) / scaleOf(offer.assetTag)).toLocaleString(getLang())} ${assetName(offer.assetTag)}` : `${frc(offer.frcAmount)} FRC`;
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${offer.assetTag ? assetName(offer.assetTag) : 'FRC'}</b><button id="tkClose" class="icon">✕</button></div>
    <div class="rrow"><span>${tr('You receive')}</span><b>${getStr}</b></div>
    <div class="rrow"><span>${tr('You pay')}</span><b>${btcToStr(offer.btcAmount)} BTC</b></div>
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
  // the reverse taker pays from the wallet ONLY (no external-payment path) — a short balance
  // means the take can't complete, so block the button instead of letting it strand the offer
  const short = takerPayCapacity(offer.assetTag ?? null) < BigInt(offer.frcAmount);
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} BTC</b><button id="tkClose" class="icon">✕</button></div>
    <div class="rrow"><span>${tr('You receive')}</span><b>${btcToStr(offer.btcAmount)} BTC</b></div>
    <div class="rrow"><span>${tr('You pay')}</span><b>${payStr}</b></div>
    <button id="tkGo"${short ? ' disabled' : ''}>${short ? tr(offer.assetTag ? 'not enough of that asset' : 'not enough FRC') : tr('Buy')}</button>
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
    putP2p({ id: offer.id, role: 'taker', nonce, status: 'need_btc', assetTag: offer.assetTag ?? null, frcAmount: offer.frcAmount, btcAmount: offer.btcAmount, paymentHash: H, btcHtlc: r.btcHtlc, ln: !!offer.ln });
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
  // all BTC rows in this window print FIXED 8 decimals — mixed precision (0,000006 next to
  // 0,00003015) breaks the visual column and makes Available vs Amount hard to compare
  const btc8 = sats => (Number(BigInt(sats)) / 1e8).toLocaleString(getLang(), { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  const hasWallet = mvBtc().available;
  const rcvTag = rec.assetTag ?? null;   // what the buyer receives for the BTC (FRC or a user asset)
  const rcv = rec.frcAmount ? `${(Number(rec.frcAmount) / scaleOf(rcvTag)).toLocaleString(getLang(), { maximumFractionDigits: rcvTag ? decimalsOf(rcvTag) : 8 })} ${assetName(rcvTag)}` : '';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} ${assetName(rcvTag)}</b><button id="pyClose" class="icon">✕</button></div>
    <div class="sub" style="margin:-4px 0 0;font-size:13px">${tr('Order')} ${rec.id}</div>
    <div class="sub" id="pyTtl" style="margin:0 0 8px;font-size:13px"></div>
    ${hasWallet ? `<div class="seg" id="paySeg"><button data-pay="wallet" class="on">${tr('From wallet')}</button><button data-pay="ext">${tr('External payment')}</button></div>` : ''}
    <div class="rrow" id="pyBalRow"${hasWallet ? '' : ' style="display:none"'}><span>${tr('Available')}</span><b id="pyBal" class="sub">${tr('checking balance…')}</b></div>
    <div class="rrow"><span>${tr('Cost')}</span><b>${btc8(amt)} BTC</b></div>
    <div class="rrow" id="pyFeeRow"${hasWallet ? '' : ' style="display:none"'}><span>${tr('Network fee')}</span><b id="pyFee"></b></div>
    <div class="rrow" id="pyTotalRow"${hasWallet ? '' : ' style="display:none"'}><span>${tr('Amount')}</span><b id="pyTotal"></b></div>
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
  // RESERVATION COUNTDOWN: an unpaid take is swept by the relay after takeTtlMs — show the buyer
  // how long the order is held. Hidden the moment anything is paid (the swap then lives by its
  // HTLC timelocks, not the reservation).
  let ttlDeadline = null;
  const syncTtl = w => {
    ttlDeadline = w && w.status === 'taken' && w.takenTime && !(loadP2p().find(r => r.id === rec.id) || rec).btcHtlc?.txid
      ? w.takenTime + (state.p2p?.takeTtlMs ?? 3600e3) : null;
  };
  syncTtl((state.p2p?.swaps || []).find(x => x.id === rec.id));
  const paintTtl = () => {
    const el = $('#pyTtl'); if (!el) return;
    if (!ttlDeadline) { el.textContent = ''; return; }
    const left = ttlDeadline - Date.now();
    if (left <= 0) { el.textContent = tr('reservation expired'); return; }
    const mm = Math.floor(left / 60000), ss = Math.floor(left % 60000 / 1000);
    el.textContent = `${tr('reserved for another')} ${mm}:${String(ss).padStart(2, '0')}`;
  };
  paintTtl();
  const ttlTimer = setInterval(paintTtl, 1000);
  const close = () => { clearInterval(poll); clearInterval(balTimer); clearInterval(ttlTimer); m.remove(); };
  m.onclick = e => { if (e.target === m) close(); };
  q(m, '#pyClose').onclick = close;
  // wallet / external toggle: swap which pane is visible, highlight the active segment.
  // the Available line belongs to the wallet path, so it follows the toggle too.
  const seg = $('#paySeg');
  const show = (sel, on) => { const el = $(sel); if (el) el.style.display = on ? '' : 'none'; };
  const applyMode = mode => {
    show('#pyWalletPane', mode === 'wallet');
    show('#pyBalRow', mode === 'wallet');
    show('#pyFeeRow', mode === 'wallet');
    show('#pyTotalRow', mode === 'wallet');
    show('#pyExtPane', mode === 'ext');
  };
  if (seg) seg.querySelectorAll('button').forEach(sb => sb.onclick = () => {
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === sb));
    applyMode(sb.dataset.pay);
  });
  // pay the HTLC straight from the in-wallet BTC account (one tap); auto-detect finishes the swap
  let paying = false;
  // once paid, the payment-method chooser (#paySeg) and the wallet-balance line (#pyBalRow) are moot —
  // hide them so the window shows only the amount, the confirmation status and Cancel.
  const hidePayInputs = () => { for (const s of ['#paySeg', '#pyBalRow', '#pyFeeRow', '#pyTotalRow', '#pyExtPane']) { const el = $(s); if (el) el.style.display = 'none'; } };
  // once the seller's lock is CONFIRMED (frc_funded+) the claim is running and a cancel can do
  // nothing (the relay refuses coop-sign, and the claim reveals R anyway) — drop the button
  const hideCancel = () => { const c = q(m, '#pyCancel'); if (c) c.style.display = 'none'; };
  // ALREADY PAID (a reload after funding): the record carries a funding txid — lock the pay path so a
  // second tap can't double-spend the BTC. The poll below still follows the swap through to completion.
  if (rec.btcHtlc?.txid) {
    paying = true; const pw0 = $('#pyWallet');
    if (pw0) {
      pw0.disabled = true;
      // initial label from the last board snapshot — the swap may already be past the payment
      // confirmations (seller's turn, or the claim), and reopening must not flash a stale
      // "confirming payment"; the immediate poll below refines it with fresh relay data
      const w0 = (state.p2p?.swaps || []).find(x => x.id === rec.id);
      pw0.textContent = !w0 || w0.status === 'taken' ? tr('confirming payment on the network')
        : w0.status === 'btc_funded' ? `${tr('confirming receipt')} (0/1)` : `${tr('confirming receipt')} (1/1)`;
      if (w0 && !['taken', 'btc_funded'].includes(w0.status)) hideCancel();
    }
    hidePayInputs();
  }
  // стартовый режим: «Из кошелька», если есть чем платить; иначе «Внешний платёж»
  if (!paying && seg) {
    const startExt = !hasWallet;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.pay === (startExt ? 'ext' : 'wallet')));
    applyMode(startExt ? 'ext' : 'wallet');
  }
  const payFromWallet = async () => {
    const pw = $('#pyWallet'); if (!pw) return;
    paying = true; pw.disabled = true; pw.textContent = tr('confirming payment on the network');
    try {
      const fund = await btcFundHtlc(b.addr, amt);
      // remember the funding txid on the local record so this BTC spend is folded into the trade row
      // (btcFundTxid) and never surfaces as a standalone "−0.00011 send" in the activity feed
      const rl = loadP2p().find(r => r.id === rec.id) || rec;
      // Mark PAID right away (status + funding txid). Previously the status stayed 'need_btc' until
      // the relay poll confirmed, so a reload in that window re-offered "Pay" and risked a second
      // BTC spend. 'btc_funded' + the txid make the reload show the awaiting state instead.
      putP2p({ ...rl, status: 'btc_funded', btcHtlc: { ...(rl.btcHtlc || b), txid: fund.txid, vout: fund.vout, value: fund.value } });
      hidePayInputs();   // paid — drop the method chooser + Available line, leave amount/status/Cancel
      ttlDeadline = null; paintTtl();   // the reservation clock is moot once the BTC is sent
      try { await api('p2pBtcFunded', { id: rec.id, btcTxid: fund.txid }); } catch {}   // nudge the relay; auto-detect is the fallback
      // paid — the (disabled) button now reads "подтверждение оплаты сетью (x/2)" until the relay
      // accepts the funding (2 confs), then the poll flips it to "ожидание продавца". No status line.
      refreshBtc();
    } catch (e) { toast(e.message, 'err'); paying = false; updateWalletBtn(); }
  };
  // the BTC balance loads async — keep the wallet button + the Available line in step with it,
  // don't lock them to a stale read. Balance lives on its own row now; the button just acts.
  const updateWalletBtn = () => {
    const pw = $('#pyWallet'), bl = $('#pyBal'), info = mvBtc(); if (!pw || !info.available || paying) return;
    if (info.balance == null) { pw.disabled = true; if (bl) { bl.textContent = tr('checking balance…'); bl.classList.add('sub'); } return; }
    // required = amount + the REAL HTLC-funding fee at the current rate (a flat 1000-sat margin
    // rejected payable orders: 514 sat of headroom is enough when the fee is ~400)
    const fee = btcFeeFor(VB_HTLC_FUND);
    const fEl = $('#pyFee'); if (fEl) fEl.textContent = `${btc8(fee)} BTC`;
    const tEl = $('#pyTotal'); if (tEl) tEl.textContent = `${btc8(amt + fee)} BTC`;   // Amount = cost + fee, what actually leaves the wallet
    const bal = BigInt(info.balance), ok = bal >= amt + fee;
    if (bl) { bl.textContent = `${btc8(bal)} BTC`; bl.classList.remove('sub'); }   // match the Amount/You-receive rows once the real figure lands
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
  const pollTick = async () => {
    try {
      const w = (await api('p2pList')).swaps.find(x => x.id === rec.id);
      const rlocal = loadP2p().find(r => r.id === rec.id);
      syncTtl(w);
      const st = $('#pyStatus');
      // v2 completion for the BUYER = my FRC/asset is claimed (frc_claimed); 'done' is just the
      // seller collecting their BTC afterwards. A dropped local record also means the drive finished.
      if (!rlocal || !w || w.status === 'done' || w.status === 'frc_claimed') {
        clearInterval(poll); clearInterval(balTimer);
        if (st) st.textContent = tr('swap complete ✅');
        setTimeout(() => m.remove(), 1800); mvRefresh(); return;
      }
      const pw = $('#pyWallet');
      // ОТМЕНА ЗАПРОШЕНА: локально (cancelWanted, ещё не дошла до релея) ИЛИ уже зафиксирована у
      // релея (w.cancelReq — переживает перезагрузку). Кнопка → «отмена запрошена» (блок), строкой
      // ниже — что произойдёт. После кооп-возврата запись дропается и модалка закроется сама.
      const canceling = !!rlocal.cancelWanted || !!w.cancelReq;
      if (canceling) { const cx = q(m, '#pyCancel'); if (cx) cx.disabled = true; if (st) st.textContent = tr('the deal will be cancelled as soon as the network confirms the payment'); }
      else if (st) st.textContent = '';
      if (w.status === 'taken') {
        // paid, but the relay won't accept the funding until it has 2 BTC confirmations — the seller
        // physically CAN'T lock yet. Show the network-confirmation progress, not "awaiting the seller".
        if (pw && rlocal.btcHtlc?.txid) {
          if (canceling) { pw.textContent = tr('cancel requested'); pw.disabled = true; }
          else {
            let confs = null;
            try { confs = ((await api('btcAccount', { addresses: [b.addr] })).utxos || []).find(u => u.txid === rlocal.btcHtlc.txid)?.confirmations; } catch {}
            pw.textContent = confs != null ? `${tr('confirming payment on the network')} (${Math.min(confs, 2)}/2)` : tr('confirming payment on the network');
          }
        }
      } else if (w.status === 'btc_funded') {                 // payment accepted — seller's lock isn't in a block yet
        if (!paidSeen) { paidSeen = true; putP2p({ ...rlocal, status: 'btc_funded' }); hidePayInputs(); mvRefresh(); }
        if (pw) { pw.textContent = canceling ? tr('cancel requested') : `${tr('confirming receipt')} (0/1)`; pw.disabled = true; }
      } else {                                                // seller's lock CONFIRMED (frc_funded/…) — I'm claiming the FRC now
        if (!paidSeen) { paidSeen = true; putP2p({ ...rlocal, status: 'btc_funded' }); hidePayInputs(); mvRefresh(); }
        if (pw) pw.textContent = `${tr('confirming receipt')} (1/1)`;
        if (st) st.textContent = tr('claiming your funds…');
        hideCancel();
      }
    } catch {}
  };
  const poll = setInterval(pollTick, 4000);
  pollTick();   // fresh state NOW — don't leave the snapshot label up for a full interval
  // back out. v2: BEFORE paying nothing is at stake — just drop the record (the relay zombie-expires
  // the take). AFTER paying, the BTC comes home automatically at the HTLC timeout (checkBtcRefunds).
  const doCancel = async () => {
    const rlocal = loadP2p().find(r => r.id === rec.id);
    if (rlocal?.btcHtlc?.txid) {
      // ALREADY PAID: ask the seller to authorize an instant coop refund. Allowed only while they
      // haven't locked (server-enforced); if they have, the BTC comes home at the timeout instead.
      const w = await api('p2pList').then(l => l.swaps.find(s => s.id === rec.id)).catch(() => null);
      if (w?.frcHtlc?.txid || w?.frcPending) { toast(tr('seller already locked — BTC auto-refunds at the timeout'), 'warn'); return; }
      // ОТМЕНА ВЫИГРЫВАЕТ ГОНКУ: ставим cancelReq у релея СРАЗУ (он принимает его уже на стадии
      // подтверждения). Флаг детерминированно блокирует будущий лок мейкера — пауза не нужна.
      // Мгновенный UI: кнопка → «отмена запрошена» (блок), строка ниже — что произойдёт.
      const pw = $('#pyWallet'); if (pw) { pw.textContent = tr('cancel requested'); pw.disabled = true; }
      const stx = $('#pyStatus'); if (stx) stx.textContent = tr('the deal will be cancelled as soon as the network confirms the payment');
      const cx = q(m, '#pyCancel'); if (cx) cx.disabled = true;
      try {
        await api('p2pBtcCancelReq', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) });
        putP2p({ ...rlocal, cancelWanted: false });   // зафиксировано у релея — драйв завершит кооп-возврат
        toast(tr('cancel requested — waiting for the seller to authorize the refund'), 'ok');
      } catch (e) {
        // редкий отказ (мейкер запёрся в этот же миг) или сеть — локальный фолбэк с ретраем
        putP2p({ ...rlocal, cancelWanted: true });
        toast(e.message, 'warn');
      }
      return;
    }
    // not paid yet: release the reservation right away (best-effort; zombie grace backs it up)
    try { await api('p2pUntake', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) }); } catch {}
    dropP2p(rec.id); close(); toast(tr('purchase cancelled'), 'ok'); mvRefresh();
  };
  // "Cancel purchase" opens an in-window CONFIRMATION step: what the cancel does at THIS stage
  // (release the unpaid order / ask the seller for an instant refund with the timeout as fallback),
  // then a "Cancel the deal" button — an accidental tap can't fire the cancel any more.
  q(m, '#pyCancel').onclick = () => {
    const card = m.querySelector('.review'); if (!card || q(m, '#pyConfirm')) return;
    const paid = !!(loadP2p().find(r => r.id === rec.id) || rec).btcHtlc?.txid;
    // the seller may ALREADY have sent the lock: confirmed (frcHtlc) — or still in the mempool,
    // which the relay tracks as frcPending — either way a cancel can no longer succeed, say so
    const wSnap = (state.p2p?.swaps || []).find(x => x.id === rec.id);
    const sellerLocked = !!(wSnap?.frcHtlc?.txid || wSnap?.frcPending);
    let eta = '';
    const cltv = rec.btcHtlc?.cltv, bh = state.p2p?.btcHeight;
    if (paid && cltv && bh && cltv > bh) eta = ` (≈ ${Math.max(1, Math.round((cltv - bh) * 10 / 60))} ${tr('h')})`;
    // swap the card's content for the confirmation (no absolute overlay: the card keeps its OWN
    // height otherwise, leaving a tall empty area under the two confirm buttons)
    const kids = [...card.children].map(el => [el, el.style.display]);
    kids.forEach(([el]) => { el.style.display = 'none'; });
    const restore = () => { ov.remove(); kids.forEach(([el, d]) => { el.style.display = d; }); };
    const ov = document.createElement('div'); ov.id = 'pyConfirm';
    ov.style.cssText = 'display:flex;flex-direction:column;gap:12px';
    ov.innerHTML = `<b>${tr('Cancel the purchase?')}</b>
      <p class="sub" style="margin:0">${sellerLocked
        ? tr('The seller has already sent the FRC — the lock is confirming on the network, so the deal can no longer be cancelled. If the lock somehow never confirms, your BTC returns automatically at the timeout') + eta + '.'
        : paid
          ? tr('You have already paid, and the seller has not sent the FRC yet. The seller will be asked to authorize an instant refund — the BTC then returns to your wallet right away; if the seller does not respond, the BTC returns automatically at the timeout') + eta + '.'
          : tr('The order will simply be released — nothing has been paid, nothing is lost.')}</p>
      ${sellerLocked ? '' : `<button id="pyDoCancel" style="width:100%;background:transparent;color:var(--warn);border:1px solid var(--warn)">${tr('Cancel the deal')}</button>`}
      <button id="pyBack" class="ghost">${tr('Back')}</button>`;
    card.appendChild(ov);
    q(ov, '#pyBack').onclick = restore;
    const dc = q(ov, '#pyDoCancel'); if (dc) dc.onclick = async () => { restore(); await doCancel(); };
  };
}

// build + broadcast a partial fill of a ranged offer, in EITHER direction. The ranged bundle's
// [payout, change] are the first two outputs; the taker's fill + change follow. The maker's give
// input keeps its (fill-independent) SIGHASH_BUNDLE signature; the taker signs its own inputs.
// The taker pays `payout` in the want asset; the network fee is always in FRC (a separate coin
// when the want asset isn't FRC, else taken from the FRC payout's surplus).
// opts.fillSpk: pay the fill (+tokens) to this script instead of my main address — Freiland's
// buy path lands the name-NFT straight on the buyer's LAND address (where landRegister expects it).
async function fillRangedNow(offer, fillUnits, opts = null) {
  try {
    const d = offer.desc;
    if (!offer.give) throw new Error(tr('offer coin is gone'));
    // 0-fee: either leg of a fill (the taker's asset/token output, the maker's asset payout)
    // can be dust, and Freicoin admits dust only in fee-less txs (see mvSendAsset)
    const L = offer.lockHeight, fee = 0n, prevout = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
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
    // a token give coin: the whole set travels to the taker's fill output, revealed two-sided
    const giveToks = offer.give.tokenHash ? (offer.give.tokens ?? []) : null;
    if (giveToks && !giveToks.length) throw new Error(tr('this coin\u2019s token list is not recovered yet \u2014 wait for a full sync'));
    /** @type {{value: bigint, scriptPubKey: string, assetTag?: string|null, tokens?: string[]}[]} */
    const vout = [
      { value: payout, scriptPubKey: d.payoutScript, assetTag: payoutTag },   // [payout] to maker
      { value: change, scriptPubKey: d.changeScript, assetTag: giveTag },     // [change] to maker
      { value: fill, scriptPubKey: opts?.fillSpk ?? spks[0], assetTag: giveTag, ...(giveToks ? { tokens: giveToks } : {}) },   // fill (+tokens) to me
    ];
    const payChange = payPv - payout - (isFrcPayout ? fee : 0n);   // my want-asset change
    if (payChange > 0n) vout.push({ value: payChange, scriptPubKey: spks[0], assetTag: payoutTag });
    // two-sided reveal for a token buy: input section = the give coin's set (vs its commitment),
    // output section = the fill output (index 2) that now carries the set
    if (giveToks) {
      const reveal = makeTokenReveal(vout, [{ tokens: giveToks }]);
      vout.push({ value: 0n, scriptPubKey: opReturnScript(reveal) });
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
    ${o.give.tokenHash ? `<div class="sub" style="font-size:13px">🎟 ${(o.give.tokens ?? []).map(tokLabel).join(' · ') || tr('recovering…')}</div>` : ''}
    ${whole ? '' : `<div class="sub" style="font-size:13px">${tr('Available')}: ${maxU.toLocaleString(getLang())} ${assetName(giveTag)}<br>${tr('Per buy:')} ${minU.toLocaleString(getLang())} – ${capU.toLocaleString(getLang())}</div>`}
    <label>${tr('Quantity')}<div class="amtrow"><input id="bQty" type="text" inputmode="decimal" ${whole ? `value="${maxU}" disabled` : `placeholder="${minU.toLocaleString(getLang())} – ${capU.toLocaleString(getLang())}"`}>${whole ? '' : `<button id="bMax" class="ghost">${tr('Max')}</button>`}</div></label>
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

// Buy N tickets from a collapsed group: pick a quantity (1..available), fill that many one-
// ticket offers one at a time (each a whole fill of a 1-token coin).
function openTicketBuyModal(offers) {
  if ($('#modal') || !offers.length) return;
  const o0 = offers[0];
  const giveTag = o0.give.assetTag, wantTag = (o0.desc.payoutAsset && o0.desc.payoutAsset !== HOST_TAG) ? o0.desc.payoutAsset : null;
  const each = (BigInt(o0.desc.priceNum) + BigInt(o0.desc.priceDen) - 1n) / BigInt(o0.desc.priceDen);
  const N = offers.length;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Buy')} \ud83c\udf9f ${assetName(giveTag)}</b><button id="tbClose" class="icon">\u2715</button></div>
    <div class="sub" style="font-size:13px">${N} ${tr('available')} \u00b7 ${fmtA(wantTag ?? 'FRC', each)} ${tr('each')}</div>
    <label>${tr('How many')}<div class="amtrow"><input id="tbQty" type="text" inputmode="numeric" value="1"><button id="tbMax" class="ghost">${tr('Max')}</button></div></label>
    <div class="rrow"><span>${tr('You pay')}</span><b id="tbCost"></b></div>
    <button id="tbBuy">${tr('Buy')}</button></div>`;
  document.body.appendChild(m);
  const clamp = () => { let q = Math.floor(num($('#tbQty').value)); if (!(q > 0)) q = 0; if (q > N) q = N; return q; };
  const cost = () => { const q = clamp(); $('#tbCost').textContent = q > 0 ? fmtA(wantTag ?? 'FRC', each * BigInt(q)) : '\u2014'; };
  cost();
  armOverlay(m);
  q(m, '#tbClose').onclick = () => closeOverlay(m);
  q(m, '#tbQty').oninput = cost;
  q(m, '#tbMax').onclick = () => { $('#tbQty').value = String(N); cost(); };
  q(m, '#tbBuy').onclick = async () => {
    const qty = clamp();
    if (!(qty > 0)) return toast(tr('enter a quantity'), 'err');
    const btn = q(m, '#tbBuy'); btn.disabled = true; btn.textContent = tr('buying…');
    let done = 0;
    for (const off of offers.slice(0, qty)) {
      // each is a whole one-ticket coin ⇒ buy the whole (fill = its unit value)
      const u = Number(BigInt(off.give.value)) / scaleOf(giveTag);
      if (await fillRangedNow(off, u)) done++; else break;
    }
    if (done) { closeOverlay(m); toast(`${done} ${tr('tickets bought')}`, 'ok'); }
    else { btn.disabled = false; btn.textContent = tr('Buy'); }
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
        // asset cancel is 0-fee (see mvSendAsset — dust admits no fee). A TOKEN give coin only
        // spends with a two-sided FRT1 reveal: input section proves the committed set, and the
        // returned coin carries it onward (bad-txns-token-input-unrevealed otherwise).
        const giveToks = offer.give.tokenHash ? (offer.give.tokens ?? []) : null;
        if (giveToks && !giveToks.length) throw new Error(tr('this coin’s token list is not recovered yet — wait for a full sync'));
        vout.push({ value: givePv, scriptPubKey: spks[0], assetTag: giveTag, ...(giveToks ? { tokens: giveToks } : {}) });
        if (giveToks) {
          const reveal = makeTokenReveal(vout, [{ tokens: giveToks }]);
          vout.push({ value: 0n, scriptPubKey: opReturnScript(reveal) });
        }
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
  // pre-sync placeholder: drop Freiland names (land:…); paint() replaces this with class-aware opts
  const assetOpts = Object.entries(defs).filter(([, d]) => !(d.name || '').startsWith('land:'))
    .map(([tag, d]) => `<option value="${tag}">${d.name || tag.slice(0, 8) + '…'}</option>`).join('');
  return `<option value="">${tr('all')}</option><optgroup label="${tr('Currency')}"><option value="FRC">FRC</option><option value="BTC">BTC</option></optgroup>`
    + (assetOpts ? `<optgroup label="${tr('Assets')}">${assetOpts}</optgroup>` : '');
}
// minimalist price sparkline above the book: completed FRC↔BTC trades from the relay archive
// (sat/FRC over time) with the current best ask as the live endpoint. Hidden until there are
// at least two points — no axes, no grid, one line and one figure.
// chart data: COMPLETED FRC↔BTC trades from the relay archive only (sat/FRC over time) —
// open offers are the table below, not history
function tradePts() {
  return [...(state.p2p?.archive || [])]
    .filter(w => w.archivedAt && !w.assetTag && +w.frcAmount > 0 && +w.btcAmount > 0)
    .map(w => ({ t: +w.archivedAt, p: Number(w.btcAmount) / Number(w.frcAmount) * 1e8 }))
    .sort((a, b) => a.t - b.t);
}
// one accent polyline + dots, no axes/grid; theme-aware via CSS vars
function chartSvg(pts, H) {
  const W = 600, P = 5;
  const t0 = pts[0].t, t1 = pts.at(-1).t, lo = Math.min(...pts.map(x => x.p)), hi = Math.max(...pts.map(x => x.p));
  const X = t => P + (W - 2 * P) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  const Y = p => H - P - (H - 2 * P) * (hi === lo ? 0.5 : (p - lo) / (hi - lo));
  const path = pts.map((x, i) => `${i ? 'L' : 'M'}${X(x.t).toFixed(1)},${Y(x.p).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>
      ${pts.map(x => `<circle cx="${X(x.t).toFixed(1)}" cy="${Y(x.p).toFixed(1)}" r="2" fill="var(--accent)" opacity="0.6"/>`).join('')}
    </svg>`;
}
// detailed chart for the history window: drawn at the element's REAL pixel width (no viewBox
// stretching, so text stays true), with a dashed price grid, time labels and a soft area fill.
function detailChart(el, pts) {
  const W = el.clientWidth || 380, H = 200, L = 8, R = 8, T = 16, B = 26;
  const t0 = pts[0].t, t1 = pts.at(-1).t;
  let lo = Math.min(...pts.map(x => x.p)), hi = Math.max(...pts.map(x => x.p));
  if (hi === lo) { lo -= lo * 0.05 || 0.5; hi += hi * 0.05 || 0.5; }   // flat series: pad the band so the line sits mid-chart
  const X = t => L + (W - L - R) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  const Y = p => T + (H - T - B) * (1 - (p - lo) / (hi - lo));
  const line = pts.map((x, i) => `${i ? 'L' : 'M'}${X(x.t).toFixed(1)},${Y(x.p).toFixed(1)}`).join('');
  const area = `${line} L${X(t1).toFixed(1)},${(H - B).toFixed(1)} L${X(t0).toFixed(1)},${(H - B).toFixed(1)} Z`;
  const fmtT = t => new Date(t).toLocaleString(getLang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const levels = [lo, (lo + hi) / 2, hi];
  // price labels live INSIDE the plot (right-aligned above their gridline) — a reserved label
  // column made the chart visibly narrower than the table under it
  el.innerHTML = `<svg width="${W}" height="${H}" style="display:block">
    ${levels.map(p => `<line x1="${L}" y1="${Y(p).toFixed(1)}" x2="${W - R}" y2="${Y(p).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 4"/>
      <text x="${W - R - 2}" y="${(Y(p) - 4).toFixed(1)}" font-size="11" fill="var(--sub)" text-anchor="end">${p.toFixed(2)}</text>`).join('')}
    <path d="${area}" fill="var(--accent)" opacity="0.07"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map((x, i) => `<circle cx="${X(x.t).toFixed(1)}" cy="${Y(x.p).toFixed(1)}" r="2.5" fill="var(--accent)"${i === pts.length - 1 ? '' : ' opacity="0.55"'}/>`).join('')}
    <text x="${L}" y="${H - 8}" font-size="11" fill="var(--sub)">${fmtT(t0)}</text>
    <text x="${W - R}" y="${H - 8}" font-size="11" fill="var(--sub)" text-anchor="end">${fmtT(t1)}</text>
  </svg>`;
}
// full history window: detailed chart + the archived trades, newest first (tap the sparkline)
function openTradeHistory() {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  document.body.appendChild(m);
  const pts = tradePts();
  const trades = [...(state.p2p?.archive || [])]
    .filter(w => w.archivedAt && !w.assetTag && +w.frcAmount > 0 && +w.btcAmount > 0)
    .sort((a, b) => b.archivedAt - a.archivedAt);
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Trade history')}</b><button id="thClose" class="icon">✕</button></div>
    ${pts.length > 1 ? '<div id="thChart"></div>' : `<p class="sub">${tr('no trades yet')}</p>`}
    <table class="mkt"><thead><tr><th></th><th class="r">FRC</th><th class="r">sat/FRC</th></tr></thead>
      <tbody>${trades.map(w => `<tr><td class="sub">${new Date(+w.archivedAt).toLocaleString(getLang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td class="r">${frc(w.frcAmount)}</td><td class="r">${(Number(w.btcAmount) / Number(w.frcAmount) * 1e8).toFixed(2)}</td></tr>`).join('')}</tbody></table></div>`;
  const ch = q(m, '#thChart'); if (ch) detailChart(ch, pts);   // after mount — needs the real width
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#thClose').onclick = () => m.remove();
}
function paintOfferChart() {
  const el = $('#offerChart'); if (!el || !state) return;
  const pts = tradePts();
  if (pts.length < 2) { el.innerHTML = ''; return; }
  const lo = Math.min(...pts.map(x => x.p)), hi = Math.max(...pts.map(x => x.p)), last = pts.at(-1);
  const html = chartSvg(pts, 44) + `
    <div class="sub" style="display:flex;justify-content:space-between;font-size:12px;margin:0 0 6px">
      <span>${tr('trades')} · ${lo.toFixed(2)}–${hi.toFixed(2)}</span><span>${last.p.toFixed(2)} sat/FRC</span>
    </div>`;
  if (el._src !== html) { el.innerHTML = html; el._src = html; el.style.cursor = 'pointer'; el.onclick = openTradeHistory; }
}
// FREILAND: реестр имён. Занять имя (залог на своём land-адресе → рента демерреджем → резолв),
// «Мои имена». Механика в @/services/market/land.mjs; выкуп чужих имён — следующий шаг.
// ---- Freiland names surfaced INLINE (no modal): «My names» (manage) in the Balance tab,
// «Names for sale» (browse + buy) in the Exchange. Both read the relay registry; actions sign
// with the land-key via land.mjs. Claiming a name lives in Issue → Holdings.
let _landMod = null;
let _nameTags = new Set();   // asset tags of Freiland name-NFTs — excluded from the trading book (they belong to «Holdings»)
const landMod = async () => (_landMod ??= await import('@/services/market/land.mjs'));
const fmtFrcN = v => (Number(BigInt(v)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 2 });
const nameLog = (sel, t) => { const el = $(sel); if (el) el.textContent = t; };

// «Мои имена» (вкладка Баланс): управление — резолв ✎, переоценка/долив ±.
export async function paintMyNames() {
  const box = $('#myNamesBody'); if (!box) return;
  const L = await landMod();
  let all = []; try { all = (await L.listNames()).names; } catch {}
  const mine = all.filter(n => n.ownerFrcPub === L.landOwnerPub(n.name));
  box.innerHTML = mine.length
    ? mine.map(n =>
        `<tr><td style="font-family:ui-monospace,monospace">${n.name}${n.lapsed ? ' ⚠' : ''}</td>
           <td class="r">${n.price ? fmtFrcN(n.price) : '—'} / ${n.value && n.value !== '0' ? fmtFrcN(n.value) : '—'} FRC</td>
           <td class="act-cell"><button class="icon nmMng" data-n="${n.name}" data-r="${n.resolve || ''}" data-p="${n.price || ''}" title="${tr('Manage')}">⋯</button></td></tr>`).join('')
    : `<tr><td colspan="3" class="sub">${tr('no names yet — claim one in Issue → Holdings')}</td></tr>`;
  box.querySelectorAll('.nmMng').forEach(b => b.onclick = () => openNameModal(b.dataset.n, b.dataset.r, b.dataset.p));
}

// Manage a name: ONE modal with both actions (revalue/top-up + repoint), replacing the two
// per-row icon buttons and their browser prompt() dialogs.
async function openNameModal(name, resolve, price) {
  if ($('#modal')) return;
  const L = await landMod();
  const curV = price ? String(Number(BigInt(price)) / 1e8) : '';
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>🗺️ ${name}</b><button id="nmX" class="icon">✕</button></div>
    <label>${tr('Self-assessed value')} (FRC)<input id="nmMV" type="text" inputmode="decimal" value="${curV}"></label>
    <button id="nmMReval">${tr('Top up / revalue')}</button>
    <label>${tr('Points to address')}<input id="nmMRes" type="text" autocomplete="off" spellcheck="false" value="${resolve || ''}"></label>
    <button id="nmMResBtn" class="ghost">${tr('Update address')}</button>
    <div id="nmMLog" class="sub" style="font-size:12px;white-space:pre-line"></div></div>`;
  document.body.appendChild(m);
  armOverlay(m);
  const log = t => { const el = $('#nmMLog'); if (el) el.textContent = t; };
  q(m, '#nmX').onclick = () => closeOverlay(m);
  q(m, '#nmMReval').onclick = async () => {
    const nv = num($('#nmMV').value), rmin = await L.minValueFrc();
    if (!(nv >= rmin)) return toast(`${tr('minimum value is')} ${rmin} FRC`, 'err');
    const btn = $('#nmMReval'); btn.disabled = true;
    try {
      await L.revalueName({ name, valueFrc: nv, progress: p => log(
        p === 'rebond' ? tr('rebonding the deposit…')
        : p === 'confirm' ? tr('waiting for confirmation (this can take a few minutes)…')
        : p === 'offer' ? tr('signing the standing sale offer…')
        : tr('registered ✅')) });
      toast(`${name}: ${tr('revalued ✅')}`, 'ok'); $('#modal')?.remove(); paintMyNames();
    } catch (e) { toast(e.message, 'err'); log(e.message); btn.disabled = false; }
  };
  q(m, '#nmMResBtn').onclick = async () => {
    const to = $('#nmMRes').value.trim(); if (!to || to === resolve) return;
    try { await L.setResolve(name, to); toast(tr('resolve updated ✅'), 'ok'); $('#modal')?.remove(); paintMyNames(); }
    catch (e) { toast(e.message, 'err'); log(e.message); }
  };
}

// «Имена в продаже» (вкладка Биржа): доска Гарбергера — все живые имена + трастлесс-выкуп.
export async function paintNameMarket() {
  const L = await landMod();
  let all = []; try { all = (await L.listNames()).names; } catch {}
  _nameTags = new Set(all.filter(n => n.nftTag).map(n => n.nftTag));   // keep the book's name-exclusion set fresh
  const box = $('#nameMktBody'); if (!box) return;
  const mineSet = new Set(all.filter(n => n.ownerFrcPub === L.landOwnerPub(n.name)).map(n => n.name));
  const live = all.filter(n => !n.lapsed).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  box.innerHTML = live.length
    ? live.map(n =>
        `<tr><td style="font-family:ui-monospace,monospace">${n.name}${mineSet.has(n.name) ? ' · ' + tr('yours') : ''}</td>
           <td class="r">${fmtFrcN(n.buyable && n.price ? n.price : n.value)} FRC</td>
           <td class="act-cell">${n.buyable && !mineSet.has(n.name) ? `<button class="nmBuy rbtn" data-n="${n.name}" data-p="${n.price}" title="${tr('Buy')}" aria-label="${tr('Buy')}">${SVG.buy}</button>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="3" class="sub">${tr('no names registered yet')}</td></tr>`;
  box.querySelectorAll('.nmBuy').forEach(b => b.onclick = () => buyName(b.dataset.n, b.dataset.p));
}

// resolve + revalue moved into openNameModal (one modal, no browser prompt() dialogs)

// трастлесс-выкуп (шаг 5c): исполнить стоячий оффер владельца (NFT едет филлом ПРЯМО на мой
// land-адрес), затем adoptName — свой залог, свой оффер, перерегистрация на меня. Старому
// владельцу V уже упала оффером; его залог заберёт его собственный maybeResignLand.
async function buyName(name, price) {
  const L = await landMod();
  const priceFrc = Number(BigInt(price)) / 1e8;
  const vNew = prompt(`${tr('Buy for')} ${fmtFrcN(price)} FRC. ${tr('Your new self-assessed value (FRC)?')}`, String(Math.ceil(priceFrc)));
  if (vNew == null) return;
  const v = num(vNew);
  const bmin = await L.minValueFrc();
  if (!(v >= bmin)) return toast(`${tr('minimum value is')} ${bmin} FRC`, 'err');
  const log = t => nameLog('#nameMktLog', t);
  try {
    const look = await api('landLookup', { name });
    if (!look.found || !look.buyable) throw new Error(tr('name is not buyable right now'));
    const offer = state?.info?.book?.find(o => o.ranged && o.id === look.offerId && o.status === 'open');
    if (!offer) { mvRefresh(); throw new Error(tr('offer not in the book yet — try again in a minute')); }
    log(tr('buying the name…'));
    // имя ходит только целиком: fill = весь номинал NFT-монеты (10^8 юнитов, см. NFT_UNITS)
    const units = Number(BigInt(offer.desc.maxFill)) / scaleOf(offer.give.assetTag ?? null);
    const ok = await fillRangedNow(offer, units, { fillSpk: L.landDepositSpk(name) });
    if (!ok) { log(''); return; }
    await L.adoptName({ name, valueFrc: v, progress: p => log(
      p === 'lock' ? tr('locking the deposit…')
      : p === 'confirm' ? tr('waiting for confirmation (this can take a few minutes)…')
      : p === 'offer' ? tr('signing the standing sale offer…')
      : tr('registered ✅')) });
    log(''); toast(`${name}: ${tr('name is yours ✅')}`, 'ok'); paintNameMarket(); paintMyNames();
  } catch (e) { toast(e.message, 'err'); log(e.message); }
}

// Биржа делится на три класса актива, как форма «Выпуск»: Валюта (FRC/валюты + BTC-свопы),
// Токены (пользовательские токены/тикеты), Владения (Freiland-имена — доска + выкуп). Имена-NFT
// исключены из книги (у них есть tokenHash — иначе попали бы в «Токены») и живут только в «Владениях».
let mktClass = 'cur';   // 'cur' | 'tok' | 'hold'
export function renderExchange(el) {
  const fopt = cachedFilterOpts();
  const nv3 = currentNet() === 'nv3';
  mktClass = 'cur';
  el.innerHTML = `
    ${nv3 ? `<div class="seg" id="mktClass">
      <button data-c="cur" class="on">${tr('Currency')}</button>
      <button data-c="tok">${tr('Token')}</button>
      <button data-c="hold">${tr('Holding')}</button>
    </div>` : ''}
    <div id="mktTrade">
      <div class="row">
        <label>${tr('Selling')}<select id="fGive">${fopt}</select></label>
        <label>${tr('Wants')}<select id="fWant">${fopt}</select></label>
      </div>
      <div id="offerChart"></div>
      <table class="mkt"><thead><tr><th>#</th><th>${tr('Give')}</th><th>${tr('Want')}</th><th></th></tr></thead><tbody id="bookBody"><tr><td colspan="4" style="padding:14px 2px 4px;border-bottom:none">${skel(3)}</td></tr></tbody></table>
      <div class="row"><button id="openOffer">${tr('Post an offer')}</button></div>
    </div>
    ${nv3 ? `<div id="mktHold" hidden>
      <div class="sub" style="font-size:12px;margin:2px 0">🗺️ ${tr('Names for sale')}. ${tr('to claim a new name, use Issue → Holdings')}</div>
      <table class="mkt"><thead><tr><th>${tr('Name')}</th><th class="r">${tr('Price')}</th><th></th></tr></thead><tbody id="nameMktBody">${skelRows(2)}</tbody></table>
      <div id="nameMktLog" class="sub" style="font-size:12px;white-space:pre-line"></div>
    </div>` : ''}`;
  $('#openOffer').onclick = openOfferModal;
  ['#fGive', '#fWant'].forEach(s => { const e = $(s); if (e) e.onchange = paint; });
  if (nv3) {
    el.querySelectorAll('#mktClass button').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => {
      mktClass = b.dataset.c;
      el.querySelectorAll('#mktClass button').forEach(x => x.classList.toggle('on', x === b));
      $('#mktTrade').hidden = mktClass === 'hold';
      $('#mktHold').hidden = mktClass !== 'hold';
      if (mktClass === 'hold') paintNameMarket(); else paint();
    });
    paintNameMarket();   // populate the name-tag set (so the book can exclude name offers) + the board
  }
  if (state) paint(); else mvRefresh();
}
// Balance tab (nv3) — the holdings split into the same three classes as Issue/Exchange:
// Currency (FRC + BTC + fungible currency assets), Tokens (token/ticket assets), Holdings (names).
export function renderAssetBalance(el) {
  // The three-class split (Currency/Tokens/Holdings) is an nv3 concept — tokens and Freiland names
  // only exist there. On the other swap nets (mainnet/testnet) show the plain single balance table,
  // else those nets sprout empty «Tokens»/«Holdings» sections. #curBalBody is the shared tbody so
  // the provisional-balance painter (dashboard) targets one id on every net.
  // nv3: the class name IS each table's first-column header (no separate label), the amount column
  // keeps its «Quantity» header, and names show «Price / deposit» (self-assessed price / the deposit's
  // present value — equal while rent is paid, the deposit trailing once it melts) instead of «V / залог».
  const nv3 = currentNet() === 'nv3';
  el.innerHTML = nv3 ? `
    <table class="mkt"><thead><tr><th>${tr('Currency')}</th><th class="r">${tr('Quantity')}</th></tr></thead><tbody id="curBalBody">${skelRows(2)}</tbody></table>
    <table class="mkt" style="margin-top:12px"><thead><tr><th>${tr('Token')}</th><th class="r">${tr('Quantity')}</th></tr></thead><tbody id="tokBalBody">${skelRows(1)}</tbody></table>
    <table class="mkt" style="margin-top:12px"><thead><tr><th>${tr('Holding')}</th><th class="r">${tr('Price')} / ${tr('deposit')}</th><th></th></tr></thead><tbody id="myNamesBody">${skelRows(1)}</tbody></table>
    <div id="myNamesLog" class="sub" style="font-size:12px;white-space:pre-line"></div>`
  : `<table class="mkt"><thead><tr><th>${tr('Asset')}</th><th class="r">${tr('Quantity')}</th></tr></thead><tbody id="curBalBody">${skelRows(3)}</tbody></table>`;
  const f = $('#faucetBtn'); if (f) f.onclick = faucet;   // the button itself lives with the other Balance actions
  if (state) paintAssetBalance(); else mvRefresh();
  if (nv3) paintMyNames();
}
function paintAssetBalance() {
  const cur = $('#curBalBody'), tok = $('#tokBalBody'); if (!cur || !state) return;
  // a provisional mine (assets() still syncing) has NO coins — painting it would stamp 'FRC 0'
  // over the restore preview's real figure; keep the provisional/skeleton rows until real data
  if (state.mine?.provisional) return;
  const h = state.mine.height;
  const pvU = u => assetPresentValue(BigInt(u.value), h - u.refheight, rateOf(u.assetTag));
  const byAsset = new Map(); const isTok = new Set();   // token asset ⇔ any held coin carries a token set
  for (const u of state.mine.utxos) { const k = u.assetTag ?? 'FRC'; const e = byAsset.get(k) ?? { nominal: 0n, pv: 0n }; e.nominal += BigInt(u.value); e.pv += pvU(u); byAsset.set(k, e); if (u.tokenHash) isTok.add(k); }
  // credit the pending-send CHANGE (already present-valued) to FRC so the swap balance drops only by
  // what actually left the wallet — matching the plain balance card and activity, no double-debit.
  const pc = state.mine.pendingChange || 0n;
  if (pc) { const e = byAsset.get('FRC') ?? { nominal: 0n, pv: 0n }; e.nominal += pc; e.pv += pc; byAsset.set('FRC', e); }
  const amt = (tag, v) => tag === 'FRC' ? frc(v)
    : (Number(BigInt(v)) / scaleOf(tag)).toLocaleString(getLang(), { maximumFractionDigits: decimalsOf(tag) });
  const row = (tag, e) => `<tr><td${tag === 'FRC' ? '' : ` title="${tag}"`}>${assetName(tag === 'FRC' ? null : tag)}</td><td class="r">${amt(tag, e.pv)}</td></tr>`;
  const curRows = [], tokRows = [];
  for (const [tag, e] of byAsset) (isTok.has(tag) ? tokRows : curRows).push(row(tag, e));
  // BTC is a currency (held in-wallet on signet); the cell fills in when refreshBtc returns.
  if (state.swap?.available) curRows.push(`<tr><td>BTC</td><td class="r" id="btcBalCell">${mvBtc().balance != null ? btcToStr(mvBtc().balance) : '…'}</td></tr>`);
  cur.innerHTML = curRows.join('') || `<tr><td colspan="2" class="sub">${tr('empty — tap Faucet')}</td></tr>`;
  if (tok) tok.innerHTML = tokRows.join('') || `<tr><td colspan="2" class="sub">${tr('no tokens')}</td></tr>`;
}

function paint() {
  if (!state || !$('#bookBody')) return;
  paintOfferChart();
  const h = state.mine.height;
  const pvU = u => assetPresentValue(BigInt(u.value), h - u.refheight, rateOf(u.assetTag));
  const byAsset = new Map();
  for (const u of state.mine.utxos) {
    const k = u.assetTag ?? 'FRC';
    const e = byAsset.get(k) ?? { nominal: 0n, pv: 0n };
    e.nominal += BigInt(u.value); e.pv += pvU(u);
    byAsset.set(k, e);
  }

  // Freiland name-NFTs never trade here (they live in «Holdings») — drop them from every selector,
  // by their tag (from the names board) or their «land:…» name (fallback before the board loads).
  const tradable = a => !_nameTags.has(a.tag) && !(a.name || '').startsWith('land:');
  const btcCur = state.swap?.available ? '<option value="BTC">BTC</option>' : '';   // BTC is a currency here, not a separate group

  // OFFER FORM: "I sell" = the assets I hold (minus names); "I want" = any tradable asset.
  const sellOpt = k => `<option value="${k}">${assetName(k === 'FRC' ? null : k)}</option>`;
  const frcHeld = byAsset.get('FRC'), heldAssets = [...byAsset.entries()].filter(([k]) => k !== 'FRC' && !_nameTags.has(k));
  const sellCur = (frcHeld ? sellOpt('FRC') : '') + btcCur;
  setOptions('#rAsset', ((sellCur ? `<optgroup label="${tr('Currency')}">${sellCur}</optgroup>` : '')
    + (heldAssets.length ? `<optgroup label="${tr('Assets')}">${heldAssets.map(([k]) => sellOpt(k)).join('')}</optgroup>` : ''))
    || `<option value="">${tr('no coins yet')}</option>`);
  const wantAssetOpts = state.info.assets.filter(tradable).map(a => `<option value="${a.tag}">${assetName(a.tag)}</option>`).join('');
  setOptions('#rWant', `<optgroup label="${tr('Currency')}"><option value="FRC">FRC</option>${btcCur}</optgroup>`
    + (wantAssetOpts ? `<optgroup label="${tr('Assets')}">${wantAssetOpts}</optgroup>` : ''));
  paintOfferAvail();   // reflect the selected sell asset's available balance in the form

  // FILTERS are CLASS-AWARE: they list only assets actually present in the CURRENT segment's OPEN
  // offers (names excluded) — so «Currency» never shows tokens, «Tokens» never shows currencies, and
  // idle issued assets with no live offer don't clutter the list. BTC (a swap, not a book offer)
  // is added to the Currency group explicitly.
  const giveTagOf = o => o.give ? (o.give.assetTag ?? 'FRC') : '';
  const wantTagOf = o => o.ranged ? ((o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : 'FRC') : (o.want?.assetTag ?? 'FRC');
  const classOf = o => _nameTags.has(o.give?.assetTag) ? null : (o.give?.tokenHash ? 'tok' : 'cur');
  const inClass = new Set();
  for (const o of state.info.book) if (o.status === 'open' && classOf(o) === mktClass) { inClass.add(giveTagOf(o)); inClass.add(wantTagOf(o)); }
  const fAssetTags = [...inClass].filter(t => t !== 'FRC');
  const showBtc = mktClass === 'cur' && state.swap?.available;
  const fopt = `<option value="">${tr('all')}</option>`
    + `<optgroup label="${tr('Currency')}"><option value="FRC">FRC</option>${showBtc ? '<option value="BTC">BTC</option>' : ''}</optgroup>`
    + (fAssetTags.length ? `<optgroup label="${tr('Assets')}">${fAssetTags.map(t => `<option value="${t}">${assetName(t)}</option>`).join('')}</optgroup>` : '');
  setOptions('#fGive', fopt); setOptions('#fWant', fopt);

  // skip repainting the book while a fill amount is being typed into it (else the 15s refresh
  // wipes the input) — same reason the offer selects are preserved.
  if (!$('#bookBody').contains(document.activeElement)) {
    const giveOf = o => o.give ? (o.give.assetTag ?? 'FRC') : '';
    const wantOf = o => o.ranged ? ((o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : 'FRC') : (o.want?.assetTag ?? 'FRC');
    const fg = $('#fGive')?.value || '', fw = $('#fWant')?.value || '';
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
    // class segment (nv3): Валюта = non-token gives, Токены = token gives; name-NFTs never in the
    // book (they live in «Holdings»). Non-nv3 stays 'cur' with no token/name assets anyway.
    const clsOk = o => {
      if (_nameTags.has(o.give?.assetTag)) return false;
      if (mktClass === 'tok') return !!o.give?.tokenHash;
      if (mktClass === 'hold') return false;
      return !o.give?.tokenHash;   // 'cur'
    };
    const filtered = state.info.book.filter(o => clsOk(o) && (!fg || giveOf(o) === fg) && (!fw || wantOf(o) === fw) && o.status === 'open').reverse();
    // tickets sold individually (1-token whole offers) COLLAPSE to one row per
    // (asset, maker, price, want) — "N tickets · price each". Others render one-per-row.
    const isTicket = o => o.ranged && o.status === 'open' && o.give?.tokenHash && (o.give.tokens?.length === 1);
    const gkey = o => [o.give.assetTag, o.makerSpk, o.desc.priceNum, o.desc.priceDen, o.desc.payoutAsset ?? ''].join('|');
    const groups = new Map(); const rows = [];
    for (const o of filtered) { if (isTicket(o)) { const k = gkey(o); (groups.get(k) ?? groups.set(k, []).get(k)).push(o); } else rows.push(o); }
    // one collapsed row, in the SAME shape as every other offer: # | Give | Want (total, unit
    // price in the tooltip) | action. Give shows the N tickets as a quantity of the asset.
    const groupRow = offers => {
      const o = offers[0], mine = spks.includes(o.makerSpk), N = offers.length;
      const giveTag = o.give.assetTag, wantTag = (o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : null;
      const ids = offers.map(x => x.id).join(',');
      const price = Number(BigInt(o.desc.priceNum)) / Number(BigInt(o.desc.priceDen)) * scaleOf(giveTag) / scaleOf(wantTag);
      const wantTotal = (BigInt(N) * BigInt(o.desc.priceNum) + BigInt(o.desc.priceDen) - 1n) / BigInt(o.desc.priceDen);
      const give = fmtA(giveTag, BigInt(N * scaleOf(giveTag)));
      const act = mine
        ? `<button class="rcancelgrp" data-ids="${ids}">${tr('Cancel')}</button>`
        : `<button class="rbtngrp" data-ids="${ids}">${tr('Buy')}</button>`;
      return `<tr><td>${o.id}</td><td>${give}</td>
        <td title="@ ${price.toLocaleString(getLang(), { maximumFractionDigits: 8 })} ${assetName(wantTag)}">${fmtA(wantTag ?? 'FRC', wantTotal)}</td><td class="act-cell">${act}</td></tr>`;
    };
    const groupHtml = [...groups.values()].map(groupRow).join('');
    // cross-chain BTC swaps ride the SAME table: the relay LP listing (FRC→BTC) + my in-flight
    // swaps, shown only when the filters don't exclude a BTC pair. Settlement is HTLC, not an
    // on-chain splice — marked with the ⇄ badge so it reads as cross-chain, not a ranged offer.
    const btcMatch = (!fg || fg === 'FRC') && (!fw || fw === 'BTC');
    let swapRows = '';
    const myP2p = new Map(loadP2p().map(r => [r.id, r]));
    if (state.swap && mktClass === 'cur') {   // BTC↔FRC swaps are currency — only in the «Currency» tab
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
        // paid-but-still-'taken' means the relay hasn't accepted the funding yet (needs 2 BTC confs) —
        // the honest label there is "confirming payment", not the seller-turn wording.
        const stLabel = (!isRev && mineRec?.role === 'taker' && mineRec.btcHtlc?.txid && o.status === 'taken') ? tr('confirming payment on the network') : p2pStatusLabel(o, mineRec);
        if (isOffer) act = mineRec ? actBtn('p2pcancel', o.id, 'cancel', tr('Cancel'))
          : actBtn('p2ptakepart rbtn', o.id, 'buy', tr('Buy'));   // pick an amount
        else if (mineRec) act = (!isRev && mineRec.status === 'need_btc' && !o.btcHtlc?.txid && !mineRec.btcHtlc?.txid) ? actBtn('p2ppay rbtn', o.id, 'pay', tr('Pay'))
          : (o.status === 'open' && !o.frcHtlc && !o.btcHtlc) ? actBtn('p2pcancel', o.id, 'cancel', tr('Cancel'))
          // MY paid forward purchase, still settling → a CLICKABLE status icon that reopens the pay/status
          // window (which carries its own "Отменить покупку"). Covers confirming-payment → awaiting-seller → claiming.
          : (!isRev && mineRec.role === 'taker' && mineRec.btcHtlc?.txid && !['frc_claimed', 'done', 'btc_claimed_rev'].includes(o.status)) ? actBtn('p2pstatus', o.id, 'wait', stLabel)
          // MY dangling take with NOTHING funded (the funding step failed) AND no BTC actually sent — let
          // the taker release the reservation. NEVER offer this once I've funded (!mineRec.btcHtlc) — a
          // p2puntake there would drop the reservation while my BTC sits locked in the HTLC → stranded coin.
          : (mineRec.role === 'taker' && o.status === 'taken' && !o.frcHtlc?.txid && !o.btcHtlc?.txid && !mineRec.btcHtlc?.txid) ? actBtn('p2puntake', o.id, 'cancel', tr('Cancel'))
          : `<span class="sub">${p2pStatusLabel(o, mineRec)}</span>`;
        else act = o.status === 'open' ? actBtn('p2ptake rbtn', o.id, 'buy', tr('Buy')) : `<span class="sub">${p2pStatusLabel(o, mineRec)}</span>`;
        // MY in-progress swaps carry a live action (Pay / a status) — never dim them; .filled is for
        // settled/other rows only (here that never actually triggers, but keep the intent explicit)
        if (o.status === 'open' || (mineRec && !isOffer))
          swapRows += `<tr class="swap ${o.status === 'open' || mineRec ? '' : 'filled'}"><td>${o.id.replace(/^p2p/, '')}</td><td>${give}</td><td>${want}</td><td class="act-cell">${act}</td></tr>`;
      }
      for (const w of (btcMatch ? loadMySwaps() : [])) {
        const past = state.mine.height > w.T1;
        swapRows += `<tr class="swap ${past ? '' : 'filled'}"><td></td><td>${frc(w.funding.value)} FRC</td><td>BTC</td><td class="act-cell sub">${past ? tr('refundable') : tr('in progress')}</td></tr>`;
      }
    }
    $('#bookBody').innerHTML = (groupHtml + rows.map(bookRow).join('') + swapRows)
      || `<tr><td colspan="4" class="sub">${state.info.book.length ? tr('no offers match') : tr('no offers yet')}</td></tr>`;
    $('#bookBody').querySelectorAll('.rbtngrp').forEach(b => b.onclick = () => {
      const ids = b.dataset.ids.split(',').map(Number);
      const offers = ids.map(id => state.info.book.find(o => o.id === id)).filter(Boolean);
      openTicketBuyModal(offers);
    });
    $('#bookBody').querySelectorAll('.rcancelgrp').forEach(b => b.onclick = async () => {
      const ids = b.dataset.ids.split(',').map(Number);
      for (const id of ids) { const o = state.info.book.find(x => x.id === id); if (o) await cancelRanged(o); }
    });
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
    $('#bookBody').querySelectorAll('.p2pstatus').forEach(b => b.onclick = () => {   // in-flight swap → reopen the pay/status window (with Cancel inside)
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (rec) openP2pPayModal(rec);
    });
    $('#bookBody').querySelectorAll('.p2puntake').forEach(b => b.onclick = async () => {
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (!rec) return;
      try {
        await api('p2pUntake', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) });
        dropP2p(rec.id);
        b.closest('tr')?.remove();
        toast(tr('purchase cancelled'), 'ok');
        Promise.resolve(inflight).then(() => mvRefresh());
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#bookBody').querySelectorAll('.p2pcancel').forEach(b => b.onclick = async () => {
      const rec = loadP2p().find(x => x.id === b.dataset.id); if (!rec) return;
      try {
        await api('p2pCancel', { id: rec.id, makerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) });
        // takes of this offer still in flight → the record must survive (its nonce serves them);
        // driveP2p drops it once the last take settles
        (state.p2p?.swaps || []).some(s => s.parent === rec.id)
          ? putP2p({ ...rec, status: 'cancelled' }) : dropP2p(rec.id);
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
