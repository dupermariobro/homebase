import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPin(pin, stored) {
  if (!stored) return true; // no PIN configured yet: everything is open
  if (pin === undefined || pin === null) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function pinIsSet(db) {
  return Boolean(getSetting(db, 'pin_hash'));
}

export function setPin(db, pin) {
  setSetting(db, 'pin_hash', pin ? hashPin(pin) : null);
}

/**
 * Wrong-PIN limiter shared by every PIN check in one app: 8 misses per client and 40 in
 * total per 15 minutes, so neither one client nor many spoofed ones can brute-force it.
 */
export function createPinGuard({ perClient = 8, total = 40, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map(); // client → { n, start }
  let all = { n: 0, start: Date.now() };
  const live = (f) => f && Date.now() - f.start < windowMs;
  return {
    blocked(key) {
      return (live(all) && all.n >= total) || (live(failures.get(key)) && failures.get(key).n >= perClient);
    },
    fail(key) {
      if (!live(all)) all = { n: 0, start: Date.now() };
      all.n++;
      if (failures.size > 1000) for (const [k, f] of failures) if (!live(f)) failures.delete(k);
      if (failures.size > 1000) failures.clear();
      const f = live(failures.get(key)) ? failures.get(key) : { n: 0, start: Date.now() };
      f.n++;
      failures.set(key, f);
    },
  };
}

// Express middleware: parent-only routes send the PIN in the X-Parent-Pin header.
export function requirePin(db, guard = createPinGuard(), clientKey = (req) => req.socket.remoteAddress) {
  return (req, res, next) => {
    const key = clientKey(req);
    if (guard.blocked(key)) return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes.' });
    if (verifyPin(req.get('x-parent-pin'), getSetting(db, 'pin_hash'))) return next();
    if (req.get('x-parent-pin')) guard.fail(key);
    res.status(401).json({ error: 'Parent PIN required', needsPin: true });
  };
}
