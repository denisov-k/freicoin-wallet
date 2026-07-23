// @ts-nocheck — LDK-биндинги нетипизированы под tsc (.res живёт на подклассах Result, wasm-ассет ?url); корректность закрыта step9-стендом
// ln-node.mjs — LN-узел кошелька (фаза 2): LDK-wasm × чейн-фид × ws-транспорт × VSS.
// Продуктовый порт доказанной сборки research/ln-spike/ln-node.mjs (step8: init+resume OK против
// реальных LND/bitcoind/VSS-релея). Файл браузерного сорта: ни fs, ни node-импортов; wasm
// инициализирует ХОЗЯИН (воркер — fetch'ем ассета, стенд — readFileSync) до start().
//
// Персистентность — АСИНХРОННАЯ: Persist возвращает InProgress, монитор уходит в VSS под
// версией = get_latest_update_id() (монотонный счётчик LDK ложится на анти-откат VSS), по ack —
// channel_monitor_updated. ChannelManager сериализуется с форс-флашем на ChannelReady (троттлинг,
// который только коалесит, РОНЯЕТ запись фандед-канала — выучено на стенде) и после событий.
import * as ldk from 'lightningdevkit';
import { Buffer } from 'buffer';
import { WsLDKNet } from './ws-net.mjs';
import { LdkChainAdapter } from './ldk-chain.mjs';

const NET = { btcregtest: 'LDKNetwork_Regtest', btcsignet: 'LDKNetwork_Signet', btcmain: 'LDKNetwork_Bitcoin' };
const MGR_KEY = 'manager';

export class LnNode {
  /** @param {{seedBytes:Uint8Array, net:'btcregtest'|'btcsignet'|'btcmain',
   *           vss:{put:Function,get:Function,list:Function},
   *           makeFeed:(adapter:LdkChainAdapter)=>{connect:()=>Promise<any>,tick:()=>Promise<void>},
   *           anchor:{hash:string,height:number}, broadcast:(hex:string)=>void, log?:Function}} o */
  constructor(o) {
    this.o = o; this.log = o.log ?? (() => {});
    this.on = {
      channelReady: () => {}, paymentClaimable: (_h, _sats) => {}, paymentClaimed: _h => {},
      paymentSent: _h => {}, paymentFailed: _h => {},
      // FundingGenerationReady: хозяин строит funding-tx из своего BTC-счёта на выданный скрипт
      fundingReady: (_tmpIdHex, _spkHex, _sats) => {},
    };
    this._mgrVersion = 0;
  }

  async start() {
    const o = this.o;
    const logger = ldk.Logger.new_impl({ log: r => { const s = r.get_args(); if (/error|warn/i.test(s) && !/gossip/i.test(s)) this.log('[ldk]', s.slice(0, 130)); } });
    const feeEst = ldk.FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 2500 });
    const broadcaster = ldk.BroadcasterInterface.new_impl({ broadcast_transactions: txs => { for (const t of txs) try { o.broadcast(Buffer.from(t).toString('hex')); } catch {} } });

    const chainMonitorRef = { cm: null };
    const persistMonitor = (monitor) => {
      const updId = monitor.get_latest_update_id();
      o.vss.put('mon_' + this._chanKey(monitor), Number(updId), monitor.write())
        .then(() => { try { chainMonitorRef.cm.channel_monitor_updated(monitor.channel_id(), updId); } catch (e) { this.log('cmu err', e.message); } })
        .catch(e => this.log('VSS monitor persist failed', e.message));
      return ldk.ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    };
    const persist = ldk.Persist.new_impl({
      persist_new_channel: (_n, m) => persistMonitor(m),
      update_persisted_channel: (_n, _u, m) => persistMonitor(m),
      archive_persisted_channel: () => {},
      get_and_clear_completed_updates: () => [],
    });

    const keys = ldk.KeysManager.constructor_new(o.seedBytes, BigInt(Math.floor(Date.now() / 1000)), (Date.now() % 1000) * 1e6, false);
    this.entropy = keys.as_EntropySource(); this.nodeSigner = keys.as_NodeSigner(); this.signerProvider = keys.as_SignerProvider();

    const chain = new LdkChainAdapter();
    const cm = ldk.ChainMonitor.constructor_new(ldk.Option_FilterZ.constructor_some(chain.filter), broadcaster, logger, feeEst, persist, this.entropy, ldk.PeerStorageKey.constructor_new(o.seedBytes));
    chainMonitorRef.cm = cm; this._chainMonitor = cm;

    const network = ldk.Network[NET[o.net]];
    const netGraph = ldk.NetworkGraph.constructor_new(network, logger);
    const scorer = ldk.ProbabilisticScorer.constructor_new(ldk.ProbabilisticScoringDecayParameters.constructor_default(), netGraph, logger);
    const lockable = ldk.MultiThreadedLockableScore.constructor_new(scorer.as_Score());
    const router = ldk.DefaultRouter.constructor_new(netGraph, logger, this.entropy, lockable.as_LockableScore(), ldk.ProbabilisticScoringFeeParameters.constructor_default());
    const msgRouter = ldk.DefaultMessageRouter.constructor_new(netGraph, this.entropy);
    const config = ldk.UserConfig.constructor_default();
    { const h = config.get_channel_handshake_config(); h.set_max_inbound_htlc_value_in_flight_percent_of_channel(100); config.set_channel_handshake_config(h); }

    const restored = await this._restore(cm, feeEst, broadcaster, router, msgRouter, logger, config).catch(e => { this.log('restore skipped:', e.message); return null; });
    if (restored) { this.chanMgr = restored; this.log('restored ChannelManager from VSS'); }
    else {
      const best = ldk.BestBlock.constructor_new(Buffer.from(o.anchor.hash, 'hex').reverse(), o.anchor.height);
      this.chanMgr = ldk.ChannelManager.constructor_new(feeEst, cm.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(),
        logger, this.entropy, this.nodeSigner, this.signerProvider, config, ldk.ChainParameters.constructor_new(network, best), Math.floor(Date.now() / 1000));
    }
    chain.attach(this.chanMgr, cm);
    this.chain = chain;
    this.nodeId = Buffer.from(this.chanMgr.get_our_node_id()).toString('hex');

    const ignoring = ldk.IgnoringMessageHandler.constructor_new();
    const rand = new Uint8Array(32); crypto.getRandomValues(rand);
    this.peerMgr = ldk.PeerManager.constructor_new(this.chanMgr.as_ChannelMessageHandler(), ignoring.as_RoutingMessageHandler(), ignoring.as_OnionMessageHandler(),
      ignoring.as_CustomMessageHandler(), ignoring.as_SendOnlyMessageHandler(), Math.floor(Date.now() / 1000), rand, logger, this.nodeSigner);
    this.lnNet = new WsLDKNet(this.peerMgr);
    this.feed = o.makeFeed(chain);
    await this.feed.connect();
    return this;
  }

  _chanKey(monitor) {
    const raw = monitor.channel_id().write?.() ?? new Uint8Array();
    return Buffer.from(raw).toString('hex').slice(0, 32) || 'ch';
  }
  async _restore(cm, feeEst, broadcaster, router, msgRouter, logger, config) {
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
      feeEst, cm.as_Watch(), broadcaster, router.as_Router(), msgRouter.as_MessageRouter(), logger, config, monitors);
    if (!r.is_ok()) { this.log('manager read NOT ok'); return null; }
    const mgrObj = r.res.get_b();
    this.log(`restore: ${monitors.length} monitors, manager channels ${mgrObj.list_channels().length}`);
    for (const m of monitors) cm.as_Watch().watch_channel(m.channel_id(), m);
    return mgrObj;
  }
  async _persistManager() {
    const now = Date.now();
    if (now - (this._lastMgrPersist ?? 0) < 2500) { this._mgrDirty = true; return; }
    await this.flushManager();
  }
  /** запись менеджера СЕЙЧАС, мимо троттла (критические точки: ChannelReady, выход) */
  async flushManager() {
    this._lastMgrPersist = Date.now(); this._mgrDirty = false;
    try { this._mgrVersion++; await this.o.vss.put(MGR_KEY, this._mgrVersion, this.chanMgr.write()); }
    catch (e) { this.log('VSS manager persist failed', e.message); this._mgrVersion--; }
  }

  _handleEvent(e) {
    if (e instanceof ldk.Event_ChannelReady) { this.log('ChannelReady'); this.on.channelReady(); }
    else if (e instanceof ldk.Event_PaymentClaimable) {
      // ОБЫЧНЫЙ инвойс LDK может заклеймить сам (preimage лежит в purpose) — клеймим сразу.
      // Hold-инвойс под внешний H остаётся ВИСЕТЬ (preimage там None) — его судьба решается
      // свопом: claimFunds(R) придёт от хозяина. Это и есть атомарная механика фазы 2.
      let auto = null;
      try {
        const p = e.purpose;
        if (p instanceof ldk.PaymentPurpose_Bolt11InvoicePayment && p.payment_preimage instanceof ldk.Option_ThirtyTwoBytesZ_Some)
          auto = p.payment_preimage.some;
      } catch {}
      if (auto) this.chanMgr.claim_funds(auto);
      this.on.paymentClaimable(Buffer.from(e.payment_hash).toString('hex'), Number(e.amount_msat) / 1000, !!auto);
    }
    else if (e instanceof ldk.Event_PaymentClaimed) this.on.paymentClaimed(Buffer.from(e.payment_hash).toString('hex'));
    else if (e instanceof ldk.Event_PaymentSent) this.on.paymentSent(Buffer.from(e.payment_hash).toString('hex'));
    else if (e instanceof ldk.Event_PaymentFailed) this.on.paymentFailed(Buffer.from(e.payment_hash ?? []).toString('hex'));
    else if (e instanceof ldk.Event_FundingGenerationReady) {
      this._pendingFunding = { tmpId: e.temporary_channel_id, nodeId: e.counterparty_node_id };
      this.on.fundingReady(Buffer.from(e.temporary_channel_id.write?.() ?? []).toString('hex'),
        Buffer.from(e.output_script).toString('hex'), Number(e.channel_value_satoshis));
    }
  }

  /** цикл: пиры + HTLC-форварды + таймеры + чейн-фид + события (+персист по грязи) */
  async tick() {
    this.peerMgr.process_events();
    this.chanMgr.process_pending_htlc_forwards?.();
    const now = Date.now();
    if (now - (this._lastTimer ?? 0) > 1000) { this._lastTimer = now; this.chanMgr.timer_tick_occurred(); this.peerMgr.timer_tick_occurred(); }
    await this.feed.tick();
    let had = false;
    const h = ldk.EventHandler.new_impl({ handle_event: e => { had = true; this._handleEvent(e); return ldk.Result_NoneReplayEventZ.constructor_ok(); } });
    this.chanMgr.as_EventsProvider().process_pending_events(h);
    this._chainMonitor.as_EventsProvider().process_pending_events(h);
    if (had) await this._persistManager();
    else if (this._mgrDirty && Date.now() - (this._lastMgrPersist ?? 0) >= 2500) await this.flushManager();
  }

  async connectPeer(wsUrl, nodeIdHex) { return this.lnNet.connect_peer(wsUrl, Buffer.from(nodeIdHex, 'hex')); }

  /** открыть СВОЙ канал к LSP (fundingReady-колбэк попросит funding-tx у BTC-счёта кошелька) */
  openChannel(peerNodeIdHex, sats) {
    // 5-й аргумент — ChannelId|null (НЕ Option-обёртка: нетипизированный биндинг молча съест
    // любой указатель и породит мусорный temporary_channel_id — выучено на стенде step9)
    const r = this.chanMgr.create_channel(Buffer.from(peerNodeIdHex, 'hex'), BigInt(sats), 0n, 0n, null, null);
    if (!r.is_ok()) throw new Error('create_channel failed');
  }
  /** хозяин собрал funding-tx (НЕ бродкастить самому — LDK бродкастит после подписи каналом) */
  fundingComplete(rawtxHex) {
    const p = this._pendingFunding; if (!p) throw new Error('нет ожидающего funding');
    const r = this.chanMgr.funding_transaction_generated(p.tmpId, p.nodeId, Buffer.from(rawtxHex, 'hex'));
    if (!r.is_ok()) throw new Error('funding_transaction_generated failed');
    this._pendingFunding = null;
  }

  /** обычный инвойс (получить сатоши; sats=null — БЕЗ суммы, плательщик вводит сам — аналог
   *  статического адреса) или hold-инвойс под ВНЕШНИЙ H (атомарный своп) */
  createInvoice(sats, memo = '', hashHex = null) {
    const descRes = ldk.Description.constructor_new(memo);
    const desc = ldk.Bolt11InvoiceDescription.constructor_direct(descRes.res ?? descRes);
    const res = this.chanMgr.create_bolt11_invoice(
      sats != null ? ldk.Option_u64Z.constructor_some(BigInt(sats) * 1000n) : ldk.Option_u64Z.constructor_none(), desc,
      ldk.Option_u32Z.constructor_some(3600), ldk.Option_u16Z.constructor_none(),
      hashHex ? ldk.Option_ThirtyTwoBytesZ.constructor_some(Buffer.from(hashHex, 'hex')) : ldk.Option_ThirtyTwoBytesZ.constructor_none());
    if (!res.is_ok()) throw new Error('invoice creation failed');
    return res.res.to_str();
  }
  claimFunds(preimageHex) { this.chanMgr.claim_funds(Buffer.from(preimageHex, 'hex')); }
  /** оплатить bolt11 (исходящий платёж; исход придёт событием paymentSent/paymentFailed) */
  payInvoice(bolt11) {
    const inv = ldk.Bolt11Invoice.constructor_from_str(bolt11);
    if (!inv.is_ok()) throw new Error('плохой инвойс');
    const pid = new Uint8Array(32); crypto.getRandomValues(pid);
    const r = this.chanMgr.pay_for_bolt11_invoice(inv.res, pid, ldk.Option_u64Z.constructor_none(),
      ldk.RouteParametersConfig.constructor_default(), ldk.Retry.constructor_attempts(3));
    if (!r.is_ok()) throw new Error('оплата не запустилась');
    return Buffer.from(inv.res.payment_hash()).toString('hex');
  }
  usableChannels() { return this.chanMgr.list_usable_channels(); }
  balance() {
    let out = 0, inb = 0, ready = 0;
    for (const c of this.chanMgr.list_channels()) {
      out += Number(c.get_outbound_capacity_msat()) / 1000;
      inb += Number(c.get_inbound_capacity_msat()) / 1000;
      if (c.get_is_channel_ready()) ready++;
    }
    return { outSats: Math.floor(out), inSats: Math.floor(inb), channels: this.chanMgr.list_channels().length, ready };
  }
}
