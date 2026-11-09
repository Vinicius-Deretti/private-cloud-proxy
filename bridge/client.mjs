import http from 'node:http';
import crypto from 'node:crypto';
import { report, failures } from './diagnostics.mjs';
import https from 'node:https';
import { WebSocket } from 'ws';
import { createTunnelStream } from './tunnel-stream.mjs';
import { RelayAgent, STICKY_FAMILY_DEFAULT } from './tls-resume.mjs';
import { CLIENT_MAX_SESSIONS, CLIENT_MAX_QUEUED, CLIENT_QUEUE_WAIT_MS, CLIENT_IDLE_EVICT_MS, RELAY_MAX_SESSIONS } from './limits.mjs';
import { Budget, meter } from './budget.mjs';
import { target } from './policy.mjs';
import { SessionQueue } from './session-queue.mjs';
import { sealFastOpen } from './fast-open.mjs';

// After a local FIN on a CONNECT tunnel, keep the downstream open while it is
// active; cancel the tunnel after this much downstream inactivity.
export const HALF_CLOSE_IDLE_MS = 5_000;

export function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/tunnel') throw new Error('Use wss://HOST/tunnel, without credentials');
  return url.href;
}

export function parseConnectAuthority(authority) {
  const url = new URL(`http://${authority}`);
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  if (url.username || url.password || url.pathname !== '/' || !explicitPort || url.search || url.hash) throw new Error('Invalid CONNECT authority');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(explicitPort) };
}

function removeHopHeaders(headers) {
  const result = { ...headers };
  const named = String(result.connection || '').split(',').map(x => x.trim().toLowerCase());
  for (const name of [...named, 'proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding']) delete result[name];
  result.connection = 'close';
  return result;
}

// Retry classification (all retries stay within the request deadline):
// - Relay/cold-start transport failures (WSS_CONNECTION_FAILED, 5xx, close
//   before verdict, SESSION_LIMIT): retried with the cold-start backoff.
// - Transient destination failures reported by the relay verdict
//   (DNS_FAILED except NXDOMAIN, TCP_CONNECT_TIMEOUT, NETWORK_UNREACHABLE) and
//   a tunnel closed after its verdict but before any byte was handed to the
//   browser (REMOTE_SOCKET_CLOSED): retried at most DESTINATION_RETRIES times
//   with a short backoff, so a mistyped domain fails fast.
// - Definitive: AUTH_FAILED, DNS_REJECTED/policy, TRAFFIC_LIMIT, TLS/cert
//   errors, TCP_CONNECTION_REFUSED, NXDOMAIN, and anything after data flowed.
// Traffic accounting (never undercount real traffic; see docs/PERFORMANCE.md):
// - RELAY_CONNECTION_BYTES per new TCP+TLS connection to the relay. Reserved
//   before connecting (so no byte can leave uncounted at the quota edge) and
//   refunded only when TCP to the relay provably never connected (failure
//   before TCP, or a control request that reused a keep-alive socket). Covers
//   the TLS handshake (measured ~5.0 KB full, ~3.6 KB resumed) plus the
//   upgrade/HTTP headers.
// - CONTROL_REQUEST_BYTES per control request (/usage, DELETE), which may
//   reuse a keep-alive connection; response bodies are also metered.
// - Tunnel payload: every chunk metered, +64 bytes framing allowance.
export const RELAY_CONNECTION_BYTES = 8192;
export const CONTROL_REQUEST_BYTES = 2048;
export const DESTINATION_RETRIES = 2;
export const DESTINATION_RETRY_MS = 250;
const TRANSIENT_DESTINATION = new Set(['DNS_FAILED', 'TCP_CONNECT_TIMEOUT', 'NETWORK_UNREACHABLE']);
export function retryableVerdict(failure, code) {
  return TRANSIENT_DESTINATION.has(failure) && code !== 'ENOTFOUND';
}
export function retryDelayMs(failure, attempt, retryMs, remainingMs, random = Math.random, destination = false) {
  if (remainingMs <= 0) return 0;
  const delay = failure === 'SESSION_LIMIT'
    ? 75 + Math.floor(Math.max(0, Math.min(0.999999, random())) * 125)
    : destination ? DESTINATION_RETRY_MS * 2 ** attempt
    : Math.min(retryMs * 2 ** attempt, 10_000);
  return Math.min(delay, remainingMs);
}

export function createLocalProxy({ endpoint, secret, ca, budget = new Budget(), ports = new Set([80, 443]),
  proxyEnv = process.env, openTimeoutMs = 10_000, attempts = 12, retryMs = 1000, connectWindowMs = 90_000, maxSessions = CLIENT_MAX_SESSIONS, maxQueued = CLIENT_MAX_QUEUED, queueWaitMs = CLIENT_QUEUE_WAIT_MS,
  idleEvictMs = CLIENT_IDLE_EVICT_MS, halfCloseIdleMs = HALF_CLOSE_IDLE_MS, stickyFamily = STICKY_FAMILY_DEFAULT, relayLookup, diagnostic = event => console.error(JSON.stringify(event)) } = {}) {
  endpoint = validateEndpoint(endpoint);
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Secret must have at least 32 characters');
  // Reuse authenticated HTTPS control sockets for readiness and cancellation.
  // Shared agent: TLS sessions are resumed across WSS tunnels; the relay's
  // working address family is tried first so fallback never drops tickets.
  const agent = new RelayAgent({ stickyFamily, ...(relayLookup ? { lookup: relayLookup } : {}), proxyEnv, keepAlive: true, maxSockets: RELAY_MAX_SESSIONS, maxFreeSockets: 4 });
  if (!Number.isFinite(idleEvictMs) || idleEvictMs < 0) throw new Error('Invalid idle eviction threshold');
  if (!Number.isFinite(halfCloseIdleMs) || halfCloseIdleMs < 0) throw new Error('Invalid half-close idle threshold');
  const queue = new SessionQueue({limit:maxSessions,maxPending:maxQueued,waitMs:queueWaitMs});
  // HTTPS prevents classifying keep-alive, HTTP/2, and application WebSockets.
  // Never evict normally. Under admission pressure only, preempt the oldest
  // tunnel that has carried no traffic for the conservative grace period.
  const activity = new Map();
  const touch = ws => { const entry = activity.get(ws); if (entry) entry.lastDataAt = performance.now(); };
  function evictIdleUnderPressure() {
    if (idleEvictMs === 0 || queue.stats().active < maxSessions) return false;
    const now = performance.now();
    let victim;
    for (const [ws, state] of activity) {
      if (ws.readyState !== WebSocket.OPEN || closing.has(ws) ||
          now - state.lastDataAt < idleEvictMs) continue;
      if (!victim || state.lastDataAt < victim.state.lastDataAt) victim = { ws, state };
    }
    if (!victim) return false;
    report(diagnostic, 'local_eviction', { failure:'IDLE_EVICTED' },
      crypto.randomUUID(), victim.state.lastDataAt);
    void endTunnel(victim.ws);
    return true;
  }
  const active = new Set(), pending = new Set(), localSockets = new Set();
  const closing=new WeakMap(),sessionIds=new WeakMap(),cancellations=new Set();
  function cancelSession(ws) {
    const id=sessionIds.get(ws);
    if(!id)return Promise.resolve();
    const cancellation=new Promise(resolve=>{
      let request,finished=false,settle=()=>{};
      const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)request?.destroy();settle();resolve();};
      const timer=setTimeout(()=>done(new Error('Cancellation deadline')),2000);
      try{
        const url=new URL(endpoint);url.protocol='https:';url.pathname='/tunnel/'+id;
        // Without budget the DELETE is skipped (never send uncounted bytes);
        // the WebSocket close already ends the remote session.
        consume(CONTROL_REQUEST_BYTES);
        const connection=reserveConnection();settle=connection.settle;
        request=https.request(url,{method:'DELETE',agent,ca,onTcpConnect:connection.connected,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{Authorization:'Bearer '+secret}},res=>{
          // Normal 204 replies can reuse the authenticated HTTPS connection.
          // A malformed/never-ending response remains bounded by the deadline.
          let size=0;
          res.on('data',chunk=>{size+=chunk.length;if(size>1024)done(new Error('Oversized cancellation response'));});
          res.once('end',done);
          res.once('error',done);
          res.resume();
        });
        request.once('error',done);request.end();
      }catch{done();}
    });
    cancellations.add(cancellation);cancellation.then(()=>cancellations.delete(cancellation));return cancellation;
  }
  function endTunnel(ws) {
    if(!ws)return Promise.resolve();
    if(closing.has(ws))return closing.get(ws);
    const cancellation=cancelSession(ws);closing.set(ws,cancellation);
    if(ws.readyState===WebSocket.CLOSED)return cancellation;
    if(ws.readyState!==WebSocket.OPEN && ws.readyState!==WebSocket.CLOSING){ws.terminate();return cancellation;}
    const timer=setTimeout(()=>ws.terminate(),1000);timer.unref();
    ws.once('close',()=>clearTimeout(timer));
    if(ws.readyState===WebSocket.OPEN)ws.close(1000);
    return cancellation;
  }
  let stopped = false,remoteQuotaExhausted=false,remoteFastOpen=false;
  const probes=new Set();
  // Reserve a relay connection's handshake allowance up front (throws when the
  // budget cannot cover it); settle() refunds it only if TCP never connected.
  function reserveConnection() {
    consume(RELAY_CONNECTION_BYTES);
    let connected=false,settled=false;
    return {
      connected(){connected=true;},
      settle(){if(settled)return;settled=true;if(!connected)budget.refund?.(RELAY_CONNECTION_BYTES);}
    };
  }
  function consume(bytes) {
    try { budget.consume(bytes); } catch {
      report(diagnostic, 'local_traffic', {failure:'TRAFFIC_LIMIT'}, crypto.randomUUID(), performance.now());
      throw Object.assign(new Error('Traffic limit reached'), {failure:'TRAFFIC_LIMIT',source:'local',retryable:false});
    }
  }
  async function checkRelay({timeoutMs=90000}={}) {
    if(stopped || !Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>90000)throw new Error('Invalid readiness state');
    consume(CONTROL_REQUEST_BYTES);
    const connection=reserveConnection();
    return new Promise((resolve,reject)=>{
      let request,finished=false;const started=performance.now();
      const done=(error,value)=>{
        if(finished)return;finished=true;clearTimeout(timer);probes.delete(request);if(error)request?.destroy();connection.settle();
        if(error)reject(Object.assign(new Error('Relay unavailable'),{failure:error.failure||'WSS_CONNECTION_FAILED',code:error.code,source:error.source}));
        else resolve(value);
      };
      const timer=setTimeout(()=>done({code:'ETIMEDOUT'}),timeoutMs);
      try{
        const url=new URL(endpoint);url.protocol='https:';url.pathname='/usage';
        request=https.get(url,{agent,ca,onTcpConnect:connection.connected,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{Authorization:'Bearer '+secret}},res=>{
          if(res.statusCode!==200){res.resume();done({failure:res.statusCode===401?'AUTH_FAILED':'WSS_CONNECTION_FAILED'});return;}
          let body='',bytes=0;
          res.on('data',chunk=>{
            if(finished)return;
            try{consume(chunk.length+64);bytes+=chunk.length;if(bytes>16384)throw new Error('Response limit');body+=chunk;}
            catch(error){done(error);}
          });
          res.once('error',error=>done(error));
          res.once('end',()=>{
            if(finished)return;
            try{
              const usage=JSON.parse(body);
              if(!['active','sessions','bytes','processLimit'].every(key=>Number.isSafeInteger(usage[key])&&usage[key]>=0) || usage.processLimit<1 || usage.bytes>usage.processLimit)throw new Error('Invalid usage');
              if(usage.processLimit-usage.bytes<8192){remoteQuotaExhausted=true;done({failure:'TRAFFIC_LIMIT',source:'remote'});return;}
              remoteQuotaExhausted=false;
              remoteFastOpen=usage.fastOpen===true;
              done(null,{active:usage.active,sessions:usage.sessions,bytes:usage.bytes,processLimit:usage.processLimit,readyMs:Math.round(performance.now()-started)});
            }catch(error){done(error);}
          });
        });
        probes.add(request);request.once('error',error=>done(error));
      }catch(error){done(error);}
    });
  }
  function onceTunnel(host, port, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let ws, settled = false, connection;
      const earlyTarget = remoteFastOpen;
      const id=crypto.randomUUID(), started=performance.now();
      const fail = cause => {
        if (!settled) {
          settled = true; ws?.terminate(); connection?.settle();
          const event = cause?.failure === 'QUEUE_CANCELLED' ? {failure:'QUEUE_CANCELLED',id} : report(diagnostic, 'wss', cause, /^[a-f0-9-]{36}$/.test(cause?.id || '') ? cause.id : id, started);
          const error = new Error('Encrypted tunnel unavailable');
          error.failure=event.failure;error.id=event.id;
          error.retryable = cause?.retryable !== false && !/CERT|TLS|SELF_SIGNED/.test(cause?.code || '');
          error.destination = cause?.destination === true;
          reject(error);
        }
      };
      try {
        if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{failure:'QUEUE_CANCELLED',retryable:false});
        // Reserved for every attempt; refunded only if TCP to the relay never
        // connected. Failed auth/TLS/cold-start replies after TCP stay charged.
        connection = reserveConnection();
        const headers = { Authorization: `Bearer ${secret}`, 'X-Tunnel-Half-Close': '1' };
        if (earlyTarget) headers['X-Tunnel-Open'] = sealFastOpen(secret, host, port);
        ws = new WebSocket(endpoint, { headers, ca, onTcpConnect: connection.connected,
          agent, followRedirects: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: timeoutMs, perMessageDeflate: false, maxPayload: 65536 });
      } catch (error) { fail(error); return; }
      pending.add(ws);
      const timer = setTimeout(fail, timeoutMs);
      ws.once('error', fail); ws.once('close', code => fail({ retryable: code !== 1008 }));
      ws.once('unexpected-response', (_req, res) => {
        res.resume();if(res.statusCode===429 && res.headers['x-tunnel-failure']==='TRAFFIC_LIMIT')remoteQuotaExhausted=true; fail({ failure:res.statusCode === 401 ? 'AUTH_FAILED' : res.statusCode === 429 ? (failures.has(res.headers['x-tunnel-failure']) ? res.headers['x-tunnel-failure'] : 'SESSION_LIMIT') : 'WSS_CONNECTION_FAILED', id:res.headers['x-tunnel-id'], retryable: res.statusCode === 200 || res.statusCode >= 500 || (res.statusCode === 429 && res.headers['x-tunnel-failure'] === 'SESSION_LIMIT') });
      });
      ws.once('open', () => { if (!earlyTarget) ws.send(JSON.stringify({ host, port })); });
      ws.once('message', (message, binary) => {
        try {
          if (binary) throw new Error();
          const verdict=JSON.parse(message.toString());
          if (verdict.ready !== true) {
            const failure = failures.has(verdict.failure) ? verdict.failure : 'INTERNAL_ERROR';
            fail({ retryable: retryableVerdict(failure, verdict.code), destination: true, failure, id: verdict.id }); return;
          }
          settled = true; clearTimeout(timer); pending.delete(ws); active.add(ws);
          if(/^[a-f0-9-]{36}$/.test(verdict.id||''))sessionIds.set(ws,verdict.id);
          // Old relays omit halfClose: keep reading after a local half-close
          // instead of closing the WebSocket (no EOF reaches the origin then).
          const stream = createTunnelStream(ws, { halfClose: verdict.halfClose === true, legacyFinal: 'keep', highWaterMark: 65536 });
          stream.on('error', () => {});
          ws.once('close', code => {active.delete(ws);if(!signal?.aborted && code!==1000 && code!==1005)report(diagnostic,'connected',{failure:'REMOTE_SOCKET_CLOSED'},/^[a-f0-9-]{36}$/.test(verdict.id||'')?verdict.id:id,started);});
          resolve({ ws, stream });
        } catch { fail({ retryable: false }); }
      });
      const abort = () => { if(settled){endTunnel(ws);return;}ws.terminate();fail({failure:'QUEUE_CANCELLED',retryable:false}); };
      signal?.addEventListener('abort',abort,{once:true});
      ws.once('close', () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); pending.delete(ws); active.delete(ws); });
    });
  }
  async function tunnel(host, port, signal) {
    target(host, port, ports);
    const traffic = () => {
      if(budget.used + RELAY_CONNECTION_BYTES <= budget.limit)return false;
      report(diagnostic,'local_limit',{failure:'TRAFFIC_LIMIT'},crypto.randomUUID(),performance.now());return true;
    };
    if(stopped || remoteQuotaExhausted || traffic())throw new Error('Traffic unavailable');
    let release;const waiting=performance.now();
    try {evictIdleUnderPressure();release=await queue.acquire({signal});}
    catch(error){if(error.failure!=='QUEUE_CANCELLED')report(diagnostic,'local_queue',error,crypto.randomUUID(),waiting);throw error;}
    let handedOff=false;
    try {
      const deadline=Date.now()+connectWindowMs;
      let destinationRetries=0;
      for(let attempt=0;attempt<attempts;attempt++) {
        if(stopped || remoteQuotaExhausted || signal?.aborted || Date.now()>=deadline || traffic())break;
        try {
          const remote=await onceTunnel(host,port,Math.min(openTimeoutMs,deadline-Date.now()),signal);
          // A closed local WebSocket no longer occupies the client's admission slot.
          // Remote cleanup is best-effort and independent, with eight spare
          // relay slots and bounded retries for transient SESSION_LIMIT.
          // Remove tracking and grant the next queued request as soon as the
          // local WSS closes. The remote DELETE still runs independently.
          activity.set(remote.ws, { lastDataAt: performance.now() });
          remote.ws.once('close', () => { activity.delete(remote.ws); release(); });
          if(stopped || signal?.aborted){endTunnel(remote.ws);throw new Error('Cancelled');}
          if(remote.ws.readyState!==WebSocket.OPEN){
            // Closed after the verdict, before any byte reached the browser.
            endTunnel(remote.ws);
            throw Object.assign(new Error('Tunnel closed before data'),{failure:'REMOTE_SOCKET_CLOSED',retryable:true,destination:true});
          }
          handedOff=true;return remote;
        }catch(error){
          if(!error.retryable)break;
          if(error.destination && destinationRetries++>=DESTINATION_RETRIES)break;
          if(attempt+1<attempts && !stopped && !signal?.aborted)await new Promise(resolve=>{
            const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
            const timer=setTimeout(done,retryDelayMs(error.failure,error.destination?destinationRetries-1:attempt,retryMs,deadline-Date.now(),Math.random,error.destination));
            signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
          });
        }
      }
      throw new Error('Tunnel unavailable');
    } finally {if(!handedOff)release();}
  }
  const server = http.createServer(async (req, res) => {
    req.pause();
    const controller=new AbortController();
    req.once('aborted',()=>controller.abort());res.once('close',()=>controller.abort());
    let remote;
    try {
      const url = new URL(req.url);
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error();
      remote = await tunnel(url.hostname, Number(url.port || 80), controller.signal);
      if (req.destroyed) { endTunnel(remote.ws); return; }
      const headers = removeHopHeaders(req.headers); headers.host = url.host;
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => remote.stream;
      const upstream = http.request({ method: req.method, path: url.pathname + url.search, headers,
        host: url.hostname, port: Number(url.port || 80), agent }, response => {
        const clean = removeHopHeaders(response.headers);
        res.writeHead(response.statusCode, clean);
        const counted = meter(bytes => consume(bytes + 64), () => touch(remote.ws));
        counted.on('error', () => { response.destroy(); res.destroy(); endTunnel(remote.ws); });
        // A truncated origin response must reach the browser as an error,
        // never hang or look complete.
        response.once('close', () => { if (!response.complete) { res.destroy(); endTunnel(remote.ws); } });
        response.on('error', () => {});
        response.pipe(counted).pipe(res);
      });
      upstream.on('error', () => {
        endTunnel(remote.ws);
        if (res.headersSent) { res.destroy(); return; } // never append text to a started body
        res.writeHead(502); res.end('Tunnel unavailable');
      });
      const counted = meter(bytes => consume(bytes + 64), () => touch(remote.ws));
      counted.on('error', () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { upstream.destroy(); endTunnel(remote.ws); });
      req.pipe(counted).pipe(upstream); req.resume();
    } catch {
      endTunnel(remote?.ws); if(res.destroyed)return; res.writeHead(502, { Connection: 'close' }); res.end('Tunnel unavailable');
    }
  });
  server.on('connect', async (req, socket, head) => {
    socket.pause();
    const controller=new AbortController();socket.once('close',()=>controller.abort());
    let remote, established = false;
    try {
      const { host, port } = parseConnectAuthority(req.url);
      remote = await tunnel(host, port, controller.signal);
      const { ws, stream } = remote;
      if (socket.destroyed) { endTunnel(ws); return; }
      const finish = () => { socket.destroy(); endTunnel(ws); };
      // TCP half-open: a local FIN ends only the upstream direction (pipe ->
      // EOF frame); the downstream keeps flowing until the remote side ends.
      // A clean remote end reaches the socket through the pipe (socket.end()).
      // Only an abrupt tunnel close (no EOF) tears the local socket down.
      stream.on('error', finish); stream.on('close', () => { if (!stream.readableEnded) finish(); });
      socket.on('error', finish); socket.on('close', () => { clearTimeout(halfCloseTimer); endTunnel(ws); });
      // Browsers rarely half-close: a FIN usually means "done". Keep reading
      // while the downstream is active, but cancel the tunnel (freeing the
      // remote slot via DELETE) once it stays idle for halfCloseIdleMs.
      let lastDownAt = performance.now(), halfCloseTimer;
      const watchHalfClosed = () => {
        const idle = performance.now() - lastDownAt;
        if (idle >= halfCloseIdleMs) { finish(); return; }
        halfCloseTimer = setTimeout(watchHalfClosed, Math.max(1, Math.ceil(halfCloseIdleMs - idle))); halfCloseTimer.unref();
      };
      socket.once('end', () => { if (!socket.destroyed && !stream.readableEnded) { lastDownAt = performance.now(); watchHalfClosed(); } });
      const up = meter(bytes => consume(bytes + 64), () => touch(ws)), down = meter(bytes => consume(bytes + 64), () => { lastDownAt = performance.now(); touch(ws); });
      up.on('error', finish); down.on('error', finish);
      if (head.length) consume(head.length + 64);
      established = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) stream.write(head);
      socket.pipe(up).pipe(stream); stream.pipe(down).pipe(socket); socket.resume();
    } catch {
      endTunnel(remote?.ws);
      if(socket.destroyed)return;
      if (established) socket.destroy();
      else socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  server.on('connection', socket => { localSockets.add(socket); socket.on('close', () => localSockets.delete(socket)); socket.on('error', () => {}); });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.headersTimeout = 15_000; server.requestTimeout = 160_000;
  return { server, budget,
    checkRelay, tlsStats: () => ({ ...agent.tlsStats }),
    async listen(port = 0) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return server.address().port; },
    async close() {
      stopped=true;queue.close();activity.clear();for(const probe of probes)probe.destroy();
      const ending=Promise.all([...active,...pending].map(ws=>new Promise(resolve=>{
        if(ws.readyState===WebSocket.CLOSED)return resolve();
        ws.once('close',resolve);endTunnel(ws);
      })));
      for(const socket of localSockets)socket.destroy();
      await ending;await Promise.all([...cancellations]);
      if(server.listening)await new Promise(resolve=>server.close(resolve));
      agent.destroy();
    }
  };
}
