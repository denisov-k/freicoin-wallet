// market.mjs — Freimarkets МАРКЕТ: пользовательский интерфейс экспериментальной цепи
// (пользовательские активы с демерреджем/процентом + книга офферов), НЕкастодиальный:
// та же кошельковая сессия (общий vault в localStorage этого origin), ключи и подписи —
// только в браузере. Сервер (:5181) — цепь, кран, индекс и авто-матчер; украсть не может.
import './style.css';
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;

import { decryptSecret } from './vault.mjs';
import { configureNetwork, resolveSecret, deriveAddress, generateMnemonic, isMnemonic } from './wallet.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '../../../core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '../../../core/ecdsa.mjs';
import { segwitV0Sighash, rangedSighash, SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY, SIGHASH_BUNDLE } from '../../../core/sighash.mjs';
import { serializeTx, NV3_TX_VERSION } from '../../../core/tx.mjs';
import { assetPresentValue } from '../../../core/assets.mjs';
import { decodeWitness } from '../../../core/address.mjs';
import { Neutrino } from './net/client.mjs';
import { tr, getLang, setLang, LANGS } from './i18n.mjs';

// the wallet's ƒ coin mark (shared look for the login / loading cards)
const COIN_SVG = `<svg width="64" height="64" viewBox="0 0 72 72" aria-hidden="true">
  <defs><linearGradient id="cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#63bbff"/><stop offset="1" stop-color="#1565c0"/></linearGradient></defs>
  <circle cx="36" cy="36" r="34" fill="url(#cg)"/><circle cx="36" cy="36" r="34" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5"/>
  <circle cx="36" cy="36" r="27.5" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5" stroke-dasharray="2.5 3.5"/>
  <text x="35" y="49" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="40" fill="#fff">ƒ</text></svg>`;
const langSelect = id => `<select id="${id}" class="wlang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${getLang() === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`;

// origin-aware endpoints: on the TLS domain (market.testtty.ru) nginx proxies /api and /ws,
// so we stay same-origin (no mixed content); on plain http we hit the raw ports directly.
const HTTPS = location.protocol === 'https:';
const API = HTTPS ? `${location.origin}/api` : `http://${location.hostname}:5181/api`;
const HOST_TAG = '00'.repeat(20);
const ACCOUNT = "m/84'/1'/0'";              // regtest coin type (as the wallet's testnets)
const $ = s => document.querySelector(s);
const rev = h => h.match(/../g).reverse().join('');
const frc = v => (Number(BigInt(v)) / 1e8).toLocaleString('ru-RU', { maximumFractionDigits: 8 });
const toast = (m, cls = '') => { const t = $('#toast'); t.textContent = m; t.className = 'show ' + cls; setTimeout(() => t.className = '', 3500); };

let seed = null, km = {}, spks = [], myAddress = '', state = null, curTab = 'bal';

// ---- theme (system / dark / light), mirrors the wallet ----
const themeMode = () => localStorage.getItem('fw_theme_mode') || 'system';
function applyTheme(mode) {
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themeMode() === 'system') applyTheme('system'); });

// ---- sync indicator: the wallet's header status button (● amber=syncing / green=ok / red=off) ----
// Clicking it opens a details popover (#statusPop), same as the wallet.
let syncTip = 0, lastStatus = 'sync';
function setStatus(s) {
  lastStatus = s;
  const b = $('#statusBtn');
  if (b) { b.className = 'icon statusbtn st-' + s; b.title = tr({ ok: 'synced ✓ (verified)', off: 'offline' }[s] || 'syncing…'); }
  const pop = $('#statusPop'); if (pop && !pop.hidden) renderStatusPop();
}
function renderStatusPop() {
  const pop = $('#statusPop'); if (!pop) return;
  const label = tr({ ok: 'synced ✓ (verified)', off: 'offline' }[lastStatus] || 'syncing…');
  const rx = lc && lc._rx ? (lc._rx / 1e6).toFixed(2) + ' MB' : '';
  pop.innerHTML =
    `<div class="rrow"><span>${tr('Network')}</span><b>Freimarkets · nV3</b></div>
     <div class="rrow"><span>${tr('Status')}</span><b>${label}</b></div>
     <div class="rrow"><span>${tr('Block')}</span><b>${syncTip.toLocaleString(getLang())}</b></div>
     <div class="rrow"><span>UTXO</span><b>${state ? state.mine.utxos.length : 0}</b></div>
     <div class="rrow"><span>${tr('Assets')}</span><b>${state ? state.info.assets.length : 0}</b></div>
     ${rx ? `<div class="rrow"><span>${tr('Downloaded')}</span><b>${rx}</b></div>` : ''}`;
}
document.addEventListener('click', e => {
  const pop = $('#statusPop');
  if (pop && !pop.hidden && !pop.contains(e.target) && e.target.id !== 'statusBtn') pop.hidden = true;
});

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

// ---- trustless reads: the wallet's own Neutrino light client over the P2P bridge ----
// Balances, asset tags and rates are VERIFIED client-side (headers PoW-checked, BIP158
// filters, block scan, defs self-certified). The relay is used only for the order book,
// faucet, issuance funding, tx broadcast and mining — the inherently-external roles.
const BRIDGE = HTTPS ? `wss://${location.host}/ws` : `ws://${location.hostname}:3055`;
const GENESIS = '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8';   // regtest
let lc = null, lcReady = null, inflight = null;
const norm = tag => (!tag || tag === HOST_TAG) ? null : tag;
async function ensureLc() {
  if (!lcReady) lcReady = (async () => { lc = new Neutrino({ url: BRIDGE, net: 'regtest', genesis: GENESIS }); await lc.connect(); })();
  return lcReady;
}
function refresh() {                              // serialized: one sync at a time (concurrent
  if (inflight) return inflight;                 // syncWallet calls on one client deadlock)
  setStatus('sync');
  inflight = doRefresh().then(() => setStatus('ok')).catch(e => { setStatus('off'); toast(tr('sync') + ': ' + e.message, 'err'); }).finally(() => { inflight = null; });
  return inflight;
}
async function doRefresh() {
  await ensureLc();
  const [info, r] = await Promise.all([api('info'), lc.syncWallet(spks)]);
  const utxos = r.utxos.map(u => ({
    outpoint: `${u.txid}:${u.vout}`, spk: u.script, assetTag: norm(u.assetTag),
    value: String(u.value), refheight: u.refheight,
  }));
  state = { info, defs: r.assetDefs, mine: { height: r.tipHeight, utxos } }; syncTip = r.tipHeight;
  if ($('#balBody')) paint(); else render();   // shell built once; refreshes only repaint data
  maybeResignRanged();                          // keep my ranged offers alive after partial fills
}

// ---- actions ----
async function faucet() { try { await api('faucet', { address: myAddress }); toast(tr('Faucet: +1 FRC'), 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); } }

async function issue() {
  try {
    const name = $('#iName').value.trim() || 'актив';
    await api('issue', { name, shift: $('#iShift').value, interest: $('#iKind').value === 'i', amount: $('#iAmt').value, spk: spks[0] });
    toast(`«${name}» ${tr('issued to your address')}`, 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- permissionless matching: I splice two crossing offers with MY fee coin, keep the
// spread, broadcast. No privileged matcher — any participant can do exactly this. ----
function findMatch() {
  const open = state.info.book.filter(o => o.status === 'open' && o.give && !o.ranged);
  const h = state.mine.height;
  const pv = (v, tag, refh) => assetPresentValue(BigInt(v), h - refh, rateOf(tag));
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const a = open[i], b = open[j];
    if (a.lockHeight !== b.lockHeight) continue;
    const at = a.give.assetTag ?? null, bt = b.give.assetTag ?? null;
    const aw = a.want.assetTag ?? null, bw = b.want.assetTag ?? null;
    if (at !== bw || bt !== aw) continue;                       // must be the same pair, opposite sides
    const apv = pv(a.give.value, at, a.give.refheight), bpv = pv(b.give.value, bt, b.give.refheight);
    if (apv < BigInt(b.want.value) || bpv < BigInt(a.want.value)) continue;   // must cross
    return { a, b, apv, bpv };
  }
  return null;
}

async function matchNow() {
  try {
    const m = findMatch();
    if (!m) { toast(tr('no crossing offers to match'), ''); return; }
    const { a, b, apv, bpv } = m;
    const L = a.lockHeight, fee = 10000n;
    // my fee coin: host currency, older than the offers' lock height (monotonic lock_height)
    const myFee = state.mine.utxos.find(u => u.assetTag === null && u.refheight <= L && assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) > fee + 1000n);
    if (!myFee) throw new Error(tr('you need an FRC coin older than the book height (tap Faucet earlier)'));
    const at = a.give.assetTag ?? null, bt = b.give.assetTag ?? null;
    const sA = apv - BigInt(b.want.value);   // surplus of asset A gives -> me
    const sB = bpv - BigInt(a.want.value);
    const vout = [
      { value: BigInt(a.want.value), scriptPubKey: a.makerSpk, assetTag: a.want.assetTag ?? HOST_TAG },
      { value: BigInt(b.want.value), scriptPubKey: b.makerSpk, assetTag: b.want.assetTag ?? HOST_TAG },
    ];
    let hostIn = assetPresentValue(BigInt(myFee.value), L - myFee.refheight, { k: 20, interest: false });
    for (const [tag, s] of [[at, sA], [bt, sB]]) {
      if (tag === null) { hostIn += s; continue; }
      if (s > 0n) vout.push({ value: s, scriptPubKey: spks[0], assetTag: tag });   // spread -> me
    }
    const change = hostIn - fee;
    if (change > 0n) vout.push({ value: change, scriptPubKey: spks[0], assetTag: HOST_TAG });
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: [
        { prevout: { txid: rev(a.giveOutpoint.split(':')[0]), vout: +a.giveOutpoint.split(':')[1] }, scriptSig: '', sequence: a.sequence, witness: a.witness },
        { prevout: { txid: rev(b.giveOutpoint.split(':')[0]), vout: +b.giveOutpoint.split(':')[1] }, scriptSig: '', sequence: b.sequence, witness: b.witness },
        { prevout: { txid: rev(myFee.outpoint.split(':')[0]), vout: +myFee.outpoint.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] },
      ],
      vout,
    };
    signInput(tx, 2, myFee.spk, myFee.value, myFee.refheight, SIGHASH_ALL);   // I sign only MY input
    await api('tx', { rawtx: serializeTx(tx), kind: 'match' });
    toast(`${tr('Matched')} #${a.id}×#${b.id}`, 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function postOffer() {
  try {
    const giveOp = $('#oGive').value;
    const u = state.mine.utxos.find(x => x.outpoint === giveOp);
    if (!u) throw new Error(tr('coin not found'));
    const wantTag = $('#oWant').value === 'FRC' ? null : $('#oWant').value;
    if ((u.assetTag ?? null) === wantTag) throw new Error(tr('an offer must trade one asset for another'));
    const wantValue = wantTag === null ? BigInt(Math.round(parseFloat($('#oAmt').value) * 1e8)) : BigInt($('#oAmt').value);
    const L = state.mine.height;
    const skel = {
      version: NV3_TX_VERSION, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(giveOp.split(':')[0]), vout: +giveOp.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] }],
      vout: [{ value: wantValue, scriptPubKey: u.spk, assetTag: wantTag ?? HOST_TAG }],
    };
    signInput(skel, 0, u.spk, u.value, u.refheight, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY);
    await api('offer', { giveOutpoint: giveOp, makerSpk: u.spk, want: { assetTag: wantTag, value: wantValue }, lockHeight: L, sequence: 0xffffffff, witness: skel.vin[0].witness });
    toast(tr('Offer signed and posted'), 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- DEX phase 2b: RANGED offers (partial fills). The maker signs a DESCRIPTOR (a price ratio
// + fill bounds) over one give coin, NOT amounts; a taker fills any amount in range and the
// remainder returns as change, which the maker re-signs to keep trading. Any direction: give and
// want are any two DIFFERENT assets (FRC↔asset, asset↔asset). Amounts in whole units (1e8 kria).
const UNIT = 100000000n;   // 1 asset/FRC unit = 1e8 kria (both have 8 decimals here)
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

// my spendable coins of one asset (null tag = FRC), present-valued at height L
function myCoinsOf(tag, L) {
  const norm = tag === HOST_TAG ? null : tag;
  return state.mine.utxos.filter(u => (u.assetTag ?? null) === norm && u.refheight <= L)
    .map(u => ({ outpoint: u.outpoint, spk: u.spk, value: BigInt(u.value), refheight: u.refheight,
                 pv: assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(norm)) }));
}

// Produce a single coin worth exactly Q of `giveTag` at height L to back an offer, so the sale is
// capped at Q and the rest stays the maker's (a separate coin, never in the offer). If one coin
// already IS the whole sale, use it; otherwise self-send the needed coins into [Q, rest, feeChange]
// and return the fresh Q-coin. Afterwards the tested single-input offer path is reused unchanged.
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
    const feeCoin = state.mine.utxos.find(x => (x.assetTag ?? null) === null && x.refheight <= L && assetPresentValue(BigInt(x.value), L - x.refheight, { k: 20, interest: false }) >= fee + 1000n);
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
    const P = parseFloat($('#rPrice').value);
    if (!(P > 0)) throw new Error(tr('enter a price'));
    const L = state.mine.height;
    const coins = myCoinsOf(giveTag, L);
    const total = coins.reduce((a, c) => a + c.pv, 0n);
    if (total <= 0n) throw new Error(tr('no coins of that asset'));
    let Q = BigInt(Math.round(parseFloat($('#rQty').value) * 1e8));
    if (!(Q > 0n)) throw new Error(tr('enter a quantity'));
    if (Q > total) Q = total;                                             // cap at the whole balance
    const give = await prepareGiveCoin(giveTag, Q, L, coins);
    const priceNum = BigInt(Math.round(P * 1e8)), priceDen = UNIT;
    const desc = { payoutAsset: wantTag, payoutScript: give.spk, priceNum, priceDen, changeScript: give.spk, minFill: 0n, maxFill: Q };
    const witness = signRangedGive(desc, give.outpoint, give, give.L);
    await api('rangedOffer', { makerSpk: give.spk, giveOutpoint: give.outpoint, desc, nExpireTime: 0, lockHeight: give.L, witness });
    toast(tr('Offer signed and posted'), 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
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
    let fill = BigInt(Math.round(fillUnits * 1e8));
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
    const { got: payCoins, sum: payPv } = gather(payTagNorm, payRate, need, new Set());
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
      const { got: feeCoins, sum: feePv } = gather(null, { k: 20, interest: false }, fee, new Set(payCoins.map(c => c.outpoint)));
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
    toast(`${tr('Bought')} ${(Number(fill) / 1e8).toLocaleString(getLang())} ${assetName(offer.give.assetTag)}`, 'ok'); refresh();
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
function render() {
  const on = t => curTab === t ? '' : ' hidden';
  const act = t => curTab === t ? ' class="active"' : '';
  $('#app').innerHTML = `
  <header><h1>Freimarkets</h1>
    <div class="hbtns"><button id="statusBtn" class="icon statusbtn st-sync" title="${tr('syncing…')}">●</button></div></header>
  <div id="statusPop" hidden></div>
  <nav>
    <button data-tab="bal"${act('bal')}>${tr('Balance')}</button>
    <button data-tab="issue"${act('issue')}>${tr('Issue')}</button>
    <button data-tab="dex"${act('dex')}>${tr('Exchange')}</button>
    <button data-tab="set"${act('set')}>⚙</button>
  </nav>
  <main>
    <section id="tab-bal"${on('bal')}>
      <p class="label">${tr('Your receiving address')}</p>
      <div class="addr">${myAddress}</div>
      <table class="mkt"><thead><tr><th>${tr('Asset')}</th><th>${tr('Present value')}</th></tr></thead><tbody id="balBody"><tr><td colspan="2" class="sub">${tr('first sync…')}</td></tr></tbody></table>
      <div class="row"><button id="faucetBtn" class="ghost">${tr('Faucet (+1 FRC)')}</button></div>
    </section>

    <section id="tab-issue"${on('issue')}>
      <p class="sub">${tr('Issue an asset that lives on the chain with its own demurrage (melts) or interest (grows) rate.')}</p>
      <label>${tr('Name')}<input id="iName" maxlength="24" placeholder="часы-труда"></label>
      <div class="row">
        <label>${tr('Rate k')}<input id="iShift" type="number" value="16" min="1" max="64"></label>
        <label>${tr('Type')}<select id="iKind"><option value="d">${tr('melts')}</option><option value="i">${tr('grows')}</option></select></label>
      </div>
      <label>${tr('Quantity')}<input id="iAmt" type="number" value="1000000"></label>
      <div class="row"><button id="issueBtn">${tr('Issue')}</button></div>
    </section>

    <section id="tab-dex"${on('dex')}>
      <p class="label">${tr('Post an offer')}</p>
      <div class="row"><label>${tr('I sell')}<select id="rAsset"></select></label><label>${tr('Quantity')}<input id="rQty" type="text" inputmode="decimal"></label></div>
      <div class="row"><label>${tr('I want')}<select id="rWant"></select></label><label>${tr('Price (want per unit)')}<input id="rPrice" type="text" inputmode="decimal"></label></div>
      <div class="row"><button id="rOfferBtn">${tr('Post offer')}</button></div>
      <p class="sub" style="font-size:12px">${tr('Buyers fill any amount; the remainder keeps trading while you are online.')}</p>

      <p class="label" style="margin-top:14px">${tr('Order book')}</p>
      <table class="mkt"><thead><tr><th>#</th><th>${tr('Give')}</th><th>${tr('Want')}</th><th></th></tr></thead><tbody id="bookBody"><tr><td colspan="4" class="sub">${tr('first sync…')}</td></tr></tbody></table>
    </section>


    <section id="tab-set"${on('set')}>
      <label>${tr('Language')}<select id="langSel">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${getLang() === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>${tr('Theme')}<select id="themeSel">
        <option value="system"${themeMode() === 'system' ? ' selected' : ''}>${tr('System')}</option>
        <option value="dark"${themeMode() === 'dark' ? ' selected' : ''}>${tr('Dark')}</option>
        <option value="light"${themeMode() === 'light' ? ' selected' : ''}>${tr('Light')}</option></select></label>
      <p class="label" style="margin-top:14px">${tr('Account')}</p>
      <label>${tr('Secret phrase')}<textarea id="setPhrase" rows="2" readonly style="filter:blur(4px)">${localStorage.getItem('fw_seed') || ''}</textarea></label>
      <div class="row"><button id="setReveal" class="ghost">${tr('Show')}</button><button id="setCopy" class="ghost">${tr('Copy')}</button></div>
      <p class="sub" style="font-size:12px">${tr('Stored only in this browser.')}</p>
      <div class="row" style="margin-top:10px"><button id="setLogout">${tr('Log out of account')}</button></div>
    </section>
  </main>`;
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#statusBtn').onclick = () => { const pop = $('#statusPop'); pop.hidden = !pop.hidden; if (!pop.hidden) renderStatusPop(); };
  $('#faucetBtn').onclick = faucet;
  $('#issueBtn').onclick = issue;
  $('#rOfferBtn').onclick = postRangedOffer;
  $('#langSel').onchange = () => { setLang($('#langSel').value); render(); };
  $('#themeSel').onchange = () => { const t = $('#themeSel').value; localStorage.setItem('fw_theme_mode', t); applyTheme(t); };
  $('#setReveal').onclick = () => { $('#setPhrase').style.filter = 'none'; };
  $('#setCopy').onclick = async () => { try { await navigator.clipboard.writeText(localStorage.getItem('fw_seed') || ''); toast(tr('Phrase copied'), 'ok'); } catch { $('#setPhrase').style.filter = 'none'; } };
  $('#setLogout').onclick = () => {
    if (!confirm(tr('Log out of account? Without the saved phrase it cannot be recovered.'))) return;
    localStorage.removeItem('fw_seed'); localStorage.removeItem('fw_vault'); location.reload();
  };
  paint();
}

// fill a <select> preserving the current selection (so a refresh doesn't reset it)
function setOptions(sel, html) {
  const el = $(sel); if (!el) return;
  const cur = el.value; el.innerHTML = html;
  if ([...el.options].some(o => o.value === cur)) el.value = cur;
}
function paint() {
  if (!state || !$('#balBody')) return;
  const h = state.mine.height;
  const pvU = u => assetPresentValue(BigInt(u.value), h - u.refheight, rateOf(u.assetTag));
  const byAsset = new Map();
  for (const u of state.mine.utxos) {
    const k = u.assetTag ?? 'FRC';
    const e = byAsset.get(k) ?? { nominal: 0n, pv: 0n };
    e.nominal += BigInt(u.value); e.pv += pvU(u);
    byAsset.set(k, e);
  }
  const amt = (tag, v) => tag === 'FRC' ? frc(v) : String(v);   // number only — the Asset column names it
  $('#balBody').innerHTML = [...byAsset.entries()].map(([tag, e]) => {
    const melt = e.pv < e.nominal, grow = e.pv > e.nominal;
    return `<tr><td>${assetName(tag === 'FRC' ? null : tag)}</td>
      <td class="${melt ? 'melt' : grow ? 'grow' : ''}">${amt(tag, e.pv)}</td></tr>`;
  }).join('') || `<tr><td colspan="2" class="sub">${tr('empty — tap Faucet')}</td></tr>`;

  // "I sell": the assets I actually hold, with my balance (present value, in units)
  setOptions('#rAsset', [...byAsset.entries()].map(([k, e]) =>
    `<option value="${k}">${assetName(k === 'FRC' ? null : k)} (${(Number(e.pv) / 1e8).toLocaleString(getLang())})</option>`).join('')
    || `<option value="">${tr('no coins yet')}</option>`);
  setOptions('#rWant', ['FRC', ...state.info.assets.map(a => a.tag)]
    .map(t => `<option value="${t}">${t === 'FRC' ? 'FRC' : assetName(t)}</option>`).join(''));

  // skip repainting the book while a fill amount is being typed into it (else the 15s refresh
  // wipes the input) — same reason the offer selects are preserved.
  if (!$('#bookBody').contains(document.activeElement)) {
    const bookRow = o => {
      const mine = spks.includes(o.makerSpk);
      const give = o.give ? fmtA(o.give.assetTag ?? 'FRC', BigInt(o.give.pv)) : '—';
      if (o.ranged) {
        const price = Number(BigInt(o.desc.priceNum)) / Number(BigInt(o.desc.priceDen));
        const wantTag = (o.desc.payoutAsset && o.desc.payoutAsset !== HOST_TAG) ? o.desc.payoutAsset : null;
        const maxU = o.give ? Number(BigInt(o.give.pv)) / 1e8 : 0;
        const act = mine ? `${tr('mine')} ${o.status}`
          : (o.status === 'open' && o.give && !o.needsResign)
            ? `<input class="rfill" data-id="${o.id}" type="text" inputmode="decimal" style="width:64px" placeholder="${maxU}"><button class="rbtn" data-id="${o.id}">${tr('Buy')}</button>`
            : o.status;
        return `<tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td><td>${give}</td>
          <td>@ ${price.toLocaleString(getLang(), { maximumFractionDigits: 8 })} ${assetName(wantTag)}</td><td>${act}</td></tr>`;
      }
      return `<tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td><td>${give}</td>
        <td>${fmtA(o.want.assetTag ?? 'FRC', BigInt(o.want.value))}</td><td>${mine ? tr('mine') : ''} ${o.status}</td></tr>`;
    };
    $('#bookBody').innerHTML = state.info.book.slice().reverse().map(bookRow).join('')
      || `<tr><td colspan="4" class="sub">${tr('no offers yet')}</td></tr>`;
    $('#bookBody').querySelectorAll('.rbtn').forEach(b => b.onclick = () => {
      const id = +b.dataset.id, offer = state.info.book.find(o => o.id === id);
      const inp = $(`.rfill[data-id="${id}"]`), amt = parseFloat(inp?.value || inp?.placeholder || '0');
      if (offer && amt > 0) fillRangedNow(offer, amt);
    });
  }
}
function showTab(t) {
  curTab = t;
  ['bal', 'issue', 'dex', 'set'].forEach(x => { const s = $(`#tab-${x}`); if (s) s.hidden = x !== t; });
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
}

// ---- key gate. Same origin as the wallet (wallet.testtty.ru/market.html) ⇒ shared vault,
// one unlock. Standalone origin (market.testtty.ru) ⇒ its own key: this is an EXPERIMENTAL
// chain, coins have no value, so we let the page create/restore a throwaway seed here. ----
function start() { deriveKeys(); render(); refresh(); setInterval(refresh, 15000); }
function boot() {
  applyTheme(themeMode());
  configureNetwork('regtest');
  const vault = localStorage.getItem('fw_vault');
  const plain = localStorage.getItem('fw_seed');
  if (plain) { seed = resolveSecret(plain); return start(); }
  if (vault) {
    $('#app').innerHTML = `<div class="lock"><div class="lockcard">
      <div class="lockicon">🔒</div><h2>Freimarkets</h2>
      <input id="pw" type="password" placeholder="${tr('Passphrase')}" autofocus>
      <button id="unlockBtn">${tr('Unlock')}</button><p id="lerr" class="err"></p>
      ${langSelect('lLang')}</div></div>`;
    $('#lLang').onchange = () => { setLang($('#lLang').value); boot(); };
    const go = () => { try { seed = resolveSecret(decryptSecret(JSON.parse(vault), $('#pw').value)); start(); } catch { $('#lerr').textContent = tr('wrong phrase'); } };
    $('#unlockBtn').onclick = go;
    $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return;
  }
  // no key on this origin — offer "log in with wallet" (primary) or a fresh/restored key.
  $('#app').innerHTML = `<div class="lock"><div class="lockcard">
    <div class="lockicon">${COIN_SVG}</div><h2>Freimarkets</h2>
    <p class="sub">${tr('A non-custodial exchange for user-issued Freicoin assets.')}</p>
    <button id="walletBtn">${tr('Log in with wallet')}</button>
    <p class="sub" style="font-size:12px">${tr('The wallet opens in a popup; after you unlock it, it hands the session here directly (bypassing the server).')}</p>
    <div id="wBody"></div>
    <button id="altBtn" class="ghost">${tr('…or set up a separate key here:')}</button>
    ${langSelect('wLang')}</div></div>`;
  $('#wLang').onchange = () => { setLang($('#wLang').value); boot(); };
  $('#walletBtn').onclick = loginViaWallet;
  $('#altBtn').onclick = () => {
    $('#altBtn').remove();
    $('#wBody').innerHTML = `<div class="row"><button id="genBtn" class="ghost">${tr('Create')}</button></div>
      <textarea id="restore" rows="2" placeholder="${tr('or log in with 12 words')}"></textarea>
      <button id="restoreBtn" class="ghost">${tr('Restore')}</button><p id="oerr" class="err"></p>`;
    $('#genBtn').onclick = () => { const m = generateMnemonic(); localStorage.setItem('fw_seed', m); seed = resolveSecret(m); start(); toast(tr('Key created — save the phrase in Settings'), 'ok'); };
    $('#restoreBtn').onclick = () => {
      const m = $('#restore').value.trim();
      if (!isMnemonic(m)) { $('#oerr').textContent = tr('invalid phrase'); return; }
      localStorage.setItem('fw_seed', m); seed = resolveSecret(m); start();
    };
  };
}

// "Log in with wallet": open the wallet as a popup in auth mode; it posts its session back to
// THIS origin (strict origin check) once unlocked. The secret never touches a server or a URL.
const WALLET_ORIGIN = 'https://wallet.testtty.ru';
function loginViaWallet() {
  const w = window.open(WALLET_ORIGIN + '/#market-auth', 'fw-wallet-auth', 'width=460,height=680');
  if (!w) { toast(tr('Allow pop-ups'), 'err'); return; }
  const onMsg = e => {
    if (e.origin !== WALLET_ORIGIN || e.source !== w) return;
    if (e.data && e.data.type === 'fw-session' && typeof e.data.secret === 'string') {
      window.removeEventListener('message', onMsg);
      localStorage.setItem('fw_seed', e.data.secret);
      seed = resolveSecret(e.data.secret);
      try { w.close(); } catch {}
      toast(tr('Signed in via wallet'), 'ok');
      start();
    }
  };
  window.addEventListener('message', onMsg);
  setTimeout(() => window.removeEventListener('message', onMsg), 180000);
}

const style = document.createElement('style');
style.textContent = `
  #app{max-width:640px;margin:0 auto}
  section[hidden]{display:none}
  table.mkt{width:100%;border-collapse:collapse;font-size:13px}
  table.mkt th{text-align:left;color:var(--sub);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--line)}
  table.mkt td{padding:5px 8px;border-bottom:1px solid var(--line);font-family:ui-monospace,monospace}
  .melt{color:var(--warn)} .grow{color:var(--ok)} .filled{opacity:.45}
  h1 .sub{font-size:13px;font-weight:400}
  #tab-set textarea{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;color:var(--fg);font:14px ui-monospace,monospace;width:100%}
`;
document.head.appendChild(style);
boot();
