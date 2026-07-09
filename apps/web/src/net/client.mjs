// client.mjs — Neutrino light client: ties B0-B3 (P2P handshake, headers, BIP157/158
// filters, block scan) over a WebSocket transport (through the p2p-bridge) into the
// same data a wallet needs — balance, UTXOs, history — with no trusted backend.
import { Buffer } from 'buffer';
import { encodeMessage, createDecoder, buildVersion, buildGetHeaders, parseHeaders, checkNativePoW,
         buildGetCFilters, parseCFilter, buildGetData, MSG_WITNESS_BLOCK } from './p2p.mjs';
import { filterMatchesAny } from './bip158.mjs';
import { blockHash, parseBlock } from './scan.mjs';
import { txid as txidOf } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';

const PROTO = 70016;

export class Neutrino {
  constructor({ url, net = 'regtest', genesis }) {
    this.url = url; this.net = net; this.genesis = genesis;
    this._handlers = {};                 // command -> callback (single-shot phases)
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

  /** Sync headers from genesis, verifying linkage + native PoW. Returns the chain array. */
  async syncHeaders() {
    const chain = [{ hash: this.genesis }];
    for (;;) {
      const p = this._await('headers');
      this._send('getheaders', buildGetHeaders(PROTO, [chain[chain.length - 1].hash]));
      const hs = parseHeaders((await p).payload);
      for (const h of hs) {
        if (h.prevHash !== chain[chain.length - 1].hash) throw new Error('header chain break');
        // native-PoW headers (regtest) are verified here; aux-pow (mainnet) PoW
        // verification (GetAuxiliaryHash) is a separate step — linkage only for now.
        if (!h.hasAux && !checkNativePoW(h)) throw new Error('header PoW invalid');
        chain.push(h);
      }
      if (hs.length === 0) break;
    }
    this.chain = chain;
    this.heightOf = {}; chain.forEach((h, i) => this.heightOf[h.hash] = i);
    return chain;
  }

  /** Fetch BIP158 filters for [1..tip] and return the block hashes matching `scripts`. */
  async matchFilters(scripts) {
    const tip = this.chain.length - 1;
    const matched = [], want = tip;
    let seen = 0;
    return new Promise(res => {
      this.on('cfilter', m => {
        const cf = parseCFilter(m.payload); seen++;
        if (filterMatchesAny(cf.filter, cf.blockHash, scripts)) matched.push(cf.blockHash);
        if (seen === want) res(matched);
      });
      this._send('getcfilters', buildGetCFilters(1, this.chain[tip].hash));
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
   * Full wallet sync: headers → filters → matched blocks → scan. Returns
   * { tipHeight, balance (kria), utxos, history } computed entirely client-side.
   */
  async syncWallet(scripts) {
    await this.syncHeaders();
    const matched = await this.matchFilters(scripts);
    const blocks = await this.fetchBlocks(matched);
    // order blocks by height, then scan
    blocks.sort((a, b) => this.heightOf[a.hash] - this.heightOf[b.hash]);
    const mine = new Set(scripts);
    const utxos = new Map(); const history = [];
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
    const tipHeight = this.chain.length - 1;
    let balance = 0n; for (const u of utxos.values()) balance += timeAdjustValue(u.value, tipHeight + 1 - u.refheight);
    return { tipHeight, balance, utxos: [...utxos.values()], history: history.reverse() };
  }

  /** Broadcast a signed raw tx over P2P (send `tx`). Returns the txid. */
  broadcast(rawHex) { this._send('tx', Buffer.from(rawHex, 'hex')); return null; }

  close() { try { this.ws.close(); } catch {} }
}
