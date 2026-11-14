import './tmp-cleanup.mjs';
// Leak guard (#68): on a provider with proxy secrets no real key value may reach any machine (create arguments and labels,
// files written, command lines) or come back in a reply, an event or a stream file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeProvider, setGithub } from './fake-provider.mjs';
import { runSubagent, waitAgents, listAgents, killAll, SECRETS } from '../src/run-subagent.mjs';
import { profileKeyNames } from '../src/profiles.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const text = (r) => r.content[0].text;

// Every key name cloudy-cloud knows, each with its own value.
const NAMES = [...new Set([...SECRETS, ...profileKeyNames({ CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json' }), 'INSTABOX_API_KEY', 'CLOUDY_CLOUD_INSTABOX_API_KEY', 'STRIPE_API_KEY', 'MCP_X_TOKEN'])];
const CANARY = Object.fromEntries(NAMES.map((n) => [n, `canary-${n}-${n.length * 7919}`]));
const PROXIED = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'PARTICLE_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDY_CLOUD_INSTABOX_API_KEY'];

async function world(extraEnv = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-leak-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo orig > a.txt && git add -A && git commit -qm init && git remote add origin https://github.com/test/repo.git');
  const github = await mkdtemp(join(tmpdir(), 'cc-leak-gh-'));
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${join(github, 'test', 'repo.git')}`);
  setGithub(github);
  const tool = await mkdtemp(join(tmpdir(), 'cc-leak-tool-'));
  await sh(tool, 'git init -q -b main && git config user.name t && git config user.email t@t && mkdir bin');
  await writeFile(join(tool, 'bin', 'cloudy-cloud'), '#!/bin/sh\nexec claude "$@"\n');
  await chmod(join(tool, 'bin', 'cloudy-cloud'), 0o755);
  await sh(tool, 'git add -A && git commit -qm tool && git remote add origin https://github.com/test/tool.git');
  await mkdir(join(github, 'test', 'tool.git'));
  await sh(join(github, 'test', 'tool.git'), 'git init -q --bare -b main');
  await sh(tool, `git push -q ${join(github, 'test', 'tool.git')} main`);
  const dir = await mkdtemp(join(tmpdir(), 'cc-leak-cfg-'));
  const mcp = join(dir, 'mcp.json');
  await writeFile(mcp, JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_X_TOKEN}' } } } }));
  const events = [];
  const provider = createFakeProvider();
  const env = { ...CANARY, CLOUDY_CLOUD_PROXY_SECRETS: PROXIED.join(','), CLOUDY_CLOUD_PROFILES: '/nonexistent/profiles.json', CLOUDY_CLOUD_MCP: mcp, CLOUDY_CLOUD_STREAMS: join(dir, 'streams'), ...extraEnv };
  const deps = { provider, open: new Map(), cwd: repo, env, toolRoot: tool, events: (e) => events.push(e) };
  return { deps, provider, events, dir, env };
}

test('no canary key value reaches any machine, reply, event or stream file for every kind of worker and a nested coordinator', async () => {
  const { deps, provider, events, dir } = await world();
  const seen = [];
  const starts = [{}, { profile: 'glm' }, { profile: 'pi-glm' }, { profile: 'omp-glm' }, { profile: 'openrouter', model: 'deepseek/deepseek-chat' }, { role: 'coordinator' }];
  for (const extra of starts) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', ...extra }, deps);
    assert.ok(!r.isError, `${JSON.stringify(extra)}: ${text(r)}`);
    seen.push(text(r));
    const id = text(r).match(/agent_id: ([0-9a-f]{8})/)[1];
    seen.push(text(await waitAgents({ agent_ids: [id], timeout_seconds: 120 }, deps)));
  }
  seen.push(text(await listAgents({}, deps)));
  assert.equal(provider.log.create.length, starts.length);
  assert.ok(provider.log.writes.length > 0 && provider.log.cmds.length > 0, 'the fake provider recorded writes and commands');
  for (const f of await readdir(join(dir, 'streams'), { recursive: true, withFileTypes: true }).catch(() => [])) if (f.isFile()) seen.push(await readFile(join(f.parentPath, f.name), 'utf8'));
  const all = JSON.stringify([provider.log.create, provider.log.writes, provider.log.cmds, events, seen]);
  for (const [name, value] of Object.entries(CANARY)) assert.ok(!all.includes(value), `the value of ${name} reached a machine, a reply, an event or a stream file`);
  await killAll(deps.open);
});

test('with no key stored as a proxy secret, every kind of start is refused and no machine is created', async () => {
  const { deps, provider, events } = await world({ CLOUDY_CLOUD_PROXY_SECRETS: '' });
  const seen = [];
  for (const extra of [{}, { profile: 'glm' }, { profile: 'pi-glm' }, { profile: 'omp-glm' }, { profile: 'openrouter', model: 'deepseek/deepseek-chat' }, { role: 'coordinator' }]) {
    const r = await runSubagent({ description: 'd', prompt: 'hi', ...extra }, deps);
    const id = text(r).match(/agent_id: ([0-9a-f]{8})/)?.[1];
    seen.push(id ? text(await waitAgents({ agent_ids: [id], timeout_seconds: 120 }, deps)) : text(r));
  }
  assert.ok(seen.every((t) => /keeps keys off machines/.test(t)), seen.join('\n---\n'));
  assert.equal(provider.log.create.length, 0);
  const all = JSON.stringify([provider.log, events, seen]);
  for (const [name, value] of Object.entries(CANARY)) assert.ok(!all.includes(value), `the value of ${name} leaked`);
  await killAll(deps.open);
});

test('the refusal: a real PARTICLE_API_KEY with no proxy entry makes a glm worker fail with the setup text and creates no machine', async () => {
  const { deps, provider } = await world({ CLOUDY_CLOUD_PROXY_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN' });
  const r = await runSubagent({ description: 'd', prompt: 'hi', profile: 'glm' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /keeps keys off machines/);
  assert.match(text(r), /cloudy-cloud setup/);
  assert.ok(!text(r).includes(CANARY.PARTICLE_API_KEY));
  assert.equal(provider.log.create.length, 0);
});

test('the refusal: a default worker whose Claude token is not a proxy secret, and a coordinator whose Instabox key is not, create no machine', async () => {
  for (const [proxied, extra] of [['PARTICLE_API_KEY', {}], ['CLAUDE_CODE_OAUTH_TOKEN', { role: 'coordinator' }]]) {
    const { deps, provider } = await world({ CLOUDY_CLOUD_PROXY_SECRETS: proxied });
    const r = await runSubagent({ description: 'd', prompt: 'hi', ...extra }, deps);
    const id = text(r).match(/agent_id: ([0-9a-f]{8})/)?.[1];
    const out = id ? text(await waitAgents({ agent_ids: [id], timeout_seconds: 120 }, deps)) : text(r);
    assert.match(out, /keeps keys off machines/);
    assert.equal(provider.log.create.length, 0);
    await killAll(deps.open);
  }
});
