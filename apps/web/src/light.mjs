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

export function createLightSource({ url, net, genesis, scripts, birthHeight = 0, onProgress = null, onProvisional = null, snapshotUrl = null, filterSnapshotUrl = null, checkpoint = null, seedDefs = null }) {
  let n = null, cache = null;
  const store = new IdbStore(net, genesis);   // IndexedDB — holds a full mainnet header chain
  // NOTE: birthHeight is NOT part of the fingerprint — it is auto-learned from the scan
  // itself, so it can never shrink an already-scanned window; it only applies on a fresh
  // start (no persisted state), where it windows the initial filter scan.
  const skey = scriptsKey(scripts);

  // One or more bridge URLs (comma/space separated). Multiple ⇒ multi-peer filter
  // agreement (no single peer can hide funds); one ⇒ the plain single-peer client.
  const urls = String(url).split(/[\s,]+/).filter(Boolean);

  // Checkpoint the chain as the sync progresses — every N header batches during the
  // download AND on every verification batch during the verify tail (the store persists
  // only up to verifiedHeight, so each save writes just the newly-verified chunks). An
  // interrupted first sync resumes from the checkpoint instead of redoing the work.
  let batches = 0, saving = false;
  const progress = p => {
    onProgress?.(p);
    const shouldSave = (p.phase === 'headers' && ++batches % 10 === 0) || p.phase === 'verify';
    if (shouldSave && !saving) {
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
    // Seed asset defs the wallet can never scan itself (an issuance block matches only the
    // ISSUER's filters): untrusted relay hints for rate/valuation of history legs — a lying
    // rate only mislabels amounts. Scan-verified defs overwrite seeds as blocks arrive.
    try { for (const [t, p] of Object.entries(seedDefs || {})) if (!n.stateClient.assetDefs.has(t)) n.stateClient.assetDefs.set(t, p); } catch {}
    // Fresh start: skip filters/scan below the wallet's birth height (headers still sync
    // fully — PoW trustlessness is not windowed). Crucial on mainnet: without a birth
    // height a new wallet would scan ~485k filters that cannot contain its coins.
    if (!resumed) {
      // Fast sync: anchor at the build-time checkpoint when nothing below it is needed
      // (the wallet's birth is at/above it). Imports that must scan older history take
      // the full-from-genesis path automatically.
      if (checkpoint && urls.length === 1 && (birthHeight || 0) >= checkpoint.height) {
        n.stateClient.initCheckpoint(checkpoint);
        if (birthHeight > 0) n.stateClient.scannedHeight = Math.max(checkpoint.height, birthHeight - 1);
      } else if (birthHeight > 0) n.stateClient.scannedHeight = birthHeight - 1;
    }
  }

  // One entry per (txid, currency): normalize the all-zero host tag to null and sum the legs
  // (legacy caches hold a separate spend leg and change leg for the same tx). Sign decides the
  // category; 'generate' sticks.
  const mergeLegs = entries => {
    const m = new Map();
    for (const h of entries) {
      const tag = (!h.assetTag || h.assetTag === '0'.repeat(40)) ? null : h.assetTag;
      const k = h.txid + '|' + (tag ?? '');
      const e = m.get(k);
      if (e) { e.amount += h.amount; if (h.category === 'generate') e.category = 'generate'; }
      else m.set(k, { ...h, assetTag: tag });
    }
    for (const e of m.values()) if (e.category !== 'generate' && e.category !== 'immature') e.category = e.amount < 0n ? 'send' : 'receive';
    return [...m.values()];
  };

  const toCache = (r, stale = false) => {
    const tip = r.tipHeight;
    return {
      stale, tipHeight: tip,
      balance: kriaToFrc(r.balance),
      // FRC-money view: the plain wallet only counts/spends host-currency coins. On mainnet
      // every coin is host (no assetTag); on the nV3 chain this hides user-issued asset coins
      // (those live in the market UI). The market reads utxos via Neutrino directly, unaffected.
      utxos: r.utxos.filter(u => !u.assetTag || u.assetTag === '0'.repeat(40)).map(u => ({
        txid: u.txid, vout: u.vout, refheight: u.refheight,
        nominal: kriaToFrc(u.value),
        amount: kriaToFrc(timeAdjustValue(u.value, tip + 1 - u.refheight)),
        coinbase: u.coinbase, scriptPubKey: u.script,
      })),
      // nV3 asset-aware view (all coins incl. user assets, + self-certified defs) — kept for the
      // merged wallet's Issue/Exchange tabs, which the plain host-only `utxos` above hides.
      assetDefs: r.assetDefs || {},
      assetUtxos: r.utxos.map(u => ({ outpoint: `${u.txid}:${u.vout}`, spk: u.script, assetTag: (!u.assetTag || u.assetTag === '0'.repeat(40)) ? null : u.assetTag, value: String(u.value), refheight: u.refheight })),
      // history entries are per-currency legs; user assets are integer tokens (scale 1).
      // Normalize the all-zero host tag AND merge legs of the same (txid, currency) — entries
      // persisted before normalization split one tx into a spend leg and a change leg.
      history: mergeLegs(r.history).map(h => ({
        txid: h.txid, category: h.category, assetTag: h.assetTag,
        amount: h.assetTag ? Number(h.amount) : kriaToFrc(h.amount < 0n ? -h.amount : h.amount) * (h.amount < 0n ? -1 : 1),
        confirmations: tip - h.height + 1, time: h.time,
      })),
      pending: mergeLegs(r.pending || []).map(p => ({
        txid: p.txid, category: p.category, assetTag: p.assetTag,
        amount: p.assetTag ? Number(p.amount) : kriaToFrc(p.amount < 0n ? -p.amount : p.amount) * (p.amount < 0n ? -1 : 1),
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
    // Birth anchor: a (height, hash) pair ~100 blocks below the birth (reorg margin),
    // taken from the just-VERIFIED chain — future fresh starts anchor the chain here.
    try {
      const c = n.stateClient.chain;
      const ah = Math.max(c.base || 0, cache.birthAuto - 100);
      cache.birthAnchor = { height: ah, hash: c.hashAt(ah) };
    } catch { cache.birthAnchor = null; }
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
    async utxos() { const c = await sync(); return { balance: c.balance, tipHeight: c.tipHeight, utxos: c.utxos, pending: c.pending, agreement: c.agreement, birthAuto: c.birthAuto, birthAnchor: c.birthAnchor }; },
    async history() { const c = await ensure(); return { txs: [...c.pending, ...c.history] }; },
    // nV3 asset-aware snapshot for the Issue/Exchange tabs (per-asset utxos + self-certified defs)
    async assets() { const c = await ensure(); return { tipHeight: c.tipHeight, assetUtxos: c.assetUtxos || [], assetDefs: c.assetDefs || {} }; },
    preview,
    async broadcast(rawtx) { if (!n) await sync(); n.broadcast(rawtx); return { txid: txidOf(parseTx(rawtx)) }; },
    refresh: sync,
    // Wipe persisted chain/UTXO state and re-sync from genesis. For a throwaway experimental
    // chain that was rewound, the stored header chain no longer connects to the node ('headers
    // do not connect'); a full reset recovers (base=0 ⇒ from-genesis is always possible).
    async reset() {
      try { await initClient(); n.stateClient._resetState(); } catch {}
      try { if (await store.open()) await store.clear(); } catch {}
      cache = null; connected = false; return { ok: true };
    },
    close() { if (n) { n.close(); n = null; cache = null; } store.close(); },
  };
}
