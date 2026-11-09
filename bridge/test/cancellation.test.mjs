import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {fixture,SECRET,request} from './fixtures.mjs';
async function waitFor(check){const end=Date.now()+1500;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check(),'cancelled remote session still holds its slot');}
const control=(f,id,authorized=true)=>new Promise((resolve,reject)=>{
 const req=https.request({hostname:'localhost',port:f.relayPort,path:'/tunnel/'+id,method:'DELETE',ca:fs.readFileSync(`${f.dir}/ca.pem`),headers:authorized?{Authorization:'Bearer '+SECRET}:{}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
});
for(const mode of ['reset','fin'])test(`browser ${mode} cancellation frees a remote slot even when the WebSocket reader is paused`,async()=>{
 // A local FIN is a half-close: the tunnel is cancelled once the downstream stays idle for halfCloseIdleMs.
 const f=await fixture({relayOptions:{maxSessions:1},clientOptions:{maxSessions:1,halfCloseIdleMs:100}});let transport,socket;
 f.relay.server.on('upgrade',(_req,peer)=>{transport=peer;});
 try{
  socket=net.connect(f.clientPort,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');
  socket.write(`CONNECT localhost:${f.httpsPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  const [reply]=await once(socket,'data');assert.match(reply.toString(),/200/);assert.equal(f.relay.usage().active,1);
  transport.pause();if(mode==='reset')socket.resetAndDestroy();else socket.end();
  await waitFor(()=>f.relay.usage().active===0);
  assert.equal((await request(f)).status,200,'next request must use the released slot without a retry');
 }finally{transport?.resume();socket?.destroy();await f.close();}
});
test('session cancellation requires authentication, validates UUID and is idempotent',async()=>{
 const f=await fixture();let ws;
 try{
  ws=new WebSocket(`wss://localhost:${f.relayPort}/tunnel`,{ca:fs.readFileSync(`${f.dir}/ca.pem`),headers:{Authorization:'Bearer '+SECRET}});ws.on('error',()=>{});await once(ws,'open');
  ws.send(JSON.stringify({host:'localhost',port:f.httpPort}));const [data]=await once(ws,'message');const verdict=JSON.parse(data.toString());assert.equal(verdict.ready,true);
  assert.equal(await control(f,verdict.id,false),401);assert.equal(f.relay.usage().active,1);
  assert.equal(await control(f,'not-a-uuid'),404);assert.equal(f.relay.usage().active,1);
  assert.equal(await control(f,verdict.id),204);assert.equal(f.relay.usage().active,0);
  assert.equal(await control(f,verdict.id),204);
 }finally{ws?.terminate();await f.close();}
});

test('unsupported cancellation endpoint falls back without leaking client slots',async()=>{
 const f=await fixture({clientOptions:{maxSessions:1,halfCloseIdleMs:100}});let socket,deletes=0;
 const handlers=f.relay.server.listeners('request');f.relay.server.removeAllListeners('request');
 f.relay.server.on('request',(req,res)=>{if(req.method==='DELETE'){deletes++;res.writeHead(404);res.end();return;}for(const handler of handlers)handler(req,res);});
 try{
  socket=net.connect(f.clientPort,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');socket.write(`CONNECT localhost:${f.httpsPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);await once(socket,'data');socket.end();
  await waitFor(()=>deletes>0);assert.equal((await request(f)).status,200);
 }finally{socket?.destroy();await f.close();}
});

test('cancellation does not drain an unexpected response body or block the next slot',async()=>{
 const f=await fixture({clientOptions:{maxSessions:1}});let socket,bodyResponse,deadline;
 const handlers=f.relay.server.listeners('request');f.relay.server.removeAllListeners('request');
 f.relay.server.on('request',(req,res)=>{if(req.method==='DELETE'){bodyResponse=res;res.writeHead(404);res.write('unexpected body that stays open');return;}for(const handler of handlers)handler(req,res);});
 try{
  socket=net.connect(f.clientPort,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');socket.write(`CONNECT localhost:${f.httpsPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);await once(socket,'data');socket.end();
  const response=await Promise.race([request(f),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('cancel body held the client slot')),1000);})]);
  assert.equal(response.status,200);
 }finally{clearTimeout(deadline);bodyResponse?.end();socket?.destroy();await f.close();}
});
