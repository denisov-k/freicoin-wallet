import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import { deriveAddress, buildSignedTx, resolveSecret, generateMnemonic, isValidAddress, walletScripts, configureNetwork } from './wallet.mjs';
import { encryptSecret, decryptSecret } from './vault.mjs';
import { NETWORKS, DEFAULT_NET, DEFAULT_BRIDGE } from './netparams.mjs';

// Data source: the variant-B neutrino light client (no trusted backend).
const curNet = () => (NETWORKS[localStorage.getItem('fw_net')] ? localStorage.getItem('fw_net') : DEFAULT_NET);
const curBridge = () => store.get('fw_bridge') || DEFAULT_BRIDGE[curNet()];
let lightSrc = null;
const fmtProgress = p =>
  p.phase === 'headers' ? `verifying headers ${p.height.toLocaleString()} / ${p.target ? p.target.toLocaleString() : '…'}`
  : p.phase === 'filters' ? `scanning filters ${p.done.toLocaleString()} / ${p.want.toLocaleString()}`
  : `fetching blocks ${p.done} / ${p.want}`;

// The light client runs in a Web Worker: header verification (~20s of CPU on mainnet)
// would freeze the page on the main thread. Only watch SCRIPTS go to the worker — the
// seed stays here; signing happens on the main thread and the worker just broadcasts.
let worker = null, wSeq = 0;
const wCalls = new Map();
function wcall(method, params) {
  return new Promise((res, rej) => { const id = ++wSeq; wCalls.set(id, { res, rej }); worker.postMessage({ id, method, params }); });
}
function ds() {
  const net = curNet();
  configureNetwork(net);
  if (!lightSrc) {
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') { const el = $('#syncp'); if (el) el.textContent = fmtProgress(m.p); return; }
      const c = wCalls.get(m.id); if (!c) return; wCalls.delete(m.id);
      m.error ? c.rej(new Error(m.error)) : c.res(m.result);
    };
    worker.onerror = () => { wCalls.forEach(c => c.rej(new Error('worker error'))); wCalls.clear(); };
    wcall('init', {
      url: curBridge(), net, genesis: NETWORKS[net].genesis, scripts: walletScripts(hexSeed()),
      birthHeight: Number(store.get('fw_birth')) || 0,
    }).catch(() => {});
    lightSrc = {
      health: () => wcall('health'), balance: () => wcall('balance'), utxos: () => wcall('utxos'),
      history: () => wcall('history'), refresh: () => wcall('refresh'),
      broadcast: rawtx => wcall('broadcast', rawtx),
      close() {
        const w = worker; worker = null;
        wCalls.forEach(c => c.rej(new Error('closed'))); wCalls.clear();
        try { w.postMessage({ id: 0, method: 'close' }); } catch {}
        setTimeout(() => { try { w.terminate(); } catch {} }, 500);
      },
    };
  }
  return lightSrc;
}

const $ = s => document.querySelector(s);
const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v), del: k => localStorage.removeItem(k) };
const short = a => a && a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-8) : (a || '');
const fmt = n => (+n).toLocaleString(undefined, { maximumFractionDigits: 8 });
const copy = (t, el) => { navigator.clipboard?.writeText(t); if (el) { const o = el.textContent; el.textContent = 'copied ✓'; setTimeout(() => el.textContent = o, 1200); } };
const skel = (n = 1) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
const getVault = () => { const v = store.get('fw_vault'); return v ? JSON.parse(v) : null; };

let unlockedSecret = null, unlockedPass = null;
let recvIndex = +(store.get('fw_recv') || 0), pending = null, pollTimer = null, toastTimer = null, cache = null;
const secret = () => unlockedSecret;
const hexSeed = () => resolveSecret(unlockedSecret);

// theme lives on <html>, survives #app re-renders
const applyTheme = t => { document.documentElement.dataset.theme = t; const b = $('#themeBtn'); if (b) b.textContent = t === 'dark' ? '☀' : '🌙'; };
applyTheme(store.get('fw_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

const toast = (t, type = 'ok') => { const el = $('#toast'); if (!el) return; clearTimeout(toastTimer);
  if (!t) { el.className = ''; el.textContent = ''; return; }
  el.textContent = t; el.className = 'show ' + type; toastTimer = setTimeout(() => el.className = '', 2800); };

// ---------- lock screen ----------
function renderLock() {
  $('#app').innerHTML = `<div class="lock">
    <div class="lockcard">
      <div class="lockicon">🔒</div><h2>Unlock wallet</h2>
      <input id="pw" type="password" placeholder="passphrase" autofocus>
      <button id="unlockBtn">Unlock</button><p id="lerr" class="err"></p>
    </div></div>`;
  const go = () => {
    const pw = $('#pw').value; if (!pw) return;
    $('#unlockBtn').disabled = true; $('#unlockBtn').textContent = 'unlocking…'; $('#lerr').textContent = '';
    setTimeout(() => {
      try { unlockedSecret = decryptSecret(getVault(), pw); unlockedPass = pw; renderApp(); }
      catch { $('#lerr').textContent = 'wrong passphrase'; $('#unlockBtn').disabled = false; $('#unlockBtn').textContent = 'Unlock'; }
    }, 30);
  };
  $('#unlockBtn').onclick = go;
  $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ---------- main app ----------
function renderApp() {
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
  applyTheme(document.documentElement.dataset.theme);
  $('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('fw_theme', t); applyTheme(t); };
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
  (async () => { try { $('#net').textContent = (await ds().health()).network; } catch { $('#net').textContent = 'offline'; } })();
  show('balance');
}

const show = tab => {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['balance', 'receive', 'send', 'activity', 'settings'].forEach(s => $('#' + s).hidden = s !== tab);
  clearInterval(pollTimer); pollTimer = null; toast(''); render[tab]?.();
};

const getState = async force => (!force && cache) ? cache : (cache = await ds().utxos());
const timeAgo = t => { const s = Math.max(0, Date.now() / 1000 - t); if (s < 60) return 'just now'; if (s < 3600) return (s / 60 | 0) + 'm ago'; if (s < 86400) return (s / 3600 | 0) + 'h ago'; return new Date(t * 1000).toLocaleDateString(); };
const CAT = { send: '↑', receive: '↓', generate: '⛏', immature: '⛏' };

const render = {
  async balance() {
    if (!$('#balance').innerHTML) $('#balance').innerHTML = `<div class="skel-line"></div>${skel(1)}<div class="sub" id="syncp"></div>`;
    const paint = s => {
      const pend = s.pending?.length ? s.pending.reduce((a, p) => a + p.amount, 0) : 0;
      $('#balance').innerHTML =
      `<div class="big">${fmt(s.balance)} <small>FRC</small></div>
       <div class="sub">present value · tip ${s.tipHeight} · ${s.utxos.length} UTXO</div>
       ${pend ? `<div class="sub">⏳ ${pend > 0 ? '+' : ''}${fmt(pend)} FRC pending (${s.pending.length} tx)</div>` : ''}
       <button id="refresh" class="ghost">↻ Refresh</button>`;
      $('#refresh').onclick = render.balance; };
    try { paint(await getState(true)); }
    catch (e) { $('#balance').innerHTML = `<div class="err">sync failed — ${e.message}</div><button id="refresh" class="ghost">↻ Retry</button>`; $('#refresh').onclick = render.balance; return; }
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
      const { txs } = await ds().history();
      $('#activity').innerHTML = txs.length ? txs.map((t, i) =>
        `<div class="act" data-i="${i}">
           <div class="act-i ${t.category}">${CAT[t.category] || '•'}</div>
           <div class="act-m"><b>${t.category}</b><span class="sub">${t.confirmations > 0 ? t.confirmations + ' conf' : 'pending'} · ${timeAgo(t.time)}</span></div>
           <div class="act-a ${(+t.amount) < 0 ? 'neg' : 'pos'}">${(+t.amount) > 0 ? '+' : ''}${fmt(t.amount)}</div>
         </div>`).join('') + '<div id="actDetail"></div>' : '<div class="sub">no transactions yet</div>';
      document.querySelectorAll('.act').forEach(el => el.onclick = () => {
        const t = txs[+el.dataset.i];
        $('#actDetail').innerHTML = `<div class="detail"><span class="sub">txid</span><div class="txid" id="dtxid">${t.txid}</div><button id="copyTxid" class="ghost">Copy txid</button></div>`;
        $('#copyTxid').onclick = e => copy(t.txid, e.target);
      });
    } catch (e) { $('#activity').innerHTML = `<div class="err">${e.message}</div>`; }
  },
  settings() {
    const vault = getVault(), s = secret();
    const kind = /\s/.test((s || '').trim()) ? 'recovery phrase' : 'hex seed';
    $('#settings').innerHTML =
      `<label>Network<select id="netSel">${Object.entries(NETWORKS).map(([k, v]) => `<option value="${k}"${k === curNet() ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
       <label>Bridge URL (neutrino P2P relay)<input id="br" value="${curBridge()}"></label>
       <label>Wallet birth height <span class="sub">(skip filter scan below; 0 = from genesis)</span><input id="birth" type="number" min="0" value="${store.get('fw_birth') || 0}"></label>
       <label>Wallet secret (${kind})<textarea id="sd" rows="2">${s}</textarea></label>
       <div class="row"><button id="saveCfg">Save</button><button id="genBtn" class="ghost">Generate 12 words</button><button id="copySeed" class="ghost">Copy</button></div>
       <div class="row">${vault
          ? '<button id="lockBtn" class="ghost">🔓 Lock</button><button id="chgBtn" class="ghost">Change passphrase</button>'
          : '<button id="secBtn" class="ghost">🔒 Secure with passphrase</button>'}</div>
       <div id="secForm"></div>
       <p class="warn">${vault ? '🔒 Secret is encrypted with your passphrase (AES-GCM). It is only decrypted in memory.' : '⚠ Secret is stored unencrypted — set a passphrase to secure it. Dev/regtest only.'}</p>`;
    $('#saveCfg').onclick = saveSettings;
    // Switching network swaps in that network's default bridge (user can still override).
    $('#netSel').onchange = () => { $('#br').value = DEFAULT_BRIDGE[$('#netSel').value] || ''; };
    $('#genBtn').onclick = () => {
      $('#sd').value = generateMnemonic();
      // A brand-new wallet has no history before the current tip — set its birth there.
      if (cache?.tipHeight) $('#birth').value = cache.tipHeight;
      toast('new phrase — back it up, then Save');
    };
    $('#copySeed').onclick = e => copy($('#sd').value, e.target);
    if (vault) { $('#lockBtn').onclick = lock; $('#chgBtn').onclick = () => passForm('Change passphrase', pw => secure(secret(), pw, true)); }
    else $('#secBtn').onclick = () => passForm('Set a passphrase', pw => secure($('#sd').value.trim(), pw, false));
  },
};

function passForm(title, done) {
  $('#secForm').innerHTML =
    `<div class="review"><div class="label">${title}</div>
       <input id="p1" type="password" placeholder="passphrase">
       <input id="p2" type="password" placeholder="repeat passphrase">
       <div class="row"><button id="pOk">Encrypt</button><button id="pCancel" class="ghost">Cancel</button></div></div>`;
  $('#pOk').onclick = () => { const a = $('#p1').value, b = $('#p2').value;
    if (a.length < 4) return toast('passphrase too short', 'err');
    if (a !== b) return toast('passphrases do not match', 'err');
    done(a); };
  $('#pCancel').onclick = () => $('#secForm').innerHTML = '';
}

function secure(sec, pass, wasVault) {
  try { resolveSecret(sec); } catch (e) { return toast(e.message, 'err'); }
  store.set('fw_vault', JSON.stringify(encryptSecret(sec, pass)));
  store.del('fw_seed'); unlockedSecret = sec; unlockedPass = pass;
  toast(wasVault ? 'passphrase changed' : 'wallet secured 🔒'); render.settings();
}
function lock() { unlockedSecret = null; unlockedPass = null; clearInterval(pollTimer); renderLock(); }

function saveSettings() {
  const sec = $('#sd').value.trim();
  try { resolveSecret(sec); } catch (e) { return toast(e.message, 'err'); }
  const net = NETWORKS[$('#netSel').value] ? $('#netSel').value : DEFAULT_NET;
  store.set('fw_net', net); configureNetwork(net);
  const br = $('#br').value.trim();
  if (br && br !== DEFAULT_BRIDGE[net]) store.set('fw_bridge', br); else store.del('fw_bridge');   // keep the net default unless overridden
  const birth = Math.max(0, parseInt($('#birth').value, 10) || 0);
  if (birth) store.set('fw_birth', birth); else store.del('fw_birth');
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  unlockedSecret = sec; recvIndex = 0; store.set('fw_recv', 0); cache = null;
  if (getVault()) store.set('fw_vault', JSON.stringify(encryptSecret(sec, unlockedPass)));  // re-encrypt
  else store.set('fw_seed', sec);
  toast('saved'); show('balance');
}

async function doReview() {
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!isValidAddress(to)) return toast('invalid Freicoin address', 'err');
  if (!(amt > 0)) return toast('enter an amount', 'err');
  toast('building…'); $('#reviewBtn').disabled = true;
  try {
    const { utxos, tipHeight, balance } = await getState();
    if (amt > balance) throw new Error(`amount exceeds available (${fmt(balance)} FRC)`);
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
  } catch (e) { toast(e.message, 'err'); }
  finally { $('#reviewBtn').disabled = false; }
}

async function doBroadcast() {
  if (!pending) return;
  const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = 'broadcasting…';
  try {
    const { txid } = await ds().broadcast(pending);
    $('#sendResult').innerHTML = `<div class="ok">Sent ✓</div><div class="txid">${txid}</div>`;
    $('#to').value = ''; $('#amt').value = ''; pending = null; cache = null; toast('broadcast ✓');
  } catch (e) { toast('broadcast failed: ' + e.message, 'err'); btn.disabled = false; btn.textContent = 'Confirm & broadcast'; }
}

// boot
configureNetwork(curNet());   // set NET/ACCOUNT before any address derivation
if (getVault()) renderLock();
else { unlockedSecret = store.get('fw_seed') || '000102030405060708090a0b0c0d0e0f'; renderApp(); }
