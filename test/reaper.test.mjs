import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watch, reaperSpawn, startReaper } from '../src/reaper.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const KEY = 'sk-secret-key';
const OWNER = 'abc123def456';

async function setup(rows) {
  const provider = createFakeProvider();
  for (const [i, labels] of rows.entries()) provider.machines.set(`m${i + 1}`, { id: `m${i + 1}`, name: `n${i + 1}`, labels, state: 'running', status: 'running', startedAt: 1 });
  return { provider, logs: [], log(m) { this.logs.push(m); } };
}
const run = (s, aliveSeq) => {
  let i = 0;
  return watch({ pid: 1, owner: OWNER, provider: s.provider, log: (m) => s.log(m), alive: () => aliveSeq[Math.min(i++, aliveSeq.length - 1)], sleep: async () => {}, maxMs: 20, pollMs: 1 });
};

test('nothing is deleted while the parent is alive', async () => {
  const s = await setup([{ owner: OWNER }]);
  await run(s, [true]);
  assert.deepEqual(s.provider.log.list, []);
  assert.deepEqual(s.provider.log.delete, []);
});

test('after the parent exits, deletes only machines with a matching owner', async () => {
  const s = await setup([{ owner: OWNER }, { owner: 'other' }, {}, { purpose: 'x' }]);
  await run(s, [true, true, false]);
  assert.deepEqual(s.provider.log.list, [{ owner: OWNER }]);
  assert.deepEqual(s.provider.log.delete, ['m1']);
});

test('a failed list or delete is logged without the key, and reaping continues', async () => {
  const s = await setup([{ owner: OWNER }, { owner: OWNER }]);
  const del = s.provider.delete;
  s.provider.delete = async (id) => { if (id === 'm1') throw new Error('Delete of m1 failed: HTTP 500'); return del(id); };
  await run(s, [false]);
  assert.deepEqual(s.provider.log.delete, ['m2']);
  assert.match(s.logs.join('\n'), /delete m1 failed/);
  assert.ok(!JSON.stringify(s.logs).includes(KEY));
  const bad = await setup([]);
  bad.provider.list = async () => { throw new Error('Could not list machines: HTTP 500'); };
  await run(bad, [false]);
  assert.match(bad.logs[0], /list failed/);
});

test('spawn options pass the key and provider only in env', () => {
  const provider = createFakeProvider();
  const { args, options } = reaperSpawn(42, OWNER, KEY, provider, { PATH: '/bin' });
  assert.ok(!JSON.stringify(args).includes(KEY));
  assert.deepEqual(args.slice(1), ['42', OWNER]);
  assert.equal(options.env.FAKE_API_KEY, KEY);
  assert.equal(options.env.CLOUDY_CLOUD_PROVIDER, 'fake');
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
});

test('the reaper process exits 1 with no key, without touching the network', () => {
  const env = { PATH: process.env.PATH };
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/reaper.mjs', import.meta.url)), '1', OWNER], { env, timeout: 5000 });
  assert.equal(r.status, 1);
});

test('the reaper logs each failed delete attempt (3 attempts) through the adapter', async () => {
  const { createProvider } = await import('../src/providers/instabox.mjs');
  const { reap } = await import('../src/reaper.mjs');
  const fetchFn = async (url, init = {}) => (init.method === 'DELETE' ? new Response('', { status: 500 }) : Response.json({ machines: [{ id: 'm1', metadata: { owner: OWNER } }] }));
  const logs = [];
  const n = await reap({ owner: OWNER, provider: createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn }), log: (l) => logs.push(l) });
  assert.equal(n, 0);
  assert.deepEqual(logs, Array(3).fill('delete m1 failed: HTTP 500'));
});

test('startReaper passes the provider and its key to the spawned reaper (the call server.mjs makes)', () => {
  const calls = [];
  const child = { on() { return this; }, unref() { calls.push('unref'); } };
  const provider = createFakeProvider();
  startReaper(42, OWNER, { FAKE_API_KEY: KEY }, provider, (cmd, args, options) => { calls.push({ cmd, args, options }); return child; });
  assert.equal(calls[0].options.env.FAKE_API_KEY, KEY);
  assert.equal(calls[0].options.env.CLOUDY_CLOUD_PROVIDER, 'fake');
  assert.deepEqual(calls[0].args.slice(1), ['42', OWNER]);
  assert.equal(calls[1], 'unref');
});

test('the reaper never loads the SDK: reap through the real adapter, and exit 1 on an empty env', () => {
  const hook = fileURLToPath(new URL('./fixtures/block-sdk.mjs', import.meta.url));
  const reaper = fileURLToPath(new URL('../src/reaper.mjs', import.meta.url));
  const adapter = fileURLToPath(new URL('../src/providers/instabox.mjs', import.meta.url));
  const empty = spawnSync(process.execPath, ['--import', hook, reaper, '1', OWNER], { env: { PATH: process.env.PATH }, timeout: 5000, encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.ok(!empty.stderr.includes('SDK_LOADED'), empty.stderr);
  const code = `
    import { reap } from ${JSON.stringify(reaper)};
    import { createProvider } from ${JSON.stringify(adapter)};
    const fetchFn = async (url, init = {}) => (init.method === 'DELETE' ? new Response('') : Response.json({ machines: [{ id: 'm1', metadata: { owner: '${OWNER}' } }] }));
    console.log(await reap({ owner: '${OWNER}', provider: createProvider({ INSTABOX_API_KEY: 'k' }, { fetchFn }) }));`;
  const full = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', code], { env: { PATH: process.env.PATH }, timeout: 5000, encoding: 'utf8' });
  assert.equal(full.stdout.trim(), '1', full.stderr);
});

test('the reaper deletes the machines of page 1 when page 2 of the list fails, and logs the error', async () => {
  const { reap } = await import('../src/reaper.mjs');
  const { createProvider } = await import('../src/providers/instabox.mjs');
  const deleted = [], logs = [];
  const fetchFn = async (url, init = {}) => {
    if (init.method === 'DELETE') { deleted.push(String(url).split('/').pop()); return new Response('{}'); }
    if (String(url).includes('cursor=c2')) return new Response('no', { status: 500 });
    return Response.json({ machines: [{ id: 'm1', metadata: { owner: OWNER }, state: 'running' }], nextCursor: 'c2' });
  };
  const n = await reap({ owner: OWNER, provider: createProvider({ INSTABOX_API_KEY: KEY }, { fetchFn }), log: (l) => logs.push(l) });
  assert.equal(n, 1);
  assert.deepEqual(deleted, ['m1']);
  assert.match(logs.join('\n'), /list failed.*HTTP 500/);
});
