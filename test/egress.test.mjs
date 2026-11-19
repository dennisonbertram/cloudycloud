import './tmp-cleanup.mjs';
// CLOUDY_CLOUD_EGRESS_ALLOW: the parser refusal, the provider-capability refusal, the profile and coordinator
// refusals, the hosts create() is told to allow, and the Network line of the start reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagent, waitAgents, stopAgents } from '../src/run-subagent.mjs';
import { fakeSandbox, setGithub, createFakeProvider } from './fake-provider.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const SECRET = 'sk-test-secret-123';
const ORIGIN = 'https://github.com/test/repo.git';

async function setup(over = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo orig > a.txt && git add -A && git commit -qm init && git remote add origin ' + ORIGIN);
  const github = await mkdtemp(join(tmpdir(), 'cc-github-'));
  const bare = join(github, 'test', 'repo.git');
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${bare}`);
  setGithub(github);
  const created = [], createOpts = [];
  const provider = over.provider ?? createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true, hasEgressPolicy: true });
  const deps = {
    createSandbox: over.createSandbox ?? (async (envs, opts) => { createOpts.push(opts); const s = await fakeSandbox(github); s.envs = envs; created.push(s); return s; }),
    provider, open: new Map(), cwd: repo,
    env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret', CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json', CLOUDY_CLOUD_MCP: '/nonexistent-mcp.json' },
    fetchFn: async () => ({ status: 200, text: async () => '{}' }), // preflight must never reach the network
    ...over, provider,
  };
  const text = (r) => r.content[0].text;
  const start = (args = {}) => runSubagent({ description: 'd', prompt: 'hi', ...args }, deps);
  const wait = (ids, t = 60) => waitAgents({ agent_ids: ids, timeout_seconds: t }, deps).then(text);
  const id = async (args) => text(await start(args)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const stop = (ids) => stopAgents({ agent_ids: ids }, deps);
  return { repo, created, createOpts, deps, start, wait, text, id, stop };
}

test('an invalid CLOUDY_CLOUD_EGRESS_ALLOW value is refused before anything is created', async () => {
  const { start, text, created, deps } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: 'ok.example.com http://x' };
  const r = await start();
  assert.equal(r.isError, true);
  assert.match(text(r), /CLOUDY_CLOUD_EGRESS_ALLOW entry 2 is not a host name\. Use host names such as api\.example\.com or \*\.example\.com, separated by commas or spaces\.\nNext step: fix CLOUDY_CLOUD_EGRESS_ALLOW in ~\/\.config\/cloudy-cloud\/env, or remove it\./);
  assert.ok(!text(r).includes('http://x'), 'the bad entry is not echoed back');
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('a provider that cannot limit egress refuses with the exact message and creates nothing', async () => {
  const { start, text, created, deps } = await setup({ provider: createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true }) });
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start();
  assert.equal(r.isError, true);
  assert.ok(text(r).startsWith('CLOUDY_CLOUD_EGRESS_ALLOW is set, but provider fake cannot limit where a machine connects, so the agent was not started.\nNext step: remove CLOUDY_CLOUD_EGRESS_ALLOW from ~/.config/cloudy-cloud/env to run without an egress limit, or set CLOUDY_CLOUD_PROVIDER=microsandbox to run agents in local microVMs that enforce it, then call cloud_agent again.'), text(r));
  assert.equal(created.length, 0);
  assert.equal(deps.provider.log.create.length, 0);
  assert.equal(deps.open.size, 0);
});

test('with egress set, create gets github.com, the Claude host and the user list, deduplicated; the reply names them', async () => {
  const { id, wait, text, createOpts, start, deps, stop } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com api.anthropic.com example.com' };
  const r = await start();
  const agent = text(r).match(/agent_id: ([0-9a-f]{8})/)[1];
  assert.ok(text(r).includes('Network: only github.com, api.github.com, api.anthropic.com, example.com.'), text(r));
  await wait([agent]);
  assert.deepEqual(createOpts[0].egress.allow, ['github.com', 'api.github.com', 'api.anthropic.com', 'example.com']);
  await stop([agent]);
});

test('a shared MCP server with an https URL adds its host to the allow list', async () => {
  const mcp = join(await mkdtemp(join(tmpdir(), 'cc-mcp-')), 'mcp.json');
  await writeFile(mcp, JSON.stringify({ mcpServers: { ctx: { type: 'http', url: 'https://mcp.example.com/mcp' } } }));
  const { id, wait, createOpts, deps, stop } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_MCP: mcp, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const agent = await id();
  await wait([agent]);
  assert.deepEqual(createOpts[0].egress.allow, ['github.com', 'api.github.com', 'api.anthropic.com', 'mcp.example.com', 'example.com']);
  await stop([agent]);
});

test('profiles that install their agent or the LiteLLM gateway at start are refused', async () => {
  const { start, text, created, deps } = await setup();
  deps.env = { ...deps.env, PARTICLE_API_KEY: 'pk-test-key-999', CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const pi = await start({ profile: 'pi-glm' });
  assert.equal(pi.isError, true);
  assert.ok(text(pi).startsWith('CLOUDY_CLOUD_EGRESS_ALLOW works only for Claude Code workers that reach their model host directly. Profile pi-glm installs its agent (pi) from the internet at start, which the egress limit would block.\nNext step: call cloud_agent without a profile, or remove CLOUDY_CLOUD_EGRESS_ALLOW from ~/.config/cloudy-cloud/env.'), text(pi));
  const glm = await start({ profile: 'glm' });
  assert.equal(glm.isError, true);
  assert.ok(text(glm).startsWith('CLOUDY_CLOUD_EGRESS_ALLOW works only for Claude Code workers that reach their model host directly. Profile glm installs its model gateway (LiteLLM) from the internet at start, which the egress limit would block.\nNext step: call cloud_agent without a profile, or remove CLOUDY_CLOUD_EGRESS_ALLOW from ~/.config/cloudy-cloud/env.'), text(glm));
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('a coordinator with egress set is refused before anything is created, with the per-command opt-out', async () => {
  const { start, text, created, deps } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start({ role: 'coordinator' });
  assert.equal(r.isError, true);
  assert.ok(text(r).startsWith('CLOUDY_CLOUD_EGRESS_ALLOW applies to workers only.'), text(r));
  assert.match(text(r), /CLOUDY_CLOUD_EGRESS_ALLOW=off cloudy-cloud coordinator start/);
  assert.match(text(r), /call cloud_agent with role "worker"/);
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('CLOUDY_CLOUD_EGRESS_ALLOW=off opts out per call: a worker starts with no policy and a coordinator is not refused by it', async () => {
  for (const word of ['off', 'none']) {
    const { id, wait, createOpts, deps, stop, start, text } = await setup();
    deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: word };
    const agent = await id();
    await wait([agent]);
    assert.ok(!('egress' in createOpts[0]), word);
    await stop([agent]);
    // the opt-out word must not trip the workers-only coordinator refusal
    const r = await start({ role: 'coordinator' });
    assert.doesNotMatch(text(r), /applies to workers only/, `${word}: ${text(r)}`);
    await stop([...deps.open.keys()]);
  }
});

test('with egress unset, create options have no egress key', async () => {
  const { id, wait, createOpts, stop } = await setup();
  const agent = await id();
  await wait([agent]);
  assert.ok(!('egress' in createOpts[0]));
  await stop([agent]);
});

test('a set-but-blank CLOUDY_CLOUD_EGRESS_ALLOW is refused, not treated as no policy', async () => {
  const { start, text, created, deps } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: '  , ' };
  const r = await start();
  assert.equal(r.isError, true);
  assert.match(text(r), /CLOUDY_CLOUD_EGRESS_ALLOW is set but lists no hosts/);
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('the provider-capability refusal fires before any profile preflight model request', async () => {
  const fetches = [];
  const { start, text, created, deps } = await setup({
    provider: createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: false, hasConsentedSecrets: true }),
    fetchFn: async (...a) => { fetches.push(a[0]); return { status: 200, text: async () => '{}' }; },
  });
  deps.env = { ...deps.env, PARTICLE_API_KEY: 'pk-early-refusal-1', CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start({ profile: 'glm' }); // format openai: without the early refusal its preflight POSTs to the model host
  assert.equal(r.isError, true);
  assert.match(text(r), /provider fake cannot limit where a machine connects/);
  assert.equal(fetches.length, 0);
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('an incompatible profile is refused before its preflight request too', async () => {
  const fetches = [];
  const { start, text, created, deps } = await setup({
    fetchFn: async (...a) => { fetches.push(a[0]); return { status: 200, text: async () => '{}' }; },
  });
  deps.env = { ...deps.env, PARTICLE_API_KEY: 'pk-early-refusal-2', CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start({ profile: 'glm' });
  assert.equal(r.isError, true);
  assert.match(text(r), /works only for Claude Code workers that reach their model host directly/);
  assert.equal(fetches.length, 0);
  assert.equal(created.length, 0);
});

test('a malformed profile baseUrl is refused before the agent is registered', async () => {
  const profilesFile = join(await mkdtemp(join(tmpdir(), 'cc-profiles-')), 'profiles.json');
  await writeFile(profilesFile, JSON.stringify({ weird: { format: 'anthropic', baseUrl: 'https://model.example:bad', keyName: 'ANTHROPIC_API_KEY', model: 'm1' } }));
  const { start, text, deps } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_PROFILES: profilesFile, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start({ profile: 'weird' });
  assert.equal(r.isError, true);
  assert.match(text(r), /baseUrl/);
  assert.equal(deps.open.size, 0);
  assert.equal(deps.count?.started ?? 0, 0);
});

test('an https MCP URL adds only its lowercase hostname, whatever the scheme case or port', async () => {
  const mcp = join(await mkdtemp(join(tmpdir(), 'cc-mcp-')), 'mcp.json');
  await writeFile(mcp, JSON.stringify({ mcpServers: { ctx: { type: 'http', url: 'HTTPS://MCP.Example.NET:8443/mcp' } } }));
  const { id, wait, createOpts, deps, stop } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_MCP: mcp, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const agent = await id();
  await wait([agent]);
  assert.deepEqual(createOpts[0].egress.allow, ['github.com', 'api.github.com', 'api.anthropic.com', 'mcp.example.net', 'example.com']);
  await stop([agent]);
});

test('npx and uvx MCP servers are refused with the package hosts to add', async () => {
  const mcp = join(await mkdtemp(join(tmpdir(), 'cc-mcp-')), 'mcp.json');
  await writeFile(mcp, JSON.stringify({ mcpServers: { npm: { command: 'npx', args: ['-y', 'some-mcp'] }, py: { command: 'uvx', args: ['other-mcp'] } } }));
  const { start, text, created, deps } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_MCP: mcp, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start();
  assert.equal(r.isError, true);
  assert.match(text(r), /registry\.npmjs\.org/);
  assert.match(text(r), /pypi\.org/);
  assert.match(text(r), /files\.pythonhosted\.org/);
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('CLOUDY_CLOUD_APT_PACKAGES is refused with the apt mirrors to add when egress is active', async () => {
  const provider = createFakeProvider({ FAKE_API_KEY: 'fake-key' }, { hasProxySecrets: true, hasEgressPolicy: true });
  const { start, text, created, deps } = await setup({ provider });
  deps.env = { ...deps.env, CLOUDY_CLOUD_PROXY_SECRETS: 'GH_TOKEN,ANTHROPIC_API_KEY', CLOUDY_CLOUD_APT_PACKAGES: 'jq', CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start();
  assert.equal(r.isError, true);
  assert.match(text(r), /deb\.debian\.org/);
  assert.match(text(r), /cli\.github\.com/);
  assert.equal(created.length, 0);
  assert.equal(deps.open.size, 0);
});

test('a cased duplicate of a built-in host is not allowed twice', async () => {
  const { id, wait, createOpts, deps, stop } = await setup();
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: 'GITHUB.COM Example.COM' };
  const agent = await id();
  await wait([agent]);
  assert.deepEqual(createOpts[0].egress.allow, ['github.com', 'api.github.com', 'api.anthropic.com', 'example.com']);
  await stop([agent]);
});

test('task mode names the allow list in its start message', async () => {
  const { start, deps, stop } = await setup({ asTask: true });
  deps.env = { ...deps.env, CLOUDY_CLOUD_EGRESS_ALLOW: 'example.com' };
  const r = await start();
  assert.equal(r.resultType, 'task');
  assert.match(r.statusMessage, /Network: only github\.com, api\.github\.com, api\.anthropic\.com, example\.com\./);
  await stop([...deps.open.keys()]);
});
