import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { activityText, coordinatorRows, createCoordinatorPoller, follow, readActivity, statuslineText, stepFor, watchMain, workerRows } from '../src/activity.mjs';
import { normalise } from '../src/stream.mjs';
import { createEventLog } from '../src/events.mjs';
import { createHandler, listen, withActivity } from '../src/dashboard.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cc-act-'));
const NOW = 1_700_000_000_000;
const ev = (id, t, o) => ({ id, t, pid: 1, ...o });
const events = [
  ev('aaaa1111', NOW - 600_000, { type: 'agent', description: 'fix parser', profile: 'claude', role: 'worker' }),
  ev('aaaa1111', NOW - 590_000, { type: 'status', status: 'running' }),
  ev('aaaa1111', NOW - 100_000, { type: 'progress', text: 'Edit src/parser.ts' }),
  ev('aaaa1111', NOW - 20_000, { type: 'progress', text: 'Bash npm test' }),
  ev('bbbb2222', NOW - 60_000, { type: 'agent', description: 'old job', role: 'worker' }),
  ev('bbbb2222', NOW - 50_000, { type: 'status', status: 'stopped' }),
];
const alive = () => true;

test('worker rows come from progress events; stopped agents are left out', () => {
  const rows = workerRows(events, { alive, now: NOW });
  assert.equal(rows.length, 1);
  assert.deepEqual({ id: rows[0].id, state: rows[0].state, step: rows[0].step, t: rows[0].t }, { id: 'aaaa1111', state: 'working', step: 'Bash npm test', t: NOW - 20_000 });
  assert.deepEqual(rows[0].steps.map((s) => s.step), ['Edit src/parser.ts', 'Bash npm test']);
  assert.equal(rows[0].quietMin, undefined);
});

test('a working agent with no step for 5 minutes is quiet; an idle one is not', () => {
  const quiet = workerRows(events, { alive, now: NOW + 6 * 60_000 })[0];
  assert.equal(quiet.quietMin, 6);
  const idle = workerRows([...events, ev('aaaa1111', NOW, { type: 'status', status: 'idle' })], { alive, now: NOW + 9 * 60_000 })[0];
  assert.equal(idle.state, 'idle');
  assert.equal(idle.quietMin, undefined);
});

test('readActivity reads the event log written by createEventLog, redacted', () => {
  const dir = tmp(), file = join(dir, 'events.jsonl'), env = { CLOUDY_CLOUD_EVENTS: file, CLOUDY_CLOUD_ACTIVITY: join(dir, 'act') };
  const emit = createEventLog(env, 'o', { file, now: () => NOW });
  emit({ id: 'cccc3333', type: 'agent', description: 'd' });
  emit({ id: 'cccc3333', type: 'status', status: 'running' });
  emit({ id: 'cccc3333', type: 'progress', text: 'Bash export API_KEY=supersecretvalue123' });
  const rows = readActivity({ env, now: NOW + 1000, alive });
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /supersecretvalue123/);
  assert.equal(readActivity({ env: { CLOUDY_CLOUD_EVENTS: join(dir, 'missing'), CLOUDY_CLOUD_ACTIVITY: join(dir, 'none') } }).length, 0);
});

test('stepFor turns normalised session lines into steps', () => {
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  assert.deepEqual(normalise(lines, { harness: 'claude' }).map(stepFor).filter(Boolean), ['thinking', 'Edit src/a.ts', 'Bash npm test']);
});

// A fake coordinator machine: a transcript file the poller reads through files.read, a pane, and a listing.
function fakeMachine({ install = 'abcdef0123456789', transcript = '', pane = 'esc to interrupt' } = {}) {
  const state = { transcript, pane, reads: 0, cmds: [], connects: 0 };
  const m = { id: 'm1', provider: undefined, state: 'running', labels: { purpose: 'cloudy-cloud', role: 'coordinator', name: 'boss', install } };
  const sbx = {
    commands: { run: async (cmd) => { state.cmds.push(cmd); return { stdout: cmd.startsWith('ls ') ? '/home/user/.claude/projects/-home-user-repo/s1.jsonl\n' : state.pane }; } },
    files: { read: async (p) => { state.reads++; assert.match(p, /s1\.jsonl$/); return Buffer.from(state.transcript); } },
  };
  const provider = { name: 'fake', keyName: 'K', list: async () => [m], connect: async () => { state.connects++; return sbx; } };
  return { state, provider, m };
}
const asst = (id, name, input) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })}\n`;
const ENV = (dir) => ({ CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_INSTALL_ID: 'abcdef0123456789', CLOUDY_CLOUD_ACTIVITY: join(dir, 'act') });

test('coordinator poller caches steps, reads only new bytes, redacts, and records the pane state', async () => {
  const dir = tmp(), env = ENV(dir);
  const f = fakeMachine({ transcript: asst('t1', 'Edit', { file_path: 'a.ts' }) });
  let t = NOW;
  const poller = createCoordinatorPoller({ provider: f.provider, env, now: () => t, scrub: (s) => s.split('EXACTSECRET99').join('[redacted]') });
  await poller.poll();
  f.state.transcript += asst('t2', 'Bash', { command: 'echo ghp_abcdefghijklmnop EXACTSECRET99' });
  t += 10_000;
  await poller.poll();
  await poller.poll(); // nothing new: no duplicate lines
  const file = join(env.CLOUDY_CLOUD_ACTIVITY, 'boss.jsonl'), text = readFileSync(file, 'utf8');
  const steps = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.step).map((l) => l.step);
  assert.deepEqual(steps.map((s) => s.slice(0, 9)), ['Edit a.ts', 'Bash echo']);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnop|EXACTSECRET99/);
  assert.equal(f.state.connects, 1);
  const row = coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, t + 1000)[0];
  assert.equal(row.state, 'working');
  assert.equal(row.name, 'boss');
  assert.match(row.step, /^Bash echo/);
  assert.deepEqual(coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, t + 10 * 60_000), []); // poller stopped: the coordinator is not shown as live
});

test('coordinator poller converts only the new bytes of the transcript', async () => {
  const dir = tmp(), env = ENV(dir);
  const f = fakeMachine({ transcript: asst('t1', 'Edit', { file_path: 'a.ts' }) });
  const poller = createCoordinatorPoller({ provider: f.provider, env, now: () => NOW });
  await poller.poll();
  const first = readFileSync(join(env.CLOUDY_CLOUD_ACTIVITY, 'boss.jsonl'), 'utf8').split('\n').filter((l) => JSON.parse(l || '{}').step).length;
  f.state.transcript += asst('t2', 'Read', { file_path: 'b.ts' }) + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","na'; // unfinished line
  await poller.poll();
  f.state.transcript = f.state.transcript.replace(/\{"type":"assistant","message":\{"content":\[\{"type":"tool_use","id":"t3","na$/, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'x' } }] } })}\n`);
  await poller.poll();
  const all = readFileSync(join(env.CLOUDY_CLOUD_ACTIVITY, 'boss.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.step).map((l) => l.step);
  assert.equal(first, 1);
  assert.deepEqual(all, ['Edit a.ts', 'Read b.ts', 'Grep x']);
});

test('coordinator poller shows pane signals and skips machines of another installation', async () => {
  const dir = tmp(), env = ENV(dir);
  const mine = fakeMachine({ pane: 'Select login method:\n1. Claude account' });
  await createCoordinatorPoller({ provider: mine.provider, env, now: () => NOW }).poll();
  const row = coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, NOW)[0];
  assert.equal(row.state, 'waiting for sign-in');
  assert.equal(row.step, 'waiting for sign-in');
  const other = fakeMachine({ install: '0000000000000000' }), dir2 = tmp();
  await createCoordinatorPoller({ provider: other.provider, env: ENV(dir2), now: () => NOW }).poll();
  assert.equal(other.state.connects, 0);
  assert.deepEqual(coordinatorRows(join(dir2, 'act'), NOW), []);
});

test('statusline: nothing for no agents, a short line for several, quiet warning', () => {
  assert.equal(statuslineText([], NOW), '');
  const rows = [
    { id: 'a', name: 'boss', kind: 'coordinator', state: 'working', step: 'Bash npm test', t: NOW - 12_000, steps: [] },
    { id: 'b', name: 'w2', kind: 'worker', state: 'working', step: 'thinking', t: NOW - 90_000, steps: [] },
    { id: 'c', name: 'w3', kind: 'worker', state: 'idle', step: '', t: NOW - 5000, steps: [] },
  ];
  assert.equal(statuslineText(rows, NOW), '☁ 2 working · boss: Bash npm test · 12s ago');
  assert.equal(statuslineText([rows[2]], NOW), '☁ 1 idle · w3: idle · 5s ago');
  assert.match(statuslineText([{ ...rows[1], quietMin: 7 }], NOW), /quiet 7m: w2$/);
});

test('statusline command prints nothing when files are missing and is fast', () => {
  const dir = tmp();
  const t0 = Date.now();
  const r = spawnSync('node', ['src/activity.mjs', 'statusline'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, CLOUDY_CLOUD_EVENTS: join(dir, 'x'), CLOUDY_CLOUD_ACTIVITY: join(dir, 'y') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '\n');
  assert.ok(Date.now() - t0 < 1500, 'sanity bound; the real target is 100 ms of runtime');
});

test('follow prints each new step once, then state changes and the quiet warning, and stops on abort', async () => {
  let step = 0;
  const frames = [
    [{ id: 'a1', name: 'w', kind: 'worker', state: 'working', step: 'one', t: NOW, steps: [{ t: NOW - 1000, step: 'zero' }, { t: NOW, step: 'one' }] }],
    [{ id: 'a1', name: 'w', kind: 'worker', state: 'working', step: 'one', t: NOW, steps: [{ t: NOW - 1000, step: 'zero' }, { t: NOW, step: 'one' }] }],
    [{ id: 'a1', name: 'w', kind: 'worker', state: 'working', step: 'two', t: NOW + 1000, steps: [{ t: NOW, step: 'one' }, { t: NOW + 1000, step: 'two' }] }],
    [{ id: 'a1', name: 'w', kind: 'worker', state: 'idle', quietMin: 6, step: 'two', t: NOW + 1000, steps: [{ t: NOW + 1000, step: 'two' }] }],
  ];
  const ac = new AbortController(), out = [];
  const sleep = async () => { if (++step >= frames.length) ac.abort(); };
  await follow({ read: () => frames[Math.min(step, frames.length - 1)], out: (s) => out.push(s), sleep, signal: ac.signal, now: () => NOW + 2000 });
  const lines = out.join('').trim().split('\n').map((l) => l.slice(9));
  assert.deepEqual(lines, ['w (a1) one', 'w (a1) two', 'w (a1) state: idle', 'w (a1) quiet for 6 min']);
  const json = [];
  const ac3 = new AbortController();
  await follow({ read: () => frames[0], out: (s) => json.push(JSON.parse(s)), json: true, sleep: async () => ac3.abort(), signal: ac3.signal });
  assert.deepEqual(json.map((j) => [j.name, j.step, j.state]), [['w', 'one', 'working']]);
});

test('follow filters by name or id', async () => {
  const rows = ['a', 'b'].map((n) => ({ id: `${n}0000000`, name: n, kind: 'worker', state: 'working', step: 's', t: NOW, steps: [{ t: NOW, step: `step ${n}` }] }));
  const ac = new AbortController(), out = [];
  await follow({ read: () => rows, out: (s) => out.push(s), filter: 'b', sleep: async () => ac.abort(), signal: ac.signal });
  assert.equal(out.length, 1);
  assert.match(out[0], /step b/);
});

test('watch exits cleanly on SIGINT and rejects bad arguments', async () => {
  const dir = tmp(), file = join(dir, 'events.jsonl'), env = { CLOUDY_CLOUD_EVENTS: file, CLOUDY_CLOUD_ACTIVITY: join(dir, 'act') };
  const emit = createEventLog(env, 'o', { file, now: Date.now });
  emit({ id: 'dddd4444', type: 'agent', description: 'job' });
  emit({ id: 'dddd4444', type: 'status', status: 'running' });
  emit({ id: 'dddd4444', type: 'progress', text: 'Read a.ts' });
  const out = [], err = [];
  let n = 0;
  const done = watchMain([], { env, out: (s) => out.push(s), err: (s) => err.push(s), intervalMs: 1, getProvider: async () => { throw new Error('no provider'); },
    sleep: async () => { if (++n === 2) process.emit('SIGINT'); await new Promise((r) => setTimeout(r, 1)); } });
  assert.equal(await done, 0);
  assert.equal(out.filter((l) => l.includes('Read a.ts')).length, 1);
  assert.equal(await watchMain(['--bogus'], { env, err: (s) => err.push(s) }), 2);
  assert.match(err.join(''), /Usage: cloudy-cloud watch/);
});

test('dashboard state carries the activity rows', async () => {
  const rows = workerRows(events, { alive, now: NOW });
  const s = await listen(createHandler({ token: 't', html: '<html></html>', getState: withActivity(async () => ({ boxes: [] }), () => rows) }), 0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/state?t=t`);
    const j = await r.json();
    assert.equal(j.activity[0].step, 'Bash npm test');
    assert.equal(j.activity[0].state, 'working');
    assert.ok(j.activity[0].t);
  } finally { s.close(); }
});

test('cloud_agent_activity is listed read-only and returns state and steps, filtered by name', async () => {
  const dir = tmp(), file = join(dir, 'events.jsonl'), env = { CLOUDY_CLOUD_EVENTS: file, CLOUDY_CLOUD_ACTIVITY: join(dir, 'act') };
  const emit = createEventLog(env, 'o', { file });
  for (const [id, d] of [['eeee5555', 'alpha'], ['ffff6666', 'beta']]) {
    emit({ id, type: 'agent', description: d, role: 'worker' });
    emit({ id, type: 'status', status: 'running' });
    emit({ id, type: 'progress', text: `Edit ${d}.ts` });
  }
  const ENTRY = new URL('../support/server-entry.mjs', import.meta.url).pathname;
  const child = spawn('node', [ENTRY], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const pending = new Map();
  let id = 0, buf = '';
  child.stdout.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls.filter(Boolean)) { const m = JSON.parse(l); pending.get(m.id)?.(m); } });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'activity-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const rpc = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params: { ...params, _meta: meta } })}\n`); });
  try {
    await rpc('server/discover');
    const list = (await rpc('tools/list')).result.tools.find((t) => t.name === 'cloud_agent_activity');
    assert.equal(list.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(list.inputSchema.properties), ['agent']);
    assert.ok(list.outputSchema.properties.agents);
    const call = async (args) => (await rpc('tools/call', { name: 'cloud_agent_activity', arguments: args })).result;
    const all = await call({});
    assert.equal(all.structuredContent.agents.length, 2);
    const one = await call({ agent: 'alpha' });
    assert.equal(one.structuredContent.agents.length, 1);
    assert.match(one.content[0].text, /alpha \(eeee5555, worker\) working\n {2}\d\d:\d\d:\d\d Edit alpha\.ts/);
  } finally { child.kill(); }
  assert.equal(activityText([]), 'No running cloud agents.');
});
