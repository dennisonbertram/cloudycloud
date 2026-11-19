// Cloud coordinators: long-lived Claude Code sessions on their own cloud machines.
// Usage: node coordinator.mjs image [--save] | start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--json] | attach NAME | ls | status NAME [--json] | stop NAME | finish [--force]
import { readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir, hostname as osHostname, constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ownerFile, egressAllow, proxySecrets, DEFAULT_PROVIDER_KEY } from './config.mjs';
import { coordinatorKeys, loadProfiles, COORDINATOR_KEY_SECRET } from './profiles.mjs';
import { ownsRepo, toolBundle, toolInstallCmd } from './toolbundle.mjs';
import { loadProvider } from './providers/index.mjs';
import { makeUi, cellWidth, fitCells } from './ui.mjs';
import { coordinatorHelp, coordinatorUsage } from './cli-help.mjs';
import { safeText } from './terminal.mjs';
import { redact } from './events.mjs';
import { paneState } from './pane-state.mjs';
import { FIRST_RUN_SCRIPT } from './first-run.mjs';
import { secretValues } from './run-subagent.mjs';
import { consentedLiterals } from './mcpsync.mjs';
export { FIRST_RUN_SCRIPT };
import { guide, guideObj, classify, CODES, SECRET_HOSTS, setCmd } from './errors.mjs';

const TEMPLATE = 'agent-browser';
const SNAPSHOT_KEY = 'CLOUDY_CLOUD_COORDINATOR_SNAPSHOT';
const ACCOUNT_KEY = 'CLOUDY_CLOUD_SNAPSHOT_ACCOUNT'; // the Claude account the image is signed in as; install.sh shows it
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;
const SETUP_MS = 600_000;
const TASK_MAX = 100_000; // bytes
const IMAGE_SECONDS = 2 * 3600;
const deadlineLine = (iso) => `Your machine is deleted by the server at ${iso}; push your work well before then.`;
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const fail = (msg) => { throw Object.assign(new Error(msg), { local: true }); };
// Coordinators run unrestricted machines: a configured worker egress policy refuses them outright (same text as runSubagent's role refusal).
const refuseEgress = (env) => { const e = egressAllow(env); if (e.error) fail(e.error); if (e.list.length) guided('CLOUDY_CLOUD_EGRESS_ALLOW applies to workers only. Next step: start the coordinator without it, or call cloud_agent with role "worker".', { short: 'CLOUDY_CLOUD_EGRESS_ALLOW applies to workers only.', next: 'start the coordinator without it, or call cloud_agent with role "worker"' }); };
// A "not found" or refusal is a normal answer, not a failure. The message stays one paragraph for scripts
// (plain stderr, --json); a terminal renders the fields: ✖ short, dim details and reason, → Next.
// `local` marks an error this file created: only such an error may carry trusted guidance fields or embedded
// guidance labels — the same labels inside provider text are diagnostics, never our instructions.
const guided = (message, fields) => { throw Object.assign(new Error(message), { ...fields, local: true }); };
// The guidance labels a message can carry (author-chosen or appended for start): one parser, used by main()
// for --json (the four origin labels, so nextStep keeps a trailing Run: line as before) and by errorScreen for
// the terminal (which also lifts "Run:"/"Next:" lines into the Next). Lines before the first label are the
// problem; a label line swallows the lines after it into its field. "Tell the user" never prints on a terminal.
const LABELS = 'What happened|Likely cause|Next step|Tell the user';
const parseGuidance = (text, labels = LABELS) => {
  const re = new RegExp(`^(${labels}): ?(.*)$`);
  const head = [], fields = {};
  let cur;
  for (const l of String(text).split('\n')) {
    const m = l.match(re);
    if (m) { cur = m[1]; fields[cur] = m[2]; }
    else if (cur) fields[cur] += `\n${l}`;
    else head.push(l);
  }
  return { head, fields };
};
// A usage error keeps the classic message for piped stderr and --json; the terminal renders the fields:
// the problem (short), the relevant subcommand's wrapped usage (details) and the matching help command (next).
const usageError = (message, cmd, short, details = []) =>
  guided(message, { short, details: [coordinatorUsage(cmd), ...details], next: `cloudy-cloud coordinator ${cmd ? `${cmd} --help` : '--help'}`, wrapShort: true });
const tilde = (p, env) => { const h = env.HOME || homedir(); return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p; };
// "→ Next: <cmd>" on one line; a command too long for that wraps whole words onto indented lines: never an ellipsis.
const nextFit = (u, cmd) => { const l = u.next(cmd); return cellWidth(l) <= u.width ? l : [`  ${u.paint(u.col.acc, `${u.utf ? '→' : '->'} Next:`)}`, ...wrapText(u, cmd).map((x) => `    ${x}`)].join('\n'); };
// Same wrap for the "Attach with: <cmd>" hint.
const attachFit = (u, name) => (4 + cellWidth(`Attach with: cloudy-cloud coordinator attach ${name}`) <= u.width
  ? u.hint(`Attach with: cloudy-cloud coordinator attach ${name}`) : [u.hint('Attach with:'), ...wrapText(u, `cloudy-cloud coordinator attach ${name}`).map((l) => `    ${u.dim(l)}`)].join('\n'));
// A hint line whose text wraps whole words onto indented dimmed lines instead of being cut mid-word.
const hintFit = (u, text) => wrapText(u, text).map((l, i) => (i ? `    ${u.dim(l)}` : u.hint(l))).join('\n');
// The longest prefix of s fitting `max` cells (like fitCells but never an ellipsis: nothing is dropped).
const takeCells = (s, max) => { let out = '', w = 0; for (const ch of String(s)) { const cw = cellWidth(ch); if (w + cw > max) break; w += cw; out += ch; } return out; };
// Whole-word wrap for a line of text: words wrap at the room edge. A single word over the room is split at a '/'
// boundary or, failing that, at the room edge — every character is kept and no command, URL or flag is cut.
const wrapText = (u, text, room = u.width - 4) => {
  const lines = []; let cur = '';
  for (const w0 of String(text).split(/\s+/).filter(Boolean)) {
    let w = w0;
    while (cellWidth(w) > room) { // a lone word over the room
      if (cur) { lines.push(cur); cur = ''; }
      const head = takeCells(w, room), slash = head.lastIndexOf('/');
      const cut = slash > 0 ? slash + 1 : Math.max(1, head.length);
      lines.push(w.slice(0, cut)); w = w.slice(cut);
    }
    if (cur && cellWidth(cur) + cellWidth(w) + 1 > room) { lines.push(cur); cur = ''; }
    cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
};
// A status line (ok/warn) whose detail rides beside the message when it fits — measuring the real mark, so [ok]
// under LANG=C is budgeted too — and otherwise moves to its own dimmed line so it is never dropped.
const statusLine = (u, kind, msg, details = []) => {
  for (const d of details) { const l = u[kind](msg, d); if (cellWidth(l) <= u.width) return l; }
  return `${u[kind](msg)}${details.length ? `\n    ${u.dim(fitCells(details[0], u.width - 4))}` : ''}`;
};

// Sets and drops config lines in ONE write: temp file in the same folder (mode 600), then rename. Errors other than a missing file propagate.
function updateConfig(file, set = {}, drop = []) {
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n'); if (lines.at(-1) === '') lines.pop(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const names = new Set([...Object.keys(set), ...drop]);
  lines = lines.filter((l) => !names.has(l.slice(0, l.indexOf('='))));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  writeFileSync(tmp, `${[...lines, ...Object.entries(set).map(([k, v]) => `${k}=${v}`)].join('\n')}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
const saveKey = (file, name, value) => updateConfig(file, { [name]: value });

// The GitHub URL of cloudy-cloud itself, kept as `origin` on the machine for reference only (empty if there is none).
export function toolRepoUrl(root) {
  let u;
  if (!ownsRepo(root)) return ''; // an npm install has no repo of its own
  try { u = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
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
  // A state change the user should see even when stderr is piped (unlike progress): one line, never stdout.
  const note = deps.note ?? ((s) => stderr.write(`${s}\n`));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const provider = deps.provider ?? await loadProvider(env, { fetchFn: deps.fetchFn, sdk: deps.sdk, sleep, spawn: deps.cliSpawn });
  const tty = deps.tty ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  const spawn = deps.spawn ?? spawnSync;
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? (async (question) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await new Promise((res) => { rl.once('close', () => res('n')); rl.question(question).then(res, () => res('n')); }); } finally { rl.close(); } });
  return { env, provider, configFile, out, root, progress, note, ui, sleep, now, tty, spawn, ask, ssh: provider.text.ssh };
}

const mach = (m) => m.machineName ?? m.name; // the machine's own name; self-hosted rows keep the logical name in `name`
// A server-supplied machine name or id reaches a suggested command (`shell`, ssh) only as one plain word —
// anything with spaces, semicolons, quotes or control characters would smuggle arguments or a second command.
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const word = (...vs) => vs.find((v) => typeof v === 'string' && WORD.test(v)) ?? '';
// Every machine a command acts on must be one of ours: purpose=cloudy-cloud plus the role. The name (for
// attach/status/stop) is a second filter, not a substitute — labels decide, never the reported name alone.
const find = async (provider, role, name) =>
  (await provider.list({ role, ...(name && { name }) }, { sdk: true }))
    .filter((m) => m.labels?.purpose === 'cloudy-cloud' && m.labels?.role === role && (!name || m.labels?.name === name));

// Installs or updates cloudy-cloud on the machine and sets up git's GitHub login. Returns the home folder.
async function installTool(sbx, root) {
  const run = (cmd, opts) => sbx.commands.run(cmd, { timeoutMs: SETUP_MS, ...opts });
  const home = (await run('printf %s "$HOME"')).stdout.trim() || fail('Could not read $HOME on the machine.');
  await run(`command -v tmux >/dev/null || { sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux; } >/dev/null 2>&1; command -v tmux >/dev/null || { echo 'tmux is not installed on the machine' >&2; exit 1; }`);
  await run('gh auth setup-git'); // before the work-repo clone, so git uses the GH_TOKEN placeholder
  // A fresh machine has no git identity, which the coordinator needs to commit merges and its report. Use the laptop's.
  const ident = (k, d) => { try { return execFileSync('git', [...(ownsRepo(root) ? ['-C', root, 'config'] : ['config', '--global']), k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || d; } catch { return d; } };
  await run(`git config --global user.name ${q(`${ident('user.name', 'cloudy-cloud')} (coordinator)`)} && git config --global user.email ${q(ident('user.email', 'cloudy-cloud@localhost'))}`);
  // Upload this checkout (HEAD plus uncommitted tracked edits) so the machine runs exactly this version, pushed or not.
  const b = toolBundle(root);
  await sbx.files.write(`${home}/cloudy-cloud.bundle`, b.data);
  await run(`${toolInstallCmd(b, `${home}/cloudy-cloud.bundle`, toolRepoUrl(root))} && npm install --no-audit --no-fund`, { cwd: home });
  return home;
}

// The machine's name as the server reports it (the adapter fetches it on demand).
const nameOf = async (sbx) => (await sbx.loadName?.()) ?? sbx.name;

// One plain address: no spaces, control characters, angle brackets or quotes, and a sane length.
const validEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v);
// Returns { email } when the machine's Claude is signed in through the browser (a setup-token cannot open Remote Control
// sessions); email is '' when the status shows none. Returns null when it is not signed in.
async function signedIn(sbx) {
  try {
    const r = await sbx.commands.run('claude auth status --json', { timeoutMs: 60_000 });
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    if (!(j.loggedIn === true && j.authMethod === 'claude.ai')) return null;
    const email = j.email || j.account?.email;
    return { email: validEmail(email) ? email : '' };
  } catch { return null; }
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5); // local HH:MM

const PENDING_KEY = 'CLOUDY_CLOUD_PENDING_SNAPSHOT'; // MACHINE_ID:SNAPSHOT_ID of a snapshot still being saved, so a later run waits on it instead of starting another
const PENDING_ACCOUNT_KEY = 'CLOUDY_CLOUD_PENDING_ACCOUNT'; // the account of that snapshot's image machine ('none' when unknown), kept in the same write
const SNAPSHOT_WAIT_MS = 30 * 60_000;
const gone = (e) => e?.code === 'not_found' || e?.status === 404;
// Known limit: two --save runs at the same moment can both start a snapshot; nothing serialises them.
const readKey = (file, name) => { // throws on anything but a missing file, so a read error never looks like "no snapshot pending"
  try { return readFileSync(file, 'utf8').split('\n').findLast((l) => l.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''; } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

// Waits for the snapshot, saves its id, deletes the image machine (sbx, when it still exists), then drops the pending entry.
// email: the account the image is signed in as; '' means unknown (the saved account is dropped); null means leave it as saved.
async function finishSave(c, sbx, snap, email = '') {
  const t0 = c.now(); let shown = 0;
  while (snap.status === 'pending') {
    const waited = c.now() - t0;
    if (waited >= SNAPSHOT_WAIT_MS) guided(`The snapshot is still saving. Run cloudy-cloud coordinator image --save later to finish; it will not start a second one. (Snapshot ${snap.id}; the image machine was kept.)`, { short: 'The snapshot is still saving.', reason: `Snapshot ${snap.id}; the image machine was kept.`, next: 'cloudy-cloud coordinator image --save' });
    await c.sleep(5000);
    const half = Math.floor((c.now() - t0) / 30_000); // progress every 30 s of wall-clock time
    if (half > shown) { shown = half; c.progress(`Saving the image snapshot... ${Math.floor(half / 2)} min`); }
    snap = await c.provider.getSnapshot(snap.id);
  }
  if (snap.status && snap.status !== 'ready') { updateConfig(c.configFile, {}, [PENDING_KEY, PENDING_ACCOUNT_KEY]); guided(`Snapshot ${snap.id} has status ${snap.status}. The image machine was kept.`, { short: `Snapshot ${snap.id} has status ${snap.status}.`, reason: 'The image machine was kept.', next: 'cloudy-cloud coordinator image --save' }); }
  updateConfig(c.configFile, { [SNAPSHOT_KEY]: snap.id, ...(email && { [ACCOUNT_KEY]: email }) }, email === '' ? [ACCOUNT_KEY] : []); // the pending entry stays until the machine is deleted, so a failed delete retries only the delete
  if (sbx) await sbx.kill();
  updateConfig(c.configFile, {}, [PENDING_KEY, PENDING_ACCOUNT_KEY]);
  if (c.ui.term) return c.out([c.ui.ok(`Saved snapshot ${safeText(snap.id)}`, 'the image machine is deleted'),
    ...(email ? [hintFit(c.ui, `signed in as ${email}`)] : []),
    hintFit(c.ui, `Saved as ${SNAPSHOT_KEY} in ${tilde(c.configFile, c.env)}`),
    c.ui.next('cloudy-cloud coordinator start NAME --repo URL')].join('\n'));
  c.out(`Saved snapshot ${safeText(snap.id)} as ${SNAPSHOT_KEY} in ${c.configFile} and deleted the image machine.\nStart a coordinator with: cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO`);
}

// If an earlier run left a snapshot pending, finish that one (even when its machine is gone). Returns false when none is pending.
async function resumePending(c) {
  const [mid, sid] = readKey(c.configFile, PENDING_KEY).split(':');
  if (!sid) return false;
  c.progress(`A snapshot (${sid}) is already being saved. Waiting for it.`);
  let snap;
  try { snap = await c.provider.getSnapshot(sid); } catch (e) {
    if (!gone(e)) throw e; // a transient error keeps the entry
    updateConfig(c.configFile, {}, [PENDING_KEY, PENDING_ACCOUNT_KEY]);
    guided(`The pending snapshot ${sid} no longer exists, so it was forgotten. Run: cloudy-cloud coordinator image`, { short: `The pending snapshot ${sid} no longer exists.`, reason: 'It was forgotten.', next: 'cloudy-cloud coordinator image' });
  }
  let sbx = null;
  // The recorded machine id is only a claim: connect (and so finishSave's delete) happens only when a fresh
  // listing verifies it is still our image machine (purpose + role). An unverifiable machine is left alone.
  try { if ((await find(c.provider, 'coordinator-image')).some((m) => m.id === mid)) sbx = await c.provider.connect(mid, { retry: false }); } catch (e) { if (!gone(e)) throw e; }
  const saved = readKey(c.configFile, PENDING_ACCOUNT_KEY); // '' only for an entry written before this key existed
  await finishSave(c, sbx, snap, saved === 'none' ? '' : saved || null);
  return true;
}

async function saveNew(c, sbx, email) {
  c.progress('Saving the image snapshot. This can take 10 to 20 minutes.');
  const snap = await c.provider.snapshot(sbx, { name: `cloudy-cloud-coordinator-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`, description: 'cloudy-cloud coordinator image' });
  if (snap.status === 'pending') updateConfig(c.configFile, { [PENDING_KEY]: `${sbx.id}:${snap.id}`, [PENDING_ACCOUNT_KEY]: email || 'none' });
  return finishSave(c, sbx, snap, email);
}

const STORE_NOTE = 'Stored a coordinator copy of your Instabox key as a proxy secret (machines see a placeholder).';
const ADMIN_NEXT = 'cloudy-cloud setup --more (or ask a workspace admin)';
// The store notice: stderr for scripts and --json; on a terminal it follows the result on stdout.
// Emitted only after the store succeeded, once.
const storeNotice = (c, res, { json = false } = {}) => { if (res === 'stored') (c.ui.term && !json ? (s) => c.out(c.ui.hint(s)) : c.note)(STORE_NOTE); };

// The store error: a real key still refuses to go on a machine (key_on_machine_refused), but the cause is the failed
// store — a personal or machine key cannot write org secrets (403 missing_scope) — and the next step is setup --more.
// The provider's failure text is quoted in the cause as one line: a newline in it could otherwise forge a
// guidance label inside a message our own error carries.
const storeError = (detail) => Object.assign(new Error(
  `Could not store the coordinator copy of your Instabox key as a proxy secret.\nWhat happened: A real key was about to be placed on a machine whose provider keeps keys off machines.\nLikely cause: Storing the coordinator key needs a workspace-admin Instabox key.${detail ? ` ${String(detail).replaceAll('\n', ' ')}` : ''}\nNext step: ${ADMIN_NEXT}.`),
  { local: true, code: 'key_on_machine_refused', short: 'Could not store the coordinator key.', reason: 'Storing the coordinator key needs a workspace-admin Instabox key.', next: ADMIN_NEXT });

// Records the secret name locally: env for this run, the config file for later ones (the loader's last-line value
// wins, so read it). Write and read failures propagate — reporting success while the name was not saved repeats the write.
const recordCoordinatorSecret = (c) => {
  c.env.CLOUDY_CLOUD_PROXY_SECRETS = [...proxySecrets(c.env), COORDINATOR_KEY_SECRET].join(',');
  const file = readKey(c.configFile, 'CLOUDY_CLOUD_PROXY_SECRETS').split(/[\s,]+/).filter(Boolean);
  if (!file.includes(COORDINATOR_KEY_SECRET)) updateConfig(c.configFile, { CLOUDY_CLOUD_PROXY_SECRETS: [...file, COORDINATOR_KEY_SECRET].join(',') });
};

// The coordinator copy of the Instabox key (the CLOUDY_CLOUD_INSTABOX_API_KEY proxy secret, host api.instabox.sh) is
// stored by `setup --more`, but a plain `setup` leaves a real INSTABOX_API_KEY without it. image and start store it
// themselves the way setup does: the provider's secrets CLI with the value on stdin — never in argv or output.
// The remote decides, not the local name list: another laptop may already have stored it (then only the name is
// recorded here), and a local name whose remote secret is gone is stale (then it is stored again). A placeholder
// (ibsec_...) or a nested coordinator has nothing storable: 'skip', and the caller's refusal explains what to do.
// Returns 'stored' | 'linked' | 'skip'; throws storeError when a store was needed and could not happen.
async function storeCoordinatorSecret(c) {
  if (!c.provider.caps.hasProxySecrets || c.provider.coordinatorEnv || typeof c.provider.storeSecret !== 'function') return 'skip';
  const key = c.env[DEFAULT_PROVIDER_KEY];
  if (!key || key.startsWith('ibsec_') || c.env.CLOUDY_CLOUD_COORDINATOR) return 'skip';
  const local = proxySecrets(c.env).has(COORDINATOR_KEY_SECRET);
  const canList = typeof c.provider.listSecrets === 'function';
  let remote; // true/false when the org's secrets could be listed; undefined when they could not
  if (canList) { try { remote = (await c.provider.listSecrets()).has(COORDINATOR_KEY_SECRET); } catch { remote = undefined; } }
  if (remote === true) { if (local) return 'skip'; recordCoordinatorSecret(c); return 'linked'; }
  if (remote === false || (!local && !canList)) { // absent remotely, or the provider cannot check: store (or repair a stale name)
    try { await c.provider.storeSecret(COORDINATOR_KEY_SECRET, key); } catch (e) { throw storeError(e?.message?.replace(/Could not store the \S+ secret /, '').replaceAll(key, '[redacted]')); }
    recordCoordinatorSecret(c);
    return 'stored';
  }
  if (!local) throw storeError('the Instabox secrets could not be listed'); // remote unverifiable: do not write blind
  return 'skip'; // the local list claims it and the remote could not be checked: keep the name
}

async function image(c, args) {
  refuseEgress(c.env);
  const stored = await storeCoordinatorSecret(c); // repair the coordinator key on every path; a failed store is not silent
  if (await resumePending(c)) return storeNotice(c, stored);
  const [img] = (await find(c.provider, 'coordinator-image')).sort((a, b) => b.startedAt - a.startedAt);
  if (args.includes('--save')) {
    if (!img) guided('No image machine found. Image machines are deleted 2 hours after cloudy-cloud coordinator image creates them. Run: cloudy-cloud coordinator image', { short: 'No image machine found.', reason: 'Image machines are deleted 2 hours after cloudy-cloud coordinator image creates them.', next: 'cloudy-cloud coordinator image', neutral: true });
    const sbx = await c.provider.connect(img.id, { retry: false });
    const who = await signedIn(sbx);
    if (!who) guided(`Claude is not signed in on ${img.name}. Run: cloudy-cloud coordinator image`, { short: `Claude is not signed in on ${img.name}.`, next: 'cloudy-cloud coordinator image' });
    const r = await saveNew(c, sbx, who.email);
    storeNotice(c, stored);
    return r;
  }
  let sbx, name, started;
  if (img) {
    c.progress(`Using the image machine ${safeText(img.name)} you already started.`);
    sbx = await c.provider.connect(img.id, { retry: false });
    name = img.name; started = new Date(img.startedAt).getTime();
  } else {
    c.progress('Creating the image machine...');
    sbx = await c.provider.create({ image: TEMPLATE, labels: { purpose: 'cloudy-cloud', role: 'coordinator-image' }, ttlSeconds: IMAGE_SECONDS, neverSuspend: true, retry: false });
    started = Date.now();
    try {
      c.progress('Connecting GitHub and installing tools (this can take a few minutes)...');
      await installTool(sbx, c.root);
    } catch (e) { await sbx.kill().catch(() => {}); throw e; }
    name = await nameOf(sbx);
  }
  const shownName = safeText(name ?? ''); // the server-reported name is display data
  const shellWord = word(name, sbx.id); // a suggested `shell` command takes only a plain word — the id when the name is not one
  const until = clock(started + IMAGE_SECONDS * 1000);
  const firstStep = shellWord ? `1. cloudy-cloud shell ${shellWord}` : '1. open a shell on the image machine';
  const fallback = `Image machine ${shownName} is ready and cloudy-cloud is installed on it. It is deleted at ${until}.\n\nSign in to Claude on it (a setup-token cannot open Remote Control sessions):\n\n  ${firstStep}\n  2. claude auth login\n  3. exit\n  4. cloudy-cloud coordinator image --save`;
  if (!c.tty) {
    c.out(c.ui.term ? [statusLine(c.ui, 'ok', `Image machine ${shownName} is ready`, [`cloudy-cloud installed; deleted at ${until}`]), '',
      '  Sign in to Claude on it (a setup-token cannot open Remote Control sessions):', `    ${firstStep}`, '    2. claude auth login', '    3. exit', c.ui.next('cloudy-cloud coordinator image --save')].join('\n') : fallback);
    return storeNotice(c, stored);
  }
  const already = img && await signedIn(sbx);
  if (already) { const r = await saveNew(c, sbx, already.email); storeNotice(c, stored); return r; } // an earlier run already finished the sign-in
  c.out(`Claude will show a link. Open it, sign in, and paste the code it shows when asked. This machine is deleted at ${until} if you don't finish.`);
  const [bin, ...rest] = c.provider.shellArgv(sbx.id, ['claude', 'auth', 'login'], { tty: true });
  for (let n = 1; ; n++) {
    const r = c.spawn(bin, rest, { stdio: 'inherit', env: { ...process.env, ...c.provider.shellEnv?.() } });
    // Trust `claude auth status`, not the ssh exit code (unverified for `claude auth login` over instabox ssh); the machine was not signed in before this login.
    const who = !r?.error && await signedIn(sbx);
    if (who) { const saved = await saveNew(c, sbx, who.email); storeNotice(c, stored); return saved; }
    const answer = n >= 3 ? 'n' : (await c.ask('Sign-in did not finish. Try again? [Y/n] '))?.trim() ?? 'n'; // closed stdin (Ctrl-D) declines
    if (/^n/i.test(answer)) guided(`Sign-in did not finish.\n\n${fallback}`, { short: 'Sign-in did not finish.', details: fallback.split('\n').slice(0, -1), next: 'cloudy-cloud coordinator image --save' });
  }
}

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const customHost = (env, key) => { try { const p = Object.values(loadProfiles(env)).find((x) => x?.keyName === key); return URL.canParse(p?.baseUrl) ? new URL(p.baseUrl).host : undefined; } catch { return undefined; } };

async function start(c, args) {
  refuseEgress(c.env);
  const name = args[0];
  if (!name || !NAME_RE.test(name)) usageError('Usage: cloudy-cloud coordinator start NAME --repo <github https url> [--branch B]\nNAME: lowercase letters, digits and -, up to 40 characters.', 'start', 'NAME must use lowercase letters, digits and hyphens (1 to 40 characters).');
  const repo = flag(args, '--repo');
  if (!repo || !REPO_RE.test(repo)) usageError('--repo must be a github.com https URL, for example https://github.com/OWNER/REPO', 'start', '--repo must be a github.com https URL.', ['For example https://github.com/OWNER/REPO']);
  const branch = flag(args, '--branch');
  if (branch && !/^[\w./-]+$/.test(branch)) usageError('--branch has characters that are not allowed.', 'start', '--branch has characters that are not allowed.');
  const model = flag(args, '--model');
  if (model !== undefined && !/^[A-Za-z0-9._:\[\]-]+$/.test(model)) usageError('--model has characters that are not allowed. Use a model name such as claude-opus-5-5 or an alias such as opus.', 'start', '--model has characters that are not allowed.', ['Use a model name such as claude-opus-5-5 or an alias such as opus.']);
  const taskFile = flag(args, '--task-file');
  const task = taskFile ? readFileSync(taskFile, 'utf8') : flag(args, '--task');
  if (task !== undefined) {
    if (!task.trim()) usageError('The task is empty.', 'start', 'The task is empty.');
    if (Buffer.byteLength(task) > TASK_MAX) usageError(`The task is larger than ${TASK_MAX / 1000} KB.`, 'start', `The task is larger than ${TASK_MAX / 1000} KB.`);
  }
  const maxHours = c.provider.caps.maxTtlSeconds / 3600;
  const hours = flag(args, '--max-hours') === undefined ? maxHours : Number(flag(args, '--max-hours'));
  const seconds = Math.round(hours * 3600);
  if (!(seconds >= 60 && seconds <= maxHours * 3600)) usageError(`--max-hours must be a number up to ${maxHours} (${c.provider.name[0].toUpperCase()}${c.provider.name.slice(1)} deletes a machine after at most ${maxHours} hours).`, 'start', `--max-hours must be a number up to ${maxHours}.`, [`${c.provider.name[0].toUpperCase()}${c.provider.name.slice(1)} deletes a machine after at most ${maxHours} hours.`]);
  const deleteAt = new Date(Date.now() + seconds * 1000).toISOString();
  const snapshot = c.env[SNAPSHOT_KEY];
  if (!snapshot) guided('No coordinator image yet. Run: cloudy-cloud coordinator image', { short: 'No coordinator image yet.', reason: 'Coordinators start from a saved, signed-in image.', next: 'cloudy-cloud coordinator image', neutral: true });
  if ((await find(c.provider, 'coordinator', name)).length) guided(`A coordinator named ${name} already exists. Stop it first: cloudy-cloud coordinator stop ${name}`, { short: `A coordinator named ${name} already exists.`, next: `cloudy-cloud coordinator stop ${name}` });
  let screenRead = true, waiting = ''; // set when the session's screen waits on a prompt a person answers by attaching
  // Keys named in CLOUDY_CLOUD_PROXY_SECRETS go as attached secrets; the env file holds their names and the settings only.
  // A plain setup leaves a real INSTABOX_API_KEY without the coordinator copy: store or repair it now, then read the keys.
  const stored = await storeCoordinatorSecret(c); // throws the workspace-admin error when the store was needed and failed
  const keys = coordinatorKeys(c.env, c.provider);
  if (keys.legacy.length) {
    const k = keys.legacy[0];
    // The coordinator copy of the Instabox key is only moved by `setup --more`; other keys keep the generic setup text.
    const g = k === DEFAULT_PROVIDER_KEY
      ? { whatHappened: 'A real key was about to be placed on a machine whose provider keeps keys off machines.', likelyCause: 'The key was passed the old way, not as a proxy secret.', nextStep: 'Run `cloudy-cloud setup --more` (it stores the coordinator copy of your Instabox key), or ask a workspace admin.' }
      : guideObj('key_on_machine_refused');
    throw Object.assign(new Error(`${k} is set as a real value, not as a proxy secret.\nWhat happened: ${g.whatHappened}\nLikely cause: ${g.likelyCause}\nNext step: ${g.nextStep}`), { local: true, code: 'key_on_machine_refused' });
  }
  // An optional key that is not stored as a proxy secret is not sent (never as a value); say so, with the command to store it.
  const custom = keys.skipped.filter((k) => !SECRET_HOSTS[k]);
  const skipNote = keys.skipped.length ? `Not sent to the coordinator (not stored as proxy secrets): ${keys.skipped.join(', ')}. Store them with \`cloudy-cloud setup --more\`${custom.length ? '. For a custom key: ' + custom.map((k) => guideObj('key_on_machine_refused', { secret: k, host: customHost(c.env, k) }).nextStep).join(' ') : ''}` : '';
  c.progress('Creating the coordinator machine...');
  const sbx = await c.provider.create({ image: snapshot, name: `coord-${name}`, ...(keys.secrets.length && { secrets: keys.secrets }), labels: { purpose: 'cloudy-cloud', role: 'coordinator', name }, ttlSeconds: seconds, neverSuspend: true, retry: false });
  try {
    c.progress('Connecting GitHub and installing tools (this can take a few minutes)...');
    const home = await installTool(sbx, c.root);
    const dir = `${home}/.config/cloudy-cloud`;
    await sbx.commands.run(`mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`);
    await sbx.files.write(`${dir}/env`, `${keys.lines.join('\n')}\n`); // values never appear in a command string
    await sbx.commands.run(`chmod 600 ${q(`${dir}/env`)}`);
    c.progress('Cloning the repository...');
    await sbx.commands.run(`rm -rf ~/repo && git clone -q ${branch ? `-b ${q(branch)} ` : ''}${q(repo)} ~/repo`, { timeoutMs: SETUP_MS });
    c.progress('Starting the Claude session...');
    // Claude Code shows first-run screens (theme, login method, trust, notices) that nobody can answer on an unattended
    // machine, and they block Remote Control. The login itself is in the snapshot; mark the rest done.
    await sbx.commands.run(`node -e ${q(FIRST_RUN_SCRIPT)}`);
    // Give the coordinator's Claude the fleet skill from this laptop, so it matches the instructions the local Claude has.
    const skillDir = join(c.root, 'skills', 'cloud-fleet');
    for (const f of readdirSync(skillDir)) await sbx.files.write(`${home}/.claude/skills/cloud-fleet/${f}`, readFileSync(join(skillDir, f)));
    // The task text goes up as a file, never in a command string; the shell in tmux reads it when Claude starts.
    if (task !== undefined) await sbx.files.write(`${home}/task.md`, `${deadlineLine(deleteAt)}\n\n${task}`);
    const prompt = task !== undefined ? ` "$(cat ${q(`${home}/task.md`)})"` : '';
    // The secrets stay attached to the machine (workers are attached by name), but this Claude must not see them:
    // a setup-token cannot start Remote Control and an env token beats the saved full login (code.claude.com/docs/en/remote-control).
    await sbx.commands.run(`tmux kill-session -t claude 2>/dev/null; tmux new-session -d -s claude -c ~/repo ${q(`env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLOUDY_CLOUD_COORDINATOR=1 CLOUDY_CLOUD_DELETE_AT=${deleteAt} "PATH=${home}/cloudy-cloud/bin:$PATH" ${home}/cloudy-cloud/bin/cloudy-cloud --remote-control ${q(name)}${model ? ` --model ${q(model)}` : ''}${prompt}`)}`);
    // A session that started but cannot work (spend limit, login, trust or MCP prompt) looks fine from outside. Read its screen.
    await c.sleep(5000);
    let pane = '';
    try { pane = (await sbx.commands.run('tmux capture-pane -t claude -p')).stdout ?? ''; } catch (e) {
      // A command that ran and failed carries exitCode (no tmux session). Anything else is the provider or network: the session may be fine.
      if (typeof e?.exitCode === 'number') throw Object.assign(new Error(`The Claude session on the new machine exited right after it started. The machine was deleted.\nLikely cause: the saved Claude login is missing or expired.\nNext: run cloudy-cloud coordinator image, sign in with claude auth login, run cloudy-cloud coordinator image --save, then start the coordinator again.`), { local: true, short: 'The Claude session on the new machine exited right after it started.', reason: 'the saved Claude login is missing or expired; the machine was deleted', next: 'cloudy-cloud coordinator image' });
      screenRead = false;
    }
    // The task is typed into the session, so its own lines can be on screen; they are not errors. Configured values are
    // removed before the screen is classified or fitted into an error, same as for `ls`/`status`.
    const st = paneState(secretValues(c.env, c.provider.keyName, consentedLiterals(c.env)).reduce((t, v) => t.split(v).join('[redacted]'), pane), task ?? '');
    const line = st.blocked;
    if (!line && st.waiting) waiting = st.waiting;
    if (line) {
      // The code comes from the matched line, never from words in this message (classify would read "spend limit" as the cause).
      const again = `run cloudy-cloud coordinator image (it signs you in to Claude and saves the image), then start ${name} again`;
      const [code, cause, next, nextCmd] = /limit|credit balance/i.test(line) ? ['spend_limit', 'the saved Claude login has hit its spend or usage limit', `check the plan at claude.ai, then run cloudy-cloud coordinator start ${name} again`, `check the plan at claude.ai, then start ${name} again`]
        : /invalid api key/i.test(line) ? ['coordinator_invalid_key', 'the session reports an invalid API key', again, 'cloudy-cloud coordinator image']
        : ['coordinator_login_expired', 'the saved Claude login has expired or is signed out', again, 'cloudy-cloud coordinator image'];
      throw Object.assign(new Error(`The coordinator session started but is not working. Its screen shows: ${line}\nThe machine was deleted.\nLikely cause: ${cause}.\nNext: ${next}.`), { local: true, code, short: 'The coordinator session started but is not working.', reason: `screen: ${fitCells(line, 40)}; the machine was deleted`, next: nextCmd });
    }
  } catch (e) { await sbx.kill().catch(() => {}); throw e; }
  const machine = await nameOf(sbx);
  const shownMachine = safeText(machine ?? ''); // the server-reported name is display data
  const machineWord = word(machine, sbx.id); // a suggested ssh command takes only a plain word — the id when the name is not one
  if (!args.includes('--json') && skipNote && !c.ui.term) c.out(skipNote); // a terminal shows it below the success line
  if (args.includes('--json')) { c.out(JSON.stringify({ name, machine: shownMachine, remoteControlName: name, ...(machineWord ? { attach: c.ssh(machineWord, 'tmux attach -t claude') } : {}), started: true, ...(skipNote && { skippedKeys: keys.skipped, note: skipNote }), ...(waiting && { waiting }), ...(!screenRead && { screenRead: false }) })); return storeNotice(c, stored, { json: true }); }
  const needsLook = !screenRead || !!waiting; // only then can the first-run prompts be what blocks it
  if (c.ui.term) {
    const u = c.ui;
    const head = `Coordinator ${name} is running`;
    // The deadline lives in the ok detail; a long name drops it to its own dimmed line rather than dropping it.
    const okLine = statusLine(u, 'ok', head, [`It never pauses; the server deletes it ${u.rel(deleteAt)}.`, `the server deletes it ${u.rel(deleteAt)}`, `deleted ${u.rel(deleteAt)}`]);
    const warn = !screenRead ? [u.warn('Could not read the session screen to check it started'), u.hint('Attach once and accept any trust or Remote Control prompts.')]
      : waiting ? [u.warn('The session is waiting on a prompt', fitCells(waiting, Math.max(8, u.width - 40)))] : [];
    // The block's label column takes 21 cells (Remote Control is the widest at 14). A long name first shortens the
    // Remote Control hint, then moves the two commands onto their own lines so they stay whole and runnable.
    const room = u.width - 21;
    const rc = [`open claude.ai/code or the Claude app, pick "${name}"`, `pick "${name}" on claude.ai/code or the app`, `pick "${name}"`]
      .find((v) => cellWidth(v) <= room) ?? fitCells(`pick "${name}"`, room);
    const reach = (rows) => u.block('Reach it', rows);
    const full = reach([['Remote Control', rc], ['Terminal', `cloudy-cloud coordinator attach ${name}`], ['Stop', `cloudy-cloud coordinator stop ${name}`]]);
    const block = full.split('\n').every((l) => cellWidth(l) <= u.width) ? full
      : [reach([['Remote Control', rc]]), `    cloudy-cloud coordinator attach ${name}`, `    cloudy-cloud coordinator stop ${name}`].join('\n');
    // The warning wraps whole words: a key name is never cut, and a custom key keeps its host-specific instructions.
    const skipBlock = !skipNote ? [] : [
      ...wrapText(u, `Not sent to the coordinator (not stored as proxy secrets): ${keys.skipped.join(', ')}`).map((l, i) => (i ? `    ${u.dim(l)}` : u.warn(l))),
      ...(custom.length < keys.skipped.length ? [u.hint('Store them with `cloudy-cloud setup --more`.')] : []),
      ...custom.flatMap((k) => wrapText(u, `For ${k}: ${guideObj('key_on_machine_refused', { secret: k, host: customHost(c.env, k) }).nextStep}`).map((l) => `    ${u.dim(l)}`)),
    ];
    return c.out([okLine, ...warn, ...skipBlock, '', block,
      ...(stored === 'stored' ? [u.hint(STORE_NOTE)] : []),
      ...(needsLook ? ['', nextFit(u, `cloudy-cloud coordinator attach ${name}`)] : [])].join('\n'));
  }
  c.out((!screenRead ? `Could not read the session screen to check it started.\nLook with: cloudy-cloud coordinator attach ${name}\n\n` : waiting ? `The session is waiting on a prompt: ${waiting}\nRun: cloudy-cloud coordinator attach ${name}, then accept the prompt.\n\n` : '') + `Coordinator ${name} is running on machine ${shownMachine}${task !== undefined ? ' and has started on the task' : ''}. It never pauses. The server deletes it at ${deleteAt}.\n\nReach it:\n  - Remote Control: open claude.ai/code or the Claude app and pick the session named "${name}".\n` +
    `  - Terminal: cloudy-cloud coordinator attach ${name}${machineWord ? `\n    (runs: ${c.ssh(machineWord, 'tmux attach -t claude')})` : ''}\n\n${needsLook ? 'Attach once and accept any trust or Remote Control prompts.\n' : ''}Stop it earlier with: cloudy-cloud coordinator stop ${name}`);
  storeNotice(c, stored); // piped stdout keeps only the result; the notice is on stderr
}

async function attach(c, args) {
  const [m] = await find(c.provider, 'coordinator', args[0] || usageError('Usage: cloudy-cloud coordinator attach NAME', 'attach', 'attach needs a coordinator name.'));
  if (!m) guided(`No coordinator named ${args[0]}. List them with: cloudy-cloud coordinator ls`, { short: `No coordinator named ${args[0]}.`, next: 'cloudy-cloud coordinator ls', neutral: true });
  if (c.tty) { // on a terminal, open the session here
    const [bin, ...rest] = c.provider.shellArgv(mach(m), ['tmux', 'attach', '-t', 'claude'], { tty: true });
    const r = c.spawn(bin, rest, { stdio: 'inherit', env: { ...process.env, ...c.provider.shellEnv?.() } });
    if (r?.error) guided(`Could not start ${bin} (${r.error.message}). Install it or run: cloudy-cloud doctor`, { short: `Could not start ${bin} (${r.error.message}).`, reason: 'Install it first, or:', next: 'cloudy-cloud doctor' });
    return r?.status ?? (r?.signal ? 128 + (osConstants.signals[r.signal] ?? 0) : 1);
  }
  if (c.ui.term) c.out(c.ui.hint('Run this to attach:'));
  const target = word(mach(m), m.id); // the printed command takes a plain word, or the name the user gave
  c.out(target ? c.ssh(target, 'tmux attach -t claude') : `cloudy-cloud coordinator attach ${args[0]}`);
}

// Reads a coordinator's screen once, read-only. waiting is the prompt line a person must answer ('' if none);
// read is false when the screen could not be read (machine not running, network, no tmux session).
async function screenOf(c, m) {
  if (m.state && m.state !== 'running') return { read: false, waiting: '' };
  try {
    const sbx = await c.provider.connect(m.id, { retry: false });
    const raw = (await sbx.commands.run('tmux capture-pane -t claude -p', { timeoutMs: 15_000 })).stdout ?? '';
    // Exact key values (and consented MCP tokens) are removed first; paneState then removes key-shaped text.
    const pane = secretValues(c.env, c.provider.keyName, consentedLiterals(c.env)).reduce((t, v) => t.split(v).join('[redacted]'), raw);
    const st = paneState(pane);
    return { read: true, waiting: st.waiting || st.blocked };
  } catch { return { read: false, waiting: '' }; }
}
const screenText = (r) => (!r.read ? 'screen not read' : r.waiting ? `waiting on a prompt: ${r.waiting}` : '-');

async function status(c, args) {
  const [m] = await find(c.provider, 'coordinator', args[0]);
  if (!m) guided(`No coordinator named ${args[0]}. List them with: cloudy-cloud coordinator ls`, { short: `No coordinator named ${args[0]}.`, next: 'cloudy-cloud coordinator ls', neutral: true });
  const r = await screenOf(c, m), name = args[0], state = safeText(m.state ?? '') || 'unknown';
  const shown = safeText(mach(m) ?? '') || 'unknown'; // the server-reported name is display data
  const target = word(mach(m), m.id); // a suggested ssh command takes a plain word, or the name the user gave
  const attach = target ? c.ssh(target, 'tmux attach -t claude') : `cloudy-cloud coordinator attach ${name}`;
  if (args.includes('--json')) return c.out(JSON.stringify({ name, machine: shown, state, screenRead: r.read, ...(r.waiting && { waiting: r.waiting }), attach }));
  if (c.ui.term) {
    const u = c.ui;
    const screen = !r.read ? 'not readable' : r.waiting ? `waiting on a prompt: ${u.paint(u.col.warn, fitCells(r.waiting, Math.max(8, u.width - 35)))}` : 'no prompt waiting';
    // a stopped coordinator has no live session to attach to: no attach action
    return c.out([u.block(`Coordinator ${name}`, [['Machine', shown], ['State', state], ['Screen', screen]]), r.waiting ? nextFit(u, `cloudy-cloud coordinator attach ${name}`) : state === 'running' ? attachFit(u, name) : ''].filter(Boolean).join('\n'));
  }
  c.out([`Coordinator ${name} on machine ${shown}: ${state}`, `Screen: ${screenText(r)}`, r.waiting && `Answer it by attaching, or with Remote Control: ${attach}`, !r.waiting && `Attach: ${attach}`].filter(Boolean).join('\n'));
}

async function ls(c) {
  const rows = await find(c.provider, 'coordinator');
  if (!rows.length) {
    if (!c.ui.term) return c.out('No coordinators.');
    // On a provider that cannot run coordinators there is no coordinator command to point at.
    if (c.provider.text?.coordinatorRefusal || !c.provider.caps?.hasSnapshots) return c.out('  No coordinators yet.');
    return c.out(['  No coordinators yet.', c.ui.next(c.env[SNAPSHOT_KEY] ? 'cloudy-cloud coordinator start NAME --repo URL' : 'cloudy-cloud coordinator image')].join('\n'));
  }
  // Names and states come from the server, so strip terminal control characters before printing them.
  const clean = (v) => safeText(v ?? '').replace(/\n/g, ' ');
  const when = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : 'unknown'; };
  const data = rows.map((m) => ({ name: clean(m.labels?.name) || 'unnamed', state: clean(m.state) || 'unknown', created: when(m.startedAt), machine: clean(mach(m)) || 'unknown',
    deleteAt: m.deleteAt ? clean(m.deleteAt) : '' }));
  // One pane read per coordinator, at most a few at a time so a long list cannot flood the provider.
  const screens = new Array(rows.length), cap = Math.min(4, c.provider.caps?.maxConcurrentCalls || 4);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(cap, rows.length) }, async () => { while (next < rows.length) { const i = next++; screens[i] = await screenOf(c, rows[i]); } }));
  data.forEach((d, i) => { d.screen = data[i].state === 'running' ? screenText(screens[i]) : '-'; }); // only a running session has a screen to read
  if (c.ui.term) {
    const u = c.ui, color = { running: u.col.ok, creating: u.col.warn, suspended: u.col.warn, paused: u.col.warn };
    const noted = data.some((d) => d.screen !== '-'); // a column only when some screen needs a look
    const waitingRow = data.find((d, i) => d.screen.startsWith('waiting') && NAME_RE.test(rows[i].labels?.name ?? '')); // the attach hint needs a server name that is also a valid argument
    const done = (text) => c.out(waitingRow ? `${text}\n\n${nextFit(u, `cloudy-cloud coordinator attach ${waitingRow.name}`)}` : text);
    const anyNever = data.some((d) => !d.deleteAt); // with one open-ended row, the absolute dates are noise, not info
    // Try the full table, then shorten SCREEN with an ellipsis, then drop the date, then the MACHINE column.
    const build = ({ machine, date, screenMax }) => {
      const cells = data.map((d) => [d.name, [[d.state, color[d.state] ?? u.col.err]], u.rel(d.created), ...(machine ? [d.machine] : []),
        d.deleteAt ? [[u.rel(d.deleteAt)], ...(date && !anyNever ? [[`  ${d.deleteAt.slice(0, 16)}Z`, u.col.dim]] : [])] : [['never', u.col.dim]]]);
      if (noted) cells.forEach((row, i) => { const t = data[i].screen; row.push([[fitCells(t, screenMax), t.startsWith('waiting') ? u.col.warn : u.col.dim]]); });
      return u.table(['NAME', 'STATE', 'STARTED', ...(machine ? ['MACHINE'] : []), 'DELETES', ...(noted ? ['SCREEN'] : [])], cells);
    };
    // A waiting prompt that cannot keep 24 cells in its column moves to a dimmed line under its own row instead of an ellipsis.
    const buildTwo = ({ machine }) => {
      const cells = data.map((d) => [d.name, [[d.state, color[d.state] ?? u.col.err]], u.rel(d.created), ...(machine ? [d.machine] : []),
        d.deleteAt ? [[u.rel(d.deleteAt)]] : [['never', u.col.dim]], ...(noted ? [[[d.screen.startsWith('waiting') ? 'waiting' : d.screen, d.screen.startsWith('waiting') ? u.col.warn : u.col.dim]]] : [])]);
      const lines = u.table(['NAME', 'STATE', 'STARTED', ...(machine ? ['MACHINE'] : []), 'DELETES', ...(noted ? ['SCREEN'] : [])], cells).split('\n');
      const out = [lines[0]];
      data.forEach((d, i) => { out.push(lines[i + 1]); if (d.screen.startsWith('waiting')) out.push(`    ${u.dim(fitCells(d.screen.slice(21), Math.max(8, u.width - 4)))}`); });
      return out.join('\n');
    };
    const widest = (t) => Math.max(...t.split('\n').map(cellWidth));
    for (const o of [{ machine: true, date: true }, { machine: true, date: false }, { machine: false, date: false }]) {
      let table = build({ ...o, screenMax: 1000 });
      if (widest(table) > u.width && noted) { // shorten SCREEN by the excess, but keep at least 24 characters of it
        const longest = Math.max(...data.map((d) => cellWidth(d.screen))), max = longest - (widest(table) - u.width);
        table = max >= 24 ? build({ ...o, screenMax: max }) : buildTwo(o);
      }
      if (widest(table) <= u.width) return done(table);
    }
    // A window too narrow even for that gets one short block per coordinator instead of wrapped columns.
    return done(data.map((d) => [`  ${u.bold(d.name)} [${d.state}]`, `    Machine: ${d.machine}`, `    Created: ${d.created}`, `    Deletes: ${d.deleteAt || 'never'}`, ...(d.screen !== '-' ? [`    Screen: ${fitCells(d.screen, u.width - 12)}`] : [])].join('\n')).join('\n\n'));
  }
  c.out(['NAME', 'STATE', 'CREATED', 'MACHINE', 'DELETES', 'WAITING'].join('\t'));
  for (const d of data) c.out([d.name, d.state, d.created, d.machine, d.deleteAt || 'never', d.screen].join('\t'));
}

async function stop(c, args) {
  const name = args[0] || usageError('Usage: cloudy-cloud coordinator stop NAME', 'stop', 'stop needs a coordinator name.');
  const [m] = await find(c.provider, 'coordinator', name);
  if (!m) guided(`No coordinator named ${name}. List them with: cloudy-cloud coordinator ls`, { short: `No coordinator named ${name}.`, next: 'cloudy-cloud coordinator ls', neutral: true });
  c.progress('Deleting the coordinator machine...');
  await c.provider.delete(m.id, { sdk: true });
  if (c.ui.term) return c.out([statusLine(c.ui, 'ok', `Deleted coordinator ${name}`, [`machine ${safeText(mach(m))}`]),
    c.ui.hint('Its workers go with its cleanup or at their own deadline.'),
    hintFit(c.ui, `List machines: ${c.provider.text.listMachines}`)].join('\n'));
  c.out(`Deleted coordinator ${name} (machine ${safeText(mach(m))}). Its workers are deleted by its cleanup process, or by their own delete deadline (6 hours by default). Check with: ${c.provider.text.listMachines}`);
}

// Run ON a coordinator machine by the coordinator itself: checks that nothing is lost, then deletes this machine.
async function finish(c, args, deps) {
  const force = args.includes('--force');
  const host = deps.hostname ?? osHostname();
  const mname = c.provider.localMachineName(host);
  const notHere = `This is not a coordinator machine (hostname ${host}). finish only runs on a machine started with: cloudy-cloud coordinator start`;
  const notHereFields = { short: 'This is not a coordinator machine.', reason: `hostname ${host}`, next: 'cloudy-cloud coordinator start NAME --repo URL' };
  if (!mname) guided(notHere, notHereFields);
  const me = (await c.provider.list({ role: 'coordinator' })).find((m) => mach(m) === mname && m.labels?.purpose === 'cloudy-cloud' && m.labels?.role === 'coordinator');
  if (!me?.id) guided(notHere, notHereFields);
  const verified = [`machine ${safeText(mach(me))} (${safeText(me.id)}), coordinator ${safeText(me.labels?.name)}`];
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
    } catch (e) { guided(`Could not read the git repo ${repo}: ${e.stderr || e.message}`, { short: `Could not read the git repo ${repo}.`, reason: e.stderr || e.message, details: ['Or skip the checks and delete anyway: cloudy-cloud coordinator finish --force'], next: 'fix the problem above, then run: cloudy-cloud coordinator finish' }); }
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
    if (problems.length) guided(`Not deleting this machine, because work could be lost:\n- ${problems.join('\n- ')}\nFix these and run finish again, or use --force to delete anyway.`, { short: 'Not deleting this machine, because work could be lost.', details: [...problems.map((p) => `- ${p}`), 'Fix these and run finish again, or use --force to delete anyway.'], next: 'fix the problems above, then run: cloudy-cloud coordinator finish' });
    verified.push('working tree clean', `pushed: ${safeText(branches.join(', '))}`, 'no running workers');
  }
  // One attempt; list and delete here use the raw API, as finish always has (ls, attach, stop use the SDK).
  await c.provider.delete(me.id, { retries: 0 }).catch((e) => { throw e.status ? Object.assign(new Error(`Delete failed: HTTP ${e.status}`), { local: true }) : e; });
  if (c.ui.term) return c.out([...verified.flatMap((v) => wrapText(c.ui, v).map((l, i) => (i ? `    ${c.ui.dim(l)}` : c.ui.ok(l)))), ...wrapText(c.ui, `Deleted this machine (${safeText(mach(me))})`).map((l, i) => (i ? `    ${c.ui.dim(l)}` : c.ui.ok(l)))].join('\n'));
  c.out(`Verified: ${verified.join('; ')}.\nDeleted this machine (${safeText(mach(me))}).`);
}

// Rejects bad arguments before any key is read or the network is touched.
const START_OPTIONS = ['--repo', '--branch', '--task', '--task-file', '--max-hours', '--model'];
function validateArgs(cmd, args) {
  const bad = (message) => usageError(`${message}\nRun: cloudy-cloud coordinator ${cmd} --help`, cmd, message);
  if (cmd === 'image') { if (args.some((a) => a !== '--save') || args.length > 1) bad('Expected image or image --save.'); return; }
  if (cmd === 'status') { if (!NAME_RE.test(args[0] ?? '') || args.slice(1).some((a) => a !== '--json') || args.length > 2) bad('Expected status NAME [--json].'); return; }
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

async function run(argv, deps) {
  const [cmd, ...args] = argv;
  const commands = { image, start, attach, ls, status, stop, finish: (c, a) => finish(c, a, deps) };
  const isHelp = (a) => a === '--help' || a === '-h';
  if ((isHelp(cmd) && !args.length) || (Object.hasOwn(commands, cmd) && args.length === 1 && isHelp(args[0]))) {
    return (deps.out ?? console.log)(coordinatorHelp(Object.hasOwn(commands, cmd) ? cmd : undefined));
  }
  if (!Object.hasOwn(commands, cmd)) usageError('Usage: cloudy-cloud coordinator image [--save] | start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--json] | attach NAME | ls | status NAME [--json] | stop NAME | finish [--force]\nRun: cloudy-cloud coordinator --help', undefined, cmd ? `"${cmd}" is not a coordinator command.` : 'coordinator needs a command.');
  validateArgs(cmd, args);
  const c = await context(deps);
  // A provider that cannot run coordinators at all says so in its own words first (it may name a working alternative);
  // only then does the generic snapshots check apply. The first sentence is the problem; it wraps, never truncates.
  if ((cmd === 'image' || cmd === 'start') && c.provider.text?.coordinatorRefusal) {
    const s = c.provider.text.coordinatorRefusal.split(/(?<=\.) +/); // a second sentence is the action
    guided(c.provider.text.coordinatorRefusal, { short: s[0], details: s.slice(1, -1), next: s.length > 1 ? s.at(-1) : 'cloudy-cloud coordinator --help', wrapShort: true });
  }
  if ((cmd === 'image' || cmd === 'start') && !c.provider.caps.hasSnapshots) guided(`Provider ${c.provider.name} has no snapshots, which coordinators need.`, { short: `Provider ${c.provider.name} has no snapshots, which coordinators need.`, next: 'cloudy-cloud setup --provider instabox' });
  try { return await commands[cmd](c, args); } catch (e) {
    // The key error always folds into one line for scripts; the terminal fields carry the same Next.
    if (e?.code === 'no_key') guided(`${e.message} Run: cloudy-cloud setup`, { short: e.message, next: 'cloudy-cloud setup' });
    throw e;
  }
}

// Every `start` failure (bad arguments, missing key, provider errors) gets guidance, scrubbed of exact configured
// secret values; --json also prints it as one error object.
export async function main(argv, deps = {}) {
  try { return await run(argv, deps); } catch (e) {
    if (argv[0] !== 'start') throw e;
    const env = deps.env ?? loadEnv();
    const secrets = Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET/i.test(k) && String(v ?? '').length >= 8).map(([, v]) => String(v));
    const clean = (s) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), redact(String(s)));
    const message = clean(e?.message ?? e);
    const code = CODES.includes(e?.code) ? e.code : classify(message);
    // A message whose own lines start with the guidance labels is already guided — but only when the error is
    // ours (`local`): the same labels inside provider or other foreign text are data, not our guidance.
    const { fields } = parseGuidance(message);
    const has = e?.local === true && !!(fields['What happened']?.trim() && fields['Next step']?.trim());
    const f = (n) => fields[n]?.trim() || undefined;
    // Embedded guidance fields win over the code's template: the message author chose them (e.g. setup --more for the coordinator key).
    const g = has
      ? { code, whatHappened: f('What happened'), likelyCause: f('Likely cause'), nextStep: f('Next step'), tellUser: f('Tell the user') }
      : guideObj(code, { message, secrets });
    if (argv.includes('--json')) (deps.out ?? console.log)(JSON.stringify({ error: g }));
    // The terminal view reads e.short/reason/next in errorScreen; plain stderr and --json keep the
    // message plus the appended guidance, as before — so the guide text is appended whenever it was before.
    // The rethrown error keeps `local` when the message ends in our own guidance: it was already ours, or
    // a known code got our template appended. Foreign text alone never becomes trusted guidance.
    throw Object.assign(new Error(code !== 'unknown' && !has ? `${message}\n${guide(code, { message, secrets })}` : message), { code: e?.code, local: e?.local === true || code !== 'unknown', short: e?.short && clean(e.short), reason: e?.reason && clean(e.reason), next: e?.next && clean(e.next), neutral: e?.neutral, wrapShort: e?.wrapShort, details: Array.isArray(e?.details) ? e.details.map((d) => clean(d)) : undefined });
  }
}

// How an error prints. One guidance layer on a terminal: ✖ short, dim details and reason, then exactly one
// → Next. Embedded label text parses once (parseGuidance) into the same shape; "Tell the user" never prints.
// Only problem and reason text is ever fitted — a command, URL, key name or flag wraps whole, never an ellipsis.
// Plain stderr is `cloudy-cloud: message`, unchanged for scripts.
export function errorScreen(e, u) {
  const text = redact(safeText(e.message ?? e));
  if (!u.term) return `cloudy-cloud: ${text}`;
  const fit = (s, room = u.width - 4) => fitCells(s, Math.max(8, room));
  // Fields reach here uncleaned for non-start errors (main() only scrubs start's): scrub them all the same.
  const scrub = (s) => redact(safeText(String(s ?? '')));
  // Embedded label values are written for agents (markdown); a terminal gets the bare instruction.
  const bare = (s) => s.replaceAll('`', '').replace(/^Run /, '');
  // Agent-directed text ("tell the user ...") is for the MCP caller: a sentence that says it drops whole;
  // a sentence that leads with a command keeps the command and loses the clause.
  const human = (s) => s.split(/(?<=[.!?])\s+/).map((p) => {
    const i = p.search(/\btell the user\b/i);
    if (i < 0) return p;
    const head = p.slice(0, i).replace(/[\s,.;:]*\b(?:and|then)?\s*$/, '');
    return /^(Run: |Call |cloudy-cloud |`)/i.test(head.trim()) ? head : '';
  }).filter(Boolean).join(' ').replace(/[\s,;:]+$/, '').trim();
  const { head, fields } = parseGuidance(text, `${LABELS}|Next|Run`);
  // Guidance — embedded labels or the short/reason/next/details fields — is trusted only from an error this
  // file created (`local`). Anything else is provider text: it prints as dim diagnostics under a generic
  // short line, with the generic Next — never as our instructions.
  const ours = e?.local === true;
  const structured = ours && Boolean(e.next || e.short || e.reason || Array.isArray(e.details)); // author-chosen fields: the embedded text is not re-read
  const first = text.split('\n')[0];
  const short = scrub((ours && e.short) || (ours ? (structured ? first : head[0] ?? fields['What happened'] ?? first) : 'Something failed.'));
  let reason = scrub((ours && e.reason) || (structured || !ours ? undefined : bare(fields['Likely cause'] ?? fields['What happened'] ?? ''))) || undefined;
  const next = human(scrub(((ours && e.next) || (structured || !ours ? undefined : [fields['Next step'], fields.Next, fields.Run].map((v) => v && bare(v.trim())).find(Boolean))) ?? 'cloudy-cloud coordinator --help')) || 'cloudy-cloud coordinator --help';
  const details = (ours ? (Array.isArray(e.details) ? e.details : structured ? [] : [...head.slice(1), ...(fields['Likely cause'] ? [fields['What happened']] : [])].filter((l) => l !== undefined && l !== '')) : text.split('\n')).map((d) => scrub(String(d)));
  // A structured short has a 60-cell head; a refusal or usage-error short wraps whole words instead of cutting.
  const shortLines = (ours && e.wrapShort) ? wrapText(u, short) : [fit(short, (ours && e.short) ? 60 : u.width - 4)];
  const seen = new Set([short.trim(), ...shortLines.map((l) => l.trim())]); // never print the same line twice
  if (reason && seen.has(reason.trim())) reason = undefined;
  const body = details.flatMap((d) => d.split('\n').flatMap((l) => (l.trim() ? wrapText(u, bare(l)) : ['']))).filter((l) => { const t = l.trim(); if (!t) return true; if (seen.has(t)) return false; seen.add(t); return true; });
  return [
    ...(ours && e.neutral ? shortLines.map((l, i) => (i ? `    ${l}` : `  ${l}`)) : shortLines.map((l, i) => (i ? `    ${u.dim(l)}` : u.err(l)))),
    ...body.map((l) => (l ? `    ${u.dim(l)}` : '')),
    ...(reason ? [`    ${u.dim(fit(reason))}`] : []),
    nextFit(u, next),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch((e) => {
    console.error(errorScreen(e, makeUi({ tty: Boolean(process.stderr.isTTY) })));
    process.exit(1);
  });
}
