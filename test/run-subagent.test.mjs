import './tmp-cleanup.mjs';
import { planSnapshot, planSettled } from '../src/machine.mjs';
import { mcpConfigText } from '../src/mcpsync.mjs';
import { ompModels, ompConfig } from '../src/profiles.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, access, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStartQueue } from '../src/limits.mjs';
import { installId } from '../src/config.mjs';
import { resetPreflightCache } from '../src/profiles.mjs';
import { fakeSandbox, setGithub, getGithub, SID, createFakeProvider } from './fake-provider.mjs';
import { buildServer } from '../src/mcp.mjs';
import { liveState } from '../src/dashboard.mjs';
import { answeredProfiles, startQueue, sharedQueue, runSubagent, explainSubagent, messageAgent, waitAgents, resultAgent, listAgents, stopAgents, killAll, getTask, cancelTask, secretValues } from '../src/run-subagent.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const SECRET = 'sk-test-secret-123';

const ORIGIN = 'https://github.com/test/repo.git';
async function setup(over = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t');
  await writeFile(join(repo, 'a.txt'), 'orig\n');
  await sh(repo, 'git add -A && git commit -qm init');
  if (over.origin !== null) await exec('git', ['remote', 'add', 'origin', over.origin ?? ORIGIN], { cwd: repo });
  // A local bare repo stands in for GitHub: the fake sandbox rewrites https://github.com/ to it.
  const github = await mkdtemp(join(tmpdir(), 'cc-github-'));
  const bare = join(github, 'test', 'repo.git');
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${bare}`);
  setGithub(github);
  const created = [];
  const createSandbox = over.createSandbox ?? (async (envs) => { const s = await fakeSandbox(github); s.envs = envs; created.push(s); return s; });
  const open = new Map();
  // The default fake has no proxy secrets, so the real Claude key in the default env is delivered by value (the self-hosted path). A provider with
  // proxy secrets refuses a real key (#68): tests of that path pass `provider: proxyProvider()` and a CLOUDY_CLOUD_PROXY_SECRETS env.
  const deps = { createSandbox, provider: createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true }), owner: 'testowner', open, tasks: new Map(), cwd: repo, env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret' }, fetchFn: async () => ({ status: 200, text: async () => '{}' }), bundleRemoteRefs: (root) => sh(root, "git for-each-ref --format='%(objectname)' refs/remotes/origin"), /* preflight must never reach the network */ ...over };
  const text = (r) => r.content[0].text;
  // start an agent, return its id
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  // Returns as soon as the agents finish; the long default only matters on a loaded machine.
  const wait = (ids, t = 120) => waitAgents({ agent_ids: ids, timeout_seconds: t }, deps).then(text);
  const msg = (id, message) => messageAgent({ agent_id: id, message }, deps);
  const stop = (ids) => stopAgents({ agent_ids: ids }, deps).then(text);
  const remote = (cmd) => sh(bare, cmd); // run git in the bare "GitHub" repo
  const rejectPushes = (on) => writeFile(join(bare, 'hooks', 'pre-receive'), on ? '#!/bin/sh\necho "remote: denied by test" >&2\nexit 1\n' : '#!/bin/sh\nexit 0\n').then(() => chmod(join(bare, 'hooks', 'pre-receive'), 0o755));
  return { repo, bare, github, created, open, deps, start, wait, msg, stop, text, remote, rejectPushes };
}
const proxyProvider = () => createFakeProvider();
const PROXY_ENV = { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY' }; // the Claude key is a proxy secret, as on Instabox
const refs = (repo) => sh(repo, 'git for-each-ref');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('explain shares local eligibility checks and reports dynamic checks without contacting providers', async () => {
  let creates = 0, plans = 0, preflights = 0, lists = 0;
  const f = await setup({
    createSandbox: async () => { creates++; throw new Error('explain must not create'); },
    fetchFn: async () => { preflights++; throw new Error('explain must not preflight'); },
  });
  const provider = f.deps.provider;
  const plan = provider.plan;
  const list = provider.list;
  provider.plan = async (...args) => { plans++; return plan(...args); };
  provider.list = async (...args) => { lists++; return list(...args); };
  const result = await explainSubagent({ description: 'preview', prompt: 'hi' }, f.deps);
  const data = result.structuredContent;
  assert.equal(data.status, 'conditional');
  assert.deepEqual(data.eligible_providers.map((p) => p.name), [provider.name]);
  assert.deepEqual(data.rejected_providers, []);
  assert.ok(data.unknown_checks.length > 0);
  assert.equal(creates, 0);
  assert.equal(plans, 0);
  assert.equal(preflights, 0);
  assert.equal(lists, 0);
  assert.equal(f.deps.count?.started ?? 0, 0);
  assert.equal(f.deps.open.size, 0);
});

test('explain does not send the billed profile preflight request', async () => {
  let fetches = 0;
  const f = await setup({
    env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: 'pk-explain-test', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' },
    fetchFn: async () => { fetches++; return { status: 200, text: async () => '{}' }; },
  });
  const result = await explainSubagent({ description: 'preview', prompt: 'hi', profile: 'pi-glm' }, f.deps);
  assert.equal(result.structuredContent.status, 'conditional');
  assert.ok(result.structuredContent.unknown_checks.some((c) => c.includes('preflight')));
  assert.equal(fetches, 0, 'explain must not send the one-token preflight request');
});

test('explain reports locally known launch exclusions using the same request validation', async () => {
  const f = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_ALLOW_MACHINE_KINDS: '' } });
  const result = await explainSubagent({ description: 'preview', prompt: 'hi', machine: 'not-a-machine' }, f.deps);
  assert.equal(result.structuredContent.status, 'ineligible');
  assert.match(result.structuredContent.message, /not a known kind/i);
  assert.equal(f.created.length, 0);
  assert.equal(f.deps.open.size, 0);
});

test('cloud_agent_explain is registered as read-only and leaves the server start state untouched', async () => {
  const f = await setup();
  const server = buildServer(f.deps);
  const call = (name, args) => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, { mcpReq: { requestState: () => undefined } });
  const listed = (await server._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} })).tools;
  const tool = listed.find((x) => x.name === 'cloud_agent_explain');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, ['prompt', 'description']);
  const explained = await call('cloud_agent_explain', { prompt: 'hi', description: 'preview' });
  assert.equal(explained.structuredContent.status, 'conditional');
  assert.equal(f.deps.count.started, 0);
  assert.equal(f.deps.open.size, 0);
  assert.equal(f.deps.tasks.size, 0);
  const capabilities = await call('cloud_agent_capabilities', {});
  assert.equal(capabilities.structuredContent.providers[0].readiness, 'local_configuration_only');
  assert.ok(capabilities.structuredContent.providers[0].unknown_checks.includes('provider reachability'));
});

test('cloud_exec streams ordered MCP progress updates and redacts split secrets before the final result', async () => {
  const f = await setup();
  const server = buildServer({ ...f.deps, executeRemoteArgv: async (_argv, deps) => {
    await deps.stdout('before sk-test-secret-');
    assert.ok(updates.some((x) => x.params.message === '[stdout] before '), 'short ordinary output should not wait for the longest configured credential');
    await deps.stdout('123 after\n');
    await deps.stderr('warning\n');
    return { status: 'completed', exit_code: 0, stdout: `before ${SECRET} after\n`, stderr: 'warning\n' };
  } });
  const updates = [];
  const call = server._requestHandlers.get('tools/call');
  const result = await call({ method: 'tools/call', params: { name: 'cloud_exec', arguments: { argv: ['printf', 'x'] } } }, {
    mcpReq: { requestState: () => undefined, _meta: { progressToken: 'exec-token' }, notify: async (notification) => updates.push(notification) },
  });
  assert.ok(updates.length >= 2);
  assert.deepEqual(updates.map((x) => x.params.progress), updates.map((_, index) => index + 1));
  assert.ok(updates.every((x) => x.method === 'notifications/progress' && x.params.progressToken === 'exec-token'));
  assert.ok(!JSON.stringify(updates).includes('sk-test'), 'even credential fragments must not cross a progress boundary');
  assert.equal(result.structuredContent.status, 'completed');
});

test('cloud_exec rejects paths outside the MCP-bound repository before execution', async () => {
  const f = await setup();
  let executions = 0;
  const server = buildServer({ ...f.deps, executeRemoteArgv: async () => { executions++; return { status: 'completed' }; } });
  const call = server._requestHandlers.get('tools/call');
  const result = await call({ method: 'tools/call', params: { name: 'cloud_exec', arguments: { argv: ['true'], repo: f.bare } } }, { mcpReq: { requestState: () => undefined } });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.message, /inside the MCP-bound repository/i);
  assert.equal(executions, 0);
});

test('cloud_exec scrubs JSON-escaped spellings of secrets from the final text', async () => {
  // A secret with characters JSON.stringify escapes (a quote, a newline) survives a literal scrub of
  // the serialized result: the text form must redact the escaped spelling too.
  const escaped = 'tok"en\nvalue';
  const f = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', MCP_TEST_TOKEN: escaped } });
  const server = buildServer({ ...f.deps, executeRemoteArgv: async () => ({ status: 'completed', exit_code: 0, stdout: `leak ${escaped} done` }) });
  const call = server._requestHandlers.get('tools/call');
  const result = await call({ method: 'tools/call', params: { name: 'cloud_exec', arguments: { argv: ['x'] } } }, { mcpReq: { requestState: () => undefined } });
  const text = result.content[0].text;
  assert.ok(!text.includes('tok'), `the serialized text leaked the escaped secret: ${text}`);
  assert.ok(text.includes('[redacted]'));
  assert.ok(!result.structuredContent.stdout.includes('tok'));
});

test('cloud_exec does not send MCP progress without a progress token', async () => {
  const f = await setup();
  let suppliedCallbacks = false, notices = 0;
  const server = buildServer({ ...f.deps, executeRemoteArgv: async (_argv, deps) => {
    suppliedCallbacks = !!deps.stdout || !!deps.stderr;
    return { status: 'completed', exit_code: 0 };
  } });
  const call = server._requestHandlers.get('tools/call');
  await call({ method: 'tools/call', params: { name: 'cloud_exec', arguments: { argv: ['true'] } } }, {
    mcpReq: { requestState: () => undefined, notify: async () => { notices++; } },
  });
  assert.equal(suppliedCallbacks, false);
  assert.equal(notices, 0);
});

test('cloud_exec refreshes the environment before routing', async () => {
  const f = await setup();
  const order = [];
  const server = buildServer({ ...f.deps, refreshEnv: () => order.push('refresh'), executeRemoteArgv: async () => { order.push('exec'); return { status: 'completed', exit_code: 0 }; } });
  const call = server._requestHandlers.get('tools/call');
  await call({ method: 'tools/call', params: { name: 'cloud_exec', arguments: { argv: ['true'] } } }, { mcpReq: { requestState: () => undefined } });
  assert.deepEqual(order, ['refresh', 'exec'], 'cloud_exec must refresh the environment before it routes');
});

test('start returns at once with starting, before the sandbox exists', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, text } = await setup({ createSandbox: async () => { await gate; return fakeSandbox(); } });
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.match(text(r), /agent_id: [0-9a-f]{8}\nstatus: starting/);
  assert.equal([...deps.open.values()][0].status, 'starting');
  release();
});

test('cancelling while provider create is pending releases the shared disk snapshot', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { start, stop, deps } = await setup({ createSandbox: async () => { await gate; return fakeSandbox(); } });
  const id = await start();
  for (let i = 0; i < 50 && !deps.snapshots?.size; i++) await tick(10);
  assert.equal(deps.snapshots?.size, 1, 'bundle preparation finished before the provider create');
  await stop([id]);
  release();
  for (let i = 0; i < 50 && deps.snapshots?.size; i++) await tick(10);
  assert.equal(deps.snapshots?.size, 0, 'cancelled setup releases the bundle and its temporary directory');
});

test('stop waits for setup to settle after a sandbox handle arrives', async () => {
  let sandbox, beginSetup, releaseSetup;
  const setupStarted = new Promise((resolve) => { beginSetup = resolve; });
  const setupGate = new Promise((resolve) => { releaseSetup = resolve; });
  const { start, open, deps } = await setup({
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = async (cmd, opts) => {
        if (cmd.includes('git init -q repo')) { beginSetup(); await setupGate; }
        return run(cmd, opts);
      };
      return sandbox;
    },
  });
  const id = await start();
  await setupStarted;
  const stopping = stopAgents({ agent_ids: [id] }, deps);
  await tick(10);
  const killedBeforeSetupSettled = sandbox.killed;
  releaseSetup();
  await stopping;
  assert.equal(killedBeforeSetupSettled, false, 'deletion waits for the setup promise even after create returns a handle');
  assert.equal(sandbox.killed, true);
  assert.equal(open.has(id), false);
});

test('concurrent public starts with the same repo prepare one shared snapshot', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let creates = 0;
  const { wait, deps } = await setup({ createSandbox: async () => { creates++; await gate; return fakeSandbox(); } });
  const server = buildServer(deps);
  const call = (name, args) => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, { mcpReq: { requestState: () => undefined } });
  const launch = async () => (await call('cloud_agent', { description: 'd', prompt: 'hi' })).content[0].text.match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const first = await launch();
  const second = await launch();
  for (let i = 0; i < 100 && creates < 2; i++) await tick(10);
  assert.equal(creates, 2, 'both public starts reached provider creation after snapshot preparation');
  assert.equal(deps.snapshots.preparations, 1, 'the server shares equivalent snapshots across tool calls');
  assert.equal(deps.snapshots.size, 1);
  release();
  await wait([first, second]);
  assert.equal(deps.snapshots.size, 0, 'the shared bundle is removed after both setups finish');
});

test('the configured default worker profile applies when omitted and an explicit profile wins', async () => {
  const f = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: 'synthetic-particle-key', CLOUDY_CLOUD_DEFAULT_PROFILE: 'pi-glm' } });
  const defaultId = await f.start({ prompt: 'OK default profile' });
  assert.equal(f.open.get(defaultId).profile.name, 'pi-glm');
  const explicitId = await f.start({ prompt: 'OK explicit profile', profile: 'pi-particle' });
  assert.equal(f.open.get(explicitId).profile.name, 'pi-particle');
  await f.wait([defaultId, explicitId]);
  await f.stop([defaultId, explicitId]);
});

test('an explicit built-in Claude profile overrides a saved named profile default', async () => {
  const f = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_DEFAULT_PROFILE: 'codex' } });
  delete f.deps.createSandbox;
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'claude' }, f.deps);
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  const id = r.content[0].text.match(/agent_id: ([0-9a-f]{8})/)?.[1];
  assert.ok(id, r.content[0].text);
  await f.wait([id]);
  assert.equal(f.deps.provider.log.create[0].labels.profile, 'claude');
  assert.equal(f.deps.open.get(id).profile, undefined, 'built-in Claude is selected without resolving a named profile');
});

test('an agent writes its events (task, machine, reply, status) with keys redacted', async () => {
  const events = [];
  const { start, wait, msg, stop } = await setup({ events: (e) => events.push(e) });
  const id = await start({ prompt: `use ${SECRET} please`, description: 'label' });
  await wait([id]);
  await msg(id, 'again');
  await wait([id]);
  await stop([id]);
  const types = events.map((e) => e.type);
  for (const t of ['agent', 'message', 'machine', 'status', 'reply']) assert.ok(types.includes(t), t);
  assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['use [redacted] please', 'again']);
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.equal(events.find((e) => e.type === 'agent').branch, `cloudy-cloud/${id}`);
  assert.equal(events.at(-1).status, 'stopped');
});

test('startup phase timings use monotonic durations and appear in events and the completed result', async () => {
  const events = [];
  const f = await setup({ events: (e) => events.push(e) });
  const id = await f.start();
  await f.wait([id]);
  const timings = f.deps.open.get(id).result.startup_timings;
  for (const phase of ['queue_wait', 'repo_preparation', 'provider_creation', 'upload', 'harness_startup', 'first_tool_call']) {
    assert.equal(typeof timings[phase].status, 'string', phase);
    if (timings[phase].status === 'unavailable') assert.equal(timings[phase].duration_ms, null, phase);
    else assert.ok(Number.isFinite(timings[phase].duration_ms) && timings[phase].duration_ms >= 0, phase);
  }
  assert.ok(events.some((e) => e.type === 'startup_timing' && e.phase === 'repo_preparation'));
  const result = await resultAgent({ agent_id: id }, f.deps);
  assert.deepEqual(result.structuredContent.startup_timings, timings);

  const failed = await setup({ createSandbox: async () => { throw new Error('synthetic create failure'); } });
  const failedId = await failed.start();
  await failed.wait([failedId]);
  const failedTimings = failed.deps.open.get(failedId).result.startup_timings;
  assert.equal(failedTimings.provider_creation.status, 'failed');
  assert.ok(Number.isFinite(failedTimings.provider_creation.duration_ms));
  for (const phase of ['upload', 'harness_startup', 'first_tool_call']) {
    assert.deepEqual(failedTimings[phase], { duration_ms: null, status: 'unavailable' }, phase);
  }
});

test('offline cold and in-flight snapshot-cache warm starts report measured timings', async () => {
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    let creates = 0, release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fixture = await setup({ createSandbox: async (envs) => { creates++; await gate; const s = await fakeSandbox(getGithub()); s.envs = envs; return s; } });
    const first = await fixture.start({ profile: 'claude' });
    while (creates < 1) await tick(1);
    const second = await fixture.start({ profile: 'claude' });
    while (creates < 2) await tick(1);
    release();
    await fixture.wait([first, second]);
    const cold = fixture.deps.open.get(first).result.startup_timings;
    const warm = fixture.deps.open.get(second).result.startup_timings;
    samples.push({ cold_repo_preparation_ms: cold.repo_preparation.duration_ms, warm_repo_preparation_ms: warm.repo_preparation.duration_ms,
      cold_upload_ms: cold.upload.duration_ms, warm_upload_ms: warm.upload.duration_ms,
      cold_provider_creation_ms: cold.provider_creation.duration_ms, warm_provider_creation_ms: warm.provider_creation.duration_ms });
    await fixture.stop([first, second]);
  }
  console.log(`offline snapshot-cache timing samples (n=${samples.length} cold/warm pairs; same repo and claude profile per pair; fake provider/harness): ${JSON.stringify(samples)}`);
  assert.equal(samples.length, 3);
  for (const sample of samples) for (const value of Object.values(sample)) assert.ok(Number.isFinite(value) && value >= 0);
});

test('secretValues drops empty and shorter-than-4 values, so exact scrubbing cannot mangle the text', () => {
  const vals = secretValues({ ANTHROPIC_API_KEY: 'x', MCP_X_TOKEN: 'ab', GH_TOKEN: 'real-token-1' }, 'FAKE_API_KEY', ['', 'ab', 'literal-value-1']);
  assert.ok(vals.includes('real-token-1'));
  assert.ok(vals.includes('literal-value-1'));
  for (const v of vals) assert.ok(v.length >= 4, JSON.stringify(v));
});

test('an agent description containing a secret is logged scrubbed', async () => {
  const events = [];
  const { start } = await setup({ events: (e) => events.push(e) });
  await start({ description: `deploy with ${SECRET}` });
  assert.equal(events.find((e) => e.type === 'agent').description, 'deploy with [redacted]');
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test('a follow-up message echoing the preview link is redacted in the logged event; the reply never logs it either', async () => {
  const events = [];
  const { start, wait, msg, open } = await setup({ events: (e) => events.push(e) });
  const id = await start({ prompt: 'EDIT', preview_port: 3000 });
  const r = await wait([id]);
  const url = open.get(id).previewUrl;
  assert.ok(url, 'a preview link was published');
  assert.match(r, new RegExp(`Preview: ${url}`), 'the result to the caller carries the link');
  const reply = events.filter((e) => e.type === 'reply').at(-1);
  assert.ok(!reply.text.includes(url), 'the logged reply does not carry the preview link');
  await msg(id, `is the app still up at ${url}?`);
  await wait([id]);
  const sent = events.filter((e) => e.type === 'message').at(-1);
  assert.ok(sent.text.includes('a private preview link was returned to the caller'), sent.text);
  assert.ok(!sent.text.includes(url), 'the logged message does not carry the preview link');
});

test('the machine event records when the server deletes the machine', async () => {
  const events = [];
  const { start, wait } = await setup({ events: (e) => events.push(e) });
  const id = await start();
  await wait([id]);
  assert.ok(events.find((e) => e.type === 'machine').deleteAt > Date.now());
});

test('wait returns the result once, then marks it reported; agent stays open', async () => {
  const { start, wait, created, open, deps } = await setup();
  const id = await start({ prompt: 'hi' });
  const first = await wait([id]);
  assert.match(first, /status: idle/);
  assert.match(first, /hello/);
  assert.match(first, /No changes, no branch pushed/);
  const second = await wait([id]);
  assert.match(second, /already delivered; call cloud_agent_result/);
  assert.doesNotMatch(second, /hello/);
  const again = (await resultAgent({ agent_id: id }, deps)).content[0].text;
  assert.match(again, /hello/);
  assert.match((await resultAgent({ agent_id: id }, deps)).content[0].text, /hello/);
  const gone = await resultAgent({ agent_id: 'nope' }, deps);
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /Next step: .*cloud_agent_list/);
  assert.equal(created[0].killed, false);
  assert.ok(open.has(id));
});

test('wait times out while an agent is still running and reports running', async () => {
  const { start, wait } = await setup();
  const id = await start({ prompt: 'SLOW' });
  const t0 = Date.now();
  const r = await wait([id], 0.1);
  assert.ok(Date.now() - t0 < 5000); // returned long before the 0.5 s turn ended, with room for a loaded machine
  assert.match(r, /status: (starting|running)/);
  assert.match(await wait([id]), /slow done/);
});

test('parallel starts all create sandboxes at once, and wait covers all', async () => {
  let inFlight = 0, peak = 0;
  const { start, wait } = await setup({
    // Hold each create until all five are in flight (or 3 s pass), so the check does not depend on timing.
    createSandbox: async () => {
      peak = Math.max(peak, ++inFlight);
      for (let waited = 0; peak < 5 && waited < 3000; waited += 20) await tick(20);
      inFlight--;
      return fakeSandbox();
    },
  });
  const ids = await Promise.all([1, 2, 3, 4, 5].map(() => start()));
  assert.equal(new Set(ids).size, 5);
  const r = await wait(ids);
  assert.equal(r.match(/status: idle/g).length, 5);
  assert.equal(peak, 5);
});

test('quota_exceeded keeps the agent queued, then it starts when capacity frees', async () => {
  let n = 0;
  const { start, wait, text, deps } = await setup({
    queue: createStartQueue({ quotaRetryMs: 60, quotaGiveUpMs: 10_000 }),
    createSandbox: async () => {
      if (n++ < 3) throw Object.assign(new Error('machine limit'), { code: 'quota_exceeded' });
      return fakeSandbox();
    },
  });
  const id = await start();
  for (let i = 0; i < 100 && deps.open.get(id).status !== 'queued'; i++) await tick(10);
  assert.match(text(await listAgents({}, deps)), /queued/);
  assert.match(await wait([id]), /status: idle[^#]*hello/);
  assert.equal(n, 4);
});

test('quota_exceeded that never clears fails the agent after the give-up time, with the provider message', async () => {
  const { start, wait, msg } = await setup({
    queue: createStartQueue({ quotaRetryMs: 5, quotaGiveUpMs: 20 }),
    createSandbox: async () => { throw Object.assign(new Error('machine limit'), { code: 'quota_exceeded' }); },
  });
  const bad = await start();
  const r = await wait([bad]);
  assert.match(r, new RegExp(`## ${bad}[^#]*status: failed[^#]*machine limit is reached[^#]*Provider message: machine limit`));
  assert.equal((await msg(bad, 'x')).isError, true);
});

test('rate_limited create is reported as the start rate', async () => {
  const { start, wait } = await setup({
    queue: createStartQueue({ sleep: async () => {} }),
    createSandbox: async () => { throw Object.assign(new Error('slow down'), { code: 'rate_limited' }); },
  });
  assert.match(await wait([await start()]), /limiting how fast[\s\S]*Still limited after 5 tries/);
});

test('message to a busy agent is rejected, not queued', async () => {
  const { start, wait, msg, text } = await setup();
  const id = await start({ prompt: 'SLOW' });
  const r = await msg(id, 'hi');
  assert.equal(r.isError, true);
  assert.match(text(r), /still working/);
  await wait([id]);
});

test('stop kills several sandboxes, forgets them, and is idempotent; message after stop errors', async () => {
  const { start, wait, msg, stop, created, open, text } = await setup();
  const ids = [await start(), await start()];
  await wait(ids);
  const out = await stop([...ids, 'deadbeef']);
  assert.match(out, /deadbeef: not open/);
  assert.ok(created.every((c) => c.killed));
  assert.equal(open.size, 0);
  assert.match(await stop(ids), /not open/);
  const r = await msg(ids[0], 'hi');
  assert.equal(r.isError, true);
  assert.match(text(r), /not open/);
  assert.match(await wait([ids[0]], 0.05), /status: stopped/);
});

test('a rejected stop stays tracked and blocks messages until a retry deletes the machine', async () => {
  let killCalls = 0;
  let beganKill, failKill;
  const killStarted = new Promise((resolve) => { beganKill = resolve; });
  const firstKill = new Promise((_, reject) => { failKill = reject; });
  let sandbox;
  const { start, wait, stop, msg, open } = await setup({
    createSandbox: async (envs) => {
      const s = await fakeSandbox(getGithub());
      s.envs = envs;
      const kill = s.kill;
      s.kill = async () => {
        if (++killCalls === 1) { beganKill(); await firstKill; }
        await kill();
      };
      sandbox = s;
      return s;
    },
  });
  const id = await start();
  await wait([id]);
  const pendingStop = stop([id]);
  await killStarted;
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.match(await wait([id]), new RegExp(`status: stop-pending`));
  assert.equal((await msg(id, 'must not start')).isError, true);
  const concurrentStop = stop([id]);
  await tick(0);
  assert.equal(killCalls, 1, 'concurrent stop calls share one deletion attempt');
  failKill(new Error('temporary delete failure'));
  const [first, concurrent] = await Promise.all([pendingStop, concurrentStop]);
  assert.match(first, /delete failure/i);
  assert.match(concurrent, /delete failure/i);
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.equal(sandbox.killed, false);
  assert.match(await stop([id]), new RegExp(`${id}: stopped`));
  assert.equal(open.has(id), false);
  assert.equal(sandbox.killed, true);
  assert.equal(killCalls, 2);
});

test('a stop after an uncertain create stays pending until exact ownership can be connected', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { name: 'uncertain', hasProxySecrets: false, hasConsentedSecrets: true });
  const create = provider.create.bind(provider);
  const list = provider.list.bind(provider);
  const connect = provider.connect.bind(provider);
  let listUnavailable = true, connectUnavailable = true;
  provider.create = async (opts) => { await create(opts); throw Object.assign(new Error('create response was lost'), { code: 'transient' }); };
  provider.list = async (labels = {}) => {
    if (labels.agent && listUnavailable) throw Object.assign(new Error('provider listing unavailable'), { code: 'transient' });
    return list(labels);
  };
  provider.connect = async (id) => {
    if (connectUnavailable) throw Object.assign(new Error('machine connection unavailable'), { code: 'transient' });
    return connect(id);
  };
  const createSandbox = (envs, options, labels, p) => p.create({
    envs, labels: { purpose: 'cloudy-cloud', owner: 'testowner', ...labels },
    ttlSeconds: options.deleteAfterSeconds, signal: options.signal,
  });
  const { start, wait, open, deps } = await setup({ provider, createSandbox });
  const id = await start();
  assert.match(await wait([id]), /machines could not be listed/);
  assert.equal(provider.log.create.length, 1);
  assert.equal(provider.machines.size, 1, 'the provider allocated a machine before its response was lost');
  assert.equal(open.get(id)?.sandbox, undefined, 'initial reconciliation could not obtain a handle');

  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.equal(provider.machines.size, 1, 'a failed listing is not proof that the machine was deleted');

  listUnavailable = false;
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.equal(provider.machines.size, 1, 'a failed connect is not proof that the machine was deleted');
  const exactFilter = provider.log.list.at(-1);
  assert.equal(exactFilter.agent, id);
  assert.equal(exactFilter.owner, 'testowner');
  assert.equal(exactFilter.parent, 'testowner');
  assert.equal(exactFilter.purpose, 'cloudy-cloud');

  connectUnavailable = false;
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(open.has(id), false);
  assert.equal(provider.machines.size, 0, 'the owned machine is deleted only after it is connected');
  assert.equal(provider.log.create.length, 1, 'stopping never retries the uncertain create');
});

test('stop waits for an in-flight uncertain create, then deletes its single owned machine', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { name: 'late', hasProxySecrets: false, hasConsentedSecrets: true });
  const create = provider.create.bind(provider);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  provider.create = async (opts) => {
    entered();
    await gate;
    await create(opts);
    throw Object.assign(new Error('create response was lost'), { code: 'transient' });
  };
  const createSandbox = (envs, options, labels, p) => p.create({
    envs, labels: { purpose: 'cloudy-cloud', owner: 'testowner', ...labels },
    ttlSeconds: options.deleteAfterSeconds, signal: options.signal,
  });
  const { start, open, deps } = await setup({ provider, createSandbox });
  const id = await start();
  await started;
  const stopping = stopAgents({ agent_ids: [id] }, deps);
  await tick(10);
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.equal(provider.machines.size, 0, 'stop waits for the provider create to settle before reconciling');
  release();
  await stopping;
  assert.equal(provider.machines.size, 0);
  assert.equal(provider.log.create.length, 1);
  assert.equal(provider.log.connect.length, 1, 'the late allocated machine is connected only for deletion');
  assert.equal(open.has(id), false);
});

test('cleanup_unconfirmed keeps a partially provisioned machine stop-pending until direct delete succeeds', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { name: 'partial', hasProxySecrets: false, hasConsentedSecrets: true });
  const create = provider.create.bind(provider);
  const remove = provider.delete.bind(provider);
  let machineId, deleteCalls = 0, deleteUnavailable = true;
  provider.create = async (opts) => {
    const sandbox = await create(opts);
    machineId = sandbox.id;
    throw Object.assign(new Error('setup failed; cleanup is unconfirmed'), { code: 'cleanup_unconfirmed', provider: 'partial', machineId, allocated: true });
  };
  provider.delete = async (id) => {
    deleteCalls++;
    if (deleteUnavailable) throw Object.assign(new Error('provider delete unavailable'), { code: 'transient' });
    return remove(id);
  };
  const createSandbox = (envs, options, labels, p) => p.create({
    envs, labels: { purpose: 'cloudy-cloud', owner: 'testowner', ...labels },
    ttlSeconds: options.deleteAfterSeconds, signal: options.signal,
  });
  const { start, wait, open, deps } = await setup({ provider, createSandbox });
  const id = await start();
  assert.match(await wait([id]), /cleanup is unconfirmed/);
  assert.equal(open.get(id)?.sandbox, undefined);
  assert.equal(provider.machines.size, 1);
  assert.equal(provider.log.create.length, 1);

  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.equal(provider.machines.size, 1);
  assert.equal(provider.log.connect.length, 0, 'a half-provisioned machine is never adopted as a worker');

  deleteUnavailable = false;
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(open.has(id), false);
  assert.equal(provider.machines.size, 0);
  assert.equal(deleteCalls, 2);
  assert.equal(provider.log.delete.length, 1);
  assert.equal(provider.log.create.length, 1, 'cleanup retries delete the known ID and never repeat create');
});

test('an idle timer handles a rejected stop and leaves the machine retryable', async () => {
  let killCalls = 0, sandbox;
  const { start, wait, stop, open } = await setup({
    idleMs: 30,
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const kill = sandbox.kill;
      sandbox.kill = async () => { if (++killCalls === 1) throw new Error('temporary delete failure'); await kill(); };
      return sandbox;
    },
  });
  const id = await start();
  await wait([id]);
  for (let i = 0; i < 30 && open.get(id)?.status !== 'stop-pending'; i++) await tick(10);
  assert.equal(open.get(id)?.status, 'stop-pending');
  assert.equal(sandbox.killed, false);
  assert.match(await stop([id]), new RegExp(`${id}: stopped`));
  assert.equal(sandbox.killed, true);
  assert.equal(killCalls, 2);
});

test('failed setup cleanup keeps the sandbox handle available for a later stop retry', async () => {
  let killCalls = 0, sandbox;
  const { start, wait, stop, open } = await setup({
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = (cmd, opts) => cmd.includes('git init -q repo')
        ? Promise.reject(new Error('temporary setup failure'))
        : run(cmd, opts);
      const kill = sandbox.kill;
      sandbox.kill = async () => { if (++killCalls === 1) throw new Error('temporary delete failure'); await kill(); };
      return sandbox;
    },
  });
  const id = await start();
  assert.match(await wait([id]), /status: failed/);
  assert.equal(open.get(id)?.sandbox, sandbox);
  assert.equal(sandbox.killed, false);
  assert.match(await stop([id]), new RegExp(`${id}: stopped`));
  assert.equal(sandbox.killed, true);
  assert.equal(killCalls, 2);
});

test('a command-specific 404 does not mark a reachable sandbox gone', async () => {
  let sandbox;
  const { start, wait, open } = await setup({
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = async (cmd, opts) => {
        if (/claude -p /.test(cmd)) throw Object.assign(new Error('remote command not found'), { code: 'not_found', status: 404 });
        return run(cmd, opts);
      };
      return sandbox;
    },
  });
  const id = await start();
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /remote command not found/);
  assert.equal(open.get(id)?.status, 'idle');
  assert.equal(sandbox.killed, false, 'the successful safety push proves the machine is still reachable');
});

test('a transient prompt write failure keeps the existing session open for an explicit retry', async () => {
  const { start, wait, msg, created, open } = await setup();
  const id = await start();
  await wait([id]);
  const write = created[0].files.write;
  let failed = false;
  created[0].files.write = async (path, data) => {
    if (path.endsWith('/prompt.txt') && !failed) { failed = true; throw new Error('temporary transport error'); }
    return write(path, data);
  };
  await msg(id, 'first explicit turn');
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /temporary transport error/);
  assert.equal(open.get(id).status, 'idle');
  assert.equal(created[0].killed, false);
  await msg(id, 'retry by user');
  assert.match(await wait([id]), /hello/);
  assert.equal(created[0].cmds.filter((c) => c.includes('claude -p')).length, 2);
});

test('a lost safety-push connection does not kill the session or replay the completed command', async () => {
  let lost = false;
  const { start, wait, msg, created, open } = await setup({
    createSandbox: async (envs) => {
      const s = await fakeSandbox(getGithub());
      s.envs = envs;
      const run = s.commands.run;
      s.commands.run = async (cmd, opts) => {
        if (!lost && cmd.includes('git rev-parse HEAD')) { lost = true; throw new Error('temporary transport error'); }
        return run(cmd, opts);
      };
      created.push(s);
      return s;
    },
  });
  const id = await start({ prompt: 'EDIT' });
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /could not be reached to push/);
  assert.match(r, /sandbox file availability are unconfirmed/);
  assert.doesNotMatch(r, /files remain in the sandbox/);
  assert.equal(open.get(id).status, 'idle');
  assert.equal(created[0].killed, false);
  assert.equal(created[0].cmds.filter((c) => c.includes('claude -p')).length, 1);
});

test('idle timer stops the agent and kills its sandbox; a message resets it', async () => {
  const { start, wait, msg, created, open } = await setup({ idleMs: 150 });
  const id = await start();
  await wait([id]);
  await tick(100);
  await msg(id, 'hi');
  await wait([id]);
  await tick(100);
  assert.ok(open.has(id), 'timer was reset by the message');
  await tick(200);
  assert.equal(open.size, 0);
  assert.ok(created[0].killed);
});

test('list shows status and idle minutes', async () => {
  const { start, wait, deps, text } = await setup();
  const id = await start({ description: 'my task' });
  await wait([id]);
  assert.match(text(await listAgents({}, deps)), new RegExp(`${id}  idle  provider fake  idle 0 min  deleted at \\S+  cpu \\d+% mem \\S+ GiB \\(\\d+[sm] ago\\)  my task`));
});

test('invalid session_id from the sandbox is refused and the agent is failed', async () => {
  const { start, wait, created } = await setup();
  const id = await start({ prompt: 'BADSID' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /invalid session_id/);
  assert.ok(!created[0].cmds.some((c) => c.includes('rm -rf')));
  assert.ok(created[0].killed);
});

test('unparseable output returns the raw stdout and says so', async () => {
  const { start, wait } = await setup();
  const id = await start({ prompt: 'RAW' });
  const r = await wait([id]);
  assert.match(r, /not json/);
  assert.match(r, /Could not parse/);
  assert.match(r, /status: failed/); // no final result and no session id: the turn failed and cannot be resumed
});

test('a first turn with a session but no final result is an error, and the agent stays open and resumable', async () => {
  let sbx, first = true;
  const { start, wait, msg, open } = await setup({
    createSandbox: async (envs) => {
      const s = await fakeSandbox(getGithub());
      s.envs = envs;
      const run = s.commands.run;
      s.commands.run = (cmd, o) => {
        if (cmd.includes('claude -p') && first) {
          first = false;
          o?.onStdout?.(`{"type":"system","subtype":"init","session_id":"${SID}"}\n`);
          return Promise.resolve({ stdout: `{"type":"system","subtype":"init","session_id":"${SID}"}\n`, stderr: '', exitCode: 0 });
        }
        return run(cmd, o);
      };
      sbx = s;
      return s;
    },
  });
  const id = await start();
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /ERROR/);
  assert.match(r, /Could not parse/);
  assert.equal(open.get(id).status, 'idle');
  await msg(id, 'hi');
  assert.match(await wait([id]), /status: idle[\s\S]*hello/);
  assert.ok(sbx.cmds.some((c) => c.includes(`--resume ${SID}`)), 'the kept session id resumes the next turn');
});

test('a failed turn reports error, scrubs secrets, still pushes commits; agent with no session is failed', async () => {
  const { start, wait, created, remote } = await setup();
  const id = await start({ prompt: 'FAIL' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /exit code 3/);
  assert.match(r, /boom \[redacted\]/);
  assert.ok(!r.includes(SECRET));
  assert.ok(created[0].killed);
  assert.equal(await remote(`git show cloudy-cloud/${id}:a.txt`), 'changed');
});

test('a known first-turn failure keeps the worker when uncommitted edits remain', async () => {
  let sandbox;
  const { start, wait, stop, open } = await setup({
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = async (cmd, opts) => {
        if (/claude -p /.test(cmd)) {
          try { return await run(cmd, opts); }
          catch (error) {
            await writeFile(join(sandbox.dir, 'home', 'repo', 'uncommitted.txt'), 'keep me\n');
            throw error;
          }
        }
        return run(cmd, opts);
      };
      return sandbox;
    },
  });
  const id = await start({ prompt: 'FAIL' });
  const r = await wait([id]);
  const agent = open.get(id);
  assert.match(r, /status: failed/);
  assert.match(r, /Uncommitted changes left in the sandbox.*uncommitted\.txt/);
  assert.doesNotMatch(r, /ask the agent to commit and push/);
  assert.match(r, /sandbox is retained because workspace or push state may be uncommitted or unconfirmed/);
  assert.match(r, /No session ID was reported, so this conversation cannot be resumed/);
  assert.equal(agent.status, 'failed');
  assert.equal(agent.result.preserve_worker, true);
  assert.equal(agent.result.workspace_dirty, true);
  assert.equal(agent.result.push_status, 'pushed');
  assert.equal(sandbox.killed, false);
  assert.match(await stop([id]), new RegExp(`${id}: stopped`));
  assert.equal(open.has(id), false);
  assert.equal(sandbox.killed, true);
});

test('a known first-turn failure keeps the worker when git status is unconfirmed', async () => {
  let sandbox;
  const { start, wait, open } = await setup({
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = (cmd, opts) => cmd.includes('PUSHOK')
        ? Promise.resolve({ stdout: 'PUSHOK\nREMOTE_SHA abc\nSHA abc\nSTATUS_FAIL\nSTATUSERR status unavailable\n', stderr: '', exitCode: 0 })
        : run(cmd, opts);
      return sandbox;
    },
  });
  const id = await start({ prompt: 'FAIL' });
  const r = await wait([id]);
  const agent = open.get(id);
  assert.match(r, /status: failed/);
  assert.match(r, /Git status could not be confirmed/);
  assert.match(r, /sandbox is retained because workspace or push state may be uncommitted or unconfirmed/);
  assert.match(r, /No session ID was reported, so this conversation cannot be resumed/);
  assert.equal(agent.status, 'failed');
  assert.equal(agent.result.preserve_worker, true);
  assert.equal(agent.result.workspace_dirty, null);
  assert.equal(agent.result.push_status, 'pushed');
  assert.equal(sandbox.killed, false);
});

test('a known first-turn failure keeps the worker when its safety push fails', async () => {
  let sandbox, pushes = 0;
  const { start, wait, open } = await setup({
    sleep: async () => {},
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = (cmd, opts) => cmd.includes('PUSHOK')
        ? Promise.resolve({ stdout: `PUSHFAIL\nERR remote denied\nSHA ${'a'.repeat(40)}\nSTATUS_OK\n`, stderr: '', exitCode: 0, attempt: ++pushes })
        : run(cmd, opts);
      return sandbox;
    },
  });
  const id = await start({ prompt: 'FAIL' });
  const r = await wait([id]);
  const agent = open.get(id);
  assert.match(r, /status: failed/);
  assert.match(r, /Push failed: remote denied/);
  assert.match(r, /sandbox is retained because workspace or push state may be uncommitted or unconfirmed/);
  assert.match(r, /No session ID was reported, so this conversation cannot be resumed/);
  assert.equal(agent.status, 'failed');
  assert.equal(agent.result.preserve_worker, true);
  assert.equal(agent.result.workspace_dirty, false);
  assert.equal(agent.result.push_status, 'failed');
  assert.equal(pushes, 2);
  assert.equal(sandbox.killed, false);
});

test('a failed follow-up keeps the agent open (idle) and pushes changes', async () => {
  const { start, wait, msg, created, open } = await setup();
  const id = await start();
  await wait([id]);
  await msg(id, 'FAIL');
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /ERROR: Subagent failed, exit code 3/);
  assert.equal(created[0].killed, false);
  assert.ok(open.has(id));
});

test('a follow-up to a vanished sandbox fails the agent and says so', async () => {
  const { start, wait, msg, created } = await setup();
  const id = await start();
  await wait([id]);
  created[0].files.write = async () => { throw Object.assign(new Error('sandbox not found'), { code: 'not_found' }); };
  await msg(id, 'hi');
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /sandbox is confirmed gone/);
  assert.match(r, new RegExp(`already pushed to origin cloudy-cloud/${id}`));
});

test('invalid model or subagent_type is rejected before any sandbox', async () => {
  const { deps, created } = await setup();
  for (const bad of [{ model: 'x; rm -rf /' }, { subagent_type: '$(id)' }]) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', ...bad }, deps);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /invalid/);
  }
  assert.equal(created.length, 0);
});

test('non-git directory returns a clear error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-nogit-'));
  const r = await runSubagent({ prompt: 'hi', description: 'd' }, { createSandbox: async () => {}, provider: createFakeProvider(), open: new Map(), cwd: dir, env: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /git init/);
});

test('uncommitted tracked edits are sent; untracked files are not', async () => {
  const { repo, start, wait } = await setup();
  await writeFile(join(repo, 'a.txt'), 'dirty\n');
  await writeFile(join(repo, 'untracked.txt'), 'x');
  await sh(repo, 'git add a.txt');
  await writeFile(join(repo, 'a.txt'), 'dirtier\n');
  const r = await wait([await start({ prompt: 'SHOW' })]);
  assert.match(r, /a=dirtier/);
  assert.match(r, /untracked=.*No such file/);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'dirtier\n');
  assert.equal(await sh(repo, 'git diff --cached --name-only'), 'a.txt', 'index unchanged');
});

test('sandbox gets only the OAuth token when both Claude credentials exist', async () => {
  let seen;
  const { start, wait } = await setup({
    createSandbox: async (envs) => { seen = envs; return fakeSandbox(); },
    env: { ANTHROPIC_API_KEY: 'api', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
  });
  await wait([await start()]);
  assert.deepEqual(seen, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
});

test('shutdown cleanup kills every open sandbox', async () => {
  const { start, wait, created, open } = await setup();
  const ids = [await start(), await start(), await start()];
  await wait(ids);
  await killAll(open);
  assert.equal(open.size, 0);
  assert.ok(created.every((c) => c.killed));
});

test('stop during a running turn kills the sandbox and the turn does not resurrect the agent', async () => {
  const { start, wait, stop, open } = await setup();
  const id = await start({ prompt: 'SLOW' });
  await tick(50);
  await stop([id]);
  await tick(800);
  assert.equal(open.size, 0);
  assert.match(await wait([id], 0.05), /status: stopped/);
});

test('wait and stop accept a single id as a string or as agent_id', async () => {
  const { stopAgents, waitAgents } = await import('../src/run-subagent.mjs');
  const deps = { createSandbox: async () => { throw new Error('unused'); }, provider: createFakeProvider(), open: new Map() };
  for (const args of [{ agent_ids: 'x1' }, { agent_id: 'x1' }]) {
    const r = await stopAgents(args, deps);
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.match(r.content[0].text, /x1: not open/);
    assert.equal(r.structuredContent.agents[0].status, 'not-open');
    const w = await waitAgents({ ...args, timeout_seconds: 1 }, deps);
    assert.notEqual(w.isError, true, JSON.stringify(w));
  }
});

test('stop reports independent structured outcomes when one provider deletion fails', async () => {
  const deps = {
    createSandbox: async () => { throw new Error('unused'); }, provider: createFakeProvider(),
    open: new Map([['deadbeef', { id: 'deadbeef', branch: 'cloudy-cloud/deadbeef', status: 'idle', sandbox: { kill: async () => { throw new Error('provider offline'); } } }]]),
  };
  const r = await stopAgents({ agent_ids: ['deadbeef', 'unknown1'] }, deps);
  assert.deepEqual(r.structuredContent.agents.map(({ agent_id, status, error }) => [agent_id, status, error]), [
    ['deadbeef', 'stop-pending', true], ['unknown1', 'not-open', undefined],
  ]);
  assert.match(r.content[0].text, /deadbeef: stop pending/);
  assert.match(r.content[0].text, /unknown1: not open/);
});

test('conditional automatic stop leaves a worker alone after a newer turn starts', async () => {
  const { start, wait, msg, deps, created } = await setup();
  const id = await start();
  await wait([id]);
  const completedTurn = deps.open.get(id).turn.id;
  await msg(id, 'OK follow-up');
  const r = await stopAgents({ agent_ids: [id], expected_turn_id: completedTurn, expected_status: 'idle' }, deps);
  assert.equal(r.structuredContent.agents[0].status, 'not-stopped');
  assert.equal(deps.open.get(id).status, 'running');
  assert.equal(created[0].killed, false);
  await wait([id]);
  await stopAgents({ agent_ids: [id] }, deps);
});

test('conditional automatic stop rechecks the live workspace before deleting', async () => {
  const { start, wait, deps, created, remote } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  // A file created through cloudy-cloud shell after the result was collected leaves the workspace dirty.
  await sbx.commands.run('echo shell-edit > shell.txt', { cwd: '/home/user/repo', timeoutMs: 5000 });
  const dirty = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(dirty.structuredContent.agents[0].status, 'not-stopped');
  assert.equal(sbx.killed, false);

  // Committing the same edit makes it pushable: the recheck preserves it on origin, then deletes.
  await sbx.commands.run('git add -A && git -c user.name=x -c user.email=x@x commit -qm shell-commit', { cwd: '/home/user/repo', timeoutMs: 5000 });
  const head = (await sbx.commands.run('git rev-parse HEAD', { cwd: '/home/user/repo', timeoutMs: 5000 })).stdout.trim();
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped');
  assert.equal(sbx.killed, true);
  assert.equal(await remote(`git rev-parse refs/heads/cloudy-cloud/${id}`), head, 'the shell commit must be on origin before deletion');
});

test('conditional automatic stop keeps a worker whose repo gained a linked worktree or extra branch', async () => {
  for (const make of ['git worktree add ../linked --detach', 'git branch extra-head HEAD~0']) {
    const { start, wait, deps, created } = await setup();
    const id = await start({ prompt: 'EDIT' });
    await wait([id]);
    const turn = deps.open.get(id).turn.id;
    const sbx = created[0];
    await sbx.commands.run(make, { cwd: '/home/user/repo', timeoutMs: 5000 });
    const r = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
    assert.equal(r.structuredContent.agents[0].status, 'not-stopped', make);
    assert.equal(sbx.killed, false, make);
    // An explicit user-requested stop is not conditional, so it still deletes the machine.
    await stopAgents({ agent_ids: [id] }, deps);
    assert.equal(sbx.killed, true);
  }
});

test('conditional automatic stop pushes a worker-branch tip that moved past HEAD', async () => {
  const recovery = await mkdtemp(join(tmpdir(), 'cc-recovery-'));
  const { start, wait, deps, created, remote } = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_RECOVERY: recovery } });
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  const run = (cmd) => sbx.commands.run(cmd, { cwd: '/home/user/repo', timeoutMs: 5000 });
  // Commits on refs/heads/<branch> that HEAD does not name (a detached checkout moved the ref past it).
  await run(`git checkout -q --detach HEAD && git commit -qm drift --allow-empty && git update-ref refs/heads/cloudy-cloud/${id} HEAD && git reset -q --hard HEAD~1`);
  const tip = (await run(`git rev-parse refs/heads/cloudy-cloud/${id}`)).stdout.trim();
  const head = (await run('git rev-parse HEAD')).stdout.trim();
  assert.notEqual(tip, head, 'the branch ref must hold a commit HEAD does not');
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped');
  assert.equal(sbx.killed, true);
  assert.equal(await remote(`git rev-parse refs/heads/cloudy-cloud/${id}`), tip, 'the drifted branch tip must be on origin before deletion');
  assert.equal(stopped.structuredContent.agents[0].checkpoint_sha, tip, 'the recovery checkpoint names the pushed branch tip');
});

test('conditional automatic stop refuses when the worker-branch tip diverged from HEAD', async () => {
  const { start, wait, deps, created } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  const base = deps.open.get(id).sha;
  // A commit on the branch ref that shares no history with the pushed HEAD: no single push preserves both.
  await sbx.commands.run(`head=$(git rev-parse HEAD) && git checkout -q -b div ${base} && git commit -qm div --allow-empty && git update-ref refs/heads/cloudy-cloud/${id} div && git checkout -q --detach $head`, { cwd: '/home/user/repo', timeoutMs: 5000 });
  const r = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(r.structuredContent.agents[0].status, 'not-stopped');
  assert.match(r.structuredContent.agents[0].message, /diverged/);
  assert.equal(sbx.killed, false);
  await sbx.commands.run(`git update-ref -d refs/heads/cloudy-cloud/${id} 2>/dev/null; git checkout -q -b cloudy-cloud/${id} HEAD`, { cwd: '/home/user/repo', timeoutMs: 5000 });
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(sbx.killed, true);
});

test('conditional automatic stop saves a newer detached HEAD when the local worker branch is stale', async () => {
  const { start, wait, deps, created, remote } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  const run = (cmd) => sbx.commands.run(cmd, { cwd: '/home/user/repo', timeoutMs: 5000 });
  // B is pushed from a detached HEAD, then C is committed on top; the local branch still names the older tip.
  await run(`git checkout -q --detach && git commit -qm b --allow-empty && git push -q origin HEAD:refs/heads/cloudy-cloud/${id} && git commit -qm c --allow-empty`);
  const head = (await run('git rev-parse HEAD')).stdout.trim();
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped', stopped.structuredContent.agents[0].message);
  assert.equal(await remote(`git rev-parse refs/heads/cloudy-cloud/${id}`), head, 'the newer HEAD is on origin before deletion');
});

test('conditional automatic stop saves HEAD when the local worker branch is missing', async () => {
  const { start, wait, deps, created, remote } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  const run = (cmd) => sbx.commands.run(cmd, { cwd: '/home/user/repo', timeoutMs: 5000 });
  await run(`git checkout -q --detach && git branch -D cloudy-cloud/${id} && git commit -qm c --allow-empty`);
  const head = (await run('git rev-parse HEAD')).stdout.trim();
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped', stopped.structuredContent.agents[0].message);
  assert.equal(await remote(`git rev-parse refs/heads/cloudy-cloud/${id}`), head);
});

test('conditional automatic stop keeps a worker that holds only Git-ignored files', async () => {
  const { start, wait, deps, created } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  await sbx.commands.run(`echo diagnostics.log >> .git/info/exclude && echo report > diagnostics.log`, { cwd: '/home/user/repo', timeoutMs: 5000 });
  const r = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(r.structuredContent.agents[0].status, 'not-stopped');
  assert.match(r.structuredContent.agents[0].message, /diagnostics\.log/);
  assert.equal(sbx.killed, false);
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(sbx.killed, true);
});

test('conditional automatic stop with no new commits checkpoints the confirmed remote tip', async () => {
  const recovery = await mkdtemp(join(tmpdir(), 'cc-recovery-'));
  const { start, wait, deps, created } = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_RECOVERY: recovery } });
  const id = await start();
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const a = deps.open.get(id);
  // The turn pushed nothing, so no checkpoint was saved. The branch tip reached origin another way
  // (a manual push): the no-change stop must still checkpoint that verified remote tip.
  await created[0].commands.run(`git push -q origin refs/heads/cloudy-cloud/${id}`, { cwd: '/home/user/repo', timeoutMs: 5000 });
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped');
  assert.equal(stopped.structuredContent.agents[0].checkpoint_sha, a.sha, 'a no-change stop still leaves a checkpoint at the verified remote tip');
  const record = JSON.parse(await readFile(join(recovery, `${id}.json`), 'utf8'));
  assert.equal(record.checkpointSha, a.sha);
});

test('conditional automatic stop refuses deletion when the workspace probe fails', async () => {
  const { start, wait, deps, created } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  const realRun = sbx.commands.run;
  // The worktree/ref listing dies after the safety push passed clean: an incomplete probe refuses.
  sbx.commands.run = (cmd, o) => String(cmd).includes('git worktree list')
    ? Promise.reject(Object.assign(new Error('probe broke'), { exitCode: 1 }))
    : realRun(cmd, o);
  const r = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(r.structuredContent.agents[0].status, 'not-stopped');
  assert.match(r.structuredContent.agents[0].message, /could not be fully inspected/);
  assert.equal(sbx.killed, false);
  sbx.commands.run = realRun;
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped');
});

test('conditional automatic stop deletes only on provider confirmation that the machine is gone', async () => {
  const { start, wait, deps, created } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  // A command-level not_found (Boat also returns it for sandbox_not_ready) while the provider still
  // reaches the machine: the deletion must not be authorized by the failed probe.
  const realRun = sbx.commands.run;
  sbx.commands.run = () => Promise.reject(Object.assign(new Error('sandbox_not_ready'), { code: 'not_found' }));
  // Hook-created sandboxes are not registered in the fake provider's own maps, so simulate the
  // provider lookup directly: reachable while the flag is clear, not_found once it is set.
  const gone = { current: false };
  const realConnect = deps.provider.connect;
  deps.provider.connect = async () => {
    if (gone.current) throw Object.assign(new Error('not found'), { code: 'not_found' });
    return {};
  };
  const refused = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(refused.structuredContent.agents[0].status, 'not-stopped');
  assert.match(refused.structuredContent.agents[0].message, /still reaches the machine|not confirmed gone/);
  assert.equal(sbx.killed, false);
  // The provider's own lookup confirms the machine is gone: only then does the failed probe count.
  gone.current = true;
  const stopped = await stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  assert.equal(stopped.structuredContent.agents[0].status, 'stopped');
  assert.equal(sbx.killed, true);
  sbx.commands.run = realRun;
  deps.provider.connect = realConnect;
});

test('conditional automatic stop rechecks the completed turn after the workspace probe', async () => {
  const { start, wait, msg, deps, created } = await setup();
  const id = await start();
  await wait([id]);
  const turn = deps.open.get(id).turn.id;
  const sbx = created[0];
  const realRun = sbx.commands.run;
  let entered, release;
  const gate = new Promise((r) => { release = r; });
  const gateEntered = new Promise((r) => { entered = r; });
  // The probe's ref listing is held open while another client starts a new turn.
  sbx.commands.run = (cmd, o) => {
    if (!String(cmd).includes('--CC-REFS--')) return realRun(cmd, o);
    entered();
    return realRun(cmd, o).then(async (r) => { await gate; return r; });
  };
  const pending = stopAgents({ agent_ids: [id], expected_turn_id: turn, expected_status: 'idle' }, deps);
  await gateEntered;
  await msg(id, 'OK more work');
  release();
  const r = await pending;
  assert.equal(r.structuredContent.agents[0].status, 'not-stopped');
  assert.equal(sbx.killed, false);
  assert.equal(deps.open.get(id).status, 'running');
  sbx.commands.run = realRun;
  await wait([id]);
  await stopAgents({ agent_ids: [id] }, deps);
  assert.equal(sbx.killed, true);
});


test('follow-up resumes the same session; both turns push to the same GitHub branch', async () => {
  const { start, wait, msg, created, text, remote } = await setup();
  const id = await start({ prompt: 'EDIT', model: 'haiku' });
  await wait([id]);
  const tip1 = await remote(`git rev-parse cloudy-cloud/${id}`);
  const r = await msg(id, 'EDIT2 please');
  assert.match(text(r), /status: running/);
  const out = await wait([id]);
  assert.match(out, new RegExp(`resumed ${SID} edited2`));
  assert.match(out, new RegExp(`Pushed to origin cloudy-cloud/${id} at [0-9a-f]{7}\\. Review: https://github\\.com/\\S+/compare/cloudy-cloud/${id}\\?expand=1 Or fetch: git fetch origin cloudy-cloud/${id}\\.`));
  assert.equal(await remote(`git merge-base --is-ancestor ${tip1} cloudy-cloud/${id} && echo yes`), 'yes');
  assert.equal(await remote(`git show cloudy-cloud/${id}:b.txt`), 'more');
  const cmd = created[0].cmds.filter((c) => c.includes('claude -p')).pop();
  assert.match(cmd, new RegExp(`--resume ${SID} --dangerously-skip-permissions --output-format stream-json --verbose`));
  assert.match(cmd, /--model haiku/);
  assert.equal(created[0].writes.filter((p) => p.endsWith('in.bundle')).length, 1);
  const checkout = created[0].cmds.find((command) => command.includes('git fetch -q ../in.bundle'));
  assert.match(checkout, /git fetch -q \.\.\/in\.bundle [0-9a-f]{40} && git checkout -q --detach [0-9a-f]{40}/);
});

test('a small repo uploads a full bundle and sets up in the original command order', async () => {
  const { start, wait, created } = await setup();
  const id = await start();
  await wait([id]);
  const c = created[0].cmds;
  assert.equal(created[0].writes.filter((p) => p.endsWith('in.bundle')).length, 1);
  assert.match(c[0], /git fetch -q \.\.\/in\.bundle .* git remote add origin /);
  assert.equal(c[1], 'gh auth setup-git');
  assert.ok(!c.some((x) => /git fetch -q origin /.test(x)));
});

const bulk = (repo, name) => writeFile(join(repo, name), randomBytes(20000)).then(() => sh(repo, `git add -A && git commit -qm ${name}`));

test('a bundle over the limit is thin: the machine fetches the commits GitHub has, then the bundle', async () => {
  const { repo, bare, start, wait, created, deps, remote } = await setup();
  await bulk(repo, 'big.bin');
  await sh(repo, `git push -q ${bare} main && git update-ref refs/remotes/origin/main HEAD`);
  const base = await sh(repo, 'git rev-parse HEAD');
  await writeFile(join(repo, 'b.txt'), 'local\n');
  await sh(repo, 'git add -A && git commit -qm local');
  deps.bundleMax = 5000;
  const id = await start();
  await wait([id]);
  const s = created[0];
  const bundle = await readFile(join(s.dir, 'home', 'in.bundle'));
  assert.ok(bundle.length < 5000, `thin bundle is ${bundle.length} bytes`);
  const i = s.cmds.findIndex((c) => c.includes(`git fetch -q origin ${base}`));
  assert.ok(i > s.cmds.indexOf('gh auth setup-git'), 'prerequisites are fetched after gh auth');
  assert.match(s.cmds[i], /git fetch -q origin [0-9a-f]{40} && git fetch -q \.\.\/in\.bundle /);
  assert.ok(s.cmds[0].includes('git remote add origin') && !s.cmds[0].includes('in.bundle'));
  assert.equal(deps.open.get(id).sha, await sh(repo, 'git rev-parse HEAD'));
});

test('changes too large even for a thin bundle fail with a clear error', async () => {
  const { repo, bare, start, wait, deps } = await setup();
  await sh(repo, `git push -q ${bare} main && git update-ref refs/remotes/origin/main HEAD`);
  await bulk(repo, 'big.bin');
  deps.bundleMax = 5000;
  const out = await wait([await start()]);
  assert.match(out, /too large to upload.*Push the branch to GitHub first/s);
});

test('a repo with no origin branches and a large bundle fails with the same error', async () => {
  const { repo, start, wait, deps } = await setup();
  await bulk(repo, 'big.bin');
  deps.bundleMax = 5000;
  assert.match(await wait([await start()]), /too large to upload/);
});

test('first-turn command is stream-json output with the commit-and-push hint; identity and branch are set up', async () => {
  const { start, wait, created, deps } = await setup();
  const id = await start();
  await wait([id]);
  const cmd = created[0].cmds.find((c) => c.includes('claude -p'));
  assert.match(cmd, /--output-format stream-json --verbose/);
  assert.ok(cmd.includes(`--append-system-prompt 'You are on branch cloudy-cloud/${id}, which tracks origin. After each meaningful step, commit with a short message and run git push. Your sandbox can disappear at any time; only pushed work survives. Never push to any other branch. Run every command in the foreground and wait for it to finish. Never end your turn while work is still running. No human is available to answer questions. Make reasonable choices, write down any assumptions in your final reply, and keep going. Only if you are truly blocked, stop and end your reply with a line starting QUESTION: that states exactly what you need; whoever started you can answer with a follow-up message. Your machine is deleted by the server at ${new Date(deps.open.get(id).deleteAt).toISOString()}; push your work well before then. This turn ends at ${cmd.match(/This turn ends at (\S+?);/)[1]}; commit, push and finish before then.'`));
  assert.ok(created[0].cmds.some((c) => c.includes('git config user.name cloudy-cloud') && c.includes('user.email cloudy-cloud@localhost')));
  assert.ok(created[0].cmds.some((c) => c.includes(`git remote add origin '${ORIGIN}'`) && c.includes(`git checkout -q -b cloudy-cloud/${id}`)));
  assert.ok(created[0].cmds.includes('gh auth setup-git'));
  assert.ok(created[0].cmds.some((c) => c.startsWith('git ls-remote') && c.includes(`branch.cloudy-cloud/${id}.merge`)));
  assert.ok(!created[0].cmds.some((c) => c.includes('git push -q -u')));
});

test('origin: https accepted, ssh converted, missing or non-GitHub or malicious rejected before any sandbox', async () => {
  const ok = await setup({ origin: 'git@github.com:acme/widgets.git' });
  const id = await ok.start();
  await ok.wait([id]);
  assert.ok(ok.created[0].cmds.some((c) => c.includes("git remote add origin 'https://github.com/acme/widgets.git'")));
  const plain = await setup({ origin: 'https://github.com/acme/widgets' });
  await plain.wait([await plain.start()]);
  assert.ok(plain.created[0].cmds.some((c) => c.includes("git remote add origin 'https://github.com/acme/widgets'")));
  for (const origin of [null, 'https://gitlab.com/a/b.git', 'git@gitlab.com:a/b.git', "https://github.com/a/b.git'; rm -rf /; '", 'https://github.com/a/b.git$(id)', 'https://evil.com/github.com/a/b.git', '/some/local/path']) {
    const t = await setup({ origin });
    const r = await runSubagent({ description: 'd', prompt: 'hi' }, t.deps);
    assert.equal(r.isError, true, String(origin));
    assert.match(r.content[0].text, /origin.*github\.com.*git remote add origin/s);
    assert.equal(t.created.length, 0);
    assert.equal(t.open.size, 0);
  }
});

test('agent commits reach the GitHub branch; the local repo gets no new refs', async () => {
  const { repo, start, wait, remote, created } = await setup();
  const before = await refs(repo);
  const head = await sh(repo, 'git rev-parse HEAD');
  const id = await start({ prompt: 'EDIT' });
  const r = await wait([id]);
  assert.match(r, new RegExp(`Pushed to origin cloudy-cloud/${id}`));
  assert.equal(await remote(`git show cloudy-cloud/${id}:a.txt`), 'changed');
  assert.equal(await refs(repo), before);
  assert.equal(await sh(repo, 'git rev-parse HEAD'), head);
  assert.equal(await sh(repo, 'git status --porcelain'), '');
  assert.ok(!created[0].cmds.some((c) => c.includes('cc-keep') && c.includes('push')));
});

test('safety push sends commits the agent made but did not push', async () => {
  const { start, wait, remote, msg } = await setup();
  const id = await start({ prompt: 'UNPUSHED' });
  const r = await wait([id]);
  assert.match(r, new RegExp(`Pushed to origin cloudy-cloud/${id}`));
  assert.equal(await remote(`git show cloudy-cloud/${id}:unpushed.txt`), 'unpushed');
  assert.doesNotMatch(r, /Uncommitted/);
  await msg(id, 'UNPUSHED');
  await wait([id]);
});

test('uncommitted files are listed, not committed', async () => {
  const { start, wait, remote, created } = await setup();
  const id = await start({ prompt: 'DIRTY' });
  const r = await wait([id]);
  assert.match(r, /Uncommitted changes left in the sandbox \(ask the agent to commit and push\): .*notes\.txt/);
  assert.match(r, /a\.txt/);
  assert.equal(await remote('git branch --list "cloudy-cloud/*"'), '');
  assert.ok(!created[0].cmds.some((c) => /git (add|commit)/.test(c)), 'the server never commits for the agent');
});

test('a push failure is reported; the agent stays idle and messageable', async () => {
  const { start, wait, msg, open, rejectPushes, remote } = await setup({ sleep: async () => {} });
  const id = await start();
  await wait([id]);
  await rejectPushes(true);
  await msg(id, 'UNPUSHED');
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /ERROR/); // a rejected push is an error the caller sees; the agent stays open and resumable
  assert.match(r, /Push failed: .*denied by test.*; the agent is still open, ask it to push\./s);
  assert.ok(open.has(id));
  await rejectPushes(false);
  assert.equal((await msg(id, 'hi')).isError, undefined);
  assert.match(await wait([id]), new RegExp(`Pushed to origin cloudy-cloud/${id}`));
  assert.equal(await remote(`git show cloudy-cloud/${id}:unpushed.txt`), 'unpushed');
});

test('a failed GitHub check fails the agent with a clear, scrubbed message', async () => {
  const { start, wait } = await setup({ ...flakyFirstPush(9, 'remote: denied by test. fatal: 403'), provider: proxyProvider(), env: PROXY_ENV });
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /GitHub access check.*GH_TOKEN.*RUNBOOK\.md, step 2\.4.*denied by test/s);
});

test('a missing gh fails the agent with a clear message', async () => {
  const { start, wait } = await setup({
    createSandbox: async () => {
      const s = await fakeSandbox();
      const run = s.commands.run;
      s.commands.run = (cmd, o) => (cmd.startsWith('gh ') ? Promise.reject(Object.assign(new Error('x'), { exitCode: 127, stderr: 'gh: not found' })) : run(cmd, o));
      return s;
    },
  });
  assert.match(await wait([await start()]), /status: failed[^#]*gh auth setup-git[^#]*gh: not found/);
});

test('8 agents finishing at once each end up with only their own commits on their own GitHub branch', async () => {
  const { repo, start, wait, remote } = await setup();
  const before = await refs(repo);
  const base = await sh(repo, 'git rev-parse HEAD');
  const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];
  const ids = await Promise.all(names.map((n) => start({ prompt: `OWN-${n}` })));
  const r = await wait(ids, 120);
  for (const [i, id] of ids.entries()) {
    const files = (await remote(`git diff --name-only ${base} cloudy-cloud/${id}`)).split('\n');
    assert.deepEqual(files, [`own-${names[i]}.txt`], `agent ${id} branch has ${files}\n${r}`);
  }
  assert.equal(await refs(repo), before);
});

test('secrets, including GH_TOKEN and GITHUB_TOKEN, are scrubbed from results', async () => {
  const { start, wait } = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', GITHUB_TOKEN: 'ghp_other' } });
  const r = await wait([await start({ prompt: 'LEAK' })]);
  assert.match(r, /leak \[redacted\] \[redacted\]/);
  assert.ok(!/ghp_secret|ghp_other/.test(r));
});

test('task mode: a starting agent says "starting machine…"; the final line ends with a total; the status message hides secrets', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, wait } = await setup({ createSandbox: async () => { await gate; return fakeSandbox(); }, asTask: true, provider: proxyProvider(), env: PROXY_ENV });
  const t = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.equal(t.resultType, 'task');
  assert.match(t.statusMessage, /^starting machine… It will push to cloudy-cloud\/[0-9a-f]{8}\.$/);
  assert.equal(getTask(t.taskId, deps).statusMessage, 'starting machine…');
  release();
  const id = t.taskId.split('-')[1];
  assert.match(await wait([id]), /Total: 1 tool use, 100 in \/ 7 out tokens, \$0\.0100, \d+s$/);
  const v = getTask(t.taskId, deps);
  assert.equal(v.status, 'completed');
  assert.ok(v.statusMessage.length <= 200 && !v.statusMessage.includes(SECRET));
  assert.equal(getTask('cc-nope-t1', deps), undefined);
});

test('claude runs with background tasks disabled on the first turn and on a resume', async () => {
  const { start, wait, msg, created } = await setup();
  const id = await start();
  await wait([id]);
  await msg(id, 'again');
  await wait([id]);
  const envlog = (await readFile(join(created[0].dir, 'home', 'envlog.txt'), 'utf8')).trim().split('\n');
  assert.equal(envlog.length, 2);
  for (const line of envlog) assert.match(line, /^1 (1680000|167\d{4}) \1$/); // the shared turn deadline shaves a few ms off 28 min
  assert.ok(created[0].cmds.filter((c) => c.includes('claude -p')).length === 2);
});

test('a queued agent shows status queued with its place, and a stopped queued agent never creates a machine', async () => {
  let creates = 0;
  const { start, stop, deps, text, wait } = await setup({
    queue: createStartQueue({ perMin: 1, sleep: () => new Promise(() => {}) }), // the 2nd and 3rd wait for ever
    createSandbox: async () => { creates++; return fakeSandbox(); },
  });
  const [a, b, c] = [await start(), await start(), await start()];
  await tick(300);
  assert.equal(creates, 1);
  assert.match(text(await listAgents({}, deps)), new RegExp(`${c}  queued[^]*queued for a machine \\(1 ahead\\)`));
  assert.match(await wait([b], 0.1), /status: queued/);
  await stop([b]);
  assert.match(text(await listAgents({}, deps)), new RegExp(`${c}  queued[^]*queued for a machine \\(0 ahead\\)`));
  await stop([c]);
  await tick(50);
  assert.equal(creates, 1);
  assert.match(await wait([a]), /status: idle/);
});

// Sandbox whose first-push command fails with `stderr` for the first `n` attempts; sleeps are recorded, not waited.
function flakyFirstPush(n, stderr) {
  const sleeps = [];
  let fails = 0;
  const createSandbox = async () => {
    const s = await fakeSandbox();
    const run = s.commands.run;
    s.commands.run = (cmd, o) => (cmd.startsWith('git ls-remote') && fails++ < n
      ? Promise.reject(Object.assign(new Error('exit'), { exitCode: 1, stderr }))
      : run(cmd, o));
    return s;
  };
  return { createSandbox, sleep: async (ms) => { sleeps.push(ms); }, sleeps, attempts: () => fails };
}

test('a transient first-push rejection is retried and the agent succeeds', async () => {
  const f = flakyFirstPush(2, '! [remote rejected] x -> x (missing necessary objects)');
  const { start, wait } = await setup(f);
  const r = await wait([await start()]);
  assert.match(r, /status: idle/);
  assert.deepEqual(f.sleeps, [5000, 15000]);
});

test('three non-auth first-push failures give the attempts message without the token hint', async () => {
  const f = flakyFirstPush(9, '! [remote rejected] x -> x (missing necessary objects)');
  const { start, wait } = await setup(f);
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /failed after 3 attempts\. Git said: .*missing necessary objects/s);
  assert.doesNotMatch(r, /GH_TOKEN|RUNBOOK/);
  assert.equal(f.attempts(), 3);
});

test('an auth failure on the first push gives the GH_TOKEN hint', async () => {
  const f = flakyFirstPush(9, 'remote: Permission to test/repo.git denied. fatal: 403');
  const { start, wait } = await setup({ ...f, provider: proxyProvider(), env: PROXY_ENV });
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /GH_TOKEN.*RUNBOOK\.md, step 2\.4/s);
});

test('without proxy secrets an auth failure on the first push gives the provider\'s token help, not the Instabox one', async () => {
  const f = flakyFirstPush(9, 'remote: Permission to test/repo.git denied. fatal: 403');
  const provider = createFakeProvider(undefined, { hasProxySecrets: false, hasConsentedSecrets: true });
  const { start, wait } = await setup({ ...f, provider });
  const r = await wait([await start()]);
  assert.match(r, /GitHub access check for origin \S+ failed\. Create the GH_TOKEN secret\. Also check that the token has write access to this repo\./);
  assert.ok(!r.includes('step 2.4'));
});

test('the safety push retries once', async () => {
  const sleeps = [];
  let pushes = 0;
  const { start, wait } = await setup({
    sleep: async (ms) => { sleeps.push(ms); },
    createSandbox: async () => {
      const s = await fakeSandbox();
      const run = s.commands.run;
      s.commands.run = (cmd, o) => (cmd.includes('PUSHOK') && pushes++ === 0
        ? Promise.resolve({ stdout: 'PUSHFAIL\nERR missing necessary objects\nSHA abc1234\nSTATUS_OK\n' })
        : run(cmd, o));
      return s;
    },
  });
  const r = await wait([await start({ prompt: 'EDIT' })]);
  assert.match(r, /Pushed to origin cloudy-cloud\//);
  assert.equal(pushes, 2);
  assert.equal(sleeps.length, 1);
});

test('the safety push retry uses the normal NOCHANGE and dirty-file result parser', async () => {
  let pushes = 0;
  const { start, wait, deps } = await setup({
    sleep: async () => {},
    createSandbox: async () => {
      const s = await fakeSandbox();
      const run = s.commands.run;
      s.commands.run = (cmd, o) => {
        if (!cmd.includes('PUSHOK')) return run(cmd, o);
        return Promise.resolve({ stdout: pushes++ === 0
          ? 'PUSHFAIL\nERR temporary remote failure\nSHA abc1234\nSTATUS_OK\nST ?? untracked.txt\n'
          : 'NOCHANGE\nSHA abc1234\nSTATUS_OK\nST  M a.txt\nST ?? notes.txt\n', stderr: '', exitCode: 0 });
      };
      return s;
    },
  });
  const r = await wait([await start({ prompt: 'DIRTY' })]);
  assert.match(r, /No new commits/);
  assert.match(r, /Uncommitted changes left in the sandbox.*a\.txt.*notes\.txt/);
  const id = [...deps.open.keys()][0];
  assert.equal(deps.open.get(id).result.preserve_worker, true);
  assert.equal(deps.open.get(id).result.workspace_dirty, true);
  assert.equal(deps.open.get(id).result.push_status, 'no-change');
  assert.equal(pushes, 2);
});

test('a failed git status check marks workspace state unknown and keeps the worker open', async () => {
  const { start, wait, deps } = await setup({
    createSandbox: async () => {
      const s = await fakeSandbox(getGithub());
      const run = s.commands.run;
      s.commands.run = (cmd, o) => cmd.includes('git status --porcelain')
        ? Promise.resolve({ stdout: 'NOCHANGE\nSHA abc1234\nSTATUS_FAIL\nSTATUSERR status unavailable\n', stderr: '', exitCode: 0 })
        : run(cmd, o);
      return s;
    },
  });
  const id = await start();
  const r = await wait([id]);
  const agent = deps.open.get(id);
  assert.match(r, /No new commits\. Git status could not be confirmed/);
  assert.equal(agent.status, 'idle');
  assert.equal(agent.result.error, true);
  assert.equal(agent.result.preserve_worker, true);
  assert.equal(agent.result.workspace_dirty, null);
  assert.equal(agent.result.push_status, 'no-change');
});

test('a dirty task result carries typed preservation fields for MCP clients', async () => {
  const { deps } = await setup();
  const started = await runSubagent({ prompt: 'DIRTY leave edits', description: 'dirty result' }, { ...deps, asTask: true });
  const turn = deps.tasks.get(started.taskId);
  await turn.done;
  const completed = getTask(started.taskId, deps);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.error.data.preserve_worker, true);
  assert.equal(completed.error.data.workspace_dirty, true);
  assert.equal(completed.error.data.push_status, 'no-change');
  assert.match(completed.error.message, /No new commits/);
  assert.equal(deps.open.get(turn.agent.id).status, 'idle');
});

test('a finished turn whose safety push loses contact stays open without replaying the turn', async () => {
  let turnCalls = 0;
  const { start, wait, open } = await setup({
    createSandbox: async (envs) => {
      const s = await fakeSandbox(getGithub());
      s.envs = envs;
      const run = s.commands.run;
      s.commands.run = (cmd, o) => {
        if (cmd.includes('PUSHOK')) return Promise.reject(Object.assign(new Error('lost'), { stdout: '', stderr: 'connection lost' }));
        if (cmd.includes('claude -p')) turnCalls++;
        return run(cmd, o);
      };
      return s;
    },
  });
  const id = await start();
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /could not be reached to push/);
  assert.equal(open.get(id).status, 'idle');
  assert.equal(turnCalls, 1);
});

test('a file name containing NOCHANGE is not read as the push result', async () => {
  const { start, wait } = await setup({
    sleep: async () => {},
    createSandbox: async (envs) => {
      const s = await fakeSandbox(getGithub());
      s.envs = envs;
      const run = s.commands.run;
      s.commands.run = (cmd, o) => (cmd.includes('PUSHOK') ? Promise.resolve({ stdout: 'PUSHFAIL\nERR denied\nSHA abc1234\nSTATUS_OK\nST ?? NOCHANGE-notes.txt\n', stderr: '', exitCode: 0 }) : run(cmd, o));
      return s;
    },
  });
  const r = await wait([await start({ prompt: 'EDIT' })]);
  assert.match(r, /Push failed/);
  assert.doesNotMatch(r, /No changes, no branch pushed/);
});

// ---- model profiles ----
const PKEY = 'pk-particle-secret-999';
const PROXY_ALL = 'ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,PARTICLE_API_KEY,OPENROUTER_API_KEY';
const pEnv = { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1', GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: PKEY, OPENROUTER_API_KEY: 'or-secret-777', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' };
// Gateway commands are faked (no uvx or curl here); everything else runs in the fake sandbox. health: 'ok' or a log text.
async function profileSetup(health = 'ok', env = pEnv) {
  const github = () => getGithub();
  const s = await setup({
    env,
    createSandbox: async (envs) => {
      const sbx = await fakeSandbox(github());
      sbx.envs = envs;
      const real = sbx.commands.run;
      sbx.commands.run = async (cmd, o) => {
        if (cmd.includes('litellm --config')) { sbx.cmds.push(cmd); return { stdout: '', stderr: '', exitCode: 0 }; }
        if (cmd.includes('health/liveliness')) {
          sbx.cmds.push(cmd);
          return { stdout: health === 'ok' ? 'GATEWAYOK\n' : `GATEWAYFAIL\n${health}\n`, stderr: '', exitCode: 0 };
        }
        return real(cmd, o);
      };
      sbx.written = {};
      const w = sbx.files.write;
      sbx.files.write = (p, d) => { sbx.written[p] = String(d); return w(p, d); };
      s.sandboxes.push(sbx);
      return sbx;
    },
  });
  s.sandboxes = [];
  return s;
}

test('an openai profile writes a key-free config, starts the gateway, waits for health, and runs claude without the OAuth token', async () => {
  const { start, wait, sandboxes } = await profileSetup();
  const id = await start({ profile: 'glm' });
  assert.match(await wait([id]), /status: idle[\s\S]*hello/);
  const sbx = sandboxes[0];
  const cfg = Object.entries(sbx.written).find(([p]) => p.endsWith('litellm.yaml'))[1];
  assert.match(cfg, /model: openai\/z-ai\/glm-5\.3-flash/);
  assert.match(cfg, /api_base: https:\/\/api\.particle\.ai\/v1/);
  assert.match(cfg, /api_key: os\.environ\/PARTICLE_API_KEY/);
  assert.match(cfg, /drop_params: true/);
  assert.match(cfg, /use_chat_completions_url_for_anthropic_messages: true/); // else LiteLLM calls /v1/responses, which Particle lacks (405)
  assert.ok(!cfg.includes(PKEY));
  const i = sbx.cmds.findIndex((c) => c.includes('litellm --config'));
  const j = sbx.cmds.findIndex((c) => c.includes('health/liveliness'));
  const k = sbx.cmds.findIndex((c) => c.includes('claude -p'));
  assert.ok(i > sbx.cmds.findIndex((c) => c.includes('git ls-remote')) && j > i && k > j, 'order: push, gateway, health, claude');
  assert.match(sbx.cmds[i], /nohup uvx --from 'litellm\[proxy\]' litellm .*--port 4000 > .*gateway\.log/);
  const c = sbx.cmds[k];
  for (const v of ['ANTHROPIC_BASE_URL=http://127.0.0.1:4000', 'ANTHROPIC_AUTH_TOKEN="$LITELLM_MASTER_KEY"', 'ANTHROPIC_API_KEY= ', 'ANTHROPIC_MODEL=worker', 'ANTHROPIC_SMALL_FAST_MODEL=worker']) assert.ok(c.includes(v), v);
  assert.ok(!c.includes('--model'));
  assert.deepEqual(Object.keys(sbx.envs).sort(), ["LITELLM_MASTER_KEY", "PARTICLE_API_KEY"]); // no OAuth token, no Anthropic key, no other provider's key
  assert.equal(sbx.envs.PARTICLE_API_KEY, PKEY);
  assert.match(sbx.envs.LITELLM_MASTER_KEY, /^sk-[0-9a-f]{48}$/); // LiteLLM refuses to start without a master key
  assert.ok(!sbx.cmds.join("\n").includes(sbx.envs.LITELLM_MASTER_KEY));
  assert.ok(!sbx.cmds.join('\n').includes(PKEY));
});

test('an anthropic profile sets the base URL and token, with the key only in the sandbox environment', async () => {
  const { start, wait, sandboxes } = await profileSetup();
  const id = await start({ profile: 'openrouter', model: 'deepseek/deepseek-chat' });
  await wait([id]);
  const sbx = sandboxes[0];
  const c = sbx.cmds.find((x) => x.includes('claude -p'));
  assert.ok(c.includes('ANTHROPIC_BASE_URL=https://openrouter.ai/api'));
  assert.ok(c.includes('ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"'));
  assert.ok(c.includes('ANTHROPIC_MODEL=deepseek/deepseek-chat') && !c.includes('--model'));
  assert.ok(!sbx.cmds.some((x) => x.includes('litellm')));
  assert.deepEqual(sbx.envs, { OPENROUTER_API_KEY: 'or-secret-777' });
});

test('a follow-up reuses the profile, and the list and status show it', async () => {
  const { start, wait, msg, deps, text, sandboxes } = await profileSetup();
  const id = await start({ profile: 'deepseek' });
  await wait([id]);
  assert.match(text(await listAgents({}, deps)), /profile deepseek/);
  await msg(id, 'again');
  await wait([id]);
  const runs = sandboxes[0].cmds.filter((x) => x.includes('claude -p'));
  assert.equal(runs.length, 2);
  assert.ok(runs[1].includes('--resume') && runs[1].includes('ANTHROPIC_MODEL=worker'));
});

test('a gateway that never becomes healthy fails the agent with a scrubbed log tail', async () => {
  const { start, wait, sandboxes } = await profileSetup(`boom ${PKEY} uvx: command not found`);
  const id = await start({ profile: 'particle' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /gateway \(LiteLLM\) did not become healthy/);
  assert.match(r, /uvx: command not found/);
  assert.ok(!r.includes(PKEY));
  assert.ok(!sandboxes[0].cmds.some((x) => x.includes('claude -p')));
  assert.equal(sandboxes[0].killed, true);
});

test('a missing provider key fails cloud_agent at once, before any sandbox', async () => {
  const { deps, created } = await setup({ env: { ANTHROPIC_API_KEY: SECRET, CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' } });
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'glm' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /PARTICLE_API_KEY.*cloudy-cloud setup/);
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('an unknown or invalid profile is rejected', async () => {
  const { deps } = await setup({ env: pEnv });
  for (const [profile, re] of [['nope', /unknown profile "nope"/], ['bad name; rm', /invalid profile/], ['__proto__', /invalid profile|unknown profile/]]) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', profile }, deps);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
  }
});

// Nested coordinators. The tool repo is a second repo on the fake GitHub; the launcher is a script that logs its args and runs the fake claude.
async function withTool(x) {
  const tool = await mkdtemp(join(tmpdir(), 'cc-tool-'));
  await sh(tool, 'git init -q -b main && git config user.name t && git config user.email t@t && mkdir bin');
  await writeFile(join(tool, 'bin', 'cloudy-cloud'), '#!/bin/sh\necho "LAUNCHER $* EXTRA=$CLOUDY_CLOUD_EXTRA_PROMPT COORD=$CLOUDY_CLOUD_COORDINATOR DEL=$CLOUDY_CLOUD_DELETE_AT" >> ../launcher.log\nexec claude "$@"\n');
  await chmod(join(tool, 'bin', 'cloudy-cloud'), 0o755);
  await sh(tool, 'git add -A && git commit -qm tool && git remote add origin https://github.com/test/tool.git');
  await mkdir(join(x.github, 'test', 'tool.git'));
  await sh(join(x.github, 'test', 'tool.git'), 'git init -q --bare -b main');
  await sh(tool, `git push -q ${join(x.github, 'test', 'tool.git')} main`);
  x.deps.toolRoot = tool;
  return { tool, sha: await sh(tool, 'git rev-parse HEAD') };
}
// STRIPE_API_KEY stands for any *_API_KEY in the shell that no profile uses.
const COORD_ALL = 'CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,PARTICLE_API_KEY';
const LONG_ENV = { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-1', INSTABOX_API_KEY: 'ib-key-1', PARTICLE_API_KEY: 'part-key-1', GH_TOKEN: 'ghp_secret', STRIPE_API_KEY: 'stripe-key-1', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' };

test('a coordinator gets cloudy-cloud at the laptop commit from a bundle, installs it, writes the env file without keys in commands, and runs the launcher', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV };
  const { sha } = await withTool(x);
  const id = await x.start({ role: 'coordinator', prompt: 'hi' });
  const out = await x.wait([id]);
  assert.match(out, /status: idle/);
  const s = x.created[0], home = join(s.dir, 'home');
  assert.equal(await sh(join(home, 'cloudy-cloud'), 'git rev-parse HEAD'), sha);
  assert.ok(s.writes.some((w) => w.endsWith('/cloudy-cloud.bundle')), 'tool uploaded as a bundle');
  assert.ok(!s.cmds.some((c) => /git clone/.test(c) && /tool/.test(c)), 'tool is not cloned from GitHub');
  assert.match(await readFile(join(home, 'cloudy-cloud', 'npm.log'), 'utf8'), /npm install/);
  const env = await readFile(join(home, '.config/cloudy-cloud/env'), 'utf8');
  for (const l of ['INSTABOX_API_KEY=ib-key-1', 'CLAUDE_CODE_OAUTH_TOKEN=oauth-tok-1', 'PARTICLE_API_KEY=part-key-1', 'CLOUDY_CLOUD_DEPTH=1', 'CLOUDY_CLOUD_MAX_DEPTH=3', 'CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION=200']) assert.ok(env.includes(l), l);
  assert.doesNotMatch(env, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(env, /STRIPE_API_KEY|stripe-key-1/, 'a key no profile uses stays on the laptop');
  assert.equal((await sh(home, 'stat -f %Lp .config/cloudy-cloud/env 2>/dev/null || stat -c %a .config/cloudy-cloud/env')), '600');
  assert.ok(s.writes.some((w) => w.endsWith('.config/cloudy-cloud/env')));
  for (const c of s.cmds) for (const k of ['ib-key-1', 'oauth-tok-1', 'part-key-1', SECRET]) assert.ok(!c.includes(k), `key in command: ${c}`);
  assert.equal(s.envs.CLOUDY_CLOUD_DEPTH, '1');
  assert.ok(s.cmds.some((c) => c.includes('ln -sfn ~/cloudy-cloud/skills/cloud-fleet .claude/skills/cloud-fleet')), 'nested coordinator gets the fleet skill');
  assert.ok(s.cmds.some((c) => c.includes('skipDangerousModePermissionPrompt') && c.includes('hasTrustDialogAccepted')), 'bypass confirmation and folder trust are pre-answered on a nested coordinator (#88)');
  const launched = await readFile(join(home, 'launcher.log'), 'utf8');
  assert.doesNotMatch(launched, /--append-system-prompt/); // the launcher adds its own; a second flag could replace it
  assert.match(launched, /^LAUNCHER -p --dangerously-skip-permissions --output-format stream-json --verbose .*EXTRA=.*You are on branch cloudy-cloud\/.*You are a coordinator\. You can start your own cloud subagents.*No human is watching in real time\..*QUESTION: line, answer it with cloud_agent_message\. Your workers are deleted as soon as your reply ends.*call cloud_agent_wait on every worker you started/);
  // A nested coordinator gets the same marks as a top-level one: COORDINATOR=1 turns on the built-in Agent
  // tool and the deadline hook in bin/cloudy-cloud; DELETE_AT gives them the machine's real deadline.
  assert.match(launched, /COORD=1/);
  assert.match(launched, /DEL=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  // A nested coordinator has no Remote Control: it never gets the peer variables a top-level one does.
  for (const c of s.cmds) assert.doesNotMatch(c, /CLOUDY_CLOUD_(NAME|PEERS)=/);
  assert.ok(s.cmds.some((c) => c.includes('/cloudy-cloud/bin/cloudy-cloud -p')));
  assert.match(await x.text(await listAgents({}, x.deps)), /role coordinator/);
});

test('a nested coordinator machine is labelled with the install id, so the dashboard reads its log (and a worker is not)', async () => {
  const x = await setup(), seen = [], orig = x.deps.createSandbox;
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_CONFIG: join(await mkdtemp(join(tmpdir(), 'cc-id-')), 'env') };
  x.deps.createSandbox = async (envs, opts, labels, p) => { seen.push(labels); return orig(envs, opts, labels, p); };
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' }), await x.start({ prompt: 'hi' })]);
  const coord = seen.find((l) => l.role === 'coordinator'), worker = seen.find((l) => l.role === 'worker');
  assert.equal(coord.install, installId(x.deps.env));
  assert.equal(worker.install, undefined);
  // the dashboard of the same installation reads that machine's log
  const denv = { ...x.deps.env, FAKE_API_KEY: 'fakekeyvalue-0123456789' }, provider = createFakeProvider(denv), m = await provider.create({ labels: { purpose: 'cloudy-cloud', ...coord }, ttlSeconds: 600 });
  const reads = [], getReader = async () => ({ readTail: async (id) => { reads.push(id); return { data: '', from: 0, next: 0, size: 0, fetchedAt: 1 }; }, capturePane: async () => ({ lines: [], fetchedAt: 1 }) });
  await liveState(denv, { provider, file: join(await mkdtemp(join(tmpdir(), 'cc-ev-')), 'e'), cacheMs: 0, getReader })();
  assert.ok(reads.includes(m.id));
});

test('a provider that defines coordinatorEnv adds fixed lines and its own names (not the Instabox key) to the shared allowlist; the depth lines are still added (#41)', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_CONFIG: join(await mkdtemp(join(tmpdir(), 'cc-id-')), 'env') };
  x.deps.provider.coordinatorEnv = () => ({ fixed: ['CLOUDY_CLOUD_PROVIDER=self-hosted', 'CLOUDY_CLOUD_SELF_HOSTED_LOCAL=1'], names: ['GH_TOKEN'] });
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  const env = await readFile(join(x.created[0].dir, 'home', '.config/cloudy-cloud/env'), 'utf8');
  assert.equal(env, `CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SELF_HOSTED_LOCAL=1\nGH_TOKEN=ghp_secret\nCLAUDE_CODE_OAUTH_TOKEN=oauth-tok-1\nPARTICLE_API_KEY=part-key-1\nCLOUDY_CLOUD_DEPTH=1\nCLOUDY_CLOUD_MAX_DEPTH=3\nCLOUDY_CLOUD_MAX_AGENTS_PER_SESSION=200\nCLOUDY_CLOUD_INSTALL_ID=${installId(x.deps.env)}\n`);
  assert.doesNotMatch(env, /INSTABOX/);
});

test('a coordinator at max depth is refused before any sandbox; depth goes up by one', async () => {
  const x = await setup();
  await withTool(x);
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_DEPTH: '3' };
  const r = await runSubagent({ description: 'd', prompt: 'hi', role: 'coordinator' }, x.deps);
  assert.equal(r.isError, true);
  assert.match(x.text(r), /maximum depth of 3/);
  assert.equal(x.created.length, 0);
  // A worker at that depth is fine, and a coordinator one level lower gets depth 3.
  assert.ok(await x.start({ prompt: 'hi' }));
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_DEPTH: '2', CLOUDY_CLOUD_MAX_DEPTH: '3' };
  const id = await x.start({ role: 'coordinator' });
  await x.wait([id]);
  assert.equal(x.created.at(-1).envs.CLOUDY_CLOUD_DEPTH, '3');
});

test('the per-session agent cap refuses further starts', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION: '2' };
  assert.ok(await x.start()); assert.ok(await x.start());
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, x.deps);
  assert.equal(r.isError, true);
  assert.match(x.text(r), /already started 2 agents.*MAX_AGENTS_PER_SESSION is 2/);
  await killAll(x.open);
});

test('a worker is unchanged: plain claude, no install, no env file; bad role rejected', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV };
  const id = await x.start({ role: 'worker' });
  await x.wait([id]);
  const s = x.created[0];
  assert.ok(s.cmds.some((c) => / claude -p /.test(c)) && !s.cmds.some((c) => /\/cloudy-cloud\/bin|npm install/.test(c)));
  assert.ok(!s.writes.some((w) => w.endsWith('/env')));
  assert.equal(s.envs.CLOUDY_CLOUD_DEPTH, undefined);
  assert.match(x.text(await runSubagent({ description: 'd', prompt: 'hi', role: 'boss' }, x.deps)), /invalid role/);
});

// ---- pi harness ---- (the fake pi prints synthetic events built from the documented shapes, see test/fixtures/pi-json-*.jsonl)
const piLog = (sbx) => readFile(join(sbx.dir, 'home', 'pi.log'), 'utf8');

test('a pi profile installs pinned pi, writes a key-free models.json, starts no gateway, and runs pi with the prompt from the file', async () => {
  const { start, wait, text, sandboxes, deps } = await profileSetup();
  const id = await start({ profile: 'pi-glm', prompt: 'do the thing' });
  const r = await wait([id]);
  assert.match(r, /status: idle[\s\S]*hello from pi/);
  assert.match(r, /Total: 1 tool use, 350 in \/ 30 out tokens, /);
  assert.ok(!/\$\d/.test(r), 'no cost in the result');
  const sbx = sandboxes[0], all = sbx.cmds.join('\n');
  assert.match(all, /npm install -g --ignore-scripts --prefix \S+\.local @earendil-works\/pi-coding-agent@1\.5\.0/);
  assert.ok(!all.includes('litellm') && !all.includes('uvx'));
  const cfg = JSON.parse(Object.entries(sbx.written).find(([p]) => p.endsWith('pi-agent/models.json'))[1]);
  const prov = Object.values(cfg.providers)[0];
  assert.deepEqual([prov.baseUrl, prov.api, prov.apiKey, prov.models], ['https://api.particle.ai/v1', 'openai-completions', '$PARTICLE_API_KEY', [{ id: 'z-ai/glm-5.3-flash' }]]);
  assert.ok(!JSON.stringify(sbx.written).includes(PKEY) && !all.includes(PKEY));
  assert.deepEqual(Object.keys(sbx.envs), ['PARTICLE_API_KEY']);
  const log = await piLog(sbx);
  assert.match(log, /ARGS --mode json --provider \S+ --model z-ai\/glm-5\.3-flash --append-system-prompt .*git push.*foreground/);
  assert.match(log, /DIR=\S+pi-agent PROMPT=do the thing/);
  assert.ok(!log.includes('--session'));
  assert.match(text(await listAgents({}, deps)), /profile pi-glm/);
});

test('a pi follow-up resumes the session by id', async () => {
  const { start, wait, msg, sandboxes } = await profileSetup();
  const id = await start({ profile: 'pi-deepseek' });
  await wait([id]);
  await msg(id, 'again');
  assert.match(await wait([id]), /status: idle/);
  const lines = (await piLog(sandboxes[0])).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /--session 11111111-2222-3333-4444-555555555555 /);
  assert.match(lines[1], /PROMPT=again/);
});

test('a pi run whose final assistant message is an error fails the turn and leaves the agent open', async () => {
  const { start, wait } = await profileSetup();
  const id = await start({ profile: 'pi-particle', prompt: 'PIERR now' });
  const r = await wait([id]);
  assert.match(r, /status: idle/); // the session event was seen, so the agent stays open (#49)
  assert.match(r, /ERROR: .*401 invalid api key/);
});

test('a pi worker cannot be a coordinator', async () => {
  const { deps } = await profileSetup();
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'pi-glm', role: 'coordinator' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /coordinator.*pi/);
});

// ---- omp harness ---- (fake omp prints the #36 spike fixtures, test/fixtures/omp-json-*.jsonl)
const ompLog = (sbx) => readFile(join(sbx.dir, 'home', 'omp.log'), 'utf8');

test('an omp profile installs pinned omp, writes key-free models.yml and config.yml, starts no gateway, and runs omp with the prompt from the file', async () => {
  const { start, wait, text, sandboxes, deps } = await profileSetup();
  const id = await start({ profile: 'omp-glm', prompt: 'do the thing' });
  const r = await wait([id]);
  assert.match(r, /status: idle[\s\S]*\(profile omp-glm\)/);
  assert.match(r, /Total: \d+ tool uses?, /);
  assert.ok(!/\$\d/.test(r), 'no cost in the result');
  const sbx = sandboxes[0], all = sbx.cmds.join('\n'), home = '/home/user';
  assert.ok(sbx.cmds.includes(`mkdir -p ${home}/omp-agent ${home}/.local/bin && curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v18.18.7 && test -x ${home}/.local/bin/omp`));
  assert.match(await readFile(join(sbx.dir, 'home', 'install.log'), 'utf8'), /install --binary --ref v18\.18\.7/);
  assert.ok(!all.includes('litellm') && !all.includes('uvx') && !all.includes('npm install'));
  assert.equal(sbx.written[`${home}/omp-agent/models.yml`], ompModels({ baseUrl: 'https://api.particle.ai/v1', keyName: 'PARTICLE_API_KEY', model: 'z-ai/glm-5.3-flash' }));
  assert.match(sbx.written[`${home}/omp-agent/models.yml`], /apiKey: PARTICLE_API_KEY\n/);
  assert.equal(sbx.written[`${home}/omp-agent/config.yml`], ompConfig());
  assert.equal(sbx.written[`${home}/omp-agent/overlay.yml`], ompConfig());
  assert.ok(!JSON.stringify(sbx.written).includes(PKEY) && !all.includes(PKEY));
  assert.deepEqual(Object.keys(sbx.envs), ['PARTICLE_API_KEY']);
  const log = await ompLog(sbx);
  assert.match(log, /ARGS -p --mode json --config \S+omp-agent\/overlay\.yml --model worker\/z-ai\/glm-5\.3-flash --append-system-prompt .*git push.*foreground/);
  assert.match(log, /DIR=\S+omp-agent PROMPT=do the thing/);
  assert.ok(!log.includes('--session') && !log.includes(PKEY));
  assert.match(text(await listAgents({}, deps)), /profile omp-glm/);
});

test('an omp follow-up resumes the session by id', async () => {
  const { start, wait, msg, sandboxes } = await profileSetup();
  const id = await start({ profile: 'omp-deepseek' });
  await wait([id]);
  await msg(id, 'again');
  assert.match(await wait([id]), /status: idle/);
  const lines = (await ompLog(sandboxes[0])).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /--session 01a1cb99-dd23-738e-99bd-0cfd030f263d /);
  assert.match(lines[1], /PROMPT=again/);
});

test('an omp run that exits 1 with an error message fails the turn and shows the error', async () => {
  const { start, wait } = await profileSetup();
  const r = await wait([await start({ profile: 'omp-particle', prompt: 'OMPERR now' })]);
  assert.match(r, /status: failed/);
  assert.match(r, /401 invalid api key/);
});

test('an omp worker cannot be a coordinator, and no machine starts', async () => {
  const { deps, created } = await profileSetup();
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'omp-glm', role: 'coordinator' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /coordinator cannot use a pi, omp, codex or opencode profile/);
  assert.equal(created.length, 0);
});

test('workers get a 6 hour delete deadline by default, CLOUDY_CLOUD_WORKER_HOURS changes it, and the deadline is in the list', async () => {
  const seen = [];
  const x = await setup({ createSandbox: async (envs, opts) => { seen.push(opts); return fakeSandbox(); } });
  const t0 = Date.now();
  const id = await x.start();
  await x.wait([id]);
  const { signal: sig0, ...seen0 } = seen[0];
  assert.ok(sig0 instanceof AbortSignal, 'create carries the agent-scoped abort signal');
  assert.deepEqual(seen0, { deleteAfterSeconds: 21600 });
  const iso = new Date(x.deps.open.get(id).deleteAt).toISOString();
  assert.ok(Math.abs(x.deps.open.get(id).deleteAt - (t0 + 21600_000)) < 60_000);
  assert.match(await x.text(await listAgents({}, x.deps)), new RegExp(`deleted at ${iso}`));
  x.deps.env = { ...x.deps.env, CLOUDY_CLOUD_WORKER_HOURS: '2' };
  await x.wait([await x.start()]);
  assert.equal(seen[1].deleteAfterSeconds, 7200);
  x.deps.env = { ...x.deps.env, CLOUDY_CLOUD_WORKER_HOURS: '99' };
  await x.wait([await x.start()]);
  assert.equal(seen[2].deleteAfterSeconds, 86400);
});

test('the coordinator hint tells the deadline and the finish step, with no apostrophe', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV };
  await withTool(x);
  const id = await x.start({ role: 'coordinator', prompt: 'hi' });
  await x.wait([id]);
  const launched = await readFile(join(x.created[0].dir, 'home', 'launcher.log'), 'utf8');
  const iso = new Date(x.deps.open.get(id).deleteAt).toISOString();
  assert.ok(launched.includes(`Your machine is deleted by the server at ${iso}; push your work well before then.`));
  assert.match(launched, /coordinator finish/);
  assert.match(launched, /cloud_agent_stop/);
  const cmd = x.created[0].cmds.find((c) => c.includes('CLOUDY_CLOUD_EXTRA_PROMPT='));
  assert.ok(!/EXTRA_PROMPT='[^']*'[^' ]/.test(cmd) && !cmd.slice(cmd.indexOf("EXTRA_PROMPT='") + 14).split("' ")[0].includes("'"), 'no apostrophe inside the hint');
});

// ---- MCP server delivery (#12) ----
async function mcpSetup(servers, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mcp-'));
  const file = join(dir, 'mcp.json');
  await writeFile(file, typeof servers === 'string' ? servers : JSON.stringify({ mcpServers: servers }));
  const opts = [];
  const s = await profileSetup('ok', { ...pEnv, CLOUDY_CLOUD_MCP: file, ...(over.proxy && { CLOUDY_CLOUD_PROXY_SECRETS: PROXY_ALL }) });
  if (over.proxy) s.deps.provider = proxyProvider(); // a provider with proxy secrets: tokens go as secrets, not as consented values
  if (over.events) s.deps.events = over.events;
  const inner = s.deps.createSandbox;
  s.deps.createSandbox = (envs, o) => { opts.push(o); return inner(envs, o); };
  return { ...s, opts, file };
}
const X = { x: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_X_TOKEN}' } } };
import { MERGE_MCP_SCRIPT } from '../src/worker-mcp.mjs';
const MERGE = `node -e '${MERGE_MCP_SCRIPT.replaceAll("'", "'\\''")}' $D/mcp.json /home/user/.config/cloudy-cloud/mcp.json || (umask 077; rm -f $D/mcp.json; echo '{"mcpServers":{}}' > $D/mcp.json);`;
const claudeCmd = (sbx) => sbx.cmds.find((c) => /claude -p|cloudy-cloud\/bin\/cloudy-cloud -p/.test(c));

test('a plain worker without mcp.json runs the same claude command (now inside the stream tee) and writes no mcp file', async () => {
  const { start, wait, sandboxes, opts } = await mcpSetup('{"mcpServers":{}}');
  await wait([await start({})]);
  const sbx = sandboxes[0];
  const inner = /\{ ([\s\S]*); echo \$\? > \$D\/t1\.exit; \}/.exec(claudeCmd(sbx))[1];
  assert.equal(inner.replace(/--append-system-prompt '[^']*'/, "--append-system-prompt 'HINT'").replace(/CLOUDY_CLOUD_TURN_DEADLINE=\S+ /, ''),
    MERGE + ' CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 BASH_DEFAULT_TIMEOUT_MS=1680000 BASH_MAX_TIMEOUT_MS=1680000 claude -p --dangerously-skip-permissions --output-format stream-json --verbose --mcp-config $D/mcp.json --strict-mcp-config --append-system-prompt \'HINT\' < /home/user/prompt.txt');
  assert.ok(!sbx.writes.some((p) => p.endsWith('mcp.json')));
  const { signal, ...opts0 } = opts[0];
  assert.ok(signal instanceof AbortSignal, 'create carries the agent-scoped abort signal');
  assert.deepEqual(opts0, { deleteAfterSeconds: 21600 });
});

test('a worker with an mcp.json server gets the file, the flags, the secret, the footer and the event', async () => {
  const { start, wait, sandboxes, opts } = await mcpSetup(X, { proxy: true });
  const id = await start({});
  const r = await wait([id]);
  const sbx = sandboxes[0], home = '/home/user';
  assert.deepEqual(opts[0].secrets, ['CLAUDE_CODE_OAUTH_TOKEN', 'MCP_X_TOKEN']);
  assert.equal(sbx.written[`${home}/.config/cloudy-cloud/mcp.json`], JSON.stringify({ mcpServers: X }, null, 2));
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${home}/.config/cloudy-cloud/mcp.json`)));
  assert.match(claudeCmd(sbx), /--verbose --mcp-config \$D\/mcp\.json --strict-mcp-config --append-system-prompt/);
  assert.ok(claudeCmd(sbx).includes(`' $D/mcp.json ${home}/.config/cloudy-cloud/mcp.json ||`), 'the merge reads the shared file');
  assert.match(r, /MCP servers: x/);
  assert.ok(!JSON.stringify(sbx.envs).includes('MCP_'), 'no MCP value in the sandbox env');
});

test('the agent event lists the MCP server names only', async () => {
  const events = [];
  const { start, wait } = await mcpSetup(X, { proxy: true, events: (e) => events.push(e) });
  await wait([await start({})]);
  assert.deepEqual(events.find((e) => e.type === 'agent').mcp, ['x']);
});

test('a rejected server is named with its reason in the footer and not delivered', async () => {
  const { start, wait, sandboxes } = await mcpSetup({ ...X, bad: { type: 'http', url: 'http://localhost:1/mcp' } });
  const r = await wait([await start({})]);
  assert.match(r, /MCP servers skipped: bad \(url points at localhost/);
  assert.ok(!JSON.stringify(sandboxes[0].written).includes('localhost'));
});

test('a pi worker gets its mcp.json in the agent dir, the secrets, and the footer; SSE is skipped', async () => {
  const servers = { ...X, s: { type: 'sse', url: 'https://s.example.com/sse' }, npxone: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] } };
  const ev = [];
  const { start, wait, sandboxes, opts } = await mcpSetup(servers, { proxy: true, events: (e) => ev.push(e) });
  const r = await wait([await start({ profile: 'pi-glm' })]);
  const sbx = sandboxes[0], home = '/home/user';
  assert.equal(sbx.written[`${home}/pi-agent/mcp.json`], mcpConfigText({ x: servers.x, npxone: servers.npxone }));
  assert.ok(sbx.cmds.some((c) => c.includes('umask 077') && c.includes(`: > ${home}/pi-agent/mcp.json`)));
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${home}/pi-agent/mcp.json`)));
  assert.ok(!sbx.writes.some((p) => p.includes('.config/cloudy-cloud/mcp.json')));
  assert.deepEqual(opts[0].secrets, ['PARTICLE_API_KEY', 'MCP_X_TOKEN']);
  assert.match(r, /MCP servers: x, npxone/);
  assert.match(r, /MCP servers skipped: s \(pi does not support the SSE transport\)/);
  assert.deepEqual(ev.find((e) => e.type === 'agent').mcp, ['x', 'npxone']);
  assert.ok(!(await piLog(sbx)).includes('mcp'), 'the pi command is unchanged');
});

test('an omp worker gets its mcp.json (SSE kept) in omp-agent with the 600 sequence, and no key value anywhere', async () => {
  const servers = { ...X, s: { type: 'sse', url: 'https://s.example.com/sse' } };
  const { start, wait, sandboxes, opts } = await mcpSetup(servers, { proxy: true });
  const r = await wait([await start({ profile: 'omp-glm' })]);
  const sbx = sandboxes[0], home = '/home/user';
  assert.equal(sbx.written[`${home}/omp-agent/mcp.json`], mcpConfigText(servers));
  assert.ok(sbx.cmds.some((c) => c.includes('umask 077') && c.includes('chmod 700') && c.includes(`: > ${home}/omp-agent/mcp.json`)));
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${home}/omp-agent/mcp.json`)));
  assert.ok(!sbx.writes.some((p) => p.includes('.config/cloudy-cloud/mcp.json')));
  assert.deepEqual(opts[0].secrets, ['PARTICLE_API_KEY', 'MCP_X_TOKEN']);
  assert.match(r, /MCP servers: x, s/);
  assert.ok(!/skipped/.test(r));
  assert.ok(!(await ompLog(sbx)).includes('mcp'), 'the omp command is unchanged');
});

test('a pi worker without an mcp.json has no MCP write and no MCP footer line', async () => {
  const { start, wait, sandboxes, opts, file } = await mcpSetup('{}');
  await rm(file);
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.ok(!sandboxes[0].writes.some((p) => p.endsWith('mcp.json')));
  assert.ok(!/MCP/.test(r));
  assert.equal(opts[0].secrets, undefined);
});

test('a Claude worker still gets an SSE server', async () => {
  const sse = { s: { type: 'sse', url: 'https://s.example.com/sse' } };
  const { start, wait, sandboxes } = await mcpSetup(sse);
  await wait([await start({})]);
  assert.deepEqual(JSON.parse(sandboxes[0].written['/home/user/.config/cloudy-cloud/mcp.json']).mcpServers, sse);
});

test('invalid mcp.json fails the first turn with the file name', async () => {
  const { start, wait, file } = await mcpSetup('{nope');
  const r = await wait([await start({})]);
  assert.match(r, new RegExp(`Could not read ${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
});

test('a server with literal values is delivered only when the user consented, and then the footer says so', async () => {
  const lit = { type: 'http', url: 'https://l.example.com/mcp', headers: { Authorization: 'Bearer abc123verysecret' } };
  const { start, wait, sandboxes, opts } = await mcpSetup({ no: lit, yes: { ...lit, cloudyCloudAllowLiteral: true } });
  const r = await wait([await start({})]);
  const file = JSON.parse(sandboxes[0].written['/home/user/.config/cloudy-cloud/mcp.json']);
  assert.deepEqual(Object.keys(file.mcpServers), ['yes']);
  assert.equal(file.mcpServers.yes.cloudyCloudAllowLiteral, undefined);
  assert.equal(file.mcpServers.yes.headers.Authorization, 'Bearer abc123verysecret');
  assert.match(r, /MCP servers skipped: no \(contains a secret value/);
  assert.match(r, /real token on the machine[^\n]*yes/);
  assert.equal(opts[0].secrets, undefined);
});

test('MCP secret names can never be copied into coordinator key files', async () => {
  const { PROVIDER_KEY } = await import('../src/config.mjs');
  assert.ok(!PROVIDER_KEY.test('MCP_X_TOKEN'));
});

test('a consented server is still delivered when another rejected server comes before it in the file', async () => {
  const lit = { type: 'http', url: 'https://l.example.com/mcp', headers: { Authorization: 'Bearer abc123verysecret' }, cloudyCloudAllowLiteral: true };
  const { start, wait, sandboxes } = await mcpSetup({ bad: { type: 'http', url: 'http://localhost:1/mcp' }, yes: lit });
  const r = await wait([await start({})]);
  assert.deepEqual(Object.keys(JSON.parse(sandboxes[0].written['/home/user/.config/cloudy-cloud/mcp.json']).mcpServers), ['yes']);
  assert.match(r, /MCP servers skipped: bad \(/);
});

test('with no mcp.json at all the footer has no MCP line and no secrets are passed', async () => {
  const { start, wait, sandboxes, opts, file } = await mcpSetup('{}');
  await rm(file);
  const r = await wait([await start({})]);
  assert.doesNotMatch(r, /MCP/);
  assert.match(claudeCmd(sandboxes[0]), /--mcp-config \$D\/mcp\.json --strict-mcp-config/);
  const { signal, ...opts0 } = opts[0];
  assert.ok(signal instanceof AbortSignal, 'create carries the agent-scoped abort signal');
  assert.deepEqual(opts0, { deleteAfterSeconds: 21600 });
});

test('a coordinator gets mcp.json next to its env file and passes it to the launcher after the launcher-bound flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mcp-'));
  const file = join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: X }));
  const x = await setup({ provider: proxyProvider() });
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_MCP: file, CLOUDY_CLOUD_PROXY_SECRETS: COORD_ALL };
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  const s = x.created[0], home = join(s.dir, 'home');
  assert.deepEqual(JSON.parse(await readFile(join(home, '.config/cloudy-cloud/mcp.json'), 'utf8')), { mcpServers: X });
  assert.ok(await readFile(join(home, '.config/cloudy-cloud/env'), 'utf8'), 'env file still written');
  assert.ok(!(await readFile(join(home, '.config/cloudy-cloud/env'), 'utf8')).includes('MCP_'), 'no MCP name in the coordinator key file');
  assert.match(await readFile(join(home, 'launcher.log'), 'utf8'), /^LAUNCHER -p .*--mcp-config \S+\/\.config\/cloudy-cloud\/mcp\.json --strict-mcp-config/);
});

test('consent never delivers a secret in a url or an argument', async () => {
  const k = 'sk-ant-api03-' + 'a'.repeat(40);
  const { start, wait, sandboxes } = await mcpSetup({
    u: { type: 'http', url: `https://u.example.com/mcp?key=${k}`, cloudyCloudAllowLiteral: true },
    g: { command: 'npx', args: ['-y', 'srv', k], cloudyCloudAllowLiteral: true },
  });
  const r = await wait([await start({})]);
  assert.match(r, /MCP servers skipped: u \(url carries a secret value[^\n]*; g \(argument 3 carries a secret value/);
  assert.ok(!JSON.stringify(sandboxes[0].written).includes(k));
});

const OPAQUE = 'OpaqueCredentialExample938412';
const OPAQUE_SERVER = { type: 'http', url: 'https://l.example.com/mcp', headers: { 'X-Api-Key': OPAQUE }, cloudyCloudAllowLiteral: true };

test('a consented literal token echoed by the agent is scrubbed from the reply, the events and follow-up turns', async () => {
  const events = [];
  const { start, wait, msg } = await mcpSetup({ yes: OPAQUE_SERVER }, { events: (e) => events.push(e) });
  const id = await start({ prompt: `ECHO ${OPAQUE}` });
  const r = await wait([id]);
  assert.ok(!r.includes(OPAQUE), r);
  await msg(id, `ECHO again ${OPAQUE}`);
  const r2 = await wait([id]);
  assert.ok(!r2.includes(OPAQUE), r2);
  assert.ok(r2.includes('[redacted]'), 'the echo reached the reply, so the scrub is what hid it');
  assert.ok(!JSON.stringify(events).includes(OPAQUE), 'events never hold the token');
});

test('the mcp.json with a real token is created inside a mode-700 folder with umask 077 before any byte is written', async () => {
  const { start, wait, sandboxes } = await mcpSetup({ yes: OPAQUE_SERVER });
  await wait([await start({})]);
  const sbx = sandboxes[0];
  const dir = '/home/user/.config/cloudy-cloud';
  const i = sbx.cmds.findIndex((c) => /umask 077/.test(c) && c.includes(`mkdir -p ${dir}`) && c.includes(`chmod 700 ${dir}`) && c.includes(`: > ${dir}/mcp.json`));
  assert.ok(i >= 0, sbx.cmds.join('\n'));
  assert.ok(sbx.writeAt[`${dir}/mcp.json`] > i, 'the file is written after the private folder and empty file exist');
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${dir}/mcp.json`)));
  assert.ok(!sbx.cmds.some((c) => c.includes(OPAQUE)), 'the token is never on a command line');
});

test('consent does not reach the workers of a coordinator: the file a coordinator hands down has no consent flag and the loader rejects the server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mcp-'));
  const file = join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: { yes: OPAQUE_SERVER } }));
  const x = await setup();
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_MCP: file };
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  const home = join(x.created[0].dir, 'home');
  const handed = JSON.parse(await readFile(join(home, '.config/cloudy-cloud/mcp.json'), 'utf8'));
  assert.equal(handed.mcpServers.yes.headers['X-Api-Key'], OPAQUE, 'the coordinator itself has the server');
  assert.equal(handed.mcpServers.yes.cloudyCloudAllowLiteral, undefined);
  const { loadMcp } = await import('../src/mcpsync.mjs');
  const worker = loadMcp({ CLOUDY_CLOUD_MCP: join(home, '.config/cloudy-cloud/mcp.json') });
  assert.deepEqual(Object.keys(worker.servers), []);
  assert.equal(worker.skipped[0].name, 'yes');
});

test('the core creates machines through provider.create, with names only in envs', async () => {
  const provider = createFakeProvider();
  const x = await setup({ createSandbox: undefined, provider, owner: 'o1', env: PROXY_ENV });
  const id = await x.start();
  assert.match(await x.wait([id]), /status: idle/);
  assert.equal(provider.log.create.length, 1);
  const { envs, signal, ...rest } = provider.log.create[0];
  assert.ok(signal instanceof AbortSignal, 'provider.create carries the agent-scoped abort signal');
  assert.deepEqual(rest, { image: 'agent-browser', kind: { name: 'linux', label: 'linux' }, labels: { purpose: 'cloudy-cloud', owner: 'o1', role: 'worker', profile: 'claude', parent: 'o1', agent: id, description: 'd' }, ttlSeconds: 21600, secrets: ['ANTHROPIC_API_KEY'] });
  assert.deepEqual(Object.keys(envs), []); // the key goes as a secret name, never as a value
});

test('a provider without proxy secrets is refused before any machine starts', async () => {
  const provider = createFakeProvider();
  provider.caps.hasProxySecrets = false;
  const x = await setup({ createSandbox: undefined, provider });
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, x.deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Provider fake cannot keep the GitHub token off the machine; cloudy-cloud only runs on providers with proxy secrets\. On your own machine you can allow it: run cloudy-cloud setup and answer yes to the GitHub token question\./);
  assert.equal(provider.log.create.length, 0);
});

test('a provider without proxy secrets but with consent runs, and every reply says where the token is', async () => {
  const provider = createFakeProvider(undefined, { hasProxySecrets: false, hasConsentedSecrets: true });
  provider.text.hostLabel = 'box1';
  const x = await setup({ provider });
  const r = await x.wait([await x.start({})]);
  assert.match(r, /\nGitHub token: stored on box1 \(you allowed it\)/);
});

test('with proxy secrets the reply has no token line', async () => {
  const x = await setup({ provider: proxyProvider(), env: PROXY_ENV });
  assert.ok(!(await x.wait([await x.start({})])).includes('GitHub token:'));
});

test('a token value in a sandbox error is scrubbed from the reply', async () => {
  const provider = createFakeProvider(undefined, { hasProxySecrets: false, hasConsentedSecrets: true });
  const x = await setup({ provider });
  const r = await x.wait([await x.start({ prompt: 'FAIL ghp_secret' })]);
  assert.ok(!r.includes('ghp_secret'));
});

// ---- MCP tokens on a provider without proxy secrets (#41) ----
for (const profile of [undefined, 'pi-glm', 'omp-glm']) test(`without proxy secrets (${profile ?? 'claude'}) an MCP token reference needs --allow-literal; only consented tokens are requested and scrubbed`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mcp-'));
  const file = join(dir, 'mcp.json');
  const ref = (v) => ({ type: 'http', url: 'https://m.example.com/mcp', headers: { Authorization: `Bearer \${${v}}` } });
  await writeFile(file, JSON.stringify({ mcpServers: { x: ref('MCP_X_TOKEN'), y: { ...ref('MCP_Y_TOKEN'), cloudyCloudAllowLiteral: true } } }));
  const provider = createFakeProvider(undefined, { hasProxySecrets: false, hasConsentedSecrets: true });
  const env = { ...pEnv, CLOUDY_CLOUD_MCP: file, MCP_X_TOKEN: 'xtoken-not-consented', MCP_Y_TOKEN: 'ytoken-consented-1' };
  const x = await setup({ createSandbox: undefined, provider, env });
  const r = await x.wait([await x.start({ prompt: 'FAIL ytoken-consented-1', ...(profile && { profile }) })]);
  const { secrets } = provider.log.create[0];
  assert.deepEqual(secrets, ['MCP_Y_TOKEN']);
  assert.match(r, /MCP servers skipped: x \(.*--allow-literal/);
  assert.ok(!r.includes('ytoken-consented-1') && !r.includes('xtoken-not-consented'));
});

test('a coordinator is refused before any machine starts when the provider says it cannot host one (#41)', async () => {
  const provider = createFakeProvider();
  provider.text.coordinatorRefusal = 'Coordinators are not supported on fake yet.';
  const x = await setup({ createSandbox: undefined, provider });
  const r = await runSubagent({ description: 'd', prompt: 'hi', role: 'coordinator' }, x.deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not supported on fake yet/);
  assert.equal(provider.log.create.length, 0);
});

test('the default create passes the role to the provider so a self-hosted coordinator can get the Docker socket (#41)', async () => {
  const calls = [];
  const provider = createFakeProvider();
  provider.create = async (o) => { calls.push(o); throw new Error('stop here'); };
  const x = await setup({ createSandbox: null, provider, env: PROXY_ENV });
  await x.wait([await x.start({ role: 'coordinator' })]);
  await x.wait([await x.start({ role: 'worker' })]);
  assert.deepEqual(calls.map((c) => c.role), ['coordinator', undefined]); // a worker's create args stay as before
});

// ---- #64: keys reach workers as proxy secrets, never as env values ----
const PROXIED = 'PARTICLE_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENROUTER_API_KEY';
for (const [profile, key] of [['glm', 'PARTICLE_API_KEY'], ['pi-glm', 'PARTICLE_API_KEY'], ['omp-glm', 'PARTICLE_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY'], [undefined, 'CLAUDE_CODE_OAUTH_TOKEN']]) {
  test(`proxy secrets: a ${profile ?? 'default'} worker gets ${key} as a secret name, not an env value`, async () => {
    const { deps, start, wait } = await setup({ provider: proxyProvider() });
    delete deps.createSandbox;
    deps.env = { GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROXY_SECRETS: PROXIED };
    await wait([await start({ profile, ...(profile === 'openrouter' && { model: 'deepseek/deepseek-chat' }) })]);
    const c = deps.provider.log.create[0];
    assert.ok(c.secrets.includes(key), `secrets ${c.secrets}`);
    assert.deepEqual(Object.keys(c.envs).filter((k) => /_API_KEY$|_TOKEN$/.test(k)), []);
  });
}

test('a key value in env that is not a proxy secret is refused on a provider with proxy secrets (#68)', async () => {
  const { deps, start, wait } = await setup({ provider: proxyProvider() });
  delete deps.createSandbox;
  deps.env = { GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: 'pk-legacy-value' };
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'pi-glm' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /keeps keys off machines/);
  assert.ok(!r.content[0].text.includes('pk-legacy-value'));
  assert.equal(deps.provider.log.create.length, 0);
});

test('a provider without proxy secrets ignores CLOUDY_CLOUD_PROXY_SECRETS and keeps the env value', async () => {
  const { deps, start, wait } = await setup();
  delete deps.createSandbox;
  deps.provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  deps.env = { PARTICLE_API_KEY: 'pk-x', CLOUDY_CLOUD_PROXY_SECRETS: 'PARTICLE_API_KEY' };
  await wait([await start({ profile: 'pi-glm' })]);
  assert.equal(deps.provider.log.create[0].envs.PARTICLE_API_KEY, 'pk-x');
});

// ---- caps.localSecrets (microsandbox): a plain local value is attached by name, no CLOUDY_CLOUD_PROXY_SECRETS needed ----
test('localSecrets: a plain Claude value goes as a secret name, never an env value', async () => {
  const { deps, start, wait } = await setup({ provider: proxyProvider() });
  delete deps.createSandbox;
  deps.provider.caps.localSecrets = true;
  deps.env = { GH_TOKEN: 'ghp_secret', CLAUDE_CODE_OAUTH_TOKEN: 'cc-local-token-value' };
  await wait([await start()]);
  const c = deps.provider.log.create[0];
  assert.ok(c.secrets.includes('CLAUDE_CODE_OAUTH_TOKEN'), `secrets ${c.secrets}`);
  assert.ok(!Object.keys(c.envs).includes('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('localSecrets: a profile key with a plain local value resolves and goes as a secret name', async () => {
  const { deps, start, wait } = await setup({ provider: proxyProvider() });
  delete deps.createSandbox;
  deps.provider.caps.localSecrets = true;
  deps.env = { GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: 'pk-local-value' };
  await wait([await start({ profile: 'pi-glm' })]);
  const c = deps.provider.log.create[0];
  assert.ok(c.secrets.includes('PARTICLE_API_KEY'), `secrets ${c.secrets}`);
  assert.ok(!Object.keys(c.envs).includes('PARTICLE_API_KEY'));
});

test('localSecrets: a credential named only in CLOUDY_CLOUD_PROXY_SECRETS gets the put-the-value-in-the-env-file fix', async () => {
  const { deps } = await setup({ provider: proxyProvider() });
  delete deps.createSandbox;
  deps.provider.caps.localSecrets = true;
  deps.env = { GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN' };
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  await new Promise((res) => setTimeout(res, 300));
  const all = JSON.stringify(r) + JSON.stringify(await listAgents({}, deps));
  assert.match(all, /named in CLOUDY_CLOUD_PROXY_SECRETS but has no value/);
  assert.match(all, /value stays on this computer/);
  assert.doesNotMatch(all, /instabox/i);
  assert.equal(deps.provider.log.create.length, 0);
});

test('localSecrets: a credential with a local value beats a name only listed in CLOUDY_CLOUD_PROXY_SECRETS', async () => {
  const { deps, start, wait } = await setup({ provider: proxyProvider() });
  delete deps.createSandbox;
  deps.provider.caps.localSecrets = true;
  deps.env = { GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN', ANTHROPIC_API_KEY: 'ak-local-value' };
  const id = await start();
  assert.ok(id, 'the valued credential must win over the stale name');
  await wait([id]);
  const c = deps.provider.log.create[0];
  assert.ok(c.secrets.includes('ANTHROPIC_API_KEY'), `secrets ${c.secrets}`);
  assert.ok(!c.secrets.includes('CLAUDE_CODE_OAUTH_TOKEN'), `secrets ${c.secrets}`);
});

test('localSecrets: preflight never fetches the local key from this computer', async () => {
  resetPreflightCache();
  const log = [];
  const { deps, start, wait } = await setup({ provider: proxyProvider(), fetchFn: fetchWith(200, '{}', log) });
  delete deps.createSandbox;
  deps.provider.caps.localSecrets = true;
  deps.env = { GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: 'pk-local-value', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' };
  const id = await start({ profile: 'pi-glm' });
  assert.ok(id);
  await wait([id]);
  assert.equal(log.length, 0, `preflight calls: ${JSON.stringify(log.map((l) => l.url))}`);
});

// ---- #48: labels and the agent tree ----
test('a worker is labelled with role, profile, parent and agent', async () => {
  const { deps, start, wait } = await setup({ provider: proxyProvider() });
  delete deps.createSandbox;
  deps.owner = 'owner123';
  deps.env = { GH_TOKEN: 'ghp_secret', PARTICLE_API_KEY: 'pk-secret-value', CLOUDY_CLOUD_PROXY_SECRETS: 'PARTICLE_API_KEY' };
  const id = await start({ profile: 'pi-deepseek', description: 'Fix the login bug: it has spaces & a token pk-secret-value' });
  await wait([id]);
  const l = deps.provider.log.create[0].labels;
  assert.deepEqual([l.purpose, l.owner, l.role, l.profile, l.parent, l.agent], ['cloudy-cloud', 'owner123', 'worker', 'pi-deepseek', 'owner123', id]);
  assert.match(l.description, /^[A-Za-z0-9_.-]{1,60}$/);
  assert.ok(!l.description.includes('secret-value'), l.description); // the key value is redacted
});

test('a default worker has profile claude', async () => {
  const { deps, start, wait } = await setup();
  delete deps.createSandbox;
  deps.owner = 'o1';
  await wait([await start()]);
  assert.equal(deps.provider.log.create[0].labels.profile, 'claude');
});

test('cloud_agent_list all:true groups every cloudy-cloud machine under its parent and shows coordinator names', async () => {
  const { deps, text } = await setup();
  const mk = (id, labels) => deps.provider.machines.set(id, { id, name: id, labels: { purpose: 'cloudy-cloud', ...labels }, state: 'running', status: 'running', startedAt: Date.now() });
  mk('m1', { owner: 'o1', parent: 'o1', role: 'worker', profile: 'claude', agent: 'aaaa1111' });
  mk('m2', { owner: 'o2', parent: 'coord-x', role: 'worker', profile: 'pi-glm', agent: 'bbbb2222', description: 'build-the-thing' });
  mk('m3', { purpose: 'other', owner: 'o3' });
  mk('m4', { owner: 'o4', parent: 'o4', role: 'coordinator', name: 'coord-b', install: 'i1' }); // the name is how other sessions message it
  const response = await listAgents({ all: true }, deps);
  const r = text(response);
  assert.match(r, /parent o1\n[^\n]*m1[^\n]*aaaa1111/);
  assert.match(r, /parent coord-x\n[^\n]*m2[^\n]*pi-glm[^\n]*build-the-thing/);
  assert.match(r, /m4[^\n]*coordinator[^\n]*name coord-b/);
  assert.ok(!r.includes('m3'));
  assert.equal(response.structuredContent.scope, 'provider');
  assert.deepEqual(response.structuredContent.agents.map(({ id, parent, role, profile, agent_id, description }) => ({ id, parent, role, profile, agent_id, description })), [
    { id: 'm1', parent: 'o1', role: 'worker', profile: 'claude', agent_id: 'aaaa1111', description: null },
    { id: 'm2', parent: 'coord-x', role: 'worker', profile: 'pi-glm', agent_id: 'bbbb2222', description: 'build-the-thing' },
    { id: 'm4', parent: 'o4', role: 'coordinator', profile: null, agent_id: undefined, description: null },
  ]);
  assert.equal(Object.hasOwn(response.structuredContent.agents[2], 'agent_id'), false, 'machines without an agent label omit the optional field');
});

test('cloud_agent_list all:true returns typed errors when provider fleet listing fails or is partial', async () => {
  const { deps } = await setup();
  deps.provider.list = async () => { throw Object.assign(new Error('Boat unavailable'), { code: 'transient', provider: 'boat' }); };
  const failed = await listAgents({ all: true }, deps);
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.scope, 'provider');
  assert.deepEqual(failed.structuredContent.agents, []);
  assert.deepEqual(failed.structuredContent.provider_errors, [{ provider: 'boat', code: 'transient', message: 'Could not list cloudy-cloud machines on boat: Boat unavailable' }]);

  deps.provider.list = async (_labels, { onError }) => {
    onError(Object.assign(new Error('Second provider unavailable'), { code: 'transient', provider: 'secondary' }));
    return [{ id: 'visible', state: 'running', status: 'running', labels: { purpose: 'cloudy-cloud', owner: 'o1' } }];
  };
  const partial = await listAgents({ all: true }, deps);
  assert.equal(partial.structuredContent.agents[0].id, 'visible');
  assert.deepEqual(partial.structuredContent.provider_errors.map(({ provider, code }) => [provider, code]), [['secondary', 'transient']]);
  assert.match(partial.content[0].text, /Provider listing is incomplete: secondary \(transient\)/);
});

// A coordinator gets the operator's install id as trusted config (CLOUDY_CLOUD_INSTALL_ID): its
// cloud_agent_list still marks this installation's coordinators instead of seeing them all as foreign.
test('cloud_agent_list all:true marks this installation\'s coordinators through the CLOUDY_CLOUD_INSTALL_ID override', async () => {
  const { deps, text } = await setup();
  deps.env = { CLOUDY_CLOUD_CONFIG: join(await mkdtemp(join(tmpdir(), 'cc-id-')), 'env'), CLOUDY_CLOUD_INSTALL_ID: 'aaaa1111bbbb2222' };
  const mk = (id, labels) => deps.provider.machines.set(id, { id, name: id, labels: { purpose: 'cloudy-cloud', ...labels }, state: 'running', status: 'running', startedAt: Date.now() });
  mk('m1', { role: 'coordinator', name: 'coord-b', install: 'aaaa1111bbbb2222' });
  mk('m2', { role: 'coordinator', name: 'coord-c', install: 'cccc3333dddd4444' });
  mk('m3', { owner: 'o1', parent: 'o1', role: 'worker', install: 'aaaa1111bbbb2222' });
  const r = text(await listAgents({ all: true }, deps));
  assert.match(r, /m1[^\n]*\(this installation\)/);
  assert.ok(!/m2[^\n]*\(this installation\)/.test(r), 'a foreign install label is never marked');
  assert.ok(!/m3[^\n]*\(this installation\)/.test(r), 'only coordinators are marked');
});

// ---- #47: optional apt packages ----
test('CLOUDY_CLOUD_APT_PACKAGES installs the packages with one apt command; without it no apt command runs', async () => {
  for (const [pkgs, expected] of [['ffmpeg postgresql-client', 1], [undefined, 0]]) {
    const cmds = [];
    const { deps, start, wait } = await setup({ createSandbox: async (envs) => { const s = await fakeSandbox(); const run = s.commands.run; s.commands.run = (c, o) => { cmds.push(c); return /apt-get/.test(c) ? Promise.resolve({ stdout: '' }) : run(c, o); }; return s; }, provider: proxyProvider() });
    deps.env = { GH_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: SECRET, CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY', ...(pkgs && { CLOUDY_CLOUD_APT_PACKAGES: pkgs }) };
    await wait([await start()]);
    const apt = cmds.filter((c) => /apt-get/.test(c));
    assert.equal(apt.length, expected);
    if (pkgs) assert.match(apt[0], /sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg postgresql-client/);
  }
});

test('a package name with a shell character is rejected at start, before any machine', async () => {
  const { deps } = await setup();
  deps.env = { GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_APT_PACKAGES: 'ffmpeg; rm -rf /' };
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /CLOUDY_CLOUD_APT_PACKAGES/);
  assert.equal(deps.provider.log.create.length, 0);
});

// ---- review fixes (#64, #47, #48) ----
test('a coordinator env file carries the proxy secret names', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN', CLOUDY_CLOUD_APT_PACKAGES: '' };
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  const env = await readFile(join(x.created[0].dir, 'home', '.config/cloudy-cloud/env'), 'utf8');
  assert.match(env, /^CLOUDY_CLOUD_PROXY_SECRETS=CLAUDE_CODE_OAUTH_TOKEN$/m);
});

test('a Claude key named only in CLOUDY_CLOUD_PROXY_SECRETS is refused on a provider without proxy secrets', async () => {
  const { deps } = await setup();
  deps.provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  deps.env = { CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN' };
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  await new Promise((res) => setTimeout(res, 300));
  const all = JSON.stringify(r) + JSON.stringify(await listAgents({}, deps));
  assert.match(all, /cannot attach proxy secrets/);
});

// An Instabox OAuth proxy-secret name left behind after switching providers must not shadow a
// credential with a local value: the provider cannot resolve the name, so the value wins (#198).
for (const pname of ['e2b', 'boat']) {
  test(`a stale proxy-secret name does not block a credential with a local value (${pname})`, async () => {
    const { deps, start, wait } = await setup();
    delete deps.createSandbox;
    deps.provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
    deps.provider.name = pname;
    deps.env = { GH_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'ak-local-value', CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN' };
    const id = await start();
    assert.ok(id, `${pname}: the valued credential wins over the stale name`);
    await wait([id]);
    const c = deps.provider.log.create[0];
    assert.equal(c.envs.ANTHROPIC_API_KEY, 'ak-local-value', `${pname}: the local value is what goes onto the sandbox`);
    assert.ok(!c.secrets?.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'the unresolvable name is not sent as a secret');
  });
}

test('a deadline the provider reports replaces the requested one before the machine event', async () => {
  const events = [];
  const real = Date.now() + 3_600_000; // the provider accepted an hour, not the requested six
  const { deps, start, wait, open } = await setup({
    events: (e) => events.push(e),
    createSandbox: async () => { const s = await fakeSandbox(); s.deleteAt = real; return s; },
  });
  const id = await start();
  await wait([id]);
  assert.equal(open.get(id).deleteAt, real, 'a.deleteAt adopts the handle\'s real deadline');
  assert.equal(events.find((e) => e.type === 'machine').deleteAt, real, 'the machine event reports it');
  const cmd = open.get(id).sandbox.cmds.find((c) => c.includes('claude -p'));
  assert.ok(cmd.includes(new Date(real).toISOString()), 'the worker prompt budgets against the real deadline');
});

test('apt packages are refused at start on a provider without sudo', async () => {
  const { deps } = await setup();
  deps.provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  deps.provider.name = 'self-hosted';
  deps.env = { CLOUDY_CLOUD_APT_PACKAGES: 'ffmpeg' };
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /docker\/worker\.Dockerfile/);
  assert.equal(deps.provider.log.create.length, 0);
});

test('apt packages install on a provider with sudo but no proxy secrets (boat)', async () => {
  const cmds = [];
  const provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true, hasSudo: true });
  provider.name = 'boat';
  const { deps, start, wait } = await setup({ provider, createSandbox: async (envs) => { const s = await fakeSandbox(); const run = s.commands.run; s.commands.run = (c, o) => { cmds.push(c); return /apt-get/.test(c) ? Promise.resolve({ stdout: '' }) : run(c, o); }; return s; } });
  deps.env = { GH_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: SECRET, CLOUDY_CLOUD_APT_PACKAGES: 'ffmpeg' };
  await wait([await start()]);
  assert.match(cmds.find((c) => /apt-get/.test(c)) ?? '', /sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg/, 'hasSudo, not hasProxySecrets, allows the install');
});

test('an explicit hasSudo false refuses apt even on a provider with proxy secrets', async () => {
  const { deps } = await setup();
  deps.provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasSudo: false });
  deps.env = { GH_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: SECRET, CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY', CLOUDY_CLOUD_APT_PACKAGES: 'ffmpeg' };
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /docker\/worker\.Dockerfile/);
  assert.equal(deps.provider.log.create.length, 0);
});

test('apt packages accept one pair of surrounding quotes, as written in the docs', async () => {
  const { aptPackages } = await import('../src/config.mjs');
  assert.deepEqual(aptPackages({ CLOUDY_CLOUD_APT_PACKAGES: '"ffmpeg postgresql-client"' }).list, ['ffmpeg', 'postgresql-client']);
  assert.deepEqual(aptPackages({ CLOUDY_CLOUD_APT_PACKAGES: "'ffmpeg'" }).list, ['ffmpeg']);
});

test('a turn keeps its stream on the machine and, redacted, in a private folder on this laptop', async () => {
  const streams = join(await mkdtemp(join(tmpdir(), 'cc-streams-')), 'streams');
  const { start, wait, msg, created } = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_STREAMS: streams } });
  const id = await start({ prompt: `ECHO use ${SECRET} and ghp_secret`, description: `deploy with ${SECRET}` });
  await wait([id]);
  await msg(id, 'again');
  await wait([id]);
  const dir = join(created[0].dir, 'home/.config/cloudy-cloud/stream');
  const onMachine = await readFile(join(dir, 't1.jsonl'), 'utf8');
  assert.match(onMachine, /"type":"tool_use"/);
  assert.match(onMachine, /"type":"result"/);
  assert.ok(await readFile(join(dir, 't2.jsonl'), 'utf8'));
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.agent, id);
  assert.equal(meta.branch, `cloudy-cloud/${id}`);
  assert.equal(meta.description, 'deploy with [redacted]');
  assert.deepEqual(meta.turns.map((t) => [t.n, t.exit, typeof t.startedAt, typeof t.endedAt]), [[1, 0, 'number', 'number'], [2, 0, 'number', 'number']]);
  // laptop copy: private, valid JSON per line, no key value
  assert.equal((await stat(join(streams, id))).mode & 0o777, 0o700);
  assert.equal((await stat(join(streams, id, 't1.jsonl'))).mode & 0o777, 0o600);
  const local = await readFile(join(streams, id, 't1.jsonl'), 'utf8');
  assert.ok(!local.includes(SECRET) && !local.includes('ghp_secret'));
  assert.match(local, /\[redacted\]/);
  for (const l of local.trim().split('\n')) JSON.parse(l);
  assert.ok(!(await readFile(join(streams, id, 't2.jsonl'), 'utf8')).includes('ghp_secret'));
});

test('a failing turn still reports its exit code and records it in meta.json', async () => {
  const { start, wait, created } = await setup();
  const id = await start({ prompt: 'FAIL' });
  assert.match(await wait([id]), /exit code 3/);
  const meta = JSON.parse(await readFile(join(created[0].dir, 'home/.config/cloudy-cloud/stream/meta.json'), 'utf8'));
  assert.equal(meta.turns[0].exit, 3);
  assert.equal(meta.agent, id);
});

test('the turn command tees the raw stream on the machine and keeps the exit code', async () => {
  const { start, wait, created } = await setup();
  await wait([await start()]);
  const cmd = created[0].cmds.find((c) => c.includes('claude -p'));
  assert.match(cmd, /tee -a \$D\/t1\.jsonl; s=\$\(cat \$D\/t1\.exit 2>\/dev\/null\); exit \$\{s:-1\}$/);
  assert.ok(cmd.includes('D=$HOME/.config/cloudy-cloud/stream'));
  assert.ok(!cmd.includes(SECRET));
});

test('the local copy stops at 20 MB with one truncated note', async () => {
  const { createLocalStream } = await import('../src/stream.mjs');
  const dir = join(await mkdtemp(join(tmpdir(), 'cc-cap-')), 'a');
  const w = createLocalStream(join(dir, 't1.jsonl'), { scrub: (s) => s, cap: 200 });
  for (let i = 0; i < 10; i++) w.write(`${JSON.stringify({ type: 'x', i, pad: 'p'.repeat(40) })}\n`);
  w.end();
  const lines = (await readFile(join(dir, 't1.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1)), { type: 'cloudy-cloud', note: 'truncated' });
  assert.equal(lines.filter((l) => l.includes('truncated')).length, 1);
  assert.ok(lines.length < 10);
});

test('the tee wrapper returns the harness exit code, and 1 when the exit file cannot be written', async () => {
  const { teed } = await import('../src/run-subagent.mjs');
  const home = await mkdtemp(join(tmpdir(), 'cc-tee-'));
  const go = (cmd) => exec('sh', ['-c', cmd], { env: { ...process.env, HOME: home } }).then(() => 0, (e) => e.code);
  assert.equal(await go(teed('sh -c "exit 3"', 1)), 3);
  assert.equal(await go(teed('true', 2)), 0);
  await mkdir(join(home, '.config/cloudy-cloud/stream/t4.exit'), { recursive: true }); // writing the exit file now fails
  assert.equal(await go(teed('true', 4)), 1);
});

test('cloud_agent_result returns the previous result while a follow-up turn runs', async () => {
  const { start, wait, msg, deps, text } = await setup();
  const id = await start({ prompt: 'hi' });
  await wait([id]);
  await msg(id, 'SLOW');
  const r = text(await resultAgent({ agent_id: id }, deps));
  assert.match(r, /hello/);
  assert.match(r, /newer turn is running/);
  await wait([id]);
});

test('argument errors and worker error results carry guidance and keep their ERROR prefix', async () => {
  const { start, wait, deps, text } = await setup();
  const a = await runSubagent({ description: 'd' }, deps);
  assert.equal(a.isError, true);
  assert.match(text(a), /prompt is required[\s\S]*Next step: .*cloud_agent/);
  const b = await messageAgent({ agent_id: 'x' }, deps);
  assert.match(text(b), /message is required[\s\S]*Next step: .*cloud_agent_message/);
  const c = await waitAgents({ agent_ids: 'x'.repeat(0) || [] }, deps);
  assert.match(text(c), /agent_ids must be[\s\S]*Next step: .*cloud_agent_wait/);
  const id = await start({ prompt: 'FAIL' });
  const w = await wait([id]);
  assert.match(w, /ERROR: [\s\S]*Next step:/);
});

// ---- #67: a coordinator gets the Instabox key, the Claude token and provider keys as proxy secrets; its env file holds names only ----
const COORD_PROXIED = 'CLOUDY_CLOUD_INSTABOX_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,PARTICLE_API_KEY';
test('a nested coordinator gets its keys as secret names and its env file has no key value', async () => {
  const x = await setup({ provider: proxyProvider() });
  delete x.deps.createSandbox;
  x.deps.env = { INSTABOX_API_KEY: 'ib-key-1', GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROXY_SECRETS: COORD_PROXIED, CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' };
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  const c = x.deps.provider.log.create[0];
  for (const n of ['CLOUDY_CLOUD_INSTABOX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'PARTICLE_API_KEY']) assert.ok(c.secrets.includes(n), `${n} in ${c.secrets}`);
  const w = x.deps.provider.log.writes.find((f) => f.p.endsWith('.config/cloudy-cloud/env'));
  assert.match(w.d, new RegExp(`^CLOUDY_CLOUD_PROXY_SECRETS=${COORD_PROXIED}$`, 'm'));
  assert.doesNotMatch(w.d, /ib-key-1|^(INSTABOX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|PARTICLE_API_KEY|CLOUDY_CLOUD_INSTABOX_API_KEY)=/m);
});

test('a nested coordinator whose key is not a proxy secret is refused and creates no machine (#68)', async () => {
  const x = await setup({ provider: proxyProvider() });
  delete x.deps.createSandbox;
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN,PARTICLE_API_KEY' }; // INSTABOX_API_KEY has no secret
  await withTool(x);
  const r = await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  assert.match(r, /keeps keys off machines/);
  assert.equal(x.deps.provider.log.create.length, 0);
});

test('a nested coordinator skips an optional profile key held only as a plain value and still starts (#67 #68)', async () => {
  const x = await setup({ provider: proxyProvider() });
  delete x.deps.createSandbox;
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN,CLOUDY_CLOUD_INSTABOX_API_KEY' }; // PARTICLE_API_KEY is a plain value
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  assert.equal(x.deps.provider.log.create.length, 1);
  assert.ok(!JSON.stringify(x.deps.provider.log).includes('part-key-1'));
});

test('the refusal for a real key carries its code', async () => {
  const { refused } = await import('../src/run-subagent.mjs');
  assert.equal(refused('X').code, 'key_on_machine_refused');
});

test('a nested coordinator start reply names the keys that were not sent', async () => {
  const x = await setup({ provider: proxyProvider() });
  delete x.deps.createSandbox;
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN,CLOUDY_CLOUD_INSTABOX_API_KEY' };
  await withTool(x);
  const t = (await runSubagent({ description: 'd', prompt: 'hi', role: 'coordinator' }, x.deps)).content[0].text;
  assert.match(t, /Not sent to the coordinator[^\n]*PARTICLE_API_KEY/);
  assert.ok(!t.includes('part-key-1'));
});

// ---- machine kinds (#94): the `machine` argument, consent, preflight, label, list ----
const kindSetup = (over = {}) => {
  const provider = over.provider ?? createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  return setup({ createSandbox: undefined, provider, ...over }).then((s) => ({ ...s, provider }));
};

test('an unknown machine string is rejected before any sandbox', async () => {
  const { deps, provider } = await kindSetup();
  for (const machine of ['windows', 'gpu:l4:9']) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', machine }, deps);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /linux, android, omarchy, gpu\[:TYPE\[:COUNT\]\] \(COUNT 1-4/);
    assert.equal(r.content[0].text.split('Accepted forms').length + r.content[0].text.split('Use one of').length - 2, 1, 'accepted forms once');
  }
  assert.equal(provider.log.create.length, 0);
  assert.equal(deps.count?.started ?? 0, 0);
});

test('machine android creates an android machine, labels it and shows it in the list', async () => {
  const { start, wait, deps, provider } = await kindSetup();
  const id = await start({ machine: 'android' });
  await wait([id]);
  assert.equal(provider.log.create[0].kind.name, 'android');
  assert.equal(provider.log.create[0].labels.kind, 'android');
  assert.match((await listAgents({}, deps)).content[0].text, /machine android/);
  assert.ok(provider.log.cmds.some((c) => /command -v "\$t"/.test(c.cmd)));
});

test('no machine argument: kind linux, no kind label, no preflight, no machine in the list', async () => {
  const { start, wait, deps, provider } = await kindSetup();
  const id = await start();
  await wait([id]);
  assert.equal(provider.log.create[0].kind.name, 'linux');
  assert.ok(!('kind' in provider.log.create[0].labels));
  assert.ok(!provider.log.cmds.some((c) => /command -v/.test(c.cmd)));
  assert.doesNotMatch((await listAgents({}, deps)).content[0].text, /machine /);
});

test('gpu without consent is refused with the price and the env line; with consent it starts and shows the cost', async () => {
  const { deps, provider, text } = await kindSetup();
  let r = await runSubagent({ description: 'd', prompt: 'hi', machine: 'gpu:l4' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /machine_needs_consent|\$0\.765/);
  assert.match(text(r), /CLOUDY_CLOUD_ALLOW_MACHINE_KINDS/);
  assert.equal(provider.log.create.length, 0);
  deps.env.CLOUDY_CLOUD_ALLOW_MACHINE_KINDS = 'macos';
  r = await runSubagent({ description: 'd', prompt: 'hi', machine: 'gpu' }, deps);
  assert.equal(r.isError, true); // macos consent does not cover gpu
  deps.env.CLOUDY_CLOUD_ALLOW_MACHINE_KINDS = 'gpu';
  r = await runSubagent({ description: 'd', prompt: 'hi', machine: 'gpu:l4' }, deps);
  assert.notEqual(r.isError, true);
  assert.match(text(r), /\$0\.765 per GPU-hour/);
  assert.match(text(r), /cloud_agent_stop/);
  r = await runSubagent({ description: 'd', prompt: 'hi', machine: 'macos' }, deps);
  assert.equal(r.isError, true);
});

test('#105 the wait and result text carry the cost line for gpu, and not for linux', async () => {
  for (const [machine, expect] of [['gpu', true], [undefined, false]]) {
    const { deps, text } = await kindSetup();
    deps.env.CLOUDY_CLOUD_ALLOW_MACHINE_KINDS = 'gpu';
    const id = text(await runSubagent({ description: 'd', prompt: 'hi', machine }, deps)).match(/agent_id: (\w+)/)[1];
    const w = text(await waitAgents({ agent_ids: [id], timeout_seconds: 10 }, deps));
    assert.equal(/per GPU-hour/.test(w) && /cloud_agent_stop/.test(w), expect, w);
    const r = text(await resultAgent({ agent_id: id }, deps));
    assert.equal(/per GPU-hour/.test(r) && /cloud_agent_stop/.test(r), expect, r);
  }
});

test('#105 a failed gpu result still starts with ERROR:, with the cost line after it', async () => {
  const { deps, text } = await kindSetup();
  deps.env.CLOUDY_CLOUD_ALLOW_MACHINE_KINDS = 'gpu';
  const id = text(await runSubagent({ description: 'd', prompt: 'FAIL', machine: 'gpu' }, deps)).match(/agent_id: (\w+)/)[1];
  await waitAgents({ agent_ids: [id], timeout_seconds: 10 }, deps);
  const r = text(await resultAgent({ agent_id: id }, deps));
  assert.match(r, /^ERROR: /, r);
  assert.match(r, /per GPU-hour[\s\S]*$/);
});

// Runs the real preflight command in bash, with PATH holding only `have` as executables and `shellOnly` as functions.
const probeProvider = (have, shellOnly = []) => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  const create = provider.create;
  provider.sbx = [];
  provider.create = async (o) => {
    const sbx = await create(o); provider.sbx.push(sbx);
    const run = sbx.commands.run;
    sbx.commands.run = async (cmd, o2) => {
      if (!/command -v/.test(cmd)) return run(cmd, o2);
      const bin = await mkdtemp(join(tmpdir(), 'cc-probe-'));
      for (const t of have) { await writeFile(join(bin, t), '#!/bin/sh\n'); await chmod(join(bin, t), 0o755); }
      const fns = shellOnly.map((t) => `${t}() { :; }; `).join('');
      const { stdout } = await promisify(execFile)('/bin/bash', ['-c', fns + cmd], { env: { PATH: bin } });
      return { stdout, stderr: '', exitCode: 0 };
    };
    return sbx;
  };
  return provider;
};
for (const [name, have, fns, lacks] of [
  ['gh missing while claude is present', ['git', 'node', 'claude'], [], 'gh'],
  ['gh only an alias-like shell function', ['git', 'node', 'claude'], ['gh'], 'gh'],
]) {
  test(`a machine with ${name} fails with machine_missing_tools naming ${lacks} and the machine is deleted`, async () => {
    const provider = probeProvider(have, fns);
    const { start, wait } = await kindSetup({ provider });
    const r = await wait([await start({ machine: 'omarchy' })]);
    assert.match(r, /status: failed/);
    assert.match(r, /lacks tools the agent needs \(gh\)/);
    assert.equal(provider.sbx[0].killed, true);
  });
}

test('a machine with all four tools passes the preflight', async () => {
  const provider = probeProvider(['git', 'gh', 'node', 'claude']);
  const { start, wait } = await kindSetup({ provider });
  assert.doesNotMatch(await wait([await start({ machine: 'omarchy' })]), /machine_missing_tools|lacks tools/);
});

test('task mode shows the price of an expensive machine at start and in the completion result', async () => {
  const { deps, wait, provider } = await kindSetup({ asTask: true, env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_ALLOW_MACHINE_KINDS: 'gpu' } });
  const t = await runSubagent({ description: 'd', prompt: 'hi', machine: 'gpu:l4' }, deps);
  assert.match(t.statusMessage, /\$0\.765 per GPU-hour.*cloud_agent_stop/);
  await wait([t.taskId.split('-')[1]]);
  assert.match(getTask(t.taskId, deps).result.content[0].text, /\$0\.765 per GPU-hour/);
  const d = await kindSetup({ asTask: true });
  assert.doesNotMatch((await runSubagent({ description: 'd', prompt: 'hi' }, d.deps)).statusMessage, /GPU-hour/);
});

test('apt packages are refused on omarchy and macos before any sandbox', async () => {
  const provider = proxyProvider();
  const { deps, text } = await kindSetup({ provider, env: { ...PROXY_ENV, CLOUDY_CLOUD_APT_PACKAGES: 'ffmpeg', CLOUDY_CLOUD_ALLOW_MACHINE_KINDS: 'macos' } });
  for (const machine of ['omarchy', 'macos']) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', machine }, deps);
    assert.equal(r.isError, true);
    assert.match(text(r), /CLOUDY_CLOUD_APT_PACKAGES/);
  }
  assert.equal(provider.log.create.length, 0);
});

test('a provider that offers only linux rejects machine android, naming the provider', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true, machineKinds: ['linux'] });
  const { deps, text } = await kindSetup({ provider });
  const r = await runSubagent({ description: 'd', prompt: 'hi', machine: 'android' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /provider fake cannot start a android machine/);
  assert.equal(provider.log.create.length, 0);
});

// ---- #118: cpu and memory use on each open agent's line ----
const usageSetup = async (metrics, over = {}) => {
  const s = await setup(over);
  const ids = [await s.start({ description: 'one' }), await s.start({ description: 'two' })];
  await s.wait(ids);
  let n = 0;
  for (const a of s.open.values()) a.sandbox.id ??= `m${n++}`;
  s.deps.provider.metrics = metrics;
  return { ...s, ids };
};
const SAMPLE = { samples: [{ t: Date.now() - 60_000, cpuPct: 3, cpuCount: 2, memUsed: 1e9, memTotal: 4e9 }, { t: Date.now() - 30_000, cpuPct: 12.4, cpuCount: 2, memUsed: 2.04e9, memTotal: 8.59e9 }], fetchedAt: 2 };

test('list adds cpu and memory from the newest sample, and usage n/a on an error', async () => {
  const { deps, text, ids, open } = await usageSetup(async (id) => { if (id === open.get(ids[1]).sandbox.id) throw new Error('boom secret'); return SAMPLE; });
  const out = text(await listAgents({}, deps));
  const lines = out.split('\n').filter((l) => l.startsWith(ids[0]) || l.startsWith(ids[1]));
  assert.match(lines[0], /  cpu 12% mem 1\.9\/8 GiB \(\d+[sm] ago\)  one$/);
  assert.match(lines[1], /  usage n\/a \(unavailable\)  two$/);
  assert.doesNotMatch(out, /boom|secret/);
});

test('list says usage n/a when the samples are empty, and when metrics exceed the time budget', async () => {
  const empty = await usageSetup(async () => ({ samples: [], fetchedAt: 1 }));
  assert.match(text0(await listAgents({}, empty.deps)), /usage n\/a \(none yet\)  two/);
  const slow = await usageSetup(() => new Promise(() => {}), { usageBudgetMs: 50 });
  const t0 = Date.now();
  assert.match(text0(await listAgents({}, slow.deps)), /usage n\/a \(timeout\)  one/);
  assert.ok(Date.now() - t0 < 2000);
});
const text0 = (r) => r.content[0].text;

test('list adds no usage segment without hasMetrics and never calls metrics', async () => {
  let calls = 0;
  const { deps } = await usageSetup(async () => { calls++; return SAMPLE; });
  deps.provider.caps.hasMetrics = false;
  const out = text0(await listAgents({}, deps));
  assert.equal(calls, 0);
  assert.doesNotMatch(out, /usage|cpu|GiB/);
});

test('list does not touch stopped or queued agents and asks for a short window', async () => {
  const seen = [];
  const { deps, ids, open } = await usageSetup(async (id, o) => { seen.push({ id, since: o.since }); return SAMPLE; });
  open.get(ids[1]).status = 'stopped';
  const before = Date.now();
  const out = text0(await listAgents({}, deps));
  assert.deepEqual(seen.map((x) => x.id), [open.get(ids[0]).sandbox.id]);
  assert.ok(seen[0].since >= before - 120_000 - 1000 && seen[0].since <= Date.now() - 119_000);
  assert.match(out, new RegExp(`${ids[1]}  stopped[^\\n]*two\\n`));
});

test('list reads at most 4 machines at a time', async () => {
  let now = 0, max = 0;
  const { deps, open } = await usageSetup(async () => { max = Math.max(max, ++now); await new Promise((r) => setTimeout(r, 20)); now--; return SAMPLE; });
  const proto = [...open.values()][0];
  for (let i = 0; i < 8; i++) open.set(`x${i}`, { ...proto, id: `x${i}`, sandbox: { id: `x${i}` } });
  await listAgents({}, deps);
  assert.equal(max, 4);
});

test('list does not read an agent that was stopped while it waited for a read slot', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, open } = await usageSetup(async (id) => { seen.push(id); await gate; return SAMPLE; });
  const proto = [...open.values()][0];
  for (let i = 0; i < 3; i++) open.set(`x${i}`, { ...proto, id: `x${i}`, sandbox: { id: `x${i}` } });
  open.set('x3', { ...proto, id: 'x3', sandbox: { id: 'x3' } }); // the fifth agent counting the two from setup
  const p = listAgents({}, deps);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 4);
  open.get('x3').status = 'stopped';
  release();
  await p;
  assert.ok(!seen.includes('x3'));
  assert.equal(seen.length, 5); // the four first reads plus the fifth agent; the stopped sixth gets none
});

test('list puts the usage segment on the first line when the description has a newline', async () => {
  const { deps, ids, open } = await usageSetup(async () => SAMPLE);
  open.get(ids[0]).description = 'first\nsecond';
  const out = text0(await listAgents({}, deps));
  assert.match(out, new RegExp(`${ids[0]}  [^\\n]*  cpu 12% mem 1\\.9/8 GiB \\(\\d+[sm] ago\\)  first\\nsecond`));
});

test('the start pace follows the provider plan (minus 10 %), CLOUDY_CLOUD_STARTS_PER_MIN wins, no plan means 25', async () => {
  const pace = async (planResult, env = {}) => {
    const provider = { ...createFakeProvider(), plan: async () => planResult };
    const q = startQueue(env, provider);
    await q.learnPlan();
    return q.pace();
  };
  assert.equal(await pace({ startsPerMinute: 10 }), 9);
  assert.equal(await pace({ startsPerMinute: 1 }), 1);
  assert.equal(await pace({ startsPerMinute: 10 }, { CLOUDY_CLOUD_STARTS_PER_MIN: '3' }), 3);
  assert.equal(await pace({ startsPerMinute: 0 }), 25);
  assert.equal(await pace(null), 25);
  const boom = { ...createFakeProvider(), plan: async () => { throw new Error('x'); } };
  const q = startQueue({}, boom);
  await q.learnPlan();
  assert.equal(q.pace(), 25);
  assert.equal(startQueue({}, createFakeProvider()).pace(), 25); // no plan() at all
});

// ---- #128 size ----
const SPECS = [{ vcpus: 4, memMiB: 8192 }, { vcpus: 2, memMiB: 4096 }, { vcpus: 8, memMiB: 16384 }];
const sizeSetup = (plan, extra = {}) => {
  const calls = [];
  const provider = { ...createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true }), plan: async (o) => { calls.push(o); return typeof plan === 'function' ? plan(o, calls.length) : plan; } };
  return kindSetup({ provider, ...extra }).then((s) => ({ ...s, calls }));
};
const proPlan = { tier: 'pro', specs: SPECS, startsPerMinute: 60, maxRunning: 10, maxMachines: 20 };

test('#128 a size the plan lacks is refused with the guide, after one refresh, and nothing is created', async () => {
  const { deps, provider, text, calls } = await sizeSetup(proPlan);
  const r = await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /size_not_allowed|16x32 is not on your Instabox plan \(pro\)/);
  assert.match(text(r), /2x4 4x8 8x16/);
  assert.match(text(r), /builder/i);
  assert.match(text(r), /npx --yes instabox@latest workspace plan/);
  assert.equal(provider.log.create.length, 0);
  assert.equal(calls.filter((c) => c?.refresh).length, 1, 'refreshed once');
  assert.equal(deps.count?.started ?? 0, 0);
});

test('#128 an allowed size starts with the size, the size label and one cost line; a refresh that finds it also passes', async () => {
  const { deps, provider, text, wait } = await sizeSetup(proPlan);
  const r = await runSubagent({ description: 'd', prompt: 'hi', size: '8x16' }, deps);
  assert.notEqual(r.isError, true);
  assert.match(text(r), /8x16 costs about \$0\.068 an hour while running/);
  assert.equal(text(r).split('an hour while running').length, 2, 'one cost line');
  await wait([text(r).match(/agent_id: (\w+)/)[1]]);
  assert.deepEqual([provider.log.create[0].size.vcpus, provider.log.create[0].size.memMiB], [8, 16384]);
  assert.equal(provider.log.create[0].labels.size, '8x16');
  const s2 = await sizeSetup((o) => (o?.refresh ? proPlan : { ...proPlan, specs: SPECS.slice(0, 2) }));
  const r2 = await runSubagent({ description: 'd', prompt: 'hi', size: '8x16' }, s2.deps);
  assert.notEqual(r2.isError, true);
});

test('#128 no size: no size option, no size label, no cost line', async () => {
  const { deps, provider, text, wait } = await sizeSetup(proPlan);
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  await wait([text(r).match(/agent_id: (\w+)/)[1]]);
  assert.ok(!('size' in provider.log.create[0]) && !('size' in provider.log.create[0].labels));
  assert.doesNotMatch(text(r), /an hour while running/);
});

test('#128 an unknown plan passes the size through, and a provider spec_not_allowed shows the guide', async () => {
  const { deps, provider, text, wait } = await sizeSetup(null);
  const id = text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, deps)).match(/agent_id: (\w+)/)[1];
  await wait([id]);
  assert.equal(provider.log.create[0].size.vcpus, 16);
  const s = await sizeSetup(null);
  s.provider.create = async () => { throw Object.assign(new Error('not allowed'), { code: 'size_not_allowed' }); };
  const id2 = text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, s.deps)).match(/agent_id: (\w+)/)[1];
  await waitAgents({ agent_ids: [id2], timeout_seconds: 10 }, s.deps);
  const res = text(await resultAgent({ agent_id: id2 }, s.deps));
  assert.match(res, /16x32 is not on your Instabox plan/);
  assert.match(res, /Likely the plan does not include it/);
});

test('#128 bad forms, gpu and macos, and providers without sizes are refused with invalid_args', async () => {
  const { deps, provider, text } = await sizeSetup(proPlan);
  deps.env.CLOUDY_CLOUD_ALLOW_MACHINE_KINDS = 'gpu,macos';
  for (const [a, re] of [[{ size: '8/16' }, /VCPUSxGIB/], [{ size: '4x8', machine: 'gpu' }, /gpu and macos machines have their own sizes/], [{ size: '4x8', machine: 'macos' }, /own sizes/]]) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', ...a }, deps);
    assert.equal(r.isError, true);
    assert.match(text(r), re);
    if (a.size !== '8/16') assert.match(text(r), /call cloud_agent again/i);
  }
  assert.equal(provider.log.create.length, 0);
  const sh = createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true });
  sh.caps.hasSizes = false;
  const s = await kindSetup({ provider: sh });
  const r = await runSubagent({ description: 'd', prompt: 'hi', size: '4x8' }, s.deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /provider has one machine size/);
  assert.equal(sh.log.create.length, 0);
});

test('#128 task mode shows the size cost at start and in the completion result, and nothing without a size', async () => {
  const { deps, wait } = await sizeSetup(proPlan, { asTask: true });
  const t = await runSubagent({ description: 'd', prompt: 'hi', size: '8x16' }, deps);
  assert.match(t.statusMessage, /8x16 costs about \$0\.068 an hour/);
  await wait([t.taskId.split('-')[1]]);
  assert.match(getTask(t.taskId, deps).result.content[0].text, /8x16 costs about \$0\.068 an hour/);
  const d = await sizeSetup(proPlan, { asTask: true });
  assert.doesNotMatch((await runSubagent({ description: 'd', prompt: 'hi' }, d.deps)).statusMessage, /an hour/);
});

test('#128 a size only a higher plan lists: 16x32 on pro names builder and its fee', async () => {
  const { deps, text } = await sizeSetup(proPlan);
  const r = text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, deps));
  assert.match(r, /builder plan \(\$100\/month/);
  assert.doesNotMatch(r, /needs the pro plan/);
});

test('#128 a provider-side size_not_allowed reads the plan for the tier and sizes; an unreadable plan gives the generic text', async () => {
  for (const [plan, want] of [[(o, n) => (n === 1 ? { ...proPlan, specs: [...SPECS, { vcpus: 16, memMiB: 32768 }] } : proPlan), /\(pro\)[\s\S]*one of: 2x4 4x8 8x16/], [null, /Likely the plan does not include it/]]) {
    const s = await sizeSetup(plan);
    s.provider.create = async () => { throw Object.assign(new Error('not allowed'), { code: 'size_not_allowed' }); };
    const id = s.text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, s.deps)).match(/agent_id: (\w+)/)[1];
    await waitAgents({ agent_ids: [id], timeout_seconds: 10 }, s.deps);
    const res = s.text(await resultAgent({ agent_id: id }, s.deps));
    assert.match(res, want);
    assert.match(res, /builder plan \(\$100\/month/);
  }
});

test('the soft wait counts this server\'s other live agents against the plan and shows a status; limit errors name the tier', async () => {
  const provider = { ...createFakeProvider(), plan: async () => ({ tier: 'pro', specs: [], startsPerMinute: 30, maxRunning: 2, maxMachines: 500 }) };
  const a = { status: 'starting' }; // the requester is in open as starting and must not count itself
  const open = new Map([['a', a], ['b', { status: 'running' }], ['c', { status: 'idle' }], ['d', { status: 'queued' }]]);
  let t = 0;
  const q = startQueue({}, provider, () => open.values(), { now: () => t, sleep: async (ms) => { t += ms; if (t >= 15_000) open.get('b').status = 'stopped'; } });
  await q.learnPlan();
  const notes = [];
  assert.equal(await q.create(new Proxy(a, { set: (o, k, v) => { if (k === 'queueNote') notes.push(v); o[k] = v; return true; } }), async () => 'up'), 'up');
  assert.equal(notes[0], 'waiting for a free machine slot (2 running on the pro plan)');
  // alone with maxRunning 1 and no other machines: no wait, no "0 running"
  const solo = { status: 'starting' };
  const q1 = startQueue({}, { ...provider, plan: async () => ({ tier: 'free', specs: [], startsPerMinute: 30, maxRunning: 1, maxMachines: 5 }) }, () => [solo].values(), { now: () => t, sleep: async () => { throw new Error('slept'); } });
  await q1.learnPlan();
  assert.equal(await q1.create(solo, async () => 'up'), 'up');
});

test('buildServer wires the live-agent count into its queue', async () => {
  const provider = { ...createFakeProvider(), plan: async () => ({ tier: 'pro', specs: [], startsPerMinute: 30, maxRunning: 1, maxMachines: 5 }) };
  const open = new Map([['b', { status: 'running' }]]);
  const deps = { env: {}, provider, open };
  buildServer(deps);
  await deps.queue.learnPlan();
  let t = 0;
  const a = {};
  const q = sharedQueue({ env: {}, provider, open }); // the factory buildServer uses
  await q.learnPlan();
  assert.ok(deps.queue.waiting && typeof q.ahead === 'function');
  // the queue from buildServer counts the open agent: it must hold a create until b stops
  const p = deps.queue.create(a, async () => 'up');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(a.queueNote ?? '', /1 running on the pro plan/);
  open.get('b').status = 'stopped';
  deps.queue.cancel(a);
  await assert.rejects(p, /cancelled/);
});

test('a stopped issue agent still names its issue branch when cloud_agent_result is a separate MCP request', async () => {
  const { deps } = await setup({ fetchIssue: async () => ({ title: 't', body: 'b' }) });
  const server = buildServer(deps);
  // The same path every MCP tool request takes: the registered handler gets a fresh copy of the shared deps.
  // Calling the exported handlers with `deps` itself would create the shared maps up front and mask the bug.
  const call = (name, args) => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, { mcpReq: { requestState: () => undefined } });
  const text = (r) => r.content[0].text;
  const started = await call('cloud_agent', { prompt: 'hi', description: 'd', issue: '12' });
  const id = text(started).match(/agent_id: ([0-9a-f]{8})/)[1];
  assert.equal(started.structuredContent.branch, `cloudy-cloud/issue-12-${id}`);
  assert.match(text(started), new RegExp(`It will push to cloudy-cloud/issue-12-${id}`));
  assert.match(text(await call('cloud_agent_wait', { agent_ids: [id], timeout_seconds: 60 })), /status: idle/);
  assert.match(text(await call('cloud_agent_stop', { agent_ids: [id] })), /stopped/);
  assert.match(text(await call('cloud_agent_result', { agent_id: id })), new RegExp(`git fetch origin cloudy-cloud/issue-12-${id}`));
});

// ---- plan UX (#135 #136 #126) ----
test('#135 3x5 on pro says the size is not offered and does not suggest an upgrade', async () => {
  const { deps, text } = await sizeSetup(proPlan);
  const r = text(await runSubagent({ description: 'd', prompt: 'hi', size: '3x5' }, deps));
  assert.match(r, /3x5 is not an Instabox size/);
  assert.match(r, /2x4 4x8 8x16/);
  assert.doesNotMatch(r, /workspace plan|needs the pro plan/);
  const b = text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, deps));
  assert.match(b, /Likely cause: The pro plan doesn't include 16x32/);
  assert.match(b, /workspace plan <workspace> builder/);
});

test('#126 a malformed size gets one clear line without the generic filler', async () => {
  const { deps, text } = await sizeSetup(proPlan);
  const r = text(await runSubagent({ description: 'd', prompt: 'hi', size: 'big' }, deps));
  assert.match(r, /VCPUSxGIB/);
  assert.doesNotMatch(r, /What happened|not accepted/);
});

test('#126 an unreadable plan lets the size start and says it was not checked; the reply compares with the default', async () => {
  const { deps, text } = await sizeSetup(null);
  const r = text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, deps));
  assert.match(r, /plan could not be read[^]*not checked[^]*may refuse/i);
  assert.match(r, /default 4x8 costs about \$0\.034/);
});

test('#126 every queued agent shows why it waits, in list and wait', async () => {
  const queue = createStartQueue({ perMin: 100, sleep: () => new Promise(() => {}), maxRunning: () => 1, tierName: () => 'pro', liveCount: () => 1 });
  const { start, deps, text, wait } = await setup({ queue });
  const [, b, c] = [await start(), await start(), await start()];
  let l; // under heavy load the third start can take longer than a fixed tick to reach the queue
  for (let i = 0; i < 100 && !new RegExp(`${c}  queued`).test(l = text(await listAgents({}, deps))); i++) await tick(50);
  assert.match(l, new RegExp(`${c}  queued[^]*2 ahead[^]*waiting for a free machine slot \\(1 running on the pro plan\\)`));
  assert.match(await wait([b], 0.1), /waiting for a free machine slot/);
});

test('#135 a provider-side size_not_allowed for a size the current plan lists says Instabox refused it and does not suggest an upgrade', async () => {
  const s = await sizeSetup(() => ({ ...proPlan, tier: 'builder', specs: [...SPECS, { vcpus: 16, memMiB: 32768 }] }));
  s.provider.create = async () => { throw Object.assign(new Error('not allowed'), { code: 'size_not_allowed' }); };
  const id = s.text(await runSubagent({ description: 'd', prompt: 'hi', size: '16x32' }, s.deps)).match(/agent_id: (\w+)/)[1];
  await waitAgents({ agent_ids: [id], timeout_seconds: 10 }, s.deps);
  const res = s.text(await resultAgent({ agent_id: id }, s.deps));
  assert.match(res, /refused/);
  assert.doesNotMatch(res, /upgrade|larger plan than any/i);
});

test('#139 cloud_agent_list ends with the usage line; no plan, a failing plan or no usage add nothing; a stale plan is refreshed', async () => {
  const mk = (plan) => createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true, plan });
  const fresh = (usage) => () => ({ tier: 'pro', fetchedAt: Date.now(), usage });
  const list = async (provider) => {
    const { start, wait, deps, text } = await setup({ provider });
    await wait([await start()]);
    await listAgents({}, deps); // starts the background plan read
    await planSettled(provider);
    return text(await listAgents({}, deps));
  };
  const base = await list(mk(null));
  assert.doesNotMatch(base, /Instabox this month/);
  const over = await list(mk(fresh({ costUSD: 66.12, allowanceUSD: 16.61, overageUSD: 49.51 })));
  assert.equal(over.split('\n').at(-1), 'Instabox this month: $66.12 used, $16.61 included, $49.51 beyond it (pay as you go)');
  assert.equal((await list(mk(fresh({ costUSD: 12.4, allowanceUSD: 20, overageUSD: 0 })))).split('\n').at(-1), 'Instabox this month: $12.40 of $20.00 included used');
  for (const p of [fresh(undefined), () => { throw new Error('boom'); }, () => ({ tier: 'free', fetchedAt: Date.now(), usage: { costUSD: 'NaN' } })]) {
    const t = await list(mk(p));
    assert.doesNotMatch(t, /Instabox this month|NaN|undefined/);
    assert.equal(t.split('\n').length, base.split('\n').length);
  }
  const stale = mk((o) => ({ tier: 'pro', fetchedAt: o?.refresh ? Date.now() : Date.now() - 31 * 60_000, usage: { costUSD: o?.refresh ? 2 : 1, allowanceUSD: 20 } }));
  assert.match(await list(stale), /\$2\.00 of \$20\.00 included used$/);
  assert.equal(stale.log.planRefresh, 1);
});

test('#139 review: a plan() that never resolves does not delay cloud_agent_list, and the line is absent', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true, plan: () => new Promise(() => {}) });
  const { start, wait, deps, text } = await setup({ provider });
  await wait([await start()]);
  const t0 = Date.now();
  const out = text(await listAgents({}, deps));
  assert.ok(Date.now() - t0 < 1000);
  assert.doesNotMatch(out, /Instabox this month/);
});

test('#139 review: a failing plan() is tried once per 5 minutes, not on every list', async () => {
  let calls = 0;
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true, plan: () => { calls++; throw new Error('429'); } });
  const { deps } = await setup({ provider });
  const base = calls; // the start pace may read the plan too
  const t = Date.now();
  for (let i = 0; i < 3; i++) { planSnapshot(provider, t + i * 1000); await planSettled(provider); }
  assert.equal(calls - base, 1);
  planSnapshot(provider, t + 6 * 60_000); await planSettled(provider);
  assert.equal(calls - base, 2);
});

test('#139 review: the all and no-agents listings end with the usage line too', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true, plan: () => ({ tier: 'pro', fetchedAt: Date.now(), usage: { costUSD: 3, allowanceUSD: 20 } }) });
  const { deps, text } = await setup({ provider });
  await listAgents({}, deps); await planSettled(provider);
  assert.equal(text(await listAgents({}, deps)), 'No agents.\nInstabox this month: $3.00 of $20.00 included used');
  assert.match(text(await listAgents({ all: true }, deps)), /No cloudy-cloud machines\.\nInstabox this month: \$3\.00 of/);
});

// ---- #49 resumable after a failed first turn, #50 turn limit ----
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: SID, model: 'x' });
// A sandbox whose claude run streams an init event, then hits the command timeout (an error with no exit code).
const timeoutSandbox = (over = {}) => async () => {
  const sbx = await fakeSandbox(getGithub());
  const real = sbx.commands.run;
  sbx.commands.run = async (cmd, o) => {
    if (/(claude|bin\/cloudy-cloud) -p /.test(cmd) && /TIMEOUT/.test(sbx.mode ?? 'TIMEOUT')) {
      sbx.cmds.push(cmd); sbx.agentRuns = [...(sbx.agentRuns ?? []), { cmd, o }];
      if (!over.noInit) await o.onStdout?.(`${INIT}\n`);
      throw new Error('job still running after 1740000 ms');
    }
    if (/(claude|bin\/cloudy-cloud) -p /.test(cmd)) sbx.agentRuns = [...(sbx.agentRuns ?? []), { cmd, o }];
    return real(cmd, o);
  };
  return sbx;
};

test('#49 a first turn that times out after the init event leaves the agent idle and resumable', async () => {
  let sbx;
  const { start, wait, msg, open } = await setup({ createSandbox: async () => (sbx = await timeoutSandbox()()) });
  const id = await start();
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /still open/);
  assert.match(r, /Next step:[^]*cloud_agent_message/);
  assert.equal(sbx.killed, false);
  assert.ok(open.has(id));
  sbx.mode = 'OK'; // the next turn works
  assert.equal((await msg(id, 'continue')).isError, undefined);
  assert.match(await wait([id]), /status: idle/);
  assert.match(sbx.agentRuns.at(-1).cmd, new RegExp(`--resume ${SID}`));
});

test('#49 a first-turn timeout before any stream event keeps unknown execution open', async () => {
  let sbx;
  const { start, wait, open } = await setup({ createSandbox: async () => (sbx = await timeoutSandbox({ noInit: true })()) });
  const id = await start();
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /agent is still open/);
  assert.equal(open.get(id)?.sessionId, undefined);
  assert.equal(open.get(id)?.status, 'idle');
  assert.equal(sbx.killed, false);
});

test('#49 a pi turn that ends with a provider error after the session event stays open and resumable', async () => {
  const { start, wait, msg, sandboxes } = await profileSetup();
  const id = await start({ profile: 'pi-particle', prompt: 'PIERR now' });
  const r = await wait([id]);
  assert.match(r, /status: idle/);
  assert.match(r, /401 invalid api key/);
  assert.match(r, /Next step:/);
  assert.equal(sandboxes[0].killed, false);
  await msg(id, 'again');
  await wait([id]);
  assert.match(await readFile(join(sandboxes[0].dir, 'home', 'pi.log'), 'utf8'), /--session 11111111-2222-3333-4444-555555555555 /);
});

test('#49 a coordinator whose turn times out stays open and runs no worker clean-up', async () => {
  let sbx;
  const { start, wait, open } = await setup({ createSandbox: async () => (sbx = await timeoutSandbox()()), env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_MAX_DEPTH: '3' } });
  const id = await start({ role: 'coordinator' });
  assert.match(await wait([id]), /status: idle/);
  assert.equal(sbx.killed, false);
  assert.equal(open.get(id).status, 'idle');
});

test('#49 the failed and still-open errors each carry a next step', async () => {
  const { guide } = await import('../src/errors.mjs');
  for (const k of ['agent_failed', 'turn_failed_open']) assert.match(guide(k, { id: 'abc12345', minutes: 29 }), /Next step:/);
  assert.match(guide('agent_failed', { id: 'abc12345' }), /cannot be resumed/);
});

test('#50 CLOUDY_CLOUD_TURN_MINUTES sets the command timeout, the Bash timeouts and a UTC deadline in the hint', async () => {
  for (const [env, minutes] of [[{}, 29], [{ CLOUDY_CLOUD_TURN_MINUTES: '45' }, 45]]) {
    let sbx;
    const before = Date.now();
    const { start, wait } = await setup({ createSandbox: async () => (sbx = await timeoutSandbox()()), env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', ...env } });
    await wait([await start()]);
    const { cmd, o } = sbx.agentRuns[0];
    assert.ok(o.timeoutMs <= minutes * 60_000 && o.timeoutMs > (minutes - 1) * 60_000, `timeoutMs ${o.timeoutMs} is the ${minutes}-minute deadline minus elapsed time`);
    const bash = Number(cmd.match(/BASH_DEFAULT_TIMEOUT_MS=(\d+)/)?.[1]);
    assert.ok(bash <= (minutes - 1) * 60_000 && bash > (minutes - 2) * 60_000, `BASH timeout ${bash} is a minute under the turn deadline`);
    assert.match(cmd, /BASH_DEFAULT_TIMEOUT_MS=(\d+) BASH_MAX_TIMEOUT_MS=\1/);
    const deadline = cmd.match(/This turn ends at (\d{4}-\d\d-\d\dT[\d:.]+Z); commit, push and finish before then\./)?.[1];
    assert.ok(deadline, 'hint has the deadline');
    assert.ok(Math.abs(Date.parse(deadline) - (before + minutes * 60_000)) < 60_000);
    assert.match(cmd, new RegExp(`CLOUDY_CLOUD_TURN_DEADLINE=${deadline} `));
  }
});

test('#50 an out-of-range or non-numeric turn limit is rejected with the range and the fix', async () => {
  for (const bad of ['4', '9999', 'abc', '30.5']) {
    const { deps } = await setup({ env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_TURN_MINUTES: bad } });
    const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
    assert.equal(r.isError, true, bad);
    assert.match(r.content[0].text, /CLOUDY_CLOUD_TURN_MINUTES[^]*5[^]*Next step:/);
  }
});

test('#50 the cloud_agent tool descriptions state the turn limit and the resume path', async () => {
  const { buildServer: _b } = await import('../src/mcp.mjs');
  const src = await readFile(new URL('../src/mcp.mjs', import.meta.url), 'utf8');
  for (const name of ['cloud_agent', 'cloud_agent_message']) {
    const d = src.match(new RegExp(`name: '${name}',\\s*description: '([^]*?)',\\n`))[1];
    assert.match(d, /29 minutes/);
    assert.match(d, /CLOUDY_CLOUD_TURN_MINUTES/);
  }
});

// ---- provider resilience (#51, #55) ----
const ERR_FIXTURE = (msg) => readFile(new URL('./fixtures/pi-json-error.jsonl', import.meta.url), 'utf8').then((s) => s.replaceAll('401 invalid api key', msg.replaceAll('"', '\\"')));
// A pi worker whose first `fails` pi runs print a provider error with `msg`; sleeps are recorded, not waited.
async function retrySetup(fails, msg, extra = {}) {
  const errOut = await ERR_FIXTURE(msg), sleeps = [], events = [];
  let piRuns = 0;
  const s = await setup({
    env: { ...pEnv, ...extra.env }, sleep: async (ms) => { sleeps.push(ms); }, events: (e) => events.push(e),
    createSandbox: async (envs) => {
      const sbx = await fakeSandbox(getGithub());
      sbx.envs = envs;
      const real = sbx.commands.run;
      sbx.commands.run = async (cmd, o) => (cmd.includes('pi --mode json') && ++piRuns <= fails ? { stdout: errOut, stderr: '', exitCode: 0 } : real(cmd, o));
      return sbx;
    },
    ...extra.deps,
  });
  return { ...s, sleeps, events, piRuns: () => piRuns };
}
const NOT_FOUND = '404: {"code":"model_not_found","message":"no capacity"}';

test('a pi turn that fails twice with model_not_found is rerun and succeeds, waiting 30s then 60s', async () => {
  answeredProfiles.add('pi-glm');
  const { start, wait, sleeps, events, piRuns } = await retrySetup(2, NOT_FOUND);
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.match(r, /status: idle[\s\S]*hello from pi/);
  assert.ok(!/ERROR/.test(r));
  assert.equal(piRuns(), 3);
  assert.deepEqual(sleeps, [30_000, 60_000]);
  assert.ok(events.some((e) => e.type === 'progress' && /retrying .*attempt 2 of 4/.test(e.text)));
  assert.ok(events.some((e) => e.type === 'progress' && /attempt 3 of 4/.test(e.text)));
});

test('a nonzero turn with empty stderr is classified on its error, not on the worker transcript in stdout', async () => {
  // First pi run exits 1: stdout is a transcript quoting model_not_found (the user's task), the message says 503. The
  // profile has not answered yet, so a model_not_found classification would give up; the 503 must be retried.
  answeredProfiles.delete('pi-glm');
  let piRuns = 0;
  const { start, wait } = await setup({
    env: pEnv, sleep: async () => {},
    createSandbox: async (envs) => {
      const sbx = await fakeSandbox(getGithub());
      sbx.envs = envs;
      const real = sbx.commands.run;
      sbx.commands.run = async (cmd, o) => {
        if (cmd.includes('pi --mode json') && ++piRuns === 1) throw Object.assign(new Error('503 overloaded'), { exitCode: 1, stdout: '{"type":"user","text":"investigate model_not_found handling"}\n' + 'progress line\n'.repeat(30), stderr: '' });
        return real(cmd, o);
      };
      return sbx;
    },
  });
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.equal(piRuns, 2, 'the 503 is retried');
  assert.match(r, /status: idle/);
});

function emptyStderrTurn(tail) {
  return async () => {
    let piRuns = 0;
    const { start, wait } = await setup({
      env: pEnv, sleep: async () => {},
      createSandbox: async (envs) => {
        const sbx = await fakeSandbox(getGithub());
        sbx.envs = envs;
        const real = sbx.commands.run;
        sbx.commands.run = async (cmd, o) => {
          if (cmd.includes('pi --mode json') && ++piRuns === 1) throw Object.assign(new Error('exit 1'), { exitCode: 1, stdout: 'progress line\n'.repeat(30) + tail + '\n', stderr: '' });
          return real(cmd, o);
        };
        return sbx;
      },
    });
    const r = await wait([await start({ profile: 'pi-glm' })]);
    return { piRuns, r };
  };
}

test('an Instabox-style turn (empty stderr, merged log on stdout) that ends with a 503 is retried', async () => {
  answeredProfiles.delete('pi-glm');
  const { piRuns, r } = await emptyStderrTurn('503 service unavailable')();
  assert.equal(piRuns, 2);
  assert.match(r, /status: idle/);
});

test('an empty-stderr turn whose stdout ends with a real model_not_found line is not retried', async () => {
  answeredProfiles.delete('pi-glm');
  const { piRuns, r } = await emptyStderrTurn(NOT_FOUND)();
  assert.equal(piRuns, 1);
  assert.match(r, /ERROR/);
});

test('a lost command transport with a retryable provider status is not replayed automatically', async () => {
  answeredProfiles.add('pi-glm');
  let piRuns = 0, sandbox;
  const sleeps = [];
  const { start, wait } = await setup({
    env: pEnv,
    sleep: async (ms) => { sleeps.push(ms); },
    createSandbox: async (envs) => {
      const sbx = sandbox = await fakeSandbox(getGithub());
      sbx.envs = envs;
      const run = sbx.commands.run;
      sbx.commands.run = async (cmd, opts) => {
        if (cmd.includes('pi --mode json')) { piRuns++; throw Object.assign(new Error('connection lost after 503 overloaded'), { code: 'transient' }); }
        return run(cmd, opts);
      };
      return sbx;
    },
  });
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.match(r, /status: idle/);
  assert.match(r, /connection lost after 503 overloaded/);
  assert.equal(piRuns, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(sandbox.killed, false);
});

test('an unknown first-turn execution without a session keeps the machine for an explicit retry', async () => {
  let turnCalls = 0, sandbox;
  const { start, wait, msg, open } = await setup({
    createSandbox: async (envs) => {
      sandbox = await fakeSandbox(getGithub());
      sandbox.envs = envs;
      const run = sandbox.commands.run;
      sandbox.commands.run = (cmd, opts) => {
        if (cmd.includes('claude -p')) {
          turnCalls++;
          if (turnCalls === 1) return Promise.reject(Object.assign(new Error('connection lost after command start'), { code: 'transient' }));
        }
        return run(cmd, opts);
      };
      return sandbox;
    },
  });
  const id = await start();
  assert.match(await wait([id]), /status: idle/);
  assert.equal(open.get(id)?.sessionId, undefined);
  assert.equal(sandbox.killed, false);
  assert.equal(turnCalls, 1, 'the uncertain command was not replayed');
  await msg(id, 'continue explicitly');
  assert.match(await wait([id]), /hello/);
  assert.equal(turnCalls, 2);
  assert.equal(sandbox.killed, false);
});

test('a 401 from the provider fails at once, without waiting', async () => {
  const { start, wait, sleeps, piRuns } = await retrySetup(9, '401 invalid api key');
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.match(r, /ERROR/);
  assert.equal(piRuns(), 1);
  assert.deepEqual(sleeps, []);
});

test('model_not_found for a profile that never answered fails at once with a model-not-available message', async () => {
  answeredProfiles.clear();
  const { start, wait, sleeps, piRuns } = await retrySetup(9, NOT_FOUND);
  const r = await wait([await start({ profile: 'pi-deepseek' })]);
  assert.match(r, /ERROR[\s\S]*not available to this key[\s\S]*Next step:/);
  assert.equal(piRuns(), 1);
  assert.deepEqual(sleeps, []);
});

test('when the retries run out the result names the provider status and a next step, and holds no key', async () => {
  answeredProfiles.add('pi-glm');
  const { start, wait, sleeps, piRuns } = await retrySetup(99, `502 bad gateway ${PKEY}`);
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.equal(piRuns(), 4);
  assert.deepEqual(sleeps, [30_000, 60_000, 120_000]);
  assert.match(r, /Provider status: 502 server_error[\s\S]*Gave up after 4 attempts[\s\S]*Next step:/);
  assert.ok(!r.includes(PKEY));
});

test('a push failure after a successful pi turn is not rerun as a provider retry', async () => {
  let piRuns = 0, pushes = 0;
  const { start, wait } = await setup({
    env: pEnv, sleep: async () => {},
    createSandbox: async (envs) => {
      const sbx = await fakeSandbox(getGithub());
      sbx.envs = envs;
      const real = sbx.commands.run;
      sbx.commands.run = async (cmd, o) => {
        if (cmd.includes('pi --mode json')) piRuns++;
        if (cmd.includes('PUSHOK')) { pushes++; return { stdout: 'PUSHFAIL\nERR remote: 502 bad gateway\nSHA abc1234\nSTATUS_OK\n', stderr: '', exitCode: 0 }; }
        return real(cmd, o);
      };
      return sbx;
    },
  });
  const r = await wait([await start({ profile: 'pi-glm' })]);
  assert.match(r, /Push failed/);
  assert.equal(piRuns, 1); // the finished run is never replayed: only harness/provider failures may be retried
  assert.equal(pushes, 2); // the safety push still used its own retry
});

test('provider retries share one deadline: a later attempt gets only the time left, and a retry needs five minutes', async () => {
  answeredProfiles.add('pi-glm');
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    const errOut = await ERR_FIXTURE('503 overloaded');
    const timeouts = [];
    let piRuns = 0;
    const { start, wait } = await setup({
      env: { ...pEnv, CLOUDY_CLOUD_TURN_MINUTES: '6' },
      sleep: async (ms) => { now += ms; }, // the fake clock spends the backoff for real
      createSandbox: async (envs) => {
        const sbx = await fakeSandbox(getGithub());
        sbx.envs = envs;
        const real = sbx.commands.run;
        sbx.commands.run = async (cmd, o) => {
          if (!cmd.includes('pi --mode json')) return real(cmd, o);
          timeouts.push(o.timeoutMs);
          piRuns++;
          return { stdout: errOut, stderr: '', exitCode: 0 };
        };
        return sbx;
      },
    });
    const r = await wait([await start({ profile: 'pi-glm' })]);
    assert.deepEqual(timeouts, [360_000, 330_000]); // attempt 2 gets the 30 s the wait already spent, not a fresh clock
    assert.equal(piRuns, 2); // 60 s more was slept, then under five minutes remained: no third attempt
    assert.match(r, /Gave up after 2 attempts/);
  } finally { Date.now = real; }
});

test('a cancel during the provider retry wait ends the turn instead of running another attempt', async () => {
  answeredProfiles.add('pi-glm');
  const errOut = await ERR_FIXTURE('503 overloaded');
  let piRuns = 0;
  const { start, wait, msg, deps } = await setup({
    env: pEnv,
    sleep: () => new Promise(() => {}), // only cancellation may end the wait
    cancelWaitMs: 50,
    createSandbox: async (envs) => {
      const sbx = await fakeSandbox(getGithub());
      sbx.envs = envs;
      const real = sbx.commands.run;
      sbx.commands.run = async (cmd, o) => (cmd.includes('pi --mode json') && ++piRuns >= 2 ? { stdout: errOut, stderr: '', exitCode: 0 } : real(cmd, o));
      return sbx;
    },
  });
  const id = await start({ profile: 'pi-glm' });
  assert.match(await wait([id]), /status: idle/); // turn 1 (pi run 1) is fine
  await msg(id, 'again');
  for (let i = 0; piRuns < 2 && i < 100; i++) await tick(10); // turn 2's first run fails, then the backoff begins
  const cancelled = await cancelTask(`cc-${id}-t2`, deps);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.statusMessage, /Turn cancelled/);
  const r = await wait([id], 5);
  assert.match(r, /status: idle/);
  assert.match(r, /result already delivered/); // tasks/cancel returned the cancelled turn's result
  assert.equal(piRuns, 2); // no retry ran after the cancelled wait
});

test('a successful omp turn marks the profile answered, even though omp never reports progress.answered', async () => {
  answeredProfiles.delete('omp-glm');
  const { start, wait } = await profileSetup();
  await wait([await start({ profile: 'omp-glm' })]);
  assert.ok(answeredProfiles.has('omp-glm'));
});

// ---- preflight, fallback ----
const fetchWith = (status, body = '{"error":{"code":"model_not_found"}}', log = []) => async (url, o) => { log.push({ url, o }); return { status, text: async () => body }; };

test('a preflight 404 fails before any machine is created, with the provider text, no key, and a next step', async () => {
  resetPreflightCache();
  const log = [];
  let created = 0;
  const { text, deps } = await setup({ env: pEnv, fetchFn: fetchWith(404, `{"error":"model_not_found ${PKEY}"}`, log), createSandbox: async () => { created++; return fakeSandbox(); } });
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'pi-glm' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /answered 404[\s\S]*Next step:/);
  assert.ok(!text(r).includes(PKEY));
  assert.equal(created, 0);
  assert.equal(log.length, 1);
  assert.match(log[0].url, /^https:\/\/api\.particle\.ai\/v1\/chat\/completions$/);
  const r2 = await runSubagent({ description: 'd', prompt: 'hi', profile: 'pi-glm', preflight: false }, deps);
  assert.ok(!r2.isError);
  assert.equal(log.length, 1);
});

test('a profile whose preflight fails falls back to the next profile and says so on the first line', async () => {
  resetPreflightCache();
  const fetchFn = async (url, o) => (JSON.parse(o.body).model === 'z-ai/glm-5.3-flash' ? { status: 404, text: async () => 'model_not_found' } : { status: 200, text: async () => '{}' });
  const { start, wait } = await setup({ env: pEnv, fetchFn });
  const r = await wait([await start({ profile: 'pi-glm', fallback: ['pi-particle'] })]);
  assert.match(r, /status: idle\s*\nran on pi-particle \(pi-glm unavailable: Profile pi-glm: api\.particle\.ai answered 404/);
  assert.match(r, /hello from pi/);
});

test('a profile-level fallback survives a preflight failure', async () => {
  resetPreflightCache();
  const dir = await mkdtemp(join(tmpdir(), 'cc-prof-preflight-fallback-'));
  const file = join(dir, 'profiles.json');
  await writeFile(file, JSON.stringify({ 'pi-glm': { harness: 'pi', format: 'openai', baseUrl: 'https://api.particle.ai/v1', model: 'z-ai/glm-5.3-flash', keyName: 'PARTICLE_API_KEY', fallback: ['pi-particle'] } }));
  const fetchFn = async (_url, o) => JSON.parse(o.body).model === 'z-ai/glm-5.3-flash'
    ? { status: 404, text: async () => 'model_not_found' }
    : { status: 200, text: async () => '{}' };
  const { deps, wait, text } = await setup({ env: { ...pEnv, CLOUDY_CLOUD_PROFILES: file }, fetchFn });
  try {
    const started = await runSubagent({ description: 'd', prompt: 'hi', profile: 'pi-glm' }, deps);
    assert.notEqual(started.isError, true, text(started));
    const id = text(started).match(/agent_id: ([0-9a-f]{8})/)?.[1];
    assert.ok(id, text(started));
    const r = await wait([id]);
    assert.match(r, /status: idle\s*\nran on pi-particle \(pi-glm unavailable: Profile pi-glm: api\.particle\.ai answered 404/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a profile with no key falls back to the profiles.json fallback list', async () => {
  resetPreflightCache();
  const dir = await mkdtemp(join(tmpdir(), 'cc-prof-'));
  const file = join(dir, 'profiles.json');
  await writeFile(file, JSON.stringify({ 'pi-nokey': { harness: 'pi', format: 'openai', baseUrl: 'https://example.com/v1', model: 'm1', keyName: 'NOKEY_API_KEY', fallback: ['pi-glm'] } }));
  const { start, wait } = await setup({ env: { ...pEnv, CLOUDY_CLOUD_PROFILES: file }, fetchFn: fetchWith(200) });
  const r = await wait([await start({ profile: 'pi-nokey' })]);
  assert.match(r, /ran on pi-glm \(pi-nokey unavailable: Profile pi-nokey needs NOKEY_API_KEY/);
});

test('when every profile fails the error lists each one', async () => {
  resetPreflightCache();
  const { text, deps } = await setup({ env: pEnv, fetchFn: fetchWith(401, 'bad key') });
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'pi-glm', fallback: ['pi-particle'] }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /No profile could start[\s\S]*pi-glm:[\s\S]*pi-particle:[\s\S]*Next step:/);
});

// ---- per-profile cap ----
test('a profile at its maxConcurrent cap queues the next start with a status line, and starts it when a slot frees', async () => {
  const open = new Map([['a', { id: 'a', status: 'running', profile: { name: 'pi-x' } }], ['b', { id: 'b', status: 'idle', profile: { name: 'pi-x' } }]]);
  let release;
  const q = startQueue({}, undefined, () => open.values(), { sleep: () => new Promise((r) => { release = r; }) });
  const me = { id: 'c', status: 'starting', profile: { name: 'pi-x', maxConcurrent: 2 }, emit() {} };
  let started = false;
  const p = q.create(me, async () => { started = true; });
  await tick(5);
  assert.equal(started, false);
  assert.match(q.reason(me), /waiting for a free pi-x slot \(2 of 2 running/);
  open.get('b').status = 'stopped';
  release();
  await p;
  assert.ok(started);
  const other = { id: 'd', status: 'starting', profile: { name: 'pi-y' }, emit() {} };
  await q.create(other, async () => {}); // no cap on another profile
});

test('snapshot preparation does not consume a profile slot', async () => {
  let now = 0, started = false;
  const preparing = { id: 'preparing', status: 'starting', profile: { name: 'pi-x' } };
  const open = new Map([[preparing.id, preparing]]);
  const q = startQueue({}, undefined, () => open.values(), { now: () => now, sleep: async (ms) => { now += ms; if (now >= 20) preparing.status = 'stopped'; }, softPollMs: 1 });
  const me = { id: 'me', status: 'starting', profile: { name: 'pi-x', maxConcurrent: 1 }, emit() {} };
  await q.create(me, async () => { started = true; });
  assert.equal(started, true);
  assert.equal(now, 0, 'the preparing agent has not created a machine and must not fill maxConcurrent');
});

test('snapshot preparation does not consume a machine slot', async () => {
  let now = 0, started = false;
  const preparing = { id: 'preparing', status: 'starting' };
  const open = new Map([[preparing.id, preparing]]);
  const provider = { name: 'fake', caps: { startsPerMin: 25 }, plan: async () => ({ tier: 'pro', specs: [], startsPerMinute: 25, maxRunning: 1 }) };
  const q = startQueue({}, provider, () => open.values(), { now: () => now, sleep: async (ms) => { now += ms; }, softPollMs: 1, softWaitMs: 10 });
  await q.learnPlan();
  const me = { id: 'me', status: 'starting', profile: { name: 'pi-y' }, emit() {} };
  await q.create(me, async () => { started = true; });
  assert.equal(started, true);
  assert.equal(now, 0, 'the preparing agent has not created a machine and must not fill maxRunning');

  preparing.machineCreating = true;
  now = 0;
  let createStarted = false;
  const queued = { id: 'queued', status: 'starting', profile: { name: 'pi-z' }, emit() {} };
  const waitForCreate = startQueue({}, provider, () => open.values(), { now: () => now, sleep: async (ms) => { now += ms; if (now >= 3) preparing.machineCreating = false; }, softPollMs: 1, softWaitMs: 10 });
  await waitForCreate.learnPlan();
  await waitForCreate.create(queued, async () => { createStarted = true; });
  assert.equal(createStarted, true);
  assert.equal(now, 3, 'an in-flight provider create must reserve a machine slot');
});

test('the profile cap counts only running or starting machines from provider.list', async () => {
  for (const [rows, shouldRun] of [
    [[{ id: 'm1', state: 'stopped', status: 'stopped' }], true],
    [[{ id: 'm1', state: 'running', status: 'running' }], false],
    [[{ id: 'm1', state: 'starting', status: 'starting' }], false],
  ]) {
    const provider = { name: 'fake', caps: { startsPerMin: 25 }, list: async () => rows };
    const open = new Map();
    const q = startQueue({}, provider, () => open.values(), { sleep: () => new Promise(() => {}) });
    const me = (id) => ({ id, status: 'starting', profile: { name: 'pi-x', maxConcurrent: 1 }, emit() {} });
    await q.create(me('a'), async () => {}); // triggers the provider.list lookup; its answer lands for the next check
    await tick(20);
    let started = false;
    const p = q.create(me('b'), async () => { started = true; });
    await Promise.race([p, tick(100)]); // a held slot would wait forever on the injected sleep
    assert.equal(started, shouldRun, `rows=${JSON.stringify(rows)}`);
  }
});

test('an agent that commits nothing leaves no cloudy-cloud branch on the remote', async () => {
  const { start, wait, remote } = await setup();
  const id = await start();
  assert.match(await wait([id]), /No changes, no branch pushed/);
  assert.equal(await remote('git branch --list "cloudy-cloud/*"'), '');
});

test('base starts the worker from another branch, not the local HEAD', async () => {
  const { start, wait, repo, created } = await setup();
  await sh(repo, 'git checkout -q -b other && echo o > o.txt && git add -A && git commit -qm other && git checkout -q -');
  const tip = await sh(repo, 'git rev-parse other'), head = await sh(repo, 'git rev-parse HEAD');
  assert.notEqual(tip, head);
  const id = await start({ base: 'other' });
  await wait([id]);
  assert.ok(created[0].cmds.some((c) => c.includes(`git checkout -q --detach ${tip}`)));
  const id2 = await start({ base: tip.slice(0, 10) });
  await wait([id2]);
  assert.ok(created[1].cmds.some((c) => c.includes(`git checkout -q --detach ${tip}`)));
});

test('an unknown or invalid base fails before any machine is created', async () => {
  const { deps, text, created } = await setup();
  for (const base of ['nope', '--upload-pack=x', 'a..b', 'a//b', 'x.lock', 5]) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', base }, deps);
    assert.ok(r.isError, `${base}`);
    assert.match(text(r), /base/);
  }
  assert.equal(created.length, 0);
});

// Host-side git talks to the fake GitHub through the same insteadOf rewrite the sandbox uses.
const rewriteGithub = (repo, github) => sh(repo, `git config url.${github}/.insteadOf https://github.com/`);

test('base that exists only on origin resolves to the sha ls-remote reported, not the local HEAD', async () => {
  const { start, wait, repo, bare, github, created } = await setup();
  await rewriteGithub(repo, github);
  await sh(repo, `git push -q ${bare} HEAD:refs/heads/remoteonly`);
  const tip = await sh(repo, 'git rev-parse HEAD');
  await sh(repo, 'echo later > later.txt && git add -A && git commit -qm later'); // local HEAD moves past the branch
  const id = await start({ base: 'remoteonly' });
  await wait([id]);
  assert.ok(created[0].cmds.some((c) => c.includes(`git checkout -q --detach ${tip}`)), 'checked out the remote tip');
});

test('a base missing on origin fails cleanly; a stale remote-tracking ref or FETCH_HEAD is never used', async () => {
  const { repo, bare, github, deps, text, created } = await setup();
  await rewriteGithub(repo, github);
  await sh(repo, `git push -q ${bare} HEAD:refs/heads/remoteonly`);
  await sh(repo, `git update-ref refs/remotes/origin/ghost HEAD`);
  await sh(repo, `git fetch -q origin remoteonly`); // poisons FETCH_HEAD with an unrelated branch
  const r = await runSubagent({ description: 'd', prompt: 'hi', base: 'ghost' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /base ghost was not found locally or on origin/);
  assert.equal(created.length, 0);
});
