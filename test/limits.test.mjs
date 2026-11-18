import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createStartQueue, classifyProviderError, providerDetail } from '../src/limits.mjs';

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

test('perMin may be a function; a rate learned after the queue exists applies to the next grant', async () => {
  const c = clock();
  let n = 5;
  const q = createStartQueue({ perMin: () => n, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 5; i++) await q.create({}, async () => {});
  n = 30;
  await q.create({}, async () => {});
  assert.equal(c.t, 0, 'the sixth create waited although the rate had risen');
});

test('poke: a rate raised while starts wait releases them at once; a lowered rate releases nothing extra', async () => {
  let t = 0, n = 1;
  const never = () => new Promise(() => {}); // the sleep until the oldest start is a minute old
  const q = createStartQueue({ perMin: () => n, now: () => t, sleep: never });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const started = [];
  const go = (i) => q.create({}, async () => { started.push(i); });
  go(0); go(1); go(2);
  await tick();
  assert.deepEqual(started, [0]);
  n = 30; q.poke(); await tick();
  assert.deepEqual(started, [0, 1, 2]);
  n = 1; q.poke(); go(3); await tick();
  assert.deepEqual(started, [0, 1, 2], 'a lower rate must not release a start');
});

test('concurrency_limit is retried like quota_exceeded, then surfaced after the give-up time', async () => {
  const c = clock();
  const q = createStartQueue({ perMin: 100, now: c.now, sleep: c.sleep, quotaRetryMs: 1000, quotaGiveUpMs: 3500 });
  let n = 0;
  const ok = await q.create({}, async () => { if (++n < 3) throw Object.assign(new Error('x'), { code: 'concurrency_limit' }); return 'up'; });
  assert.equal(ok, 'up');
  const err = Object.assign(new Error('too many running'), { code: 'concurrency_limit' });
  n = 0;
  await assert.rejects(q.create({}, async () => { n++; throw err; }), (e) => e === err);
  assert.ok(n > 2 && n < 10);
});

test('soft wait: at maxRunning the create waits, releases when an agent stops, and is bounded', async () => {
  const c = clock();
  let live = 2, started = 0;
  const q = createStartQueue({ perMin: 100, now: c.now, sleep: async (ms) => { c.t += ms; if (c.t >= 20_000) live = 1; }, liveCount: () => live, maxRunning: () => 2, softPollMs: 5000, softWaitMs: 600_000 });
  const a = {};
  await q.create(a, async () => { started++; });
  assert.equal(started, 1);
  assert.ok(c.t >= 20_000 && c.t < 30_000);
  // never released: gives up waiting at softWaitMs and lets the API decide
  live = 5; c.t = 0;
  const q2 = createStartQueue({ perMin: 100, now: c.now, sleep: c.sleep, liveCount: () => live, maxRunning: () => 2, softPollMs: 5000, softWaitMs: 60_000 });
  const b = {};
  const p = q2.create(b, async () => { started++; });
  await p;
  assert.equal(started, 2);
  assert.ok(c.t >= 60_000 && c.t < 70_000);
  // no limit known (0 or undefined): no wait
  const q3 = createStartQueue({ perMin: 100, now: c.now, sleep: c.sleep, liveCount: () => 9, maxRunning: () => 0 });
  const t0 = c.t; await q3.create({}, async () => {}); assert.equal(c.t, t0);
});

test('soft wait keeps FIFO: a later request never overtakes a sleeping head', async () => {
  const c = clock();
  let live = 2; const order = [];
  const q = createStartQueue({ perMin: 100, now: c.now, sleep: async (ms) => { c.t += ms; if (c.t >= 10_000) live = 1; }, liveCount: () => live, maxRunning: () => 2, softPollMs: 5000 });
  const go = (i) => q.create({}, async () => { order.push(i); live++; });
  await Promise.all([go(0), go(1)]);
  assert.deepEqual(order, [0, 1]);
  assert.ok(c.t >= 10_000);
});

test('a request that waited for the rate limit rechecks capacity before starting', async () => {
  const c = clock();
  let live = 0; const order = [];
  // the rate wait (60 s) is where capacity fills; the second request must then wait for it to free up
  const q = createStartQueue({ perMin: 1, now: c.now, sleep: async (ms) => { c.t += ms; if (c.t >= 60_000 && c.t < 100_000) live = 1; else if (c.t >= 100_000) live = 0; }, liveCount: () => live, maxRunning: () => 1, softPollMs: 5000 });
  await q.create({}, async () => { order.push(c.t); });
  await q.create({}, async () => { order.push(c.t); });
  assert.equal(order[0], 0);
  assert.ok(order[1] >= 100_000, `started at ${order[1]} while full`);
});

test('the requesting agent is passed to liveCount so it can exclude itself', async () => {
  const c = clock(); const seen = [];
  const a = {};
  const q = createStartQueue({ perMin: 100, now: c.now, sleep: c.sleep, liveCount: (x) => { seen.push(x); return 0; }, maxRunning: () => 1 });
  await q.create(a, async () => {});
  assert.ok(seen.length && seen.every((x) => x === a));
});

test('capacity wait: every waiting agent gets its note once, and the grant clears it with a starting event', async () => {
  const c = clock();
  let running = 1;
  const evs = [];
  const mk = (id) => ({ id, emit: (e) => evs.push({ id, t: evs.length + 1, ...e }) });
  const [a, b] = [mk('a'), mk('b')];
  const q = createStartQueue({ perMin: 99, now: c.now, sleep: async (ms) => { c.t += ms; if (c.t >= 10_000) running = 0; }, liveCount: () => running, maxRunning: () => 1, tierName: () => 'pro' });
  await Promise.all([q.create(a, async () => {}), q.create(b, async () => {})]);
  const notes = (id) => evs.filter((e) => e.id === id && e.status === 'queued').map((e) => e.note);
  assert.deepEqual(notes('a'), ['waiting for a free machine slot (1 running on the pro plan)']);
  assert.deepEqual(notes('b'), ['queued, 1 ahead: waiting for a free machine slot (1 running on the pro plan)']); // once, not once per poll
  for (const id of ['a', 'b']) {
    const last = evs.filter((e) => e.id === id).at(-1);
    assert.equal(last.status, 'starting');
    assert.equal(last.note, undefined);
  }
});

test('classifyProviderError: transient errors retry, rejected requests do not', () => {
  const k = (s) => classifyProviderError(s);
  assert.deepEqual(k('404: {"code":"model_not_found"}'), { kind: 'model_not_found', status: 404, retryable: true });
  assert.deepEqual([k('429 slow down').kind, k('429 slow down').retryable], ['rate_limited', true]);
  assert.deepEqual([k('503 unavailable').kind, k('503 unavailable').retryable], ['server_error', true]);
  assert.equal(k('request failed: ECONNRESET').retryable, true);
  assert.equal(k('401 invalid api key').retryable, false);
  assert.equal(k('400 bad request').retryable, false);
  assert.equal(k('I fixed the bug'), null);
  assert.equal(providerDetail('502 bad gateway'), 'Provider status: 502 server_error');
  assert.equal(providerDetail('all fine'), '');
});

test('profileBusy holds the head, labels it, and releases it when the cap clears', async () => {
  let busy = 'waiting for a free pi-x slot (2 of 2 running)', release;
  const q = createStartQueue({ profileBusy: () => busy, sleep: () => new Promise((r) => { release = r; }) });
  const a = { id: 'a', emit() {} };
  let started = false;
  const p = q.create(a, async () => { started = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, false);
  assert.equal(a.status, 'queued');
  assert.match(q.reason(a), /pi-x slot/);
  busy = undefined;
  release();
  await p;
  assert.ok(started);
});
