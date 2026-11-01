import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed } from '../db.js';
import { createApp } from '../app.js';
import { isDue, weekdayOf } from '../chores.js';
import { parseIcs } from '../calendar.js';

let server, base, db;
const events = [];

before(async () => {
  db = openDb(':memory:');
  seed(db);
  const os = await import('node:os');
  const fs = await import('node:fs');
  const photoDir = fs.mkdtempSync(os.tmpdir() + '/hb-photos-');
  const app = createApp({ db, broadcast: (m) => events.push(m), photoDir });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (method, url, body, pin) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(pin ? { 'x-parent-pin': pin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test('weekday is computed independent of host timezone', () => {
  assert.equal(weekdayOf('2026-09-29'), 2); // Tuesday
});

test('isDue handles daily, weekday, and inactive chores', () => {
  assert.equal(isDue({ active: 1, schedule_type: 'daily' }, '2026-09-29'), true);
  assert.equal(isDue({ active: 1, schedule_type: 'weekdays', days: '2' }, '2026-09-29'), true);
  assert.equal(isDue({ active: 1, schedule_type: 'weekdays', days: '1,3' }, '2026-09-29'), false);
  assert.equal(isDue({ active: 0, schedule_type: 'daily' }, '2026-09-29'), false);
});

test('seeded household is present with colors and no leaked iCal URLs', async () => {
  const { body } = await api('GET', '/api/people');
  assert.deepEqual(body.map((p) => p.name), ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Family']);
  assert.equal(body[5].role, 'calendar');
  assert.equal(body[4].color, 'orange');
  assert.ok(body.every((p) => !('ical_url' in p)));
});

test('chores due on a Tuesday include Jordan trash day but not mowing', async () => {
  const { body } = await api('GET', '/api/chores?date=2026-09-29');
  const titles = body.chores.map((c) => c.title);
  assert.ok(titles.includes('Take out trash'));
  assert.ok(!titles.includes('Mow the lawn'));
});

test('completing a chore is idempotent and awards points once', async () => {
  const { body } = await api('GET', '/api/chores?date=2026-09-29');
  const chore = body.chores.find((c) => c.title === 'Toys away');
  const first = await api('POST', `/api/chores/${chore.id}/complete`, { date: '2026-09-29' });
  const second = await api('POST', `/api/chores/${chore.id}/complete`, { date: '2026-09-29' });
  assert.equal(first.body.created, true);
  assert.equal(second.body.created, false);
  const people = (await api('GET', '/api/people')).body;
  assert.equal(people.find((p) => p.name === 'Casey').points.balance, 2);
  assert.ok(events.some((e) => e.topic === 'chores'));
});

test('PIN gates parent actions once set', async () => {
  const set = await api('PUT', '/api/auth/pin', { pin: '1234' });
  assert.equal(set.status, 200);
  const denied = await api('POST', '/api/rewards', { title: 'Movie night', cost: 10 });
  assert.equal(denied.status, 401);
  const allowed = await api('POST', '/api/rewards', { title: 'Movie night', cost: 10 }, '1234');
  assert.equal(allowed.status, 200);
  assert.equal((await api('POST', '/api/auth/check', { pin: '9999' })).body.ok, false);
});

test('redeeming requires enough points and deducts balance', async () => {
  const casey = (await api('GET', '/api/people')).body.find((p) => p.name === 'Casey');
  const { rewards } = (await api('GET', '/api/rewards')).body;
  const pricey = rewards.find((r) => r.cost > 2);
  const fail = await api('POST', `/api/rewards/${pricey.id}/redeem`, { person_id: casey.id }, '1234');
  assert.equal(fail.status, 400);
  const cheap = (await api('POST', '/api/rewards', { title: 'Sticker', cost: 2 }, '1234')).body.id;
  const ok = await api('POST', `/api/rewards/${cheap}/redeem`, { person_id: casey.id }, '1234');
  assert.equal(ok.body.balance, 0);
});

test('un-checking a chore needs the PIN', async () => {
  const chore = (await api('GET', '/api/chores?date=2026-09-29')).body.chores.find((c) => c.done);
  assert.equal((await api('DELETE', `/api/chores/${chore.id}/complete?date=2026-09-29`)).status, 401);
  assert.equal((await api('DELETE', `/api/chores/${chore.id}/complete?date=2026-09-29`, null, '1234')).status, 200);
});

test('meal ingredients flow onto the grocery list without duplicates', async () => {
  await api('PUT', '/api/meals/2026-09-29', { title: 'Chicken tacos', ingredients: ['Tortillas', 'Cilantro', 'tortillas'] });
  const lists = (await api('GET', '/api/lists')).body;
  await api('POST', `/api/lists/${lists[0].id}/items`, { text: 'Cilantro' });
  const r = await api('POST', '/api/meals/2026-09-29/to-list', {});
  assert.equal(r.body.added, 1);
  const items = (await api('GET', '/api/lists')).body[0].items.map((i) => i.text);
  assert.deepEqual(items.sort(), ['Cilantro', 'Tortillas']);
});

test('list items can be checked and cleared', async () => {
  const list = (await api('GET', '/api/lists')).body[0];
  await api('PATCH', `/api/items/${list.items[0].id}`, { done: true });
  const r = await api('POST', `/api/lists/${list.id}/clear-done`);
  assert.equal(r.body.removed, 1);
});

test('iCal parser expands weekly recurrence and keeps all-day dates', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:piano@test',
    'SUMMARY:Piano lesson',
    'DTSTART:20260901T220000Z',
    'DTEND:20260901T230000Z',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:trip@test',
    'SUMMARY:Camping',
    'DTSTART;VALUE=DATE:20261010',
    'DTEND;VALUE=DATE:20261012',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const out = parseIcs(ics, new Date('2026-09-29T12:00:00Z'));
  assert.equal(out.filter((e) => e.title === 'Piano lesson').length, 6);
  const camping = out.find((e) => e.title === 'Camping');
  assert.equal(camping.start, '2026-10-10');
  assert.equal(camping.all_day, 1);
});

test('SPA index is served even from a path containing a dot-directory', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  const dist = path.join(dir, '.hidden', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root"></div>');
  const app = createApp({ db, staticDir: dist, photoDir: dir });
  const srv = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/chores`);
  srv.close();
  assert.equal(res.status, 200);
  assert.match(await res.text(), /root/);
});

test('unknown API routes return JSON 404', async () => {
  const r = await api('GET', '/api/nope');
  assert.equal(r.status, 404);
});
