// Local stand-in for Netlify: serves public/ and runs the real leaderboard logic against in-memory stores.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../netlify/lib/core.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function fakeStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v, o = {}) { if (o.onlyIfNew && m.has(k)) return { modified: false }; m.set(k, JSON.stringify(v)); return { modified: true }; },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
let lastEmail = null;
// In dev the reset email is not sent; it is printed here and served at /dev/last-email.
const deps = { players: fakeStore(), scores: fakeStore(), secret: 'dev', now: () => Date.now(), sendEmail: async (m) => { lastEmail = m; console.log('reset email to', m.to, '\n' + m.text); } };

export function start(port = 8788) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/leaderboard') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await handle(new Request(url, { method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), deps);
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
    }
    if (url.pathname === '/dev/last-email') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(lastEmail)); return; }
    let f = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
  console.log('dev server on http://localhost:8788');
}
