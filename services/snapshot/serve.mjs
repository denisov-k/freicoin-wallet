// serve.mjs — tiny static file server for header snapshots. Serving a pre-built file
// is far cheaper for the host than P2P header serialization + WS relay (sendfile from
// page cache), which matters on a small VPS. CORS-open (the wallet page fetches from a
// different port); Range supported for future parallel-segment downloads.
//   env: FW_SNAP_DIR (default /root/fw-snapshots), FW_SNAP_PORT (default 3050)
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const DIR = process.env.FW_SNAP_DIR || '/root/fw-snapshots';
const PORT = parseInt(process.env.FW_SNAP_PORT || '3050', 10);

http.createServer((req, res) => {
  const path = normalize(join(DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(DIR) || req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(403); res.end(); return; }
  let st;
  try { st = statSync(path); if (!st.isFile()) throw 0; } catch { res.writeHead(404); res.end(); return; }
  const common = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Content-Type': 'application/octet-stream',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
    if (start > end || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...common, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...common, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(path).pipe(res);
  }
}).listen(PORT, '0.0.0.0', () => console.log(`snapshot server http://0.0.0.0:${PORT} ← ${DIR}`));
