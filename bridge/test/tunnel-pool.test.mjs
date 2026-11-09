import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture, request, SECRET } from './fixtures.mjs';
import { RELAY_CONNECTION_BYTES } from '../client.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms = 2000) { const end = Date.now() + ms; while (!check() && Date.now() < end) await wait(10); assert.ok(check()); }
function countPooled(f) {
  const counter = { pooled: 0, regular: 0 };
  f.relay.server.prependListener('upgrade', req => { if (req.headers['x-tunnel-pool'] === '1') counter.pooled++; else counter.regular++; });
  return counter;
}

test('pool is off by default: no pre-opened tunnels', async () => {
  const f = await fixture();
  const counter = countPooled(f);
  try {
    await f.client.checkRelay();
    for (let i = 0; i < 3; i++) assert.equal((await request(f)).status, 200);
    await wait(100);
    assert.equal(counter.pooled, 0);
    assert.equal(f.client.poolStats().opened, 0);
  } finally { await f.close(); }
});

test('with the flag, requests reuse pre-authenticated tunnels and the pool refills on demand', async () => {
  const f = await fixture({ clientOptions: { poolSize: 2 } });
  const counter = countPooled(f);
  try {
    await f.client.checkRelay(); // relay advertises pool support
    assert.equal((await request(f)).status, 200); // miss: regular fast-open, then fill
    await waitFor(() => f.client.poolStats().idle === 2);
    const regularBefore = counter.regular;
    assert.equal((await request(f)).status, 200);
    assert.equal((await request(f)).status, 200);
    assert.equal(counter.regular, regularBefore, 'served from the pool, no new regular tunnel');
    const stats = f.client.poolStats();
    assert.equal(stats.hits, 2);
    await waitFor(() => f.client.poolStats().idle === 2);
    assert.ok(counter.pooled <= 4, 'refill only replaces consumed entries');
  } finally { await f.close(); }
});

test('idle pool drains and is not refilled: no artificial keep-alive', async () => {
  const f = await fixture({ clientOptions: { poolSize: 2, poolIdleMs: 150 } });
  const counter = countPooled(f);
  try {
    await f.client.checkRelay();
    assert.equal((await request(f)).status, 200);
    await waitFor(() => f.client.poolStats().idle === 2);
    await wait(400);
    assert.equal(f.client.poolStats().idle, 0);
    assert.equal(f.client.poolStats().expired, 2);
    const opened = counter.pooled;
    await wait(400);
    assert.equal(counter.pooled, opened, 'nothing reopened without user activity');
    await waitFor(() => f.relay.usage().active === 0);
  } finally { await f.close(); }
});

test('relay keeps a pooled tunnel waiting up to idleMs but a regular one only connectMs', async () => {
  const f = await fixture({ relayOptions: { connectMs: 100, idleMs: 600 } });
  const open = headers => { const ws = new WebSocket(`wss://localhost:${f.relayPort}/tunnel`, { ca: fs.readFileSync(`${f.dir}/ca.pem`), headers: { Authorization: 'Bearer ' + SECRET, ...headers } }); ws.on('error', () => {}); return ws; };
  try {
    const regular = open({}), pooled = open({ 'X-Tunnel-Pool': '1' });
    await Promise.all([once(regular, 'open'), once(pooled, 'open')]);
    await once(regular, 'close'); // opening deadline (connectMs)
    await wait(200);
    assert.equal(pooled.readyState, WebSocket.OPEN, 'pooled tunnel survives connectMs');
    pooled.send(JSON.stringify({ host: 'localhost', port: f.httpPort }));
    const [data] = await once(pooled, 'message');
    assert.equal(JSON.parse(data.toString()).ready, true);
    pooled.terminate();
    const idle = open({ 'X-Tunnel-Pool': '1' }); await once(idle, 'open');
    const started = Date.now(); await once(idle, 'close');
    assert.ok(Date.now() - started >= 500, 'idle pooled tunnel closed by the relay after idleMs');
  } finally { await f.close(); }
});

test('pool respects the session ceiling, budget and cancellation', async () => {
  const held = new Set();
  const origin = net.createServer(socket => { held.add(socket); socket.on('error', () => {}); socket.on('data', c => socket.write(c)); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = origin.address().port;
  const events = [];
  const f = await fixture({ relayOptions: { ports: new Set([port]), diagnostic: e => events.push(e) }, clientOptions: { ports: new Set([port]), poolSize: 4, diagnostic() {} } });
  try {
    await f.client.checkRelay();
    const before = f.client.budget.used;
    const sockets = [];
    for (let i = 0; i < 30; i++) {
      const socket = net.connect(f.clientPort, '127.0.0.1'); socket.on('error', () => {});
      socket.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      sockets.push(socket);
    }
    await waitFor(() => f.relay.usage().active >= 26, 5000);
    await wait(200);
    assert.ok(f.relay.usage().active <= 30, `relay active ${f.relay.usage().active} within client 26 + pool 4`);
    assert.equal(events.filter(e => e.failure === 'SESSION_LIMIT').length, 0);
    const opened = f.client.poolStats().opened;
    assert.ok(opened > 0, 'pool was used under load');
    // Every relay connection, pooled or regular, carries its allowance.
    assert.ok(f.client.budget.used - before >= (26 + opened - f.client.poolStats().hits) * RELAY_CONNECTION_BYTES, 'pooled tunnels are charged');
    for (const socket of sockets) socket.destroy(); // cancellation
    await waitFor(() => f.relay.usage().active <= f.client.poolStats().idle, 4000);
  } finally {
    for (const socket of held) socket.destroy();
    await f.close(); await new Promise(resolve => origin.close(resolve));
  }
});
