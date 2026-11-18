import { Server, ProtocolError, ProtocolErrorCode, fromJsonSchema } from '@modelcontextprotocol/server';
import { runSubagent, messageAgent, waitAgents, resultAgent, listAgents, stopAgents, getTask, cancelTask, sharedQueue } from './run-subagent.mjs';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

const ids = { type: 'array', items: { type: 'string' }, description: 'Agent ids' };
const tools = [
  {
    name: 'cloud_agent',
    description: 'Start a subagent in a remote sandbox on committed and tracked files (no untracked files). The repo needs a github.com origin. Returns at once while the sandbox starts and the task runs in the background. In Claude Code terminal sessions that support MCP tasks, the call becomes a background task: its progress shows in /tasks and the result arrives on its own, with the agent_id. Otherwise it returns an agent_id and you call cloud_agent_wait to get the result. The agent stays open for follow-ups until cloud_agent_stop or 60 idle minutes. The agent pushes its work to origin branch cloudy-cloud/<id>; nothing is copied into the local repo. The optional machine argument picks another kind of machine (android, omarchy, gpu, macos). Each turn is limited to 29 minutes by default (CLOUDY_CLOUD_TURN_MINUTES changes it, 5 or more); the prompt tells the agent when its turn ends. If a turn fails or hits the limit after the agent has started, the agent stays open: call cloud_agent_message to continue it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full task for the subagent' },
        description: { type: 'string', description: 'Short task label' },
        model: { type: 'string', description: 'Optional Claude model name, such as haiku. For any other agent or model use profile instead. Exceptions: the openrouter, codex-openrouter and opencode-openrouter profiles also need model (the OpenRouter model id).' },
        profile: { type: 'string', description: 'Optional profile that runs the worker on another agent or model. Default: Claude Code. Claude Code with another model: glm, deepseek, particle, openrouter. pi: pi-glm, pi-deepseek, pi-particle. oh-my-pi: omp-glm, omp-deepseek, omp-particle. Codex: codex (OPENAI_API_KEY), codex-chatgpt (your ChatGPT login file), codex-openrouter (pass model). opencode: opencode-glm, opencode-deepseek, opencode-particle, opencode-openrouter (pass model). Or a name from profiles.json. Coordinators (role coordinator) cannot use a pi, omp, codex or opencode profile.' },
        role: { type: 'string', enum: ['worker', 'coordinator'], description: 'Optional. worker (default) does the task. coordinator also gets cloudy-cloud installed and can start its own cloud agents (limited by CLOUDY_CLOUD_MAX_DEPTH, default 3).' },
        fallback: { type: 'array', items: { type: 'string' }, description: 'Optional profile names to try in order when the profile has no key or the provider refuses a one-token check before the machine starts. Overrides the profile\'s fallback in profiles.json. The result says which profile ran.' },
        preflight: { type: 'boolean', description: 'Optional, default true. Set false to skip the one-token provider check that runs before the machine is created.' },
        autofix: { type: 'boolean', description: 'Optional, default false. After the worker pushes, the server opens a pull request for its branch and keeps the worker fixing failed checks, review comments and merge conflicts (at most 3 rounds, CLOUDY_CLOUD_AUTOFIX_ROUNDS) before the task ends. The result says whether the pull request is clean. Not for coordinators.' },
        machine: { type: 'string', description: 'Optional kind of machine: linux (default), android, omarchy, gpu, gpu:TYPE, gpu:TYPE:COUNT, macos, macos:MODEL. gpu and macos cost much more and need CLOUDY_CLOUD_ALLOW_MACHINE_KINDS in the user\'s cloudy-cloud env file.' },
        size: { type: 'string', description: 'Optional machine size as VCPUSxGIB, for example 4x8 (default), 2x4 or 8x16. Sizes and cost an hour: 2x4 $0.017, 4x8 $0.034 (default), 8x16 $0.068 on every paid plan; builder adds 16x32 ($0.136); team adds 32x64 ($0.272). Your plan decides which are allowed; a size no plan lists is refused.' },
        base: { type: 'string', description: 'Optional branch name or commit SHA to start the worker from instead of the local HEAD (fetched from origin if needed). Uncommitted edits are ignored when set.' },
        subagent_type: { type: 'string', description: 'Optional Claude Code agent name, passed to claude as --agent. Only for Claude Code workers (no profile, or glm, deepseek, particle, openrouter); pi, omp, Codex and opencode workers ignore it.' },
      },
      required: ['prompt', 'description'],
    },
  },
  {
    name: 'cloud_agent_message',
    description: 'Send a follow-up message to an open, idle agent. Returns at once. As an MCP task the reply arrives on its own; otherwise call cloud_agent_wait for it. Rejected if the agent is busy or gone. Each turn is limited to 29 minutes by default (CLOUDY_CLOUD_TURN_MINUTES changes it); a turn that fails or hits the limit leaves the agent open, so send another message to continue.',
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
    description: 'List every agent with its id, description, status, idle minutes and progress (tool uses, tokens, elapsed time, current step), plus CPU and memory use of each running or idle machine, with the sample age (usage n/a (timeout|unavailable|none yet) when it cannot be read). Status idle means the turn finished and the agent waits for a message; it does not mean the machine does nothing. Stop agents you no longer need with cloud_agent_stop, especially quiet ones (under 3 % CPU for 10 minutes while running). A queued agent shows why it waits (a free machine slot on your plan, or the start pace) and how many are ahead; do not start more agents while they wait. The last line gives this month\'s Instabox usage against what the plan includes, when it can be read. With all: true, list every cloudy-cloud machine on the provider (including other sessions and coordinators) grouped by parent.',
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
  sharedQueue(deps);
  deps.literals ??= new Set(); // tokens to redact, added when an agent starts and needed by every later call
  const server = new Server({ name: 'cloud', version: '0.2.0' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } } });
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
