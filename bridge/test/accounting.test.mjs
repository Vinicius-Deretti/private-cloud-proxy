import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { fixture, httpsViaProxy, SECRET } from './fixtures.mjs';
import { createLocalProxy, RELAY_CONNECTION_BYTES } from '../client.mjs';
import { Budget } from '../budget.mjs';

// TCP proxy in front of the relay that counts every byte on the wire
// (TLS records, WebSocket frames, HTTP upgrade): the ground truth.
async function wireCounter(targetPort) {
  const counter = { bytes: 0, connections: 0 };
  const sockets = new Set();
  const server = net.createServer(socket => {
    counter.connections++;
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const s of [socket, upstream]) { sockets.add(s); s.on('error', () => {}); s.on('data', chunk => { counter.bytes += chunk.length; }); }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  counter.port = server.address().port;
  counter.close = () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(resolve); });
  return counter;
}
function client(f, port, options = {}) {
  return createLocalProxy({ endpoint: `wss://localhost:${port}/tunnel`, secret: SECRET, ca: fs.readFileSync(`${f.dir}/ca.pem`),
    ports: new Set([80, 443, f.httpPort, f.httpsPort]), attempts: 1, openTimeoutMs: 1500, budget: new Budget(), diagnostic() {}, ...options });
}
const get = (port, url, method = 'GET', body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: body ? { 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

test('failures before TCP reaches the relay cost nothing, regardless of retries', async () => {
  const f = await fixture();
  const closed = net.createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const proxy = client(f, deadPort, { attempts: 4, retryMs: 5 });
  try {
    const port = await proxy.listen();
    assert.equal((await get(port, `http://x.invalid:${f.httpPort}/hello`)).status, 502);
    await assert.rejects(proxy.checkRelay({ timeoutMs: 2000 }));
    await settle();
    // Only the control request allowance of the failed /usage probe remains.
    assert.ok(proxy.budget.used <= 2048, `used=${proxy.budget.used}; previously 4 attempts x 8192 + 8192`);
  } finally { await proxy.close(); await f.close(); }
});

test('real traffic is never undercounted: budget >= bytes on the wire', async () => {
  const f = await fixture({ originHandler: (req, res) => {
    if (req.url !== '/big') return false;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.alloc(256 * 1024, 7)); return true;
  } });
  const wire = await wireCounter(f.relayPort);
  const proxy = client(f, wire.port);
  try {
    const port = await proxy.listen();
    await proxy.checkRelay({ timeoutMs: 5000 });
    await proxy.checkRelay({ timeoutMs: 5000 }); // keep-alive reuse: no new handshake
    assert.equal((await get(port, `http://x.invalid:${f.httpPort}/big`)).body.length, 256 * 1024);
    assert.equal((await get(port, `http://x.invalid:${f.httpPort}/echo`, 'POST', 'u'.repeat(64 * 1024))).body.length, 64 * 1024);
    const https = await httpsViaProxy({ dir: f.dir, clientPort: port, httpsPort: f.httpsPort });
    assert.equal(https.stdout, 'bridge-origin-ok');
    await settle();
    const used = proxy.budget.used;
    assert.ok(used >= wire.bytes, `undercount: budget ${used} < wire ${wire.bytes}`);
    // Precision: the allowance is bounded (not an arbitrary overcharge).
    assert.ok(used <= wire.bytes * 1.25 + wire.connections * RELAY_CONNECTION_BYTES, `budget ${used} vs wire ${wire.bytes} over ${wire.connections} connections`);
    console.log(JSON.stringify({ scenario: 'mixed', wireBytes: wire.bytes, budgetBytes: used, ratio: +(used / wire.bytes).toFixed(3), connections: wire.connections }));
  } finally { await proxy.close(); await wire.close(); await f.close(); }
});

test('cold-start failures after TCP stay charged and never below the wire', async () => {
  const f = await fixture();
  const wire = await wireCounter(f.relayPort);
  const [upgrade] = f.relay.server.listeners('upgrade'); f.relay.server.removeAllListeners('upgrade');
  let calls = 0;
  f.relay.server.on('upgrade', (req, socket, head) => {
    if (++calls <= 2) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else upgrade(req, socket, head);
  });
  const proxy = client(f, wire.port, { attempts: 4, retryMs: 5 });
  try {
    const port = await proxy.listen();
    assert.equal((await get(port, `http://x.invalid:${f.httpPort}/hello`)).status, 200);
    await settle();
    assert.equal(calls, 3);
    assert.ok(proxy.budget.used >= wire.bytes, `undercount: budget ${proxy.budget.used} < wire ${wire.bytes}`);
    assert.ok(proxy.budget.used >= 3 * RELAY_CONNECTION_BYTES, 'each TCP-connected attempt keeps its allowance');
    console.log(JSON.stringify({ scenario: 'cold-start x2', wireBytes: wire.bytes, budgetBytes: proxy.budget.used }));
  } finally { await proxy.close(); await wire.close(); await f.close(); }
});

test('refund lowers only the in-memory count, never the persisted ledger', () => {
  const dir = fs.mkdtempSync(`${process.env.TEMP || '/tmp'}/refund-`);
  try {
    const file = `${dir}/usage.json`;
    const budget = new Budget({ limit: 100, file });
    budget.consume(50); budget.refund(30);
    assert.equal(budget.used, 20);
    assert.equal(new Budget({ limit: 100, file }).used, 50, 'restart stays conservative');
    assert.throws(() => budget.refund(21)); assert.throws(() => budget.refund(-1));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
