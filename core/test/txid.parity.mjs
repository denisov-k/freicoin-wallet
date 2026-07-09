import { readFileSync } from 'fs';
import { parseTx, txid } from '../tx.mjs';
const ref = JSON.parse(readFileSync('./reftx.json','utf8'));
const p = parseTx(ref.raw);
const got = txid(p);
const match = got === ref.txid;
console.log(`txid: ${match ? '1/1 match' : 'FAIL'}`);
if (!match) console.log(`  got ${got}\n  ref ${ref.txid}`);
// prove lock_height is committed: flip it, txid must change
const p2 = { ...p, lockHeight: p.lockHeight + 1 };
const changed = txid(p2) !== got;
console.log(`lock_height committed in txid: ${changed ? 'YES' : 'NO (unexpected!)'}`);
process.exit(match && changed ? 0 : 1);
