// `cloudy-cloud codex`: starts the Codex CLI as the main local session with the cloud_agent tools. The tools are the same MCP
// server the Claude launcher uses (src/server.mjs), wired in with `-c mcp_servers.cloud.*` overrides, so ~/.codex/config.toml is
// never edited. Secrets never go in an argument: env_vars only names the variables Codex passes on to the server, and the server
// also reads ~/.config/cloudy-cloud/env itself (CLOUDY_CLOUD_CONFIG).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultWorkerNote, loadEnv } from './config.mjs';

// Same names as the Claude launcher forwards, plus the Codex worker's own (the OpenAI key and the ChatGPT login file path).
const FORWARD = ['INSTABOX_API_KEY', 'BOAT_API_KEY', 'E2B_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_PROFILES', 'CLOUDY_CLOUD_CODEX_AUTH', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_TURN_MINUTES', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES', 'CLOUDY_CLOUD_EGRESS_ALLOW', 'CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX', 'CLOUDY_CLOUD_E2B_TOKEN_ON_BOX'];

export const codexPrompt = (note = '') => `ALL delegation that would use a subagent must use the cloud MCP server's cloud_agent tool. Do not use Codex's own subagent or multi-agent features for work that should run in a cloud sandbox. Call cloud_agent_capabilities to discover configured worker profiles, providers and machine kinds; the configured default profile applies when profile is omitted. Use cloud_agent_recover only with a fresh user-authored message when a checkpoint is available. cloud_agent starts a worker on its own cloud machine with the repo's committed and tracked files (including uncommitted edits to tracked files), not local untracked files. Workflow: start every worker with cloud_agent first; this session cannot receive MCP task results, so call cloud_agent_wait with all agent_ids to get results and again after each cloud_agent_message. Use cloud_agent_message for follow-ups, cloud_agent_list for state and progress, and cloud_agent_stop when a worker is finished. Use the branch returned in the agent result; issue agents use cloudy-cloud/issue-<number>-<id>. Workers stay open until stopped or 60 idle minutes pass, so stop them when done. Starts are paced automatically. Each worker pushes its work to origin; nothing is copied into the local repo automatically. When a cloud_agent tool returns an error, follow its Next step and relay its Tell the user line. Never print, share, commit or send API keys, tokens or login files, or read ~/.config/cloudy-cloud into a message or file. To look at a worker, run cloudy-cloud shell <id> -- <cmd> or cloudy-cloud display <id>; a display link is a secret.${note ? ` ${note.replace(/\n/g, ' ')}` : ''}`;

export function codexHostArgs({ root, config, note = '' }) {
  const kv = (k, v) => ['-c', `mcp_servers.cloud.${k}=${v}`];
  return [
    ...kv('command', '"node"'),
    ...kv('args', JSON.stringify([join(root, 'src/server.mjs')])),
    ...kv('env', `{ CLOUDY_CLOUD_CONFIG = ${JSON.stringify(config)} }`),
    ...kv('env_vars', JSON.stringify(FORWARD)),
    ...kv('default_tools_approval_mode', '"approve"'),
    ...kv('tool_timeout_sec', '1800'),
    '-c', `developer_instructions=${JSON.stringify(codexPrompt(note))}`,
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const note = defaultWorkerNote(loadEnv());
  if (note) console.error(`  ! ${note.replace(/\n/g, '\n    ')}`);
  const r = spawnSync('codex', [...codexHostArgs({ root, config: process.env.CLOUDY_CLOUD_CONFIG, note }), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.error) {
    console.error(r.error.code === 'ENOENT' ? 'cloudy-cloud: the codex command was not found.\nNext step: install it with: npm install -g @openai/codex' : `cloudy-cloud: could not start codex: ${r.error.message}`);
    process.exit(127);
  }
  process.exit(r.status ?? (r.signal ? 128 : 1));
}
