// @ts-nocheck — LDK-биндинги нетипизированы под tsc (.res живёт на подклассах Result, wasm-ассет ?url); корректность закрыта step9-стендом
// ln-worker.mjs — LN-узел фазы 2 в выделенном воркере. LDK-wasm (24МБ) грузится ЛЕНИВО —
// только когда пользователь включает ⚡-счёт; главный бандл его не тянет вовсе (dynamic import
// + wasm-ассет по URL). Протокол сообщений: {id, call, args} → {id, ok|err}; события узла
// уходят без id: {event, data}. Ключи LDK выводятся из сида кошелька (пришёл в init) — ни один
// секрет воркер наружу не отдаёт.
import wasmUrl from 'lightningdevkit/liblightningjs.wasm?url';

let node = null, vss = null, tickTimer = null, initP = null;
const post = m => self.postMessage(m);
const emit = (event, data) => post({ event, data });
// ГОНКА ЗАПУСКА: воркер уже есть, а LDK ещё грузит wasm — любой вызов до конца init видел
// node=null («null is not an object»). Все вызовы ждут initP; init идемпотентен.
const ready = async () => { if (!node && initP) await initP; if (!node) throw new Error('узел ещё запускается'); };

const CALLS = {
  async init(args) {
    if (node) return { nodeId: node.nodeId };
    if (initP) return initP;
    initP = this._init(args);
    try { return await initP; } catch (e) { initP = null; throw e; }   // провал → можно повторить
  },
  async _init({ seedBytes, net, apiBase, lspWsUrl, lspNodeId, anchor, fromHeight }) {
    const ldk = await import('lightningdevkit');
    await ldk.initializeWasmFromBinary(new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer()));
    const { LnNode } = await import('./ln-node.mjs');
    const { RelayChainFeed } = await import('./relay-feed.mjs');
    const { VssClient } = await import('../net/vss-client.mjs');
    const api = async (path, body) => {
      const r = await fetch(`${apiBase}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      const j = await r.json(); if (j.error) throw new Error(j.error); return j;
    };
    const seed = new Uint8Array(seedBytes);
    // nodeId детерминирован сидом — нужен для namespace VSS ДО старта узла
    const km = ldk.KeysManager.constructor_new(seed, 1n, 0, false);
    const nodeId = Array.from(km.as_NodeSigner().get_node_id(ldk.Recipient.LDKRecipient_Node).res, b => b.toString(16).padStart(2, '0')).join('');
    vss = new VssClient({ apiBase, nodeId, seedBytes: seed });
    this._lsp = { wsUrl: lspWsUrl, nodeId: lspNodeId };
    node = new LnNode({
      seedBytes: seed, net, vss,
      makeFeed: adapter => new RelayChainFeed({
        api, adapter, fromHeight,
        onHeight: h => emit('height', h),      // хозяин персистит прогресс (IndexedDB)
        log: (...a) => emit('log', a.join(' ')),
      }),
      anchor,
      broadcast: hex => { api('btcBroadcast', { rawtx: hex }).catch(e => emit('log', 'broadcast: ' + e.message)); },
      log: (...a) => emit('log', a.join(' ')),
    });
    node.on.channelReady = () => emit('channelReady', node.balance());
    node.on.paymentClaimable = (hash, sats, autoClaimed) => emit('paymentClaimable', { hash, sats, autoClaimed });
    node.on.paymentClaimed = hash => emit('paymentClaimed', { hash });
    node.on.paymentSent = hash => emit('paymentSent', { hash });
    node.on.paymentFailed = hash => emit('paymentFailed', { hash });
    node.on.fundingReady = (tmpId, spkHex, sats) => emit('fundingReady', { tmpId, spkHex, sats });
    await node.start();
    tickTimer = setInterval(() => node.tick().catch(e => emit('log', 'tick: ' + e.message)), 400);
    // соединение с LSP держим живым
    const keepPeer = async () => { try { await node.connectPeer(lspWsUrl, lspNodeId); } catch {} };
    await keepPeer(); setInterval(keepPeer, 60e3);
    return { nodeId: node.nodeId };
  },
  status() {
    if (!node) return { running: false };
    return { running: true, nodeId: node.nodeId, ...node.balance() };
  },
  async invoice({ sats, memo, hashHex }) { await ready(); return { bolt11: node.createInvoice(sats ?? null, memo || '', hashHex || null) }; },
  async pay({ bolt11 }) { await ready(); return { hash: node.payInvoice(bolt11) }; },
  async claim({ preimageHex }) { await ready(); node.claimFunds(preimageHex); return {}; },
  async openChannel({ peerNodeId, sats }) { await ready(); node.openChannel(peerNodeId ?? this._lsp.nodeId, sats); return {}; },
  async fundingComplete({ rawtxHex }) { await ready(); node.fundingComplete(rawtxHex); return {}; },
  async flush() { await ready(); await node.flushManager(); return {}; },
};

self.onmessage = async ev => {
  const { id, call, args } = ev.data;
  try { post({ id, ok: await CALLS[call].call(CALLS, args || {}) }); }
  catch (e) { post({ id, err: String(e?.message ?? e) }); }
};
