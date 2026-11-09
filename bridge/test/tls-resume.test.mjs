import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixture, request } from './fixtures.mjs';
import { preferFamily } from '../tls-resume.mjs';

// The relay name resolves IPv6-first but IPv6 is unusable (nothing listens
// on ::1): every connection needs the Happy Eyeballs fallback to IPv4.
const brokenIPv6First = (_host, options, callback) => {
  const rows = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
  if (options?.all) callback(null, rows); else callback(null, rows[1].address, 4);
};
const seen = [];
async function handshakes(clientOptions, rounds = 4, between) {
  const f = await fixture({ clientOptions: { relayLookup: brokenIPv6First, ...clientOptions } });
  seen.length = 0;
  f.relay.server.on('secureConnection', socket => seen.push({ reused: socket.isSessionReused(), protocol: socket.getProtocol() }));
  try {
    for (let i = 0; i < rounds; i++) {
      await between?.(f, i);
      assert.equal((await request(f)).status, 200);
      await new Promise(resolve => setTimeout(resolve, 50)); // let the ticket arrive
    }
    return { seen, stats: f.client.tlsStats() };
  } finally { await f.close(); }
}

test('without the sticky family, fallback loses TLS tickets: every tunnel is a full handshake', async () => {
  const { seen, stats } = await handshakes({ stickyFamily: false });
  assert.ok(seen.length >= 4, 'one TLS connection per tunnel (plus cancellation requests)');
  assert.ok(seen.every(s => !s.reused), JSON.stringify(seen));
  assert.equal(stats.resumed, 0);
});

test('second and later WSS tunnels resume the TLS 1.3 session once the working family is remembered', async () => {
  const { seen, stats } = await handshakes({});
  assert.ok(seen.every(s => s.protocol === 'TLSv1.3'), 'TLS 1.3 is negotiated (minVersion unchanged)');
  // 1st: Happy Eyeballs fallback (ticket lost, family learned).
  // 2nd: direct IPv4, full handshake, ticket stored. 3rd onward: resumed.
  assert.deepEqual(seen.slice(0, 2).map(s => s.reused), [false, false]);
  assert.ok(seen.slice(2).length >= 2 && seen.slice(2).every(s => s.reused), JSON.stringify(seen));
  assert.equal(stats.full, 2); assert.equal(stats.resumed, seen.length - 2);
});

test('a rejected resumption falls back to a full handshake and the tunnel still works', async () => {
  let rotatedAt;
  await handshakes({}, 6, (f, round) => {
    if (round === 3) { rotatedAt = seen.length; f.relay.server.setTicketKeys(crypto.randomBytes(48)); } // server forgets every ticket
  });
  assert.ok(seen.slice(2, rotatedAt).every(s => s.reused), 'resumed before rotation');
  assert.equal(seen[rotatedAt].reused, false, 'stale ticket rejected => full handshake, request still 200');
  assert.ok(seen.slice(rotatedAt + 1).some(s => s.reused), 'resumption recovers with the new ticket');
});

test('preferFamily keeps every address and only reorders', () => {
  const rows = [{ address: '::1', family: 6 }, { address: '1.1.1.1', family: 4 }, { address: '::2', family: 6 }];
  assert.deepEqual(preferFamily(rows, 4).map(r => r.address), ['1.1.1.1', '::1', '::2']);
  assert.deepEqual(preferFamily(rows, undefined), rows);
});
