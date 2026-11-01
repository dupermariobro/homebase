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
 * Wrong-PIN limiter shared by every PIN check in one app. Each client gets 8 misses per
 * 15 minutes. Past 40 misses in total (many clients guessing), every PIN check is queued
 * and slowed to one per `slowMs`, so a guessing swarm crawls while the right PIN still
 * works for the family. (A hard global lockout would let anyone lock the parents out.)
 */
export function createPinGuard({ perClient = 8, total = 40, windowMs = 15 * 60 * 1000, slowMs = 5000, maxQueue = 20 } = {}) {
  const failures = new Map(); // client → { n, start }
  let all = { n: 0, start: Date.now() };
  let queue = Promise.resolve();
  const waiting = new Set(); // clients with a check in the slow queue (one each)
  const live = (f) => f && Date.now() - f.start < windowMs;
  const guard = {
    blocked(key) {
      return Boolean(live(failures.get(key)) && failures.get(key).n >= perClient);
    },
    /**
     * Runs `check()` now, or, while the swarm limit is tripped, in a one-at-a-time slow queue
     * (one waiting check per client, at most `maxQueue` in total). The per-client block is
     * re-checked when the check actually runs. Returns false when the caller should answer
     * 429; errors go to `onError` and never escape as unhandled rejections.
     */
    pace(key, check, onError) {
      const run = () => {
        try {
          if (guard.blocked(key)) return check(true);
          return check(false);
        } catch (err) {
          onError(err);
        }
      };
      if (!(live(all) && all.n >= total)) {
        run();
        return true;
      }
      if (waiting.has(key) || waiting.size >= maxQueue) return false;
      waiting.add(key);
      queue = queue
        .then(() => new Promise((r) => setTimeout(r, slowMs)))
        .then(() => {
          waiting.delete(key);
          run();
        })
        .catch(onError);
      return true;
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
  return guard;
}

// Express middleware: parent-only routes send the PIN in the X-Parent-Pin header.
export function requirePin(db, guard = createPinGuard(), clientKey = (req) => req.socket.remoteAddress) {
  return (req, res, next) => {
    const key = clientKey(req);
    if (guard.blocked(key)) return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes.' });
    const stored = getSetting(db, 'pin_hash');
    if (!stored) return next();
    const queued = guard.pace(
      key,
      (blocked) => {
        if (blocked) return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes.' });
        if (verifyPin(req.get('x-parent-pin'), stored)) return next();
        if (req.get('x-parent-pin')) guard.fail(key);
        res.status(401).json({ error: 'Parent PIN required', needsPin: true });
      },
      next
    );
    if (!queued) res.status(429).json({ error: 'Too many PIN checks right now. Try again in a minute.' });
  };
}
