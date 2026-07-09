// store-idb.mjs — IndexedDB persistence for the light client. localStorage cannot hold a
// mainnet header chain (485k × 32-byte hashes ≫ its ~5MB cap), so headers are stored as
// individual records and only NEW ones are appended each sync — persistence stays
// incremental, matching the client's incremental header sync. The small wallet state
// (scannedHeight + UTXO set + history) is one record. Keyed by (net, genesis); a different
// wallet (script-set fingerprint change) discards the stored state.
const DB_VERSION = 1;
const idb = () => { try { return globalThis.indexedDB; } catch { return null; } };
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const reqDone = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class IdbStore {
  constructor(net, genesis) { this.name = `fw-light-${net}-${genesis.slice(0, 12)}`; this.db = null; this.persistedTip = -1; }
  get available() { return !!idb(); }

  async open() {
    if (!this.available) return false;
    this.db = await new Promise((res, rej) => {
      const r = idb().open(this.name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('headers')) db.createObjectStore('headers', { keyPath: 'h' });
        if (!db.objectStoreNames.contains('wallet')) db.createObjectStore('wallet', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return true;
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
    rows.sort((a, b) => a.h - b.h);
    const chain = rows.map(r => ({ hash: r.hash, prevHash: r.prevHash, time: r.time }));
    const ok = client.importState({ net: client.net, genesis: client.genesis, scannedHeight: w.scannedHeight, chain, utxos: w.utxos, history: w.history });
    this.persistedTip = ok ? chain.length - 1 : -1;
    if (!ok) await this.clear();
    return ok;
  }

  /** Persist the delta since the last save: any reorg rollback, newly-synced headers, and
   *  the current wallet record. Cheap when nothing new synced. */
  async save(client, scriptsKey) {
    if (!this.db) return;
    const o = client.stateClient;
    const tip = o.chain.length - 1;
    // Reorg: drop persisted headers above the fork so the store mirrors the client's chain.
    if (o.reorgFloor != null && o.reorgFloor < this.persistedTip) {
      const t = this.db.transaction('headers', 'readwrite');
      t.objectStore('headers').delete(IDBKeyRange.lowerBound(o.reorgFloor, true));
      await txDone(t); this.persistedTip = o.reorgFloor;
    }
    o.reorgFloor = null;
    if (tip > this.persistedTip) {
      const t = this.db.transaction('headers', 'readwrite'); const os = t.objectStore('headers');
      for (let h = this.persistedTip + 1; h <= tip; h++) { const c = o.chain[h]; os.put({ h, hash: c.hash, prevHash: c.prevHash ?? null, time: c.time || 0 }); }
      await txDone(t); this.persistedTip = tip;
    }
    const t = this.db.transaction('wallet', 'readwrite');
    t.objectStore('wallet').put({
      k: 'state', scriptsKey, scannedHeight: o.scannedHeight,
      utxos: [...o.utxos.values()].map(u => ({ ...u, value: u.value.toString() })),
      history: o.history.map(e => ({ ...e, amount: e.amount.toString() })),
    });
    await txDone(t);
  }

  close() { try { this.db?.close(); } catch {} }
}
