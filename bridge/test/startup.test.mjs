import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {fixture,SECRET} from './fixtures.mjs';
const run=promisify(execFile);
const launcher=new URL('../start.mjs',import.meta.url);
const TEST_SECRET='startup-test-secret-only-not-production-123';
async function failedStartup({secret=TEST_SECRET,ledger,endpoint='wss://private-cloud-proxy-free.onrender.com/tunnel',extraEnv={},allowAccountedAdvance=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-startup-'));
 try{
  // Discovery stub only: the failing startup must never launch this file.
  const browser=path.join(dir,'Google','Chrome','Application','chrome.exe');fs.mkdirSync(path.dirname(browser),{recursive:true});fs.writeFileSync(browser,'');
  const data=path.join(dir,'PrivateCloudProxy');fs.mkdirSync(data);
  if(ledger!==undefined)fs.writeFileSync(path.join(data,'bridge-usage.json'),ledger);
  let result;
  try{await run(process.execPath,[fileURLToPath(launcher)],{timeout:5000,env:{...process.env,ProgramFiles:dir,LOCALAPPDATA:dir,TUNNEL_URL:endpoint,TUNNEL_TOKEN:secret,...extraEnv}});assert.fail('startup unexpectedly succeeded');}
  catch(error){if(error.code==='ERR_ASSERTION')throw error;result=error;}
  assert.equal(result.code,1,result.stderr);
  assert.ok(!fs.existsSync(path.join(data,'bridge.lock')),'startup failure must release its lock');
  if(secret)assert.ok(!result.stderr.includes(secret),'diagnostics must not expose the secret');
  assert.ok(!result.stderr.includes('do-not-expose-this-data'),'diagnostics must not expose ledger contents');
  if(ledger!==undefined){
   const persisted=fs.readFileSync(path.join(data,'bridge-usage.json'),'utf8');
   if(allowAccountedAdvance){
    const before=JSON.parse(ledger),after=JSON.parse(persisted);
    assert.equal(after.month,before.month);
    assert.ok(after.used>=before.used && after.used<=before.used+256*1024,'recorded allowance may only advance by one durable reservation');
   }else assert.equal(persisted,ledger,'must preserve the usage ledger');
  }
  return result.stderr;
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('startup identifies incomplete secret without exposing its value',async()=>{
 assert.match(await failedStartup({secret:'short-test-secret'}),/SECRET_INVALID/);
});
test('startup identifies invalid usage ledger and preserves it',async()=>{
 assert.match(await failedStartup({ledger:'{"invalid":"do-not-expose-this-data"}'}),/USAGE_INVALID/);
});
test('startup identifies a busy loopback port and releases its lock',async()=>{
 const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(17831,'127.0.0.1',resolve);});
 try{assert.match(await failedStartup(),/LOCAL_PORT_BUSY/);}
 finally{await new Promise(resolve=>listener.close(resolve));}
});

test('startup requires an interactive terminal when no secure credential is supplied',async()=>{
 assert.match(await failedStartup({secret:''}),/INTERACTIVE_REQUIRED/);
});

test('startup reports remote quota exhaustion before attempting to launch the browser',async()=>{
 const f=await fixture({relayOptions:{processBytes:8191}});
 try{assert.match(await failedStartup({secret:SECRET,endpoint:`wss://localhost:${f.relayPort}/tunnel`,extraEnv:{NODE_EXTRA_CA_CERTS:`${f.dir}/ca.pem`}}),/REMOTE_TRAFFIC_LIMIT/);}
 finally{await f.close();}
});

test('existing 512 MiB ledger is preserved and no longer blocks a 4 GiB client budget',async()=>{
 const f=await fixture(); const ledger=JSON.stringify({month:new Date().toISOString().slice(0,7),used:512*1024*1024});
 try {
  const stderr=await failedStartup({secret:SECRET+'wrong',ledger,endpoint:`wss://localhost:${f.relayPort}/tunnel`,extraEnv:{NODE_EXTRA_CA_CERTS:`${f.dir}/ca.pem`},allowAccountedAdvance:true});
  assert.match(stderr,/RELAY_AUTH_FAILED/);
  assert.doesNotMatch(stderr,/CLIENT_TRAFFIC_LIMIT/);
 } finally {await f.close();}
});

test('exhausted 4 GiB budget refuses startup before requesting a secret',async()=>{
 const ledger=JSON.stringify({month:new Date().toISOString().slice(0,7),used:4*1024*1024*1024});
 const stderr=await failedStartup({secret:'',ledger});
 assert.match(stderr,/CLIENT_TRAFFIC_LIMIT/);
 assert.doesNotMatch(stderr,/SECRET_INVALID|INTERACTIVE_REQUIRED/);
});

test('browser process receives loopback port but no case variant of the tunnel secret',async()=>{
 const f=await fixture();const directory=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-browser-env-'));let child;
 try{
  const report=path.join(directory,'browser-report.json'),hook=path.join(directory,'browser-hook.cjs');
  fs.writeFileSync(hook,`if(process.env.PCP_PROXY_PORT)require('node:fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({port:process.env.PCP_PROXY_PORT,hasToken:Object.keys(process.env).some(key=>key.toUpperCase()==='TUNNEL_TOKEN')}));`);
  const env={...process.env,LOCALAPPDATA:directory,TUNNEL_URL:`wss://localhost:${f.relayPort}/tunnel`,TUNNEL_TOKEN:SECRET,tunnel_token:SECRET,PCP_PROTECTED_BROWSER_EXE:process.execPath,NODE_EXTRA_CA_CERTS:`${f.dir}/ca.pem`,NODE_OPTIONS:`--require "${hook.replaceAll('\\','/')}"`};delete env.PCP_PROXY_PORT;
  child=spawn(process.execPath,[fileURLToPath(launcher)],{env,stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();const exited=once(child,'exit');
  try{
   const deadline=Date.now()+4000;while(!fs.existsSync(report)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
   assert.ok(fs.existsSync(report),'protected browser process never started');
   assert.deepEqual(JSON.parse(fs.readFileSync(report,'utf8')),{port:'17831',hasToken:false});
  }finally{child.kill('SIGTERM');await exited;}
 }finally{await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});
