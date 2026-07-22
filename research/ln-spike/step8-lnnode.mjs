// step8: СБОРКА фазы 2 целиком — LnNode (LDK×BtcNeutrino×WsLDKNet×VSS) на стенде.
// Фаза init: узел стартует, LSP(Алиса) открывает канал, hold-инвойс под H, платёж, claim(R),
// монитор+менеджер уходят в VSS. Фаза resume: НОВЫЙ LnNode с тем же сидом восстанавливается ИЗ
// VSS и принимает ВТОРОЙ платёж. Требует мосты 3070(LN)/3071(neutrino), bitcoind -peerblockfilters,
// VSS-релей :5182.  Запуск: node --import ../../apps/web/test/register-aliases.mjs step8-lnnode.mjs init|resume
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import * as ldk from 'lightningdevkit';
import { LnNode } from './ln-node.mjs';
import { VssClient } from '../../apps/web/src/services/light/net/vss-client.mjs';

const MODE = process.argv[2];
if (!['init', 'resume'].includes(MODE)) { console.error('usage: init|resume'); process.exit(1); }
const BENCH = '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/lnbench';
const DIR = BENCH + '/lnnode'; mkdirSync(DIR, { recursive: true });
const BTCLI = ['/root/bitcoin-core/bin/bitcoin-cli', '-regtest', '-datadir=/root/btc-regtest', '-rpcport=18443'];
const LNCLI_A = ['lncli', `--lnddir=${BENCH}/alice`, '--network=regtest', '--rpcserver=127.0.0.1:10011'];
const btcli = (...a) => execFileSync(BTCLI[0], [...BTCLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const aliceA = (...a) => new Promise((res, rej) => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), ...a], { encoding: 'utf8' }, (e, out, err) => e ? rej(new Error((err || String(e)).slice(0, 160))) : res(JSON.parse(out))));

await ldk.initializeWasmFromBinary(readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'));

// stable seed + a fixed nodeId namespace for VSS across init/resume
const seedFile = DIR + '/seed'; if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(32));
const seed = new Uint8Array(readFileSync(seedFile));
// nodeId is derived by LDK from the seed → same across runs; use a placeholder for VSS namespacing
// that we finalize after start() (VSS keys are per (nodeId,key), and nodeId is deterministic).
const hwMap = new Map();
const hwStore = { get: k => hwMap.has(k) ? hwMap.get(k) : (existsSync(`${DIR}/hw_${k}`) ? +readFileSync(`${DIR}/hw_${k}`, 'utf8') : null),
                  set: (k, v) => { hwMap.set(k, v); writeFileSync(`${DIR}/hw_${k}`, String(v)); } };

// LDK nodeId is deterministic from the seed; compute it by a throwaway KeysManager+ChannelManager?
// Simpler: start the node, read node.nodeId, and point the VssClient at it. But VSS is needed DURING
// start (restore). So derive nodeId first via a minimal KeysManager path:
const km = ldk.KeysManager.constructor_new(seed, 1n, 0, false);
// node id = the node signer's pubkey; ChannelManager.get_our_node_id equals NodeSigner's node id
const nodeId = Buffer.from(km.as_NodeSigner().get_node_id(ldk.Recipient.LDKRecipient_Node).res).toString('hex');
console.log('nodeId', nodeId.slice(0, 20) + '…');

const vss = new VssClient({ apiBase: 'http://127.0.0.1:5182/api', nodeId, seedBytes: seed, hwStore });

let anchorHeight = +btcli('getblockcount'), anchorHash = btcli('getbestblockhash');
const anchorFile = DIR + '/anchor.json';
if (MODE === 'init') writeFileSync(anchorFile, JSON.stringify({ height: anchorHeight, hash: anchorHash }));
else if (existsSync(anchorFile)) { const a = JSON.parse(readFileSync(anchorFile, 'utf8')); anchorHeight = a.height; anchorHash = a.hash; }   // resume: re-feed from init so the restored manager reaches the tip
const node = new LnNode({
  seedBytes: seed, net: 'btcregtest', lspUrl: 'ws://127.0.0.1:3070', btcUrl: 'ws://127.0.0.1:3071', vss,
  anchor: { hash: anchorHash, height: anchorHeight }, broadcast: hex => { try { btcli('sendrawtransaction', hex); } catch {} },
  log: (...a) => console.log(' ', ...a),
});

const R = randomBytes(32), H = createHash('sha256').update(R).digest('hex');
let claimed = false, ready = false;
node.on.channelReady = () => { ready = true; node.flushManager().catch(()=>{}); };
node.on.paymentClaimable = (hash) => { if (hash === H) { console.log('  held → claim_funds(R)'); node.claimFunds(R.toString('hex')); } };
node.on.paymentClaimed = () => { claimed = true; };

await node.start();
console.log(`started (${MODE}); channels: ${node.chanMgr.list_channels().length}, usable: ${node.usableChannels().length}`);

const ALICE_PK = (await aliceA('getinfo')).identity_pubkey;
const ensurePeer = async () => { for (let i = 0; i < 60; i++) { node.peerMgr.process_events();
  if ((await aliceA('listpeers')).peers?.some(p => p.pub_key === node.nodeId)) return;
  if (i % 10 === 0) { try { await node.connectLsp('ws://127.0.0.1:3070', ALICE_PK); } catch {} }
  await new Promise(r => setTimeout(r, 200)); } throw new Error('peer never up'); };
await ensurePeer();

const mine = async n => { btcli('generatetoaddress', String(n), (await aliceA('newaddress', 'p2wkh')).address); };
if (MODE === 'init') {
  console.log('-- alice opens a 300k channel…');
  await aliceA('openchannel', '--node_key', node.nodeId, '--local_amt', '300000', '--private');
  for (let i = 0; i < 150 && !ready; i++) { if (i % 15 === 3) await mine(1); await node.tick(); await new Promise(r => setTimeout(r, 300)); }
} else {
  for (let i = 0; i < 100 && !node.usableChannels().length; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
  ready = node.usableChannels().length > 0;
  console.log('  restored channel usable:', ready);
}
if (!ready) { console.error('no usable channel'); process.exit(1); }
for (let i = 0; i < 40; i++) { await node.tick(); const cs = node.usableChannels(); if (cs.length && cs[0].get_counterparty_forwarding_info?.()) break; await new Promise(r => setTimeout(r, 200)); }

// hold invoice under external H, alice pays, held → claim(R)
const bolt11 = node.createHoldInvoice(H, 30000);
console.log('  invoice', bolt11.slice(0, 24) + '…');
const payer = new Promise(res => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), 'payinvoice', '--force', '--timeout', '45s', bolt11], () => res(null)));
for (let i = 0; i < 250 && !claimed; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
await payer;
const pay = (await aliceA('listpayments')).payments.at(-1);
console.log('  alice payment', pay.status, '| preimage match', pay.payment_preimage === R.toString('hex'));
// give VSS writes a moment
for (let i = 0; i < 10; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
const vlist = await vss.list();
console.log('  VSS keys:', vlist.map(x => `${x.key}@v${x.version}`).join(', '));
console.log(claimed && pay.payment_preimage === R.toString('hex') ? `STEP8 ${MODE.toUpperCase()} OK ✅` : `STEP8 ${MODE.toUpperCase()} FAILED`);
process.exit(claimed ? 0 : 1);
