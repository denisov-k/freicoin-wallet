// step1: LDK-wasm поднимается как узел и делает LN-рукопожатие с бенчевой Алисой (LND).
// Проверяет toolchain целиком: wasm-инициализация, трейты через new_impl, PeerManager, TCP-мост.
// Запуск: node step1-handshake.mjs <alice_pubkey_hex>
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import * as ldk from 'lightningdevkit';
import { NodeLDKNet } from 'lightningdevkit-node-net';

const ALICE_PK = process.argv[2];
if (!/^[0-9a-f]{66}$/.test(ALICE_PK ?? '')) { console.error('usage: node step1-handshake.mjs <alice_pubkey_hex>'); process.exit(1); }

await ldk.initializeWasmFromBinary(readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'));
console.log('wasm ok, LDK', ldk.get_ldk_version?.() ?? '(version fn n/a)');

// ---- трейты-заглушки, достаточные для рукопожатия ----
const logger = ldk.Logger.new_impl({ log: r => { const s = r.get_args(); if (!/GossipSync|Persist/.test(s)) console.log('  [ldk]', s.slice(0, 110)); } });
const feeEst = ldk.FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 253 });
const broadcaster = ldk.BroadcasterInterface.new_impl({ broadcast_transactions: txs => console.log('  broadcast requested:', txs.length) });
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

const peerStorageKey = ldk.PeerStorageKey.constructor_new ? ldk.PeerStorageKey.constructor_new(randomBytes(32)) : null;
const chainMonitor = ldk.ChainMonitor.constructor_new(ldk.Option_FilterZ.constructor_none(), broadcaster, logger, feeEst, persist, entropy, peerStorageKey);

const network = ldk.Network.LDKNetwork_Regtest;
const netGraph = ldk.NetworkGraph.constructor_new(network, logger);
const scorerParams = ldk.ProbabilisticScoringDecayParameters.constructor_default?.() ?? null;
const scorer = ldk.ProbabilisticScorer.constructor_new(scorerParams, netGraph, logger);
const lockable = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
const router = ldk.DefaultRouter.constructor_new(netGraph, logger, entropy, lockable.as_LockableScore(), ldk.ProbabilisticScoringFeeParameters.constructor_default());

// best block: спрашивать не обязательно — для рукопожатия хватит генезиса регтеста
const bestBlock = ldk.BestBlock.constructor_from_network(network);
const params = ldk.ChainParameters.constructor_new(network, bestBlock);
const config = ldk.UserConfig.constructor_default();

const msgRouter = ldk.DefaultMessageRouter.constructor_new(netGraph, entropy);
const chanMgr = ldk.ChannelManager.constructor_new(feeEst, chainMonitor.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(),
  logger, entropy, nodeSigner, signerProvider, config, params, Math.floor(now / 1000));

const ourId = Buffer.from(chanMgr.get_our_node_id()).toString('hex');
console.log('LDK node id:', ourId);

const ignoring = ldk.IgnoringMessageHandler.constructor_new();
const peerMgr = ldk.PeerManager.constructor_new(chanMgr.as_ChannelMessageHandler(), ignoring.as_RoutingMessageHandler(), ignoring.as_OnionMessageHandler(),
  ignoring.as_CustomMessageHandler(), ignoring.as_SendOnlyMessageHandler(), Math.floor(now / 1000), randomBytes(32), logger, nodeSigner);

const net = new NodeLDKNet(peerMgr);
await net.connect_peer('127.0.0.1', 9741, Buffer.from(ALICE_PK, 'hex'));
// дождаться завершения noise/init-обмена
for (let i = 0; i < 50; i++) {
  peerMgr.process_events();
  const peers = peerMgr.list_peers();
  if (peers.length && peers[0].get_counterparty_node_id) {
    const pk = Buffer.from(peers[0].get_counterparty_node_id()).toString('hex');
    if (pk === ALICE_PK) { console.log('HANDSHAKE OK ✅ peer:', pk.slice(0, 20) + '…'); process.exit(0); }
  }
  await new Promise(r => setTimeout(r, 200));
}
console.error('handshake timed out');
process.exit(1);
