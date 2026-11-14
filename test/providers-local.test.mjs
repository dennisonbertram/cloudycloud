import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocal } from '../src/providers/local.mjs';

test('local transport: stdout, stdin and exit codes follow the ssh transport contract', async () => {
  const t = createLocal();
  const chunks = [];
  const r = await t.run('cat; echo err >&2', { stdin: 'in-data', onStdout: (d) => chunks.push(d) });
  assert.deepEqual([r.stdout, r.stderr.trim(), r.exitCode, chunks.join('')], ['in-data', 'err', 0, 'in-data']);
  await assert.rejects(t.run('echo o; echo e >&2; exit 3'), (e) => e.exitCode === 3 && e.stdout === 'o\n' && /e/.test(e.stderr));
});

test('local transport: timeout and abort end the process; a bad spawn is transient', async () => {
  const t = createLocal();
  const t0 = Date.now();
  await assert.rejects(t.run('sleep 30', { timeoutMs: 200 }), (e) => e.code === 'timeout');
  const ac = new AbortController();
  const p = t.run('sleep 30', { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(createLocal({ spawn: () => { throw new Error('boom'); } }).run('x'), (e) => e.code === 'transient');
});
