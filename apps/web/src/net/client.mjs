// client.mjs — Neutrino light client: ties B0-B3 (P2P handshake, headers, BIP157/158
// filters, block scan) over a WebSocket transport (through the p2p-bridge) into the
// same data a wallet needs — balance, UTXOs, history — with no trusted backend.
import { Buffer } from 'buffer';
import { encodeMessage, createDecoder, buildVersion, parseVersion, buildGetHeaders, parseHeaders, checkNativePoW,
         buildGetCFilters, parseCFilter, buildGetCFHeaders, parseCFHeaders, buildGetData, parseInv,
         MSG_WITNESS_BLOCK, MSG_WITNESS_TX, MSG_TX } from './p2p.mjs';
import { filterMatchesAny } from './bip158.mjs';
import { parseAuxPow, checkAuxPoW } from './auxpow.mjs';
import { blockHash, parseBlock } from './scan.mjs';
import { parseTx, txid as txidOf } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';
import { sha256d } from '../../../../core/crypto.mjs';

const PROTO = 70016;
const CFILTERS_BATCH = 1000;    // node's MAX_GETCFILTERS_SIZE — larger requests are ignored
const CFHEADERS_BATCH = 2000;   // node's MAX_GETCFHEADERS_SIZE

export class Neutrino {
  constructor({ url, net = 'regtest', genesis }) {
    this.url = url; this.net = net; this.genesis = genesis;
    this._handlers = {};                 // command -> callback (single-shot phases)
    // persistent, incremental state (kept across syncWallet calls / restorable)
    this.chain = [{ hash: genesis, prevHash: null, time: 0 }];
    this.heightOf = { [genesis]: 0 };
    this.utxos = new Map();              // "txid:vout" -> {txid,vout,value,refheight,script,coinbase}
    this.history = [];                   // {txid,category,amount,height,time}
    this.scannedHeight = 0;              // highest block scanned for wallet activity
    this.reorgFloor = null;              // lowest fork height rolled back since last persist (signal for the store)
    this.mempool = new Map();            // txid -> {txid,category,amount,time} — unconfirmed wallet txs
    this.peerHeight = 0;                 // peer's chain height from the version handshake (progress target)
    this.onProgress = null;              // optional ({phase, ...}) callback for sync progress
    this._watch = null;                  // scripts watched for mempool activity
    this._inflight = new Set();          // reject fns of in-flight _await promises (rejected on disconnect)
  }
  get stateClient() { return this; }     // the object that owns the persistable chain/UTXO state

  /** Block locator with exponential back-off, so the node can find the fork point after a reorg. */
  _locator() {
    const c = this.chain, loc = []; let step = 1;
    for (let i = c.length - 1; i >= 0; i -= step) { loc.push(c[i].hash); if (loc.length >= 10) step *= 2; }
    if (loc[loc.length - 1] !== this.genesis) loc.push(this.genesis);
    return loc;
  }

  _verifyPoW(h) {
    if (h.hasAux) {
      const { aux } = parseAuxPow(h.raw, 82);
      if (!checkAuxPoW({ prev: h.raw.subarray(4, 36), time: h.raw.readUInt32LE(68) }, aux, this.net === 'main' ? 'main' : this.net))
        throw new Error('aux-pow invalid');
    } else if (!checkNativePoW(h)) throw new Error('header PoW invalid');
  }

  /** Roll the wallet/chain state back to `forkH` (drop everything above it). */
  _reorgTo(forkH) {
    for (let ht = this.chain.length - 1; ht > forkH; ht--) delete this.heightOf[this.chain[ht].hash];
    this.chain.length = forkH + 1;
    for (const [k, u] of this.utxos) if (u.refheight > forkH) this.utxos.delete(k);
    this.history = this.history.filter(e => e.height <= forkH);
    this.scannedHeight = Math.min(this.scannedHeight, forkH);
    this.reorgFloor = Math.min(this.reorgFloor ?? Infinity, forkH);
  }
  _send(cmd, payload) { this.ws.send(encodeMessage(this.net, cmd, payload)); }
  on(cmd, fn) { this._handlers[cmd] = fn; }

  /** Open the WS, do the version/verack handshake. Resolves when connected. */
  connect() {
    if (this._conn) return this._conn;   // re-entrant: share the in-flight attempt
    this._conn = new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      const decode = createDecoder(this.net);
      ws.onopen = () => this._send('version', buildVersion({ height: 0 }));
      ws.onerror = () => { this._conn = null; reject(new Error('bridge/ws error')); };
      ws.onclose = () => {
        this._conn = null;
        if (!this._ready) reject(new Error('connection closed'));
        this._ready = false;
        // Fail any sync stuck mid-flight so the caller can retry (which reconnects lazily).
        for (const rej of this._inflight) rej(new Error('connection lost'));
        this._inflight.clear();
      };
      ws.onmessage = ev => {
        for (const m of decode(Buffer.from(ev.data))) {
          if (m.command === 'version') { try { this.peerHeight = parseVersion(m.payload).startHeight; } catch {} this._send('verack'); }
          else if (m.command === 'verack') { this._ready = true; resolve(); }
          else if (m.command === 'ping') this._send('pong', m.payload);
          else if (m.command === 'inv') this._onInv(m);
          else if (m.command === 'tx') this._onTx(m);
          else this._handlers[m.command]?.(m);
        }
      };
    });
    return this._conn;
  }

  /** Reconnect if the socket dropped (bridge restart, network blip). */
  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1 && this._ready) return;
    await this.connect();
  }

  _await(cmd) {
    return new Promise((res, rej) => {
      this._inflight.add(rej);
      this.on(cmd, m => { this._inflight.delete(rej); res(m); });
    });
  }

  // --- mempool watch: unsolicited tx invs -> getdata -> match against wallet scripts ---
  _onInv(m) {
    if (!this._watch) return;
    const txs = parseInv(m.payload).filter(i => i.type === MSG_TX || i.type === MSG_WITNESS_TX);
    if (txs.length) this._send('getdata', buildGetData(txs.map(t => ({ type: MSG_WITNESS_TX, hashHex: t.hashHex }))));
  }
  _onTx(m) {
    if (!this._watch) return;
    try { this._considerTx(parseTx(Buffer.from(m.payload).toString('hex'))); } catch {}
  }
  /** If `tx` touches the wallet (pays a watched script / spends our UTXO), record it as pending. */
  _considerTx(tx) {
    const id = txidOf(tx);
    if (this.mempool.has(id)) return;
    const rev = h => Buffer.from(h, 'hex').reverse().toString('hex');
    let recv = 0n, sent = 0n;
    for (const vin of tx.vin) { const u = this.utxos.get(rev(vin.prevout.txid) + ':' + vin.prevout.vout); if (u) sent += u.value; }
    for (const o of tx.vout) if (this._watch.has(o.scriptPubKey)) recv += o.value;
    if (recv === 0n && sent === 0n) return;
    this.mempool.set(id, { txid: id, category: recv >= sent ? 'receive' : 'send', amount: recv - sent, time: Math.floor(Date.now() / 1000) });
  }

  /** Incrementally extend the chain from the current tip, verifying linkage + PoW.
   *  Only NEW headers are fetched (getheaders from a back-off locator); a reorg below
   *  the tip is detected via the locator and rolled back. PIPELINED: the next batch is
   *  requested as soon as the current one is parsed (its hashes are known before PoW
   *  verification), so the network round-trip overlaps the CPU-heavy verify — on a
   *  high-RTT link (mobile) the sequential request→verify→request loop was RTT-bound.
   *  Returns the chain array. */
  async syncHeaders() {
    const request = locator => { const p = this._await('headers'); this._send('getheaders', buildGetHeaders(PROTO, locator)); return p; };
    let inFlight = request(this._locator());
    for (;;) {
      const hs = parseHeaders((await inFlight).payload);
      if (hs.length === 0) break;
      // Ask for the batch after this one BEFORE verifying: parseHeaders already computed
      // every hash, so the locator head is known. If this batch fails PoW we throw anyway;
      // the speculative request costs nothing (its response is simply never awaited).
      inFlight = request([hs[hs.length - 1].hash, ...this._locator()]);
      // The first header connects at the last block we share with the peer (fork point).
      const forkH = this.heightOf[hs[0].prevHash];
      if (forkH === undefined) throw new Error('headers do not connect (deep reorg?)');
      if (forkH < this.chain.length - 1) this._reorgTo(forkH);   // roll back the orphaned tail
      for (const h of hs) {
        if (h.prevHash !== this.chain[this.chain.length - 1].hash) throw new Error('header chain break');
        this._verifyPoW(h);
        h.raw = null;                          // raw bytes only needed for PoW verify; drop to keep the chain lean (mainnet = 485k headers)
        this.heightOf[h.hash] = this.chain.length;
        this.chain.push(h);
      }
      this.onProgress?.({ phase: 'headers', height: this.chain.length - 1, target: Math.max(this.peerHeight, this.chain.length - 1) });
    }
    return this.chain;
  }

  /** One getcfilters batch [from..to] (node caps batches at 1000); calls `each(cf)` per filter. */
  _cfilterBatch(from, to, each) {
    const want = to - from + 1;
    let seen = 0;
    return new Promise((res, rej) => {
      this._inflight.add(rej);
      this.on('cfilter', m => { each(parseCFilter(m.payload)); if (++seen === want) { this._inflight.delete(rej); res(); } });
      this._send('getcfilters', buildGetCFilters(from, this.chain[to].hash));
    });
  }

  /** Stream filters for [from..tip] through `each(cf)`, with up to `DEPTH` batch requests
   *  in flight (the node answers requests in order over the single stream, so responses
   *  arrive sequentially). A sequential batch loop is RTT-bound: a full mainnet scan is
   *  ~485 batches — pipelining makes it download/CPU-bound instead. */
  _cfilterStream(from, each) {
    const DEPTH = 8;
    const tip = this.chain.length - 1;
    const want = tip - from + 1;
    if (want <= 0) return Promise.resolve(0);
    const ranges = [];
    for (let lo = from; lo <= tip; lo += CFILTERS_BATCH) ranges.push([lo, Math.min(lo + CFILTERS_BATCH - 1, tip)]);
    let received = 0, sent = 0;
    return new Promise((res, rej) => {
      this._inflight.add(rej);
      const sendMore = () => {
        while (sent < ranges.length && sent - Math.floor(received / CFILTERS_BATCH) < DEPTH) {
          const [lo, hi] = ranges[sent++];
          this._send('getcfilters', buildGetCFilters(lo, this.chain[hi].hash));
        }
      };
      this.on('cfilter', m => {
        each(parseCFilter(m.payload));
        received++;
        if (received % CFILTERS_BATCH === 0 || received === want) {
          this.onProgress?.({ phase: 'filters', done: received, want });
          if (received === want) { this._inflight.delete(rej); res(want); return; }
          sendMore();
        }
      });
      sendMore();
    });
  }

  /** BIP158 filters for heights [from..tip]; return the block hashes matching `scripts`. */
  async matchFilters(scripts, from = 1) {
    const matched = [];
    await this._cfilterStream(from, cf => {
      if (filterMatchesAny(cf.filter, cf.blockHash, scripts)) matched.push(cf.blockHash);
    });
    return matched;
  }

  /** BIP157 filter hashes for heights [from..tip] — the compact commitment a peer vouches
   *  for; comparing these across peers detects a peer serving a tampered/omitting filter.
   *  Batched (the node serves at most 2000 cfheaders per request). */
  async getCFHeaders(from = 1) {
    const tip = this.chain.length - 1;
    if (tip < from) return [];
    const all = [];
    for (let lo = from; lo <= tip; lo += CFHEADERS_BATCH) {
      const hi = Math.min(lo + CFHEADERS_BATCH - 1, tip);
      const hs = await new Promise((res, rej) => {
        this._inflight.add(rej);
        this.on('cfheaders', m => { this._inflight.delete(rej); res(parseCFHeaders(m.payload).filterHashes); });
        this._send('getcfheaders', buildGetCFHeaders(lo, this.chain[hi].hash));
      });
      all.push(...hs);
    }
    return all;
  }

  /** Full filters for [from..tip], each with its own double-SHA256 (to check against the
   *  cross-peer agreed hash) and whether it matches `scripts`. Keyed by height. */
  async filtersWithHashes(scripts, from = 1) {
    const out = [];
    await this._cfilterStream(from, cf => out.push({
      height: this.heightOf[cf.blockHash], blockHash: cf.blockHash,
      filterHash: Buffer.from(sha256d(cf.filter)).reverse().toString('hex'),
      matched: filterMatchesAny(cf.filter, cf.blockHash, scripts),
    }));
    return out;
  }

  /** Fetch the given blocks (display hashes), scan them into the persistent UTXO set /
   *  history in height order, and advance scannedHeight to the tip. The blocks passed are
   *  those the wallet must inspect (filter-matched and/or disputed by peer disagreement). */
  async _applyBlocks(scripts, matchedHashes) {
    const tip = this.chain.length - 1;
    const blocks = await this.fetchBlocks(matchedHashes);
    blocks.sort((a, b) => this.heightOf[a.hash] - this.heightOf[b.hash]);   // scan in height order
    const mine = new Set(scripts);
    const utxos = this.utxos, history = this.history;
    const rev = h => Buffer.from(h, 'hex').reverse().toString('hex');
    for (const { hash, bytes } of blocks) {
      const height = this.heightOf[hash]; const time = this.chain[height].time;
      parseBlock(bytes).forEach((tx, txIndex) => {
        const id = txidOf(tx);
        let recv = 0n, sent = 0n;
        for (const vin of tx.vin) { const k = rev(vin.prevout.txid) + ':' + vin.prevout.vout; const u = utxos.get(k); if (u) { sent += u.value; utxos.delete(k); } }
        tx.vout.forEach((o, i) => { if (mine.has(o.scriptPubKey)) { recv += o.value; utxos.set(id + ':' + i, { txid: id, vout: i, value: o.value, refheight: height, script: o.scriptPubKey, coinbase: txIndex === 0 }); } });
        if (recv > sent) history.push({ txid: id, category: txIndex === 0 ? 'generate' : 'receive', amount: recv - sent, height, time });
        else if (sent > recv) history.push({ txid: id, category: 'send', amount: recv - sent, height, time });
      });
    }
    this.scannedHeight = tip;
  }

  /** Download the given blocks (display hashes). Returns [{hash, bytes}]. */
  async fetchBlocks(hashes) {
    if (!hashes.length) return [];
    const blocks = [];
    return new Promise((res, rej) => {
      this._inflight.add(rej);
      this.on('block', m => {
        const bytes = Buffer.from(m.payload); blocks.push({ hash: blockHash(bytes), bytes });
        this.onProgress?.({ phase: 'blocks', done: blocks.length, want: hashes.length });
        if (blocks.length === hashes.length) { this._inflight.delete(rej); res(blocks); }
      });
      this._send('getdata', buildGetData(hashes.map(h => ({ type: MSG_WITNESS_BLOCK, hashHex: h }))));
    });
  }

  /**
   * Incremental wallet sync. Extends the chain, then scans ONLY the blocks above the
   * last-scanned height (filters + matched blocks), updating the persistent UTXO set /
   * history in place. Consecutive calls with no new blocks do no filter/block work.
   * Returns { tipHeight, balance (kria), utxos, history } computed entirely client-side.
   */
  async syncWallet(scripts) {
    await this.ensureConnected();
    this._watch = new Set(scripts);        // watch the mempool for these scripts from now on
    await this.syncHeaders();
    const tip = this.chain.length - 1;
    if (tip > this.scannedHeight) {
      const matched = await this.matchFilters(scripts, this.scannedHeight + 1);
      await this._applyBlocks(scripts, matched);
      for (const id of this.mempool.keys())  // confirmed now? drop from pending
        if (this.history.some(e => e.txid === id)) this.mempool.delete(id);
    }
    let balance = 0n; for (const u of this.utxos.values()) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { tipHeight: tip, balance, utxos: [...this.utxos.values()], history: [...this.history].reverse(), pending: [...this.mempool.values()] };
  }

  /** The same result shape as syncWallet, computed from the CURRENT in-memory state with
   *  no network at all — used to show a last-known balance instantly (e.g. restored from
   *  IndexedDB) while the real sync catches up. */
  snapshot() {
    const tip = this.chain.length - 1;
    let balance = 0n; for (const u of this.utxos.values()) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { tipHeight: tip, balance, utxos: [...this.utxos.values()], history: [...this.history].reverse(), pending: [...this.mempool.values()] };
  }

  /** Serialize the incremental state (JSON-safe) for persistence across page reloads. */
  exportState() {
    return {
      net: this.net, genesis: this.genesis, scannedHeight: this.scannedHeight,
      chain: this.chain.map(h => ({ hash: h.hash, prevHash: h.prevHash ?? null, time: h.time || 0 })),
      utxos: [...this.utxos.values()].map(u => ({ ...u, value: u.value.toString() })),
      history: this.history.map(e => ({ ...e, amount: e.amount.toString() })),
    };
  }

  /** Restore state from exportState(). Returns false (state untouched) if net/genesis mismatch. */
  importState(s) {
    if (!s || s.net !== this.net || s.genesis !== this.genesis || !Array.isArray(s.chain) || s.chain[0]?.hash !== this.genesis) return false;
    this.chain = s.chain.map(h => ({ hash: h.hash, prevHash: h.prevHash, time: h.time }));
    this.heightOf = {}; this.chain.forEach((h, i) => this.heightOf[h.hash] = i);
    this.utxos = new Map(s.utxos.map(u => [u.txid + ':' + u.vout, { ...u, value: BigInt(u.value) }]));
    this.history = s.history.map(e => ({ ...e, amount: BigInt(e.amount) }));
    this.scannedHeight = s.scannedHeight | 0;
    return true;
  }

  /** Broadcast a signed raw tx over P2P (send `tx`). Records it as pending immediately. */
  broadcast(rawHex) {
    this._send('tx', Buffer.from(rawHex, 'hex'));
    if (this._watch) try { this._considerTx(parseTx(rawHex)); } catch {}
    return null;
  }

  close() { this._ready = false; this._conn = null; try { this.ws.close(); } catch {} }
}

/**
 * Multi-peer neutrino: cross-checks BIP157 filter commitments across several independent
 * peers so no single peer can hide funds by serving a tampered filter. The primary peer
 * owns the incremental wallet state (chain, UTXOs); the others are consulted only for
 * filter agreement. For each new block the wallet inspects it directly (downloads + scans)
 * when EITHER its filter matches our scripts OR the peers disagree on that block's filter
 * hash — the block is committed to by the PoW-verified header, so a disagreement is
 * resolved authoritatively by the block itself. Guarantee: as long as ≥1 peer is honest,
 * an omitted payment forces a disagreement and is caught. A block can never be forged
 * (header PoW), so the worst a bad peer can do is trigger an extra block download.
 */
export class NeutrinoPool {
  constructor({ urls, net = 'regtest', genesis }) {
    this.net = net; this.genesis = genesis;
    this.peers = urls.map(url => new Neutrino({ url, net, genesis }));
    this.primary = this.peers[0];
    this.lastAgreement = null;
  }
  get stateClient() { return this.primary; }   // the primary owns the persistable chain/UTXO state

  async connect() {
    const rs = await Promise.allSettled(this.peers.map(p => p.connect()));
    // Keep only peers that connected; the primary must be among them.
    this.peers = this.peers.filter((_, i) => rs[i].status === 'fulfilled');
    if (!this.peers.length) throw new Error('no peer connected');
    if (!this.peers.includes(this.primary)) this.primary = this.peers[0];
  }

  async syncWallet(scripts) {
    const primary = this.primary;
    await Promise.allSettled(this.peers.map(p => p.ensureConnected()));   // reconnect dropped peers
    this.peers.forEach(p => p._watch = new Set(scripts));                 // mempool watch on every peer
    // 1. Sync headers on every peer independently (each verifies linkage + PoW).
    const hs = await Promise.allSettled(this.peers.map(p => p.syncHeaders()));
    const alive = this.peers.filter((_, i) => hs[i].status === 'fulfilled');
    const tip = primary.chain.length - 1;

    if (tip > primary.scannedHeight) {
      const from = primary.scannedHeight + 1;
      // 2. Only peers that agree with the primary on the tip header can vouch for filters.
      const agreeing = alive.filter(p => p.chain.length - 1 >= tip && p.chain[tip].hash === primary.chain[tip].hash);
      // 3. Filter-hash commitments from every agreeing peer (one getcfheaders each).
      const cf = await Promise.all(agreeing.map(p => p.getCFHeaders(from)));
      const n = tip - from + 1;
      const disputed = new Set();            // heights where peers disagree on the filter hash
      const agreed = [];                     // consensus filter hash per height (majority)
      for (let i = 0; i < n; i++) {
        const votes = cf.map(a => a[i]).filter(Boolean);
        const tally = {}; for (const v of votes) tally[v] = (tally[v] || 0) + 1;
        const [best] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || [null];
        agreed[i] = best;
        if (votes.length && votes.some(v => v !== votes[0])) disputed.add(from + i);
      }
      // 4. Primary's actual filters: which match our scripts, and are they consistent with
      //    the cross-peer consensus? A filter whose hash ≠ the agreed hash is not trusted.
      const fh = await primary.filtersWithHashes(scripts, from);
      const fetch = new Set();
      for (const f of fh) {
        const consensus = agreed[f.height - from];
        if (f.matched) fetch.add(f.height);
        else if (consensus && f.filterHash !== consensus) fetch.add(f.height);   // primary served an off-consensus filter
      }
      for (const h of disputed) fetch.add(h);
      // 5. Download + scan exactly those blocks (authoritative), advance scannedHeight.
      const hashes = [...fetch].sort((a, b) => a - b).map(h => primary.chain[h].hash);
      await primary._applyBlocks(scripts, hashes);
      this.lastAgreement = { peers: this.peers.length, agreeing: agreeing.length, disputed: disputed.size, forced: fetch.size };
    } else {
      this.lastAgreement = { peers: this.peers.length, agreeing: alive.length, disputed: 0, forced: 0 };
    }

    // Pending: merge every peer's mempool sightings (an inv may reach only one connection),
    // dropping anything that has confirmed into the primary's history.
    // (primary iterated last so its entry wins — it has the UTXO set for correct categorization)
    const pending = new Map();
    for (const p of [...this.peers].reverse()) for (const [id, e] of p.mempool) {
      if (primary.history.some(h => h.txid === id)) p.mempool.delete(id);
      else pending.set(id, e);
    }
    let balance = 0n; for (const u of primary.utxos.values()) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { tipHeight: tip, balance, utxos: [...primary.utxos.values()], history: [...primary.history].reverse(), pending: [...pending.values()], agreement: this.lastAgreement };
  }

  broadcast(rawHex) { for (const p of this.peers) p.broadcast(rawHex); return null; }
  snapshot() { return this.primary.snapshot(); }
  exportState() { return this.primary.exportState(); }
  importState(s) { return this.primary.importState(s); }
  close() { for (const p of this.peers) p.close(); }
}
