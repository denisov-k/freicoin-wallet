// views/issue.mjs — issue a new on-chain asset, in one of three modes picked by a segmented
// switch: a CURRENCY (fungible amounts with a constant/melting/growing rate, live rate
// preview), TOKENS (a set of unique named items — tickets, memberships, keys — minted onto
// one coin), or a Freiland NAME (a registry slot: the same issuance under the hood — a unique
// land-NFT — plus a melting deposit whose demurrage IS the rent; see land.mjs registerName).
// Reads the live session/relay state from ctx; posts via the relay's issue endpoint.
import { $, q, num } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { armOverlay, closeOverlay } from '@/components/modal.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import { api, ctx, isCovenantNet } from '@/state/market-ctx.mjs';
import { mvRefresh, paintMyNames } from '@/views/exchange.mjs';
import { tickerId } from '@core/freiland.mjs';
import { mountPlotMap } from '@/components/plotmap.mjs';
import { renderPlotBuy } from '@/views/plot-buy.mjs';
import { mountMapSearch } from '@/components/mapsearch.mjs';
import { encodePolygon } from '@core/geopoly.mjs';
import { plotId } from '@core/freiland.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

let mode = 'a';   // 'a' = currency (amounts), 't' = tokens (unique items), 'n' = Freiland holding
let kind = 'name';   // holding sub-kind: 'name' (human-readable) | 'ticker' (asset symbol)
// The claimed id carries the namespace — a ticker is `ticker:USD`, a name is bare. Everything else
// (covenant, rent, forced buy) is identical, so the two kinds share the whole pipeline.
let plotPoints = [];   // the boundary being drawn (a plot's id is the hash of it)
const holdingId = raw => kind === 'ticker' ? tickerId(raw) : raw;

async function issue() {
  try {
    // a holding id is canonical (it is addressed by sha256, so case would fork it): names are
    // lower-case, tickers upper-case. Fold here too — autofill/paste can land a value without ever
    // firing the input handler.
    const raw = $('#iName').value.trim();
    const name = mode === 'n' ? holdingId(kind === 'ticker' ? raw.toUpperCase() : raw.toLowerCase()) : raw;
    if (!raw && !(mode === 'n' && kind === 'plot')) throw new Error(tr('enter a name'));
    // Freiland name: the full claim pipeline (mint land-NFT → deposit → standing offer →
    // register) — the registry machinery lives in land.mjs, this is only its issuance face
    if (mode === 'n') {
      // trustless covenant backend on a covenant-active network, else the relay MVP (dormant until deploy)
      const L = isCovenantNet()
        ? await import('@/services/market/covenant-land.mjs')
        : await import('@/services/market/land.mjs');
      let shape = null, label = null, id = name;
      if (kind === 'plot') {
        if (plotPoints.length < 3) throw new Error(tr('no plot drawn yet'));
        shape = encodePolygon(plotPoints);
        id = plotId(sha256(Buffer.from(shape, 'hex')).toString('hex'));
        // a plot's name is a label its holder publishes, not part of what the plot IS
        label = ($('#iPlotName')?.value || '').trim() || null;
        const LC = /** @type {any} */ (L);
        if (label && LC.plotLabelBytes?.(label) > (LC.MAX_PLOT_LABEL ?? 40)) throw new Error(tr('the name is too long'));
      }
      if (!L.validHoldingId(id)) throw new Error(tr(kind === 'ticker' ? 'bad ticker (2–10: A-Z 0-9)' : 'bad name (1–32: a-z 0-9 _ -)'));
      const v = num($('#iVal')?.value ?? '');
      const min = await L.minValueFrc();
      if (!(v >= min)) throw new Error(`${tr('minimum value is')} ${min} FRC`);
      const log = t => { const el = $('#iLog'); if (el) el.textContent = t; };
      const btn = $('#issueBtn'); if (btn) btn.disabled = true;
      try {
        await L.registerName(/** @type {any} */ ({ name: id, valueFrc: v, shape, label, progress: p => log(
          p === 'mint' ? tr('minting the name token…')
          : p === 'lock' ? tr('locking the deposit…')
          : p === 'confirm' ? tr('waiting for confirmation (this can take a few minutes)…')
          : p === 'offer' ? tr('signing the standing sale offer…')
          : tr('registered ✅')) }));
        $('#modal')?.remove();
        toast(`${kind === 'plot' ? (label || tr('Plot')) : raw}: ${tr('name claimed ✅')}`, 'ok'); mvRefresh(); paintMyNames();
      } catch (e) { log(e.message); throw e; }
      finally { const b = $('#issueBtn'); if (b) b.disabled = false; }
      return;
    }
    if (mode === 't') {
      const tokens = ($('#iToks')?.value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
      if (!tokens.length) throw new Error(tr('add at least one item'));
      if (tokens.length !== new Set(tokens).size) throw new Error(tr('token names must be unique'));
      // tokens ride one coin; the fungible side is a flat 1 unit per item (shift-64 interest
      // floors growth to exactly zero — truly constant, nothing to melt)
      await api('issue', { name, shift: 64, interest: true, amount: tokens.length, decimals: 0, spk: ctx.spks[0], tokens });
    } else {
      // 'constant' = shift-64 INTEREST: growth of 2^-64/block floors to exactly zero at any age
      // and any amount — truly flat. (The demurrage side would round ONE base unit off, which on
      // a whole-unit asset is a visible token.)
      const kind = $('#iKind').value;
      await api('issue', { name, shift: kind === 'c' ? 64 : Math.min(63, Math.max(1, Math.round(+$('#iShift').value || 16))), interest: kind === 'i' || kind === 'c', amount: $('#iAmt').value, decimals: $('#iDec')?.value ?? 0, spk: ctx.spks[0] });
    }
    $('#modal')?.remove();
    toast(`«${name}» ${tr('issued to your address')}`, 'ok'); mvRefresh();
  } catch (e) { toast(tr(e.message), 'err'); }
}

export function openIssueModal() {
  if ($('#modal')) return;
  mode = 'a';
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b id="issTitle">${tr('Issue asset')}</b><button id="issClose" class="icon">✕</button></div>
    <div class="seg" id="iMode">
      <button data-m="a" class="on">${tr('Currency')}</button>
      <button data-m="t">${tr('Token')}</button>
      <button data-m="n">${tr('Holding')}</button>
    </div>
    <div class="seg" id="iLandKind" hidden>
      <button data-k="name" class="on">${tr('name (human-readable)')}</button>
      <button data-k="ticker">${tr('ticker')}</button>
      <button data-k="plot">${tr('plot')}</button>
    </div>
    <p class="sub" id="iModeHint" style="font-size:12px">${tr('Fungible units — a local currency, points, labor hours. They divide, add up, and can stay constant, melt or grow at your rate.')}</p>
    <div id="iPlotBox" class="stack" hidden>
      <button id="iPickPlot" class="ghost">${tr('Choose the plot')}</button>
      <div class="sub" id="iCellInfo" style="font-size:12px"></div>
      <label><span>${tr('Name')} <span class="sub">(${tr('optional')})</span></span><input id="iPlotName" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="${tr('e.g. the field by the river')}"></label>
    </div>
    <div id="iMapScreen" class="stack" hidden>
      <div class="mapwrap">
        <div id="iSearch"></div>
        <div class="mapbox">
          <div id="iMap"></div>
          <div class="map-ctl map-ctl-z"><button id="iZoomIn" title="+">+</button><button id="iZoomOut" title="−">−</button></div>
          <div class="map-ctl map-ctl-edit"><button id="imUndo" title="${tr('Undo corner')}" disabled>↶</button><button id="imClear" title="${tr('Clear')}" disabled>🗑</button></div>
          <div class="map-ctl map-ctl-here"><button id="iHere" title="${tr('📍 Where I am')}">📍</button></div>
          <div class="map-ctl map-ctl-full"><button class="map-accept" id="imDoneFull" hidden>${tr('Accept')}</button><button id="imFull" title="${tr('Full screen')}">⤢</button></div>
          <div class="map-pill" id="iMapPill"></div>
        </div>
        <div class="map-sheet" id="iPlotCard" hidden></div>
      </div>
      <div class="sub" id="iMapInfo" style="font-size:12px"></div>
      <button id="imDone">${tr('Accept')}</button>
      <button id="imBack" class="ghost">${tr('← Back')}</button>
    </div>
    <div id="iBuyScreen" class="stack" hidden></div>
    <label id="iNameLbl">${tr('Name')}<input id="iName" maxlength="24" placeholder="${tr('e.g. labor-hours')}"></label>
    <div id="iFungible" class="stack">
      <div class="row">
        <label>${tr('Type')}<select id="iKind"><option value="c">${tr('constant')}</option><option value="d">${tr('melts')}</option><option value="i">${tr('grows')}</option></select></label>
        <label id="iRateLbl" hidden>${tr('Rate k')}<input id="iShift" type="number" value="16" min="1" max="63" step="1"></label>
      </div>
      <p class="sub" id="iRateHint" style="font-size:12px" hidden></p>
      <div class="row">
        <label>${tr('Quantity')}<input id="iAmt" type="number" value="1000000"></label>
        <label>${tr('Decimals')}<select id="iDec"><option value="2">0,01</option><option value="3">0,001</option><option value="0">${tr('whole only')}</option></select></label>
      </div>
      <p class="sub" id="iMeltHint" style="font-size:12px" hidden>${tr('Melting eats whole units on indivisible assets — decimals let it shave fractions instead.')}</p>
    </div>
    <div id="iTokensBox" class="stack" hidden>
      <label>${tr('Unique items (tokens)')}<textarea id="iToks" class="txt-ui" rows="4" placeholder="${tr('one per line')}"></textarea></label>
    </div>
    <div id="iLandBox" class="stack" hidden>
      <div class="sub" id="iAvail" style="font-size:12px"></div>
      <label>${tr('Self-assessed value')} (FRC)<input id="iVal" type="text" inputmode="decimal" placeholder="0.01+"></label>
      <div class="rrow"><span>${tr('Network fee')}</span><b id="iRent" class="sub">—</b></div>
    </div>
    <div id="iLog" class="sub" style="font-size:12px;white-space:pre-line"></div>
    <button id="issueBtn">${tr('Issue asset')}</button></div>`;
  document.body.appendChild(m);
  armOverlay(m);
  q(m, '#issClose').onclick = () => closeOverlay(m);
  q(m, '#issueBtn').onclick = issue;
  // mode switch: one form, three faces
  m.querySelectorAll('#iMode button').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => {
    mode = b.dataset.m;
    m.querySelectorAll('#iMode button').forEach(x => x.classList.toggle('on', x === b));
    $('#iFungible').hidden = mode !== 'a';
    $('#iTokensBox').hidden = mode !== 't';
    $('#iLandBox').hidden = mode !== 'n';
    $('#iLandKind').hidden = mode !== 'n';   // под-переключатель Имя/Тикер/Участок — сразу под классом
    const nameInp = /** @type {HTMLInputElement} */ ($('#iName'));
    nameInp.maxLength = mode === 'n' ? 32 : 24;   // land-имена до 32
    paintKind();
  });
  // holding sub-kind: name | ticker (plot pending). Both are the same covenant under different id
  // namespaces, so only the field's shape and the copy change.
  m.querySelectorAll('#iLandKind button').forEach((/** @type {HTMLButtonElement} */ b) => {
    if (b.disabled) return;
    b.onclick = () => {
      kind = b.dataset.k;
      m.querySelectorAll('#iLandKind button').forEach(x => x.classList.toggle('on', x === b));
      paintKind();
    };
  });
  function paintKind() {
    const tick = mode === 'n' && kind === 'ticker';
    const plot = mode === 'n' && kind === 'plot';
    const box = $('#iPlotBox'); if (box) box.hidden = !plot;
    const nl = $('#iNameLbl'); if (nl) nl.hidden = plot;   // a plot has no name: its id IS its boundary
    const inp = /** @type {HTMLInputElement} */ ($('#iName'));
    inp.maxLength = mode !== 'n' ? 24 : tick ? 10 : 32;
    inp.placeholder = mode !== 'n' ? tr('e.g. labor-hours') : tick ? 'USD' : 'alice';
    // A holding id is canonical, and the mobile keyboard fights it: it capitalises the first letter
    // of a name (which must be lower-case) and offers lower-case for a ticker (which must be upper).
    // Force the right shape instead of scolding the user.
    inp.setAttribute('autocapitalize', mode !== 'n' ? 'sentences' : tick ? 'characters' : 'none');
    if (plot) { mountMap(); paintCell(); syncPlotState(); }
    inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('spellcheck', 'false');
    $('#issueBtn').textContent = mode === 'n' ? tr(tick ? 'Claim the ticker' : plot ? 'Claim the plot' : 'Claim the name') : tr('Issue asset');
    $('#iModeHint').textContent = mode === 't'
      ? tr('Unique named items — tickets, memberships, keys. They do not melt, travel whole on one coin, and names must not repeat.')
      : mode === 'n'
        ? (plot
          ? tr('🗺 A plot is a boundary you draw on the map, held from the community: the id IS the shape, so a plot names the exact ground. Your deposit melts as rent and anyone can take the plot at the price you set.')
          : tick
          ? tr('🏷 A ticker is the short symbol an asset trades under. Held from the community like a name: nothing stops two issuers picking «USD», so the symbol goes to whoever values it enough to pay the rent.')
          : tr('🗺️ Freiland — a name held from the community: your deposit melts as rent, and anyone can buy it at your self-assessed price.'))
        : tr('Fungible units — a local currency, points, labor hours. They divide, add up, and can stay constant, melt or grow at your rate.');
    if (mode === 'n') $('#iName').dispatchEvent(new Event('input'));   // сразу проверить занятость
  }
  // what the drawn boundary is, in the form: size and whether it clashes with someone
  function paintCell() {
    const el = $('#iCellInfo'); if (!el) return;
    if (plotPoints.length < 3) { el.textContent = tr('no plot drawn yet'); el.style.color = ''; return; }
    const a = Math.round(map?.area || 0);
    const clash = map?.overlapsAny();
    el.textContent = `${plotPoints.length} ${tr('corners')} · ≈ ${a.toLocaleString(getLang())} ${tr('m²')}`
      + (clash ? ' · ' + tr('overlaps a taken plot') : '');
    el.style.color = clash ? 'var(--warn)' : '';
  }

  // ── plot flow: draw a boundary on the map, claim the ground it encloses ───────────────────────
  let map = null, mapPlots = [];
  // The map without the taken plots is a map that lies: it would warn about no overlap and answer
  // no questions. One load can come back empty (the registry hiccuped, the session was not awake
  // yet), so the list is refreshed whenever the map is shown and retried once if it came back bare.
  async function loadPlots({ retry = true } = {}) {
    if (!isCovenantNet()) return;
    const L = await import('@/services/market/covenant-land.mjs');
    const list = await L.livePlots().catch(() => []);
    if (list.length || !mapPlots.length) { mapPlots = list; map?.draw(); }
    if (!list.length && retry) setTimeout(() => loadPlots({ retry: false }), 2500);
  }

  async function mountMap(lat = 55.7558, lon = 37.6173) {
    const host = $('#iMap'); if (!host) return;
    await loadPlots();
    map = mountPlotMap({ el: host, lat, lon, taken: () => mapPlots, onInspect: showPlotCard, onChange: pts => {
      plotPoints = pts;
      paintMapInfo(pts);
      if (pts.length) closePlotCard();   // you started drawing: the card is in the way now
      paintCell(); syncPlotState(); syncMapCtl();
    } });
    paintMapInfo(map.points()); syncMapCtl();
  }

  // the same readout under the map and on it — in full screen the line below is off-screen
  function paintMapInfo(pts) {
    const clash = pts.length >= 3 && !!map?.overlapsAny();
    const txt = pts.length < 3 ? ''
      : `${pts.length} ${tr('corners')} · ≈ ${Math.round(map?.area || 0).toLocaleString(getLang())} ${tr('m²')}`
        + (clash ? ' · ' + tr('overlaps a taken plot') : '');
    for (const el of [$('#iMapInfo'), $('#iMapPill')]) if (el) { el.textContent = txt; el.style.color = clash ? 'var(--warn)' : ''; }
  }

  const syncMapCtl = () => {
    ['#imUndo', '#imClear'].forEach(sel => {
      const b = /** @type {HTMLButtonElement} */ ($(sel)); if (b) b.disabled = !plotPoints.length;
    });
    // full screen has no “Choose” below the map, so the map carries its own — once there is a
    // boundary to accept
    const done = $('#imDoneFull'); if (done) done.hidden = plotPoints.length < 3;
  };

  // a taken plot is a holding like any other: it says what it is, what it would cost to take over,
  // and lets you do it right here — «occupied» with no way to ask about it is just a coloured blob
  const frc = v => (Number(v) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  function closePlotCard() {
    const card = $('#iPlotCard'); if (!card || card.hidden) return;
    card.hidden = true; card.innerHTML = ''; map?.deselect();
    m.querySelector('.mapwrap')?.classList.remove('carded');
  }
  function showPlotCard(plot) {
    const card = $('#iPlotCard'); if (!card) return;
    const price = frc(plot.price);
    card.hidden = false;
    m.querySelector('.mapwrap')?.classList.add('carded');   // in full screen the card takes the pill's place
    card.innerHTML = `<div class="rrow"><b>${plot.mine ? tr('Your plot') : tr('Taken plot')}</b><button id="ipcX" class="icon">✕</button></div>
      <div class="rrow"><span>${tr('Area')}</span><b>≈ ${Math.round(plot.area).toLocaleString(getLang())} ${tr('m²')}</b></div>
      <div class="rrow"><span>${tr('Forced-buy price')}</span><b>${price} FRC</b></div>
      ${plot.mine ? '' : `<button id="ipcBuy">${tr('Take it over')}</button>`}`;
    const x = $('#ipcX'); if (x) x.onclick = closePlotCard;
    const buy = $('#ipcBuy');
    if (buy) buy.onclick = () => showBuyScreen(plot);
  }

  // Spending real money is not a thing to confirm in a corner of the map: the takeover gets the
  // whole modal — the screen itself is shared with the exchange board, so the same act reads the
  // same way wherever it starts.
  function showBuyScreen(plot) {
    const scr = $('#iBuyScreen'), mapScr = $('#iMapScreen'); if (!scr || !mapScr) return;
    m.querySelector('.mapwrap')?.classList.remove('full'); document.body.classList.remove('map-full');
    mapScr.hidden = true; scr.hidden = false;
    const ttl = $('#issTitle'); if (ttl) ttl.textContent = tr('Take the plot over');
    const back = () => { scr.hidden = true; scr.innerHTML = ''; mapScr.hidden = false;
      const t2 = $('#issTitle'); if (t2) t2.textContent = tr('Choose a plot'); map?.draw(); };
    renderPlotBuy({ host: scr, plot, onCancel: back, onDone: async () => {
      back(); closePlotCard();
      toast(tr('the plot is yours ✅'), 'ok');
      await mountMap(plot.centre.lat, plot.centre.lon);   // redraw the map off the new chain state
      paintMyNames();
    } });
  }

  // one place that decides what the plot form allows: no boundary ⇒ nothing to claim, said
  // plainly instead of failing later on a malformed id
  function syncPlotState() {
    if (kind !== 'plot') return;
    const btn = $('#issueBtn'); if (btn) btn.disabled = plotPoints.length < 3;
    const info = $('#iCellInfo');
    if (info && plotPoints.length < 3) info.textContent = tr('no plot drawn yet');
  }

  const mainEls = () => [$('#iPlotBox'), $('#iNameLbl'), $('#iLandBox'), $('#iLandKind'), $('#iMode'), $('#iModeHint'), $('#issueBtn')];
  const showMapScreen = on => {
    if (!on) { closePlotCard();
      const bs = $('#iBuyScreen'); if (bs) { bs.hidden = true; bs.innerHTML = ''; }
      m.querySelector('.mapwrap')?.classList.remove('full'); document.body.classList.remove('map-full');
      const fb = $('#imFull'); if (fb) { fb.textContent = '⤢'; fb.title = tr('Full screen'); } }
    mainEls().forEach(x => { if (x) x.hidden = on; });
    // coming back restores the form as it was, and a plot's form has no name field — its id IS its
    // boundary. Without this the «alice» input reappears the moment you leave the map.
    const nl = $('#iNameLbl'); if (nl && !on) nl.hidden = mode === 'n' && kind === 'plot';
    const ttl = $('#issTitle'); if (ttl) ttl.textContent = on ? tr('Choose a plot') : tr('Issue asset');
    const scr = $('#iMapScreen'); if (scr) scr.hidden = !on;
    if (on) { if (!map) mountMap(); else { map.draw(); loadPlots(); } }
  };

  const pickBtn = q(m, '#iPickPlot'); if (pickBtn) pickBtn.onclick = () => showMapScreen(true);
  const imBack = q(m, '#imBack'); if (imBack) imBack.onclick = () => showMapScreen(false);
  const accept = () => { showMapScreen(false); paintCell(); syncPlotState(); };
  const imDone = q(m, '#imDone'); if (imDone) imDone.onclick = accept;
  const imDoneFull = q(m, '#imDoneFull'); if (imDoneFull) imDoneFull.onclick = accept;
  const imUndo = q(m, '#imUndo'); if (imUndo) imUndo.onclick = () => { map?.undo(); syncMapCtl(); };
  const imClear = q(m, '#imClear'); if (imClear) imClear.onclick = () => { map?.clear(); syncMapCtl(); };
  const zi = q(m, '#iZoomIn'); if (zi) zi.onclick = () => map?.zoom(1);
  const zo = q(m, '#iZoomOut'); if (zo) zo.onclick = () => map?.zoom(-1);

  // full screen: iOS has no Fullscreen API for anything but video, so the map takes over the
  // viewport from inside the page — same element, same drawing, just given the whole screen
  const imFull = q(m, '#imFull');
  if (imFull) imFull.onclick = () => {
    const wrap = m.querySelector('.mapwrap'); if (!wrap) return;
    const on = wrap.classList.toggle('full');
    document.body.classList.toggle('map-full', on);
    imFull.textContent = on ? '⤡' : '⤢';
    imFull.title = tr(on ? 'Leave full screen' : 'Full screen');
    requestAnimationFrame(() => map?.draw());   // the canvas sizes itself from the new layout
  };

  const searchHost = q(m, '#iSearch');
  if (searchHost) mountMapSearch({ el: searchHost, onPick: p => map?.centre(p.lat, p.lon, 18) });

  const hereBtn = q(m, '#iHere');
  if (hereBtn) hereBtn.onclick = () => {
    if (!navigator.geolocation) return toast(tr('this device cannot report a position'), 'err');
    const el = $('#iCellInfo'); if (el) el.textContent = tr('locating…');
    navigator.geolocation.getCurrentPosition(
      pos => map?.centre(pos.coords.latitude, pos.coords.longitude),
      () => { const e2 = $('#iCellInfo'); if (e2) e2.textContent = tr('could not get your position — pan the map instead'); },
      { enableHighAccuracy: true, timeout: 10000 });
  };

  // Freiland-режим: живая проверка доступности имени + годовая рента от заявленной V
  let availT = null;
  q(m, '#iName').addEventListener('input', () => {
    if (mode !== 'n' || kind === 'plot') return;
    // canonicalise as you type: the id is addressed by sha256, so «Test» and «test» would be two
    // different holdings — and the keyboard fights the required case either way. Fold it silently.
    const inp = /** @type {HTMLInputElement} */ (q(m, '#iName'));
    const canon = kind === 'ticker' ? inp.value.toUpperCase() : inp.value.toLowerCase();
    if (inp.value !== canon) {
      const pos = inp.selectionStart;
      inp.value = canon;
      try { inp.setSelectionRange(pos, pos); } catch {}
    }
    const el = $('#iAvail'); if (el) { el.textContent = ''; el.style.color = ''; }
    if (kind === 'plot') { paintCell(); syncPlotState(); }
    clearTimeout(availT);
    const name = inp.value.trim();
    if (!name) return;
    availT = setTimeout(async () => {
      const L = isCovenantNet()
        ? await import('@/services/market/covenant-land.mjs')
        : await import('@/services/market/land.mjs');
      const id = holdingId(name);
      if (!L.validHoldingId(id)) { const e2 = $('#iAvail'); if (e2) { e2.textContent = tr(kind === 'ticker' ? 'bad ticker (2–10: A-Z 0-9)' : 'bad name (1–32: a-z 0-9 _ -)'); e2.style.color = 'var(--err)'; } return; }
      const addr = await L.resolveName(id); if (q(m, '#iName').value.trim() !== name) return;
      const e2 = $('#iAvail'); if (!e2) return;
      // A name taken by THIS seed (mine) is not "taken" from the owner's view — the chain keeps only
      // sha256(name), so a lost localStorage hides an owned name. Recover it into «my names» on sight.
      if (addr && isCovenantNet() && addr.mine) {
        const ok = await /** @type {any} */ (L).recoverName?.(id).catch(() => false);
        e2.textContent = ok ? tr('✓ your name — restored to «My names»') : tr('name taken');
        e2.style.color = ok ? 'var(--ok)' : 'var(--err)';
        if (ok) { try { paintMyNames(); } catch {} }
        return;
      }
      e2.textContent = addr ? tr('name taken') : tr('available'); e2.style.color = addr ? 'var(--err)' : 'var(--ok)';
    }, 400);
  });
  q(m, '#iVal').oninput = async () => {
    const v = num($('#iVal').value) || 0; const el = $('#iRent');
    const L = isCovenantNet()
      ? await import('@/services/market/covenant-land.mjs')
      : await import('@/services/market/land.mjs');
    if (el) el.textContent = v > 0 ? `≈ ${(Number(L.annualRent(BigInt(Math.round(v * 1e8)))) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 2 })} FRC/${tr('yr')}` : '—';
  };
  const rateHint = () => {
    const kind = $('#iKind').value, el = $('#iRateHint');
    el.hidden = kind === 'c';
    if (el.hidden) return;
    const k = Math.min(63, Math.max(1, Math.round(+$('#iShift').value || 16)));
    const perBlock = 2 ** -k;
    const blocksDay = 86400 / ((ctx.state?.info?.mineEveryMs ?? 20000) / 1000);
    const over = days => kind === 'd' ? 1 - (1 - perBlock) ** (blocksDay * days) : (1 + perBlock) ** (blocksDay * days) - 1;
    // extreme k values compound into astronomy — anything past 9 999% reads as "practically infinite"
    const f = x => { const pc = x * 100; return (!isFinite(pc) || pc > 9999) ? '∞' : pc.toLocaleString(getLang(), { maximumSignificantDigits: 3 }); };
    el.textContent = `≈ ${f(over(1))}% ${tr('per day')} · ≈ ${f(over(30))}% ${tr('per month')} · ≈ ${f(over(365))}% ${tr('per year')}`;
  };
  q(m, '#iShift').oninput = e => {   // hard-clamp typed values (min/max only guard the spinner)
    const v = e.target.value;
    if (v !== '') { const c = Math.min(63, Math.max(1, Math.round(+v || 1))); if (String(c) !== v) e.target.value = c; }
    rateHint();
  };
  q(m, '#iKind').onchange = e => {
    $('#iRateLbl').hidden = e.target.value === 'c';        // constant has no rate at all
    // rounding hint per type: melting EATS whole units; growth STALLS below a whole unit
    const hint = $('#iMeltHint');
    hint.hidden = e.target.value === 'c';
    if (!hint.hidden) hint.textContent = e.target.value === 'd'
      ? tr('Melting eats whole units on indivisible assets — decimals let it shave fractions instead.')
      : tr('Growth rounds down — small indivisible holdings stall until a whole unit accrues; decimals make it smooth.');
    rateHint();
  };
}
