import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Sandbox } from 'e2b';
import { runSubagent } from './run-subagent.mjs';

const tool = {
  name: 'cloud_agent',
  description: 'Run a subagent in a remote E2B sandbox on committed and tracked files (no untracked files). Returns its final answer; any file changes come back as a local git branch.',
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
const createSandbox = (envs, timeoutMs) => Sandbox.create('claude', { envs, timeoutMs });

const server = new Server({ name: 'cloud', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'cloud_agent') {
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  }
  return runSubagent(req.params.arguments ?? {}, { createSandbox, env });
});
await server.connect(new StdioServerTransport());
