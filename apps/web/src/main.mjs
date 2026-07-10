import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import { deriveAddress, buildSignedTx, resolveSecret, generateMnemonic, isValidAddress, walletScripts, configureNetwork } from './wallet.mjs';
import { encryptSecret, decryptSecret } from './vault.mjs';
import { NETWORKS, DEFAULT_NET, DEFAULT_BRIDGE, DEFAULT_SNAPSHOT, DEFAULT_SNAPSHOT_FILTERS } from './netparams.mjs';

// Data source: the variant-B neutrino light client (no trusted backend).
const curNet = () => (NETWORKS[localStorage.getItem('fw_net')] ? localStorage.getItem('fw_net') : DEFAULT_NET);
const curBridge = () => store.get('fw_bridge') || DEFAULT_BRIDGE[curNet()];
let lightSrc = null;
// ---- header status indicator (dot + click-popover with sync details) ----
const status = { state: 'sync', detail: 'connecting…', tip: null, progress: {} };
function setStatus(state, detail, tip) {
  status.state = state;
  if (detail !== undefined) status.detail = detail;
  if (tip !== undefined) status.tip = tip;
  if (state === 'ok') status.progress = {};
  const b = $('#statusBtn');
  if (b) b.className = 'icon statusbtn st-' + state;
  const pop = $('#statusPop');
  if (pop && !pop.hidden) renderStatusPop();
}
const PHASE_LABEL = { headers: 'headers', filters: 'scan', blocks: 'blocks', verify: 'PoW' };
const PHASE_ORDER = ['headers', 'filters', 'blocks', 'verify'];   // pipeline order, not arrival order
function renderStatusPop() {
  const pop = $('#statusPop'); if (!pop) return;
  const label = { ok: 'synced ✓ (verified)', sync: 'syncing…', off: 'offline' }[status.state] || status.state;
  // one stable line per concurrently-running phase, in fixed pipeline order (rendering by
  // arrival order made the lines shuffle depending on which stream reported first)
  const phases = PHASE_ORDER.filter(k => status.progress[k]).map(k => { const p = status.progress[k];
    return `<div class="rrow"><span>${PHASE_LABEL[k]}</span><b>${(p.done ?? p.height).toLocaleString()} / ${(p.want ?? p.target).toLocaleString()}</b></div>`; }).join('');
  pop.innerHTML =
    `<div class="rrow"><span>Network</span><b>${NETWORKS[curNet()].label}</b></div>
     <div class="rrow"><span>Status</span><b>${label}</b></div>
     ${status.state !== 'ok' && status.rx ? `<div class="rrow"><span>Downloaded</span><b>${(status.rx / 1e6).toFixed(1)} MB${status.mbps ? ' · ' + status.mbps.toFixed(1) + ' MB/s' : ''}</b></div>` : ''}
     ${status.state !== 'ok' ? phases || (status.detail ? `<div class="sub">${status.detail}</div>` : '') : ''}`;
}

// The light client runs in a Web Worker: header verification (~20s of CPU on mainnet)
// would freeze the page on the main thread. Only watch SCRIPTS go to the worker — the
// seed stays here; signing happens on the main thread and the worker just broadcasts.
let worker = null, wSeq = 0;
const wCalls = new Map();
function wcall(method, params) {
  return new Promise((res, rej) => { const id = ++wSeq; wCalls.set(id, { res, rej }); worker.postMessage({ id, method, params }); });
}
// Wallet fingerprint (same djb2 as the light source) — keys the learned birth height.
const walletFp = scripts => { let h = 5381 >>> 0; const s = scripts.join(''); for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return scripts.length + ':' + h.toString(16); };
// Birth height is fully automatic: a brand-new wallet's birth is the tip at generation
// time; an imported wallet full-scans once, then the first-activity height learned from
// that scan is remembered (survives IndexedDB eviction — a rescan skips straight to it).
const learnedBirth = fp => Number(store.get('fw_ab:' + fp)) || 0;
const effectiveBirth = fp => learnedBirth(fp);

function ds() {
  const net = curNet();
  configureNetwork(net);
  if (!lightSrc) {
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') {
        status.progress[m.p.phase] = m.p;
        if (m.p.rx) { const now = Date.now();
          if (status.rxAt && now > status.rxAt) status.mbps = ((m.p.rx - status.rx) / 1e6) / ((now - status.rxAt) / 1000) * 0.5 + (status.mbps || 0) * 0.5;
          status.rx = m.p.rx; status.rxAt = now; }
        setStatus('sync'); return;
      }
      if (m.type === 'provisional') {
        liveState = m.c;
        try { paintBalance(m.c); } catch {}
        try { paintActivity([...m.c.pending, ...m.c.history]); } catch {}
        try { paintSendAvail(m.c, true); } catch {}
        setStatus('sync', undefined, m.c.tipHeight);
        return;
      }
      const c = wCalls.get(m.id); if (!c) return; wCalls.delete(m.id);
      m.error ? c.rej(new Error(m.error)) : c.res(m.result);
    };
    worker.onerror = () => { wCalls.forEach(c => c.rej(new Error('worker error'))); wCalls.clear(); };
    const scripts = walletScripts(hexSeed());
    wcall('init', {
      url: curBridge(), net, genesis: NETWORKS[net].genesis, scripts,
      birthHeight: effectiveBirth(walletFp(scripts)),
      snapshotUrl: DEFAULT_SNAPSHOT[net] || null,
      filterSnapshotUrl: DEFAULT_SNAPSHOT_FILTERS[net] || null,
    }).catch(() => {});
    lightSrc = {
      health: () => wcall('health'), balance: () => wcall('balance'), utxos: () => wcall('utxos'),
      history: () => wcall('history'), refresh: () => wcall('refresh'), preview: () => wcall('preview'),
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

// theme lives on <html>, survives #app re-renders. Mode 'system' (default) follows the
// OS preference — the OS flips it on its own schedule (e.g. dark after sunset), and the
// media-query listener re-applies it live.
// fw_theme_mode is the NEW key: the legacy fw_theme (written by the old header toggle on
// every click) would silently pin an explicit theme and break System on devices that ever
// used the toggle — drop it.
store.del('fw_theme');
const themeMode = () => store.get('fw_theme_mode') || 'system';
const resolveTheme = m => m === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : m;
const applyTheme = m => { document.documentElement.dataset.theme = resolveTheme(m); const sel = $('#themeSel'); if (sel) sel.value = m; };
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themeMode() === 'system') applyTheme('system'); });
applyTheme(themeMode());

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
      <div class="hbtns"><button id="statusBtn" class="icon statusbtn st-sync" title="sync status">●</button></div></header>
    <div id="statusPop" hidden></div>
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
  applyTheme(themeMode());
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
  $('#statusBtn').onclick = () => { const pop = $('#statusPop'); pop.hidden = !pop.hidden; if (!pop.hidden) renderStatusPop(); };
  document.addEventListener('click', e => { const pop = $('#statusPop'); if (pop && !pop.hidden && !pop.contains(e.target) && e.target.id !== 'statusBtn') pop.hidden = true; });
  setStatus('sync', 'connecting…');
  // Global refresh loop: keeps the status dot, balance and (when visible) the activity
  // list fresh no matter which tab is open — it used to live inside the Balance render,
  // so opening on another tab froze the status at 'connecting…' forever.
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const st = await getState(true);
      paintBalance(st);                                   // sets status ok; skips DOM when hidden
      if (!$('#activity').hidden) { const { txs } = await ds().history(); paintActivity(txs); }
    } catch { setStatus('off', 'bridge unreachable — retrying'); }
  }, 6000);
  const saved = store.get('fw_tab');
  show(TABS.includes(saved) ? saved : 'balance');
}

const TABS = ['balance', 'receive', 'send', 'activity', 'settings'];
const show = tab => {
  store.set('fw_tab', tab);   // restore the active tab across reloads
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  TABS.forEach(s => $('#' + s).hidden = s !== tab);
  toast(''); render[tab]?.();
};

const getState = async force => {
  if (!force && cache) return cache;
  cache = await ds().utxos();
  // Learn the wallet's birth height from the first completed scan (write-once per wallet):
  // a future rescan (e.g. the browser evicted IndexedDB) then skips straight to it.
  try {
    const fp = walletFp(walletScripts(hexSeed()));
    if (cache.birthAuto && !store.get('fw_ab:' + fp)) store.set('fw_ab:' + fp, cache.birthAuto);
  } catch {}
  return cache;
};
const timeAgo = t => { const s = Math.max(0, Date.now() / 1000 - t); if (s < 60) return 'just now'; if (s < 3600) return (s / 60 | 0) + 'm ago'; if (s < 86400) return (s / 3600 | 0) + 'h ago'; return new Date(t * 1000).toLocaleDateString(); };
const CAT = { send: '↑', receive: '↓', generate: '⛏', immature: '⛏' };

// Latest streamed (partial/provisional) state — lets every tab show live data during a
// first sync, when there is no cache and nothing persisted to preview.
let liveState = null;

// Activity list painter — module-level so streamed partials can update the visible list.
let actLastHtml = '';
function paintActivity(txs) {
  const sec = $('#activity');
  if (!sec || sec.hidden) return false;
  const html = txs.length ? txs.map((t, i) =>
    `<div class="act" data-i="${i}">
       <div class="act-i ${t.category}">${CAT[t.category] || '•'}</div>
       <div class="act-m"><b>${t.category}</b><span class="sub">${t.confirmations > 0 ? t.confirmations + ' conf' : 'pending'} · ${timeAgo(t.time)}</span></div>
       <div class="act-a ${(+t.amount) < 0 ? 'neg' : 'pos'}">${(+t.amount) > 0 ? '+' : ''}${fmt(t.amount)}</div>
     </div>`).join('') + '<div id="actDetail"></div>' : '<div class="sub">no transactions yet</div>';
  if (html === actLastHtml) return true;   // identical content — skip the rewrite (no blink)
  actLastHtml = html;
  sec.innerHTML = html;
  document.querySelectorAll('.act').forEach(el => el.onclick = () => {
    const t = txs[+el.dataset.i];
    $('#actDetail').innerHTML = `<div class="detail"><span class="sub">txid</span><div class="txid" id="dtxid">${t.txid}</div><button id="copyTxid" class="ghost">Copy txid</button></div>`;
    $('#copyTxid').onclick = e => copy(t.txid, e.target);
  });
  return true;
}
// Send available line — ≈ marks unverified (streamed/preview) values.
function paintSendAvail(st, approx) {
  const el = $('#avail');
  if (el && st) el.textContent = `available ${approx ? '≈ ' : ''}${fmt(st.balance)} FRC`;
}

// Render generation: bumped on every tab render; async callbacks from an older render
// (e.g. a sync rejected with 'closed' when Settings replaced the source) check it and
// bail instead of painting errors over the new render.
let renderGen = 0;

// Balance card painter — module-level so the worker's provisional events can repaint
// the visible balance screen outside a render.balance() call.
let balPainted = false;
function paintBalance(s) {
  if (!s.stale) setStatus('ok', '', s.tipHeight);
  else setStatus('sync', undefined, s.tipHeight);
  if ($('#balance').hidden) return;
  balPainted = true;
  // build the card once; update fields in place afterwards (a full innerHTML rewrite per
  // streamed partial made the screen flicker)
  if (!$('#balBig')) {
    $('#balance').innerHTML =
      `<div class="big" id="balBig"></div>
       <div class="sub" id="balPend"></div>`;
  }
  // no qualifier line: the header dot carries the state (amber = syncing/unverified,
  // green = verified) and the popover the details
  const pend = s.pending?.length ? s.pending.reduce((a, p) => a + p.amount, 0) : 0;
  status.utxos = s.utxos.length;           // detail lives in the status popover
  $('#balBig').innerHTML = `${fmt(s.balance)} <small>FRC</small>`;
  $('#balPend').textContent = pend ? `⏳ ${pend > 0 ? '+' : ''}${fmt(pend)} FRC pending (${s.pending.length} tx)` : '';
}

const render = {
  async balance() {
    const gen = ++renderGen;
    // First sync (nothing persisted yet): an honest placeholder — the balance is genuinely
    // unknown until the filter scan completes, so show that instead of a bare skeleton.
    if (!$('#balance').innerHTML) $('#balance').innerHTML =
      `<div class="big">— <small>FRC</small></div>
       <div class="sub">first sync…</div>`;
    balPainted = false;
    // Instant: last persisted state (no network) while the real sync runs.
    if (!cache) { try { const pv = await ds().preview(); if (gen === renderGen && pv) paintBalance(pv); } catch {} }
    try { const st = await getState(true); if (gen !== renderGen) return; paintBalance(st); }
    catch (e) {
      if (gen !== renderGen) return;   // stale render (source was replaced) — ignore
      if (!balPainted) { setStatus('off', e.message); $('#balance').innerHTML = `<div class="err">sync failed — ${e.message}</div><button id="refresh" class="ghost">↻ Retry</button>`; $('#refresh').onclick = render.balance; return; }
      setStatus('off', 'bridge unreachable — retrying');
    }
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
    // Instant: approximate available (verified cache > streamed partial > preview); live
    // partials keep it fresh; the verified value replaces it in place and binds Max.
    const seed = cache || liveState;
    if (seed) paintSendAvail(seed, !cache);
    else { try { const pv = await ds().preview(); if (pv) paintSendAvail(pv, true); } catch {} }
    const sendGen = renderGen;
    try { const s = await getState(); if (sendGen !== renderGen) return; paintBalance(s); paintSendAvail(s, false);
      if ($('#maxBtn')) $('#maxBtn').onclick = () => { $('#amt').value = Math.max(0, s.balance - 0.001).toFixed(8); }; }
    catch { if (sendGen !== renderGen) return; const el = $('#avail'); if (el && el.textContent === 'available…') el.textContent = ''; }
  },
  async activity() {
    const gen = ++renderGen;
    actLastHtml = '';
    $('#activity').innerHTML = skel(4);
    let painted = false;
    // Instant: verified cache > streamed partial > persisted preview; live partials keep
    // updating the list via the worker's provisional events while the sync runs.
    const seed = cache || liveState;
    if (seed) painted = paintActivity([...seed.pending, ...seed.history]) || painted;
    else { try { const pv = await ds().preview(); if (pv) painted = paintActivity([...pv.pending, ...pv.history]) || painted; } catch {} }
    try {
      const { txs } = await ds().history();
      if (gen !== renderGen) return;
      painted = paintActivity(txs) || painted;
      setStatus('ok');
    } catch (e) { if (gen === renderGen && !painted) $('#activity').innerHTML = `<div class="err">${e.message}</div>`; }
  },
  settings() {
    const vault = getVault(), s = secret();
    const kind = /\s/.test((s || '').trim()) ? 'recovery phrase' : 'hex seed';
    $('#settings').innerHTML =
      `<label>Theme<select id="themeSel">${['system', 'dark', 'light'].map(m => `<option value="${m}"${themeMode() === m ? ' selected' : ''}>${m === 'system' ? 'System' : m === 'dark' ? 'Dark' : 'Light'}</option>`).join('')}</select></label>
       <label>Network<select id="netSel">${Object.entries(NETWORKS).map(([k, v]) => `<option value="${k}"${k === curNet() ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
       <label>Bridge URL (neutrino P2P relay)<input id="br" value="${curBridge()}"></label>
       <label>Wallet secret (${kind})<textarea id="sd" rows="2">${s}</textarea></label>
       <div class="row"><button id="saveCfg">Save</button><button id="genBtn" class="ghost">Generate 12 words</button><button id="copySeed" class="ghost">Copy</button></div>
       <div class="row">${vault
          ? '<button id="lockBtn" class="ghost">🔓 Lock</button><button id="chgBtn" class="ghost">Change passphrase</button>'
          : '<button id="secBtn" class="ghost">🔒 Secure with passphrase</button>'}</div>
       <div id="secForm"></div>
       <p class="warn">${vault ? '🔒 Secret is encrypted with your passphrase (AES-GCM). It is only decrypted in memory.' : '⚠ Secret is stored unencrypted — set a passphrase to secure it. Dev/regtest only.'}</p>`;
    $('#saveCfg').onclick = saveSettings;
    $('#themeSel').onchange = () => { const t = $('#themeSel').value; store.set('fw_theme_mode', t); applyTheme(t); };   // applies immediately
    // Switching network swaps in that network's default bridge (user can still override).
    $('#netSel').onchange = () => { $('#br').value = DEFAULT_BRIDGE[$('#netSel').value] || ''; };
    $('#genBtn').onclick = () => {
      const m = generateMnemonic();
      $('#sd').value = m;
      // A brand-new wallet has no history before the current tip — record its birth now
      // (keyed by the new wallet's fingerprint; picked up when the user saves).
      try { if (cache?.tipHeight) store.set('fw_ab:' + walletFp(walletScripts(resolveSecret(m))), cache.tipHeight); } catch {}
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
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  unlockedSecret = sec; recvIndex = 0; store.set('fw_recv', 0); cache = null; liveState = null;
  if (getVault()) store.set('fw_vault', JSON.stringify(encryptSecret(sec, unlockedPass)));  // re-encrypt
  else store.set('fw_seed', sec);
  // Reset the UI to the new source's reality — the old network/wallet's numbers must not
  // linger on screen while the new one syncs (nor its download counters in the popover).
  $('#balance').innerHTML = ''; $('#activity').innerHTML = ''; actLastHtml = '';
  const av = $('#avail'); if (av) av.textContent = 'available…';
  status.progress = {}; status.rx = 0; status.rxAt = 0; status.mbps = 0; status.utxos = null; status.tip = null;
  setStatus('sync', 'connecting…');
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
