import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMachineReader } from '../src/machine-read.mjs';
import { createFakeProvider } from './fake-provider.mjs';

const KEY = 'fakekeyvalue-0123456789';
const L1 = '{"type":"assistant","n":1}\n', L2 = '{"type":"assistant","n":2}\n', L3 = '{"type":"result","n":3}\n';

async function setup(opts = {}) {
  const env = { FAKE_API_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant-notarealkey-1234' };
  const provider = createFakeProvider(env);
  const sbx = await provider.create({ labels: { purpose: 'cloudy-cloud' }, ttlSeconds: 600 });
  const home = join(sbx.dir, 'home/.config/cloudy-cloud');
  await mkdir(join(home, 'stream'), { recursive: true });
  const file = join(home, 'stream/t1.jsonl');
  await writeFile(file, L1 + L2);
  let runs = 0;
  const run = sbx.commands.run;
  sbx.commands.run = (cmd, o) => { runs++; sbx.last = cmd; return run(cmd, o); };
  const clock = { t: 1_000_000 };
  const cacheDir = await mkdtemp(join(tmpdir(), 'cc-mr-'));
  const reader = createMachineReader(provider, env, { now: () => clock.t, cacheDir, ...opts });
  return { provider, sbx, file, home, reader, clock, cacheDir, runs: () => runs, env };
}
const code = (p) => p.then(() => { throw new Error('should reject'); }, (e) => e.code);

test('readTail returns new bytes only and the file size', async () => {
  const { reader, sbx, file, clock } = await setup();
  const a = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  assert.equal(a.data, L1 + L2);
  assert.equal(a.from, 0);
  assert.equal(a.size, Buffer.byteLength(L1 + L2));
  await appendFile(file, L3);
  clock.t += 3000;
  const b = await reader.readTail(sbx.id, 'stream/t1.jsonl', a.size);
  assert.equal(b.data, L3);
  assert.equal(b.from, a.size);
  assert.equal(b.size, Buffer.byteLength(L1 + L2 + L3));
  assert.equal(typeof b.fetchedAt, 'number');
});

test('a bad path or machine is refused before any provider call', async () => {
  const { reader, sbx, provider } = await setup();
  for (const bad of ['../x', 't99999', 'stream/t1.jsonl;id', 'stream/t12345.jsonl', 'streams/XYZ/t1.jsonl', 'streams/../../etc/t1.jsonl', '/etc/passwd']) {
    assert.equal(await code(reader.readTail(sbx.id, bad, 0)), 'invalid_path', bad);
  }
  assert.equal(await code(reader.readTail('../m', 'stream/t1.jsonl', 0)), 'invalid_path');
  assert.equal(await code(reader.readTail(sbx.id, 'stream/t1.jsonl', -1)), 'invalid_path');
  assert.deepEqual([provider.log.list.length, provider.log.connect.length], [0, 0]);
  assert.equal(await code(reader.readTail('fake-999', 'stream/t1.jsonl', 0)), 'not_listed');
  assert.equal(provider.log.connect.length, 0);
});

test('the four allowed file shapes are read', async () => {
  const { reader, sbx, home, clock } = await setup();
  await writeFile(join(home, 'stream/meta.json'), '{"agent":"a"}\n');
  await writeFile(join(home, 'events.jsonl'), '{"type":"agent"}\n');
  await mkdir(join(home, 'streams/0123abcd'), { recursive: true });
  await writeFile(join(home, 'streams/0123abcd/t2.jsonl'), L1);
  for (const [name, text] of [['stream/meta.json', '{"agent":"a"}\n'], ['events.jsonl', '{"type":"agent"}\n'], ['streams/0123abcd/t2.jsonl', L1]]) {
    clock.t += 3000;
    assert.equal((await reader.readTail(sbx.id, name, 0)).data, text, name);
  }
});

test('concurrent reads of one machine make one command; a read within 3 s uses the cache', async () => {
  const { reader, sbx, runs, clock, file } = await setup();
  const [a, b] = await Promise.all([reader.readTail(sbx.id, 'stream/t1.jsonl', 0), reader.readTail(sbx.id, 'stream/t1.jsonl', 0)]);
  assert.equal(runs(), 1);
  assert.equal(a.data, b.data);
  await appendFile(file, L3);
  clock.t += 2000;
  const c = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  assert.equal(runs(), 1);
  assert.equal(c.data, a.data);
  // a new offset inside the interval: nothing new yet, still no command
  const d = await reader.readTail(sbx.id, 'stream/t1.jsonl', a.size);
  assert.equal(runs(), 1);
  assert.equal(d.data, '');
  clock.t += 1500;
  assert.equal((await reader.readTail(sbx.id, 'stream/t1.jsonl', a.size)).data, L3);
  assert.equal(runs(), 2);
});

test('only a fixed read command is sent, and no key is in it', async () => {
  const { reader, sbx, env } = await setup();
  await reader.readTail(sbx.id, 'stream/t1.jsonl', 5);
  assert.match(sbx.last, /^sz=\$\(wc -c < "\$HOME\/\.config\/cloudy-cloud\/stream\/t1\.jsonl"\); tail -c \+6 "\$HOME\/\.config\/cloudy-cloud\/stream\/t1\.jsonl" \| head -c 262144; echo; echo "SIZE \$sz"$/);
  for (const v of Object.values(env)) assert.ok(!sbx.last.includes(v));
});

test('returned data is redacted, including the exact env key values; the on-disk cache is private and outlives the machine', async () => {
  const { reader, sbx, file, provider, cacheDir, env } = await setup();
  await writeFile(file, `${JSON.stringify({ type: 'x', a: 'INSTABOX_API_KEY=ibk_abcdefghijkl', b: `key ${KEY} and ${env.ANTHROPIC_API_KEY}` })}\n`);
  const r = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  for (const bad of ['ibk_abcdefghijkl', KEY, env.ANTHROPIC_API_KEY]) assert.ok(!r.data.includes(bad), bad);
  JSON.parse(r.data); // still valid JSON
  const cached = join(cacheDir, sbx.id, 'stream/t1.jsonl');
  assert.equal((await stat(cached)).mode & 0o777, 0o600);
  assert.equal((await stat(join(cacheDir, sbx.id))).mode & 0o777, 0o700);
  assert.equal(await readFile(cached, 'utf8'), r.data);
  provider.machines.delete(sbx.id);
  const c = await reader.readCached(sbx.id, 'stream/t1.jsonl');
  assert.equal(c.data, r.data);
  assert.equal(c.source, 'cache');
  assert.equal(await reader.readCached(sbx.id, 'stream/t9.jsonl'), null);
});

test('a machine that is gone gives not_found and its connection is not reused', async () => {
  const { reader, sbx, provider, clock } = await setup();
  await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  provider.machines.set('fake-gone', { id: 'fake-gone', labels: { purpose: 'cloudy-cloud' } }); // listed, but connect() says not_found
  clock.t += 20_000;
  assert.equal(await code(reader.readTail('fake-gone', 'stream/t1.jsonl', 0)), 'not_found');
  assert.equal(await code(reader.readTail('fake-gone', 'stream/t1.jsonl', 0)), 'not_found');
  assert.equal(provider.log.connect.filter((i) => i === 'fake-gone').length, 2);
  assert.equal(provider.log.list.length, 2); // refreshed at most every 10 s
});

test('capturePane sends only tmux capture-pane and redacts the screen', async () => {
  const { reader, sbx, runs } = await setup();
  await writeFile(join(sbx.dir, 'bin/tmux'), `#!/bin/sh\necho "$@" >> ../tmux.log\necho "pane line one"\necho "token sk-abcdefghijkl1234"\n`);
  await chmod(join(sbx.dir, 'bin/tmux'), 0o755);
  const r = await reader.capturePane(sbx.id);
  assert.deepEqual(r.lines.slice(0, 2), ['pane line one', 'token [redacted]']);
  assert.equal(await readFile(join(sbx.dir, 'tmux.log'), 'utf8'), 'capture-pane -p -J -t claude -S -200\n');
  assert.equal(sbx.last, "tmux capture-pane -p -J -t claude -S -200 2>&1 || echo 'no tmux session named claude'");
  await reader.capturePane(sbx.id);
  assert.equal(runs(), 1);
});

test('only complete lines are returned and cached; an unfinished line waits, an oversize line is dropped', async () => {
  const { reader, sbx, file, clock, cacheDir } = await setup();
  await writeFile(file, `${L1}{"type":"x","secret":"abcdef`);
  const a = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  assert.equal(a.data, L1);
  assert.equal(a.next, Buffer.byteLength(L1)); // stays at the start of the unfinished line
  clock.t += 3000;
  await appendFile(file, 'ghij"}\n');
  const b = await reader.readTail(sbx.id, 'stream/t1.jsonl', a.next);
  assert.equal(b.data, '{"type":"x","secret":"abcdefghij"}\n');
  assert.equal(await readFile(join(cacheDir, sbx.id, 'stream/t1.jsonl'), 'utf8'), a.data + b.data);
  // a single line longer than the 256 KB chunk: no fragments, a marker, and the rest of that line is skipped
  clock.t += 3000;
  await writeFile(file, `${'z'.repeat(300_000)}\n${L3}`);
  const c = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  assert.equal(c.data, '{"type":"cloudy-cloud","note":"truncated"}\n');
  clock.t += 3000;
  const d = await reader.readTail(sbx.id, 'stream/t1.jsonl', c.next);
  assert.equal(d.data, L3);
});

test('MCP token values in the env and consented literals are redacted in tails, the cache and the pane', async () => {
  const lits = new Set();
  const { sbx, file, cacheDir, provider, env, clock } = await setup();
  env.MCP_NOTION_TOKEN = 'mcpnotionvalue-777';
  lits.add('ytoken-consented-1');
  const reader = createMachineReader(provider, env, { now: () => clock.t, cacheDir, literals: lits });
  await writeFile(file, `${JSON.stringify({ a: 'ytoken-consented-1', b: 'mcpnotionvalue-777' })}\n`);
  const r = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  const onDisk = await readFile(join(cacheDir, sbx.id, 'stream/t1.jsonl'), 'utf8');
  for (const t of [r.data, onDisk]) assert.ok(!t.includes('ytoken-consented-1') && !t.includes('mcpnotionvalue-777'));
  await writeFile(join(sbx.dir, 'bin/tmux'), '#!/bin/sh\necho "x ytoken-consented-1 y"\n');
  await chmod(join(sbx.dir, 'bin/tmux'), 0o755);
  clock.t += 3000;
  assert.deepEqual((await reader.capturePane(sbx.id)).lines, ['x [redacted] y']);
});

test('the reader keeps few results and the disk cache stops at the cap; readCached reads only the tail', async () => {
  const { reader, sbx, file, clock, cacheDir } = await setup({ cacheCap: 300 });
  const big = (n) => `${JSON.stringify({ n, pad: 'p'.repeat(100) })}\n`;
  await writeFile(file, big(1) + big(2));
  const a = await reader.readTail(sbx.id, 'stream/t1.jsonl', 0);
  clock.t += 3000;
  await appendFile(file, big(3) + big(4));
  await reader.readTail(sbx.id, 'stream/t1.jsonl', a.next);
  const stored = await readFile(join(cacheDir, sbx.id, 'stream/t1.jsonl'), 'utf8');
  assert.ok(Buffer.byteLength(stored) <= 300);
  const c = await reader.readCached(sbx.id, 'stream/t1.jsonl', { maxBytes: 150 });
  assert.ok(Buffer.byteLength(c.data) <= 150);
  assert.ok(c.data.endsWith('\n') && c.data.startsWith('{')); // starts on a line boundary
});

test('concurrent reads of different files on one machine keep the 3 s interval', async () => {
  const { reader, sbx, home, runs } = await setup();
  await writeFile(join(home, 'stream/meta.json'), '{"a":1}\n');
  const [a, b] = await Promise.all([reader.readTail(sbx.id, 'stream/t1.jsonl', 0), reader.readTail(sbx.id, 'stream/meta.json', 0)]);
  assert.equal(runs(), 1);
  assert.equal(a.data !== '' || b.data !== '', true);
  assert.ok(a.data === '' || b.data === '');
});
