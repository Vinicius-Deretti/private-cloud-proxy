import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRelay } from '../server.mjs';
import { createLocalProxy } from '../client.mjs';
import { resolvePublicAddresses } from '../policy.mjs';
export const run = promisify(execFile);
export const SECRET = 'test-secret-only-32-random-characters';
export async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
export async function fixture({ secured = false, relayOptions = {}, clientOptions = {}, originHandler, originUpgrade } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-bridge-'));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=WSS Test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign');
  openssl('req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=localhost');
  fs.writeFileSync(path.join(dir,'ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n');
  openssl('x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days','1','-extfile','ext');
  const tls = { key: fs.readFileSync(path.join(dir,'leaf.key')), cert: fs.readFileSync(path.join(dir,'leaf.pem')) };
  let hits = 0; const lookups = [];
  const handler = (req, res) => {
    hits++;
    if(originHandler?.(req,res))return;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/hello' }); res.end(); return; }
    const chunks=[]; req.on('data', c => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'Content-Type':'text/plain' }); res.end(req.method === 'POST' ? Buffer.concat(chunks) : req.url === '/large' ? 'x'.repeat(32768) : 'bridge-origin-ok'); });
  };
  const origin = http.createServer(handler), secureOrigin = https.createServer(tls, handler);
  if (originUpgrade) origin.on('upgrade', originUpgrade);
  const httpPort = await listen(origin), httpsPort = await listen(secureOrigin);
  const ports = new Set([80, 443, httpPort, httpsPort]);
  const makeRelay = () => createRelay({ secret: SECRET, server: https.createServer(tls), ports,
    resolve: secured ? resolvePublicAddresses : async host => { lookups.push(host); return '127.0.0.1'; }, ...relayOptions });
  let relay = makeRelay();
  const relayPort = await listen(relay.server);
  const client = createLocalProxy({ endpoint: `wss://localhost:${relayPort}/tunnel`, secret: SECRET,
    ca: fs.readFileSync(path.join(dir,'ca.pem')), ports, attempts: 1, openTimeoutMs: 1500, ...clientOptions });
  const clientPort = await client.listen();
  return { dir, tls, get relay() { return relay; }, client, clientPort, relayPort, httpPort, httpsPort, lookups,
    async restartRelay() { await relay.close(); relay = makeRelay(); await new Promise(resolve => relay.server.listen(relayPort, '127.0.0.1', resolve)); },
    hits: () => hits,
    async close() {
      await client.close(); await relay.close();
      for (const server of [origin, secureOrigin]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      fs.rmSync(dir, { recursive:true, force:true });
    }
  };
}
export function request(f, { url = `http://remote-only.invalid:${f.httpPort}/hello`, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host:'127.0.0.1', port:f.clientPort, path:url, method, headers:body ? {'Content-Length':Buffer.byteLength(body)} : {} }, res => {
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode, body:Buffer.concat(chunks).toString()}));res.on('error',reject);
    });
    req.on('error',reject); if(body)req.write(body);req.end();
  });
}
// HTTPS through the local proxy's CONNECT with full origin TLS verification.
// Pure Node (no curl) so it behaves the same on Linux and Windows/Schannel.
export function httpsViaProxy(f, { ca = fs.readFileSync(path.join(f.dir,'ca.pem')), timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host:'127.0.0.1', port:f.clientPort, method:'CONNECT', path:`localhost:${f.httpsPort}` });
    const timer = setTimeout(() => { req.destroy(); reject(Object.assign(new Error('timeout'), { code:'ETIMEDOUT' })); }, timeoutMs);
    const done = (fn, value) => { clearTimeout(timer); fn(value); };
    req.on('error', error => done(reject, error));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return done(reject, Object.assign(new Error(`CONNECT ${res.statusCode}`), { code:'CONNECT_FAILED' })); }
      const secure = tls.connect({ socket, servername:'localhost', ca, rejectUnauthorized:true }, () => {
        // HTTP/1.0 => unchunked body, server closes. write() (not end()) mirrors curl: no half-close.
        secure.write('GET /hello HTTP/1.0\r\nHost: localhost\r\n\r\n');
      });
      const chunks=[]; secure.on('data', c => chunks.push(c)); secure.on('error', error => done(reject, error));
      secure.on('end', () => {
        const raw = Buffer.concat(chunks).toString(), split = raw.indexOf('\r\n\r\n');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1]);
        done(status ? resolve : reject, status ? { status, stdout: raw.slice(split + 4) } : Object.assign(new Error('no HTTP response'), { code:'EPROTO' }));
      });
    });
    req.end();
  });
}
