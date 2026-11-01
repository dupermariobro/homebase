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

// Express middleware: parent-only routes send the PIN in the X-Parent-Pin header.
export function requirePin(db) {
  const failures = new Map(); // client → { n, start }
  const WINDOW = 15 * 60 * 1000;
  return (req, res, next) => {
    const key = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket.remoteAddress;
    const f = failures.get(key);
    if (f && Date.now() - f.start < WINDOW && f.n >= 8) {
      return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes.' });
    }
    if (verifyPin(req.get('x-parent-pin'), getSetting(db, 'pin_hash'))) return next();
    if (req.get('x-parent-pin')) {
      const cur = f && Date.now() - f.start < WINDOW ? f : { n: 0, start: Date.now() };
      cur.n++;
      failures.set(key, cur);
    }
    res.status(401).json({ error: 'Parent PIN required', needsPin: true });
  };
}
