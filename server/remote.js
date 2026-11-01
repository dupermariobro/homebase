// Away-from-home access. The public (Funnel) listener only serves paired devices.
// Pairing: a parent creates a one-time link on the home network; opening it on a
// phone swaps the link for a long-lived session cookie. No passwords involved.
import crypto from 'node:crypto';

export const COOKIE = 'hb_session';
const PAIR_TTL_MS = 15 * 60 * 1000;
const SESSION_DAYS = 400;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

export function createPairCode(db, now = Date.now()) {
  const code = token();
  db.prepare('DELETE FROM pair_codes WHERE expires_at < ? OR used = 1').run(now);
  db.prepare('INSERT INTO pair_codes (code_hash, expires_at) VALUES (?, ?)').run(sha(code), now + PAIR_TTL_MS);
  return { code, expiresAt: now + PAIR_TTL_MS };
}

/** Single-use: marks the code used before issuing a session. */
export function redeemPairCode(db, code, name, now = Date.now()) {
  if (typeof code !== 'string' || code.length < 20) return { error: 'This link is not valid', status: 400 };
  const claimed = db
    .prepare('UPDATE pair_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at >= ?')
    .run(sha(code), now);
  if (claimed.changes !== 1) return { error: 'This link expired or was already used. Ask for a new one.', status: 400 };
  const session = token();
  const r = db
    .prepare("INSERT INTO devices (name, token_hash, last_seen) VALUES (?, ?, datetime('now'))")
    .run(String(name || 'Phone').slice(0, 60), sha(session));
  return { ok: true, session, deviceId: r.lastInsertRowid };
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

const seenAt = new Map(); // device id → last write, so we don't write on every request

export function deviceForRequest(db, cookieHeader) {
  const s = parseCookies(cookieHeader)[COOKIE];
  if (!s) return null;
  const dev = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha(s));
  if (dev && Date.now() - (seenAt.get(dev.id) || 0) > 10 * 60 * 1000) {
    seenAt.set(dev.id, Date.now());
    db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(dev.id);
  }
  return dev || null;
}

export function sessionCookie(session) {
  return `${COOKIE}=${session}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

/** Simple fixed-window limiter keyed by client address. */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      if (hits.size > 1000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      if (hits.size > 1000) hits.clear();
      hits.set(key, { start: now, n: 1 });
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}

export function clientIp(req, behindProxy = false) {
  const sock = req.socket?.remoteAddress || '?';
  // Only the remote listener sits behind a tunnel (Funnel), which connects from loopback and
  // appends the real client to X-Forwarded-For. Anything a client wrote earlier in that header
  // is untrusted, so use the last value; on the LAN listener ignore the header entirely.
  const loopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  if (!behindProxy || !loopback) return sock;
  const xff = String(req.get?.('x-forwarded-for') || req.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || sock;
}

const PAIR_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Homebase · Link this phone</title>
<style>body{font-family:ui-rounded,system-ui,sans-serif;background:#f6f3ee;color:#23221f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
main{background:#fff;border-radius:22px;padding:28px;max-width:380px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{font-size:1.4rem;margin:0 0 8px}p{color:#5d5a53;line-height:1.5}input{font:inherit;width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #ccc;margin:8px 0 16px}
button{font:inherit;font-weight:700;width:100%;padding:14px;border-radius:999px;border:0;background:#2f5d50;color:#fff}.err{color:#a8321f}</style></head>
<body><main><h1>Link this phone to Homebase</h1><p id="msg">Name this device so you can recognize it later.</p>
<input id="name" placeholder="Sam’s iPhone" autocomplete="off"><button id="go">Link phone</button></main>
<script>
const code = location.hash.slice(1);
history.replaceState(null, '', '/pair');
const msg = document.getElementById('msg');
if (!code) { msg.textContent = 'This link is missing its code. Ask for a new one from Homebase Settings.'; msg.className = 'err'; }
document.getElementById('go').onclick = async () => {
  const r = await fetch('/api/pair/redeem', { method: 'POST', headers: { 'content-type': 'application/json', 'x-homebase': '1' },
    body: JSON.stringify({ code, name: document.getElementById('name').value || 'Phone' }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { msg.textContent = 'Linked! Opening Homebase…'; location.replace('/'); }
  else { msg.textContent = j.error || 'That didn’t work.'; msg.className = 'err'; }
};
</script></body></html>`;

const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Homebase</title>
<style>body{font-family:ui-rounded,system-ui,sans-serif;background:#f6f3ee;color:#23221f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}</style></head>
<body><main><h1>Homebase</h1><p>This phone isn’t linked yet.<br>On the home tablet, open Settings → Away from home → Link a phone.</p></main></body></html>`;

/**
 * Middleware for the public listener: only paired devices get through.
 * Everything else sees the pairing page, the redeem endpoint, or a locked notice.
 */
export function remoteGate(db) {
  const redeemLimit = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  return (req, res, next) => {
    res.set('Strict-Transport-Security', 'max-age=31536000');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.path === '/pair') return res.type('html').set('Cache-Control', 'no-store').send(PAIR_PAGE);
    if (req.path === '/api/pair/redeem' && req.method === 'POST') {
      if (!redeemLimit(clientIp(req, true))) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
      const result = redeemPairCode(db, req.body?.code, req.body?.name);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.set('Set-Cookie', sessionCookie(result.session));
      return res.json({ ok: true });
    }
    const device = deviceForRequest(db, req.get('cookie'));
    if (device) {
      req.device = device;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'This device isn’t linked', needsPairing: true });
    return res.status(401).type('html').send(LOCKED_PAGE);
  };
}
