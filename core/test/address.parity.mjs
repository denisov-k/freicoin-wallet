import { readFileSync } from 'fs';
import { encodeWitness, decodeWitness, encodeBase58Check, decodeBase58Check } from '../address.mjs';
const ref = JSON.parse(readFileSync('./refaddr.json','utf8'));
let ok=0, fail=0;
function check(name, cond, detail) { if (cond) ok++; else { fail++; console.log('FAIL', name, detail); } }

// bech32 witness v0 round-trip
const b = ref.bech32;
const dec = decodeWitness(b.addr);
check('bech32 decode version', dec.version === b.witver, `${dec.version} vs ${b.witver}`);
check('bech32 decode program', dec.programHex === b.witprog, `${dec.programHex} vs ${b.witprog}`);
check('bech32 encode round-trip', encodeWitness('regtest', b.witver, b.witprog) === b.addr, `${encodeWitness('regtest', b.witver, b.witprog)} vs ${b.addr}`);

// legacy P2PKH: spk = 76a914 <hash160> 88ac  → hash160 = spk[6:46]
const l = ref.legacy;
const hash160 = l.spk.slice(6, 46);
const legacyDec = await decodeBase58Check(l.addr);
check('legacy decode version', legacyDec.version === 0x6f, `0x${legacyDec.version.toString(16)}`);
check('legacy decode hash160', legacyDec.hash160Hex === hash160, `${legacyDec.hash160Hex} vs ${hash160}`);
check('legacy encode round-trip', (await encodeBase58Check(0x6f, hash160)) === l.addr, `${await encodeBase58Check(0x6f, hash160)} vs ${l.addr}`);

console.log(`address parity: ${ok}/${ok+fail} match`);
process.exit(fail ? 1 : 0);
