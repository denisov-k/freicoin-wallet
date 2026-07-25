// geohash.mjs — the grid Freiland plots are addressed on. A plot id carries a geohash cell, so the
// identifier IS the location: no coordinate lists, no polygons, and — because every plot uses the
// SAME precision — no overlaps to detect. Two cells are either identical or disjoint, which is what
// lets the covenant stay untouched: uniqueness of the id is uniqueness of the ground.
//
// Standard geohash (base32, longitude bit first). Self-contained: this file has no dependencies, and
// the wallet loads no map tiles — a plot is picked from the device's own position or typed in.

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';   // geohash alphabet (no a/i/l/o)

/** Encode a position to a geohash of `precision` characters. */
export function geohashEncode(lat, lon, precision = 8) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = '', bits = 0, bit = 0, even = true;   // even step = longitude
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { bits = (bits << 1) | 1; lonMin = mid; } else { bits <<= 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { bits = (bits << 1) | 1; latMin = mid; } else { bits <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += B32[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

/** Decode a geohash to its cell: centre plus the bounds it covers. */
export function geohashDecode(hash) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, even = true;
  for (const ch of String(hash).toLowerCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad geohash');
    for (let i = 4; i >= 0; i--) {
      const bit = (idx >> i) & 1;
      if (even) { const mid = (lonMin + lonMax) / 2; if (bit) lonMin = mid; else lonMax = mid; }
      else      { const mid = (latMin + latMax) / 2; if (bit) latMin = mid; else latMax = mid; }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2, latMin, latMax, lonMin, lonMax };
}

/** Rough size of a cell in metres, for showing what a precision actually buys. */
export function geohashSize(hash) {
  const c = geohashDecode(hash);
  const h = (c.latMax - c.latMin) * 111320;                                  // latitude degrees are ~constant
  const w = (c.lonMax - c.lonMin) * 111320 * Math.cos(c.lat * Math.PI / 180);
  return { widthM: Math.round(w), heightM: Math.round(h) };
}

/** A cell of ANY resolution: 1 char ≈ 5000 km, 12 ≈ 4 cm. Length is the zoom, not a constraint —
 *  the chain does not adjudicate overlaps (see freiland.mjs cellsOverlap), so a plot may be as
 *  coarse as a field or as fine as a parking space. */
export const GEOHASH_MIN = 1, GEOHASH_MAX = 12;
export const validGeohash = (h, precision = null) =>
  typeof h === 'string'
  && (precision ? h.length === precision : h.length >= GEOHASH_MIN && h.length <= GEOHASH_MAX)
  && [...h].every(c => B32.includes(c));
