import { Server, ProtocolError, ProtocolErrorCode, fromJsonSchema } from '@modelcontextprotocol/server';
import { runSubagent, messageAgent, waitAgents, resultAgent, listAgents, stopAgents, getTask, cancelTask, startQueue } from './run-subagent.mjs';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

const ids = { type: 'array', items: { type: 'string' }, description: 'Agent ids' };
const tools = [
  {
    name: 'cloud_agent',
    description: 'Start a Claude subagent in a remote sandbox on committed and tracked files (no untracked files). The repo needs a github.com origin. Returns at once while the sandbox starts and the task runs in the background. In Claude Code terminal sessions that support MCP tasks, the call becomes a background task: its progress shows in /tasks and the result arrives on its own, with the agent_id. Otherwise it returns an agent_id and you call cloud_agent_wait to get the result. The agent stays open for follow-ups until cloud_agent_stop or 60 idle minutes. The agent pushes its work to origin branch cloudy-cloud/<id>; nothing is copied into the local repo.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full task for the subagent' },
        description: { type: 'string', description: 'Short task label' },
        model: { type: 'string', description: 'Optional Claude model name, such as haiku. For any non-Claude model use profile instead.' },
        profile: { type: 'string', description: 'Optional model profile that runs the worker on another model: glm, deepseek, particle, pi-glm, pi-deepseek, pi-particle, omp-glm, omp-deepseek, omp-particle, openrouter, or a name from profiles.json. Default: Claude.' },
        role: { type: 'string', enum: ['worker', 'coordinator'], description: 'Optional. worker (default) does the task. coordinator also gets cloudy-cloud installed and can start its own cloud agents (limited by CLOUDY_CLOUD_MAX_DEPTH, default 3).' },
        subagent_type: { type: 'string', description: 'Optional agent name' },
      },
      required: ['prompt', 'description'],
    },
  },
  {
    name: 'cloud_agent_message',
    description: 'Send a follow-up message to an open, idle agent. Returns at once. As an MCP task the reply arrives on its own; otherwise call cloud_agent_wait for it. Rejected if the agent is busy or gone.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string' }, message: { type: 'string' } },
      required: ['agent_id', 'message'],
    },
  },
  {
    name: 'cloud_agent_wait',
    description: 'Wait until every listed agent finishes its current turn, or the timeout passes. Returns each agent\'s status (starting, running, idle, failed, stopped) and its latest result once; later calls mark it already reported (read it again with cloud_agent_result).',
    inputSchema: {
      type: 'object',
      properties: { agent_ids: ids, timeout_seconds: { type: 'number', description: 'Default 600, max 1500' } },
      required: ['agent_ids'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cloud_agent_result',
    description: 'Return the latest result of one agent again, as often as asked, even after cloud_agent_wait or a task notification delivered it. Says so if the agent has no result yet or is not open.',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cloud_agent_list',
    description: 'List every agent with its id, description, status, idle minutes and progress (tool uses, tokens, elapsed time, current step). With all: true, list every cloudy-cloud machine on the provider (including other sessions and coordinators) grouped by parent.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'List every cloudy-cloud machine from the provider, grouped by parent' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cloud_agent_stop',
    description: 'Stop agents and delete their sandboxes. Safe to repeat or to call with unknown ids.',
    inputSchema: { type: 'object', properties: { agent_ids: ids }, required: ['agent_ids'] },
  },
];
const handlers = {
  cloud_agent: runSubagent, cloud_agent_message: messageAgent, cloud_agent_wait: waitAgents, cloud_agent_result: resultAgent,
  cloud_agent_list: listAgents, cloud_agent_stop: stopAgents,
};


// MCP revision 2026-07-28: every request carries the client's capabilities in its envelope. The client can take a task
// answer only when it lists the tasks extension. Older revisions have no envelope, so those calls answer at once.
const canTask = (ctx) => ctx.mcpReq?.envelope?.[CAPABILITIES_META]?.extensions?.[TASKS_EXTENSION] !== undefined;

const taskParams = fromJsonSchema({ type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] });

// deps: { createSandbox, env, open, tasks, cwd? }. One server per connection.
export function buildServer(deps) {
  deps.count ??= { started: 0 }; // agents started by this server, for the per-session cap
  // Each tool call gets a copy of deps, so anything shared between calls must exist before the copy is made.
  deps.tasks ??= new Map();
  deps.queue ??= startQueue(deps.env, deps.provider);
  deps.literals ??= new Set(); // tokens to redact, added when an agent starts and needed by every later call
  const server = new Server({ name: 'cloud', version: '0.1.2' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } } });
  server.setRequestHandler('tools/list', async () => ({ tools }));
  server.setRequestHandler('tools/call', async (req, ctx) => {
    const h = handlers[req.params.name];
    if (!h) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
    return h(req.params.arguments ?? {}, { ...deps, asTask: canTask(ctx) });
  });
  // tasks/get and tasks/cancel are the two task methods the tasks extension keeps; the SDK has no typed API for them.
  const taskMethod = (fn) => async (params) => {
    const r = await fn(params.taskId, deps);
    if (!r) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task ${params.taskId}`);
    return r;
  };
  server.setRequestHandler('tasks/get', { params: taskParams }, taskMethod(getTask));
  server.setRequestHandler('tasks/cancel', { params: taskParams }, taskMethod(cancelTask));
  return server;
}
