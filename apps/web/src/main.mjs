import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import QRCode from 'qrcode';
import { deriveAddress, buildSignedTx, resolveSecret, generateMnemonic, isValidAddress, walletScripts, configureNetwork, addrToSpk } from '@/services/wallet.mjs';
import { encryptSecret, decryptSecret } from '@/services/vault.mjs';
import { NETWORKS, DEFAULT_NET, DEFAULT_BRIDGE, DEFAULT_SNAPSHOT, DEFAULT_SNAPSHOT_FILTERS, CHECKPOINT } from '@/state/network-params.mjs';
import { tr, getLang, setLang, LANGS } from '@/services/i18n.mjs';
// Freimarkets (Issue + Exchange) — mounted as extra tabs only on the nv3 network.
import { initMarketView, mvSetSeed, mvRefresh, mvResetNet, renderExchange, renderAssetBalance, mvOwnedAssets, mvSendAsset, mvRelayAssets, mvBtc, mvBtcAddress, mvSendBtc, mvBtcValidAddr, mvBtcHistory } from '@/views/exchange.mjs';
import { loadFeeTxids, lsKey } from '@/services/storage.mjs';
import { enablePush, disablePush, pushSupported, pushEnabled } from '@/services/push.mjs';
import { btcExportKeys, btcToStr } from '@/services/market/btc-account.mjs';
import { $, store, short, fmt, fmtBal, copy, skel } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { openModal, closeOverlay } from '@/components/modal.mjs';
import { initAuth, renderWelcome, renderLock } from '@/views/auth.mjs';
import { initSettings, renderSettings } from '@/views/settings.mjs';
import { initSend, renderReceive, renderSend, paintSendAvail } from '@/views/send.mjs';
import { initDashboard, renderBalance, renderActivity, paintBalance, paintActivity, resetActivityCache, setBtcLegs } from '@/views/dashboard.mjs';

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
  let phases = PHASE_ORDER.filter(k => status.progress[k]).map(k => { const p = status.progress[k];
    return `<div class="rrow"><span>${tr(PHASE_LABEL[k])}</span><b>${(p.done ?? p.height).toLocaleString()} / ${(p.want ?? p.target).toLocaleString()}</b></div>`; }).join('');
  // checkpoint-preview diagnostics: shows whether the instant-balance path ran (or why not)
  if (status.progress.preview) phases += `<div class="rrow"><span>preview</span><b>${status.progress.preview.msg}</b></div>`;
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
    worker = new Worker(new URL('./services/light/worker.mjs', import.meta.url), { type: 'module' });
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
      seedDefs: (() => { try { return JSON.parse(store.get(lsKey('fw_reldefs')) || 'null'); } catch { return null; } })(),
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

// $/store/short/fmt/fmtBal/copy/skel → @/components/dom.mjs; toast → toast.mjs; openModal → modal.mjs
const getVault = () => { const v = store.get('fw_vault'); return v ? JSON.parse(v) : null; };

let unlockedSecret = null, unlockedPass = null;
const setSecret = (sec, pass = null) => { unlockedSecret = sec; unlockedPass = pass; };   // injected into views/auth
let recvIndex = +(store.get('fw_recv') || 0), pending = null, pollTimer = null, cache = null;
const secret = () => unlockedSecret;
const hexSeed = () => resolveSecret(unlockedSecret);
// Watch window: always 20 unused addresses beyond the highest handed-out receive index, so
// "get new address" works indefinitely without ever handing out an unwatched address.
const watchGap = () => recvIndex + 20;
const myScripts = () => walletScripts(hexSeed(), watchGap());
// After handing out a fresh receive address: grow the watch window — copy each network's birth
// record onto the grown fingerprint (a fresh address has no history, so the birth stays valid, no
// rescan) and restart the light client on the wider script set. Off the click frame so a few
// hundred HD derivations don't freeze the tap. Injected into views/send (the "New address" button).
function growWatchAfterNewAddr() {
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
}

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


// ---------- main app ----------
// On the Freimarkets (nv3) network the wallet grows two extra tabs (Issue + Exchange); on every
// other network it stays a plain wallet. The product is titled "Freicoin"; the ƒ is its mark.
const MKT = () => curNet() === 'nv3';
// Swap-enabled networks: nv3 (full assets+DEX+BTC), testnet (the BTC↔FRC swap REHEARSAL — real
// 10-min chains, no assets) and — since 2026-07-18, with the pruned BTC mainnet node synced —
// MAINNET (real BTC↔FRC swaps via /api-main). They get the Exchange tab, the BTC account and the
// swap drive; only nv3 (MKT) additionally gets Issue + the asset machinery.
const SWAP = () => MKT() || curNet() === 'test' || curNet() === 'main';
function renderApp() {
  $('#app').innerHTML = `
    <header><h1 style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:600;font-size:26px;line-height:1;margin:0" title="Freicoin">ƒ</h1>
      <div class="hbtns"><button id="statusBtn" class="icon statusbtn st-sync" title="sync status">●</button></div></header>
    <div id="statusPop" hidden></div>
    <nav>
      <button data-tab="balance" class="active">${tr('Balance')}</button>
      <button data-tab="activity">${tr('Activity')}</button>
      ${SWAP() ? `<button data-tab="exchange">${tr('Exchange')}</button>` : ''}
      <button data-tab="settings">⚙</button>
    </nav>
    <main>
      <section id="balance"></section><section id="activity" hidden></section>
      ${SWAP() ? `<section id="exchange" hidden></section>` : ''}
      <section id="settings" hidden></section>
    </main>
    <div id="toast"></div>`;
  if (SWAP() && unlockedSecret) mvSetSeed(hexSeed());   // hand the Freimarkets tabs the unlocked seed
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
        const [h, btc] = await Promise.all([ds().history(), SWAP() ? mvBtcHistory() : Promise.resolve(null)]);
        if (SWAP() && btc) setBtcLegs(btc);
        paintActivity(h.txs);
      }
      if (SWAP()) mvRefresh();                             // keep the order book + asset balance fresh on nv3
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
    if (!document.hidden && unlockedSecret) { getState(true).then(paintBalance).catch(() => {}); if (SWAP()) mvRefresh(); }
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
const visibleTabs = () => SWAP() ? ['balance', 'activity', 'exchange', 'settings'] : TABS;
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

// Latest streamed (partial/provisional) state — lets every tab show live data during a
// first sync, when there is no cache and nothing persisted to preview.
let liveState = null;

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

// Render generation: bumped on every tab render; async callbacks from an older render
// (e.g. a sync rejected with 'closed' when Settings replaced the source) check it and
// bail instead of painting errors over the new render.
let renderGen = 0;



const render = {
  balance: renderBalance,
  exchange() { renderExchange($('#exchange')); }, // Freimarkets: the ranged-offer order book
  receive: renderReceive,
  send: renderSend,
  activity: renderActivity,
  settings: renderSettings,
};

function passForm(title, done) {
  const m = openModal(title,
    `<input id="p1" type="password" placeholder="${tr('passphrase')}">
     <input id="p2" type="password" placeholder="${tr('repeat passphrase')}">
     <div class="row"><button id="pOk">${tr('Encrypt')}</button><button id="pCancel" class="ghost">${tr('Cancel')}</button></div>`);
  const q = s => m.querySelector(s);
  q('#pOk').onclick = () => { const a = q('#p1').value, b = q('#p2').value;
    if (a.length < 4) return toast(tr('passphrase too short'), 'err');
    if (a !== b) return toast(tr('passphrases do not match'), 'err');
    closeOverlay(m); done(a); };
  q('#pCancel').onclick = () => closeOverlay(m);
}

function secure(sec, pass, wasVault) {
  try { resolveSecret(sec); } catch (e) { return toast(e.message, 'err'); }
  store.set('fw_vault', JSON.stringify(encryptSecret(sec, pass)));
  store.del('fw_seed'); unlockedSecret = sec; unlockedPass = pass;
  toast(wasVault ? tr('passphrase changed') : tr('wallet secured 🔒')); render.settings();
}
function lock() { unlockedSecret = null; unlockedPass = null; try { mvSetSeed(null); } catch {} clearInterval(pollTimer); renderLock(); }

function logout() {
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  // "Removes the wallet from this device" includes the synced history/UTXO cache —
  // financial data must not survive the seed. (Headers go with it; a later wallet
  // re-bootstraps from the checkpoint/snapshot.) Deletion waits out the worker's
  // closing connection via the store's versionchange self-close.
  try { Object.entries(NETWORKS).forEach(([k, v]) => indexedDB.deleteDatabase(`fw-light-${k}-${v.genesis.slice(0, 12)}`)); } catch {}
  ['fw_seed', 'fw_vault', 'fw_recv', 'fw_tab'].forEach(k => store.del(k));
  unlockedSecret = null; unlockedPass = null; try { mvSetSeed(null); } catch {} cache = null; liveState = null; recvIndex = 0;
  clearInterval(pollTimer); pollTimer = null;
  renderWelcome();
}

function applyNetSettings() {
  const net = NETWORKS[$('#netSel').value] ? $('#netSel').value : DEFAULT_NET;
  store.set('fw_net', net); configureNetwork(net);
  const br = $('#br').value.trim();
  if (br && br !== DEFAULT_BRIDGE[net]) store.set('fw_bridge', br); else store.del('fw_bridge');   // keep the net default unless overridden
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  cache = null; liveState = null; resetActivityCache();   // same wallet — keep the receive index
  status.progress = {}; status.rx = 0; status.rxAt = 0; status.mbps = 0; status.utxos = null; status.tip = null;
  mvResetNet();   // the exchange/BTC snapshot too — else the OLD net's balance table paints until fresh data lands
  // Full rebuild: the old network's numbers must not linger, and the Freimarkets (Issue/Exchange)
  // tabs must appear or disappear as the network gains/loses nv3.
  renderApp();
  toast(tr('saved'));
}

// The Balance card's "Try Freimarkets" pointer: force the nv3 network with the same data-plane
// teardown as a network switch. Injected into views/dashboard.
function switchToFreimarkets() {
  store.set('fw_net', 'nv3'); configureNetwork('nv3'); store.del('fw_bridge');
  if (lightSrc) { lightSrc.close?.(); lightSrc = null; }
  mvResetNet();
  cache = null; liveState = null; resetActivityCache();
  status.progress = {}; status.rx = 0; status.rxAt = 0; status.mbps = 0; status.utxos = null; status.tip = null;
  renderApp(); toast(tr('welcome to Freimarkets 🧪'));
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
initAuth({ renderApp, recordNewWalletBirth, getVault, setSecret });   // wire the auth screens' deps
initDashboard({ SWAP, MKT, curNet, getState, ds, setStatus, setStatusUtxos: n => { status.utxos = n; }, chainRecovery,
  cacheReady: () => !!cache, seedState: () => cache || liveState, bumpGen: () => ++renderGen, renderGen: () => renderGen, switchToFreimarkets });
initSettings({ getVault, secret, themeMode, applyTheme, curNet, curBridge, SWAP, renderApp, applyNetSettings, lock, passForm, secure, logout });
initSend({ hexSeed, recvIndex: () => recvIndex, bumpRecv: () => { recvIndex++; store.set('fw_recv', recvIndex); }, growWatchAfterNewAddr,
  getPending: () => pending, setPending: v => { pending = v; }, resetCache: () => { cache = null; }, cacheReady: () => !!cache,
  seedState: () => cache || liveState, renderGen: () => renderGen, getState, ds, paintBalance, SWAP, MKT });
configureNetwork(curNet());   // set NET/ACCOUNT before any address derivation
if (getVault()) renderLock();
else if (store.get('fw_seed')) { unlockedSecret = store.get('fw_seed'); renderApp(); }
else renderWelcome();
