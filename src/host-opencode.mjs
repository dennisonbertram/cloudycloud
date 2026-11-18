// `cloudy-cloud opencode [opencode args]`: starts opencode with the cloud_agent tools, for this session only.
// Everything goes through OPENCODE_CONFIG_CONTENT, which opencode merges after the user's own and the project's config, so
// nothing is written into their opencode.json. The config holds {env:NAME} references, never key values. opencode names MCP tools
// <server>_<tool>, so the tools are cloud_cloud_agent, cloud_cloud_agent_wait and so on. It has no MCP task support, so the
// cloud_agent_wait flow is the only one.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from './config.mjs';
import { MCP_TIMEOUT_MS } from './harness-opencode.mjs';

const ENV_NAMES = ['CLOUDY_CLOUD_CONFIG', 'CLOUDY_CLOUD_PROVIDER', 'INSTABOX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_PROFILES', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES'];

export const HOST_PROMPT = `ALL delegation that would use a subagent must use the cloud_cloud_agent tool: opencode's built-in task tool is disabled. Each cloud agent is a full coding agent on its own remote machine with the repo's committed and tracked files (including uncommitted edits to tracked files), not local untracked files. Workflow: start every subagent with cloud_cloud_agent first; it returns an agent_id at once and the agent works in the background. Then call cloud_cloud_agent_wait with all the agent_ids to get the results, and again after each cloud_cloud_agent_message (use it for follow-ups). Use cloud_cloud_agent_list to check state and progress, and cloud_cloud_agent_stop when an agent is finished. Agents stay open until stopped or 60 idle minutes pass, so stop them when done. Starts are paced and queued automatically, so start as many as you need at once. Workers run Claude by default; for another model or agent use the profile argument of cloud_cloud_agent (for example opencode-glm, opencode-deepseek, pi-glm, omp-glm, glm, deepseek, openrouter), never the model argument. Each agent pushes its work to origin branch cloudy-cloud/<id>; nothing is copied into the local repo automatically. Get an agent's work with git fetch origin cloudy-cloud/<id> (the result says when it was pushed). If an agent fails or disappears, whatever it pushed is still on origin cloudy-cloud/<id>. When a cloud_cloud_agent tool returns an error, follow its Next step, and relay its Tell the user line to the user when present. cloud_cloud_agent also takes machine (linux by default; android, omarchy, gpu, macos); gpu and macos need consent in the env file, so relay the error Tell the user line and do not retry. Never print, share or commit API keys or the contents of ~/.config/cloudy-cloud/env. To look at a worker, run cloudy-cloud shell <id> -- <cmd> or cloudy-cloud display <id>; a display link is a secret, never put it in a PR, issue or report.`;

export const hostConfig = (root, instructionsFile) => JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  instructions: [instructionsFile],
  permission: { task: 'deny', 'cloud_*': 'allow' },
  mcp: { cloud: { type: 'local', command: ['node', `${root}/src/server.mjs`], environment: Object.fromEntries(ENV_NAMES.map((n) => [n, `{env:${n}}`])), enabled: true } },
  experimental: { mcp_timeout: MCP_TIMEOUT_MS },
});

function main(args) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const env = loadEnv();
  const config = process.env.CLOUDY_CLOUD_CONFIG || `${process.env.HOME}/.config/cloudy-cloud/env`;
  // Only the default provider is checked here; any other provider reports its own missing settings when the server starts.
  if ((env.CLOUDY_CLOUD_PROVIDER || 'instabox') === 'instabox' && !env.INSTABOX_API_KEY) {
    console.error(`  ! cloudy-cloud is not set up yet  no Instabox API key in ${config}\n  > Run: cloudy-cloud setup`);
    return 1;
  }
  const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
  if (git('rev-parse', '--is-inside-work-tree').status !== 0) console.error("  ! This folder is not a git repository, so subagents can't start here.  run cloudy-cloud from inside a repo with a github.com origin");
  else if (!/github\.com/.test(git('remote', 'get-url', 'origin').stdout)) console.error("  ! This repo has no github.com origin, so subagents can't push their work.  add one: git remote add origin https://github.com/OWNER/REPO.git");
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-cloud-opencode-'));
  const file = join(dir, 'instructions.md');
  writeFileSync(file, HOST_PROMPT);
  const child = spawn(process.env.CLOUDY_CLOUD_OPENCODE_BIN || 'opencode', args, {
    stdio: 'inherit',
    env: { ...process.env, CLOUDY_CLOUD_CONFIG: config, OPENCODE_CONFIG_CONTENT: hostConfig(root, file) },
  });
  const done = (code) => { rmSync(dir, { recursive: true, force: true }); process.exit(code); };
  child.on('error', (e) => { console.error(e.code === 'ENOENT' ? '  ! opencode is not installed.  Run: npm install -g opencode-ai' : `  ! could not start opencode: ${e.message}`); done(1); });
  child.on('exit', (code, sig) => done(code ?? (sig ? 1 : 0)));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => {}); // opencode gets the same signal from the terminal; exit with it
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const c = main(process.argv.slice(2)); if (c) process.exit(c); }
