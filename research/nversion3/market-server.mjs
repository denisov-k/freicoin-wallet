// market-server.mjs — the Freimarkets MARKET backend for real (non-custodial) users.
// The browser holds the keys (the wallet's own vault); this server only:
//   - runs the experimental chain (-nv3assets) and mines a block every N seconds,
//   - indexes the chain (spk -> utxos with asset tags; OP_RETURN defs -> asset registry),
//   - hands out faucet FRC, funds+mines asset issuances (OP_TRUE leg, mint to the user),
//   - relays user-signed transactions into blocks,
//   - keeps the shared ORDER BOOK of user-signed SIGHASH_SINGLE|ANYONECANPAY offers and
//     auto-matches crosses, taking the fee from its own wallet (spread stays with makers'
//     pricing; the house takes only what the offers leave).
// It can steal nothing: every asset movement carries a user signature the chain verifies.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serializeTx, parseTx, txid as computeTxid, NV3_TX_VERSION } from '../../core/tx.mjs';
import { assetPresentValue } from '../../core/assets.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/root/nv3-playground/chain';
const RPCPORT = Number(process.env.NV3_RPCPORT ?? 19660);
const LISTEN = Number(process.env.NV3_LISTEN ?? 5181);
const MINE_EVERY_MS = Number(process.env.NV3_MINE_MS ?? 20000);
const HOST_TAG = '00'.repeat(20);

const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const hash160 = b => ripemd160(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');

let cookie = '';
const refreshCookie = () => { cookie = Buffer.from(readFileSync(`${DATADIR}/regtest/.cookie`)).toString('base64'); };
async function rpc(method, ...params) {
  const call = async () => {
    const res = await fetch(`http://127.0.0.1:${RPCPORT}/wallet/w`, {
      method: 'POST', headers: { Authorization: `Basic ${cookie}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 401) throw new Error('401');
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  };
  try { return await call(); } catch (e) {
    if (String(e.message) === '401') { refreshCookie(); return await call(); }
    throw e;
  }
}

// OP_TRUE leg for issuance funding (chain-admin convenience, holds no user value)
const TRUE_SCRIPT = '51', TRUE_REVEAL = '00' + TRUE_SCRIPT;
const TRUE_SPK = '0020' + hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_WITNESS = [TRUE_REVEAL, ''];

// ---- chain index (rebuilt from block 0 at startup, then follows the tip) ----
const utxos = new Map();     // 'txid:n' -> {spk, assetTag(null=host), value(bigint), refheight}
const assets = new Map();    // tag -> {name?, shift, interest, granularity, supply, issuedAt}
const spkIndex = new Map();  // spk -> Set(outpoint)
let indexedHeight = -1;
const events = [];           // rolling feed
const say = m => { events.unshift({ t: Date.now(), m }); if (events.length > 100) events.pop(); };

const addU = (op, u) => { utxos.set(op, u); (spkIndex.get(u.spk) ?? spkIndex.set(u.spk, new Set()).get(u.spk)).add(op); };
const delU = op => { const u = utxos.get(op); if (u) { utxos.delete(op); spkIndex.get(u.spk)?.delete(op); } };

async function indexBlock(h) {
  const hash = await rpc('getblockhash', h);
  const blk = await rpc('getblock', hash, 2);
  for (const tx of blk.tx) {
    for (const vin of tx.vin) if (vin.txid) delU(`${vin.txid}:${vin.vout}`);
    // asset definitions (OP_RETURN 'FRA1' + def) -> registry, plus a companion 'FRAN' name
    // OP_RETURN in the same tx (consensus ignores it; re-read here so names survive restarts).
    let definedTag = null, declaredName = null;
    for (const o of tx.vout) {
      const spk = o.scriptPubKey.hex;
      if (spk.startsWith('6a') && spk.includes('46524131')) {
        const defHex = spk.slice(spk.indexOf('46524131') + 8);
        const def = Buffer.from(defHex, 'hex');
        if (def.length >= 42) {
          const tag = hash160(def.subarray(0, def.length)).toString('hex');
          definedTag = tag;
          if (!assets.has(tag)) assets.set(tag, {
            shift: def[0], interest: (def[1] & 1) !== 0, granularity: 1,
            name: null, supply: 0n, issuedAt: tx.lockheight,
          });
        }
      } else if (spk.startsWith('6a') && spk.includes('4652414e')) {
        try { declaredName = Buffer.from(spk.slice(spk.indexOf('4652414e') + 8), 'hex').toString('utf8').replace(/[<>&"'\x00-\x1f\x7f]/g, '').slice(0, 32).trim(); } catch { /* not a name */ }
      }
    }
    if (definedTag && declaredName && assets.has(definedTag)) assets.get(definedTag).name = declaredName;
    tx.vout.forEach((o, n) => {
      if (o.scriptPubKey.hex.startsWith('6a')) return;   // OP_RETURN: unspendable
      const tag = o.assetTag ? rev(o.assetTag) : null;   // RPC shows uint160 hex reversed
      const u = { spk: o.scriptPubKey.hex, assetTag: tag, value: BigInt(Math.round(o.value * 1e8)), refheight: tx.lockheight };
      addU(`${tx.txid}:${n}`, u);
      if (tag && assets.has(tag) && h === (assets.get(tag).issuedAt ?? h)) assets.get(tag).supply += u.value;
    });
  }
  indexedHeight = h;
}
async function catchUp() {
  const tip = await rpc('getblockcount');
  while (indexedHeight < tip) await indexBlock(indexedHeight + 1);
}

const rateOf = tag => tag === null ? { k: 20, interest: false }
  : { k: assets.get(tag)?.shift ?? 20, interest: !!assets.get(tag)?.interest };
const pvOf = (u, h) => assetPresentValue(u.value, h - u.refheight, rateOf(u.assetTag));

// ---- order book: a PURE RELAY of user-signed SINGLE|ACP offers ----
// The server never matches. It stores offers (with the maker's partial signature — public by
// design; that signature only completes against a crossing counter-offer) and lists them.
// ANY client splices two crossing offers with its OWN fee coin, keeps the spread, and
// broadcasts the composite via /api/tx — permissionless matching, no privileged house.
// phase-1: {id, giveOutpoint, makerSpk, want, lockHeight, sequence, witness, status}
// phase-2b ranged: {id, ranged:true, makerSpk, giveOutpoint, desc, nExpireTime, lockHeight,
//   witness, needsResign, status} — a signed CONSTRAINT (price ratio + fill bounds) whose give
//   coin partially fills. Each fill spends the give coin and returns a smaller change coin, which
//   the maker's client re-signs (resignRanged) to keep the remainder tradeable.
const book = [];
let offerSeq = 1;

// Mark an offer done once its give coin leaves the UTXO set. A ranged fill re-points the offer
// at its change coin FIRST (in the tx handler, before this runs), so a ranged offer only trips
// this if its coin was spent by something else (another offer, a manual spend) — it is then
// orphaned and unfillable, so retire it instead of leaving a dead "open" row.
function reconcileBook() {
  for (const o of book) if (o.status === 'open' && !utxos.has(o.giveOutpoint)) o.status = 'filled';
}

// ---- lifecycle ----
let mineAddr = null;
async function bootstrap() {
  refreshCookie();
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  mineAddr = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mineAddr);
  await catchUp();
  say('маркет запущен (релей книги + майнер, без матчинга)');
  // the miner role only: produce a block on a timer so the chain lives. No matching here.
  setInterval(async () => {
    try {
      await rpc('generatetoaddress', 1, mineAddr);
      await catchUp();
      reconcileBook();
    } catch (e) { say('майнер: ' + String(e.message).slice(0, 80)); }
  }, MINE_EVERY_MS);
}

// ---- API ----
const api = {
  async info() {
    const h = await rpc('getblockcount');
    return {
      height: h, mineEveryMs: MINE_EVERY_MS,
      assets: [...assets.entries()].map(([tag, a]) => ({ tag, ...a, supply: String(a.supply) })),
      // the book exposes EVERYTHING a client needs to splice a cross itself: the give
      // outpoint, the maker's partial witness, terms. The witness is a SINGLE|ACP signature —
      // public by design, it binds only "my coin ↔ this exact output" and does nothing until
      // a crossing counter-offer completes the balance.
      book: book.slice(-80).map(o => {
        const g = utxos.get(o.giveOutpoint);
        const give = g ? { assetTag: g.assetTag, value: String(g.value), refheight: g.refheight, pv: String(pvOf(g, h)) } : null;
        const base = { id: o.id, status: o.status, makerSpk: o.makerSpk, lockHeight: o.lockHeight, giveOutpoint: o.giveOutpoint, witness: o.witness, give };
        return o.ranged
          ? { ...base, ranged: true, desc: o.desc, nExpireTime: o.nExpireTime, needsResign: !!o.needsResign }
          : { ...base, sequence: o.sequence, want: { assetTag: o.want.assetTag, value: String(o.want.value) } };
      }),
      events: events.slice(0, 30),
    };
  },
  async utxos({ spks }) {
    const h = await rpc('getblockcount');
    const out = [];
    for (const spk of spks ?? []) for (const op of spkIndex.get(spk) ?? []) {
      const u = utxos.get(op);
      out.push({ outpoint: op, spk, assetTag: u.assetTag, value: String(u.value), refheight: u.refheight, pv: String(pvOf(u, h)) });
    }
    return { height: h, utxos: out };
  },
  async faucet({ address }) {
    const txid = await rpc('sendtoaddress', address, '1.0');
    await rpc('generatetoaddress', 1, mineAddr);
    await catchUp();
    say(`кран: 1 FRC → ${address.slice(0, 16)}…`);
    return { txid };
  },
  async issue({ name, shift, interest, amount, spk }) {
    shift = Math.min(64, Math.max(1, Number(shift) || 16));
    const amt = BigInt(amount);
    if (amt <= 0n || amt > 9007199254740991n) throw new Error('bad amount');
    if (!/^[0-9a-f]{4,140}$/.test(spk)) throw new Error('bad spk');
    // the human name, sanitized once and used everywhere: its sha256 goes in the def (so the tag
    // commits it) AND the raw string goes in a companion 'FRAN' OP_RETURN (so indexers recover it).
    const nm = String(name ?? 'asset').replace(/[<>&"'\x00-\x1f\x7f]/g, '').slice(0, 32).trim() || 'asset';
    const def = Buffer.concat([Buffer.from([shift, interest ? 1 : 0]), Buffer.alloc(8), sha256(Buffer.from(nm, 'utf8'))]);
    def.writeUInt8(1, 2);
    const tag = hash160(def).toString('hex');
    if (assets.has(tag)) throw new Error('актив с таким именем и параметрами уже существует');
    const dec = await rpc('decodescript', TRUE_SPK);
    const ftx = await rpc('sendtoaddress', dec.address, '0.01');
    const raw = await rpc('getrawtransaction', ftx, true);
    const v = raw.vout.findIndex(o => o.scriptPubKey.hex === TRUE_SPK);
    await rpc('generatetoaddress', 1, mineAddr);
    const fval = BigInt(Math.round(raw.vout[v].value * 1e8));
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: raw.lockheight, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(ftx), vout: v }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
      vout: [
        { value: amt, scriptPubKey: spk, assetTag: tag },
        { value: 0n, scriptPubKey: '6a' + (4 + def.length).toString(16).padStart(2, '0') + '46524131' + def.toString('hex') },
        { value: fval - 100000n, scriptPubKey: TRUE_SPK },
      ],
    };
    // companion 'FRAN' name OP_RETURN (consensus ignores it; indexers read it from-chain). Its
    // sha256 is committed in the def above, so a reader can verify the name against the tag.
    const nmeta = Buffer.from(nm, 'utf8');
    tx.vout.push({ value: 0n, scriptPubKey: '6a' + (4 + nmeta.length).toString(16).padStart(2, '0') + '4652414e' + nmeta.toString('hex') });
    await rpc('generateblock', mineAddr, [serializeTx(tx)]);
    await catchUp();
    assets.get(tag).name = nm;
    say(`выпуск: «${nm}» ×${amount} (shift ${shift}${interest ? ', растёт' : ''})`);
    return { tag, txid: computeTxid(tx) };
  },
  async tx({ rawtx, kind, offerId }) {
    const parsed = parseTx(rawtx);            // sanity: it parses
    await rpc('generateblock', mineAddr, [rawtx]);
    await catchUp();
    const txid = computeTxid(parsed);
    // a ranged partial fill: re-point the offer at its change coin (the ranged bundle's 2nd
    // output) FIRST, so reconcileBook below sees the live change coin and doesn't retire it. The
    // change coin needs a fresh maker signature to stay tradeable; exhausted (< minFill) ⇒ done.
    if (kind === 'rangedfill' && offerId != null) {
      const o = book.find(x => x.id === Number(offerId) && x.ranged);
      if (o) {
        const h = await rpc('getblockcount');
        const changeOp = `${txid}:1`;
        const c = utxos.get(changeOp);
        if (c && c.spk === o.desc.changeScript && pvOf(c, h) >= BigInt(o.desc.minFill)) {
          o.giveOutpoint = changeOp; o.witness = null; o.needsResign = true; o.status = 'open';
        } else { o.status = 'filled'; }
      }
    }
    reconcileBook();                          // retire any offer whose give coin this tx consumed
    say(kind === 'match' ? `сделка сведена участником (${txid.slice(0, 12)}…)`
      : kind === 'rangedfill' ? `частичный филл ranged-оффера #${offerId} (${txid.slice(0, 12)}…)`
      : `транзакция пользователя замайнена (${txid.slice(0, 12)}…)`);
    return { txid };
  },
  async offer({ giveOutpoint, makerSpk, want, lockHeight, sequence, witness }) {
    const g = utxos.get(giveOutpoint);
    if (!g) throw new Error('монета не найдена/уже потрачена');
    if (g.spk !== makerSpk) throw new Error('монета не принадлежит этому ключу');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    const o = { id: offerSeq++, giveOutpoint, makerSpk, lockHeight: Number(lockHeight),
      sequence: Number(sequence ?? 0xffffffff),
      want: { assetTag: want.assetTag ?? null, value: BigInt(want.value) }, witness, status: 'open' };
    book.push(o);
    say(`новый оффер #${o.id} (ждёт, пока любой участник сведёт)`);
    return { id: o.id };
  },
  // phase-2b: a ranged (partial-fill) offer. The maker signs a descriptor (price ratio + fill
  // bounds) over ONE give coin; the server only relays it, exactly like phase-1 offers.
  async rangedOffer({ makerSpk, giveOutpoint, desc, nExpireTime, lockHeight, witness }) {
    const g = utxos.get(giveOutpoint);
    if (!g) throw new Error('монета не найдена/уже потрачена');
    if (g.spk !== makerSpk) throw new Error('монета не принадлежит этому ключу');
    if (!desc || desc.payoutScript == null || desc.changeScript == null) throw new Error('плохой дескриптор');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    const o = { id: offerSeq++, ranged: true, makerSpk, giveOutpoint,
      desc: { payoutAsset: desc.payoutAsset ?? '00'.repeat(20), payoutScript: desc.payoutScript,
        priceNum: String(desc.priceNum), priceDen: String(desc.priceDen), changeScript: desc.changeScript,
        minFill: String(desc.minFill), maxFill: String(desc.maxFill) },
      nExpireTime: Number(nExpireTime ?? 0), lockHeight: Number(lockHeight), witness, needsResign: false, status: 'open' };
    book.push(o);
    say(`новый ranged-оффер #${o.id} (частичные филлы)`);
    return { id: o.id };
  },
  // the maker's client re-signs its change coin after a partial fill (only it holds the key).
  async resignRanged({ id, giveOutpoint, lockHeight, witness }) {
    const o = book.find(x => x.id === Number(id) && x.ranged);
    if (!o) throw new Error('нет такого ranged-оффера');
    if (giveOutpoint && giveOutpoint !== o.giveOutpoint) throw new Error('оффер указывает на другую монету');
    const g = utxos.get(o.giveOutpoint);
    if (!g || g.spk !== o.makerSpk) throw new Error('монета остатка недоступна');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    o.witness = witness; o.lockHeight = Number(lockHeight); o.needsResign = false; o.status = 'open';
    return { id: o.id };
  },
  async cancel({ id, makerSpk }) {
    const o = book.find(x => x.id === Number(id) && x.status === 'open');
    if (!o || o.makerSpk !== makerSpk) throw new Error('нет такого открытого оффера');
    o.status = 'cancelled';   // NB: true cancel = spend the coin; this only delists locally
    return {};
  },
  async name({ tag }) { return { name: assets.get(tag)?.name ?? null }; },
};

const server = createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    const m = /^\/api\/(\w+)$/.exec(req.url ?? '');
    if (!m || !(m[1] in api)) { res.writeHead(404, cors); return res.end('{"error":"not found"}'); }
    let body = {};
    if (req.method === 'POST') body = await new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => ok(d ? JSON.parse(d) : {})); });
    const out = await api[m[1]](body);
    res.writeHead(200, cors);
    res.end(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? String(v) : v));
  } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: e.message })); }
});
await bootstrap();
server.listen(LISTEN, '0.0.0.0', () => console.log(`market server on :${LISTEN}, chain ${DATADIR}, indexed to ${indexedHeight}`));
