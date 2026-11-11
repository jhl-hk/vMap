// Standalone server: static files from dist/ plus the realtime WebSocket on /ws.
// Usage: node server/index.js   (PORT, HOST, ROOM_CAP, TRUST_PROXY env vars)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRealtime } from './realtime.js';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

// dist/ is a few hundred KB in total; keep it in memory, re-read when the file changes
const cache = new Map();

async function load(path) {
  const s = await stat(path);
  if (!s.isFile()) throw new Error('not a file');
  let hit = cache.get(path);
  if (hit && hit.mtime === s.mtimeMs) return hit;
  hit = { mtime: s.mtimeMs, body: await readFile(path), br: null, gz: null };
  try { hit.br = await readFile(path + '.br'); } catch {}
  try { hit.gz = await readFile(path + '.gz'); } catch {}
  if (cache.size > 64) cache.clear();
  cache.set(path, hit);
  return hit;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url.endsWith('/')) url += 'index.html';
  const path = normalize(join(ROOT, url));
  if (!path.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const f = await load(path);
    const ae = String(req.headers['accept-encoding'] || '');
    const headers = {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Cache-Control': url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept-Encoding',
    };
    let body = f.body;
    if (f.br && /\bbr\b/.test(ae)) { body = f.br; headers['Content-Encoding'] = 'br'; }
    else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

const rt = attachRealtime(server, {
  roomCap: Number(process.env.ROOM_CAP || 50),
  trustProxy: process.env.TRUST_PROXY === '1',
});

server.listen(PORT, HOST, () => console.log(`像素北科 http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    rt.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
