// Validate sighash.mjs against the Freicoin reference (script.py). NO node.
//   node sighash.parity.mjs
import { readFileSync } from 'fs';
import { segwitV0SighashPreimage, segwitV0Sighash } from '../sighash.mjs';

const cases = JSON.parse(readFileSync('./sighash_vectors.json', 'utf8'));
let ok = 0, fail = 0, firstfail = null;
const check = (cond, label, extra) => {
  if (cond) ok++;
  else { fail++; if (!firstfail) firstfail = { label, ...extra }; }
};

for (const c of cases) {
  const tx = {
    version: c.tx.version, nLockTime: c.tx.nLockTime, lockHeight: c.tx.lockHeight,
    vin: c.tx.vin.map(i => ({ prevout: i.prevout, sequence: i.sequence })),
    vout: c.tx.vout.map(o => ({ value: BigInt(o.value), scriptPubKey: o.scriptPubKey })),
  };
  const pre = segwitV0SighashPreimage(tx, c.inIdx, c.scriptCode, BigInt(c.amount), c.refheight, c.hashtype);
  check(pre === c.preimage, 'preimage',
    { ht: c.hashtype, got: pre.slice(0, 48) + '...', want: c.preimage.slice(0, 48) + '...' });
  const sh = segwitV0Sighash(tx, c.inIdx, c.scriptCode, BigInt(c.amount), c.refheight, c.hashtype);
  check(sh === c.sighash, 'sighash', { ht: c.hashtype, got: sh, want: c.sighash });
}

console.log(`sighash parity: ${ok}/${ok + fail} checks pass  (${cases.length} vectors x2)`);
if (firstfail) { console.log('FIRST FAIL:', JSON.stringify(firstfail)); process.exit(1); }
