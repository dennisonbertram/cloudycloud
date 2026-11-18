// `cloudy-cloud pi [pi args]` and `cloudy-cloud free-pi [free-pi-cli args]`: start pi or free-pi as the main session with the
// cloud_agent tools. pi gets them from a per-session extension that registers `node src/server.mjs` as an MCP server over stdio
// (the handlers do not run inside pi). free-pi-cli takes no extension flag, so the same server is registered in its own mcp.json
// (~/.free-pi/agent) under the name cloudy-cloud, which leaves a user's own `cloud` server alone.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultWorkerNote, loadEnv } from './config.mjs';
import { PI_VERSION } from './profiles.mjs';

// Pinned like the workers' installs. free-pi-cli updates itself in place when its server blocks an old version.
const FREE_PI_VERSION = '0.6.23';

export const HOST_PROMPT = 'You are the main session of Cloudy Cloud. Delegate coding work to cloud agents with the cloud_agent tools (mcp__cloud__cloud_agent and its siblings), and do not run long jobs yourself. Each cloud agent is a full coding agent on its own cloud machine with the repo\'s committed and tracked files; it pushes its work to origin branch cloudy-cloud/<id>, and nothing is copied into this repo. For a non-Claude model pass the profile argument to cloud_agent (pi-particle, pi-glm, pi-deepseek, omp-particle, omp-glm, omp-deepseek, particle, glm, deepseek, openrouter), never the model argument. Start every agent with cloud_agent; it returns at once. Then call cloud_agent_wait with all the agent_ids to get results, and again after each cloud_agent_message. Use cloud_agent_message for follow-ups, cloud_agent_list to check progress, and cloud_agent_stop when an agent is finished; agents stay open for 60 idle minutes, so stop them when done. Starts are paced and queued automatically, so start as many as you need at once. Get an agent\'s work with git fetch origin cloudy-cloud/<id>. When a cloud_agent tool returns an error, follow its Next step and relay its Tell the user line. Keys stay private: never print, read, share or commit anything from ~/.config/cloudy-cloud/env, and never put a key in a prompt to an agent.';

export const onPath = (name, env = process.env) => String(env.PATH ?? '').split(delimiter).filter(Boolean).some((d) => { try { accessSync(join(d, name), constants.X_OK); return true; } catch { return false; } });

// '' when the saved settings are enough to start cloud agents. No Claude token is needed: profile workers use their own key.
export function missingSetup(env) {
  if (env.CLOUDY_CLOUD_PROVIDER === 'self-hosted') return env.CLOUDY_CLOUD_SELF_HOSTED_LOCAL === '1' || env.CLOUDY_CLOUD_SSH_HOST ? '' : 'self-hosted machine (CLOUDY_CLOUD_SSH_HOST)';
  if (env.CLOUDY_CLOUD_PROVIDER === 'microsandbox') return env.CLOUDY_CLOUD_MSB_BIN ? '' : 'microsandbox CLI (CLOUDY_CLOUD_MSB_BIN)';
  return env.INSTABOX_API_KEY ? '' : 'Instabox API key';
}

// -> { setup?: { cmd, args }, run: { cmd, args } }. Argument arrays only, nothing goes through a shell.
export function hostPlan(agent, { root, env, args, note = '', onPath: has = onPath }) {
  const server = `${root}/src/server.mjs`;
  if (agent === 'pi') {
    const pre = ['-e', `${root}/src/host-pi-extension.mjs`, '--append-system-prompt', note ? `${HOST_PROMPT} ${note.replace(/\n/g, ' ')}` : HOST_PROMPT, ...args];
    return { run: has('pi', env) ? { cmd: 'pi', args: pre } : { cmd: 'npx', args: ['--yes', `@earendil-works/pi-coding-agent@${PI_VERSION}`, ...pre] } };
  }
  const bin = has('free-pi-cli', env) ? { cmd: 'free-pi-cli', pre: [] } : { cmd: 'npx', pre: ['--yes', `free-pi-cli@${FREE_PI_VERSION}`] };
  // free-pi-cli has no prompt flag; the server's `description` is shown in its system prompt, so the profile hint goes there.
  const description = `Cloudy Cloud: start coding agents on their own cloud machines. Start with cloud_agent, get results with cloud_agent_wait, stop with cloud_agent_stop.${note ? ` ${note.replace(/\n/g, ' ')}` : ''}`;
  // timeout is in seconds (pi's mcp-servers schema; default 60): cloud_agent_wait can block for 1,500 s.
  return { register: { name: FREE_PI_SERVER, entry: { command: 'node', args: [server], ...(env.CLOUDY_CLOUD_CONFIG && { env: { CLOUDY_CLOUD_CONFIG: env.CLOUDY_CLOUD_CONFIG } }), exposure: 'direct', timeout: 1800, description } }, run: { cmd: bin.cmd, args: [...bin.pre, ...args] } };
}

export const FREE_PI_SERVER = 'cloudy-cloud';
export const freePiFile = () => join(homedir(), '.free-pi/agent/mcp.json');
// Adds or updates our server in free-pi's mcp.json and leaves every other entry as it was. An entry of the same name that differs
// in anything but its description is not ours to replace. Returns {} or { error }.
export function registerFreePi(file, name, entry) {
  let j = {};
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return { error: `Could not read ${file}: ${e.message}\nNext step: fix or remove that file, then run cloudy-cloud free-pi again.` }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || (j.mcpServers !== undefined && (typeof j.mcpServers !== 'object' || !j.mcpServers || Array.isArray(j.mcpServers)))) return { error: `${file} is not a free-pi MCP file (expected an object with mcpServers).\nNext step: fix or remove that file, then run cloudy-cloud free-pi again.` };
  const old = j.mcpServers?.[name];
  const same = (x) => JSON.stringify({ ...x, description: undefined }) === JSON.stringify({ ...entry, description: undefined });
  if (old !== undefined && !same(old)) return { error: `${file} already has a server named ${name} that cloudy-cloud did not write (or that points at another install).\nNext step: run: free-pi-cli mcp remove ${name}, then run cloudy-cloud free-pi again.` };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...j, mcpServers: { ...j.mcpServers, [name]: entry } }, null, 2)}\n`, { mode: 0o600 });
  return {};
}

function main(agent, args) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!['pi', 'free-pi'].includes(agent)) { console.error('usage: cloudy-cloud pi|free-pi [args]'); return 2; }
  const env = loadEnv();
  const missing = missingSetup(env);
  if (missing) { console.error(`cloudy-cloud is not set up yet: no ${missing} in ${process.env.CLOUDY_CLOUD_CONFIG || '~/.config/cloudy-cloud/env'}\n  Next step: run cloudy-cloud setup`); return 1; }
  const note = defaultWorkerNote(env);
  if (note) console.error(`  ! ${note.replace(/\n/g, '\n    ')}`);
  const plan = hostPlan(agent, { root, env: process.env, args, note });
  if (plan.register) {
    const r = registerFreePi(freePiFile(), plan.register.name, plan.register.entry);
    if (r.error) { console.error(r.error); return 1; }
  }
  const r = spawnSync(plan.run.cmd, plan.run.args, { stdio: 'inherit', env: { ...process.env, CLOUDY_CLOUD_BIN: join(root, 'bin/cloudy-cloud') } });
  if (r.error) { console.error(`Could not start ${plan.run.cmd}: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2], process.argv.slice(3)));
