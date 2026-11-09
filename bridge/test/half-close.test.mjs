import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture, listen, SECRET } from './fixtures.mjs';

const PAYLOAD = Buffer.alloc(256 * 1024, 'z'); // several WS frames and buffers

// Raw TCP origin that supports half-open sockets.
async function rawOrigin(onSocket) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => { sockets.add(socket); socket.on('error', () => {}); onSocket(socket); });
  const port = await listen(server);
  return { port, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}
async function openConnect(f, port) {
  const socket = net.connect({ port: f.clientPort, host: '127.0.0.1', allowHalfOpen: true });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  // The 200 reply and early origin bytes may share a chunk: keep the rest.
  const buffered = await new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.indexOf('\r\n\r\n') >= 0) { socket.off('data', onData); socket.pause(); resolve(data); }
    };
    socket.on('data', onData); socket.once('error', reject);
  });
  const split = buffered.indexOf('\r\n\r\n') + 4;
  assert.match(buffered.subarray(0, split).toString(), /^HTTP\/1\.1 200/);
  socket.leftover = buffered.subarray(split);
  return socket;
}
function readAll(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [socket.leftover ?? Buffer.alloc(0)]; socket.on('data', c => chunks.push(c)); socket.resume();
    socket.once('end', () => resolve(Buffer.concat(chunks))); socket.once('error', reject);
  });
}
const withPort = (port, extra = {}) => ({ relayOptions: { ports: new Set([port]), ...extra.relay }, clientOptions: { ports: new Set([port]), ...extra.client } });

test('local write-side close keeps reading until the end and propagates EOF to the origin', async () => {
  let originSawEof = false;
  const origin = await rawOrigin(socket => {
    const chunks = [];
    socket.on('data', c => chunks.push(c));
    // Responds only after EOF: impossible unless the half-close reached it.
    socket.on('end', () => { originSawEof = true; socket.write(`got:${Buffer.concat(chunks)}|`); socket.end(PAYLOAD); });
  });
  const f = await fixture(withPort(origin.port));
  try {
    const socket = await openConnect(f, origin.port);
    const body = readAll(socket);
    socket.end('hello'); // FIN on the local write side only
    const received = await body;
    assert.ok(originSawEof, 'origin must observe the local half-close');
    assert.equal(received.subarray(0, 10).toString(), 'got:hello|');
    assert.equal(received.length, 10 + PAYLOAD.length, 'downstream must be delivered completely after the local FIN');
  } finally { await f.close(); await origin.close(); }
});

test('origin write-side close still lets the local side send until it finishes', async () => {
  let late;
  const lateReceived = new Promise(resolve => { late = resolve; });
  const origin = await rawOrigin(socket => {
    const chunks = [];
    socket.end('banner'); // origin half-closes first
    socket.on('data', c => chunks.push(c)); socket.on('end', () => late(Buffer.concat(chunks).toString()));
  });
  const f = await fixture(withPort(origin.port));
  try {
    const socket = await openConnect(f, origin.port);
    const received = await readAll(socket);
    assert.equal(received.toString(), 'banner');
    socket.end('late-upload');
    assert.equal(await lateReceived, 'late-upload', 'upstream must keep flowing after the remote FIN');
  } finally { await f.close(); await origin.close(); }
});

test('legacy relay without half-close support: a local FIN no longer cuts the response', async () => {
  const origin = await rawOrigin(socket => {
    socket.once('data', () => setTimeout(() => socket.end(PAYLOAD), 50));
  });
  const f = await fixture(withPort(origin.port, { relay: { halfClose: false } }));
  try {
    const socket = await openConnect(f, origin.port);
    const body = readAll(socket);
    socket.end('request'); // previously tore the whole tunnel down
    assert.equal((await body).length, PAYLOAD.length);
  } finally { await f.close(); await origin.close(); }
});

test('relay negotiates half-close only when the client asks and rejects unknown text frames', async () => {
  const origin = await rawOrigin(socket => socket.resume());
  const f = await fixture(withPort(origin.port));
  const open = async headers => {
    const ws = new WebSocket(`wss://localhost:${f.relayPort}/tunnel`, { ca: fs.readFileSync(`${f.dir}/ca.pem`), headers: { Authorization: 'Bearer ' + SECRET, ...headers } });
    ws.on('error', () => {}); await once(ws, 'open');
    ws.send(JSON.stringify({ host: 'localhost', port: origin.port }));
    const [data] = await once(ws, 'message');
    return { ws, verdict: JSON.parse(data.toString()) };
  };
  try {
    const legacy = await open({});
    assert.equal(legacy.verdict.ready, true); assert.equal(legacy.verdict.halfClose, undefined);
    legacy.ws.terminate();
    const modern = await open({ 'X-Tunnel-Half-Close': '1' });
    assert.equal(modern.verdict.halfClose, true);
    const closed = once(modern.ws, 'close');
    modern.ws.send('not-eof');
    const [code] = await closed;
    assert.notEqual(code, 1000, 'protocol violation must not look like a clean close');
  } finally { await f.close(); await origin.close(); }
});
