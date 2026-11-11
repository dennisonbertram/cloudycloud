// Setup and doctor for the self-hosted provider (your own machine over SSH).
//   node src/self-hosted-setup.mjs setup    asks for the machine, checks it, builds the worker image, saves the settings
//   node src/self-hosted-setup.mjs doctor   checks the saved machine and prints ok / warn / fail lines, each with a fix
// Everything on the machine goes through src/providers/ssh.mjs. Secrets are read with hidden input and written to the env
// file only; they never appear in a command, an argument or the output.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { createSsh } from './providers/ssh.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const IMAGE = `cloudy-cloud-worker:${version}`;
const GIB = 2 ** 30;
const SETUP_CMD = 'cloudy-cloud setup --provider self-hosted';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const q = (s) => (/^[\w./-]+$/.test(s) ? s : shq(s)); // quote only when needed
const tail = (text, n = 6) => String(text || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');

// Suggested number of subagents at once: half the CPUs, or one per 4 GiB of memory, whichever is lower; at least 1.
export const slotsFor = (ncpu, memBytes) => Math.max(1, Math.min(Math.floor(ncpu / 2), Math.floor(memBytes / (4 * GIB))));

// What the adapter (providers/self-hosted.mjs) reads: runtime name, absolute CLI path, and per-container limits that split
// the box (or the container VM on a Mac) between the slots. --cpus is a cap, so at least 1; memory keeps 20% for the host.
export const containerSettings = ({ kind, bin, ncpu, mem }, slots) => ({
  CLOUDY_CLOUD_CONTAINER_RUNTIME: kind === 'podman' ? 'podman' : 'docker',
  CLOUDY_CLOUD_CONTAINER_BIN: bin,
  CLOUDY_CLOUD_SELF_HOSTED_SLOTS: String(slots),
  CLOUDY_CLOUD_SELF_HOSTED_CPUS: String(Math.max(1, Math.floor(ncpu / slots))),
  CLOUDY_CLOUD_SELF_HOSTED_MEMORY: `${Math.max(512, Math.floor((mem * 0.8) / slots / 2 ** 20))}m`,
});

// ---- output ----
function makeUi(out = process.stdout) {
  const color = out.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const ui = { fails: 0, text: (s = '') => out.write(`${s}\n`) };
  ui.say = (level, text, fix) => {
    if (level === 'fail') ui.fails++;
    out.write(`  ${paint({ ok: 32, warn: 33, fail: 31 }[level], level.padEnd(4))}  ${text}\n`);
    for (const f of [].concat(fix || [])) out.write(`        ${paint(2, `fix: ${f}`)}\n`);
  };
  return ui;
}

// ---- the env file (same rules as install.sh write_env: private temp file in the same folder, then rename) ----
const envFile = (env) => env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env');
export function saveEnv(file, set, del = []) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const drop = new Set([...Object.keys(set), ...del]);
  let old = [];
  try { old = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const kept = old.filter((l) => !drop.has(l.slice(0, l.indexOf('='))));
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, [...kept, ...Object.entries(set).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// ---- running things on the machine ----
const sshEnv = (env) => ({ CLOUDY_CLOUD_SSH_HOST: env.CLOUDY_CLOUD_SSH_HOST, CLOUDY_CLOUD_SSH_KEY: env.CLOUDY_CLOUD_SSH_KEY, CLOUDY_CLOUD_SSH_PORT: env.CLOUDY_CLOUD_SSH_PORT });
// ponytail: the client-side signal is the only time limit; the remote `timeout` command is missing on a stock Mac.
const probe = async (ssh, cmd, ms = 30000) => {
  try { return { ok: true, ...(await ssh.run(cmd, { signal: AbortSignal.timeout(ms) })) }; } catch (e) { return { ok: false, err: e, stdout: e.stdout || '', stderr: e.stderr || '' }; }
};
const errText = (r) => tail(r.err?.name === 'AbortError' || r.err?.name === 'TimeoutError' ? 'no answer in time' : (r.stderr || r.err?.message || '').replace(/^cannot reach \S+ over ssh: /, ''), 3);
function closeSsh(ssh, env) {
  const e = sshEnv(env);
  spawnSync('ssh', ['-o', `ControlPath=${ssh.dir}/cc-%C`, '-O', 'exit', ...(e.CLOUDY_CLOUD_SSH_PORT ? ['-p', e.CLOUDY_CLOUD_SSH_PORT] : []), e.CLOUDY_CLOUD_SSH_HOST], { stdio: 'ignore' });
  rmSync(ssh.dir, { recursive: true, force: true });
}

// Absolute path of a CLI on the machine. A non-interactive SSH command on macOS lacks /opt/homebrew/bin and /usr/local/bin,
// so ask a login shell first, then the usual install places.
const KNOWN = {
  docker: ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '"$HOME/.orbstack/bin/docker"', '/Applications/Docker.app/Contents/Resources/bin/docker', '/usr/bin/docker'],
  podman: ['/opt/homebrew/bin/podman', '/usr/local/bin/podman', '/usr/bin/podman'],
};
async function findBin(ssh, name) {
  const login = await probe(ssh, `"\${SHELL:-/bin/sh}" -lc 'command -v ${name}'`);
  const p = (login.ok && login.stdout.trim().split('\n').pop()) || '';
  if (p.startsWith('/')) return p;
  const known = await probe(ssh, `for p in ${KNOWN[name].join(' ')}; do [ -x "$p" ] && { echo "$p"; break; }; done`);
  const k = (known.ok && known.stdout.trim().split('\n')[0]) || '';
  return k.startsWith('/') ? k : '';
}

const slowMs = (env) => Number(env.CLOUDY_CLOUD_DOCTOR_SLOW_MS ?? 5000);
const SSH_FIXES = (host) => [
  'Make sure Tailscale is running on this computer and on the machine (run: tailscale status).',
  'Make sure the machine is in your tailnet and the name or 100.x address is right.',
  `Make sure your SSH key is accepted: run "ssh ${host} true" yourself. On a Mac, turn on Remote Login in System Settings > General > Sharing.`,
];

// The checks setup and doctor share: ssh, sleep, container runtime, disk. Returns the facts, or null after a fail.
async function checkBox({ ssh, ui, env }) {
  const host = env.CLOUDY_CLOUD_SSH_HOST;
  const t0 = performance.now();
  const r = await probe(ssh, 'true', 20000);
  const ms = performance.now() - t0;
  if (!r.ok) { ui.say('fail', `SSH: cannot reach ${host} (${errText(r)})`, SSH_FIXES(host)); return null; }
  const took = `${(ms / 1000).toFixed(1)} s`;
  if (ms > slowMs(env)) ui.say('warn', `SSH: ${host} answered in ${took}. Tailscale check mode may be asking for re-auth`, 'In the Tailscale admin console give this machine an "accept" rule or a longer checkPeriod, or use a normal SSH key.');
  else ui.say('ok', `SSH: ${host} answered in ${took}`);

  const os = (await probe(ssh, 'uname -s')).stdout.trim() || 'Linux';
  const mac = os === 'Darwin';

  if (mac) {
    const m = Number((await probe(ssh, `pmset -g | awk '$1=="sleep"{print $2}'`)).stdout.trim());
    if (m > 0) ui.say('warn', `Sleep: the Mac goes to sleep after ${m} minute${m === 1 ? '' : 's'}, which stops every subagent on it`, 'On the Mac: System Settings > Battery (or Energy), turn on "Prevent automatic sleeping when the display is off", or run: sudo pmset -a sleep 0');
    else if (m === 0) ui.say('ok', 'Sleep: the Mac does not sleep');
  }

  const saved = env.CLOUDY_CLOUD_CONTAINER_RUNTIME;
  let bin = env.CLOUDY_CLOUD_CONTAINER_BIN?.startsWith('/') ? env.CLOUDY_CLOUD_CONTAINER_BIN : '';
  if (!bin) for (const n of saved === 'podman' ? ['podman'] : ['docker', 'podman']) if ((bin = await findBin(ssh, n))) break;
  if (!bin) {
    ui.say('fail', `Container runtime: no docker found on ${host}`, mac
      ? `Install Docker Desktop or OrbStack on the Mac, open it once so it starts, then run: ${SETUP_CMD}`
      : `Install Docker (https://docs.docker.com/engine/install/) or Podman on the machine, then run: ${SETUP_CMD}`);
    return null;
  }
  const kind = basename(bin);
  const fmt = kind === 'podman' ? '{{.Version.Version}} {{.Host.CPUs}} {{.Host.MemTotal}} {{.Host.Security.Rootless}}' : '{{.ServerVersion}} {{.NCPU}} {{.MemTotal}}';
  const info = await probe(ssh, `${q(bin)} info --format ${shq(fmt)}`);
  const [ver, vmCpu, vmMem, rootless] = info.stdout.trim().split(/\s+/);
  if (!info.ok || !(Number(vmCpu) > 0)) {
    ui.say('fail', `Container runtime: ${bin} is installed but does not answer (${errText(info)})`, mac
      ? `Start Docker Desktop or OrbStack on the Mac and wait until it says it is running, then try again. If the path changed, run: ${SETUP_CMD}`
      : `Start the service (sudo systemctl start ${kind}) or fix the error above, then try again.`);
    return null;
  }
  ui.say('ok', `Container runtime: ${kind} ${ver} at ${bin}`);
  if (rootless === 'true') ui.say('warn', 'Container runtime: Podman runs rootless, so CPU and memory limits may not apply', 'Enable cgroup v2 delegation for your user (see the Podman rootless guide) or use Docker.');

  const df = await probe(ssh, mac ? 'df -Pk "$HOME"' : 'df -Pk /var/lib/docker 2>/dev/null || df -Pk "$HOME"');
  const freeKb = Number(df.stdout.trim().split('\n').pop().trim().split(/\s+/)[3]);
  if (freeKb >= 0) {
    const gb = Math.floor(freeKb / 1024 / 1024);
    if (gb < 20) ui.say('warn', `Disk: ${gb} GB free, under the 20 GB the worker image and containers need`, `Free space on the machine${mac ? ' (Docker Desktop and OrbStack keep their disk image in your home folder)' : ''}, for example: ${q(bin)} system prune -a`);
    else ui.say('ok', `Disk: ${gb} GB free`);
  }

  // Size the box. Containers on a Mac live in a VM, so the VM's own limit counts too.
  const hostSpec = (await probe(ssh, mac ? 'sysctl -n hw.ncpu hw.memsize' : "nproc; awk '/MemTotal/{print $2*1024}' /proc/meminfo")).stdout.trim().split(/\s+/).map(Number);
  const ncpu = Math.min(...[hostSpec[0], Number(vmCpu)].filter((n) => n > 0));
  const mem = Math.min(...[hostSpec[1], Number(vmMem)].filter((n) => n > 0));
  return { bin, kind, mac, ncpu, mem, suggested: slotsFor(ncpu, mem), limitedByVm: mac && hostSpec[0] > Number(vmCpu) };
}

async function checkImage({ ssh, ui, bin }) {
  const r = await probe(ssh, `${q(bin)} image inspect ${IMAGE} --format '{{index .Config.Labels "cloudy-cloud.image"}}'`);
  const label = r.stdout.trim();
  if (!r.ok) ui.say('fail', `Worker image: ${IMAGE} is not on the machine`, SETUP_CMD);
  else if (label !== version) ui.say('fail', `Worker image: ${IMAGE} is labelled ${label || 'nothing'} but this cloudy-cloud is ${version}`, SETUP_CMD);
  else ui.say('ok', `Worker image: ${IMAGE} is built`);
  return r.ok && label === version;
}

// ---- doctor ----
export async function runDoctor({ env = loadEnv(), out = process.stdout } = {}) {
  const ui = makeUi(out);
  const provider = env.CLOUDY_CLOUD_PROVIDER || 'instabox';
  if (provider !== 'self-hosted') { ui.text(`Provider is ${provider}; doctor checks self-hosted boxes only`); return 0; }
  const host = env.CLOUDY_CLOUD_SSH_HOST;
  if (!host) { ui.say('fail', 'Settings: CLOUDY_CLOUD_SSH_HOST is not set', SETUP_CMD); return 1; }
  let ssh;
  try { ssh = createSsh(sshEnv(env)); } catch (e) { ui.say('fail', `Settings: ${e.message}`, SETUP_CMD); return 1; }
  try {
    const f = await checkBox({ ssh, ui, env });
    if (f) {
      await checkImage({ ssh, ui, bin: f.bin });
      {
        const slots = Number(env.CLOUDY_CLOUD_SELF_HOSTED_SLOTS);
        if (slots > f.suggested) ui.say('warn', `Capacity: ${slots} subagents at once is more than this machine suggests (${f.suggested})`, `Set CLOUDY_CLOUD_SELF_HOSTED_SLOTS=${f.suggested} in ${envFile(env)}, or run: ${SETUP_CMD}`);
        else if (slots > 0) ui.say('ok', `Capacity: ${slots} subagents at once fits this machine (${f.ncpu} CPUs, ${Math.floor(f.mem / GIB)} GB memory)`);
      }
      const ps = await probe(ssh, `${q(f.bin)} ps -a --filter label=cloudy-cloud.purpose --format '{{.Names}}|{{.RunningFor}}|{{.Label "cloudy-cloud.deleteAt"}}'`);
      const rows = ps.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
      const sshCmd = `ssh${env.CLOUDY_CLOUD_SSH_KEY ? ` -i ${env.CLOUDY_CLOUD_SSH_KEY}` : ''}${env.CLOUDY_CLOUD_SSH_PORT ? ` -p ${env.CLOUDY_CLOUD_SSH_PORT}` : ''} ${host}`;
      if (!ps.ok) ui.say('warn', `Containers: could not list them (${errText(ps)})`);
      else if (!rows.length) ui.say('ok', 'Containers: none running');
      for (const [name, age, deadline] of rows) {
        if (deadline && Date.parse(deadline) < Date.now()) ui.say('warn', `Containers: ${name} is stale (started ${age}, deadline ${deadline} passed)`, `${sshCmd} ${shq(`${f.bin} rm -f ${name}`)}`);
        else ui.say('ok', `Containers: ${name} started ${age}${deadline ? `, ends ${deadline}` : ''}`);
      }
    }
  } finally { closeSsh(ssh, env); }

  const before = ui.fails;
  const missing = [];
  if (!env.CLOUDY_CLOUD_CONTAINER_BIN) missing.push(['CLOUDY_CLOUD_CONTAINER_BIN is not set, so the container CLI is looked up by name and may not be found']);
  if (!env.CLOUDY_CLOUD_SELF_HOSTED_SLOTS) missing.push(['CLOUDY_CLOUD_SELF_HOSTED_SLOTS is not set, so the default number of subagents is used']);
  if (env.CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX !== 'yes') missing.push(['GitHub token is not allowed on the machine, so workers cannot push to GitHub']);
  for (const [m] of missing) ui.say('warn', `Settings: ${m}`, SETUP_CMD);
  if (env.CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX === 'yes' && !env.GH_TOKEN) ui.say('fail', 'Settings: GitHub token is allowed but GH_TOKEN is not saved', SETUP_CMD);
  if (!missing.length && ui.fails === before) ui.say('ok', `Settings: all needed names are saved in ${envFile(env)}`);
  return ui.fails ? 1 : 0;
}

// ---- setup ----
function makeInput(input, out) {
  let muted = false;
  const mute = new Writable({ write(c, _e, cb) { if (!muted) out.write(c); cb(); } });
  const rl = createInterface({ input, output: input.isTTY ? mute : undefined, terminal: !!input.isTTY });
  const it = rl[Symbol.asyncIterator]();
  const line = async (prompt, hidden = false) => {
    out.write(prompt);
    muted = hidden;
    const { value } = await it.next();
    muted = false;
    if (hidden || !input.isTTY) out.write('\n');
    return (value ?? '').trim();
  };
  return { line, close: () => rl.close() };
}

export async function runSetup({ env = loadEnv(), input = process.stdin, out = process.stdout } = {}) {
  const ui = makeUi(out);
  const inp = makeInput(input, out);
  const file = envFile(env);
  let ssh, target;
  try {
    ui.text('  ? SSH address of your machine (user@host)');
    ui.text('    Use the Tailscale name or 100.x address, for example me@mac-studio.');
    ui.text('    On a Mac, first turn on System Settings > General > Sharing > Remote Login.');
    ui.text('    On Linux with Tailscale SSH, run: sudo tailscale up --ssh');
    const host = (await inp.line(`  > Address${env.CLOUDY_CLOUD_SSH_HOST ? ` [${env.CLOUDY_CLOUD_SSH_HOST}]` : ''}: `)) || env.CLOUDY_CLOUD_SSH_HOST;
    if (!host) { ui.say('fail', 'No address given', `Run again and type something like me@mac-studio, or: ${SETUP_CMD}`); return 1; }
    ui.text('  ? Path to your SSH key (optional)');
    ui.text('    A Mac with Remote Login needs a key. Press Enter to use your default keys or Tailscale SSH.');
    const keyIn = await inp.line(`  > Path to your SSH key${env.CLOUDY_CLOUD_SSH_KEY ? ` [${env.CLOUDY_CLOUD_SSH_KEY}]` : ''}: `);
    const key = keyIn || env.CLOUDY_CLOUD_SSH_KEY || '';
    const e = target = { ...env, CLOUDY_CLOUD_SSH_HOST: host, CLOUDY_CLOUD_SSH_KEY: key };
    try { ssh = createSsh(sshEnv(e)); } catch (err) { ui.say('fail', `SSH: "${host}" does not look like an SSH address (${err.message})`, 'Use user@host, for example me@mac-studio.'); return 1; }

    const f = await checkBox({ ssh, ui, env: e });
    if (!f) return 1;
    ui.text('  ? How many subagents should run at once on this machine?');
    ui.text(`    ${f.ncpu} CPUs and ${Math.floor(f.mem / GIB)} GB memory${f.limitedByVm ? " are available to containers (the container VM's limit)" : ''}. Suggested: ${f.suggested} (half the CPUs, or 4 GB each, whichever is lower).`);
    const slotsIn = await inp.line(`  > How many subagents may run at once? [${env.CLOUDY_CLOUD_SELF_HOSTED_SLOTS || f.suggested}]: `);
    let slots = Number(env.CLOUDY_CLOUD_SELF_HOSTED_SLOTS) || f.suggested;
    if (slotsIn) {
      if (/^[1-9]\d*$/.test(slotsIn)) slots = Number(slotsIn); else ui.say('warn', `"${slotsIn}" is not a number, so ${slots} is used`);
    }

    ui.text(`  > Building the worker image ${IMAGE} on ${host} (the first build takes a few minutes)...`);
    const dir = dirname(f.bin);
    const build = `PATH=${q(dir)}:/usr/local/bin:/opt/homebrew/bin:"$PATH"; export PATH; ${q(f.bin)} build --build-arg VERSION=${version} -t ${IMAGE} -`;
    try {
      await ssh.run(build, { stdin: readFileSync(join(root, 'docker/worker.Dockerfile')), signal: AbortSignal.timeout(30 * 60000) });
    } catch (err) {
      ui.say('fail', `Worker image: the build failed\n${tail((err.stderr || '') + (err.stdout || '') || err.message, 8).replace(/^/gm, '        ')}`, 'Fix the error above (a full disk or no network on the machine are common), then run: ' + SETUP_CMD);
      return 1;
    }
    if (!(await checkImage({ ssh, ui, bin: f.bin }))) return 1;

    ui.text(`  ? Allow the GitHub token on ${host}? [y/N]`);
    ui.text('    Subagents need a GitHub token to push branches. Instabox keeps the token off its machines; your own machine has no such proxy,');
    ui.text(`    so the token would be stored inside each worker container on ${host} (in memory only, removed with the container).`);
    ui.text('    Say yes only if you own and trust that machine.');
    const allow = /^y/i.test(await inp.line(`  > Allow the GitHub token on ${host}? [y/N]: `));
    const set = { CLOUDY_CLOUD_PROVIDER: 'self-hosted', CLOUDY_CLOUD_SSH_HOST: host, ...containerSettings(f, slots) };
    const del = [];
    if (key) set.CLOUDY_CLOUD_SSH_KEY = key; else del.push('CLOUDY_CLOUD_SSH_KEY');
    if (env.CLOUDY_CLOUD_SSH_PORT) set.CLOUDY_CLOUD_SSH_PORT = env.CLOUDY_CLOUD_SSH_PORT;
    if (allow) {
      set.CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX = 'yes';
      const tok = (await inp.line(`  > Paste a GitHub token limited to the repos subagents may push to (nothing shows as you paste${env.GH_TOKEN ? '; Enter keeps the saved one' : ''}): `, true)).replace(/\s+/g, '');
      if (tok) set.GH_TOKEN = tok;
      if (tok || env.GH_TOKEN) ui.say('ok', `GitHub token: allowed on ${host}; saved in ${file} (mode 600), never shown`);
      else ui.say('warn', 'GitHub token: allowed, but no token is saved yet', `${SETUP_CMD} (run it again and paste a token)`);
    } else {
      del.push('CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX', 'GH_TOKEN');
      ui.say('warn', 'GitHub token: not allowed, so workers cannot push to GitHub and will not start', `${SETUP_CMD} (run it again and answer y)`);
    }
    saveEnv(file, set, del);
    ui.say('ok', `Saved the self-hosted settings to ${file}`);
    ui.text(`    ${slots} subagent${slots === 1 ? '' : 's'} at once on ${host}. Check the machine any time with: cloudy-cloud doctor`);
    return 0;
  } finally { inp.close(); if (ssh) closeSsh(ssh, target); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd !== 'setup' && cmd !== 'doctor') { process.stderr.write('usage: self-hosted-setup.mjs setup|doctor\n'); process.exit(2); }
  process.exitCode = await (cmd === 'setup' ? runSetup() : runDoctor());
}
