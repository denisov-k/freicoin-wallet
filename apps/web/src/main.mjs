import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import * as api from './api.mjs';
import { deriveAddress, buildSignedTx } from './wallet.mjs';

const $ = s => document.querySelector(s);
const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
const seed = () => store.get('fw_seed') || '000102030405060708090a0b0c0d0e0f';
const short = a => a.length > 20 ? a.slice(0, 10) + '…' + a.slice(-8) : a;
const copy = (t, el) => { navigator.clipboard?.writeText(t); if (el) { const o = el.textContent; el.textContent = 'copied ✓'; setTimeout(() => el.textContent = o, 1200); } };
let recvIndex = 0;

$('#app').innerHTML = `
  <header><h1>Freicoin Wallet</h1><span id="net" class="pill">…</span></header>
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

const show = tab => {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['balance', 'receive', 'send', 'settings'].forEach(s => $('#' + s).hidden = s !== tab);
  msg(''); render[tab]?.();
};
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
const msg = (t, err) => { const m = $('#msg'); m.textContent = t; m.className = err ? 'err' : 'ok'; };

let cachedUtxos = null;
const loadUtxos = async () => (cachedUtxos = await api.utxos());

const render = {
  async balance() {
    $('#balance').innerHTML = '<div class="loading">loading…</div>';
    try {
      const b = await api.balance();
      $('#balance').innerHTML =
        `<div class="big">${(+b.balance).toLocaleString(undefined, { maximumFractionDigits: 8 })} <small>FRC</small></div>
         <div class="sub">present value · tip ${b.tipHeight}</div>
         <button id="refresh" class="ghost">↻ Refresh</button>`;
      $('#refresh').onclick = render.balance;
      cachedUtxos = null;
    } catch (e) { $('#balance').innerHTML = `<div class="err">backend unreachable — ${e.message}</div><button id="refresh" class="ghost">↻ Retry</button>`; $('#refresh').onclick = render.balance; }
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
    $('#nextAddr').onclick = () => { recvIndex++; render.receive(); };
  },
  send() {
    $('#send').innerHTML =
      `<label>To address<input id="to" placeholder="fcrt1…" autocomplete="off"></label>
       <label>Amount (FRC)<input id="amt" type="number" step="0.00000001" min="0" placeholder="0.0"></label>
       <button id="sendBtn">Sign &amp; send</button>
       <div id="sendResult"></div>`;
    $('#sendBtn').onclick = doSend;
  },
  settings() {
    $('#settings').innerHTML =
      `<label>Backend URL<input id="be" value="${store.get('fw_backend') || (import.meta.env?.VITE_BACKEND || 'http://127.0.0.1:3030')}"></label>
       <label>Seed (hex — dev only, insecure)<input id="sd" value="${seed()}"></label>
       <div class="row"><button id="saveCfg">Save</button><button id="copySeed" class="ghost">Copy seed</button></div>
       <p class="warn">⚠ The seed is kept in localStorage for this MVP. Do not use real funds.</p>`;
    $('#saveCfg').onclick = () => { store.set('fw_backend', $('#be').value.trim()); store.set('fw_seed', $('#sd').value.trim()); recvIndex = 0; msg('saved'); show('balance'); };
    $('#copySeed').onclick = e => copy(seed(), e.target);
  },
};

async function doSend() {
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  const btn = $('#sendBtn');
  if (!to.startsWith('fcrt1') && !to.startsWith('fc1') && !to.startsWith('tf1')) return msg('enter a valid Freicoin address', true);
  if (!(amt > 0)) return msg('enter an amount', true);
  btn.disabled = true; btn.textContent = 'signing…'; msg('building & signing…');
  try {
    const { utxos, tipHeight } = cachedUtxos || await loadUtxos();
    const r = buildSignedTx({ seed: seed(), utxos, toAddress: to, amountFrc: amt, tipHeight });
    msg('broadcasting…');
    const { txid } = await api.broadcast(r.rawtx);
    $('#sendResult').innerHTML = `<div class="ok">Sent ✓</div><div class="txid">${short(txid)}</div><div class="sub">${r.inputs} input(s) · fee ${r.fee} kria · change ${r.change} kria</div>`;
    $('#to').value = ''; $('#amt').value = ''; cachedUtxos = null; msg('broadcast ✓');
  } catch (e) { msg('send failed: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Sign & send'; }
}

(async () => {
  try { $('#net').textContent = (await api.health()).network; } catch { $('#net').textContent = 'offline'; }
  show('balance');
})();
