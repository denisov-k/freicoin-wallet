// Validate pst.mjs against golden vectors from the python PST reference. NO node.
//   node pst.parity.mjs
import { readFileSync } from 'fs';
import { parsePst, serializePst, pstToBase64, pstFromBase64 } from '../pst.mjs';

const cases = JSON.parse(readFileSync('./pst_vectors.json', 'utf8'));
let ok = 0, fail = 0, firstfail = null;
const check = (cond, label, extra) => {
  if (cond) ok++;
  else { fail++; if (!firstfail) firstfail = { label, ...extra }; }
};

for (const c of cases) {
  let p;
  try { p = parsePst(c.hex); }
  catch (e) { check(false, 'parse_threw', { msg: e.message }); continue; }

  // input/output map counts equal the embedded tx's vin/vout counts
  check(p.tx.vin.length === c.n_in, 'n_in', { got: p.tx.vin.length, want: c.n_in });
  check(p.tx.vout.length === c.n_out, 'n_out', { got: p.tx.vout.length, want: c.n_out });
  check(p.inputs.length === c.n_in, 'input_maps', { got: p.inputs.length, want: c.n_in });
  check(p.outputs.length === c.n_out, 'output_maps', { got: p.outputs.length, want: c.n_out });
  // Freicoin trailing lock_height survived the embedded-tx parse
  check(p.tx.lockHeight === c.lock_height, 'lock_height', { got: p.tx.lockHeight, want: c.lock_height });
  // every input map carries a witness_utxo (key type 0x01)
  check(p.inputs.every(m => m.entries.some(e => parseInt(e.key.slice(0, 2), 16) === 0x01)),
    'input_has_witness_utxo', {});

  // byte-exact round-trip: parse -> serialize == original
  const round = serializePst(p);
  check(round === c.hex, 'roundtrip_byte_exact',
    { got: round.slice(0, 40) + '...', want: c.hex.slice(0, 40) + '...' });

  // base64 wrapper round-trips too
  check(pstFromBase64(pstToBase64(c.hex)) === c.hex, 'base64_roundtrip', {});
}

// magic check: a PSBT (psbt\xff) must be rejected
try { parsePst('70736274ff' + '00'); check(false, 'psbt_magic_rejected'); }
catch { check(true, 'psbt_magic_rejected'); }

console.log(`pst parity: ${ok}/${ok + fail} checks pass`);
if (firstfail) { console.log('FIRST FAIL:', JSON.stringify(firstfail)); process.exit(1); }
