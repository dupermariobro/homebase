// Guards for server-side fetches of user-supplied URLs (recipe import), so nobody on the
// network can point Homebase at the router, other home services, or cloud metadata.
import dns from 'node:dns';
import net from 'node:net';

/** True for loopback, private, link-local, CGNAT, unique-local, multicast and other non-public IPs. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
  }
  return true;
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
 * Fetches a user-supplied public URL: re-checks every redirect hop, caps the body size.
 * (A host could still flip DNS between our lookup and the connection; the redirect and
 * shape checks keep the common tricks out, and the body never reaches the client raw.)
 */
export async function fetchPublicText(fetchImpl, url, { lookup = dns.promises.lookup, maxBytes = 3_000_000, maxRedirects = 3, timeoutMs = 15000 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(current, lookup);
    const res = await fetchImpl(current, {
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
