// plotmap.mjs — drawing a plot the way land actually is: a boundary you trace, over a real map.
//
// The basemap comes from an external tile server, which is a deliberate trade: tiles make the map
// usable, and the server that serves them learns which area you are looking at. Nothing else about
// the wallet changes — no key, balance or transaction ever goes near it, and the tile URL is a
// setting, so it can be pointed at a community's own server (or switched off) later.
import { polygonArea, polygonCentre, polygonsOverlap, pointInPolygon, MAX_VERTICES } from '@core/geopoly.mjs';

const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TS = 256;
const lon2x = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);
const x2lon = (x, z) => x / Math.pow(2, z) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

/** Mount a plot drawer.
 *  @param {{el:HTMLElement, lat:number, lon:number, zoom?:number,
 *           taken:()=>{points:{lat:number,lon:number}[], mine:boolean, area?:number}[],
 *           onChange:(pts:{lat:number,lon:number}[])=>void,
 *           onInspect?:(plot:any)=>void}} o */
export function mountPlotMap({ el, lat, lon, zoom = 18, taken, onChange, onInspect = null }) {
  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:100%;height:300px;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block;cursor:crosshair';
  el.innerHTML = ''; el.appendChild(cv);
  const st = { lat, lon, z: zoom, pts: [], sel: null };   // z is fractional — a pinch zooms between tile levels
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
    // basemap: a pinch zooms continuously, tiles only exist at whole levels — so take the nearest
    // level and scale it by the remainder (ts), which is what keeps the map still under the fingers
    const zi = Math.max(0, Math.min(19, Math.round(st.z)));
    const ts = TS * Math.pow(2, st.z - zi);
    const cx = lon2x(st.lon, zi), cy = lat2y(st.lat, zi);
    const x0 = Math.floor(cx - w / 2 / ts), x1 = Math.floor(cx + w / 2 / ts);
    const y0 = Math.floor(cy - h / 2 / ts), y1 = Math.floor(cy + h / 2 / ts);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const n = Math.pow(2, zi);
      if (y < 0 || y >= n) continue;
      const img = tile(zi, ((x % n) + n) % n, y);
      // +1px: neighbouring tiles land on fractional pixels and would show hairline seams
      if (img.complete && img.naturalWidth) g.drawImage(img, w / 2 + (x - cx) * ts, h / 2 + (y - cy) * ts, ts + 1, ts + 1);
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
    for (const t of taken() || []) {
      const c = t.mine ? css('--ok') : css('--warn');
      poly(t.points, c, c);
      if (t === st.sel) {                                        // the one being looked at, outlined
        g.lineWidth = 4; g.strokeStyle = c; g.setLineDash([6, 4]); g.stroke(); g.setLineDash([]);
      }
    }
    poly(st.pts, css('--accent'), css('--accent'));
    for (const p of st.pts) { const s = toScreen(p);
      g.beginPath(); g.arc(s.x, s.y, 5, 0, 7); g.fillStyle = css('--accent'); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    g.fillStyle = css('--sub'); g.font = '10px system-ui'; g.textAlign = 'right';
    g.fillText('© OpenStreetMap', w - 6, h - 6);
  }

  // one finger: tap adds a corner (tapping the first one closes the shape), drag pans.
  // two fingers: pinch zooms, and the ground under the midpoint stays put — a map you can zoom
  // only in whole steps from a button is a map you cannot frame a plot with.
  const ptrs = new Map();
  let pan = null, pinch = null, moved = false, vdrag = null, lpTimer = null;
  const cancelPress = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  const two = () => [...ptrs.values()];
  const local = pt => { const b = cv.getBoundingClientRect(); return { x: pt.x - b.left, y: pt.y - b.top }; };
  const midOf = p => local({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });

  cv.onpointerdown = e => {
    try { cv.setPointerCapture(e.pointerId); } catch {}   // synthetic events have no live pointer
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      pan = { x: e.clientX, y: e.clientY, lat: st.lat, lon: st.lon }; moved = false;
      const b = cv.getBoundingClientRect(), lx = e.clientX - b.left, ly = e.clientY - b.top;
      // a corner in the wrong place should be movable, not only removable: grab the one under the
      // finger and the drag edits the boundary instead of panning the map
      vdrag = null;
      for (let i = 0; i < st.pts.length; i++) { const sc = toScreen(st.pts[i]);
        if (Math.hypot(sc.x - lx, sc.y - ly) < 16) { vdrag = { i }; break; } }
      // holding still over someone's plot asks about it — a plain tap has to stay «add a corner»,
      // and ground you cannot draw on is ground you cannot ask about
      cancelPress();
      if (onInspect && !vdrag) lpTimer = setTimeout(() => {
        lpTimer = null;
        const here = toWorld(lx, ly);
        // plots may lie on top of each other (the chain does not forbid it), so answer with the
        // SMALLEST one under the finger — otherwise a small plot inside a big one is unreachable
        const hit = (taken() || []).filter(t => pointInPolygon(here, t.points))
          .sort((a, b) => (a.area ?? polygonArea(a.points)) - (b.area ?? polygonArea(b.points)))[0];
        if (!hit) return;
        moved = true;                                            // this press is not a corner
        st.sel = hit; draw(); onInspect(hit);
      }, 500);
    }
    else if (ptrs.size === 2) {
      cancelPress(); vdrag = null;
      pan = null; moved = true;                                  // a pinch is never a tap
      const p = two(), m = midOf(p);
      pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), z: st.z, anchor: toWorld(m.x, m.y) };
    }
  };
  cv.onpointermove = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (vdrag) {
      const b = cv.getBoundingClientRect();
      if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 4) moved = true;
      if (!moved) return;
      st.pts[vdrag.i] = toWorld(e.clientX - b.left, e.clientY - b.top);
      draw(); onChange(st.pts.slice());
      return;
    }
    if (pinch && ptrs.size >= 2) {
      const p = two(), d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (!d || !pinch.d) return;
      st.z = Math.max(3, Math.min(19, pinch.z + Math.log2(d / pinch.d)));
      const m = midOf(p), cur = toWorld(m.x, m.y);               // hold the anchored ground still
      st.lon = x2lon(lon2x(st.lon, st.z) + lon2x(pinch.anchor.lon, st.z) - lon2x(cur.lon, st.z), st.z);
      st.lat = y2lat(lat2y(st.lat, st.z) + lat2y(pinch.anchor.lat, st.z) - lat2y(cur.lat, st.z), st.z);
      draw();
      return;
    }
    if (!pan) return;
    if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 6) { moved = true; cancelPress(); }
    if (!moved) return;
    st.lon = x2lon(lon2x(pan.lon, st.z) - (e.clientX - pan.x) / TS, st.z);
    st.lat = y2lat(lat2y(pan.lat, st.z) - (e.clientY - pan.y) / TS, st.z);
    draw();
  };
  cv.onpointercancel = cv.onpointerup = e => {
    ptrs.delete(e.pointerId);
    cancelPress();
    if (ptrs.size === 1) {                                       // lifted one finger of a pinch:
      pinch = null;                                              // carry on panning with the other
      const [p] = two(); pan = { x: p.x, y: p.y, lat: st.lat, lon: st.lon };
      return;
    }
    if (ptrs.size > 1) return;
    const wasDrag = moved || !!pinch; const onVertex = !!vdrag;
    pan = null; pinch = null; vdrag = null;
    if (wasDrag) return;
    const b = cv.getBoundingClientRect();
    const p = toWorld(e.clientX - b.left, e.clientY - b.top);
    if (st.pts.length >= 3) {                                   // near the first corner ⇒ close
      const f = toScreen(st.pts[0]);
      if (Math.hypot(f.x - (e.clientX - b.left), f.y - (e.clientY - b.top)) < 14) { draw(); onChange(st.pts.slice()); return; }
    }
    if (onVertex) return;                                       // tapped a corner you already have
    if (st.pts.length >= MAX_VERTICES) return;
    st.pts.push(p); draw(); onChange(st.pts.slice());
  };
  cv.onwheel = e => { e.preventDefault(); setZoom(Math.round(st.z) + (e.deltaY > 0 ? -1 : 1)); };
  // Safari zooms the PAGE on a double tap and honours touch-action for it only sometimes — on a map
  // you tap corner after corner, so swallow the second tap of a pair outright
  let lastTap = 0;
  cv.addEventListener('touchend', e => {
    const now = e.timeStamp;
    if (now - lastTap < 400) e.preventDefault();
    lastTap = now;
  }, { passive: false });
  // the buttons step whole levels, so they snap a pinched view back onto a crisp tile level
  function setZoom(z) { const nz = Math.max(3, Math.min(19, z)); if (nz === st.z) return; st.z = nz; draw(); }

  const api = {
    draw, zoom: d => setZoom(Math.round(st.z) + d),
    centre(la, lo, z) { st.lat = la; st.lon = lo; if (z) st.z = z; draw(); },
    clear() { st.pts = []; draw(); onChange([]); },
    undo() { st.pts.pop(); draw(); onChange(st.pts.slice()); },
    points: () => st.pts.slice(),
    deselect() { if (!st.sel) return; st.sel = null; draw(); },
    get area() { return st.pts.length >= 3 ? polygonArea(st.pts) : 0; },
    get centreOfPlot() { return st.pts.length ? polygonCentre(st.pts) : { lat: st.lat, lon: st.lon }; },
    overlapsAny: () => st.pts.length >= 3 && (taken() || []).some(t => polygonsOverlap(st.pts, t.points)),
  };
  draw();
  return api;
}
