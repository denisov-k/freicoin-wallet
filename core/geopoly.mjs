// geopoly.mjs — a plot is a POLYGON, because land is. The grid of square cells that came before
// existed to make overlaps impossible to record; once we accepted that the chain does not
// adjudicate overlap (it holds only a hash of an id, and land exists whether or not anyone records
// it), the grid was only deforming boundaries to fit the data structure. A boundary follows a river
// or a fence, so the wallet stores the boundary.
//
// The id commits to the shape: plot:<world>:<sha256 of the canonical encoding>. The shape itself
// rides in the holding's own transaction, so anyone can read it back and check it hashes to the id.
// Everything here is exact integer arithmetic on 1e-6 degrees (≈11 cm) — the same bytes always
// produce the same hash, which is what makes the commitment work.

const SCALE = 1e6;                       // 1e-6 degrees ≈ 11 cm
export const MAX_VERTICES = 10;          // anchor(8B) + 9 deltas(4B) = 44B — fits one OP_RETURN memo
const q = v => Math.round(v * SCALE);    // degrees → integer units
const unq = v => v / SCALE;

const i32 = (a, v) => { for (let i = 0; i < 4; i++) a.push((v >> (8 * i)) & 0xff); };
const i16 = (a, v) => { const u = v & 0xffff; a.push(u & 0xff, (u >> 8) & 0xff); };
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
const rd16 = (b, o) => { const u = b[o] | (b[o + 1] << 8); return u > 0x7fff ? u - 0x10000 : u; };

/** Twice the signed area in integer units — the sign IS the winding, so canonicalisation is exact. */
const shoelace2 = pts => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y; }
  return s;
};

/** Canonical form: quantised, counter-clockwise, starting at the lowest vertex. The same ground
 *  drawn in a different order or direction must hash the same, or the commitment is meaningless. */
export function canonicalPolygon(points) {
  let pts = points.map(p => ({ x: q(p.lon), y: q(p.lat) }));
  // drop consecutive duplicates (a double tap while drawing)
  pts = pts.filter((p, i) => { const n = pts[(i + 1) % pts.length]; return p.x !== n.x || p.y !== n.y; });
  if (pts.length < 3) throw new Error('a plot needs at least 3 corners');
  if (pts.length > MAX_VERTICES) throw new Error('too many corners');
  if (shoelace2(pts) < 0) pts.reverse();                                   // force counter-clockwise
  let k = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].y < pts[k].y || (pts[i].y === pts[k].y && pts[i].x < pts[k].x)) k = i;
  return pts.slice(k).concat(pts.slice(0, k));
}

/** Canonical polygon → wire bytes (hex): anchor as absolute units, the rest as deltas. */
export function encodePolygon(points) {
  const pts = canonicalPolygon(points);
  const a = [];
  i32(a, pts[0].y); i32(a, pts[0].x);
  for (let i = 1; i < pts.length; i++) {
    const dy = pts[i].y - pts[i - 1].y, dx = pts[i].x - pts[i - 1].x;
    if (dy > 32767 || dy < -32768 || dx > 32767 || dx < -32768) throw new Error('corners too far apart');
    i16(a, dy); i16(a, dx);
  }
  return a.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Wire bytes → [{lat, lon}] (the canonical order, so re-encoding reproduces the same hash). */
export function decodePolygon(hex) {
  const b = (hex.match(/../g) || []).map(h => parseInt(h, 16));
  if (b.length < 8 || (b.length - 8) % 4) throw new Error('bad polygon');
  let y = rd32(b, 0), x = rd32(b, 4);
  const out = [{ lat: unq(y), lon: unq(x) }];
  for (let o = 8; o < b.length; o += 4) {
    y += rd16(b, o); x += rd16(b, o + 2);
    out.push({ lat: unq(y), lon: unq(x) });
  }
  // a memo is just bytes: an older or foreign one decodes to nonsense, so refuse anything that is
  // not a place on Earth rather than handing the map impossible corners
  if (out.some(p => !(p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180))) throw new Error('not a boundary');
  return out;
}

/** Area in square metres (local flat approximation — plots are small). */
export function polygonArea(points) {
  const pts = points.map(p => ({ x: p.lon, y: p.lat }));
  const lat0 = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110540;
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length];
    s += (a.x * mx) * (b.y * my) - (b.x * mx) * (a.y * my); }
  return Math.abs(s / 2);
}

export const polygonCentre = points => ({
  lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
  lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
});

// ── overlap ─────────────────────────────────────────────────────────────────────────────────────
const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);
const onSeg = (p, q2, r) => Math.min(p.lon, r.lon) <= q2.lon && q2.lon <= Math.max(p.lon, r.lon)
  && Math.min(p.lat, r.lat) <= q2.lat && q2.lat <= Math.max(p.lat, r.lat);
const segmentsCross = (p1, p2, p3, p4) => {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSeg(p3, p1, p4)) || (d2 === 0 && onSeg(p3, p2, p4))
      || (d3 === 0 && onSeg(p1, p3, p2)) || (d4 === 0 && onSeg(p1, p4, p2));
};
export const pointInPolygon = (pt, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat)
      && pt.lon < (b.lon - a.lon) * (pt.lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
};
/** Do two plots cover any common ground? Edge crossing, or one lying inside the other. */
export function polygonsOverlap(a, b) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++)
    if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}
