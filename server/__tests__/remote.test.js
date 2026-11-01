import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, seed, setSetting } from '../db.js';
import { createApp } from '../app.js';
import { createPairCode, redeemPairCode } from '../remote.js';
import os from 'node:os';
import fs from 'node:fs';

const PIN = '5555';
const json = { 'content-type': 'application/json', 'x-homebase': '1' };
const parentJson = { ...json, 'x-parent-pin': PIN };

let db, home, remote, homeUrl, remoteUrl, photoDir;
const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
before(async () => {
  db = openDb(':memory:');
  seed(db);
  photoDir = fs.mkdtempSync(os.tmpdir() + '/hb-remote-');
  home = await listen(createApp({ db, photoDir }));
  remote = await listen(createApp({ db, photoDir, remote: true }));
  homeUrl = `http://127.0.0.1:${home.address().port}`;
  remoteUrl = `http://127.0.0.1:${remote.address().port}`;
  await fetch(`${homeUrl}/api/auth/pin`, { method: 'PUT', headers: json, body: JSON.stringify({ pin: PIN }) });
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
  const pair = await fetch(`${homeUrl}/api/devices/pair`, { method: 'POST', headers: parentJson }).then((r) => r.json());
  assert.match(pair.url, /^https:\/\/example\.ts\.net:8443\/pair#.{40,}$/);
  const code = pair.url.split('#')[1];
  const redeem = await fetch(`${remoteUrl}/api/pair/redeem`, { method: 'POST', headers: json, body: JSON.stringify({ code, name: 'Test phone' }) });
  assert.equal(redeem.status, 200);
  const cookie = redeem.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  const session = cookie.split(';')[0];
  assert.equal((await fetch(`${remoteUrl}/api/people`, { headers: { cookie: session } })).status, 200);
  // Single use
  const again = await fetch(`${remoteUrl}/api/pair/redeem`, { method: 'POST', headers: json, body: JSON.stringify({ code }) });
  assert.equal(again.status, 400);
  // Unlinking revokes access
  const { devices } = await fetch(`${homeUrl}/api/devices`, { headers: parentJson }).then((r) => r.json());
  await fetch(`${homeUrl}/api/devices/${devices[0].id}`, { method: 'DELETE', headers: parentJson });
  assert.equal((await fetch(`${remoteUrl}/api/people`, { headers: { cookie: session } })).status, 401);
});

test('phones can only be linked once a parent PIN exists', async () => {
  const fresh = openDb(':memory:');
  seed(fresh);
  setSetting(fresh, 'public_url', 'https://example.ts.net:8443');
  const s = await listen(createApp({ db: fresh, photoDir }));
  const r = await fetch(`http://127.0.0.1:${s.address().port}/api/devices/pair`, { method: 'POST', headers: json });
  s.close();
  assert.equal(r.status, 400);
});

test('pair codes expire after 15 minutes', () => {
  const { code } = createPairCode(db, Date.now() - 16 * 60 * 1000);
  assert.equal(redeemPairCode(db, code, 'late').status, 400);
});

test('writes without the X-Homebase header are refused (cross-site requests)', async () => {
  const r = await fetch(`${homeUrl}/api/notes`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 403);
});

test('the LAN listener refuses unknown Host names (DNS rebinding)', async () => {
  const get = (host) =>
    new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: home.address().port, path: '/api/people', headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
  assert.equal(await get('evil.example'), 403);
  assert.equal(await get('homebase.local'), 200);
  assert.equal(await get('192.168.1.20:4830'), 200);
});

test('wrong PIN guesses are rate limited, even with a forged X-Forwarded-For', async () => {
  let last;
  for (let i = 0; i < 10; i++) {
    last = await fetch(`${homeUrl}/api/auth/check`, {
      method: 'POST',
      headers: { ...json, 'x-forwarded-for': `203.0.113.${i}` },
      body: JSON.stringify({ pin: String(1000 + i) }),
    });
  }
  assert.equal(last.status, 429);
});
