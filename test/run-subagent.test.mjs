import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagent, messageAgent, waitAgents, listAgents, stopAgents, killAll } from '../src/run-subagent.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const SECRET = 'sk-test-secret-123';

// Fake `claude`: behaviour chosen by the first word of the prompt on stdin. Prints JSON like `claude -p --output-format json`.
const SID = '11111111-2222-3333-4444-555555555555';
const FAKE_CLAUDE = `#!/bin/sh
p=$(cat)
sid=${SID}
resumed=""
[ "$1" = "-p" ] && [ "$2" = "--resume" ] && resumed="resumed $3 "
reply() { printf '{"type":"result","is_error":false,"session_id":"%s","result":"%s"}\\n' "$sid" "$1"; }
case "$p" in
  OWN-*) n=\${p#OWN-}; echo "$n" > "own-$n.txt"; git add -A; git -c user.name=x -c user.email=x@x commit -qm "own $n"; reply "own $n" ;;
  JUNK*) mkdir -p __pycache__; echo bytecode > __pycache__/m.pyc; echo newfile > notes.txt; echo dirty >> a.txt; reply "junk" ;;
  EDIT2*) echo more > b.txt; git add -A; git -c user.name=x -c user.email=x@x commit -qm two; reply "\${resumed}edited2" ;;
  EDIT*) echo changed > a.txt; reply "edited" ;;
  SHOW*) reply "a=$(cat a.txt) untracked=$(ls untracked.txt 2>&1 | tr -d '\\n')" ;;
  SLOWCLEAN*) echo dirty >> a.txt; sleep 0.8; reply "slow done" ;;
  SLOWWIP*) echo wipdata > u.txt; echo dirty >> a.txt; sleep 0.8; reply "slow done" ;;
  FAILWIP*) echo wipdata > u.txt; sleep 0.8; echo "boom $ANTHROPIC_API_KEY" >&2; exit 3 ;;
  SLOW*) sleep 0.5; reply "slow done" ;;
  BADSID*) printf '{"result":"x","session_id":"x; rm -rf /"}' ;;
  RAW*) echo "not json" ;;
  FAIL*) echo changed > a.txt; git add -A; git -c user.name=x -c user.email=x@x commit -qm fail; echo "boom $ANTHROPIC_API_KEY" >&2; exit 3 ;;
  *) reply "\${resumed}hello" ;;
esac
`;

async function fakeSandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'fake-sbx-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await mkdir(join(dir, 'home'));
  await writeFile(join(bin, 'claude'), FAKE_CLAUDE);
  await chmod(join(bin, 'claude'), 0o755);
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
      async run(cmd, { cwd, timeoutMs } = {}) {
        assert.ok(timeoutMs > 0, 'timeoutMs must be set');
        sbx.cmds.push(cmd);
        try {
          const r = await exec('sh', ['-c', map(cmd)], {
            cwd: map(cwd),
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: sbx.envs?.ANTHROPIC_API_KEY ?? '' },
          });
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

async function setup(over = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t');
  await writeFile(join(repo, 'a.txt'), 'orig\n');
  await sh(repo, 'git add -A && git commit -qm init');
  const created = [];
  const createSandbox = over.createSandbox ?? (async (envs) => { const s = await fakeSandbox(); s.envs = envs; created.push(s); return s; });
  const open = new Map();
  const deps = { createSandbox, open, cwd: repo, env: { ANTHROPIC_API_KEY: SECRET, E2B_API_KEY: 'e2b-secret' }, ...over };
  const text = (r) => r.content[0].text;
  // start an agent, return its id
  const start = async (args = {}) => text(await runSubagent({ description: 'd', prompt: 'hi', ...args }, deps)).match(/agent_id: ([0-9a-f]{8})/)?.[1];
  const wait = (ids, t = 10) => waitAgents({ agent_ids: ids, timeout_seconds: t }, deps).then(text);
  const msg = (id, message) => messageAgent({ agent_id: id, message }, deps);
  const stop = (ids) => stopAgents({ agent_ids: ids }, deps).then(text);
  return { repo, created, open, deps, start, wait, msg, stop, text };
}
const branches = (repo) => sh(repo, 'git branch --list "claude-cloud/*"');
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
  assert.match(first, /No changes were made/);
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

test('a failed create marks only that agent failed, with the provider limit named', async () => {
  let n = 0;
  const { start, wait, msg } = await setup({
    createSandbox: async () => {
      if (n++ === 0) throw Object.assign(new Error('machine limit'), { code: 'quota_exceeded' });
      return fakeSandbox();
    },
  });
  const [bad, good] = [await start(), await start()];
  const r = await wait([bad, good]);
  assert.match(r, new RegExp(`## ${bad}[^#]*status: failed[^#]*machine limit reached \\(quota_exceeded\\)`));
  assert.match(r, new RegExp(`## ${good}[^#]*status: idle[^#]*hello`));
  assert.equal((await msg(bad, 'x')).isError, true);
});

test('rate_limited create is reported as the start rate', async () => {
  const { start, wait } = await setup({ createSandbox: async () => { throw Object.assign(new Error('slow down'), { code: 'rate_limited' }); } });
  assert.match(await wait([await start()]), /start rate limit reached \(rate_limited\)/);
});

test('follow-up resumes the same session; its commit moves the same branch forward', async () => {
  const { repo, start, wait, msg, created, text } = await setup();
  const id = await start({ prompt: 'EDIT', model: 'haiku' });
  await wait([id]);
  const tip1 = await sh(repo, `git rev-parse claude-cloud/${id}`);
  const r = await msg(id, 'EDIT2 please');
  assert.match(text(r), /status: running/);
  const out = await wait([id]);
  assert.match(out, new RegExp(`resumed ${SID} edited2`));
  assert.match(out, new RegExp(`local branch claude-cloud/${id}\\.`));
  assert.equal(await sh(repo, `git merge-base --is-ancestor ${tip1} claude-cloud/${id} && echo yes`), 'yes');
  assert.equal(await sh(repo, `git show claude-cloud/${id}:b.txt`), 'more');
  const cmd = created[0].cmds.filter((c) => c.includes('claude -p')).pop();
  assert.match(cmd, new RegExp(`--resume ${SID} --dangerously-skip-permissions --output-format json`));
  assert.match(cmd, /--model haiku/);
  assert.equal(created[0].writes.filter((p) => p.endsWith('in.bundle')).length, 1);
  assert.equal(await sh(repo, 'git for-each-ref refs/cc-keep | wc -l'), '1');
});

test('first-turn command is json output with the commit instruction; identity is set', async () => {
  const { start, wait, created } = await setup();
  await wait([await start()]);
  const cmd = created[0].cmds.find((c) => c.includes('claude -p'));
  assert.match(cmd, /--output-format json/);
  assert.ok(cmd.includes("--append-system-prompt 'Commit your work with git after each meaningful step, at least every few minutes, with a short message. Your sandbox can disappear at any time and only committed work is recovered.'"));
  assert.ok(created[0].cmds.some((c) => c.includes('git config user.name claude-cloud') && c.includes('user.email claude-cloud@localhost')));
});

test('follow-up with no change leaves the branch where it is', async () => {
  const { repo, start, wait, msg } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  const tip = await sh(repo, `git rev-parse claude-cloud/${id}`);
  await msg(id, 'hi again');
  assert.match(await wait([id]), /No changes were made/);
  assert.equal(await sh(repo, `git rev-parse claude-cloud/${id}`), tip);
});

test('a locally changed branch is not overwritten; update goes to -1', async () => {
  const { repo, start, wait, msg } = await setup();
  const id = await start({ prompt: 'EDIT' });
  await wait([id]);
  await sh(repo, `git checkout -q -b tmp claude-cloud/${id} && echo local > l.txt && git add -A && git commit -qm local && git branch -f claude-cloud/${id} tmp && git checkout -q main`);
  const local = await sh(repo, `git rev-parse claude-cloud/${id}`);
  await msg(id, 'EDIT2');
  const out = await wait([id]);
  assert.equal(await sh(repo, `git rev-parse claude-cloud/${id}`), local);
  assert.match(out, new RegExp(`local branch claude-cloud/${id}-1`));
  assert.match(out, /not a fast-forward/);
  assert.equal(await sh(repo, `git show claude-cloud/${id}-1:b.txt`), 'more');
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

test('unparseable JSON returns the raw stdout and says so', async () => {
  const { start, wait } = await setup();
  const id = await start({ prompt: 'RAW' });
  const r = await wait([id]);
  assert.match(r, /not json/);
  assert.match(r, /Could not parse/);
});

test('a failed turn reports error, scrubs secrets, recovers commits; agent with no session is failed', async () => {
  const { repo, start, wait, created } = await setup();
  const id = await start({ prompt: 'FAIL' });
  const r = await wait([id]);
  assert.match(r, /status: failed/);
  assert.match(r, /exit code 3/);
  assert.match(r, /boom \[redacted\]/);
  assert.ok(!r.includes(SECRET));
  assert.ok(created[0].killed);
  assert.equal(await sh(repo, `git show claude-cloud/${id}:a.txt`), 'changed');
});

test('a failed follow-up keeps the agent open (idle) and recovers changes', async () => {
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
  assert.match(r, new RegExp(`claude-cloud/${id}-wip`));
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

test('edit lands on a local branch; HEAD, index and worktree untouched', async () => {
  const { repo, start, wait } = await setup();
  const head = await sh(repo, 'git rev-parse HEAD');
  const id = await start({ prompt: 'EDIT' });
  assert.match(await wait([id]), new RegExp(`claude-cloud/${id}`));
  assert.equal(await sh(repo, `git show claude-cloud/${id}:a.txt`), 'changed');
  assert.equal(await sh(repo, 'git rev-parse HEAD'), head);
  assert.equal(await sh(repo, 'git status --porcelain'), '');
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'orig\n');
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

test('failed change recovery is reported, not described as no changes', async () => {
  const { start, wait } = await setup({
    createSandbox: async () => { const s = await fakeSandbox(); s.files.read = async () => { throw new Error('download failed'); }; return s; },
  });
  const r = await wait([await start({ prompt: 'EDIT' })]);
  assert.doesNotMatch(r, /No changes were made/);
  assert.match(r, /could not be recovered/);
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

test('checkpoint captures uncommitted and untracked files to -wip without touching HEAD or index; clean turn removes -wip', async () => {
  const { repo, start, wait, created } = await setup({ checkpointMs: 100 });
  const id = await start({ prompt: 'SLOWWIP' });
  const wip = `claude-cloud/${id}-wip`;
  let tries = 0;
  while (!(await sh(repo, `git cat-file -e ${wip}:u.txt && echo y`).catch(() => '')) && tries++ < 60) await tick(30);
  assert.ok(await sh(repo, `git branch --list ${wip}`), 'wip branch appeared during the turn');
  assert.equal(await sh(repo, `git show ${wip}:u.txt`), 'wipdata');
  assert.match(await sh(repo, `git show ${wip}:a.txt`), /dirty/);
  const sbxRepo = join(created[0].dir, 'home', 'repo');
  assert.equal(await sh(sbxRepo, 'git rev-parse HEAD'), await sh(repo, `git rev-parse refs/cc-keep/${id}`));
  assert.equal(await sh(sbxRepo, 'git diff --cached --name-only'), '', 'agent index untouched');
  assert.match(await sh(sbxRepo, 'git status --porcelain'), /\?\? u\.txt/);
  const r = await wait([id]);
  // u.txt was left untracked: it is not committed to the branch, is named in the result, and -wip keeps a copy.
  assert.match(await sh(repo, `git show claude-cloud/${id}:a.txt`), /dirty/);
  assert.equal(await sh(repo, `git cat-file -e claude-cloud/${id}:u.txt 2>/dev/null && echo y || echo n`), 'n');
  assert.match(r, /not committed.*u\.txt/);
  assert.equal(await sh(repo, `git show ${wip}:u.txt`), 'wipdata', 'wip kept while untracked files remain');
});

test('-wip branch is removed after a clean turn with nothing left uncommitted', async () => {
  const { repo, start, wait } = await setup({ checkpointMs: 100 });
  const id = await start({ prompt: 'SLOWCLEAN' });
  await wait([id]);
  assert.equal(await sh(repo, `git branch --list claude-cloud/${id}-wip`), '');
  assert.match(await sh(repo, `git show claude-cloud/${id}:a.txt`), /dirty/);
});

test('-wip branch is kept after a failed turn', async () => {
  const { repo, start, wait } = await setup({ checkpointMs: 100 });
  const id = await start({ prompt: 'FAILWIP' });
  await wait([id]);
  assert.equal(await sh(repo, `git show claude-cloud/${id}-wip:u.txt`), 'wipdata');
});

test('a checkpoint failure does not fail the turn', async () => {
  const { start, wait } = await setup({
    checkpointMs: 100,
    createSandbox: async () => {
      const s = await fakeSandbox();
      const run = s.commands.run;
      s.commands.run = (cmd, o) => (cmd.includes('cc-wip-index') ? Promise.reject(new Error('exec cap')) : run(cmd, o));
      return s;
    },
  });
  const r = await wait([await start({ prompt: 'SLOWWIP' })]);
  assert.match(r, /status: idle/);
  assert.match(r, /slow done/);
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

test('agents finishing at the same moment each get their own commits', async () => {
  const { repo, start, wait } = await setup();
  const names = ['n1', 'n2', 'n3', 'n4'];
  const ids = await Promise.all(names.map((n) => start({ prompt: `OWN-${n}` })));
  const r = await wait(ids, 120);
  for (const [i, id] of ids.entries()) {
    const files = (await sh(repo, `git diff --name-only main claude-cloud/${id} 2>&1 || true`)).split('\n');
    assert.deepEqual(files, [`own-${names[i]}.txt`], `agent ${id} branch has ${files}\n${r}`);
  }
});

test('final sweep commits tracked edits only and names leftover untracked files', async () => {
  const { repo, start, wait } = await setup();
  const id = await start({ prompt: 'JUNK' });
  const r = await wait([id]);
  const files = (await sh(repo, `git diff --name-only main claude-cloud/${id}`)).split('\n');
  assert.deepEqual(files, ['a.txt']);
  assert.match(r, /not committed.*__pycache__\/.*notes\.txt|not committed.*notes\.txt.*__pycache__\//s);
});
