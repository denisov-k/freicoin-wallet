// client.mjs — Neutrino light client: ties B0-B3 (P2P handshake, headers, BIP157/158
// filters, block scan) over a WebSocket transport (through the p2p-bridge) into the
// same data a wallet needs — balance, UTXOs, history — with no trusted backend.
import { Buffer } from 'buffer';
import { encodeMessage, createDecoder, buildVersion, buildGetHeaders, parseHeaders, checkNativePoW,
         buildGetCFilters, parseCFilter, buildGetData, MSG_WITNESS_BLOCK } from './p2p.mjs';
import { filterMatchesAny } from './bip158.mjs';
import { parseAuxPow, checkAuxPoW } from './auxpow.mjs';
import { blockHash, parseBlock } from './scan.mjs';
import { txid as txidOf } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';

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
      const from = this.scannedHeight + 1;
      const matched = await this.matchFilters(scripts, from);
      const blocks = await this.fetchBlocks(matched);
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
