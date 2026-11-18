import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/machines.mjs';
import { makeUi } from '../src/ui.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const ttyUi = () => makeUi({ tty: true, env: { TERM: 'xterm', LANG: 'en_US.UTF-8' }, cols: 80 });
const pipeUi = () => makeUi({ tty: false });

const make = (provider, { name, role = 'worker', labels = {}, ttlSeconds = 21_600 } = {}) =>
  provider.create({ name, labels: { purpose: 'cloudy-cloud', role, ...labels }, ttlSeconds });

const deps = (over = {}) => {
  const provider = createFakeProvider();
  const out = [], err = [];
  const d = {
    provider, env: { FAKE_API_KEY: 'k' }, events: () => [], tty: false, ui: pipeUi(),
    out: (s) => out.push(s), err: (s) => err.push(s), ...over,
  };
  return { provider, out, err, d };
};

test('ls piped prints a TSV header and one row per machine', async () => {
  const { provider, out, d } = deps();
  await make(provider, { name: 'w-one' });
  await make(provider, { name: 'c-one', role: 'coordinator', labels: { name: 'boss' } });
  assert.equal(await run(['ls'], d), 0);
  assert.equal(out[0], 'NAME\tROLE\tSTATE\tSTARTED\tDELETES\tID');
  assert.match(out[1], /^w-one\tworker\trunning\t\d{4}-\d{2}-\d{2}T.*\tfake-1$/);
  assert.match(out[2], /^boss\tcoordinator\trunning\t.*\tfake-2$/);
  assert.equal(out.length, 3, out.join('\n'));
});

test('ls on a terminal prints a table ending with the count and a Next', async () => {
  const { provider, out, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'w-one' });
  await make(provider, { name: 'w-two' });
  assert.equal(await run([], d), 0);
  const text = out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /NAME\s+ROLE\s+STATE\s+AGE\s+DELETES/);
  assert.match(text, /w-one\s+worker\s+running/);
  assert.match(text, /2 running\./);
  assert.match(text, /Next: cloudy-cloud machines stop/);
});

test('ls with no machines prints the empty line in both modes', async () => {
  for (const d of [deps().d, deps({ tty: true, ui: ttyUi() }).d]) {
    const out = [];
    assert.equal(await run(['ls'], { ...d, out: (s) => out.push(s) }), 0);
    assert.deepEqual(out, ['No Cloudy Cloud machines running.']);
  }
});

test('an image machine shows the image role and a machine without a role shows machine', async () => {
  const { provider, out, d } = deps();
  await make(provider, { name: 'img', role: 'coordinator-image' });
  await provider.create({ name: 'old', labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 600 });
  assert.equal(await run([], d), 0);
  assert.match(out[1], /^img\timage\t/);
  assert.match(out[2], /^old\tmachine\t/);
});

test('stop NAME deletes that machine only and prints it', async () => {
  const { provider, out, d } = deps();
  const a = await make(provider, { name: 'w-one' });
  const b = await make(provider, { name: 'w-two' });
  assert.equal(await run(['stop', 'w-one'], d), 0);
  assert.deepEqual(provider.log.delete, [a.id]);
  assert.match(out.join('\n'), /Deleted w-one \(fake-1\)/);
  assert.ok(provider.machines.has(b.id), 'the other machine is left alone');
});

test('stop resolves an agent id to its machine through the event log', async () => {
  const { provider, d } = deps();
  const a = await make(provider, { name: 'w-one' });
  d.events = () => [{ t: 1, id: '7c1e90ab', type: 'agent' }, { t: 2, id: '7c1e90ab', type: 'machine', machine: a.id }];
  assert.equal(await run(['stop', '7c1e90ab'], d), 0);
  assert.deepEqual(provider.log.delete, [a.id]);
});

test('stop of an unknown id is a plain error and deletes nothing', async () => {
  const { provider, err, d } = deps();
  await make(provider, { name: 'w-one' });
  assert.equal(await run(['stop', 'nope'], d), 1);
  assert.match(err.join('\n'), /Unknown id "nope"/);
  assert.equal(provider.log.delete.length, 0);
});

test('stop --all without --yes refuses off a terminal and deletes nothing', async () => {
  const { provider, err, d } = deps();
  await make(provider, { name: 'w-one' });
  assert.equal(await run(['stop', '--all'], d), 1);
  assert.match(err.join('\n'), /--yes/);
  assert.equal(provider.log.delete.length, 0);
});

test('stop --all --yes deletes every listed machine and says so', async () => {
  const { provider, out, d } = deps();
  await make(provider, { name: 'w-one' });
  await make(provider, { name: 'c-one', role: 'coordinator' });
  assert.equal(await run(['stop', '--all', '--yes'], d), 0);
  assert.equal(provider.log.delete.length, 2);
  assert.match(out.join('\n'), /Deleted w-one/);
  assert.match(out.join('\n'), /Deleted 2 machines\./);
});

test('stop --all on a terminal asks once; n deletes nothing, y deletes all', async () => {
  const { provider, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'w-one' });
  const asked = [];
  assert.equal(await run(['stop', '--all'], { ...d, ask: async (q) => (asked.push(q), 'n') }), 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /1 Cloudy Cloud machine|1 machine/);
  assert.equal(provider.log.delete.length, 0);
  assert.equal(await run(['stop', '--all'], { ...d, ask: async () => 'y' }), 0);
  assert.equal(provider.log.delete.length, 1);
});

test('machines without the cloudy-cloud purpose label are never listed or deleted', async () => {
  const { provider, d } = deps();
  const ours = await make(provider, { name: 'w-one' });
  const row = (m, extra = {}) => ({ id: m.id ?? m, name: m.name ?? m, labels: {}, state: 'running', status: 'running', startedAt: Date.now(), ...extra });
  d.list = async () => [row(ours, { labels: { purpose: 'cloudy-cloud' } }), row('foreign-1', { name: 'not-ours' })];
  const out = [], err = [];
  assert.equal(await run(['ls'], { ...d, out: (s) => out.push(s) }), 0);
  assert.equal(out.length, 2, 'header plus the one labelled machine');
  assert.equal(await run(['stop', '--all', '--yes'], { ...d, out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
  assert.deepEqual(provider.log.delete, [ours.id]);
  assert.equal(await run(['stop', 'not-ours'], { ...d, err: (s) => err.push(s) }), 1);
  assert.match(err.join('\n'), /Unknown id "not-ours"/);
});

test('the provider is asked only for cloudy-cloud machines', async () => {
  const { provider, d } = deps();
  await run([], d);
  assert.deepEqual(provider.log.list, [{ purpose: 'cloudy-cloud' }]);
});

test('without the provider key the fix is setup', async () => {
  const { err, d } = deps();
  d.env = {};
  assert.equal(await run([], d), 1);
  assert.match(err.join('\n'), /not signed in.*cloudy-cloud setup/s);
});

test('bad arguments print usage to stderr and exit 2', async () => {
  for (const args of [['bogus'], ['stop'], ['ls', 'extra']]) {
    const err = [];
    assert.equal(await run(args, { ...deps().d, err: (s) => err.push(s) }), 2, args.join(' '));
    assert.match(err.join('\n'), /Usage: cloudy-cloud machines/);
  }
});
