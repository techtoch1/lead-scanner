// Lead Scanner on your own server: serves the page and the Apollo API from one
// Node process, with no dependencies. Listens on 127.0.0.1 only; Nginx sits in
// front of it and handles HTTPS and the site password.
//
// Environment (see deploy/lead-scanner.env.example):
//   APOLLO_API_KEY  your Apollo API key
//   PORT            default 3010
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRoute } from '../worker/apollo-proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || '127.0.0.1';
const env = { APOLLO_API_KEY: process.env.APOLLO_API_KEY || '' };

// Only these files are served; everything else in the folder (server code,
// config) stays private.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/logo-light.svg': ['logo-light.svg', 'image/svg+xml'],
  '/logo-dark.svg': ['logo-dark.svg', 'image/svg+xml'],
  '/favicon.webp': ['favicon.webp', 'image/webp'],
};

const MAX_BODY = 1024 * 1024;

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Body must be JSON.'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
      if (!env.APOLLO_API_KEY) return send(res, 500, { error: 'APOLLO_API_KEY is not set on the server.' });
      const result = await runRoute(env, pathname.slice(5).replace(/\/+$/, ''), await readJson(req));
      return send(res, result.status, result.body);
    }
    const file = STATIC[pathname];
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, await fs.readFile(path.join(ROOT, file[0])), file[1]);
  } catch (e) {
    return send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});

server.listen(PORT, HOST, () => console.log(`Lead Scanner listening on http://${HOST}:${PORT}`));
