// Validate ecdsa.mjs against Freicoin key.py deterministic sigs + self-verify. NO node.
//   node sign.parity.mjs
import { readFileSync } from 'fs';
import { signEcdsa, verifyEcdsa, pubkeyCompressed } from '../ecdsa.mjs';

const cases = JSON.parse(readFileSync('./sign_vectors.json', 'utf8'));
let ok = 0, fail = 0, firstfail = null;
const check = (cond, label, extra) => {
  if (cond) ok++;
  else { fail++; if (!firstfail) firstfail = { label, ...extra }; }
};

for (const c of cases) {
  // 1. compressed pubkey derived from secret matches key.py
  const pk = pubkeyCompressed(c.secret);
  check(pk === c.pubkey, 'pubkey', { got: pk, want: c.pubkey });
  // 2. deterministic (rfc6979) DER signature matches key.py byte-for-byte
  const der = signEcdsa(c.secret, c.msg);
  check(der === c.der, 'der_sig', { got: der, want: c.der });
  // 3. the signature verifies
  check(verifyEcdsa(c.secret, c.msg, der), 'self_verify', {});
  // 4. a tampered message must NOT verify
  const badMsg = (BigInt('0x' + c.msg) ^ 1n).toString(16).padStart(64, '0');
  check(!verifyEcdsa(c.secret, badMsg, der), 'reject_tampered', {});
}

console.log(`ecdsa parity: ${ok}/${ok + fail} checks pass  (${cases.length} vectors x4)`);
if (firstfail) { console.log('FIRST FAIL:', JSON.stringify(firstfail)); process.exit(1); }
