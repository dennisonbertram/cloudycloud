import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NAME_MAX = 128;
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const hash = (s) => createHash('sha256').update(s).digest('hex');
function ensurePrivateSocketDir(paths) {
  mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.socketDir, 0o700);
  const st = lstatSync(paths.socketDir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) {
    throw new Error('Named session socket directory is not private to this user.');
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX || /[\/\\\0-\x1f\x7f]/.test(name)) {
    throw new Error(`Invalid session name; use 1-${NAME_MAX} printable characters without slashes.`);
  }
  return name;
}

export function sessionPaths({ name, repo, home = homedir(), uid = process.getuid?.() ?? userInfo().username }) {
  validateName(name);
  if (typeof repo !== 'string' || !repo.trim()) throw new Error('A repo path is required for a named session.');
  const root = canonicalRepoPath(repo);
  const userHome = resolve(home);
  const key = hash(`${uid}\0${userHome}\0${name}\0${root}`);
  const state = join(userHome, '.config', 'cloudy-cloud', 'sessions');
  // Keep the Unix socket short on macOS, with a per-owner mode-700 directory under the system temp directory.
  const socketDir = join(tmpdir(), `cc-${hash(String(uid)).slice(0, 8)}-${key.slice(0, 28)}`);
  const socket = join(socketDir, 's');
  return { name, repo: root, key, socketDir, socket, metadata: join(state, `${key}.json`), lock: join(state, `${key}.lock`) };
}

export function canonicalRepoPath(repo) {
  try {
    const root = realpathSync(repo);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new Error('The named session repo path must exist and be a directory.');
  }
}

const tryConnect = (socketPath) => new Promise((resolve) => {
  const socket = createConnection(socketPath);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

function safeUnlink(paths, file) {
  if (file !== paths.socket && file !== paths.metadata && file !== paths.lock) return;
  try { rmSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function metadata(paths) {
  try { return JSON.parse(readFileSync(paths.metadata, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read named session metadata: ${e.message}`); }
}

function clearStale(paths) {
  const m = metadata(paths);
  if (m && Number.isInteger(m.pid) && isAlive(m.pid)) return false;
  safeUnlink(paths, paths.socket);
  safeUnlink(paths, paths.metadata);
  try { rmdirSync(paths.socketDir); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e; }
  return true;
}

async function waitForOwner(paths, timeoutMs = 8000, stopWhenOwnerExited = true) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await tryConnect(paths.socket)) return paths;
    const m = metadata(paths);
    if (stopWhenOwnerExited && m && Number.isInteger(m.pid) && !isAlive(m.pid)) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await tryConnect(paths.socket)) ? paths : null;
}

export async function startNamedSession({ name, repo, home = homedir(), env = process.env, ownerEntry = fileURLToPath(new URL('./server.mjs', import.meta.url)), timeoutMs = 8000 }) {
  const paths = sessionPaths({ name, repo, home });
  mkdirSync(dirname(paths.metadata), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(paths.metadata), 0o700); } catch { /* best effort on platforms without chmod */ }
  ensurePrivateSocketDir(paths);
  if (await tryConnect(paths.socket)) return paths;
  const current = metadata(paths);
  if (current && Number.isInteger(current.pid) && isAlive(current.pid)) {
    const ready = await waitForOwner(paths, timeoutMs);
    if (ready) return paths;
    throw new Error(`Named session "${name}" has a live owner process but its socket is unavailable.`);
  }

  let lockFd;
  try {
    lockFd = openSync(paths.lock, 'wx', 0o600);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const ready = await waitForOwner(paths, timeoutMs, false);
    if (ready) return paths;
    let lock;
    for (let i = 0; i < 10 && !lock?.pid; i++) {
      try { lock = JSON.parse(readFileSync(paths.lock, 'utf8')); } catch { lock = null; }
      if (!lock?.pid) await new Promise((r) => setTimeout(r, 50));
    }
    if (!lock?.pid || !isAlive(lock.pid)) {
      safeUnlink(paths, paths.lock);
      return startNamedSession({ name, repo, home, env, ownerEntry, timeoutMs });
    }
    throw new Error(`Timed out waiting for named session "${name}" to start.`);
  }

  try {
    if (await tryConnect(paths.socket)) return paths;
    const existing = metadata(paths);
    if (existing && Number.isInteger(existing.pid) && isAlive(existing.pid)) {
      const ready = await waitForOwner(paths, timeoutMs);
      if (ready) return paths;
      throw new Error(`Named session "${name}" has a live owner process but its socket is unavailable.`);
    }
    clearStale(paths);
    ensurePrivateSocketDir(paths);
    const child = spawn(process.execPath, [ownerEntry, '--session-owner', '--session', name, '--repo', paths.repo], {
      detached: true, stdio: 'ignore', env: { ...env, CLOUDY_CLOUD_SESSION_HOME: home }, cwd: paths.repo,
    });
    let spawnError;
    child.once('error', (e) => { spawnError = e; });
    child.unref();
    const ready = await waitForOwner(paths, timeoutMs);
    if (ready) return paths;
    try { child.kill('SIGTERM'); } catch { /* startup process may already have exited */ }
    const m = metadata(paths);
    throw new Error(m?.error || (spawnError ? `Could not start named session owner: ${spawnError.message}` : `Named session "${name}" owner did not open its private socket.`));
  } finally {
    closeSync(lockFd);
    safeUnlink(paths, paths.lock);
  }
}

export class SocketTransport {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try { this.onmessage?.(JSON.parse(line)); } catch (e) { this.onerror?.(e); }
      }
    });
    this.socket.on('error', (e) => this.onerror?.(e));
    this.socket.on('close', () => { this.started = false; this.onclose?.(); });
    this.started = true;
  }

  async send(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Named session transport is not connected.');
    await new Promise((resolve, reject) => this.socket.write(`${JSON.stringify(message)}\n`, (e) => e ? reject(e) : resolve()));
  }

  async close() {
    if (!this.socket) return;
    this.socket.end();
    this.socket = null;
    this.started = false;
  }
}

export class NamedSessionTransport extends SocketTransport {
  constructor(paths, options) {
    super(null);
    this.paths = paths;
    this.options = options;
  }

  async start() {
    if (this.started) return;
    await startNamedSession(this.options);
    await new Promise((resolve, reject) => {
      const socket = createConnection(this.paths.socket);
      this.socket = socket;
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await super.start();
  }
}

export async function createNamedSessionTransport(options) {
  const paths = sessionPaths(options);
  return new NamedSessionTransport(paths, options);
}

export async function bridgeNamedSessionStdio(options, { input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const paths = await startNamedSession(options);
  const socket = createConnection(paths.socket);
  socket.once('error', (e) => { error.write(`cloudy-cloud: named session connection failed: ${e.message}\n`); process.exitCode = 1; });
  socket.once('connect', () => {
    input.pipe(socket);
    socket.pipe(output);
  });
  input.once('end', () => socket.end());
  socket.once('close', () => {
    if (!input.destroyed) { input.unpipe(socket); input.pause(); }
    output.end();
  });
  return socket;
}

function writeMetadata(paths, value) {
  mkdirSync(dirname(paths.metadata), { recursive: true, mode: 0o700 });
  const temp = `${paths.metadata}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, paths.metadata);
}

export async function serveNamedSession({ name, repo, home = process.env.CLOUDY_CLOUD_SESSION_HOME || homedir(), owner, deps, onConnection, onClose, idleCheckMs = 30_000 }) {
  const paths = sessionPaths({ name, repo, home });
  mkdirSync(dirname(paths.metadata), { recursive: true, mode: 0o700 });
  clearStale(paths);
  ensurePrivateSocketDir(paths);
  const clients = new Set();
  let idleTimer;
  let closed = false;
  let ownerMetadata = { name, repo: paths.repo, pid: process.pid, owner, socket: paths.socket, startedAt: Date.now(), placements: [] };
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    safeUnlink(paths, paths.socket);
    try { rmdirSync(paths.socketDir); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e; }
    const m = metadata(paths);
    if (m?.pid === process.pid) safeUnlink(paths, paths.metadata);
    await onClose?.();
  };
  const scheduleIdleCheck = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!clients.size && !deps.open?.size) void close();
      else if (!closed) scheduleIdleCheck();
    }, idleCheckMs);
    idleTimer.unref?.();
  };
  const server = createServer((socket) => {
    clients.add(socket);
    clearTimeout(idleTimer);
    onConnection?.(socket);
    socket.on('close', () => { clients.delete(socket); scheduleIdleCheck(); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    chmodSync(paths.socket, 0o600);
    writeMetadata(paths, ownerMetadata);
  } catch (e) {
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    safeUnlink(paths, paths.socket);
    try { rmdirSync(paths.socketDir); } catch { /* the next startup checks the owned path */ }
    throw e;
  }
  scheduleIdleCheck();
  return {
    paths, server, close,
    recordPlacement: ({ provider, machine, id, branch, root }) => {
      if (typeof provider !== 'string' || typeof machine !== 'string' || !provider || !machine) return;
      const placement = { provider, machine, ...(typeof id === 'string' && { id }), ...(typeof branch === 'string' && { branch }), workspace: typeof root === 'string' ? resolve(root) : paths.repo };
      ownerMetadata = { ...ownerMetadata, placements: [...ownerMetadata.placements.filter((p) => p.id !== placement.id && p.machine !== machine), placement] };
      writeMetadata(paths, ownerMetadata);
    },
  };
}
