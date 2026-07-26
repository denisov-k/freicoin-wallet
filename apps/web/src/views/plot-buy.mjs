// views/plot-buy.mjs — taking a plot over, in one place. A forced buy is the same act wherever it
// starts: from the map (a screen inside the picker) or from the exchange board (a modal). Both spend
// real money on a plot whose price its holder set, so both must say the same things in the same
// order — what the ground is, what it costs, what changes hands, and what to call it now.
import { $ } from '@/components/dom.mjs';
import { tr, getLang } from '@/services/i18n.mjs';

// same reading as the tables: the wallet's locale, up to the last kria
const frc = v => (Number(v) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 });

/** Fill `host` with the takeover screen and wire it.
 *  @param {{host:HTMLElement, plot:any, onCancel:()=>void, onDone:(plot:any)=>void}} o */
export function renderPlotBuy({ host, plot, onCancel, onDone }) {
  const price = frc(plot.price);
  const row = (k, v) => `<div class="rrow"><span>${k}</span><b>${v}</b></div>`;

  // Step one: what you are about to pay for. Step two: what to call it. Deciding on the ground and
  // naming it are two different thoughts, and the second one is easy to make once the first is made.
  function whatItIs() {
    host.innerHTML = `${plot.label ? row(tr('Name'), plot.label) : ''}
      ${row(tr('Where'), `${plot.centre.lat.toFixed(4)}, ${plot.centre.lon.toFixed(4)}`)}
      ${row(tr('Area'), `≈ ${Math.round(plot.area).toLocaleString(getLang())} ${tr('m²')}`)}
      ${row(tr('Forced-buy price'), `${price} FRC`)}
      <div class="mapwrap"><div class="mapbox"><div id="ipbMap"></div></div></div>
      <button id="ipbNext">${tr('Take it over')}</button>
      <button id="ipbNo" class="ghost">${tr('Cancel')}</button>`;
    drawMap();
    const no = $('#ipbNo'); if (no) no.onclick = onCancel;
    const next = $('#ipbNext'); if (next) next.onclick = naming;
  }

  // the ground itself, rather than a paragraph about it: same drawing as the picker, read-only,
  // fitted to the boundary with its neighbours in view
  async function drawMap() {
    const [{ mountPlotMap }, L] = await Promise.all([
      import('@/components/plotmap.mjs'), import('@/services/market/covenant-land.mjs')]);
    const el = $('#ipbMap'); if (!el) return;
    const plots = await L.livePlots().catch(() => []);
    const span = Math.max(1e-5, ...plot.points.map(a => Math.max(Math.abs(a.lat - plot.centre.lat) * 111320,
      Math.abs(a.lon - plot.centre.lon) * 111320 * Math.cos(plot.centre.lat * Math.PI / 180)))) * 2;
    const z = Math.max(3, Math.min(19, Math.log2(156543.03392 * Math.cos(plot.centre.lat * Math.PI / 180) * 100 / span)));
    mountPlotMap({ el, lat: plot.centre.lat, lon: plot.centre.lon, zoom: Math.round(z), height: 180,
      readonly: true, taken: () => (plots.length ? plots : [plot]), onChange: () => {} });
  }

  function naming() {
    // Prefilled with what it is called now: the name does not travel with the plot — the holder
    // publishes it — but confirming as it stands republishes the same name under your own hand.
    host.innerHTML = `${row(tr('Forced-buy price'), `${price} FRC`)}
      <label><span>${tr('Name')} <span class="sub">(${tr('optional')})</span></span><input id="ipbName" type="text" maxlength="24" autocomplete="off" spellcheck="false" value="${(plot.label || '').replace(/"/g, '&quot;')}" placeholder="${tr('e.g. the field by the river')}"></label>
      <p class="sub" style="font-size:12px">${tr('A plot is named by whoever holds it: confirming publishes this name under your own hand.')}</p>
      <div class="sub" id="ipbLog" style="font-size:12px;white-space:pre-line"></div>
      <button id="ipbYes">${tr('Confirm')}</button>
      <button id="ipbBack" class="ghost">${tr('← Back')}</button>`;
    const back = $('#ipbBack'); if (back) back.onclick = whatItIs;
    const log = t => { const el = $('#ipbLog'); if (el) el.textContent = t; };
    const yes = /** @type {HTMLButtonElement} */ ($('#ipbYes'));
    if (yes) yes.onclick = async () => {
      yes.disabled = true;
      try {
        const L = await import('@/services/market/covenant-land.mjs');
        const label = ($('#ipbName')?.value || '').trim() || null;
        if (label && L.plotLabelBytes(label) > L.MAX_PLOT_LABEL) throw new Error(tr('the name is too long'));
        await L.buyName({ name: plot.id, label, progress: p => log(p === 'done' ? tr('the plot is yours ✅') : tr('taking it over…')) });
        onDone({ ...plot, label });
      } catch (e) { log(tr(e.message)); yes.disabled = false; }
    };
  }

  whatItIs();
}
