import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createStartQueue } from '../src/limits.mjs';

// Fake clock: sleep advances time at once.
function clock() {
  const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } };
  return c;
}

test('start pacing never exceeds N creates in any rolling minute', async () => {
  const c = clock();
  const q = createStartQueue({ perMin: 5, now: c.now, sleep: c.sleep });
  const times = [];
  await Promise.all(Array.from({ length: 23 }, () => q.create({}, async () => { times.push(c.t); })));
  assert.equal(times.length, 23);
  for (let i = 5; i < times.length; i++) assert.ok(times[i] - times[i - 5] >= 60_000, `create ${i} came too soon`);
});

test('rate_limited is retried after retryAfterSeconds, up to 5 tries', async () => {
  const c = clock();
  const q = createStartQueue({ perMin: 100, now: c.now, sleep: c.sleep });
  const times = [];
  const r = await q.create({}, async () => {
    times.push(c.t);
    if (times.length < 3) throw Object.assign(new Error('slow'), { code: 'rate_limited', retryAfterSeconds: 7 });
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.deepEqual(times, [0, 7000, 7000 + 14_000]); // backoff grows: 1x, 2x
  let n = 0;
  await assert.rejects(q.create({}, async () => { n++; throw Object.assign(new Error('slow'), { code: 'rate_limited' }); }), /slow/);
  assert.equal(n, 5);
});

test('limiter never runs more than its cap, with 100 agents', async () => {
  const l = createLimiter(24);
  let done = 0;
  await Promise.all(Array.from({ length: 100 }, () => l.run(async () => { await new Promise((r) => setTimeout(r, 2)); done++; })));
  assert.equal(done, 100);
  assert.equal(l.peak, 24);
  assert.equal(l.active, 0);
});
