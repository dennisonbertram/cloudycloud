import './tmp-cleanup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRepoPath, sessionPaths, startNamedSession } from '../src/session-transport.mjs';
import { parseServerArgs } from '../src/session-args.mjs';

const home = '/tmp/cloudy-cloud-home';
const openSockets = new Set();
const ownerPids = new Set();
after(() => {
  for (const socket of openSockets) socket.destroy();
  for (const pid of ownerPids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already closed */ } }
});

test('named sessions use a private, collision-resistant owner path scoped to the repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-paths-'));
  const alpha = join(root, 'alpha'), beta = join(root, 'beta'), alias = join(root, 'alpha-link');
  mkdirSync(alpha); mkdirSync(beta); symlinkSync(alpha, alias);
  try {
    const a = sessionPaths({ name: 'work session', repo: alpha, home });
    const same = sessionPaths({ name: 'work session', repo: alpha, home });
    const symlink = sessionPaths({ name: 'work session', repo: alias, home });
    const otherRepo = sessionPaths({ name: 'work session', repo: beta, home });
    const otherName = sessionPaths({ name: 'other', repo: alpha, home });
    const otherHome = sessionPaths({ name: 'work session', repo: alpha, home: '/tmp/isolated-home' });
    assert.deepEqual(a, same);
    assert.deepEqual(a, symlink);
    assert.equal(canonicalRepoPath(alias), canonicalRepoPath(alpha));
    assert.notEqual(a.socket, otherRepo.socket);
    assert.notEqual(a.socket, otherName.socket);
    assert.notEqual(a.socket, otherHome.socket);
    assert.match(a.socket, /\/cc-[a-f0-9]{8}-[a-f0-9]{28}\/s$/);
    assert.match(a.metadata, /^\/tmp\/cloudy-cloud-home\/\.config\/cloudy-cloud\/sessions\/[a-f0-9]{64}\.json$/);
    assert.throws(() => canonicalRepoPath(join(root, 'missing')), /must exist and be a directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('named session names reject blank, path-like, and control-character input', () => {
  for (const name of ['', '../escape', 'a/b', 'bad\nname']) {
    assert.throws(() => sessionPaths({ name, repo: '/work/alpha', home }), /session name/i);
  }
});

test('mcp-server accepts workspace binding and named owner mode without changing default stdio options', () => {
  assert.deepEqual(parseServerArgs([]), { session: undefined, repo: undefined, owner: false });
  assert.deepEqual(parseServerArgs(['--repo', '/work/project']), { session: undefined, repo: '/work/project', owner: false });
  assert.deepEqual(parseServerArgs(['--session', 'shared', '--repo', '/work/project']), { session: 'shared', repo: '/work/project', owner: false });
  assert.deepEqual(parseServerArgs(['--session-owner', '--session', 'shared', '--repo', '/work/project']), { session: 'shared', repo: '/work/project', owner: true });
  assert.throws(() => parseServerArgs(['--session']), /requires a value/);
  assert.throws(() => parseServerArgs(['--unknown']), /Unknown mcp-server option/);
  assert.throws(() => parseServerArgs(['--session-owner', '--session', 'shared']), /requires --session and --repo/);
});

function connect(paths) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socket);
    openSockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '', id = 0;
    const pending = new Map();
    const client = {
      socket,
      request(method, params = {}) {
        const requestId = ++id;
        return new Promise((done, fail) => {
          const timer = setTimeout(() => { pending.delete(requestId); fail(new Error(`timed out: ${method}`)); }, 5000);
          pending.set(requestId, (message) => { clearTimeout(timer); done(message); });
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
        });
      },
      notify(method, params = {}) { socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
      async close() { openSockets.delete(socket); socket.end(); await new Promise((r) => socket.once('close', r)); },
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    socket.once('connect', async () => {
      try {
        const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'session-regression', version: '1' } });
        assert.equal(init.result.protocolVersion, '2025-11-25');
        client.notify('notifications/initialized');
        resolve(client);
      } catch (e) { socket.destroy(); reject(e); }
    });
    socket.once('error', reject);
  });
}

const call = async (client, name, args = {}, id = undefined) => {
  const response = await client.request('tools/call', { name, arguments: args }, id);
  assert.ok(response.result, JSON.stringify(response));
  return response.result.content?.[0]?.text ?? '';
};

test('a subprocess named owner preserves workers across disconnects and concurrent client request ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-session-'));
  const repo = join(dir, 'repo');
  const userHome = join(dir, 'home');
  const ownerEntry = fileURLToPath(new URL('../support/session-owner-entry.mjs', import.meta.url));
  const env = { ...process.env, HOME: userHome, CLOUDY_CLOUD_CONFIG: join(userHome, '.config/cloudy-cloud/env'), NODE_ENV: 'test', CC_TEST_IDLE_MS: '100' };
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo, env });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, env });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo, env });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test/session-fixture.git'], { cwd: repo, env });

  const stale = sessionPaths({ name: 'shared', repo, home: userHome });
  mkdirSync(stale.socketDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(stale.metadata), { recursive: true, mode: 0o700 });
  writeFileSync(stale.socket, 'stale socket');
  writeFileSync(stale.metadata, JSON.stringify({ pid: 2_147_483_647 }));
  const [paths, sameOwner] = await Promise.all([
    startNamedSession({ name: 'shared', repo, home: userHome, env, ownerEntry }),
    startNamedSession({ name: 'shared', repo, home: userHome, env, ownerEntry }),
  ]);
  assert.equal(sameOwner.socket, paths.socket);
  const metadata = JSON.parse(readFileSync(paths.metadata, 'utf8'));
  ownerPids.add(metadata.pid);
  const first = await connect(paths);
  const started = await call(first, 'cloud_agent', { prompt: 'SLOW shared', description: 'shared session' });
  const id = /agent_id: ([0-9a-f]{8})/.exec(started)?.[1];
  assert.ok(id, started);
  await first.close();

  const second = await connect(paths);
  const [list, concurrentList] = await Promise.all([
    second.request('tools/list'),
    (async () => {
      const third = await connect(paths);
      try { return await third.request('tools/list'); } finally { await third.close(); }
    })(),
  ]);
  assert.ok(list.result.tools.some((tool) => tool.name === 'cloud_agent_result'));
  assert.ok(concurrentList.result.tools.some((tool) => tool.name === 'cloud_agent_result'));
  const waited = await call(second, 'cloud_agent_wait', { agent_ids: [id], timeout_seconds: 5 });
  assert.match(waited, /done SLOW/);
  await second.close();

  const reconnected = await connect(paths);
  const result = await call(reconnected, 'cloud_agent_result', { agent_id: id });
  assert.match(result, /done SLOW/);
  const stopped = await call(reconnected, 'cloud_agent_stop', { agent_ids: [id] });
  assert.match(stopped, /stopped|deleted|not open/i);
  await reconnected.close();

  const until = Date.now() + 4000;
  while (Date.now() < until) {
    try { readFileSync(paths.metadata); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.throws(() => readFileSync(paths.metadata), { code: 'ENOENT' });
  const ownerExitDeadline = Date.now() + 2000;
  let ownerAlive = true;
  while (ownerAlive && Date.now() < ownerExitDeadline) {
    try { process.kill(metadata.pid, 0); } catch (e) { if (e.code === 'ESRCH') ownerAlive = false; else throw e; }
    if (ownerAlive) await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(ownerAlive, false, 'named owner should exit after its final worker is stopped');
  ownerPids.delete(metadata.pid);
  rmSync(dir, { recursive: true, force: true });
});
