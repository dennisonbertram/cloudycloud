import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveTarget, run } from '../src/open.mjs';

const machines = [
  { id: 'mach-aaa', name: 'box-aaa', state: 'running' },
  { id: 'mach-bbb', name: 'box-bbb', state: 'stopped' },
  { id: 'mach-ccc', name: 'my-coord', role: 'coordinator', state: 'running' },
];
const events = [
  { t: 1, id: '7c1e90ab', type: 'agent', description: 'a' },
  { t: 2, id: '7c1e90ab', type: 'machine', machine: 'mach-aaa' },
  { t: 3, id: 'dead0001', type: 'agent', description: 'b' },
  { t: 4, id: 'dead0001', type: 'machine', machine: 'mach-bbb' },
];
const deps = (calls = [], over = {}) => {
  const out = [], err = [];
  return { calls, out, err, d: {
    list: async () => machines, events: () => events, alive: () => true,
    spawn: async (argv, o) => { calls.push([argv, o]); return { code: 0, stdout: '{"url":"https://x.example/?_token=t"}' }; },
    out: (s) => out.push(s), err: (s) => err.push(s), ...over,
  } };
};

test('parseArgs accepts ports and flags, rejects bad input', () => {
  assert.deepEqual(parseArgs(['7c1e90ab', '3000']), { id: '7c1e90ab', port: '3000', share: false, unshare: false });
  assert.equal(parseArgs(['x', '8080:3000']).port, '8080:3000');
  assert.equal(parseArgs(['x', '3000', '--share']).share, true);
  assert.throws(() => parseArgs(['x']), /port/i);
  assert.throws(() => parseArgs([]), /Usage/);
  for (const p of ['0', '65536', 'abc', '80:0', '1:2:3', '-1']) assert.throws(() => parseArgs(['x', p]), /1 to 65535/, p);
  assert.throws(() => parseArgs(['a;rm', '3000']), /characters/);
  assert.throws(() => parseArgs(['x', '3000', '--share', '--unshare']), /either/);
  assert.throws(() => parseArgs(['x', '8080:3000', '--share']), /single port/);
  assert.throws(() => parseArgs(['x', '3000', '--public']), /Unknown option/);
});

test('resolveTarget maps agent id and coordinator name; errors are plain', () => {
  const ctx = { machines, events, alive: () => true };
  assert.equal(resolveTarget('7c1e90ab', ctx), 'mach-aaa');
  assert.equal(resolveTarget('my-coord', ctx), 'mach-ccc');
  assert.throws(() => resolveTarget('dead0001', ctx), /not running/);
  assert.throws(() => resolveTarget('nope', ctx), /Unknown id "nope".*7c1e90ab/s);
});

test('default opens a private tunnel with an exact argv', async () => {
  const { calls, out, d } = deps([], { env: { INSTABOX_API_KEY: 'ibk_saved' } });
  assert.equal(await run(['7c1e90ab', '8080:3000'], d), 0);
  assert.equal(out[0], 'Forwarding http://127.0.0.1:8080 to port 3000 on mach-aaa. Press Ctrl-C to stop.');
  assert.deepEqual(calls[0], [['npx', '--yes', 'instabox@latest', 'port-forward', 'mach-aaa', '8080:3000'], { inherit: true, env: { INSTABOX_API_KEY: 'ibk_saved' } }]);
  assert.ok(calls.every(([, o]) => o.env.INSTABOX_API_KEY === 'ibk_saved'));
});

test('--share publishes privately and --unshare unpublishes', async () => {
  const s = deps();
  assert.equal(await run(['7c1e90ab', '3000', '--share'], s.d), 0);
  assert.deepEqual(s.calls[0][0], ['npx', '--yes', 'instabox@latest', 'port', 'publish', 'mach-aaa', '3000', '--private', '--json']);
  assert.ok(s.out.join('\n').includes('https://x.example/?_token=t'));
  assert.match(s.out.join('\n'), /Anyone with this link can open the app until the machine is deleted or you run: cloudy-cloud open 7c1e90ab 3000 --unshare/);
  assert.ok(!s.calls[0][0].includes('--public'));
  const u = deps();
  await run(['7c1e90ab', '3000', '--unshare'], u.d);
  assert.deepEqual(u.calls[0][0], ['npx', '--yes', 'instabox@latest', 'port', 'unpublish', 'mach-aaa', '3000']);
});

test('errors spawn nothing and return 1', async () => {
  const a = deps();
  assert.equal(await run(['nope', '3000'], a.d), 1);
  assert.equal(a.calls.length, 0);
  assert.match(a.err.join(''), /7c1e90ab/);
  const b = deps([], { list: async () => { throw Object.assign(new Error('INSTABOX_API_KEY is not set.'), { code: 'no_key' }); } });
  assert.equal(await run(['x', '3000'], b.d), 1);
  assert.match(b.err.join(''), /cloudy-cloud setup/);
});
