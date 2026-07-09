import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import * as api from './api.mjs';
import { deriveAddress, buildSignedTx, resolveSecret, generateMnemonic, isMnemonic } from './wallet.mjs';

const $ = s => document.querySelector(s);
const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
const secret = () => store.get('fw_seed') || '000102030405060708090a0b0c0d0e0f';
const hexSeed = () => resolveSecret(secret());
const short = a => a && a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-8) : (a || '');
const fmt = n => (+n).toLocaleString(undefined, { maximumFractionDigits: 8 });
const copy = (t, el) => { navigator.clipboard?.writeText(t); if (el) { const o = el.textContent; el.textContent = 'copied ✓'; setTimeout(() => el.textContent = o, 1200); } };
const skel = (n = 1) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
let recvIndex = +(store.get('fw_recv') || 0), pending = null, pollTimer = null, toastTimer = null;

$('#app').innerHTML = `
  <header><h1>Freicoin Wallet</h1>
    <div class="hbtns"><button id="themeBtn" class="icon"></button><span id="net" class="pill">…</span></div></header>
  <nav>
    <button data-tab="balance" class="active">Balance</button>
    <button data-tab="receive">Receive</button>
    <button data-tab="send">Send</button>
    <button data-tab="activity">Activity</button>
    <button data-tab="settings">⚙</button>
  </nav>
  <main>
    <section id="balance"></section><section id="receive" hidden></section>
    <section id="send" hidden></section><section id="activity" hidden></section>
    <section id="settings" hidden></section>
  </main>
  <div id="toast"></div>`;

const applyTheme = t => { document.documentElement.dataset.theme = t; $('#themeBtn').textContent = t === 'dark' ? '☀' : '🌙'; };
applyTheme(store.get('fw_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('fw_theme', t); applyTheme(t); };

const toast = (t, type = 'ok') => {
  const el = $('#toast'); clearTimeout(toastTimer);
  if (!t) { el.className = ''; el.textContent = ''; return; }   // empty -> fully hidden (no oval)
  el.textContent = t; el.className = 'show ' + type;
  toastTimer = setTimeout(() => el.className = '', 2800);
};

const show = tab => {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['balance', 'receive', 'send', 'activity', 'settings'].forEach(s => $('#' + s).hidden = s !== tab);
  clearInterval(pollTimer); pollTimer = null; toast(''); render[tab]?.();
};
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));

let cache = null;
const getState = async force => (!force && cache) ? cache : (cache = await api.utxos());
const timeAgo = t => { const s = Math.max(0, Date.now() / 1000 - t); if (s < 60) return 'just now'; if (s < 3600) return (s / 60 | 0) + 'm ago'; if (s < 86400) return (s / 3600 | 0) + 'h ago'; return new Date(t * 1000).toLocaleDateString(); };
const CAT = { send: '↑', receive: '↓', generate: '⛏', immature: '⛏' };

const render = {
  async balance() {
    if (!$('#balance').innerHTML) $('#balance').innerHTML = `<div class="big skel-line"></div>${skel(1)}`;
    const paint = s => { $('#balance').innerHTML =
      `<div class="big">${fmt(s.balance)} <small>FRC</small></div>
       <div class="sub">present value · tip ${s.tipHeight} · ${s.utxos.length} UTXO</div>
       <button id="refresh" class="ghost">↻ Refresh</button>`;
      $('#refresh').onclick = render.balance; };
    try { paint(await getState(true)); }
    catch (e) { $('#balance').innerHTML = `<div class="err">backend unreachable — ${e.message}</div><button id="refresh" class="ghost">↻ Retry</button>`; $('#refresh').onclick = render.balance; return; }
    clearInterval(pollTimer); pollTimer = setInterval(async () => { try { paint(await getState(true)); } catch {} }, 6000);
  },
  async receive() {
    let addr; try { addr = deriveAddress(hexSeed(), recvIndex, 0); } catch (e) { return toast(e.message, 'err'); }
    $('#receive').innerHTML =
      `<div class="label">Receive address #${recvIndex}</div>
       <img id="qr" class="qr" alt="qr"/>
       <div class="addr" id="addr">${addr}</div>
       <div class="row"><button id="copyAddr" class="ghost">Copy</button><button id="nextAddr" class="ghost">Next →</button></div>`;
    $('#qr').src = await QRCode.toDataURL(addr.toUpperCase(), { margin: 1, width: 220 });
    $('#copyAddr').onclick = e => copy(addr, e.target);
    $('#nextAddr').onclick = () => { recvIndex++; store.set('fw_recv', recvIndex); render.receive(); };
  },
  async send() {
    pending = null;
    $('#send').innerHTML =
      `<div class="sub" id="avail">available…</div>
       <label>To address<input id="to" placeholder="fcrt1…" autocomplete="off"></label>
       <label>Amount (FRC)<div class="amtrow"><input id="amt" type="number" step="0.00000001" min="0" placeholder="0.0"><button id="maxBtn" class="ghost">Max</button></div></label>
       <button id="reviewBtn">Review</button><div id="sendResult"></div>`;
    $('#reviewBtn').onclick = doReview;
    $('#amt').addEventListener('keydown', e => { if (e.key === 'Enter') doReview(); });
    try { const s = await getState(); $('#avail').textContent = `available ${fmt(s.balance)} FRC`;
      $('#maxBtn').onclick = () => { $('#amt').value = Math.max(0, s.balance - 0.001).toFixed(8); }; }
    catch { $('#avail').textContent = ''; }
  },
  async activity() {
    $('#activity').innerHTML = skel(4);
    try {
      const { txs } = await api.history();
      $('#activity').innerHTML = txs.length ? txs.map(t =>
        `<div class="act">
           <div class="act-i ${t.category}">${CAT[t.category] || '•'}</div>
           <div class="act-m"><b>${t.category}</b><span class="sub">${t.confirmations > 0 ? t.confirmations + ' conf' : 'pending'} · ${timeAgo(t.time)}</span></div>
           <div class="act-a ${(+t.amount) < 0 ? 'neg' : 'pos'}">${(+t.amount) > 0 ? '+' : ''}${fmt(t.amount)}</div>
         </div>`).join('') : '<div class="sub">no transactions yet</div>';
    } catch (e) { $('#activity').innerHTML = `<div class="err">${e.message}</div>`; }
  },
  settings() {
    const s = secret(), kind = /\s/.test(s.trim()) ? 'recovery phrase' : 'hex seed';
    $('#settings').innerHTML =
      `<label>Backend URL<input id="be" value="${store.get('fw_backend') || (import.meta.env?.VITE_BACKEND || 'http://127.0.0.1:3030')}"></label>
       <label>Wallet secret (${kind} — dev only)<textarea id="sd" rows="2">${s}</textarea></label>
       <div class="row"><button id="saveCfg">Save</button><button id="genBtn" class="ghost">Generate 12 words</button><button id="copySeed" class="ghost">Copy</button></div>
       <p class="warn">⚠ Stored in localStorage for this MVP — do not use real funds.</p>`;
    $('#saveCfg').onclick = () => { try { resolveSecret($('#sd').value); } catch (e) { return toast(e.message, 'err'); }
      store.set('fw_backend', $('#be').value.trim()); store.set('fw_seed', $('#sd').value.trim()); recvIndex = 0; store.set('fw_recv', 0); cache = null; toast('saved'); show('balance'); };
    $('#genBtn').onclick = () => { $('#sd').value = generateMnemonic(); toast('new phrase — back it up, then Save'); };
    $('#copySeed').onclick = e => copy($('#sd').value, e.target);
  },
};

async function doReview() {
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!/^(fcrt1|fc1|tf1)/.test(to)) return toast('enter a valid Freicoin address', 'err');
  if (!(amt > 0)) return toast('enter an amount', 'err');
  toast('building…'); $('#reviewBtn').disabled = true;
  try {
    const { utxos, tipHeight } = await getState();
    const r = buildSignedTx({ seed: hexSeed(), utxos, toAddress: to, amountFrc: amt, tipHeight });
    pending = r.rawtx;
    $('#sendResult').innerHTML =
      `<div class="review">
         <div class="rrow"><span>To</span><b>${short(to)}</b></div>
         <div class="rrow"><span>Amount</span><b>${fmt(amt)} FRC</b></div>
         <div class="rrow"><span>Fee</span><b>${r.fee} kria</b></div>
         <div class="rrow"><span>Inputs</span><b>${r.inputs}</b></div>
         <div class="row"><button id="confirmBtn">Confirm &amp; broadcast</button><button id="cancelBtn" class="ghost">Cancel</button></div>
       </div>`;
    $('#confirmBtn').onclick = doBroadcast;
    $('#cancelBtn').onclick = () => { pending = null; $('#sendResult').innerHTML = ''; toast(''); };
    toast('review the transaction');
  } catch (e) { toast('cannot build: ' + e.message, 'err'); }
  finally { $('#reviewBtn').disabled = false; }
}

async function doBroadcast() {
  if (!pending) return;
  const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = 'broadcasting…';
  try {
    const { txid } = await api.broadcast(pending);
    $('#sendResult').innerHTML = `<div class="ok">Sent ✓</div><div class="txid">${txid}</div>`;
    $('#to').value = ''; $('#amt').value = ''; pending = null; cache = null; toast('broadcast ✓');
  } catch (e) { toast('broadcast failed: ' + e.message, 'err'); btn.disabled = false; btn.textContent = 'Confirm & broadcast'; }
}

(async () => {
  try { $('#net').textContent = (await api.health()).network; } catch { $('#net').textContent = 'offline'; }
  show('balance');
})();
