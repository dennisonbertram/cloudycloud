import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInstaboxSandbox } from './instabox.mjs';
import { runSubagent } from './run-subagent.mjs';

const tool = {
  name: 'cloud_agent',
  description: 'Run a subagent in a remote sandbox on committed and tracked files (no untracked files). Returns its final answer; any file changes come back as a local git branch.',
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
};

// The launcher passes unset secrets as empty strings; treat them as unset.
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v));
// Instabox wins when both keys are set. Each SDK is imported only when its provider is used.
const createSandbox = env.INSTABOX_API_KEY
  ? createInstaboxSandbox(env)
  : async (envs, timeoutMs) => (await import('e2b')).Sandbox.create('claude', { envs, timeoutMs });

const server = new Server({ name: 'cloud', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'cloud_agent') {
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  }
  return runSubagent(req.params.arguments ?? {}, { createSandbox, env });
});
await server.connect(new StdioServerTransport());
