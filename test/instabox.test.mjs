import './tmp-cleanup.mjs';
import { test } from 'node:test';
import { createFakeProvider } from './fake-provider.mjs';
import assert from 'node:assert/strict';
import { createInstaboxSandbox } from '../src/providers/instabox.mjs';
import { createLimiter } from '../src/limits.mjs';
import { createProgress } from '../src/progress.mjs';
import { runSubagent, waitAgents } from '../src/run-subagent.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway repo with a github.com origin, so the test does not depend on where this checkout came from.
function githubRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ib-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/test/repo.git');
  return dir;
}

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
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, 'own1')({ A: '1' });
  assert.equal(sbx.home, '/data/home');
  assert.equal(calls.create.opts.apiKey, KEY);
  assert.equal(calls.create.opts.archiveMs, 8 * 60 * 60_000);
  assert.deepEqual(calls.create.opts.metadata, { purpose: 'cloudy-cloud', owner: 'own1' });
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
  let t = 0;
  const rt = { now: () => t, sleep: async () => {}, sliceMs: 20_000 };
  const { sdk, calls } = fakeSdk({ waitImpl: async (o) => { assert.ok(o.timeoutMs <= 20_000); t += o.timeoutMs; throw Object.assign(new Error('late'), { code: 'job_wait_timeout' }); } });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, undefined, rt)({});
  await assert.rejects(sbx.commands.run('x', { timeoutMs: 1_740_000 }), /timed out/);
  assert.equal(calls.killedJob, true);
  assert.equal(t, 1_740_000);
});

test('sliced waits deliver the full output once, with no double-counted tool uses', async () => {
  const tool = (id) => `{"type":"assistant","message":{"id":"m${id}","content":[{"type":"tool_use","id":"t${id}","name":"Bash","input":{"command":"ls"}}]}}\n`;
  const lines = [tool(1), tool(2), tool(3), '{"type":"result","result":"done","session_id":"s"}\n'];
  let slice = 0;
  // Each wait() replays the log from the start and reveals one more line, as the SDK does.
  const waitImpl = async (o) => {
    slice++;
    for (const l of lines.slice(0, slice)) await o.onStdout(l.slice(0, 7)), await o.onStdout(l.slice(7));
    if (slice < lines.length) throw Object.assign(new Error('slice'), { code: 'job_wait_timeout' });
    return { stdout: lines.join(''), stderr: '', exitCode: 0 };
  };
  const { sdk } = fakeSdk({ waitImpl });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast())({});
  const p = createProgress();
  const got = [];
  const r = await sbx.commands.run('x', { timeoutMs: 1_740_000, onStdout: (c) => { got.push(c); p.feed(c); } });
  p.end();
  assert.equal(slice, 4);
  assert.equal(got.join(''), lines.join(''));
  assert.equal(p.tools, 3);
  assert.equal(r.stdout, lines.join(''));
});

test('the global limiter holds at its cap with 100 agents running long turns, and waits do not hold a slot between slices', async () => {
  const limiter = createLimiter(24);
  const rt = { limiter, sleep: async () => {} };
  let finished = 0;
  const left = new Map();
  const waitImpl = (id) => async () => {
    await new Promise((r) => setTimeout(r, 1));
    left.set(id, (left.get(id) ?? 5) - 1);
    if (left.get(id) > 0) throw Object.assign(new Error('slice'), { code: 'job_wait_timeout' });
    finished++;
    return { stdout: 'x', stderr: '', exitCode: 0 };
  };
  let n = 0;
  const sdk = { Sandbox: { async create() {
    const id = n++;
    return { sandboxId: `m${id}`, files: { write: async () => {} }, kill: async () => true,
      commands: { run: async (c, o) => (o.background ? { kill: async () => true, wait: waitImpl(id) } : { stdout: '', stderr: '', exitCode: 0 }) } };
  } } };
  const make = createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, undefined, rt);
  await Promise.all(Array.from({ length: 100 }, async () => {
    const sbx = await make({});
    await sbx.files.write('/f', 'x');
    await sbx.commands.run('claude', { timeoutMs: 1_740_000 });
  }));
  assert.equal(finished, 100);
  assert.equal(limiter.peak, 24);
  assert.equal(limiter.active, 0);
});

test('a 429 on any call is retried after a short backoff', async () => {
  let writes = 0, runs = 0;
  const sleeps = [];
  const sdk = { Sandbox: { async create() {
    return { sandboxId: 'm', kill: async () => true,
      files: { write: async () => { if (writes++ < 2) throw Object.assign(new Error('slots'), { status: 429, code: 'quota_exceeded' }); } },
      commands: { run: async () => { if (runs++ < 1) throw Object.assign(new Error('slots'), { status: 429 }); return { stdout: 'ok', stderr: '', exitCode: 0 }; } } };
  } } };
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, undefined, { limiter: createLimiter(2), sleep: async (ms) => { sleeps.push(ms); } })({});
  await sbx.files.write('/f', 'x');
  assert.equal((await sbx.commands.run('x', { timeoutMs: 1000 })).stdout, 'ok');
  assert.equal(writes, 3);
  assert.equal(runs, 2);
  assert.deepEqual(sleeps, [1000, 2000, 1000]);
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
    createSandbox: async (envs) => { seenEnvs = envs; return sbx; }, provider: { ...createFakeProvider(), keyName: 'INSTABOX_API_KEY' }, open: new Map(),
    env: { INSTABOX_API_KEY: KEY, ANTHROPIC_API_KEY: 'api-key-xyz', CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY' }, cwd: githubRepo(),
  };
  const started = await runSubagent({ description: 'd', prompt: 'p' }, deps);
  const id = started.content[0].text.match(/agent_id: (\w+)/)[1];
  const r = await waitAgents({ agent_ids: [id], timeout_seconds: 10 }, deps);
  assert.match(r.content[0].text, /status: failed/);
  assert.deepEqual(seenEnvs, {}); // the key is a proxy secret, not an env value
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
    await assert.rejects(createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, f, timing)({}), (e) => re.test(e.message) && /GH_TOKEN Instabox secret/.test(e.message) && /RUNBOOK\.md, step 2\.4/.test(e.message));
    assert.equal(killed, true);
  }
});

test('background run streams output to onStdout and kills the job when the signal aborts', async () => {
  let seen, resolveWait;
  const { sdk, calls } = fakeSdk({
    waitImpl: (o) => { seen = o; return new Promise((_, rej) => { resolveWait = () => rej(Object.assign(new Error('x'), { exitCode: 143, stdout: 'log' })); }); },
  });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast())({});
  const ac = new AbortController();
  const chunks = [];
  const p = sbx.commands.run('x', { timeoutMs: 600001, onStdout: (c) => chunks.push(c), signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  seen.onStdout('line\n');
  assert.deepEqual(chunks, ['line\n']);
  ac.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.killedJob, true);
  resolveWait();
  await assert.rejects(p, (e) => e.exitCode === 143);
});

const tool1 = '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}\n';
const transient = [
  Object.assign(new Error('POST /v1/machines/m_1/exec timed out after 79000 ms'), { name: 'InstaboxTimeoutError', code: 'request_timeout' }),
  new Error('POST /v1/machines/m_1/exec timed out after 79000 ms'),
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
  Object.assign(new Error('bad gateway'), { status: 503, code: 'unavailable' }),
];

test('transient errors while waiting are retried with backoff and the output is delivered once', async () => {
  let n = 0;
  const sleeps = [];
  const rt = { now: () => 0, sleep: async (ms) => { sleeps.push(ms); } };
  const waitImpl = async (o) => {
    await o.onStdout(tool1);
    if (n < transient.length) throw transient[n++];
    return { stdout: tool1, stderr: '', exitCode: 0 };
  };
  const { sdk } = fakeSdk({ waitImpl });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, undefined, rt)({});
  const got = [];
  const r = await sbx.commands.run('x', { timeoutMs: 1_740_000, onStdout: (c) => got.push(c) });
  assert.equal(r.exitCode, 0);
  assert.equal(got.join(''), tool1);
  assert.deepEqual(sleeps, [2000, 4000, 8000, 15000]);
});

test('job_lost, not_found and a command exit fail at once while waiting', async () => {
  for (const err of [Object.assign(new Error('lost'), { code: 'job_lost' }), Object.assign(new Error('gone'), { status: 404, code: 'not_found' })]) {
    let n = 0;
    const { sdk } = fakeSdk({ waitImpl: async () => { n++; throw err; } });
    const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, undefined, { now: () => 0, sleep: async () => {} })({});
    await assert.rejects(sbx.commands.run('x', { timeoutMs: 1_740_000 }), err);
    assert.equal(n, 1);
  }
});

test('transient errors past the overall deadline end in the timeout path and kill the job', async () => {
  let t = 0;
  const rt = { now: () => t, sleep: async (ms) => { t += ms; } };
  const { sdk, calls } = fakeSdk({ waitImpl: async () => { t += 1000; throw new Error('POST /exec timed out after 79000 ms'); } });
  const sbx = await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, fast(), undefined, undefined, rt)({});
  await assert.rejects(sbx.commands.run('x', { timeoutMs: 700_000 }), /command timed out after 700000 ms/);
  assert.equal(calls.killedJob, true);
});

test('MCP secrets go in the same PATCH as GH_TOKEN', async () => {
  const { sdk } = fakeSdk();
  const { f, calls: http } = fakeFetch();
  await createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, f, timing)({}, { secrets: ['MCP_X_TOKEN'] });
  assert.equal(http[0].body, '{"secrets":["GH_TOKEN","MCP_X_TOKEN"]}');
  assert.equal(http.filter((c) => c.method === 'PATCH').length, 1);
});

test('a missing key secret says the exact secrets set command with its host', async () => {
  const f = async (url, init) => init.method === 'PATCH' ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'secret PARTICLE_API_KEY not found' } }), { status: 404 }) : Response.json({});
  await assert.rejects(createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, fakeSdk().sdk, f, timing)({}, { secrets: ['PARTICLE_API_KEY'] }),
    (e) => e.message.includes('secrets set PARTICLE_API_KEY --host api.particle.ai'));
});

test('a 4xx that names a missing MCP secret says how to create it', async () => {
  const f = async (url, init) => init.method === 'PATCH' ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'secret MCP_X_TOKEN not found' } }), { status: 404 }) : Response.json({});
  const { sdk } = fakeSdk();
  await assert.rejects(createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, sdk, f, timing)({}, { secrets: ['MCP_X_TOKEN'] }),
    (e) => /Instabox secret MCP_X_TOKEN is not in your org/.test(e.message) && /secrets set MCP_X_TOKEN --host/.test(e.message));
  const g = async (url, init) => init.method === 'PATCH' ? new Response('nope', { status: 400 }) : Response.json({});
  await assert.rejects(createInstaboxSandbox({ INSTABOX_API_KEY: KEY }, fakeSdk().sdk, g, timing)({}, { secrets: ['MCP_X_TOKEN'] }),
    (e) => /GH_TOKEN Instabox secret/.test(e.message) && /MCP_X_TOKEN/.test(e.message));
});
