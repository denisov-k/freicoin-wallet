// store-idb.mjs — IndexedDB persistence for the light client. localStorage cannot hold a
// mainnet header chain (485k × 32-byte hashes ≫ its ~5MB cap). Headers are stored in
// CHUNKS of CHUNK headers per record (485k individual records made saves take minutes;
// ~240 chunk records save in well under a second) and only chunks touched since the last
// save are rewritten — persistence stays incremental, matching the incremental header
// sync. The small wallet state (scannedHeight + UTXO set + history) is one record.
// Keyed by (net, genesis); a different wallet (script-set fingerprint) discards the store.
const DB_VERSION = 2;          // v2: chunked headers (v1 stored one record per header)
const CHUNK = 2048;            // headers per record
const idb = () => { try { return globalThis.indexedDB; } catch { return null; } };
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const reqDone = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class IdbStore {
  constructor(net, genesis) { this.name = `fw-light-${net}-${genesis.slice(0, 12)}`; this.db = null; this.persistedTip = -1; }
  get available() { return !!idb(); }

  async open() {
    if (!this.available) return false;
    // An upgrade `open` BLOCKS FOREVER if another tab (or a zombie connection — mobile
    // browsers restore tabs) still holds the database at an older version, and would
    // freeze the whole sync at "connecting". Time-box the open and treat blocked/slow
    // as "no persistence this session" — the wallet still syncs, it just won't resume.
    try {
      this.db = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('idb open timeout/blocked')), 4000);
        const r = idb().open(this.name, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (db.objectStoreNames.contains('headers')) db.deleteObjectStore('headers');   // v1 schema → rebuild
          db.createObjectStore('headers', { keyPath: 'c' });
          if (!db.objectStoreNames.contains('wallet')) db.createObjectStore('wallet', { keyPath: 'k' });
        };
        r.onblocked = () => { clearTimeout(timer); rej(new Error('idb blocked by another connection')); };
        r.onsuccess = () => {
          clearTimeout(timer);
          // if a future version wants to upgrade, don't be the tab that bricks it
          r.result.onversionchange = () => { try { r.result.close(); } catch {} this.db = null; };
          res(r.result);
        };
        r.onerror = () => { clearTimeout(timer); rej(r.error); };
      });
      return true;
    } catch { this.db = null; return false; }
  }
  _os(store, mode) { return this.db.transaction(store, mode).objectStore(store); }

  async clear() {
    if (!this.db) return;
    const t = this.db.transaction(['headers', 'wallet'], 'readwrite');
    t.objectStore('headers').clear(); t.objectStore('wallet').clear();
    await txDone(t); this.persistedTip = -1;
  }

  /** Load persisted state into `client` (via client.importState). Returns true if a chain
   *  for this exact wallet (scriptsKey) was restored; false (and a wiped store) otherwise. */
  async loadInto(client, scriptsKey) {
    if (!this.db) return false;
    const w = await reqDone(this._os('wallet', 'readonly').get('state'));
    if (!w || w.scriptsKey !== scriptsKey) { await this.clear(); return false; }
    const rows = await new Promise((res, rej) => {
      const out = []; const c = this._os('headers', 'readonly').openCursor();
      c.onsuccess = e => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
      c.onerror = () => rej(c.error);
    });
    rows.sort((a, b) => a.c - b.c);
    const base = w.base || 0;                 // checkpoint anchor of the persisted chain
    const chain = [];
    for (const r of rows) {
      if (r.c * CHUNK !== chain.length) { await this.clear(); return false; }   // gap → store corrupt, start fresh
      for (const e of r.hs) chain.push({ hash: e[0], time: e[e.length - 1] || 0 });   // [hash,time] (v2 rows [hash,prevHash,time] read compatibly)
    }
    const ok = chain.length > 0 && client.importState({ net: client.net, genesis: client.genesis, base, scannedHeight: w.scannedHeight, scannedOnce: w.scannedOnce, chain, utxos: w.utxos, history: w.history });
    this.persistedTip = ok ? chain.length - 1 : -1;
    if (!ok) await this.clear();
    return ok;
  }

  /** Persist the delta since the last save: any reorg rollback, newly-synced headers
   *  (only the chunk records they touch are rewritten), and the wallet record. */
  async save(client, scriptsKey) {
    if (!this.db) return;
    const o = client.stateClient;
    // Persist only the VERIFIED prefix — headers whose PoW is still in the deferred
    // verification queue must never be trusted across a reload.
    const tip = Math.min(o.chain.length - 1, o.verifiedHeight ?? (o.chain.length - 1));
    // Reorg: forget persisted headers above the fork; the append below rewrites the
    // partial chunk from the (already truncated + re-extended) in-memory chain.
    if (o.reorgFloor != null && o.reorgFloor < this.persistedTip) this.persistedTip = o.reorgFloor;
    o.reorgFloor = null;
    const base = o.chain.base || 0;           // chunk indices are RELATIVE to the anchor
    if (this.persistedTip < base) this.persistedTip = base - 1;
    if (tip !== this.persistedTip) {
      const firstChunk = Math.floor((this.persistedTip + 1 - base) / CHUNK);
      const lastChunk = Math.floor((tip - base) / CHUNK);
      const t = this.db.transaction('headers', 'readwrite'); const os = t.objectStore('headers');
      for (let c = firstChunk; c <= lastChunk; c++) {
        // rows are [hash, time] — prevHash is redundant (prevHash at h === hash at h-1)
        const hs = [];
        for (let h = base + c * CHUNK; h <= Math.min(base + (c + 1) * CHUNK - 1, tip); h++) hs.push([o.chain.hashAt(h), o.chain.timeAt(h)]);
        os.put({ c, hs });
      }
      os.delete(IDBKeyRange.lowerBound(lastChunk, true));   // drop stale chunks past the tip (reorg shrink)
      await txDone(t); this.persistedTip = tip;
    }
    // The wallet record must stay consistent with the persisted (verified-only) chain:
    // the scan follower may have swept past verifiedHeight — clamp scannedHeight and drop
    // anything above the persisted tip (a resumed sync re-scans and re-finds it).
    const t = this.db.transaction('wallet', 'readwrite');
    t.objectStore('wallet').put({
      k: 'state', scriptsKey, base, scannedHeight: Math.min(o.scannedHeight, tip), scannedOnce: o.scannedOnce,
      utxos: [...o.utxos.values()].filter(u => u.refheight <= tip).map(u => ({ ...u, value: u.value.toString() })),
      history: o.history.filter(e => e.height <= tip).map(e => ({ ...e, amount: e.amount.toString() })),
    });
    await txDone(t);
  }

  close() { try { this.db?.close(); } catch {} }
}
