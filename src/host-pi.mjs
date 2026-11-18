// `cloudy-cloud pi [pi args]` and `cloudy-cloud free-pi [free-pi-cli args]`: start pi or free-pi as the main session with the
// cloud_agent tools. pi gets them from a per-session extension; free-pi-cli takes no extension flag, so the server is
// registered in its own mcp.json (~/.free-pi/agent) with `free-pi-cli mcp add`, which replaces the entry on every start.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { PI_VERSION } from './profiles.mjs';

// Pinned like the workers' installs. free-pi-cli updates itself in place when its server blocks an old version.
const FREE_PI_VERSION = '0.6.23';

export const HOST_PROMPT = 'You are the main session of Cloudy Cloud. Delegate coding work to cloud agents with the cloud_agent tools (mcp__cloud__cloud_agent and its siblings), and do not run long jobs yourself. Each cloud agent is a full coding agent on its own cloud machine with the repo\'s committed and tracked files; it pushes its work to origin branch cloudy-cloud/<id>, and nothing is copied into this repo. For a non-Claude model pass the profile argument to cloud_agent (pi-particle, pi-glm, pi-deepseek, omp-particle, omp-glm, omp-deepseek, particle, glm, deepseek, openrouter), never the model argument. Start every agent with cloud_agent; it returns at once. Then call cloud_agent_wait with all the agent_ids to get results, and again after each cloud_agent_message. Use cloud_agent_message for follow-ups, cloud_agent_list to check progress, and cloud_agent_stop when an agent is finished; agents stay open for 60 idle minutes, so stop them when done. Starts are paced and queued automatically, so start as many as you need at once. Get an agent\'s work with git fetch origin cloudy-cloud/<id>. When a cloud_agent tool returns an error, follow its Next step and relay its Tell the user line. Keys stay private: never print, read, share or commit anything from ~/.config/cloudy-cloud/env, and never put a key in a prompt to an agent.';

export const onPath = (name, env = process.env) => String(env.PATH ?? '').split(delimiter).filter(Boolean).some((d) => { try { accessSync(join(d, name), constants.X_OK); return true; } catch { return false; } });

// '' when the saved settings are enough to start cloud agents. No Claude token is needed: profile workers use their own key.
export function missingSetup(env) {
  if (env.CLOUDY_CLOUD_PROVIDER === 'self-hosted') return env.CLOUDY_CLOUD_SELF_HOSTED_LOCAL === '1' || env.CLOUDY_CLOUD_SSH_HOST ? '' : 'self-hosted machine (CLOUDY_CLOUD_SSH_HOST)';
  return env.INSTABOX_API_KEY ? '' : 'Instabox API key';
}

// -> { setup?: { cmd, args }, run: { cmd, args } }. Argument arrays only, nothing goes through a shell.
export function hostPlan(agent, { root, env, args, onPath: has = onPath }) {
  const server = `${root}/src/server.mjs`;
  if (agent === 'pi') {
    const pre = ['-e', `${root}/src/host-pi-extension.mjs`, '--append-system-prompt', HOST_PROMPT, ...args];
    return { run: has('pi', env) ? { cmd: 'pi', args: pre } : { cmd: 'npx', args: ['--yes', `@earendil-works/pi-coding-agent@${PI_VERSION}`, ...pre] } };
  }
  const bin = has('free-pi-cli', env) ? { cmd: 'free-pi-cli', pre: [] } : { cmd: 'npx', pre: ['--yes', `free-pi-cli@${FREE_PI_VERSION}`] };
  const cfg = ['--env', `CLOUDY_CLOUD_CONFIG=${env.CLOUDY_CLOUD_CONFIG ?? ''}`];
  return {
    setup: { cmd: bin.cmd, args: [...bin.pre, 'mcp', 'add', 'cloud', '--exposure', 'direct', '--description', 'Cloudy Cloud: start coding agents on their own cloud machines. Start with cloud_agent, get results with cloud_agent_wait, stop with cloud_agent_stop.', ...(env.CLOUDY_CLOUD_CONFIG ? cfg : []), '--', 'node', server] },
    run: { cmd: bin.cmd, args: [...bin.pre, ...args] },
  };
}

function main(agent, args) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!['pi', 'free-pi'].includes(agent)) { console.error('usage: cloudy-cloud pi|free-pi [args]'); return 2; }
  const env = loadEnv();
  const missing = missingSetup(env);
  if (missing) { console.error(`cloudy-cloud is not set up yet: no ${missing} in ${process.env.CLOUDY_CLOUD_CONFIG || '~/.config/cloudy-cloud/env'}\n  Next step: run cloudy-cloud setup`); return 1; }
  const plan = hostPlan(agent, { root, env: process.env, args });
  if (plan.setup) {
    const s = spawnSync(plan.setup.cmd, plan.setup.args, { stdio: ['ignore', 'ignore', 'inherit'] });
    if (s.status !== 0) { console.error(`Could not register the cloud tools with ${agent}. Next step: run ${plan.setup.cmd} --version, then retry cloudy-cloud ${agent}.`); return 1; }
  }
  const r = spawnSync(plan.run.cmd, plan.run.args, { stdio: 'inherit', env: { ...process.env, CLOUDY_CLOUD_BIN: join(root, 'bin/cloudy-cloud') } });
  if (r.error) { console.error(`Could not start ${plan.run.cmd}: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2], process.argv.slice(3)));
