import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers/instabox.mjs';
import { createInstaboxSandbox } from '../src/providers/instabox.mjs';

const KEY = 'ib-secret-key';
const done = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };
const timing = { pollMs: 5, timeoutMs: 100 };

function fakeSdk() {
  const calls = { create: [], snapshot: [], connect: [], list: [], kill: [] };
  const box = () => ({
    sandboxId: 'm-1', kill: async () => true, getInfo: async () => ({ name: 'machine-x' }),
    files: { write: async () => {}, read: async () => new Uint8Array() },
    commands: { run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
    createSnapshot: async (o) => { calls.snapshot.push(o); return { id: 'snap-1', status: 'pending' }; },
  });
  return { calls, sdk: { Sandbox: {
    create: async (image, opts) => { calls.create.push({ image, opts }); return box(); },
    connect: async (id, opts) => { calls.connect.push({ id, opts }); return box(); },
    getSnapshot: async (id) => ({ id, status: 'ready' }),
    list: async (opts) => { calls.list.push(opts); return [{ sandboxId: 'm1', name: 'box', state: 'running', startedAt: '2026-01-02T03:04:05Z', archiveAt: '2026-01-03T03:04:05Z', metadata: { role: 'coordinator' }, machine: { deleteAt: '2026-01-04T00:00:00Z' } }]; },
    kill: async (id, opts) => { calls.kill.push({ id, opts }); return !String(id).startsWith('gone'); },
  } } };
}
function fakeFetch(handler = () => new Response('{}')) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (init.method === 'GET' && /secrets$/.test(String(url))) return Response.json(done);
    return handler(String(url), init);
  };
  return { f, calls };
}

test('provider.create sends the same SDK call and secrets PATCH as createInstaboxSandbox', async () => {
  const a = fakeSdk(), fa = fakeFetch(), b = fakeSdk(), fb = fakeFetch();
  const env = { INSTABOX_API_KEY: KEY };
  const sbx = await createProvider(env, { sdk: a.sdk, fetchFn: fa.f, timing })
    .create({ image: 'agent-browser', envs: { A: '1' }, labels: { purpose: 'cloudy-cloud', owner: 'o1' }, ttlSeconds: 21600, secrets: ['MCP_X_TOKEN'] });
  await createInstaboxSandbox(env, b.sdk, fb.f, timing, 'o1')({ A: '1' }, { deleteAfterSeconds: 21600, secrets: ['MCP_X_TOKEN'] });
  assert.equal(sbx.id, 'm-1');
  assert.deepEqual(Object.keys(a.calls.create[0].opts), Object.keys(b.calls.create[0].opts));
  const strip = (c) => ({ ...c, opts: { ...c.opts, fetch: undefined } });
  assert.deepEqual(strip(a.calls.create[0]), strip(b.calls.create[0]));
  assert.equal(a.calls.create[0].opts.archiveMs, 8 * 3600_000);
  assert.deepEqual(fa.calls.map((c) => [c.method, c.url, c.body]), fb.calls.map((c) => [c.method, c.url, c.body]));
  assert.equal(fa.calls[0].body, '{"secrets":["GH_TOKEN","MCP_X_TOKEN"]}');
  assert.ok(!JSON.stringify(fa.calls).includes('ghp_'));
});

test('coordinator-style create: name, neverSuspend (no archiveMs), name from getInfo', async () => {
  const { sdk, calls } = fakeSdk();
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: fakeFetch().f, timing });
  const s1 = await p.create({ image: 'snap', labels: { purpose: 'cloudy-cloud', role: 'coordinator' }, name: 'coord-a', ttlSeconds: 60, neverSuspend: true });
  assert.equal(s1.name, 'machine-x'); // the server's name, as the coordinator used
  assert.deepEqual(Object.keys(calls.create[0].opts), ['apiKey', 'name', 'autoSuspendMs', 'metadata', 'fetch']);
  assert.equal(calls.create[0].opts.autoSuspendMs, 0);
  assert.equal(calls.create[0].opts.archiveMs, undefined);
  const s2 = await p.create({ image: 'tpl', labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 60, neverSuspend: true });
  assert.equal(s2.name, 'machine-x');
});

test('caps follow the environment', () => {
  const c = createProvider({ CLOUDY_CLOUD_MAX_INSTABOX_CALLS: '7', CLOUDY_CLOUD_STARTS_PER_MIN: '3' }).caps;
  assert.equal(c.maxConcurrentCalls, 7);
  assert.equal(c.startsPerMin, 3);
  const d = createProvider({}).caps;
  assert.deepEqual([d.maxConcurrentCalls, d.startsPerMin, d.maxForegroundMs, d.maxTtlSeconds, d.uploadMaxBytes], [24, 25, 600000, 86400, 10485760]);
  assert.ok(d.hasServerTTL && d.hasProxySecrets && d.hasSnapshots && d.hasPortForward && d.hasPublish);
});

test('list uses raw GET with metadata, filters client-side and maps rows', async () => {
  const { f, calls } = fakeFetch(() => Response.json({ machines: [
    { id: 'a', name: 'n1', state: 'running', createdAt: '2026-01-01T00:00:00Z', metadata: { owner: 'o1', purpose: 'cloudy-cloud' }, deleteAt: '2026-01-02T00:00:00Z' },
    { id: 'b', name: 'n2', state: 'error', createdAt: '2026-01-01T00:00:00Z', metadata: { owner: 'other' } },
  ] }));
  const rows = await createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn: f }).list({ owner: 'o1' });
  assert.equal(calls[0].url, 'https://api.instabox.sh/v1/machines?metadata=owner%3Ao1');
  assert.deepEqual(calls[0].headers, { 'X-API-Key': KEY });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].status, rows[0].state, rows[0].deleteAt, rows[0].labels.owner], ['a', 'running', 'running', '2026-01-02T00:00:00Z', 'o1']);
});

test('delete sends the confirm headers; 404 resolves; 500 rejects after 3 attempts', async () => {
  const ok = fakeFetch(() => new Response('', { status: 404 }));
  await createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn: ok.f }).delete('x');
  assert.equal(ok.calls[0].url, 'https://api.instabox.sh/v1/machines/x');
  assert.equal(ok.calls[0].method, 'DELETE');
  assert.equal(ok.calls[0].headers['X-Confirm-Delete'], 'x');
  assert.ok(ok.calls[0].headers['Idempotency-Key']);
  const bad = fakeFetch(() => new Response('', { status: 500 }));
  await assert.rejects(createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn: bad.f }).delete('x'), (e) => e.code === 'transient');
  assert.equal(bad.calls.length, 3);
});

test('missing key gives code no_key; localMachineName; snapshot and ports', async () => {
  await assert.rejects(createProvider({}, { fetchFn: fakeFetch().f }).list({}), (e) => e.code === 'no_key');
  const spawned = [];
  const { sdk, calls } = fakeSdk();
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: fakeFetch().f, timing,
    spawn: async (argv, o) => { spawned.push([argv, o]); return { code: 0, stdout: '{"url":"https://u"}', stderr: '' }; } });
  assert.equal(p.localMachineName('instabox-abc'), 'abc');
  assert.equal(p.localMachineName('laptop'), '');
  assert.deepEqual(await p.snapshot(await p.connect('m-1'), { name: 's', description: 'd' }), { id: 'snap-1', status: 'pending' });
  assert.deepEqual(calls.snapshot[0], { name: 's', description: 'd' });
  assert.deepEqual(await p.getSnapshot('snap-1'), { id: 'snap-1', status: 'ready' });
  assert.deepEqual(await p.publishPort('m', '3000'), { url: 'https://u' });
  assert.deepEqual(spawned[0][0], ['npx', '--yes', 'instabox@latest', 'port', 'publish', 'm', '3000', '--private', '--json']);
  assert.equal(await p.forwardPort('m', '3000:80'), 0);
  assert.equal(spawned[1][1].inherit, true);
  assert.ok(!spawned[1][0].includes(KEY));
});

test('list and delete with { sdk: true } use the SDK with today\'s arguments; the default stays raw fetch', async () => {
  const { sdk, calls } = fakeSdk();
  const fx = fakeFetch();
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: fx.f });
  const rows = await p.list({ role: 'coordinator', name: 'a' }, { sdk: true });
  assert.deepEqual(calls.list, [{ apiKey: KEY, metadata: { role: 'coordinator', name: 'a' } }]);
  assert.deepEqual(rows, [{ id: 'm1', name: 'box', labels: { role: 'coordinator' }, state: 'running', status: 'running',
    startedAt: +new Date('2026-01-02T03:04:05Z'), archiveAt: +new Date('2026-01-03T03:04:05Z'), deleteAt: '2026-01-04T00:00:00Z' }]);
  await p.delete('m1', { sdk: true });
  await p.delete('gone-1', { sdk: true }); // Sandbox.kill returns false on 404: still deleted
  assert.deepEqual(calls.kill, [{ id: 'm1', opts: { apiKey: KEY } }, { id: 'gone-1', opts: { apiKey: KEY } }]);
  assert.equal(fx.calls.length, 0);
  assert.equal(calls.list.length, 1);
  await assert.rejects(createProvider({}, { sdk }).list({}, { sdk: true }), (e) => e.code === 'no_key');
});

test('delete retries and log: reaper style 3 attempts with a log line each, finish style 1 attempt', async () => {
  const bad = fakeFetch(() => new Response('', { status: 500 }));
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn: bad.f });
  const lines = [];
  await assert.rejects(p.delete('x', { retries: 2, log: (l) => lines.push(l) }), (e) => e.status === 500);
  assert.equal(bad.calls.length, 3);
  assert.deepEqual(lines, Array(3).fill('delete x failed: HTTP 500'));
  await assert.rejects(p.delete('y', { retries: 0 }), (e) => e.status === 500);
  assert.equal(bad.calls.length, 4);
});

test('the injected spawn gets the whole env object', async () => {
  const seen = [];
  const env = { INSTABOX_API_KEY: KEY, OTHER: '1' };
  const p = createProvider(env, { spawn: async (argv, o) => { seen.push(o.env); return { code: 0, stdout: '', stderr: '' }; } });
  await p.unpublishPort('m', '3000');
  assert.equal(seen[0], env);
});

// Wire assertions moved from test/reaper.test.mjs and test/open.test.mjs (reaper and `open` now go through the provider).
test('wire: list and delete use the raw API with the key, confirm and idempotency headers; delete retries twice', async () => {
  const calls = [];
  let d = 0;
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (init.method === 'DELETE') return Response.json({}, { status: [500, 500, 500][d++] ?? 500 });
    return Response.json({ machines: [{ id: 'm1', metadata: { owner: 'abc123def456' } }] });
  };
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn });
  assert.deepEqual((await p.list({ owner: 'abc123def456' })).map((m) => m.id), ['m1']);
  assert.equal(calls[0].url, 'https://api.instabox.sh/v1/machines?metadata=owner%3Aabc123def456');
  assert.equal(calls[0].headers['X-API-Key'], KEY);
  await assert.rejects(p.delete('m1'), (e) => !e.message.includes(KEY));
  const dels = calls.filter((c) => c.method === 'DELETE');
  assert.equal(dels.length, 3);
  assert.equal(dels[0].url, 'https://api.instabox.sh/v1/machines/m1');
  assert.equal(dels[0].headers['X-Confirm-Delete'], 'm1');
  assert.equal(dels[0].headers['X-API-Key'], KEY);
  assert.ok(dels[0].headers['Idempotency-Key']);
});

test('wire: port commands use the exact npx instabox argv and the key only in env', async () => {
  const calls = [];
  const spawn = async (argv, o) => { calls.push([argv, o]); return { code: 0, stdout: '{"url":"https://x.example/?_token=t"}' }; };
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { spawn });
  assert.equal(await p.forwardPort('mach-aaa', '8080:3000'), 0);
  assert.deepEqual(await p.publishPort('mach-aaa', '3000'), { url: 'https://x.example/?_token=t' });
  assert.equal(await p.unpublishPort('mach-aaa', '3000'), 0);
  assert.deepEqual(calls.map(([a]) => a), [
    ['npx', '--yes', 'instabox@latest', 'port-forward', 'mach-aaa', '8080:3000'],
    ['npx', '--yes', 'instabox@latest', 'port', 'publish', 'mach-aaa', '3000', '--private', '--json'],
    ['npx', '--yes', 'instabox@latest', 'port', 'unpublish', 'mach-aaa', '3000'],
  ]);
  assert.equal(calls[0][1].inherit, true);
  assert.ok(calls.every(([a, o]) => o.env.INSTABOX_API_KEY === KEY && !a.includes(KEY) && !a.includes('--public')));
});
