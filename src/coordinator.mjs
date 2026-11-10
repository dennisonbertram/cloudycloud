// Cloud coordinators: long-lived Claude Code sessions on their own cloud machines.
// Usage: node coordinator.mjs image [--save] | start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--json] | attach NAME | ls | stop NAME | finish [--force]
import { readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ownerFile, PROVIDER_KEY } from './config.mjs';
import { toolBundle, toolInstallCmd } from './toolbundle.mjs';
import { loadProvider } from './providers/index.mjs';
import { makeUi } from './ui.mjs';
import { coordinatorHelp } from './cli-help.mjs';
import { safeText } from './terminal.mjs';
import { redact } from './events.mjs';

const TEMPLATE = 'agent-browser';
const SNAPSHOT_KEY = 'CLOUDY_CLOUD_COORDINATOR_SNAPSHOT';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;
const SETUP_MS = 600_000;
const TASK_MAX = 100_000; // bytes
const IMAGE_SECONDS = 2 * 3600;
const deadlineLine = (iso) => `Your machine is deleted by the server at ${iso}; push your work well before then.`;
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

// The GitHub URL of cloudy-cloud itself, kept as `origin` on the machine for reference only (empty if there is none).
function toolRepoUrl(root) {
  let u;
  try { u = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(); } catch { return ''; }
  const m = u.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/);
  const url = m ? `https://github.com/${m[1]}.git` : u;
  return REPO_RE.test(url) ? url : ''; // goes into a quoted shell word
}

// Everything the commands need, injectable for tests.
async function context(deps) {
  const env = deps.env ?? loadEnv();
  const configFile = env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env');
  const out = deps.out ?? ((s) => console.log(s));
  const root = deps.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Progress for slow steps goes to stderr, and only on a terminal, so piped output stays clean.
  const stderr = deps.stderr ?? process.stderr;
  const ui = deps.ui ?? makeUi();
  const progress = (message) => { if (stderr.isTTY) stderr.write(`${ui.hint(message)}\n`); };
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const provider = deps.provider ?? await loadProvider(env, { fetchFn: deps.fetchFn, sdk: deps.sdk, sleep });
  return { env, provider, configFile, out, root, progress, ui, sleep, ssh: provider.text.ssh };
}

const find = async (provider, role, name) =>
  (await provider.list({ role, ...(name && { name }) }, { sdk: true })).filter((m) => m.labels?.role === role && (!name || m.labels?.name === name));

// Installs or updates cloudy-cloud on the machine and sets up git's GitHub login. Returns the home folder.
// Marks Claude Code's first-run screens as done in ~/.claude.json and trusts ~/repo. Keys found live on a coordinator.
const MARK_FIRST_RUN_DONE = `const fs=require('fs'),f=process.env.HOME+'/.claude.json';
const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
Object.assign(j,{hasCompletedOnboarding:true,theme:j.theme||'dark',hasSeenAutoDefaultNotice:true,fullscreenUpsellSeenCount:Math.max(3,j.fullscreenUpsellSeenCount||0)});
const p=process.env.HOME+'/repo';j.projects=j.projects||{};
j.projects[p]={...(j.projects[p]||{}),hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};
fs.writeFileSync(f,JSON.stringify(j,null,2),{mode:0o600});`;

async function installTool(sbx, root) {
  const run = (cmd, opts) => sbx.commands.run(cmd, { timeoutMs: SETUP_MS, ...opts });
  const home = (await run('printf %s "$HOME"')).stdout.trim() || fail('Could not read $HOME on the machine.');
  await run(`command -v tmux >/dev/null || { sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux; } >/dev/null 2>&1; command -v tmux >/dev/null || { echo 'tmux is not installed on the machine' >&2; exit 1; }`);
  await run('gh auth setup-git'); // before the work-repo clone, so git uses the GH_TOKEN placeholder
  // A fresh machine has no git identity, which the coordinator needs to commit merges and its report. Use the laptop's.
  const ident = (k, d) => { try { return execFileSync('git', ['-C', root, 'config', k], { encoding: 'utf8' }).trim() || d; } catch { return d; } };
  await run(`git config --global user.name ${q(`${ident('user.name', 'cloudy-cloud')} (coordinator)`)} && git config --global user.email ${q(ident('user.email', 'cloudy-cloud@localhost'))}`);
  // Upload this checkout (HEAD plus uncommitted tracked edits) so the machine runs exactly this version, pushed or not.
  const b = toolBundle(root);
  await sbx.files.write(`${home}/cloudy-cloud.bundle`, b.data);
  await run(`${toolInstallCmd(b, `${home}/cloudy-cloud.bundle`, toolRepoUrl(root))} && npm install --no-audit --no-fund`, { cwd: home });
  return home;
}

async function image(c, args) {
  const existing = await find(c.provider, 'coordinator-image');
  if (!args.includes('--save')) {
    if (existing.length) fail(`An image machine already exists (${existing[0].name}). Finish it with: cloudy-cloud coordinator image --save`);
    c.progress('Creating the image machine...');
    const sbx = await c.provider.create({ image: TEMPLATE, labels: { purpose: 'cloudy-cloud', role: 'coordinator-image' }, ttlSeconds: IMAGE_SECONDS, neverSuspend: true });
    try {
      c.progress('Connecting GitHub and installing tools (this can take a few minutes)...');
      await installTool(sbx, c.root);
    } catch (e) { await sbx.kill().catch(() => {}); throw e; }
    const info = { name: sbx.name };
    if (c.ui.on) return c.out([c.ui.ok(`Image machine ${info.name} is ready`, 'cloudy-cloud is installed on it'), '',
      c.ui.block('Now sign in to Claude on it', [['1', c.ssh(info.name, '')], ['2', 'In that shell run: claude auth login'], ['3', 'Finish the browser sign-in, then leave the shell']]), '',
      c.ui.hint('A setup-token cannot open Remote Control sessions, so this sign-in is needed.'), c.ui.hint('Then run: cloudy-cloud coordinator image --save')].join('\n'));
    c.out(`Image machine ${info.name} is ready and cloudy-cloud is installed on it.\n\nNow sign in to Claude on it (a setup-token cannot open Remote Control sessions):\n\n  1. ${c.ssh(info.name, '')}`.trimEnd() +
      `\n  2. In that shell run: claude auth login\n  3. Finish the browser sign-in, then leave the shell.\n  4. Run: cloudy-cloud coordinator image --save`);
    return;
  }
  const [img] = existing.sort((a, b) => b.startedAt - a.startedAt);
  if (!img) fail('No image machine found. Run: cloudy-cloud coordinator image');
  const sbx = await c.provider.connect(img.id);
  c.progress('Saving the image snapshot...');
  let snap = await c.provider.snapshot(sbx, { name: `cloudy-cloud-coordinator-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`, description: 'cloudy-cloud coordinator image' });
  for (let n = 0; snap.status === 'pending'; n++) {
    if (n > 120) fail(`Snapshot ${snap.id} is still being saved. The image machine was kept; run --save again later.`);
    await c.sleep(5000);
    snap = await c.provider.getSnapshot(snap.id);
  }
  if (snap.status && snap.status !== 'ready') fail(`Snapshot ${snap.id} has status ${snap.status}. The image machine was kept.`);
  saveKey(c.configFile, SNAPSHOT_KEY, snap.id);
  await sbx.kill();
  if (c.ui.on) return c.out([c.ui.ok(`Saved snapshot ${snap.id}`, 'the image machine is deleted'), c.ui.hint(`Saved as ${SNAPSHOT_KEY} in ${c.configFile}`),
    c.ui.hint('Start a coordinator with: cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO')].join('\n'));
  c.out(`Saved snapshot ${snap.id} as ${SNAPSHOT_KEY} in ${c.configFile} and deleted the image machine.\nStart a coordinator with: cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO`);
}

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// What goes in the coordinator's own env file: the provider key, the Claude setup-token and provider keys.
function keysFile(env, keyName) {
  return `${Object.entries(env).filter(([k, v]) => v && ([keyName, 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k) || PROVIDER_KEY.test(k)))
    .map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

async function start(c, args) {
  const name = args[0];
  if (!name || !NAME_RE.test(name)) fail('Usage: cloudy-cloud coordinator start NAME --repo <github https url> [--branch B]\nNAME: lowercase letters, digits and -, up to 40 characters.');
  const repo = flag(args, '--repo');
  if (!repo || !REPO_RE.test(repo)) fail('--repo must be a github.com https URL, for example https://github.com/OWNER/REPO');
  const branch = flag(args, '--branch');
  if (branch && !/^[\w./-]+$/.test(branch)) fail('--branch has characters that are not allowed.');
  const taskFile = flag(args, '--task-file');
  const task = taskFile ? readFileSync(taskFile, 'utf8') : flag(args, '--task');
  if (task !== undefined) {
    if (!task.trim()) fail('The task is empty.');
    if (Buffer.byteLength(task) > TASK_MAX) fail(`The task is larger than ${TASK_MAX / 1000} KB.`);
  }
  const maxHours = c.provider.caps.maxTtlSeconds / 3600;
  const hours = flag(args, '--max-hours') === undefined ? maxHours : Number(flag(args, '--max-hours'));
  const seconds = Math.round(hours * 3600);
  if (!(seconds >= 60 && seconds <= maxHours * 3600)) fail(`--max-hours must be a number up to ${maxHours} (${c.provider.name[0].toUpperCase()}${c.provider.name.slice(1)} deletes a machine after at most ${maxHours} hours).`);
  const deleteAt = new Date(Date.now() + seconds * 1000).toISOString();
  const snapshot = c.env[SNAPSHOT_KEY];
  if (!snapshot) fail('No coordinator image yet. Run: cloudy-cloud coordinator image');
  if ((await find(c.provider, 'coordinator', name)).length) fail(`A coordinator named ${name} already exists. Stop it first: cloudy-cloud coordinator stop ${name}`);
  c.progress('Creating the coordinator machine...');
  const sbx = await c.provider.create({ image: snapshot, name: `coord-${name}`, labels: { purpose: 'cloudy-cloud', role: 'coordinator', name }, ttlSeconds: seconds, neverSuspend: true });
  try {
    c.progress('Connecting GitHub and installing tools (this can take a few minutes)...');
    const home = await installTool(sbx, c.root);
    const dir = `${home}/.config/cloudy-cloud`;
    await sbx.commands.run(`mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`);
    await sbx.files.write(`${dir}/env`, keysFile(c.env, c.provider.keyName)); // values never appear in a command string
    await sbx.commands.run(`chmod 600 ${q(`${dir}/env`)}`);
    c.progress('Cloning the repository...');
    await sbx.commands.run(`rm -rf ~/repo && git clone -q ${branch ? `-b ${q(branch)} ` : ''}${q(repo)} ~/repo`, { timeoutMs: SETUP_MS });
    c.progress('Starting the Claude session...');
    // Claude Code shows first-run screens (theme, login method, trust, notices) that nobody can answer on an unattended
    // machine, and they block Remote Control. The login itself is in the snapshot; mark the rest done.
    await sbx.commands.run(`node -e ${q(MARK_FIRST_RUN_DONE)}`);
    // Give the coordinator's Claude the fleet skill from this laptop, so it matches the instructions the local Claude has.
    const skillDir = join(c.root, 'skills', 'cloud-fleet');
    for (const f of readdirSync(skillDir)) await sbx.files.write(`${home}/.claude/skills/cloud-fleet/${f}`, readFileSync(join(skillDir, f)));
    // The task text goes up as a file, never in a command string; the shell in tmux reads it when Claude starts.
    if (task !== undefined) await sbx.files.write(`${home}/task.md`, `${deadlineLine(deleteAt)}\n\n${task}`);
    const prompt = task !== undefined ? ` "$(cat ${q(`${home}/task.md`)})"` : '';
    await sbx.commands.run(`tmux kill-session -t claude 2>/dev/null; tmux new-session -d -s claude -c ~/repo ${q(`env CLOUDY_CLOUD_COORDINATOR=1 CLOUDY_CLOUD_DELETE_AT=${deleteAt} ${home}/cloudy-cloud/bin/cloudy-cloud --remote-control ${q(name)}${prompt}`)}`);
  } catch (e) { await sbx.kill().catch(() => {}); throw e; }
  const machine = sbx.name;
  if (args.includes('--json')) return c.out(JSON.stringify({ name, machine, remoteControlName: name, attach: c.ssh(machine, 'tmux attach -t claude') }));
  if (c.ui.on) {
    const u = c.ui;
    return c.out([u.ok(`Coordinator ${name} is running`, `machine ${machine}${task !== undefined ? ', started on the task' : ''}`),
      u.hint(`It never pauses. The server deletes it ${u.rel(deleteAt)} (${deleteAt.slice(0, 16)}Z).`), '',
      u.block('Reach it', [['Remote Control', `open claude.ai/code or the Claude app, pick "${name}"`],
        ['Terminal', `cloudy-cloud coordinator attach ${name}`, `runs: ${c.ssh(machine, 'tmux attach -t claude')}`]]), '',
      u.hint('The first time, attach once and accept any trust or Remote Control prompts.'),
      u.hint(`Stop it earlier with: cloudy-cloud coordinator stop ${name}`)].join('\n'));
  }
  c.out(`Coordinator ${name} is running on machine ${machine}${task !== undefined ? ' and has started on the task' : ''}. It never pauses. The server deletes it at ${deleteAt}.\n\nReach it:\n  - Remote Control: open claude.ai/code or the Claude app and pick the session named "${name}".\n` +
    `  - Terminal: cloudy-cloud coordinator attach ${name}\n    (runs: ${c.ssh(machine, 'tmux attach -t claude')})\n\nThe first time, attach once and accept any trust or Remote Control prompts.\nStop it earlier with: cloudy-cloud coordinator stop ${name}`);
}

async function attach(c, args) {
  const [m] = await find(c.provider, 'coordinator', args[0] || fail('Usage: cloudy-cloud coordinator attach NAME'));
  if (!m) fail(`No coordinator named ${args[0]}. List them with: cloudy-cloud coordinator ls`);
  c.out(c.ssh(m.name, 'tmux attach -t claude'));
}

async function ls(c) {
  const rows = await find(c.provider, 'coordinator');
  if (!rows.length) {
    if (!c.ui.on) return c.out('No coordinators.');
    return c.out([c.ui.warn('No coordinators yet'),
      c.ui.hint(c.env[SNAPSHOT_KEY] ? 'Start one with: cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO'
        : 'First save a sign-in image with: cloudy-cloud coordinator image')].join('\n'));
  }
  // Names and states come from the server, so strip terminal control characters before printing them.
  const clean = (v) => safeText(v ?? '').replace(/\n/g, ' ');
  const when = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : 'unknown'; };
  const data = rows.map((m) => ({ name: clean(m.labels?.name) || 'unnamed', state: clean(m.state) || 'unknown', created: when(m.startedAt), machine: clean(m.name) || 'unknown',
    deleteAt: m.deleteAt ? clean(m.deleteAt) : '' }));
  if (c.ui.on) {
    const u = c.ui, color = { running: u.col.ok, creating: u.col.warn, suspended: u.col.warn, paused: u.col.warn };
    const cells = data.map((d) => [d.name, [[d.state, color[d.state] ?? u.col.err]], u.rel(d.created), d.machine,
      d.deleteAt ? [[u.rel(d.deleteAt)], [`  ${d.deleteAt.slice(0, 16)}Z`, u.col.dim]] : [['never', u.col.dim]]]);
    const table = u.table(['NAME', 'STATE', 'STARTED', 'MACHINE', 'DELETES'], cells);
    // A window too narrow for the table gets one short block per coordinator instead of wrapped columns.
    if (!table.split('\n').some((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length > u.width)) return c.out(table);
    return c.out(data.map((d) => [`  ${u.bold(d.name)} [${d.state}]`, `    Machine: ${d.machine}`, `    Created: ${d.created}`, `    Deletes: ${d.deleteAt || 'never'}`].join('\n')).join('\n\n'));
  }
  c.out(['NAME', 'STATE', 'CREATED', 'MACHINE', 'DELETES'].join('\t'));
  for (const d of data) c.out([d.name, d.state, d.created, d.machine, d.deleteAt || 'never'].join('\t'));
}

async function stop(c, args) {
  const name = args[0] || fail('Usage: cloudy-cloud coordinator stop NAME');
  const [m] = await find(c.provider, 'coordinator', name);
  if (!m) fail(`No coordinator named ${name}. List them with: cloudy-cloud coordinator ls`);
  c.progress('Deleting the coordinator machine...');
  await c.provider.delete(m.id, { sdk: true });
  if (c.ui.on) return c.out([c.ui.ok(`Deleted coordinator ${name}`, `machine ${m.name}`), c.ui.hint('Its workers go with its cleanup, or at their own deadline (6 hours by default).'),
    c.ui.hint(`Check with: ${c.provider.text.listMachines}`)].join('\n'));
  c.out(`Deleted coordinator ${name} (machine ${m.name}). Its workers are deleted by its cleanup process, or by their own delete deadline (6 hours by default). Check with: ${c.provider.text.listMachines}`);
}

// Run ON a coordinator machine by the coordinator itself: checks that nothing is lost, then deletes this machine.
async function finish(c, args, deps) {
  const force = args.includes('--force');
  const host = deps.hostname ?? osHostname();
  const mname = c.provider.localMachineName(host);
  const notHere = `This is not a coordinator machine (hostname ${host}). finish only runs on a machine started with: cloudy-cloud coordinator start`;
  if (!mname) fail(notHere);
  const me = (await c.provider.list({ role: 'coordinator' })).find((m) => m.name === mname && m.labels?.role === 'coordinator');
  if (!me?.id) fail(notHere);
  const verified = [`machine ${me.name} (${me.id}), coordinator ${me.labels.name}`];
  if (force) verified.push('--force: skipped the git and worker checks');
  else {
    const repo = deps.repoDir ?? join(homedir(), 'repo');
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const problems = [];
    let dirty, current, branches;
    try {
      dirty = git('status', '--porcelain');
      current = git('rev-parse', '--abbrev-ref', 'HEAD');
      branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter((b) => b === current || b.startsWith('fleet/'));
    } catch (e) { fail(`Could not read the git repo ${repo}: ${e.stderr || e.message}`); }
    if (dirty) problems.push(`${repo} has uncommitted changes:\n${dirty.split('\n').slice(0, 10).join('\n')}`);
    if (current === 'HEAD') {
      let held = '';
      try { held = git('branch', '-r', '--contains', 'HEAD'); } catch { /* treated as not pushed */ }
      if (!held) problems.push('HEAD is detached and not contained in any remote branch, so its commits may be unpushed. Push them to a branch first: git push origin HEAD:refs/heads/<branch>');
    }
    for (const b of branches) {
      let ahead;
      try { ahead = git('rev-list', `${b}@{u}..${b}`); } catch { problems.push(`Branch ${b} has no upstream on GitHub; push it with: git push -u origin ${b}`); continue; }
      if (ahead) problems.push(`Branch ${b} has ${ahead.split('\n').length} commit(s) not pushed to its upstream; run: git push`);
    }
    let owner = '';
    try { owner = readFileSync(deps.ownerFile ?? ownerFile(c.env), 'utf8').trim(); } catch { /* no server has run here */ }
    const workers = owner ? (await c.provider.list({ owner })).filter((m) => m.labels?.owner === owner && !/delet/.test(m.state ?? '')) : [];
    if (workers.length) problems.push(`${workers.length} worker machine(s) of this coordinator are still running (${workers.map((m) => m.name || m.id).join(', ')}). Stop them with cloud_agent_stop first.`);
    if (problems.length) fail(`Not deleting this machine, because work could be lost:\n- ${problems.join('\n- ')}\nFix these and run finish again, or use --force to delete anyway.`);
    verified.push('working tree clean', `pushed: ${branches.join(', ')}`, 'no running workers');
  }
  // One attempt; list and delete here use the raw API, as finish always has (ls, attach, stop use the SDK).
  await c.provider.delete(me.id, { retries: 0 }).catch((e) => { throw e.status ? new Error(`Delete failed: HTTP ${e.status}`) : e; });
  if (c.ui.on) return c.out([...verified.map((v) => c.ui.ok(v)), c.ui.ok(`Deleted this machine (${me.name})`)].join('\n'));
  c.out(`Verified: ${verified.join('; ')}.\nDeleted this machine (${me.name}).`);
}

// Rejects bad arguments before any key is read or the network is touched.
const START_OPTIONS = ['--repo', '--branch', '--task', '--task-file', '--max-hours'];
function validateArgs(cmd, args) {
  const bad = (message) => fail(`${message}\nRun: cloudy-cloud coordinator ${cmd} --help`);
  if (cmd === 'image') { if (args.some((a) => a !== '--save') || args.length > 1) bad('Expected image or image --save.'); return; }
  if (cmd === 'ls') { if (args.length) bad('ls takes no arguments.'); return; }
  if (cmd === 'finish') { if (args.some((a) => a !== '--force') || args.length > 1) bad('finish takes only --force.'); return; }
  if (!NAME_RE.test(args[0] ?? '')) bad('NAME must use lowercase letters, digits and hyphens (1 to 40 characters).');
  if (cmd !== 'start') { if (args.length !== 1) bad(`${cmd} takes exactly one NAME.`); return; }
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (option === '--json') { if (seen.has(option)) bad('Repeated option: --json'); seen.add(option); continue; }
    if (!START_OPTIONS.includes(option)) bad(`Unknown argument: ${option}`);
    if (seen.has(option)) bad(`Repeated option: ${option}`);
    if (args[i + 1] === undefined || (option !== '--task' && args[i + 1].startsWith('--'))) bad(`Missing value for ${option}.`);
    seen.add(option);
    i++;
  }
}

export async function main(argv, deps = {}) {
  const [cmd, ...args] = argv;
  const commands = { image, start, attach, ls, stop, finish: (c, a) => finish(c, a, deps) };
  const isHelp = (a) => a === '--help' || a === '-h';
  if ((isHelp(cmd) && !args.length) || (Object.hasOwn(commands, cmd) && args.length === 1 && isHelp(args[0]))) {
    return (deps.out ?? console.log)(coordinatorHelp(Object.hasOwn(commands, cmd) ? cmd : undefined));
  }
  if (!Object.hasOwn(commands, cmd)) fail('Usage: cloudy-cloud coordinator image [--save] | start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--json] | attach NAME | ls | stop NAME | finish [--force]\nRun: cloudy-cloud coordinator --help');
  validateArgs(cmd, args);
  const c = await context(deps);
  if ((cmd === 'image' || cmd === 'start') && !c.provider.caps.hasSnapshots) fail(`Provider ${c.provider.name} has no snapshots, which coordinators need.`);
  try { return await commands[cmd](c, args); } catch (e) {
    if (e?.code === 'no_key') fail(`${e.message} Run: cloudy-cloud setup`);
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    const u = makeUi({ tty: process.stderr.isTTY });
    const [first, ...more] = redact(safeText(e.message ?? e)).split('\n');
    console.error(u.on ? [u.err(first), ...more.map((l) => `    ${u.dim(l)}`)].join('\n') : `cloudy-cloud: ${[first, ...more].join('\n')}`);
    process.exit(1);
  });
}
