// Lead Scanner on your own server: serves the page and the Apollo API from one
// Node process, with no dependencies. Listens on 127.0.0.1 only; Nginx sits in
// front of it and handles HTTPS. Sign-in is handled here (see auth.js).
//
// Environment (/etc/lead-scanner.env, written by deploy/install.sh):
//   APOLLO_API_KEY                         your Apollo API key
//   LOGIN_USER, LOGIN_HASH, SESSION_SECRET sign-in (see auth.js)
//   PORT                                   default 3010
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRoute } from '../worker/apollo-proxy.js';
import { createAuth } from './auth.js';
import { createCrm } from './crm.js';
import { createDeploy } from './deploy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || '127.0.0.1';
const env = { APOLLO_API_KEY: process.env.APOLLO_API_KEY || '' };
const auth = createAuth(process.env);
// systemd's StateDirectory= sets STATE_DIRECTORY (/var/lib/lead-scanner).
const DATA_DIR = process.env.STATE_DIRECTORY || process.env.DATA_DIR || path.join(ROOT, 'data');
const crm = createCrm({ dataDir: DATA_DIR, env });
const deploy = createDeploy({ dataDir: DATA_DIR, token: process.env.DEPLOY_TOKEN || '', appRoot: ROOT });

// Only these files are served; everything else in the folder (server code,
// config) stays private. PUBLIC ones are reachable before signing in.
const PUBLIC = new Set(['/logo-light.svg', '/logo-dark.svg', '/favicon.webp']);
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/logo-light.svg': ['logo-light.svg', 'image/svg+xml'],
  '/logo-dark.svg': ['logo-dark.svg', 'image/svg+xml'],
  '/favicon.webp': ['favicon.webp', 'image/webp'],
};

const MAX_BODY = 1024 * 1024;

function send(res, status, body, type = 'application/json', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(data);
}

const redirect = (res, location, extra = {}) => send(res, 303, '', 'text/plain', { Location: location, ...extra });

// Only same-site paths, so the login form can't be used to bounce people elsewhere.
const safeNext = n => (typeof n === 'string' && /^\/(?!\/)[^\\\s]*$/.test(n) ? n : '/');

const ERRORS = {
  bad: 'Wrong username or password.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  setup: 'Sign-in isn\'t set up yet. Run: sudo bash deploy/install.sh',
};
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loginPage(res, { error = '', next = '/', status = 200, username = '' } = {}) {
  const html = (await fs.readFile(path.join(ROOT, 'login.html'), 'utf8'))
    .replace('<!--ERROR-->', escHtml(ERRORS[error] || ''))
    .replace('<!--NEXT-->', escHtml(safeNext(next)))
    .replace('<!--USER-->', escHtml(String(username).slice(0, 100)));
  return send(res, status, html, 'text/html; charset=utf-8');
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  return Object.fromEntries(new URLSearchParams(body));
}

async function readJson(req, limit = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Body must be JSON.'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/login') {
      if (req.method === 'POST') {
        const form = await readForm(req);
        const next = safeNext(form.next);
        if (!auth.configured) return loginPage(res, { error: 'setup', next, status: 503 });
        const result = auth.attempt(req, form.username || '', form.password || '');
        if (result === 'ok') return redirect(res, next, { 'Set-Cookie': auth.newSessionCookie(req) });
        return loginPage(res, { error: result, next, status: result === 'locked' ? 429 : 401, username: form.username });
      }
      if (auth.sessionUser(req)) return redirect(res, safeNext(searchParams.get('next')));
      return loginPage(res, { error: auth.configured ? '' : 'setup', next: searchParams.get('next') || '/' });
    }
    // Direct deploys use their own key instead of a sign-in (see deploy.js).
    if (pathname === '/deploy' || pathname.startsWith('/deploy/')) {
      return deploy.handle(req, res, pathname, readJson, send);
    }
    if (pathname === '/logout') {
      return redirect(res, '/login', { 'Set-Cookie': auth.clearCookie(req) });
    }

    const signedIn = Boolean(auth.sessionUser(req));
    if (!signedIn && !PUBLIC.has(pathname)) {
      if (pathname.startsWith('/api/')) return send(res, 401, { error: 'Signed out. Reload the page to sign in again.' });
      return redirect(res, '/login?next=' + encodeURIComponent(pathname));
    }

    if (pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
      // Browsers can't send JSON cross-site without a preflight, which this server never approves.
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON.' });
      if (pathname.startsWith('/api/crm/')) {
        const name = pathname.slice(9).replace(/\/+$/, '');
        const handler = Object.prototype.hasOwnProperty.call(crm.routes, name) ? crm.routes[name] : null;
        if (!handler) return send(res, 404, { error: 'Unknown route.' });
        try {
          return send(res, 200, await handler(auth.sessionUser(req), await readJson(req)));
        } catch (e) {
          return send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
        }
      }
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
