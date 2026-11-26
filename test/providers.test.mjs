import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { combine, loadProvider, loadProviders, providerNames } from '../src/providers/index.mjs';
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
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'nope' }), { message: 'Unknown CLOUDY_CLOUD_PROVIDER "nope". Known: instabox, self-hosted, microsandbox, boat, e2b.' });
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'constructor' }), /Unknown CLOUDY_CLOUD_PROVIDER/);
});

test('provider names are ordered, de-duplicated, and retain every existing adapter', () => {
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: 'boat, e2b instabox boat' }), ['boat', 'e2b', 'instabox']);
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDER: 'boat' }), ['boat']);
  assert.deepEqual(providerNames({}), ['instabox']);
  assert.throws(() => providerNames({ CLOUDY_CLOUD_PROVIDERS: 'instabox,not-a-provider' }), /Unknown CLOUDY_CLOUD_PROVIDER/);
});

test('loadProviders constructs all configured adapters in order', async () => {
  const providers = await loadProviders({ CLOUDY_CLOUD_PROVIDERS: 'boat,e2b' }, {
    fetchFn: async () => { throw new Error('unexpected network request'); },
  });
  assert.deepEqual(providers.map((p) => p.name), ['boat', 'e2b']);
});

test('combined provider tags rows and refuses to dispatch duplicate bare IDs', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'a' }, { name: 'a' });
  const b = createFakeProvider({ FAKE_API_KEY: 'b' }, { name: 'b' });
  const row = { id: 'same-id', name: 'x', labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() };
  a.machines.set(row.id, row);
  b.machines.set(row.id, row);
  const p = combine([a, b]);
  const rows = await p.list({ purpose: 'cloudy-cloud' });
  assert.deepEqual(rows.map((m) => m.provider), ['a', 'b']);
  assert.equal(p.for(rows[0]), a);
  await assert.rejects(p.connect('same-id'), { code: 'ambiguous' });
  await assert.rejects(p.delete('same-id'), { code: 'ambiguous' });
});

test('combined provider refuses bare-ID routing if any provider could not be listed', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'a' }, { name: 'a' });
  const b = createFakeProvider({ FAKE_API_KEY: 'b' }, { name: 'b' });
  b.machines.set('b-1', { id: 'b-1', name: 'x', labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() });
  a.list = async () => { throw Object.assign(new Error('list unavailable'), { code: 'transient' }); };
  const p = combine([a, b]);
  await assert.rejects(p.connect('b-1'), { code: 'provider_ownership_unavailable' });
  assert.equal(p.for({ provider: 'b' }), b, 'an explicit provider tag remains a safe routing key');
});

test('combined provider treats a reported list error as incomplete even when the adapter resolves empty', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'a' }, { name: 'a' });
  const b = createFakeProvider({ FAKE_API_KEY: 'b' }, { name: 'b' });
  b.machines.set('b-1', { id: 'b-1', name: 'x', labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() });
  a.list = async (_labels, opts) => { opts.onError(Object.assign(new Error('list unavailable'), { code: 'transient' })); return []; };
  const p = combine([a, b]);
  await assert.rejects(p.connect('b-1'), { code: 'provider_ownership_unavailable' });
});

// The adapter lands in a separate change; these run once src/providers/instabox.mjs exists.
const adapter = existsSync(new URL('../src/providers/instabox.mjs', import.meta.url));
test('loadProvider defaults to instabox and accepts it by name', { skip: !adapter && 'adapter not present yet' }, async () => {
  assert.equal((await loadProvider({})).name, 'instabox');
  assert.equal((await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'instabox' })).name, 'instabox');
});
