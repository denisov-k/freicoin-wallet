import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;                         // core returns Buffer

import * as api from './api.mjs';
import { deriveAddress, buildSignedTx } from './wallet.mjs';

const $ = s => document.querySelector(s);
const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
// DEV seed by default (INSECURE — for MVP/regtest only; real wallet uses secure storage)
const seed = () => store.get('fw_seed') || '000102030405060708090a0b0c0d0e0f';
let recvIndex = 0;

const app = $('#app');
app.innerHTML = `
  <header><h1>Freicoin Wallet</h1><span id="net" class="pill">…</span></header>
  <nav>
    <button data-tab="balance" class="active">Balance</button>
    <button data-tab="receive">Receive</button>
    <button data-tab="send">Send</button>
    <button data-tab="settings">⚙</button>
  </nav>
  <main>
    <section id="balance"></section>
    <section id="receive" hidden></section>
    <section id="send" hidden></section>
    <section id="settings" hidden></section>
  </main>
  <p id="msg"></p>`;

const show = tab => {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['balance', 'receive', 'send', 'settings'].forEach(s => $('#' + s).hidden = s !== tab);
  render[tab]?.();
};
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
const msg = (t, err) => { const m = $('#msg'); m.textContent = t; m.className = err ? 'err' : 'ok'; };

const render = {
  async balance() {
    $('#balance').innerHTML = '<div class="loading">loading…</div>';
    try {
      const b = await api.balance();
      $('#balance').innerHTML =
        `<div class="big">${b.balance} <small>FRC</small></div>
         <div class="sub">present value · tip height ${b.tipHeight}</div>`;
    } catch (e) { $('#balance').innerHTML = `<div class="err">backend: ${e.message}</div>`; }
  },
  receive() {
    const addr = deriveAddress(seed(), recvIndex, 0);
    $('#receive').innerHTML =
      `<div class="label">Receive address #${recvIndex}</div>
       <div class="addr">${addr}</div>
       <button id="nextAddr">Next address</button>`;
    $('#nextAddr').onclick = () => { recvIndex++; render.receive(); };
  },
  send() {
    $('#send').innerHTML =
      `<label>To address<input id="to" placeholder="fcrt1…"></label>
       <label>Amount (FRC)<input id="amt" type="number" step="0.00000001" placeholder="0.0"></label>
       <button id="sendBtn">Sign & broadcast</button>
       <div id="sendResult"></div>`;
    $('#sendBtn').onclick = doSend;
  },
  settings() {
    $('#settings').innerHTML =
      `<label>Backend URL<input id="be" value="${store.get('fw_backend') || 'http://127.0.0.1:3030'}"></label>
       <label>Seed (hex, dev only)<input id="sd" value="${seed()}"></label>
       <button id="saveCfg">Save</button>`;
    $('#saveCfg').onclick = () => {
      store.set('fw_backend', $('#be').value.trim());
      store.set('fw_seed', $('#sd').value.trim());
      msg('settings saved'); show('balance');
    };
  },
};

async function doSend() {
  const toAddress = $('#to').value.trim();
  const amountFrc = parseFloat($('#amt').value);
  if (!toAddress || !(amountFrc > 0)) return msg('enter address and amount', true);
  try {
    msg('building…');
    const { utxos, tipHeight } = await api.utxos();
    const { rawtx, fee, change, inputs } = buildSignedTx({ seed: seed(), utxos, toAddress, amountFrc, tipHeight });
    const { txid } = await api.broadcast(rawtx);
    $('#sendResult').innerHTML = `<div class="ok">sent ✓ txid ${txid}<br><small>${inputs} input(s), fee ${fee} kria, change ${change} kria</small></div>`;
    msg('broadcast ✓'); render.balance();
  } catch (e) { msg('send failed: ' + e.message, true); }
}

// boot
(async () => {
  try { $('#net').textContent = (await api.health()).network; } catch { $('#net').textContent = 'offline'; }
  show('balance');
})();
