import { test } from 'node:test';
import assert from 'node:assert/strict';
import { target, resolvePublicAddresses, createCachedPublicResolver } from '../policy.mjs';

test('hostnames with underscores in labels are accepted', () => {
  for (const host of ['a_b.example.com', '_service.example.com', 'cdn_1.edge_node.example.net', 'x_.example.com'])
    assert.deepEqual(target(host, 443), { host, port: 443 });
});

test('underscore support does not loosen other hostname syntax', () => {
  for (const host of ['-a.example.com', 'a-.example.com', 'a..example.com', 'a b.example.com', 'a/b.example.com', 'a@b.example.com', `${'a'.repeat(64)}.example.com`, 'a%2e.example.com'])
    assert.throws(() => target(host, 443), host);
  assert.throws(() => target('a_b.example.com', 22), 'port policy still applies');
});

test('underscore hostnames resolving to private, loopback or metadata addresses stay blocked', async () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', '192.168.1.1', '::ffff:127.0.0.1']) {
    const lookup = async () => [{ address }];
    await assert.rejects(resolvePublicAddresses('a_b.example.com', lookup), error => error.code === 'DNS_REJECTED', address);
  }
  await assert.rejects(resolvePublicAddresses('a_b.example.com', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]), error => error.code === 'DNS_REJECTED', 'mixed answer fails closed');
  assert.deepEqual(await resolvePublicAddresses('a_b.example.com', async () => [{ address: '93.184.216.34' }]), ['93.184.216.34']);
  const cached = createCachedPublicResolver({ resolve: async () => ['10.0.0.1'] });
  await assert.rejects(cached('a_b.example.com'), error => error.code === 'DNS_REJECTED');
});
