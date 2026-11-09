import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Budget, persistLedger } from '../budget.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-durable-'));

test('ledger write is open/write/fsync/close before the atomic rename', () => {
  const dir = tmpdir(), calls = [];
  try {
    const file = path.join(dir, 'usage.json');
    const io = Object.fromEntries(['mkdirSync','openSync','writeSync','fsyncSync','closeSync','renameSync','unlinkSync']
      .map(name => [name, (...args) => { calls.push(name); return fs[name](...args); }]));
    persistLedger(file, { month: '2026-11', used: 10 }, io);
    const order = calls.filter(name => name !== 'mkdirSync');
    // First five operations are the file itself; POSIX adds a directory fsync after rename.
    assert.deepEqual(order.slice(0, 5), ['openSync','writeSync','fsyncSync','closeSync','renameSync']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { month: '2026-11', used: 10 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed fsync never renames and never records unpersisted traffic', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'usage.json');
    new Budget({ limit: 100, file }).consume(40);
    const io = { ...fs, mkdirSync: fs.mkdirSync, openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync,
      renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, fsyncSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    assert.throws(() => persistLedger(file, { month: new Date().toISOString().slice(0, 7), used: 90 }, io), /EIO/);
    assert.equal(new Budget({ limit: 100, file }).used, 40, 'previous ledger must survive');
    assert.deepEqual(fs.readdirSync(dir), ['usage.json'], 'temporary must be removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('process killed after a partial temporary write leaves a recoverable ledger', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'usage.json');
    new Budget({ limit: 1000, file }).consume(123);
    // A separate process starts the same write sequence and is hard-killed
    // after a partial write, before fsync/rename.
    const script = `const fs=require('node:fs');const fd=fs.openSync(process.argv[1]+'.'+process.pid+'.tmp','w');fs.writeSync(fd,'{"month":"20');process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['-e', script, file]);
    assert.notEqual(child.status, 0, 'child must die abruptly');
    assert.ok(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), 'partial temporary left behind');
    const recovered = new Budget({ limit: 1000, file }); // must not throw (USAGE_INVALID)
    assert.equal(recovered.used, 123);
    assert.deepEqual(fs.readdirSync(dir), ['usage.json'], 'stale partial temporary is cleaned up, never trusted');
    recovered.consume(1);
    assert.equal(new Budget({ limit: 1000, file }).used, 124);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
