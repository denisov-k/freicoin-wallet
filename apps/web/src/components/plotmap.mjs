// plotmap.mjs — drawing a plot the way land actually is: a boundary you trace, over a real map.
//
// The basemap comes from an external tile server, which is a deliberate trade: tiles make the map
// usable, and the server that serves them learns which area you are looking at. Nothing else about
// the wallet changes — no key, balance or transaction ever goes near it, and the tile URL is a
// setting, so it can be pointed at a community's own server (or switched off) later.
import { polygonArea, polygonCentre, polygonsOverlap, MAX_VERTICES } from '@core/geopoly.mjs';

const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TS = 256;
const lon2x = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);
const x2lon = (x, z) => x / Math.pow(2, z) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

/** Mount a plot drawer.
 *  @param {{el:HTMLElement, lat:number, lon:number, zoom?:number,
 *           taken:()=>{points:{lat:number,lon:number}[], mine:boolean}[],
 *           onChange:(pts:{lat:number,lon:number}[])=>void}} o */
export function mountPlotMap({ el, lat, lon, zoom = 18, taken, onChange }) {
  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:100%;height:300px;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block;cursor:crosshair';
  el.innerHTML = ''; el.appendChild(cv);
  const st = { lat, lon, z: zoom, pts: [] };
  const tiles = new Map();                                   // cached tile images, keyed z/x/y

  const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const size = () => ({ w: cv.clientWidth, h: cv.clientHeight });
  // screen ↔ world: the centre of the canvas is (st.lat, st.lon)
  const toScreen = p => { const { w, h } = size();
    return { x: w / 2 + (lon2x(p.lon, st.z) - lon2x(st.lon, st.z)) * TS, y: h / 2 + (lat2y(p.lat, st.z) - lat2y(st.lat, st.z)) * TS }; };
  const toWorld = (x, y) => { const { w, h } = size();
    return { lat: y2lat(lat2y(st.lat, st.z) + (y - h / 2) / TS, st.z), lon: x2lon(lon2x(st.lon, st.z) + (x - w / 2) / TS, st.z) }; };

  function tile(z, x, y) {
    const k = `${z}/${x}/${y}`;
    let img = tiles.get(k);
    if (!img) {
      img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => draw(); img.onerror = () => {};
      img.src = TILE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      tiles.set(k, img);
    }
    return img;
  }

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { w, h } = size();
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css('--card'); g.fillRect(0, 0, w, h);
    // basemap
    const cx = lon2x(st.lon, st.z), cy = lat2y(st.lat, st.z);
    const x0 = Math.floor(cx - w / 2 / TS), x1 = Math.floor(cx + w / 2 / TS);
    const y0 = Math.floor(cy - h / 2 / TS), y1 = Math.floor(cy + h / 2 / TS);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const n = Math.pow(2, st.z);
      if (y < 0 || y >= n) continue;
      const img = tile(st.z, ((x % n) + n) % n, y);
      if (img.complete && img.naturalWidth) g.drawImage(img, w / 2 + (x - cx) * TS, h / 2 + (y - cy) * TS, TS, TS);
    }
    // plots already taken, then the one being drawn
    const poly = (pts, stroke, fill) => {
      if (pts.length < 2) return;
      g.beginPath();
      pts.forEach((p, i) => { const s = toScreen(p); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
      g.closePath();
      if (fill) { g.fillStyle = fill; g.globalAlpha = .35; g.fill(); g.globalAlpha = 1; }
      g.strokeStyle = stroke; g.lineWidth = 2; g.stroke();
    };
    for (const t of taken() || []) poly(t.points, t.mine ? css('--ok') : css('--warn'), t.mine ? css('--ok') : css('--warn'));
    poly(st.pts, css('--accent'), css('--accent'));
    for (const p of st.pts) { const s = toScreen(p);
      g.beginPath(); g.arc(s.x, s.y, 5, 0, 7); g.fillStyle = css('--accent'); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    g.fillStyle = css('--sub'); g.font = '10px system-ui'; g.textAlign = 'right';
    g.fillText('© OpenStreetMap', w - 6, h - 6);
  }

  // tap adds a corner; tapping the first corner closes the shape; drag pans
  let down = null, moved = false;
  cv.onpointerdown = e => { down = { x: e.clientX, y: e.clientY, lat: st.lat, lon: st.lon }; moved = false; cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => {
    if (!down) return;
    if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) moved = true;
    if (!moved) return;
    const { w, h } = size();
    const b = cv.getBoundingClientRect();
    st.lon = x2lon(lon2x(down.lon, st.z) - (e.clientX - down.x) / TS, st.z);
    st.lat = y2lat(lat2y(down.lat, st.z) - (e.clientY - down.y) / TS, st.z);
    draw();
  };
  cv.onpointerup = e => {
    const wasDrag = moved; down = null;
    if (wasDrag) return;
    const b = cv.getBoundingClientRect();
    const p = toWorld(e.clientX - b.left, e.clientY - b.top);
    if (st.pts.length >= 3) {                                   // near the first corner ⇒ close
      const f = toScreen(st.pts[0]);
      if (Math.hypot(f.x - (e.clientX - b.left), f.y - (e.clientY - b.top)) < 14) { draw(); onChange(st.pts.slice()); return; }
    }
    if (st.pts.length >= MAX_VERTICES) return;
    st.pts.push(p); draw(); onChange(st.pts.slice());
  };
  cv.onwheel = e => { e.preventDefault(); setZoom(st.z + (e.deltaY > 0 ? -1 : 1)); };
  function setZoom(z) { const nz = Math.max(3, Math.min(19, z)); if (nz === st.z) return; st.z = nz; draw(); }

  const api = {
    draw, zoom: d => setZoom(st.z + d),
    centre(la, lo, z) { st.lat = la; st.lon = lo; if (z) st.z = z; draw(); },
    clear() { st.pts = []; draw(); onChange([]); },
    undo() { st.pts.pop(); draw(); onChange(st.pts.slice()); },
    points: () => st.pts.slice(),
    get area() { return st.pts.length >= 3 ? polygonArea(st.pts) : 0; },
    get centreOfPlot() { return st.pts.length ? polygonCentre(st.pts) : { lat: st.lat, lon: st.lon }; },
    overlapsAny: () => st.pts.length >= 3 && (taken() || []).some(t => polygonsOverlap(st.pts, t.points)),
  };
  draw();
  return api;
}
