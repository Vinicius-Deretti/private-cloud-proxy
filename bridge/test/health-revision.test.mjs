import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { fixture, SECRET } from './fixtures.mjs';

const health = (f, headers = {}) => new Promise((resolve, reject) => {
  https.get({ hostname: 'localhost', port: f.relayPort, path: '/health', ca: fs.readFileSync(`${f.dir}/ca.pem`), headers }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, revision: res.headers['x-relay-revision'], body }));
  }).on('error', reject);
});

test('health stays public but discloses the relay revision only to authenticated callers', async () => {
  const previous = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = 'a'.repeat(40);
  const f = await fixture();
  try {
    const anonymous = await health(f);
    assert.equal(anonymous.status, 200); assert.equal(anonymous.body, 'ok');
    assert.equal(anonymous.revision, undefined, 'unauthenticated /health must not fingerprint the deployment');
    assert.equal((await health(f, { Authorization: 'Bearer wrong-secret-of-sufficient-length-xx' })).revision, undefined);
    const authenticated = await health(f, { Authorization: 'Bearer ' + SECRET });
    assert.equal(authenticated.status, 200); assert.equal(authenticated.revision, 'a'.repeat(40));
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = previous;
  }
});
