import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed } from '../db.js';
import { createApp } from '../app.js';

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  seed(db);
  const os = await import('node:os');
  const fs = await import('node:fs');
  const photoDir = fs.mkdtempSync(os.tmpdir() + '/hb-photos-');
  // No real weather calls in the test: a fetch stub that always fails → weather is null.
  const app = createApp({ db, photoDir, fetchImpl: async () => { throw new Error('offline'); } });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, ct: res.headers.get('content-type') || '', body: res };
};

test('ambient payload bundles the whole family board in one read', async () => {
  const res = await fetch(base + '/api/tv/ambient');
  assert.equal(res.status, 200);
  const d = await res.json();
  // shape
  for (const k of ['now', 'settings', 'people', 'chores', 'events', 'meals', 'notes', 'countdowns', 'birthdays']) {
    assert.ok(k in d, `missing ${k}`);
  }
  assert.match(d.now.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(d.people) && d.people.length >= 1);
  // never leak the secret iCal URL or ntfy topic to the TV
  assert.ok(d.people.every((p) => !('ical_url' in p) && !('ntfy_topic' in p)));
  // chores progress rows carry done/total and are for non-calendar people
  assert.ok(Array.isArray(d.chores));
  for (const c of d.chores) {
    assert.ok(Number.isInteger(c.done) && Number.isInteger(c.total));
    assert.ok(c.done <= c.total || c.total === 0);
  }
  // events split into today / upcoming arrays
  assert.ok(Array.isArray(d.events.today) && Array.isArray(d.events.upcoming));
  // weather is null when the upstream call fails, rather than erroring the whole payload
  assert.equal(d.weather, null);
});

test('ambient page is served as self-contained HTML', async () => {
  const { status, ct, body } = await get('/tv/ambient');
  assert.equal(status, 200);
  assert.match(ct, /text\/html/);
  const html = await body.text();
  assert.match(html, /Homebase/);
  assert.match(html, /\/api\/tv\/ambient/); // the page fetches the aggregate endpoint
  assert.ok(!/<script src=/.test(html), 'should have no external scripts (light for Pi/TV)');
});

test('a Homebase announcement shows up in the ambient notes', async () => {
  await fetch(base + '/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-homebase': '1' },
    body: JSON.stringify({ text: 'Soccer carpool moved to 5pm' }),
  });
  const d = await (await fetch(base + '/api/tv/ambient')).json();
  assert.ok(d.notes.some((n) => n.text === 'Soccer carpool moved to 5pm'));
});
