// `cloudy-cloud codex`: starts the Codex CLI as the main local session with the cloud_agent tools. The tools are the same MCP
// server the Claude launcher uses (src/server.mjs), wired in with `-c mcp_servers.cloud.*` overrides, so ~/.codex/config.toml is
// never edited. Secrets never go in an argument: env_vars only names the variables Codex passes on to the server, and the server
// also reads ~/.config/cloudy-cloud/env itself (CLOUDY_CLOUD_CONFIG).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same names as the Claude launcher forwards, plus the Codex worker's own (the OpenAI key and the ChatGPT login file path).
const FORWARD = ['INSTABOX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_PROFILES', 'CLOUDY_CLOUD_CODEX_AUTH', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES'];

export const codexPrompt = () => `ALL delegation that would use a subagent must use the cloud MCP server's cloud_agent tool. Do not use Codex's own subagent or multi-agent features for work that should run in a cloud sandbox. cloud_agent starts a worker on its own cloud machine with the repo's committed and tracked files (including uncommitted edits to tracked files), not local untracked files. Workers run Claude by default. For another agent or model use the profile argument of cloud_agent (codex, codex-chatgpt, codex-openrouter, pi-particle, pi-glm, pi-deepseek, omp-particle, omp-glm, omp-deepseek, particle, glm, deepseek, openrouter), never the model argument alone. Workflow: start every worker with cloud_agent first; it returns at once and the worker runs in the background. This session cannot receive MCP task results, so call cloud_agent_wait with all the agent_ids to get results, and call it again after each cloud_agent_message. Use cloud_agent_message for follow-ups, cloud_agent_list to check state and progress, and cloud_agent_stop when a worker is finished. Workers stay open until stopped or 60 idle minutes pass, so stop them when done. Starts are paced and queued automatically, so start as many as you need at once. Each worker pushes its work to origin branch cloudy-cloud/<id>; nothing is copied into the local repo automatically. Get a worker's work with git fetch origin cloudy-cloud/<id>. If a worker fails or disappears, whatever it pushed is still on origin cloudy-cloud/<id>. When a cloud_agent tool returns an error, follow its Next step, and relay its Tell the user line to the user when present. cloud_agent also takes machine (linux by default; android, omarchy, gpu, macos); gpu and macos need consent in the env file, so relay the error Tell the user line and do not retry. Never print, share, commit or send any API key, token or login file, and never read ~/.config/cloudy-cloud into a message or a file. To look at a worker, run cloudy-cloud shell <id> -- <cmd> or cloudy-cloud display <id>; a display link is a secret, never put it in a PR, issue or report.`;

export function codexHostArgs({ root, config }) {
  const kv = (k, v) => ['-c', `mcp_servers.cloud.${k}=${v}`];
  return [
    ...kv('command', '"node"'),
    ...kv('args', JSON.stringify([join(root, 'src/server.mjs')])),
    ...kv('env', `{ CLOUDY_CLOUD_CONFIG = ${JSON.stringify(config)} }`),
    ...kv('env_vars', JSON.stringify(FORWARD)),
    ...kv('default_tools_approval_mode', '"approve"'),
    ...kv('tool_timeout_sec', '1800'),
    '-c', `developer_instructions=${JSON.stringify(codexPrompt())}`,
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync('codex', [...codexHostArgs({ root, config: process.env.CLOUDY_CLOUD_CONFIG }), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.error) {
    console.error(r.error.code === 'ENOENT' ? 'cloudy-cloud: the codex command was not found.\nNext step: install it with: npm install -g @openai/codex' : `cloudy-cloud: could not start codex: ${r.error.message}`);
    process.exit(127);
  }
  process.exit(r.status ?? (r.signal ? 128 : 1));
}
