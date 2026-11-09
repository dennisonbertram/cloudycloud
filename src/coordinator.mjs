// Cloud coordinators: long-lived Claude Code sessions on their own Instabox machines.
// Usage: node coordinator.mjs image [--save] | start NAME --repo URL [--branch B] | attach NAME | ls | stop NAME
import { readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROVIDER_KEY } from './config.mjs';
import { attachGithubToken } from './instabox.mjs';
import { coordinatorHelp } from './cli-help.mjs';
import { terminal } from './terminal.mjs';

const TEMPLATE = 'agent-browser';
const SNAPSHOT_KEY = 'CLAUDE_CLOUD_COORDINATOR_SNAPSHOT';
const SECRET_KEYS = ['INSTABOX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;
const SETUP_MS = 600_000;
const SSH = (machine, rest) => `npx --yes instabox@latest ssh ${machine}${rest ? ` -- ${rest}` : ''}`;
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const fail = (msg) => { throw new Error(msg); };

// Saves NAME=value in the config file: temp file in the same folder (mode 600), then rename.
function saveKey(file, name, value) {
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${name}=`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  writeFileSync(tmp, `${[...lines, `${name}=${value}`].join('\n')}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// The repo URL of claude-cloud itself, as an https URL (git clone on the machine goes through the GH_TOKEN proxy).
function toolRepoUrl(root) {
  const u = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = u.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}.git` : u;
}

// Everything the commands need, injectable for tests.
function context(deps) {
  const env = deps.env ?? loadEnv();
  const apiKey = env.INSTABOX_API_KEY || fail('INSTABOX_API_KEY is not set. Run install.sh first.');
  const configFile = env.CLAUDE_CLOUD_CONFIG || join(homedir(), '.config/claude-cloud/env');
  const out = deps.out ?? ((s) => console.log(s));
  const root = deps.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return { env, apiKey, configFile, out, root, fetchFn: deps.fetchFn ?? fetch, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    getSdk: async () => deps.sdk ?? (await import('@insforge/instabox-sdk')) };
}

const find = async (Sandbox, apiKey, role, name) =>
  (await Sandbox.list({ apiKey, metadata: { role, ...(name && { name }) } }))
    .filter((m) => m.metadata?.role === role && (!name || m.metadata?.name === name));

// Installs or updates claude-cloud on the machine and sets up git's GitHub login. Returns the home folder.
async function installTool(sbx, root) {
  const run = (cmd, opts) => sbx.commands.run(cmd, { timeoutMs: SETUP_MS, ...opts });
  const home = (await run('printf %s "$HOME"')).stdout.trim() || fail('Could not read $HOME on the machine.');
  await run(`command -v tmux >/dev/null || { sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux; } >/dev/null 2>&1; command -v tmux >/dev/null || { echo 'tmux is not installed on the machine' >&2; exit 1; }`);
  await run('gh auth setup-git'); // before any clone, so git uses the GH_TOKEN placeholder
  await run(`if [ -d ~/claude-cloud/.git ]; then git -C ~/claude-cloud pull --ff-only -q; else git clone -q ${q(toolRepoUrl(root))} ~/claude-cloud; fi && cd ~/claude-cloud && npm install --no-audit --no-fund`);
  return home;
}

async function image(c, args) {
  const { Sandbox } = await c.getSdk();
  const existing = await find(Sandbox, c.apiKey, 'coordinator-image');
  if (!args.includes('--save')) {
    if (existing.length) fail(`An image machine already exists (${existing[0].name}). Finish it with: claude-cloud coordinator image --save`);
    const sbx = await Sandbox.create(TEMPLATE, { apiKey: c.apiKey, metadata: { purpose: 'claude-cloud', role: 'coordinator-image' }, autoSuspendMs: 0 });
    try {
      await attachGithubToken(sbx.sandboxId, c.apiKey, c.fetchFn);
      await installTool(sbx, c.root);
    } catch (e) { await sbx.kill().catch(() => {}); throw e; }
    const info = await sbx.getInfo();
    c.out(`Image machine ${info.name} is ready and claude-cloud is installed on it.\n\nNow sign in to Claude on it (a setup-token cannot open Remote Control sessions):\n\n  1. ${SSH(info.name, '')}`.trimEnd() +
      `\n  2. In that shell run: claude auth login\n  3. Finish the browser sign-in, then leave the shell.\n  4. Run: claude-cloud coordinator image --save`);
    return;
  }
  const [img] = existing.sort((a, b) => b.startedAt - a.startedAt);
  if (!img) fail('No image machine found. Run: claude-cloud coordinator image');
  const sbx = await Sandbox.connect(img.sandboxId, { apiKey: c.apiKey });
  let snap = await sbx.createSnapshot({ name: `claude-cloud-coordinator-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`, description: 'claude-cloud coordinator image' });
  for (let n = 0; snap.status === 'pending'; n++) {
    if (n > 120) fail(`Snapshot ${snap.id} is still being saved. The image machine was kept; run --save again later.`);
    await c.sleep(5000);
    snap = await Sandbox.getSnapshot(snap.id, { apiKey: c.apiKey });
  }
  if (snap.status && snap.status !== 'ready') fail(`Snapshot ${snap.id} has status ${snap.status}. The image machine was kept.`);
  saveKey(c.configFile, SNAPSHOT_KEY, snap.id);
  await sbx.kill();
  c.out(`Saved snapshot ${snap.id} as ${SNAPSHOT_KEY} in ${c.configFile} and deleted the image machine.\nStart a coordinator with: claude-cloud coordinator start NAME --repo https://github.com/OWNER/REPO`);
}

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function validateArgs(cmd, args) {
  const usage = `Run: claude-cloud coordinator ${cmd} --help`;
  const invalid = (message) => fail(`${message}\n${usage}`);
  if (cmd === 'image') {
    if (args.length && !(args.length === 1 && args[0] === '--save')) invalid('Expected image or image --save.');
    return;
  }
  if (cmd === 'ls') {
    if (args.length) invalid('ls takes no arguments.');
    return;
  }
  if (!NAME_RE.test(args[0] ?? '')) invalid('NAME must use lowercase letters, digits and hyphens (1–40 characters).');
  if (cmd !== 'start') {
    if (args.length !== 1) invalid(`${cmd} takes exactly one NAME.`);
    return;
  }
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const option = args[i];
    if (!['--repo', '--branch'].includes(option)) invalid(`Unknown argument: ${option}`);
    if (seen.has(option)) invalid(`Repeated option: ${option}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) invalid(`Missing value for ${option}.`);
    seen.add(option);
  }
  const repo = flag(args, '--repo');
  if (!repo || !REPO_RE.test(repo)) invalid('--repo must be a github.com https URL, for example https://github.com/OWNER/REPO');
  const branch = flag(args, '--branch');
  if (branch && !/^[\w./-]+$/.test(branch)) invalid('--branch has characters that are not allowed.');
}

// What goes in the coordinator's own env file: the Instabox key, the Claude setup-token and provider keys.
function keysFile(env) {
  return `${Object.entries(env).filter(([k, v]) => v && (SECRET_KEYS.includes(k) || PROVIDER_KEY.test(k)))
    .map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

async function start(c, args) {
  const name = args[0];
  if (!name || !NAME_RE.test(name)) fail('Usage: claude-cloud coordinator start NAME --repo <github https url> [--branch B]\nNAME: lowercase letters, digits and -, up to 40 characters.');
  const repo = flag(args, '--repo');
  if (!repo || !REPO_RE.test(repo)) fail('--repo must be a github.com https URL, for example https://github.com/OWNER/REPO');
  const branch = flag(args, '--branch');
  if (branch && !/^[\w./-]+$/.test(branch)) fail('--branch has characters that are not allowed.');
  const snapshot = c.env[SNAPSHOT_KEY];
  if (!snapshot) fail('No coordinator image yet. Run: claude-cloud coordinator image');
  const { Sandbox } = await c.getSdk();
  if ((await find(Sandbox, c.apiKey, 'coordinator', name)).length) fail(`A coordinator named ${name} already exists. Stop it first: claude-cloud coordinator stop ${name}`);
  const sbx = await Sandbox.create(snapshot, { apiKey: c.apiKey, name: `coord-${name}`, autoSuspendMs: 0,
    metadata: { purpose: 'claude-cloud', role: 'coordinator', name } });
  try {
    await attachGithubToken(sbx.sandboxId, c.apiKey, c.fetchFn);
    const home = await installTool(sbx, c.root);
    const dir = `${home}/.config/claude-cloud`;
    await sbx.commands.run(`mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`);
    await sbx.files.write(`${dir}/env`, keysFile(c.env)); // values never appear in a command string
    await sbx.commands.run(`chmod 600 ${q(`${dir}/env`)}`);
    await sbx.commands.run(`rm -rf ~/repo && git clone -q ${branch ? `-b ${q(branch)} ` : ''}${q(repo)} ~/repo`, { timeoutMs: SETUP_MS });
    await sbx.commands.run(`tmux kill-session -t claude 2>/dev/null; tmux new-session -d -s claude -c ~/repo ${q(`env CLAUDE_CLOUD_COORDINATOR=1 ${home}/claude-cloud/bin/claude-cloud --remote-control ${q(name)}`)}`);
  } catch (e) { await sbx.kill().catch(() => {}); throw e; }
  const machine = (await sbx.getInfo()).name;
  c.out(`Coordinator ${name} is running on machine ${machine}. It never pauses.\n\nReach it:\n  - Remote Control: open claude.ai/code or the Claude app and pick the session named "${name}".\n` +
    `  - Terminal: claude-cloud coordinator attach ${name}\n    (runs: ${SSH(machine, 'tmux attach -t claude')})\n\nThe first time, attach once and accept any trust or Remote Control prompts.\nStop it with: claude-cloud coordinator stop ${name}`);
}

async function attach(c, args) {
  const [m] = await find((await c.getSdk()).Sandbox, c.apiKey, 'coordinator', args[0] || fail('Usage: claude-cloud coordinator attach NAME'));
  if (!m) fail(`No coordinator named ${args[0]}. List them with: claude-cloud coordinator ls`);
  c.out(SSH(m.name, 'tmux attach -t claude'));
}

async function ls(c) {
  const rows = await find((await c.getSdk()).Sandbox, c.apiKey, 'coordinator');
  if (!rows.length) return c.out('No coordinators.');
  c.out(['NAME', 'STATE', 'CREATED', 'MACHINE'].join('\t'));
  for (const m of rows) c.out([m.metadata.name, m.state, new Date(m.startedAt).toISOString(), m.name].join('\t'));
}

async function stop(c, args) {
  const name = args[0] || fail('Usage: claude-cloud coordinator stop NAME');
  const { Sandbox } = await c.getSdk();
  const [m] = await find(Sandbox, c.apiKey, 'coordinator', name);
  if (!m) fail(`No coordinator named ${name}. List them with: claude-cloud coordinator ls`);
  await Sandbox.kill(m.sandboxId, { apiKey: c.apiKey });
  c.out(`Deleted coordinator ${name} (machine ${m.name}). Workers it started are deleted by its own claude-cloud cleanup process when its session ends; check with: npx --yes instabox@latest ls --meta purpose=claude-cloud`);
}

export async function main(argv, deps = {}) {
  const [cmd, ...args] = argv;
  const commands = { image, start, attach, ls, stop };
  if ((['--help', '-h'].includes(cmd) && !args.length) || (Object.hasOwn(commands, cmd) && args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    return (deps.out ?? console.log)(coordinatorHelp(Object.hasOwn(commands, cmd) ? cmd : undefined, deps.ui ?? terminal()));
  }
  if (!Object.hasOwn(commands, cmd)) fail('Usage: claude-cloud coordinator <command>\nRun: claude-cloud coordinator --help');
  validateArgs(cmd, args);
  return commands[cmd](context(deps), args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`claude-cloud: ${e.message}`); process.exit(1); });
}
