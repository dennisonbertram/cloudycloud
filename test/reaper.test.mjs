import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watch, reaperSpawn } from '../src/reaper.mjs';
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
