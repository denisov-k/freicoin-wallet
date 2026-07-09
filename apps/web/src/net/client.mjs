// client.mjs — Neutrino light client: ties B0-B3 (P2P handshake, headers, BIP157/158
// filters, block scan) over a WebSocket transport (through the p2p-bridge) into the
// same data a wallet needs — balance, UTXOs, history — with no trusted backend.
import { Buffer } from 'buffer';
import { encodeMessage, createDecoder, buildVersion, buildGetHeaders, parseHeaders, checkNativePoW,
         buildGetCFilters, parseCFilter, buildGetCFHeaders, parseCFHeaders, buildGetData, MSG_WITNESS_BLOCK } from './p2p.mjs';
import { filterMatchesAny } from './bip158.mjs';
import { parseAuxPow, checkAuxPoW } from './auxpow.mjs';
import { blockHash, parseBlock } from './scan.mjs';
import { txid as txidOf } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';
import { sha256d } from '../../../../core/crypto.mjs';

const PROTO = 70016;

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
  }

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
  }
  _send(cmd, payload) { this.ws.send(encodeMessage(this.net, cmd, payload)); }
  on(cmd, fn) { this._handlers[cmd] = fn; }

  /** Open the WS, do the version/verack handshake. Resolves when connected. */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      const decode = createDecoder(this.net);
      ws.onopen = () => this._send('version', buildVersion({ height: 0 }));
      ws.onerror = e => reject(new Error('bridge/ws error'));
      ws.onclose = () => { if (!this._ready) reject(new Error('connection closed')); };
      ws.onmessage = ev => {
        for (const m of decode(Buffer.from(ev.data))) {
          if (m.command === 'version') this._send('verack');
          else if (m.command === 'verack') { this._ready = true; resolve(); }
          else if (m.command === 'ping') this._send('pong', m.payload);
          else this._handlers[m.command]?.(m);
        }
      };
    });
  }

  _await(cmd) { return new Promise(res => this.on(cmd, res)); }

  /** Incrementally extend the chain from the current tip, verifying linkage + PoW.
   *  Only NEW headers are fetched (getheaders from a back-off locator); a reorg below
   *  the tip is detected via the locator and rolled back. Returns the chain array. */
  async syncHeaders() {
    for (;;) {
      const p = this._await('headers');
      this._send('getheaders', buildGetHeaders(PROTO, this._locator()));
      const hs = parseHeaders((await p).payload);
      if (hs.length === 0) break;
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
    }
    return this.chain;
  }

  /** BIP158 filters for heights [from..tip]; return the block hashes matching `scripts`. */
  async matchFilters(scripts, from = 1) {
    const tip = this.chain.length - 1;
    const want = tip - from + 1;
    if (want <= 0) return [];
    const matched = [];
    let seen = 0;
    return new Promise(res => {
      this.on('cfilter', m => {
        const cf = parseCFilter(m.payload); seen++;
        if (filterMatchesAny(cf.filter, cf.blockHash, scripts)) matched.push(cf.blockHash);
        if (seen === want) res(matched);
      });
      this._send('getcfilters', buildGetCFilters(from, this.chain[tip].hash));
    });
  }

  /** BIP157 filter hashes for heights [from..tip] (one getcfheaders round-trip).
   *  Returns display-hex filter_hash per block — the compact commitment a peer vouches
   *  for; comparing these across peers detects a peer serving a tampered/omitting filter. */
  async getCFHeaders(from = 1) {
    const tip = this.chain.length - 1;
    if (tip < from) return [];
    return new Promise(res => {
      this.on('cfheaders', m => res(parseCFHeaders(m.payload).filterHashes));
      this._send('getcfheaders', buildGetCFHeaders(from, this.chain[tip].hash));
    });
  }

  /** Full filters for [from..tip], each with its own double-SHA256 (to check against the
   *  cross-peer agreed hash) and whether it matches `scripts`. Keyed by height. */
  async filtersWithHashes(scripts, from = 1) {
    const tip = this.chain.length - 1;
    const want = tip - from + 1;
    if (want <= 0) return [];
    const out = [];
    let seen = 0;
    return new Promise(res => {
      this.on('cfilter', m => {
        const cf = parseCFilter(m.payload); seen++;
        out.push({
          height: this.heightOf[cf.blockHash], blockHash: cf.blockHash,
          filterHash: Buffer.from(sha256d(cf.filter)).reverse().toString('hex'),
          matched: filterMatchesAny(cf.filter, cf.blockHash, scripts),
        });
        if (seen === want) res(out);
      });
      this._send('getcfilters', buildGetCFilters(from, this.chain[tip].hash));
    });
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
    return new Promise(res => {
      this.on('block', m => {
        const bytes = Buffer.from(m.payload); blocks.push({ hash: blockHash(bytes), bytes });
        if (blocks.length === hashes.length) res(blocks);
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
    await this.syncHeaders();
    const tip = this.chain.length - 1;
    if (tip > this.scannedHeight) {
      const matched = await this.matchFilters(scripts, this.scannedHeight + 1);
      await this._applyBlocks(scripts, matched);
    }
    let balance = 0n; for (const u of this.utxos.values()) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { tipHeight: tip, balance, utxos: [...this.utxos.values()], history: [...this.history].reverse() };
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

  /** Broadcast a signed raw tx over P2P (send `tx`). Returns the txid. */
  broadcast(rawHex) { this._send('tx', Buffer.from(rawHex, 'hex')); return null; }

  close() { try { this.ws.close(); } catch {} }
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

  async connect() {
    const rs = await Promise.allSettled(this.peers.map(p => p.connect()));
    // Keep only peers that connected; the primary must be among them.
    this.peers = this.peers.filter((_, i) => rs[i].status === 'fulfilled');
    if (!this.peers.length) throw new Error('no peer connected');
    if (!this.peers.includes(this.primary)) this.primary = this.peers[0];
  }

  async syncWallet(scripts) {
    const primary = this.primary;
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

    let balance = 0n; for (const u of primary.utxos.values()) balance += timeAdjustValue(u.value, tip + 1 - u.refheight);
    return { tipHeight: tip, balance, utxos: [...primary.utxos.values()], history: [...primary.history].reverse(), agreement: this.lastAgreement };
  }

  broadcast(rawHex) { for (const p of this.peers) p.broadcast(rawHex); return null; }
  exportState() { return this.primary.exportState(); }
  importState(s) { return this.primary.importState(s); }
  close() { for (const p of this.peers) p.close(); }
}
