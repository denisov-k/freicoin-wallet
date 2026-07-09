// Run every *.parity.mjs harness in this directory; exit non-zero on any failure.
import { readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
for (const f of readdirSync(here).filter(x => x.endsWith('.parity.mjs')).sort()) {
  try { process.stdout.write(execFileSync('node', [f], { cwd: here, encoding: 'utf8' })); }
  catch (e) { fail++; process.stdout.write(e.stdout || ''); console.error('FAILED:', f); }
}
console.log(fail ? `\n${fail} harness(es) FAILED` : '\nall harnesses passed');
process.exit(fail ? 1 : 0);
