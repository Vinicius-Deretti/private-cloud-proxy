import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';

test('relay and client components exist', () => {
  assert.ok(fs.existsSync(new URL('../server.mjs', import.meta.url)), 'remote relay missing');
  assert.ok(fs.existsSync(new URL('../client.mjs', import.meta.url)), 'local client missing');
});

import { fixture, request, httpsViaProxy, SECRET } from './fixtures.mjs';

test('HTTP and HTTPS CONNECT traverse authenticated WSS with explicit CA', async () => {
  const f=await fixture();
  try {
    assert.equal(f.client.server.address().address,'127.0.0.1');
    const http=await request(f); assert.equal(http.status,200);assert.equal(http.body,'bridge-origin-ok');
    assert.ok(f.relay.usage().bytes > 20,'HTTP bytes must pass through WSS, not a direct client socket');
    const post=await request(f,{method:'POST',body:'bidirectional payload'});assert.equal(post.body,'bidirectional payload');
    const https=await httpsViaProxy(f);assert.equal(https.stdout,'bridge-origin-ok');
    assert.ok(f.lookups.length>=3,'remote relay must resolve every connection');
  } finally { await f.close(); }
});

test('invalid authentication never reaches origin', async () => {
  const f=await fixture({clientOptions:{secret:SECRET+'wrong'}});
  try { assert.equal((await request(f)).status,502); assert.equal(f.hits(),0); } finally { await f.close(); }
});

test('untrusted WSS certificate is rejected without TLS bypass', async () => {
  const f=await fixture({clientOptions:{ca:undefined}});
  try { assert.equal((await request(f)).status,502);assert.equal(f.hits(),0); } finally { await f.close(); }
});

test('production policy blocks local origins and forbidden ports', async () => {
  const f=await fixture({secured:true});
  try {
    assert.equal((await request(f)).status,502);
    for(const url of ['http://169.254.169.254/','http://10.0.0.1/','http://127.0.0.1/','http://localhost:22/']) assert.equal((await request(f,{url})).status,502);
    assert.equal(f.hits(),0);
  } finally { await f.close(); }
});

test('concurrency works and failure never falls back to direct origin', async () => {
  const f=await fixture();
  try {
    const results=await Promise.all(Array.from({length:4},()=>request(f)));
    assert.ok(results.every(r=>r.status===200));
    await f.relay.close(); const before=f.hits();
    assert.equal((await request(f)).status,502);assert.equal(f.hits(),before);
  } finally { await f.close(); }
});

test('session byte cap terminates transfer', async () => {
  const f=await fixture({relayOptions:{maxBytes:1024}});
  try {
    await assert.rejects(httpsViaProxy(f));
    const result=await request(f,{url:`http://localhost:${f.httpPort}/large`}).catch(()=>({status:502}));
    assert.ok(!result.body || result.body.length < 32768, 'byte cap must prevent full response');
  } finally { await f.close(); }
});

import net from 'node:net';
import { once } from 'node:events';
import { Budget } from '../budget.mjs';

test('idle tunnel is closed and next request reconnects after relay restart', async () => {
  const f=await fixture({relayOptions:{idleMs:100,lifetimeMs:1000}});
  let socket;
  try {
    socket=net.connect(f.clientPort,'127.0.0.1');socket.on('error',()=>{});
    await once(socket,'connect');
    socket.write(`CONNECT localhost:${f.httpsPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    const [reply]=await once(socket,'data');assert.match(reply.toString(),/200 Connection Established/);
    await Promise.race([once(socket,'close'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Idle tunnel did not close')),1500).unref())]);
    await f.relay.close(); assert.equal((await request(f)).status,502);
    await f.restartRelay(); assert.equal((await request(f)).status,200);
  } finally {socket?.destroy();await f.close();}
});

test('client monthly cap and server daily session cap fail closed', async () => {
  const f=await fixture({clientOptions:{budget:new Budget({limit:8191})}});
  try {assert.equal((await request(f)).status,502);assert.equal(f.hits(),0);} finally {await f.close();}
  const other=await fixture({relayOptions:{dailySessions:1}});
  try {assert.equal((await request(other)).status,200);assert.equal((await request(other)).status,502);} finally {await other.close();}
});

import { WebSocket } from 'ws';

test('missing authentication is rejected at WebSocket upgrade', async () => {
  const f=await fixture();
  try {
    const status=await new Promise((resolve,reject)=>{
      const ws=new WebSocket(`wss://localhost:${f.relayPort}/tunnel`,{ca:fs.readFileSync(`${f.dir}/ca.pem`)});
      ws.on('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve(res.statusCode);});
      ws.on('error',()=>{});ws.on('open',()=>reject(new Error('Unauthenticated upgrade accepted')));
    });
    assert.equal(status,401);assert.equal(f.hits(),0);
  } finally {await f.close();}
});

test('origin TLS verification stays end-to-end through CONNECT', async () => {
  const f=await fixture();
  try {
    // Public roots only: the private test CA must NOT be trusted, so the origin cert is rejected end-to-end.
    await assert.rejects(httpsViaProxy(f,{ca:tls.rootCertificates}),error=>['SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
  } finally {await f.close();}
});

test('server connection ceiling rejects additional sessions', async () => {
  const f=await fixture({relayOptions:{maxSessions:1}});let socket;
  try {
    socket=net.connect(f.clientPort,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');
    socket.write(`CONNECT localhost:${f.httpsPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    const [reply]=await once(socket,'data');assert.match(reply.toString(),/200/);
    assert.equal((await request(f)).status,502);
  } finally {socket?.destroy();await f.close();}
});

test('cold-start HTTP errors retry only within an active user request', async () => {
  const f=await fixture({clientOptions:{attempts:4,retryMs:10,connectWindowMs:1000}});
  try {
    const [upgrade]=f.relay.server.listeners('upgrade');f.relay.server.removeAllListeners('upgrade');
    let calls=0;
    f.relay.server.on('upgrade',(req,socket,head)=>{
      if(++calls<=2) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else upgrade(req,socket,head);
    });
    assert.equal((await request(f)).status,200);assert.equal(calls,3);
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(calls,3,'no background keep-alive/reconnect loop');
  } finally {await f.close();}
});

import http from 'node:http';
import { listen } from './fixtures.mjs';
test('WSS respects an explicitly configured HTTP CONNECT proxy', async () => {
  const forward=http.createServer();let connects=0;const sockets=new Set();
  forward.on('connect',(req,socket,head)=>{
    connects++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    const port=Number(req.url.split(':').at(-1));const upstream=net.connect(port,'127.0.0.1',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
    });
    upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
  });
  const port=await listen(forward);
  const f=await fixture({clientOptions:{proxyEnv:{HTTPS_PROXY:`http://127.0.0.1:${port}`,NO_PROXY:''}}});
  try {assert.equal((await request(f)).status,200);assert.ok(connects>0);} finally {await f.close();for(const s of sockets)s.destroy();await new Promise(resolve=>forward.close(resolve));}
});

import https from 'node:https';
test('usage counters require authentication and never contain secrets', async () => {
  const f=await fixture();
  const usage=authorization=>new Promise((resolve,reject)=>{
    https.get({hostname:'localhost',port:f.relayPort,path:'/usage',ca:fs.readFileSync(`${f.dir}/ca.pem`),headers:authorization?{Authorization:authorization}:{}},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));
    }).on('error',reject);
  });
  try {
    assert.equal((await usage()).status,401);
    await request(f);const result=await usage(`Bearer ${SECRET}`);
    assert.equal(result.status,200);assert.ok(JSON.parse(result.body).bytes>0);assert.ok(!result.body.includes(SECRET));
  } finally {await f.close();}
});

test('remote server itself rejects forbidden ports even if local client permits them', async () => {
  const f=await fixture({clientOptions:{ports:new Set([22])}});
  try {
    const r=await request(f,{url:'http://remote-only.invalid:22/'});
    assert.equal(r.status,502);assert.equal(f.relay.usage().sessions,1);assert.equal(f.lookups.length,0);
  } finally {await f.close();}
});

test('denied destinations produce an explicit protocol verdict before closing', async () => {
  const f=await fixture();
  try {
    const verdict=await new Promise((resolve,reject)=>{
      const ws=new WebSocket(`wss://localhost:${f.relayPort}/tunnel`,{ca:fs.readFileSync(`${f.dir}/ca.pem`),headers:{Authorization:`Bearer ${SECRET}`}});
      ws.on('error',reject);
      ws.once('open',()=>ws.send(JSON.stringify({host:'example.com',port:22})));
      ws.once('message',message=>{try{resolve(JSON.parse(message.toString()));}catch(error){reject(error);}finally{ws.terminate();}});
      ws.once('close',()=>reject(new Error('No application verdict before transport close')));
    });
    assert.equal(verdict.ready,false);assert.ok(typeof verdict.failure==='string');
  } finally {await f.close();}
});

test('relay reports sanitized DNS and TCP failure stages without destination or secret', async () => {
  const events=[];
  const f=await fixture({relayOptions:{diagnostic:event=>events.push(event),resolve:async host=>{
    if (host === 'failure.example') { const error=new Error('sensitive DNS detail'); error.code='ENOTFOUND'; throw error; }
    return '127.0.0.2';
  }}});
  try {
    assert.equal((await request(f,{url:'http://failure.example/'})).status,502);
    assert.equal((await request(f,{url:`http://refused.example:${f.httpPort}/`})).status,502);
    assert.ok(events.some(e=>e.stage==='tcp' && e.code==='ECONNREFUSED'));
    assert.ok(events.some(e=>e.stage==='dns' && e.code==='ENOTFOUND'));
    assert.doesNotMatch(JSON.stringify(events),/failure\.example|sensitive|test-secret/);
  } finally {await f.close();}
});

test('TCP connection failure sends an explicit denial before closing', async () => {
  const f=await fixture({relayOptions:{resolve:async()=> '127.0.0.2', diagnostic:()=>{}}});
  try {
    const verdict=await new Promise((resolve,reject)=>{
      const ws=new WebSocket(`wss://localhost:${f.relayPort}/tunnel`,{ca:fs.readFileSync(`${f.dir}/ca.pem`),headers:{Authorization:`Bearer ${SECRET}`}});
      ws.on('error',reject);
      ws.once('open',()=>ws.send(JSON.stringify({host:'example.com',port:f.httpPort})));
      ws.once('message',message=>{resolve(JSON.parse(message.toString()));ws.terminate();});
      ws.once('close',()=>reject(new Error('No application verdict before transport close')));
    });
    assert.equal(verdict.ready,false);assert.ok(typeof verdict.failure==='string');
  } finally {await f.close();}
});

test('relay tries a second resolved address when the first refuses TCP', async()=>{
  const f=await fixture({relayOptions:{resolve:async()=>['127.0.0.2','127.0.0.1']}});
  try {assert.equal((await request(f)).status,200);assert.equal(f.hits(),1);}
  finally {await f.close();}
});

test('CONNECT early bytes over budget fail before sending success and release tunnel',async()=>{
  const f=await fixture({clientOptions:{budget:new Budget({limit:8192})}});let socket;
  try {
    socket=net.connect(f.clientPort,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');
    const reply=once(socket,'data');
    socket.write(`CONNECT localhost:${f.httpsPort} HTTP/1.1\r\nHost: localhost\r\n\r\nearly-data`);
    const [data]=await reply;assert.match(data.toString(),/^HTTP\/1.1 502/);assert.doesNotMatch(data.toString(),/200 Connection/);
  } finally {socket?.destroy();await f.close();}
});
