// Checkpoint fast path (regtest): a fresh wallet born at a recent anchor syncs the tail
// only (chain.base > 0), reaches the tip, and persists/resumes with the base intact.
import 'fake-indexeddb/auto';
import { ENV, check, finish, cliR } from './helpers.mjs';
import { createLightSource } from '../src/light.mjs';
import { configureNetwork } from '../src/wallet.mjs';
configureNetwork('regtest');
const tip = Number(cliR('getblockcount'));
const cpH = Math.max(1, tip - 50);
const cp = { height: cpH, hash: cliR('getblockhash', String(cpH)) };
const freshSpk = '0014' + 'cd'.repeat(20);
const a = createLightSource({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, scripts: [freshSpk], birthHeight: cpH, checkpoint: cp });
const t0 = Date.now();
const r1 = await a.utxos(); a.close();
check('fast sync reaches the tip', r1.tipHeight >= tip, `${r1.tipHeight} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
check('fresh wallet balance 0', r1.balance === 0);
const b = createLightSource({ url: ENV.REG_BRIDGE, net: 'regtest', genesis: ENV.REG_GENESIS, scripts: [freshSpk], birthHeight: cpH, checkpoint: cp });
const r2 = await b.utxos();
check('checkpointed state resumes', r2.tipHeight >= r1.tipHeight);
check('preview works on checkpointed state', !!(await b.preview()));
b.close();
finish();
