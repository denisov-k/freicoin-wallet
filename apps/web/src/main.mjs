import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import { deriveAddress, buildSignedTx, resolveSecret, generateMnemonic, isValidAddress, walletScripts, configureNetwork, addrToSpk } from './wallet.mjs';
import { encryptSecret, decryptSecret } from './vault.mjs';
import { NETWORKS, DEFAULT_NET, DEFAULT_BRIDGE, DEFAULT_SNAPSHOT, DEFAULT_SNAPSHOT_FILTERS, CHECKPOINT } from './netparams.mjs';
import { tr, getLang, setLang, LANGS } from './i18n.mjs';
// Freimarkets (Issue + Exchange) — mounted as extra tabs only on the nv3 network.
import { initMarketView, mvSetSeed, mvRefresh, openIssueModal, renderExchange, renderAssetBalance, mvOwnedAssets, mvSendAsset, mvRelayAssets, mvBtc, mvBtcAddress, mvSendBtc, mvBtcValidAddr, mvBtcHistory } from './market-view.mjs';

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
const PHASE_LABEL = { headers: 'headers', filters: 'scan' };
const PHASE_ORDER = ['headers', 'filters'];   // pipeline order; blocks/PoW are internal detail
function renderStatusPop() {
  const pop = $('#statusPop'); if (!pop) return;
  // The verify tail runs after download+scan complete; without this the status showed a
  // motionless 'syncing…' with both visible phases at 100%.
  const label = (() => {
    if (status.state !== 'sync') return tr({ ok: 'synced ✓ (verified)', off: 'offline', retry: 'reconnecting…' }[status.state] || status.state);
    const v = status.progress.verify, h = status.progress.headers, f = status.progress.filters;
    const headersDone = !h || (h.height ?? h.done) >= (h.target ?? h.want);
    const scanDone = !f || f.done >= f.want;
    if (v && v.done < v.want && headersDone && scanDone)
      return tr('verifying…') + ' ' + Math.floor(v.done / v.want * 100) + '%';
    return tr('syncing…');
  })();
  // one stable line per concurrently-running phase, in fixed pipeline order (rendering by
  // arrival order made the lines shuffle depending on which stream reported first)
  const phases = PHASE_ORDER.filter(k => status.progress[k]).map(k => { const p = status.progress[k];
    return `<div class="rrow"><span>${tr(PHASE_LABEL[k])}</span><b>${(p.done ?? p.height).toLocaleString()} / ${(p.want ?? p.target).toLocaleString()}</b></div>`; }).join('');
  pop.innerHTML =
    `<div class="rrow"><span>${tr('Network')}</span><b>${NETWORKS[curNet()].label}</b></div>
     <div class="rrow"><span>${tr('Status')}</span><b>${label}</b></div>
     ${status.state !== 'ok' && status.rx ? `<div class="rrow"><span>${tr('Downloaded')}</span><b>${(status.rx / 1e6).toFixed(1)} MB${status.mbps ? ' · ' + status.mbps.toFixed(1) + ' MB/s' : ''}</b></div>` : ''}
     ${status.state !== 'ok' ? phases || (status.detail ? `<div class="sub">${tr(status.detail)}</div>` : '') : ''}`;
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
// ONE sync mode: data always from the wallet's BIRTH. The birth record (localStorage,
// per wallet fingerprint) holds {birth, anchorH, anchorHash}: the anchor is a verified
// (height, hash) ~100 blocks below the birth — fresh starts anchor the header chain
// there instead of genesis. Unknown birth (a fresh import) full-scans ONCE to learn it.
// A newly created wallet is born "now" on EVERY network (fingerprints differ per net —
// the coin type changes the scripts), so record its birth for each network that has a
// build checkpoint; nets without one (regtest) full-scan cheaply anyway.
function recordNewWalletBirth(secret) {
  try {
    const seed = resolveSecret(secret);
    const cur = curNet();
    for (const netK of Object.keys(NETWORKS)) {
      const cp = CHECKPOINT[netK];
      if (!cp) continue;
      configureNetwork(netK);
      store.set('fw_ab:' + walletFp(walletScripts(seed)), JSON.stringify({ birth: cp.height, anchorH: cp.height, anchorHash: cp.hash }));
    }
    configureNetwork(cur);
  } catch {}
}

const birthRec = fp => {
  const v = store.get('fw_ab:' + fp);
  if (!v) return null;
  try { const j = JSON.parse(v); if (j && j.birth) return j; } catch {}
  const n = Number(v); return n > 0 ? { birth: n } : null;   // legacy: height only, no anchor
};

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
        try { paintActivity([...m.c.pending, ...m.c.history], false); } catch {}
        try { paintSendAvail(m.c, true); } catch {}
        setStatus('sync', undefined, m.c.tipHeight);
        return;
      }
      const c = wCalls.get(m.id); if (!c) return; wCalls.delete(m.id);
      m.error ? c.rej(new Error(m.error)) : c.res(m.result);
    };
    worker.onerror = () => { wCalls.forEach(c => c.rej(new Error('worker error'))); wCalls.clear(); };
    const scripts = myScripts();
    const rec = birthRec(walletFp(scripts));
    wcall('init', {
      url: curBridge(), net, genesis: NETWORKS[net].genesis, scripts,
      birthHeight: rec?.birth || 0,
      snapshotUrl: DEFAULT_SNAPSHOT[net] || null,
      filterSnapshotUrl: DEFAULT_SNAPSHOT_FILTERS[net] || null,
      // anchor: the wallet's own recorded birth anchor, else the build-time one (valid
      // only when the birth is at/above it — the source enforces that)
      checkpoint: (rec?.anchorH && rec?.anchorHash) ? { height: rec.anchorH, hash: rec.anchorHash } : (CHECKPOINT[net] || null),
      // untrusted relay asset defs (rates) — lets history value asset spends it can't scan defs for
      seedDefs: (() => { try { return JSON.parse(store.get('fw_reldefs') || 'null'); } catch { return null; } })(),
    }).catch(() => {});
    lightSrc = {
      health: () => wcall('health'), balance: () => wcall('balance'), utxos: () => wcall('utxos'),
      history: () => wcall('history'), refresh: () => wcall('refresh'), preview: () => wcall('preview'),
      assets: () => wcall('assets'),   // nV3 asset-aware view for the Issue/Exchange tabs
      reset: () => wcall('reset'), broadcast: rawtx => wcall('broadcast', rawtx),
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
initMarketView(ds);   // give the Freimarkets tabs the wallet's light source (ds().assets())

/** @type {(s: string) => any} */
const $ = s => document.querySelector(s);
const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v), del: k => localStorage.removeItem(k) };
const short = a => a && a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-8) : (a || '');
const fmt = n => (+n).toLocaleString(undefined, { maximumFractionDigits: 8 });
// Display balance: 2 decimals, rounded DOWN (never show more than is spendable) — the
// demurrage churns the low digits every block, so full precision is visual noise here.
// Full 8-digit precision stays where it matters: amounts, fees, activity records.
const fmtBal = n => (Math.floor((+n) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const copy = (t, el) => { navigator.clipboard?.writeText(t); if (el) { const o = el.textContent; el.textContent = tr('copied ✓'); setTimeout(() => el.textContent = o, 1200); } };
const skel = (n = 1) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
const getVault = () => { const v = store.get('fw_vault'); return v ? JSON.parse(v) : null; };

let unlockedSecret = null, unlockedPass = null;
let recvIndex = +(store.get('fw_recv') || 0), pending = null, pollTimer = null, toastTimer = null, cache = null;
const secret = () => unlockedSecret;
const hexSeed = () => resolveSecret(unlockedSecret);
// Watch window: always 20 unused addresses beyond the highest handed-out receive index, so
// "get new address" works indefinitely without ever handing out an unwatched address.
const watchGap = () => recvIndex + 20;
const myScripts = () => walletScripts(hexSeed(), watchGap());

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
// reusable modal: a .review card in the #modal overlay, tap-outside or ✕ to close. `title` gets a
// header row with a close button; returns the overlay so callers can wire and later remove it.
const openModal = (title, inner) => {
  $('#modal')?.remove();
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${title}</b><button id="mClose" class="icon">✕</button></div>
    ${inner}</div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  // @ts-ignore  — false positive (DOM/Promise<void> under checkJs)
  m.querySelector('#mClose').onclick = () => m.remove();
  return m;
};

// ---------- first-run welcome ----------
// Onboarding passphrase step: encrypting the secret is the default path; skipping is an
// explicit (discouraged) choice — a mainnet wallet should not sit in plaintext storage.
function welcomePassStep(sec, doneToast) {
  $('#wBody').innerHTML = `
    <p class="sub">${tr('Protect your wallet with a passphrase — it encrypts the phrase on this device.')}</p>
    <input id="p1" type="password" placeholder="${tr('passphrase')}">
    <input id="p2" type="password" placeholder="${tr('repeat passphrase')}">
    <div class="row"><button id="wEnc">${tr('Encrypt')}</button><button id="wSkip" class="ghost">${tr('Skip for now')}</button></div>`;
  $('#wEnc').onclick = () => {
    const a = $('#p1').value, b = $('#p2').value;
    if (a.length < 4) return toast(tr('passphrase too short'), 'err');
    if (a !== b) return toast(tr('passphrases do not match'), 'err');
    store.set('fw_vault', JSON.stringify(encryptSecret(sec, a)));
    store.del('fw_seed'); unlockedSecret = sec; unlockedPass = a;
    renderApp(); toast(tr('wallet secured 🔒'));
  };
  $('#wSkip').onclick = () => {
    store.set('fw_seed', sec); unlockedSecret = sec;
    renderApp(); toast(doneToast + ' · ' + tr('you can add a passphrase later in Settings'));
  };
}
function renderWelcome() {
  $('#app').innerHTML = `<div class="lock"><div class="lockcard">
    <div class="lockicon fmark" aria-hidden="true">ƒ</div><h2>Freicoin</h2>
    <p class="sub">${tr('Only money that goes out of date like a newspaper, rots like potatoes, rusts like iron, is fit to be a medium of exchange.')}<br><span class="cite">— ${tr('Silvio Gesell')}</span></p>
    <button id="wCreate">${tr('Sign up')}</button>
    <button id="wRestore" class="ghost">${tr('Log in')}</button>
    <select id="wLang" class="wlang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${getLang() === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div></div>`;
  $('#wLang').onchange = () => { setLang($('#wLang').value); renderWelcome(); };
  $('#wCreate').onclick = renderSignup;
  $('#wRestore').onclick = renderLogin;
}
// Sign-up and log-in live on their own screens; ← returns to the welcome card.
const authScreen = (title, body) => {
  $('#app').innerHTML = `<div class="lock"><div class="lockcard">
    <div class="lockicon fmark" aria-hidden="true">ƒ</div><h2>${title}</h2>
    <div id="wBody">${body}</div>
    <button id="wBack" class="ghost">← ${tr('Back')}</button></div></div>`;
  $('#wBack').onclick = renderWelcome;
};
function renderSignup() {
  const m = generateMnemonic();
  authScreen(tr('Sign up'), `
    <div class="addr">${m}</div>
    <p class="warn">${tr('⚠ Write these 12 words down. They are the ONLY key to your money — no one can recover them for you.')}</p>
    <div class="row"><button id="wCopy" class="ghost">⧉ ${tr('Copy')}</button><button id="wDone">${tr('I wrote them down')}</button></div>`);
  $('#wCopy').onclick = e => copy(m, e.target);
  $('#wDone').onclick = () => {
    recordNewWalletBirth(m);
    welcomePassStep(m, tr('wallet created — you can add a passphrase in Settings 🔒').split(' — ')[0]);
  };
}
function renderLogin() {
  authScreen(tr('Log in'), `
    <label>${tr('Recovery phrase or hex seed')}<textarea id="wSeed" rows="2"></textarea></label>
    <p class="sub">${tr('Restoring an existing wallet scans its whole history once — this can take a minute.')}</p>
    <div class="row"><button id="wGo">${tr('Log in')}</button></div>`);
  $('#wGo').onclick = () => {
    const sec = $('#wSeed').value.trim();
    try { resolveSecret(sec); } catch (e) { return toast(e.message, 'err'); }
    store.set('fw_seed', sec); unlockedSecret = sec;
    renderApp(); toast(tr('wallet restored — scanning its history…'));
  };
}

// ---------- lock screen ----------
function renderLock() {
  $('#app').innerHTML = `<div class="lock">
    <div class="lockcard">
      <div class="lockicon">🔒</div><h2>${tr('Unlock wallet')}</h2>
      <input id="pw" type="password" placeholder="${tr('passphrase')}" autofocus>
      <button id="unlockBtn">${tr('Unlock')}</button><p id="lerr" class="err"></p>
    </div></div>`;
  const go = () => {
    const pw = $('#pw').value; if (!pw) return;
    $('#unlockBtn').disabled = true; $('#unlockBtn').textContent = tr('unlocking…'); $('#lerr').textContent = '';
    setTimeout(() => {
      try { unlockedSecret = decryptSecret(getVault(), pw); unlockedPass = pw; renderApp(); }
      catch { $('#lerr').textContent = tr('wrong passphrase'); $('#unlockBtn').disabled = false; $('#unlockBtn').textContent = tr('Unlock'); }
    }, 30);
  };
  $('#unlockBtn').onclick = go;
  $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ---------- main app ----------
// On the Freimarkets (nv3) network the wallet grows two extra tabs (Issue + Exchange); on every
// other network it stays a plain wallet. The product is titled "Freicoin"; the ƒ is its mark.
const MKT = () => curNet() === 'nv3';
function renderApp() {
  $('#app').innerHTML = `
    <header><h1 style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:600;font-size:26px;line-height:1;margin:0" title="Freicoin">ƒ</h1>
      <div class="hbtns"><button id="statusBtn" class="icon statusbtn st-sync" title="sync status">●</button></div></header>
    <div id="statusPop" hidden></div>
    <nav>
      <button data-tab="balance" class="active">${tr('Balance')}</button>
      <button data-tab="activity">${tr('Activity')}</button>
      ${MKT() ? `<button data-tab="exchange">${tr('Exchange')}</button>` : ''}
      <button data-tab="settings">⚙</button>
    </nav>
    <main>
      <section id="balance"></section><section id="activity" hidden></section>
      ${MKT() ? `<section id="exchange" hidden></section>` : ''}
      <section id="settings" hidden></section>
    </main>
    <div id="toast"></div>`;
  if (MKT() && unlockedSecret) mvSetSeed(hexSeed());   // hand the Freimarkets tabs the unlocked seed
  applyTheme(themeMode());
  // @ts-ignore  — false positive (DOM/Promise<void> under checkJs)
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
  $('#statusBtn').onclick = () => { const pop = $('#statusPop'); pop.hidden = !pop.hidden; if (!pop.hidden) renderStatusPop(); };
  // @ts-ignore  — false positive (DOM/Promise<void> under checkJs)
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
      if (!$('#activity').hidden) {
        const [h, btc] = await Promise.all([ds().history(), MKT() ? mvBtcHistory() : Promise.resolve(null)]);
        if (MKT() && btc) { btcActLegs = btc.legs; btcActHide = new Set(btc.hideFrc); btcActReady = true; }
        paintActivity(h.txs);
      }
      if (MKT()) mvRefresh();                             // keep the order book + asset balance fresh on nv3
    } catch (e) {
      // the poll must also self-heal (deep reorg / lost anchor) — otherwise a wallet that
      // hits the error HERE spins on "reconnecting" forever; and surface the REAL error
      // in the popover instead of a generic bridge message.
      if (await chainRecovery(e)) return;
      setStatus('retry', String(e?.message || 'bridge unreachable — retrying'));
    }
  }, 6000);
  // iOS freezes background tabs and kills the WebSocket — on wake, kick a sync immediately
  // instead of letting the user stare at "reconnecting" until the next poll tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && unlockedSecret) { getState(true).then(paintBalance).catch(() => {}); if (MKT()) mvRefresh(); }
  });
  const fromHash = location.hash.slice(1);
  const saved = store.get('fw_tab');
  const tabs = visibleTabs();
  const initial = tabs.includes(fromHash) ? fromHash : (tabs.includes(saved) ? saved : 'balance');
  history.replaceState(null, '', '#' + initial);   // normalize the URL without a spurious history entry
  show(initial);
}

const TABS = ['balance', 'activity', 'settings'];   // Receive/Send/Issue are modals now, not tabs
// the Exchange tab exists only on nv3; membership + which sections to hide are network-aware
const visibleTabs = () => MKT() ? ['balance', 'activity', 'exchange', 'settings'] : TABS;
const show = tab => {
  // @ts-ignore  — false positive (DOM/Promise<void> under checkJs)
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  visibleTabs().forEach(s => { const el = $('#' + s); if (el) el.hidden = s !== tab; });
  toast(''); render[tab]?.();
  store.set('fw_tab', tab);                                        // fallback when the URL has no tab
  if (location.hash.slice(1) !== tab) location.hash = tab;         // hash routing: survives reload + back/forward
};
// back/forward or an external #tab link switches the tab
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (visibleTabs().includes(t) && $('#' + t)?.hidden) show(t); });

const getState = async force => {
  if (!force && cache) return cache;
  cache = await ds().utxos();
  // Learn the wallet's birth height from the first completed scan (write-once per wallet):
  // a future rescan (e.g. the browser evicted IndexedDB) then skips straight to it.
  try {
    const fp = walletFp(myScripts());
    const cur = birthRec(fp);
    if (cache.birthAuto && (!cur || !cur.anchorH))   // learn once; upgrade legacy height-only records
      store.set('fw_ab:' + fp, JSON.stringify({ birth: cache.birthAuto, anchorH: cache.birthAnchor?.height, anchorHash: cache.birthAnchor?.hash }));
  } catch {}
  return cache;
};
const timeAgo = t => { const s = Math.max(0, Date.now() / 1000 - t); if (s < 60) return tr('just now'); if (s < 3600) return (s / 60 | 0) + tr('m ago'); if (s < 86400) return (s / 3600 | 0) + tr('h ago'); return new Date(t * 1000).toLocaleDateString(); };
const CAT = { send: '↑', receive: '↓', generate: '⛏', immature: '⛏', purchase: '⇄', sale: '⇄', swap: '⇄' };

// Latest streamed (partial/provisional) state — lets every tab show live data during a
// first sync, when there is no cache and nothing persisted to preview.
let liveState = null;

// Activity list painter — module-level so streamed partials can update the visible list.
let actLastHtml = '', actLastTxs = [], actDefs = {}, actGotFinal = false;
// BTC legs (from the relay's watch-only index) live on a SEPARATE chain than the FRC light client,
// so they aren't in ds().history(). Cache them here and always merge — otherwise any FRC-only
// repaint (the 6s poll, worker provisionals, preview) would wipe the BTC rows between fetches.
let btcActLegs = [];
let btcActHide = new Set();   // FRC txids replaced by a BTC trade row (raw HTLC legs must not show twice)
// On nv3 the FIRST paint waits for the BTC legs too (user preference: one complete list beats a
// fast FRC-only list that BTC rows pop into later). Until the first BTC fetch lands, every paint
// path — preview, worker provisionals, the poll — keeps the skeleton instead of a partial list.
let btcActReady = false;
const actFilter = { cat: '', cur: '' };
const actAssetName = tag => actDefs[tag]?.name || tag.slice(0, 8) + '…';
function paintActivity(txs, final = true) {
  if (final) actGotFinal = true;
  const sec = $('#activity');
  if (!sec || sec.hidden) return false;
  const list = $('#actList') || sec;   // filters live above the list; partials may land before render.activity
  if (MKT() && !btcActReady) { if (!list.querySelector('.skel')) list.innerHTML = skel(4); return false; }
  // A PROVISIONAL paint with an empty FRC history (mid-resync, e.g. reopening the tab) must not
  // show a BTC-only list — hold the skeleton until real FRC legs arrive or the FINAL paint says
  // the history is truly empty.
  if (!final && !txs.filter(t => !t.btc).length) { if (!list.querySelector('.skel')) list.innerHTML = skel(4); return false; }
  txs = [...txs.filter(t => !t.btc && !t.trade && !btcActHide.has(t.txid)), ...btcActLegs];   // FRC/asset legs (minus those a trade row replaces) + cached BTC legs/trades
  actLastTxs = txs;
  // A tx whose legs move DIFFERENT currencies in opposite directions is a trade — collapse
  // its legs into one Purchase/Sale/Swap item (display-level; the raw legs stay in history).
  // Cross-chain BTC trades arrive PRE-BUILT (mvBtcHistory) and skip the same-txid collapse.
  const byTx = new Map();
  for (const t of txs) { if (t.trade) continue; if (!byTx.has(t.txid)) byTx.set(t.txid, []); byTx.get(t.txid).push(t); }
  const items = [...txs.filter(t => t.trade)];
  for (const legs of byTx.values()) {
    const pos = legs.filter(l => +l.amount > 0), neg = legs.filter(l => +l.amount < 0);
    const curs = new Set(legs.map(l => l.assetTag ?? 'FRC'));
    if (curs.size > 1 && pos.length && neg.length) {
      const recv = pos[0], paid = neg[0];
      items.push({ trade: true, txid: recv.txid, recv, paid, time: recv.time,
        category: (recv.assetTag && !paid.assetTag) ? 'purchase' : (!recv.assetTag && paid.assetTag) ? 'sale' : 'swap',
        confirmations: Math.min(...legs.map(l => l.confirmations)) });
    } else items.push(...legs);
  }
  items.sort((a, b) => (b.time || 0) - (a.time || 0));   // newest first — interleave BTC legs by time, not at the end
  // the currency filter offers exactly what the history contains (options refresh in place,
  // selection preserved; a selection filtered out of existence falls back to 'all')
  const cur = $('#afCur');
  if (cur) {
    const opts = `<option value="">${tr('all')}</option><option value="FRC">FRC</option>`
      + (txs.some(t => t.btc || (t.trade && (t.recv?.btc || t.paid?.btc))) ? `<option value="BTC">BTC</option>` : '')
      + [...new Set(txs.map(t => t.assetTag).filter(Boolean))].map(tg => `<option value="${tg}">${actAssetName(tg)}</option>`).join('');
    if (cur.dataset.opts !== opts) {
      cur.dataset.opts = opts; const v = cur.value; cur.innerHTML = opts;
      cur.value = [...cur.options].some(o => o.value === v) ? v : '';
      if (cur.value !== actFilter.cur) actFilter.cur = cur.value;
    }
  }
  const shown = items.filter(i =>
    (!actFilter.cat || (i.trade ? actFilter.cat === 'trade'
      : actFilter.cat === 'generate' ? (i.category === 'generate' || i.category === 'immature') : i.category === actFilter.cat))
    && (!actFilter.cur || ((i.trade ? [i.recv, i.paid] : [i]).some(l => actFilter.cur === 'FRC' ? (!l.assetTag && !l.btc) : actFilter.cur === 'BTC' ? l.btc : l.assetTag === actFilter.cur))));
  const amtStr = t => t.btc
    ? `${(+t.amount) > 0 ? '+' : ''}${(+t.amount).toLocaleString(getLang(), { maximumFractionDigits: 8 })} <small>BTC</small>`
    : `${(+t.amount) > 0 ? '+' : ''}${fmt(t.amount / (t.assetTag ? 10 ** Number(actDefs[t.assetTag]?.decimals ?? 0) : 1))} <small>${t.assetTag ? actAssetName(t.assetTag) : 'FRC'}</small>`;
  const rowHtml = i =>
    `<div class="act-i ${i.trade ? 'trade' : i.category}">${CAT[i.category] || '•'}</div>
     <div class="act-m"><b>${tr(i.category)}</b><span class="sub">${i.confirmations > 0 ? '' : tr('pending') + ' · '}${timeAgo(i.time)}</span></div>
     ${i.trade
    ? `<div class="act-a"><span class="pos">${amtStr(i.recv)}</span><span class="neg">${amtStr(i.paid)}</span></div>`
    : `<div class="act-a ${(+i.amount) < 0 ? 'neg' : 'pos'}"><span>${amtStr(i)}</span></div>`}`;
  const detailHtml = i => `<div class="detail"><span class="sub">${i.confirmations > 0 ? i.confirmations + ' ' + tr('conf') : tr('pending')} · ${new Date(i.time * 1000).toLocaleString(getLang())}</span><span class="sub">txid</span><div class="txid">${i.txid}</div><button id="copyTxid" class="ghost">${tr('Copy txid')}</button></div>`;
  const keyOf = i => i.txid + '|' + (i.trade ? '#trade' : (i.assetTag ?? 'FRC') + '|' + i.category);

  // KEYED RECONCILE — update rows in place instead of rewriting the container, so a refresh
  // never resets the scroll position or closes the opened detail (that detail rides right
  // under its row and its confirmations stay live).
  if (!shown.length) {
    // an EMPTY provisional/preview just means the scan hasn't reached the wallet's history
    // yet — keep the skeleton shimmering instead of flashing "no transactions yet"
    if (!txs.length && !final) { if (!list.querySelector('.skel')) list.innerHTML = skel(4); return false; }
    list.innerHTML = `<div class="sub">${txs.length ? tr('nothing matches the filters') : tr('no transactions yet')}</div>`;
    return true;
  }
  [...list.children].forEach(n => { if (!n.classList?.contains('act') && n.id !== 'actDetail') n.remove(); });   // skeletons/placeholders
  const existing = new Map([...list.querySelectorAll('.act')].map(el => [el.dataset.key, el]));
  let anchor = null;   // last placed node; the next one goes right after it
  const place = node => { const want = anchor ? anchor.nextSibling : list.firstChild; if (node !== want) list.insertBefore(node, want); anchor = node; };
  for (const i of shown) {
    const k = keyOf(i), inner = rowHtml(i);
    let el = existing.get(k);
    if (el) existing.delete(k);
    else { el = document.createElement('div'); el.className = 'act'; el.dataset.key = k; }
    if (el._src !== inner) { el.innerHTML = inner; el._src = inner; }
    el.onclick = () => {   // (re)bound each paint — closes over the fresh item
      const open = $('#actDetail');
      const sameRow = open?.dataset.key === k;
      open?.remove();
      document.querySelector('.act.open')?.classList.remove('open');
      if (sameRow) return;
      el.classList.add('open');   // suppress the row's own rule — the detail carries the divider
      const d = document.createElement('div');
      d.id = 'actDetail'; d.dataset.key = k; d.innerHTML = detailHtml(i);
      el.insertAdjacentElement('afterend', d);
      $('#copyTxid').onclick = e => copy(i.txid, e.target);
    };
    place(el);
    const det = $('#actDetail');
    if (det?.dataset.key === k) {   // opened detail: keep it glued under its row, content live
      const dh = detailHtml(i);
      if (det._src !== dh) { det.innerHTML = dh; det._src = dh; det.querySelector('#copyTxid').onclick = e => copy(i.txid, e.target); }
      place(det);
    }
  }
  for (const el of existing.values()) el.remove();   // rows that left the filter/history
  const det = $('#actDetail');
  if (det && !list.querySelector(`.act[data-key="${(CSS?.escape ?? (s => s))(det.dataset.key)}"]`)) det.remove();
  return true;
}
// Self-healing for chain-level sync failures, shared by every tab that reads the source:
// returns true when the state was wiped and a re-render should retry.
async function chainRecovery(e) {
  const msg = String(e?.message || e);
  if (msg.includes('below the checkpoint')) {
    // the anchor was reorged out (very deep reorg): drop it and resync from scratch
    try { store.del('fw_ab:' + walletFp(myScripts())); } catch {}
    if (lightSrc) { lightSrc.close?.(); lightSrc = null; } cache = null; liveState = null;
    return true;
  }
  if (/do not connect|deep reorg/.test(msg)) {
    // the persisted header chain diverged from the node (an experimental chain was
    // rewound): wipe the stored chain and re-sync from genesis.
    try { await ds().reset(); } catch {}
    try { store.del('fw_ab:' + walletFp(myScripts())); } catch {}
    cache = null; liveState = null;
    return true;
  }
  return false;
}

// Send available line — ≈ marks unverified (streamed/preview) values.
function paintSendAvail(st, approx) {
  const el = $('#avail');
  if (el && st) el.textContent = `${tr('available ')}${approx ? '≈ ' : ''}${fmt(st.balance)} FRC`;   // full precision — this number is meant to be spent
}

// Render generation: bumped on every tab render; async callbacks from an older render
// (e.g. a sync rejected with 'closed' when Settings replaced the source) check it and
// bail instead of painting errors over the new render.
let renderGen = 0;

// Balance card painter — module-level so the worker's provisional events can repaint
// the visible balance screen outside a render.balance() call.
let balPainted = false;
// action buttons under the balance: Receive + Send (all networks), Issue asset (nv3 only) — each
// opens a modal instead of a tab.
const balActions = () => `<div class="row" style="margin-top:12px"><button id="rcvBtn">${tr('Receive')}</button><button id="sndBtn">${tr('Send')}</button></div>`
  + (MKT() ? `<div class="row"><button id="issBtn" class="ghost">${tr('Issue asset')}</button></div>
              <div class="row"><button id="faucetBtn" class="ghost">${tr('Faucet (+1 FRC)')}</button></div>` : '');
function wireBalActions() {
  const r = $('#rcvBtn'); if (r) r.onclick = () => render.receive();
  const s = $('#sndBtn'); if (s) s.onclick = () => render.send();
  const i = $('#issBtn'); if (i) i.onclick = openIssueModal;
}
function paintBalance(s) {
  if (!s.stale) setStatus('ok', '', s.tipHeight);
  else setStatus('sync', undefined, s.tipHeight);
  if (MKT()) return;   // Freimarkets balance is a per-asset table owned by market-view; only sync the status here
  if ($('#balance').hidden) return;
  balPainted = true;
  // build the card once; update fields in place afterwards (a full innerHTML rewrite per
  // streamed partial made the screen flicker)
  if (!$('#balBig')) {
    // Mainnet gets a gentle pointer at the experimental chain — assets, the exchange, the
    // faucet all live there; one tap switches (Settings switches back).
    const promo = curNet() === 'main'
      ? `<div class="promo"><span class="sub">${tr('Assets and the exchange live on the experimental Freimarkets chain — try them with free test coins.')}</span>
         <button id="tryFm" class="ghost">${tr('Try Freimarkets')}</button></div>`
      : '';
    $('#balance').innerHTML =
      `<div class="big" id="balBig"></div>
       <div class="sub" id="balPend"></div>` + balActions() + promo;
    wireBalActions();
    const t = $('#tryFm');
    if (t) t.onclick = () => {
      store.set('fw_net', 'nv3'); configureNetwork('nv3'); store.del('fw_bridge');
      if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
      cache = null; liveState = null; actLastHtml = ''; btcActLegs = []; btcActHide = new Set(); btcActReady = false;
      status.progress = {}; status.rx = 0; status.rxAt = 0; status.mbps = 0; status.utxos = null; status.tip = null;
      renderApp(); toast(tr('welcome to Freimarkets 🧪'));
    };
  }
  // no qualifier line: the header dot carries the state (amber = syncing/unverified,
  // green = verified) and the popover the details
  const pend = s.pending?.length ? s.pending.reduce((a, p) => a + p.amount, 0) : 0;
  status.utxos = s.utxos.length;           // detail lives in the status popover
  $('#balBig').innerHTML = `${fmtBal(s.balance)} <small>FRC</small>`;
  $('#balPend').textContent = pend ? `⏳ ${pend > 0 ? '+' : ''}${fmtBal(pend)} FRC ${tr('pending')} (${s.pending.length} tx)` : '';
}


const render = {
  async balance() {
    // Freimarkets (nv3): show per-asset holdings (FRC + user assets) + receiving address, not the
    // plain FRC number. market-view owns the table; the host-currency sync still drives the status.
    if (MKT()) {
      if (!$('#assetBalBody')) {
        $('#balance').innerHTML = `<div id="mktBal"></div>` + balActions();
        renderAssetBalance($('#mktBal'));   // per-asset table (+ dev faucet); the address lives in the Receive modal
        wireBalActions();
      }
      mvRefresh();
      try { paintBalance(await getState(true)); } catch { setStatus('retry', 'bridge unreachable — retrying'); }
      return;
    }
    const gen = ++renderGen;
    // First sync (nothing persisted yet): an honest placeholder — the balance is genuinely
    // unknown until the filter scan completes, so show that instead of a bare skeleton.
    if (!$('#balance').innerHTML) $('#balance').innerHTML =
      `<div class="big">— <small>FRC</small></div>
       <div class="sub">${tr('first sync…')}</div>`;
    balPainted = false;
    // Instant: last persisted state (no network) while the real sync runs.
    if (!cache) { try { const pv = await ds().preview(); if (gen === renderGen && pv) paintBalance(pv); } catch {} }
    try { const st = await getState(true); if (gen !== renderGen) return; paintBalance(st); }
    catch (e) {
      if (gen !== renderGen) return;   // stale render (source was replaced) — ignore
      if (await chainRecovery(e)) { render.balance(); return; }
      if (!balPainted) { setStatus('off', e.message); $('#balance').innerHTML = `<div class="err">${tr('sync failed — ')}${e.message}</div><button id="refresh" class="ghost">${tr('↻ Retry')}</button>`; $('#refresh').onclick = render.balance; return; }
      setStatus('retry', 'bridge unreachable — retrying');
    }
  },
  exchange() { renderExchange($('#exchange')); }, // Freimarkets: the ranged-offer order book
  async receive() {
    // Open in a loading state (shimmering QR + address placeholders), then fill in — the
    // same skeleton the tables use, so "get new address" visibly loads the fresh one.
    const btcOn = MKT() && mvBtc().available;
    openModal(tr('Receiving'),
      (btcOn ? `<label>${tr('Currency')}<select id="rcvCur"><option value="FRC">FRC</option><option value="BTC">BTC</option></select></label>` : '')
      + `<div id="qrBox" class="qr skel" style="margin:0 auto;height:220px"></div>
       <div class="addr" id="addr"><div class="skel-line" style="height:14px;width:85%;margin:3px auto"></div></div>
       <div class="row"><button id="copyAddr" class="ghost" disabled>⧉ ${tr('Copy')}</button></div>
       <div class="row" id="newAddrRow"><button id="newAddr" class="ghost">${tr('New address')}</button></div>`);
    // Fill the QR + address for the chosen currency. FRC = a fresh HD address; BTC = the single
    // (fixed) account address, so "New address" hides for BTC. derive+QR beat a frame, so the
    // skeleton floor keeps the shimmer visible on repeated switches/clicks.
    const fill = async isBtc => {
      const box0 = $('#qrBox'); if (box0) { box0.className = 'qr skel'; box0.innerHTML = ''; }
      const a0 = $('#addr'); if (a0) a0.innerHTML = `<div class="skel-line" style="height:14px;width:85%;margin:3px auto"></div>`;
      const cp0 = $('#copyAddr'); if (cp0) cp0.disabled = true;
      const nr = $('#newAddrRow'); if (nr) nr.hidden = isBtc;
      const t0 = performance.now();
      let addr; try { addr = isBtc ? mvBtcAddress() : deriveAddress(hexSeed(), recvIndex, 0); } catch (e) { return toast(e.message, 'err'); }
      const qr = await QRCode.toDataURL(addr.toUpperCase(), { margin: 1, width: 220 });
      await new Promise(r => setTimeout(r, Math.max(0, 350 - (performance.now() - t0))));
      const box = $('#qrBox'); if (!box) return;   // modal was closed mid-load
      box.className = 'qr'; box.innerHTML = `<img src="${qr}" alt="qr" style="width:100%;height:100%">`;
      $('#addr').textContent = addr;
      const cp = $('#copyAddr'); if (cp) { cp.disabled = false; cp.onclick = e => copy(addr, e.target); }
    };
    const cur = $('#rcvCur'); if (cur) cur.onchange = () => fill(cur.value === 'BTC');
    // Unbounded fresh FRC addresses: bump the index and repaint (skeleton shows at once), THEN —
    // off the click frame — grow the watch window: copy each network's birth record onto the
    // grown fingerprint (a fresh address has no history — the birth stays valid, no rescan)
    // and restart the light client on the wider script set. Doing the migration first froze
    // the click for the length of a few hundred HD derivations.
    $('#newAddr').onclick = () => {
      recvIndex++; store.set('fw_recv', recvIndex);
      fill(false);
      setTimeout(() => {
        const seed = hexSeed(), cur = curNet();
        try {
          for (const netK of Object.keys(NETWORKS)) {
            configureNetwork(netK);
            const rec = store.get('fw_ab:' + walletFp(walletScripts(seed, watchGap() - 1)));
            if (rec) store.set('fw_ab:' + walletFp(walletScripts(seed, watchGap())), rec);
          }
        } finally { configureNetwork(cur); }
        if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
        cache = null; ds();
      }, 60);
    };
    fill(false);
  },
  async send() {
    pending = null;
    openModal(tr('Send'),
      `<div class="sub" id="avail">${tr('available…')}</div>
       ${MKT() ? `<label>${tr('Asset')}<select id="sendAsset"><option value="">FRC</option></select></label>` : ''}
       <label>${tr('To address')}<input id="to" placeholder="fc1…" autocomplete="off"></label>
       <label id="amtLabel">${tr('Amount (FRC)')}<div class="amtrow"><input id="amt" type="number" step="0.00000001" min="0" placeholder="0.0"><button id="maxBtn" class="ghost">${tr('Max')}</button></div></label>
       <button id="reviewBtn">${tr('Review')}</button><div id="sendResult"></div>`);
    $('#reviewBtn').onclick = doReview;
    // Max dispatches on the selected currency: asset → its whole quantity; FRC → balance-fee
    let sendBal = null;
    $('#maxBtn').onclick = () => {
      const sel = $('#sendAsset');
      if (sel && sel.value === 'BTC') { const b = mvBtc().balance; $('#amt').value = b ? Math.max(0, (Number(BigInt(b)) - 1000) / 1e8).toFixed(8) : '0'; }
      else if (sel && sel.value) $('#amt').value = sel.selectedOptions[0].dataset.qty;
      else if (sendBal != null) $('#amt').value = Math.max(0, sendBal - 0.001).toFixed(8);
    };
    // Freimarkets: the selector offers every owned asset (+ BTC when a BTC account is available);
    // assets are integer tokens (scale 1), BTC uses its own (non-custodial, signet) send path.
    if (MKT()) mvOwnedAssets().then(list => {
      const sel = $('#sendAsset'); if (!sel) return;
      const btc = mvBtc();
      sel.innerHTML = `<option value="">FRC</option>` + list.map(a => `<option value="${a.tag}" data-qty="${a.qty}" data-dec="${a.decimals}">${a.name} (${a.qty.toLocaleString(getLang())})</option>`).join('')
        + (btc.available ? `<option value="BTC">BTC</option>` : '');
      sel.onchange = () => {
        const v = sel.value, isBtc = v === 'BTC', isFrc = !v, dec = +(sel.selectedOptions[0]?.dataset.dec || 0);
        $('#amtLabel').firstChild.textContent = isFrc ? tr('Amount (FRC)') : isBtc ? tr('Amount (BTC)') : tr('Quantity');
        const amt = $('#amt'); amt.step = isBtc || isFrc ? '0.00000001' : String(1 / 10 ** dec); amt.placeholder = isBtc || isFrc ? '0.0' : '0'; amt.value = '';
        $('#to').placeholder = isBtc ? `${btc.hrp}1…` : 'fc1…';
        $('#avail').style.display = isFrc ? '' : 'none';   // the FRC line doesn't describe an asset/BTC
      };
    }).catch(() => {});
    $('#amt').addEventListener('keydown', e => { if (e.key === 'Enter') doReview(); });
    // Instant: approximate available (verified cache > streamed partial > preview); live
    // partials keep it fresh; the verified value replaces it in place and binds Max.
    const seed = cache || liveState;
    if (seed) paintSendAvail(seed, !cache);
    else { try { const pv = await ds().preview(); if (pv) paintSendAvail(pv, true); } catch {} }
    const sendGen = renderGen;
    try { const s = await getState(); if (sendGen !== renderGen) return; paintBalance(s); paintSendAvail(s, false);
      sendBal = s.balance; }
    catch { if (sendGen !== renderGen) return; const el = $('#avail'); if (el && el.textContent === tr('available…')) el.textContent = ''; }
  },
  async activity() {
    const gen = ++renderGen;
    actLastHtml = ''; actGotFinal = false;
    // filter bar (type always; currency only where assets exist) + the list container
    $('#activity').innerHTML = `
      <div class="row actfix">
        <label>${tr('Type')}<select id="afCat">
          <option value="">${tr('all')}</option>
          <option value="receive">${tr('receive')}</option>
          <option value="send">${tr('send')}</option>
          ${MKT() ? `<option value="trade">${tr('trades')}</option>` : ''}
          <option value="generate">${tr('generate')}</option>
        </select></label>
        ${MKT() ? `<label>${tr('Asset')}<select id="afCur"><option value="">${tr('all')}</option><option value="FRC">FRC</option></select></label>` : ''}
      </div>
      <div id="actList">${skel(4)}</div>`;
    $('#afCat').value = actFilter.cat;
    $('#afCat').onchange = () => { actFilter.cat = $('#afCat').value; actLastHtml = ''; paintActivity(actLastTxs, actGotFinal); };
    if (MKT()) {
      const cur = $('#afCur');
      cur.onchange = () => { actFilter.cur = cur.value; actLastHtml = ''; paintActivity(actLastTxs, actGotFinal); };
      // scan-verified defs first; relay names fill the gaps (the wallet only learns defs
      // from blocks its own filters matched — a buyer never scans the issuer's issuance block).
      // The filter's OPTIONS are painted by paintActivity from the actual history.
      Promise.all([ds().assets(), mvRelayAssets().catch(() => [])]).then(([r, relay]) => {
        actDefs = { ...(r.assetDefs || {}) };
        for (const a of relay) if (a.name) { const d = (actDefs[a.tag] ??= {}); d.name ??= a.name; d.decimals ??= a.decimals; }
        actLastHtml = ''; paintActivity(actLastTxs, actGotFinal);   // rows/options painted before the defs arrived show raw tags
      }).catch(() => {});
    } else actFilter.cur = '';
    let painted = false;
    // Instant: verified cache > streamed partial > persisted preview; live partials keep
    // updating the list via the worker's provisional events while the sync runs.
    const seed = cache || liveState;
    if (seed) painted = paintActivity([...(seed.pending || []), ...(seed.history || [])], !!(cache && cache.history)) || painted;
    else { try { const pv = await ds().preview(); if (pv) painted = paintActivity([...pv.pending, ...pv.history], false) || painted; } catch {} }
    try {
      // both histories in parallel — the first real paint is the COMPLETE list (FRC + BTC)
      const [{ txs }, btc] = await Promise.all([ds().history(), MKT() ? mvBtcHistory() : Promise.resolve(null)]);
      if (gen !== renderGen) return;
      if (MKT() && btc) { btcActLegs = btc.legs; btcActHide = new Set(btc.hideFrc); btcActReady = true; }
      painted = paintActivity(txs) || painted;
      setStatus('ok');
    } catch (e) {
      if (gen !== renderGen) return;
      if (await chainRecovery(e)) { render.activity(); return; }   // deep reorg / lost anchor heal here too
      if (!painted) ($('#actList') || $('#activity')).innerHTML = `<div class="err">${e.message}</div>`;
    }
  },
  settings() {
    const vault = getVault(), s = secret();
    const kind = /\s/.test((s || '').trim()) ? tr('recovery phrase') : tr('hex seed');
    $('#settings').innerHTML =
      `<label>${tr('Language')}<select id="langSel">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${getLang() === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
       <label>${tr('Theme')}<select id="themeSel">${['system', 'dark', 'light'].map(m => `<option value="${m}"${themeMode() === m ? ' selected' : ''}>${m === 'system' ? tr('System') : m === 'dark' ? tr('Dark') : tr('Light')}</option>`).join('')}</select></label>
       <label>${tr('Network')}<select id="netSel">${Object.entries(NETWORKS).filter(([k, v]) => !v.hidden || k === curNet()).map(([k, v]) => `<option value="${k}"${k === curNet() ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
       <label>${tr('Bridge URL (neutrino P2P relay)')}<input id="br" value="${curBridge()}"></label>
       <label>${tr('Wallet secret')} (${kind})<textarea id="sd" rows="2" readonly>${'•'.repeat(24)}</textarea></label>
       <div class="row"><button id="revealSeed" class="ghost">${tr('Show')}</button><button id="copySeed" class="ghost">⧉ ${tr('Copy')}</button></div>
       <p class="warn">${vault ? tr('🔒 Secret is encrypted with your passphrase (AES-GCM). It is only decrypted in memory.') + ' ' + tr('Auto-locks after 5 minutes of inactivity.') : tr('⚠ Secret is stored unencrypted — set a passphrase to secure it.')}</p>
       <div class="row">${vault
          ? `<button id="lockBtn" class="ghost">${tr('🔓 Lock')}</button><button id="chgBtn" class="ghost">${tr('Change passphrase')}</button>`
          : `<button id="secBtn" class="ghost">${tr('🔒 Secure with passphrase')}</button>`}</div>
       <div id="secForm"></div>
       <div class="row"><button id="outBtn" class="ghost">${tr('Log out of wallet')}</button></div>`;
    $('#langSel').onchange = () => { setLang($('#langSel').value); renderApp(); };   // applies immediately, re-renders all
    $('#themeSel').onchange = () => { const t = $('#themeSel').value; store.set('fw_theme_mode', t); applyTheme(t); };   // applies immediately
    // Network/bridge apply immediately too: network on select (swapping in that network's
    // default bridge), bridge on leaving the field.
    $('#netSel').onchange = () => { $('#br').value = DEFAULT_BRIDGE[$('#netSel').value] || ''; applyNetSettings(); };
    $('#br').onchange = applyNetSettings;
    // The secret never sits in the DOM while masked — Show swaps the real value in.
    let revealed = false;
    $('#revealSeed').onclick = () => {
      revealed = !revealed;
      $('#sd').value = revealed ? s : '•'.repeat(24);
      $('#revealSeed').textContent = revealed ? tr('Hide') : tr('Show');
    };
    $('#copySeed').onclick = e => copy(s, e.target);
    if (vault) { $('#lockBtn').onclick = lock; $('#chgBtn').onclick = () => passForm(tr('Change passphrase'), pw => secure(secret(), pw, true)); }
    else $('#secBtn').onclick = () => passForm(tr('Set a passphrase'), pw => secure(s, pw, false));
    $('#outBtn').onclick = () => {
      const m = document.createElement('div'); m.id = 'modal';
      m.innerHTML = `<div class="review">
        <p class="warn">${tr('This removes the wallet from this device. Without the recovery phrase the funds are UNRECOVERABLE.')}</p>
        <div class="row"><button id="outYes">${tr('Log out & wipe')}</button><button id="outNo" class="ghost">${tr('Cancel')}</button></div></div>`;
      document.body.appendChild(m);
      m.onclick = e => { if (e.target === m) m.remove(); };   // tap outside the card = cancel
      // @ts-ignore  — false positive (DOM/Promise<void> under checkJs)
      m.querySelector('#outNo').onclick = () => m.remove();
      // @ts-ignore  — false positive (DOM/Promise<void> under checkJs)
      m.querySelector('#outYes').onclick = () => { m.remove(); logout(); };
    };
  },
};

function passForm(title, done) {
  $('#secForm').innerHTML =
    `<div class="review"><div class="label">${title}</div>
       <input id="p1" type="password" placeholder="${tr('passphrase')}">
       <input id="p2" type="password" placeholder="${tr('repeat passphrase')}">
       <div class="row"><button id="pOk">${tr('Encrypt')}</button><button id="pCancel" class="ghost">${tr('Cancel')}</button></div></div>`;
  $('#pOk').onclick = () => { const a = $('#p1').value, b = $('#p2').value;
    if (a.length < 4) return toast(tr('passphrase too short'), 'err');
    if (a !== b) return toast(tr('passphrases do not match'), 'err');
    done(a); };
  $('#pCancel').onclick = () => $('#secForm').innerHTML = '';
}

function secure(sec, pass, wasVault) {
  try { resolveSecret(sec); } catch (e) { return toast(e.message, 'err'); }
  store.set('fw_vault', JSON.stringify(encryptSecret(sec, pass)));
  store.del('fw_seed'); unlockedSecret = sec; unlockedPass = pass;
  toast(wasVault ? tr('passphrase changed') : tr('wallet secured 🔒')); render.settings();
}
function lock() { unlockedSecret = null; unlockedPass = null; clearInterval(pollTimer); renderLock(); }

function logout() {
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  // "Removes the wallet from this device" includes the synced history/UTXO cache —
  // financial data must not survive the seed. (Headers go with it; a later wallet
  // re-bootstraps from the checkpoint/snapshot.) Deletion waits out the worker's
  // closing connection via the store's versionchange self-close.
  try { Object.entries(NETWORKS).forEach(([k, v]) => indexedDB.deleteDatabase(`fw-light-${k}-${v.genesis.slice(0, 12)}`)); } catch {}
  ['fw_seed', 'fw_vault', 'fw_recv', 'fw_tab'].forEach(k => store.del(k));
  unlockedSecret = null; unlockedPass = null; cache = null; liveState = null; recvIndex = 0;
  clearInterval(pollTimer); pollTimer = null;
  renderWelcome();
}

function applyNetSettings() {
  const net = NETWORKS[$('#netSel').value] ? $('#netSel').value : DEFAULT_NET;
  store.set('fw_net', net); configureNetwork(net);
  const br = $('#br').value.trim();
  if (br && br !== DEFAULT_BRIDGE[net]) store.set('fw_bridge', br); else store.del('fw_bridge');   // keep the net default unless overridden
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  cache = null; liveState = null; actLastHtml = ''; btcActLegs = []; btcActHide = new Set(); btcActReady = false;   // same wallet — keep the receive index
  status.progress = {}; status.rx = 0; status.rxAt = 0; status.mbps = 0; status.utxos = null; status.tip = null;
  // Full rebuild: the old network's numbers must not linger, and the Freimarkets (Issue/Exchange)
  // tabs must appear or disappear as the network gains/loses nv3.
  renderApp();
  toast(tr('saved'));
}

async function doReview() {
  if ($('#sendAsset')?.value === 'BTC') return doReviewBtc();
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!isValidAddress(to)) return toast(tr('invalid Freicoin address'), 'err');
  if (!(amt > 0)) return toast(tr('enter an amount'), 'err');
  // Asset branch (Freimarkets): review, then sign+broadcast through the exchange machinery
  const assetTag = $('#sendAsset')?.value || null;
  if (assetTag) {
    const name = $('#sendAsset').selectedOptions[0].textContent.replace(/ \(.*\)$/, '');
    $('#sendResult').innerHTML =
      `<div class="review">
         <div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
         <div class="rrow"><span>${tr('Amount')}</span><b>${amt.toLocaleString(getLang())} ${name}</b></div>
         <div class="rrow"><span>${tr('Fee')}</span><b>0.00010000 FRC</b></div>
         <div class="row"><button id="confirmBtn">${tr('Confirm & broadcast')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>
       </div>`;
    $('#cancelBtn').onclick = () => { $('#sendResult').innerHTML = ''; toast(''); };
    $('#confirmBtn').onclick = async () => {
      const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
      try {
        const txid = await mvSendAsset(assetTag, amt, addrToSpk(to));
        $('#sendResult').innerHTML = `<div class="ok">${tr('Sent ✓')}</div><div class="txid">${txid}</div>`;
        $('#to').value = ''; $('#amt').value = ''; toast(tr('broadcast ✓'));
      } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Confirm & broadcast'); }
    };
    return;
  }
  toast(tr('building…')); $('#reviewBtn').disabled = true;
  try {
    const { utxos, tipHeight, balance } = await getState();
    if (amt > balance) throw new Error(`${tr('amount exceeds available')} (${fmt(balance)} FRC)`);
    const r = buildSignedTx({ seed: hexSeed(), utxos, toAddress: to, amountFrc: amt, tipHeight });
    pending = r.rawtx;
    $('#sendResult').innerHTML =
      `<div class="review">
         <div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
         <div class="rrow"><span>${tr('Amount')}</span><b>${fmt(amt)} FRC</b></div>
         <div class="rrow"><span>${tr('Fee')}</span><b>${(Number(r.fee) / 1e8).toFixed(8)} FRC</b></div>
         <div class="row"><button id="confirmBtn">${tr('Confirm & broadcast')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>
       </div>`;
    $('#confirmBtn').onclick = doBroadcast;
    $('#cancelBtn').onclick = () => { pending = null; $('#sendResult').innerHTML = ''; toast(''); };
    toast(tr('review the transaction'));
  } catch (e) { toast(e.message, 'err'); }
  finally { $('#reviewBtn').disabled = false; }
}

// BTC send review + confirm — signs locally in market-view, broadcasts via the relay (non-custodial).
async function doReviewBtc() {
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!mvBtcValidAddr(to)) return toast(tr('bad address'), 'err');
  if (!(amt > 0)) return toast(tr('enter an amount'), 'err');
  $('#sendResult').innerHTML =
    `<div class="review">
       <div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
       <div class="rrow"><span>${tr('Amount')}</span><b>${amt.toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC</b></div>
       <div class="rrow"><span>${tr('Fee')}</span><b>0.00001000 BTC</b></div>
       <div class="row"><button id="confirmBtn">${tr('Confirm & broadcast')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>
     </div>`;
  $('#cancelBtn').onclick = () => { $('#sendResult').innerHTML = ''; toast(''); };
  $('#confirmBtn').onclick = async () => {
    const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
    try {
      const txid = await mvSendBtc(to, amt);
      $('#sendResult').innerHTML = `<div class="ok">${tr('Sent ✓')}</div><div class="txid">${txid}</div>`;
      $('#to').value = ''; $('#amt').value = ''; toast(tr('broadcast ✓'));
    } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Confirm & broadcast'); }
  };
}

async function doBroadcast() {
  if (!pending) return;
  const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
  try {
    const { txid } = await ds().broadcast(pending);
    $('#sendResult').innerHTML = `<div class="ok">${tr('Sent ✓')}</div><div class="txid">${txid}</div>`;
    $('#to').value = ''; $('#amt').value = ''; pending = null; cache = null; toast(tr('broadcast ✓'));
  } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Confirm & broadcast'); }
}

// Auto-lock: with a vault present, an idle unlocked wallet locks itself after 5 minutes
// (activity = any pointer/key/touch on the page).
let lastActivity = Date.now();
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (getVault() && unlockedSecret && Date.now() - lastActivity > 5 * 60_000) lock();
}, 30_000);

// boot
configureNetwork(curNet());   // set NET/ACCOUNT before any address derivation
if (getVault()) renderLock();
else if (store.get('fw_seed')) { unlockedSecret = store.get('fw_seed'); renderApp(); }
else renderWelcome();
