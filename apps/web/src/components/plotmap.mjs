// plotmap.mjs — picking a plot by looking at the ground, not by typing a geohash.
//
// A canvas, not a slippy map: the wallet talks to nobody but its own relay, and loading tiles would
// hand a third party the one thing a land map leaks — where you are looking. So the drawing is the
// GRID itself: the cells at the current zoom, what is taken, what is yours, where you stand. You
// see structure rather than streets, which is what choosing a cell actually needs.
import { geohashEncode, geohashDecode, geohashSize } from '@core/geohash.mjs';

// geohash bits alternate lon/lat, so odd precisions are 8x4 within their parent and even ones 4x8;
// stepping by whole characters keeps every drawn cell aligned to a real id.
const cellSpan = prec => {
  const c = geohashDecode(geohashEncode(0, 0, prec));
  return { dLat: c.latMax - c.latMin, dLon: c.lonMax - c.lonMin };
};

/** Mount a plot picker into `el`.
 *  @param {{el:HTMLElement, lat:number, lon:number, precision:number,
 *           taken:()=>{cell:string, mine:boolean}[], onPick:(cell:string)=>void}} o */
export function mountPlotMap({ el, lat, lon, precision, taken, onPick }) {
  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:100%;height:260px;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block';
  el.innerHTML = ''; el.appendChild(cv);
  const state = { lat, lon, prec: precision, sel: geohashEncode(lat, lon, precision) };

  const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { dLat, dLon } = cellSpan(state.prec);
    const cols = 9, rows = Math.max(3, Math.round(cols * h / w));          // odd ⇒ the centre is a cell
    const cw = w / cols, ch = h / rows;
    const t = new Map((taken() || []).map(x => [x.cell, x]));
    g.font = '10px ui-monospace, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const clat = state.lat + (Math.floor(rows / 2) - r) * dLat;
      const clon = state.lon + (c - Math.floor(cols / 2)) * dLon;
      const cell = geohashEncode(clat, clon, state.prec);
      const hit = t.get(cell);
      const x = c * cw, y = r * ch;
      g.fillStyle = hit ? (hit.mine ? css('--ok') : css('--warn')) : css('--card');
      g.globalAlpha = hit ? 0.55 : 1; g.fillRect(x, y, cw - 1, ch - 1); g.globalAlpha = 1;
      if (cell === state.sel) { g.strokeStyle = css('--accent'); g.lineWidth = 2; g.strokeRect(x + 1, y + 1, cw - 3, ch - 3); }
      else { g.strokeStyle = css('--line'); g.lineWidth = 1; g.strokeRect(x + .5, y + .5, cw - 2, ch - 2); }
      if (cw > 46) { g.fillStyle = css('--sub'); g.fillText(cell.slice(-2), x + cw / 2, y + ch / 2); }
    }
    cv.onclick = ev => {
      const b = cv.getBoundingClientRect();
      const c = Math.floor((ev.clientX - b.left) / cw), r = Math.floor((ev.clientY - b.top) / ch);
      const clat = state.lat + (Math.floor(rows / 2) - r) * dLat;
      const clon = state.lon + (c - Math.floor(cols / 2)) * dLon;
      state.sel = geohashEncode(clat, clon, state.prec);
      draw(); onPick(state.sel);
    };
  }

  // pan by drag, zoom by wheel/pinch — zoom changes the PRECISION, i.e. the size of a plot
  let drag = null;
  cv.onpointerdown = e => { drag = { x: e.clientX, y: e.clientY, lat: state.lat, lon: state.lon }; cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => {
    if (!drag) return;
    const { dLat, dLon } = cellSpan(state.prec);
    const cw = cv.clientWidth / 9, ch = cv.clientHeight / Math.max(3, Math.round(9 * cv.clientHeight / cv.clientWidth));
    state.lat = drag.lat + (e.clientY - drag.y) / ch * dLat;
    state.lon = drag.lon - (e.clientX - drag.x) / cw * dLon;
    draw();
  };
  cv.onpointerup = () => { drag = null; };
  cv.onwheel = e => { e.preventDefault(); zoom(e.deltaY > 0 ? -1 : 1); };

  function zoom(d) {
    const p = Math.max(1, Math.min(12, state.prec + d));
    if (p === state.prec) return;
    state.prec = p; state.sel = geohashEncode(state.lat, state.lon, p);
    draw(); onPick(state.sel);
  }
  const api = {
    draw,
    zoom,
    center(la, lo, prec) { state.lat = la; state.lon = lo; if (prec) state.prec = prec; state.sel = geohashEncode(la, lo, state.prec); draw(); onPick(state.sel); },
    select(cell) { try { const c = geohashDecode(cell); state.lat = c.lat; state.lon = c.lon; state.prec = cell.length; state.sel = cell; draw(); } catch {} },
    get precision() { return state.prec; },
    get size() { return geohashSize(state.sel); },
  };
  draw();
  return api;
}
