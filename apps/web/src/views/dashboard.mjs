// views/dashboard.mjs — the two data-plane screens that render the wallet's live state: the
// Balance card and the Activity list. They share a display cache (BTC trade legs, asset defs,
// filter) and cross-reference (a net-switch from Balance resets Activity), so they live together
// and the shell store (cache/liveState/renderGen/status/ds/getState/chainRecovery/net) is injected
// via initDashboard — this module owns only the display cache, never the wallet data plane.
import { $, store, fmt, fmtBal, skel, copy } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import { mvBtc, refreshBtc, btcToStr } from '@/services/market/btc-account.mjs';
import { loadFeeTxids } from '@/services/storage.mjs';
import { renderAssetBalance, mvRefresh, mvRelayAssets, mvBtcHistory } from '@/views/exchange.mjs';
import { openIssueModal } from '@/views/issue.mjs';
import { renderReceive, renderSend } from '@/views/send.mjs';

/** shell store, injected by main.mjs */
let d;
export const initDashboard = deps => { d = deps; };

// ---- display cache (owned here) ----
const timeAgo = t => { const s = Math.max(0, Date.now() / 1000 - t); if (s < 60) return tr('just now'); if (s < 3600) return (s / 60 | 0) + tr('m ago'); if (s < 86400) return (s / 3600 | 0) + tr('h ago'); return new Date(t * 1000).toLocaleDateString(); };
const CAT = { send: '↑', receive: '↓', generate: '⛏', immature: '⛏', purchase: '⇄', sale: '⇄', swap: '⇄', fee: '•' };
// Freicoin coinbase maturity: a mined reward is unspendable until 100 blocks sit on top of it.
// Activity flags a 'generate' row as immature (with its N/100 progress) until then, so a user can
// see WHY a freshly-mined balance can't yet be sent or swapped.
const COINBASE_MATURITY = 100;
const isImmatureGen = i => i.category === 'generate' && i.confirmations > 0 && i.confirmations < COINBASE_MATURITY;
let balPainted = false;
let provBest = 0;   // best provisional FRC total shown so far (partials at low heights carry 0)
let actLastHtml = '', actLastTxs = [], actDefs = {}, actGotFinal = false;
// BTC legs (from the relay's watch-only index) live on a SEPARATE chain than the FRC light client,
// so they aren't in ds().history(). Cache them here and always merge.
let btcActLegs = [];
let btcActHide = new Set();   // FRC txids replaced by a BTC trade row (raw HTLC legs must not show twice)
let btcActReady = false;
const actFilter = { cat: '', cur: '' };
const actAssetName = tag => actDefs[tag]?.name || tag.slice(0, 8) + '…';

/** the net-switch / logout reset (matches applyNetSettings' subset — receive index survives) */
export const resetActivityCache = () => { actLastHtml = ''; btcActLegs = []; btcActHide = new Set(); btcActReady = false; };
/** the worker/history handler feeds in BTC trade legs */
export const setBtcLegs = btc => { btcActLegs = btc.legs; btcActHide = new Set(btc.hideFrc); btcActReady = true; };

// ---- balance card ----
const balActions = () => `<div class="row" style="margin-top:12px"><button id="rcvBtn">${tr('Receive')}</button><button id="sndBtn">${tr('Send')}</button></div>`
  + (d.MKT() ? `<div class="row"><button id="issBtn" class="ghost">${tr('Issue asset')}</button></div>
              <div class="row"><button id="faucetBtn" class="ghost">${tr('Faucet (+1 FRC)')}</button></div>` : '')
  // ⚡-счёт (LDK-узел в кошельке) — только mainnet: фид/LSP живут на прод-реле
  + (d.curNet() === 'main' ? `<div class="row"><button id="lnBtn" class="ghost">⚡ Lightning</button></div>` : '');
function wireBalActions() {
  const r = $('#rcvBtn'); if (r) r.onclick = () => renderReceive();
  const s = $('#sndBtn'); if (s) s.onclick = () => renderSend();
  const i = $('#issBtn'); if (i) i.onclick = openIssueModal;
  const l = $('#lnBtn'); if (l) {
    l.onclick = async () => (await import('@/views/lightning.mjs')).openLnModal();
    // включённый ранее ⚡-узел поднимается сам: при живом канале за цепью нужно следить всегда
    import('@/views/lightning.mjs').then(mod => mod.maybeAutoStartLn()).catch(() => {});
  }
}
export function paintBalance(s) {
  if (!s.stale) d.setStatus('ok', '', s.tipHeight);
  else d.setStatus('sync', undefined, s.tipHeight);
  if (d.SWAP()) {
    // The per-asset table is owned by market-view, whose data source resolves only when the
    // FULL sync lands — on a restore that left the checkpoint preview's instant balance
    // invisible (status said "ok 2097 FRC", the table stayed a skeleton). Until market-view
    // has real rows, paint the provisional FRC total straight into the table.
    const body = $('#assetBalBody');
    // keep repainting while the table holds only skeletons or OUR provisional row (#provRow) —
    // never once market-view has painted real rows (its rewrite drops the marker). The sweep's
    // early partials (balance 0) and the preview race; the larger figure must not be clobbered
    // by an older-height 0, so take the max the provisional stream has shown.
    // paint only once there is a NONZERO figure — an early sweep partial legitimately reports 0
    // long before the preview lands, and flashing "0" reads as "no money" (keep the skeleton).
    if (body && (body.querySelector('.skel-line') || $('#provRow'))) {
      // The balance figure takes only TRUSTWORTHY sources: restored (complete prior scan), the
      // checkpoint preview (a complete tail-window scan), the proofs-pending result (scan complete),
      // and live/final. The ONLY thing ignored is the mid-sweep 'sweep' emit, which OVERCOUNTS
      // (a from-genesis scan finds receives before their spends), so 15 climbed to 25→40. Everything
      // else is a real figure; the final table corrects any preview undercount once the scan lands.
      const trustworthy = s.stale !== 'sweep';
      if (trustworthy) provBest = +s.balance;
      // 0 in the provisional path means "still scanning, nothing shown yet", not "you have 0" —
      // keep the skeleton until a real figure exists (the final table legitimately shows a 0).
      if (provBest > 0) {
        const b = mvBtc();
        const rows = [`<tr><td>FRC</td><td class="r">${provBest.toLocaleString(getLang(), { maximumFractionDigits: 8 })}</td></tr>`];
        if (b.balance != null) rows.push(`<tr><td>BTC</td><td class="r">${btcToStr(b.balance)}</td></tr>`);   // relay-backed, needs no chain sync
        body.innerHTML = rows.join('') + `<tr id="provRow" hidden></tr>`;
      }
    }
    return;
  }
  if ($('#balance').hidden) return;
  balPainted = true;
  // build the card once; update fields in place afterwards (a full innerHTML rewrite per streamed
  // partial made the screen flicker)
  if (!$('#balBig')) {
    // Mainnet gets a gentle pointer at the experimental chain — one tap switches (Settings back).
    const promo = d.curNet() === 'main'
      ? `<div class="promo"><span class="sub">${tr('Assets and the exchange live on the experimental Freimarkets chain — try them with free test coins.')}</span>
         <button id="tryFm" class="ghost">${tr('Try Freimarkets')}</button></div>`
      : '';
    $('#balance').innerHTML =
      `<div class="big" id="balBig"></div>
       <div class="sub" id="balPend"></div>` + balActions() + promo;
    wireBalActions();
    const t = $('#tryFm');
    if (t) t.onclick = () => d.switchToFreimarkets();
  }
  // no qualifier line: the header dot carries the state and the popover the details
  const pend = s.pending?.length ? s.pending.reduce((a, p) => a + p.amount, 0) : 0;
  d.setStatusUtxos(s.utxos.length);           // detail lives in the status popover
  $('#balBig').innerHTML = `${fmtBal(s.balance)} <small>FRC</small>`;
  $('#balPend').textContent = pend ? `⏳ ${pend > 0 ? '+' : ''}${fmtBal(pend)} FRC ${tr('pending')} (${s.pending.length} tx)` : '';
}

export async function renderBalance() {
  // Freimarkets (nv3): show per-asset holdings, not the plain FRC number. market-view owns the
  // table; the host-currency sync still drives the status.
  if (d.SWAP()) {
    if (!$('#assetBalBody')) {
      provBest = 0;   // fresh table (new session/network) — forget the previous wallet's figure
      $('#balance').innerHTML = `<div id="mktBal"></div>` + balActions();
      renderAssetBalance($('#mktBal'));   // per-asset table (+ dev faucet); the address lives in Receive
      wireBalActions();
    }
    mvRefresh();
    try { refreshBtc(); } catch {}   // BTC account is relay-backed — paint it without waiting for the chain
    try { paintBalance(await d.getState(true)); } catch { d.setStatus('retry', 'bridge unreachable — retrying'); }
    return;
  }
  const gen = d.bumpGen();
  // First sync (nothing persisted yet): an honest placeholder.
  if (!$('#balance').innerHTML) $('#balance').innerHTML =
    `<div class="big">— <small>FRC</small></div>
     <div class="sub">${tr('first sync…')}</div>`;
  balPainted = false;
  // Instant: last persisted state (no network) while the real sync runs.
  if (!d.cacheReady()) { try { const pv = await d.ds().preview(); if (gen === d.renderGen() && pv) paintBalance(pv); } catch {} }
  try { const st = await d.getState(true); if (gen !== d.renderGen()) return; paintBalance(st); }
  catch (e) {
    if (gen !== d.renderGen()) return;   // stale render (source was replaced) — ignore
    if (await d.chainRecovery(e)) { renderBalance(); return; }
    if (!balPainted) { d.setStatus('off', e.message); $('#balance').innerHTML = `<div class="err">${tr('sync failed — ')}${e.message}</div><button id="refresh" class="ghost">${tr('↻ Retry')}</button>`; $('#refresh').onclick = renderBalance; return; }
    d.setStatus('retry', 'bridge unreachable — retrying');
  }
}

// ---- activity list ----
export function paintActivity(txs, final = true) {
  if (final) actGotFinal = true;
  const sec = $('#activity');
  if (!sec || sec.hidden) return false;
  const list = $('#actList') || sec;   // filters live above the list; partials may land before renderActivity
  // ONE synchronous first paint: hold EVERY activity render (provisional included) until the
  // relay's BTC trade legs are in — they are fetched EARLY now (seed-gated), so this costs ~1-2s
  // and the list appears complete at once instead of rows trickling in source by source.
  if (d.SWAP() && !btcActReady) { if (!list.querySelector('.skel')) list.innerHTML = skel(3); return false; }
  // A PROVISIONAL paint with an empty FRC history (mid-resync) must not show a BTC-only list — hold
  // the skeleton until real FRC legs arrive or the FINAL paint says the history is truly empty.
  if (!final && !txs.filter(t => !t.btc).length) { if (!list.querySelector('.skel')) list.innerHTML = skel(3); return false; }
  // ANTI-FLICKER. Two shapes to guard against, both from a paint whose source lags the true state:
  //   1) a cache snapshotted BEFORE a just-broadcast tx lacks its pending row;
  //   2) a thin PROVISIONAL (e.g. mempool-only, history not merged yet) has FEWER rows than shown.
  // A PROVISIONAL paint may only ADD — carry forward every prior row the incoming set lacks, so it
  // never shrinks the list. A FINAL paint is authoritative (full history+legs) and only carries a
  // recent pending the set doesn't yet know about; a confirmed/known txid in the set always wins.
  {
    const k = i => i.txid + '|' + (i.trade ? '#trade' : (i.assetTag ?? 'FRC') + '|' + i.category);
    const have = new Set(txs.map(k));
    const now = Date.now() / 1000;
    for (const p of actLastTxs) {
      if (have.has(k(p))) continue;
      if (!final || (p.confirmations === 0 && now - (p.time || now) < 3600)) txs = [...txs, p];
    }
  }
  // A cross-chain trade knows the raw FRC leg it replaces (frcTxid) — adopt that leg's real
  // time/confirmations before the leg itself is hidden. AMOUNTS stay the trade's NOMINAL ones.
  for (const t of btcActLegs) {
    if (!t.trade || !t.frcTxid) continue;
    const leg = txs.find(l => !l.btc && !l.assetTag && l.txid === t.frcTxid);
    if (!leg) continue;
    if (!t.time) t.time = leg.time;
    t.confirmations = leg.confirmations;
  }
  // a trade that never anchored to the chain (no real time after adopting its legs) is a phantom
  // from an incomplete/stale swap record — hide it instead of a 01.01.1970 ghost row
  txs = [...txs.filter(t => !t.btc && !t.trade && !btcActHide.has(t.txid)), ...btcActLegs.filter(t => !(t.trade && !t.time))];
  actLastTxs = txs;
  // A tx whose legs move DIFFERENT currencies in opposite directions is a trade — collapse its legs
  // into one Purchase/Sale/Swap item. Cross-chain BTC trades arrive PRE-BUILT and skip the collapse.
  const byTx = new Map();
  for (const t of txs) { if (t.trade) continue; if (!byTx.has(t.txid)) byTx.set(t.txid, []); byTx.get(t.txid).push(t); }
  const items = [...txs.filter(t => t.trade)];
  for (const legs of byTx.values()) {
    const pos = legs.filter(l => +l.amount > 0), neg = legs.filter(l => +l.amount < 0);
    const curs = new Set(legs.map(l => l.assetTag ?? 'FRC'));
    if (curs.size > 1 && pos.length && neg.length) {
      const recv = pos[0], paid = neg[0];
      const tAsset = recv.assetTag || paid.assetTag;   // the non-FRC side names the trade
      items.push({ trade: true, txid: recv.txid, recv, paid, time: recv.time,
        category: (recv.assetTag && !paid.assetTag) ? 'purchase' : (!recv.assetTag && paid.assetTag) ? 'sale' : 'swap',
        assetName: tAsset ? actAssetName(tAsset) : undefined,
        confirmations: Math.min(...legs.map(l => l.confirmations)) });
    } else items.push(...legs);
  }
  // exchange PLUMBING self-spends (give-coin consolidation, on-chain cancel): net-zero, only the
  // miner fee left — label it the NETWORK FEE it is, not a "send".
  const feeTx = new Set(loadFeeTxids());
  for (const i of items) if (!i.trade && feeTx.has(i.txid)) i.category = 'fee';
  items.sort((a, b) => (b.time || 0) - (a.time || 0));   // newest first — interleave BTC legs by time
  // the currency filter offers exactly what the history contains (options refresh in place)
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
    : t.unit   // pre-scaled leg (cross-chain trade): show verbatim with its own unit, don't re-divide
    ? `${(+t.amount) > 0 ? '+' : ''}${fmt(t.amount)} <small>${t.unit}</small>`
    : `${(+t.amount) > 0 ? '+' : ''}${fmt(t.amount / (t.assetTag ? 10 ** Number(actDefs[t.assetTag]?.decimals ?? 0) : 1))} <small>${t.assetTag ? actAssetName(t.assetTag) : 'FRC'}</small>`;
  const rowHtml = i =>
    `<div class="act-i ${i.trade ? 'trade' : i.category}${isImmatureGen(i) ? ' immature' : ''}">${CAT[i.category] || '•'}</div>
     <div class="act-m"><b>${tr(i.category)}</b><span class="sub">${timeAgo(i.time)}</span></div>
     ${i.trade
    ? `<div class="act-a"><span class="pos">${amtStr(i.recv)}</span><span class="neg">${amtStr(i.paid)}</span></div>`
    : `<div class="act-a ${(+i.amount) < 0 ? 'neg' : 'pos'}"><span>${amtStr(i)}</span>${isImmatureGen(i) ? `<span class="sub immature">${tr('immature')} ${i.confirmations}/${COINBASE_MATURITY}</span>` : i.confirmations === 0 ? `<span class="sub immature">${tr('confirming')} 0/1</span>` : i.note ? `<span class="sub">${tr(i.note)}</span>` : ''}</div>`}`;
  // per-leg id line: truncated hash + compact copy / open-in-explorer actions. A cross-chain trade
  // has TWO real txids (FRC leg + BTC leg) — its `txid` field is just the stable row key (often
  // the swap id), which no block explorer can resolve.
  const EXPL = {
    frc: () => d.curNet() === 'main' ? 'https://freicoin.ru/explorer/tx/' : null,
    btc: () => mvBtc().hrp === 'bc' ? 'https://mempool.space/tx/' : 'https://mempool.space/signet/tx/',
  };
  const abtn = 'width:auto;padding:5px 11px;font-size:14px;line-height:1';
  const legRow = (label, txid, base) => `<div style="display:flex;align-items:center;gap:8px">
      ${label ? `<span class="sub" style="min-width:30px">${label}</span>` : ''}
      <span class="txid" style="flex:1">${txid.length > 28 ? txid.slice(0, 12) + '…' + txid.slice(-12) : txid}</span>
      <button class="ghost copyTx" data-v="${txid}" title="${tr('Copy txid')}" aria-label="${tr('Copy txid')}" style="${abtn}">⧉</button>
      ${base ? `<a href="${base}${txid}" target="_blank" rel="noopener" title="${tr('Open in explorer')}" aria-label="${tr('Open in explorer')}"><button class="ghost" style="${abtn}" tabindex="-1">↗</button></a>` : ''}
    </div>`;
  const idsHtml = i => {
    if (i.trade && (i.frcTxid || i.btcLegTxid)) {
      return (i.orderId ? `<span class="sub">${tr('Order')} ${i.orderId}</span>` : '')
        + (i.frcTxid ? legRow('FRC', i.frcTxid, EXPL.frc()) : '')
        + (i.btcLegTxid ? legRow('BTC', i.btcLegTxid, EXPL.btc()) : '');
    }
    return legRow('', i.txid, i.trade ? null : (i.btc ? EXPL.btc() : EXPL.frc()));
  };
  const detailHtml = i => `<div class="detail"><span class="sub">${i.confirmations > 0 ? i.confirmations + ' ' + tr('conf') : tr('confirming') + ' 0/1'} · ${new Date(i.time * 1000).toLocaleString(getLang())}</span>${isImmatureGen(i) ? `<span class="sub immature">🔒 ${tr('immature')} · ${tr('spendable in')} ${COINBASE_MATURITY - i.confirmations} ${tr('blocks')}</span>` : ''}${idsHtml(i)}</div>`;
  const keyOf = i => i.txid + '|' + (i.trade ? '#trade' : (i.assetTag ?? 'FRC') + '|' + i.category);

  // KEYED RECONCILE — update rows in place instead of rewriting the container, so a refresh never
  // resets the scroll position or closes the opened detail.
  if (!shown.length) {
    if (!txs.length && !final) { if (!list.querySelector('.skel')) list.innerHTML = skel(3); return false; }
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
      const dd = document.createElement('div');
      dd.id = 'actDetail'; dd.dataset.key = k; dd.innerHTML = detailHtml(i);
      el.insertAdjacentElement('afterend', dd);
      dd.querySelectorAll('.copyTx').forEach(n => { const b = /** @type {HTMLElement} */ (n); b.onclick = e => copy(b.getAttribute('data-v'), e.target); });
    };
    place(el);
    const det = $('#actDetail');
    if (det?.dataset.key === k) {   // opened detail: keep it glued under its row, content live
      const dh = detailHtml(i);
      if (det._src !== dh) { det.innerHTML = dh; det._src = dh; det.querySelectorAll('.copyTx').forEach(n => { const b = /** @type {HTMLElement} */ (n); b.onclick = e => copy(b.getAttribute('data-v'), e.target); }); }
      place(det);
    }
  }
  for (const el of existing.values()) el.remove();   // rows that left the filter/history
  const det = $('#actDetail');
  if (det && !list.querySelector(`.act[data-key="${(CSS?.escape ?? (s => s))(det.dataset.key)}"]`)) det.remove();
  return true;
}

export async function renderActivity() {
  const gen = d.bumpGen();
  actLastHtml = ''; actGotFinal = false;
  // filter bar (type always; currency only where assets exist) + the list container
  $('#activity').innerHTML = `
    <div class="row actfix">
      <label>${tr('Type')}<select id="afCat">
        <option value="">${tr('all')}</option>
        <option value="receive">${tr('receive')}</option>
        <option value="send">${tr('send')}</option>
        ${d.SWAP() ? `<option value="trade">${tr('trades')}</option>` : ''}
        <option value="generate">${tr('generate')}</option>
      </select></label>
      ${d.MKT() ? `<label>${tr('Asset')}<select id="afCur"><option value="">${tr('all')}</option><option value="FRC">FRC</option></select></label>` : ''}
    </div>
    <div id="actList">${skel(3)}</div>`;
  $('#afCat').value = actFilter.cat;
  $('#afCat').onchange = () => { actFilter.cat = $('#afCat').value; actLastHtml = ''; paintActivity(actLastTxs, actGotFinal); };
  if (d.MKT()) {
    const cur = $('#afCur');
    cur.onchange = () => { actFilter.cur = cur.value; actLastHtml = ''; paintActivity(actLastTxs, actGotFinal); };
    // scan-verified defs first; relay names fill the gaps (the wallet only learns defs from blocks
    // its own filters matched). The filter OPTIONS are painted by paintActivity from the history.
    Promise.all([d.ds().assets(), mvRelayAssets().catch(() => [])]).then(([r, relay]) => {
      actDefs = { ...(r.assetDefs || {}) };
      for (const a of relay) if (a.name) { const dd = (actDefs[a.tag] ??= {}); dd.name ??= a.name; dd.decimals ??= a.decimals; }
      actLastHtml = ''; paintActivity(actLastTxs, actGotFinal);   // rows painted before defs arrived show raw tags
    }).catch(() => {});
  } else actFilter.cur = '';
  let painted = false;
  // BTC trade legs (relay-backed, no chain sync) gate the SWAP activity paint. Fetch them on their
  // OWN — NOT behind ds().history(), which awaits the full FRC sync — so the list unblocks during
  // the sweep instead of only after it. When they land, set the gate and repaint from the seed so
  // the preview's history shows at once. The persisted mempool means the seed already carries BOTH
  // confirmed and pending, so this single (early) legs fetch no longer causes the confirmed/pending
  // split the old duplicate fetch did.
  if (d.SWAP()) mvBtcHistory().then(btc => {
    if (gen !== d.renderGen() || !btc) return;
    setBtcLegs(btc);
    const s = d.seedState();
    if (s && s.history) paintActivity([...(s.pending || []), ...s.history], d.cacheReady());
  }).catch(() => {});
  // SEED (instant): the synced cache OR the restored snapshot (both carry history+pending). On a SWAP
  // net this paint is held until the legs land (above); a returning user's cache paints immediately.
  // The preview() fallback covers a first-ever load (no cache).
  const seed = d.seedState();
  if (seed && seed.history) painted = paintActivity([...(seed.pending || []), ...seed.history], d.cacheReady()) || painted;
  else { try { const pv = await d.ds().preview(); if (pv) painted = paintActivity([...pv.pending, ...pv.history], false) || painted; } catch {} }
  try {
    // FRC full history is authoritative (awaits the sync) — this final paint replaces the seed.
    const { txs } = await d.ds().history();
    if (gen !== d.renderGen()) return;
    painted = paintActivity(txs) || painted;
    d.setStatus('ok');
  } catch (e) {
    if (gen !== d.renderGen()) return;
    if (await d.chainRecovery(e)) { renderActivity(); return; }   // deep reorg / lost anchor heal here too
    if (!painted) ($('#actList') || $('#activity')).innerHTML = `<div class="err">${e.message}</div>`;
  }
}
