import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaboxSandbox } from '../src/instabox.mjs';
import { runSubagent } from '../src/run-subagent.mjs';

function fakeSdk({ waitImpl } = {}) {
  const calls = { create: null, run: [], killedJob: false };
  const sdk = {
    Sandbox: {
      async create(template, opts) {
        calls.create = { template, opts };
        return {
          files: { write: async () => {}, read: async () => new Uint8Array() },
          kill: async () => true,
          commands: {
            async run(cmd, opts) {
              calls.run.push({ cmd, opts });
              if (!opts.background) return { stdout: 'fg', stderr: '', exitCode: 0 };
              return {
                kill: async () => { calls.killedJob = true; return true; },
                wait: waitImpl ?? (async () => ({ stdout: 'bg', stderr: '', exitCode: 0 })),
              };
            },
          },
        };
      },
    },
  };
  return { sdk, calls };
}

const KEY = 'ib-secret-key';

test('create passes key, metadata, archiveMs and home', async () => {
  const { sdk, calls } = fakeSdk();
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk)({ A: '1' }, 1800000);
  assert.equal(sbx.home, '/data/home');
  assert.equal(calls.create.opts.apiKey, KEY);
  assert.equal(calls.create.opts.archiveMs, 1800000);
  assert.deepEqual(calls.create.opts.metadata, { purpose: 'claude-cloud' });
  assert.equal(calls.create.opts.timeoutMs, undefined);
  assert.ok(!JSON.stringify(Object.keys(sbx)).includes(KEY));
  assert.ok(!Object.values(sbx).some((v) => typeof v === 'string' && v.includes(KEY)));
});

test('timeout above 10 minutes runs in background, at or below runs in foreground', async () => {
  const { sdk, calls } = fakeSdk();
  const sbx = await createInstaboxSandbox({}, sdk)({}, 1);
  assert.equal((await sbx.commands.run('x', { timeoutMs: 600000 })).stdout, 'fg');
  assert.equal(calls.run[0].opts.background, undefined);
  assert.equal(calls.run[0].opts.timeoutMs, 600000);
  assert.equal((await sbx.commands.run('x', { cwd: '/c', timeoutMs: 600001 })).stdout, 'bg');
  assert.equal(calls.run[1].opts.background, true);
  assert.equal(calls.run[1].opts.cwd, '/c');
});

test('background non-zero exit throws exitCode and stderr', async () => {
  const { sdk } = fakeSdk({ waitImpl: async () => { throw Object.assign(new Error('x'), { exitCode: 3, stdout: 'log text', stderr: '' }); } });
  const sbx = await createInstaboxSandbox({}, sdk)({}, 1);
  await assert.rejects(sbx.commands.run('x', { timeoutMs: 1_740_000 }), (e) => e.exitCode === 3 && e.stderr === 'log text');
});

test('background timeout kills the job and throws', async () => {
  const { sdk, calls } = fakeSdk({ waitImpl: async (o) => { assert.equal(o.timeoutMs, 1_740_000); throw Object.assign(new Error('late'), { code: 'job_wait_timeout' }); } });
  const sbx = await createInstaboxSandbox({}, sdk)({}, 1);
  await assert.rejects(sbx.commands.run('x', { timeoutMs: 1_740_000 }), /timed out/);
  assert.equal(calls.killedJob, true);
});

test('run-subagent honours sandbox.home and scrubs the Instabox key', async () => {
  const written = [], cmds = [];
  let seenEnvs;
  const sbx = {
    home: '/data/home',
    files: { write: async (p) => { written.push(p); }, read: async () => new Uint8Array() },
    commands: { async run(cmd, o) { cmds.push({ cmd, cwd: o.cwd }); throw Object.assign(new Error('x'), { exitCode: 1, stderr: `bad ${KEY}` }); } },
    kill: async () => {},
  };
  const r = await runSubagent({ description: 'd', prompt: 'p' }, {
    createSandbox: async (envs) => { seenEnvs = envs; return sbx; },
    env: { INSTABOX_API_KEY: KEY, E2B_API_KEY: 'e2b', ANTHROPIC_API_KEY: 'a' }, cwd: process.cwd(),
  });
  assert.deepEqual(seenEnvs, { ANTHROPIC_API_KEY: 'a' });
  assert.ok(written.every((p) => p.startsWith('/data/home/')) && written.length);
  assert.ok(cmds.every((c) => !c.cmd.includes('/home/user') && !String(c.cwd).includes('/home/user')));
  assert.ok(!JSON.stringify(r).includes(KEY));
});
