// server.mjs — a minimal Freicoin block explorer over freicoind RPC (txindex required
// for /tx lookups). Dependency-free, server-rendered, mounted under a path prefix
// (default /explorer, e.g. behind nginx). Amounts from scantxoutset are present values;
// block/tx outputs are nominal (kria face value) — labeled accordingly.
//   env: FW_RPC_PORT (18951), FW_RPC_COOKIE (/root/fw-mainnet-filter/.cookie),
//        FW_EXPLORER_PORT (3060), FW_PREFIX (/explorer)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const RPC_PORT = process.env.FW_RPC_PORT || '18951';
const COOKIE = process.env.FW_RPC_COOKIE || '/root/fw-mainnet-filter/.cookie';
const PORT = parseInt(process.env.FW_EXPLORER_PORT || '3060', 10);
const PREFIX = process.env.FW_PREFIX ?? '/explorer';

async function rpc(method, params = []) {
  const auth = Buffer.from(readFileSync(COOKIE, 'utf8').trim()).toString('base64');
  const r = await fetch(`http://127.0.0.1:${RPC_PORT}/`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = t => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const L = (path, text) => `<a href="${PREFIX}${path}">${esc(text)}</a>`;

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Freicoin Explorer</title><style>
:root{--bg:#0f1115;--card:#181b22;--fg:#e8eaed;--sub:#9aa0aa;--acc:#3ea6ff;--line:#262a33}
body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg)}
.wrap{max-width:960px;margin:0 auto;padding:16px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:18px}h1 a{color:var(--fg)}h2{font-size:15px;color:var(--sub)}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden}
td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;word-break:break-all}
th{color:var(--sub);font-weight:normal}
.k{color:var(--sub);white-space:nowrap;width:160px}
form{display:flex;gap:8px;margin:12px 0}
input{flex:1;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px;color:var(--fg);font:inherit}
button{background:var(--acc);color:#04121f;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
.sub{color:var(--sub)}.r{text-align:right}.mono{font-family:inherit}
</style></head><body><div class="wrap">
<h1>${L('/', '⛓ Freicoin Explorer')} <span class="sub" style="font-size:12px">mainnet · powered by <a href="https://wallet.testtty.ru">wallet.testtty.ru</a></span></h1>
<form action="${PREFIX}/search"><input name="q" placeholder="height / block hash / txid / address"><button>Search</button></form>
${body}</div></body></html>`;

const kv = rows => `<table>${rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`;

async function home() {
  const [bc, mp, net] = await Promise.all([rpc('getblockchaininfo'), rpc('getmempoolinfo'), rpc('getnetworkinfo')]);
  const tip = bc.blocks;
  const heights = Array.from({ length: 15 }, (_, i) => tip - i);
  const blocks = await Promise.all(heights.map(async h => rpc('getblock', [await rpc('getblockhash', [h]), 1])));
  return page('Freicoin Explorer',
    kv([
      ['height', `${tip}`],
      ['best block', L('/block/' + bc.bestblockhash, bc.bestblockhash)],
      ['mempool', `${mp.size} tx`],
      ['connections', `${net.connections}`],
      ['node', esc(net.subversion)],
    ]) +
    `<h2>latest blocks</h2><table><tr><th>height</th><th>time</th><th class="r">txs</th><th class="r">size</th></tr>` +
    blocks.map(b => `<tr><td>${L('/block/' + b.hash, b.height)}</td><td class="sub">${fmtT(b.time)}</td><td class="r">${b.nTx}</td><td class="r">${(b.size / 1024).toFixed(1)} kB</td></tr>`).join('') + '</table>');
}

async function blockPage(id) {
  const hash = /^\d+$/.test(id) ? await rpc('getblockhash', [parseInt(id, 10)]) : id;
  const b = await rpc('getblock', [hash, 2]);
  return page('Block ' + b.height,
    kv([
      ['height', `${b.height}`],
      ['hash', esc(b.hash)],
      ['time', fmtT(b.time)],
      ['confirmations', `${b.confirmations}`],
      ['size / weight', `${b.size} B / ${b.weight} WU`],
      ['prev', b.previousblockhash ? L('/block/' + b.previousblockhash, b.previousblockhash) : '—'],
      ['next', b.nextblockhash ? L('/block/' + b.nextblockhash, b.nextblockhash) : '—'],
    ]) +
    `<h2>${b.nTx} transaction(s)</h2><table><tr><th>txid</th><th class="r">in</th><th class="r">out</th><th class="r">value out (nominal)</th></tr>` +
    b.tx.map((t, i) => {
      const out = t.vout.reduce((a, o) => a + o.value, 0);
      const tag = i === 0 ? ' <span class="sub">coinbase</span>' : (i === b.tx.length - 1 && b.tx.length > 1 && t.vin[0]?.coinbase === undefined && t.vout.length === 1 ? '' : '');
      return `<tr><td>${L('/tx/' + t.txid, t.txid)}${tag}</td><td class="r">${t.vin.length}</td><td class="r">${t.vout.length}</td><td class="r">${out.toFixed(8)}</td></tr>`;
    }).join('') + '</table>');
}

async function txPage(txid) {
  const t = await rpc('getrawtransaction', [txid, 2]);
  const vin = t.vin.map(v => v.coinbase !== undefined
    ? `<tr><td class="sub">coinbase</td><td></td><td class="r"></td></tr>`
    : `<tr><td>${L('/tx/' + v.txid, v.txid)}:${v.vout}</td><td>${v.prevout?.scriptPubKey?.address ? L('/address/' + v.prevout.scriptPubKey.address, v.prevout.scriptPubKey.address) : '<span class="sub">—</span>'}</td><td class="r">${v.prevout ? v.prevout.value.toFixed(8) : ''}</td></tr>`).join('');
  const vout = t.vout.map(o =>
    `<tr><td>#${o.n}</td><td>${o.scriptPubKey.address ? L('/address/' + o.scriptPubKey.address, o.scriptPubKey.address) : '<span class="sub">' + esc(o.scriptPubKey.type) + '</span>'}</td><td class="r">${o.value.toFixed(8)}</td></tr>`).join('');
  return page('Tx ' + txid.slice(0, 12),
    kv([
      ['txid', esc(t.txid)],
      ['block', t.blockhash ? L('/block/' + t.blockhash, t.blockhash) : '<span class="sub">mempool</span>'],
      ['confirmations', `${t.confirmations ?? 0}`],
      ['time', t.time ? fmtT(t.time) : '—'],
      ['size / vsize', `${t.size} B / ${t.vsize} vB`],
      ['lock_height', `${t.lockheight ?? t.lock_height ?? '—'} <span class="sub">(demurrage reference)</span>`],
      ['fee', t.fee !== undefined ? t.fee.toFixed(8) + ' FRC' : '—'],
    ]) +
    `<h2>inputs</h2><table><tr><th>outpoint</th><th>address</th><th class="r">value</th></tr>${vin}</table>` +
    `<h2>outputs <span class="sub">(nominal)</span></h2><table><tr><th>#</th><th>address</th><th class="r">value</th></tr>${vout}</table>`);
}

async function addrPage(addr) {
  const scan = await rpc('scantxoutset', ['start', [`addr(${addr})`]]);
  const rows = (scan.unspents || []).sort((a, b) => b.height - a.height).slice(0, 200);
  return page('Address ' + addr.slice(0, 16),
    kv([
      ['address', esc(addr)],
      ['UTXOs', `${scan.unspents?.length ?? 0}`],
      ['balance (present value)', `${(+scan.total_amount).toFixed(8)} FRC`],
    ]) +
    `<p class="sub">current unspent outputs only — spent history is not indexed</p>` +
    `<table><tr><th>outpoint</th><th class="r">height</th><th class="r">amount</th></tr>` +
    rows.map(u => `<tr><td>${L('/tx/' + u.txid, u.txid)}:${u.vout}</td><td class="r">${L('/block/' + u.height, u.height)}</td><td class="r">${u.amount.toFixed(8)}</td></tr>`).join('') + '</table>');
}

async function search(q) {
  q = q.trim();
  if (/^\d+$/.test(q)) return { to: '/block/' + q };
  if (/^[0-9a-fA-F]{64}$/.test(q)) {
    try { await rpc('getblock', [q, 1]); return { to: '/block/' + q }; } catch {}
    return { to: '/tx/' + q };
  }
  return { to: '/address/' + q };
}

http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (PREFIX && path.startsWith(PREFIX)) path = path.slice(PREFIX.length) || '/';
    const q = new URL(req.url, 'http://x').searchParams.get('q');
    let html;
    if (path === '/' || path === '') html = await home();
    else if (path === '/search' && q) { const { to } = await search(q); res.writeHead(302, { Location: PREFIX + to }); res.end(); return; }
    else if (path.startsWith('/block/')) html = await blockPage(path.slice(7));
    else if (path.startsWith('/tx/')) html = await txPage(path.slice(4));
    else if (path.startsWith('/address/')) html = await addrPage(path.slice(9));
    else { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=10' });
    res.end(html);
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Error', `<p class="sub">${esc(e.message)}</p>`));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`explorer http://127.0.0.1:${PORT}${PREFIX}`));
