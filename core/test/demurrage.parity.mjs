import { readFileSync } from 'fs';
import { timeAdjustValue } from '../demurrage.mjs';
const cases = JSON.parse(readFileSync('./vectors.json','utf8'));
let ok=0, fail=0, firstfail=null;
for (const c of cases){
  const got = timeAdjustValue(BigInt(c.v), c.d);
  if (got === BigInt(c.e)) ok++;
  else { fail++; if(!firstfail) firstfail={...c, got: got.toString()}; }
}
console.log(`parity: ${ok}/${ok+fail} match`);
if(firstfail) console.log('FIRST FAIL:', JSON.stringify(firstfail));
