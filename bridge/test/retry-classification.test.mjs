import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { fixture, request, SECRET } from './fixtures.mjs';
import { connectPinned } from '../connect.mjs';
import { DESTINATION_RETRIES, retryableVerdict, retryDelayMs } from '../client.mjs';

const RETRYING = { attempts: 8, retryMs: 10, connectWindowMs: 10_000 };
const failingSocket = code => { const socket = new net.Socket(); process.nextTick(() => socket.destroy(Object.assign(new Error(code), { code }))); return socket; };

async function scenario({ relayOptions = {}, clientOptions = {}, originHandler } = {}) {
  const f = await fixture({ relayOptions, clientOptions: { ...RETRYING, ...clientOptions }, originHandler });
  let upgrades = 0;
  f.relay.server.prependListener('upgrade', () => upgrades++);
  try { const response = await request(f).catch(() => ({ status: 'error' })); return { status: response.status, upgrades }; }
  finally { await f.close(); }
}
// Fails `times` times with `make()`, then behaves normally.
const flaky = (times, make, normal) => { let calls = 0; return (...args) => (++calls <= times ? make(...args) : normal(...args)); };

test('verdict classification table', () => {
  assert.equal(retryableVerdict('DNS_FAILED', 'EAI_AGAIN'), true);
  assert.equal(retryableVerdict('DNS_FAILED', 'ETIMEDOUT'), true);
  assert.equal(retryableVerdict('DNS_FAILED', undefined), true, 'older relays send no code');
  assert.equal(retryableVerdict('DNS_FAILED', 'ENOTFOUND'), false, 'NXDOMAIN is authoritative');
  assert.equal(retryableVerdict('TCP_CONNECT_TIMEOUT', 'ETIMEDOUT'), true);
  assert.equal(retryableVerdict('NETWORK_UNREACHABLE', 'ENETUNREACH'), true);
  for (const failure of ['DNS_REJECTED', 'AUTH_FAILED', 'TRAFFIC_LIMIT', 'TCP_CONNECTION_REFUSED', 'INTERNAL_ERROR'])
    assert.equal(retryableVerdict(failure, 'OTHER'), false, failure);
  assert.deepEqual([0, 1].map(n => retryDelayMs('DNS_FAILED', n, 1000, 10_000, Math.random, true)), [250, 500]);
});

for (const [name, relayOptions] of [
  ['DNS_FAILED (temporary resolver failure)', { resolve: flaky(1, async () => { throw Object.assign(new Error(), { code: 'EAI_AGAIN' }); }, async () => '127.0.0.1') }],
  ['TCP_CONNECT_TIMEOUT', { connect: flaky(1, () => failingSocket('ETIMEDOUT'), connectPinned) }],
  ['NETWORK_UNREACHABLE', { connect: flaky(1, () => failingSocket('ENETUNREACH'), connectPinned) }],
]) test(`${name} is retried within the deadline`, async () => {
  const { status, upgrades } = await scenario({ relayOptions });
  assert.equal(status, 200); assert.equal(upgrades, 2);
});

test('persistent transient destination failures stop after DESTINATION_RETRIES', async () => {
  const { status, upgrades } = await scenario({ relayOptions: { connect: () => failingSocket('ETIMEDOUT') } });
  assert.equal(status, 502); assert.equal(upgrades, 1 + DESTINATION_RETRIES);
});

for (const [name, options] of [
  ['NXDOMAIN', { relayOptions: { resolve: async () => { throw Object.assign(new Error(), { code: 'ENOTFOUND' }); } } }],
  ['AUTH_FAILED', { clientOptions: { secret: SECRET + 'wrong' } }],
  ['policy DNS_REJECTED', { relayOptions: { resolve: async () => { throw Object.assign(new Error(), { code: 'DNS_REJECTED' }); } } }],
  ['TRAFFIC_LIMIT (relay quota)', { relayOptions: { processBytes: 1000 } }],
  ['TCP_CONNECTION_REFUSED', { relayOptions: { connect: () => failingSocket('ECONNREFUSED') } }],
]) test(`${name} is definitive: one attempt, no retry`, async () => {
  const { status, upgrades } = await scenario(options);
  assert.equal(status, 502); assert.equal(upgrades, 1);
});

test('tunnel closed after the verdict but before any data is retried', async () => {
  const f = await fixture({ clientOptions: RETRYING });
  const [realUpgrade] = f.relay.server.listeners('upgrade');
  f.relay.server.removeAllListeners('upgrade');
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  f.relay.server.on('upgrade', (req, socket, head) => {
    if (++upgrades > 1) return realUpgrade(req, socket, head);
    // Ready, then closed in the same flight: nothing reached the browser yet.
    wss.handleUpgrade(req, socket, head, ws => { ws.send(JSON.stringify({ ready: true, id: '00000000-0000-4000-8000-000000000000' })); ws.close(1011); });
  });
  try { assert.equal((await request(f)).status, 200); assert.equal(upgrades, 2); }
  finally { wss.close(); await f.close(); }
});

const CRLF = '\r\n';
test('failures after data flowed are never retried', async () => {
  // CONNECT tunnel: bytes flow both ways, then the origin resets.
  const origin = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', () => { socket.write('server-bytes'); setTimeout(() => socket.resetAndDestroy(), 20); }); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = origin.address().port;
  const f = await fixture({ relayOptions: { ports: new Set([port]) }, clientOptions: { ...RETRYING, ports: new Set([port]) } });
  let upgrades = 0;
  f.relay.server.prependListener('upgrade', () => upgrades++);
  try {
    const socket = net.connect(f.clientPort, '127.0.0.1'); socket.on('error', () => {});
    socket.write(`CONNECT localhost:${port} HTTP/1.1${CRLF}Host: localhost${CRLF}${CRLF}`);
    let received = '', sent = false;
    socket.on('data', chunk => { received += chunk; if (!sent && received.includes(CRLF + CRLF)) { sent = true; socket.write('client-bytes'); } });
    await new Promise(resolve => socket.once('close', resolve));
    assert.match(received, /server-bytes/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(upgrades, 1, 'no new tunnel after data flowed');
  } finally { await f.close(); await new Promise(resolve => origin.close(resolve)); }
});
