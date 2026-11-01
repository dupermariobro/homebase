import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed, setSetting } from '../db.js';
import { createApp } from '../app.js';
import { createPairCode, redeemPairCode } from '../remote.js';
import os from 'node:os';
import fs from 'node:fs';

let db, home, remote, homeUrl, remoteUrl;
before(async () => {
  db = openDb(':memory:');
  seed(db);
  const photoDir = fs.mkdtempSync(os.tmpdir() + '/hb-remote-');
  const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
  home = await listen(createApp({ db, photoDir }));
  remote = await listen(createApp({ db, photoDir, remote: true }));
  homeUrl = `http://127.0.0.1:${home.address().port}`;
  remoteUrl = `http://127.0.0.1:${remote.address().port}`;
});
after(() => { home.close(); remote.close(); });

test('the public entrance hides everything from unpaired visitors', async () => {
  const api = await fetch(`${remoteUrl}/api/people`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).needsPairing, true);
  const page = await fetch(`${remoteUrl}/`);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /isn’t linked/);
  assert.equal((await fetch(`${remoteUrl}/photos/anything.jpg`)).status, 401);
  // Home network is unaffected.
  assert.equal((await fetch(`${homeUrl}/api/people`)).status, 200);
});

test('pairing: parent creates a one-time link; the phone redeems it for a cookie', async () => {
  setSetting(db, 'public_url', 'https://example.ts.net:8443');
  const pair = await fetch(`${homeUrl}/api/devices/pair`, { method: 'POST' }).then((r) => r.json());
  assert.match(pair.url, /^https:\/\/example\.ts\.net:8443\/pair#.{40,}$/);
  const code = pair.url.split('#')[1];
  const redeem = await fetch(`${remoteUrl}/api/pair/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Test phone' }) });
  assert.equal(redeem.status, 200);
  const cookie = redeem.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  const session = cookie.split(';')[0];
  assert.equal((await fetch(`${remoteUrl}/api/people`, { headers: { cookie: session } })).status, 200);
  // Single use
  const again = await fetch(`${remoteUrl}/api/pair/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(again.status, 400);
  // Unlinking revokes access
  const { devices } = await fetch(`${homeUrl}/api/devices`).then((r) => r.json());
  await fetch(`${homeUrl}/api/devices/${devices[0].id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${remoteUrl}/api/people`, { headers: { cookie: session } })).status, 401);
});

test('pair codes expire after 15 minutes', () => {
  const { code } = createPairCode(db, Date.now() - 16 * 60 * 1000);
  assert.equal(redeemPairCode(db, code, 'late').status, 400);
});

test('wrong PIN guesses are rate limited', async () => {
  await fetch(`${homeUrl}/api/auth/pin`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '5555' }) });
  let last;
  for (let i = 0; i < 10; i++) {
    last = await fetch(`${homeUrl}/api/auth/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: String(1000 + i) }) });
  }
  assert.equal(last.status, 429);
});
