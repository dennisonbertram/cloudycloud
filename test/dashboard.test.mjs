import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildState, createHandler, isQuiet, lazy, listen, liveState, listMachines } from '../src/dashboard.mjs';
import { createEventLog, foldAgents, pushOf, readEvents, redact } from '../src/events.mjs';
import { demoState, demoStream } from '../src/dashboard-demo.mjs';
import { createFakeProvider } from './fake-provider.mjs';
import { planSnapshot, planSettled } from '../src/machine.mjs';
import { createMachineReader } from '../src/machine-read.mjs';
import { createLimiter } from '../src/limits.mjs';

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
  assert.deepEqual(rows, [{ id: 'm1', name: 'box', role: 'coordinator', owner: 'o1', labels: { purpose: 'cloudy-cloud', role: 'coordinator', owner: 'o1' }, state: 'creating', status: 'starting', startedAt: 5, archiveAt: 9 }]);
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


test('buildState gives real titles and a coordinator to worker tree from machine labels', () => {
  const lab = (o) => ({ purpose: 'cloudy-cloud', ...o });
  const machines = [
    { id: 'mc', name: 'coord-box', role: 'coordinator', owner: 'o9', labels: lab({ role: 'coordinator', name: 'm1', owner: 'o9' }), state: 'running', status: 'running', startedAt: 1 },
    { id: 'm1', name: 'sbx-one', owner: 'o8', labels: lab({ role: 'worker', profile: 'glm', parent: 'm1', agent: 'ab12cd34', description: 'Fix tests', owner: 'o8' }), state: 'running', status: 'running', startedAt: 2 },
    { id: 'm2', name: 'sbx-two', owner: 'o8', labels: lab({ owner: 'o8' }), state: 'running', status: 'running', startedAt: 3 },
    { id: 'm3', name: 'sbx-three', owner: 'o7', labels: lab({ parent: 'nobody', agent: 'ff00ff00', owner: 'o7' }), state: 'running', status: 'running', startedAt: 4 },
  ];
  const s = buildState({ events: [], machines, now: 1000, alive: () => true, owner: 'o7' });
  const by = Object.fromEntries(s.boxes.map((b) => [b.machine, b]));
  assert.equal(by.mc.kind, 'coordinator');
  assert.equal(by.m1.title, 'Fix tests');
  assert.equal(by.m1.titleSource, 'label');
  assert.equal(by.m1.kind, 'agent');
  assert.equal(by.m1.parent, by.mc.id);
  assert.ok(by.mc.children.includes(by.m1.id));
  assert.equal(by.m1.startedBy, 'm1');
  assert.equal(by.m2.kind, 'machine');
  assert.equal(by.m2.titleSource, 'machine');
  assert.match(by.m2.note, /#48/);
  assert.equal(by.m2.title, 'sbx-two');
  assert.equal(by.m3.parentUnknown, true);
  assert.equal(by.m3.startedBy, 'this session');
  assert.ok(s.boxes.every((b) => b.description !== 'Machine without a session log'));
});

test('buildState joins an agent without a machine event to its machine by the agent label', () => {
  const events = [{ type: 'agent', id: 'ab12cd34', t: 1, pid: 1, description: 'Logged title', branch: 'b' }, { type: 'message', id: 'ab12cd34', t: 2, text: 'go' }];
  const machines = [{ id: 'm1', name: 'sbx', labels: { agent: 'ab12cd34', description: 'Label title' }, state: 'running', status: 'running', startedAt: 1 }];
  const s = buildState({ events, machines, now: 1000, alive: () => true });
  assert.equal(s.boxes.length, 1);
  assert.equal(s.boxes[0].machine, 'm1');
  assert.equal(s.boxes[0].machineState, 'running');
  assert.equal(s.boxes[0].title, 'Logged title');
  assert.equal(s.boxes[0].titleSource, 'log');
  assert.equal(s.boxes[0].turns, 1);
});

// ---- /api/stream and /api/pane ----
const SAMPLE = readFileSync(new URL('./fixtures/stream-json-sample.jsonl', import.meta.url), 'utf8');
const fakeReader = (o = {}) => {
  const calls = [];
  return Object.assign(o, {
    calls,
    readTail: o.readTail ?? (async (m, name, from) => { calls.push(['tail', m, name, from]); return { data: SAMPLE.slice(from), from, next: SAMPLE.length, size: SAMPLE.length, fetchedAt: 5000 }; }),
    readCached: o.readCached ?? (async () => null),
    capturePane: o.capturePane ?? (async (m) => { calls.push(['pane', m]); return { lines: ['$ claude', 'working'], fetchedAt: 6000 }; }),
  });
};
const streamEnv = (boxes, reader, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-streams-'));
  return { dir, reader, opts: { getState: async () => ({ boxes }), streamsDir: dir, getReader: async () => reader, now: () => 10_000, ...extra } };
};
const api = async (opts, path, host, method) => { const s = await serve(opts); try { const r = await get(s.address().port, `${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`, host, method); return { ...r, json: r.status === 200 || r.status === 404 ? JSON.parse(r.body) : undefined }; } finally { s.close(); } };
const putLocal = (dir, box, n, text) => { mkdirSync(join(dir, box), { recursive: true }); writeFileSync(join(dir, box, `t${n}.jsonl`), text); };

test('/api/stream serves the local stream file first, then only events after `from`', async () => {
  const { dir, opts } = streamEnv([{ id: 'a1', kind: 'agent', status: 'running', turns: 1 }], fakeReader());
  putLocal(dir, 'a1', 1, SAMPLE);
  const s = await serve(opts), { port } = s.address();
  try {
    const r = JSON.parse((await get(port, `/api/stream?box=a1&turn=1&t=${TOKEN}`)).body);
    assert.equal(r.source.kind, 'local');
    assert.equal(r.source.path, 'streams/a1/t1.jsonl');
    assert.ok(r.events.some((e) => e.kind === 'tool_use' && e.name === 'Bash'));
    assert.ok(r.events.some((e) => e.kind === 'result' && e.costUsd > 0));
    assert.equal(r.complete, true);
    assert.equal(r.totals.tools, 2);
    assert.ok(r.totals.costUsd > 0);
    const more = JSON.parse((await get(port, `/api/stream?box=a1&turn=1&from=${r.next}&t=${TOKEN}`)).body);
    assert.deepEqual(more.events, []);
    assert.equal(more.next, r.next);
  } finally { s.close(); }
});

test('/api/stream reads a live machine once and reuses it within 3 seconds', async () => {
  const reader = fakeReader();
  const { opts } = streamEnv([{ id: 'b1', kind: 'agent', status: 'running', machine: 'mb', machineState: 'running' }], reader);
  const s = await serve(opts), { port } = s.address();
  try {
    const a = JSON.parse((await get(port, `/api/stream?box=b1&turn=1&t=${TOKEN}`)).body);
    const b = JSON.parse((await get(port, `/api/stream?box=b1&turn=1&t=${TOKEN}`)).body);
    assert.deepEqual(reader.calls, [['tail', 'mb', 'stream/t1.jsonl', 0]]);
    assert.equal(a.source.kind, 'machine');
    assert.equal(a.source.machine, 'mb');
    assert.equal(a.source.fetchedAt, 5000);
    assert.equal(b.events.length, a.events.length);
    assert.equal(a.complete, true); // a result event was seen
  } finally { s.close(); }
});

test('/api/stream falls back to the cache, then says why there is nothing', async () => {
  const gone = Object.assign(new Error('gone'), { code: 'not_found' });
  const box = { id: 'c1', kind: 'agent', status: 'stopped', machine: 'mc', machineState: 'running' };
  const cached = fakeReader({ readTail: async () => { throw gone; }, readCached: async () => ({ data: SAMPLE, fetchedAt: 42 }) });
  const r1 = (await api(streamEnv([box], cached).opts, '/api/stream?box=c1&turn=1')).json;
  assert.equal(r1.source.kind, 'cache');
  assert.equal(r1.source.fetchedAt, 42);
  assert.ok(r1.events.length > 0);
  const none = fakeReader({ readTail: async () => { throw gone; } });
  assert.deepEqual((await api(streamEnv([box], none).opts, '/api/stream?box=c1&turn=1')).json.source, { kind: 'none', reason: 'machine_gone', machine: 'mc' });
  const flaky = fakeReader({ readTail: async () => { throw Object.assign(new Error('x'), { code: 'transient' }); } });
  assert.equal((await api(streamEnv([box], flaky).opts, '/api/stream?box=c1&turn=1')).json.source.reason, 'provider_error');
  const nomachine = { id: 'd1', kind: 'agent', status: 'stopped' };
  const r4 = (await api(streamEnv([nomachine], fakeReader()).opts, '/api/stream?box=d1&turn=1')).json;
  assert.deepEqual([r4.source.kind, r4.source.reason, r4.events, r4.complete], ['none', 'no_stream_yet', [], true]);
});

test('/api/stream and /api/pane keep the token, host, method and box checks', async () => {
  const { opts } = streamEnv([{ id: 'a1', kind: 'agent', status: 'running' }], fakeReader());
  for (const bad of ['../../etc', 'nope', '']) assert.equal((await api(opts, `/api/stream?box=${encodeURIComponent(bad)}&turn=1`)).status, 404, bad);
  for (const q of ['turn=1e9', 'turn=-1', 'turn=abc', 'turn=12345', 'from=-1', 'from=1.5']) assert.equal((await api(opts, `/api/stream?box=a1&${q}`)).status, 404, q);
  assert.deepEqual((await api(opts, '/api/stream?box=../../etc&turn=1')).json, { error: 'unknown box' });
  const s = await serve(opts), { port } = s.address();
  try {
    assert.equal((await get(port, '/api/stream?box=a1&turn=1')).status, 401);
    assert.equal((await get(port, '/api/pane?box=a1')).status, 401);
    assert.equal((await get(port, `/api/stream?box=a1&turn=1&t=${TOKEN}`, 'evil.example')).status, 403);
    assert.equal((await get(port, `/api/stream?box=a1&turn=1&t=${TOKEN}`, undefined, 'POST')).status, 405);
    assert.equal((await get(port, `/api/pane?box=a1&t=${TOKEN}`, undefined, 'POST')).status, 405);
  } finally { s.close(); }
});

test('/api/pane returns the pane of a live coordinator and 404 for anything else', async () => {
  const reader = fakeReader();
  const { opts } = streamEnv([{ id: 'co', kind: 'coordinator', machine: 'mco', machineState: 'running', status: 'running' }, { id: 'w', kind: 'agent', machine: 'mw', machineState: 'running' }, { id: 'old', kind: 'coordinator', machine: 'mo', status: 'stopped' }], reader);
  const ok = await api(opts, '/api/pane?box=co');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { lines: ['$ claude', 'working'], fetchedAt: 6000, source: { kind: 'machine', machine: 'mco' } });
  assert.equal((await api(opts, '/api/pane?box=w')).status, 404);
  assert.equal((await api(opts, '/api/pane?box=old')).status, 404);
  assert.equal((await api(opts, '/api/pane?box=zzz')).status, 404);
  const down = fakeReader({ capturePane: async () => { throw Object.assign(new Error('x'), { code: 'not_found' }); } });
  const r = await api(streamEnv([{ id: 'co', kind: 'coordinator', machine: 'mco', machineState: 'running' }], down).opts, '/api/pane?box=co');
  assert.deepEqual([r.status, r.json.lines, r.json.source.reason], [200, [], 'machine_gone']);
});

test('/api/stream never returns a key value, and event+full gives the whole redacted input', async () => {
  const big = 'x'.repeat(6000);
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `export ANTHROPIC_API_KEY=sk-abcdefghijklmnop1234 && echo ${big}` } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ANTHROPIC_API_KEY=sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnop1234' }] } },
  ].map((j) => JSON.stringify(j)).join('\n') + '\n';
  const { dir, opts } = streamEnv([{ id: 'k1', kind: 'agent', status: 'running' }], fakeReader());
  putLocal(dir, 'k1', 1, lines);
  const s = await serve(opts), { port } = s.address();
  try {
    const r = await get(port, `/api/stream?box=k1&turn=1&t=${TOKEN}`);
    assert.doesNotMatch(r.body, /sk-abcdefghijklmnop|ghp_abcdefghij/);
    const ev = JSON.parse(r.body).events.find((e) => e.kind === 'tool_use');
    assert.equal(ev.truncated, true);
    const f = await get(port, `/api/stream?box=k1&turn=1&event=${ev.seq}&full=1&t=${TOKEN}`);
    assert.doesNotMatch(f.body, /sk-abcdefghijklmnop/);
    const [full, ...rest] = JSON.parse(f.body).events;
    assert.equal(rest.length, 0);
    assert.ok(full.input.length > 6000 && full.input.includes(big));
    assert.equal((await get(port, `/api/stream?box=k1&turn=1&event=99&full=1&t=${TOKEN}`)).status, 404);
  } finally { s.close(); }
});

test('/api/state gives each box the turns it has, from its message events', () => {
  const events = [{ type: 'agent', id: 'a1', t: 1, pid: 1 }, { type: 'message', id: 'a1', t: 2, text: 'one' }, { type: 'message', id: 'a1', t: 3, text: 'two' }];
  assert.equal(buildState({ events, machines: [], alive: () => true }).boxes[0].turns, 2);
});

test('the demo serves a stream and a pane for its boxes through the same endpoints', async () => {
  const demo = demoState(Date.now());
  const { opts } = streamEnv(demo.boxes, null, { getReader: undefined, demo: demoStream });
  const r = (await api(opts, '/api/stream?box=7c1e90ab&turn=1')).json;
  assert.equal(r.source.kind, 'local');
  assert.ok(r.events.some((e) => e.kind === 'tool_use') && r.events.some((e) => e.kind === 'tool_result'));
  assert.ok((await api(opts, '/api/pane?box=fleet-main')).json.lines.length > 3);
});

// ---- a coordinator's workers, from the coordinator machine's own log and streams ----
test('a coordinator box is filled from its machine\'s events.jsonl and streams, and the reads are paced', async () => {
  const env = { FAKE_API_KEY: 'fakekeyvalue-0123456789' }, provider = createFakeProvider(env);
  const coord = await provider.create({ labels: { purpose: 'cloudy-cloud', role: 'coordinator', name: 'coord-m1', owner: 'o1' }, ttlSeconds: 600 });
  await provider.create({ labels: { purpose: 'cloudy-cloud', role: 'worker', parent: 'coord-m1', agent: 'aaaa1111', owner: 'o2' }, ttlSeconds: 600 });
  const home = join(coord.dir, 'home/.config/cloudy-cloud');
  mkdirSync(join(home, 'streams/aaaa1111'), { recursive: true });
  writeFileSync(join(home, 'streams/aaaa1111/t1.jsonl'), SAMPLE);
  const ev = [
    { type: 'agent', id: 'aaaa1111', t: 1000, description: 'Worker one', profile: 'glm', role: 'worker', branch: 'cloudy-cloud/aaaa1111' },
    { type: 'message', id: 'aaaa1111', t: 1001, text: 'do the thing' },
    { type: 'reply', id: 'aaaa1111', t: 1002, text: 'done\nPushed to origin cloudy-cloud/aaaa1111 at 3fa9c01.' },
    { type: 'agent', id: 'bbbb2222', t: 2000, description: 'Worker two', role: 'worker', branch: 'cloudy-cloud/bbbb2222' },
    { type: 'machine', id: 'bbbb2222', t: 2001, machine: 'gone-1' },
    { type: 'message', id: 'bbbb2222', t: 2002, text: 'use ANTHROPIC_API_KEY=sk-plantedkey12345678 here' },
    { type: 'status', id: 'bbbb2222', t: 2003, status: 'running' },
  ];
  writeFileSync(join(home, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n{"cut');
  const reader = createMachineReader(provider, env, { minIntervalMs: 0, cacheMs: 0, cacheDir: mkdtempSync(join(tmpdir(), 'cc-rc-')) });
  const tails = [];
  const counted = { ...reader, readTail: (m, name, from) => { tails.push([m, name, from]); return reader.readTail(m, name, from); } };
  const empty = join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'events.jsonl');
  const getState = liveState(env, { provider, file: empty, cacheMs: 0, getReader: async () => counted });
  const s1 = await getState();
  const w1 = s1.boxes.find((b) => b.id === 'aaaa1111'), w2 = s1.boxes.find((b) => b.id === 'bbbb2222'), co = s1.boxes.find((b) => b.kind === 'coordinator');
  assert.deepEqual(w1.messages.map((m) => [m.kind, m.text.split('\n')[0]]), [['out', 'do the thing'], ['reply', 'done']]);
  assert.deepEqual([w1.title, w1.profile, w1.push.sha, w1.parent], ['Worker one', 'glm', '3fa9c01', co.id]);
  assert.deepEqual([w2.status, w2.source, w2.kind, w2.parent, w2.machineState], ['stopped', 'coordinator-log', 'agent', co.id, undefined]);
  assert.deepEqual(co.children.sort(), ['aaaa1111', 'bbbb2222']);
  assert.ok(co.messages.length === 3 && co.messages.every((m) => m.agent));
  assert.doesNotMatch(JSON.stringify(s1), /sk-plantedkey/);
  assert.deepEqual(tails.map((t) => t.slice(0, 2)), [[coord.id, 'events.jsonl']]);
  await getState(); // within 10 s: no new read
  assert.equal(tails.length, 1);
  const s = await serve({ getState, getReader: async () => counted, streamsDir: mkdtempSync(join(tmpdir(), 'cc-sd-')) }), { port } = s.address();
  try {
    const r = JSON.parse((await get(port, `/api/stream?box=aaaa1111&turn=1&t=${TOKEN}`)).body);
    assert.equal(r.source.kind, 'coordinator');
    assert.equal(r.source.machine, coord.id);
    assert.ok(r.events.some((e) => e.kind === 'tool_use' && e.name === 'Bash'));
    assert.deepEqual(tails.at(-1).slice(0, 2), [coord.id, 'streams/aaaa1111/t1.jsonl']);
    const st = await get(port, `/api/state?t=${TOKEN}`);
    assert.doesNotMatch(st.body, /sk-plantedkey/);
  } finally { s.close(); }
});

test('demo state has a coordinator with two workers, tool-call streams, and a box with no stream', () => {
  const d = demoState(), by = Object.fromEntries(d.boxes.map((b) => [b.id, b]));
  const coord = d.boxes.find((b) => b.kind === 'coordinator' && b.children?.length >= 2);
  assert.ok(coord, 'a coordinator with two children');
  for (const id of coord.children) assert.equal(by[id].parent, coord.id);
  const lines = demoStream.stream('b42f0d17', 1).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.message?.content?.[0]?.type === 'tool_use') && lines.some((l) => l.message?.content?.[0]?.type === 'tool_result') && lines.some((l) => l.type === 'result'));
  assert.ok(d.boxes.some((b) => demoStream.stream(b.id, 1) === undefined), 'a box with no stream');
});

// ---- review fixes (#71 #72 #73 #74) ----
test('every string /api/state, /api/stream and /api/pane return, keys included, drops the exact secret values', async () => {
  const sec = 'opaque-secret-value-9876';
  const boxes = [{ id: 'k1', kind: 'coordinator', status: 'running', machine: 'm', machineState: 'running', title: `t ${sec}`, labels: { [`key-${sec}`]: `v ${sec}` } }];
  const reader = fakeReader({ capturePane: async () => ({ lines: [`$ echo ${sec}`], fetchedAt: 1 }) });
  const { dir, opts } = streamEnv(boxes, reader, { getSecrets: async () => [sec] });
  putLocal(dir, 'k1', 1, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `say ${sec}` }] } }) + '\n');
  for (const path of ['/api/state', '/api/stream?box=k1&turn=1', '/api/pane?box=k1']) assert.doesNotMatch((await api(opts, path)).body, /opaque-secret-value/, path);
});

test('a worker started by the same laptop session as its siblings is nobody\'s child; one started by a coordinator is', () => {
  const lab = (o) => ({ purpose: 'cloudy-cloud', ...o });
  const mk = (id, role, labels) => ({ id, name: id, role, owner: 'laptop', labels: lab({ owner: 'laptop', parent: 'laptop', ...labels }), state: 'running', status: 'running', startedAt: 1 });
  const machines = [mk('c1', 'coordinator', { role: 'coordinator', name: 'n1' }), mk('c2', 'coordinator', { role: 'coordinator', name: 'n2' }), mk('w1', 'worker', { role: 'worker', agent: 'aaaa1111' }),
    { ...mk('w2', 'worker', { role: 'worker', agent: 'bbbb2222' }), labels: lab({ role: 'worker', agent: 'bbbb2222', parent: 'n1', owner: 'cown' }) }];
  const by = Object.fromEntries(buildState({ events: [], machines, alive: () => true, owner: 'laptop' }).boxes.map((b) => [b.machine, b]));
  assert.equal(by.c1.parent, undefined); assert.equal(by.c2.parent, undefined); assert.equal(by.w1.parent, undefined);
  assert.equal(by.w2.parent, by.c1.id);
  assert.deepEqual(by.c1.children, [by.w2.id]);
  assert.equal(by.c2.children, undefined);
  // two coordinators naming each other never make a cycle
  const loop = [mk('c1', 'coordinator', { role: 'coordinator', name: 'n1', parent: 'n2' }), mk('c2', 'coordinator', { role: 'coordinator', name: 'n2', parent: 'n1' })];
  const ls = buildState({ events: [], machines: loop, alive: () => true }).boxes;
  assert.ok(ls.filter((b) => b.parent).length <= 1);
});

const coordWithLog = async (lines, clockRef) => {
  const env = { FAKE_API_KEY: 'fakekeyvalue-0123456789' }, provider = createFakeProvider(env);
  const coord = await provider.create({ labels: { purpose: 'cloudy-cloud', role: 'coordinator', name: 'cn', owner: 'o' }, ttlSeconds: 600 });
  const home = join(coord.dir, 'home/.config/cloudy-cloud');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'events.jsonl'), lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const reader = createMachineReader(provider, env, { minIntervalMs: 0, cacheMs: 0, cacheDir: mkdtempSync(join(tmpdir(), 'cc-rc-')) });
  return { env, provider, coord, home, reader, getState: liveState(env, { provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'e'), cacheMs: 0, getReader: async () => reader, now: () => clockRef.t }) };
};

test('a coordinator\'s turn count comes from all its message events, not the 300 kept', async () => {
  const ev = [{ type: 'agent', id: 'aaaa1111', t: 1, description: 'w', role: 'worker' }, ...Array.from({ length: 400 }, (_, i) => ({ type: 'message', id: 'aaaa1111', t: 2 + i, text: 'm' + i }))];
  const clock = { t: 0 }, { getState } = await coordWithLog(ev, clock);
  const w = (await getState()).boxes.find((b) => b.id === 'aaaa1111');
  assert.equal(w.turns, 400);
});

test('a coordinator\'s event history is bounded, and forgotten once its machine is gone', async () => {
  const ev = Array.from({ length: 12_000 }, (_, i) => ({ type: 'agent', id: String(i).padStart(8, '0'), t: i + 1, description: 'w', role: 'worker' }));
  const clock = { t: 0 }, { getState, provider } = await coordWithLog(ev, clock);
  let s;
  for (let i = 0; i < 12; i++) { clock.t += 11_000; s = await getState(); }
  const n = s.boxes.filter((b) => b.source === 'coordinator-log').length;
  assert.ok(n > 0 && n <= 5000, `kept ${n}`);
  const tails = [];
  let gone = false;
  const r = createMachineReader(provider, { FAKE_API_KEY: 'x' }, { minIntervalMs: 0, cacheMs: 0, cacheDir: mkdtempSync(join(tmpdir(), 'cc-rc-')) });
  const gs = liveState({ FAKE_API_KEY: 'x' }, { provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'e'), cacheMs: 0, now: () => clock.t, list: async (e, p) => (gone ? [] : listMachines(e, p)), getReader: async () => ({ ...r, readTail: (m, name, from) => { tails.push(from); return r.readTail(m, name, from); } }) });
  await gs(); clock.t += 11_000; await gs();
  assert.ok(tails.at(-1) > 0);
  gone = true; clock.t += 11_000; await gs();
  gone = false; clock.t += 11_000; await gs();
  assert.equal(tails.at(-1), 0, 'a machine that came back is read from the start: its old events were dropped');
});

test('/api/stream keeps raw machine streams for as many boxes as it keeps parsed ones', async () => {
  const clock = { t: 10_000 };
  const boxes = Array.from({ length: 30 }, (_, i) => ({ id: 'b' + i, kind: 'agent', status: 'running', machine: 'm' + i, machineState: 'running' }));
  const reader = fakeReader();
  const { opts } = streamEnv(boxes, reader, { now: () => clock.t });
  const s = await serve(opts), { port } = s.address();
  try {
    for (const b of boxes) await get(port, `/api/stream?box=${b.id}&turn=1&t=${TOKEN}`);
    clock.t += 4000;
    reader.calls.length = 0;
    await get(port, `/api/stream?box=b0&turn=1&t=${TOKEN}`);
    assert.deepEqual(reader.calls, [['tail', 'm0', 'stream/t1.jsonl', 0]], 'the oldest was evicted, so it is read again from 0');
  } finally { s.close(); }
});

test('the stream cursor follows the reader\'s `next` even when it returns no data (skipped oversize line)', async () => {
  const clock = { t: 10_000 }, froms = [];
  const reader = fakeReader({ readTail: async (m, name, from) => { froms.push(from); return from === 0 ? { data: '', from, next: 500, size: 900, fetchedAt: 1 } : { data: SAMPLE, from, next: from + SAMPLE.length, size: 900, fetchedAt: 2 }; } });
  const { opts } = streamEnv([{ id: 'o1', kind: 'agent', status: 'running', machine: 'mo', machineState: 'running' }], reader, { now: () => clock.t });
  const s = await serve(opts), { port } = s.address();
  try {
    await get(port, `/api/stream?box=o1&turn=1&t=${TOKEN}`);
    clock.t += 4000;
    await get(port, `/api/stream?box=o1&turn=1&t=${TOKEN}`);
    assert.deepEqual(froms, [0, 500]);
  } finally { s.close(); }
});

test('a rate-limited pane read is the last real pane with its real time, or "rate_limited", never a fresh empty one', async () => {
  let limited = false;
  const reader = fakeReader({ capturePane: async () => (limited ? { lines: [], fetchedAt: 9000, source: 'cache' } : { lines: ['real'], fetchedAt: 6000 }) });
  const { opts } = streamEnv([{ id: 'co', kind: 'coordinator', machine: 'mco', machineState: 'running' }, { id: 'c2', kind: 'coordinator', machine: 'mc2', machineState: 'running' }], reader);
  const s = await serve(opts), { port } = s.address();
  const pane = async (id) => JSON.parse((await get(port, `/api/pane?box=${id}&t=${TOKEN}`)).body);
  try {
    limited = true;
    assert.deepEqual(await pane('c2'), { lines: [], fetchedAt: null, source: { kind: 'none', machine: 'mc2', reason: 'rate_limited' } });
    limited = false; await pane('co'); limited = true;
    assert.deepEqual(await pane('co'), { lines: ['real'], fetchedAt: 6000, source: { kind: 'cache', machine: 'mco' } });
  } finally { s.close(); }
});

test('the machine reader marks its rate-limit pane fallback as from the cache', async () => {
  const env = { FAKE_API_KEY: 'fakekeyvalue-0123456789' }, provider = createFakeProvider(env);
  const m = await provider.create({ labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 600 });
  const reader = createMachineReader(provider, env, { minIntervalMs: 60_000, cacheMs: 0, cacheDir: mkdtempSync(join(tmpdir(), 'cc-rc-')) });
  await reader.readTail(m.id, 'events.jsonl', 0).catch(() => {}); // uses the machine within the interval
  assert.equal((await reader.capturePane(m.id)).source, 'cache');
});

test('lazy builds its value once for concurrent callers and retries after a failure', async () => {
  let n = 0;
  const get1 = lazy(async () => { n++; await new Promise((r) => setTimeout(r, 10)); return {}; });
  const [a, b] = await Promise.all([get1(), get1()]);
  assert.equal(a, b); assert.equal(n, 1);
  let fail = true;
  const g2 = lazy(async () => { if (fail) throw new Error('x'); return 1; });
  await assert.rejects(g2());
  fail = false;
  assert.equal(await g2(), 1);
});

test('the page names the worker on a coordinator\'s merged messages and links to it', () => {
  const script = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  assert.match(script, /m\.agent && m\.agent !== b\.id/);
  assert.match(script, /'worker ' \+ /);
  assert.match(script, /select\(m\.agent, true\)/);
});

// ---- page fixes for the dashboard review (#73): the page is one script, so these check its source and run its small pure helpers
const PAGE = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
const pageLine = (start) => PAGE.split('\n').find((l) => l.trim().startsWith(start));

test('page: an event with no timestamp renders without a time element instead of throwing', () => {
  const run = new Function('h', 'now', `${pageLine('const clock')}\n${pageLine('const timeEl')}\nreturn timeEl;`);
  const timeEl = run((tag, a) => ({ tag, ...a }), () => Date.now());
  assert.doesNotThrow(() => timeEl('btime', undefined));
  assert.equal(timeEl('btime', undefined) || null, null);
  assert.equal(timeEl('btime', 'x') || null, null);
  assert.equal(timeEl('btime', Date.now()).tag, 'time');
});

test('page: an inactive agent keeps fetching its stream while the server says it is not complete and next advances, within a bound', () => {
  assert.match(PAGE, /!st\.complete && st\.next > nextBefore && \+\+st\.hops <= 20/);
});

test('page: a turn\'s messages come from the retained outgoing messages offset by the dropped ones, never the whole history', () => {
  assert.match(PAGE, /const first = Math\.max\(1, \(b\.turns \|\| 1\) - outs\.length \+ 1\)/);
  assert.match(PAGE, /turn < first/);
  assert.doesNotMatch(PAGE, /outs\[turn - 1\] \?\? 0/);
  assert.match(PAGE, /were not kept/);
});

test('page: Terminal polling needs the list view and an open detail pane, like the stream tail', () => {
  assert.match(PAGE, /const visible = /);
  assert.match(PAGE, /paneEnsure\(b\) \{\s*if \(b\.kind !== 'coordinator' \|\| S\.tab !== 'terminal' \|\| !visible\(b\)/);
});

test('page: collapsing a coordinator with one of its workers selected selects the coordinator first', () => {
  assert.match(PAGE, /S\.kids\[id\]\?\.some\(\(c\) => c\.id === S\.sel\)\) return select\(id, false\)/);
});

test('page: the fleet signature includes workers', () => {
  assert.match(PAGE, /const f = sig\(\['f', roots\.map\(\(b\) => \[[^\]]*, \(S\.kids\[b\.id\] \|\| \[\]\)\.map/);
});

test('page: pane failures show their reason, and pane data gets the source and age badge', () => {
  assert.match(PAGE, /source: j\.source/);
  assert.match(PAGE, /Could not read the terminal/);
  assert.match(PAGE, /term \? null : turnBar\(b\), badgeEl/);
  assert.doesNotMatch(PAGE, /term \? null : badgeEl/);
});

test('page: a cached stream is not called a deleted machine unless the reason says so', () => {
  assert.doesNotMatch(PAGE, /'cached copy · machine deleted'/);
  assert.match(PAGE, /machine_gone'\s*\?\s*'saved copy · machine deleted'/);
  assert.match(PAGE, /from the saved copy \(machine not reachable\)/);
});

test('page: full-text responses are cleared on agent or turn change and capped in total size', () => {
  assert.match(PAGE, /S\.full = \{\}/);
  assert.match(PAGE, /FULL_CAP/);
});

test('a coordinator whose pane shows a waiting prompt gets `waiting` (redacted), read at most every 30 s, and a quiet pane clears it (#88)', async () => {
  const clock = { t: 100_000 }, { getState, reader } = await coordWithLog([{ type: 'agent', id: 'aaaa1111', t: 1, description: 'w', role: 'worker' }], clock);
  let pane = ['working', '│ Do you want to read /data/tmp/claude-1000/x.md? sk-ant-oat01-LEAKYTOKEN0123', '❯ 1. Yes'], reads = 0;
  reader.capturePane = async () => { reads++; return { lines: pane, fetchedAt: clock.t }; };
  const co = async () => (await getState()).boxes.find((b) => b.kind === 'coordinator');
  const first = await co();
  assert.match(first.waiting, /^Do you want to read \/data\/tmp\/claude-1000\/x\.md\?/);
  assert.doesNotMatch(first.waiting, /LEAKYTOKEN/);
  clock.t += 10_000; await co();
  assert.equal(reads, 1, 'not again within 30 s');
  pane = ['working']; clock.t += 25_000;
  assert.equal((await co()).waiting, undefined);
  assert.equal(reads, 2);
});

test('the page lists a waiting coordinator under Needs you with its line and the attach command (#88)', () => {
  const page = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  assert.match(page, /needsYou = \(b\) => [^\n]*b\.waiting/);
  assert.match(page, /Waiting on a prompt/);
  assert.match(page, /coordinator attach/);
});

test('a fatal pane state reaches the box as waiting with fatal; the attach name is the label; a stopped coordinator drops the alert (#88)', async () => {
  const clock = { t: 100_000 }, { getState, reader, env, provider } = await coordWithLog([{ type: 'agent', id: 'aaaa1111', t: 1, description: 'w', role: 'worker' }], clock);
  reader.capturePane = async () => ({ lines: ['Not logged in \u00b7 Please run /login'], fetchedAt: clock.t });
  const co = async () => (await getState()).boxes.find((b) => b.kind === 'coordinator');
  const b = await co();
  assert.deepEqual([b.waiting, b.fatal, b.labels.name], ['Not logged in \u00b7 Please run /login', true, 'cn']);
  const page = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  assert.match(page, /attach ' \+ \(b\.labels && b\.labels\.name \|\| b\.id\)/);
  assert.match(page, /b\.fatal/);
  const down = liveState(env, { provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'e'), cacheMs: 0, getReader: async () => reader, now: () => clock.t, list: async (e, p) => (await listMachines(e, p)).map((m) => ({ ...m, state: gone ? 'deleting' : m.state })) });
  let gone = false;
  assert.ok((await down()).boxes.find((x) => x.kind === 'coordinator').waiting);
  gone = true; clock.t += 40_000;
  const after = (await down()).boxes.find((x) => x.kind === 'coordinator');
  assert.deepEqual([after.machineState, after.waiting], ['deleting', undefined]);
});

test('boxes carry machineKind from the kind label (absent is linux), and state carries the provider caps', () => {
  const m = (id, kind) => ({ id, name: id, labels: { agent: id, ...(kind && { kind }) }, state: 'running', status: 'running' });
  const s = buildState({ events: [], machines: [m('a1', 'android'), m('g1', 'gpu:l4:2'), m('l1')], now: 1000, alive: () => true, provider: createFakeProvider() });
  const by = (id) => s.boxes.find((b) => b.id === id);
  assert.equal(by('a1').machineKind, 'android');
  assert.equal(by('g1').machineKind, 'gpu:l4:2');
  assert.equal(by('l1').machineKind, undefined);
  assert.equal(typeof s.caps.hasShell, 'boolean');
  assert.equal(typeof s.caps.hasDisplay, 'boolean');
  assert.equal(buildState({ events: [], machines: [], now: 1000, alive: () => true }).caps, undefined);
});

test('demo has android and gpu boxes, and no linux demo box has a kind', () => {
  const d = demoState(), by = (id) => d.boxes.find((b) => b.id === id);
  assert.equal(by('c3d4e5f6').machineKind, 'android');
  assert.match(by('d4e5f607').machineKind, /^gpu:l4/);
  assert.equal(by('7c1e90ab').machineKind, undefined);
  assert.deepEqual(d.caps, { hasShell: true, hasDisplay: true });
});

test('the page shows kind badges, shell and display command rows once each, hides display for omarchy and no-display providers, and has no link or token', () => {
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  assert.equal(html.split('cloudy-cloud shell ').length - 1, 1);
  assert.equal(html.split('cloudy-cloud display ').length - 1, 1);
  assert.match(html, /machineKind/);
  assert.match(html, /omarchy/);
  assert.match(html, /caps\.hasDisplay/);
  assert.doesNotMatch(html, /desktop\/stream/);
  assert.doesNotMatch(html, /location\.hash|#token/);
  assert.doesNotMatch(JSON.stringify(demoState()), /https?:\/\/[^\s"]*(display|desktop|stream)|[?#&]token=/i);
});

test('shell and display commands use an id the CLI resolves, and a kind or caps change re-renders the rail and the panel', () => {
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  // a local agent (source log) uses its agent id; any other box uses its machine id, since a label-only agent id is unknown to the CLI
  assert.match(html, /const cliId = \(b\) => b\.source === 'log' \|\| !b\.machine \? b\.id : b\.machine;/);
  assert.match(html, /shellCmd\(cliId\(b\)\)/);
  assert.match(html, /displayCmd\(cliId\(b\)\)/);
  assert.doesNotMatch(html, /shellCmd\(b\.id\)|displayCmd\(b\.id\)/);
  assert.match(html, /sig\(\['r'[^\n]*b\.machineKind/);
  assert.match(html, /sig\(\['p'[^\n]*sb\.machineKind[^\n]*caps/);
});

test('#111 the command rows are in the header, which has no height cap on a phone, and the Cost row names the price and how to stop', () => {
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const head = html.match(/const head = h\('div', \{ class: 'panel-head' \}[\s\S]*?updateBadge\(b\);/)[0];
  assert.match(head, /class: 'props cmds'[^\n]*kindRows\(b\)/);
  assert.doesNotMatch(html, /\.panel-head \{[^}]*(max-height|overflow)/); // a capped header scrolled on its own and hid the rows at 390px
  assert.match(html, /\.props\.cmds/);
  assert.match(html, /\$0\.765 per GPU-hour/);
  assert.match(html, /cloud_agent_stop/);
  assert.match(html, /24-hour minimum/);
  assert.match(html, /not available on omarchy/i);
  assert.match(html, /kindrep/); // the kind in the Machine row only where the list badge is hidden
});

test('the macOS Cost row prices the chosen model with its 24-hour minimum, and the macOS Screen row says it is unverified', () => {
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const src = html.match(/  const costText = [\s\S]*?\n  \};/)[0];
  const costText = new Function(`${src}; return costText;`)();
  const m2 = costText({ machineKind: 'macos:m2', deadline: 1 }), pro = costText({ machineKind: 'macos:m4pro' });
  assert.match(m2, /\$0\.45 per hour[\s\S]*24-hour minimum[\s\S]*\$10\.80/);
  assert.match(pro, /\$1\.25 per hour[\s\S]*24-hour minimum[\s\S]*\$30\.00/);
  assert.doesNotMatch(pro, /\$0\.45/);
  assert.match(costText({ machineKind: 'macos' }), /\$0\.45 to \$1\.25 per hour/);
  assert.match(html, /not verified on macOS yet/);
});

// ---- usage per running machine (#117) ----
const usageEnv = (over = {}) => {
  const clock = { t: 1_000_000 }, calls = [];
  const machines = [{ id: 'm1', state: 'running', status: 'running', labels: {} }, { id: 'm2', state: 'running', status: 'running', labels: {} }, { id: 'm3', state: 'stopped', status: 'stopped', labels: {} }];
  const series = (id) => [{ t: clock.t - 60_000, cpuPct: 5, cpuCount: 2, memUsed: 1, memTotal: 4 }, { t: clock.t - 20_000, cpuPct: id === 'm1' ? 77 : 12, cpuCount: 2, memUsed: 2, memTotal: 4, netIn: 9, netOut: 8 }];
  const provider = { name: 'fake', keyName: 'FAKE_API_KEY', caps: { hasMetrics: true }, async metrics(id, o) { calls.push({ id, since: o.since }); return over.metrics ? over.metrics(id, o) : { samples: series(id), fetchedAt: clock.t }; } };
  const getState = liveState({}, { list: async () => machines, provider: over.provider ?? provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'events.jsonl'), cacheMs: 0, now: () => clock.t });
  return { clock, calls, getState, machines };
};
const fresh = async (getState) => { await getState(); await getState.settle(); return getState(); }; // one state build, the background reads, then the state with their result
const boxOf = (s, m) => s.boxes.find((b) => b.machine === m);

test('usage is read once per running machine per 30 s, from the newest sample, and never for a stopped machine', async () => {
  const { clock, calls, getState } = usageEnv();
  const s = await fresh(getState); await getState(); clock.t += 29_000; await fresh(getState);
  assert.deepEqual(calls.map((c) => c.id).sort(), ['m1', 'm2']);
  assert.equal(calls[0].since, 1_000_000 - 3_600_000);
  const u = boxOf(s, 'm1').usage;
  assert.deepEqual([u.cpuPct, u.cpuCount, u.memUsed, u.memTotal, u.netIn, u.netOut, u.at, u.fetchedAt, u.source], [77, 2, 2, 4, 9, 8, 1_000_000 - 20_000, 1_000_000, 'live']);
  assert.equal(boxOf(s, 'm2').usage.cpuPct, 12);
  assert.equal('usage' in boxOf(s, 'm3'), false);
  clock.t += 2_000; await fresh(getState);
  assert.equal(calls.length, 4);
});

test('at most 4 usage reads are in flight at once', async () => {
  let now = 0, peak = 0;
  const { getState, machines } = usageEnv({ metrics: async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 5)); now--; return { samples: [], fetchedAt: 1 }; } });
  for (let i = 0; i < 10; i++) machines.push({ id: `x${i}`, state: 'running', status: 'running', labels: {} });
  await fresh(getState);
  assert.equal(peak, 4);
});

test('a failed usage read shows the reason with its guide, keeps the last samples, and is not a zero', async () => {
  let fail = false;
  const { clock, getState, calls } = usageEnv({ metrics: async (id) => { if (fail) throw Object.assign(new Error('503 secret-detail'), { code: 'metrics_unavailable' }); return { samples: [{ t: 5, cpuPct: 40, cpuCount: 1, memUsed: 1, memTotal: 2 }], fetchedAt: 6 }; } });
  assert.equal(boxOf(await fresh(getState), 'm1').usage.cpuPct, 40);
  fail = true; clock.t += 31_000;
  const u = boxOf(await fresh(getState), 'm1').usage;
  assert.equal(u.error.code, 'metrics_unavailable');
  assert.equal(typeof u.error.nextStep, 'string');
  assert.equal(u.cpuPct, undefined);
  assert.equal(calls.length, 4);
  const kept = (await getState.metrics('m1'));
  assert.equal(kept.samples.length, 1);
  assert.equal(kept.error.code, 'metrics_unavailable');
  fail = false; clock.t += 31_000;
  assert.equal(boxOf(await fresh(getState), 'm1').usage.error, undefined);
});

test('a machine that is gone gives machine_gone without guide text; no samples gives no_samples_yet', async () => {
  const { getState } = usageEnv({ metrics: async (id) => { if (id === 'm1') throw Object.assign(new Error('x'), { code: 'not_found' }); return { samples: [], fetchedAt: 7 }; } });
  const s = await fresh(getState);
  assert.deepEqual(boxOf(s, 'm1').usage, { error: { code: 'machine_gone' } });
  assert.deepEqual(boxOf(s, 'm2').usage, { none: 'no_samples_yet', fetchedAt: 7 });
});

test('a provider without metrics says metrics_unsupported once and makes no calls', async () => {
  let n = 0;
  const { getState, clock } = usageEnv({ provider: { name: 'self-hosted', keyName: 'K', caps: { hasMetrics: false }, metrics: async () => { n++; } } });
  const u = boxOf(await fresh(getState), 'm1').usage;
  assert.equal(u.error.code, 'metrics_unsupported');
  clock.t += 60_000; await getState();
  assert.equal(n, 0);
});

test('a read that never finishes does not delay the state, is not started twice, and shows up once it lands', async () => {
  const releases = []; let started = 0;
  const { getState, clock } = usageEnv({ metrics: () => { started++; return new Promise((r) => { releases.push(() => r({ samples: [{ t: 9, cpuPct: 33, cpuCount: 1, memUsed: 1, memTotal: 2 }], fetchedAt: 10 })); }); } });
  const t0 = Date.now();
  const s1 = await getState(); clock.t += 1000; await getState(); clock.t += 40_000; await getState();
  assert.ok(Date.now() - t0 < 200);
  assert.deepEqual(boxOf(s1, 'm1').usage, { none: 'no_samples_yet', fetchedAt: null });
  assert.equal(started, 2); // m1 and m2, once each, although the 30 s passed while they were still in flight
  releases.forEach((f) => f()); await getState.settle();
  assert.equal(boxOf(await getState(), 'm1').usage.cpuPct, 33);
});

test('a read that fails in the background is not an unhandled rejection', async () => {
  const seen = []; const h = (e) => seen.push(e); process.on('unhandledRejection', h);
  try {
    const { getState } = usageEnv({ metrics: async () => { throw new Error('boom'); } });
    await getState(); await getState.settle(); await new Promise((r) => setImmediate(r));
  } finally { process.off('unhandledRejection', h); }
  assert.deepEqual(seen, []);
});

test('/api/metrics gives a live box its samples, 404 for a stopped or unknown box, 401 without the token, and never a key', async () => {
  const boxes = [{ id: 'a1', machine: 'm1', machineState: 'running', kind: 'agent' }, { id: 'b1', machine: 'm3', machineState: 'stopped', kind: 'agent' }];
  const getMetrics = (m) => (m === 'm1' ? { samples: [{ t: 1, cpuPct: 3, note: 'sk-abcdefghijklmnop1234' }], fetchedAt: 9, source: 'live' } : undefined);
  const { opts } = streamEnv(boxes, null, { getMetrics });
  const ok = await api(opts, '/api/metrics?box=a1');
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.box, ok.json.samples.length, ok.json.fetchedAt, ok.json.window, ok.json.source], ['a1', 1, 9, 3_600_000, 'live']);
  assert.doesNotMatch(ok.body, /sk-abcdefghij/);
  assert.equal((await api(opts, '/api/metrics?box=b1')).status, 404);
  assert.equal((await api(opts, '/api/metrics?box=zzz')).status, 404);
  const s = await serve(opts), { port } = s.address();
  try {
    assert.equal((await get(port, '/api/metrics?box=a1')).status, 401);
    assert.equal((await get(port, `/api/metrics?box=a1&t=${TOKEN}`, 'evil.example')).status, 403);
    assert.equal((await get(port, `/api/metrics?box=a1&t=${TOKEN}`, undefined, 'POST')).status, 405);
  } finally { s.close(); }
});

test('the demo has usage for running boxes (one busy, one quiet) and a series at /api/metrics', async () => {
  const demo = demoState(Date.now()), by = (id) => demo.boxes.find((b) => b.id === id);
  assert.ok(by('7c1e90ab').usage.cpuPct > 60 && by('b42f0d17').usage.cpuPct < 15);
  assert.equal(by('c3d4e5f6').usage.quiet, true); assert.equal(by('7c1e90ab').usage.quiet, undefined);
  assert.equal('usage' in by('51d9ee02'), false);
  assert.equal('usage' in by('a7716be4'), false);
  const { opts } = streamEnv(demo.boxes, null, { getReader: undefined, demo: demoStream });
  const r = (await api(opts, '/api/metrics?box=7c1e90ab')).json;
  assert.equal(r.samples.length, 120);
  assert.ok(r.samples.at(-1).t - r.samples[0].t >= 3_500_000 && r.samples.at(-1).t - r.samples[0].t <= 3_600_000);
});

// ---- usage read eligibility, timing and bounds (#117 review) ----
const gated = () => { // m1, m2, x1..x3 running; metrics for the first four block until released, later ones answer at once
  const held = [], seen = [];
  const e = usageEnv({ metrics: (id) => { seen.push(id); const s = [{ t: 1_000_000 - 5000, cpuPct: 1, cpuCount: 1, memUsed: 1, memTotal: 2 }]; return held.length < 4 ? new Promise((r) => held.push(() => r({ samples: s, fetchedAt: 1 }))) : Promise.resolve({ samples: s, fetchedAt: 1 }); } });
  for (const id of ['x1', 'x2', 'x3']) e.machines.push({ id, state: 'running', status: 'running', labels: {} });
  return { ...e, held, seen };
};
const tick = () => new Promise((r) => setImmediate(r));

test('a read queued behind others is dropped when its machine left the running list meanwhile', async () => {
  const { getState, machines, held, seen } = gated();
  await getState(); await tick(); assert.equal(seen.length, 4);
  machines.find((m) => m.id === 'x3').state = 'stopped'; await getState();
  held.forEach((f) => f()); await getState.settle(); await tick();
  assert.equal(seen.includes('x3'), false);
});

test('a read queued when the page stops polling is dropped', async () => {
  const { getState, clock, held, seen } = gated();
  await getState(); await tick(); clock.t += 600_000;
  held.forEach((f) => f()); await getState.settle(); await tick();
  assert.equal(seen.length, 4);
});

test('the 30 s interval counts from when the read starts, not when it was queued', async () => {
  const { getState, clock, held, seen } = gated();
  await getState(); await tick(); clock.t += 31_000; await getState(); // x3 still queued; the page keeps polling
  held.forEach((f) => f()); await getState.settle(); await tick(); assert.equal(seen.filter((i) => i === 'x3').length, 1);
  clock.t += 1_000; await getState(); await getState.settle();
  assert.equal(seen.filter((i) => i === 'x3').length, 1); // started at +31 s, so not again at +32 s
});

test('stored samples are capped and limited to the last hour, also at response time', async () => {
  const clock0 = 10_000_000;
  const many = Array.from({ length: 400 }, (_, i) => ({ t: clock0 - (399 - i) * 5000, cpuPct: i, cpuCount: 1, memUsed: 1, memTotal: 2 }));
  const old = [{ t: clock0 - 7_200_000, cpuPct: 99, cpuCount: 1, memUsed: 1, memTotal: 2 }, ...many];
  let fail = false;
  const { getState, clock } = usageEnv({ metrics: async () => { if (fail) throw Object.assign(new Error('x'), { code: 'metrics_unavailable' }); return { samples: old, fetchedAt: clock0 }; } });
  clock.t = clock0;
  const s = await fresh(getState);
  const kept = getState.metrics('m1').samples;
  assert.equal(kept.length, 150); assert.equal(kept.at(-1).cpuPct, 399); assert.ok(kept.every((x) => x.t >= clock0 - 3_600_000));
  assert.equal(boxOf(s, 'm1').usage.cpuPct, 399);
  fail = true; clock.t += 2 * 3_600_000; const s2 = await fresh(getState);
  assert.equal(getState.metrics('m1').samples.length, 0); // nothing older than an hour is returned after a failed refresh
  assert.equal(boxOf(s2, 'm1').usage.error.code, 'metrics_unavailable');
});

test('the demo series covers one hour', () => {
  const s = demoStream.metrics('7c1e90ab').samples;
  assert.equal(s.length, 120); assert.ok(s.at(-1).t - s[0].t <= 3_600_000);
});

// ---- provider slots, list order, restart within 30 s (#117 second review) ----
const mkMachines = (...ids) => ids.map((id) => ({ id, state: 'running', status: 'running', labels: {} }));
const stateWith = (list, provider, clock) => liveState({}, { list, provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'events.jsonl'), cacheMs: 0, now: () => clock.t });

test('pending metrics reads never take every provider slot: a state build that needs a slot still completes', async () => {
  const L = createLimiter(4), clock = { t: 1_000_000 }, calls = [];
  const provider = { name: 'fake', keyName: 'K', caps: { hasMetrics: true, maxConcurrentCalls: 4 }, metrics: (id) => L.run(() => { calls.push(id); return new Promise(() => {}); }) };
  const machines = mkMachines('a', 'b', 'c', 'd', 'e');
  const getState = stateWith(() => L.run(async () => machines), provider, clock);
  await getState(); await tick();
  assert.ok(calls.length >= 1 && calls.length <= 3);
  const done = await Promise.race([getState().then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
  assert.equal(done, true);
});

test('a list answer older than the one already applied does not start reads', async () => {
  const clock = { t: 1_000_000 }, calls = []; let n = 0;
  const provider = { name: 'fake', keyName: 'K', caps: { hasMetrics: true }, metrics: async (id) => { calls.push(id); return { samples: [], fetchedAt: 1 }; } };
  const list = async () => (++n === 1 ? (await new Promise((r) => setTimeout(r, 30)), mkMachines('m1')) : [{ id: 'm1', state: 'stopped', status: 'stopped', labels: {} }]);
  const getState = stateWith(list, provider, clock);
  await Promise.all([getState(), getState()]); await getState.settle(); await tick();
  assert.deepEqual(calls, []);
});

test('a machine that stops and resumes within 30 s is not read again at once', async () => {
  const clock = { t: 1_000_000 }, calls = []; let state = 'running';
  const provider = { name: 'fake', keyName: 'K', caps: { hasMetrics: true }, metrics: async (id) => { calls.push(id); return { samples: [], fetchedAt: 1 }; } };
  const getState = stateWith(async () => [{ id: 'm1', state, status: state, labels: {} }], provider, clock);
  await fresh(getState); state = 'stopped'; clock.t += 2000; await getState(); state = 'running'; clock.t += 2000; await fresh(getState);
  assert.equal(calls.length, 1);
  clock.t += 30_000; await fresh(getState);
  assert.equal(calls.length, 2);
});

// #119: usage per agent on the page. The page is not run here; these check the source for the behaviour the issue fixes.
test('the page shows usage: list text, sparkline from numbers, quiet hint, freshness, states and the copy command', () => {
  const script = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  assert.match(script, /\/api\/metrics\?t=' \+ enc\(T\)/, 'the metrics fetch carries the token');
  assert.match(script, /'cpu ' \+ Math\.round\(/, 'rail and fleet text: cpu N% · mem X of Y GiB');
  assert.match(script, /createElementNS\(NS, tag\)/); assert.match(script, /hs\('polyline'/, 'the sparkline is built with createElementNS');
  assert.match(script, /Number\.isFinite/, 'sparkline points are checked as finite numbers');
  assert.match(script, /stroke-dasharray/, 'memory line is dashed');
    assert.match(script, /Quiet for 10 minutes while marked running/);
  assert.match(script, /Newest sample/); assert.match(script, /paused or stopped since then/);
  assert.match(script, /never wakes a paused machine/);
  assert.match(script, /within about a minute of starting/);
  assert.match(script, /whatHappened/); assert.match(script, /nextStep/);
  assert.match(script, /usage\?\.cpuPct/, 'usage fields are in the rebuild signatures');
});

// ---- #119 review fixes: run the page's pure helpers on their own
const pure = (() => {
  const src = PAGE.slice(PAGE.indexOf('// pure:begin'), PAGE.indexOf('// pure:end'));
  const dur = (ms) => Math.round(ms / 60_000) + 'm';
  return new Function('fin', 'dur', `${src}\nreturn { safeId, metricsCmdFor, quietText, quietTitle, quietFresh, flatHour, pruneMetrics, historyNote };`)((n) => typeof n === 'number' && Number.isFinite(n), dur);
})();
const NOW = 10_000_000;
const series = (o = {}) => Array.from({ length: 40 }, (_, k) => ({ t: NOW - (39 - k) * 30_000, cpuPct: 1, netIn: 100, netOut: 50, ...o }));

test('page: the copied metrics command is shown only for a safe machine id, and single-quoted', () => {
  assert.equal(pure.metricsCmdFor('m-7c1e90ab'), "npx --yes instabox@latest metrics 'm-7c1e90ab' --since 6h");
  for (const bad of ['m1; printf INJECTED #', 'a b', '$(x)', '`x`', "a'b", '-rf', '', 'a\nb', undefined]) assert.equal(pure.metricsCmdFor(bad), null, String(bad));
  assert.equal(pure.safeId('x;y'), null);
  assert.match(PAGE, /if \(!safeId\(cliId\(b\)\)\) return null/, 'Shell and Screen rows use it too');
  assert.match(PAGE, /openApp = \(b\) => \{\s*if \(!safeId\(b\.id\)\) return null/);
});

test('server: quiet needs 10 continuous minutes under 3 % CPU, a fresh newest sample, and low network where it is reported', () => {
  const ss = series();
  assert.equal(isQuiet(ss, NOW), true);
  const gap = ss.filter((x, i) => i < 20 || i > 24); // a 150 s hole
  assert.equal(isQuiet(gap, NOW), false);
  assert.equal(isQuiet(ss.slice(-15), NOW), false);
  assert.equal(isQuiet(series().map((x, i) => (i < 5 ? { ...x, cpuPct: 50 } : x)), NOW), true, 'a busy sample older than 10 minutes does not count');
  assert.equal(isQuiet(series().map((x, i) => (i === 30 ? { ...x, cpuPct: 3 } : x)), NOW), false);
  assert.equal(isQuiet(series({ netIn: 1000, netOut: 100 }), NOW), false);
  assert.equal(isQuiet(ss, NOW + 130_000), false, 'stale newest sample');
  const noNet = series({ netIn: undefined, netOut: undefined });
  assert.equal(isQuiet(noNet, NOW), true, 'network not reported yet: CPU alone decides');
  assert.equal(isQuiet(noNet.map((x, i) => (i === 30 ? { ...x, cpuPct: 20 } : x)), NOW), false);
});

test('server: the state marks only running machines quiet, from the stored samples', async () => {
  const clock0 = 10_000_000;
  const quietSeries = Array.from({ length: 40 }, (_, k) => ({ t: clock0 - (39 - k) * 30_000, cpuPct: 1, cpuCount: 2, memUsed: 1, memTotal: 4 }));
  const { getState, clock } = usageEnv({ metrics: async (id) => ({ samples: id === 'm1' ? quietSeries : quietSeries.map((x) => ({ ...x, cpuPct: 50 })), fetchedAt: clock0 }) });
  clock.t = clock0;
  const s = await fresh(getState);
  assert.equal(boxOf(s, 'm1').usage.quiet, true);
  assert.equal(boxOf(s, 'm2').usage.quiet, undefined);
});

test('page: list rows and fleet cards show a quiet tag from usage.quiet, fleet text is short, idle reads as waiting for you', () => {
  assert.match(PAGE, /isQuiet = \(b\) => b\.status === 'running' && hasUsage\(b\) && quietFresh\(b\.usage, now\(\)\)/);
  assert.match(PAGE, /text: 'quiet'/);
  assert.equal((PAGE.match(/quietTag\(b\)/g) || []).length >= 3, true, 'list row and fleet card use the tag');
  assert.match(PAGE, /usageLine\(b, true\)/); assert.match(PAGE, /'\/' \+ gib\(u\.memTotal\) \+ ' GiB'/);
  assert.match(PAGE, /st === 'idle' \? 'waiting for you'/);
  assert.match(PAGE, /'Waiting for you', idle/);
  assert.equal((PAGE.match(/isQuiet\((b|c|sb)\)\]?[,\]]/g) || []).length >= 3, true, 'the quiet state is in the rebuild signatures');
});

test('page: quiet hint wording depends on whether network is reported, and mentions stopping', () => {
  assert.match(pure.quietText({ netIn: 1, netOut: 1 }), /under 3 % CPU and almost no network\./);
  assert.match(pure.quietText({}), /under 3 % CPU; network not reported yet\./);
  assert.match(pure.quietText({}), /cloud_agent_stop/);
});

test('page: the quiet flag is trusted only while the usage sample is under 2 minutes old, and the tooltip depends on network', () => {
  assert.equal(pure.quietFresh({ quiet: true, at: NOW - 119_000 }, NOW), true);
  assert.equal(pure.quietFresh({ quiet: true, at: NOW - 121_000 }, NOW), false);
  assert.equal(pure.quietFresh({ quiet: true }, NOW), false);
  assert.match(pure.quietTitle({ netIn: 1, netOut: 1 }), /almost no network/);
  assert.match(pure.quietTitle({}), /network not reported yet/);
  assert.doesNotMatch(pure.quietTitle({}), /almost no network/);
  assert.match(PAGE, /b\.usage\?\.quiet, now\(\)|quietFresh\(b\.usage, now\(\)\)/);
  assert.equal(/usage\?\.quiet/.test(PAGE), false, 'signatures use the age-aware isQuiet, so tags re-render as samples age');
});

test('page: the graph is labelled, and a flat hour becomes one note', () => {
  const hour = (cpu) => Array.from({ length: 120 }, (_, k) => ({ t: NOW - (119 - k) * 30_000, cpuPct: cpu }));
  assert.equal(pure.flatHour(hour(1)), true);
  assert.equal(pure.flatHour(hour(3)), false);
  assert.equal(pure.flatHour(hour(1).slice(-20)), false, 'ten minutes of history is not "all hour"');
  assert.equal(pure.flatHour([{ t: NOW - 56 * 60_000, cpuPct: 1 }, { t: NOW, cpuPct: 1 }]), false, 'two low samples are not an hour');
  assert.equal(pure.flatHour(hour(1).filter((x, i) => i < 50 || i > 54)), false, 'a gap over 90 s');
  assert.match(PAGE, /text: '1h ago'/); assert.match(PAGE, /'now: CPU '/); assert.match(PAGE, /CPU flat all hour/);
});

test('page: the measurement footnote is a disclosure, the history command wraps', () => {
  assert.match(PAGE, /h\('details', \{ class: 'fine' \}, h\('summary', \{ text: 'How this is measured' \}\)/);
  assert.match(PAGE, /\.usage \.prop \.pv \{ white-space: normal; overflow-wrap: anywhere/);
});

test('page: a failed history read keeps the old samples, marks them stale and says how old, or says history is unavailable', () => {
  assert.equal(pure.historyNote({ stale: true, okAt: NOW - 5 * 60_000 }, NOW), 'History could not be refreshed. The graph is 5m old.');
  assert.match(pure.historyNote({ stale: true, okAt: null }, NOW), /^History is unavailable/);
  assert.equal(pure.historyNote({ stale: false }, NOW), null);
  assert.equal(pure.historyNote(undefined, NOW), null);
  assert.equal((PAGE.match(/stale: true, okAt: prev\?\.okAt \?\? null/g) || []).length, 2, 'non-OK and network error both mark stale');
});

test('page: the history cache drops agents that left the state and keeps only the 10 most recent', () => {
  const cache = Object.fromEntries(Array.from({ length: 14 }, (_, i) => ['a' + i, { got: i }]));
  pure.pruneMetrics(cache, new Set(Object.keys(cache).filter((k) => k !== 'a13')));
  assert.equal('a13' in cache, false);
  assert.deepEqual(Object.keys(cache).sort(), Array.from({ length: 10 }, (_, i) => 'a' + (i + 3)).sort());
  assert.match(PAGE, /pruneMetrics\(S\.metrics, new Set\(\(S\.data\.boxes/, 'also pruned when the state arrives');
});

test('the demo has one truly quiet running agent: under 3 % CPU and 1 KB/s for the whole hour', () => {
  const s = demoStream.metrics('c3d4e5f6').samples;
  assert.equal(s.length, 120);
  assert.ok(s.every((x) => x.cpuPct < 3 && x.netIn + x.netOut < 1024));
});

test('#139 /api/state carries usage from the plan, refreshes a stale plan, and omits it otherwise', async () => {
  const state = async (plan) => {
    const provider = createFakeProvider({ FAKE_API_KEY: 'fakekeyvalue-0123456789' }, { plan });
    const get = liveState({ FAKE_API_KEY: 'fakekeyvalue-0123456789' }, { provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'e'), cacheMs: 0 });
    await get(); await planSettled(provider); // the first state starts the background plan read
    return { provider, s: await get() };
  };
  const u = { costUSD: 66.12, allowanceUSD: 16.61, overageUSD: 49.51, ratedUntil: '2026-11-17T10:00:00Z', creditRemainingUSD: 0, periodEnd: 'x' };
  const a = await state(() => ({ fetchedAt: Date.now(), usage: u }));
  assert.deepEqual(a.s.usage, { costUSD: 66.12, allowanceUSD: 16.61, overageUSD: 49.51, ratedUntil: '2026-11-17T10:00:00Z' });
  for (const p of [null, () => ({ fetchedAt: Date.now() }), () => { throw new Error('x'); }, () => ({ fetchedAt: Date.now(), usage: { costUSD: 'n' } })]) assert.ok(!('usage' in (await state(p)).s));
  const st = await state((o) => ({ fetchedAt: o?.refresh ? Date.now() : 0, usage: { costUSD: o?.refresh ? 5 : 1 } }));
  assert.equal(st.s.usage.costUSD, 5);
  assert.equal(st.provider.log.planRefresh, 1);
});

test('#139 review: state() returns at once while plan() hangs, and a failing plan() is read once per 5 minutes', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fakekeyvalue-0123456789' }, { plan: () => new Promise(() => {}) });
  const get = liveState({ FAKE_API_KEY: 'fakekeyvalue-0123456789' }, { provider, file: join(mkdtempSync(join(tmpdir(), 'cc-ev-')), 'e'), cacheMs: 0 });
  const t0 = Date.now();
  assert.ok(!('usage' in await get()) && Date.now() - t0 < 1000);
  let calls = 0;
  const bad = createFakeProvider({}, { plan: () => { calls++; throw new Error('x'); } });
  const t = Date.now();
  for (let i = 0; i < 3; i++) { planSnapshot(bad, t + i); await planSettled(bad); }
  assert.equal(calls, 1);
});

test('#139 page: #summary appends the same sentence as the server formatter when state.usage is present; demo data has usage', async () => {
  const { usageLine } = await import('../src/machine.mjs');
  assert.match(PAGE, /usageSentence\(S\.data && S\.data\.usage\)/);
  const f = new Function(`${pageLine('const usageSentence')}\nreturn usageSentence;`)();
  for (const usage of [{ costUSD: 12.4, allowanceUSD: 20, overageUSD: 0 }, { costUSD: 66.03, allowanceUSD: 16.61, overageUSD: 49.42 }, { costUSD: 3.1, allowanceUSD: 0 }, { costUSD: 0.005, allowanceUSD: 16.666 }]) assert.equal(f(usage), usageLine({ usage }));
  for (const bad of [undefined, null, {}, { costUSD: 'x' }, { costUSD: 3 }, { costUSD: 3, allowanceUSD: '20' }, { costUSD: 3, allowanceUSD: NaN }]) assert.equal(f(bad), null);
  const { demoState } = await import('../src/dashboard-demo.mjs');
  assert.ok(usageLine({ usage: demoState().usage }));
});


// ---- Astra review fixes ----
test('/api/stream parses codex and opencode worker streams with the existing progress parsers', async () => {
  for (const [file, tool, text] of [['codex-json-sample.jsonl', /^Bash/, 'done'], ['opencode-json-sample.jsonl', /^bash/, 'Done.']]) {
    const { dir, opts } = streamEnv([{ id: 'a1', kind: 'agent', status: 'running', turns: 1 }], fakeReader());
    putLocal(dir, 'a1', 1, readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
    const s = await serve(opts);
    try {
      const r = JSON.parse((await get(s.address().port, `/api/stream?box=a1&turn=1&t=${TOKEN}`)).body);
      assert.deepEqual(r.events.filter((e) => e.kind === 'tool_use').map((e) => tool.test(e.name)), [true], file);
      const res = r.events.find((e) => e.kind === 'result');
      assert.equal(res.text, text, file);
      assert.ok(res.usage.input > 0 && res.usage.output > 0, file);
      assert.equal(r.totals.tools, 1, file);
      assert.equal(r.complete, true, file);
    } finally { s.close(); }
  }
});

test('/api/stream redacts a refreshed Codex token that came from a machine and is in no list of known secrets', async () => {
  const raw = readFileSync(new URL('./fixtures/codex-json-sample.jsonl', import.meta.url), 'utf8').replace('"text":"done"', '"text":"new token rt_RefreshedTokenValue1234567890abcdef"');
  const reader = fakeReader({ readTail: async (m, name, from) => ({ data: raw.slice(from), from, next: raw.length, size: raw.length, fetchedAt: 5000 }) });
  const { opts } = streamEnv([{ id: 'b1', kind: 'agent', status: 'running', machine: 'mb', machineState: 'running' }], reader);
  const s = await serve(opts);
  try {
    const body = (await get(s.address().port, `/api/stream?box=b1&turn=1&t=${TOKEN}`)).body;
    assert.match(body, /new token \[redacted\]/);
    assert.ok(!body.includes('RefreshedTokenValue'));
  } finally { s.close(); }
});

test('/api/stream shows a codex answer that follows retry error notices, not a failed turn', async () => {
  const stream = [
    { type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 1/5' }, { type: 'error', message: 'Reconnecting... 2/5' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'all good' } },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const { dir, opts } = streamEnv([{ id: 'a1', kind: 'agent', status: 'running', turns: 1 }], fakeReader());
  putLocal(dir, 'a1', 1, stream);
  const s = await serve(opts);
  try {
    const r = JSON.parse((await get(s.address().port, `/api/stream?box=a1&turn=1&t=${TOKEN}`)).body);
    const res = r.events.find((e) => e.kind === 'result');
    assert.equal(res.text, 'all good');
    assert.notEqual(res.is_error, true);
  } finally { s.close(); }
});
