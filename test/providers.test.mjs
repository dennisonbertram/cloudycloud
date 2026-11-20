import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadProvider } from '../src/providers/index.mjs';
import { contractSuite } from './provider-contract.mjs';
import { createFakeProvider } from './fake-provider.mjs';

contractSuite('fake', ({ withKey }) => createFakeProvider(withKey ? { FAKE_API_KEY: 'k' } : {}));
contractSuite('fake without snapshots', ({ withKey }) => createFakeProvider(withKey ? { FAKE_API_KEY: 'k' } : {}, { hasSnapshots: false }));
contractSuite('fake with linux only', ({ withKey }) => createFakeProvider(withKey ? { FAKE_API_KEY: 'k' } : {}, { machineKinds: ['linux'] }));

test('fake provider records the kind and serves shell and display', async () => {
  const p = createFakeProvider();
  const s = await p.create({ image: 'x', envs: {}, labels: {}, ttlSeconds: 60, kind: { name: 'gpu', gpu: 'l4' } });
  assert.deepEqual(p.log.create[0].kind, { name: 'gpu', gpu: 'l4' });
  assert.deepEqual(p.shellArgv(s.id, ['ls']), ['fake-ssh', s.id, 'ls']);
  const l = await p.displayLink(s.id, { control: true });
  assert.equal(l.url, `https://fake.example/desktop/${s.id}#tok`);
  await p.revokeDisplayLinks(s.id);
  assert.deepEqual(p.log.display.map((d) => d.op), ['link', 'revoke']);
  assert.equal((await p.screenshot(s.id))[0], 0x89);
});

test('loadProvider rejects an unknown provider name', async () => {
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'nope' }), { message: 'Unknown CLOUDY_CLOUD_PROVIDER "nope". Known: instabox, self-hosted, microsandbox, zipbox.' });
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'constructor' }), /Unknown CLOUDY_CLOUD_PROVIDER/);
});

// The adapter lands in a separate change; these run once src/providers/instabox.mjs exists.
const adapter = existsSync(new URL('../src/providers/instabox.mjs', import.meta.url));
test('loadProvider defaults to instabox and accepts it by name', { skip: !adapter && 'adapter not present yet' }, async () => {
  assert.equal((await loadProvider({})).name, 'instabox');
  assert.equal((await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'instabox' })).name, 'instabox');
});
