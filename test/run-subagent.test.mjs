import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStartQueue } from '../src/limits.mjs';
import { runSubagent, messageAgent, waitAgents, listAgents, stopAgents, killAll, getTask } from '../src/run-subagent.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const SECRET = 'sk-test-secret-123';

// Fake `claude`: behaviour chosen by the first word of the prompt on stdin. Prints stream-json like `claude -p --output-format stream-json --verbose`.
const SID = '11111111-2222-3333-4444-555555555555';
const FAKE_CLAUDE = `#!/bin/sh
p=$(cat)
echo "$CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" >> ../envlog.txt
sid=${SID}
resumed=""
[ "$1" = "-p" ] && [ "$2" = "--resume" ] && resumed="resumed $3 "
reply() {
  printf '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":10,"output_tokens":5}}}\\n'
  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"%s","total_cost_usd":0.01,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":7}}\\n' "$sid" "$1"
}
commit() { git add -A; git -c user.name=x -c user.email=x@x commit -qm "$1"; }
case "$p" in
  OWN-*) n=\${p#OWN-}; echo "$n" > "own-$n.txt"; commit "own $n"; git push -q origin HEAD; reply "own $n" ;;
  UNPUSHED*) echo unpushed > unpushed.txt; commit unpushed; reply "\${resumed}committed only" ;;
  DIRTY*) echo newfile > notes.txt; echo dirty >> a.txt; reply "dirty" ;;
  EDIT2*) echo more > b.txt; commit two; git push -q origin HEAD; reply "\${resumed}edited2" ;;
  EDIT*) echo changed > a.txt; commit edit; git push -q origin HEAD; reply "edited" ;;
  SHOW*) reply "a=$(cat a.txt) untracked=$(ls untracked.txt 2>&1 | tr -d '\\n')" ;;
  SLOW*) sleep 0.5; reply "slow done" ;;
  BADSID*) printf '{"type":"result","is_error":false,"result":"x","session_id":"x; rm -rf /"}\\n' ;;
  RAW*) echo "not json" ;;
  LEAK*) reply "leak $LEAK1 $LEAK2" ;;
  FAIL*) echo changed > a.txt; commit fail; echo "boom $ANTHROPIC_API_KEY" >&2; exit 3 ;;
  *) reply "\${resumed}hello" ;;
esac
`;

let currentGithub; // the bare repo of the test being set up (tests in a file run one at a time)
async function fakeSandbox(github = currentGithub) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-sbx-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await mkdir(join(dir, 'home'));
  await writeFile(join(bin, 'claude'), FAKE_CLAUDE);
  await chmod(join(bin, 'claude'), 0o755);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 0\n'); // fake gh: no-op
  await chmod(join(bin, 'gh'), 0o755);
  const map = (s) => s.replaceAll('/home/user', join(dir, 'home'));
  const sbx = {
    dir,
    killed: false,
    files: {
      write: (p, d) => { sbx.writes.push(p); return writeFile(map(p), d); },
      read: (p) => readFile(map(p)),
    },
    cmds: [],
    writes: [],
    commands: {
      async run(cmd, { cwd, timeoutMs, onStdout } = {}) {
        assert.ok(timeoutMs > 0, 'timeoutMs must be set');
        sbx.cmds.push(cmd);
        try {
          const r = await exec('sh', ['-c', map(cmd)], {
            cwd: map(cwd),
            env: { ...process.env, ...(github && { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${github}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' }), PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: sbx.envs?.ANTHROPIC_API_KEY ?? '', LEAK1: 'ghp_secret', LEAK2: 'ghp_other' },
          });
          await onStdout?.(r.stdout);
          return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
        } catch (e) {
          throw Object.assign(new Error('exit'), { exitCode: e.code, stdout: e.stdout, stderr: e.stderr });
        }
      },
    },
    kill: async () => { sbx.killed = true; },
  };
  return sbx;
}

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
  currentGithub = github;
  const created = [];
  const createSandbox = over.createSandbox ?? (async (envs) => { const s = await fakeSandbox(github); s.envs = envs; created.push(s); return s; });
  const open = new Map();
  const deps = { createSandbox, open, cwd: repo, env: { ANTHROPIC_API_KEY: SECRET, GH_TOKEN: 'ghp_secret' }, ...over };
  const text = (r) => r.content[0].text;
  // start an agent, return its id
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const wait = (ids, t = 10) => waitAgents({ agent_ids: ids, timeout_seconds: t }, deps).then(text);
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

test('wait returns the result once, then marks it reported; agent stays open', async () => {
  const { start, wait, created, open } = await setup();
  const id = await start({ prompt: 'hi' });
  const first = await wait([id]);
  assert.match(first, /status: idle/);
  assert.match(first, /hello/);
  assert.match(first, /Pushed to origin claude-cloud\//);
  const second = await wait([id]);
  assert.match(second, /already reported/);
  assert.doesNotMatch(second, /hello/);
  assert.equal(created[0].killed, false);
  assert.ok(open.has(id));
});

test('wait times out while an agent is still running and reports running', async () => {
  const { start, wait } = await setup();
  const id = await start({ prompt: 'SLOW' });
  const t0 = Date.now();
  const r = await wait([id], 0.1);
  assert.ok(Date.now() - t0 < 400);
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
  assert.match(r, new RegExp(`## ${bad}[^#]*status: failed[^#]*machine limit reached \\(quota_exceeded\\)[^#]*Provider message: machine limit`));
  assert.equal((await msg(bad, 'x')).isError, true);
});

test('rate_limited create is reported as the start rate', async () => {
  const { start, wait } = await setup({
    queue: createStartQueue({ sleep: async () => {} }),
    createSandbox: async () => { throw Object.assign(new Error('slow down'), { code: 'rate_limited' }); },
  });
  assert.match(await wait([await start()]), /start rate limit reached \(rate_limited\) and still limited after 5 tries/);
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
  assert.match(text(await listAgents({}, deps)), new RegExp(`${id}  idle  idle 0 min  my task`));
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
  assert.equal(await remote(`git show claude-cloud/${id}:a.txt`), 'changed');
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
  assert.match(r, new RegExp(`already pushed to origin claude-cloud/${id}`));
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
  const r = await runSubagent({ prompt: 'hi', description: 'd' }, { createSandbox: async () => {}, open: new Map(), cwd: dir, env: {} });
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
  const deps = { createSandbox: async () => { throw new Error('unused'); }, open: new Map() };
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
  const tip1 = await remote(`git rev-parse claude-cloud/${id}`);
  const r = await msg(id, 'EDIT2 please');
  assert.match(text(r), /status: running/);
  const out = await wait([id]);
  assert.match(out, new RegExp(`resumed ${SID} edited2`));
  assert.match(out, new RegExp(`Pushed to origin claude-cloud/${id} at [0-9a-f]{7}\\. Fetch with: git fetch origin claude-cloud/${id}`));
  assert.equal(await remote(`git merge-base --is-ancestor ${tip1} claude-cloud/${id} && echo yes`), 'yes');
  assert.equal(await remote(`git show claude-cloud/${id}:b.txt`), 'more');
  const cmd = created[0].cmds.filter((c) => c.includes('claude -p')).pop();
  assert.match(cmd, new RegExp(`--resume ${SID} --dangerously-skip-permissions --output-format stream-json --verbose`));
  assert.match(cmd, /--model haiku/);
  assert.equal(created[0].writes.filter((p) => p.endsWith('in.bundle')).length, 1);
});

test('first-turn command is stream-json output with the commit-and-push hint; identity and branch are set up', async () => {
  const { start, wait, created } = await setup();
  const id = await start();
  await wait([id]);
  const cmd = created[0].cmds.find((c) => c.includes('claude -p'));
  assert.match(cmd, /--output-format stream-json --verbose/);
  assert.ok(cmd.includes(`--append-system-prompt 'You are on branch claude-cloud/${id}, which tracks origin. After each meaningful step, commit with a short message and run git push. Your sandbox can disappear at any time; only pushed work survives. Never push to any other branch. Run every command in the foreground and wait for it to finish. Never end your turn while work is still running.'`));
  assert.ok(created[0].cmds.some((c) => c.includes('git config user.name claude-cloud') && c.includes('user.email claude-cloud@localhost')));
  assert.ok(created[0].cmds.some((c) => c.includes(`git remote add origin '${ORIGIN}'`) && c.includes(`git checkout -q -b claude-cloud/${id}`)));
  assert.ok(created[0].cmds.includes('gh auth setup-git'));
  assert.ok(created[0].cmds.includes(`git push -q -u origin claude-cloud/${id}`));
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
  assert.match(r, new RegExp(`Pushed to origin claude-cloud/${id}`));
  assert.equal(await remote(`git show claude-cloud/${id}:a.txt`), 'changed');
  assert.equal(await refs(repo), before);
  assert.equal(await sh(repo, 'git rev-parse HEAD'), head);
  assert.equal(await sh(repo, 'git status --porcelain'), '');
  assert.ok(!created[0].cmds.some((c) => c.includes('cc-keep') && c.includes('push')));
});

test('safety push sends commits the agent made but did not push', async () => {
  const { start, wait, remote, msg } = await setup();
  const id = await start({ prompt: 'UNPUSHED' });
  const r = await wait([id]);
  assert.match(r, new RegExp(`Pushed to origin claude-cloud/${id}`));
  assert.equal(await remote(`git show claude-cloud/${id}:unpushed.txt`), 'unpushed');
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
  assert.equal(await remote(`git ls-tree -r --name-only claude-cloud/${id}`), 'a.txt');
  assert.equal(await remote(`git show claude-cloud/${id}:a.txt`), 'orig');
  assert.ok(!created[0].cmds.some((c) => /git (add|commit)/.test(c)), 'the server never commits for the agent');
});

test('a push failure is reported; the agent stays idle and messageable', async () => {
  const { start, wait, msg, open, rejectPushes, remote } = await setup();
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
  assert.match(await wait([id]), new RegExp(`Pushed to origin claude-cloud/${id}`));
  assert.equal(await remote(`git show claude-cloud/${id}:unpushed.txt`), 'unpushed');
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
    const files = (await remote(`git diff --name-only ${base} claude-cloud/${id}`)).split('\n');
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
  assert.equal(await readFile(join(created[0].dir, 'home', 'envlog.txt'), 'utf8'), '1\n1\n');
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
