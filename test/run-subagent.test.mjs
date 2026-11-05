import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagent } from '../src/run-subagent.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
const SECRET = 'sk-test-secret-123';

// Fake `claude`: behaviour chosen by the first word of the prompt on stdin.
const FAKE_CLAUDE = `#!/bin/sh
p=$(cat)
case "$p" in
  EDIT*) echo changed > a.txt; echo "edited" ;;
  SHOW*) echo "a=$(cat a.txt) untracked=$(ls untracked.txt 2>&1)" ;;
  FAIL*) echo changed > a.txt; git add -A; git -c user.name=x -c user.email=x@x commit -qm fail; echo "boom $ANTHROPIC_API_KEY" >&2; exit 3 ;;
  *) echo "hello" ;;
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
    killed: false,
    files: {
      write: (p, d) => writeFile(map(p), d),
      read: (p) => readFile(map(p)),
    },
    commands: {
      async run(cmd, { cwd, timeoutMs } = {}) {
        assert.ok(timeoutMs > 0, 'timeoutMs must be set');
        try {
          const r = await exec('sh', ['-c', map(cmd)], {
            cwd: map(cwd),
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: sbx.envs.ANTHROPIC_API_KEY ?? '' },
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

async function setup() {
  const repo = await mkdtemp(join(tmpdir(), 'cc-repo-'));
  await sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t');
  await writeFile(join(repo, 'a.txt'), 'orig\n');
  await sh(repo, 'git add -A && git commit -qm init');
  const created = [];
  const createSandbox = async (envs) => { const s = await fakeSandbox(); s.envs = envs; created.push(s); return s; };
  const call = (args) => runSubagent({ description: 'd', ...args }, {
    createSandbox, cwd: repo, env: { ANTHROPIC_API_KEY: SECRET, E2B_API_KEY: 'e2b-secret' },
  });
  return { repo, created, call };
}
const branches = (repo) => sh(repo, 'git branch --list "claude-cloud/*"');

test('edit lands on a local branch; HEAD, index and worktree untouched', async () => {
  const { repo, call } = await setup();
  const head = await sh(repo, 'git rev-parse HEAD');
  const r = await call({ prompt: 'EDIT' });
  assert.ok(!r.isError, r.content[0].text);
  const name = (await branches(repo)).trim();
  assert.match(name, /^claude-cloud\/[0-9a-f]{8}$/);
  assert.match(r.content[0].text, new RegExp(name));
  assert.equal(await sh(repo, `git show ${name}:a.txt`), 'changed');
  assert.equal(await sh(repo, 'git rev-parse HEAD'), head);
  assert.equal(await sh(repo, 'git status --porcelain'), '');
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'orig\n');
  assert.equal(await sh(repo, 'git for-each-ref refs/claude-cloud'), '', 'temp ref deleted');
});

test('no changes: no branch, text returned, sandbox killed', async () => {
  const { repo, call, created } = await setup();
  const r = await call({ prompt: 'hi' });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /hello/);
  assert.match(r.content[0].text, /No changes/);
  assert.equal(await branches(repo), '');
  assert.ok(created[0].killed);
  assert.deepEqual(created[0].envs, { ANTHROPIC_API_KEY: SECRET });
});

test('uncommitted tracked edits are sent; untracked files are not', async () => {
  const { repo, call } = await setup();
  await writeFile(join(repo, 'a.txt'), 'dirty\n');
  await writeFile(join(repo, 'untracked.txt'), 'x');
  await sh(repo, 'git add a.txt');
  await writeFile(join(repo, 'a.txt'), 'dirtier\n');
  const r = await call({ prompt: 'SHOW' });
  assert.match(r.content[0].text, /a=dirtier/);
  assert.match(r.content[0].text, /untracked=.*No such file/);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'dirtier\n');
  assert.equal(await sh(repo, 'git diff --cached --name-only'), 'a.txt', 'index unchanged');
});

test('non-zero exit: error, sandbox killed, commits recovered, secret scrubbed', async () => {
  const { repo, call, created } = await setup();
  const r = await call({ prompt: 'FAIL' });
  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.match(text, /exit code 3/);
  assert.match(text, /boom \[redacted\]/);
  assert.ok(!text.includes(SECRET));
  assert.ok(created[0].killed);
  const name = (await branches(repo)).trim();
  assert.equal(await sh(repo, `git show ${name}:a.txt`), 'changed');
});

test('invalid model or subagent_type is rejected before any sandbox', async () => {
  const { call, created } = await setup();
  for (const bad of [{ model: 'x; rm -rf /' }, { subagent_type: '$(id)' }]) {
    const r = await call({ prompt: 'hi', ...bad });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /invalid/);
  }
  assert.equal(created.length, 0);
});

test('non-git directory returns a clear error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-nogit-'));
  let made = 0;
  const r = await runSubagent({ prompt: 'hi', description: 'd' }, {
    createSandbox: async () => { made++; }, cwd: dir, env: {},
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /git init/);
  assert.equal(made, 0);
});

test('failed change recovery is reported, not described as no changes', async () => {
  const { repo } = await setup();
  const createSandbox = async (envs) => {
    const s = await fakeSandbox();
    s.envs = envs;
    s.files.read = async () => { throw new Error('download failed'); };
    return s;
  };
  const r = await runSubagent({ description: 'd', prompt: 'EDIT' }, { createSandbox, cwd: repo, env: {} });
  const text = r.content[0].text;
  assert.doesNotMatch(text, /No changes were made/);
  assert.match(text, /could not be recovered/);
  assert.equal(r.isError, true);
});

test('sandbox gets only the OAuth token when both Claude credentials exist', async () => {
  const { repo } = await setup();
  let seen;
  const createSandbox = async (envs) => { seen = envs; const s = await fakeSandbox(); s.envs = envs; return s; };
  await runSubagent({ description: 'd', prompt: 'hi' }, {
    createSandbox, cwd: repo, env: { ANTHROPIC_API_KEY: 'api', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
  });
  assert.deepEqual(seen, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
});
