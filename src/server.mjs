import { randomUUID } from 'node:crypto';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { combine, loadProviders } from './providers/index.mjs';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { chdir, cwd } from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envRefresher, loadEnv, ownerFile } from './config.mjs';
import { killAll } from './run-subagent.mjs';
import { buildServer } from './mcp.mjs';
import { startReaper, providerKey } from './reaper.mjs';
import { createEventLog } from './events.mjs';
import { canonicalRepoPath, SocketTransport, bridgeNamedSessionStdio, serveNamedSession } from './session-transport.mjs';
import { parseServerArgs } from './session-args.mjs';

async function createDeps({ owner, env, provider, providers }) {
  let sessionHost;
  let reaperChild = null;
  // A server without a provider key (mcp-server before setup) starts the reaper on first env refresh.
  // The reaper is tracked, so refresh can start another if it exits or fails to spawn.
  const maybeStartReaper = () => {
    if (reaperChild || !providers.some((p) => providerKey(env, p)) || process.env.NODE_ENV?.includes('test')) return;
    const child = startReaper(process.pid, owner, env, provider);
    if (!child) return;
    reaperChild = child;
    const gone = () => { if (reaperChild === child) reaperChild = null; };
    child.on('exit', gone).on('error', gone);
  };
  const refresh = envRefresher(env);
  const events = createEventLog(env, owner);
  const deps = {
    provider, providers, owner, env, cwd: cwd(), refreshEnv: () => { refresh(); maybeStartReaper(); },
    open: new Map(), tasks: new Map(), events: (event) => {
      events(event);
      if (event?.type === 'machine') sessionHost?.recordPlacement?.({ provider: event.provider, machine: event.machine, id: event.id, branch: event.branch, root: event.root });
    },
  };
  maybeStartReaper();
  return { deps, setSessionHost: (host) => { sessionHost = host; } };
}

function installCleanup(deps, { ownerMode = false, sessionHost } = {}) {
  // kill() waits for the delete to finish, which can take seconds, so give it at most 1.5 s before exiting.
  const killOpen = () => Promise.race([killAll(deps.open), new Promise((r) => setTimeout(r, 1500))]);
  const stop = () => killOpen().finally(async () => { await sessionHost?.close?.(); process.exit(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, stop);
  if (!ownerMode) {
    process.on('beforeExit', killOpen);
    process.stdin.on('close', stop);
  }
  return killOpen;
}

async function createRuntime() {
  const owner = randomUUID().slice(0, 12);
  const env = loadEnv();
  const providers = await loadProviders(env, { owner }).catch((e) => { console.error(e.message); process.exit(1); });
  const provider = providers.length === 1 ? providers[0] : combine(providers);
  return { ...(await createDeps({ owner, env, provider, providers })), owner, env, provider, providers };
}

async function runNamedOwner(options) {
  const runtime = await createRuntime();
  const { deps, setSessionHost } = runtime;
  const host = await serveNamedSession({
    name: options.session, repo: options.repo, owner: runtime.owner, deps,
    onClose: () => setImmediate(() => process.exit(0)),
    onConnection: (socket) => {
      const server = buildServer(deps);
      const transport = new SocketTransport(socket);
      void server.connect(transport).catch((e) => { console.error(`named session connection failed: ${e.message}`); socket.destroy(); });
    },
  });
  setSessionHost(host);
  // A named owner has its own durable metadata and reaper. Do not replace the shared owner marker consumed by coordinators.
  installCleanup(deps, { ownerMode: true, sessionHost: host });
}

const options = parseServerArgs(process.argv.slice(2));
if (options.repo) { options.repo = canonicalRepoPath(options.repo); chdir(options.repo); }

if (options.owner) {
  await runNamedOwner(options);
} else if (options.session) {
  await bridgeNamedSessionStdio({ name: options.session, repo: options.repo || cwd(), ownerEntry: fileURLToPath(import.meta.url) });
} else {
  const runtime = await createRuntime();
  const { deps } = runtime;
  // This owner registry is for `coordinator finish`. Keep every stdio owner so concurrent MCP servers,
  // including servers started with --repo, cannot hide each other's workers from the finish check.
  try {
    const file = ownerFile(runtime.env);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${runtime.owner}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch { /* finish fails closed if it cannot read a verified owner */ }
  installCleanup(deps);
  serveStdio(() => buildServer(deps));
}
