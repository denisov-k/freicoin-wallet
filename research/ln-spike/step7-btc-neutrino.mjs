// step7: ФИНАЛ neutrino-интеграции. Чейн-фид LDK теперь тянет НАШ BtcNeutrino по настоящему
// Bitcoin-P2P (getheaders/getcfilters/getdata) через ws-мост — bitcoin-cli участвует только для
// управления стендом (майнинг, открытие канала Алисой), НЕ для данных LDK.
// Требует: bitcoind -regtest -peerblockfilters -port=18444; мост ws:3071→18444; мост ws:3070→alice:9741.
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import * as ldk from 'lightningdevkit';
import { WsLDKNet } from './ws-net.mjs';
import { LdkChainAdapter } from './ldk-chain.mjs';
import { BtcNeutrino } from '../../apps/web/src/services/light/net/btc-neutrino.mjs';

const BENCH = process.env.LNBENCH ?? '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/lnbench';
const BTCLI = ['/root/bitcoin-core/bin/bitcoin-cli', '-regtest', '-datadir=/root/btc-regtest', '-rpcport=18443'];
const LNCLI_A = ['lncli', `--lnddir=${BENCH}/alice`, '--network=regtest', '--rpcserver=127.0.0.1:10011'];
const btcli = (...a) => execFileSync(BTCLI[0], [...BTCLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const aliceA = (...a) => new Promise((res, rej) => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), ...a],
  { encoding: 'utf8' }, (e, out, err) => e ? rej(new Error((err || String(e)).slice(0, 200))) : res(JSON.parse(out))));

await ldk.initializeWasmFromBinary(readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'));

const logger = ldk.Logger.new_impl({ log: r => { const s = r.get_args(); if (/error|warn/i.test(s) && !/gossip/i.test(s)) console.log('  [ldk]', s.slice(0, 130)); } });
const feeEst = ldk.FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 2500 });
const broadcaster = ldk.BroadcasterInterface.new_impl({ broadcast_transactions: txs => { for (const t of txs) { try { btcli('sendrawtransaction', Buffer.from(t).toString('hex')); } catch {} } } });
const persist = ldk.Persist.new_impl({
  persist_new_channel: () => ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed,
  update_persisted_channel: () => ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed,
  archive_persisted_channel: () => {}, get_and_clear_completed_updates: () => [],
});
const now = Date.now();
const keys = ldk.KeysManager.constructor_new(randomBytes(32), BigInt(Math.floor(now / 1000)), (now % 1000) * 1e6, false);
const entropy = keys.as_EntropySource(), nodeSigner = keys.as_NodeSigner(), signerProvider = keys.as_SignerProvider();

const chain = new LdkChainAdapter();
const chainMonitor = ldk.ChainMonitor.constructor_new(ldk.Option_FilterZ.constructor_some(chain.filter), broadcaster, logger, feeEst, persist, entropy, ldk.PeerStorageKey.constructor_new(randomBytes(32)));
const network = ldk.Network.LDKNetwork_Regtest;
const netGraph = ldk.NetworkGraph.constructor_new(network, logger);
const scorer = ldk.ProbabilisticScorer.constructor_new(ldk.ProbabilisticScoringDecayParameters.constructor_default(), netGraph, logger);
const lockable = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
const router = ldk.DefaultRouter.constructor_new(netGraph, logger, entropy, lockable.as_LockableScore(), ldk.ProbabilisticScoringFeeParameters.constructor_default());
const msgRouter = ldk.DefaultMessageRouter.constructor_new(netGraph, entropy);
const config = ldk.UserConfig.constructor_default();
{ const h = config.get_channel_handshake_config(); h.set_max_inbound_htlc_value_in_flight_percent_of_channel(100); config.set_channel_handshake_config(h); }

const startHeight = +btcli('getblockcount');
const bestHash = btcli('getbestblockhash');
const bestBlock = ldk.BestBlock.constructor_new(Buffer.from(bestHash, 'hex').reverse(), startHeight);
const chanMgr = ldk.ChannelManager.constructor_new(feeEst, chainMonitor.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(),
  logger, entropy, nodeSigner, signerProvider, config, ldk.ChainParameters.constructor_new(network, bestBlock), Math.floor(now / 1000));
chain.attach(chanMgr, chainMonitor);
const ourId = Buffer.from(chanMgr.get_our_node_id()).toString('hex');
console.log('LDK node:', ourId, 'start height:', startHeight);

// ---- НАШ neutrino поверх Bitcoin-P2P через мост ----
const btc = new BtcNeutrino({ url: 'ws://127.0.0.1:3071', net: 'btcregtest', adapter: chain }); btc.debug = true;
btc.seedAnchor(bestHash, startHeight);   // якорь на текущей вершине — тянем только новые блоки
await btc.connect();
await btc.syncHeaders();
console.log('neutrino synced headers to height', btc.headers.at(-1)?.height ?? startHeight);

const R = randomBytes(32), H = createHash('sha256').update(R).digest();
let claimed = false, channelReady = false, held = false;
const handler = ldk.EventHandler.new_impl({ handle_event: e => {
  if (e instanceof ldk.Event_ChannelReady) { channelReady = true; console.log('EVENT ChannelReady (funding seen through OUR neutrino filter)'); }
  else if (e instanceof ldk.Event_PaymentClaimable) { held = true; console.log('EVENT PaymentClaimable — held, claim_funds(R)'); chanMgr.claim_funds(R); }
  else if (e instanceof ldk.Event_PaymentClaimed) { const h = Buffer.from(e.payment_hash).toString('hex'); if (h === H.toString('hex')) { claimed = true; console.log('EVENT PaymentClaimed ✅'); } }
  return ldk.Result_NoneReplayEventZ.constructor_ok();
} });
let lastTick = 0;
const pump = async () => {
  peerMgr.process_events(); chanMgr.process_pending_htlc_forwards?.();
  if (Date.now() - lastTick > 1000) { lastTick = Date.now(); chanMgr.timer_tick_occurred(); peerMgr.timer_tick_occurred(); }
  await btc.tick();   // neutrino: headers + filtered scan → adapter → LDK Confirm
  chanMgr.as_EventsProvider().process_pending_events(handler);
  chainMonitor.as_EventsProvider().process_pending_events(handler);
};

const ignoring = ldk.IgnoringMessageHandler.constructor_new();
const peerMgr = ldk.PeerManager.constructor_new(chanMgr.as_ChannelMessageHandler(), ignoring.as_RoutingMessageHandler(), ignoring.as_OnionMessageHandler(),
  ignoring.as_CustomMessageHandler(), ignoring.as_SendOnlyMessageHandler(), Math.floor(now / 1000), randomBytes(32), logger, nodeSigner);
const lnNet = new WsLDKNet(peerMgr);
const ALICE_PK = (await aliceA('getinfo')).identity_pubkey;
const ensurePeer = async () => {
  for (let i = 0; i < 60; i++) { peerMgr.process_events();
    if ((await aliceA('listpeers')).peers?.some(p => p.pub_key === ourId)) return;
    if (i % 10 === 0) { try { await lnNet.connect_peer('ws://127.0.0.1:3070', Buffer.from(ALICE_PK, 'hex')); } catch {} }
    await new Promise(r => setTimeout(r, 200)); }
  throw new Error('peer never came up');
};
await ensurePeer();

console.log('-- alice opens a 300k channel…');
await aliceA('openchannel', '--node_key', ourId, '--local_amt', '300000', '--private');
const mine = async n => { btcli('generatetoaddress', String(n), (await aliceA('newaddress', 'p2wkh')).address); };
for (let i = 0; i < 150 && !channelReady; i++) { if (i % 15 === 3) await mine(1); await pump(); await new Promise(r => setTimeout(r, 300)); }
if (!channelReady) { console.error('no channel'); process.exit(1); }
for (let i = 0; i < 50; i++) { await pump(); const cs = chanMgr.list_usable_channels(); if (cs.length && cs[0].get_counterparty_forwarding_info?.()) break; await new Promise(r => setTimeout(r, 200)); }
console.log('channel usable:', chanMgr.list_usable_channels().length > 0);

const descRes = ldk.Description.constructor_new('fw-neutrino');
const desc = ldk.Bolt11InvoiceDescription.constructor_direct(descRes.res ?? descRes);
const invRes = chanMgr.create_bolt11_invoice(ldk.Option_u64Z.constructor_some(40000n * 1000n), desc,
  ldk.Option_u32Z.constructor_some(1800), ldk.Option_u16Z.constructor_none(), ldk.Option_ThirtyTwoBytesZ.constructor_some(H));
if (!invRes.is_ok()) { console.error('invoice failed'); process.exit(1); }
const bolt11 = invRes.res.to_str();
const payer = new Promise(res => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), 'payinvoice', '--force', '--timeout', '45s', bolt11], () => res(null)));
for (let i = 0; i < 250 && !claimed; i++) { await pump(); await new Promise(r => setTimeout(r, 200)); }
await payer;
const pay = (await aliceA('listpayments')).payments.at(-1);
console.log('alice payment:', pay.status, '| preimage match:', pay.payment_preimage === R.toString('hex'));
console.log(claimed && pay.payment_preimage === R.toString('hex') ? 'STEP7 OK ✅ — neutrino feed drives an LN channel end-to-end' : 'STEP7 FAILED');
process.exit(claimed ? 0 : 1);
