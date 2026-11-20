import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, run } from '../src/display.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const machines = [
  { id: 'mach-aaa', name: 'box-aaa', state: 'running', status: 'running' },
  { id: 'mach-bbb', name: 'box-bbb', state: 'stopped', status: 'stopped' },
  { id: 'mach-ccc', name: 'my-coord', role: 'coordinator', state: 'running', status: 'running' },
];
const events = [
  { t: 1, id: '7c1e90ab', type: 'agent', description: 'a' },
  { t: 2, id: '7c1e90ab', type: 'machine', machine: 'mach-aaa' },
];
const setup = (caps = {}) => {
  const out = [], err = [], provider = createFakeProvider();
  Object.assign(provider.caps, caps);
  return { out, err, provider, d: { provider, env: {}, list: async () => machines, events: () => events, alive: () => true, out: (s) => out.push(s), err: (s) => err.push(s) } };
};
const TOKEN = '#tok';

test('parseArgs reads the flags and rejects bad ones', () => {
  assert.deepEqual(parseArgs(['x']), { id: 'x', control: false, ttl: 3600, screenshot: undefined, unshare: false });
  assert.equal(parseArgs(['x', '--control', '--ttl', '60']).ttl, 60);
  assert.equal(parseArgs(['x', '--ttl', '86400']).ttl, 86400);
  assert.equal(parseArgs(['x', '--screenshot', 'a.png']).screenshot, 'a.png');
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['x', '--ttl', '59']), /60 to 86400/);
  assert.throws(() => parseArgs(['x', '--ttl', '86401']), /60 to 86400/);
  assert.throws(() => parseArgs(['x', '--ttl', 'abc']), /60 to 86400/);
  assert.throws(() => parseArgs(['x', '--screenshot']), /file/);
  assert.throws(() => parseArgs(['x', '--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['a;rm']), /characters/);
  assert.throws(() => parseArgs(['x', '--unshare', '--control']), /--unshare/);
  assert.throws(() => parseArgs(['x', '--screenshot', 'a.png', '--control']), /--screenshot/);
});

test('--help prints usage with where the id comes from and exits 0; the expiry is local time with a zone, not ISO', async () => {
  const s = setup();
  assert.equal(await run(['--help'], s.d), 0);
  assert.match(s.out.join('\n'), /Usage: cloudy-cloud display[\s\S]*cloud_agent_list/);
  assert.deepEqual(s.err, []);
  const t = setup();
  assert.equal(await run(['7c1e90ab'], t.d), 0);
  assert.doesNotMatch(t.err.join('\n'), /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/);
  assert.match(t.err.join('\n'), /stops working for new viewers at \d{1,2}:\d\d\b.*[A-Z]{2,5}|GMT/);
});

test('prints only the URL on stdout; view-only by default; the link never reaches stderr', async () => {
  const s = setup();
  assert.equal(await run(['7c1e90ab'], s.d), 0);
  assert.deepEqual(s.out, ['https://fake.example/desktop/mach-aaa#tok']);
  assert.deepEqual(s.provider.log.display, [{ op: 'link', id: 'mach-aaa', control: false, ttlSeconds: 3600 }]);
  const e = s.err.join('\n');
  assert.ok(!e.includes(TOKEN) && !e.includes('fake.example'));
  assert.match(e, /anyone with the link can view the screen[\s\S]*stops working for new viewers at[\s\S]*cloudy-cloud display 7c1e90ab --unshare/i);
});

test('--control and --ttl are passed on, and the note says control', async () => {
  const s = setup();
  assert.equal(await run(['my-coord', '--control', '--ttl', '120'], s.d), 0);
  assert.deepEqual(s.provider.log.display, [{ op: 'link', id: 'mach-ccc', control: true, ttlSeconds: 120 }]);
  assert.match(s.err.join('\n'), /control the screen/i);
});

test('--screenshot writes the PNG and prints the path, not a link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disp-')), f = join(dir, 'shot.png');
  const s = setup();
  assert.equal(await run(['box-aaa', '--screenshot', f], s.d), 0);
  assert.deepEqual(s.out, [f]);
  assert.deepEqual([...await readFile(f)].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(await readdir(dir), ['shot.png']);
  assert.equal(s.provider.log.display.some((x) => x.op === 'link'), false);
});

test('--unshare revokes every link and prints nothing on stdout', async () => {
  const s = setup();
  assert.equal(await run(['box-aaa', '--unshare'], s.d), 0);
  assert.deepEqual(s.provider.log.display, [{ op: 'revoke', id: 'mach-aaa' }]);
  assert.deepEqual(s.out, []);
});

test('a slow desktop start prints the two-minute note on stderr', async () => {
  const s = setup(); s.d.slowMs = 5;
  const orig = s.provider.displayLink.bind(s.provider);
  s.provider.displayLink = async (...a) => { await new Promise((r) => setTimeout(r, 40)); return orig(...a); };
  assert.equal(await run(['box-aaa'], s.d), 0);
  assert.match(s.err.join('\n'), /about two minutes/);
});

test('errors name a code and a next step', async () => {
  let s = setup({ hasDisplay: false });
  assert.equal(await run(['box-aaa'], s.d), 1);
  assert.match(s.err.join('\n'), /no desktop display/);
  assert.match(s.err.join('\n'), /Next step/);
  s = setup();
  assert.equal(await run(['box-bbb'], s.d), 1);
  assert.match(s.err.join('\n'), /Machine box-bbb is not running[\s\S]*Next step/);
  for (const [code, re] of [['desktop_unavailable', /has no desktop/], ['display_forbidden', /refused the display link/]]) {
    s = setup();
    s.provider.displayLink = async () => { throw Object.assign(new Error('x'), { code }); };
    assert.equal(await run(['box-aaa'], s.d), 1);
    assert.match(s.err.join('\n'), re);
    assert.match(s.err.join('\n'), /Next step/);
    assert.deepEqual(s.out, []);
  }
  s = setup();
  s.provider.screenshot = async () => { throw Object.assign(new Error('x'), { code: 'display_forbidden' }); };
  assert.equal(await run(['box-aaa', '--screenshot', join(tmpdir(), 'nope.png')], s.d), 1);
});

test('provider error text and any link in it never reach stderr', async () => {
  for (const code of [undefined, 'display_forbidden']) {
    const s = setup();
    s.provider.displayLink = async () => { throw Object.assign(new Error('bad https://fake.example/desktop/m#SECRETTOK end'), { code }); };
    assert.equal(await run(['box-aaa'], s.d), 1);
    const e = s.err.join('\n');
    assert.ok(!e.includes('SECRETTOK') && !e.includes('fake.example') && !e.includes('bad '));
    assert.match(e, /display/i);
  }
});

test('--screenshot refuses an existing file or symlink and leaves them unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disp-')), f = join(dir, 'a.png'), t = join(dir, 'target'), l = join(dir, 'link.png');
  await writeFile(f, 'keep'); await writeFile(t, 'keep'); await symlink(t, l);
  for (const p of [f, l]) {
    const s = setup();
    assert.equal(await run(['box-aaa', '--screenshot', p], s.d), 1);
    assert.match(s.err.join('\n'), /already exists/);
  }
  assert.equal(await readFile(f, 'utf8'), 'keep');
  assert.equal(await readFile(t, 'utf8'), 'keep');
});

test('--unshare works on a stopped machine', async () => {
  const s = setup();
  assert.equal(await run(['box-bbb', '--unshare'], s.d), 0);
  assert.deepEqual(s.provider.log.display, [{ op: 'revoke', id: 'mach-bbb' }]);
});

test('a gpu machine gets the two-minute note before the request', async () => {
  const s = setup();
  s.d.list = async () => [{ ...machines[0], labels: { kind: 'gpu' } }];
  s.provider.displayLink = async () => { assert.match(s.err.join('\n'), /about two minutes/); return { url: 'https://x/#t', expiresAt: Date.now() + 1000 }; };
  assert.equal(await run(['box-aaa'], s.d), 0);
});

test('an omarchy machine is refused up front whether addressed by agent id, name or machine id', async () => {
  for (const id of ['7c1e90ab', 'box-aaa', 'mach-aaa']) {
    const s = setup();
    s.d.list = async () => [{ ...machines[0], labels: { kind: 'omarchy' } }];
    assert.equal(await run([id], s.d), 1, id);
    assert.match(s.err.join('\n'), /omarchy machine has no desktop/);
    assert.deepEqual(s.provider.log.display, [], id);
  }
});

test('a generic provider failure names no CLI — display runs through the SDK, not the provider binary', async () => {
  let s = setup();
  let argvCalls = 0;
  s.provider.shellArgv = () => { argvCalls++; return ['npx', 'fake-ssh']; }; // SDK-only failures must not probe the CLI path
  s.provider.displayLink = async () => { throw new Error('socket hangup'); };
  assert.equal(await run(['box-aaa'], s.d), 1);
  assert.equal(argvCalls, 0, 'shellArgv was called for an SDK-only failure');
  assert.match(s.err.join('\n'), /could not complete the display request\. Try again\./);
  assert.doesNotMatch(s.err.join('\n'), /installed|npx|fake-ssh|doctor/);
  s = setup();
  s.provider.name = 'self-hosted';
  s.provider.displayLink = async () => { throw new Error('socket hangup'); };
  assert.equal(await run(['box-aaa'], s.d), 1);
  assert.match(s.err.join('\n'), /cloudy-cloud doctor/); // doctor checks self-hosted boxes only
});
