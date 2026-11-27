import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
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
  assert.deepEqual(normalise(lines, { harness: 'claude' }).map((e) => stepFor(e)).filter(Boolean), ['thinking', 'Edit src/a.ts', 'Bash npm']);
});

// A fake coordinator machine. The transcript is read with the shell command the poller sends (no whole-file read): the fake
// answers it like `wc`, `tail -c +N` and `head -c` would, and counts the bytes it hands back.
const SID = '11111111-2222-3333-4444-555555555555', OTHER_SID = '99999999-8888-7777-6666-555555555555';
function fakeMachine({ install = 'abcdef0123456789', transcript = '', pane = 'esc to interrupt', id = 'm1', provider: prov, name = 'boss', transcripts } = {}) {
  const state = { transcript, pane, bytes: 0, cmds: [], connects: 0, paths: [] };
  const m = { id, provider: prov, state: 'running', labels: { purpose: 'cloudy-cloud', role: 'coordinator', name, install } };
  const files = transcripts ?? { [SID]: () => state.transcript };
  const run = async (cmd) => {
    state.cmds.push(cmd);
    if (cmd.startsWith('p=$(tmux')) return { stdout: `PANE 100\n100 1\n200 100\n300 1\nSESSIONS\n${JSON.stringify({ pid: 200, sessionId: SID, startedAt: 1 })}\n${JSON.stringify({ pid: 300, sessionId: OTHER_SID, startedAt: 2 })}\n` };
    if (cmd.startsWith('ls ')) { const sid = /([0-9a-f-]{36})\.jsonl/.exec(cmd)[1]; return { stdout: `/home/user/.claude/projects/-home-user-repo/${sid}.jsonl\n` }; }
    if (cmd.startsWith('f=')) {
      const path = /^f='([^']+)'/.exec(cmd)[1]; state.paths.push(path);
      const buf = Buffer.from(files[/([0-9a-f-]{36})\.jsonl/.exec(path)[1]]());
      const arg = /o=(\S+);/.exec(cmd)[1], o = arg === '-' ? Math.max(0, buf.length - 262144) : Number(arg);
      const data = buf.length > o ? buf.subarray(o, o + 1048576).toString('base64') : '';
      state.bytes += data.length;
      return { stdout: `${buf.length} ${o}\n${data}\n` };
    }
    return { stdout: state.pane };
  };
  const sbx = { commands: { run }, files: { read: async () => assert.fail('the whole transcript must not be downloaded') } };
  const provider = { name: 'fake', keyName: 'K', list: async () => [m], connect: async () => { state.connects++; return sbx; } };
  return { state, provider, m };
}
const asst = (id, name, input) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })}\n`;
const INSTALL = 'abcdef0123456789';
const ENV = (dir) => ({ CLOUDY_CLOUD_CONFIG: join(dir, 'env'), CLOUDY_CLOUD_INSTALL_ID: INSTALL, CLOUDY_CLOUD_ACTIVITY: join(dir, 'act') });
const snaps = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

test('coordinator poller caches steps, reads only new bytes, scrubs, and records the pane state', async () => {
  const dir = tmp(), env = ENV(dir);
  const f = fakeMachine({ transcript: asst('t1', 'Edit', { file_path: 'a.ts' }) });
  let t = NOW;
  const poller = createCoordinatorPoller({ provider: f.provider, env, now: () => t, scrub: (s) => s.split('EXACTSECRET99').join('[redacted]') });
  await poller.poll();
  f.state.transcript += asst('t2', 'Bash', { command: 'echo ghp_abcdefghijklmnop EXACTSECRET99' });
  t += 10_000;
  const before = f.state.bytes;
  await poller.poll();
  const grew = f.state.bytes - before;
  await poller.poll(); // nothing new: no duplicate steps, and no bytes read
  assert.equal(f.state.bytes - before, grew);
  const text = readdirSync(env.CLOUDY_CLOUD_ACTIVITY).map((n) => readFileSync(join(env.CLOUDY_CLOUD_ACTIVITY, n), 'utf8')).join('');
  assert.deepEqual(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.map((s) => s.step), ['Edit a.ts', 'Bash echo']);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnop|EXACTSECRET99/);
  assert.equal(f.state.connects, 1);
  const row = coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, t + 1000, INSTALL)[0];
  assert.equal(row.state, 'working');
  assert.equal(row.name, 'boss');
  assert.equal(row.id, 'm1');
  assert.equal(row.step, 'Bash echo');
  assert.deepEqual(coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, t + 10 * 60_000, INSTALL), []); // poller stopped: the coordinator is not shown as live
});

test('steps keep only an allowlisted summary: a secret in a Bash argument, a URL, a path or a search never reaches the cache', async () => {
  const dir = tmp(), env = ENV(dir);
  const longPath = `${'d/'.repeat(48)}EXACTSECRET99/x.ts`; // the secret straddles the 100 character cut
  const f = fakeMachine({ transcript: [
    asst('b1', 'Bash', { command: 'curl https://user:Zx9pQw2LmNb@example.com/x -H "Authorization: Q8wErTy7UiOp"' }),
    asst('b2', 'Bash', { command: 'FOO=hunter2hunter2 deploy --password opaquePass123 EXACTSECRET99' }),
    asst('b3', 'Read', { file_path: longPath }),
    asst('b4', 'WebFetch', { url: 'https://u:pw99@host/x?token=abcdef123456', prompt: 'p' }),
    asst('b5', 'Grep', { pattern: 'opaquePass123' }),
  ].join('') });
  await createCoordinatorPoller({ provider: f.provider, env, now: () => NOW, scrub: (s) => s.split('EXACTSECRET99').join('[redacted]') }).poll();
  const raw = readdirSync(env.CLOUDY_CLOUD_ACTIVITY).map((n) => readFileSync(join(env.CLOUDY_CLOUD_ACTIVITY, n), 'utf8')).join('');
  assert.doesNotMatch(raw, /Zx9pQw2LmNb|Q8wErTy7UiOp|hunter2|opaquePass123|EXACTSEC|ACTSECRET|pw99|abcdef123456/);
  const steps = snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.map((s) => s.step);
  assert.deepEqual([steps[0], steps[1], steps[3], steps[4]], ['Bash curl', 'Bash deploy', 'WebFetch', 'Grep']);
  assert.match(steps[2], /^Read (d\/)+/);
});

test('the transcript is read as a bounded tail first, then from the saved offset, and never when the file did not grow', async () => {
  const dir = tmp(), env = ENV(dir);
  const line = (i) => asst(`t${i}`, 'Edit', { file_path: `f${i}.ts`, pad: 'x'.repeat(1000) });
  const f = fakeMachine({ transcript: Array.from({ length: 1500 }, (_, i) => line(i)).join('') }); // about 1.5 MB
  const poller = createCoordinatorPoller({ provider: f.provider, env, now: () => NOW });
  await poller.poll();
  assert.ok(f.state.bytes < 400_000, `first read is a tail, got ${f.state.bytes} base64 characters`);
  const snap = snaps(env.CLOUDY_CLOUD_ACTIVITY)[0];
  assert.equal(snap.steps.length, 50);
  assert.equal(snap.steps.at(-1).step, 'Edit f1499.ts');
  assert.match(snap.steps[0].step, /^Edit f\d+\.ts$/); // the cut first line was dropped, so no fragment became a step
  const after = f.state.bytes;
  await poller.poll();
  assert.equal(f.state.bytes, after);
  f.state.transcript += line(1500);
  await poller.poll();
  assert.ok(f.state.bytes - after < 2000);
  assert.equal(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.at(-1).step, 'Edit f1500.ts');
  assert.equal(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.length, 50); // the snapshot stays bounded
});

test('coordinator poller converts only the new bytes of the transcript', async () => {
  const dir = tmp(), env = ENV(dir);
  const f = fakeMachine({ transcript: asst('t1', 'Edit', { file_path: 'a.ts' }) });
  const poller = createCoordinatorPoller({ provider: f.provider, env, now: () => NOW });
  await poller.poll();
  f.state.transcript += asst('t2', 'Read', { file_path: 'b.ts' }) + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","na'; // unfinished line
  await poller.poll();
  f.state.transcript = f.state.transcript.replace(/\{"type":"assistant","message":\{"content":\[\{"type":"tool_use","id":"t3","na$/, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'x' } }] } })}\n`);
  await poller.poll();
  assert.deepEqual(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.map((s) => s.step), ['Edit a.ts', 'Read b.ts', 'Grep']);
  assert.deepEqual(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.map((s) => s.n), [1, 2, 3]);
});

test('the transcript is the one of the session in the claude pane, not the newest file', async () => {
  const dir = tmp(), env = ENV(dir);
  const f = fakeMachine({ transcripts: { [SID]: () => asst('a', 'Edit', { file_path: 'mine.ts' }), [OTHER_SID]: () => asst('b', 'Edit', { file_path: 'other.ts' }) } });
  await createCoordinatorPoller({ provider: f.provider, env, now: () => NOW }).poll();
  assert.deepEqual(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.map((s) => s.step), ['Edit mine.ts']);
  assert.ok(f.state.paths.every((p) => p.includes(SID)));
  assert.ok(f.state.cmds.every((c) => !/ls -t/.test(c)));
});

test('snapshots are keyed by installation, provider and machine id: same names do not collide, other installations are not shown', async () => {
  const dir = tmp(), env = ENV(dir);
  const a = fakeMachine({ id: 'ma', provider: 'p1', transcript: asst('a', 'Edit', { file_path: 'a.ts' }) }), b = fakeMachine({ id: 'mb', provider: 'p2', transcript: asst('b', 'Edit', { file_path: 'b.ts' }) });
  const both = { name: 'multi', providers: [a.provider, b.provider], list: async () => [a.m, b.m], for: (m) => (m.id === 'ma' ? a : b).provider };
  await createCoordinatorPoller({ provider: both, env, now: () => NOW }).poll();
  const rows = coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, NOW, INSTALL);
  assert.deepEqual(rows.map((r) => [r.id, r.name]).sort(), [['ma', 'boss'], ['mb', 'boss']]);
  assert.deepEqual(coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, NOW, '0000000000000000'), []);
  assert.deepEqual(readActivity({ env: { ...env, CLOUDY_CLOUD_INSTALL_ID: '1111111111111111' }, events: [], now: NOW }), []);
  const j = snaps(env.CLOUDY_CLOUD_ACTIVITY).map((x) => [x.install, x.provider, x.machine]).sort();
  assert.deepEqual(j, [[INSTALL, 'p1', 'ma'], [INSTALL, 'p2', 'mb']]);
});

test('coordinator poller shows pane signals and skips machines of another installation', async () => {
  const dir = tmp(), env = ENV(dir);
  const mine = fakeMachine({ pane: 'Select login method:\n1. Claude account' });
  await createCoordinatorPoller({ provider: mine.provider, env, now: () => NOW }).poll();
  const row = coordinatorRows(env.CLOUDY_CLOUD_ACTIVITY, NOW, INSTALL)[0];
  assert.equal(row.state, 'waiting for sign-in');
  assert.equal(row.step, 'waiting for sign-in');
  const other = fakeMachine({ install: '0000000000000000' }), dir2 = tmp();
  await createCoordinatorPoller({ provider: other.provider, env: ENV(dir2), now: () => NOW }).poll();
  assert.equal(other.state.connects, 0);
  assert.deepEqual(coordinatorRows(join(dir2, 'act'), NOW, INSTALL), []);
});

test('polls are serialized, bounded and cancellable; two processes never write one machine at once', async () => {
  const dir = tmp(), env = ENV(dir);
  const f = fakeMachine({ transcript: asst('t1', 'Edit', { file_path: 'a.ts' }) });
  let lists = 0, release;
  const gate = new Promise((r) => { release = r; });
  const slow = { ...f.provider, list: async () => { lists++; await gate; return [f.m]; } };
  const poller = createCoordinatorPoller({ provider: slow, env, now: () => NOW });
  const p1 = poller.poll(), p2 = poller.poll();
  assert.equal(p1, p2);
  release();
  await p1;
  assert.equal(lists, 1);
  // a second poller on the same directory while the first holds the machine's lock: it skips, so no step is written twice
  const f2 = fakeMachine({ transcript: asst('t1', 'Edit', { file_path: 'a.ts' }) });
  const x = createCoordinatorPoller({ provider: f2.provider, env, now: () => NOW }), y = createCoordinatorPoller({ provider: f2.provider, env, now: () => NOW });
  await Promise.all([x.poll(), y.poll()]);
  assert.equal(f2.state.connects, 1);
  assert.deepEqual(snaps(env.CLOUDY_CLOUD_ACTIVITY)[0].steps.map((s) => s.step), ['Edit a.ts']);
  // stop() settles a poll that is stuck in a provider call
  const hang = createCoordinatorPoller({ provider: { ...f.provider, list: () => new Promise(() => {}) }, env, now: () => NOW });
  const stuck = hang.poll().then(() => 'done', () => 'stopped');
  hang.stop();
  assert.equal(await stuck, 'stopped');
  // at most 3 machines are read at once
  let live = 0, peak = 0;
  const ms = Array.from({ length: 7 }, (_, i) => ({ ...f.m, id: `mm${i}` }));
  const wide = { ...f.provider, list: async () => ms, connect: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; throw new Error('x'); } };
  await createCoordinatorPoller({ provider: wide, env: ENV(tmp()), now: () => NOW }).poll();
  assert.ok(peak >= 2 && peak <= 3, `peak ${peak}`);
});

test('polling never creates the config folder: no install id yet, or no config folder, means nothing to do', async () => {
  const dir = tmp(), f = fakeMachine();
  const noId = { CLOUDY_CLOUD_CONFIG: join(dir, 'cfg/env'), CLOUDY_CLOUD_ACTIVITY: join(dir, 'cfg/activity') };
  await createCoordinatorPoller({ provider: f.provider, env: noId, now: () => NOW }).poll();
  assert.equal(existsSync(join(dir, 'cfg')), false);
  await createCoordinatorPoller({ provider: f.provider, env: { ...noId, CLOUDY_CLOUD_INSTALL_ID: INSTALL }, now: () => NOW }).poll();
  assert.equal(existsSync(join(dir, 'cfg')), false);
  assert.equal(f.state.connects, 0);
});

test('a running worker keeps its name and role after its agent event falls out of the log tail', () => {
  const dir = tmp(), env = { CLOUDY_CLOUD_ACTIVITY: join(dir, 'act') };
  mkdirSync(env.CLOUDY_CLOUD_ACTIVITY);
  const all = [ev('wwww9999', NOW - 3_000_000, { type: 'agent', description: 'long job', role: 'worker' }), ev('wwww9999', NOW - 2_990_000, { type: 'status', status: 'running' })];
  readActivity({ env, events: all, alive, now: NOW - 100_000 }); // seen while its agent event was still in the tail
  const tail = [ev('wwww9999', NOW - 10_000, { type: 'status', status: 'running' }), ev('wwww9999', NOW - 5_000, { type: 'progress', text: 'Edit x.ts' })];
  assert.deepEqual(readActivity({ env, events: tail, alive, now: NOW }).map((r) => [r.name, r.state, r.step]), [['long job', 'working', 'Edit x.ts']]);
});

test('statusline: nothing for no agents, a short line for several, quiet warning', () => {
  assert.equal(statuslineText([], NOW), '');
  const rows = [
    { id: 'a', name: 'boss', kind: 'coordinator', state: 'working', step: 'Bash npm test', t: NOW - 12_000, steps: [] },
    { id: 'b', name: 'w2', kind: 'worker', state: 'working', step: 'thinking', t: NOW - 90_000, steps: [] },
    { id: 'c', name: 'w3', kind: 'worker', state: 'idle', step: '', t: NOW - 5000, steps: [] },
  ];
  assert.equal(statuslineText(rows, NOW), '☁ 2 working, 1 idle · boss: Bash npm test · 12s ago');
  assert.equal(statuslineText([rows[2]], NOW), '☁ 1 idle · w3: idle · 5s ago');
  assert.match(statuslineText([{ ...rows[1], quietMin: 7 }], NOW), /quiet 7m: w2$/);
  assert.equal(statuslineText([{ ...rows[0], state: 'blocked', step: 'Credit balance is too low' }], NOW), '☁ 1 blocked · boss: Credit balance is too low · 12s ago');
  assert.equal(statuslineText([{ ...rows[0], state: 'waiting for sign-in', step: 'waiting for sign-in' }, rows[1]], NOW), '☁ 1 working, 1 waiting for sign-in · w2: thinking · 1m ago');
  const hostile = statuslineText([{ ...rows[0], name: 'a\x1b[2Jb\nc', step: 'Edit \x1b]0;x\x07f\r\ng' }], NOW);
  assert.doesNotMatch(hostile, /[\x00-\x1f]/);
});

test('follow shows a burst of steps and equal timestamps, and the state of an agent that has no step yet; terminal text is made safe', async () => {
  const mk = (n, t = NOW) => Array.from({ length: n }, (_, i) => ({ n: i + 1, t, step: `s${i + 1}` }));
  const frames = [
    [{ id: 'c1', name: 'boss', kind: 'coordinator', state: 'waiting for sign-in', step: 'waiting for sign-in', t: NOW, steps: [] }, { id: 'w1', name: 'w', kind: 'worker', state: 'working', step: 's1', t: NOW, steps: mk(1) }],
    [{ id: 'c1', name: 'boss', kind: 'coordinator', state: 'waiting for sign-in', step: 'waiting for sign-in', t: NOW, steps: [] }, { id: 'w1', name: 'w\x1b[31m\nx', kind: 'worker', state: 'working', step: 's12', t: NOW, steps: mk(12) }],
  ];
  let i = 0;
  const ac = new AbortController(), out = [];
  await follow({ read: () => frames[Math.min(i, 1)], out: (s) => out.push(s), sleep: async () => { if (++i >= 2) ac.abort(); }, signal: ac.signal, now: () => NOW });
  const lines = out.join('').trim().split('\n').map((l) => l.slice(9));
  assert.deepEqual(lines, ['boss (c1) waiting for sign-in', 'w (w1) s1', ...Array.from({ length: 11 }, (_, k) => `w x (w1) s${k + 2}`)].map((l) => l));
  assert.ok(out.every((l) => !/\x1b/.test(l) && l.split('\n').length === 2));
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
