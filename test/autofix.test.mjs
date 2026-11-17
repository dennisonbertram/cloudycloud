import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSandbox, setGithub, createFakeProvider } from './fake-provider.mjs';
import { runSubagent, messageAgent, waitAgents, stopAgents, getTask, cancelTask } from '../src/run-subagent.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const text = (r) => r.content[0].text;
const PR = 'https://github.com/test/repo/pull/7';
const RUN_LINK = 'https://github.com/test/repo/actions/runs/555/job/9';
const fail = (stderr) => Object.assign(new Error('exit'), { exitCode: 1, stdout: '', stderr });

// Fake gh: `gh ...` commands are answered here; everything else runs in the fake sandbox. `g` holds the scripted state.
async function setup(g = {}, env = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t && echo orig > a.txt && git add -A && git commit -qm init');
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: repo });
  const github = await mkdtemp(join(tmpdir(), 'cc-github-'));
  await mkdir(join(github, 'test'));
  await sh(github, 'git init -q --bare -b main test/repo.git');
  setGithub(github);
  g.calls = [];
  g.prompts = [];
  g.hasPr ??= false;
  g.checks ??= [[]]; // one list per `pr checks` call; the last repeats
  g.view ??= () => ({ number: 7, url: PR, baseRefName: 'main', mergeable: 'MERGEABLE', author: { login: 'me' }, reviews: [] });
  let checkCalls = 0;
  const handle = (cmd) => {
    g.calls.push(cmd);
    if (cmd.startsWith('gh pr view')) { if (!g.hasPr) throw fail('no pull requests found'); return JSON.stringify(g.view()); }
    if (cmd.startsWith('gh pr create')) { if (g.createError) throw fail(g.createError); g.hasPr = true; return `${PR}\n`; }
    if (cmd.startsWith('gh pr checks')) {
      const list = g.checks[Math.min(checkCalls++, g.checks.length - 1)];
      // Instabox rejects a nonzero exit with only exitCode (no stdout), unless the command itself always exits 0.
      if (g.strictExit && !cmd.endsWith('; true') && list.some((c) => c.bucket !== 'pass')) throw Object.assign(new Error('x'), { exitCode: list.some((c) => c.bucket === 'pending') ? 8 : 1 });
      return JSON.stringify(list);
    }
    if (cmd.startsWith('gh run view')) return g.log ?? '';
    if (cmd.startsWith('gh api')) return JSON.stringify(g.inline ?? []);
    return '';
  };
  const createSandbox = async () => {
    const s = await fakeSandbox(github);
    const run = s.commands.run, write = s.files.write;
    s.commands.run = (cmd, o) => (cmd.startsWith('gh ') ? Promise.resolve().then(() => ({ stdout: handle(cmd), stderr: '', exitCode: 0 })) : run(cmd, o));
    s.files.write = (p, d) => { if (p.endsWith('prompt.txt')) g.prompts.push(String(d)); return write(p, d); };
    return s;
  };
  const open = new Map();
  const deps = { createSandbox, provider: createFakeProvider({ FAKE_API_KEY: 'k' }, { hasProxySecrets: false, hasConsentedSecrets: true }), open, cwd: repo, env: { ANTHROPIC_API_KEY: 'sk-x', ...env }, autofixPollMs: 5, autofixGraceMs: 20, ...g.deps };
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const wait = (ids) => waitAgents({ agent_ids: ids, timeout_seconds: 60 }, deps).then(text);
  return { g, deps, start, wait, open };
}
const turns = (g) => g.prompts.length;

test('autofix off: no gh pull request calls and one turn', async () => {
  const { g, start, wait } = await setup();
  const id = await start();
  const r = await wait([id]);
  assert.match(r, /hello/);
  assert.doesNotMatch(r, /Autofix/);
  assert.deepEqual(g.calls.filter((c) => /^gh pr/.test(c)), []);
});

test('autofix: PR created, no checks configured, one turn, result has URL and clean', async () => {
  const { g, start, wait, open } = await setup();
  const id = await start({ autofix: true });
  const r = await wait([id]);
  assert.match(r, new RegExp(`Autofix: pull request ${PR} is clean`));
  assert.equal(turns(g), 1);
  assert.ok(g.calls.includes(`gh pr create --head cloudy-cloud/${id} --fill`));
  assert.equal(open.get(id).prUrl, PR);
  assert.match(r, /status: idle/);
});

test('autofix: a failed check then a pass runs exactly two turns, and the second message has the log tail', async () => {
  const { g, start, wait } = await setup({ checks: [[{ name: 'test', bucket: 'pending', link: RUN_LINK }], [{ name: 'test', bucket: 'fail', link: RUN_LINK }], [{ name: 'test', bucket: 'pass', link: RUN_LINK }]], log: 'x\nAssertionError: boom in foo.test.js\n' });
  const id = await start({ autofix: true });
  const r = await wait([id]);
  assert.equal(turns(g), 2);
  assert.match(g.prompts[1], /Failed check "test"/);
  assert.match(g.prompts[1], /AssertionError: boom in foo\.test\.js/);
  assert.ok(g.calls.includes('gh run view 555 --log-failed'));
  assert.match(r, /is clean .* after 1 fix round\./);
});

test('autofix: review comments and merge conflicts are sent to the worker once', async () => {
  const { g, start, wait } = await setup({
    inline: [{ id: 1, user: { login: 'rev' }, path: 'a.txt', line: 3, body: 'rename this' }, { id: 2, user: { login: 'me' }, path: 'a.txt', body: 'my own reply' }],
  });
  let n = 0;
  g.view = () => ({ number: 7, url: PR, baseRefName: 'main', mergeable: n++ < 2 ? 'CONFLICTING' : 'MERGEABLE', author: { login: 'me' }, reviews: [] });
  const id = await start({ autofix: true });
  const r = await wait([id]);
  assert.equal(turns(g), 2);
  assert.match(g.prompts[1], /Comment by rev on a\.txt:3: rename this/);
  assert.doesNotMatch(g.prompts[1], /my own reply/);
  assert.match(g.prompts[1], /Merge conflict with main/);
  assert.match(r, /is clean/);
});

test('autofix: the cap ends the loop and the result lists what still fails', async () => {
  const { g, start, wait } = await setup({ checks: [[{ name: 'lint', bucket: 'fail', link: RUN_LINK }]] }, { CLOUDY_CLOUD_AUTOFIX_ROUNDS: '2' });
  const id = await start({ autofix: true });
  const r = await wait([id]);
  assert.equal(turns(g), 3); // first turn plus two fix rounds
  assert.match(r, /is NOT clean after 2 fix rounds/);
  assert.match(r, /Failed check "lint"/);
  assert.match(r, /cloud_agent_message/);
});

test('autofix: gh pr create failing leaves the agent idle and explains the next step', async () => {
  const { g, start, wait, open } = await setup({ createError: 'GraphQL: Resource not accessible by personal access token ghp_secret' });
  const id = await start({ autofix: true });
  const r = await wait([id]);
  assert.match(r, /Autofix stopped: gh could not create a pull request/);
  assert.match(r, /Resource not accessible/);
  assert.match(r, /Next step:/);
  assert.equal(open.get(id).status, 'idle');
  assert.equal(turns(g), 1);
});

test('autofix: cancelling during the checks wait ends the task promptly', async () => {
  const { g, deps, start } = await setup({ checks: [[{ name: 'test', bucket: 'pending', link: RUN_LINK }]], deps: { autofixPollMs: 60_000, autofixChecksMs: 600_000, asTask: true } });
  const out = await runSubagent({ description: 'd', prompt: 'hi', autofix: true }, deps);
  const taskId = out.taskId;
  const t0 = Date.now();
  while (!g.calls.some((c) => c.startsWith('gh pr checks')) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
  const t1 = Date.now();
  const v = await cancelTask(taskId, deps);
  assert.ok(Date.now() - t1 < 3000);
  assert.equal(v.status, 'cancelled');
  assert.equal(getTask(taskId, deps).status, 'cancelled');
});

test('autofix: the status line shows the autofix round', async () => {
  const { g, deps, start, wait } = await setup({ checks: [[{ name: 'test', bucket: 'pending', link: RUN_LINK }]], deps: { autofixPollMs: 60_000, autofixChecksMs: 600_000, asTask: true } });
  const { taskId } = await runSubagent({ description: 'd', prompt: 'hi', autofix: true }, deps);
  const t0 = Date.now();
  let msg = '';
  while (!/autofix 0\/3: waiting for checks/.test(msg) && Date.now() - t0 < 20_000) { await new Promise((r) => setTimeout(r, 20)); msg = getTask(taskId, deps).statusMessage; }
  assert.match(msg, /autofix 0\/3: waiting for checks/);
  await cancelTask(taskId, deps);
});

test('autofix is rejected for a coordinator, with the next step', async () => {
  const { deps } = await setup();
  const r = await runSubagent({ description: 'd', prompt: 'hi', role: 'coordinator', autofix: true }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /autofix works for workers only/);
  assert.match(text(r), /role "worker"/);
});

test('autofix must be a boolean', async () => {
  const { deps } = await setup();
  const r = await runSubagent({ description: 'd', prompt: 'hi', autofix: 'yes' }, deps);
  assert.equal(r.isError, true);
  assert.match(text(r), /invalid autofix/);
});

test('autofix: pending and failing checks work when the provider drops stdout of a nonzero exit', async () => {
  const { g, start, wait } = await setup({ strictExit: true, checks: [[{ name: 'test', bucket: 'pending', link: RUN_LINK }], [{ name: 'test', bucket: 'fail', link: RUN_LINK }], [{ name: 'test', bucket: 'pass', link: RUN_LINK }]], log: 'boom' });
  const id = await start({ autofix: true });
  const r = await wait([id]);
  assert.doesNotMatch(r, /could not read the checks/);
  assert.equal(turns(g), 2);
  assert.match(r, /is clean/);
});

test('autofix: a follow-up turn cancelled mid-wait ends within 2 s even with the default poll', async () => {
  const { g, deps, start, wait } = await setup({ checks: [[{ name: 'test', bucket: 'pass', link: RUN_LINK }]], deps: { autofixPollMs: 20_000, autofixGraceMs: 0 } });
  g.checks = [[{ name: 'test', bucket: 'pass', link: RUN_LINK }]];
  const id = await start({ autofix: true });
  await wait([id]);
  g.checks = [[{ name: 'test', bucket: 'pending', link: RUN_LINK }]];
  deps.asTask = true;
  const { taskId } = await messageAgent({ agent_id: id, message: 'again' }, deps);
  const t0 = Date.now();
  while (g.calls.filter((c) => c.startsWith('gh pr checks')).length < 2 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const t1 = Date.now();
  const v = await cancelTask(taskId, deps);
  assert.ok(Date.now() - t1 < 2000, `took ${Date.now() - t1} ms`);
  assert.equal(v.status, 'cancelled');
});
