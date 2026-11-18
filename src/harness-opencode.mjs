// opencode worker harness (sst/opencode). Docs: opencode.ai/docs/config (provider options.apiKey takes "{env:NAME}", `instructions`
// takes file paths, OPENCODE_CONFIG_CONTENT is merged after project config so a repository cannot override it); observed on 1.18.31:
// `opencode run --format json`, the prompt on stdin, `--session ses_...` to resume. The config file holds key NAMES only; it is
// mode 600 because an MCP server the user allowed to carry a real value may add one. The pinned version's config schema is the
// 1.x one (`provider`, `mcp` map), not the 2.x `providers` / `mcp.servers` of the current docs.
export const OPENCODE_VERSION = '1.18.31';
export const OPENCODE_PROVIDER = 'worker';
export const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{8,40}$/;
export const MCP_TIMEOUT_MS = 1800000; // like MCP_TOOL_TIMEOUT for Claude: cloud_agent_wait may block for minutes

export const opencodeDir = (home) => `${home}/opencode-agent`;
export const opencodeInstructions = (home) => `${opencodeDir(home)}/instructions.md`;

// Claude-style ${NAME} references become opencode's {env:NAME}. cleanEntry already limited each entry to the fields below.
const ref = (s) => s.replace(/\$\{([^}]*)\}/g, '{env:$1}');
const refs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ref(v)]));
export const opencodeMcp = (servers) => Object.fromEntries(Object.entries(servers).map(([name, e]) => [name, e.type === 'http' || e.type === 'sse'
  ? { type: 'remote', url: e.url, ...(e.headers && { headers: refs(e.headers) }), enabled: true }
  : { type: 'local', command: [e.command, ...(e.args ?? [])].map(ref), ...(e.env && { environment: refs(e.env) }), enabled: true }]));

export const opencodeConfig = (p, { home, servers = {} }) => JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
  instructions: [opencodeInstructions(home)],
  permission: { '*': 'allow' }, // headless: nobody can answer a prompt, like --dangerously-skip-permissions for Claude
  provider: { [OPENCODE_PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: OPENCODE_PROVIDER, options: { baseURL: p.baseUrl, apiKey: `{env:${p.keyName}}` }, models: { [p.model]: { name: p.model } } } },
  mcp: opencodeMcp(servers),
  experimental: { mcp_timeout: MCP_TIMEOUT_MS },
}, null, 2);

// OPENCODE_DISABLE_PROJECT_CONFIG=1 (checked on 1.18.31 with `opencode debug config`) drops the checked-out repository's opencode.json and .opencode/
// (MCP servers, plugins), so only the file below is used. The config is read from its file at run time, so no value but a name is in the command string. p.model, the session id and home are validated.
export const opencodeCommand = (p, { home, sessionId }) => `OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT="$(cat ${opencodeDir(home)}/opencode.json)" PATH=${home}/.local/bin:$PATH opencode run --format json --model ${OPENCODE_PROVIDER}/${p.model}${sessionId ? ` --session ${sessionId}` : ''} < ${home}/prompt.txt`;
