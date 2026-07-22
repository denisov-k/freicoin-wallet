// step5: ПОЛНЫЙ браузерный контур — WS-транспорт (шаг 4) + НЕЙТРИНО-КОРМЛЕНИЕ цепи:
// вместо полных блоков через Listen LDK получает только то, что сам заказал через Filter.
// Решение «совпал/не совпал» принимает НАСТОЯЩИЙ BIP158-фильтр блока (getblockfilter) против
// watch-set'а адаптера — ровно тот контракт, который в кошельке исполняет neutrino-клиент.
// Запуск: node step5-neutrino-feed.mjs (мост 3070 + bitcoind с -blockfilterindex=1)
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import * as ldk from 'lightningdevkit';
import { WsLDKNet } from './ws-net.mjs';
import { LdkChainAdapter } from './ldk-chain.mjs';

const BENCH = process.env.LNBENCH ?? '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/lnbench';
const BTCLI = ['/root/bitcoin-core/bin/bitcoin-cli', '-regtest', '-datadir=/root/btc-regtest', '-rpcport=18443'];
const LNCLI_A = ['lncli', `--lnddir=${BENCH}/alice`, '--network=regtest', '--rpcserver=127.0.0.1:10011'];
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const btcli = (...a) => sh(BTCLI[0], [...BTCLI.slice(1), ...a]).trim();
const alice = (...a) => JSON.parse(sh(LNCLI_A[0], [...LNCLI_A.slice(1), ...a]));   // только ДО поднятия LN-сокета
const aliceA = (...a) => new Promise((res, rej) => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), ...a],
  { encoding: 'utf8' }, (e, out, err) => e ? rej(new Error(err || String(e))) : res(JSON.parse(out))));
const revHex = h => Buffer.from(h, 'hex').reverse();

// фондируем Алису ДО поднятия LN-соединения: синхронный майнинг душит event loop,
// а без живого сокета душить нечего
if (+alice('walletbalance').confirmed_balance < 600000) {
  console.log('-- funding alice on-chain…');
  const aaddr = alice('newaddress', 'p2wkh').address;
  btcli('generatetoaddress', '105', aaddr);
  for (let i = 0; i < 30 && +alice('walletbalance').confirmed_balance < 600000; i++) await new Promise(r => setTimeout(r, 500));
  console.log('alice confirmed:', alice('walletbalance').confirmed_balance);
}

await ldk.initializeWasmFromBinary(readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'));

// ---- узел (как step1, но с реальным best block и логом только важного) ----
const logger = ldk.Logger.new_impl({ log: r => { const s = r.get_args(); if (/fail|htlc|error|warn|claim/i.test(s)) console.log('  [ldk]', s.slice(0, 400)); } });
const feeEst = ldk.FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 2500 });
const broadcaster = ldk.BroadcasterInterface.new_impl({ broadcast_transactions: txs => {
  for (const t of txs) { try { btcli('sendrawtransaction', Buffer.from(t).toString('hex')); console.log('  broadcast ok'); } catch (e) { console.log('  broadcast fail:', String(e).slice(0, 80)); } }
} });
const persist = ldk.Persist.new_impl({
  persist_new_channel: () => ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed,
  update_persisted_channel: () => ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed,
  archive_persisted_channel: () => {},
  get_and_clear_completed_updates: () => [],
});
const seed = randomBytes(32);
const now = Date.now();
const keys = ldk.KeysManager.constructor_new(seed, BigInt(Math.floor(now / 1000)), (now % 1000) * 1e6, false);
const entropy = keys.as_EntropySource(), nodeSigner = keys.as_NodeSigner(), signerProvider = keys.as_SignerProvider();
const chain = new LdkChainAdapter();
chain.onWatch = spk => console.log('  [filter] LDK просит следить за spk', spk.slice(0, 24) + '…');
const chainMonitor = ldk.ChainMonitor.constructor_new(ldk.Option_FilterZ.constructor_some(chain.filter), broadcaster, logger, feeEst, persist, entropy,
  ldk.PeerStorageKey.constructor_new(randomBytes(32)));
const network = ldk.Network.LDKNetwork_Regtest;
const netGraph = ldk.NetworkGraph.constructor_new(network, logger);
const scorer = ldk.ProbabilisticScorer.constructor_new(ldk.ProbabilisticScoringDecayParameters.constructor_default(), netGraph, logger);
const lockable = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
const router = ldk.DefaultRouter.constructor_new(netGraph, logger, entropy, lockable.as_LockableScore(), ldk.ProbabilisticScoringFeeParameters.constructor_default());
let tipHeight = +btcli('getblockcount');
let tipHash = btcli('getbestblockhash');
const bestBlock = ldk.BestBlock.constructor_new(revHex(tipHash), tipHeight);
const params = ldk.ChainParameters.constructor_new(network, bestBlock);
const config = ldk.UserConfig.constructor_default();
{ const h = config.get_channel_handshake_config(); h.set_max_inbound_htlc_value_in_flight_percent_of_channel(100); config.set_channel_handshake_config(h); }
const msgRouter = ldk.DefaultMessageRouter.constructor_new(netGraph, entropy);
const chanMgr = ldk.ChannelManager.constructor_new(feeEst, chainMonitor.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(),
  logger, entropy, nodeSigner, signerProvider, config, params, Math.floor(now / 1000));
chain.attach(chanMgr, chainMonitor);
const ourId = Buffer.from(chanMgr.get_our_node_id()).toString('hex');
console.log('LDK node:', ourId, 'tip:', tipHeight);

const ignoring = ldk.IgnoringMessageHandler.constructor_new();
const peerMgr = ldk.PeerManager.constructor_new(chanMgr.as_ChannelMessageHandler(), ignoring.as_RoutingMessageHandler(), ignoring.as_OnionMessageHandler(),
  ignoring.as_CustomMessageHandler(), ignoring.as_SendOnlyMessageHandler(), Math.floor(now / 1000), randomBytes(32), logger, nodeSigner);
const net = new WsLDKNet(peerMgr);
const ALICE_PK = (await aliceA('getinfo')).identity_pubkey;
await net.connect_peer('ws://127.0.0.1:3070', Buffer.from(ALICE_PK, 'hex'));
const ensurePeer = async () => {   // LND роняет молчаливого пира — переподключаемся при нужде
  for (let i = 0; i < 50; i++) {
    peerMgr.process_events();
    if ((await aliceA('listpeers')).peers?.some(p => p.pub_key === ourId)) return;
    if (i % 10 === 5) { try { await net.connect_peer('ws://127.0.0.1:3070', Buffer.from(ALICE_PK, 'hex')); } catch {} }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('peer never came up');
};
await ensurePeer();

// ---- события: удержание платежа с нашим H, клейм по «раскрытию» R ----
const R = randomBytes(32);
const H = createHash('sha256').update(R).digest();
let held = false, claimed = false, channelReady = false;
const handler = ldk.EventHandler.new_impl({ handle_event: e => {
  const name = e.constructor?.name ?? 'Event';
  if (e instanceof ldk.Event_ChannelReady) { channelReady = true; console.log('EVENT ChannelReady'); }
  else if (e instanceof ldk.Event_PaymentClaimable) {
    const h = Buffer.from(e.payment_hash).toString('hex');
    console.log('EVENT PaymentClaimable', (Number(e.amount_msat) / 1000), 'sat, hash', h.slice(0, 16) + '…');
    if (h === H.toString('hex')) { held = true; console.log('>>> ПЛАТЁЖ УДЕРЖАН (не клеймим — ждём «раскрытия» R)'); }
  }
  else if (e instanceof ldk.Event_PaymentClaimed) { claimed = true; console.log('EVENT PaymentClaimed ✅'); }
  else if (e instanceof ldk.Event_ChannelPending) console.log('EVENT ChannelPending');
  else if (e instanceof ldk.Event_HTLCHandlingFailed) console.log('EVENT HTLCHandlingFailed:', e.failure_type?.constructor?.name, '|', e.failure_reason?.some?.constructor?.name ?? e.failure_reason?.constructor?.name);
  else console.log('EVENT', name);
  return ldk.Result_NoneReplayEventZ.constructor_ok();
} });
const pump = () => { peerMgr.process_events(); chanMgr.process_pending_htlc_forwards?.(); chanMgr.as_EventsProvider().process_pending_events(handler); chainMonitor.as_EventsProvider().process_pending_events(handler); };

// ---- фид цепи: скармливаем новые блоки обоим Listen ----
// BIP158 basic-фильтр содержит скрипты выходов + скрипты трат — матчим по watch-set'у
// адаптера тем же решением, что даёт GCS-матчер кошелька (здесь берём фильтр узла как
// источник истины: пуст watch-set или нет пересечения → блок даже не скачивается)
const gcsMatch = (blockHash) => {
  if (!chain.watchedSpks.size && !chain.watchedTxids.size) return false;
  const f = JSON.parse(btcli('getblockfilter', blockHash)).filter;
  return f.length > 2;   // на регтесте блоки крошечные: непустой фильтр → проверяем содержимым
};
const feedTo = height => {
  while (tipHeight < height) {
    tipHeight++;
    tipHash = btcli('getblockhash', String(tipHeight));
    const hdr80 = Buffer.from(btcli('getblockheader', tipHash, 'false'), 'hex');
    if (!gcsMatch(tipHash)) { chain.tipAdvanced(hdr80, tipHeight); continue; }
    const blk = JSON.parse(btcli('getblock', tipHash, '3'));
    const relevant = [];
    blk.tx.forEach((t, index) => {
      const outs = t.vout.map(o => o.scriptPubKey.hex);
      const prevSpks = (t.vin || []).map(v => v.prevout?.scriptPubKey?.hex).filter(Boolean);
      if (chain.isRelevant({ txid: t.txid, outs }, prevSpks)) relevant.push({ index, raw: Buffer.from(t.hex, 'hex') });
    });
    if (relevant.length) console.log(`  [feed] блок ${tipHeight}: релевантных tx ${relevant.length}`);
    chain.blockConnected(hdr80, tipHeight, relevant);
  }
};
const mine = async n => { btcli('generatetoaddress', String(n), (await aliceA('newaddress', 'p2wkh')).address); feedTo(+btcli('getblockcount')); };

// ---- Алиса открывает канал НА НАС (входящий, весь баланс на её стороне) ----
await ensurePeer();
console.log('-- alice opens a 500k channel to LDK…');
const fund = await aliceA('openchannel', '--node_key', ourId, '--local_amt', '500000', '--private');
console.log('funding tx:', fund.funding_txid);
for (let i = 0; i < 120 && !channelReady; i++) { if (i % 15 === 3) await mine(1); pump(); await new Promise(r => setTimeout(r, 300)); }
if (!channelReady) { console.error('channel never became ready'); process.exit(1); }
const usable = () => chanMgr.list_usable_channels().length > 0;
for (let i = 0; i < 30 && !usable(); i++) { pump(); await new Promise(r => setTimeout(r, 200)); }
console.log('channel usable:', usable());

// ---- инвойс под ВНЕШНИЙ H, оплата Алисой, удержание, клейм R ----
// приватному каналу нужен route hint в инвойсе, а hint появляется только после channel_update
// от пира — дождёмся counterparty_forwarding_info
for (let i = 0; i < 50; i++) {
  pump();
  const cs = chanMgr.list_usable_channels();
  if (cs.length && cs[0].get_counterparty_forwarding_info?.()) { console.log('forwarding info ready'); break; }
  await new Promise(r => setTimeout(r, 200));
}
const descRes = ldk.Description.constructor_new('fw-swap');
const desc = ldk.Bolt11InvoiceDescription.constructor_direct(descRes.res ?? descRes);
const invRes = chanMgr.create_bolt11_invoice(
  ldk.Option_u64Z.constructor_some(40000n * 1000n), desc,
  ldk.Option_u32Z.constructor_some(1800), ldk.Option_u16Z.constructor_none(),
  ldk.Option_ThirtyTwoBytesZ.constructor_some(H));
if (!invRes.is_ok()) { console.error('invoice failed'); process.exit(1); }
const bolt11 = invRes.res.to_str();
console.log('invoice under swap-H:', bolt11.slice(0, 40) + '…');
const chans = (await aliceA('listchannels')).channels;
console.log('alice sees channel:', JSON.stringify(chans.map(c => ({ active: c.active, priv: c.private, id: c.chan_id }))));
const dec = await aliceA('decodepayreq', bolt11);
console.log('decoded: dest', dec.destination.slice(0, 16), 'cltv', dec.cltv_expiry, 'hints', JSON.stringify(dec.route_hints));
const payer = new Promise(res => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), 'payinvoice', '--force', '--timeout', '60s', bolt11], { encoding: 'utf8' }, (e, out, err) => { console.log('payinvoice out:', (out||'').slice(-400)); if (err) console.log('payinvoice err:', err.slice(-200)); res(null); }));
for (let i = 0; i < 350 && !held; i++) { pump(); await new Promise(r => setTimeout(r, 200)); }
if (!held) {
  const lp = (await aliceA('listpayments')).payments.at(-1);
  console.error('not claimable; alice payment:', lp?.status, lp?.failure_reason, JSON.stringify((lp?.htlcs ?? []).map(h => h.failure?.code)));
  process.exit(1);
}
await new Promise(r => setTimeout(r, 2000));   // подержим — доказательство hold-семантики
console.log('-- claim_funds(R): «R раскрылся в FRC-клейме»');
chanMgr.claim_funds(R);
for (let i = 0; i < 50 && !claimed; i++) { pump(); await new Promise(r => setTimeout(r, 200)); }
await payer;
const pay = (await aliceA('listpayments')).payments.at(-1);
console.log('alice payment:', pay.status, 'preimage:', pay.payment_preimage?.slice(0, 16) + '…', '(ждали', R.toString('hex').slice(0, 16) + '…)');
const ch = chanMgr.list_channels()[0];
console.log('LDK balance msat:', ch ? Number(ch.get_balance_msat?.() ?? 0) : 'n/a');
console.log(claimed && pay.payment_preimage === R.toString('hex') ? 'STEP5 OK ✅' : 'STEP5 FAILED');
process.exit(claimed ? 0 : 1);
