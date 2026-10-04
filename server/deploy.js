// Direct deploys over HTTPS, so updates don't need GitHub or SSH.
//
//   POST /deploy           body: { files: { "path": "<base64>" }, note }  -> installs a new version
//   POST /deploy/rollback  switches back to the previous version
//   POST /deploy/status    current version and the ones kept
// All need "Authorization: Bearer <DEPLOY_TOKEN>" (set in /etc/lead-scanner.env).
//
// A version is written to <data>/releases/<id>/, started on a spare port and
// checked before <data>/current is switched to it. The service then restarts
// into the new version (systemd Restart=always). The last 5 versions are kept.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const KEEP = 5;
const MAX_FILES = 200;
const MAX_TOTAL = 15 * 1024 * 1024;
// Only these paths can be shipped; anything else is refused.
const ALLOWED = /^(index\.html|login\.html|favicon\.webp|logo-(light|dark)\.svg|README\.md|\.gitignore|server\/[\w.-]+\.(js|json)|worker\/[\w.-]+\.(js|json|toml)|deploy\/[\w.-]+\.(sh|mjs))$/;
const REQUIRED = ['index.html', 'login.html', 'server/server.js', 'server/auth.js', 'worker/apollo-proxy.js', 'worker/package.json', 'server/package.json'];

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts the new version on a spare port and waits for its sign-in page.
async function smokeTest(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  try {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (child.exitCode !== null) {
        const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
        const where = lines.find(l => /\.js:\d+/.test(l)) || '';
        const what = lines.find(l => /\b\w*Error\b/.test(l)) || lines[0] || 'no output';
        throw new Error(`New version exited on start: ${what}${where && where !== what ? ' (' + where + ')' : ''}`.slice(0, 600));
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200 && (await res.text()).includes('Lead Scanner')) return;
      } catch { /* not up yet */ }
    }
    throw new Error('New version didn\'t answer within 10 seconds. ' + stderr.trim().slice(-500));
  } finally {
    child.kill('SIGTERM');
  }
}

export function createDeploy({ dataDir, token, appRoot }) {
  const releases = path.join(dataDir, 'releases');
  const current = path.join(dataDir, 'current');
  const fails = { count: 0, until: 0 };
  let busy = false;

  function authorized(req) {
    if (!token || token.length < 32) return { ok: false, status: 503, error: 'Deploys are off: DEPLOY_TOKEN isn\'t set on the server.' };
    if (fails.until > Date.now()) return { ok: false, status: 429, error: 'Too many wrong keys. Try again later.' };
    const ok = safeEqual(req.headers.authorization || '', 'Bearer ' + token);
    if (!ok && ++fails.count >= 10) { fails.until = Date.now() + 30 * 60 * 1000; fails.count = 0; }
    if (ok) fails.count = 0;
    return ok ? { ok: true } : { ok: false, status: 401, error: 'Wrong deploy key.' };
  }

  async function currentId() {
    try { return path.basename(await fs.readlink(current)); } catch { return null; }
  }
  async function list() {
    try { return (await fs.readdir(releases)).sort(); } catch { return []; }
  }

  async function pointTo(id) {
    const tmp = current + '.tmp';
    await fs.rm(tmp, { force: true });
    await fs.symlink(path.join(releases, id), tmp);
    await fs.rename(tmp, current);
  }

  // Exit after replying; systemd starts the service again from <data>/current.
  const restartSoon = () => setTimeout(() => process.exit(0), 300);

  async function install(body) {
    const files = body && typeof body.files === 'object' && body.files ? body.files : null;
    if (!files) throw Object.assign(new Error('Send { files: { path: base64 } }.'), { status: 400 });
    const entries = Object.entries(files);
    if (!entries.length || entries.length > MAX_FILES) throw Object.assign(new Error('Wrong number of files.'), { status: 400 });
    let total = 0;
    const decoded = entries.map(([p, b64]) => {
      if (!ALLOWED.test(p)) throw Object.assign(new Error('Path not allowed: ' + p), { status: 400 });
      const buf = Buffer.from(String(b64), 'base64');
      total += buf.length;
      return [p, buf];
    });
    if (total > MAX_TOTAL) throw Object.assign(new Error('Too large.'), { status: 413 });
    for (const r of REQUIRED) if (!files[r]) throw Object.assign(new Error('Missing ' + r), { status: 400 });

    const digest = sha(Buffer.concat(decoded.sort(([a], [b]) => a.localeCompare(b)).map(([p, b]) => Buffer.concat([Buffer.from(p + '\0'), b]))));
    const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + '-' + digest.slice(0, 8);
    const dir = path.join(releases, id);
    await fs.mkdir(dir, { recursive: true });
    try {
      for (const [p, buf] of decoded) {
        const dest = path.join(dir, p);
        if (!dest.startsWith(dir + path.sep)) throw new Error('Bad path.');
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
      }
      await smokeTest(dir);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw Object.assign(new Error('Not deployed, the live version is unchanged. ' + e.message), { status: 422 });
    }
    const previous = await currentId();
    await pointTo(id);
    await fs.writeFile(path.join(dir, 'DEPLOYED.json'), JSON.stringify({ id, previous, note: String(body.note || '').slice(0, 300), at: new Date().toISOString() }, null, 1));
    // Keep the newest few (never the live one).
    const all = await list();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) if (old !== id) await fs.rm(path.join(releases, old), { recursive: true, force: true });
    return { deployed: id, previous };
  }

  async function handle(req, res, pathname, readJson, send) {
    const auth = authorized(req);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
    if (busy) return send(res, 409, { error: 'Another deploy is running.' });
    busy = true;
    try {
      if (pathname === '/deploy/status') {
        return send(res, 200, { running: path.relative(dataDir, appRoot).startsWith('..') ? 'base install' : path.basename(appRoot), current: await currentId(), kept: await list() });
      }
      if (pathname === '/deploy/rollback') {
        const all = await list();
        const cur = await currentId();
        const idx = all.indexOf(cur);
        const target = idx > 0 ? all[idx - 1] : null;
        if (!target) {
          // No older version kept: go back to the base install from the installer.
          await fs.rm(current, { force: true });
          send(res, 200, { rolledBackTo: 'base install' });
        } else {
          await pointTo(target);
          send(res, 200, { rolledBackTo: target });
        }
        return restartSoon();
      }
      if (pathname === '/deploy') {
        const result = await install(await readJson(req, MAX_TOTAL * 1.4 + 100000));
        send(res, 200, { ...result, restarting: true });
        return restartSoon();
      }
      return send(res, 404, { error: 'Unknown deploy route.' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    } finally {
      busy = false;
    }
  }

  return { handle };
}
