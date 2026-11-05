import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInstaboxSandbox } from './instabox.mjs';
import { loadEnv } from './config.mjs';
import { runSubagent } from './run-subagent.mjs';

const tool = {
  name: 'cloud_agent',
  description: 'Run a subagent in a remote sandbox on committed and tracked files (no untracked files). Returns its final answer; any file changes come back as a local git branch. Set keep_open to leave the subagent open, then pass its session_id to send follow-up messages.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full task for the subagent, or the follow-up message when session_id is given. Required unless close is true.' },
      description: { type: 'string', description: 'Short task label' },
      model: { type: 'string', description: 'Optional model name' },
      subagent_type: { type: 'string', description: 'Optional agent name' },
      keep_open: { type: 'boolean', description: 'Keep the sandbox open after this run so it can receive follow-up messages' },
      session_id: { type: 'string', pattern: '^[0-9a-f]{8}$', description: 'Id of an open subagent to continue (or close)' },
      close: { type: 'boolean', description: 'With session_id: end that open subagent. No prompt needed.' },
    },
    required: ['description'],
  },
};

const env = loadEnv();
// Instabox wins when both keys are set. Each SDK is imported only when its provider is used.
const createSandbox = env.INSTABOX_API_KEY
  ? createInstaboxSandbox(env)
  : async (envs, timeoutMs) => (await import('e2b')).Sandbox.create('claude', { envs, timeoutMs });

const open = new Map();
const killOpen = () => {
  const all = [...open.values()];
  open.clear();
  return Promise.allSettled(all.map((o) => o.sandbox.kill()));
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => killOpen().finally(() => process.exit()));
process.on('beforeExit', killOpen);
process.stdin.on('close', () => killOpen().finally(() => process.exit()));

const server = new Server({ name: 'cloud', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'cloud_agent') {
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  }
  return runSubagent(req.params.arguments ?? {}, { createSandbox, env, open });
});
await server.connect(new StdioServerTransport());
