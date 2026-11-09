import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import specials from './data/iana-special.json' with {type:'json'};
const globalIPv6 = ipaddr.parseCIDR('2000::/3');
const denied = specials.entries.flatMap(entry=>entry.prefixes.map(prefix=>ipaddr.parseCIDR(prefix)));

export function isPublic(address) {
  try {
    // Only native, globally routable unicast. Reject transition/mapped formats.
    const ip = ipaddr.parse(address);
    return !address.includes('%') && ip.range() === 'unicast' && (ip.kind()==='ipv4' || ip.match(...globalIPv6)) && !denied.some(([network,bits])=>network.kind()===ip.kind() && ip.match(network,bits));
  } catch { return false; }
}

export function target(host, port, ports = new Set([80, 443])) {
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s/@?#\\\x00-\x1f]/.test(host) || !ports.has(port)) throw new Error('Destination denied');
  // Real-world DNS names may contain '_' (CDN/SaaS hosts, e.g. a_b.example.com).
  // This only widens the hostname syntax; resolved addresses are still
  // validated (public unicast only) before any socket is opened.
  if (!net.isIP(host) && !host.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label))) throw new Error('Invalid hostname');
  return { host, port };
}

export async function resolvePublicAddresses(host, lookup = dns.lookup) {
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => !isPublic(row.address))) throw Object.assign(new Error('Destination denied'), {code:'DNS_REJECTED'});
  // Validate the entire snapshot before making any candidate available.
  return [...new Set(addresses.map(row => row.address))].sort((a,b)=>net.isIP(a)-net.isIP(b));
}

export async function resolvePublic(host, lookup = dns.lookup) {
  return (await resolvePublicAddresses(host, lookup))[0];
}

// Cache only fully validated public snapshots. No negative or mixed private
// answers are retained. A brief bounded TTL helps CDN-heavy pages while
// retaining pinned numeric addresses for every socket, with no re-resolution
// between policy checks and TCP connect.
export function createCachedPublicResolver({ resolve = resolvePublicAddresses, ttlMs = 20_000,
  maxEntries = 128, now = Date.now } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new Error('Invalid DNS cache configuration');
  const cache = new Map(), pending = new Map();
  return async function resolveCached(host) {
    const key = host.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      cache.delete(key); cache.set(key, cached); // bounded LRU
      return [...cached.addresses];
    }
    cache.delete(key);
    if (pending.has(key)) return [...await pending.get(key)];
    const job = (async () => {
      const addresses = await resolve(host);
      if (!Array.isArray(addresses) || addresses.length === 0 ||
          addresses.some(address => typeof address !== 'string' || !isPublic(address)))
        throw Object.assign(new Error('Destination denied'), { code: 'DNS_REJECTED' });
      const snapshot = Object.freeze([...new Set(addresses)]);
      if (ttlMs > 0) {
        cache.set(key, { addresses: snapshot, expiresAt: now() + ttlMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return snapshot;
    })();
    pending.set(key, job);
    try { return [...await job]; }
    finally { pending.delete(key); }
  };
}
