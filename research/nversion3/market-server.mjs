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
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '../../core/sighash.mjs';
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

// house key (fee funding for the matcher) + OP_TRUE leg for issuances
const HOUSE = (() => {
  const sec = 'fa'.repeat(32), pub = pubkeyCompressed(sec);
  const leaf = '21' + pub + 'ac';
  return { sec, pub, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') };
})();
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
    // asset definitions (OP_RETURN 'FRA1' + def) -> registry
    for (const o of tx.vout) {
      const spk = o.scriptPubKey.hex;
      if (spk.startsWith('6a') && spk.includes('46524131')) {
        const defHex = spk.slice(spk.indexOf('46524131') + 8);
        const def = Buffer.from(defHex, 'hex');
        if (def.length >= 42) {
          const tag = hash160(def.subarray(0, def.length)).toString('hex');
          if (!assets.has(tag)) assets.set(tag, {
            shift: def[0], interest: (def[1] & 1) !== 0, granularity: 1,
            name: null, supply: 0n, issuedAt: tx.lockheight,
          });
        }
      }
    }
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

// ---- order book (user-signed SINGLE|ACP offers) ----
const book = [];   // {id, giveOutpoint, makerSpk, want:{assetTag|null, value}, lockHeight, sequence, witness, status, name?}
let offerSeq = 1;

function offersCross(a, b, h) {
  const ga = utxos.get(a.giveOutpoint), gb = utxos.get(b.giveOutpoint);
  if (!ga || !gb) return false;
  if ((ga.assetTag ?? null) !== (b.want.assetTag ?? null) || (gb.assetTag ?? null) !== (a.want.assetTag ?? null)) return false;
  if (a.lockHeight !== b.lockHeight) return false;
  return pvOf(ga, a.lockHeight) >= b.want.value && pvOf(gb, b.lockHeight) >= a.want.value;
}

async function tryMatch() {
  const h = await rpc('getblockcount');
  const open = book.filter(o => o.status === 'open' && utxos.has(o.giveOutpoint));
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const a = open[i], b = open[j];
    if (!offersCross(a, b, h)) continue;
    try { await splice(a, b); return true; } catch (e) { say(`мэтч #${a.id}×#${b.id} не прошёл: ${String(e.message).slice(0, 80)}`); }
  }
  return false;
}

async function splice(a, b) {
  const ga = utxos.get(a.giveOutpoint), gb = utxos.get(b.giveOutpoint);
  const L = a.lockHeight;
  const fee = 10000n;
  // house fee coin older than L
  const house = [...(spkIndex.get(HOUSE.spk) ?? [])].map(op => [op, utxos.get(op)])
    .find(([, u]) => u.assetTag === null && u.refheight <= L && pvOf(u, L) > fee + 1000n);
  if (!house) throw new Error('у дома нет монеты для комиссии старше высоты книги');
  const [hop, hcoin] = house;
  const sA = pvOf(ga, L) - b.want.value;   // surplus of what a gives
  const sB = pvOf(gb, L) - a.want.value;
  const vout = [
    { value: a.want.value, scriptPubKey: a.makerSpk, assetTag: a.want.assetTag ?? HOST_TAG },
    { value: b.want.value, scriptPubKey: b.makerSpk, assetTag: b.want.assetTag ?? HOST_TAG },
  ];
  let hostIn = pvOf(hcoin, L);
  for (const [tag, s] of [[ga.assetTag, sA], [gb.assetTag, sB]]) {
    if (tag === null) { hostIn += s; continue; }
    if (s > 0n) vout.push({ value: s, scriptPubKey: HOUSE.spk, assetTag: tag });
  }
  const change = hostIn - fee;
  if (change < 0n) throw new Error('дом не покрывает комиссию');
  if (change > 0n) vout.push({ value: change, scriptPubKey: HOUSE.spk, assetTag: HOST_TAG });
  const tx = {
    version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
    vin: [
      { prevout: { txid: rev(a.giveOutpoint.split(':')[0]), vout: +a.giveOutpoint.split(':')[1] }, scriptSig: '', sequence: a.sequence ?? 0xffffffff, witness: a.witness },
      { prevout: { txid: rev(b.giveOutpoint.split(':')[0]), vout: +b.giveOutpoint.split(':')[1] }, scriptSig: '', sequence: b.sequence ?? 0xffffffff, witness: b.witness },
      { prevout: { txid: rev(hop.split(':')[0]), vout: +hop.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] },
    ],
    vout,
  };
  const d = segwitV0Sighash(tx, 2, HOUSE.leaf, hcoin.value, BigInt(hcoin.refheight), SIGHASH_ALL);
  tx.vin[2].witness = [signEcdsa(HOUSE.sec, d) + '01', '00' + HOUSE.leaf, ''];
  await rpc('generateblock', mineAddr, [serializeTx(tx)]);
  await catchUp();
  a.status = b.status = 'filled';
  say(`сделка: оффер #${a.id} × #${b.id} исполнены (${computeTxid(tx).slice(0, 12)}…)`);
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
  // ensure the house has fee money
  const houseFrc = [...(spkIndex.get(HOUSE.spk) ?? [])].length;
  if (houseFrc < 3) {
    const dec = await rpc('decodescript', HOUSE.spk);
    for (let i = 0; i < 3; i++) await rpc('sendtoaddress', dec.address, '0.05');
    await rpc('generatetoaddress', 1, mineAddr);
    await catchUp();
  }
  say('маркет запущен');
  setInterval(async () => {
    try {
      await rpc('generatetoaddress', 1, mineAddr);
      await catchUp();
      await tryMatch();
    } catch (e) { say('фоновый цикл: ' + String(e.message).slice(0, 80)); }
  }, MINE_EVERY_MS);
}

// ---- API ----
const api = {
  async info() {
    const h = await rpc('getblockcount');
    return {
      height: h, mineEveryMs: MINE_EVERY_MS,
      assets: [...assets.entries()].map(([tag, a]) => ({ tag, ...a, supply: String(a.supply) })),
      book: book.slice(-50).map(o => {
        const g = utxos.get(o.giveOutpoint);
        return { id: o.id, status: o.status, makerSpk: o.makerSpk, lockHeight: o.lockHeight,
          give: g ? { assetTag: g.assetTag, pv: String(pvOf(g, h)) } : null,
          want: { assetTag: o.want.assetTag, value: String(o.want.value) } };
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
    const def = Buffer.concat([Buffer.from([shift, interest ? 1 : 0]), Buffer.alloc(8), sha256(Buffer.from(String(name ?? 'asset')))]);
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
    await rpc('generateblock', mineAddr, [serializeTx(tx)]);
    await catchUp();
    assets.get(tag).name = String(name ?? 'asset');
    say(`выпуск: «${name}» ×${amount} (shift ${shift}${interest ? ', растёт' : ''})`);
    return { tag, txid: computeTxid(tx) };
  },
  async tx({ rawtx }) {
    const parsed = parseTx(rawtx);            // sanity: it parses
    await rpc('generateblock', mineAddr, [rawtx]);
    await catchUp();
    say(`транзакция пользователя замайнена (${computeTxid(parsed).slice(0, 12)}…)`);
    return { txid: computeTxid(parsed) };
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
    say(`новый оффер #${o.id}`);
    setTimeout(() => tryMatch().catch(() => {}), 100);
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
