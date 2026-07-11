// market.mjs — Freimarkets МАРКЕТ: пользовательский интерфейс экспериментальной цепи
// (пользовательские активы с демерреджем/процентом + книга офферов), НЕкастодиальный:
// та же кошельковая сессия (общий vault в localStorage этого origin), ключи и подписи —
// только в браузере. Сервер (:5181) — цепь, кран, индекс и авто-матчер; украсть не может.
import './style.css';
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;

import { decryptSecret } from './vault.mjs';
import { configureNetwork, resolveSecret, deriveAddress, isValidAddress, generateMnemonic, isMnemonic } from './wallet.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '../../../core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '../../../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY } from '../../../core/sighash.mjs';
import { serializeTx, NV3_TX_VERSION } from '../../../core/tx.mjs';
import { assetPresentValue } from '../../../core/assets.mjs';
import { decodeWitness } from '../../../core/address.mjs';
import { Neutrino } from './net/client.mjs';

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

let seed = null, km = {}, spks = [], myAddress = '', state = null;

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
const addrToSpk = a => { const { version, programHex } = decodeWitness(a.trim()); return version.toString(16).padStart(2, '0') + (programHex.length / 2).toString(16).padStart(2, '0') + programHex; };

// ---- data ----
// asset RATES come from the light client's self-certified defs (tag = Hash160(def)); the
// relay's names are cosmetic (a lie only mislabels, it can't misprice).
const assetName = tag => tag === null || tag === HOST_TAG ? 'FRC' : (state?.info.assets.find(a => a.tag === tag)?.name ?? tag.slice(0, 8) + '…');
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
  inflight = doRefresh().catch(e => toast('синхронизация: ' + e.message, 'err')).finally(() => { inflight = null; });
  return inflight;
}
async function doRefresh() {
  await ensureLc();
  const [info, r] = await Promise.all([api('info'), lc.syncWallet(spks)]);
  const utxos = r.utxos.map(u => ({
    outpoint: `${u.txid}:${u.vout}`, spk: u.script, assetTag: norm(u.assetTag),
    value: String(u.value), refheight: u.refheight,
  }));
  state = { info, defs: r.assetDefs, mine: { height: r.tipHeight, utxos } };
  render();
}

// ---- actions ----
async function faucet() { try { await api('faucet', { address: myAddress }); toast('Кран: +1 FRC', 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); } }

async function issue() {
  try {
    const name = $('#iName').value.trim() || 'актив';
    await api('issue', { name, shift: $('#iShift').value, interest: $('#iKind').value === 'i', amount: $('#iAmt').value, spk: spks[0] });
    toast(`«${name}» выпущен на ваш адрес`, 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function send() {
  try {
    const tag = $('#sAsset').value === 'FRC' ? null : $('#sAsset').value;
    const addr = $('#sAddr').value.trim();
    if (!isValidAddress(addr)) throw new Error('неверный адрес (нужен fcrt1…)');
    const toSpk = addrToSpk(addr);
    const amount = tag === null ? BigInt(Math.round(parseFloat($('#sAmt').value) * 1e8)) : BigInt($('#sAmt').value);
    const L = state.mine.height;
    const fee = 10000n;
    const pv = u => assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(u.assetTag));
    const pick = (want, sum, coins) => { const sel = []; let s = 0n; for (const u of coins) { sel.push(u); s += pv(u); if (s >= sum) break; } if (s < sum) throw new Error('недостаточно средств'); return [sel, s]; };
    const myCoins = state.mine.utxos;
    const vin = [], vout = [];
    if (tag === null) {
      const [sel, s] = pick(null, amount + fee, myCoins.filter(u => u.assetTag === null));
      sel.forEach(u => vin.push(u));
      vout.push({ value: amount, scriptPubKey: toSpk, assetTag: HOST_TAG });
      if (s - amount - fee > 0n) vout.push({ value: s - amount - fee, scriptPubKey: spks[12], assetTag: HOST_TAG });
    } else {
      const [selA, sA] = pick(null, amount, myCoins.filter(u => u.assetTag === tag));
      const [selF, sF] = pick(null, fee, myCoins.filter(u => u.assetTag === null));
      [...selA, ...selF].forEach(u => vin.push(u));
      vout.push({ value: amount, scriptPubKey: toSpk, assetTag: tag });
      if (sA - amount > 0n) vout.push({ value: sA - amount, scriptPubKey: spks[12], assetTag: tag });   // точная консервация
      if (sF - fee > 0n) vout.push({ value: sF - fee, scriptPubKey: spks[12], assetTag: HOST_TAG });
    }
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: vin.map(u => ({ prevout: { txid: rev(u.outpoint.split(':')[0]), vout: +u.outpoint.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] })),
      vout,
    };
    vin.forEach((u, i) => signInput(tx, i, u.spk, u.value, u.refheight, SIGHASH_ALL));
    await api('tx', { rawtx: serializeTx(tx) });
    toast('Отправлено и замайнено', 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- permissionless matching: I splice two crossing offers with MY fee coin, keep the
// spread, broadcast. No privileged matcher — any participant can do exactly this. ----
function findMatch() {
  const open = state.info.book.filter(o => o.status === 'open' && o.give);
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
    if (!m) { toast('нет пересекающихся офферов для сведения', ''); return; }
    const { a, b, apv, bpv } = m;
    const L = a.lockHeight, fee = 10000n;
    // my fee coin: host currency, older than the offers' lock height (monotonic lock_height)
    const myFee = state.mine.utxos.find(u => u.assetTag === null && u.refheight <= L && assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) > fee + 1000n);
    if (!myFee) throw new Error('нужна ваша FRC-монета старше высоты книги (нажмите Кран пораньше)');
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
    toast(`Свёл офферы #${a.id}×#${b.id}, спред ваш`, 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function postOffer() {
  try {
    const giveOp = $('#oGive').value;
    const u = state.mine.utxos.find(x => x.outpoint === giveOp);
    if (!u) throw new Error('монета не найдена');
    const wantTag = $('#oWant').value === 'FRC' ? null : $('#oWant').value;
    if ((u.assetTag ?? null) === wantTag) throw new Error('оффер должен менять один актив на другой');
    const wantValue = wantTag === null ? BigInt(Math.round(parseFloat($('#oAmt').value) * 1e8)) : BigInt($('#oAmt').value);
    const L = state.mine.height;
    const skel = {
      version: NV3_TX_VERSION, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(giveOp.split(':')[0]), vout: +giveOp.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] }],
      vout: [{ value: wantValue, scriptPubKey: u.spk, assetTag: wantTag ?? HOST_TAG }],
    };
    signInput(skel, 0, u.spk, u.value, u.refheight, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY);
    await api('offer', { giveOutpoint: giveOp, makerSpk: u.spk, want: { assetTag: wantTag, value: wantValue }, lockHeight: L, sequence: 0xffffffff, witness: skel.vin[0].witness });
    toast('Оффер подписан и выставлен', 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- UI ----
function render() {
  if (!state) return;
  const h = state.mine.height;
  const pvU = u => assetPresentValue(BigInt(u.value), h - u.refheight, rateOf(u.assetTag));
  const byAsset = new Map();
  for (const u of state.mine.utxos) {
    const k = u.assetTag ?? 'FRC';
    const e = byAsset.get(k) ?? { nominal: 0n, pv: 0n };
    e.nominal += BigInt(u.value); e.pv += pvU(u);
    byAsset.set(k, e);
  }
  const fmt = (tag, v) => tag === 'FRC' ? frc(v) + ' FRC' : String(v) + ' ' + assetName(tag);
  const balRows = [...byAsset.entries()].map(([tag, e]) => {
    const melt = e.pv < e.nominal, grow = e.pv > e.nominal;
    return `<tr><td>${assetName(tag === 'FRC' ? null : tag)}</td><td>${fmt(tag, e.nominal)}</td>
      <td class="${melt ? 'melt' : grow ? 'grow' : ''}">${fmt(tag, e.pv)}</td></tr>`;
  }).join('') || `<tr><td colspan="3" class="sub">пусто — нажмите «Кран»</td></tr>`;

  const myAssetOpts = ['FRC', ...new Set(state.mine.utxos.filter(u => u.assetTag).map(u => u.assetTag))]
    .map(t => `<option value="${t}">${t === 'FRC' ? 'FRC' : assetName(t)}</option>`).join('');
  const allAssetOpts = ['FRC', ...state.info.assets.map(a => a.tag)]
    .map(t => `<option value="${t}">${t === 'FRC' ? 'FRC' : assetName(t)}</option>`).join('');
  const giveOpts = state.mine.utxos.map(u =>
    `<option value="${u.outpoint}">${fmt(u.assetTag ?? 'FRC', pvU(u))} (${u.outpoint.slice(0, 8)}…)</option>`).join('');

  const bookRows = state.info.book.slice().reverse().map(o => `
    <tr class="${o.status !== 'open' ? 'filled' : ''}"><td>${o.id}</td>
      <td>${o.give ? fmt(o.give.assetTag ?? 'FRC', BigInt(o.give.pv)) : '—'}</td>
      <td>${fmt(o.want.assetTag ?? 'FRC', BigInt(o.want.value))}</td>
      <td>${o.makerSpk === spks[0] || spks.includes(o.makerSpk) ? 'мой' : ''} ${o.status}</td></tr>`).join('')
    || `<tr><td colspan="4" class="sub">офферов пока нет</td></tr>`;

  $('#app').innerHTML = `
  <header><h1>Freimarkets <span class="sub">маркет · эксперимент</span></h1>
    <span class="pill">блок <b>${h}</b></span></header>
  <main><section>
    <p class="sub">Экспериментальная цепь: активы с демерреджем/процентом и p2p-биржа. Ключи — только в этом браузере
      (та же фраза, что в кошельке). Монеты цепи ценности не имеют. <a href="/">← кошелёк</a></p>

    <h2 style="font-size:15px;margin:8px 0 0">Балансы</h2>
    <div class="addr">${myAddress}</div>
    <table class="mkt"><thead><tr><th>Актив</th><th>Номинал</th><th>Сейчас стоит</th></tr></thead><tbody>${balRows}</tbody></table>
    <div class="row"><button id="faucetBtn" class="ghost">Кран (+1 FRC)</button><button id="refreshBtn" class="ghost">Обновить</button></div>

    <h2 style="font-size:15px;margin:14px 0 0">Выпустить актив</h2>
    <div class="row">
      <label>Название<input id="iName" maxlength="24" placeholder="часы-труда"></label>
      <label>Ставка k<input id="iShift" type="number" value="16" min="1" max="64"></label>
    </div>
    <div class="row">
      <label>Тип<select id="iKind"><option value="d">плавится</option><option value="i">растёт</option></select></label>
      <label>Количество<input id="iAmt" type="number" value="1000000"></label>
      <button id="issueBtn">Выпустить</button>
    </div>

    <h2 style="font-size:15px;margin:14px 0 0">Отправить</h2>
    <div class="row">
      <label>Актив<select id="sAsset">${myAssetOpts}</select></label>
      <label>Кому (fcrt1…)<input id="sAddr" placeholder="fcrt1…"></label>
    </div>
    <div class="row"><label>Сколько<input id="sAmt" type="text" inputmode="decimal"></label><button id="sendBtn">Отправить</button></div>

    <h2 style="font-size:15px;margin:14px 0 0">Биржа</h2>
    <div class="row">
      <label>Отдаю монету<select id="oGive">${giveOpts}</select></label>
      <label>Хочу<select id="oWant">${allAssetOpts}</select></label>
    </div>
    <div class="row"><label>Сколько хочу<input id="oAmt" type="text" inputmode="decimal"></label><button id="offerBtn">Выставить оффер</button></div>
    ${findMatch() ? `<div class="row"><button id="matchBtn">⚡ Свести встречные офферы и забрать спред</button></div>
      <p class="sub">Сведение делает любой участник своей монетой на комиссию — привилегированного матчера нет.</p>` : ''}
    <table class="mkt"><thead><tr><th>#</th><th>Отдают</th><th>Хотят</th><th></th></tr></thead><tbody>${bookRows}</tbody></table>

    <h2 style="font-size:15px;margin:14px 0 0">События</h2>
    <div id="mlog">${state.info.events.map(e => `<div>${new Date(e.t).toLocaleTimeString('ru-RU')} — ${e.m}</div>`).join('')}</div>
  </section></main>`;
  $('#faucetBtn').onclick = faucet;
  $('#refreshBtn').onclick = refresh;
  $('#issueBtn').onclick = issue;
  $('#sendBtn').onclick = send;
  $('#offerBtn').onclick = postOffer;
  if ($('#matchBtn')) $('#matchBtn').onclick = matchNow;
}

// ---- key gate. Same origin as the wallet (wallet.testtty.ru/market.html) ⇒ shared vault,
// one unlock. Standalone origin (market.testtty.ru) ⇒ its own key: this is an EXPERIMENTAL
// chain, coins have no value, so we let the page create/restore a throwaway seed here. ----
function start() { deriveKeys(); refresh(); setInterval(refresh, 15000); }
function boot() {
  configureNetwork('regtest');
  const vault = localStorage.getItem('fw_vault');
  const plain = localStorage.getItem('fw_seed');
  if (plain) { seed = resolveSecret(plain); return start(); }
  if (vault) {
    $('#app').innerHTML = `<header><h1>Freimarkets</h1></header><main><section>
      <p class="sub">Введите парольную фразу кошелька этого домена.</p>
      <label>Парольная фраза<input id="pw" type="password"></label>
      <button id="unlockBtn">Разблокировать</button><p id="lerr" class="err"></p></section></main>`;
    $('#unlockBtn').onclick = () => {
      try { seed = resolveSecret(decryptSecret(JSON.parse(vault), $('#pw').value)); start(); }
      catch { $('#lerr').textContent = 'неверная фраза'; }
    };
    return;
  }
  // no key on this origin — onboard (create/restore). Experimental chain: seed stored plainly.
  $('#app').innerHTML = `<header><h1>Freimarkets <span class="sub">маркет · эксперимент</span></h1></header><main><section>
    <p class="sub">Экспериментальная биржа с пользовательскими активами. Ключ хранится только в этом браузере;
      монеты цепи ценности не имеют. Создайте ключ или восстановите фразой.</p>
    <button id="genBtn">Создать ключ</button>
    <p class="label" style="margin-top:14px">…или восстановить существующей фразой:</p>
    <textarea id="restore" rows="2" placeholder="12 слов"></textarea>
    <button id="restoreBtn" class="ghost">Восстановить</button>
    <p id="oerr" class="err"></p></section></main>`;
  $('#genBtn').onclick = () => {
    const m = generateMnemonic();
    if (!confirm('Ваша фраза (сохраните её):\n\n' + m + '\n\nПродолжить?')) return;
    localStorage.setItem('fw_seed', m); seed = resolveSecret(m); start();
  };
  $('#restoreBtn').onclick = () => {
    const m = $('#restore').value.trim();
    if (!isMnemonic(m)) { $('#oerr').textContent = 'неверная фраза'; return; }
    localStorage.setItem('fw_seed', m); seed = resolveSecret(m); start();
  };
}

const style = document.createElement('style');
style.textContent = `
  #app{max-width:640px} main{overflow-y:auto}
  table.mkt{width:100%;border-collapse:collapse;font-size:13px}
  table.mkt th{text-align:left;color:var(--sub);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--line)}
  table.mkt td{padding:5px 8px;border-bottom:1px solid var(--line);font-family:ui-monospace,monospace}
  .melt{color:var(--warn)} .grow{color:var(--ok)} .filled{opacity:.45}
  #mlog div{font-size:12.5px;color:var(--sub);padding:2px 0;border-bottom:1px dashed var(--line)}
  h1 .sub{font-size:13px;font-weight:400}`;
document.head.appendChild(style);
boot();
