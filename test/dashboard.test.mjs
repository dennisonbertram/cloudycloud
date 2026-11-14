import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildState, createHandler, listen, liveState, listMachines } from '../src/dashboard.mjs';
import { createEventLog, foldAgents, pushOf, readEvents, redact } from '../src/events.mjs';
import { demoState, demoStream } from '../src/dashboard-demo.mjs';
import { createFakeProvider } from './fake-provider.mjs';
import { createMachineReader } from '../src/machine-read.mjs';

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
