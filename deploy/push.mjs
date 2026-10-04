// Sends this folder straight to the server as a new version (no GitHub needed).
//
//   LEAD_SCANNER_DEPLOY_TOKEN=... node deploy/push.mjs ["note"]
//   LEAD_SCANNER_DEPLOY_TOKEN=... node deploy/push.mjs --rollback
//   LEAD_SCANNER_DEPLOY_TOKEN=... node deploy/push.mjs --status
// LEAD_SCANNER_URL defaults to https://leads.aligned-tech.com
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = (process.env.LEAD_SCANNER_URL || 'https://leads.aligned-tech.com').replace(/\/+$/, '');
const TOKEN = process.env.LEAD_SCANNER_DEPLOY_TOKEN;
if (!TOKEN) { console.error('Set LEAD_SCANNER_DEPLOY_TOKEN.'); process.exit(1); }
// Must match ALLOWED in server/deploy.js.
const ALLOWED = /^(index\.html|login\.html|favicon\.webp|logo-(light|dark)\.svg|README\.md|\.gitignore|server\/[\w.-]+\.(js|json)|worker\/[\w.-]+\.(js|json|toml)|deploy\/[\w.-]+\.(sh|mjs))$/;

async function call(route, body) {
  const res = await fetch(URL_BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function collect(dir = ROOT, prefix = '') {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'data') continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(out, collect(path.join(dir, e.name), rel + '/'));
    else if (ALLOWED.test(rel)) out[rel] = fs.readFileSync(path.join(dir, e.name)).toString('base64');
  }
  return out;
}

const arg = process.argv[2] || '';
if (arg === '--status') {
  console.log(await call('/deploy/status'));
} else if (arg === '--rollback') {
  console.log(await call('/deploy/rollback'));
} else {
  const files = collect();
  const size = Object.values(files).reduce((n, b) => n + b.length, 0);
  console.log(`Sending ${Object.keys(files).length} files (${Math.round(size / 1024)} KB) to ${URL_BASE}…`);
  const result = await call('/deploy', { files, note: arg });
  console.log('Installed and checked:', result.deployed, '(previous:', (result.previous || 'base install') + '). Restarting…');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const st = await call('/deploy/status');
      if (st.running === result.deployed) { console.log('Live:', st.running); process.exit(0); }
    } catch { /* restarting */ }
  }
  console.error('Sent, but the server did not report the new version within 30 seconds. Check: node deploy/push.mjs --status');
  process.exit(2);
}
