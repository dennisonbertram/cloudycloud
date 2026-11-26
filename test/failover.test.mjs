import './tmp-cleanup.mjs';
// Failover (WP2): deps.providers is the ordered candidate list (server passes it; a single provider keeps
// today's behaviour). A create error the plan fails over on, or a provider that cannot run this request,
// moves the agent to the next candidate — never across secret models, never to a second machine once one
// was created. The result's first line, the events and cloud_agent_list say where the machine ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStartQueue } from '../src/limits.mjs';
import { setGithub, createFakeProvider } from './fake-provider.mjs';
import { runSubagent, waitAgents, listAgents, stopAgents, startQueue } from '../src/run-subagent.mjs';
import { combine } from '../src/providers/index.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const SECRET = 'sk-test-secret-123';
const ORIGIN = 'https://github.com/test/repo.git';
const PROXY_ENV = { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json', CLOUDY_CLOUD_MCP: '/nonexistent-mcp.json' };
const err = (code, message) => Object.assign(new Error(message), { code });

async function setup(over = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo orig > a.txt && git add -A && git commit -qm init && git remote add origin ' + ORIGIN);
  const github = await mkdtemp(join(tmpdir(), 'cc-github-'));
  const bare = join(github, 'test', 'repo.git');
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${bare}`);
  setGithub(github);
  const events = [];
  const a = over.a ?? createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a' });
  const b = over.b ?? createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b' });
  const deps = {
    provider: over.provider ?? a,
    providers: [a, b],
    open: new Map(),
    cwd: repo,
    env: { ...PROXY_ENV, ...(over.env ?? {}) },
    queue: over.queue ?? createStartQueue({ sleep: async () => {}, quotaRetryMs: 1, quotaGiveUpMs: 0 }),
    fetchFn: async () => ({ status: 200, text: async () => '{}' }),
    events: (e) => events.push(e),
    ...(over.toolRoot && { toolRoot: over.toolRoot }),
  };
  const text = (r) => r.content[0].text;
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const wait = (ids, t = 120) => waitAgents({ agent_ids: ids, timeout_seconds: t }, deps).then(text);
  return { repo, github, a, b, deps, events, start, wait, text };
}

// A coordinator needs the cloudy-cloud tool repo (like withTool in run-subagent.test.mjs).
async function withTool(x) {
  const tool = await mkdtemp(join(tmpdir(), 'cc-tool-'));
  await sh(tool, 'git init -q -b main && git config user.name t && git config user.email t@t && mkdir bin');
  await writeFile(join(tool, 'bin', 'cloudy-cloud'), '#!/bin/sh\nexec claude "$@"\n');
  await chmod(join(tool, 'bin', 'cloudy-cloud'), 0o755);
  await sh(tool, 'git add -A && git commit -qm tool && git remote add origin https://github.com/test/tool.git');
  await mkdir(join(x.github, 'test', 'tool.git'));
  await sh(join(x.github, 'test', 'tool.git'), 'git init -q --bare -b main');
  await sh(tool, `git push -q ${join(x.github, 'test', 'tool.git')} main`);
  x.deps.toolRoot = tool;
}

test('quota_exceeded on the primary fails over at once and the result says where it started', async () => {
  const { a, b, events, start, wait } = await setup();
  const errs = [];
  const orig = console.error;
  console.error = (...x) => errs.push(x.join(' '));
  try {
    a.create = async () => { throw err('quota_exceeded', 'machine limit'); };
    const r = await wait([await start()]);
    assert.match(r, /status: idle[^]*hello/);
    assert.equal(b.log.create.length, 1);
    assert.equal(a.log.create.length, 0);
    assert.match(r, /\nStarted on b because a could not start it \(quota_exceeded: machine limit\)\.\n/);
    assert.ok(events.some((e) => e.text === 'a could not start a machine (quota_exceeded); trying b'), JSON.stringify(events));
    assert.equal(events.find((e) => e.type === 'machine').provider, 'b');
  } finally { console.error = orig; }
  assert.ok(errs.some((l) => /\[cloudy-cloud\] agent [0-9a-f]{8}: a -> b \(quota_exceeded\)/.test(l)), errs.join('\n'));
});

test('rate_limited fails over at once, without the queue backoff', async () => {
  const { a, b, start, wait } = await setup();
  let calls = 0;
  a.create = async () => { calls++; throw err('rate_limited', 'slow down'); };
  const r = await wait([await start()]);
  assert.match(r, /Started on b because a could not start it \(rate_limited: slow down\)\./);
  assert.equal(calls, 1, 'the rate limit error did not send the agent back to the queue');
  assert.equal(b.log.create.length, 1);
});

test('a transient create response adopts the single matching machine and never launches another provider', async () => {
  const { a, b, start, wait } = await setup();
  const create = a.create.bind(a);
  a.create = async (opts) => { await create(opts); throw err('transient', 'response lost'); };
  const r = await wait([await start()]);
  assert.match(r, /Recovered the existing machine on a after an uncertain create response/);
  assert.equal(a.log.create.length, 1);
  assert.equal(a.log.connect.length, 1);
  assert.equal(b.log.create.length, 0);
});

test('no_key fails over to the next provider', async () => {
  const a = createFakeProvider({}, { name: 'a' }); // no FAKE_API_KEY: every adapter call throws no_key
  const { b, start, wait } = await setup({ a });
  const r = await wait([await start()]);
  assert.match(r, /Started on b because a could not start it \(no_key: FAKE_API_KEY is not set\.\)\./);
  assert.equal(b.log.create.length, 1);
});

test('a network failure without a code fails closed when no machine can be confirmed', async () => {
  const { a, b, start, wait } = await setup();
  a.create = async () => { throw new TypeError('fetch failed'); };
  const r = await wait([await start()]);
  assert.match(r, /uncertain create and no matching machine could be confirmed/);
  assert.ok(a.log.list.length > 0, 'the failed provider was checked for leaked machines');
  assert.equal(b.log.create.length, 0, 'an uncertain create never starts a second machine');
});

test('a transient create does not fall back when reconciliation itself fails', async () => {
  const { a, b, start, wait } = await setup();
  a.create = async () => { throw err('transient', 'response lost'); };
  a.list = async () => { throw err('transient', 'list unavailable'); };
  const r = await wait([await start()]);
  assert.match(r, /machines could not be listed; refusing another create/);
  assert.equal(b.log.create.length, 0);
});

test('secret_missing and unknown errors never fail over', async () => {
  const { a, b, start, wait } = await setup();
  let calls = 0;
  a.create = async () => { calls++; throw err('secret_missing', 'GH_TOKEN is not in your org'); };
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.equal(calls, 1);
  assert.equal(b.log.create.length, 0);
  const x = await setup();
  x.a.create = async () => { throw new Error('totally unexpected'); };
  const r2 = await x.wait([await x.start()]);
  assert.match(r2, /status: failed/);
  assert.match(r2, /totally unexpected/);
  assert.equal(x.b.log.create.length, 0);
});

test('a failure after create returned never starts a second machine', async () => {
  const { a, b, start, wait } = await setup();
  const orig = a.create;
  a.create = async (o) => {
    const s = await orig(o);
    const run = s.commands.run;
    s.commands.run = (cmd, o2) => (cmd.startsWith('gh ') ? Promise.reject(Object.assign(new Error('exit'), { exitCode: 1, stderr: 'gh broken' })) : run(cmd, o2));
    return s;
  };
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.equal(a.log.create.length, 1);
  assert.equal(b.log.create.length, 0, 'no second create once a provider returned a sandbox');
});

test('an uncertain create reconciles the one labeled machine before continuing setup', async () => {
  const { a, b, start, wait } = await setup();
  const create = a.create.bind(a);
  a.create = async (opts) => { await create(opts); throw err('ambiguous', 'create response timed out'); };
  const r = await wait([await start()]);
  assert.match(r, /status: idle[^]*hello/);
  assert.equal(a.log.create.length, 1);
  assert.equal(a.log.connect.length, 1);
  assert.equal(b.log.create.length, 0, 'the second provider is not tried after an uncertain create');
});

test('multiple machines with the same agent label after an uncertain create are refused', async () => {
  const { a, b, start, wait } = await setup();
  const create = a.create.bind(a);
  a.create = async (opts) => { await create(opts); await create(opts); throw err('ambiguous', 'create response timed out'); };
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /multiple machines carry agent/);
  assert.equal(a.log.create.length, 2);
  assert.equal(b.log.create.length, 0, 'ambiguous ownership never starts another worker');
});

test('an egress allowlist skips a provider that cannot enforce it, and refuses only when none can', async () => {
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', hasEgressPolicy: true });
  const { a, start, wait } = await setup({ b, env: { CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' } });
  const r = await wait([await start()]);
  assert.match(r, /Started on b because a cannot run this request \(CLOUDY_CLOUD_EGRESS_ALLOW is set, but provider a cannot limit where a machine connects, so the agent was not started\.\)\./);
  assert.equal(b.log.create.length, 1);
  assert.deepEqual(b.log.create[0].egress.allow, ['github.com', 'api.github.com', 'api.anthropic.com', 'example.com']);
  assert.equal(a.log.create.length, 0);
  // No capable provider at all: today's refusal, unchanged.
  const x = await setup({ env: { CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' } });
  const r2 = await runSubagent({ description: 'd', prompt: 'hi' }, x.deps);
  assert.equal(r2.isError, true);
  assert.ok(x.text(r2).startsWith('CLOUDY_CLOUD_EGRESS_ALLOW is set, but provider a cannot limit where a machine connects, so the agent was not started.\nNext step: remove CLOUDY_CLOUD_EGRESS_ALLOW from ~/.config/cloudy-cloud/env to run without an egress limit, or set CLOUDY_CLOUD_PROVIDER=microsandbox to run agents in local microVMs that enforce it, then call cloud_agent again.'), x.text(r2));
  assert.equal(x.a.log.create.length + x.b.log.create.length, 0);
});

test('a machine kind the primary lacks runs on the provider that offers it', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a', machineKinds: ['linux'] });
  const { b, start, wait } = await setup({ a, env: { CLOUDY_CLOUD_ALLOW_MACHINE_KINDS: 'gpu' } });
  const r = await wait([await start({ machine: 'gpu' })]);
  assert.equal(b.log.create.length, 1);
  assert.equal(b.log.create[0].kind.name, 'gpu');
  assert.equal(a.log.create.length, 0);
  assert.match(r, /Started on b because a cannot run this request \(What happened: The provider a cannot start a gpu machine \(it offers: linux\)\.\)\./);
});

test('a provider with a full known machine cap is skipped promptly for a secondary with capacity', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a', plan: { tier: 'a', specs: [], startsPerMinute: 10, maxRunning: 1, maxMachines: 10 } });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', plan: { tier: 'b', specs: [], startsPerMinute: 10, maxRunning: 10, maxMachines: 20 } });
  a.machines.set('a-existing', { id: 'a-existing', labels: { purpose: 'cloudy-cloud' }, state: 'running', status: 'running', startedAt: Date.now() });
  const provider = combine([a, b]);
  const x = await setup({ a, b, provider, env: { CLOUDY_CLOUD_STARTS_PER_MIN: '20' } });
  x.deps.queue = startQueue(x.deps.env, provider, () => x.deps.open.values(), { sleep: async () => {} });
  await x.deps.queue.learnPlan();
  const r = await x.wait([await x.start()]);
  assert.equal(a.log.create.length, 0, 'the known-full primary is never asked to create');
  assert.equal(b.log.create.length, 1);
  assert.match(r, /Started on b/);
});

test('a provider at its own start-rate limit is skipped when another candidate has a slot', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a', plan: { tier: 'a', specs: [], startsPerMinute: 1, maxRunning: 10, maxMachines: 20 } });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', plan: { tier: 'b', specs: [], startsPerMinute: 10, maxRunning: 10, maxMachines: 20 } });
  const provider = combine([a, b]);
  const x = await setup({ a, b, provider, env: { CLOUDY_CLOUD_STARTS_PER_MIN: '20' } });
  x.deps.queue = startQueue(x.deps.env, provider, () => x.deps.open.values(), { sleep: async () => {} });
  await x.deps.queue.learnPlan();
  const first = await x.start();
  await x.wait([first]);
  const second = await x.start();
  const r = await x.wait([second]);
  assert.equal(a.log.create.length, 1, 'the primary plan allows only one start in the window');
  assert.equal(b.log.create.length, 1, 'the secondary serves the start-rate overflow');
  assert.match(r, /Started on b/);
});

test('size admission accepts a size offered by a secondary provider', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a', plan: { tier: 'a', specs: [{ vcpus: 2, memMiB: 4096 }], startsPerMinute: 10, maxRunning: 10 } });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', plan: { tier: 'b', specs: [{ vcpus: 4, memMiB: 8192 }], startsPerMinute: 10, maxRunning: 10 } });
  const x = await setup({ a, b });
  const r = await x.wait([await x.start({ size: '4x8' })]);
  assert.equal(a.log.create.length, 0);
  assert.equal(b.log.create.length, 1);
  assert.match(r, /Started on b/);
});

test('a definitive primary size refusal falls through to a provider that offers the requested size', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a', plan: null });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', plan: { tier: 'b', specs: [{ vcpus: 4, memMiB: 8192 }], startsPerMinute: 10, maxRunning: 10 } });
  let primaryAttempts = 0;
  a.create = async () => { primaryAttempts++; throw Object.assign(new Error('size rejected'), { code: 'size_not_allowed' }); };
  const provider = combine([a, b]);
  const x = await setup({ a, b, provider });
  const r = await x.wait([await x.start({ size: '4x8' })]);
  assert.equal(primaryAttempts, 1, 'the primary refusal is definite and happens before machine acceptance');
  assert.equal(b.log.create.length, 1);
  assert.match(r, /Started on b/);
});

test('a turn limit rejected by the primary remains available on a provider with a longer TTL', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a' });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b' });
  a.caps.maxTtlSeconds = 3600;
  b.caps.maxTtlSeconds = 86_400;
  const x = await setup({ a, b, env: { CLOUDY_CLOUD_TURN_MINUTES: '60' } });
  const r = await x.wait([await x.start()]);
  assert.equal(a.log.create.length, 0);
  assert.equal(b.log.create.length, 1);
  assert.match(r, /Started on b/);
});

test('a coordinator lands on the provider that does not refuse coordinators', async () => {
  const x = await setup();
  x.a.text.coordinatorRefusal = 'Coordinators are not supported on a yet.';
  await withTool(x);
  const r = await x.wait([await x.start({ role: 'coordinator' })]);
  assert.equal(x.a.log.create.length, 0);
  assert.equal(x.b.log.create.length, 1);
  assert.equal(x.b.log.create[0].role, 'coordinator');
  assert.match(r, /Started on b because a cannot run this request \(Coordinators are not supported on a yet\.\)\./);
});

test('failover never crosses secret models: a proxy provider does not move to a token-on-machine provider', async () => {
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', hasProxySecrets: false, hasConsentedSecrets: true });
  const { a, start, wait } = await setup({ b });
  a.create = async () => { throw err('quota_exceeded', 'machine limit'); };
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /machine limit is reached/);
  assert.equal(b.log.create.length, 0, 'the provider with a different secret model was never tried');
  assert.doesNotMatch(r, /Started on b|Providers tried/);
});

test('candidate filtering cannot switch a proxy-selected request to a consented on-box provider', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'a' });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b', hasProxySecrets: false, hasConsentedSecrets: true });
  a.caps.hasSizes = false;
  const provider = combine([a, b]);
  const x = await setup({ a, b, provider });
  const r = await runSubagent({ description: 'd', prompt: 'hi', size: '4x8' }, x.deps);
  assert.equal(r.isError, true);
  assert.match(x.text(r), /size is not available: the a provider has one machine size/);
  assert.equal(a.log.create.length, 0);
  assert.equal(b.log.create.length, 0, 'the on-box credential mode is not selected after provider filtering');
});

test('a smaller fallback upload cap does not block the primary and is excluded when the bundle exceeds its cap', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'primary' });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'small-fallback' });
  a.caps.uploadMaxBytes = 8 * 1024 * 1024;
  b.caps.uploadMaxBytes = 5 * 1024 * 1024;
  const x = await setup({ a, b });
  const sha = await sh(x.repo, 'git rev-parse HEAD');
  const bundleSize = 6 * 1024 * 1024;
  let acquiredMax;
  x.deps.snapshots = {
    async acquire(_root, _head, _snapshot, max) {
      acquiredMax = max;
      if (bundleSize > max) throw new Error(`The uncommitted/unpushed changes are too large to upload (${bundleSize} bytes, limit ${max}). Push the branch to GitHub first, then start the agent again.`);
      return { sha, size: bundleSize, prereqs: [], read: async () => undefined, release: async () => {} };
    },
  };
  a.create = async (opts) => { a.log.create.push(opts); throw err('quota_exceeded', 'machine limit'); };
  const id = await x.start();
  const r = await x.wait([id]);
  assert.equal(acquiredMax, 7 * 1024 * 1024, 'prepare for the largest candidate, less the existing safety margin');
  assert.equal(a.log.create.length, 1, 'try the primary that can accept this bundle');
  assert.equal(b.log.create.length, 0, 'do not send a bundle larger than the fallback upload cap');
  assert.ok(x.deps.open.get(id).skipped.some((s) => s.name === 'small-fallback' && /upload limit/.test(s.why)));
});

test('a localSecrets provider can validate a named profile after a proxy-only provider rejects its real key', async () => {
  const a = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'proxy-only' });
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'local-secrets' });
  b.caps.localSecrets = true;
  const { deps, start, wait } = await setup({ a, b, env: {
    OPENAI_API_KEY: 'synthetic-openai-key',
    CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY',
  } });
  const profileDir = await mkdtemp(join(tmpdir(), 'cc-routing-profiles-'));
  const profilePath = join(profileDir, 'profiles.json');
  await writeFile(profilePath, JSON.stringify({ local: {
    harness: 'claude', format: 'anthropic', baseUrl: 'https://api.example.test', model: 'claude-3-7-sonnet-latest', keyName: 'OPENAI_API_KEY',
  } }));
  deps.env.CLOUDY_CLOUD_PROFILES = profilePath;
  try {
    const id = await start({ profile: 'local' });
    assert.ok(id, 'the profile should be accepted by the localSecrets candidate');
    const r = await wait([id]);
    assert.match(r, /Started on local-secrets because proxy-only cannot run this request/);
    assert.equal(a.log.create.length, 0);
    assert.equal(b.log.create.length, 1);
    assert.ok(b.log.create[0].secrets.includes('OPENAI_API_KEY'));
    assert.equal(b.log.create[0].envs.OPENAI_API_KEY, undefined, 'the value is represented only by its local secret name');
  } finally { await rm(profileDir, { recursive: true, force: true }); }
});

test('a plain key skips a proxy provider for a localSecrets one, and its value never reaches a machine', async () => {
  const b = createFakeProvider({ FAKE_API_KEY: 'k' }, { name: 'b' });
  b.caps.localSecrets = true; // like microsandbox: local values are attached by name
  const { a, start, wait } = await setup({ b, env: { CLOUDY_CLOUD_PROXY_SECRETS: undefined } });
  const r = await wait([await start()]);
  assert.match(r, /Started on b because a cannot run this request \(ANTHROPIC_API_KEY is set as a real value, not as a proxy secret\.\)\./);
  assert.equal(a.log.create.length, 0, 'the proxy provider never got a create');
  assert.equal(b.log.create.length, 1);
  assert.ok(b.log.create[0].secrets.includes('ANTHROPIC_API_KEY'), 'attached as a secret name');
  assert.ok(!('ANTHROPIC_API_KEY' in b.log.create[0].envs), 'the value is not an env var');
  assert.ok(!JSON.stringify([a.log, b.log]).includes(SECRET), 'the key value reached a machine');
});

test('when every provider is out of machines the guided text names Providers tried', async () => {
  const { a, b, start, wait } = await setup();
  a.create = async () => { throw err('quota_exceeded', 'a is full'); };
  b.create = async () => { throw err('quota_exceeded', 'b is full'); };
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /machine limit is reached/);
  assert.match(r, /Providers tried: a \(quota_exceeded: a is full\), b \(quota_exceeded: b is full\)/, r);
});

test('stop, publishPort, metrics and list act on the provider that ran the machine', async () => {
  const { a, b, deps, start, wait, text } = await setup();
  a.create = async () => { throw err('quota_exceeded', 'machine limit'); };
  const id = await start({ preview_port: 3000, prompt: 'EDIT' });
  const r = await wait([id]);
  assert.match(r, /Preview: https:\/\/fake\.example\/b-1\/3000/);
  assert.deepEqual(b.log.ports.map((p) => p.op), ['publish']);
  assert.deepEqual(a.log.ports, []);
  const out = text(await listAgents({}, deps));
  assert.match(out, /provider b/);
  assert.ok(b.log.metrics.length > 0, 'usage is read on b');
  assert.equal(a.log.metrics.length, 0);
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(b.machines.size, 0, 'the sandbox on b was killed');
});

test('src/run-subagent.mjs keeps no ctx.provider.caps admission reads (capability checks go through the candidate list)', async () => {
  const src = await readFile(new URL('../src/run-subagent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /ctx\.provider\??\.caps/, 'ctx.provider(.?)caps read left');
  assert.doesNotMatch(src, /(?<![\w$.])provider\.caps/, 'bare provider.caps read left');
});
