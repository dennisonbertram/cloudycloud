import { randomUUID } from 'node:crypto';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadProvider } from './providers/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { envRefresher, loadEnv, ownerFile } from './config.mjs';
import { killAll } from './run-subagent.mjs';
import { buildServer } from './mcp.mjs';
import { startReaper } from './reaper.mjs';
import { createEventLog } from './events.mjs';

const owner = randomUUID().slice(0, 12);
const env = loadEnv();
const provider = await loadProvider(env, { owner }).catch((e) => { console.error(e.message); process.exit(1); });

// The reaper is the guarantee that machines are deleted. A server that started without the provider key
// (cloudy-cloud mcp-server run before setup) starts it on the first env refresh that finds one — the
// refresh runs at the top of cloud_agent, so the first authenticated launch is covered too.
let reaperStarted = false;
const maybeStartReaper = () => {
  if (reaperStarted || !env[provider.keyName] || process.env.NODE_ENV?.includes('test')) return;
  reaperStarted = true;
  startReaper(process.pid, owner, env, provider);
};
const refresh = envRefresher(env);
const deps = { provider, owner, env, refreshEnv: () => { refresh(); maybeStartReaper(); }, open: new Map(), tasks: new Map(), events: createEventLog(env, owner) };

try { mkdirSync(dirname(ownerFile(env)), { recursive: true }); writeFileSync(ownerFile(env), `${owner}\n`); } catch { /* only `coordinator finish` reads it */ }

maybeStartReaper();

// kill() waits for the delete to finish, which can take seconds, so give it at most 1.5 s before exiting.
const killOpen = () => Promise.race([killAll(deps.open), new Promise((r) => setTimeout(r, 1500))]);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => killOpen().finally(() => process.exit()));
process.on('beforeExit', killOpen);
process.stdin.on('close', () => killOpen().finally(() => process.exit()));

// serveStdio picks the protocol revision per connection: 2026-07-28 (MCP tasks) or any older one.
serveStdio(() => buildServer(deps));
