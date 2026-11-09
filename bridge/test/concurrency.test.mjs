import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fixture } from './fixtures.mjs';
import { RELAY_MAX_SESSIONS, POOL_MAX_TUNNELS, CLOSING_HEADROOM, CLIENT_MAX_SESSIONS } from '../limits.mjs';

const CRLF = '\r\n';

test('client and relay limits are coherent and leave room for the pool', () => {
  assert.equal(CLIENT_MAX_SESSIONS + POOL_MAX_TUNNELS + CLOSING_HEADROOM, RELAY_MAX_SESSIONS);
  assert.ok(CLIENT_MAX_SESSIONS > 24, 'raised from the previous 24');
});

test('simultaneous load up to and beyond the client ceiling never trips the relay limit', async () => {
  const held = new Set();
  const origin = net.createServer(socket => { held.add(socket); socket.on('error', () => {}); socket.on('data', chunk => socket.write(chunk)); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = origin.address().port;
  const events = [];
  // Production defaults on both ends; only the test origin port is allowed in.
  const f = await fixture({ relayOptions: { ports: new Set([port]), diagnostic: event => events.push(event) },
    clientOptions: { ports: new Set([port]), diagnostic: () => {} } });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, f.relay.usage().active); }, 2);
  const open = () => new Promise((resolve, reject) => {
    const socket = net.connect(f.clientPort, '127.0.0.1');
    socket.on('error', () => {});
    socket.write(`CONNECT localhost:${port} HTTP/1.1${CRLF}Host: localhost${CRLF}${CRLF}`);
    socket.once('data', chunk => (/^HTTP\/1\.1 200/.test(chunk.toString()) ? resolve(socket) : reject(new Error(chunk.toString()))));
  });
  const extra = 6;
  try {
    const all = Array.from({ length: CLIENT_MAX_SESSIONS + extra }, open);
    const settled = new Array(all.length).fill(false);
    all.forEach((p, i) => p.then(() => { settled[i] = true; }, () => {}));
    const first = await Promise.all(all.slice(0, CLIENT_MAX_SESSIONS));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.relay.usage().active, CLIENT_MAX_SESSIONS, 'exactly the client ceiling is open remotely');
    assert.equal(settled.filter(Boolean).length, CLIENT_MAX_SESSIONS, 'the rest wait in the local queue, not at the relay');
    // Echo check on every open tunnel.
    await Promise.all(first.map((socket, i) => new Promise(resolve => { socket.once('data', d => { assert.equal(d.toString(), `ping${i}`); resolve(); }); socket.write(`ping${i}`); })));
    for (const socket of first.slice(0, extra)) socket.destroy(); // free slots: the queued ones proceed
    const rest = await Promise.all(all.slice(CLIENT_MAX_SESSIONS));
    assert.equal(rest.length, extra);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(peak <= RELAY_MAX_SESSIONS - POOL_MAX_TUNNELS, `relay peak ${peak} must leave the pool reservation free`);
    assert.equal(events.filter(e => ['SESSION_LIMIT', 'SESSION_QUOTA'].includes(e.failure)).length, 0, 'relay never refused a session');
    for (const socket of [...first, ...rest]) socket.destroy();
  } finally {
    clearInterval(sampler);
    for (const socket of held) socket.destroy();
    await f.close(); await new Promise(resolve => origin.close(resolve));
  }
});
