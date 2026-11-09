import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildState, createHandler, listen, liveState } from '../src/dashboard.mjs';
import { createEventLog, foldAgents, pushOf, readEvents, redact } from '../src/events.mjs';
import { demoState } from '../src/dashboard-demo.mjs';

const TOKEN = 'tok-123';
const get = (port, path, host = `127.0.0.1:${port}`, method = 'GET') => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  req.on('error', reject);
  req.end();
});
const serve = async (opts = {}) => listen(createHandler({ token: TOKEN, html: '<html>page</html>', getState: async () => ({ ok: 1 }), ...opts }), 0);

test('server listens on 127.0.0.1 only', async () => {
  const s = await serve();
  try {
    assert.equal(s.address().address, '127.0.0.1');
  } finally { s.close(); }
});

test('requests without the token get 401, with it 200', async () => {
  const s = await serve(), { port } = s.address();
  try {
    assert.equal((await get(port, '/')).status, 401);
    assert.equal((await get(port, '/api/state')).status, 401);
    assert.equal((await get(port, '/api/state?t=wrong')).status, 401);
    const ok = await get(port, `/api/state?t=${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: 1 });
    const page = await get(port, `/?t=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  } finally { s.close(); }
});

test('a Host header that is not localhost or 127.0.0.1 is rejected, even with the token', async () => {
  const s = await serve(), { port } = s.address();
  try {
    assert.equal((await get(port, `/api/state?t=${TOKEN}`, `evil.example:${port}`)).status, 403);
    assert.equal((await get(port, `/api/state?t=${TOKEN}`, `localhost:${port}`)).status, 200);
  } finally { s.close(); }
});

test('the dashboard is read-only', async () => {
  const s = await serve(), { port } = s.address();
  try {
    assert.equal((await get(port, `/api/state?t=${TOKEN}`, undefined, 'POST')).status, 405);
  } finally { s.close(); }
});

test('the event log redacts keys, exact secrets and long text, and is private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ev-'));
  const file = join(dir, 'sub', 'events.jsonl');
  const emit = createEventLog({}, 'owner1', { file, scrub: (s) => s.split('my-exact-secret').join('[redacted]') });
  emit({ type: 'message', id: 'a1', text: 'use sk-ant-abcdefghijklmnop and ghp_abcdefghijklmnopqrst and my-exact-secret' });
  emit({ type: 'message', id: 'a1', text: 'ANTHROPIC_API_KEY=abc123xyz789 then Authorization: Bearer abcdefghijklmnopqrstuv' });
  const raw = readFileSync(file, 'utf8');
  for (const bad of ['sk-ant-abcdefghijklmnop', 'ghp_abcdefghijklmnopqrst', 'my-exact-secret', 'abc123xyz789', 'abcdefghijklmnopqrstuv']) assert.ok(!raw.includes(bad), bad);
  assert.match(raw, /\[redacted\]/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
  assert.ok(redact('x'.repeat(30_000)).length < 21_000);
});

test('events fold into agents; a dead session turns running into stopped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ev-'));
  const file = join(dir, 'events.jsonl');
  let t = 1000;
  const emit = createEventLog({}, 'o', { file, now: () => (t += 1000) });
  emit({ type: 'agent', id: 'a1', description: 'Do it', profile: 'glm', role: 'worker', model: 'm', branch: 'cloudy-cloud/a1' });
  emit({ type: 'message', id: 'a1', text: 'task' });
  emit({ type: 'machine', id: 'a1', machine: 'mach-1' });
  emit({ type: 'status', id: 'a1', status: 'running' });
  emit({ type: 'progress', id: 'a1', text: 'Edit x.js' });
  emit({ type: 'reply', id: 'a1', text: 'done\n\nPushed to origin cloudy-cloud/a1 at abc1234. Fetch with: git fetch origin cloudy-cloud/a1.', error: false });
  emit({ type: 'status', id: 'a1', status: 'idle' });
  emit({ type: 'agent', id: 'a2', description: 'Other', role: 'worker', branch: 'cloudy-cloud/a2' });
  emit({ type: 'status', id: 'a2', status: 'running' });
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n`);
  const events = readEvents(file);
  assert.equal(events.length, 9);
  const [a2, a1] = foldAgents(events, { alive: () => true });
  assert.equal(a1.status, 'idle');
  assert.equal(a1.machine, 'mach-1');
  assert.deepEqual(a1.messages.map((m) => m.kind), ['out', 'progress', 'reply']);
  assert.equal(a1.push.sha, 'abc1234');
  assert.equal(typeof a1.push.t, 'number');
  assert.equal(a1.deadline, a1.idleSince + 3_600_000);
  assert.equal(a2.status, 'running');
  const dead = foldAgents(events, { alive: () => false });
  assert.equal(dead.find((a) => a.id === 'a2').status, 'stopped'); // running but its session is gone
  assert.equal(dead.find((a) => a.id === 'a1').status, 'idle'); // idle agents are not touched by the check
  assert.deepEqual(readEvents(join(dir, 'missing.jsonl')), []);
});

test('buildState joins machines to agents and lists the rest', () => {
  const events = [
    { type: 'agent', id: 'a1', t: 1, pid: 1, branch: 'cloudy-cloud/a1' }, { type: 'machine', id: 'a1', t: 2, machine: 'm1' }, { type: 'status', id: 'a1', t: 3, status: 'running' },
    { type: 'agent', id: 'a2', t: 4, pid: 1 }, { type: 'machine', id: 'a2', t: 5, machine: 'm-gone' }, { type: 'status', id: 'a2', t: 6, status: 'running' },
  ];
  const machines = [{ id: 'm1', name: 'swift-otter', state: 'running', startedAt: 1 }, { id: 'm9', name: 'fleet', role: 'coordinator', state: 'running', startedAt: 7 }];
  const s = buildState({ events, machines, alive: () => true });
  const by = Object.fromEntries(s.boxes.map((b) => [b.id, b]));
  assert.equal(by.a1.status, 'running');
  assert.equal(by.a2.status, 'stopped'); // its machine is not listed any more
  assert.equal(by.fleet.kind, 'coordinator');
  assert.equal(s.boxes.length, 3);
  assert.equal(s.machines.ok, true);
});

test('a missing key or API failure becomes an error with a fix, and never leaks the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ev-'));
  const noKey = await liveState({}, { file: join(dir, 'e'), cacheMs: 0, list: async () => { throw Object.assign(new Error('INSTABOX_API_KEY is not set.'), { code: 'no_key' }); } })();
  assert.equal(noKey.machines.ok, false);
  assert.match(noKey.machines.fix, /INSTABOX_API_KEY=/);
  const down = await liveState({ INSTABOX_API_KEY: 'ibk_supersecretvalue' }, { file: join(dir, 'e'), cacheMs: 0, list: async () => { throw new Error('fetch failed for ibk_supersecretvalue'); } })();
  assert.equal(down.machines.ok, false);
  assert.ok(!JSON.stringify(down).includes('ibk_supersecretvalue'));
});

test('pushOf reads the push sentence the safety push writes; the last one wins', () => {
  assert.deepEqual(pushOf('Done.\n\nPushed to origin cloudy-cloud/a1 at 9d2e7b4. Fetch with: git fetch origin cloudy-cloud/a1.\nModel: m\nTotal: 3 tool uses'), { sha: '9d2e7b4', branch: 'cloudy-cloud/a1' });
  assert.deepEqual(pushOf('x\n\nPush failed: rejected\nhint: pull first; the agent is still open, ask it to push.\nModel: m'), { failed: true });
  assert.deepEqual(pushOf('x\nThe sandbox could not be reached to push. Only work the agent already pushed to origin cloudy-cloud/a1 survives.'), { failed: true });
  assert.equal(pushOf('I pushed it at 9d2e7b4'), undefined);
  assert.equal(pushOf('Pushed to origin cloudy-cloud/a1 at .'), undefined);
  assert.deepEqual(pushOf('Pushed to origin cloudy-cloud/a1 at 1111111.\n\nPush failed: x'), { failed: true });
});

test('demo data is labelled and has every status', () => {
  const d = demoState();
  assert.equal(d.demo, true);
  assert.deepEqual([...new Set(d.boxes.map((b) => b.status))].sort(), ['failed', 'idle', 'queued', 'running', 'starting', 'stopped']);
  assert.equal(d.boxes.find((b) => b.id === 'b42f0d17').push.sha, '9d2e7b4');
  assert.equal(d.boxes.find((b) => b.id === '90aa13fc').push.failed, true);
  const now = d.now;
  assert.ok(d.boxes.some((b) => ['queued', 'starting', 'running'].includes(b.status) && b.deadline - now < 3_600_000 && b.deadline > now), 'an active box is under one hour from deletion');
});

test('401 explains the fix and never contains the token', async () => {
  const s = await serve(), { port } = s.address();
  try {
    for (const path of ['/', '/?t=wrong', '/api/state']) {
      const r = await get(port, path);
      assert.equal(r.status, 401);
      assert.equal(r.body, 'This dashboard link is missing its access key, or it is from an earlier run.\nOpen the newest link that cloudy-cloud dashboard printed in your terminal, or run cloudy-cloud dashboard again.\n');
      assert.ok(!r.body.includes(TOKEN));
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    }
  } finally { s.close(); }
});

test('a page that cannot be read is a 500 and the server keeps running', { timeout: 5000 }, async () => {
  const s = await serve({ html: () => { throw new Error('ENOENT: no such file'); } }), { port } = s.address();
  try {
    const r = await get(port, `/?t=${TOKEN}`);
    assert.equal(r.status, 500);
    assert.ok(r.body.startsWith('Could not read the dashboard page: '));
    assert.equal((await get(port, `/api/state?t=${TOKEN}`)).status, 200);
  } finally { s.close(); }
});
