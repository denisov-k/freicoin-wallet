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
import { HeaderChain } from './chain.mjs';
import { makePool } from './verifypool.mjs';
import { parseTx, txid as txidOf } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';
import { sha256d } from '../../../../core/crypto.mjs';

const PROTO = 70016;
const CFILTERS_BATCH = 1000;    // node's MAX_GETCFILTERS_SIZE — larger requests are ignored
const CFHEADERS_BATCH = 2000;   // node's MAX_GETCFHEADERS_SIZE

export class Neutrino {
  constructor({ url, net = 'regtest', genesis, snapshotUrl = null }) {
    this.url = url; this.net = net; this.genesis = genesis; this.snapshotUrl = snapshotUrl;
    this._rx = 0;                        // bytes received (this connection + snapshot)
    this._handlers = {};                 // command -> callback (single-shot phases)
    // persistent, incremental state (kept across syncWallet calls / restorable)
    this.chain = new HeaderChain(genesis);   // compact columnar chain (hashAt/timeAt/heightOf)
    this.utxos = new Map();              // "txid:vout" -> {txid,vout,value,refheight,script,coinbase}
    this.history = [];                   // {txid,category,amount,height,time}
    this.scannedHeight = 0;              // highest block scanned for wallet activity
    this.scannedOnce = false;            // true once a full filter scan has completed (preview gate)
    this.reorgFloor = null;              // lowest fork height rolled back since last persist (signal for the store)
    this.mempool = new Map();            // txid -> {txid,category,amount,time} — unconfirmed wallet txs
    this.peerHeight = 0;                 // peer's chain height from the version handshake (progress target)
    this.onProgress = null;              // optional ({phase, ...}) callback for sync progress
    this._watch = null;                  // scripts watched for mempool activity
    this._inflight = new Set();          // reject fns of in-flight _await promises (rejected on disconnect)
    // deferred aux-pow verification: headers are linked+pushed immediately; their proofs
    // queue here and verify in a worker pool (or inline) — verifiedHeight trails the tip
    // and gates persistence, so an unverified chain is never trusted across a reload.
    this.verifiedHeight = 0;
    this._pendingVerify = [];            // [{raws: Buffer[], endH}]
    this._verifying = null;              // in-flight drain promise
    this._auxDone = 0; this._auxTotal = 0;
    this._pool = undefined;              // verify-worker pool (null = inline fallback)
  }
  get stateClient() { return this; }     // the object that owns the persistable chain/UTXO state

  /** Wipe all wallet/chain state (after a failed PoW verification — nothing is trustable). */
  _resetState() {
    this.chain = new HeaderChain(this.genesis);
    this.utxos = new Map(); this.history = []; this.mempool = new Map();
    this.scannedHeight = 0; this.scannedOnce = false; this.reorgFloor = null;
    this.verifiedHeight = 0; this._pendingVerify = []; this._verifying = null;
    this._auxDone = 0; this._auxTotal = 0;
  }

  /** Queue a batch of aux-pow proofs; a pool consumer verifies them as they arrive
   *  (inline fallback verifies at drainVerify time instead, to not starve the socket). */
  _queueVerify(raws, endH) {
    this._auxTotal += raws.length;
    this._pendingVerify.push({ raws, endH });
    if (this._pool) this._startConsumer();
  }
  _startConsumer() {
    if (this._verifying) return;
    this._verifying = (async () => {
      while (this._pendingVerify.length) {
        const { raws, endH } = this._pendingVerify.shift();
        if (this._pool) await this._pool.verify(this.net, raws);
        else await this._verifyInline(raws);
        this._auxDone += raws.length;
        if (endH > this.verifiedHeight) this.verifiedHeight = endH;
        this.onProgress?.({ phase: 'verify', done: this._auxDone, want: this._auxTotal });
      }
      this._verifying = null;
    })();
  }
  async _verifyInline(raws) {
    for (let i = 0; i < raws.length; i += 200) {
      for (const raw of raws.slice(i, i + 200)) this._verifyPoW({ hasAux: true, raw });
      await new Promise(r => setTimeout(r, 0));   // keep the socket serviced
    }
  }
  /** Wait for every queued proof to verify. Throws (and resets state) on a bad proof. */
  async drainVerify() {
    try {
      if (!this._pool && this._pendingVerify.length) this._startConsumer();
      while (this._verifying) await this._verifying;
    } catch (e) { this._resetState(); throw e; }
  }

  /** Block locator with exponential back-off, so the node can find the fork point after a reorg. */
  _locator() {
    const c = this.chain, loc = []; let step = 1;
    for (let i = c.length - 1; i >= 0; i -= step) { loc.push(c.hashAt(i)); if (loc.length >= 10) step *= 2; }
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
    this.chain.truncate(forkH + 1);
    for (const [k, u] of this.utxos) if (u.refheight > forkH) this.utxos.delete(k);
    this.history = this.history.filter(e => e.height <= forkH);
    this.scannedHeight = Math.min(this.scannedHeight, forkH);
    this.verifiedHeight = Math.min(this.verifiedHeight, forkH);
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
        this._rx += ev.data.byteLength || 0;
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
  /** Link + push a parsed headers batch: native PoW inline (the hash is already computed),
   *  aux-pow proofs QUEUED for the parallel verify pool. Shared by the P2P sync and the
   *  snapshot bootstrap — both are untrusted inputs and get identical verification. */
  async _processBatch(hs) {
    // The first header connects at the last block we share (fork point on reorg).
    const forkH = this.chain.heightOf(hs[0].prevHash);
    if (forkH === undefined) throw new Error('headers do not connect (deep reorg?)');
    if (forkH < this.chain.length - 1) {
      await this.drainVerify();                                // settle pending proofs before rolling back
      this._reorgTo(forkH);
    }
    const auxRaws = [];
    for (const h of hs) {
      if (h.prevHash !== this.chain.tipHash()) throw new Error('header chain break');
      if (h.hasAux) auxRaws.push(h.raw);
      else if (!checkNativePoW(h)) throw new Error('header PoW invalid');
      this.chain.push(h.hash, h.time);       // raw bytes/prevHash not kept — the columnar chain stores hash+time only
    }
    const endH = this.chain.length - 1;
    if (auxRaws.length) this._queueVerify(auxRaws, endH);
    else if (!this._pendingVerify.length && !this._verifying) this.verifiedHeight = endH;
    this.onProgress?.({ phase: 'headers', height: endH, target: Math.max(this.peerHeight, endH), rx: this._rx + (this._dl?._rx || 0) });
  }

  /** Bootstrap the header chain from a static HTTP snapshot (a dump of standard P2P
   *  `headers` messages). MUCH cheaper for the server than P2P serialization+relay, and
   *  needs no trust: every header goes through the same linkage+PoW verification. Any
   *  failure falls back to plain P2P (the chain stays consistent — errors throw before
   *  a bad header is pushed). */
  async _bootstrapSnapshot() {
    if (!this.snapshotUrl || this.chain.length > 1 || this._snapshotBroken || typeof fetch !== 'function') return;
    try {
      const resp = await fetch(this.snapshotUrl);
      if (!resp.ok || !resp.body) return;
      const decode = createDecoder(this.net);
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this._rx += value.byteLength;
        for (const m of decode(Buffer.from(value))) {
          if (m.command !== 'headers' || !m.ok) continue;
          const hs = parseHeaders(m.payload);
          if (hs.length) await this._processBatch(hs);
        }
      }
    } catch { this._snapshotBroken = true; }   // fall back to P2P; don't retry a bad snapshot
  }

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
      await this._processBatch(hs);
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
      this._send('getcfilters', buildGetCFilters(from, this.chain.hashAt(to)));
    });
  }

  /** Stream filters for [from..tip] through `each(cf)`, with up to `DEPTH` batch requests
   *  in flight (the node answers requests in order over the single stream, so responses
   *  arrive sequentially). A sequential batch loop is RTT-bound: a full mainnet scan is
   *  ~485 batches — pipelining makes it download/CPU-bound instead. */
  _cfilterStream(from, to, each) {
    const DEPTH = 8;
    const want = to - from + 1;
    if (want <= 0) return Promise.resolve(0);
    const ranges = [];
    for (let lo = from; lo <= to; lo += CFILTERS_BATCH) ranges.push([lo, Math.min(lo + CFILTERS_BATCH - 1, to)]);
    let received = 0, sent = 0;
    return new Promise((res, rej) => {
      this._inflight.add(rej);
      const sendMore = () => {
        while (sent < ranges.length && sent - Math.floor(received / CFILTERS_BATCH) < DEPTH) {
          const [lo, hi] = ranges[sent++];
          this._send('getcfilters', buildGetCFilters(lo, this.chain.hashAt(hi)));
        }
      };
      this.on('cfilter', m => {
        each(parseCFilter(m.payload));
        received++;
        if (received % CFILTERS_BATCH === 0 || received === want) {
          this.onProgress?.({ phase: 'filters', done: from + received - 1, want: Math.max(this.peerHeight, this.chain.length - 1) });
          if (received === want) { this._inflight.delete(rej); res(want); return; }
          sendMore();
        }
      });
      sendMore();
    });
  }

  /** BIP158 filters for heights [from..to]; return the block hashes matching `scripts`. */
  async matchFilters(scripts, from = 1, to = this.chain.length - 1) {
    const matched = [];
    await this._cfilterStream(from, to, cf => {
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
        this._send('getcfheaders', buildGetCFHeaders(lo, this.chain.hashAt(hi)));
      });
      all.push(...hs);
    }
    return all;
  }

  /** Full filters for [from..tip], each with its own double-SHA256 (to check against the
   *  cross-peer agreed hash) and whether it matches `scripts`. Keyed by height. */
  async filtersWithHashes(scripts, from = 1) {
    const out = [];
    await this._cfilterStream(from, this.chain.length - 1, cf => out.push({
      height: this.chain.heightOf(cf.blockHash), blockHash: cf.blockHash,
      filterHash: Buffer.from(sha256d(cf.filter)).reverse().toString('hex'),
      matched: filterMatchesAny(cf.filter, cf.blockHash, scripts),
    }));
    return out;
  }

  /** Fetch the given blocks (display hashes), scan them into the persistent UTXO set /
   *  history in height order, and advance scannedHeight to the tip. The blocks passed are
   *  those the wallet must inspect (filter-matched and/or disputed by peer disagreement). */
  async _applyBlocks(scripts, matchedHashes, upto = this.chain.length - 1, via = this) {
    const blocks = await via.fetchBlocks(matchedHashes);
    const hOf = new Map(blocks.map(b => [b.hash, this.chain.heightOf(b.hash)]));
    blocks.sort((a, b) => hOf.get(a.hash) - hOf.get(b.hash));   // scan in height order
    const mine = new Set(scripts);
    const utxos = this.utxos, history = this.history;
    const rev = h => Buffer.from(h, 'hex').reverse().toString('hex');
    for (const { hash, bytes } of blocks) {
      const height = hOf.get(hash); const time = this.chain.timeAt(height);
      parseBlock(bytes).forEach((tx, txIndex) => {
        const id = txidOf(tx);
        let recv = 0n, sent = 0n;
        for (const vin of tx.vin) { const k = rev(vin.prevout.txid) + ':' + vin.prevout.vout; const u = utxos.get(k); if (u) { sent += u.value; utxos.delete(k); } }
        tx.vout.forEach((o, i) => { if (mine.has(o.scriptPubKey)) { recv += o.value; utxos.set(id + ':' + i, { txid: id, vout: i, value: o.value, refheight: height, script: o.scriptPubKey, coinbase: txIndex === 0 }); } });
        if (recv > sent) history.push({ txid: id, category: txIndex === 0 ? 'generate' : 'receive', amount: recv - sent, height, time });
        else if (sent > recv) history.push({ txid: id, category: 'send', amount: recv - sent, height, time });
      });
    }
    this.scannedHeight = upto;
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
  /** Result shape at height `at` (present values evaluated at at+1). */
  _result(at = this.chain.length - 1) {
    let balance = 0n; for (const u of this.utxos.values()) balance += timeAdjustValue(u.value, at + 1 - u.refheight);
    return { tipHeight: at, balance, utxos: [...this.utxos.values()], history: [...this.history].reverse(), pending: [...this.mempool.values()] };
  }

  async syncWallet(scripts, { onProvisional = null, onPartial = null } = {}) {
    await this.ensureConnected();
    if (this._pool === undefined) this._pool = await makePool();   // null ⇒ inline fallback
    this._watch = new Set(scripts);        // watch the mempool for these scripts from now on
    // Second download connection: the follower fetches filters+blocks over its OWN socket,
    // so they don't compete with the header stream on one TCP connection (whose congestion
    // window caps throughput on high-RTT links). Shares the chain by reference; falls back
    // to the main connection if it can't open.
    if (this._dl === undefined) {
      try { const dl = new Neutrino({ url: this.url, net: this.net, genesis: this.genesis }); dl.chain = this.chain; await dl.connect(); this._dl = dl; }
      catch { this._dl = null; }
    } else if (this._dl) { try { await this._dl.ensureConnected(); } catch {} }
    const fetcher = (this._dl && this._dl._ready) ? this._dl : this;
    fetcher.onProgress = this.onProgress;
    // OVERLAPPED sync: a scan follower trails the header front, so filter download +
    // matching + block scan run concurrently with header download+verification instead
    // of strictly after them — and the balance found so far streams out via onPartial
    // as the sweep advances.
    let headersDone = false, headersErr = null;
    const headersP = this._bootstrapSnapshot().then(() => this.syncHeaders())
      .then(() => { headersDone = true; }, e => { headersDone = true; headersErr = e; });
    const follower = (async () => {
      for (;;) {
        if (headersErr) break;
        const target = this.chain.length - 1;
        const from = this.scannedHeight + 1;
        const ready = target - from + 1;
        if (ready >= CFILTERS_BATCH || (headersDone && ready > 0)) {
          // cap each stride so partial updates stay frequent even when the header front
          // races far ahead (a lagging follower would otherwise catch up in giant leaps)
          const stride = Math.min(headersDone ? ready : Math.floor(ready / CFILTERS_BATCH) * CFILTERS_BATCH, 10 * CFILTERS_BATCH);
          const to = from + stride - 1;
          const matched = await fetcher.matchFilters(scripts, from, to);
          await this._applyBlocks(scripts, matched, to, fetcher);
          onPartial?.(this._result(to));
        } else if (headersDone) break;
        else await new Promise(r => setTimeout(r, 50));   // wait for the header front to advance
      }
    })();
    await headersP; await follower;
    if (headersErr) throw headersErr;
    for (const id of this.mempool.keys())  // confirmed now? drop from pending
      if (this.history.some(e => e.txid === id)) this.mempool.delete(id);
    // Provisional: the scan is done but some PoW proofs are still verifying — surface the
    // balance now, clearly marked; the final (verified) result follows when the queue drains.
    if (onProvisional && (this._verifying || this._pendingVerify.length)) onProvisional(this._result());
    try { await this.drainVerify(); }      // throws + resets state if any proof is bad
    catch (e) { this._snapshotBroken = true; throw e; }
    this.scannedOnce = true;
    return this._result();
  }

  /** The same result shape as syncWallet, computed from the CURRENT in-memory state with
   *  no network at all — used to show a last-known balance instantly (e.g. restored from
   *  IndexedDB) while the real sync catches up. */
  snapshot() {
    const tip = this.chain.length - 1;
    let balance = 0n; for (const u of this.utxos.values()) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { tipHeight: tip, balance, utxos: [...this.utxos.values()], history: [...this.history].reverse(), pending: [...this.mempool.values()] };
  }

  /** Serialize the incremental state (JSON-safe) for persistence across page reloads.
   *  prevHash is not stored — it is redundant (prevHash at h === hash at h-1). */
  exportState() {
    const chain = [];
    for (let h = 0; h < this.chain.length; h++) chain.push({ hash: this.chain.hashAt(h), time: this.chain.timeAt(h) });
    return {
      net: this.net, genesis: this.genesis, scannedHeight: this.scannedHeight, scannedOnce: this.scannedOnce, chain,
      utxos: [...this.utxos.values()].map(u => ({ ...u, value: u.value.toString() })),
      history: this.history.map(e => ({ ...e, amount: e.amount.toString() })),
    };
  }

  /** Restore state from exportState(). Returns false (state untouched) if net/genesis mismatch. */
  importState(s) {
    if (!s || s.net !== this.net || s.genesis !== this.genesis || !Array.isArray(s.chain) || s.chain[0]?.hash !== this.genesis) return false;
    this.chain = new HeaderChain(this.genesis);
    for (let i = 1; i < s.chain.length; i++) this.chain.push(s.chain[i].hash, s.chain[i].time || 0);
    this.utxos = new Map(s.utxos.map(u => [u.txid + ':' + u.vout, { ...u, value: BigInt(u.value) }]));
    this.history = s.history.map(e => ({ ...e, amount: BigInt(e.amount) }));
    this.scannedHeight = s.scannedHeight | 0;
    this.scannedOnce = !!s.scannedOnce;
    this.verifiedHeight = this.chain.length - 1;   // persisted headers were verified before saving
    return true;
  }

  /** Broadcast a signed raw tx over P2P (send `tx`). Records it as pending immediately. */
  broadcast(rawHex) {
    this._send('tx', Buffer.from(rawHex, 'hex'));
    if (this._watch) try { this._considerTx(parseTx(rawHex)); } catch {}
    return null;
  }

  close() {
    this._ready = false; this._conn = null;
    try { this.ws.close(); } catch {}
    try { this._pool?.close(); } catch {} this._pool = undefined;
    try { this._dl?.close(); } catch {} this._dl = undefined;
  }
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
    if (this._vpool === undefined) this._vpool = await makePool();        // one shared verify pool
    this.peers.forEach(p => { p._watch = new Set(scripts); if (p._pool === undefined) p._pool = this._vpool; });
    // 1. Sync headers on every peer independently (each verifies linkage + PoW; aux proofs
    //    verify via the shared pool and are drained before any filter agreement).
    const hs = await Promise.allSettled(this.peers.map(p => p.syncHeaders()));
    await Promise.allSettled(this.peers.map(p => p.drainVerify()));
    const alive = this.peers.filter((_, i) => hs[i].status === 'fulfilled');
    const tip = primary.chain.length - 1;

    if (tip > primary.scannedHeight) {
      const from = primary.scannedHeight + 1;
      // 2. Only peers that agree with the primary on the tip header can vouch for filters.
      const agreeing = alive.filter(p => p.chain.length - 1 >= tip && p.chain.hashAt(tip) === primary.chain.hashAt(tip));
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
      const hashes = [...fetch].sort((a, b) => a - b).map(h => primary.chain.hashAt(h));
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
  close() { for (const p of this.peers) { p._pool = undefined; p.close(); } try { this._vpool?.close(); } catch {} this._vpool = undefined; }
}
