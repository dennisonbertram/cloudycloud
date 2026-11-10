// Golden: what a worker start, one follow-up message and a stop send to the sandbox. Must not change in the provider refactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagent, messageAgent, waitAgents, stopAgents } from '../src/run-subagent.mjs';
import { fakeSandbox, setGithub, createFakeProvider } from './fake-provider.mjs';
import { golden, envNames } from './golden-util.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());

test('worker commands, files and env names are unchanged', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'gold-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo orig > a.txt && git add -A && git commit -qm init && git remote add origin https://github.com/test/repo.git');
  const github = await mkdtemp(join(tmpdir(), 'gold-github-'));
  await mkdir(join(github, 'test'));
  await sh(github, `git init -q --bare -b main ${join(github, 'test', 'repo.git')}`);
  setGithub(github);

  const calls = [];
  const createSandbox = async (envs, opts) => {
    const s = await fakeSandbox(github);
    s.envs = envs;
    const run = s.commands.run;
    s.commands.run = (cmd, o = {}) => { calls.push({ op: 'run', cmd, cwd: o.cwd, timeoutMs: o.timeoutMs, onStdout: typeof o.onStdout === 'function' }); return run(cmd, o); };
    const write = s.files.write;
    s.files.write = (p, d) => { calls.push({ op: 'write', path: p, ...(/\/env$/.test(p) ? { envNames: envNames(d) } : /prompt\.txt$/.test(p) ? { text: String(d) } : {}) }); return write(p, d); };
    const kill = s.kill;
    s.kill = () => { calls.push({ op: 'kill' }); return kill(); };
    calls.push({ op: 'createSandbox', envNames: Object.keys(envs).sort(), opts });
    return s;
  };
  const deps = { createSandbox, provider: createFakeProvider(), open: new Map(), cwd: repo, env: { ANTHROPIC_API_KEY: 'sk-test-secret-123', GH_TOKEN: 'ghp_secret' } };
  const text = (r) => r.content[0].text;
  const id = text(await runSubagent({ description: 'd', prompt: 'hi' }, deps)).match(/agent_id: ([0-9a-f]{8})/)[1];
  await waitAgents({ agent_ids: [id], timeout_seconds: 120 }, deps);
  await messageAgent({ agent_id: id, message: 'again' }, deps);
  await waitAgents({ agent_ids: [id], timeout_seconds: 120 }, deps);
  await stopAgents({ agent_ids: [id] }, deps);

  // The agent id is random, the work repo is a temp path and commit ids depend on the clock; replace them.
  const norm = (v) => JSON.parse(JSON.stringify(v).replaceAll(id, '<ID>').replaceAll(repo, '<REPO>').replace(/\b[0-9a-f]{40}\b/g, '<SHA>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<TIME>'));
  assert.ok(calls.length > 5);
  golden('worker-commands', norm(calls));
});
