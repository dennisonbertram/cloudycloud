import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
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

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'cc-run-cli-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'cc-run-cli-repo-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'cc-run-cli-remote-'));
  const remote = join(remoteRoot, 'test', 'run-cli.git');
  await mkdir(remote, { recursive: true });
  await mkdir(join(home, '.config', 'cloudy-cloud'), { recursive: true });
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
  const cli = await exec(resolve(root, 'bin/cloudy-cloud'), ['run', '--repo', f.repo, '--session', f.session, '--timeout', '1', '--json', '--', 'FAIL keep this worker'], { env: f.env, timeout: 20_000 }).catch((error) => error);
  assert.equal(cli.code, 1, `expected failed work to return nonzero; stdout=${cli.stdout} stderr=${cli.stderr}`);
  const result = JSON.parse(cli.stdout.trim());
  assert.equal(result.status, 'failed');
  assert.equal(result.recoverable, true);
  assert.equal(result.session, f.session);
  assert.equal(result.repo, f.repo);
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
