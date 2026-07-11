// playground-server.mjs — nV3 playground: a tiny HTTP server exposing the Freimarkets
// primitives (user assets with per-asset demurrage/interest, offers, miner-matching) over a
// JSON API + one static page, against a THROWAWAY regtest chain (-nv3assets). Demo actors
// (alice/bob/matcher) live server-side with fixed keys; the crypto is the wallet's own core
// (ecdsa/sighash/tx). Nothing here touches mainnet.
//
// Run: node research/nversion3/playground-server.mjs   (node must be up; see systemd units)
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY } from '../../core/sighash.mjs';
import { serializeTx, txid as computeTxid } from '../../core/tx.mjs';
import { assetPresentValue } from '../../core/assets.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/root/nv3-playground/chain';
const RPCPORT = Number(process.env.NV3_RPCPORT ?? 19660);
const LISTEN = Number(process.env.NV3_LISTEN ?? 5180);
const HOST_TAG = '00'.repeat(20);

const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const hash160 = b => ripemd160(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');

// ---- RPC ----
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

// ---- actors (fixed demo keys; MAST wpk: leaf = 0x21<pub>ac, program = RIPEMD160(HASH256(00||leaf))) ----
const mkKey = seed => {
  const sec = seed.repeat(32), pub = pubkeyCompressed(sec);
  const leaf = '21' + pub + 'ac';
  const prog = ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex');
  return { sec, pub, leaf, spk: '0014' + prog };
};
const ACTORS = { alice: mkKey('a1'), bob: mkKey('b2'), carol: mkKey('cb'), matcher: mkKey('c3') };
const TRUE_SCRIPT = '51', TRUE_REVEAL = '00' + TRUE_SCRIPT;
const TRUE_SPK = '0020' + hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_WITNESS = [TRUE_REVEAL, ''];

// ---- server state (playground bookkeeping; the CHAIN is the source of truth for validity) ----
const assets = new Map();   // tag -> {name, shift, interest, supply, issuedAt}
const utxos = new Map();    // outpoint 'txid:n' (display txid) -> {actor, assetTag, value, refheight}
const book = [];            // offers: {id, actor, give:{outpoint,assetTag,value,refheight}, want:{assetTag,value}, witness, lockHeight, status}
const log = [];             // event feed
let offerSeq = 1;
const say = m => { log.unshift({ t: Date.now(), m }); if (log.length > 60) log.pop(); };

const rate = tag => tag === HOST_TAG ? { k: 20, interest: false }
  : { k: assets.get(tag)?.shift ?? 20, interest: !!assets.get(tag)?.interest };
const pvOf = (u, h) => assetPresentValue(u.value, h - u.refheight, rate(u.assetTag));

let mineAddr = null;
async function mineBlocks(n = 1) { await rpc('generatetoaddress', n, mineAddr); }

async function fundActor(actor, amountFrc) {
  const k = ACTORS[actor];
  const dec = await rpc('decodescript', k.spk);
  const txid = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, amountFrc);
  const raw = await rpc('getrawtransaction', txid, true);
  const vout = raw.vout.findIndex(o => o.scriptPubKey.hex === k.spk);
  await mineBlocks(1);
  const u = { actor, assetTag: HOST_TAG, value: BigInt(Math.round(raw.vout[vout].value * 1e8)), refheight: raw.lockheight };
  utxos.set(`${txid}:${vout}`, u);
  return u;
}

function signInput(tx, inIdx, k, coinValue, refheight, hashtype) {
  const digest = segwitV0Sighash(tx, inIdx, k.leaf, coinValue, BigInt(refheight), hashtype);
  return [signEcdsa(k.sec, digest) + hashtype.toString(16).padStart(2, '0'), '00' + k.leaf, ''];
}

// ---- API actions ----
async function apiStatus() {
  const h = await rpc('getblockcount');
  const balances = {};
  for (const [op, u] of utxos) {
    (balances[u.actor] ??= []).push({ outpoint: op, asset: u.assetTag, nominal: String(u.value), pv: String(pvOf(u, h)) });
  }
  return {
    height: h,
    assets: [...assets.entries()].map(([tag, a]) => ({ tag, ...a, supply: String(a.supply) })),
    balances,
    book: book.map(o => ({ id: o.id, actor: o.actor, status: o.status,
      give: { asset: o.give.assetTag, nominal: String(o.give.value), pv: String(pvOf(o.give, h)) },
      want: { asset: o.want.assetTag, value: String(o.want.value) }, lockHeight: o.lockHeight })),
    log,
  };
}

async function apiIssue({ name, shift, interest, amount, to }) {
  shift = Math.min(64, Math.max(1, Number(shift) || 20));
  const amt = BigInt(amount);
  const who = ACTORS[to] ? to : 'alice';
  // canonical def: shift|flags|granularity(8LE)|contractHash(32) — the name lives in the
  // contract-hash field (hash of the name), so different names = different assets.
  const flags = interest ? 1 : 0;
  const def = Buffer.concat([Buffer.from([shift, flags]), Buffer.alloc(8), sha256(Buffer.from(String(name || 'asset')))]);
  def.writeUInt8(1, 2);   // granularity 1
  const tag = hash160(def).toString('hex');
  if (assets.has(tag)) throw new Error('такой актив уже выпущен');
  const fund = await (async () => {   // OP_TRUE leg pays the definition fee
    const dec = await rpc('decodescript', TRUE_SPK);
    const txid = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, '1.0');
    const raw = await rpc('getrawtransaction', txid, true);
    const vout = raw.vout.findIndex(o => o.scriptPubKey.hex === TRUE_SPK);
    await mineBlocks(1);
    return { txid, vout, value: BigInt(Math.round(raw.vout[vout].value * 1e8)), refheight: raw.lockheight };
  })();
  const opret = '6a' + (4 + def.length).toString(16).padStart(2, '0') + '46524131' + def.toString('hex');
  const tx = {
    version: 3, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: fund.refheight, nExpireTime: 0,
    vin: [{ prevout: { txid: rev(fund.txid), vout: fund.vout }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
    vout: [
      { value: amt, scriptPubKey: ACTORS[who].spk, assetTag: tag },
      { value: 0n, scriptPubKey: opret },
      { value: fund.value - 100000n, scriptPubKey: TRUE_SPK },
    ],
  };
  await rpc('generateblock', mineAddr, [serializeTx(tx)]);
  const id = computeTxid(tx);
  assets.set(tag, { name: String(name || 'asset'), shift, interest: !!interest, supply: amt, issuedAt: fund.refheight });
  utxos.set(`${id}:0`, { actor: who, assetTag: tag, value: amt, refheight: fund.refheight });
  say(`«${name}» выпущен: ${amount} единиц → ${who} (shift ${shift}${interest ? ', процентный' : ''})`);
  return { tag, txid: id };
}

async function apiOffer({ actor, giveOutpoint, wantAsset, wantValue }) {
  const k = ACTORS[actor]; if (!k) throw new Error('нет такого актора');
  const give = utxos.get(giveOutpoint);
  if (!give || give.actor !== actor) throw new Error('монета не найдена или не принадлежит актору');
  if (give.assetTag === wantAsset) throw new Error('оффер должен менять один актив на другой');
  const H = await rpc('getblockcount');
  const offer = {
    id: offerSeq++, actor, lockHeight: H, status: 'open',
    give: { outpoint: giveOutpoint, ...give },
    want: { assetTag: wantAsset, value: BigInt(wantValue) },
  };
  const input = { prevout: { txid: rev(giveOutpoint.split(':')[0]), vout: Number(giveOutpoint.split(':')[1]) }, scriptSig: '', sequence: 0xffffffff, witness: [] };
  const output = { value: offer.want.value, scriptPubKey: k.spk, assetTag: wantAsset };
  const skeleton = { version: 3, nLockTime: 0, lockHeight: H, nExpireTime: 0, vin: [input], vout: [output] };
  offer.input = input; offer.output = output;
  offer.witness = signInput(skeleton, 0, k, give.value, give.refheight, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY);
  book.push(offer);
  say(`${actor}: оффер #${offer.id} — отдаёт ${give.value} (${assets.get(give.assetTag)?.name ?? 'FRC'}), хочет ${wantValue} (${assets.get(wantAsset)?.name ?? 'FRC'})`);
  return { id: offer.id };
}

function crossOK(a, b, h) {
  if (a.give.assetTag !== b.want.assetTag || b.give.assetTag !== a.want.assetTag) return false;
  return pvOf(a.give, h) >= b.want.value && pvOf(b.give, h) >= a.want.value;
}

async function apiMatch({ i, j }) {
  const a = book.find(o => o.id === Number(i) && o.status === 'open');
  const b = book.find(o => o.id === Number(j) && o.status === 'open');
  if (!a || !b) throw new Error('оффер не найден или уже исполнен');
  const H = await rpc('getblockcount');
  if (a.lockHeight !== b.lockHeight) throw new Error(`офферы подписаны на разных высотах (${a.lockHeight} vs ${b.lockHeight}) — пересоздайте`);
  if (H !== a.lockHeight) throw new Error(`высота ушла (offer @${a.lockHeight}, chain @${H}) — пересоздайте офферы`);
  if (!crossOK(a, b, H)) throw new Error('офферы не пересекаются по цене');
  // matcher funds the fee with his freshest FRC coin
  const matCoinEntry = [...utxos.entries()].find(([, u]) => u.actor === 'matcher' && u.assetTag === HOST_TAG);
  if (!matCoinEntry) throw new Error('у матчера нет FRC');
  const [matOp, matCoin] = matCoinEntry;
  const fee = 10000n;
  const sA = pvOf(a.give, H) - b.want.value;   // surplus of asset A gives
  const sB = pvOf(b.give, H) - a.want.value;   // surplus of asset B gives
  const matPv = pvOf(matCoin, H);
  const vout = [a.output, b.output];
  const spread = [];
  for (const [tag, s] of [[a.give.assetTag, sA], [b.give.assetTag, sB]]) {
    if (tag !== HOST_TAG && s > 0n) { vout.push({ value: s, scriptPubKey: ACTORS.matcher.spk, assetTag: tag }); spread.push(`${s} ${assets.get(tag)?.name ?? tag.slice(0, 8)}`); }
  }
  const hostIn = matPv + (a.give.assetTag === HOST_TAG ? sA : 0n) + (b.give.assetTag === HOST_TAG ? sB : 0n);
  const change = hostIn - fee;
  if (change < 0n) throw new Error('матчеру не хватает на комиссию');
  if (change > 0n) { vout.push({ value: change, scriptPubKey: ACTORS.matcher.spk, assetTag: HOST_TAG }); spread.push(`${change - matPv} FRC-kria`); }
  const tx = {
    version: 3, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H, nExpireTime: 0,
    vin: [
      { ...a.input, witness: a.witness },
      { ...b.input, witness: b.witness },
      { prevout: { txid: rev(matOp.split(':')[0]), vout: Number(matOp.split(':')[1]) }, scriptSig: '', sequence: 0xffffffff, witness: [] },
    ],
    vout,
  };
  tx.vin[2].witness = signInput(tx, 2, ACTORS.matcher, matCoin.value, matCoin.refheight, SIGHASH_ALL);
  await rpc('generateblock', mineAddr, [serializeTx(tx)]);
  const id = computeTxid(tx);
  // settle bookkeeping
  utxos.delete(a.give.outpoint); utxos.delete(b.give.outpoint); utxos.delete(matOp);
  utxos.set(`${id}:0`, { actor: a.actor, assetTag: a.want.assetTag, value: a.want.value, refheight: H });
  utxos.set(`${id}:1`, { actor: b.actor, assetTag: b.want.assetTag, value: b.want.value, refheight: H });
  vout.slice(2).forEach((o, n) => utxos.set(`${id}:${n + 2}`, { actor: 'matcher', assetTag: o.assetTag, value: o.value, refheight: H }));
  a.status = b.status = 'filled';
  say(`МЭТЧ #${a.id}×#${b.id} в блоке: матчер заработал ${spread.join(' + ')} (комиссия ${fee})`);
  return { txid: id };
}

async function apiMine({ n }) { await mineBlocks(Math.min(50, Number(n) || 1)); say(`+${n || 1} блок(ов): всё демерреджное подплавилось`); return {}; }

// ---- bootstrap ----
async function bootstrap() {
  refreshCookie();
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  mineAddr = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) { await mineBlocks(120); say('цепь развёрнута (120 блоков)'); }
  for (const a of ['alice', 'bob', 'carol']) if (![...utxos.values()].some(u => u.actor === a)) await fundActor(a, '1.0');
  if (![...utxos.values()].some(u => u.actor === 'matcher')) await fundActor('matcher', '0.05');
  say('демо-акторы профинансированы: alice/bob/carol по 1 FRC, matcher 0.05 FRC');
}

// ---- HTTP ----
const here = dirname(fileURLToPath(import.meta.url));
const page = () => readFileSync(join(here, 'playground.html'));
const server = createServer(async (req, res) => {
  const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, page(), 'text/html');
    if (req.method === 'GET' && req.url === '/api/status') return send(200, await apiStatus());
    if (req.method === 'POST' && req.url?.startsWith('/api/')) {
      const body = await new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => ok(d ? JSON.parse(d) : {})); });
      if (req.url === '/api/issue') return send(200, await apiIssue(body));
      if (req.url === '/api/offer') return send(200, await apiOffer(body));
      if (req.url === '/api/match') return send(200, await apiMatch(body));
      if (req.url === '/api/mine') return send(200, await apiMine(body));
    }
    send(404, { error: 'not found' });
  } catch (e) { send(400, { error: e.message }); }
});
await bootstrap();
server.listen(LISTEN, '0.0.0.0', () => console.log(`nV3 playground on :${LISTEN}, chain ${DATADIR}`));
