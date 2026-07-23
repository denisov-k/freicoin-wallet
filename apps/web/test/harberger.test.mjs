// harberger.test.mjs — Freiland covenant OP_3 (HRBG) extension-output format (variant A).
// Pure model test (no node): the byte format the covenant consensus rule will parse, mirrored in
// the JS model so the wallet can build/recognise Harberger outputs. See docs/freiland-covenant-spec.md §3.
import assert from 'node:assert';
import { encodeHarbergerSpk, encodeAssetSpk, decodeAssetSpk, HARBERGER_V } from '@core/asset-spk.mjs';

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log('PASS ', name); pass++; };

const base = '0014' + '11'.repeat(20);      // a plain host P2WPKH-style base program
const nameHash = 'aa'.repeat(32);
const owner = 'bb'.repeat(20);
const floorV = 1000000n;                     // 0.01 FRC dust floor (kria)

// ---- exact wire bytes ----
const spk = encodeHarbergerSpk(base, nameHash, owner, floorV);
const expected = base
  + '20' + nameHash                          // push 32-byte nameHash
  + '14' + owner                             // push 20-byte ownerHash160
  + '08' + '40420f0000000000'                // push 8-byte little-endian floorV (1_000_000)
  + '53';                                    // OP_3 (0x50 + 3)
check('encodes to the exact HRBG wire bytes', spk === expected);
check('HARBERGER_V is 3', HARBERGER_V === 3);

// ---- round-trip decode ----
const d = decodeAssetSpk(spk);
check('decodes (not null)', d !== null);
check('base program preserved (tag/covenant stripped)', d.baseSpk === base);
check('HRBG is HOST currency — assetTag null', d.assetTag === null);
check('no tokenHash on a HRBG output', d.tokenHash === null);
check('version is HARBERGER_V', d.version === HARBERGER_V);
check('harberger field present', !!d.harberger);
check('nameHash round-trips', d.harberger.nameHash === nameHash);
check('owner round-trips', d.harberger.owner === owner);
check('floorV round-trips as BigInt', d.harberger.floorV === floorV);

// ---- floorV little-endian over a range (incl. large / MAX_MONEY-scale) ----
for (const v of [0n, 1n, 255n, 256n, 100000000n, 9007199254740991n, 0xdeadbeefn, 0xfffffffffffffffen]) {
  const r = decodeAssetSpk(encodeHarbergerSpk(base, nameHash, owner, v));
  check(`floorV ${v} round-trips`, r.harberger.floorV === v);
}

// ---- distinct from asset v1/v2, and no regression on the asset path ----
const fung = decodeAssetSpk(encodeAssetSpk(base, 'cc'.repeat(20)));           // OP_1 fungible
check('asset v1 still decodes with a tag (no regression)', fung.assetTag === 'cc'.repeat(20) && fung.version === 1 && !fung.harberger);
const tok = decodeAssetSpk(encodeAssetSpk(base, 'cc'.repeat(20), ['t1']));    // OP_2 asset+tokens
check('asset v2 still decodes tag+tokenHash (no regression)', tok.assetTag === 'cc'.repeat(20) && tok.tokenHash && tok.version === 2 && !tok.harberger);
check('a HRBG spk is NOT read as an asset', decodeAssetSpk(spk).assetTag === null);

// ---- rejects malformed ----
check('rejects wrong nameHash length', (() => { try { encodeHarbergerSpk(base, 'aa'.repeat(31), owner, floorV); return false; } catch { return true; } })());
check('rejects wrong owner length', (() => { try { encodeHarbergerSpk(base, nameHash, 'bb'.repeat(19), floorV); return false; } catch { return true; } })());
check('rejects floorV overflow', (() => { try { encodeHarbergerSpk(base, nameHash, owner, 1n << 64n); return false; } catch { return true; } })());
// a suffix with OP_3 but the wrong data length must not decode as HRBG
check('rejects HRBG suffix of wrong data length', decodeAssetSpk(base + '20' + nameHash + '53') === null);

// ---- host output (no suffix) unaffected ----
check('plain host program decodes as host, no harberger', (() => { const h = decodeAssetSpk(base); return h.assetTag === null && !h.harberger; })());

console.log(`\nOK ✅  (${pass} checks)`);
