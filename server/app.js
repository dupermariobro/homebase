import express from 'express';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from './db.js';
import {
  isValidDate,
  choresForDate,
  balances,
  assigneeFor,
  completeChore,
  uncompleteChore,
  redeem,
  parseDays,
  parseIds,
  approveCompletion,
  pendingApprovals,
  streaks,
} from './chores.js';
import { requirePin, verifyPin, pinIsSet, setPin, createPinGuard } from './pin.js';
import { eventsBetween, syncAll } from './calendar.js';
import { getWeather } from './weather.js';
import { registerExtras, expandLocalEvents } from './extras.js';
import { sendNtfy } from './reminders.js';
import { remoteGate, createPairCode, clientIp } from './remote.js';
import { aiEnabled, shoppingItems } from './ai.js';
import { addToList, ruleBasedShopping } from './shopping.js';

export const COLORS = ['blue', 'green', 'teal', 'purple', 'orange', 'pink', 'red', 'amber', 'gray'];

export function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}


const ROLES = ['adult', 'child', 'calendar'];

// Public view of a person: never leak the secret iCal URL or ntfy topic to unauthenticated clients.
function publicPerson(p) {
  const { ical_url, ntfy_topic, ...rest } = p;
  return { ...rest, has_calendar: Boolean(ical_url), has_reminders: Boolean(ntfy_topic) };
}

function validChorePayload(b) {
  if (!b.title || !String(b.title).trim()) return 'Title is required';
  if (!Number.isInteger(Number(b.person_id))) return 'Pick who the chore is for';
  if (!['daily', 'weekdays'].includes(b.schedule_type)) return 'Invalid schedule';
  if (b.schedule_type === 'weekdays' && parseDays(Array.isArray(b.days) ? b.days.join(',') : b.days).length === 0)
    return 'Pick at least one day';
  return null;
}

// Notify every parent (adult with an ntfy topic) that a kid's completion is waiting
// for approval. Best-effort: a notify failure must never fail the completion itself.
async function notifyPendingApproval(db, fetchImpl, choreId, date) {
  const url = getSetting(db, 'ntfy_url');
  if (!url) return;
  const chore = db.prepare('SELECT * FROM chores WHERE id = ?').get(choreId);
  if (!chore) return;
  const who = db.prepare('SELECT name FROM people WHERE id = ?').get(assigneeFor(chore, date));
  const adults = db
    .prepare("SELECT ntfy_topic FROM people WHERE role = 'adult' AND ntfy_topic IS NOT NULL AND ntfy_topic != ''")
    .all();
  const click = getSetting(db, 'public_url') || undefined;
  for (const a of adults) {
    try {
      await sendNtfy(fetchImpl, url, a.ntfy_topic, {
        title: 'Chore to approve',
        message: `${who?.name || 'A kid'} says they finished “${chore.title}”. Tap to approve in Homebase.`,
        tags: 'white_check_mark',
        click,
      });
    } catch (e) {
      console.error('approval ntfy failed:', e.message);
    }
  }
}

// Names the tablet may use to reach the LAN listener. Anything else is refused, which stops
// DNS-rebinding pages (attacker.example → 192.168.x.x) from reading the family's data.
function hostAllowed(hostname = '') {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const extra = (process.env.HOMEBASE_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (
    net.isIP(h) !== 0 || h === 'localhost' || extra.includes(h) ||
    /\.(local|lan|home\.arpa|ts\.net)$/.test(h)
  );
}

export function createApp({ db, broadcast = () => {}, fetchImpl = fetch, staticDir, photoDir, remote = false, lookup } = {}) {
  const app = express();
  // AI requests carry a photo, so they get their own larger body limit (see extras.js).
  const smallJson = express.json({ limit: '256kb' });
  app.use((req, res, next) => (req.path.startsWith('/api/ai/') || req.path === '/api/photos' ? next() : smallJson(req, res, next)));
  // The public listener (Tailscale Funnel) only lets paired devices through.
  // Cross-site writes: other websites can't send custom headers or JSON/image bodies without a
  // CORS preflight, which Homebase never grants. So a write needs X-Homebase, or one of the body
  // types Homebase actually consumes (allowlist). Browsers that label a request cross-site are
  // refused outright as a second layer.
  const PREFLIGHTED = /^(application\/json|image\/(jpeg|png|webp|heic|heif))$/;
  app.use((req, res, next) => {
    if (!remote && !hostAllowed(req.hostname)) return res.status(403).json({ error: 'Unknown host — add it to HOMEBASE_ALLOWED_HOSTS' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed' });
      if (!req.get('x-homebase') && !PREFLIGHTED.test(type)) {
        return res.status(403).json({ error: 'Send X-Homebase: 1 (or a JSON body) with API writes' });
      }
    }
    next();
  });
  if (remote) app.use(remoteGate(db));
  // Only the remote listener sits behind a proxy whose X-Forwarded-For can be trusted.
  const clientKey = (req) => clientIp(req, remote);
  const pinGuard = createPinGuard();
  const parent = requirePin(db, pinGuard, clientKey);
  const changed = (topic) => broadcast({ type: 'changed', topic });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const send = (res, result) =>
    result.error ? res.status(result.status || 400).json({ error: result.error }) : res.json(result);

  app.get('/api/health', (_req, res) => res.json({ ok: true, today: localToday() }));

  // --- auth -------------------------------------------------------------
  app.get('/api/auth', (_req, res) => res.json({ pinSet: pinIsSet(db) }));
  app.post('/api/auth/check', (req, res, next) => {
    const key = clientKey(req);
    if (pinGuard.blocked(key)) return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes.' });
    const queued = pinGuard.pace(
      key,
      (blocked) => {
        if (blocked) return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes.' });
        const ok = verifyPin(req.body?.pin, getSetting(db, 'pin_hash'));
        if (!ok) pinGuard.fail(key);
        res.json({ ok });
      },
      next
    );
    if (!queued) res.status(429).json({ error: 'Too many PIN checks right now. Try again in a minute.' });
  });

  // --- away-from-home devices ---------------------------------------------------
  app.get('/api/devices', parent, (_req, res) => {
    res.json({
      publicUrl: getSetting(db, 'public_url'),
      devices: db.prepare('SELECT id, name, created_at, last_seen FROM devices ORDER BY id').all(),
    });
  });
  app.post('/api/devices/pair', parent, (_req, res) => {
    // A linked phone can do anything the tablet can, from anywhere, so linking needs a PIN.
    if (!pinIsSet(db)) return res.status(400).json({ error: 'Set a parent PIN before linking phones' });
    const base = getSetting(db, 'public_url');
    if (!base) return res.status(400).json({ error: 'Away-from-home access isn’t turned on yet' });
    const { code, expiresAt } = createPairCode(db);
    // The code rides in the URL fragment, which browsers never send to servers or logs.
    res.json({ url: `${base.replace(/\/$/, '')}/pair#${code}`, expiresAt });
  });
  app.delete('/api/devices/:id', parent, (req, res) => {
    db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  app.put('/api/auth/pin', parent, (req, res) => {
    const pin = req.body.pin;
    if (pin && !/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–8 digits' });
    setPin(db, pin || null);
    res.json({ ok: true, pinSet: Boolean(pin) });
  });

  // --- people -----------------------------------------------------------
  app.get('/api/people', (_req, res) => {
    const people = db.prepare('SELECT * FROM people ORDER BY sort_order, id').all().map(publicPerson);
    const bal = balances(db);
    const streak = streaks(db, localToday());
    res.json(people.map((p) => ({ ...p, points: bal[p.id], streak: streak[p.id] || 0 })));
  });
  app.get('/api/admin/people', parent, (_req, res) => {
    res.json(db.prepare('SELECT * FROM people ORDER BY sort_order, id').all());
  });
  app.post('/api/people', parent, (req, res) => {
    const b = req.body;
    if (!b.name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const color = COLORS.includes(b.color) ? b.color : 'gray';
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM people').get().m;
    const r = db
      .prepare(
        'INSERT INTO people (name, role, birthday, color, rewards_enabled, ical_url, sort_order, ntfy_topic) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        b.name.trim(),
        ROLES.includes(b.role) ? b.role : 'child',
        b.birthday || null,
        color,
        b.rewards_enabled && b.role !== 'calendar' ? 1 : 0,
        b.ical_url || null,
        max + 1,
        b.ntfy_topic?.trim() || null
      );
    changed('people');
    res.json({ id: r.lastInsertRowid });
  });
  app.put('/api/people/:id', parent, (req, res) => {
    const cur = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Person not found' });
    const b = { ...cur, ...req.body };
    if (!String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });
    db.prepare(
      'UPDATE people SET name=?, role=?, birthday=?, color=?, rewards_enabled=?, ical_url=?, sort_order=?, ntfy_topic=? WHERE id=?'
    ).run(
      String(b.name).trim(),
      ROLES.includes(b.role) ? b.role : cur.role,
      b.birthday || null,
      COLORS.includes(b.color) ? b.color : cur.color,
      b.rewards_enabled ? 1 : 0,
      b.ical_url ? String(b.ical_url).trim() : null,
      Number(b.sort_order) || 0,
      b.ntfy_topic ? String(b.ntfy_topic).trim() : null,
      cur.id
    );
    if (!b.ical_url) db.prepare('DELETE FROM events WHERE person_id = ?').run(cur.id);
    changed('people');
    changed('events');
    res.json({ ok: true });
  });
  app.delete('/api/people/:id', parent, (req, res) => {
    db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
    changed('people');
    changed('chores');
    res.json({ ok: true });
  });

  // --- chores -----------------------------------------------------------
  app.get('/api/chores', (req, res) => {
    const date = isValidDate(req.query.date) ? req.query.date : localToday();
    res.json({ date, chores: choresForDate(db, date) });
  });
  app.get('/api/chores/all', (_req, res) => {
    res.json(
      db
        .prepare('SELECT * FROM chores ORDER BY person_id, id')
        .all()
        .map((c) => ({ ...c, days: parseDays(c.days), rotation: parseIds(c.rotation) }))
    );
  });
  app.get('/api/chores/pending', (_req, res) => res.json(pendingApprovals(db)));
  app.post('/api/chores/:id/approve', parent, (req, res) => {
    const date = isValidDate(req.body.date) ? req.body.date : localToday();
    const result = approveCompletion(db, Number(req.params.id), date);
    if (result.ok) {
      changed('chores');
      changed('people');
    }
    send(res, result);
  });
  const choreArgs = (b) => [
    String(b.title).trim(),
    Number(b.person_id),
    Math.max(0, Math.min(100, Number(b.points) || 0)),
    b.schedule_type,
    b.schedule_type === 'weekdays' ? parseDays(Array.isArray(b.days) ? b.days.join(',') : b.days).join(',') : '',
    b.icon || null,
    (Array.isArray(b.rotation) ? b.rotation : parseIds(b.rotation)).map(Number).filter(Boolean).join(','),
    b.requires_approval ? 1 : 0,
  ];
  app.post('/api/chores', parent, (req, res) => {
    const err = validChorePayload(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = db
      .prepare('INSERT INTO chores (title, person_id, points, schedule_type, days, icon, rotation, requires_approval) VALUES (?,?,?,?,?,?,?,?)')
      .run(...choreArgs(req.body));
    changed('chores');
    res.json({ id: r.lastInsertRowid });
  });
  app.put('/api/chores/:id', parent, (req, res) => {
    const err = validChorePayload(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = db
      .prepare('UPDATE chores SET title=?, person_id=?, points=?, schedule_type=?, days=?, icon=?, rotation=?, requires_approval=? WHERE id=?')
      .run(...choreArgs(req.body), req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Chore not found' });
    changed('chores');
    res.json({ ok: true });
  });
  app.delete('/api/chores/:id', parent, (req, res) => {
    // Soft delete keeps past completions (and therefore points) intact.
    db.prepare('UPDATE chores SET active = 0 WHERE id = ?').run(req.params.id);
    changed('chores');
    res.json({ ok: true });
  });
  app.post(
    '/api/chores/:id/complete',
    wrap(async (req, res) => {
      const date = isValidDate(req.body.date) ? req.body.date : localToday();
      // A voice completion (Alexa → HA) posts { pending: true } so it needs a parent's
      // approval, while a tablet tap (no flag) still completes instantly as before.
      const forceApproval = req.body.pending === true || req.body.approval === 'force';
      const result = completeChore(db, Number(req.params.id), date, { forceApproval });
      if (result.ok) {
        changed('chores');
        changed('people');
        // Ping the parents when something newly lands in the approval queue.
        if (result.created && result.status === 'pending') {
          await notifyPendingApproval(db, fetchImpl, Number(req.params.id), date);
        }
      }
      send(res, result);
    })
  );
  // Un-checking is parent-only so points can't be farmed by toggling.
  app.delete('/api/chores/:id/complete', parent, (req, res) => {
    const date = isValidDate(req.query.date) ? req.query.date : localToday();
    const result = uncompleteChore(db, Number(req.params.id), date);
    changed('chores');
    changed('people');
    send(res, result);
  });

  // --- rewards ----------------------------------------------------------
  app.get('/api/rewards', (_req, res) => {
    res.json({
      rewards: db.prepare('SELECT * FROM rewards WHERE active = 1 ORDER BY cost').all(),
      recent: db
        .prepare('SELECT r.*, p.name FROM redemptions r JOIN people p ON p.id = r.person_id ORDER BY r.id DESC LIMIT 10')
        .all(),
    });
  });
  app.post('/api/rewards', parent, (req, res) => {
    const { title, cost } = req.body;
    if (!title?.trim() || !(Number(cost) > 0)) return res.status(400).json({ error: 'Title and a positive cost are required' });
    const r = db.prepare('INSERT INTO rewards (title, cost, icon) VALUES (?,?,?)').run(title.trim(), Math.round(cost), req.body.icon || null);
    changed('rewards');
    res.json({ id: r.lastInsertRowid });
  });
  app.put('/api/rewards/:id', parent, (req, res) => {
    const { title, cost } = req.body;
    if (!title?.trim() || !(Number(cost) > 0)) return res.status(400).json({ error: 'Title and a positive cost are required' });
    db.prepare('UPDATE rewards SET title=?, cost=? WHERE id=?').run(title.trim(), Math.round(cost), req.params.id);
    changed('rewards');
    res.json({ ok: true });
  });
  app.delete('/api/rewards/:id', parent, (req, res) => {
    db.prepare('UPDATE rewards SET active = 0 WHERE id = ?').run(req.params.id);
    changed('rewards');
    res.json({ ok: true });
  });
  app.post('/api/rewards/:id/redeem', parent, (req, res) => {
    const result = redeem(db, Number(req.params.id), Number(req.body.person_id));
    if (result.ok) {
      changed('rewards');
      changed('people');
    }
    send(res, result);
  });

  // --- meals ------------------------------------------------------------
  app.get('/api/meals', (req, res) => {
    const { from, to } = req.query;
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to dates required' });
    // Linked recipes come along so the day can show how to make it.
    res.json(
      db
        .prepare(
          `SELECT m.*, r.title AS recipe_title, r.instructions AS recipe_instructions,
                  r.ingredients AS recipe_ingredients, r.source_url AS recipe_source
           FROM meals m LEFT JOIN recipes r ON r.id = m.recipe_id
           WHERE m.date >= ? AND m.date <= ? ORDER BY m.date`
        )
        .all(from, to)
        .map((m) => ({
          ...m,
          ingredients: JSON.parse(m.ingredients),
          recipe_ingredients: m.recipe_ingredients ? JSON.parse(m.recipe_ingredients) : null,
        }))
    );
  });
  app.put('/api/meals/:date', (req, res) => {
    const { date } = req.params;
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const title = String(req.body.title || '').trim();
    if (!title) {
      db.prepare('DELETE FROM meals WHERE date = ?').run(date);
    } else {
      const ingredients = (Array.isArray(req.body.ingredients) ? req.body.ingredients : [])
        .map((s) => String(s).trim())
        .filter(Boolean);
      db.prepare(
        `INSERT INTO meals (date, title, notes, ingredients) VALUES (?,?,?,?)
         ON CONFLICT(date) DO UPDATE SET title=excluded.title, notes=excluded.notes, ingredients=excluded.ingredients`
      ).run(date, title, req.body.notes || null, JSON.stringify(ingredients));
      // recipe_id: omitted = keep the link, null = unlink (e.g. dinner was changed to something else).
      if ('recipe_id' in req.body) {
        const rid = req.body.recipe_id ? Number(req.body.recipe_id) : null;
        db.prepare('UPDATE meals SET recipe_id = ? WHERE date = ?').run(rid, date);
      }
    }
    changed('meals');
    res.json({ ok: true });
  });
  app.post(
    '/api/meals/:date/to-list',
    wrap(async (req, res) => {
      const meal = db.prepare('SELECT * FROM meals WHERE date = ?').get(req.params.date);
      if (!meal) return res.status(404).json({ error: 'No meal planned that day' });
      const listId = Number(req.body.list_id) || db.prepare('SELECT id FROM lists ORDER BY sort_order, id LIMIT 1').get()?.id;
      if (!listId) return res.status(400).json({ error: 'Create a list first' });
      const lines = JSON.parse(meal.ingredients);
      // Shopping amounts, not cooking amounts. AI handles messy lines; rules are the fallback.
      let items;
      if (aiEnabled()) {
        try {
          items = await shoppingItems(fetchImpl, lines);
        } catch (err) {
          console.error('Shopping conversion fell back to rules:', err.message);
        }
      }
      if (!items) items = ruleBasedShopping(lines);
      const result = addToList(db, listId, items);
      changed('lists');
      res.json({ ok: true, ...result });
    })
  );

  // --- lists ------------------------------------------------------------
  app.get('/api/lists', (_req, res) => {
    const lists = db.prepare('SELECT * FROM lists ORDER BY sort_order, id').all();
    const items = db.prepare('SELECT * FROM list_items ORDER BY done, id').all();
    res.json(lists.map((l) => ({ ...l, items: items.filter((i) => i.list_id === l.id) })));
  });
  app.post('/api/lists', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM lists').get().m;
    const r = db.prepare('INSERT INTO lists (name, sort_order) VALUES (?, ?)').run(name, max + 1);
    changed('lists');
    res.json({ id: r.lastInsertRowid });
  });
  app.delete('/api/lists/:id', parent, (req, res) => {
    db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
    changed('lists');
    res.json({ ok: true });
  });
  app.post('/api/lists/:id/items', (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const r = db.prepare('INSERT INTO list_items (list_id, text) VALUES (?, ?)').run(req.params.id, text.slice(0, 200));
    changed('lists');
    res.json({ id: r.lastInsertRowid });
  });
  app.patch('/api/items/:id', (req, res) => {
    const cur = db.prepare('SELECT * FROM list_items WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    const text = req.body.text !== undefined ? String(req.body.text).trim() || cur.text : cur.text;
    const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : cur.done;
    db.prepare('UPDATE list_items SET text = ?, done = ? WHERE id = ?').run(text, done, cur.id);
    changed('lists');
    res.json({ ok: true });
  });
  app.delete('/api/items/:id', (req, res) => {
    db.prepare('DELETE FROM list_items WHERE id = ?').run(req.params.id);
    changed('lists');
    res.json({ ok: true });
  });
  app.post('/api/lists/:id/clear-done', (req, res) => {
    const r = db.prepare('DELETE FROM list_items WHERE list_id = ? AND done = 1').run(req.params.id);
    changed('lists');
    res.json({ ok: true, removed: r.changes });
  });

  // --- calendar ---------------------------------------------------------
  app.get('/api/events', (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const local = expandLocalEvents(db, String(from), String(to));
    const ical = eventsBetween(db, String(from), String(to)).map((e) => ({ ...e, source: 'ical' }));
    res.json([...ical, ...local].sort((a, b) => b.all_day - a.all_day || a.start.localeCompare(b.start)));
  });
  app.post(
    '/api/calendar/refresh',
    wrap(async (_req, res) => {
      const result = await syncAll(db, fetchImpl);
      if (result.changed) changed('events');
      changed('settings');
      res.json(result);
    })
  );

  // --- settings / weather -----------------------------------------------
  app.get('/api/settings', (_req, res) => {
    res.json({
      lat: getSetting(db, 'lat'),
      lon: getSetting(db, 'lon'),
      location_name: getSetting(db, 'location_name'),
      cents_per_point: Number(getSetting(db, 'cents_per_point', 0)),
      reminder_minutes: Number(getSetting(db, 'reminder_minutes', 30)),
      ntfy_url: getSetting(db, 'ntfy_url', ''),
      ntfy_public_url: getSetting(db, 'ntfy_public_url', ''),
      ai_enabled: aiEnabled(),
      calendar_status: JSON.parse(getSetting(db, 'calendar_status', '{}')),
      pinSet: pinIsSet(db),
    });
  });
  app.put('/api/settings', parent, (req, res) => {
    for (const key of ['lat', 'lon', 'location_name', 'cents_per_point', 'reminder_minutes', 'ntfy_url']) {
      if (key in req.body) setSetting(db, key, req.body[key] === '' ? null : req.body[key]);
    }
    changed('settings');
    res.json({ ok: true });
  });
  app.get(
    '/api/weather',
    wrap(async (_req, res) => res.json(await getWeather(db, fetchImpl)))
  );

  registerExtras(app, { db, parent, changed, wrap, send, fetchImpl, photoDir, lookup });

  app.post(
    '/api/reminders/test',
    parent,
    wrap(async (req, res) => {
      const person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.body.person_id);
      const url = getSetting(db, 'ntfy_url');
      if (!url) return res.status(400).json({ error: 'Set the ntfy server address first' });
      if (!person?.ntfy_topic) return res.status(400).json({ error: 'Give this person an ntfy topic first' });
      try {
        await sendNtfy(fetchImpl, url, person.ntfy_topic, {
          title: `Hi ${person.name}!`,
          message: 'Homebase reminders are working. Tap to open Homebase.',
          tags: 'tada',
          click: getSetting(db, 'public_url') || undefined,
        });
      } catch (e) {
        return res.status(502).json({ error: `Couldn’t reach ntfy: ${e.message}` });
      }
      res.json({ ok: true });
    })
  );

  // --- static client ----------------------------------------------------
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      // `root` matters: send() rejects absolute paths containing dot-directories
      // (e.g. an install under ~/.something).
      res.sendFile('index.html', { root: staticDir });
    });
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });
  return app;
}
