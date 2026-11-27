import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRemoteArgv, main as execMain, parseExecArgs } from '../src/exec.mjs';
import { classifyCreateFailure } from '../src/create-routing.mjs';

const run = promisify(execFile);

async function localRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-exec-repo-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.name', 'exec test'], { cwd: dir });
  await run('git', ['config', 'user.email', 'exec@test.invalid'], { cwd: dir });
  await (await import('node:fs/promises')).writeFile(join(dir, 'tracked.txt'), 'initial\n');
  await run('git', ['add', 'tracked.txt'], { cwd: dir });
  await run('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function provider({ transportLoss = false, createError, name = 'fake', duplicateMatches = false } = {}) {
  const home = join(tmpdir(), `cc-exec-machine-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const state = { createAttempts: 0, created: 0, deleted: 0, commands: 0, calls: [], labels: undefined, sandbox: undefined, writes: [], secretWrites: [] };
  const adapter = {
    name,
    caps: { machineKinds: ['linux'], uploadMaxBytes: 10_000_000, maxTtlSeconds: 86_400, hasEgressPolicy: true },
    async create(options) {
      state.createAttempts++;
      if (createError && !createError.afterAllocation) throw Object.assign(new Error(createError.message ?? 'create refused'), createError);
      state.created++;
      state.labels = options.labels;
      await mkdir(home, { recursive: true });
      const put = (list) => async (path, bytes) => { list.push(path); await mkdir(join(path, '..'), { recursive: true }).catch(() => {}); const { writeFile } = await import('node:fs/promises'); await writeFile(path, bytes); };
      const sandbox = {
        id: 'same-id', home,
        files: { write: put(state.writes), writeSecret: put(state.secretWrites) },
        commands: { async run(cmd, opts = {}) {
          state.commands++;
          state.calls.push({ cmd, opts });
          try {
            const result = await run('sh', ['-c', cmd], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
            opts.onStdout?.(result.stdout);
            opts.onStderr?.(result.stderr);
            if (transportLoss && state.commands === 2) throw Object.assign(new Error('connection dropped after command ran'), { code: 'transient', stdout: result.stdout, stderr: result.stderr });
            return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
          } catch (error) {
            if (error?.code === 'transient') throw error;
            const exitCode = Number.isInteger(error.code) ? error.code : 1;
            opts.onStdout?.(error.stdout ?? '');
            opts.onStderr?.(error.stderr ?? '');
            throw Object.assign(error, { exitCode, stdout: error.stdout ?? '', stderr: error.stderr ?? '' });
          }
        } },
      };
      state.sandbox = sandbox;
      if (createError) throw Object.assign(new Error(createError.message ?? 'create response lost'), createError);
      return sandbox;
    },
    async delete() { state.deleted++; await rm(home, { recursive: true, force: true }); },
    async list(labels) {
      if (!state.labels || !Object.entries(labels).every(([k, v]) => state.labels[k] === v)) return [];
      const row = { id: 'same-id', labels: state.labels };
      return duplicateMatches ? [row, { id: 'other-id', labels: state.labels }] : [row];
    },
    async connect() { return state.sandbox; },
  };
  return { adapter, state, home };
}

async function invoke(repo, instance, argv, extras = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cc-exec-home-'));
  const env = { HOME: home, CLOUDY_CLOUD_CONFIG: join(home, 'missing-env') };
  try {
    return await executeRemoteArgv(argv, { repo, providers: [instance.adapter], env, ...extras });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('exec parses the command boundary and validates timeout', () => {
  assert.deepEqual(parseExecArgs(['--repo', '.', '--timeout', '9', '--', 'printf', '%s', 'a b']), {
    repo: '.', timeout: 9, json: false, argv: ['printf', '%s', 'a b'],
  });
  assert.throws(() => parseExecArgs(['--repo', '.', '--timeout', '0', '--', 'true']), /--timeout/);
});

test('shared create routing preserves message-based provider refusal classification', () => {
  assert.equal(classifyCreateFailure(new Error('provider says rate_limited')), 'next');
  assert.equal(classifyCreateFailure(new Error('quota_exceeded')), 'next');
  assert.equal(classifyCreateFailure(new Error('unexpected transport failure')), undefined);
});

test('create routing honors an explicit transient code before message text', () => {
  const transient = (message) => Object.assign(new Error(message), { code: 'transient' });
  assert.equal(classifyCreateFailure(transient('the create request was dropped; response mentioned quota_exceeded')), 'reconcile');
  assert.equal(classifyCreateFailure(Object.assign(new Error('retry timed out during rate_limited backoff'), { code: 'create_unknown' })), 'reconcile');
  assert.equal(classifyCreateFailure(Object.assign(new Error('rate_limited'), { code: 'rate_limited' })), 'next');
});

test('exec preserves literal argv, streams both streams, and deletes a verified clean machine', async () => {
  const repo = await localRepo(), instance = provider();
  const streamed = { out: '', err: '' };
  try {
    const result = await invoke(repo, instance, [
      'node', '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("early-stderr")',
      'a; touch PWNED', '$(touch PWNED)',
    ], { stdout: (chunk) => { streamed.out += chunk; }, stderr: (chunk) => { streamed.err += chunk; } });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.exit_code, 0);
    assert.equal(result.preserve_machine, false);
    assert.equal(instance.state.deleted, 1);
    assert.equal(streamed.out, '["a; touch PWNED","$(touch PWNED)"]');
    assert.equal(streamed.err, 'early-stderr');
    assert.equal(result.stderr_streamed, true);
    await assert.rejects(readFile(join(instance.home, 'repo', 'PWNED')));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('exec returns the exact nonzero code and cleans an unchanged workspace', async () => {
  const repo = await localRepo(), instance = provider();
  try {
    const result = await invoke(repo, instance, ['node', '-e', 'process.exit(37)']);
    assert.equal(result.status, 'failed');
    assert.equal(result.exit_code, 37);
    assert.equal(result.workspace_dirty, false, JSON.stringify(result));
    assert.equal(result.workspace_changed, false);
    assert.equal(result.preserve_machine, false);
    assert.equal(instance.state.deleted, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('exec bounds captured output while continuing to stream the full stdout', async () => {
  const repo = await localRepo(), instance = provider();
  let streamed = 0;
  try {
    const result = await invoke(repo, instance, ['node', '-e', 'process.stdout.write("x".repeat(140000))'], {
      stdout: (chunk) => { streamed += Buffer.byteLength(chunk); },
    });
    assert.equal(result.output_truncated, true);
    assert.equal(streamed, 140000);
    assert.ok(Buffer.byteLength(result.stdout) <= 131_072 + 100);
    assert.match(result.stdout, /output truncated/);
    assert.equal(instance.state.deleted, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('exec keeps dirty work and a clean new commit for inspection', async () => {
  const repo = await localRepo(), dirty = provider(), committed = provider();
  try {
    const dirtyResult = await invoke(repo, dirty, ['node', '-e', "require('fs').writeFileSync('new.txt','work')"]);
    assert.equal(dirtyResult.status, 'completed');
    assert.equal(dirtyResult.error, false);
    assert.equal(dirtyResult.workspace_dirty, true, JSON.stringify(dirtyResult));
    assert.equal(dirtyResult.preserve_machine, true);
    assert.equal(dirty.state.deleted, 0);
    assert.equal(dirtyResult.owner.selector, 'fake:same-id');
    assert.match(dirtyResult.action, /cloudy-cloud shell 'fake:same-id'/);
    assert.equal(dirtyResult.cleanup_command, "cloudy-cloud machines stop 'fake:same-id'");

    const commitResult = await invoke(repo, committed, [
      'sh', '-c', 'echo committed > new.txt && git add new.txt && git -c user.name=exec -c user.email=exec@test.invalid commit -qm saved',
    ]);
    assert.equal(commitResult.workspace_dirty, false);
    assert.equal(commitResult.workspace_changed, true);
    assert.equal(commitResult.preserve_machine, true);
    assert.equal(committed.state.deleted, 0);
  } finally { await Promise.all([rm(repo, { recursive: true, force: true }), rm(dirty.home, { recursive: true, force: true }), rm(committed.home, { recursive: true, force: true })]); }
});

test('exec keeps the machine when the command adds a linked worktree with a commit', async () => {
  const repo = await localRepo(), instance = provider();
  try {
    const result = await invoke(repo, instance, [
      'sh', '-c', 'git worktree add ../linked --detach && cd ../linked && git -c user.name=x -c user.email=x@x commit -qm linked-work --allow-empty',
    ]);
    assert.equal(result.preserve_machine, true, JSON.stringify(result));
    assert.equal(instance.state.deleted, 0);
  } finally { await Promise.all([rm(repo, { recursive: true, force: true }), rm(instance.home, { recursive: true, force: true })]); }
});

test('exec never puts argv or the snapshot bundle in a provider command string', async () => {
  const repo = await localRepo(), instance = provider();
  try {
    const result = await invoke(repo, instance, ['node', '-e', 'process.stdout.write("ok")', 'sk-literal-credential-9']);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    for (const { cmd } of instance.state.calls) assert.ok(!cmd.includes('sk-literal-credential-9'), `argv leaked into a command string: ${cmd}`);
    assert.ok(instance.state.secretWrites.some((p) => p.endsWith('/in.bundle')), 'the snapshot bundle must use the upload-only write route');
    assert.ok(instance.state.secretWrites.some((p) => p.includes('exec-argv')), 'the argv file must use the upload-only write route');
    assert.ok(!instance.state.writes.some((p) => p.endsWith('/in.bundle') || p.includes('exec-argv')), 'secret material must not use the plain write route when writeSecret exists');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('CLI returns zero and prints the locator when a successful command leaves dirty work', async () => {
  const repo = await localRepo(), instance = provider();
  const output = { out: '', err: '' };
  try {
    const code = await execMain(['--repo', repo, '--', 'node', '-e', "require('fs').writeFileSync('new.txt','work')"], {
      providers: [instance.adapter],
      env: { HOME: tmpdir(), CLOUDY_CLOUD_CONFIG: join(tmpdir(), 'missing-exec-env') },
      writeOut: (text) => { output.out += text; },
      writeErr: (text) => { output.err += text; },
    });
    assert.equal(code, 0);
    assert.match(output.err, /cloudy-cloud shell 'fake:same-id'/);
    assert.equal(instance.state.deleted, 0);
  } finally { await Promise.all([rm(repo, { recursive: true, force: true }), rm(instance.home, { recursive: true, force: true })]); }
});

test('exec retains the machine when a command transport drops after the command ran', async () => {
  const repo = await localRepo(), instance = provider({ transportLoss: true });
  try {
    const result = await invoke(repo, instance, ['node', '-e', 'process.stdout.write("ran")']);
    assert.equal(result.error, true);
    assert.equal(result.exit_code, null);
    assert.equal(result.preserve_machine, true);
    assert.equal(instance.state.deleted, 0);
    assert.match(result.action, /fake:same-id/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('exec advances after a definite create refusal and runs on the next eligible provider', async () => {
  const repo = await localRepo();
  const refused = provider({ name: 'first', createError: { code: 'no_key', message: 'missing provider key' } });
  const ready = provider({ name: 'second' });
  try {
    const result = await executeRemoteArgv(['node', '-e', 'process.stdout.write("ok")'], {
      repo, providers: [refused.adapter, ready.adapter], env: { HOME: tmpdir(), CLOUDY_CLOUD_CONFIG: join(tmpdir(), 'missing-exec-env') },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.provider, 'second');
    assert.equal(refused.state.createAttempts, 1);
    assert.equal(ready.state.createAttempts, 1);
    assert.equal(ready.state.deleted, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('exec refuses duplicate matches after an uncertain create and returns provider-qualified locators', async () => {
  const repo = await localRepo();
  const uncertain = provider({ name: 'first', createError: { code: 'transient', afterAllocation: true }, duplicateMatches: true });
  const next = provider({ name: 'second' });
  try {
    const result = await executeRemoteArgv(['true'], {
      repo, providers: [uncertain.adapter, next.adapter], env: { HOME: tmpdir(), CLOUDY_CLOUD_CONFIG: join(tmpdir(), 'missing-exec-env') },
    });
    assert.equal(result.error, true);
    assert.equal(result.preserve_machine, true);
    assert.equal(uncertain.state.createAttempts, 1);
    assert.equal(next.state.createAttempts, 0);
    assert.deepEqual(result.owners.map((owner) => owner.selector), ['first:same-id', 'first:other-id']);
    assert.match(result.action, /cloudy-cloud machines ls/);
  } finally { await Promise.all([rm(repo, { recursive: true, force: true }), rm(uncertain.home, { recursive: true, force: true })]); }
});
