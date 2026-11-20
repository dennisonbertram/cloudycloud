import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from '../src/shell.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const machines = [
  { id: 'mach-aaa', name: 'box-aaa', state: 'running', status: 'running' },
  { id: 'mach-bbb', name: 'box-bbb', state: 'stopped', status: 'stopped' },
  { id: 'mach-ccc', name: 'my-coord', role: 'coordinator', state: 'running', status: 'running' },
];
const events = [
  { t: 1, id: '7c1e90ab', type: 'agent', description: 'a' },
  { t: 2, id: '7c1e90ab', type: 'machine', machine: 'mach-aaa' },
  { t: 3, id: 'dead0001', type: 'agent', description: 'b' },
  { t: 4, id: 'dead0001', type: 'machine', machine: 'mach-bbb' },
];
const setup = (caps = {}, status = 0) => {
  const out = [], err = [], spawned = [], provider = createFakeProvider();
  Object.assign(provider.caps, caps);
  return { out, err, spawned, d: {
    provider, env: {}, list: async () => machines, events: () => events, alive: () => true,
    spawn: (argv) => { spawned.push(argv); return { status }; },
    out: (s) => out.push(s), err: (s) => err.push(s),
  } };
};

test('--help prints usage with where the id comes from and exits 0', async () => {
  const out = [], err = [];
  const log = console.log; console.log = (m) => out.push(m);
  try { assert.equal(await run(['--help'], { err: (m) => err.push(m), env: {} }), 0); } finally { console.log = log; }
  assert.match(out.join('\n'), /Usage: cloudy-cloud shell[\s\S]*cloud_agent_list/);
  assert.deepEqual(err, []);
});

test('parseArgs splits the target from the command at --', () => {
  assert.deepEqual(parseArgs(['x']), { id: 'x', cmd: undefined });
  assert.deepEqual(parseArgs(['x', '--']), { id: 'x', cmd: undefined });
  assert.deepEqual(parseArgs(['x', '--', 'ls', '-la']), { id: 'x', cmd: ['ls', '-la'] });
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['a;rm']), /characters/);
  assert.throws(() => parseArgs(['x', 'ls']), /Usage/);
  assert.throws(() => parseArgs(['x', '--flag']), /Unknown option/);
});

test('resolves an agent id and a machine name; passes argv through unchanged', async () => {
  const cmd = ['sh', '-c', 'echo "a b"; echo \'c\'', 'it\'s $HOME'];
  const a = setup();
  assert.equal(await run(['7c1e90ab', '--', ...cmd], a.d), 0);
  assert.deepEqual(a.spawned, [['fake-ssh', 'mach-aaa', ...cmd]]);
  const b = setup();
  await run(['my-coord', '--', 'ls'], b.d);
  assert.deepEqual(b.spawned, [['fake-ssh', 'mach-ccc', 'ls']]);
});

test('no command opens an interactive shell', async () => {
  const s = setup(); s.d.isTTY = true;
  assert.equal(await run(['box-aaa'], s.d), 0);
  assert.deepEqual(s.spawned, [['fake-ssh', 'mach-aaa']]);
});

test('exit code of the remote command is returned', async () => {
  const s = setup({}, 7);
  assert.equal(await run(['7c1e90ab', '--', 'false'], s.d), 7);
  const k = setup(); k.d.spawn = () => ({ status: null, signal: 'SIGTERM' });
  assert.equal(await run(['7c1e90ab', '--', 'x'], k.d), 143);
});

test('provider without a shell is refused with shell_unsupported', async () => {
  const s = setup({ hasShell: false });
  assert.equal(await run(['7c1e90ab', '--', 'ls'], s.d), 1);
  assert.equal(s.spawned.length, 0);
  assert.match(s.err.join('\n'), /has no shell for this machine/);
});

test('unknown target and stopped machine give clear errors', async () => {
  const u = setup();
  assert.equal(await run(['nope'], u.d), 1);
  assert.match(u.err.join('\n'), /Unknown id "nope".*7c1e90ab/s);
  const n = setup();
  assert.equal(await run(['dead0001', '--', 'ls'], n.d), 1);
  assert.match(n.err.join('\n'), /is not running/);
  assert.match(n.err.join('\n'), /cloud_agent_list/);
  assert.equal(n.spawned.length, 0);
});

test('no command without a TTY is refused', async () => {
  const s = setup(); s.d.isTTY = false;
  assert.equal(await run(['box-aaa'], s.d), 1);
  assert.match(s.err.join('\n'), /needs a terminal.*-- <command>/s);
  assert.equal(s.spawned.length, 0);
});

test('any signal maps to 128 + its number', async () => {
  const s = setup(); s.d.spawn = () => ({ status: null, signal: 'SIGALRM' });
  assert.equal(await run(['7c1e90ab', '--', 'x'], s.d), 142);
});

test('the shell child gets the provider env (same account as the SDK), never in argv', async () => {
  const s = setup();
  s.d.provider.shellEnv = () => ({ FAKE_API_KEY: 'k-secret' });
  let opts;
  s.d.spawn = (argv, o) => { s.spawned.push(argv); opts = o; return { status: 0 }; };
  await run(['mach-aaa', '--', 'ls'], s.d);
  assert.equal(opts.env.FAKE_API_KEY, 'k-secret');
  assert.ok(!JSON.stringify(s.spawned).includes('k-secret'));
});

test('a failed shell spawn names the binary to install; doctor is a self-hosted answer only', async () => {
  const s = setup(); s.d.spawn = () => ({ error: new Error('spawn fake-ssh ENOENT') });
  assert.equal(await run(['box-aaa', '--', 'ls'], s.d), 1);
  assert.match(s.err.join('\n'), /Could not start fake-ssh.*Install fake-ssh first\./s);
  assert.doesNotMatch(s.err.join('\n'), /doctor/);
  const h = setup(); h.d.provider.name = 'self-hosted'; h.d.spawn = () => ({ error: new Error('spawn ssh ENOENT') });
  assert.equal(await run(['box-aaa', '--', 'ls'], h.d), 1);
  assert.match(h.err.join('\n'), /cloudy-cloud doctor/);
});
