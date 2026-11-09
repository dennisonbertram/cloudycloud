import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createInstaboxSandbox } from './instabox.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEnv, ownerFile } from './config.mjs';
import { killAll } from './run-subagent.mjs';
import { buildServer } from './mcp.mjs';
import { reaperSpawn } from './reaper.mjs';
import { createEventLog } from './events.mjs';

const owner = randomUUID().slice(0, 12);
const env = loadEnv();
const deps = { createSandbox: createInstaboxSandbox(env, undefined, undefined, undefined, owner), env, open: new Map(), tasks: new Map(), events: createEventLog(env, owner) };

try { mkdirSync(dirname(ownerFile(env)), { recursive: true }); writeFileSync(ownerFile(env), `${owner}\n`); } catch { /* only `coordinator finish` reads it */ }

// The reaper is the guarantee that machines are deleted. The handlers below only try to be quick about it.
if (env.INSTABOX_API_KEY && !process.env.NODE_ENV?.includes('test')) {
  const { command, args, options } = reaperSpawn(process.pid, owner, env.INSTABOX_API_KEY);
  spawn(command, args, options).on('error', () => {}).unref();
}

// kill() waits for the delete to finish, which can take seconds, so give it at most 1.5 s before exiting.
const killOpen = () => Promise.race([killAll(deps.open), new Promise((r) => setTimeout(r, 1500))]);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => killOpen().finally(() => process.exit()));
process.on('beforeExit', killOpen);
process.stdin.on('close', () => killOpen().finally(() => process.exit()));

// serveStdio picks the protocol revision per connection: 2026-07-28 (MCP tasks) or any older one.
serveStdio(() => buildServer(deps));
