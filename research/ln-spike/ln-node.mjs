// ln-node.mjs — СБОРКА фазы 2: единый LN-узел кошелька из доказанных компонентов —
//   LDK (ChannelManager/ChainMonitor)  ×  BtcNeutrino (чейн-фид)  ×  WsLDKNet (транспорт к LSP)
//   ×  VSS (шифрованный версионный бэкап мониторов).
// Работает и в Node (стенд), и в браузерном воркере (WebSocket/WebCrypto — те же API).
// Персистентность мониторов — АСИНХРОННАЯ: Persist возвращает InProgress, пишет монитор в VSS под
// версией = get_latest_update_id() (монотонный счётчик → анти-откат VSS «бесплатно»), и по ack
// зовёт chain_monitor.channel_monitor_updated(). ChannelManager сериализуется в VSS после событий.
import * as ldk from 'lightningdevkit';
import { WsLDKNet } from './ws-net.mjs';
import { LdkChainAdapter } from './ldk-chain.mjs';
import { BtcNeutrino } from '../../apps/web/src/services/light/net/btc-neutrino.mjs';

const NET = { btcregtest: ldk.Network.LDKNetwork_Regtest, btcsignet: ldk.Network.LDKNetwork_Signet, btcmain: ldk.Network.LDKNetwork_Bitcoin };
const MGR_KEY = 'manager';   // VSS key for the serialized ChannelManager

export class LnNode {
  /** @param {{seedBytes:Uint8Array, net:'btcregtest'|'btcsignet'|'btcmain', lspUrl:string, btcUrl:string,
   *           vss:import('../../apps/web/src/services/light/net/vss-client.mjs').VssClient,
   *           anchor:{hash:string,height:number}, broadcast:(hex:string)=>void, log?:Function}} o */
  constructor(o) {
    this.o = o; this.log = o.log ?? (() => {});
    this.on = { channelReady: () => {}, paymentClaimable: () => {}, paymentClaimed: () => {} };
    this._mgrVersion = 0;
  }

  async start() {
    const o = this.o;
    const logger = ldk.Logger.new_impl({ log: r => { const s = r.get_args(); if (/error|warn/i.test(s) && !/gossip/i.test(s)) this.log('[ldk]', s.slice(0, 130)); } });
    const feeEst = ldk.FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 2500 });
    const broadcaster = ldk.BroadcasterInterface.new_impl({ broadcast_transactions: txs => { for (const t of txs) try { o.broadcast(Buffer.from(t).toString('hex')); } catch {} } });

    // ---- ASYNC PERSIST → VSS. version = monitor.get_latest_update_id() (monotonic → anti-rollback).
    const chainMonitorRef = { cm: null };
    const persistMonitor = (monitor) => {
      const updId = monitor.get_latest_update_id();
      o.vss.put('mon_' + this._chanKey(monitor), Number(updId), monitor.write())
        .then(() => { try { chainMonitorRef.cm.channel_monitor_updated(monitor.channel_id(), updId); } catch (e) { this.log('cmu err', e.message); } })
        .catch(e => this.log('VSS monitor persist failed', e.message));   // InProgress stays; LDK retries via a later update
      return ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    };
    const persist = ldk.Persist.new_impl({
      persist_new_channel: (_name, monitor) => persistMonitor(monitor),
      update_persisted_channel: (_name, _upd, monitor) => persistMonitor(monitor),
      archive_persisted_channel: () => {},
      get_and_clear_completed_updates: () => [],
    });

    const keys = ldk.KeysManager.constructor_new(o.seedBytes, BigInt(this._nowSec()), this._nowNanos(), false);
    this.entropy = keys.as_EntropySource(); this.nodeSigner = keys.as_NodeSigner(); this.signerProvider = keys.as_SignerProvider();

    // The chain feed is Filter-driven, so the ChainMonitor must be built WITH the adapter's Filter
    // (LDK registers funding/commitment scripts through it at construction).
    const chain = new LdkChainAdapter();
    const cm2 = ldk.ChainMonitor.constructor_new(ldk.Option_FilterZ.constructor_some(chain.filter), broadcaster, logger, feeEst, persist, this.entropy, ldk.PeerStorageKey.constructor_new(o.seedBytes));
    chainMonitorRef.cm = cm2; this._chainMonitor = cm2;

    const network = NET[o.net];
    const netGraph = ldk.NetworkGraph.constructor_new(network, logger);
    const scorer = ldk.ProbabilisticScorer.constructor_new(ldk.ProbabilisticScoringDecayParameters.constructor_default(), netGraph, logger);
    const lockable = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
    const router = ldk.DefaultRouter.constructor_new(netGraph, logger, this.entropy, lockable.as_LockableScore(), ldk.ProbabilisticScoringFeeParameters.constructor_default());
    const msgRouter = ldk.DefaultMessageRouter.constructor_new(netGraph, this.entropy);
    const config = ldk.UserConfig.constructor_default();
    { const h = config.get_channel_handshake_config(); h.set_max_inbound_htlc_value_in_flight_percent_of_channel(100); config.set_channel_handshake_config(h); }

    // ---- RESTORE from VSS (monitors first, then manager with them) or start fresh ----
    const restored = await this._restore(cm2, feeEst, broadcaster, router, msgRouter, logger, config).catch(e => { this.log('restore skipped:', e.message); return null; });
    if (restored) {
      this.chanMgr = restored;
      this.log('restored ChannelManager from VSS');
    } else {
      const best = ldk.BestBlock.constructor_new(Buffer.from(o.anchor.hash, 'hex').reverse(), o.anchor.height);
      this.chanMgr = ldk.ChannelManager.constructor_new(feeEst, cm2.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(),
        logger, this.entropy, this.nodeSigner, this.signerProvider, config, ldk.ChainParameters.constructor_new(network, best), this._nowSec());
    }
    chain.attach(this.chanMgr, cm2);
    this.chain = chain;
    this.nodeId = Buffer.from(this.chanMgr.get_our_node_id()).toString('hex');

    // ---- transports: LN peer (to LSP) + BtcNeutrino chain feed ----
    const ignoring = ldk.IgnoringMessageHandler.constructor_new();
    this.peerMgr = ldk.PeerManager.constructor_new(this.chanMgr.as_ChannelMessageHandler(), ignoring.as_RoutingMessageHandler(), ignoring.as_OnionMessageHandler(),
      ignoring.as_CustomMessageHandler(), ignoring.as_SendOnlyMessageHandler(), this._nowSec(), this._rand(32), logger, this.nodeSigner);
    this.lnNet = new WsLDKNet(this.peerMgr);
    this.btc = new BtcNeutrino({ url: o.btcUrl, net: o.net, adapter: chain });
    this.btc.seedAnchor(o.anchor.hash, o.anchor.height);
    await this.btc.connect();
    await this.btc.syncHeaders();

    this._handler = ldk.EventHandler.new_impl({ handle_event: e => { this._handleEvent(e); return ldk.Result_NoneReplayEventZ.constructor_ok(); } });
    this._logger = logger;
    return this;
  }

  _chanKey(monitor) {
    // stable per-channel VSS key from the channel id bytes
    const chId = monitor.channel_id();
    const raw = chId.write ? chId.write() : new Uint8Array();
    return Buffer.from(raw).toString('hex').slice(0, 32) || 'ch';
  }
  async _restore(cm2, feeEst, broadcaster, router, msgRouter, logger, config) {
    const list = await this.o.vss.list();
    const monEntries = list.filter(x => x.key.startsWith('mon_'));
    if (!monEntries.length) return null;
    const monitors = [];
    for (const e of monEntries) {
      const g = await this.o.vss.get(e.key); if (!g) continue;
      const res = ldk.UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read(g.bytes, this.entropy, this.signerProvider);
      if (res.is_ok()) monitors.push(res.res.get_b());
    }
    const mgr = await this.o.vss.get(MGR_KEY);
    if (!mgr || !monitors.length) return null;
    this._mgrVersion = mgr.version;
    const r = ldk.UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelManagerZ_read(mgr.bytes, this.entropy, this.nodeSigner, this.signerProvider,
      feeEst, cm2.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(), logger, config, monitors);
    if (!r.is_ok()) { this.log('manager read NOT ok'); return null; }
    const mgrObj = r.res.get_b();
    this.log(`restore: ${monitors.length} monitors, manager channels ${mgrObj.list_channels().length}`);
    // re-register restored monitors so ChainMonitor watches them
    for (const m of monitors) cm2.as_Watch().watch_channel(m.channel_id(), m);
    return mgrObj;
  }
  async _persistManager() {
    const now = Date.now();
    if (now - (this._lastMgrPersist ?? 0) < 2500) { this._mgrDirty = true; return; }   // coalesce bursts — the trailing flush in tick() writes it
    await this.flushManager();
  }
  /** Write the CURRENT manager state now, bypassing the throttle (critical points: ChannelReady, exit). */
  async flushManager() {
    this._lastMgrPersist = Date.now(); this._mgrDirty = false;
    try { this._mgrVersion++; await this.o.vss.put(MGR_KEY, this._mgrVersion, this.chanMgr.write()); }
    catch (e) { this.log('VSS manager persist failed', e.message); this._mgrVersion--; }
  }

  _handleEvent(e) {
    if (e instanceof ldk.Event_ChannelReady) { this.log('ChannelReady'); this.on.channelReady(); }
    else if (e instanceof ldk.Event_PaymentClaimable) {
      const hash = Buffer.from(e.payment_hash).toString('hex'), amt = Number(e.amount_msat) / 1000;
      this.log('PaymentClaimable', amt, 'sat'); this.on.paymentClaimable(hash, amt);
    }
    else if (e instanceof ldk.Event_PaymentClaimed) { this.on.paymentClaimed(Buffer.from(e.payment_hash).toString('hex')); }
  }

  /** Drive one cycle: peer + HTLC forwards + timer + chain feed + events. Persist manager after. */
  async tick() {
    this.peerMgr.process_events();
    this.chanMgr.process_pending_htlc_forwards?.();
    const now = this._nowMs();
    if (now - (this._lastTick ?? 0) > 1000) { this._lastTick = now; this.chanMgr.timer_tick_occurred(); this.peerMgr.timer_tick_occurred(); }
    await this.btc.tick();
    let had = false;
    const h = ldk.EventHandler.new_impl({ handle_event: e => { had = true; this._handleEvent(e); return ldk.Result_NoneReplayEventZ.constructor_ok(); } });
    this.chanMgr.as_EventsProvider().process_pending_events(h);
    this._chainMonitor.as_EventsProvider().process_pending_events(h);
    if (had) await this._persistManager();   // channel state changed → back up the manager
    else if (this._mgrDirty && Date.now() - (this._lastMgrPersist ?? 0) >= 2500) await this.flushManager();   // trailing flush of a coalesced write
  }

  async connectLsp(wsUrl, lspNodeIdHex) { return this.lnNet.connect_peer(wsUrl, Buffer.from(lspNodeIdHex, 'hex')); }

  /** HOLD invoice under an EXTERNAL swap hash — the atomic-reverse primitive. */
  createHoldInvoice(hashHex, sats, memo = 'Freimarkets swap') {
    const descRes = ldk.Description.constructor_new(memo);
    const desc = ldk.Bolt11InvoiceDescription.constructor_direct(descRes.res ?? descRes);
    const res = this.chanMgr.create_bolt11_invoice(ldk.Option_u64Z.constructor_some(BigInt(sats) * 1000n), desc,
      ldk.Option_u32Z.constructor_some(1800), ldk.Option_u16Z.constructor_none(), ldk.Option_ThirtyTwoBytesZ.constructor_some(Buffer.from(hashHex, 'hex')));
    if (!res.is_ok()) throw new Error('invoice creation failed');
    return res.res.to_str();
  }
  claimFunds(preimageHex) { this.chanMgr.claim_funds(Buffer.from(preimageHex, 'hex')); }
  usableChannels() { return this.chanMgr.list_usable_channels(); }
  // "how much I can send out" — outbound capacity (this LDK exposes no single get_balance_msat)
  outboundMsat() { return this.chanMgr.list_channels().reduce((s, c) => s + Number(c.get_outbound_capacity_msat?.() ?? 0), 0); }

  _nowMs() { return typeof performance !== 'undefined' ? Date.now() : Date.now(); }
  _nowSec() { return Math.floor(Date.now() / 1000); }
  _nowNanos() { return (Date.now() % 1000) * 1e6; }
  _rand(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
}
