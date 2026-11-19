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
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'nope' }), { message: 'Unknown CLOUDY_CLOUD_PROVIDER "nope". Known: instabox, self-hosted, microsandbox.' });
  await assert.rejects(loadProvider({ CLOUDY_CLOUD_PROVIDER: 'constructor' }), /Unknown CLOUDY_CLOUD_PROVIDER/);
});

// The adapter lands in a separate change; these run once src/providers/instabox.mjs exists.
const adapter = existsSync(new URL('../src/providers/instabox.mjs', import.meta.url));
test('loadProvider defaults to instabox and accepts it by name', { skip: !adapter && 'adapter not present yet' }, async () => {
  assert.equal((await loadProvider({})).name, 'instabox');
  assert.equal((await loadProvider({ CLOUDY_CLOUD_PROVIDER: 'instabox' })).name, 'instabox');
});

test('providerNames reads the list, the single name, or the default', () => {
  assert.deepEqual(providerNames({}), ['instabox']);
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDER: 'microsandbox' }), ['microsandbox']);
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: 'instabox, microsandbox' }), ['instabox', 'microsandbox']);
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: 'microsandbox instabox' }), ['microsandbox', 'instabox']);
});

test('providerNames: the list wins over the single name; duplicates and empty entries are dropped', () => {
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: 'microsandbox', CLOUDY_CLOUD_PROVIDER: 'instabox' }), ['microsandbox']);
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: 'instabox,microsandbox,instabox microsandbox' }), ['instabox', 'microsandbox']);
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: 'instabox,, microsandbox,' }), ['instabox', 'microsandbox']);
  // A list that names nothing counts as unset, so the single name applies.
  assert.deepEqual(providerNames({ CLOUDY_CLOUD_PROVIDERS: ' , ', CLOUDY_CLOUD_PROVIDER: 'self-hosted' }), ['self-hosted']);
});

test('providerNames rejects an unknown name with the same text as the single-name path', () => {
  assert.throws(() => providerNames({ CLOUDY_CLOUD_PROVIDERS: 'instabox,nope' }), { message: 'Unknown CLOUDY_CLOUD_PROVIDER "nope". Known: instabox, self-hosted, microsandbox.' });
  assert.throws(() => providerNames({ CLOUDY_CLOUD_PROVIDER: 'constructor' }), /Unknown CLOUDY_CLOUD_PROVIDER/);
});

test('loadProviders returns every configured adapter in order; loadProvider combines them', async () => {
  const env = { CLOUDY_CLOUD_PROVIDERS: 'instabox,self-hosted', CLOUDY_CLOUD_SSH_HOST: 'u@h' };
  const ps = await loadProviders(env);
  assert.deepEqual(ps.map((p) => p.name), ['instabox', 'self-hosted']);
  const many = await loadProvider(env);
  assert.deepEqual(many.providers.map((p) => p.name), ['instabox', 'self-hosted']);
  // One configured name returns the adapter itself, not a combine wrapper.
  const one = await loadProvider({ CLOUDY_CLOUD_PROVIDERS: 'instabox' });
  assert.equal(one.name, 'instabox');
  assert.equal(one.providers, undefined);
});

const pair = () => ({ a: createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a' }), b: createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b' }) });
const mk = (p, labels = { purpose: 'cloudy-cloud' }) => p.create({ image: 'x', envs: {}, labels, ttlSeconds: 60 });

test('combine lists the union of all providers, each row tagged with its provider name', async () => {
  const { a, b } = pair();
  const c = combine([a, b]);
  await mk(a, { owner: 'o' }); await mk(b, { owner: 'o' });
  const rows = await c.list({ owner: 'o' });
  assert.deepEqual(rows.map((r) => `${r.id}@${r.provider}`).sort(), ['a-1@a', 'b-1@b']);
});

test('combine routes delete and connect to the provider that listed the id', async () => {
  const { a, b } = pair();
  const c = combine([a, b]);
  await mk(a); await mk(b);
  await c.list();
  await c.delete('b-1');
  assert.deepEqual(a.log.delete, []);
  assert.deepEqual(b.log.delete, ['b-1']);
  const sbx = await c.connect('a-1');
  assert.equal(sbx.id, 'a-1');
  assert.deepEqual(a.log.connect, ['a-1']);
});

test('connect of an id no list has seen lists once, then routes', async () => {
  const { a, b } = pair();
  const c = combine([a, b]);
  await mk(b);
  const sbx = await c.connect('b-1');
  assert.equal(sbx.id, 'b-1');
  assert.deepEqual(b.log.list, [{ purpose: 'cloudy-cloud' }]);
  assert.deepEqual(b.log.connect, ['b-1']);
  await assert.rejects(c.connect('nope-1'), { code: 'not_found' });
});

test('an id listed by two providers throws instead of guessing', async () => {
  const { a, b } = pair();
  const row = (id) => ({ id, name: 'n', labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: 1 });
  a.machines.set('dup-1', row('dup-1'));
  b.machines.set('dup-1', row('dup-1'));
  const c = combine([a, b]);
  await assert.rejects(c.connect('dup-1'), /more than one provider/);
  await assert.rejects(c.delete('dup-1'), /more than one provider/);
  await assert.rejects(c.metrics('dup-1'), /more than one provider/);
});

test('a failing provider still yields the other rows and reports the error tagged with its name', async () => {
  const { a, b } = pair();
  a.list = async () => { throw Object.assign(new Error('a is down'), { code: 'transient' }); };
  await mk(b);
  const seen = [];
  const rows = await combine([a, b]).list({}, { onError: (e) => seen.push(e) });
  assert.deepEqual(rows.map((r) => r.id), ['b-1']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'a is down');
  assert.equal(seen[0].provider, 'a');
});

test('combine list throws the first error only when every provider failed', async () => {
  const { a, b } = pair();
  a.list = async () => { throw new Error('a down'); };
  b.list = async () => { throw new Error('b down'); };
  await assert.rejects(combine([a, b]).list(), { message: 'a down' });
  b.list = async () => [];
  assert.deepEqual(await combine([a, b]).list(), []);
});

test('combine caps: booleans are AND-ed, numbers and text come from the primary', async () => {
  const { a, b } = pair();
  b.caps = { ...b.caps, hasDisplay: false, maxTtlSeconds: 1, machineKinds: ['linux'] };
  const c = combine([a, b]);
  assert.equal(c.caps.hasDisplay, false, 'AND-ed boolean');
  assert.equal(c.caps.hasProxySecrets, true, 'true on both stays true');
  assert.equal(c.caps.maxTtlSeconds, a.caps.maxTtlSeconds, 'a number comes from the primary');
  assert.deepEqual(c.caps.machineKinds, ['linux'], 'a list is the intersection');
  assert.equal(c.keyName, 'FAKE_API_KEY');
  assert.equal(c.name, 'a');
  assert.equal(c.text, a.text);
  assert.deepEqual(c.providers, [a, b]);
});

test('combine.for resolves a machine row or id to its provider after a list', async () => {
  const { a, b } = pair();
  const c = combine([a, b]);
  await mk(b);
  assert.equal(c.for('b-1'), undefined, 'no list yet');
  const rows = await c.list();
  assert.equal(c.for(rows[0]), b);
  assert.equal(c.for('b-1'), b);
  assert.equal(c.for({ provider: 'a', id: 'unseen' }), a);
  await c.metrics('b-1');
  assert.deepEqual(b.log.metrics.map((m) => m.id), ['b-1']);
  assert.deepEqual(a.log.metrics, []);
});
