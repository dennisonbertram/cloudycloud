import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveTarget, run } from '../src/open.mjs';
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
const deps = (over = {}, providerCaps = {}) => {
  const out = [], err = [], provider = createFakeProvider();
  Object.assign(provider.caps, providerCaps);
  return { out, err, provider, d: {
    provider, env: {}, list: async () => machines, events: () => events, alive: () => true,
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

test('default forwards a private tunnel through the provider', async () => {
  const { provider, out, d } = deps();
  assert.equal(await run(['7c1e90ab', '8080:3000'], d), 0);
  assert.equal(out[0], 'Forwarding http://127.0.0.1:8080 to port 3000 on mach-aaa. Press Ctrl-C to stop.');
  assert.deepEqual(provider.log.ports, [{ op: 'forward', id: 'mach-aaa', localRemote: '8080:3000' }]);
});

test('--share publishes through the provider and --unshare unpublishes', async () => {
  const s = deps();
  assert.equal(await run(['7c1e90ab', '3000', '--share'], s.d), 0);
  assert.deepEqual(s.provider.log.ports, [{ op: 'publish', id: 'mach-aaa', port: '3000' }]);
  assert.equal(s.out[0], 'https://fake.example/mach-aaa/3000');
  assert.match(s.out.join('\n'), /Anyone with this link can open the app until the machine is deleted or you run: cloudy-cloud open 7c1e90ab 3000 --unshare/);
  const u = deps();
  assert.equal(await run(['7c1e90ab', '3000', '--unshare'], u.d), 0);
  assert.deepEqual(u.provider.log.ports, [{ op: 'unpublish', id: 'mach-aaa', port: '3000' }]);
});

test('a provider without ports fails with one line naming it; a publish failure is explained', async () => {
  const a = deps({}, { hasPublish: false, hasPortForward: false });
  for (const args of [['7c1e90ab', '3000', '--share'], ['7c1e90ab', '3000']]) assert.equal(await run(args, a.d), 1);
  assert.equal(a.err.length, 2);
  assert.match(a.err[0], /Fake does not support/);
  assert.deepEqual(a.provider.log.ports, []);
  const b = deps();
  b.provider.publishPort = async () => { throw new Error('boom'); };
  assert.equal(await run(['7c1e90ab', '3000', '--share'], b.d), 1);
  assert.match(b.err.join(''), /Publishing failed: boom\nIf Fake is not signed in, run: cloudy-cloud setup/);
});

test('errors spawn nothing and return 1', async () => {
  const a = deps();
  assert.equal(await run(['nope', '3000'], a.d), 1);
  assert.deepEqual(a.provider.log.ports, []);
  assert.match(a.err.join(''), /7c1e90ab/);
  const b = deps({ list: async () => { throw Object.assign(new Error('INSTABOX_API_KEY is not set.'), { code: 'no_key' }); } });
  assert.equal(await run(['x', '3000'], b.d), 1);
  assert.match(b.err.join(''), /cloudy-cloud setup/);
});
