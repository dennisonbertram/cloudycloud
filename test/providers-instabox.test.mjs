import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createProvider } from '../src/providers/instabox.mjs';
import { createLimiter } from '../src/limits.mjs';
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

test('coordinator-style create: name, neverSuspend (no archiveMs), name from getInfo only when loadName is called', async () => {
  const { sdk, calls } = fakeSdk();
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: fakeFetch().f, timing });
  const s1 = await p.create({ image: 'snap', labels: { purpose: 'cloudy-cloud', role: 'coordinator' }, name: 'coord-a', ttlSeconds: 60, neverSuspend: true });
  assert.equal(s1.name, 'coord-a'); // getInfo is not called inside create; the coordinator asks later, as before
  assert.equal(await s1.loadName(), 'machine-x'); // the server's name, as the coordinator used
  assert.equal(s1.name, 'machine-x');
  assert.deepEqual(Object.keys(calls.create[0].opts), ['apiKey', 'name', 'autoSuspendMs', 'metadata', 'fetch']);
  assert.equal(calls.create[0].opts.autoSuspendMs, 0);
  assert.equal(calls.create[0].opts.archiveMs, undefined);
  const s2 = await p.create({ image: 'tpl', labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 60, neverSuspend: true });
  assert.equal(await s2.loadName(), 'machine-x');
});

test('retry:false (coordinators): a persistent 429 on a command is one attempt and no backoff; workers still retry', async () => {
  for (const [opts, tries] of [[{ retry: false }, 1], [{}, 8]]) {
    let runs = 0;
    const sleeps = [];
    const { sdk } = fakeSdk();
    const create = sdk.Sandbox.create;
    sdk.Sandbox.create = async (...a) => { const b = await create(...a); b.commands.run = async () => { runs++; throw Object.assign(new Error('slow down'), { status: 429 }); }; return b; };
    const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: fakeFetch().f, timing, sleep: async (ms) => { sleeps.push(ms); } });
    const sbx = await p.create({ image: 'snap', labels: {}, ttlSeconds: 60, ...opts });
    await assert.rejects(sbx.commands.run('x'), (e) => e.code === 'rate_limited');
    assert.equal(runs, tries);
    assert.equal(sleeps.length, tries - 1);
  }
});

test('connect with retry:false makes one attempt on a 429', async () => {
  let runs = 0;
  const { sdk } = fakeSdk();
  sdk.Sandbox.connect = async () => ({ sandboxId: 'm-1', commands: { run: async () => { runs++; throw Object.assign(new Error('x'), { status: 429 }); } } });
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: fakeFetch().f, sleep: async () => { throw new Error('slept'); } });
  await assert.rejects((await p.connect('m-1', { retry: false })).commands.run('x'), { code: 'rate_limited' });
  assert.equal(runs, 1);
});

test('list with onError returns the rows of earlier pages when a later page fails; without it, it throws', async () => {
  const row = { id: 'm1', metadata: { owner: 'o' }, state: 'running', createdAt: '2026-01-01T00:00:00Z' };
  const { f } = fakeFetch((url) => (url.includes('cursor=c2') ? new Response('no', { status: 500 }) : Response.json({ machines: [row], nextCursor: 'c2' })));
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn: f });
  const errs = [];
  const rows = await p.list({ owner: 'o' }, { onError: (e) => errs.push(e.message) });
  assert.deepEqual(rows.map((r) => r.id), ['m1']);
  assert.match(errs[0], /HTTP 500/);
  await assert.rejects(p.list({ owner: 'o' }), /HTTP 500/);
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

test('a coordinator reads its API key from the CLOUDY_CLOUD_INSTABOX_API_KEY placeholder when INSTABOX_API_KEY is unset', async () => {
  const { calls, sdk } = fakeSdk();
  await createProvider({ CLOUDY_CLOUD_INSTABOX_API_KEY: 'ibsec_placeholder' }, { sdk }).list({}, { sdk: true });
  assert.equal(calls.list[0].apiKey, 'ibsec_placeholder');
});

// ---- machine kinds, shell and display (#93, #89) ----
async function createKind(kind, extra = {}) {
  const { sdk, calls } = fakeSdk();
  let body;
  const f = fakeFetch((url, init) => { body = init.body; return new Response('{}'); });
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk, fetchFn: f.f, timing });
  const sbx = await p.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 600, kind, ...extra });
  const { image, opts } = calls.create[0];
  await opts.fetch('https://api.instabox.sh/v1/machines', { method: 'POST', body: JSON.stringify({ image }) });
  return { image, body: JSON.parse(body), sbx };
}

test('kinds: the default and an explicit linux kind send the same request (agent-browser, no extra fields)', async () => {
  const a = await createKind(undefined), b = await createKind({ name: 'linux' });
  assert.equal(a.image, 'agent-browser');
  assert.deepEqual(a.body, { image: 'agent-browser', deleteAfterSeconds: 600 });
  assert.deepEqual(b.body, a.body);
});

test('kinds: android, omarchy and gpu map to their template ids and gpu to the REST gpu field', async () => {
  assert.equal((await createKind({ name: 'android' })).image, 'android');
  assert.equal((await createKind({ name: 'omarchy' })).image, 'omarchy');
  const g = await createKind({ name: 'gpu' });
  assert.equal(g.image, 'gpu');
  assert.equal(g.body.gpu, 'l4');
  assert.equal((await createKind({ name: 'gpu', gpu: 'l4:2' })).body.gpu, 'l4:2');
  assert.equal(g.body.deleteAfterSeconds, 600);
});

test('kinds: macos sends acceptMinimumLease and the model, and reads home from the machine', async () => {
  const { sdk, calls } = fakeSdk();
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk: { Sandbox: { ...sdk.Sandbox, create: async (i, o) => { calls.create.push({ image: i, opts: o }); return { sandboxId: 'mac-1', kill: async () => {}, files: {}, commands: { run: async (c) => ({ stdout: c.includes('$HOME') ? '/Users/admin' : '', stderr: '', exitCode: 0 }) } }; } } }, fetchFn: fakeFetch().f, timing });
  const s = await p.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 600, kind: { name: 'macos', model: 'm4' } });
  assert.equal(calls.create[0].image, 'macos');
  assert.equal(s.home, '/Users/admin');
  let body;
  const f2 = fakeFetch((u, i) => { if (i.method === 'POST') body = i.body; return new Response('{}'); });
  const p2 = createProvider({ INSTABOX_API_KEY: KEY }, { sdk: { Sandbox: { create: async (i, o) => { await o.fetch('https://api.instabox.sh/v1/machines', { method: 'POST', body: '{}' }); return { sandboxId: 'm', kill: async () => {}, commands: { run: async () => ({ stdout: '/Users/x' }) } }; } } }, fetchFn: f2.f, timing });
  await p2.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 600, kind: { name: 'macos', model: 'm4' } });
  assert.equal(JSON.parse(body).acceptMinimumLease, true);
  assert.equal(JSON.parse(body).model, 'm4');
});

test('kinds: create errors map to the machine_* codes', async () => {
  const cases = [
    [{ status: 403, code: 'template_not_allowed' }, 'machine_not_on_plan'],
    [{ status: 403, code: 'template_limit' }, 'machine_gpu_limit'],
    [{ status: 503 }, 'machine_no_capacity'],
    [{ status: 503, code: 'no_capacity' }, 'machine_no_capacity'], // SDK-shaped: the SDK always sets code
    [{ status: 0, code: 'no_capacity' }, 'machine_no_capacity'], // a failed async create
  ];
  for (const [err, want] of cases) {
    const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk: { Sandbox: { create: async () => { throw Object.assign(new Error('x'), err); } } }, fetchFn: fakeFetch().f, timing });
    await assert.rejects(p.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 60, kind: { name: 'gpu' } }), (e) => e.code === want, want);
  }
  // a linux 503 stays transient
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk: { Sandbox: { create: async () => { throw Object.assign(new Error('x'), { status: 503 }); } } }, fetchFn: fakeFetch().f, timing });
  await assert.rejects(p.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 60 }), (e) => e.code === 'transient');
});

test('shellArgv keeps every argument separate and the key out of argv', () => {
  const p = createProvider({ INSTABOX_API_KEY: KEY }, {});
  assert.deepEqual(p.shellArgv('m1'), ['npx', '--yes', 'instabox@latest', 'ssh', 'm1']);
  assert.deepEqual(p.shellArgv('m1', ['ls', '-la', 'a b']), ['npx', '--yes', 'instabox@latest', 'ssh', 'm1', '--', '-T', "'ls' '-la' 'a b'"]);
  assert.equal(p.caps.hasShell, true);
  assert.deepEqual(p.caps.machineKinds, ['linux', 'android', 'omarchy', 'gpu', 'macos']);
});

function desktopSdk({ desktop }) {
  const log = [];
  const d = {
    status: async () => { log.push('status'); return desktop.status?.() ?? { installed: true, running: true }; },
    start: async () => { log.push('start'); return desktop.start?.() ?? { installed: true, running: true }; },
    streamUrl: async (o) => { log.push(['stream', o]); if (desktop.stream) throw desktop.stream; return { url: 'https://dashboard.instabox.sh/desktop/m-1#t', expiresAt: new Date(0) }; },
    revokeStreamUrls: async () => { log.push('revoke'); },
    screenshot: async () => { log.push('shot'); if (desktop.shot) throw desktop.shot; return new Uint8Array([1, 2]); },
  };
  return { log, sdk: { Sandbox: { connect: async () => ({ sandboxId: 'm-1', desktop: d }) } } };
}
const mk = (o) => { const x = desktopSdk(o); return { ...x, p: createProvider({ INSTABOX_API_KEY: KEY }, { sdk: x.sdk, fetchFn: fakeFetch().f, timing }) }; };

test('displayLink: a running desktop gets a view-only link by default; control asks for a control link', async () => {
  const { p, log } = mk({ desktop: {} });
  const r = await p.displayLink('m-1', { ttlSeconds: 300 });
  assert.equal(r.url, 'https://dashboard.instabox.sh/desktop/m-1#t');
  assert.deepEqual(log, ['status', ['stream', { viewOnly: true, ttlSeconds: 300 }]]);
  await p.displayLink('m-1', { control: true });
  assert.equal(log.at(-1)[1].viewOnly, false);
});

test('displayLink starts a desktop that is not running; revoke and screenshot call the SDK', async () => {
  const { p, log } = mk({ desktop: { status: () => ({ installed: false, running: false }) } });
  await p.displayLink('m-1');
  assert.deepEqual(log.slice(0, 2), ['status', 'start']);
  await p.revokeDisplayLinks('m-1');
  assert.deepEqual([...await p.screenshot('m-1')], [1, 2]);
  assert.ok(log.includes('revoke') && log.includes('shot'));
});

test('omarchy desktop failures become desktop_unavailable; 403 permission_denied becomes display_forbidden', async () => {
  const bad = Object.assign(new Error('command exited with code 127: xdotool: command not found'), { code: 'command_exit', exitCode: 127 });
  const a = mk({ desktop: { status: () => { throw bad; } } });
  await assert.rejects(a.p.displayLink('m-1'), (e) => e.code === 'desktop_unavailable');
  const b = mk({ desktop: { shot: Object.assign(new Error("command exited with code 1: unable to open X server ':1'"), { code: 'command_exit', exitCode: 1 }) } });
  await assert.rejects(b.p.screenshot('m-1'), (e) => e.code === 'desktop_unavailable');
  const c = mk({ desktop: { stream: Object.assign(new Error('no'), { status: 403, code: 'permission_denied' }) } });
  await assert.rejects(c.p.displayLink('m-1'), (e) => e.code === 'display_forbidden');
});

test('desktop errors that are not the desktop failing keep their own codes', async () => {
  for (const [err, want] of [[{ status: 401, code: 'invalid_key' }, 'invalid_key'], [{ status: 403, code: 'missing_scope' }, 'missing_scope'],
    [{ status: 429, code: 'quota_exceeded' }, 'quota_exceeded'], [{ status: 503, code: 'host_unavailable' }, 'host_unavailable'],
    [{ status: 404 }, 'not_found'], [{ status: 502 }, 'transient']]) {
    const { p } = mk({ desktop: { status: () => { throw Object.assign(new Error('x'), err); } } });
    await assert.rejects(p.displayLink('m-1'), (e) => e.code === want, want);
  }
  const { p } = mk({ desktop: { status: () => { throw Object.assign(new Error('x'), { status: 0, code: 'desktop_not_running' }); } } });
  await assert.rejects(p.displayLink('m-1'), (e) => e.code === 'desktop_unavailable');
});

test('permission_denied keeps its own code outside the display calls', async () => {
  const denied = () => Object.assign(new Error('no'), { status: 403, code: 'permission_denied' });
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk: { Sandbox: { create: async () => { throw denied(); }, connect: async () => { throw denied(); } } }, fetchFn: fakeFetch().f, timing });
  await assert.rejects(p.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 60 }), (e) => e.code === 'permission_denied');
  await assert.rejects(p.connect('m-1'), (e) => e.code === 'permission_denied');
});

test('#89 shellArgv sends one quoted remote string that a shell parses back into the same arguments', () => {
  const p = createProvider({ env: { INSTABOX_API_KEY: KEY } });
  for (const cmd of [['sh', '-c', 'echo "a b" $(echo SUB); exit 7'], ['printf', '%s|', 'a b', "it's", 'x;y', '$HOME', '']]) {
    const argv = p.shellArgv('m1', cmd);
    assert.deepEqual(argv.slice(0, 6), ['npx', '--yes', 'instabox@latest', 'ssh', 'm1', '--']);
    assert.equal(argv.length, 8);
    assert.equal(argv[6], '-T');
    const r = spawnSync('sh', ['-c', argv[7]], { encoding: 'utf8' });
    const direct = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
    assert.equal(r.stdout, direct.stdout);
    assert.equal(r.status, direct.status);
  }
  const r = spawnSync('sh', ['-c', p.shellArgv('m1', ['sh', '-c', 'echo "a b" $(echo SUB); exit 7'])[7]], { encoding: 'utf8' });
  assert.equal(r.stdout, 'a b SUB\n');
  assert.equal(r.status, 7);
});

// ---- metrics (#116) ----
const NOW = Date.parse('2026-03-01T12:00:00Z');
const metricsProvider = (handler, extra = {}) => {
  const f = fakeFetch(handler);
  return { f, p: createProvider({ INSTABOX_API_KEY: KEY }, { sdk: fakeSdk().sdk, fetchFn: f.f, now: () => NOW, sleep: async () => {}, ...extra }) };
};
const full = { timestamp: '2026-03-01T11:59:30Z', cpuUsedPct: 12.5, cpuCount: 2, memUsed: 100, memTotal: 400, diskTotal: 9, diskUsed: 3, netInBytesPerSec: 10, netOutBytesPerSec: 20, diskReadBytesPerSec: 30, diskWriteBytesPerSec: 40, gpuCount: 1 };
const bare = { timestamp: '2026-03-01T11:59:00Z', cpuUsedPct: 1, cpuCount: 2, memUsed: 5, memTotal: 400, diskTotal: 9 };

test('metrics: one GET with the key header and since as ISO; maps samples with and without optional fields', async () => {
  const since = NOW - 600_000;
  const { p, f } = metricsProvider(() => Response.json({ metrics: [bare, full] }));
  const r = await p.metrics('m/1', { since });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.instabox.sh/v1/machines/m%2F1/metrics?since=${new Date(since).toISOString()}`);
  assert.deepEqual(f.calls[0].headers, { 'X-API-Key': KEY });
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[0].method ?? 'GET', 'GET');
  assert.equal(r.fetchedAt, NOW);
  assert.deepEqual(r.samples[0], { t: Date.parse(bare.timestamp), cpuPct: 1, cpuCount: 2, memUsed: 5, memTotal: 400, netIn: undefined, netOut: undefined, diskRead: undefined, diskWrite: undefined });
  assert.deepEqual(r.samples[1], { t: Date.parse(full.timestamp), cpuPct: 12.5, cpuCount: 2, memUsed: 100, memTotal: 400, netIn: 10, netOut: 20, diskRead: 30, diskWrite: 40 });
  assert.equal((await metricsProvider(() => Response.json({ metrics: [] })).p.metrics('m1')).samples.length, 0);
  assert.equal(p.caps.hasMetrics, true);
});

test('metrics: since defaults to one hour and is clamped to 24 hours', async () => {
  const { p, f } = metricsProvider(() => Response.json({ metrics: [] }));
  await p.metrics('m1');
  await p.metrics('m1', { since: NOW - 5 * 86_400_000 });
  const sinceOf = (c) => Date.parse(new URL(c.url).searchParams.get('since'));
  assert.equal(sinceOf(f.calls[0]), NOW - 3_600_000);
  assert.equal(sinceOf(f.calls[1]), NOW - 86_400_000);
});

test('metrics: each error status maps to a code and no message contains the key', async () => {
  const cases = [[404, { error: { code: 'not_found' } }, 'not_found'], [503, { error: { code: 'metrics_unavailable' } }, 'metrics_unavailable'], [403, { error: { code: 'missing_scope' } }, 'metrics_forbidden'], [403, { code: 'missing_scope' }, 'metrics_forbidden'], [401, {}, undefined], [500, {}, 'transient']];
  for (const [status, body, code] of cases) {
    const { p } = metricsProvider(() => new Response(JSON.stringify(body), { status }));
    await assert.rejects(p.metrics('m1'), (e) => e.code === code && !String(e.message).includes(KEY) && !JSON.stringify(e).includes(KEY), `${status}`);
  }
});

test('metrics: a response code or body containing the key never reaches the thrown error', async () => {
  for (const body of [{ error: { code: `x_${KEY}`, message: KEY } }, { code: KEY }, `plain ${KEY}`]) {
    const { p } = metricsProvider(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 400 }));
    await assert.rejects(p.metrics('m1'), (e) => !JSON.stringify(e, Object.getOwnPropertyNames(e)).includes(KEY) && e.message === 'metrics request failed (HTTP 400)');
  }
});

test('metrics: a fetch rejection carrying the key becomes a fixed transient error', async () => {
  const { p } = metricsProvider(() => { throw Object.assign(new Error(`connect failed ${KEY}`), { cause: new Error(KEY), request: { headers: { 'X-API-Key': KEY } } }); });
  await assert.rejects(p.metrics('m1'), (e) => e.code === 'transient' && e.cause === undefined && !JSON.stringify(e, Object.getOwnPropertyNames(e)).includes(KEY) && !String(e.stack).includes(KEY));
});

test('metrics: a stalled fetch times out as transient and frees the limiter slot', async () => {
  const limiter = createLimiter(1);
  const { p } = metricsProvider((url) => (url.includes('/metrics') ? new Promise(() => {}) : Response.json({})), { limiter, metricsTimeoutMs: 30 });
  const t0 = Date.now();
  const stalled = assert.rejects(p.metrics('m1'), { code: 'transient' });
  assert.equal(await limiter.run(async () => 'ran'), 'ran'); // queued behind the stalled call
  await stalled;
  assert.ok(Date.now() - t0 < 1000);
});

test('metrics: a future since is clamped to now', async () => {
  const { p, f } = metricsProvider(() => Response.json({ metrics: [] }));
  await p.metrics('m1', { since: NOW + 3_600_000 });
  assert.equal(Date.parse(new URL(f.calls[0].url).searchParams.get('since')), NOW);
});

test('metrics: a 429 is retried through the limiter, and the call runs inside a limiter slot', async () => {
  let n = 0, ran = 0;
  const limiter = { run: (fn) => { ran++; return fn(); } };
  const { p } = metricsProvider(() => (++n === 1 ? new Response('{}', { status: 429 }) : Response.json({ metrics: [bare] })), { limiter });
  assert.equal((await p.metrics('m1')).samples.length, 1);
  assert.equal(n, 2);
  assert.equal(ran, 2);
});

test('metrics: no key is no_key and no request is made', async () => {
  const f = fakeFetch();
  await assert.rejects(createProvider({}, { sdk: fakeSdk().sdk, fetchFn: f.f }).metrics('m1'), { code: 'no_key' });
  assert.equal(f.calls.length, 0);
});

// ---- plan (#127) ----
const ME = { org: { id: 'org-secret-id', tier: 'pro' }, allowedSpecs: [{ vcpus: 4, memMiB: 8192 }, { vcpus: 2, memMiB: 4096 }], plans: [] };
const ORG = { id: 'org-secret-id', allowedSpecs: [{ vcpus: 4, memMiB: 8192 }, { vcpus: 8, memMiB: 16384 }], limits: { startsPerMinute: 30, maxRunning: 0, maxMachines: 100, maxVCPUs: 64 }, usage: { running: 1 } };
const planHandler = (org = () => Response.json(ORG)) => (url) => (url.endsWith('/v1/me') ? Response.json(ME) : org());

test('plan: GET /v1/me then /v1/orgs/<id> with the key header only; maps the fields; no identifiers in the result', async () => {
  const { p, f } = metricsProvider(planHandler());
  const r = await p.plan();
  assert.deepEqual(f.calls.map((c) => c.url), ['https://api.instabox.sh/v1/me', 'https://api.instabox.sh/v1/orgs/org-secret-id']);
  assert.ok(f.calls.every((c) => c.headers['X-API-Key'] === KEY && Object.keys(c.headers).length === 1));
  assert.deepEqual(r, { tier: 'pro', specs: [{ vcpus: 4, memMiB: 8192 }, { vcpus: 8, memMiB: 16384 }], startsPerMinute: 30, maxRunning: 0, maxMachines: 100, fetchedAt: NOW });
  assert.ok(!JSON.stringify(r).includes('org-secret-id'));
});

test('plan: cached for the process; refresh fetches again', async () => {
  const { p, f } = metricsProvider(planHandler());
  await p.plan(); await p.plan();
  assert.equal(f.calls.length, 2);
  await p.plan({ refresh: true });
  assert.equal(f.calls.length, 4);
});

test('plan: specs fall back to /v1/me allowedSpecs when the org lists none', async () => {
  const { p } = metricsProvider(planHandler(() => Response.json({ ...ORG, allowedSpecs: undefined })));
  assert.deepEqual((await p.plan()).specs, ME.allowedSpecs);
});

test('plan: 401, 403, 500, a missing org id, a timeout and a network error all resolve null; the key is never logged', async () => {
  const lines = [];
  const orig = console.error; console.error = (...a) => lines.push(a.join(' '));
  try {
    for (const status of [401, 403, 500]) {
      const { p } = metricsProvider(() => new Response(JSON.stringify({ error: { code: KEY } }), { status }));
      assert.equal(await p.plan(), null, `${status}`);
    }
    assert.equal(await metricsProvider(() => Response.json({ allowedSpecs: [] })).p.plan(), null);
    assert.equal(await metricsProvider(() => { throw new Error(`down ${KEY}`); }).p.plan(), null);
    assert.equal(await metricsProvider(() => new Promise(() => {}), { metricsTimeoutMs: 10 }).p.plan(), null);
    assert.equal(await createProvider({}, { sdk: fakeSdk().sdk }).plan(), null);
  } finally { console.error = orig; }
  assert.ok(lines.length >= 1 && lines.every((l) => !l.includes(KEY)), lines.join('|'));
});

test('plan: a failure is not cached, so the next call can succeed', async () => {
  let n = 0;
  const { p } = metricsProvider((url) => (n++ < 1 ? new Response('{}', { status: 500 }) : planHandler()(url)));
  assert.equal(await p.plan(), null);
  assert.equal((await p.plan()).tier, 'pro');
});

test('#128 create passes vcpus and memMiB only when a size is given; spec_not_allowed becomes size_not_allowed', async () => {
  const mk = (a) => createProvider({ INSTABOX_API_KEY: KEY }, { sdk: a.sdk, fetchFn: fakeFetch().f, timing });
  const a = fakeSdk(), b = fakeSdk();
  await mk(a).create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 60, size: { vcpus: 8, memMiB: 16384, label: '8x16' } });
  assert.equal(a.calls.create[0].opts.vcpus, 8);
  assert.equal(a.calls.create[0].opts.memMiB, 16384);
  await mk(b).create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 60 });
  assert.ok(!('vcpus' in b.calls.create[0].opts) && !('memMiB' in b.calls.create[0].opts));
  const p = createProvider({ INSTABOX_API_KEY: KEY }, { sdk: { Sandbox: { create: async () => { throw Object.assign(new Error('size 16/32 is not allowed'), { status: 400, code: 'spec_not_allowed' }); } } }, fetchFn: fakeFetch().f, timing });
  await assert.rejects(p.create({ image: 'agent-browser', envs: {}, labels: {}, ttlSeconds: 60, size: { vcpus: 16, memMiB: 32768 } }), (e) => e.code === 'size_not_allowed' && e.instaboxCode === 'spec_not_allowed' && /16\/32/.test(e.message));
  assert.equal(createProvider({ INSTABOX_API_KEY: KEY }, { sdk: fakeSdk().sdk, fetchFn: fakeFetch().f, timing }).caps.hasSizes, true);
});
