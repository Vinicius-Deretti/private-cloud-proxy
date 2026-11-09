import http from 'node:http';
import { connectPinned } from './connect.mjs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createTunnelStream, HALF_CLOSE_HEADER } from './tunnel-stream.mjs';
import { createCachedPublicResolver, target } from './policy.mjs';
import { Budget, meter } from './budget.mjs';
import { report as emit } from './diagnostics.mjs';
import { openFastOpen } from './fast-open.mjs';
import { loadProjectEnv } from './env.mjs';

// Interactive sites may maintain idle-but-valid HTTPS connections for extended periods.
// Both limits remain bounded; byte/session quotas are enforced independently.
export const DEFAULT_RELAY_TIMEOUTS = Object.freeze({ idleMs: 120_000, lifetimeMs: 1_800_000 });

export function createRelay({ secret, server = http.createServer(), resolve = createCachedPublicResolver(), connect = connectPinned,
  ports = new Set([80, 443]), maxSessions = 32, maxBytes = 1024 * 1024 * 1024,
  processBytes = 4 * 1024 * 1024 * 1024, idleMs = DEFAULT_RELAY_TIMEOUTS.idleMs, lifetimeMs = DEFAULT_RELAY_TIMEOUTS.lifetimeMs,
  connectMs = 10_000, dailySessions = 2000, halfClose = true, diagnostic = event => console.error(JSON.stringify(event)) } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('TUNNEL_TOKEN must have at least 32 characters');
  const expected = Buffer.from(`Bearer ${secret}`);
  const budget = new Budget({ limit: processBytes });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const connections = new Set();
  const sessionClosers=new Map();
  const history=[];
  const record=event=>{history.push(event);if(history.length>64)history.shift();try{diagnostic(event);}catch{}};
  let day = '', count = 0;
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  function authorized(req) {
    const actual = Buffer.from(req.headers.authorization || '');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  server.on('request', (req, res) => {
    if(req.method==='DELETE' && req.url.startsWith('/tunnel/')) {
      if(!authorized(req)){res.writeHead(401,{'Cache-Control':'no-store'});res.end();return;}
      const id=req.url.slice('/tunnel/'.length);
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)){res.writeHead(404);res.end();return;}
      sessionClosers.get(id)?.();
      res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;
    }
    if (req.url === '/diagnostics' && req.method === 'GET') {
      if (!authorized(req)) { res.writeHead(401,{'Cache-Control':'no-store'});res.end();return; }
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({events:history}));return;
    }
    if (req.url === '/usage' && req.method === 'GET') {
      if (!authorized(req)) { res.writeHead(401, { 'Cache-Control': 'no-store' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ active: connections.size, sessions: count, day, bytes: budget.used, processLimit: budget.limit, fastOpen: true })); return;
    }
    // /health stays public for the platform probe; the deployed revision is a
    // fingerprint and is disclosed only to authenticated callers.
    if (req.url === '/health' && authorized(req) && /^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT || '')) res.setHeader('X-Relay-Revision', process.env.RENDER_GIT_COMMIT);
    res.writeHead(req.method === 'GET' && req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(req.url === '/health' ? 'ok' : 'not found');
  });
  function reject(socket, status, failure, id) { socket.end(`HTTP/1.1 ${status}\r\n${failure ? `X-Tunnel-Failure: ${failure}\r\n` : ''}${id ? `X-Tunnel-Id: ${id}\r\n` : ''}Connection: close\r\nContent-Length: 0\r\n\r\n`); }
  server.on('upgrade', (req, socket, head) => {
    const id = crypto.randomUUID(), started = performance.now();
    const report = (stage, error) => emit(record, stage, error, id, started);
    if (req.url !== '/tunnel' || req.headers.origin || !authorized(req)) { report('wss', {failure:'AUTH_FAILED'}); return reject(socket, '401 Unauthorized'); }
    // Authenticate before parsing any optional encrypted upgrade target.
    // Never include request headers, hosts, or tokens in diagnostics.
    let earlyTarget;
    if (req.headers['x-tunnel-open'] !== undefined) {
      try { earlyTarget = openFastOpen(secret, req.headers['x-tunnel-open']); }
      catch {
        report('policy', { failure:'DNS_REJECTED' });
        return reject(socket, '400 Bad Request');
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) { day = today; count = 0; }
    const trafficExhausted=budget.limit-budget.used<8192;
    if (connections.size >= maxSessions || count >= dailySessions || trafficExhausted) { const event=report('limit', {failure:trafficExhausted ? 'TRAFFIC_LIMIT' : count >= dailySessions ? 'SESSION_QUOTA' : 'SESSION_LIMIT'}); return reject(socket, '429 Too Many Requests', event.failure, event.id); }
    // Half-close is used only when this client asked for it (old clients keep
    // the previous close-on-end framing).
    const sessionHalfClose = halfClose && req.headers[HALF_CLOSE_HEADER] === '1';
    wss.handleUpgrade(req, socket, head, ws => {
      connections.add(ws); count++;
      let upstream, stream, idle, lastActivityAt = 0, total = 0, finished = false, denied = false;
      const timers = [];
      const finish = () => {
        if (finished) return; finished = true;sessionClosers.delete(id);
        clearTimeout(idle); timers.forEach(clearTimeout);
        upstream?.destroy(); stream?.destroy(); ws.terminate(); connections.delete(ws);
      };
      sessionClosers.set(id,finish);
      const deny = event => {
        if (finished || denied) return;
        denied = true; upstream?.destroy();
        clearTimeout(timers[0]);
        timers.push(setTimeout(finish, 1000));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ready: false, failure: event.failure, id: event.id }), error => {
            if (error) finish(); else ws.close(1008, 'Unavailable');
          });
        } else finish();
      };
      // One idle deadline per session, refreshed by observed activity without
      // allocating/clearing a timer for every forwarded network chunk.
      const scheduleIdle = () => {
        const remaining = Math.max(1, Math.ceil(idleMs - (performance.now() - lastActivityAt)));
        idle = setTimeout(() => {
          if (finished) return;
          if (performance.now() - lastActivityAt >= idleMs) finish();
          else scheduleIdle();
        }, remaining);
        idle.unref();
      };
      const activity = () => {
        lastActivityAt = performance.now();
        if (!idle) scheduleIdle();
      };
      ws.on('error', finish); ws.on('close', finish);
      let stage = 'opening';
      timers.push(setTimeout(() => { deny(report(stage === 'dns' ? 'dns_timeout' : stage === 'tcp' ? 'tcp_timeout' : 'opening_timeout', {code:'ETIMEDOUT'})); }, connectMs), setTimeout(finish, lifetimeMs));
      const startDestination = async (message, binary) => {
        try {
          if (binary || message.length > 1024) throw new Error('Invalid opening');
          const { host, port } = JSON.parse(message.toString());
          stage = 'policy';
          target(host, port, ports);
          stage = 'dns';
          const resolved = await resolve(host);
          if (finished || denied) return;
          if (ws.readyState !== WebSocket.OPEN) return finish();
          const addresses = Array.isArray(resolved) ? resolved : [resolved];
          // Only the validated snapshot reaches the socket's custom lookup.
          stage = 'tcp';
          upstream = connect(addresses, port, { allowHalfOpen: sessionHalfClose });
          upstream.on('connectionAttemptFailed', (_address, _port, _family, error) => report('tcp', error));
          upstream.on('connectionAttemptTimeout', () => report('tcp_timeout', {code:'ETIMEDOUT'}));
          upstream.once('error', error => { const event=report(stage, error.errors?.at(-1) || error); if (stage === 'tcp') deny(event); else finish(); });
          upstream.once('connect', () => {
            if (finished || denied) return;
            clearTimeout(timers[0]);
            stage = 'connected';
            ws.send(JSON.stringify(sessionHalfClose ? { ready: true, id, halfClose: true } : { ready: true, id }));
            stream = createTunnelStream(ws, { halfClose: sessionHalfClose, legacyFinal: 'close', highWaterMark: 65536 });
            const consume = bytes => {
              try {
                if ((total += bytes) > maxBytes) throw new Error('Session limit');
                budget.consume(bytes);
              } catch (error) { report('traffic', {failure:'TRAFFIC_LIMIT'}); throw error; }
            };
            const outbound = meter(consume, activity), inbound = meter(consume, activity);
            for (const component of [stream, outbound, inbound]) component.on('error', finish);
            upstream.pipe(outbound).pipe(stream);
            stream.pipe(inbound).pipe(upstream);
            activity();
          });
        } catch (error) {
          deny(report(stage, error));
        }
      };
      if (earlyTarget) {
        // Begin policy/DNS/TCP while the WebSocket handshake response travels
        // back to the client. Legacy clients retain their first text frame.
        void startDestination(Buffer.from(JSON.stringify(earlyTarget)), false);
      } else {
        ws.once('message', startDestination);
      }
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  return {
    server, usage: () => ({ active: connections.size, sessions: count, bytes: budget.used }),
    async close() {
      for (const ws of connections) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadProjectEnv();
    const relay = createRelay({ secret: process.env.TUNNEL_TOKEN });
    const port = Number(process.env.PORT || 10000);
    relay.server.listen(port, '0.0.0.0', () => console.log('Private relay ready'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { relay.close().then(() => process.exit(0)); });
  } catch { console.error('Missing or invalid server configuration'); process.exit(1); }
}
