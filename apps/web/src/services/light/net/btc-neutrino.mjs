// btc-neutrino.mjs — компактный BIP157/158 клиент для BITCOIN-цепи (чейн-фид LN-узла).
// Переиспользует ВСЕ проводные примитивы из p2p.mjs (они chain-agnostic, диалект задаёт MAGIC);
// новое здесь только цикл: handshake → getheaders → getcfilters → BIP158-матч по watch-set →
// getdata совпавших блоков → сплит нашим btc-block.mjs → скормить LDK-адаптеру.
// Никакой Freicoin-специфики (aux-pow, демерредж, активы) — обычные 80-байтные BTC-заголовки.
import { encodeMessage, createDecoder, buildVersion, parseVersion, buildGetHeaders, parseHeaders,
         buildGetCFilters, parseCFilter, buildGetData, parseInv, MSG_WITNESS_BLOCK } from './p2p.mjs';
import { filterMatchesAny } from './bip158.mjs';
import { parseBtcBlock } from './btc-block.mjs';

const revHex = h => Buffer.from(h, 'hex').reverse().toString('hex');

export class BtcNeutrino {
  /** @param {{url:string, net:'btcmain'|'btcregtest'|'btcsignet', adapter:import('./ldk-chain.mjs').LdkChainAdapter}} o */
  constructor({ url, net, adapter }) {
    this.url = url; this.net = net; this.adapter = adapter;
    this.headers = [];        // [{hash, prevHash, height, raw(80)}]
    this.byHash = new Map();
    this.scannedIdx = -1;     // highest headers[] INDEX already fed to LDK (index, not height)
    this.ws = null; this._ready = false; this._waiters = new Map();
    // LDK's Filter registrations grow the watch-set; a fresh script re-scans from the funding
    // height so a channel opened after the last scan is still seen.
    adapter.onWatch = () => { this._rescanFrom = 0; };
    this._rescanFrom = null;
  }
  _send(cmd, payload) { this.ws.send(encodeMessage(this.net, cmd, payload)); }
  _once(cmd) { return new Promise(res => { (this._waiters.get(cmd) ?? this._waiters.set(cmd, []).get(cmd)).push(res); }); }
  // Core stays SILENT on getheaders/getcfilters when it has nothing after the locator (a tip
  // request, an already-served filter) — so any wait for a reply must be able to give up. null on
  // timeout means "nothing more", not an error.
  _onceOrNull(cmd, ms = 4000) {
    return new Promise(res => {
      let done = false;
      const arr = this._waiters.get(cmd) ?? this._waiters.set(cmd, []).get(cmd);
      const fn = m => { if (!done) { done = true; clearTimeout(t); res(m); } };
      arr.push(fn);
      const t = setTimeout(() => { if (!done) { done = true; const w = this._waiters.get(cmd); const i = w?.indexOf(fn); if (i >= 0) w.splice(i, 1); res(null); } }, ms);
    });
  }
  _emit(cmd, m) { const w = this._waiters.get(cmd); if (w && w.length) { this._waiters.set(cmd, []); w.forEach(f => f(m)); } }

  async connect() {
    const dec = createDecoder(this.net);
    this.ws = new WebSocket(this.url); this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = ev => { for (const m of dec(Buffer.from(ev.data))) this._onMsg(m); };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('btc ws failed')); });
    this._send('version', buildVersion({ ua: '/fw-ln:0.1/' }));
    await this._once('verack');
    this._ready = true;
  }
  _onMsg(m) {
    if (m.command === 'version') { this._send('verack'); this._emit('version', m); }
    else if (m.command === 'verack') this._emit('verack', m);
    else if (m.command === 'ping') this._send('pong', m.payload);
    else if (m.command === 'headers') this._emit('headers', m);
    else if (m.command === 'cfilter') this._emit('cfilter', m);
    else if (m.command === 'block') this._emit('block', m);
    else if (m.command === 'inv') {   // new tip — pull it
      if (parseInv(m.payload).some(i => i.type === 2 /* MSG_BLOCK */)) this._pull?.();
    }
  }

  /** Seed the sync anchor so we don't pull ancient history: bitcoind returns only headers AFTER
   *  this hash, and the first new header gets height base+1. */
  seedAnchor(hashHex, height) { this._anchorHash = hashHex; this._startHeight = height; }

  /** Fetch headers forward from our tip until caught up. */
  async syncHeaders() {
    for (;;) {
      const tip = this.headers.length ? this.headers[this.headers.length - 1].hash : (this._anchorHash ?? '00'.repeat(32));
      this._send('getheaders', buildGetHeaders(70016, [tip]));   // buildGetHeaders wants an ARRAY of locator hashes
      const m = await this._onceOrNull('headers');
      if (!m) break;                                       // silence = caught up (Core sends nothing at tip)
      const hs = parseHeaders(m.payload);
      if (!hs.length) break;
      for (const h of hs) {
        if (this.byHash.has(h.hash)) continue;
        const height = this.headers.length ? this.headers[this.headers.length - 1].height + 1 : ((this._startHeight ?? -1) + 1);
        const rec = { hash: h.hash, prevHash: h.prevHash, height, raw: h.raw.subarray(0, 80) };
        this.headers.push(rec); this.byHash.set(h.hash, rec);
      }
      if (hs.length < 2000) break;
    }
  }

  /** Scan headers[fromIdx..end]: one cfilter per block, match against the LDK watch-set,
   *  download+split matched blocks, feed the adapter. `fromIdx`/`scannedIdx` are ARRAY INDICES
   *  into headers[], NOT heights (the two diverge — headers[0] is anchor+1). */
  async scan(fromIdx) {
    const scriptsHex = [...this.adapter.watchedSpks];
    if (this.debug) console.log(`  [scan] idx ${fromIdx}..${this.headers.length - 1}, scripts ${scriptsHex.length}`);
    for (let i = Math.max(0, fromIdx); i < this.headers.length; i++) {
      const hdr = this.headers[i];
      this.scannedIdx = i;
      this._send('getcfilters', buildGetCFilters(hdr.height, hdr.hash));
      const cfm = await this._onceOrNull('cfilter');
      if (!cfm) { this.adapter.tipAdvanced(hdr.raw, hdr.height); continue; }
      const cf = parseCFilter(cfm.payload);
      const hit = scriptsHex.length && filterMatchesAny(cf.filter, cf.blockHash, scriptsHex);
      if (this.debug) console.log(`  [scan] h${hdr.height} filter ${cf.filter.length}b hit=${hit}`);
      if (!hit) { this.adapter.tipAdvanced(hdr.raw, hdr.height); continue; }
      this._send('getdata', buildGetData([{ type: MSG_WITNESS_BLOCK, hashHex: hdr.hash }]));
      const bm = await this._onceOrNull('block', 8000);
      if (!bm) { this.adapter.tipAdvanced(hdr.raw, hdr.height); continue; }   // no block served — advance, retry next tick
      const { txs } = await parseBtcBlock(new Uint8Array(Buffer.from(bm.payload)));
      const relevant = txs.filter(t => this.adapter.isRelevant({ txid: t.txid, outs: t.outs }))
        .map(t => ({ index: t.index, raw: Buffer.from(t.raw) }));
      if (this.debug) console.log(`  [neutrino] block ${hdr.height} matched, relevant tx ${relevant.length}`);
      this.adapter.blockConnected(hdr.raw, hdr.height, relevant);
    }
  }

  /** One sync pass: headers forward, then scan the new (or, after a watch-set widening, the whole)
   *  range. `scannedIdx` is the last headers[] index fed; a rescan resets it to -1 so the next scan
   *  re-covers everything (Confirm feeds are idempotent — LDK dedups re-confirmations). */
  async tick() {
    await this.syncHeaders();
    if (this._rescanFrom != null) { this.scannedIdx = -1; this._rescanFrom = null; }
    const fromIdx = this.scannedIdx + 1;
    if (fromIdx < this.headers.length) await this.scan(fromIdx);
  }
  /** Start scanning from a known height (skip ancient history — a channel's funding is recent). */
  set startHeight(h) { this._startHeight = h; }
}
