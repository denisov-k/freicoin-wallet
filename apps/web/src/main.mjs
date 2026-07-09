import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import * as api from './api.mjs';
import { deriveAddress, buildSignedTx } from './wallet.mjs';

const $ = s => document.querySelector(s);
const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
const seed = () => store.get('fw_seed') || '000102030405060708090a0b0c0d0e0f';
const short = a => a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-8) : a;
const fmt = n => (+n).toLocaleString(undefined, { maximumFractionDigits: 8 });
const copy = (t, el) => { navigator.clipboard?.writeText(t); if (el) { const o = el.textContent; el.textContent = 'copied ✓'; setTimeout(() => el.textContent = o, 1200); } };
let recvIndex = +(store.get('fw_recv') || 0);
let pending = null, pollTimer = null;

// theme: stored override, else system
const applyTheme = t => { document.documentElement.dataset.theme = t; $('#themeBtn') && ($('#themeBtn').textContent = t === 'dark' ? '☀' : '🌙'); };
const theme = () => store.get('fw_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

$('#app').innerHTML = `
  <header><h1>Freicoin Wallet</h1>
    <div class="hbtns"><button id="themeBtn" class="icon"></button><span id="net" class="pill">…</span></div></header>
  <nav>
    <button data-tab="balance" class="active">Balance</button>
    <button data-tab="receive">Receive</button>
    <button data-tab="send">Send</button>
    <button data-tab="settings">⚙</button>
  </nav>
  <main>
    <section id="balance"></section><section id="receive" hidden></section>
    <section id="send" hidden></section><section id="settings" hidden></section>
  </main>
  <p id="msg"></p>`;
applyTheme(theme());
$('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('fw_theme', t); applyTheme(t); };

const show = tab => {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['balance', 'receive', 'send', 'settings'].forEach(s => $('#' + s).hidden = s !== tab);
  clearInterval(pollTimer); pollTimer = null; msg(''); render[tab]?.();
};
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
const msg = (t, err) => { const m = $('#msg'); m.textContent = t; m.className = err ? 'err' : 'ok'; };

let cache = null;
const getState = async (force) => (!force && cache) ? cache : (cache = await api.utxos());

const render = {
  async balance() {
    if (!$('#balance').innerHTML) $('#balance').innerHTML = '<div class="loading">loading…</div>';
    const paint = s => $('#balance').innerHTML =
      `<div class="big">${fmt(s.balance)} <small>FRC</small></div>
       <div class="sub">present value · tip ${s.tipHeight} · ${s.utxos.length} UTXO</div>
       <button id="refresh" class="ghost">↻ Refresh</button>`;
    try { const s = await getState(true); paint(s); $('#refresh').onclick = render.balance; }
    catch (e) { $('#balance').innerHTML = `<div class="err">backend unreachable — ${e.message}</div><button id="refresh" class="ghost">↻ Retry</button>`; $('#refresh').onclick = render.balance; return; }
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => { try { paint(await getState(true)); $('#refresh').onclick = render.balance; } catch {} }, 6000);
  },
  async receive() {
    const addr = deriveAddress(seed(), recvIndex, 0);
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
       <button id="reviewBtn">Review</button>
       <div id="sendResult"></div>`;
    $('#reviewBtn').onclick = doReview;
    try { const s = await getState(); $('#avail').textContent = `available ${fmt(s.balance)} FRC`;
      $('#maxBtn').onclick = () => { $('#amt').value = Math.max(0, s.balance - 0.001).toFixed(8); }; }
    catch { $('#avail').textContent = ''; }
  },
  settings() {
    $('#settings').innerHTML =
      `<label>Backend URL<input id="be" value="${store.get('fw_backend') || (import.meta.env?.VITE_BACKEND || 'http://127.0.0.1:3030')}"></label>
       <label>Seed (hex — dev only, insecure)<input id="sd" value="${seed()}"></label>
       <div class="row"><button id="saveCfg">Save</button><button id="copySeed" class="ghost">Copy seed</button></div>
       <p class="warn">⚠ Seed is kept in localStorage for this MVP. Do not use real funds.</p>`;
    $('#saveCfg').onclick = () => { store.set('fw_backend', $('#be').value.trim()); store.set('fw_seed', $('#sd').value.trim()); recvIndex = 0; store.set('fw_recv', 0); cache = null; msg('saved'); show('balance'); };
    $('#copySeed').onclick = e => copy(seed(), e.target);
  },
};

async function doReview() {
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!/^(fcrt1|fc1|tf1)/.test(to)) return msg('enter a valid Freicoin address', true);
  if (!(amt > 0)) return msg('enter an amount', true);
  msg('building…'); $('#reviewBtn').disabled = true;
  try {
    const { utxos, tipHeight } = await getState();
    const r = buildSignedTx({ seed: seed(), utxos, toAddress: to, amountFrc: amt, tipHeight });
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
    $('#cancelBtn').onclick = () => { pending = null; $('#sendResult').innerHTML = ''; msg(''); };
    msg('review the transaction');
  } catch (e) { msg('cannot build: ' + e.message, true); }
  finally { $('#reviewBtn').disabled = false; }
}

async function doBroadcast() {
  if (!pending) return;
  const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = 'broadcasting…';
  try {
    const { txid } = await api.broadcast(pending);
    $('#sendResult').innerHTML = `<div class="ok">Sent ✓</div><div class="txid">${txid}</div>`;
    $('#to').value = ''; $('#amt').value = ''; pending = null; cache = null; msg('broadcast ✓');
  } catch (e) { msg('broadcast failed: ' + e.message, true); btn.disabled = false; btn.textContent = 'Confirm & broadcast'; }
}

(async () => {
  try { $('#net').textContent = (await api.health()).network; } catch { $('#net').textContent = 'offline'; }
  show('balance');
})();
