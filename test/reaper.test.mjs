import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watch, reaperSpawn } from '../src/reaper.mjs';

const KEY = 'sk-secret-key';
const OWNER = 'abc123def456';
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });

function setup({ machines, deleteStatus = [200] } = {}) {
  const calls = [], logs = [];
  let d = 0;
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (init.method === 'DELETE') return json({}, deleteStatus[Math.min(d++, deleteStatus.length - 1)]);
    return json({ machines });
  };
  return { calls, logs, fetchFn, log: (m) => logs.push(m) };
}
const run = (s, aliveSeq) => {
  let i = 0;
  return watch({ pid: 1, owner: OWNER, apiKey: KEY, fetchFn: s.fetchFn, log: s.log, alive: () => aliveSeq[Math.min(i++, aliveSeq.length - 1)], sleep: async () => {}, maxMs: 20, pollMs: 1 });
};

test('nothing is deleted while the parent is alive', async () => {
  const s = setup({ machines: [{ id: 'm1', metadata: { owner: OWNER } }] });
  await run(s, [true]);
  assert.equal(s.calls.length, 0);
});

test('after the parent exits, deletes only machines with a matching owner', async () => {
  const s = setup({ machines: [
    { id: 'm1', metadata: { owner: OWNER } }, { id: 'm2', metadata: { owner: 'other' } }, { id: 'm3' }, { id: 'm4', metadata: {} },
  ] });
  await run(s, [true, true, false]);
  assert.equal(s.calls[0].url, `https://api.instabox.sh/v1/machines?metadata=owner%3A${OWNER}`);
  assert.equal(s.calls[0].headers['X-API-Key'], KEY);
  const dels = s.calls.filter((c) => c.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].url, 'https://api.instabox.sh/v1/machines/m1');
  assert.equal(dels[0].headers['X-Confirm-Delete'], 'm1');
  assert.equal(dels[0].headers['X-API-Key'], KEY);
  assert.ok(dels[0].headers['Idempotency-Key']);
});

test('a failed delete is retried at most twice, and the key is never logged', async () => {
  const s = setup({ machines: [{ id: 'm1', metadata: { owner: OWNER } }], deleteStatus: [500] });
  await run(s, [false]);
  assert.equal(s.calls.filter((c) => c.method === 'DELETE').length, 3);
  assert.ok(s.logs.length > 0);
  assert.ok(!JSON.stringify(s.logs).includes(KEY));
});

test('spawn options pass the key only in env', () => {
  const { args, options } = reaperSpawn(42, OWNER, KEY, { PATH: '/bin' });
  assert.ok(!JSON.stringify(args).includes(KEY));
  assert.deepEqual(args.slice(1), ['42', OWNER]);
  assert.equal(options.env.INSTABOX_API_KEY, KEY);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
});
