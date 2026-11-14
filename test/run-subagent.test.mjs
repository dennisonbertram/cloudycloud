import './tmp-cleanup.mjs';
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
import { fakeSandbox, setGithub, getGithub, SID, createFakeProvider } from './fake-provider.mjs';
import { runSubagent, messageAgent, waitAgents, resultAgent, listAgents, stopAgents, killAll, getTask } from '../src/run-subagent.mjs';

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
  const deps = { createSandbox, provider: createFakeProvider(), open, cwd: repo, env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret' }, ...over };
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
const refs = (repo) => sh(repo, 'git for-each-ref');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('start returns at once with starting, before the sandbox exists', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, text } = await setup({ createSandbox: async () => { await gate; return fakeSandbox(); } });
  const r = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.match(text(r), /agent_id: [0-9a-f]{8}\nstatus: starting/);
  assert.equal([...deps.open.values()][0].status, 'starting');
  release();
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

test('an agent description containing a secret is logged scrubbed', async () => {
  const events = [];
  const { start } = await setup({ events: (e) => events.push(e) });
  await start({ description: `deploy with ${SECRET}` });
  assert.equal(events.find((e) => e.type === 'agent').description, 'deploy with [redacted]');
  assert.ok(!JSON.stringify(events).includes(SECRET));
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
  assert.match(first, /Pushed to origin cloudy-cloud\//);
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
  assert.match(text(await listAgents({}, deps)), new RegExp(`${id}  idle  idle 0 min  deleted at \\S+  my task`));
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
  created[0].files.write = async () => { throw new Error('sandbox not found'); };
  await msg(id, 'hi');
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /no longer reachable/);
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
    const w = await waitAgents({ ...args, timeout_seconds: 1 }, deps);
    assert.notEqual(w.isError, true, JSON.stringify(w));
  }
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
  assert.match(out, new RegExp(`Pushed to origin cloudy-cloud/${id} at [0-9a-f]{7}\\. Fetch with: git fetch origin cloudy-cloud/${id}`));
  assert.equal(await remote(`git merge-base --is-ancestor ${tip1} cloudy-cloud/${id} && echo yes`), 'yes');
  assert.equal(await remote(`git show cloudy-cloud/${id}:b.txt`), 'more');
  const cmd = created[0].cmds.filter((c) => c.includes('claude -p')).pop();
  assert.match(cmd, new RegExp(`--resume ${SID} --dangerously-skip-permissions --output-format stream-json --verbose`));
  assert.match(cmd, /--model haiku/);
  assert.equal(created[0].writes.filter((p) => p.endsWith('in.bundle')).length, 1);
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
  assert.equal(await remote(`git show cloudy-cloud/${id}:b.txt`), 'local');
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
  assert.ok(cmd.includes(`--append-system-prompt 'You are on branch cloudy-cloud/${id}, which tracks origin. After each meaningful step, commit with a short message and run git push. Your sandbox can disappear at any time; only pushed work survives. Never push to any other branch. Run every command in the foreground and wait for it to finish. Never end your turn while work is still running. No human is available to answer questions. Make reasonable choices, write down any assumptions in your final reply, and keep going. Only if you are truly blocked, stop and end your reply with a line starting QUESTION: that states exactly what you need; whoever started you can answer with a follow-up message. Your machine is deleted by the server at ${new Date(deps.open.get(id).deleteAt).toISOString()}; push your work well before then.'`));
  assert.ok(created[0].cmds.some((c) => c.includes('git config user.name cloudy-cloud') && c.includes('user.email cloudy-cloud@localhost')));
  assert.ok(created[0].cmds.some((c) => c.includes(`git remote add origin '${ORIGIN}'`) && c.includes(`git checkout -q -b cloudy-cloud/${id}`)));
  assert.ok(created[0].cmds.includes('gh auth setup-git'));
  assert.ok(created[0].cmds.includes(`git push -q -u origin cloudy-cloud/${id}`));
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
  assert.equal(await remote(`git ls-tree -r --name-only cloudy-cloud/${id}`), 'a.txt');
  assert.equal(await remote(`git show cloudy-cloud/${id}:a.txt`), 'orig');
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
  assert.doesNotMatch(r, /ERROR/);
  assert.match(r, /Push failed: .*denied by test.*; the agent is still open, ask it to push\./s);
  assert.ok(open.has(id));
  await rejectPushes(false);
  assert.equal((await msg(id, 'hi')).isError, undefined);
  assert.match(await wait([id]), new RegExp(`Pushed to origin cloudy-cloud/${id}`));
  assert.equal(await remote(`git show cloudy-cloud/${id}:unpushed.txt`), 'unpushed');
});

test('a failed first push fails the agent with a clear, scrubbed message', async () => {
  const { start, wait, rejectPushes, created } = await setup();
  await rejectPushes(true);
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /first push.*GH_TOKEN.*RUNBOOK\.md, step 2\.4.*denied by test/s);
  assert.ok(created[0].killed);
  assert.ok(!created[0].cmds.some((c) => c.includes('claude -p')));
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
  const { deps, wait } = await setup({ createSandbox: async () => { await gate; return fakeSandbox(); }, asTask: true });
  const t = await runSubagent({ description: 'd', prompt: 'hi' }, deps);
  assert.equal(t.resultType, 'task');
  assert.equal(t.statusMessage, 'starting machine…');
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
  assert.equal(await readFile(join(created[0].dir, 'home', 'envlog.txt'), 'utf8'), '1 1680000 1680000\n1 1680000 1680000\n');
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
    s.commands.run = (cmd, o) => (cmd.startsWith('git push -q -u') && fails++ < n
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
  const { start, wait } = await setup(f);
  const r = await wait([await start()]);
  assert.match(r, /status: failed/);
  assert.match(r, /GH_TOKEN.*RUNBOOK\.md, step 2\.4/s);
});

test('without proxy secrets an auth failure on the first push gives the provider\'s token help, not the Instabox one', async () => {
  const f = flakyFirstPush(9, 'remote: Permission to test/repo.git denied. fatal: 403');
  const provider = createFakeProvider(undefined, { hasProxySecrets: false, hasConsentedSecrets: true });
  const { start, wait } = await setup({ ...f, provider });
  const r = await wait([await start()]);
  assert.match(r, /first push to origin \S+ failed\. Create the GH_TOKEN secret\. Also check that the token has write access to this repo\./);
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
        ? Promise.resolve({ stdout: 'PUSHFAIL\nERR missing necessary objects\nSHA abc1234\n' })
        : run(cmd, o));
      return s;
    },
  });
  const r = await wait([await start()]);
  assert.match(r, /Pushed to origin cloudy-cloud\//);
  assert.equal(pushes, 2);
  assert.equal(sleeps.length, 1);
});

// ---- model profiles ----
const PKEY = 'pk-particle-secret-999';
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
  assert.ok(i > sbx.cmds.findIndex((c) => c.includes('git push -q -u')) && j > i && k > j, 'order: push, gateway, health, claude');
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
  await writeFile(join(tool, 'bin', 'cloudy-cloud'), '#!/bin/sh\necho "LAUNCHER $* EXTRA=$CLOUDY_CLOUD_EXTRA_PROMPT" >> ../launcher.log\nexec claude "$@"\n');
  await chmod(join(tool, 'bin', 'cloudy-cloud'), 0o755);
  await sh(tool, 'git add -A && git commit -qm tool && git remote add origin https://github.com/test/tool.git');
  await mkdir(join(x.github, 'test', 'tool.git'));
  await sh(join(x.github, 'test', 'tool.git'), 'git init -q --bare -b main');
  await sh(tool, `git push -q ${join(x.github, 'test', 'tool.git')} main`);
  x.deps.toolRoot = tool;
  return { tool, sha: await sh(tool, 'git rev-parse HEAD') };
}
// STRIPE_API_KEY stands for any *_API_KEY in the shell that no profile uses.
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
  const launched = await readFile(join(home, 'launcher.log'), 'utf8');
  assert.doesNotMatch(launched, /--append-system-prompt/); // the launcher adds its own; a second flag could replace it
  assert.match(launched, /^LAUNCHER -p --dangerously-skip-permissions --output-format stream-json --verbose .*EXTRA=.*You are on branch cloudy-cloud\/.*You are a coordinator\. You can start your own cloud subagents.*No human is watching in real time\..*QUESTION: line, answer it with cloud_agent_message\. Your workers are deleted as soon as your reply ends.*call cloud_agent_wait on every worker you started/);
  assert.ok(s.cmds.some((c) => c.includes('/cloudy-cloud/bin/cloudy-cloud -p')));
  assert.match(await x.text(await listAgents({}, x.deps)), /role coordinator/);
});

test('a provider that defines coordinatorEnv adds fixed lines and its own names (not the Instabox key) to the shared allowlist; the depth lines are still added (#41)', async () => {
  const x = await setup();
  x.deps.env = { ...LONG_ENV };
  x.deps.provider.coordinatorEnv = () => ({ fixed: ['CLOUDY_CLOUD_PROVIDER=self-hosted', 'CLOUDY_CLOUD_SELF_HOSTED_LOCAL=1'], names: ['GH_TOKEN'] });
  await withTool(x);
  await x.wait([await x.start({ role: 'coordinator', prompt: 'hi' })]);
  const env = await readFile(join(x.created[0].dir, 'home', '.config/cloudy-cloud/env'), 'utf8');
  assert.equal(env, 'CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SELF_HOSTED_LOCAL=1\nGH_TOKEN=ghp_secret\nCLAUDE_CODE_OAUTH_TOKEN=oauth-tok-1\nPARTICLE_API_KEY=part-key-1\nCLOUDY_CLOUD_DEPTH=1\nCLOUDY_CLOUD_MAX_DEPTH=3\nCLOUDY_CLOUD_MAX_AGENTS_PER_SESSION=200\n');
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

test('a pi run whose final assistant message is an error fails the turn', async () => {
  const { start, wait } = await profileSetup();
  const id = await start({ profile: 'pi-particle', prompt: 'PIERR now' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
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
  assert.match(r.content[0].text, /coordinator cannot use a pi or omp profile/);
  assert.equal(created.length, 0);
});

test('workers get a 6 hour delete deadline by default, CLOUDY_CLOUD_WORKER_HOURS changes it, and the deadline is in the list', async () => {
  const seen = [];
  const x = await setup({ createSandbox: async (envs, opts) => { seen.push(opts); return fakeSandbox(); } });
  const t0 = Date.now();
  const id = await x.start();
  await x.wait([id]);
  assert.deepEqual(seen[0], { deleteAfterSeconds: 21600 });
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
  const s = await profileSetup('ok', { ...pEnv, CLOUDY_CLOUD_MCP: file });
  if (over.events) s.deps.events = over.events;
  const inner = s.deps.createSandbox;
  s.deps.createSandbox = (envs, o) => { opts.push(o); return inner(envs, o); };
  return { ...s, opts, file };
}
const X = { x: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_X_TOKEN}' } } };
const claudeCmd = (sbx) => sbx.cmds.find((c) => /claude -p|cloudy-cloud\/bin\/cloudy-cloud -p/.test(c));

test('a plain worker without mcp.json runs the same claude command (now inside the stream tee) and writes no mcp file', async () => {
  const { start, wait, sandboxes, opts } = await mcpSetup('{"mcpServers":{}}');
  await wait([await start({})]);
  const sbx = sandboxes[0];
  const inner = /\{ (.*); echo \$\? > \$D\/t1\.exit; \}/.exec(claudeCmd(sbx))[1];
  assert.equal(inner.replace(/--append-system-prompt '[^']*'/, "--append-system-prompt 'HINT'"),
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 BASH_DEFAULT_TIMEOUT_MS=1680000 BASH_MAX_TIMEOUT_MS=1680000 claude -p --dangerously-skip-permissions --output-format stream-json --verbose --append-system-prompt \'HINT\' < /home/user/prompt.txt');
  assert.ok(!sbx.writes.some((p) => p.endsWith('mcp.json')));
  assert.deepEqual(opts[0], { deleteAfterSeconds: 21600 });
});

test('a worker with an mcp.json server gets the file, the flags, the secret, the footer and the event', async () => {
  const { start, wait, sandboxes, opts } = await mcpSetup(X);
  const id = await start({});
  const r = await wait([id]);
  const sbx = sandboxes[0], home = '/home/user';
  assert.deepEqual(opts[0].secrets, ['MCP_X_TOKEN']);
  assert.equal(sbx.written[`${home}/.config/cloudy-cloud/mcp.json`], JSON.stringify({ mcpServers: X }, null, 2));
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${home}/.config/cloudy-cloud/mcp.json`)));
  assert.match(claudeCmd(sbx), /--verbose --mcp-config \/home\/user\/\.config\/cloudy-cloud\/mcp\.json --strict-mcp-config /);
  assert.match(r, /MCP servers: x/);
  assert.ok(!JSON.stringify(sbx.envs).includes('MCP_'), 'no MCP value in the sandbox env');
});

test('the agent event lists the MCP server names only', async () => {
  const events = [];
  const { start, wait } = await mcpSetup(X, { events: (e) => events.push(e) });
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
  const { start, wait, sandboxes, opts } = await mcpSetup(servers, { events: (e) => ev.push(e) });
  const r = await wait([await start({ profile: 'pi-glm' })]);
  const sbx = sandboxes[0], home = '/home/user';
  assert.equal(sbx.written[`${home}/pi-agent/mcp.json`], mcpConfigText({ x: servers.x, npxone: servers.npxone }));
  assert.ok(sbx.cmds.some((c) => c.includes('umask 077') && c.includes(`: > ${home}/pi-agent/mcp.json`)));
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${home}/pi-agent/mcp.json`)));
  assert.ok(!sbx.writes.some((p) => p.includes('.config/cloudy-cloud/mcp.json')));
  assert.deepEqual(opts[0].secrets, ['MCP_X_TOKEN']);
  assert.match(r, /MCP servers: x, npxone/);
  assert.match(r, /MCP servers skipped: s \(pi does not support the SSE transport\)/);
  assert.deepEqual(ev.find((e) => e.type === 'agent').mcp, ['x', 'npxone']);
  assert.ok(!(await piLog(sbx)).includes('mcp'), 'the pi command is unchanged');
});

test('an omp worker gets its mcp.json (SSE kept) in omp-agent with the 600 sequence, and no key value anywhere', async () => {
  const servers = { ...X, s: { type: 'sse', url: 'https://s.example.com/sse' } };
  const { start, wait, sandboxes, opts } = await mcpSetup(servers);
  const r = await wait([await start({ profile: 'omp-glm' })]);
  const sbx = sandboxes[0], home = '/home/user';
  assert.equal(sbx.written[`${home}/omp-agent/mcp.json`], mcpConfigText(servers));
  assert.ok(sbx.cmds.some((c) => c.includes('umask 077') && c.includes('chmod 700') && c.includes(`: > ${home}/omp-agent/mcp.json`)));
  assert.ok(sbx.cmds.some((c) => c.includes(`chmod 600 ${home}/omp-agent/mcp.json`)));
  assert.ok(!sbx.writes.some((p) => p.includes('.config/cloudy-cloud/mcp.json')));
  assert.deepEqual(opts[0].secrets, ['MCP_X_TOKEN']);
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
  assert.ok(!claudeCmd(sandboxes[0]).includes('--mcp-config'));
  assert.deepEqual(opts[0], { deleteAfterSeconds: 21600 });
});

test('a coordinator gets mcp.json next to its env file and passes it to the launcher after the launcher-bound flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mcp-'));
  const file = join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: X }));
  const x = await setup();
  x.deps.env = { ...LONG_ENV, CLOUDY_CLOUD_MCP: file };
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
  const x = await setup({ createSandbox: undefined, provider, owner: 'o1' });
  const id = await x.start();
  assert.match(await x.wait([id]), /status: idle/);
  assert.equal(provider.log.create.length, 1);
  const { envs, ...rest } = provider.log.create[0];
  assert.deepEqual(rest, { image: 'agent-browser', labels: { purpose: 'cloudy-cloud', owner: 'o1' }, ttlSeconds: 21600, secrets: [] });
  assert.deepEqual(Object.keys(envs), ['ANTHROPIC_API_KEY']);
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
  assert.match(r, /\nGitHub token: on your machine box1 \(you allowed it\)/);
});

test('with proxy secrets the reply has no token line', async () => {
  const x = await setup();
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
  const x = await setup({ createSandbox: null, provider });
  await x.wait([await x.start({ role: 'coordinator' })]);
  await x.wait([await x.start({ role: 'worker' })]);
  assert.deepEqual(calls.map((c) => c.role), ['coordinator', undefined]); // a worker's create args stay as before
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
