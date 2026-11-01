import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, seed } from '../db.js';
import { createApp } from '../app.js';
import { assigneeFor, streaks } from '../chores.js';
import { dueReminders, runReminders } from '../reminders.js';
import { eventRow } from '../extras.js';
import { htmlToText } from '../ai.js';

let server, base, db;
const openaiCalls = [];
let openaiReply = { items: [] };

// Stand-in for fetch(): answers OpenAI calls with canned structured output.
async function fakeFetch(url, opts) {
  if (String(url).includes('api.openai.com')) {
    openaiCalls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(openaiReply) } }] }), { status: 200 });
  }
  if (String(url).startsWith('https://recipes.example')) {
    return new Response('<html><script type="application/ld+json">{"@type":"Recipe","name":"Tacos"}</script></html>');
  }
  return fetch(url, opts);
}

const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-v2-'));
before(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  db = openDb(':memory:');
  seed(db);
  const app = createApp({ db, fetchImpl: fakeFetch, photoDir, lookup: async () => [{ address: '93.184.215.14', family: 4 }] });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  delete process.env.OPENAI_API_KEY;
});

const api = async (method, url, body, pin) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-homebase': '1', ...(pin ? { 'x-parent-pin': pin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const person = (name) => db.prepare('SELECT * FROM people WHERE name = ?').get(name);

test('migration upgrades a v1 database and keeps its data', () => {
  const file = path.join(photoDir, 'v1.db');
  const v1 = new Database(file);
  v1.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('adult','child')),
    birthday TEXT, color TEXT NOT NULL, rewards_enabled INTEGER NOT NULL DEFAULT 0, ical_url TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
    INSERT INTO people (name, role, color) VALUES ('Alex','adult','blue');`);
  v1.close();
  const upgraded = openDb(file);
  assert.ok(upgraded.pragma('user_version', { simple: true }) >= 2);
  assert.equal(upgraded.prepare('SELECT name FROM people').get().name, 'Alex');
  upgraded.prepare("INSERT INTO people (name, role, color) VALUES ('Family','calendar','amber')").run();
  assert.ok(upgraded.prepare('SELECT 1 FROM tasks').all());
  upgraded.close();
});

test('rotation hands a chore to the next person each week', () => {
  const chore = { person_id: 4, rotation: '4,5' };
  assert.equal(assigneeFor(chore, '2026-09-27'), assigneeFor(chore, '2026-10-03')); // same week
  assert.notEqual(assigneeFor(chore, '2026-09-27'), assigneeFor(chore, '2026-10-04')); // next week
  assert.equal(assigneeFor({ person_id: 4, rotation: '' }, '2026-10-04'), 4);
});

test('approval-required chores award points only after a parent approves', async () => {
  await api('PUT', '/api/auth/pin', { pin: '4321' });
  const riley = person('Riley');
  const { body } = await api(
    'POST',
    '/api/chores',
    { title: 'Clean room', person_id: riley.id, points: 5, schedule_type: 'daily', requires_approval: true },
    '4321'
  );
  const done = await api('POST', `/api/chores/${body.id}/complete`, { date: '2026-09-29' });
  assert.equal(done.body.status, 'pending');
  let me = (await api('GET', '/api/people')).body.find((p) => p.name === 'Riley');
  assert.equal(me.points.balance, 0);
  assert.equal(me.points.pending, 5);
  assert.equal((await api('GET', '/api/chores/pending')).body.length, 1);
  assert.equal((await api('POST', `/api/chores/${body.id}/approve`, { date: '2026-09-29' })).status, 401);
  await api('POST', `/api/chores/${body.id}/approve`, { date: '2026-09-29' }, '4321');
  me = (await api('GET', '/api/people')).body.find((p) => p.name === 'Riley');
  assert.equal(me.points.balance, 5);
});

test('a voice completion ({pending:true}) needs approval even for an auto-approve chore', async () => {
  await api('PUT', '/api/auth/pin', { pin: '4321' });
  const casey = person('Casey');
  // An ordinary auto-approve chore (requires_approval defaults off).
  const { body } = await api(
    'POST',
    '/api/chores',
    { title: 'Make bed', person_id: casey.id, points: 1, schedule_type: 'daily' },
    '4321'
  );
  // A tablet tap (no flag) auto-approves...
  const tap = await api('POST', `/api/chores/${body.id}/complete`, { date: '2026-09-28' });
  assert.equal(tap.body.status, 'approved');
  // ...but a voice completion ({pending:true}) lands pending and earns nothing yet.
  const voice = await api('POST', `/api/chores/${body.id}/complete`, { date: '2026-09-29', pending: true });
  assert.equal(voice.body.status, 'pending');
  let me = (await api('GET', '/api/people')).body.find((p) => p.name === 'Casey');
  assert.equal(me.points.pending, 1);
  assert.equal((await api('GET', '/api/chores/pending')).body.some((r) => r.chore_id === body.id), true);
  // Parent approval moves it to earned.
  await api('POST', `/api/chores/${body.id}/approve`, { date: '2026-09-29' }, '4321');
  me = (await api('GET', '/api/people')).body.find((p) => p.name === 'Casey');
  assert.equal(me.points.balance, 2); // tap (1) + approved voice (1)
});

test('streak counts consecutive fully-finished days and skips an unfinished today', () => {
  const casey = person('Casey');
  const mine = db.prepare('SELECT * FROM chores WHERE person_id = ? AND active = 1').all(casey.id);
  const ins = db.prepare("INSERT OR IGNORE INTO chore_completions (chore_id, person_id, date, points, status) VALUES (?,?,?,?, 'approved')");
  for (const d of ['2026-09-26', '2026-09-27', '2026-09-28']) for (const c of mine) ins.run(c.id, casey.id, d, c.points);
  assert.equal(streaks(db, '2026-09-29')[casey.id], 3);
});

test('tasks add points when done and need a PIN to undo', async () => {
  const jordan = person('Jordan');
  const { body } = await api('POST', '/api/tasks', { title: 'Return library books', person_id: jordan.id, due_date: '2026-10-02', points: 4 });
  await api('POST', `/api/tasks/${body.id}/done`);
  const me = (await api('GET', '/api/people')).body.find((p) => p.name === 'Jordan');
  assert.equal(me.points.earned, 4);
  assert.equal((await api('DELETE', `/api/tasks/${body.id}/done`)).status, 401);
});

test('Homebase events merge into the calendar feed', async () => {
  const fam = person('Family');
  await api('POST', '/api/local-events', { title: 'Pumpkin patch', person_id: fam.id, date: '2026-10-10' });
  const { body } = await api('GET', '/api/events?from=2026-10-10T00:00:00.000Z&to=2026-10-11T12:00:00.000Z');
  const ev = body.find((e) => e.title === 'Pumpkin patch');
  assert.equal(ev.source, 'local');
  assert.equal(ev.all_day, 1);
  assert.equal(ev.end, '2026-10-11');
});

test('eventRow defaults timed events to one hour', () => {
  const r = eventRow({ title: 'Dentist', person_id: 1, date: '2026-10-01', start_time: '15:00' });
  assert.equal(Date.parse(r.end) - Date.parse(r.start), 3600e3);
  assert.equal(eventRow({ title: 'x', person_id: 1, date: 'nope' }).error, 'Event needs a date');
});

test('AI quick-add parses with the household context and applies confirmed items', async () => {
  openaiReply = {
    items: [
      { type: 'event', title: 'Dentist', person: 'Riley', date: '2026-10-01', start_time: '15:00', end_time: null, all_day: false, location: null, ingredients: [], points: null },
      { type: 'grocery', title: 'Milk', person: null, date: null, start_time: null, end_time: null, all_day: false, location: null, ingredients: [], points: null },
    ],
  };
  const parsed = await api('POST', '/api/ai/parse', { text: 'Riley dentist Thursday 3pm, and we need milk' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.items[0].person_id, person('Riley').id);
  const sent = openaiCalls.at(-1);
  assert.equal(sent.response_format.type, 'json_schema');
  assert.match(sent.messages[0].content, /Casey/);
  const applied = await api('POST', '/api/ai/apply', { items: parsed.body.items });
  assert.equal(applied.body.added, 2);
  const lists = (await api('GET', '/api/lists')).body;
  assert.ok(lists[0].items.some((i) => i.text === 'Milk'));
});

test('recipe import refuses local network links and extracts from public pages', async () => {
  assert.equal((await api('POST', '/api/recipes/import', { url: 'http://192.168.1.1/admin' })).status, 400);
  openaiReply = { title: 'Tacos', ingredients: ['Tortillas'], instructions: '1. Cook' };
  const r = await api('POST', '/api/recipes/import', { url: 'https://recipes.example/tacos' });
  assert.equal(r.body.title, 'Tacos');
  assert.match(htmlToText('<script type="application/ld+json">{"@type":"Recipe"}</script>'), /Recipe/);
});

test('photos upload as raw images and delete with the PIN', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(496, 1)]);
  const up = await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-homebase': '1' }, body: jpeg }).then((r) => r.json());
  assert.ok(fs.existsSync(path.join(photoDir, up.filename)));
  const served = await fetch(`${base}/photos/${up.filename}`);
  assert.equal(served.status, 200);
  assert.equal((await api('DELETE', `/api/photos/${up.id}`)).status, 401);
  await api('DELETE', `/api/photos/${up.id}`, null, '4321');
  assert.ok(!fs.existsSync(path.join(photoDir, up.filename)));
});

test('notes and countdowns round-trip', async () => {
  await api('POST', '/api/notes', { text: 'Pizza Friday!', person_id: person('Sam').id });
  await api('POST', '/api/countdowns', { title: 'Disney', date: '2099-01-01' });
  assert.equal((await api('GET', '/api/notes')).body[0].text, 'Pizza Friday!');
  assert.equal((await api('GET', '/api/countdowns')).body[0].title, 'Disney');
});

test('reminders: event heads-up once, family events to adults, chore nudge for kids', async () => {
  db.prepare('UPDATE people SET ntfy_topic = ? WHERE name = ?').run('hb-dad', 'Alex');
  db.prepare('UPDATE people SET ntfy_topic = ? WHERE name = ?').run('hb-casey', 'Casey');
  db.prepare("INSERT INTO settings (key, value) VALUES ('ntfy_url', 'http://ntfy.test') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const now = new Date(2026, 8, 29, 17, 5); // 5:05 pm local
  const soon = new Date(now.getTime() + 20 * 60e3).toISOString();
  db.prepare('INSERT INTO local_events (person_id, title, start, end, all_day) VALUES (?,?,?,?,0)').run(
    person('Family').id, 'Soccer', soon, new Date(Date.parse(soon) + 3600e3).toISOString()
  );
  const due = dueReminders(db, now);
  assert.ok(due.some((r) => r.topic === 'hb-dad' && r.title === 'Soccer'));
  assert.ok(due.some((r) => r.topic === 'hb-casey' && r.key.startsWith('nudge|')));
  const posted = [];
  const ntfyFetch = async (url, opts) => (posted.push({ url, title: opts.headers.Title }), new Response('{}'));
  const first = await runReminders(db, ntfyFetch, now);
  const second = await runReminders(db, ntfyFetch, now);
  assert.ok(first >= 2);
  assert.equal(second, 0);
  assert.ok(posted.every((p) => p.url.startsWith('http://ntfy.test/hb-')));
});

test('HEIC uploads are converted to JPEG on the Mac', { skip: process.platform !== 'darwin' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const src = path.join(photoDir, 'src.png');
  const heic = path.join(photoDir, 'src.heic');
  // Build a real HEIC with sips from a generated PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR42u3PMQ0AAAgDoL1/aY3hAQkUaMo7qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKjoZwNk4gHBqqVsbwAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(src, png);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', src, '--out', heic], { stdio: 'pipe' });
  const res = await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/heic', 'x-homebase': '1' }, body: fs.readFileSync(heic) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.filename, /\.jpg$/);
  const out = fs.readFileSync(path.join(photoDir, body.filename));
  assert.equal(out[0], 0xff); // JPEG magic bytes
  assert.equal(out[1], 0xd8);
});

test('unsupported upload types get a clear error', async () => {
  const r = await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-homebase': '1' }, body: Buffer.alloc(500) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /supported/);
});

test('weekly events repeat on the same weekday and keep their local time across DST', async () => {
  const casey = person('Casey');
  const created = await api('POST', '/api/local-events', {
    title: 'Gymnastics', person_id: casey.id, date: '2026-10-06', start_time: '18:00', end_time: '19:30', repeat: 'weekly', repeat_until: '2026-11-17',
  });
  assert.equal(created.status, 200);
  const from = new Date(2026, 9, 1).toISOString();
  const to = new Date(2026, 11, 31).toISOString();
  const evs = (await api('GET', `/api/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body.filter((e) => e.title === 'Gymnastics');
  assert.equal(evs.length, 7); // Oct 6 … Nov 17 inclusive
  for (const e of evs) {
    const d = new Date(e.start);
    assert.equal(d.getDay(), 2); // Tuesday
    assert.equal(d.getHours(), 18); // 6 pm before and after DST ends on Nov 1
    assert.equal((Date.parse(e.end) - Date.parse(e.start)) / 60000, 90);
  }
  assert.equal(new Set(evs.map((e) => e.id)).size, 7);
});

test('a repeating event can be edited and removed as a series', async () => {
  const fam = person('Family');
  const { body } = await api('POST', '/api/local-events', { title: 'Trash night', person_id: fam.id, date: '2026-10-05', repeat: 'weekly' });
  const row = (await api('GET', `/api/local-events/${body.id}`)).body;
  assert.equal(row.repeat, 'weekly');
  await api('PUT', `/api/local-events/${body.id}`, { title: 'Trash & recycling', person_id: fam.id, date: '2026-10-05', repeat: 'biweekly' });
  const range = `from=${encodeURIComponent(new Date(2026, 9, 1).toISOString())}&to=${encodeURIComponent(new Date(2026, 10, 1).toISOString())}`;
  const evs = (await api('GET', `/api/events?${range}`)).body.filter((e) => e.title === 'Trash & recycling');
  assert.deepEqual(evs.map((e) => e.start), ['2026-10-05', '2026-10-19']);
  await api('DELETE', `/api/local-events/${body.id}`);
  assert.equal((await api('GET', `/api/events?${range}`)).body.filter((e) => e.local_id === body.id).length, 0);
});

test('AI quick-add passes repeat through to a recurring event', async () => {
  openaiReply = {
    items: [{ type: 'event', title: 'Gymnastics', person: 'Casey', date: '2026-10-06', start_time: '18:00', end_time: null, all_day: false, location: null, ingredients: [], points: null, repeat: 'weekly', repeat_until: null }],
  };
  const parsed = await api('POST', '/api/ai/parse', { text: 'Casey gymnastics every Tuesday at 6pm' });
  assert.ok(openaiCalls.at(-1).response_format.json_schema.schema.properties.items.items.properties.repeat);
  await api('POST', '/api/ai/apply', { items: parsed.body.items });
  const row = db.prepare("SELECT * FROM local_events WHERE title = 'Gymnastics' ORDER BY id DESC").get();
  assert.equal(row.repeat, 'weekly');
});

test('AI quick-add creates real chores (not to-dos), gated by the parent PIN', async () => {
  openaiReply = {
    items: [{ type: 'chore', title: 'Empty the dishwasher', person: 'Jordan', date: null, start_time: null, end_time: null, all_day: false, location: null, ingredients: [], points: 3, repeat: 'none', repeat_until: null, days: [1, 3, 5] }],
  };
  const parsed = await api('POST', '/api/ai/parse', { text: 'add emptying the dishwasher as a chore for Jordan on Mon, Wed, Fri for 3 points' });
  assert.equal(parsed.body.items[0].type, 'chore');
  assert.match(openaiCalls.at(-1).messages[0].content, /never task/);
  const denied = await api('POST', '/api/ai/apply', { items: parsed.body.items });
  assert.equal(denied.status, 401);
  const ok = await api('POST', '/api/ai/apply', { items: parsed.body.items }, '4321');
  assert.equal(ok.body.added, 1);
  const chore = db.prepare("SELECT * FROM chores WHERE title = 'Empty the dishwasher'").get();
  assert.equal(chore.person_id, person('Jordan').id);
  assert.equal(chore.schedule_type, 'weekdays');
  assert.equal(chore.days, '1,3,5');
  assert.equal(chore.points, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE title = 'Empty the dishwasher'").get().n, 0);
});

test('calendar sync reports a change only when events actually differ', async () => {
  const { syncAll } = await import('../calendar.js');
  const jordan = person('Jordan');
  db.prepare('UPDATE people SET ical_url = ? WHERE id = ?').run('https://cal.example/jordan.ics', jordan.id);
  let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@x\r\nSUMMARY:Work\r\nDTSTART:20261001T140000Z\r\nDTEND:20261001T220000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const feed = async () => new Response(ics);
  const first = await syncAll(db, feed);
  const second = await syncAll(db, feed);
  ics = ics.replace('SUMMARY:Work', 'SUMMARY:Work (late shift)');
  const third = await syncAll(db, feed);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(third.changed, true);
  db.prepare('UPDATE people SET ical_url = NULL WHERE id = ?').run(jordan.id);
});

test('recipe → grocery list uses shopping amounts and merges with what is already there', async () => {
  const { ruleBasedShopping, addToList, formatItem } = await import('../shopping.js');
  const conv = (l) => formatItem(ruleBasedShopping([l])[0]);
  assert.equal(conv('1 1/4 lb ground turkey'), 'Ground turkey (2 lb)');
  assert.equal(conv('2 tbsp kosher salt'), 'Kosher salt');
  assert.equal(conv('1/4 cup light mayonnaise'), 'Light mayonnaise');
  assert.equal(conv('2 (15 oz) cans black beans'), 'Black beans (2 cans)');
  assert.equal(conv('Juice of 2 limes'), 'Limes (2)');
  assert.equal(conv('1-2 jalapeños, diced'), 'Jalapeños (2)');

  const list = db.prepare("INSERT INTO lists (name) VALUES ('Merge test')").run().lastInsertRowid;
  db.prepare('INSERT INTO list_items (list_id, text) VALUES (?, ?)').run(list, 'Ground turkey (1 lb)');
  const r = addToList(db, list, ruleBasedShopping(['1 lb ground turkey', '1 tsp kosher salt', '2 tbsp Kosher salt']));
  const items = db.prepare('SELECT text FROM list_items WHERE list_id = ? ORDER BY id').all(list).map((x) => x.text);
  assert.deepEqual(items, ['Ground turkey (2 lb)', 'Kosher salt']);
  assert.deepEqual(r, { added: 1, merged: 1 });
});

test('recipe → grocery list asks the AI for shopping amounts when available', async () => {
  openaiReply = { items: [{ name: 'Ground turkey', amount: '2 lb' }, { name: 'Light mayonnaise', amount: null }] };
  await api('PUT', '/api/meals/2026-10-09', { title: 'Turkey burgers', ingredients: ['1 1/4 lb ground turkey', '2 tbsp light mayonnaise'] });
  const before = openaiCalls.length;
  const r = await api('POST', '/api/meals/2026-10-09/to-list', {});
  assert.equal(openaiCalls.length, before + 1);
  assert.match(openaiCalls.at(-1).messages[0].content, /round UP to whole pounds/);
  assert.equal(r.body.added >= 1, true);
  const texts = (await api('GET', '/api/lists')).body[0].items.map((i) => i.text);
  assert.ok(texts.includes('Ground turkey (2 lb)'));
  assert.ok(texts.includes('Light mayonnaise'));
});

test('a day planned from a recipe carries its instructions, and unlinks when changed', async () => {
  const rec = (await api('POST', '/api/recipes', { title: 'Turkey tacos', ingredients: ['1 lb ground turkey', '8 tortillas'], instructions: '1. Brown the turkey\n2. Warm tortillas\n3. Build tacos' })).body.id;
  await api('POST', '/api/meals/2026-10-12/recipe', { recipe_id: rec });
  await api('PUT', '/api/meals/2026-10-12', { title: 'Turkey tacos', notes: 'Lily helps cook', ingredients: ['1 lb ground turkey', '8 tortillas'] });
  let m = (await api('GET', '/api/meals?from=2026-10-12&to=2026-10-12')).body[0];
  assert.equal(m.recipe_title, 'Turkey tacos');
  assert.match(m.recipe_instructions, /Brown the turkey/);
  assert.deepEqual(m.recipe_ingredients, ['1 lb ground turkey', '8 tortillas']);
  assert.equal(m.notes, 'Lily helps cook'); // saving notes keeps the recipe link
  await api('PUT', '/api/meals/2026-10-12', { title: 'Pizza night', ingredients: [], recipe_id: null });
  m = (await api('GET', '/api/meals?from=2026-10-12&to=2026-10-12')).body[0];
  assert.equal(m.recipe_title, null);
});

test('quick-add sends every attached image (up to 4) to the AI', async () => {
  openaiReply = { items: [] };
  const img = 'data:image/jpeg;base64,' + Buffer.alloc(40).toString('base64');
  await api('POST', '/api/ai/parse', { text: '', images: [img, img, img, img, img, 'not-an-image'] });
  const parts = openaiCalls.at(-1).messages[1].content;
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 4);
});
