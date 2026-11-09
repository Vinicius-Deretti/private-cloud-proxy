import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, pidAlive, LOCK_STALE_MS, LOCK_UNREADABLE_GRACE_MS } from '../lock.mjs';

const withDir = async fn => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-')); try { return await fn(path.join(dir, 'bridge.lock')); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
const age = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
const OTHER_PID = 424242;

test('a live, recently refreshed lock blocks a second client', () => withDir(file => {
  fs.writeFileSync(file, JSON.stringify({ pid: OTHER_PID, nonce: 'x' }));
  assert.throws(() => acquireLock(file, { isAlive: () => true, heartbeatMs: 0 }), error => error.code === 'LOCK_HELD');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, OTHER_PID, 'active lock is untouched');
}));

test('PID reused after a crash: alive PID but expired heartbeat is stale', () => withDir(file => {
  fs.writeFileSync(file, JSON.stringify({ pid: OTHER_PID, nonce: 'x' }));
  age(file, LOCK_STALE_MS + 1000);
  const lock = acquireLock(file, { isAlive: () => true, heartbeatMs: 0 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  lock.release(); assert.ok(!fs.existsSync(file));
}));

test('a dead PID is stale even when recent, including legacy bare-PID locks', () => withDir(file => {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = Number(child.stdout.toString()); // exited: really dead on this OS
  fs.writeFileSync(file, String(deadPid));
  const lock = acquireLock(file, { heartbeatMs: 0 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  lock.release();
}));

test('pidAlive reports this process; unreadable locks become stale after a short grace', () => withDir(file => {
  assert.equal(pidAlive(process.pid), true);
  fs.writeFileSync(file, '{"pid":');
  assert.throws(() => acquireLock(file, { heartbeatMs: 0 }), error => error.code === 'LOCK_HELD', 'possibly mid-creation');
  age(file, LOCK_UNREADABLE_GRACE_MS + 1000);
  acquireLock(file, { heartbeatMs: 0 }).release();
}));

test('release never deletes a lock that now belongs to someone else; heartbeat refreshes mtime', async () => withDir(async file => {
  const lock = acquireLock(file, { heartbeatMs: 20 });
  age(file, 60_000);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 5_000, 'heartbeat must refresh the lock');
  fs.writeFileSync(file, JSON.stringify({ pid: OTHER_PID, nonce: 'someone-else' }));
  lock.release();
  assert.ok(fs.existsSync(file), 'foreign lock must survive our release');
}));
