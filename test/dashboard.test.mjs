import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildState, createHandler, listen, liveState, listMachines } from '../src/dashboard.mjs';
import { createEventLog, foldAgents, pushOf, readEvents, redact } from '../src/events.mjs';
import { demoState, demoStream, demoPane } from '../src/dashboard-demo.mjs';
import { createFakeProvider } from './fake-provider.mjs';

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
  const machines = [{ id: 'm1', name: 'swift-otter', state: 'running', status: 'running', startedAt: 1 }, { id: 'm9', name: 'fleet', role: 'coordinator', state: 'running', status: 'running', startedAt: 7 }];
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

test('small-text colour tokens meet 4.5:1 in light and dark', () => {
  const css = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const [light, dark] = [...css.matchAll(/:root\s*{([^}]*)}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map((x) => [x[1], x[2]])));
  const lum = (h) => { if (h.length === 4) h = '#' + [...h.slice(1)].map((d) => d + d).join(''); const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, t] of [['light', light], ['dark', { ...light, ...dark }]])
    for (const fg of ['text-2', 'text-3', 't-running', 't-starting', 't-idle', 's-failed', 'accent'])
      for (const bg of ['page', 'surface']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} --${fg} on --${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
  // text that sits on a tinted background (warning and error rows)
  for (const [name, t] of [['light', light], ['dark', { ...light, ...dark }]])
    for (const [fg, bg] of [['warn-text', 'warn-bg'], ['s-failed', 'err-bg']]) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} --${fg} on --${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
});

test('a multi-byte token of the right character count is a 401, not a crash', async () => {
  const s = await serve(), { port } = s.address();
  try {
    assert.equal((await get(port, `/api/state?t=${encodeURIComponent('é'.repeat(24))}`)).status, 401);
    assert.equal((await get(port, `/api/state?t=${TOKEN}`)).status, 200);
  } finally { s.close(); }
});

test('foldAgents uses the real delete time as the deadline, else 6 hours', () => {
  const ev = (id, deleteAt) => [{ t: 1000, id, type: 'agent', description: 'd', role: 'worker' }, { t: 1001, id, type: 'machine', machine: 'm', ...(deleteAt && { deleteAt }) }, { t: 1002, id, type: 'status', status: 'running' }];
  const [a] = foldAgents(ev('a1', 5000), { alive: () => true });
  assert.equal(a.deadline, 5000);
  const [b] = foldAgents(ev('b1'), { alive: () => true });
  assert.equal(b.deadline, 1000 + 6 * 3600_000);
});

test('foldAgents copies the agent event\'s mcp names; absent stays undefined; demo has an agent with mcp', () => {
  const ev = (mcp) => [{ type: 'agent', id: 'm1', t: 1, description: 'd', role: 'worker', branch: 'b', ...(mcp && { mcp }) }];
  assert.deepEqual(foldAgents(ev(['a', 'b']), { alive: () => true })[0].mcp, ['a', 'b']);
  assert.equal(foldAgents(ev(), { alive: () => true })[0].mcp, undefined);
  assert.ok(demoState().boxes.some((b) => b.mcp?.length));
});

test('listMachines maps the provider list, status included, and needs the key', async () => {
  const provider = createFakeProvider();
  provider.machines.set('m1', { id: 'm1', name: 'box', labels: { purpose: 'cloudy-cloud', role: 'coordinator', owner: 'o1' }, state: 'creating', status: 'starting', startedAt: 5, archiveAt: 9 });
  provider.machines.set('m2', { id: 'm2', name: 'other', labels: { purpose: 'else' }, state: 'running', status: 'running', startedAt: 6 });
  const rows = await listMachines({ FAKE_API_KEY: 'k' }, provider);
  assert.deepEqual(provider.log.list, [{ purpose: 'cloudy-cloud' }]);
  assert.deepEqual(rows, [{ id: 'm1', name: 'box', role: 'coordinator', owner: 'o1', state: 'creating', status: 'starting', startedAt: 5, archiveAt: 9 }]);
  await assert.rejects(listMachines({}, provider), { code: 'no_key', message: 'FAKE_API_KEY is not set.' });
});

test('/api/state for fixed events and machines is unchanged', () => {
  const events = [
    { type: 'agent', id: 'a1', t: 1, pid: 1, branch: 'cloudy-cloud/a1' }, { type: 'machine', id: 'a1', t: 2, machine: 'm1' }, { type: 'status', id: 'a1', t: 3, status: 'running' },
  ];
  const machines = [
    { id: 'm1', name: 'swift-otter', state: 'running', status: 'running', startedAt: 1 },
    { id: 'm2', name: 'fleet', role: 'coordinator', state: 'creating', status: 'starting', startedAt: 7, archiveAt: 99 },
    { id: 'm3', name: 'old', state: 'deleting', status: 'stopped', startedAt: 8 },
  ];
  const s = buildState({ events, machines, now: 1000, alive: () => true });
  assert.deepEqual(s.boxes.map((b) => [b.id, b.kind, b.status, b.machineState, b.deadline]), [
    ['a1', 'agent', 'running', 'running', 21600001], ['fleet', 'coordinator', 'starting', 'creating', 99], ['old', 'machine', 'stopped', 'deleting', undefined],
  ]);
  const err = buildState({ events, machineError: { code: 'no_key', message: 'x' }, now: 1000, alive: () => true, provider: createFakeProvider() }).machines;
  assert.deepEqual(err, { ok: false, code: 'no_key', message: 'x', fix: 'Set FAKE_API_KEY.' });
});

test('the page never assigns server data to innerHTML and fetches the stream with the token', () => {
  const page = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const script = page.slice(page.indexOf('<script>'));
  const bad = [...script.matchAll(/\.innerHTML\s*=(?!=)\s*([^;\n]*)/g)].map((m) => m[1].trim()).filter((rhs) => !/^(['"`])[^'"`$]*\1$/.test(rhs));
  assert.deepEqual(bad, [], 'innerHTML may only be set to a constant string');
  assert.match(script, /\/api\/stream\?t=/);
  assert.match(script, /\/api\/pane\?t=/);
  assert.match(script, /aria-expanded/);
  assert.match(script, /aria-live/);
});

test('demo data has a coordinator with two workers, a stream with tool calls, and a box with no stream', () => {
  const d = demoState(), by = Object.fromEntries(d.boxes.map((b) => [b.id, b]));
  const coord = d.boxes.find((b) => b.kind === 'coordinator' && b.children?.length >= 2);
  assert.ok(coord, 'a coordinator with two children');
  for (const id of coord.children) assert.equal(by[id].parent, coord.id);
  const kinds = new Set();
  for (const b of d.boxes) for (const e of demoStream(b.id, 1, 0, d.now).events) kinds.add(e.kind);
  for (const k of ['text', 'tool_use', 'tool_result', 'retry', 'error', 'thinking', 'result']) assert.ok(kinds.has(k), k);
  const r = demoStream('7c1e90ab', 1, 0, d.now);
  assert.ok(r.events.find((e) => e.kind === 'tool_use' && e.truncated), 'a truncated tool_use');
  assert.equal(demoStream('7c1e90ab', 1, r.next, d.now).events.length, 0);
  assert.ok(d.boxes.some((b) => demoStream(b.id, 1, 0, d.now).source.kind === 'none'), 'a box whose stream source is none');
  assert.ok(demoPane(coord.id).lines.length > 3);
  assert.equal(demoPane('7c1e90ab'), null);
});
