import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sessionPaths } from '../src/session-transport.mjs';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const TEST_PATH = process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const git = (args, options = {}) => exec('/bin/sh', ['-c', 'git "$@"', 'git', ...args], { ...options, env: { ...process.env, PATH: TEST_PATH, ...options.env } });

async function fixture(t, { currentConfig = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cc-run-cli-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'cc-run-cli-repo-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'cc-run-cli-remote-'));
  const remote = join(remoteRoot, 'test', 'run-cli.git');
  await mkdir(remote, { recursive: true });
  if (currentConfig) await mkdir(join(home, '.config', 'cloudy-cloud'), { recursive: true });
  await git(['init', '--bare', '-q'], { cwd: remote });
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'test'], { cwd: repo });
  await git(['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await exec('/bin/sh', ['-c', 'echo initial > tracked.txt && git add -A && git commit -qm init'], { cwd: repo, env: { ...process.env, PATH: TEST_PATH } });
  await git(['remote', 'add', 'origin', 'https://github.com/test/run-cli.git'], { cwd: repo });
  await git(['push', '-q', '-u', 'origin', 'main'], { cwd: repo, env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remoteRoot}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' } });
  const session = `run-test-${randomBytes(5).toString('hex')}`;
  const env = {
    ...process.env, PATH: TEST_PATH, HOME: home, CLOUDY_CLOUD_SESSION_HOME: home, CLOUDY_CLOUD_TEST_GITHUB: remoteRoot,
    CLOUDY_CLOUD_PROVIDERS: 'instabox', ANTHROPIC_API_KEY: 'sk-ant-interface-test', CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${join(root, 'support', 'test-provider-hook.mjs')}`.trim(),
  };
  t.after(async () => {
    await exec('rm', ['-rf', home, repo, remoteRoot]).catch(() => {});
  });
  return { home, repo, remote, session, env };
}

async function stopOwner(name, repo, home) {
  try {
    const { pid } = JSON.parse(await readFile(sessionPaths({ name, repo, home }).metadata, 'utf8'));
    if (Number.isInteger(pid)) process.kill(pid, 'SIGTERM');
  } catch { /* owner already exited or test setup did not create one */ }
}

function rpcProcess(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`timed out on ${method}: ${stderr}`)); }, 10_000);
    pending.set(n, (message) => { clearTimeout(timer); resolveRequest(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return { child, request };
}

test('CLI returns a recoverable worker after failure and a separate MCP stdio connection can stop it', async (t) => {
  const f = await fixture(t);
  const cleanSession = `${f.session}-clean`;
  t.after(async () => { await stopOwner(cleanSession, f.repo, f.home); await stopOwner(f.session, f.repo, f.home); });
  const cli = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', f.session, '--timeout', '5', '--json', '--', 'FAIL keep this worker'], { env: f.env, timeout: 20_000 }).catch((error) => error);
  assert.equal(cli.code, 1, `expected failed work to return nonzero; stdout=${cli.stdout} stderr=${cli.stderr}`);
  const result = JSON.parse(cli.stdout.trim());
  assert.equal(result.status, 'failed');
  assert.equal(result.recoverable, true);
  assert.equal(result.session, f.session);
  assert.equal(result.repo, f.repo);
  const runId = /Run ID: ([0-9a-f-]{36})/.exec(cli.stderr)?.[1];
  assert.ok(runId, 'the CLI must expose the durable run handle on stderr');
  assert.equal(result.run_id, runId);
  assert.match(result.action, /cloudy-cloud mcp-server --session/);

  const mcp = rpcProcess(process.execPath, [resolve(root, 'src/server.mjs'), '--session', f.session, '--repo', f.repo], f.repo, f.env);
  t.after(() => mcp.child.kill());
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-cli-test', version: '1' } });
  const stopped = await mcp.request('tools/call', { name: 'cloud_agent_stop', arguments: { agent_ids: [result.agent_id] } });
  assert.ok(['stopped', 'not-open'].includes(stopped.result.structuredContent.agents[0].status));

  const clean = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', cleanSession, '--timeout', '30', '--json', '--', 'OK complete the task'], { env: f.env, timeout: 40_000 }).catch((error) => error);
  assert.equal(clean.code ?? 0, 0, `expected successful run and confirmed cleanup; stdout=${clean.stdout} stderr=${clean.stderr}`);
  const cleanResult = JSON.parse(clean.stdout.trim());
  assert.equal(cleanResult.status, 'completed');
  assert.equal(cleanResult.error, false);
});

test('run --explain reports local eligibility without creating a worker', async (t) => {
  const f = await fixture(t);
  t.after(() => stopOwner(f.session, f.repo, f.home));
  const cli = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', f.session, '--json', '--explain', '--', 'check eligibility'], { env: f.env, timeout: 15_000 }).catch((error) => error);
  assert.equal(cli.code ?? 0, 0, `explanation should succeed; stdout=${cli.stdout} stderr=${cli.stderr}`);
  const result = JSON.parse(cli.stdout.trim());
  assert.equal(result.status, 'conditional');
  assert.ok(result.eligible_providers.length > 0, JSON.stringify(result));
  assert.ok(result.unknown_checks.length > 0);
  assert.equal(result.agent_id, undefined);
  assert.equal(result.error, undefined);
  await assert.rejects(access(sessionPaths({ name: f.session, repo: f.repo, home: f.home }).metadata), 'explain must not create a persistent named owner manifest');
});

test('run migrates legacy config before creating the named owner and keeps its notice off JSON stdout', async (t) => {
  const f = await fixture(t, { currentConfig: false });
  const legacy = join(f.home, '.config', 'claude-cloud');
  await mkdir(legacy, { recursive: true });
  const original = 'CLAUDE_CLOUD_MIGRATION_SENTINEL=keep-me\n';
  await writeFile(join(legacy, 'env'), original, { mode: 0o600 });
  await writeFile(join(legacy, 'legacy-marker'), 'preserve this directory\n');
  t.after(() => stopOwner(f.session, f.repo, f.home));

  const result = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', f.session, '--timeout', '5', '--json', '--', 'FAIL keep this worker'], { env: f.env, timeout: 20_000 }).catch((error) => error);
  assert.equal(result.code, 1, `expected failed worker result; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.doesNotThrow(() => JSON.parse(result.stdout.trim()), 'stdout must contain only the JSON result');
  assert.match(result.stderr, /Moved your saved keys from ~\/\.config\/claude-cloud/);
  assert.equal(await readFile(join(f.home, '.config', 'cloudy-cloud', 'env'), 'utf8'), 'CLOUDY_CLOUD_MIGRATION_SENTINEL=keep-me\n');
  assert.equal(await readFile(join(legacy, 'env'), 'utf8'), original);
  assert.equal(await readFile(join(legacy, 'legacy-marker'), 'utf8'), 'preserve this directory\n');
  await access(sessionPaths({ name: f.session, repo: f.repo, home: f.home }).metadata);
});

test('run help documents required repo and does not migrate legacy config', async (t) => {
  const f = await fixture(t, { currentConfig: false });
  const legacy = join(f.home, '.config', 'claude-cloud');
  await mkdir(legacy, { recursive: true });
  const original = 'CLAUDE_CLOUD_LEGACY=value\n';
  await writeFile(join(legacy, 'env'), original, { mode: 0o600 });

  const result = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--help'], { env: f.env });
  assert.match(result.stdout, /Required repository with a github\.com origin/);
  assert.equal(result.stderr, '');
  const topLevel = await exec(resolve(root, 'bin/cloudy-cloud'), ['--help'], { env: f.env });
  assert.match(topLevel.stdout, /run --repo PATH/);
  assert.doesNotMatch(topLevel.stdout, /run \[--repo PATH\]/);
  await assert.rejects(access(join(f.home, '.config', 'cloudy-cloud')));
  assert.equal(await readFile(join(legacy, 'env'), 'utf8'), original);
});

test('CLI keeps workers with dirty or unverified work and returns an actionable failure', async (t) => {
  const f = await fixture(t);
  const cases = [
    { prompt: 'DIRTY leave edits', expectedText: /No new commits[\s\S]*Uncommitted changes left in the sandbox/, expectedPush: 'no-change', workspaceDirty: true },
    { prompt: 'PUSH_DIRTY push then leave edits', expectedText: /Pushed to origin[\s\S]*Uncommitted changes left in the sandbox/, expectedPush: 'pushed', workspaceDirty: true },
    { prompt: 'OK status cannot be read', env: { CLOUDY_CLOUD_TEST_STATUS_FAILURE: '1' }, expectedText: /status could not be confirmed/i, expectedPush: 'no-change', workspaceDirty: null },
  ];

  for (const [index, scenario] of cases.entries()) {
    const session = `${f.session}-preserve-${index}`;
    t.after(() => stopOwner(session, f.repo, f.home));
    const cli = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', session, '--timeout', '30', '--json', '--', scenario.prompt], {
      env: { ...f.env, ...scenario.env }, timeout: 40_000,
    }).catch((error) => error);
    assert.equal(cli.code, 1, `expected unsafe auto-stop to return nonzero; stdout=${cli.stdout} stderr=${cli.stderr}`);
    const result = JSON.parse(cli.stdout.trim());
    assert.equal(result.status, 'failed');
    assert.equal(result.error, true);
    assert.equal(result.preserve_worker, true);
    assert.equal(result.push_status, scenario.expectedPush);
    assert.equal(result.workspace_dirty, scenario.workspaceDirty);
    assert.equal(result.session, session);
    assert.equal(result.repo, f.repo);
    assert.match(result.result, scenario.expectedText);
    assert.match(result.action, new RegExp(`mcp-server --session ${session}`));

    const mcp = rpcProcess(process.execPath, [resolve(root, 'src/server.mjs'), '--session', session, '--repo', f.repo], f.repo, f.env);
    t.after(() => mcp.child.kill());
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-cli-preservation-test', version: '1' } });
    const listed = await mcp.request('tools/call', { name: 'cloud_agent_list', arguments: {} });
    assert.ok(listed.result.structuredContent.agents.some((agent) => agent.agent_id === result.agent_id && agent.status === 'idle'));
    const stopped = await mcp.request('tools/call', { name: 'cloud_agent_stop', arguments: { agent_ids: [result.agent_id] } });
    assert.equal(stopped.result.structuredContent.agents[0].status, 'stopped');
  }
});

test('CLI retries cleanup while the named owner is connected and reports reconnect coordinates on failure', async (t) => {
  const f = await fixture(t);
  const session = `${f.session}-delete-retry`;
  t.after(() => stopOwner(session, f.repo, f.home));
  const cli = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', session, '--timeout', '30', '--json', '--', 'OK finish cleanly'], {
    env: { ...f.env, CLOUDY_CLOUD_TEST_DELETE_FAILURES: '3' }, timeout: 40_000,
  }).catch((error) => error);
  assert.equal(cli.code, 1, `expected unconfirmed cleanup to return nonzero; stdout=${cli.stdout} stderr=${cli.stderr}`);
  const result = JSON.parse(cli.stdout.trim());
  assert.equal(result.cleanup_error, true);
  assert.equal(result.preserve_worker, true);
  assert.equal(result.session, session);
  assert.equal(result.repo, f.repo);
  assert.match(result.message, /not confirmed after three attempts/);
  assert.match(result.action, new RegExp(`cloudy-cloud mcp-server --session ${session} --repo`));
  assert.match(result.action, new RegExp(`cloud_agent_stop for ${result.agent_id}`));

  const mcp = rpcProcess(process.execPath, [resolve(root, 'src/server.mjs'), '--session', session, '--repo', f.repo], f.repo, f.env);
  t.after(() => mcp.child.kill());
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-cli-cleanup-test', version: '1' } });
  const listed = await mcp.request('tools/call', { name: 'cloud_agent_list', arguments: {} });
  assert.ok(listed.result.structuredContent.agents.some((agent) => agent.agent_id === result.agent_id && agent.status === 'stop-pending'));
  const stopped = await mcp.request('tools/call', { name: 'cloud_agent_stop', arguments: { agent_ids: [result.agent_id] } });
  assert.equal(stopped.result.structuredContent.agents[0].status, 'stopped');
});

test('CLI drains large JSON output before exiting', async (t) => {
  const f = await fixture(t);
  const session = `${f.session}-large-output`;
  t.after(() => stopOwner(session, f.repo, f.home));
  const child = spawn(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', session, '--timeout', '30', '--json', '--', 'LARGE output'], {
    cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 2);
  });
  const code = await new Promise((resolveCode, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`large JSON CLI timed out; stderr=${stderr}`)); }, 40_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => { clearTimeout(timer); resolveCode(status); });
  });
  assert.equal(code, 0, `exit=${code}; stderr=${stderr}; stdoutBytes=${Buffer.byteLength(stdout)}; stdoutPrefix=${stdout.slice(0, 300)}`);
  assert.ok(stdout.endsWith('\n'));
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'completed');
  assert.ok(result.result.length > 2_000_000);
});

test('run prints a durable handle and resume collects the same worker after the CLI disconnects', async (t) => {
  const f = await fixture(t);
  const session = `${f.session}-resume`;
  t.after(() => stopOwner(session, f.repo, f.home));
  const dirtyFile = join(f.repo, 'keep-me.txt');
  await writeFile(dirtyFile, 'local edits stay here\n');
  const child = spawn(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', session, '--timeout', '30', '--json', '--', 'SLOW resumable work'], {
    cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const runId = await new Promise((resolveId, reject) => {
    const timer = setTimeout(() => reject(new Error(`run handle was not printed; stderr=${stderr}`)), 10_000);
    const poll = async () => {
      const match = /Run ID: ([0-9a-f-]{36})/.exec(stderr);
      if (match) { clearTimeout(timer); resolveId(match[1]); return; }
      if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`run exited before printing its handle; stderr=${stderr}`)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
  const recordPath = join(f.home, '.config', 'cloudy-cloud', 'runs', `${runId}.json`);
  let record;
  for (let i = 0; i < 200; i++) {
    try { record = JSON.parse(await readFile(recordPath, 'utf8')); } catch { /* waiting for atomic run record update */ }
    if (record?.agent_id) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.ok(record?.agent_id, `worker id was not persisted; stderr=${stderr}`);
  child.kill('SIGTERM');
  await new Promise((resolveClose) => child.once('close', resolveClose));
  assert.equal(stdout, '', 'the interrupted --json command must not emit a partial result');

  const mcp = rpcProcess(process.execPath, [resolve(root, 'src/server.mjs'), '--session', session, '--repo', f.repo], f.repo, f.env);
  t.after(() => mcp.child.kill());
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-resume-test', version: '1' } });
  const listed = await mcp.request('tools/call', { name: 'cloud_agent_list', arguments: {} });
  const originalAgents = listed.result.structuredContent.agents;
  assert.deepEqual(originalAgents.map((agent) => agent.agent_id), [record.agent_id], 'the original session must contain exactly one worker before resume');

  const resumed = await exec(resolve(root, 'bin/cloudy-cloud'), ['resume', runId, '--json'], { cwd: tmpdir(), env: f.env, timeout: 40_000 }).catch((error) => error);
  assert.equal(resumed.code ?? 0, 0, `resume failed; stdout=${resumed.stdout} stderr=${resumed.stderr}`);
  const result = JSON.parse(resumed.stdout.trim());
  assert.equal(result.status, 'completed');
  assert.equal(result.run_id, runId);
  assert.equal(result.agent_id, record.agent_id, 'resume must collect the original worker');
  assert.match(result.result, /slow done/);
  assert.equal(await readFile(dirtyFile, 'utf8'), 'local edits stay here\n');
  const runs = await stat(join(f.home, '.config', 'cloudy-cloud', 'runs'));
  assert.equal(runs.mode & 0o077, 0, 'run handles must be private to the user');
  mcp.child.kill();
  await new Promise((resolveClose) => mcp.child.once('close', resolveClose));
  await stopOwner(session, f.repo, f.home);
  const metadataFile = sessionPaths({ name: session, repo: f.repo, home: f.home }).metadata;
  let ownerGone = false;
  for (let i = 0; i < 200; i++) {
    try { await access(metadataFile); } catch { ownerGone = true; break; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.equal(ownerGone, true, 'the cached replay must not depend on a live owner');
  const replay = await exec(resolve(root, 'bin/cloudy-cloud'), ['resume', runId, '--json'], { cwd: tmpdir(), env: f.env, timeout: 20_000 });
  assert.deepEqual(JSON.parse(replay.stdout.trim()), result);
});

test('resume with a stale run record fails without starting a new named owner', async (t) => {
  const f = await fixture(t);
  const runId = '00000000-0000-4000-8000-000000000060';
  const session = `${f.session}-stale`;
  const records = join(f.home, '.config', 'cloudy-cloud', 'runs');
  await mkdir(records, { recursive: true, mode: 0o700 });
  await writeFile(join(records, `${runId}.json`), JSON.stringify({ id: runId, uid: process.getuid?.() ?? 0, repo: f.repo, session, agent_id: 'deadbeef', created_at: Date.now() }), { mode: 0o600 });
  const resumed = await exec(resolve(root, 'bin/cloudy-cloud'), ['resume', runId, '--json'], { cwd: f.repo, env: f.env }).catch((error) => error);
  assert.equal(resumed.code, 1);
  const result = JSON.parse(resumed.stdout.trim());
  assert.equal(result.error, true);
  assert.match(result.message, /stale or unavailable|No live named session owner/);
  await assert.rejects(access(sessionPaths({ name: session, repo: f.repo, home: f.home }).metadata), 'resume must not create an owner for a stale run');
});

test('transient run timeout remains resumable and is not cached as a final result', async (t) => {
  const f = await fixture(t);
  t.after(() => stopOwner(f.session, f.repo, f.home));
  const result = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', f.session, '--timeout', '1', '--json', '--', 'HANG until stopped'], { env: f.env, timeout: 20_000 }).catch((error) => error);
  assert.equal(result.code, 124, `expected the wait limit to expire; stdout=${result.stdout} stderr=${result.stderr}`);
  const runId = /Run ID: ([0-9a-f-]{36})/.exec(result.stderr)?.[1];
  assert.ok(runId);
  const record = JSON.parse(await readFile(join(f.home, '.config', 'cloudy-cloud', 'runs', `${runId}.json`), 'utf8'));
  assert.equal(record.agent_id !== null, true);
  assert.equal(record.cached_result, undefined);
  assert.equal(record.status, 'failed');
  const resumed = await exec(resolve(root, 'bin/cloudy-cloud'), ['resume', runId, '--timeout', '1', '--json'], { cwd: tmpdir(), env: f.env, timeout: 20_000 }).catch((error) => error);
  assert.equal(resumed.code, 124, `expected resume to keep waiting on the original worker; stdout=${resumed.stdout} stderr=${resumed.stderr}`);
  const resumedResult = JSON.parse(resumed.stdout.trim());
  assert.equal(resumedResult.run_id, runId);
  assert.equal(resumedResult.agent_id, record.agent_id);
});
