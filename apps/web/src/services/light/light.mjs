// light.mjs — a data source backed by the Neutrino light client (variant B),
// exposing the same shape as the variant-C backend (api.mjs) so the UI can use
// either. No trusted backend: balance/UTXOs/history are computed client-side from
// verified headers, BIP157/158 filters and the blocks they flag.
import { Neutrino, NeutrinoPool } from './net/client.mjs';
import { IdbStore } from './store-idb.mjs';
import { timeAdjustValue } from '@core/demurrage.mjs';
import { parseTx, txid as txidOf } from '@core/tx.mjs';
import { Buffer } from 'buffer';

const kriaToFrc = k => Number(k) / 1e8;

// Cheap fingerprint of the wallet's script set — stored state is only reused for the
// same wallet (a different secret ⇒ different scripts ⇒ discard the persisted UTXO set).
export const scriptsKey = scripts => { let h = 5381 >>> 0; const s = scripts.join(''); for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return scripts.length + ':' + h.toString(16); };

export function createLightSource({ url, net, genesis, scripts, birthHeight = 0, onProgress = null, onProvisional = null, snapshotUrl = null, filterSnapshotUrl = null, checkpoint = null, checkpointDeep = null, seedDefs = null }) {
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
    // NB: strip `decimals` from the seed — display decimals are SELF-CERTIFIED on-chain (the "name|D"
    // suffix hashed into the tag), so a stale/wrong seeded decimals must never set the display scale
    // (it once made a whole "1 Test1" render as "0.0001"). Decimals come only from the trustless scan
    // or, for non-scannable assets, the relay's freshly-read info.assets — never a cached seed.
    try { for (const [t, p] of Object.entries(seedDefs || {})) if (!n.stateClient.assetDefs.has(t)) { const { decimals, ...rest } = p; n.stateClient.assetDefs.set(t, rest); } } catch {}
    // Also DROP any decimals persisted in the resumed store: an old build seeded untrusted relay
    // decimals INTO the store, and a stale/wrong one there sets the display scale (it made a whole
    // "1 Test1" render as "0.0001"). Display decimals are self-certified on-chain, so they must come
    // only from a live scan of the def block or fresh relay info — never a persisted hint.
    try { for (const [t, p] of n.stateClient.assetDefs) if (p && 'decimals' in p) { const { decimals, ...rest } = p; n.stateClient.assetDefs.set(t, rest); } } catch {}
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

  /** @type {(r: any, stale?: any) => any} */
  const toCache = (r, stale = false) => {
    const tip = r.tipHeight;
    // present-valued FRC that is actually SPENDABLE right now: total balance minus coins a spend
    // would be rejected for — immature coinbase (mined reward < 100 confs). On a wallet with no
    // fresh mining this equals `balance`; on one holding just-mined rewards it is lower (often 0),
    // which is what Send/Max must reflect so the user isn't offered coins consensus won't let them
    // move. COINBASE_MATURITY = 100.
    const spendableKria = r.utxos.reduce((a, u) =>
      ((!u.assetTag || u.assetTag === '0'.repeat(40)) && !(u.coinbase && (tip - u.refheight) < 100))
        ? a + timeAdjustValue(u.value, tip + 1 - u.refheight) : a, 0n);
    return {
      stale, tipHeight: tip,
      balance: kriaToFrc(r.balance),
      spendable: kriaToFrc(spendableKria),
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
      assetUtxos: r.utxos.map(u => ({ outpoint: `${u.txid}:${u.vout}`, spk: u.script, assetTag: (!u.assetTag || u.assetTag === '0'.repeat(40)) ? null : u.assetTag, value: String(u.value), refheight: u.refheight, coinbase: !!u.coinbase, ...(u.tokenHash ? { tokens: u.tokens ?? [], tokenHash: u.tokenHash } : {}) })),
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
  // Tail preview (full import only): the last ~5000 blocks scanned into a temporary view the
  // moment headers land, so a restored wallet's RECENT coins paint in seconds while the
  // authoritative from-genesis sweep still crawls. Sweep partials MERGE with it (dedup by
  // outpoint; heights are mostly disjoint — the sweep is below the window, the tail above), and
  // the final verified result replaces everything.
  let tailPrev = null;
  // Adopt a tail view unless we already hold a better one (deeper window / newer tip); never
  // after the verified full result landed (a late preview must not overwrite the truth).
  const setTail = p => {
    if (cache || !p) return;
    if (tailPrev && tailPrev.tailFrom <= p.tailFrom && tailPrev.tipHeight >= p.tipHeight) return;
    tailPrev = p;
    try { onProvisional?.(toCache(mergeTail({ ...p, utxos: [], history: [], balance: 0n }), 'partial')); } catch {}
  };
  // CHECKPOINT PREVIEW: a restore ("12 words only") must scan from genesis for the FULL truth —
  // but the first screen doesn't have to wait for it. A tiny parallel client anchors at the
  // build-time checkpoint (trusted exactly as much as this code itself — reproducible builds),
  // syncs checkpoint→tip in ~a second (a few hundred headers, PoW-verified) and scans just that
  // window: the wallet behaves like a NEW wallet instantly, while the from-genesis sync earns
  // the history in the background and supersedes this view.
  async function checkpointPreview() {
    const anchor = checkpointDeep || checkpoint;
    if (!anchor || !onProvisional || urls.length > 1) { onProgress?.({ phase: 'preview', msg: 'skip:' + (!anchor ? 'no-cp' : 'pool') }); return; }
    let p = null;
    try {
      onProgress?.({ phase: 'preview', msg: 'start @' + anchor.height });
      p = new Neutrino({ url: urls[0], net, genesis });
      p.stateClient.initCheckpoint(anchor);
      p.stateClient.scannedHeight = anchor.height;   // scan only the window above the anchor
      await p.connect();
      // The preview runs FIRST (doSync holds the main sweep until it lands or 25s pass), with the
      // CPU to itself — INLINE matching/verification, no worker pool at all. The main client later
      // creates the one and only pool of the session (a second pool hangs on iOS's Worker cap;
      // sharing/inheriting one across clients deadlocked the verify tail — keep it simple).
      p._pool = null;
      await p.syncWallet(scripts, {});
      // syncWallet sent the BIP35 mempool request at its tail; the inv→getdata→tx round-trip lands
      // async — wait for it, then reclassify + snapshot so the FIRST painted list carries pending.
      await new Promise(res => setTimeout(res, 1800));
      p.stateClient.reconsiderMempool();
      const snap = p.stateClient.snapshot();
      // SEED the main client with the preview's coins (guarded: _result/snapshot ignore coins
      // above their own height) — its buffered mempool txs then classify against real inputs and
      // a spend paints as «send −X» from the very first list.
      try { for (const u of snap.utxos) n?.stateClient.utxos.set(u.txid + ':' + u.vout, u); n?.stateClient.reconsiderMempool?.(); } catch {}
      setTail({ ...snap, tailFrom: anchor.height + 1 });
      onProgress?.({ phase: 'preview', msg: 'ok ' + (Number(snap.balance) / 1e8).toFixed(2) + ' FRC' });
    } catch (e) { onProgress?.({ phase: 'preview', msg: 'err: ' + String(e && e.message).slice(0, 60) }); }
    finally { try { p?.close?.(); } catch {} }
  }
  const isHostU = u => !u.assetTag || u.assetTag === '0'.repeat(40);
  const mergeTail = part => {
    if (!tailPrev) return part;
    const tip = Math.max(part.tipHeight, tailPrev.tipHeight);
    const seen = new Set(part.utxos.map(u => u.txid + ':' + u.vout));
    const utxos = [...part.utxos, ...tailPrev.utxos.filter(u => !seen.has(u.txid + ':' + u.vout))];
    const hseen = new Set(part.history.map(h => h.txid + ':' + (h.assetTag ?? '')));
    const history = [...part.history, ...tailPrev.history.filter(h => !hseen.has(h.txid + ':' + (h.assetTag ?? '')))];
    // PENDING: the preview's classification WINS. Its tail-window coin set is complete, so it reads
    // a spend as «send −X»; the main sweep, still crawling from the anchor, sees only the change
    // output and would mislabel the same txid as a tiny «receive» (the row that flashed then moved).
    const key = p => p.txid + ':' + (p.assetTag ?? '');
    const pseen = new Set((tailPrev.pending || []).map(key));
    const pending = [...(tailPrev.pending || []), ...(part.pending || []).filter(p => !pseen.has(key(p)))];
    let balance = 0n; for (const u of utxos) if (isHostU(u)) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { ...part, tipHeight: tip, balance, utxos, history, pending };
  };
  async function doSync() {
    await initClient();
    if (!connected) { await n.connect(); n.stateClient.onProgress = progress; connected = true; }
    // subscribe the MAIN client to the mempool IMMEDIATELY (watch + BIP35) — its raw txs buffer
    // during the preview; the seeding below then classifies them correctly for the FIRST paint
    try { if (!n.stateClient._watch) { n.stateClient._watch = new Set(scripts); n.stateClient._send('mempool', Buffer.alloc(0)); } } catch {}
    // Full-history import (restore): nothing scanned, nothing cached — float the checkpoint
    // preview alongside the genesis sync. (A resumed or anchored client has scannedHeight>0
    // and skips this naturally.)
    // preview whenever the scan sits BELOW the deep anchor (fresh import OR a resumed session
    // that was interrupted mid-history) — a reload at scan 368k otherwise shows only the mempool
    // rows until the sweep reaches the recent blocks
    const anchorH = (checkpointDeep || checkpoint)?.height ?? 0;
    if (!cache && anchorH && n.stateClient.scannedHeight < anchorH)
      await Promise.race([checkpointPreview(), new Promise(r => setTimeout(r, 25000))]);   // preview gets the CPU first
    const r = await n.syncWallet(scripts, {
      // Scan done but PoW proofs still verifying: surface the balance immediately, clearly
      // marked provisional. cache is NOT set — Send must never build on unverified data.
      onProvisional: prov => { try { onProvisional?.(toCache(prov, 'provisional')); } catch {} },
      // Progressive balance during the sweep: what the scan has found so far, marked partial.
      onPartial: part => { try { onProvisional?.(toCache(mergeTail(part), 'partial')); } catch {} },
      // (the in-sync P2P tail preview is superseded by the checkpoint preview above — not passing
      // onTail disables it; it had no timeout and could hang the sync tail on a lost block reply)
    });
    tailPrev = null;   // the verified full result supersedes the preview
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
    async balance() { const c = await ensure(); return { balance: c.balance, spendable: c.spendable, tipHeight: c.tipHeight, unit: 'present-value', pending: c.pending, agreement: c.agreement, birthAuto: c.birthAuto }; },
    async utxos() { const c = await sync(); return { balance: c.balance, spendable: c.spendable, tipHeight: c.tipHeight, utxos: c.utxos, pending: c.pending, agreement: c.agreement, birthAuto: c.birthAuto, birthAnchor: c.birthAnchor }; },
    async history() { const c = await ensure(); return { txs: [...c.pending, ...c.history] }; },
    // nV3 asset-aware snapshot for the Issue/Exchange tabs (per-asset utxos + self-certified defs)
    async assets() { const c = await sync(); return { tipHeight: c.tipHeight, assetUtxos: c.assetUtxos || [], assetDefs: c.assetDefs || {} }; },   // sync() not ensure(): the asset/token coins that back sends must be as fresh as FRC's utxos(), never a stale cache (a reorg/reindex silently invalidates cached outpoints)
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
