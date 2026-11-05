import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInstaboxSandbox } from './instabox.mjs';
import { loadEnv } from './config.mjs';
import { runSubagent, messageAgent, waitAgents, listAgents, stopAgents, killAll } from './run-subagent.mjs';

const ids = { type: 'array', items: { type: 'string' }, description: 'Agent ids' };
const tools = [
  {
    name: 'cloud_agent',
    description: 'Start a Claude subagent in a remote sandbox on committed and tracked files (no untracked files). Returns an agent_id at once while the sandbox starts and the task runs in the background. Call cloud_agent_wait to get the result. The agent stays open for follow-ups until cloud_agent_stop or 60 idle minutes. File changes come back as local git branch claude-cloud/<id>.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full task for the subagent' },
        description: { type: 'string', description: 'Short task label' },
        model: { type: 'string', description: 'Optional model name' },
        subagent_type: { type: 'string', description: 'Optional agent name' },
      },
      required: ['prompt', 'description'],
    },
  },
  {
    name: 'cloud_agent_message',
    description: 'Send a follow-up message to an open, idle agent. Returns at once; call cloud_agent_wait for the reply. Rejected if the agent is busy or gone.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string' }, message: { type: 'string' } },
      required: ['agent_id', 'message'],
    },
  },
  {
    name: 'cloud_agent_wait',
    description: 'Wait until every listed agent finishes its current turn, or the timeout passes. Returns each agent\'s status (starting, running, idle, failed, stopped) and its latest result once; later calls mark it already reported.',
    inputSchema: {
      type: 'object',
      properties: { agent_ids: ids, timeout_seconds: { type: 'number', description: 'Default 600, max 1500' } },
      required: ['agent_ids'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cloud_agent_list',
    description: 'List every agent with its id, description, status and idle minutes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cloud_agent_stop',
    description: 'Stop agents and delete their sandboxes. Safe to repeat or to call with unknown ids.',
    inputSchema: { type: 'object', properties: { agent_ids: ids }, required: ['agent_ids'] },
  },
];
const handlers = {
  cloud_agent: runSubagent, cloud_agent_message: messageAgent, cloud_agent_wait: waitAgents,
  cloud_agent_list: listAgents, cloud_agent_stop: stopAgents,
};

const env = loadEnv();
// Instabox wins when both keys are set. Each SDK is imported only when its provider is used.
const createSandbox = env.INSTABOX_API_KEY
  ? createInstaboxSandbox(env)
  : async (envs) => (await import('e2b')).Sandbox.create('claude', { envs, timeoutMs: 60 * 60_000 }) // E2B caps a sandbox at 1 hour;

const open = new Map();
const killOpen = () => killAll(open);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => killOpen().finally(() => process.exit()));
process.on('beforeExit', killOpen);
process.stdin.on('close', () => killOpen().finally(() => process.exit()));

const server = new Server({ name: 'cloud', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const h = handlers[req.params.name];
  if (!h) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  return h(req.params.arguments ?? {}, { createSandbox, env, open });
});
await server.connect(new StdioServerTransport());
