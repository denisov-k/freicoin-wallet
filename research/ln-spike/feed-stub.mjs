// feed-stub.mjs — стендовый сервер BIP158-фида с ТЕМ ЖЕ контрактом, что у прод-реле
// (btcFeedStatus/btcFeedFilters/btcFeedBlock), но поверх регтест-узла стенда. Использует тот же
// buildFilter, что и реле, — то есть step9 тестирует настоящий продуктовый путь клиента.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { buildFilter } from '../../apps/web/src/services/light/net/bip158.mjs';

const PORT = Number(process.env.FEED_PORT ?? 3079);
const cli = (...a) => new Promise((res, rej) => execFile('/root/bitcoin-core/bin/bitcoin-cli',
  ['-regtest', '-datadir=/root/btc-regtest', '-rpcport=18443', ...a],
  { encoding: 'utf8', maxBuffer: 64e6 }, (e, out) => e ? rej(e) : res(out.trim())));

const cache = new Map();   // height → rec
async function recAt(h) {
  if (cache.has(h)) return cache.get(h);
  const hash = await cli('getblockhash', String(h));
  const blk = JSON.parse(await cli('getblock', hash, '3'));
  const hdr = await cli('getblockheader', hash, 'false');
  const scripts = [];
  for (const tx of blk.tx) {
    for (const o of tx.vout) { const s = o.scriptPubKey?.hex; if (s && !s.startsWith('6a')) scripts.push(s); }
    for (const vin of tx.vin) { const s = vin.prevout?.scriptPubKey?.hex; if (s) scripts.push(s); }
  }
  const rec = { h, hash, prev: blk.previousblockhash, hdr, f: buildFilter(hash, scripts).toString('hex') };
  cache.set(h, rec); return rec;
}

createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const call = req.url.replace(/^\/api\//, ''), args = body ? JSON.parse(body) : {};
  try {
    let out;
    if (call === 'btcFeedStatus') { const tip = Number(await cli('getblockcount')); out = { start: 0, tip, tipHash: await cli('getblockhash', String(tip)) }; }
    else if (call === 'btcFeedFilters') {
      const tip = Number(await cli('getblockcount'));
      const n = Math.min(Number(args.count) || 96, 288), out2 = [];
      for (let h = Number(args.from); h < Number(args.from) + n && h <= tip; h++) out2.push(await recAt(h));
      out = { filters: out2, tip };
    } else if (call === 'btcFeedBlock') out = { hex: await cli('getblock', args.hash, '0') };
    else throw new Error('unknown ' + call);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  } catch (e) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, () => console.log('feed-stub on', PORT));
