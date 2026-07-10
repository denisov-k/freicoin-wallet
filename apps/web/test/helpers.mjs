// helpers.mjs — shared harness for the light-client test suite. Tests need live infra
// (a regtest node + bridge; optionally the mainnet filter node + bridge + snapshots);
// endpoints come from env with defaults matching the project VPS.
import { execFileSync } from 'node:child_process';

export const ENV = {
  CLI: process.env.FW_CLI || '/root/fcbuild-31/bin/freicoin-cli',
  REG_BRIDGE: process.env.FW_BRIDGE_REGTEST || 'ws://127.0.0.1:3040',
  REG_ARGS: (process.env.FW_REGTEST_ARGS || '-regtest -datadir=/root/fw-bdev -rpcport=19560').split(' '),
  REG_GENESIS: '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8',
  MAIN_BRIDGE: process.env.FW_BRIDGE_MAIN || 'ws://127.0.0.1:3041',
  MAIN_ARGS: (process.env.FW_MAIN_ARGS || '-datadir=/root/fw-mainnet-filter -rpcport=18951').split(' '),
  MAIN_GENESIS: '000000005b1e3d23ecfd2dd4a6e1a35238aa0392c0a8528c40df52376d7efe2c',
  SNAP: process.env.FW_SNAP || 'http://127.0.0.1:3050',
};

export const cliR = (...a) => execFileSync(ENV.CLI, [...ENV.REG_ARGS, ...a]).toString().trim();
export const cliM = (...a) => execFileSync(ENV.CLI, [...ENV.MAIN_ARGS, ...a]).toString().trim();

export const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let failed = 0;
export const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) failed = 1;
};
export const finish = () => { console.log(failed ? 'FAILED ❌' : 'OK ✅'); process.exit(failed); };

/** Ensure the regtest wallet's coinbases are spendable (100-block maturity). */
export function ensureMature(foreignAddr) {
  cliR('generatetoaddress', '100', foreignAddr);
}

/** Worker-protocol harness over the exported handle() — a fake main thread. */
export async function makeWorkerClient() {
  const { handle } = await import('../src/worker.mjs');
  const waits = new Map(); let seq = 0;
  const c = { events: [], partials: [] };
  const post = m => {
    if (m.type === 'progress') { c.events.push(m.p); return; }
    if (m.type === 'provisional') { c.partials.push(m.c); return; }
    const w = waits.get(m.id); if (w) { waits.delete(m.id); m.error ? w.rej(new Error(m.error)) : w.res(m.result); }
  };
  c.call = (method, params) => new Promise((res, rej) => { const id = ++seq; waits.set(id, { res, rej }); handle({ id, method, params }, post); });
  return c;
}

/** True when the mainnet infra (node RPC + bridge) answers; mainnet suites skip otherwise. */
export function mainnetAvailable() {
  try { cliM('getblockcount'); return true; } catch { return false; }
}
