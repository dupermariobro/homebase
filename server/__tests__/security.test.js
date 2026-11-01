import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicText, isPrivateAddress, isPublicHttpUrl } from '../netguard.js';
import { looksLikeImage } from '../extras.js';
import { sendNtfy } from '../reminders.js';

const publicDns = async () => [{ address: '93.184.215.14', family: 4 }];
const page = (body, init) => new Response(body, init);

test('private, loopback, link-local and CGNAT addresses are recognized', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.100.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('LAN-style links are refused before any request', () => {
  for (const u of ['http://router/', 'http://homeassistant:8123', 'http://nas.local', 'http://box.lan', 'http://x.home.arpa', 'http://[::1]/', 'ftp://example.com', 'http://user:pw@example.com']) {
    assert.equal(isPublicHttpUrl(u), false, u);
  }
  assert.equal(isPublicHttpUrl('https://www.example.com/recipe'), true);
});

test('a public name that resolves to a private IP is refused', async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), page('x'));
  await assert.rejects(fetchPublicText(fetchImpl, 'https://sneaky.example/', { lookup: async () => [{ address: '192.168.1.1', family: 4 }] }), { status: 400 });
  assert.equal(called, false);
});

test('a redirect to the home network is refused', async () => {
  const fetchImpl = async (url) =>
    url.startsWith('https://recipes.example') ? page(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } }) : page('secret');
  await assert.rejects(fetchPublicText(fetchImpl, 'https://recipes.example/tacos', { lookup: publicDns }), { status: 400 });
});

test('page bodies are capped', async () => {
  const text = await fetchPublicText(async () => page('a'.repeat(5000)), 'https://recipes.example/', { lookup: publicDns, maxBytes: 1000 });
  assert.ok(text.length <= 1000);
});

test('uploads must really be images', () => {
  assert.equal(looksLikeImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), true);
  assert.equal(looksLikeImage(Buffer.from('<html><script>alert(1)</script></html>')), false);
});

test('the ntfy token only goes to the pinned ntfy server', async () => {
  process.env.HOMEBASE_NTFY_TOKEN = 'tk_test';
  process.env.HOMEBASE_NTFY_URL = 'https://ntfy.example.com';
  const seen = [];
  const fetchImpl = async (url, opts) => (seen.push({ url, auth: opts.headers.Authorization }), page('{}'));
  try {
    await sendNtfy(fetchImpl, 'https://ntfy.example.com', 'hb-a', { title: 't', message: 'm' });
    await sendNtfy(fetchImpl, 'https://attacker.example', 'hb-a', { title: 't', message: 'm' });
  } finally {
    delete process.env.HOMEBASE_NTFY_TOKEN;
    delete process.env.HOMEBASE_NTFY_URL;
  }
  assert.equal(seen[0].auth, 'Bearer tk_test');
  assert.equal(seen[1].auth, undefined);
});

test('IPv4 hidden inside IPv6 is refused in every spelling', () => {
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:c0a8:101::1]/']) {
    assert.equal(isPublicHttpUrl(u), false, u);
  }
});

test('the guarded connection refuses a name that resolves privately at connect time', async () => {
  const { guardedAgent } = await import('../netguard.js');
  const rebinding = (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(fetch('http://rebind.example/', { dispatcher: guardedAgent(rebinding) }));
});

test('a guessing swarm slows PIN checks but never locks the family out', async () => {
  const { createPinGuard } = await import('../pin.js');
  const guard = createPinGuard({ perClient: 8, total: 3, slowMs: 30 });
  for (let i = 0; i < 3; i++) guard.fail(`attacker-${i}`);
  assert.equal(guard.blocked('tablet'), false);
  const t0 = Date.now();
  const ran = await guard.pace(() => 'checked');
  assert.equal(ran, 'checked');
  assert.ok(Date.now() - t0 >= 25);
});
