// run-tests.mjs — runs each *.test.mjs in its own process (fake-indexeddb state must not
// leak between tests) and reports a summary. Needs the live regtest infra (node+bridge);
// the mainnet suite self-skips when its infra is unreachable.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of tests) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, ['--max-old-space-size=3200', join(dir, f)], { stdio: 'inherit', timeout: 600000 });
  if (r.status !== 0) { failed++; console.log(`*** ${f} FAILED (exit ${r.status})`); }
}
console.log(`\n${tests.length - failed}/${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
