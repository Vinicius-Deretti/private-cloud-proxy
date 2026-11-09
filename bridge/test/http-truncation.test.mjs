import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request } from './fixtures.mjs';

test('origin cutting an HTTP response mid-body surfaces as an error, not a hang', async () => {
  const f = await fixture({ originHandler: (req, res) => {
    res.writeHead(200, { 'Content-Length': '100' }); res.write('partial');
    setTimeout(() => res.socket.destroy(), 20); return true;
  } });
  try {
    const outcome = await Promise.race([
      request(f).then(r => ({ kind: 'response', body: r.body }), error => ({ kind: 'error', code: error.code })),
      new Promise(resolve => setTimeout(() => resolve({ kind: 'hang' }), 5000)),
    ]);
    assert.notEqual(outcome.kind, 'hang', 'browser request must not hang');
    assert.ok(outcome.kind === 'error' || outcome.body.length < 100, JSON.stringify(outcome));
    if (outcome.kind === 'response') assert.ok(!outcome.body.includes('Tunnel unavailable'), 'no text appended to a started body');
  } finally { await f.close(); }
});
