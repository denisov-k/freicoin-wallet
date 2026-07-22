// step3: ПЕРСИСТЕНТНОСТЬ — ядро будущего VSS. Фаза `init`: поднять узел с постоянным сидом,
// получить канал от LSP, принять платёж, сериализовать ChannelManager+ChannelMonitor на диск и
// выйти. Фаза `resume`: НОВЫЙ процесс восстанавливает узел из байтов, докармливает пропущенные
// блоки, переустанавливает соединение (channel_reestablish) и принимает ВТОРОЙ платёж.
// Если resume проходит — «эти же байты на сервере» и есть VSS, дальше только транспорт.
// Запуск: node step3-restore.mjs init && node step3-restore.mjs resume
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import * as ldk from 'lightningdevkit';
import { NodeLDKNet } from 'lightningdevkit-node-net';

const MODE = process.argv[2];
if (!['init', 'resume'].includes(MODE)) { console.error('usage: node step3-restore.mjs init|resume'); process.exit(1); }
const BENCH = process.env.LNBENCH ?? '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/lnbench';
const DIR = `${BENCH}/ldknode`; mkdirSync(DIR, { recursive: true });
const BTCLI = ['/root/bitcoin-core/bin/bitcoin-cli', '-regtest', '-datadir=/root/btc-regtest', '-rpcport=18443'];
const LNCLI_A = ['lncli', `--lnddir=${BENCH}/alice`, '--network=regtest', '--rpcserver=127.0.0.1:10011'];
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const btcli = (...a) => sh(BTCLI[0], [...BTCLI.slice(1), ...a]).trim();
const aliceA = (...a) => new Promise((res, rej) => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), ...a],
  { encoding: 'utf8' }, (e, out, err) => e ? rej(new Error((err || String(e)).slice(0, 200))) : res(JSON.parse(out))));
const revHex = h => Buffer.from(h, 'hex').reverse();

await ldk.initializeWasmFromBinary(readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'));

// ---- постоянные сид и файлы состояния ----
const seedFile = `${DIR}/seed`; if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(32));
const seed = readFileSync(seedFile);
const managerFile = `${DIR}/manager.bin`, monitorFile = `${DIR}/monitor0.bin`, metaFile = `${DIR}/meta.json`;

const logger = ldk.Logger.new_impl({ log: r => { const s = r.get_args(); if (/error|warn/i.test(s) && !/gossip/i.test(s)) console.log('  [ldk]', s.slice(0, 130)); } });
const feeEst = ldk.FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 2500 });
const broadcaster = ldk.BroadcasterInterface.new_impl({ broadcast_transactions: txs => {
  for (const t of txs) { try { btcli('sendrawtransaction', Buffer.from(t).toString('hex')); } catch {} }
} });
// САМОЕ ВАЖНОЕ: каждый persist-колбэк пишет актуальные байты монитора на диск (в бою — в VSS,
// и только после ack продолжаем). Здесь single-channel, поэтому один файл.
const persist = ldk.Persist.new_impl({
  persist_new_channel: (name, mon) => { writeFileSync(monitorFile, mon.write()); return ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed; },
  update_persisted_channel: (name, upd, mon) => { writeFileSync(monitorFile, mon.write()); return ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed; },
  archive_persisted_channel: () => {},
  get_and_clear_completed_updates: () => [],
});
const now = Date.now();
const keys = ldk.KeysManager.constructor_new(seed, BigInt(Math.floor(now / 1000)), (now % 1000) * 1e6, false);
const entropy = keys.as_EntropySource(), nodeSigner = keys.as_NodeSigner(), signerProvider = keys.as_SignerProvider();
const chainMonitor = ldk.ChainMonitor.constructor_new(ldk.Option_FilterZ.constructor_none(), broadcaster, logger, feeEst, persist, entropy,
  ldk.PeerStorageKey.constructor_new(seed));
const network = ldk.Network.LDKNetwork_Regtest;
const netGraph = ldk.NetworkGraph.constructor_new(network, logger);
const scorer = ldk.ProbabilisticScorer.constructor_new(ldk.ProbabilisticScoringDecayParameters.constructor_default(), netGraph, logger);
const lockable = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
const router = ldk.DefaultRouter.constructor_new(netGraph, logger, entropy, lockable.as_LockableScore(), ldk.ProbabilisticScoringFeeParameters.constructor_default());
const msgRouter = ldk.DefaultMessageRouter.constructor_new(netGraph, entropy);
const config = ldk.UserConfig.constructor_default();
{ const h = config.get_channel_handshake_config(); h.set_max_inbound_htlc_value_in_flight_percent_of_channel(100); config.set_channel_handshake_config(h); }

let tipHeight, chanMgr;
if (MODE === 'init') {
  tipHeight = +btcli('getblockcount');
  const bestBlock = ldk.BestBlock.constructor_new(revHex(btcli('getbestblockhash')), tipHeight);
  chanMgr = ldk.ChannelManager.constructor_new(feeEst, chainMonitor.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(),
    logger, entropy, nodeSigner, signerProvider, config, ldk.ChainParameters.constructor_new(network, bestBlock), Math.floor(now / 1000));
} else {
  // ---- ВОССТАНОВЛЕНИЕ: сначала мониторы, потом менеджер с ними, потом watch_channel ----
  const monRes = ldk.UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read(readFileSync(monitorFile), entropy, signerProvider);
  if (!monRes.is_ok()) { console.error('monitor decode failed'); process.exit(1); }
  const monitor = monRes.res.get_b();
  const mgrRes = ldk.UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelManagerZ_read(readFileSync(managerFile), entropy, nodeSigner, signerProvider,
    feeEst, chainMonitor.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(), logger, config, [monitor]);
  if (!mgrRes.is_ok()) { console.error('manager decode failed'); process.exit(1); }
  chanMgr = mgrRes.res.get_b();
  const fundTxo = monitor.get_funding_txo();
  const outpoint = fundTxo.get_a ? fundTxo.get_a() : fundTxo;
  const wres = chainMonitor.as_Watch().watch_channel(outpoint, monitor);
  console.log('watch_channel restored:', wres.is_ok?.() ?? 'ok');
  tipHeight = JSON.parse(readFileSync(metaFile, 'utf8')).tipHeight;
  console.log('restored manager+monitor; resuming from height', tipHeight);
}
const ourId = Buffer.from(chanMgr.get_our_node_id()).toString('hex');
console.log('LDK node:', ourId, '(mode:', MODE + ')');

const R = randomBytes(32), H = createHash('sha256').update(R).digest();
let claimed = false, channelReady = false, held = false;
const handler = ldk.EventHandler.new_impl({ handle_event: e => {
  if (e instanceof ldk.Event_ChannelReady) { channelReady = true; console.log('EVENT ChannelReady'); }
  else if (e instanceof ldk.Event_PaymentClaimable) { held = true; console.log('EVENT PaymentClaimable — claim_funds(R)'); chanMgr.claim_funds(R); }
  else if (e instanceof ldk.Event_PaymentClaimed) { claimed = true; console.log('EVENT PaymentClaimed ✅'); }
  return ldk.Result_NoneReplayEventZ.constructor_ok();
} });
const pump = () => { peerMgr.process_events(); chanMgr.process_pending_htlc_forwards?.(); chanMgr.as_EventsProvider().process_pending_events(handler); chainMonitor.as_EventsProvider().process_pending_events(handler); };
const feedTo = height => {
  while (tipHeight < height) {
    tipHeight++;
    const raw = Buffer.from(btcli('getblock', btcli('getblockhash', String(tipHeight)), '0'), 'hex');
    chanMgr.as_Listen().block_connected(raw, tipHeight);
    chainMonitor.as_Listen().block_connected(raw, tipHeight);
  }
};

const ignoring = ldk.IgnoringMessageHandler.constructor_new();
const peerMgr = ldk.PeerManager.constructor_new(chanMgr.as_ChannelMessageHandler(), ignoring.as_RoutingMessageHandler(), ignoring.as_OnionMessageHandler(),
  ignoring.as_CustomMessageHandler(), ignoring.as_SendOnlyMessageHandler(), Math.floor(now / 1000), randomBytes(32), logger, nodeSigner);
const net = new NodeLDKNet(peerMgr);
const ALICE_PK = (await aliceA('getinfo')).identity_pubkey;
const ensurePeer = async () => {
  for (let i = 0; i < 60; i++) {
    peerMgr.process_events();
    if ((await aliceA('listpeers')).peers?.some(p => p.pub_key === ourId)) return;
    if (i % 10 === 0) { try { await net.connect_peer('127.0.0.1', 9741, Buffer.from(ALICE_PK, 'hex')); } catch {} }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('peer never came up');
};
feedTo(+btcli('getblockcount'));   // resume: докормить пропущенное ДО реестаблиша
await ensurePeer();

if (MODE === 'init') {
  console.log('-- alice opens a 300k channel…');
  await aliceA('openchannel', '--node_key', ourId, '--local_amt', '300000', '--private');
  const mine = async n => { btcli('generatetoaddress', String(n), (await aliceA('newaddress', 'p2wkh')).address); feedTo(+btcli('getblockcount')); };
  for (let i = 0; i < 120 && !channelReady; i++) { if (i % 15 === 3) await mine(1); pump(); await new Promise(r => setTimeout(r, 300)); }
  if (!channelReady) { console.error('no channel'); process.exit(1); }
} else {
  // канал уже есть — ждём реестаблиш до usable
  for (let i = 0; i < 100 && !chanMgr.list_usable_channels().length; i++) { pump(); await new Promise(r => setTimeout(r, 200)); }
}
for (let i = 0; i < 50; i++) {
  pump();
  const cs = chanMgr.list_usable_channels();
  if (cs.length && cs[0].get_counterparty_forwarding_info?.()) break;
  await new Promise(r => setTimeout(r, 200));
}
console.log('channel usable:', chanMgr.list_usable_channels().length > 0);

// ---- платёж (в обеих фазах — resume доказывает, что восстановленный канал ЖИВОЙ) ----
const descRes = ldk.Description.constructor_new('fw-restore-' + MODE);
const desc = ldk.Bolt11InvoiceDescription.constructor_direct(descRes.res ?? descRes);
const invRes = chanMgr.create_bolt11_invoice(
  ldk.Option_u64Z.constructor_some(30000n * 1000n), desc,
  ldk.Option_u32Z.constructor_some(1800), ldk.Option_u16Z.constructor_none(),
  ldk.Option_ThirtyTwoBytesZ.constructor_some(H));
if (!invRes.is_ok()) { console.error('invoice failed'); process.exit(1); }
const bolt11 = invRes.res.to_str();
const payer = new Promise(res => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), 'payinvoice', '--force', '--timeout', '45s', bolt11], { encoding: 'utf8' }, (e, out, err) => { console.log('payinvoice:', (out || '').slice(-220).replace(/\n/g, ' '), (err || '').slice(-160)); res(null); }));
for (let i = 0; i < 250 && !claimed; i++) { pump(); await new Promise(r => setTimeout(r, 200)); }
await payer;
const pay = (await aliceA('listpayments')).payments.at(-1);
console.log('alice payment:', pay.status, '| preimage match:', pay.payment_preimage === R.toString('hex'));

// ---- сериализация состояния под следующий запуск ----
writeFileSync(managerFile, chanMgr.write());
writeFileSync(metaFile, JSON.stringify({ tipHeight }));
console.log('state saved:', 'manager', chanMgr.write().length, 'bytes; monitor', existsSync(monitorFile) ? readFileSync(monitorFile).length : 0, 'bytes');
console.log(claimed ? `STEP3 ${MODE.toUpperCase()} OK ✅` : `STEP3 ${MODE.toUpperCase()} FAILED`);
process.exit(claimed ? 0 : 1);
