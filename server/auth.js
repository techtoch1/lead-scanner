// Sign-in for Lead Scanner: one username, a scrypt password hash, and signed
// session cookies. No dependencies.
//
// Environment (written by deploy/install.sh into /etc/lead-scanner.env):
//   LOGIN_USER      username
//   LOGIN_HASH      scrypt:N:r:p:salt:hash  (make one with: node hash-password.js)
//   SESSION_SECRET  random string used to sign session cookies
import crypto from 'node:crypto';

const COOKIE = 'ls_session';
const SESSION_DAYS = 7;
const MAX_FAILS = 8;               // per IP ...
const LOCK_MS = 15 * 60 * 1000;    // ... within / locked for 15 minutes

const b64url = buf => Buffer.from(buf).toString('base64url');

export function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p });
  return ['scrypt', N, r, p, b64url(salt), b64url(hash)].join(':');
}

function verifyHash(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqualStr(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export function createAuth(env) {
  const user = env.LOGIN_USER || '';
  const hash = env.LOGIN_HASH || '';
  const configured = Boolean(user && hash);
  let secret = env.SESSION_SECRET || '';
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set; sessions will reset when the server restarts.');
  }
  // Signing with the password hash too means changing the password signs everyone out.
  const key = crypto.createHash('sha256').update(secret + '|' + hash).digest();
  const sign = data => crypto.createHmac('sha256', key).update(data).digest('base64url');
  const fails = new Map(); // ip -> { count, first, lockedUntil }

  function sessionUser(req) {
    const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
    if (!raw) return null;
    const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig || !safeEqualStr(sig, sign(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.exp > Date.now() && data.u === user ? data.u : null;
    } catch { return null; }
  }

  function cookieFor(req, value, maxAgeSec) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  }

  function newSessionCookie(req) {
    const payload = b64url(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 86400e3 }));
    return cookieFor(req, `${payload}.${sign(payload)}`, SESSION_DAYS * 86400);
  }

  const clearCookie = req => cookieFor(req, '', 0);

  // Nginx appends the real client address last in X-Forwarded-For.
  function clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
  }

  // Returns 'ok', 'bad' or 'locked'.
  function attempt(req, username, password) {
    const ip = clientIp(req);
    const now = Date.now();
    let f = fails.get(ip);
    if (f && f.lockedUntil > now) return 'locked';
    if (f && now - f.first > LOCK_MS) { fails.delete(ip); f = null; }
    // Always run the hash so a wrong username takes as long as a wrong password.
    const passOk = configured && verifyHash(String(password || ''), hash);
    if (passOk && safeEqualStr(username, user)) { fails.delete(ip); return 'ok'; }
    f = f || { count: 0, first: now, lockedUntil: 0 };
    f.count++;
    if (f.count >= MAX_FAILS) f.lockedUntil = now + LOCK_MS;
    fails.set(ip, f);
    if (fails.size > 10000) fails.clear(); // don't let a flood grow memory forever
    return f.lockedUntil > now ? 'locked' : 'bad';
  }

  return { configured, sessionUser, newSessionCookie, clearCookie, attempt };
}
