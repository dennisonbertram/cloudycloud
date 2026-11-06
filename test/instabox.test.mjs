import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaboxSandbox } from '../src/instabox.mjs';
import { runSubagent, waitAgents } from '../src/run-subagent.mjs';

function fakeSdk({ waitImpl } = {}) {
  const calls = { create: null, run: [], killedJob: false };
  const sdk = {
    Sandbox: {
      async create(template, opts) {
        calls.create = { template, opts };
        return {
          sandboxId: 'm-123',
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
const applied = { proxy: { revision: 2, appliedRevision: 2 }, guest: { revision: 2, appliedRevision: 2 } };
const pending = { proxy: { revision: 2, appliedRevision: 1 }, guest: { revision: 2, appliedRevision: 2 } };
// Fake fetch for the secrets endpoint: records calls, answers each GET from `gets` (last one repeats).
function fakeFetch({ gets = [applied], patchStatus = 200 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === 'PATCH') return new Response(patchStatus < 300 ? '{}' : JSON.stringify({ error: { code: 'missing_scope', message: 'lacks scope' } }), { status: patchStatus });
    return Response.json(gets[Math.min(calls.filter((c) => c.method === 'GET').length - 1, gets.length - 1)]);
  };
  return { f, calls };
}
const timing = { pollMs: 5, timeoutMs: 100 };
const fast = () => fakeFetch().f;

test('create passes key, metadata, archiveMs and home', async () => {
  const { sdk, calls } = fakeSdk();
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast())({ A: '1' });
  assert.equal(sbx.home, '/data/home');
  assert.equal(calls.create.opts.apiKey, KEY);
  assert.equal(calls.create.opts.archiveMs, 8 * 60 * 60_000);
  assert.deepEqual(calls.create.opts.metadata, { purpose: 'claude-cloud' });
  assert.equal(calls.create.opts.timeoutMs, undefined);
  assert.ok(!JSON.stringify(Object.keys(sbx)).includes(KEY));
  assert.ok(!Object.values(sbx).some((v) => typeof v === 'string' && v.includes(KEY)));
});

test('timeout above 10 minutes runs in background, at or below runs in foreground', async () => {
  const { sdk, calls } = fakeSdk();
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast())({}, 1);
  assert.equal((await sbx.commands.run('x', { timeoutMs: 600000 })).stdout, 'fg');
  assert.equal(calls.run[0].opts.background, undefined);
  assert.equal(calls.run[0].opts.timeoutMs, 600000);
  assert.equal((await sbx.commands.run('x', { cwd: '/c', timeoutMs: 600001 })).stdout, 'bg');
  assert.equal(calls.run[1].opts.background, true);
  assert.equal(calls.run[1].opts.cwd, '/c');
});

test('background non-zero exit throws exitCode and stderr', async () => {
  const { sdk } = fakeSdk({ waitImpl: async () => { throw Object.assign(new Error('x'), { exitCode: 3, stdout: 'log text', stderr: '' }); } });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast())({}, 1);
  await assert.rejects(sbx.commands.run('x', { timeoutMs: 1_740_000 }), (e) => e.exitCode === 3 && e.stderr === 'log text');
});

test('background timeout kills the job and throws', async () => {
  const { sdk, calls } = fakeSdk({ waitImpl: async (o) => { assert.equal(o.timeoutMs, 1_740_000); throw Object.assign(new Error('late'), { code: 'job_wait_timeout' }); } });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast())({}, 1);
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
  const deps = {
    createSandbox: async (envs) => { seenEnvs = envs; return sbx; }, open: new Map(),
    env: { INSTABOX_API_KEY: KEY, ANTHROPIC_API_KEY: 'api-key-xyz' }, cwd: process.cwd(),
  };
  const started = await runSubagent({ description: 'd', prompt: 'p' }, deps);
  const id = started.content[0].text.match(/agent_id: (\w+)/)[1];
  const r = await waitAgents({ agent_ids: [id], timeout_seconds: 10 }, deps);
  assert.match(r.content[0].text, /status: failed/);
  assert.deepEqual(seenEnvs, { ANTHROPIC_API_KEY: 'api-key-xyz' });
  assert.ok(written.every((p) => p.startsWith('/data/home/')) && written.length);
  assert.ok(cmds.every((c) => !c.cmd.includes('/home/user') && !String(c.cwd).includes('/home/user')));
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('GH_TOKEN secret is attached with PATCH, then polled until proxy and guest have applied it', async () => {
  const { sdk, calls } = fakeSdk();
  const { f, calls: http } = fakeFetch({ gets: [pending, pending, applied] });
  await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, f, timing)({});
  assert.equal(http[0].method, 'PATCH');
  assert.equal(http[0].url, 'https://api.instabox.sh/v1/machines/m-123/secrets');
  assert.equal(http[0].body, '{"secrets":["GH_TOKEN"]}');
  assert.equal(http[0].headers['X-API-Key'], KEY);
  assert.deepEqual(http.slice(1).map((c) => c.method), ['GET', 'GET', 'GET']);
  assert.equal(calls.create.opts.envs.GH_TOKEN, undefined);
});

test('a secrets timeout or HTTP error kills the sandbox and names GH_TOKEN and the setup script', async () => {
  for (const [f, re] of [[fakeFetch({ gets: [pending] }).f, /not applied within/], [fakeFetch({ patchStatus: 403 }).f, /HTTP 403, code missing_scope: lacks scope/]]) {
    let killed = false;
    const { sdk } = fakeSdk();
    const create = sdk.Sandbox.create;
    sdk.Sandbox.create = async (...a) => Object.assign(await create(...a), { kill: async () => { killed = true; } });
    await assert.rejects(createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, f, timing)({}), (e) => re.test(e.message) && /GH_TOKEN Instabox secret/.test(e.message) && /claude-cloud-setup-github/.test(e.message));
    assert.equal(killed, true);
  }
});
