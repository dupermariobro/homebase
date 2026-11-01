// v2 routes: tasks, Homebase-only events, notes, countdowns, photos, recipes, AI quick-add.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isValidDate } from './chores.js';
import { aiEnabled, aiModel, extractRecipe, parseQuickAdd } from './ai.js';
import { fetch as undiciFetch } from 'undici';
import { fetchPublicText, guardedAgent, isPublicHttpUrl } from './netguard.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nextDay(dateStr) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
}

/** Local date + HH:MM → ISO instant, using the server's timezone (set it to the family's). */
function localIso(date, time) {
  return new Date(`${date}T${time}:00`).toISOString();
}

export const REPEATS = ['none', 'daily', 'weekly', 'biweekly', 'monthly'];

/** Normalizes an event payload into a local_events row, or returns an error string. */
export function eventRow(b) {
  const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'none';
  const repeat_until = repeat !== 'none' && isValidDate(b.repeat_until) ? b.repeat_until : null;
  const base = eventTimes(b);
  return base.error ? base : { ...base, repeat, repeat_until };
}

function eventTimes(b) {
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Event needs a title' };
  if (!isValidDate(b.date)) return { error: 'Event needs a date' };
  const person_id = Number(b.person_id);
  if (!Number.isInteger(person_id) || person_id <= 0) return { error: 'Pick whose calendar' };
  const allDay = Boolean(b.all_day) || !b.start_time;
  if (allDay) {
    const endDate = isValidDate(b.end_date) && b.end_date >= b.date ? nextDay(b.end_date) : nextDay(b.date);
    return { person_id, title, start: b.date, end: endDate, all_day: 1, location: b.location || null };
  }
  if (!TIME_RE.test(b.start_time)) return { error: 'Start time looks wrong' };
  const start = localIso(b.date, b.start_time);
  let end = b.end_time && TIME_RE.test(b.end_time) ? localIso(b.date, b.end_time) : null;
  if (!end || end <= start) end = new Date(Date.parse(start) + 3600e3).toISOString();
  return { person_id, title, start, end, all_day: 0, location: b.location || null };
}


/**
 * Saves an uploaded photo. Small JPEG/PNG/WebP files are stored as-is; HEIC and
 * oversized originals (sent when the phone couldn't shrink them) are converted to a
 * ≤1920px JPEG with macOS's built-in `sips`.
 */
export function storePhoto(dir, base, type, buf) {
  const needsConvert = type === 'image/heic' || type === 'image/heif' || buf.length > 4 * 1024 * 1024;
  if (!needsConvert) {
    const ext = { 'image/png': 'png', 'image/webp': 'webp' }[type] || 'jpg';
    fs.writeFileSync(path.join(dir, `${base}.${ext}`), buf);
    return `${base}.${ext}`;
  }
  const tmp = path.join(dir, `.${base}.upload`);
  const out = `${base}.jpg`;
  fs.writeFileSync(tmp, buf);
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '1920', tmp, '--out', path.join(dir, out)], { stdio: 'pipe', timeout: 30000 });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (!fs.existsSync(path.join(dir, out))) throw new Error('sips produced no output');
  return out;
}

// --- repeating events --------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Occurrence k of a repeating event, stepped in local time so DST never shifts the hour. */
function occurrence(e, k) {
  const start = e.all_day ? fromKey(e.start) : new Date(e.start);
  const end = e.all_day ? fromKey(e.end) : new Date(e.end);
  const dur = end - start;
  const s = new Date(start);
  if (e.repeat === 'daily') s.setDate(s.getDate() + k);
  else if (e.repeat === 'weekly') s.setDate(s.getDate() + 7 * k);
  else if (e.repeat === 'biweekly') s.setDate(s.getDate() + 14 * k);
  else if (e.repeat === 'monthly') s.setMonth(s.getMonth() + k);
  const en = new Date(s.getTime() + dur);
  if (e.all_day) {
    const days = Math.round(dur / 864e5);
    const endD = new Date(s);
    endD.setDate(endD.getDate() + days);
    return { start: localKey(s), end: localKey(endD), startDate: s, endDate: endD };
  }
  return { start: s.toISOString(), end: en.toISOString(), startDate: s, endDate: en };
}

/** Homebase events (including repeats) overlapping [fromIso, toIso). */
export function expandLocalEvents(db, fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const out = [];
  const shape = (e, o, k) => ({ ...e, start: o.start, end: o.end, id: `local-${e.id}${e.repeat !== 'none' ? `-${k}` : ''}`, local_id: e.id, source: 'local' });
  for (const e of db.prepare('SELECT * FROM local_events').all()) {
    if (e.repeat === 'none' || !REPEATS.includes(e.repeat)) {
      const o = occurrence({ ...e, repeat: 'none' }, 0);
      if (o.startDate < to && (o.endDate > from || (!e.all_day && o.startDate >= from))) out.push(shape(e, o, 0));
      continue;
    }
    const until = e.repeat_until ? fromKey(e.repeat_until) : null;
    if (until) until.setDate(until.getDate() + 1); // inclusive of the until date
    const step = { daily: 1, weekly: 7, biweekly: 14, monthly: 28 }[e.repeat] * 864e5;
    const first = e.all_day ? fromKey(e.start) : new Date(e.start);
    let k = Math.max(0, Math.floor((from - first) / step) - 2);
    for (let n = 0; n < 800; n++, k++) {
      const o = occurrence(e, k);
      if (o.startDate >= to || (until && o.startDate >= until)) break;
      if (o.endDate > from) out.push(shape(e, o, k));
    }
  }
  return out;
}

/** Checks the file's own signature, not the declared type: JPEG, PNG, WebP or HEIC/HEIF. */
export function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return true;
  return buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(buf.toString('latin1', 8, 12));
}

export function registerExtras(app, { db, parent, changed, wrap, send, fetchImpl, photoDir, lookup }) {
  const json = express.json({ limit: '256kb' });
  const bigJson = express.json({ limit: '12mb' });
  const personExists = (id) => id == null || Boolean(db.prepare('SELECT 1 FROM people WHERE id = ?').get(id));

  // --- tasks --------------------------------------------------------------
  app.get('/api/tasks', (req, res) => {
    const includeDone = req.query.done === '1';
    const rows = db
      .prepare(
        `SELECT * FROM tasks WHERE ${includeDone ? "done_at IS NULL OR done_at >= datetime('now','-7 days')" : 'done_at IS NULL'}
         ORDER BY done_at IS NOT NULL, due_date IS NULL, due_date, id`
      )
      .all();
    res.json(rows);
  });
  const taskArgs = (b) => {
    const title = String(b.title || '').trim();
    if (!title) return { error: 'Task needs a title' };
    const person_id = b.person_id ? Number(b.person_id) : null;
    if (!personExists(person_id)) return { error: 'Unknown person' };
    const due = isValidDate(b.due_date) ? b.due_date : null;
    return { args: [title, person_id, due, Math.max(0, Math.min(100, Number(b.points) || 0)), b.notes || null] };
  };
  app.post('/api/tasks', (req, res) => {
    const t = taskArgs(req.body);
    if (t.error) return res.status(400).json(t);
    const r = db.prepare('INSERT INTO tasks (title, person_id, due_date, points, notes) VALUES (?,?,?,?,?)').run(...t.args);
    changed('tasks');
    res.json({ id: r.lastInsertRowid });
  });
  // Points on tasks mean editing/deleting is a parent action.
  app.put('/api/tasks/:id', parent, (req, res) => {
    const t = taskArgs(req.body);
    if (t.error) return res.status(400).json(t);
    db.prepare('UPDATE tasks SET title=?, person_id=?, due_date=?, points=?, notes=? WHERE id=?').run(...t.args, req.params.id);
    changed('tasks');
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/done', (req, res) => {
    const r = db.prepare("UPDATE tasks SET done_at = datetime('now') WHERE id = ? AND done_at IS NULL").run(req.params.id);
    changed('tasks');
    changed('people');
    res.json({ ok: true, changed: r.changes === 1 });
  });
  app.delete('/api/tasks/:id/done', parent, (req, res) => {
    db.prepare('UPDATE tasks SET done_at = NULL WHERE id = ?').run(req.params.id);
    changed('tasks');
    changed('people');
    res.json({ ok: true });
  });
  app.delete('/api/tasks/:id', parent, (req, res) => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    changed('tasks');
    changed('people');
    res.json({ ok: true });
  });

  // --- Homebase events ----------------------------------------------------------
  const insertEvent = (row) =>
    db
      .prepare('INSERT INTO local_events (person_id, title, start, end, all_day, location, repeat, repeat_until) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.person_id, row.title, row.start, row.end, row.all_day, row.location, row.repeat, row.repeat_until).lastInsertRowid;
  app.post('/api/local-events', json, (req, res) => {
    const row = eventRow(req.body);
    if (row.error) return res.status(400).json(row);
    if (!personExists(row.person_id)) return res.status(400).json({ error: 'Unknown person' });
    const id = insertEvent(row);
    changed('events');
    res.json({ id });
  });
  app.get('/api/local-events/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM local_events WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Event not found' });
    res.json(row);
  });
  app.put('/api/local-events/:id', json, (req, res) => {
    const row = eventRow(req.body);
    if (row.error) return res.status(400).json(row);
    const r = db
      .prepare('UPDATE local_events SET person_id=?, title=?, start=?, end=?, all_day=?, location=?, repeat=?, repeat_until=? WHERE id=?')
      .run(row.person_id, row.title, row.start, row.end, row.all_day, row.location, row.repeat, row.repeat_until, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Event not found' });
    changed('events');
    res.json({ ok: true });
  });
  app.delete('/api/local-events/:id', (req, res) => {
    db.prepare('DELETE FROM local_events WHERE id = ?').run(req.params.id);
    changed('events');
    res.json({ ok: true });
  });

  // --- notes ----------------------------------------------------------------
  app.get('/api/notes', (_req, res) => {
    res.json(
      db
        .prepare('SELECT * FROM notes WHERE expires_on IS NULL OR expires_on >= ? ORDER BY id DESC')
        .all(localToday())
    );
  });
  app.post('/api/notes', (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 280);
    if (!text) return res.status(400).json({ error: 'Write something first' });
    const person_id = req.body.person_id ? Number(req.body.person_id) : null;
    const r = db
      .prepare('INSERT INTO notes (text, person_id, expires_on) VALUES (?,?,?)')
      .run(text, personExists(person_id) ? person_id : null, isValidDate(req.body.expires_on) ? req.body.expires_on : null);
    changed('notes');
    res.json({ id: r.lastInsertRowid });
  });
  app.delete('/api/notes/:id', (req, res) => {
    db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
    changed('notes');
    res.json({ ok: true });
  });

  // --- countdowns -----------------------------------------------------------
  app.get('/api/countdowns', (_req, res) => {
    res.json(db.prepare('SELECT * FROM countdowns WHERE date >= ? ORDER BY date').all(localToday()));
  });
  app.post('/api/countdowns', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title || !isValidDate(req.body.date)) return res.status(400).json({ error: 'Countdown needs a title and date' });
    const r = db.prepare('INSERT INTO countdowns (title, date, icon) VALUES (?,?,?)').run(title, req.body.date, req.body.icon || null);
    changed('countdowns');
    res.json({ id: r.lastInsertRowid });
  });
  app.delete('/api/countdowns/:id', (req, res) => {
    db.prepare('DELETE FROM countdowns WHERE id = ?').run(req.params.id);
    changed('countdowns');
    res.json({ ok: true });
  });

  // --- photos -----------------------------------------------------------------
  const dir = photoDir || path.resolve('data/photos');
  fs.mkdirSync(dir, { recursive: true });
  app.get('/api/photos', (_req, res) => res.json(db.prepare('SELECT * FROM photos ORDER BY id DESC').all()));
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  app.post('/api/photos', express.raw({ type: PHOTO_TYPES, limit: '40mb' }), (req, res) => {
    const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const size = Buffer.isBuffer(req.body) ? req.body.length : 0;
    if (!PHOTO_TYPES.includes(type) || size < 100 || !looksLikeImage(req.body)) {
      console.error(`Photo upload rejected: type=${type || 'none'} bytes=${size}`);
      return res.status(400).json({ error: 'That file type isn’t supported — use a photo (JPEG, PNG, HEIC)' });
    }
    const base = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    let filename;
    try {
      filename = storePhoto(dir, base, type, req.body);
    } catch (err) {
      console.error('Photo conversion failed:', err.message);
      return res.status(422).json({ error: 'Couldn’t read that photo' });
    }
    const by = Number(req.query.by) || null;
    const r = db.prepare('INSERT INTO photos (filename, uploaded_by) VALUES (?,?)').run(filename, personExists(by) ? by : null);
    console.log(`Photo saved: ${filename} (${type}, ${(size / 1024).toFixed(0)} KB)`);
    changed('photos');
    res.json({ id: r.lastInsertRowid, filename });
  });
  // Phones report upload failures here so they show up in the server log.
  app.post('/api/client-log', (req, res) => {
    console.error('Client:', String(req.body?.message || '').slice(0, 500), '|', String(req.get('user-agent') || '').slice(0, 120));
    res.json({ ok: true });
  });
  app.delete('/api/photos/:id', parent, (req, res) => {
    const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    fs.rmSync(path.join(dir, path.basename(row.filename)), { force: true });
    db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
    changed('photos');
    res.json({ ok: true });
  });
  app.use('/photos', express.static(dir, { maxAge: '30d', immutable: true, setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));

  // --- recipes ----------------------------------------------------------------
  // Real page fetches use undici's own fetch with the pinned agent (Node's built-in fetch
  // doesn't decode bodies through a dispatcher from the undici package). Tests inject fakes.
  const recipeAgent = guardedAgent();
  const pageFetch = fetchImpl === globalThis.fetch ? undiciFetch : fetchImpl;
  const recipeOut = (r) => ({ ...r, ingredients: JSON.parse(r.ingredients) });
  const cleanList = (xs) => (Array.isArray(xs) ? xs : []).map((s) => String(s).trim()).filter(Boolean);
  app.get('/api/recipes', (_req, res) => res.json(db.prepare('SELECT * FROM recipes ORDER BY title COLLATE NOCASE').all().map(recipeOut)));
  app.post('/api/recipes', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Recipe needs a title' });
    const r = db
      .prepare('INSERT INTO recipes (title, ingredients, instructions, source_url) VALUES (?,?,?,?)')
      .run(title, JSON.stringify(cleanList(req.body.ingredients)), req.body.instructions || null, req.body.source_url || null);
    changed('recipes');
    res.json({ id: r.lastInsertRowid });
  });
  app.put('/api/recipes/:id', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Recipe needs a title' });
    db.prepare('UPDATE recipes SET title=?, ingredients=?, instructions=?, source_url=? WHERE id=?').run(
      title,
      JSON.stringify(cleanList(req.body.ingredients)),
      req.body.instructions || null,
      req.body.source_url || null,
      req.params.id
    );
    changed('recipes');
    res.json({ ok: true });
  });
  app.delete('/api/recipes/:id', parent, (req, res) => {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
    changed('recipes');
    res.json({ ok: true });
  });
  app.post(
    '/api/recipes/import',
    wrap(async (req, res) => {
      const { url, text } = req.body;
      if (url && !isPublicHttpUrl(url)) return res.status(400).json({ error: 'Use a regular web link (http or https)' });
      if (!aiEnabled()) return res.status(503).json({ error: 'AI is not set up — add OPENAI_API_KEY (or OPENAI_BASE_URL) to .env' });
      const fetchPage = (u) => fetchPublicText(pageFetch, u, { lookup, dispatcher: recipeAgent });
      const recipe = await extractRecipe(fetchImpl, { url, text, fetchPage });
      res.json({ ...recipe, source_url: url || null });
    })
  );
  app.post('/api/meals/:date/recipe', (req, res) => {
    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.body.recipe_id);
    if (!recipe || !isValidDate(req.params.date)) return res.status(400).json({ error: 'Pick a recipe' });
    db.prepare(
      `INSERT INTO meals (date, title, notes, ingredients, recipe_id) VALUES (?,?,NULL,?,?)
       ON CONFLICT(date) DO UPDATE SET title=excluded.title, ingredients=excluded.ingredients, recipe_id=excluded.recipe_id`
    ).run(req.params.date, recipe.title, recipe.ingredients, recipe.id);
    changed('meals');
    res.json({ ok: true });
  });

  // --- AI quick-add ------------------------------------------------------------
  app.get('/api/ai/status', (_req, res) => res.json({ enabled: aiEnabled(), model: aiModel() }));
  app.post(
    '/api/ai/parse',
    bigJson,
    wrap(async (req, res) => {
      const people = db.prepare('SELECT id, name, role, birthday FROM people ORDER BY sort_order, id').all();
      const lists = db.prepare('SELECT name FROM lists ORDER BY sort_order, id').all().map((l) => l.name);
      const now = new Date();
      const today = localToday();
      const items = await parseQuickAdd(fetchImpl, {
        text: String(req.body.text || '').slice(0, 4000),
        images: [req.body.image, ...(Array.isArray(req.body.images) ? req.body.images : [])]
          .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
          .slice(0, 4),
        context: {
          today,
          weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          people,
          lists,
        },
      });
      const byName = new Map(people.map((p) => [p.name.toLowerCase(), p.id]));
      res.json({ items: items.map((it) => ({ ...it, person_id: it.person ? byName.get(it.person.toLowerCase()) || null : null })) });
    })
  );
  app.post('/api/ai/apply', bigJson, (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    // Chores award points, so creating them is a parent action (same rule as the chore editor).
    if (items.some((it) => it.type === 'chore')) {
      let allowed = false;
      parent(req, res, () => (allowed = true));
      if (!allowed) return;
    }
    const fallbackPerson =
      db.prepare("SELECT id FROM people WHERE role = 'calendar' ORDER BY sort_order LIMIT 1").get()?.id ||
      db.prepare("SELECT id FROM people WHERE role = 'adult' ORDER BY sort_order LIMIT 1").get()?.id;
    const listId = db.prepare('SELECT id FROM lists ORDER BY sort_order, id LIMIT 1').get()?.id;
    const results = [];
    const errors = [];
    db.transaction(() => {
      for (const it of items) {
        const person_id = it.person_id && personExists(Number(it.person_id)) ? Number(it.person_id) : null;
        try {
          if (it.type === 'event') {
            const row = eventRow({ ...it, person_id: person_id || fallbackPerson });
            if (row.error) throw new Error(row.error);
            results.push({ type: 'event', id: insertEvent(row) });
          } else if (it.type === 'chore') {
            if (!person_id) throw new Error('Pick who the chore is for');
            const days = (Array.isArray(it.days) ? it.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
            const uniq = [...new Set(days)].sort();
            const r = db
              .prepare('INSERT INTO chores (title, person_id, points, schedule_type, days) VALUES (?,?,?,?,?)')
              .run(String(it.title).trim(), person_id, Math.max(0, Math.min(100, Number(it.points) || 1)), uniq.length && uniq.length < 7 ? 'weekdays' : 'daily', uniq.length && uniq.length < 7 ? uniq.join(',') : '');
            results.push({ type: 'chore', id: r.lastInsertRowid });
          } else if (it.type === 'task') {
            const r = db
              .prepare('INSERT INTO tasks (title, person_id, due_date, points) VALUES (?,?,?,?)')
              .run(String(it.title).trim(), person_id, isValidDate(it.date) ? it.date : null, Math.max(0, Number(it.points) || 0));
            results.push({ type: 'task', id: r.lastInsertRowid });
          } else if (it.type === 'grocery') {
            if (!listId) throw new Error('No shopping list');
            db.prepare('INSERT INTO list_items (list_id, text) VALUES (?,?)').run(listId, String(it.title).trim().slice(0, 200));
            results.push({ type: 'grocery' });
          } else if (it.type === 'meal') {
            if (!isValidDate(it.date)) throw new Error('Meal needs a date');
            db.prepare(
              `INSERT INTO meals (date, title, ingredients) VALUES (?,?,?)
               ON CONFLICT(date) DO UPDATE SET title=excluded.title, ingredients=excluded.ingredients`
            ).run(it.date, String(it.title).trim(), JSON.stringify(cleanList(it.ingredients)));
            results.push({ type: 'meal' });
          } else if (it.type === 'note') {
            db.prepare('INSERT INTO notes (text, person_id) VALUES (?,?)').run(String(it.title).trim().slice(0, 280), person_id);
            results.push({ type: 'note' });
          } else if (it.type === 'countdown') {
            if (!isValidDate(it.date)) throw new Error('Countdown needs a date');
            db.prepare('INSERT INTO countdowns (title, date) VALUES (?,?)').run(String(it.title).trim(), it.date);
            results.push({ type: 'countdown' });
          }
        } catch (e) {
          errors.push(`${it.title || it.type}: ${e.message}`);
        }
      }
    })();
    for (const t of ['events', 'chores', 'tasks', 'lists', 'meals', 'notes', 'countdowns']) changed(t);
    res.json({ ok: true, added: results.length, errors });
  });

  return { send };
}
