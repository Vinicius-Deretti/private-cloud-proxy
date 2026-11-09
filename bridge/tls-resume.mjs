import https from 'node:https';
import dns from 'node:dns';

// TLS session resumption for relay connections (WSS tunnels, /usage, DELETE).
//
// Measured in this repository (bridge/test/tls-resume.test.mjs): Node's
// https.Agent already caches TLS sessions and resumes them on new WSS
// tunnels, but only when the first address tried for the relay connects.
// When Happy Eyeballs (autoSelectFamily) falls back to another address — e.g.
// the relay name resolves to IPv6 first and IPv6 is broken on the user's
// network — the TLS socket never emits 'session', so the cache stays empty
// and every tunnel pays (a) the failed attempt (autoSelectFamilyAttemptTimeout,
// 250 ms default) and (b) a full TLS handshake.
//
// This agent remembers the address family that last completed a TLS
// handshake for each relay host and orders DNS answers to try it first.
// Every address is still offered, so a family change still falls back.
// TLS verification (ca, rejectUnauthorized, minVersion) is untouched; the
// built-in cache evicts a session whose connection errors, so a rejected
// resumption simply becomes a full handshake.
export const STICKY_FAMILY_DEFAULT = true;

export function preferFamily(addresses, family) {
  if (!family) return addresses;
  return [...addresses.filter(a => a.family === family), ...addresses.filter(a => a.family !== family)];
}

export class RelayAgent extends https.Agent {
  constructor({ stickyFamily = STICKY_FAMILY_DEFAULT, lookup = dns.lookup, ...options } = {}) {
    super(options);
    this.stickyFamily = stickyFamily;
    this.baseLookup = lookup;
    this.families = new Map();
    this.tlsStats = { full: 0, resumed: 0 };
  }
  createConnection(options, callback) {
    const host = options.host;
    const effective = this.stickyFamily && !options.lookup ? { ...options, lookup: (hostname, lookupOptions, done) => {
      this.baseLookup(hostname, lookupOptions, (error, address, family) => {
        if (error || !lookupOptions?.all || !Array.isArray(address)) return done(error, address, family);
        done(null, preferFamily(address, this.families.get(host)));
      });
    } } : options;
    const watch = socket => {
      if (!socket || socket.__relayWatched) return socket;
      socket.__relayWatched = true;
      socket.once('secureConnect', () => {
        if (socket.isSessionReused?.()) this.tlsStats.resumed++; else this.tlsStats.full++;
        const family = socket.remoteFamily === 'IPv6' ? 6 : socket.remoteFamily === 'IPv4' ? 4 : undefined;
        if (family) this.families.set(host, family);
      });
      return socket;
    };
    const wrapped = typeof callback === 'function' ? (error, socket) => { watch(socket); callback(error, socket); } : callback;
    return watch(super.createConnection(effective, wrapped));
  }
}
