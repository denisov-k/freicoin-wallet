// make.mjs — build a static header-chain snapshot for the wallet's HTTP bootstrap.
// Connects to a bridge, downloads + FULLY VERIFIES the header chain (same code path as
// the wallet: linkage + native PoW + parallel aux-pow), and writes every raw `headers`
// message (standard P2P framing) to the output file. The wallet re-verifies everything
// on consumption, so the snapshot channel needs no trust — this pre-verification just
// ensures we never publish garbage.
//   node make.mjs <net> <bridge-url> <genesis> <out-file>
import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Neutrino } from '../../apps/web/src/net/client.mjs';
import { encodeMessage } from '../../apps/web/src/net/p2p.mjs';

const [net, url, genesis, out] = process.argv.slice(2);
if (!out) { console.error('usage: node make.mjs <net> <bridge-url> <genesis> <out-file>'); process.exit(2); }

const tmp = out + '.tmp';
const f = createWriteStream(tmp);
const n = new Neutrino({ url, net, genesis });

// capture every non-empty headers payload as it flows through the normal sync
const origOn = n.on.bind(n);
n.on = (cmd, fn) => origOn(cmd, m => {
  if (cmd === 'headers' && m.payload.length > 1) f.write(encodeMessage(net, 'headers', m.payload));
  fn(m);
});

await n.connect();
const t0 = Date.now();
await n.syncHeaders();
const { makePool } = await import('../../apps/web/src/net/verifypool.mjs');
n._pool = n._pool ?? await makePool();
await n.drainVerify();                       // full PoW verification before publishing
n.close();
await new Promise(r => f.end(r));
await rename(tmp, out);
console.log(`snapshot ${out}: tip ${n.chain.length - 1}, verified, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(0);
