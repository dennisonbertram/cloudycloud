import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createInstaboxSandbox } from './instabox.mjs';
import { loadEnv } from './config.mjs';
import { killAll } from './run-subagent.mjs';
import { buildServer } from './mcp.mjs';

const env = loadEnv();
const deps = { createSandbox: createInstaboxSandbox(env), env, open: new Map(), tasks: new Map() };

const killOpen = () => killAll(deps.open);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => killOpen().finally(() => process.exit()));
process.on('beforeExit', killOpen);
process.stdin.on('close', () => killOpen().finally(() => process.exit()));

// serveStdio picks the protocol revision per connection: 2026-07-28 (MCP tasks) or any older one.
serveStdio(() => buildServer(deps));
