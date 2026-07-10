// light.mjs — a data source backed by the Neutrino light client (variant B),
// exposing the same shape as the variant-C backend (api.mjs) so the UI can use
// either. No trusted backend: balance/UTXOs/history are computed client-side from
// verified headers, BIP157/158 filters and the blocks they flag.
import { Neutrino, NeutrinoPool } from './net/client.mjs';
import { IdbStore } from './store-idb.mjs';
import { timeAdjustValue } from '../../../core/demurrage.mjs';
import { parseTx, txid as txidOf } from '../../../core/tx.mjs';

const kriaToFrc = k => Number(k) / 1e8;

// Cheap fingerprint of the wallet's script set — stored state is only reused for the
// same wallet (a different secret ⇒ different scripts ⇒ discard the persisted UTXO set).
export const scriptsKey = scripts => { let h = 5381 >>> 0; const s = scripts.join(''); for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return scripts.length + ':' + h.toString(16); };

export function createLightSource({ url, net, genesis, scripts, birthHeight = 0, onProgress = null, onProvisional = null, snapshotUrl = null, filterSnapshotUrl = null }) {
  let n = null, cache = null;
  const store = new IdbStore(net, genesis);   // IndexedDB — holds a full mainnet header chain
  // NOTE: birthHeight is NOT part of the fingerprint — it is auto-learned from the scan
  // itself, so it can never shrink an already-scanned window; it only applies on a fresh
  // start (no persisted state), where it windows the initial filter scan.
  const skey = scriptsKey(scripts);

  // One or more bridge URLs (comma/space separated). Multiple ⇒ multi-peer filter
  // agreement (no single peer can hide funds); one ⇒ the plain single-peer client.
  const urls = String(url).split(/[\s,]+/).filter(Boolean);

  // Checkpoint the chain every N header batches (~2000 headers each) so an interrupted
  // first sync (page closed mid-way) resumes from the checkpoint instead of genesis.
  let batches = 0, saving = false;
  const progress = p => {
    onProgress?.(p);
    if (p.phase === 'headers' && ++batches % 10 === 0 && !saving) {
      saving = true;
      store.save(n, skey).catch(() => {}).finally(() => { saving = false; });
    }
  };

  // Create the client + restore persisted state. NO network — connect happens in sync().
  async function initClient() {
    if (n) return;
    n = urls.length > 1 ? new NeutrinoPool({ urls, net, genesis }) : new Neutrino({ url: urls[0], net, genesis, snapshotUrl, filterSnapshotUrl });
    let resumed = false;
    try { if (await store.open()) resumed = await store.loadInto(n, skey); } catch {}   // resume persisted chain if same wallet
    // Fresh start: skip filters/scan below the wallet's birth height (headers still sync
    // fully — PoW trustlessness is not windowed). Crucial on mainnet: without a birth
    // height a new wallet would scan ~485k filters that cannot contain its coins.
    if (!resumed && birthHeight > 0) n.stateClient.scannedHeight = birthHeight - 1;
  }

  const toCache = (r, stale = false) => {
    const tip = r.tipHeight;
    return {
      stale, tipHeight: tip,
      balance: kriaToFrc(r.balance),
      utxos: r.utxos.map(u => ({
        txid: u.txid, vout: u.vout, refheight: u.refheight,
        nominal: kriaToFrc(u.value),
        amount: kriaToFrc(timeAdjustValue(u.value, tip + 1 - u.refheight)),
        coinbase: u.coinbase, scriptPubKey: u.script,
      })),
      history: r.history.map(h => ({
        txid: h.txid, category: h.category,
        amount: kriaToFrc(h.amount < 0n ? -h.amount : h.amount) * (h.amount < 0n ? -1 : 1),
        confirmations: tip - h.height + 1, time: h.time,
      })),
      pending: (r.pending || []).map(p => ({
        txid: p.txid, category: p.category,
        amount: kriaToFrc(p.amount < 0n ? -p.amount : p.amount) * (p.amount < 0n ? -1 : 1),
        confirmations: 0, time: p.time,
      })),
      agreement: r.agreement || null,
    };
  };

  // Serialized: concurrent callers (Balance poll, Activity, Send) share ONE in-flight
  // syncWallet — two interleaved syncs on the same client steal each other's single-shot
  // message handlers and both hang.
  let inflight = null;
  function sync() {
    if (!inflight) inflight = doSync().finally(() => { inflight = null; });
    return inflight;
  }
  async function doSync() {
    await initClient();
    if (!connected) { await n.connect(); n.stateClient.onProgress = progress; connected = true; }
    const r = await n.syncWallet(scripts, {
      // Scan done but PoW proofs still verifying: surface the balance immediately, clearly
      // marked provisional. cache is NOT set — Send must never build on unverified data.
      onProvisional: prov => { try { onProvisional?.(toCache(prov, 'provisional')); } catch {} },
      // Progressive balance during the sweep: what the scan has found so far, marked partial.
      onPartial: part => { try { onProvisional?.(toCache(part, 'partial')); } catch {} },
    });
    try { await store.save(n, skey); } catch {}
    cache = toCache(r);
    // Learned birth height: after a completed (verified) scan the wallet's first activity
    // is known — a manual birth stays authoritative; a full scan learns min(history height)
    // (or the tip for an empty wallet: nothing below the scanned tip can appear later).
    cache.birthAuto = birthHeight > 0 ? birthHeight
      : (r.history.length ? Math.min(...r.history.map(h => h.height)) : r.tipHeight);
    return cache;
  }
  let connected = false;
  const ensure = async () => cache || sync();

  /** Last-known state, instantly and without any network: the persisted chain/UTXO set
   *  restored from IndexedDB (or whatever is already in memory). Null when there is
   *  nothing to show yet. Marked stale — callers must not build transactions from it. */
  async function preview() {
    if (cache) return cache;                       // a fresh sync already happened
    await initClient();
    const s = n.stateClient;
    // Only show a last-known balance if a full filter scan has ever completed — a chain
    // checkpointed mid-first-sync has headers but NO scan, and "0 FRC" would be a lie.
    if (!s.scannedOnce) return null;
    return toCache(n.snapshot(), true);
  }

  return {
    async health() { return { ok: true, network: net + ' (light)' }; },
    async balance() { const c = await ensure(); return { balance: c.balance, tipHeight: c.tipHeight, unit: 'present-value', pending: c.pending, agreement: c.agreement, birthAuto: c.birthAuto }; },
    async utxos() { const c = await sync(); return { balance: c.balance, tipHeight: c.tipHeight, utxos: c.utxos, pending: c.pending, agreement: c.agreement, birthAuto: c.birthAuto }; },
    async history() { const c = await ensure(); return { txs: [...c.pending, ...c.history] }; },
    preview,
    async broadcast(rawtx) { if (!n) await sync(); n.broadcast(rawtx); return { txid: txidOf(parseTx(rawtx)) }; },
    refresh: sync,
    close() { if (n) { n.close(); n = null; cache = null; } store.close(); },
  };
}
