// Guards for server-side fetches of user-supplied URLs (recipe import), so nobody on the
// network can point Homebase at the router, other home services, or cloud metadata.
import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

// Non-public ranges. IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4)
// are blocked outright: a recipe site never needs them, and they're a classic filter bypass.
// Separate lists: a single BlockList also matches IPv4 against IPv6 rules via the mapped
// form, so ::ffff:0:0/96 would swallow every IPv4 address.
const BLOCKED4 = new net.BlockList();
const BLOCKED6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) BLOCKED4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED6.addSubnet(addr, prefix, 'ipv6');

/** True for loopback, private, link-local, CGNAT, unique-local, multicast and other non-public IPs. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED4.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return BLOCKED6.check(ip, 'ipv6');
  return true;
}

/**
 * An undici dispatcher whose DNS lookup refuses private answers, so the address that is
 * actually connected to is the one that was checked (no DNS-rebinding window).
 */
export function guardedAgent(lookup = dns.lookup) {
  return new Agent({
    connect: {
      lookup(hostname, options, cb) {
        lookup(hostname, { ...options, all: true }, (err, addrs) => {
          if (err) return cb(err);
          if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
            return cb(Object.assign(new Error('Refusing a private address'), { code: 'EPRIVATE' }));
          }
          return options?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
        });
      },
    },
  });
}

/** Cheap shape check: http(s), a dotted public-looking hostname, no IP literal in a private range. */
export function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(h)) return !isPrivateAddress(h);
  if (!h.includes('.')) return false; // dotless names (router, homeassistant) are LAN-only
  return !/\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(h) && h !== 'localhost';
}

async function assertPublicHost(url, lookup) {
  if (!isPublicHttpUrl(url)) throw Object.assign(new Error('Use a regular web link (http or https)'), { status: 400 });
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error('Couldn’t find that website'), { status: 400 });
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error('Use a regular web link (http or https)'), { status: 400 });
  }
}

/**
 * Fetches a user-supplied public URL: checks every redirect hop and caps the body size.
 * Pass `dispatcher: guardedAgent()` with the real fetch so the connection itself is pinned too.
 */
export async function fetchPublicText(fetchImpl, url, { lookup = dns.promises.lookup, dispatcher, maxBytes = 3_000_000, maxRedirects = 3, timeoutMs = 15000 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(current, lookup);
    const res = await fetchImpl(current, {
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 Homebase' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers?.get?.('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) throw Object.assign(new Error('Couldn’t open that page'), { status: 400 });
    const reader = res.body?.getReader?.();
    if (!reader) return (await res.text()).slice(0, maxBytes);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  throw Object.assign(new Error('That link redirects too many times'), { status: 400 });
}
