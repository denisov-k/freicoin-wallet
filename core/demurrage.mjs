// demurrage.mjs — bit-exact JS port of Freicoin TimeAdjustValueForward.
// Present value of `nominal` kria after `distance` blocks. BigInt (64.64 fixed).
const MASK32 = 0xffffffffn;
const K32 = [
  [0xfffff000n, 0x00000000n],
  [0xffffe000n, 0x01000000n],
  [0xffffc000n, 0x05ffffc0n],
  [0xffff8000n, 0x1bfffc80n],
  [0xffff0000n, 0x77ffdd00n],
  [0xfffe0001n, 0xeffeca00n],
  [0xfffc0007n, 0xdff5d409n],
  [0xfff8001fn, 0xbfaca8a2n],
  [0xfff0007fn, 0x7d5d5a6an],
  [0xffe001fen, 0xeacb48a8n],
  [0xffc007fdn, 0x55dfda2an],
  [0xff801ff6n, 0xad5499cdn],
  [0xff007fcdn, 0x67f98aadn],
  [0xfe01fe9bn, 0x74f0943en],
  [0xfc07f540n, 0x767d2a82n],
  [0xf81fab16n, 0x3dc15990n],
  [0xf07d5f65n, 0xf9604ac9n],
  [0xe1eb5045n, 0x80b6ebf7n],
  [0xc75f7b66n, 0xa5075defn],
  [0x9b459576n, 0x663bbb3en],
  [0x5e2d55e7n, 0x48e27ab4n],
  [0x22a5531dn, 0x29a95916n],
  [0x04b054d7n, 0xfda49c4dn],
  [0x0015fc1bn, 0x85085be9n],
  [0x000001e3n, 0x54ca043cn],
  [0x00000000n, 0x00039089n]
];
export function timeAdjustValue(nominal, distance) {
  if (distance < 0) throw new Error("distance must be >= 0");
  const sign = nominal > 0n ? 1n : nominal < 0n ? -1n : 0n;
  const value = nominal < 0n ? -nominal : nominal;
  if (distance === 0) return nominal;
  if (distance >= (1 << 26)) return 0n;
  let w0 = null, w1 = 0n;
  for (let bit = 0; bit < 26; bit++) {
    if (distance & (1 << bit)) {
      const [k0, k1] = K32[bit];
      if (w0 === null) { w0 = k0; w1 = k1; continue; }
      let acc = k1 * w0 + k0 * w1;
      acc = (acc >> 32n) + k0 * w0;
      w1 = acc & MASK32;
      w0 = (acc >> 32n) & MASK32;
    }
  }
  if (w0 === null) return nominal;
  const v0 = value >> 32n, v1 = value & MASK32;
  let acc = (w1 * v1) >> 32n;
  acc += w1 * v0 + w0 * v1;
  acc = (acc >> 32n) + w0 * v0;
  return sign * acc;
}
