// Cloud coordinators: long-lived Claude Code sessions on their own cloud machines.
// Usage: node coordinator.mjs image [--save] | start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--json] | attach NAME | login NAME [--code CODE] | ls | status NAME [--json] | stop NAME | finish [--force]
import { readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { homedir, hostname as osHostname, constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ownerFile, egressAllow, envLine, proxySecrets, installId, DEFAULT_PROVIDER_KEY } from './config.mjs';
import { coordinatorKeys, loadProfiles, COORDINATOR_KEY_SECRET } from './profiles.mjs';
import { WATCHDOG_SCRIPT } from './watchdog.mjs';
import { LAUNCH_SCRIPT } from './coordinator-launch.mjs';
import { parseEnvFile, planEnv, consentFile } from './env-bridge.mjs';
import { ownsRepo, toolBundle, toolInstallCmd } from './toolbundle.mjs';
import { loadProvider, writeSecretFile } from './providers/index.mjs';
import { makeUi, cellWidth, fitCells } from './ui.mjs';
import { coordinatorHelp, coordinatorUsage } from './cli-help.mjs';
import { safeText } from './terminal.mjs';
import { redact } from './events.mjs';
import { renderUnicodeCompact } from 'uqr';
import { paneState } from './pane-state.mjs';
import { FIRST_RUN_SCRIPT } from './first-run.mjs';
import { secretValues } from './run-subagent.mjs';
import { consentedLiterals } from './mcpsync.mjs';
export { FIRST_RUN_SCRIPT };
import { guide, guideObj, classify, CODES, SECRET_HOSTS, setCmd } from './errors.mjs';

const TEMPLATE = 'agent-browser';
const SNAPSHOT_KEY = 'CLOUDY_CLOUD_COORDINATOR_SNAPSHOT';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;
const SETUP_MS = 600_000;
const TASK_MAX = 100_000; // bytes
const IMAGE_SECONDS = 2 * 3600;
const deadlineLine = (iso) => `Your machine is deleted by the server at ${iso}; push your work well before then.`;
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const fail = (msg) => { throw Object.assign(new Error(msg), { local: true }); };
// Coordinators run unrestricted machines: a configured worker egress policy refuses them outright (same text as runSubagent's role refusal).
const refuseEgress = (env, cmd) => { const e = egressAllow(env); if (e.error) guided(e.error, { short: e.short, details: e.details, next: e.next }); const again = cmd === 'cloud' ? 'cloudy-cloud cloud' : `cloudy-cloud coordinator ${cmd}`; if (e.list.length) guided(`CLOUDY_CLOUD_EGRESS_ALLOW applies to workers only. Next step: start the coordinator without it — for one command, prefix it: CLOUDY_CLOUD_EGRESS_ALLOW=off ${again} — or call cloud_agent with role "worker".`, { short: 'CLOUDY_CLOUD_EGRESS_ALLOW applies to workers only.', next: `start the coordinator without it — for one command, prefix it: CLOUDY_CLOUD_EGRESS_ALLOW=off ${again} — or call cloud_agent with role "worker"` }); };
// A "not found" or refusal is a normal answer, not a failure. The message stays one paragraph for scripts
// (plain stderr, --json); a terminal renders the fields: ✖ short, dim details and reason, → Next.
// `local` marks an error our own code created (this file, a provider, config): only such an error may carry
// trusted guidance fields or embedded guidance labels — the same labels inside provider text are diagnostics,
// never our instructions.
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
const cmdFit = (u, label, cmd) => (4 + cellWidth(`${label} ${cmd}`) <= u.width
  ? u.hint(`${label} ${cmd}`) : [u.hint(label), ...wrapText(u, cmd).map((l) => `    ${u.dim(l)}`)].join('\n'));
const attachFit = (u, name) => cmdFit(u, 'Attach with:', `cloudy-cloud coordinator attach ${name}`);
// A hint line whose text wraps whole words onto indented dimmed lines instead of being cut mid-word.
const hintFit = (u, text) => wrapText(u, text).map((l, i) => (i ? `    ${u.dim(l)}` : u.hint(l))).join('\n');
// The longest prefix of s fitting `max` cells (like fitCells but never an ellipsis: nothing is dropped).
const takeCells = (s, max) => { let out = '', w = 0; for (const ch of String(s)) { const cw = cellWidth(ch); if (w + cw > max) break; w += cw; out += ch; } return out; };
// Whole-word wrap for a line of text: words wrap at the room edge. A single word over the room is split at a '/'
// boundary or, failing that, at the room edge — every character is kept and no command, URL or flag is cut.
const wrapText = (u, text, room = u.width - 4) => {
  room = Math.max(1, room); // a terminal too narrow for a useful room still wraps one cell at a time, never loops
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
  writeFileSync(tmp, `${[...lines, ...Object.entries(set).map(([k, v]) => envLine(k, v))].join('\n')}\n`, { mode: 0o600 });
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
  // Prompts write to stderr, never stdout: --json and piped output stay machine-readable.
  const ask = deps.ask ?? (async (question) => { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await new Promise((res) => { rl.once('close', () => res('n')); rl.question(question).then(res, () => res('n')); }); } finally { rl.close(); } });
  return { env, provider, configFile, out, root, progress, note, ui, sleep, now, tty, spawn, ask, cwd: deps.cwd };
}

// The Remote Control session id is in ~/.claude/sessions/<pid>.json once Remote Control connects. Read exactly the files of
// the tmux pane's process and its descendants (the Claude session), never the screen text. The file text is untrusted: only
// one strict id builds the URL, and none or several distinct ids mean no link.
const LINK_CMD = `p=$(tmux display -p -t claude '#{pane_pid}') || exit 0; for f in $(ps -e -o pid= -o ppid= | awk -v r="$p" '{par[$1]=$2} END{s[r]=1; do{ch=0; for(k in par) if(!(k in s) && (par[k] in s)){s[k]=1; ch=1}}while(ch); for(k in s) print k}'); do grep -ho '"bridgeSessionId" *: *"[^"]*"' ~/.claude/sessions/$f.json 2>/dev/null; done; true`;
function parseLink(stdout = '') {
  const ids = new Set([...String(stdout).matchAll(/"bridgeSessionId"\s*:\s*"([^"]*)"/g)].map((m) => m[1]).filter((id) => /^session_[A-Za-z0-9]{1,64}$/.test(id)));
  return ids.size === 1 ? `https://claude.ai/code/${[...ids][0]}` : '';
}
// A failed or slow link read is never a failed screen read: it only means no link yet.
const readLink = async (sbx) => { try { return parseLink((await sbx.commands.run(LINK_CMD, { timeoutMs: 15_000 })).stdout); } catch { return ''; } };
// A QR code of the link for a phone: only on a UTF-8 terminal where it fits, and never an error.
const qrLines = (u, link) => {
  if (!u.utf) return [];
  try {
    const lines = renderUnicodeCompact(link).split('\n').filter(Boolean);
    return lines.every((l) => cellWidth(l) + 4 <= u.width) ? ['', ...lines.map((l) => `    ${l}`)] : [];
  } catch { return []; }
};
// The link on its own line, or the label then the link when both do not fit (the link itself is never cut).
const linkLines = (u, link) => (2 + cellWidth(`Remote Control: ${link}`) <= u.width ? [`  Remote Control: ${link}`] : ['  Remote Control:', `    ${link}`]);

const mach = (m) => m.machineName ?? m.name; // the machine's own name; self-hosted rows keep the logical name in `name`
// Every machine a command acts on must be one of ours: the purpose label plus the role. Machines made before the
// rename carry the historical purpose=claude-cloud label; those count as ours too. The name (for attach/status/stop)
// is a second filter, not a substitute — labels decide, never the reported name alone.
const OUR_PURPOSES = new Set(['cloudy-cloud', 'claude-cloud']);
const find = async (provider, role, name) =>
  (await provider.list({ role, ...(name && { name }) }, { sdk: true }))
    .filter((m) => OUR_PURPOSES.has(m.labels?.purpose) && m.labels?.role === role && (!name || m.labels?.name === name));

// Installs or updates cloudy-cloud on the machine and sets up git's GitHub login. Returns the home folder.
async function installTool(sbx, root, note) {
  const run = (cmd, opts) => sbx.commands.run(cmd, { timeoutMs: SETUP_MS, ...opts });
  const home = (await run('printf %s "$HOME"')).stdout.trim() || fail('Could not read $HOME on the machine.');
  await run(`command -v tmux >/dev/null || { sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux; } >/dev/null 2>&1; command -v tmux >/dev/null || { echo 'tmux is not installed on the machine' >&2; exit 1; }`);
  await run('gh auth setup-git'); // before the work-repo clone, so git uses the GH_TOKEN placeholder
  // A fresh machine has no git identity, which the coordinator needs to commit merges and its report. Use the laptop's.
  const ident = (k, d) => { try { return execFileSync('git', [...(ownsRepo(root) ? ['-C', root, 'config'] : ['config', '--global']), k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || d; } catch { return d; } };
  await run(`git config --global user.name ${q(`${ident('user.name', 'cloudy-cloud')} (coordinator)`)} && git config --global user.email ${q(ident('user.email', 'cloudy-cloud@localhost'))}`);
  // Upload this checkout (HEAD plus uncommitted tracked edits) so the machine runs exactly this version,
  // pushed or not. Credential-looking files never ride the bundle; their names are reported back.
  const b = toolBundle(root);
  if (b.dropped?.length) note?.(`The tool bundle left out ${b.dropped.join(', ')}: file names like these can hold credentials and are never sent to a machine.`);
  await sbx.files.write(`${home}/cloudy-cloud.bundle`, b.data);
  await run(`${toolInstallCmd(b, `${home}/cloudy-cloud.bundle`, toolRepoUrl(root))} && npm install --no-audit --no-fund`, { cwd: home });
  return home;
}

// The machine's name as the server reports it (the adapter fetches it on demand).
const nameOf = async (sbx) => (await sbx.loadName?.()) ?? sbx.name;

// True when the machine's Claude is signed in through the browser (a setup-token cannot open Remote Control
// sessions); an unreadable status counts as not signed in.
async function signedIn(sbx) {
  try {
    const r = await sbx.commands.run('claude auth status --json', { timeoutMs: 60_000 });
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    return j.loggedIn === true && j.authMethod === 'claude.ai';
  } catch { return false; }
}

const PENDING_KEY = 'CLOUDY_CLOUD_PENDING_SNAPSHOT'; // MACHINE_ID:SNAPSHOT_ID of a snapshot still being saved, so a later run waits on it instead of starting another
// The image-sign-in bookkeeping older versions wrote (CLOUDY_CLOUD_SNAPSHOT_ACCOUNT and
// CLOUDY_CLOUD_PENDING_ACCOUNT) is dropped from the config on the next save; a leftover line is ignored.
const LEGACY_ACCOUNT_KEYS = ['CLOUDY_CLOUD_SNAPSHOT_ACCOUNT', 'CLOUDY_CLOUD_PENDING_ACCOUNT'];
const SNAPSHOT_WAIT_MS = 30 * 60_000;
const gone = (e) => e?.code === 'not_found' || e?.status === 404;
// Known limit: two --save runs at the same moment can both start a snapshot; nothing serialises them.
const readKey = (file, name) => { // throws on anything but a missing file, so a read error never looks like "no snapshot pending"
  try { return readFileSync(file, 'utf8').split('\n').findLast((l) => l.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''; } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

// Waits for the snapshot, saves its id, deletes the image machine (sbx, when it still exists), then drops the pending entry.
async function finishSave(c, sbx, snap) {
  const t0 = c.now(); let shown = 0;
  while (snap.status === 'pending') {
    const waited = c.now() - t0;
    if (waited >= SNAPSHOT_WAIT_MS) guided(`The snapshot is still saving. Run cloudy-cloud coordinator image --save later to finish; it will not start a second one. (Snapshot ${snap.id}; the image machine was kept.)`, { short: 'The snapshot is still saving.', reason: `Snapshot ${snap.id}; the image machine was kept.`, next: 'cloudy-cloud coordinator image --save' });
    await c.sleep(5000);
    const half = Math.floor((c.now() - t0) / 30_000); // progress every 30 s of wall-clock time
    if (half > shown) { shown = half; c.progress(`Saving the image snapshot... ${Math.floor(half / 2)} min`); }
    snap = await c.provider.getSnapshot(snap.id);
  }
  if (snap.status && snap.status !== 'ready') { updateConfig(c.configFile, {}, [PENDING_KEY]); guided(`Snapshot ${snap.id} has status ${snap.status}. The image machine was kept.`, { short: `Snapshot ${snap.id} has status ${snap.status}.`, reason: 'The image machine was kept.', next: 'cloudy-cloud coordinator image --save' }); }
  updateConfig(c.configFile, { [SNAPSHOT_KEY]: snap.id }, LEGACY_ACCOUNT_KEYS); // the pending entry stays until the machine is deleted, so a failed delete retries only the delete
  if (sbx) await sbx.kill();
  updateConfig(c.configFile, {}, [PENDING_KEY, ...LEGACY_ACCOUNT_KEYS]);
  if (c.ui.term) return c.out([c.ui.ok(`Saved snapshot ${safeText(snap.id)}`, 'the image machine is deleted'),
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
    updateConfig(c.configFile, {}, [PENDING_KEY, ...LEGACY_ACCOUNT_KEYS]);
    guided(`The pending snapshot ${sid} no longer exists, so it was forgotten. Run: cloudy-cloud coordinator image`, { short: `The pending snapshot ${sid} no longer exists.`, reason: 'It was forgotten.', next: 'cloudy-cloud coordinator image' });
  }
  let sbx = null, foreign = false;
  // The recorded machine id is only a claim: connect (and so finishSave's delete) happens only when a fresh
  // listing verifies it is still our image machine (purpose + role). A machine that exists but no longer verifies
  // stays untouched and the pending record is kept, so a later --save can finish it; only a machine that is really
  // gone falls through to finishSave, which clears the record after saving the snapshot id.
  try {
    // Unfiltered: a role-filtered list would miss the machine entirely if its role label is what changed.
    const row = (await c.provider.list({}, { sdk: true })).find((m) => m.id === mid);
    if (row && OUR_PURPOSES.has(row.labels?.purpose) && row.labels?.role === 'coordinator-image') sbx = await c.provider.connect(mid, { retry: false });
    else foreign = !!row;
  } catch (e) { if (!gone(e)) throw e; }
  if (foreign) guided(`The pending image machine ${mid} still exists, but it could not be verified as ours (its purpose or role labels changed or are gone), so it was left alone and the pending snapshot record was kept.\nNext step: check the machine with cloudy-cloud machines; if it really is a leftover image machine of yours, delete it and run cloudy-cloud coordinator image --save again.`, { short: `The image machine ${mid} could not be verified as ours.`, reason: 'its labels no longer show it as ours; the machine and the pending record were kept', next: 'cloudy-cloud machines' });
  await finishSave(c, sbx, snap);
  return true;
}

async function saveNew(c, sbx) {
  // No credential ever rides a snapshot: a sign-in the image machine still holds is removed first.
  await sbx.commands.run('rm -f ~/.claude/.credentials.json', { timeoutMs: 30_000 });
  c.progress('Saving the image snapshot. This can take 10 to 20 minutes.');
  const snap = await c.provider.snapshot(sbx, { name: `cloudy-cloud-coordinator-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`, description: 'cloudy-cloud coordinator image' });
  if (snap.status === 'pending') updateConfig(c.configFile, { [PENDING_KEY]: `${sbx.id}:${snap.id}` }, ['CLOUDY_CLOUD_PENDING_ACCOUNT']);
  return finishSave(c, sbx, snap);
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
  if (!key || key.startsWith('ibsec_') || c.env.CLOUDY_CLOUD_COORDINATOR === '1') return 'skip';
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

// Builds (or finishes) the coordinator image: install the tool, remove any Claude credential so no
// sign-in ever rides a snapshot, snapshot, delete the image machine. Each coordinator signs in for
// itself at `start` — there is no sign-in here anymore. A leftover image machine (the provider stops
// these 2 hours after creation) is snapshotted by `image --save` instead of starting another machine.
async function image(c, args) {
  refuseEgress(c.env, 'image');
  const stored = await storeCoordinatorSecret(c); // repair the coordinator key on every path; a failed store is not silent
  if (await resumePending(c)) return storeNotice(c, stored);
  const [img] = (await find(c.provider, 'coordinator-image')).sort((a, b) => b.startedAt - a.startedAt);
  if (args.includes('--save')) {
    if (!img) guided('No image machine found. Image machines are deleted 2 hours after cloudy-cloud coordinator image creates them. Run: cloudy-cloud coordinator image', { short: 'No image machine found.', reason: 'Image machines are deleted 2 hours after cloudy-cloud coordinator image creates them.', next: 'cloudy-cloud coordinator image', neutral: true });
    const sbx = await c.provider.connect(img.id, { retry: false });
    const r = await saveNew(c, sbx);
    storeNotice(c, stored);
    return r;
  }
  let sbx;
  if (img) {
    c.progress(`Using the image machine ${safeText(img.name)} you already started.`);
    sbx = await c.provider.connect(img.id, { retry: false });
  } else {
    c.progress('Creating the image machine...');
    sbx = await c.provider.create({ image: TEMPLATE, labels: { purpose: 'cloudy-cloud', role: 'coordinator-image' }, ttlSeconds: IMAGE_SECONDS, neverSuspend: true, retry: false });
    try {
      c.progress('Connecting GitHub and installing tools (this can take a few minutes)...');
      await installTool(sbx, c.root);
    } catch (e) { await sbx.kill().catch(() => {}); throw e; }
  }
  const r = await saveNew(c, sbx);
  storeNotice(c, stored);
  return r;
}

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// A repeatable option: every value after an occurrence, in order (`--env` may appear several times).
const flags = (args, name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
// Every env file to bridge: --env FILE arguments plus the comma list in ~/.config/cloudy-cloud/env.
const envFileArgs = (args, env) => [...flags(args, '--env'), ...String(env.CLOUDY_CLOUD_ENV_FILES ?? '').split(/[\s,]+/).filter(Boolean)];

// The env-bridge half of start (env-bridge.mjs): parse each --env file, let planEnv sort names into proxied,
// consented-literal and skipped, and build the sourced file text for the literal ones. A proxied variable is
// attached to the machine by NAME only — it is one of the user's own CLOUDY_CLOUD_PROXY_SECRETS, so the value
// never leaves the laptop and the bridge never stores a secret.
async function bridgeEnv(c, files, origin) {
  const vars = new Map();
  vars.skipped = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); }
    catch { usageError(`Cannot read the --env file ${f}.`, 'start', `Cannot read the --env file ${f}.`); }
    const parsed = parseEnvFile(text);
    for (const [k, v] of parsed) vars.set(k, v);
    vars.skipped.push(...parsed.skipped.map((s) => ({ ...s, file: f })));
  }
  const plan = await planEnv({
    vars, env: c.env, origin, consentPath: consentFile(c.env),
    // No proxy secrets on this provider: a proxy-secret name then needs consent like any other variable.
    proxy: !!c.provider.caps.hasProxySecrets,
    ask: c.tty ? (name) => c.ask(`Copy the real value of ${name} to the cloud machine? [y/N/a] `) : null,
  });
  const secrets = plan.proxied.map((p) => p.name), skipped = [...plan.skipped];
  const lines = [], literal = [], values = [];
  for (const name of plan.literal) {
    const v = String(vars.get(name));
    if (/[\r\n\0]/.test(v)) { skipped.push({ name, reason: 'the value contains a line break' }); continue; }
    lines.push(`${name}='${v.replaceAll("'", "'\\''")}'`);
    literal.push(name);
    if (v.length >= 4) values.push(v); // kept for pane and error scrubbing only — a shorter value would over-redact
  }
  // A malformed line reports only its line number and file: the text itself could be a secret.
  const shown = (s) => s.name ?? `line ${s.line}${s.file ? ` of ${s.file}` : ''}`;
  const summary = [secrets.length && `proxied by name: ${secrets.join(', ')}`, literal.length && `copied literally: ${literal.join(', ')}`, ...skipped.map((s) => `skipped ${shown(s)}: ${s.reason}`)].filter(Boolean);
  return { secrets, literal, values, skipped, summary, text: lines.length ? `${lines.join('\n')}\n` : '' };
}

const customHost = (env, key) => { try { const p = Object.values(loadProfiles(env)).find((x) => x?.keyName === key); return URL.canParse(p?.baseUrl) ? new URL(p.baseUrl).host : undefined; } catch { return undefined; } };
// The owner/repo path of a github.com https URL, without any .git suffix: the value the repo label carries.
const repoPath = (url) => url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');

async function start(c, args) {
  refuseEgress(c.env, 'start');
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
  const snapshot = c.env[SNAPSHOT_KEY];
  if (!snapshot) guided('No coordinator image yet. Run: cloudy-cloud coordinator image', { short: 'No coordinator image yet.', reason: 'Coordinators start from a saved image; each signs in to Claude at start.', next: 'cloudy-cloud coordinator image', neutral: true });
  if ((await find(c.provider, 'coordinator', name)).length) guided(`A coordinator named ${name} already exists. Stop it first: cloudy-cloud coordinator stop ${name}`, { short: `A coordinator named ${name} already exists.`, next: `cloudy-cloud coordinator stop ${name}` });
  // Peers for Remote Control messaging: the running coordinators this same installation made (the install-label
  // check `cloud` reattach uses), by name, excluding the one being started. A failed lookup never fails a start.
  const mine = installId(c.env);
  let peers = [];
  try {
    peers = (await find(c.provider, 'coordinator'))
      .filter((m) => m.state === 'running' && m.labels?.install === mine && m.labels?.name !== name && NAME_RE.test(m.labels?.name ?? ''))
      .map((m) => m.labels.name);
  } catch { c.progress('Could not list the other coordinators; this one starts without peers.'); }
  let link = '';
  let screenRead = true, waiting = ''; // set when the session's screen waits on a prompt a person answers by attaching
  let needsLogin = false, loginUrl = ''; // set while the coordinator waits for its own Claude sign-in (a normal state)
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
    // The terminal fields carry the same facts the embedded labels do — the generic "passed the old way"
    // likely-cause repeats the what-happened, so the fields skip it (the message and --json keep it).
    throw Object.assign(new Error(`${k} is set as a real value, not as a proxy secret.\nWhat happened: ${g.whatHappened}\nLikely cause: ${g.likelyCause}\nNext step: ${g.nextStep}`), { local: true, code: 'key_on_machine_refused', short: `${k} is set as a real value, not as a proxy secret.`, reason: g.whatHappened, next: g.nextStep.replace(/^Run `?/, '').replaceAll('`', '') });
  }
  // An optional key that is not stored as a proxy secret is not sent (never as a value); say so, with the command to store it.
  const custom = keys.skipped.filter((k) => !SECRET_HOSTS[k]);
  const skipNote = keys.skipped.length ? `Not sent to the coordinator (not stored as proxy secrets): ${keys.skipped.join(', ')}. Store them with \`cloudy-cloud setup --more\`${custom.length ? '. For a custom key: ' + custom.map((k) => guideObj('key_on_machine_refused', { secret: k, host: customHost(c.env, k) }).nextStep).join(' ') : ''}` : '';
  // --env FILE variables (and the CLOUDY_CLOUD_ENV_FILES list): a variable whose name is already in
  // CLOUDY_CLOUD_PROXY_SECRETS attaches by name like any other proxy secret; the summary names names only.
  const envFiles = envFileArgs(args, c.env);
  const bridged = envFiles.length ? await bridgeEnv(c, envFiles, repo) : { secrets: [], literal: [], values: [], skipped: [], summary: [], text: '' };
  for (const line of bridged.summary) c.note(`Environment: ${line}`);
  c.progress('Creating the coordinator machine...');
  // The repo and branch labels are what `cloud` reattach checks against later; repo is the owner/repo path.
  // The install label is this installation's stable id (the same one boat/E2B workers carry): it is what
  // keeps `cloud` and `coordinator attach` off a teammate's coordinator of the same name.
  const t0 = Date.now(); // the create timestamp, for the deadline fallback below
  const sbx = await c.provider.create({ image: snapshot, name: `coord-${name}`, ...((keys.secrets.length + bridged.secrets.length) && { secrets: [...keys.secrets, ...bridged.secrets] }), labels: { purpose: 'cloudy-cloud', role: 'coordinator', name, repo: repoPath(repo), install: installId(c.env), ...(branch ? { branch } : {}) }, ttlSeconds: seconds, neverSuspend: true, retry: false });
  // The deadline comes from the machine's own deletion time once the provider reports it — the consent
  // prompts above could otherwise eat into a deadline computed before them. Only the list row of THIS
  // machine counts (another coordinator's deadline is wrong), so the fallback is the requested ttl from
  // the timestamp taken just before create — never rows[0].
  const row = await find(c.provider, 'coordinator', name).then((rows) => rows.find((m) => m.id === sbx.id)).catch(() => null);
  const deleteAt = row?.deleteAt && Number.isFinite(new Date(row.deleteAt).getTime()) ? new Date(row.deleteAt).toISOString() : new Date(t0 + seconds * 1000).toISOString();
  try {
    c.progress('Connecting GitHub and installing tools (this can take a few minutes)...');
    const home = await installTool(sbx, c.root, c.note);
    const dir = `${home}/.config/cloudy-cloud`;
    await sbx.commands.run(`mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`);
    await sbx.files.write(`${dir}/env`, `${keys.lines.join('\n')}\n`); // values never appear in a command string
    await sbx.commands.run(`chmod 600 ${q(`${dir}/env`)}`);
    // Consented literal values go in env.local: an empty mode-600 file first (the upload could briefly be 644),
    // the secret file route for the body, a chmod after. tmux sources it into Claude's environment below.
    if (bridged.text) {
      await sbx.commands.run(`umask 077 && : > ${q(`${dir}/env.local`)}`);
      await writeSecretFile(sbx, `${dir}/env.local`, bridged.text);
      await sbx.commands.run(`chmod 600 ${q(`${dir}/env.local`)}`);
    }
    c.progress('Cloning the repository...');
    await sbx.commands.run(`rm -rf ~/repo && git clone -q ${branch ? `-b ${q(branch)} ` : ''}${q(repo)} ~/repo`, { timeoutMs: SETUP_MS });
    c.progress('Starting the Claude session...');
    // Claude Code shows first-run screens (theme, login method, trust, notices) that nobody can answer on an unattended
    // machine, and they block Remote Control. The sign-in itself is per coordinator (launch.sh below); mark the rest done.
    await sbx.commands.run(`node -e ${q(FIRST_RUN_SCRIPT)}`);
    // Give the coordinator's Claude the fleet skill from this laptop, so it matches the instructions the local Claude has.
    const skillDir = join(c.root, 'skills', 'cloud-fleet');
    for (const f of readdirSync(skillDir)) await sbx.files.write(`${home}/.claude/skills/cloud-fleet/${f}`, readFileSync(join(skillDir, f)));
    // The task text goes up as a file, never in a command string; the shell in tmux reads it when Claude starts.
    if (task !== undefined) await sbx.files.write(`${home}/task.md`, `${deadlineLine(deleteAt)}\n\n${task}`);
    const prompt = task !== undefined ? ` "$(cat ${q(`${home}/task.md`)})"` : '';
    // The secrets stay attached to the machine (workers are attached by name), but this Claude must not see them:
    // a setup-token cannot start Remote Control and an env token beats a sign-in (code.claude.com/docs/en/remote-control).
    // CLOUDY_CLOUD_NAME makes the launcher pass --name to claude, so the other coordinators can message this
    // session by name; CLOUDY_CLOUD_PEERS are the peer names known at start, and REPO/BRANCH feed the hello
    // message. Every one is set explicitly — an empty value too — so a bridged env.local cannot inject them.
    // env.local holds the consented literal --env variables; sourcing it here exports them to Claude's environment.
    // launch.sh (coordinator-launch.mjs) first removes any credential the image copied in — once, at the first launch,
    // so a relaunch never deletes this coordinator's own sign-in — then runs `claude auth login` when the coordinator
    // is not signed in, and execs the session command. The pane waits at the sign-in until a person finishes it.
    await sbx.files.write(`${dir}/launch.sh`, LAUNCH_SCRIPT);
    await sbx.commands.run(`chmod 700 ${q(`${dir}/launch.sh`)}`);
    await sbx.commands.run(`tmux kill-session -t claude 2>/dev/null; tmux new-session -d -s claude -c ~/repo ${q(`sh ${dir}/launch.sh ${q(`${bridged.text ? `set -a; . ${q(`${dir}/env.local`)}; set +a; ` : ''}env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLOUDY_CLOUD_COORDINATOR=1 CLOUDY_CLOUD_DELETE_AT=${deleteAt} CLOUDY_CLOUD_NAME=${name} CLOUDY_CLOUD_PEERS=${peers.join(',')} CLOUDY_CLOUD_REPO=${q(repoPath(repo))} CLOUDY_CLOUD_BRANCH=${q(branch ?? '')} "PATH=${home}/cloudy-cloud/bin:$PATH" ${home}/cloudy-cloud/bin/cloudy-cloud --remote-control ${q(name)}${model ? ` --model ${q(model)}` : ''}${prompt}`)}`)}`);
    // The deadline watchdog runs in its own tmux session so a Claude restart never stops it.
    await sbx.files.write(`${home}/watchdog.sh`, WATCHDOG_SCRIPT);
    await sbx.commands.run(`tmux kill-session -t cc-watchdog 2>/dev/null; tmux new-session -d -s cc-watchdog ${q(`env CLOUDY_CLOUD_COORDINATOR=1 CLOUDY_CLOUD_DELETE_AT=${deleteAt} sh ${home}/watchdog.sh`)}`);
    // A session that started but cannot work (spend limit, a dead session) looks fine from outside. Read its screen.
    // Waiting for the coordinator's own Claude sign-in is a normal state — the machine is never deleted for it.
    await c.sleep(5000);
    let pane = '';
    try { pane = (await sbx.commands.run('tmux capture-pane -t claude -p -J')).stdout ?? ''; } catch (e) {
      // A command that ran and failed carries exitCode (no tmux session). Anything else is the provider or network: the session may be fine.
      if (typeof e?.exitCode === 'number') throw Object.assign(new Error(`The Claude session on the new machine exited right after it started. The machine was deleted.\nLikely cause: the launcher or Claude exited at once.\nNext: run cloudy-cloud coordinator start ${name} again; if it repeats, run cloudy-cloud coordinator image for a fresh image.`), { local: true, short: 'The Claude session on the new machine exited right after it started.', reason: 'the launcher or Claude exited at once; the machine was deleted', next: `cloudy-cloud coordinator start ${name}` });
      screenRead = false;
    }
    // The task is typed into the session, so its own lines can be on screen; they are not errors. Configured values are
    // removed before the screen is classified or fitted into an error, same as for `ls`/`status`.
    const scrub = (text) => [...secretValues(c.env, c.provider.keyName, consentedLiterals(c.env)), ...bridged.values].reduce((t, v) => t.split(v).join('[redacted]'), text);
    const st = paneState(scrub(pane), task ?? '');
    const line = st.blocked;
    if (!line && st.waiting) waiting = st.waiting;
    if (line) {
      // The code comes from the matched line, never from words in this message (classify would read "spend limit" as the cause).
      const [code, cause, next, nextCmd] = /invalid api key/i.test(line)
        ? ['coordinator_invalid_key', 'the session reports an invalid API key', `check the keys the image settings or your --env files send, then run cloudy-cloud coordinator start ${name} again`, `check the machine's Claude settings and your --env files, then start ${name} again`]
        : ['spend_limit', 'the Claude account on the coordinator has hit its spend or usage limit', `check the plan at claude.ai, then run cloudy-cloud coordinator start ${name} again`, `check the plan at claude.ai, then start ${name} again`];
      // Remote pane text is diagnostic data, not a trusted field: the cause and next are our authored words only.
      throw Object.assign(new Error(`The coordinator session started but is not working. Its screen shows: ${line}\nThe machine was deleted.\nLikely cause: ${cause}.\nNext: ${next}.`), { local: true, code, short: 'The coordinator session started but is not working.', reason: `${cause}; the machine was deleted`, details: [`screen: ${fitCells(line, 40)}`], next: nextCmd });
    }
    // Every fresh coordinator waits for its own Claude sign-in: the pane sits at `claude auth login` or at Claude's
    // own login screen. That is normal — the machine stays; `coordinator login NAME` finishes the sign-in. The
    // Remote Control link is read only once it is signed in.
    needsLogin = !(await signedIn(sbx));
    if (needsLogin) {
      loginUrl = st.loginUrl;
      // The sign-in URL can take a few seconds to appear on the pane; look again briefly, never longer.
      for (let i = 0; i < 3 && !loginUrl && screenRead; i++) {
        await c.sleep(3000);
        try { loginUrl = paneState(scrub((await sbx.commands.run('tmux capture-pane -t claude -p -J')).stdout ?? ''), task ?? '').loginUrl; } catch { break; }
      }
    } else if (screenRead && !waiting) {
      // Remote Control can take a few seconds to connect: look again briefly, and stop if a prompt appears. A missing link never fails start.
      link = await readLink(sbx);
      for (let i = 0; i < 3 && !link && !waiting; i++) {
        await c.sleep(3000);
        try {
          const again = paneState(scrub((await sbx.commands.run('tmux capture-pane -t claude -p -J')).stdout ?? ''), task ?? '');
          waiting = again.waiting || again.blocked || '';
        } catch { break; }
        if (!waiting) link = await readLink(sbx);
      }
    }
  } catch (e) { e.scrubValues = [...(e.scrubValues ?? []), ...bridged.values]; await sbx.kill().catch(() => {}); throw e; }
  const machine = await nameOf(sbx);
  const shownMachine = safeText(machine ?? ''); // the server-reported name is display data
  if (!args.includes('--json') && skipNote && !c.ui.term) c.out(skipNote); // a terminal shows it below the success line
  if (args.includes('--json')) { c.out(JSON.stringify({ name, machine: shownMachine, remoteControlName: name, attach: `cloudy-cloud coordinator attach ${name}`, started: true, ...(needsLogin ? { needsLogin: true, ...(loginUrl && { loginUrl }), next: `cloudy-cloud coordinator login ${name}` } : {}), ...(link && { remoteControlUrl: link }), ...(skipNote && { skippedKeys: keys.skipped, note: skipNote }), ...(waiting && { waiting }), ...(!screenRead && { screenRead: false }) })); storeNotice(c, stored, { json: true }); return { needsLogin, loginUrl }; }
  const needsLook = !screenRead || !!waiting; // only then can the first-run prompts be what blocks it
  if (c.ui.term) {
    const u = c.ui;
    const head = `Coordinator ${name} is running`;
    // The deadline lives in the ok detail; a long name drops it to its own dimmed line rather than dropping it.
    const okLine = statusLine(u, 'ok', head, [`It never pauses; the server deletes it ${u.rel(deleteAt)}.`, `the server deletes it ${u.rel(deleteAt)}`, `deleted ${u.rel(deleteAt)}`]);
    const warn = !screenRead ? [u.warn('Could not read the session screen to check it started'), u.hint('Attach once and accept any trust or Remote Control prompts.')]
      : needsLogin ? [u.warn('Waiting for Claude sign-in'), u.hint('Each coordinator has its own sign-in.')]
      : waiting ? [u.warn('The session is waiting on a prompt', fitCells(waiting, Math.max(8, u.width - 40)))] : [];
    // The block's label column takes 21 cells (Remote Control is the widest at 14). A long name first shortens the
    // Remote Control hint, then moves the two commands onto their own lines so they stay whole and runnable.
    const room = u.width - 21;
    const rc = [`open claude.ai/code or the Claude app, pick "${name}"`, `pick "${name}" on claude.ai/code or the app`, `pick "${name}"`]
      .find((v) => cellWidth(v) <= room) ?? fitCells(`pick "${name}"`, room);
    const reach = (rows) => u.block('Reach it', rows);
    const full = (v) => reach(needsLogin
      ? [['Sign in', `cloudy-cloud coordinator login ${name}`], ['Terminal', `cloudy-cloud coordinator attach ${name}`], ['Stop', `cloudy-cloud coordinator stop ${name}`]]
      : [['Remote Control', v], ['Terminal', `cloudy-cloud coordinator attach ${name}`], ['Stop', `cloudy-cloud coordinator stop ${name}`]]);
    const fits = (t) => t.split('\n').every((l) => cellWidth(l) <= u.width);
    const base = fits(full(rc)) ? full(rc)
      : [reach(needsLogin ? [['Sign in', `cloudy-cloud coordinator login ${name}`]] : [['Remote Control', rc]]), `    cloudy-cloud coordinator attach ${name}`, `    cloudy-cloud coordinator stop ${name}`].join('\n');
    // The URL goes in the block row when it fits; otherwise on its own line below, whole.
    const linkRow = !needsLogin && link && fits(full(link));
    const block = linkRow ? full(link) : base;
    // The warning wraps whole words: a key name is never cut, and a custom key keeps its host-specific instructions.
    const skipBlock = !skipNote ? [] : [
      ...wrapText(u, `Not sent to the coordinator (not stored as proxy secrets): ${keys.skipped.join(', ')}`).map((l, i) => (i ? `    ${u.dim(l)}` : u.warn(l))),
      ...(custom.length < keys.skipped.length ? [u.hint('Store them with `cloudy-cloud setup --more`.')] : []),
      ...custom.flatMap((k) => wrapText(u, `For ${k}: ${guideObj('key_on_machine_refused', { secret: k, host: customHost(c.env, k) }).nextStep}`).map((l) => `    ${u.dim(l)}`)),
    ];
    return c.out([okLine, ...warn, ...skipBlock, '', block, ...(loginUrl ? linkLines(u, loginUrl) : []), ...(link && !linkRow ? linkLines(u, link) : []), ...(link ? qrLines(u, link) : []),
      ...(!link && !needsLogin ? [cmdFit(u, 'Link not ready yet. Get it with:', `cloudy-cloud coordinator status ${name}`)] : []),
      ...(stored === 'stored' ? [u.hint(STORE_NOTE)] : []),
      ...(needsLook || needsLogin ? ['', nextFit(u, needsLogin ? `cloudy-cloud coordinator login ${name}` : `cloudy-cloud coordinator attach ${name}`)] : [])].join('\n'));
  }
  c.out((!screenRead ? `Could not read the session screen to check it started.\nLook with: cloudy-cloud coordinator attach ${name}\n\n` : needsLogin ? 'The coordinator is waiting for its Claude sign-in (each coordinator has its own).\n\n' : waiting ? `The session is waiting on a prompt: ${waiting}\nRun: cloudy-cloud coordinator attach ${name}, then accept the prompt.\n\n` : '') + `Coordinator ${name} is running on machine ${shownMachine}${task !== undefined ? ' and has started on the task' : ''}. It never pauses. The server deletes it at ${deleteAt}.\n\n` +
    (needsLogin ? `Sign in to Claude on it:\n  cloudy-cloud coordinator login ${name}${loginUrl ? `\n  Sign-in link: ${loginUrl}` : ''}\n\n`
      : `Reach it:\n  - Remote Control: ${link || `open claude.ai/code or the Claude app and pick the session named "${name}" (the link is not ready yet; get it with: cloudy-cloud coordinator status ${name})`}\n  - Terminal: cloudy-cloud coordinator attach ${name}\n\n`) +
    `${needsLook ? 'Attach once and accept any trust or Remote Control prompts.\n' : ''}Stop it earlier with: cloudy-cloud coordinator stop ${name}`);
  storeNotice(c, stored); // piped stdout keeps only the result; the notice is on stderr
  return { needsLogin, loginUrl };
}

async function attach(c, args, { noAttach = false, machine = null } = {}) {
  // `cloud` passes the machine it already validated (`machine`): a same-named machine created after the
  // lookup is not what this attach reaches. Without it the default lookup by name stands.
  const m = machine ?? (await find(c.provider, 'coordinator', args[0] || usageError('Usage: cloudy-cloud coordinator attach NAME', 'attach', 'attach needs a coordinator name.')))[0];
  if (!m) guided(`No coordinator named ${args[0]}. List them with: cloudy-cloud coordinator ls`, { short: `No coordinator named ${args[0]}.`, next: 'cloudy-cloud coordinator ls', neutral: true });
  // A coordinator made by a different installation is not ours to attach to. A machine without an install
  // label predates labelling: an explicit `attach NAME` is still how one of those is reached (only `cloud`
  // reattach refuses those).
  if (m.labels?.install && m.labels.install !== installId(c.env)) guided(`Coordinator ${args[0]} belongs to a different cloudy-cloud installation, so it was not attached.\nNext step: list this installation's coordinators with cloudy-cloud coordinator ls`, { short: `Coordinator ${args[0]} belongs to a different cloudy-cloud installation.`, next: 'cloudy-cloud coordinator ls' });
  if (c.tty && !noAttach) { // on a terminal, open the session here
    const argv = c.provider.shellArgv(mach(m), ['tmux', 'attach', '-t', 'claude'], { tty: true });
    const r = c.spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env, ...c.provider.shellEnv?.() }, ...c.provider.shellSpawnOpts?.(argv) });
    // doctor checks self-hosted boxes only; everywhere else the fix is the missing provider CLI itself.
    if (r?.error) guided(c.provider.name === 'self-hosted' ? `Could not start ${argv[0]} (${r.error.message}). Install it or run: cloudy-cloud doctor` : `Could not start ${argv[0]} (${r.error.message}). Install ${argv[0]} first.`,
      c.provider.name === 'self-hosted' ? { short: `Could not start ${argv[0]} (${r.error.message}).`, reason: 'Install it first, or:', next: 'cloudy-cloud doctor' } : { short: `Could not start ${argv[0]} (${r.error.message}).`, next: `install ${argv[0]}, then attach again` });
    return r?.status ?? (r?.signal ? 128 + (osConstants.signals[r.signal] ?? 0) : 1);
  }
  if (c.ui.term) c.out(c.ui.hint('Run this to attach:'));
  c.out(`cloudy-cloud coordinator attach ${args[0]}`);
}

// The code the browser sign-in shows, typed into the pane's sign-in prompt: word characters only.
const CODE_RE = /^[A-Za-z0-9#_-]{1,512}$/;

// `coordinator login NAME [--code CODE]` finishes a coordinator's Claude sign-in. Without --code it attaches
// to the pane so a person signs in there; with --code it types the code into the pane's sign-in prompt — the
// way a local agent completes a sign-in the user finished in the browser.
async function login(c, args) {
  const name = args[0];
  const code = flag(args, '--code');
  if (code !== undefined && !CODE_RE.test(code)) usageError('--code takes 1 to 512 characters of letters, digits, #, _ and -.', 'login', '--code takes 1 to 512 characters of letters, digits, #, _ and -.');
  const [m] = await find(c.provider, 'coordinator', name);
  if (!m) guided(`No coordinator named ${name}. List them with: cloudy-cloud coordinator ls`, { short: `No coordinator named ${name}.`, next: 'cloudy-cloud coordinator ls', neutral: true });
  if (m.labels?.install && m.labels.install !== installId(c.env)) guided(`Coordinator ${name} belongs to a different cloudy-cloud installation, so it was not signed in.\nNext step: list this installation's coordinators with cloudy-cloud coordinator ls`, { short: `Coordinator ${name} belongs to a different cloudy-cloud installation.`, next: 'cloudy-cloud coordinator ls' });
  const sbx = await c.provider.connect(m.id, { retry: false });
  const paneOf = async () => {
    const raw = (await sbx.commands.run('tmux capture-pane -t claude -p -J', { timeoutMs: 15_000 })).stdout ?? '';
    // Exact configured values are removed first; paneState then removes key-shaped text.
    return paneState(secretValues(c.env, c.provider.keyName, consentedLiterals(c.env)).reduce((t, v) => t.split(v).join('[redacted]'), raw));
  };
  let st;
  try { st = await paneOf(); } catch (e) {
    guided(`Could not read the ${name} session screen${e?.message ? `: ${safeText(e.message)}` : ''}. Check the coordinator with cloudy-cloud coordinator status ${name}`, { short: `Could not read the ${name} session screen.`, next: `cloudy-cloud coordinator status ${name}` });
  }
  if (code === undefined) {
    // A terminal is required: signing in means seeing the pane (the URL and the code prompt live there).
    if (!c.tty) guided(`coordinator login opens the session on a terminal. For a non-interactive finish, pass the code the browser showed: cloudy-cloud coordinator login ${name} --code CODE`, { short: 'coordinator login needs a terminal.', reason: 'the sign-in lives in the session pane', next: `cloudy-cloud coordinator login ${name} --code CODE` });
    if (/Login expired|\/login/i.test(st.signin)) c.out('Type /login and sign in.');
    return attach(c, args, { machine: m });
  }
  // The code reaches Claude only at the sign-in prompt: a pane anywhere else eats the keys.
  if (!st.codePrompt) guided(`Coordinator ${name} is not waiting for a sign-in code. Check its screen with cloudy-cloud coordinator status ${name}; if Claude is already running in the pane, type /login in it first (attach with cloudy-cloud coordinator attach ${name})`, { short: `Coordinator ${name} is not waiting for a sign-in code.`, next: `cloudy-cloud coordinator status ${name}` });
  await sbx.commands.run(`tmux send-keys -t claude -l -- ${q(code)} && tmux send-keys -t claude Enter`);
  const t0 = c.now();
  while (c.now() - t0 < 60_000) {
    if (await signedIn(sbx)) return c.out(`Coordinator ${name} is signed in to Claude.`);
    await c.sleep(2000);
  }
  guided(`The code was sent, but Claude on ${name} is still not signed in after 60 seconds. Look at the session with cloudy-cloud coordinator login ${name}: the browser sign-in may not have finished, or the code may be wrong.`, { short: `Claude on ${name} is still not signed in.`, reason: 'the code was sent but the sign-in did not finish in 60 seconds', next: `cloudy-cloud coordinator login ${name}` });
}

// Reads a coordinator's screen once, read-only. waiting is the prompt line a person must answer ('' if none);
// read is false when the screen could not be read (machine not running, network, no tmux session).
async function screenOf(c, m, { withLink = false } = {}) {
  const none = { read: false, waiting: '', signin: false, loginUrl: '', link: '' };
  if (m.state && m.state !== 'running') return none;
  try {
    const sbx = await c.provider.connect(m.id, { retry: false });
    const raw = (await sbx.commands.run('tmux capture-pane -t claude -p -J', { timeoutMs: 15_000 })).stdout ?? '';
    // Exact key values (and consented MCP tokens) are removed first; paneState then removes key-shaped text.
    const pane = secretValues(c.env, c.provider.keyName, consentedLiterals(c.env)).reduce((t, v) => t.split(v).join('[redacted]'), raw);
    const st = paneState(pane);
    const signin = !!st.signin;
    // No Remote Control link while the pane waits at the sign-in: there is no session to link to yet.
    return { ...none, read: true, waiting: st.waiting || st.blocked, signin, loginUrl: st.loginUrl, link: withLink && !signin ? await readLink(sbx) : '' };
  } catch { return none; }
}
const screenText = (r) => (!r.read ? 'screen not read' : r.signin ? 'waiting for Claude sign-in' : r.waiting ? `waiting on a prompt: ${r.waiting}` : '-');

async function status(c, args) {
  const [m] = await find(c.provider, 'coordinator', args[0]);
  if (!m) guided(`No coordinator named ${args[0]}. List them with: cloudy-cloud coordinator ls`, { short: `No coordinator named ${args[0]}.`, next: 'cloudy-cloud coordinator ls', neutral: true });
  const r = await screenOf(c, m, { withLink: true }), name = args[0], state = safeText(m.state ?? '') || 'unknown';
  const shown = safeText(mach(m) ?? '') || 'unknown'; // the server-reported name is display data
  const attach = `cloudy-cloud coordinator attach ${name}`;
  if (args.includes('--json')) return c.out(JSON.stringify({ name, machine: shown, state, screenRead: r.read, ...(r.signin ? { needsLogin: true, ...(r.loginUrl && { loginUrl: r.loginUrl }), next: `cloudy-cloud coordinator login ${name}` } : {}), ...(r.waiting && { waiting: r.waiting }), ...(r.link && { remoteControlUrl: r.link }), attach }));
  if (c.ui.term) {
    const u = c.ui;
    const screen = !r.read ? 'not readable' : r.signin ? u.paint(u.col.warn, 'waiting for Claude sign-in') : r.waiting ? `waiting on a prompt: ${u.paint(u.col.warn, fitCells(r.waiting, Math.max(8, u.width - 35)))}` : 'no prompt waiting';
    // a stopped coordinator has no live session to attach to: no attach action
    return c.out([u.block(`Coordinator ${name}`, [['Machine', shown], ['State', state], ['Screen', screen]]), ...(r.link ? [...linkLines(u, r.link), ...qrLines(u, r.link)] : []), ...(r.loginUrl ? linkLines(u, r.loginUrl) : []), r.signin ? nextFit(u, `cloudy-cloud coordinator login ${name}`) : r.waiting ? nextFit(u, `cloudy-cloud coordinator attach ${name}`) : state === 'running' ? attachFit(u, name) : ''].filter(Boolean).join('\n'));
  }
  c.out([`Coordinator ${name} on machine ${shown}: ${state}`, `Screen: ${screenText(r)}`, r.link && `Remote Control: ${r.link}`, r.loginUrl && `Sign-in link: ${r.loginUrl}`, r.signin ? `Next: cloudy-cloud coordinator login ${name}` : r.waiting ? `Answer it by attaching, or with Remote Control: ${attach}` : `Attach: ${attach}`].filter(Boolean).join('\n'));
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
    // The "next" hint needs a server name that is also a valid argument; a sign-in gets `login`, a prompt `attach`.
    const argOk = (d, i) => NAME_RE.test(rows[i].labels?.name ?? '');
    const signinRow = data.find((d, i) => d.screen === 'waiting for Claude sign-in' && argOk(d, i));
    const waitingRow = data.find((d, i) => d.screen.startsWith('waiting on a prompt') && argOk(d, i));
    const nextCmd = signinRow ? `cloudy-cloud coordinator login ${signinRow.name}` : waitingRow ? `cloudy-cloud coordinator attach ${waitingRow.name}` : '';
    const done = (text) => c.out(nextCmd ? `${text}\n\n${nextFit(u, nextCmd)}` : text);
    // DELETES is the relative time only; the ISO date stays in the piped TSV.
    const rowCells = (d, machine) => [d.name, [[d.state, color[d.state] ?? u.col.err]], u.rel(d.created), ...(machine ? [d.machine] : []),
      d.deleteAt ? [[u.rel(d.deleteAt)]] : [['never', u.col.dim]]];
    const fixedTable = (machine) => u.table(['NAME', 'STATE', 'STARTED', ...(machine ? ['MACHINE'] : []), 'DELETES'], data.map((d) => rowCells(d, machine)));
    const widest = (t) => Math.max(...t.split('\n').map(cellWidth));
    // The SCREEN column gets the width left after the fixed columns. A prompt that does not fit whole moves to
    // wrapped dimmed sub-lines under its row — it is never cut mid-word with an ellipsis.
    const build = (machine) => {
      const cells = data.map((d) => [...rowCells(d, machine), [[d.screen, d.screen.startsWith('waiting') ? u.col.warn : u.col.dim]]]);
      return u.table(['NAME', 'STATE', 'STARTED', ...(machine ? ['MACHINE'] : []), 'DELETES', 'SCREEN'], cells);
    };
    const buildTwo = (machine) => {
      const promptOnly = (d) => d.screen.startsWith('waiting on a prompt:'); // 'waiting for Claude sign-in' stays whole — it names itself
      const cells = data.map((d) => [...rowCells(d, machine), [[promptOnly(d) ? 'waiting' : d.screen, d.screen.startsWith('waiting') ? u.col.warn : u.col.dim]]]);
      const lines = u.table(['NAME', 'STATE', 'STARTED', ...(machine ? ['MACHINE'] : []), 'DELETES', 'SCREEN'], cells).split('\n');
      const out = [lines[0]];
      data.forEach((d, i) => { out.push(lines[i + 1]); if (promptOnly(d)) out.push(...wrapText(u, d.screen.slice(21)).map((l) => `    ${u.dim(l)}`)); });
      return out.join('\n');
    };
    const longest = noted ? Math.max(...data.map((d) => cellWidth(d.screen))) : 0;
    for (const machine of [true, false]) {
      const fixed = fixedTable(machine), room = u.width - widest(fixed);
      if (!noted) { if (room >= 0) return done(fixed); continue; }
      if (longest + 3 <= room) return done(build(machine)); // every screen fits whole in its column
      const t = buildTwo(machine);
      if (widest(t) <= u.width) return done(t);
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
  // Both name our own command when the provider has one (listMachinesUi), so the provider stays behind cloudy-cloud.
  if (c.ui.term) return c.out([statusLine(c.ui, 'ok', `Deleted coordinator ${name}`, [`machine ${safeText(mach(m))}`]),
    c.ui.hint('Its workers go with its cleanup or at their own deadline.'),
    hintFit(c.ui, `List machines: ${c.provider.text.listMachinesUi ?? c.provider.text.listMachines}`)].join('\n'));
  c.out(`Deleted coordinator ${name} (machine ${safeText(mach(m))}). Its workers are deleted by its cleanup process, or by their own delete deadline (6 hours by default). Check with: ${c.provider.text.listMachinesUi ?? c.provider.text.listMachines}`);
}

// Run ON a coordinator machine by the coordinator itself: checks that nothing is lost, then deletes this machine.
async function finish(c, args, deps) {
  const force = args.includes('--force');
  const host = deps.hostname ?? osHostname();
  const mname = c.provider.localMachineName(host);
  const notHere = `This is not a coordinator machine (hostname ${host}). finish only runs on a machine started with: cloudy-cloud coordinator start`;
  const notHereFields = { short: 'This is not a coordinator machine.', reason: `hostname ${host}`, next: 'cloudy-cloud coordinator start NAME --repo URL' };
  if (!mname) guided(notHere, notHereFields);
  const me = (await c.provider.list({ role: 'coordinator' })).find((m) => mach(m) === mname && OUR_PURPOSES.has(m.labels?.purpose) && m.labels?.role === 'coordinator');
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
      try { ahead = git('rev-list', `${b}@{u}..${b}`); } catch { problems.push(`Branch ${b} has no upstream on GitHub; push it with: git push -u origin ${q(b)}`); continue; }
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
const START_OPTIONS = ['--repo', '--branch', '--task', '--task-file', '--max-hours', '--model', '--env'];
const CLOUD_OPTIONS = ['--name', '--branch', '--max-hours', '--model', '--env'];
const CLOUD_FLAGS = ['--no-attach', '--json'];
function validateArgs(cmd, args) {
  const bad = (message, short = message) => usageError(`${message}\nRun: cloudy-cloud coordinator ${cmd} --help`, cmd, short);
  if (cmd === 'cloud') {
    const seen = new Set();
    const badCloud = (message) => guided(`${message}\nUsage: cloudy-cloud cloud [--name N] [--branch B] [--max-hours H] [--model M] [--env FILE]... [--no-attach] [--json]`, { short: message, next: 'cloudy-cloud cloud --help', wrapShort: true });
    for (let i = 0; i < args.length; i++) {
      const option = args[i];
      if (CLOUD_FLAGS.includes(option)) { if (seen.has(option)) badCloud(`Repeated option: ${option}`); seen.add(option); continue; }
      if (!CLOUD_OPTIONS.includes(option)) badCloud(`Unknown argument: ${option}`);
      // --env is repeatable (same as on start): it is not kept in `seen`.
      if (option === '--env') { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) badCloud(`Missing value for ${option}.`); i++; continue; }
      if (seen.has(option)) badCloud(`Repeated option: ${option}`);
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) badCloud(`Missing value for ${option}.`);
      seen.add(option);
      i++;
    }
    return;
  }
  if (cmd === 'image') { if (args.some((a) => a !== '--save') || args.length > 1) bad('Expected image or image --save.'); return; }
  if (cmd === 'status') { if (!NAME_RE.test(args[0] ?? '') || args.slice(1).some((a) => a !== '--json') || args.length > 2) bad('Expected status NAME [--json].'); return; }
  if (cmd === 'ls') { if (args.length) bad('ls takes no arguments.'); return; }
  if (cmd === 'finish') { if (args.some((a) => a !== '--force') || args.length > 1) bad('finish takes only --force.'); return; }
  if (cmd === 'login') {
    if (!NAME_RE.test(args[0] ?? '')) bad('Expected login NAME [--code CODE].');
    const rest = args.slice(1);
    // The --code value is checked in login() itself (its own rule decides), so any code shape reaches it.
    if (rest.length > 2 || (rest.length && rest[0] !== '--code') || (rest[0] === '--code' && rest[1] === undefined)) bad('Expected login NAME [--code CODE].');
    return;
  }
  // The piped text always says what is wrong with the value; the terminal headline says start needs a NAME.
  if (!NAME_RE.test(args[0] ?? '')) bad('NAME must use lowercase letters, digits and hyphens (1 to 40 characters).', cmd === 'start' && (args[0] === undefined || args[0].startsWith('-')) ? 'start needs a NAME.' : 'NAME must use lowercase letters, digits and hyphens (1 to 40 characters).');
  if (cmd !== 'start') { if (args.length !== 1) bad(`${cmd} takes exactly one NAME.`); return; }
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (option === '--json') { if (seen.has(option)) bad('Repeated option: --json'); seen.add(option); continue; }
    if (!START_OPTIONS.includes(option)) bad(`Unknown argument: ${option}`);
    if (seen.has(option)) bad(`Repeated option: ${option}`); // --env is repeatable: it is not kept in `seen`
    if (option === '--env') { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) bad(`Missing value for ${option}.`); i++; continue; }
    if (args[i + 1] === undefined || (option !== '--task' && args[i + 1].startsWith('--'))) bad(`Missing value for ${option}.`);
    seen.add(option);
    i++;
  }
}

// `cloudy-cloud cloud`: inside a clone whose origin is on github.com, one step to a coordinator for this
// branch — local work that is not on GitHub is flagged first (the cloud copy is cloned from GitHub, so it
// would not have it), an already-running coordinator of the same name is reattached to instead of restarted.
async function cloud(c, args) {
  refuseEgress(c.env, 'cloud');
  const dir = c.cwd ?? process.cwd();
  const git = (...a) => { const r = c.spawn('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return !r?.error && r.status === 0 ? (r.stdout ?? '').trim() : null; };
  if (git('rev-parse', '--is-inside-work-tree') !== 'true') guided('cloudy-cloud cloud runs inside a git repository whose origin is on github.com. Run it inside a clone, or start a coordinator the general way: cloudy-cloud coordinator start NAME --repo URL', { short: 'Not inside a git repository.', next: 'cd into a clone, then run cloudy-cloud cloud again' });
  const remote = git('remote', 'get-url', 'origin') ?? '';
  // The URL itself is never echoed back: an https remote can carry a credential. Only owner/repo is extracted.
  const m = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  const repo = m && REPO_RE.test(`https://github.com/${m[1]}`) ? `https://github.com/${m[1]}` : '';
  if (!repo) guided('cloudy-cloud cloud needs an origin that is a github.com repository (https or ssh). Start a coordinator the general way: cloudy-cloud coordinator start NAME --repo URL', { short: 'The origin is not a github.com URL.', next: 'cloudy-cloud coordinator start NAME --repo URL' });
  const branch = flag(args, '--branch') ?? git('branch', '--show-current');
  if (!branch) guided('There is no current branch (HEAD is detached). Check out a branch or pass --branch.', { short: 'No current branch (detached HEAD).', next: 'check out a branch, or pass --branch' });
  if (!/^[\w./-]+$/.test(branch)) guided('--branch has characters that are not allowed.', { short: '--branch has characters that are not allowed.', next: 'cloudy-cloud cloud --help' });
  const path = repoPath(repo); // owner/repo — the value the machine's repo label stores
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  // The default name is <owner>-<repo>-<branch>-<hash>: the short hash of owner/repo/branch always rides
  // along, so two different repos — or the same repo on two branches — can never collide on the name.
  const wanted = slug(`${path.replace('/', '-')}-${branch}`);
  const auto = `${wanted.slice(0, 32).replace(/-+$/g, '')}-${createHash('sha1').update(`${path}@${branch}`).digest('hex').slice(0, 7)}`;
  const name = flag(args, '--name') ?? auto;
  if (!NAME_RE.test(name)) guided(`The coordinator name "${safeText(name)}" is not valid. Pass one with --name: lowercase letters, digits and hyphens (1 to 40 characters).`, { short: 'The coordinator name must use lowercase letters, digits and hyphens (1 to 40 characters).', next: 'cloudy-cloud cloud --help' });
  const json = args.includes('--json');
  // Reattach only to a RUNNING coordinator THIS installation made (install label) whose repo and branch
  // labels match this checkout — a bare name match could otherwise hand the session of a teammate's
  // coordinator, a different project, or a stale machine to this repo.
  const existing = await find(c.provider, 'coordinator', name);
  const mine = installId(c.env);
  const match = existing.find((m) => m.state === 'running' && m.labels?.install === mine && m.labels?.repo === path && m.labels?.branch === branch);
  if (match || existing.length) {
    if (!match) {
      const m0 = existing[0], labels = m0.labels ?? {};
      const conflict = m0.state !== 'running' ? `it is ${safeText(m0.state ?? '') || 'not running'}`
        : !labels.install ? 'it has no installation label (it was made before coordinators carried one), so cloud cannot verify it is yours'
        : labels.install !== mine ? 'it belongs to a different cloudy-cloud installation'
        : labels.repo !== path ? `it belongs to ${safeText(labels.repo ?? '') || 'a different repository'}, not ${path}`
        : `it is on branch ${safeText(labels.branch ?? '') || 'another branch'}, not ${branch}`;
      // A legacy coordinator (no install label) can still be attached to by name; a foreign one cannot.
      const next = labels.install ? 'pick a different name with --name, or stop it first' : 'attach to it by name, or pick a different name with --name';
      guided(`A coordinator named ${name} already exists, but ${conflict}.\nNext step: ${next}: cloudy-cloud ${labels.install ? `coordinator stop ${name}` : `coordinator attach ${name}`} — or: cloudy-cloud cloud --name OTHER`, { short: `The name ${name} is taken by a different coordinator.`, reason: conflict, next: 'cloudy-cloud cloud --name OTHER' });
    }
    // --env on a reattach would silently do nothing: say so instead (env files apply at start only).
    if (envFileArgs(args, c.env).length) c.note(`Environment: the env files were not applied — coordinator ${name} already runs (env files are applied at start only).`);
    if (json) return c.out(JSON.stringify({ name, machine: safeText(mach(match) ?? ''), reattached: true, attach: `cloudy-cloud coordinator attach ${name}` }));
    c.out(`Reattaching to ${name}`);
    return attach(c, [name], { noAttach: args.includes('--no-attach'), machine: match });
  }
  // A fresh start only: what the GitHub clone would not have — commits the branch has not pushed to
  // origin/<branch> (fetched first), plus edits to tracked files. Untracked files warn but never block.
  const untracked = (git('status', '--porcelain') ?? '').split('\n').filter((l) => l.startsWith('?? ')).length;
  if (untracked) c.note(`${untracked} untracked file(s) are not committed; the cloud clone will not have them.`);
  git('fetch', '-q', 'origin', branch); // best effort: an offline laptop compares against the last fetched ref
  const dirty = git('status', '--porcelain', '--untracked-files=no') ?? '';
  // Local <branch> is compared, not HEAD: --branch may point at a branch that is not checked out. A local
  // branch that does not exist skips the unpushed check (there is nothing local to miss).
  const ahead = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) === null ? 0
    : git('rev-parse', '--verify', '--quiet', `origin/${branch}`) !== null ? Number(git('rev-list', '--count', `origin/${branch}..${branch}`)) : -1;
  const problems = [ahead === -1 && `the branch ${branch} is not on origin at all`, ahead > 0 && `${ahead} commit(s) on ${branch} are not pushed to origin/${branch}`, dirty && 'uncommitted changes to tracked files'].filter(Boolean);
  if (problems.length) {
    const push = `git push${ahead === -1 ? ` -u origin ${branch}` : ''}`;
    const why = `The cloud clone comes from GitHub, so it will not have:\n- ${problems.join('\n- ')}`;
    // --json means a script is reading: fail like a pipe does instead of prompting (which would touch stdout).
    if (!c.tty || json) guided(`${why}\nPush first (${push}), then run cloudy-cloud cloud again.`, { short: 'Local work is not on GitHub.', details: problems.map((p) => `- ${p}`), next: `${push}, then run cloudy-cloud cloud again` });
    c.out(why);
    const answer = (await c.ask('Start anyway? [y/N] '))?.trim() ?? 'n';
    if (!/^y/i.test(answer)) return c.out('Not started.');
  }
  // Same start path as `coordinator start`; the flags that exist on both are passed straight through.
  const startArgs = [name, '--repo', repo, '--branch', branch,
    ...['--max-hours', '--model'].flatMap((f) => (flag(args, f) !== undefined ? [f, flag(args, f)] : [])),
    ...flags(args, '--env').flatMap((f) => ['--env', f]),
    ...(json ? ['--json'] : [])];
  const res = await start(c, startArgs);
  if (args.includes('--no-attach') || json || !c.tty) return undefined;
  // A coordinator waiting for its Claude sign-in attaches to the sign-in pane, not to Claude: say so first.
  if (res?.needsLogin) {
    c.out('Sign in to Claude in the window that opens (each coordinator has its own sign-in).');
    await attach(c, [name]);
    // The Remote Control link exists only once the sign-in finished; report what happened on detach.
    try {
      const [m] = await find(c.provider, 'coordinator', name);
      const sbx = m && await c.provider.connect(m.id, { retry: false });
      if (sbx && await signedIn(sbx)) {
        const url = await readLink(sbx);
        return c.out(url ? `Remote Control: ${url}` : `Signed in. The Remote Control link is not ready yet; get it with: cloudy-cloud coordinator status ${name}`);
      }
      return c.out(`Not signed in yet — run: cloudy-cloud coordinator login ${name}`);
    } catch { return c.out(`Check the session with: cloudy-cloud coordinator status ${name}`); }
  }
  return attach(c, [name]);
}

async function run(argv, deps) {
  const [cmd, ...args] = argv;
  const commands = { image, start, attach, login, ls, status, stop, finish: (c, a) => finish(c, a, deps), cloud };
  const isHelp = (a) => a === '--help' || a === '-h';
  if ((isHelp(cmd) && !args.length) || (Object.hasOwn(commands, cmd) && args.length === 1 && isHelp(args[0]))) {
    return (deps.out ?? console.log)(coordinatorHelp(Object.hasOwn(commands, cmd) ? cmd : undefined));
  }
  if (!Object.hasOwn(commands, cmd)) usageError('Usage: cloudy-cloud coordinator image [--save] | start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--env FILE]... [--json] | attach NAME | login NAME [--code CODE] | ls | status NAME [--json] | stop NAME | finish [--force]\nRun: cloudy-cloud coordinator --help', undefined, cmd ? `"${cmd}" is not a coordinator command.` : 'coordinator needs a command.');
  validateArgs(cmd, args);
  const c = await context(deps);
  // A provider that cannot run coordinators at all says so in its own words first (it may name a working alternative);
  // only then does the generic snapshots check apply. The first sentence is the problem; it wraps, never truncates.
  if (['image', 'start', 'cloud'].includes(cmd) && c.provider.text?.coordinatorRefusal) {
    const s = c.provider.text.coordinatorRefusal.split(/(?<=\.) +/); // a second sentence is the action
    guided(c.provider.text.coordinatorRefusal, { short: s[0], details: s.slice(1, -1), next: s.length > 1 ? s.at(-1) : 'cloudy-cloud coordinator --help', wrapShort: true });
  }
  if (['image', 'start', 'cloud'].includes(cmd) && !c.provider.caps.hasSnapshots) guided(`Provider ${c.provider.name} has no snapshots, which coordinators need.`, { short: `Provider ${c.provider.name} has no snapshots, which coordinators need.`, next: 'cloudy-cloud setup --provider instabox' });
  try { return await commands[cmd](c, args); } catch (e) {
    // The key error always folds into one line for scripts (provider text is flattened so it cannot forge a
    // guidance label); the terminal fields carry our own words, with the provider's text as the diagnostic.
    // An error our own providers mark local keeps the short/next they carry; a foreign one gets generic words.
    if (e?.code === 'no_key') guided(`${String(e.message).replaceAll('\n', ' ')} Run: ${(e.local === true && e.next) || 'cloudy-cloud setup'}`, { short: (e.local === true && e.short) || `A required ${c.provider.name} key is missing.`, details: [String(e.message)], next: (e.local === true && e.next) || 'cloudy-cloud setup', nextCmd: (e.local === true && e.nextCmd === true) || undefined });
    throw e;
  }
}

// Every `start` failure (bad arguments, missing key, provider errors) gets guidance, scrubbed of exact configured
// secret values; --json also prints it as one error object.
export async function main(argv, deps = {}) {
  try { return await run(argv, deps); } catch (e) {
    if (argv[0] !== 'start' && argv[0] !== 'cloud') throw e;
    const env = deps.env ?? loadEnv();
    // e.scrubValues carries extra exact values an error may contain (bridged literal --env values).
    const secrets = [...Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET/i.test(k) && String(v ?? '').length >= 8).map(([, v]) => String(v)), ...(Array.isArray(e?.scrubValues) ? e.scrubValues : [])];
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
    // a known code got our template appended. Foreign text alone never becomes trusted guidance (#185):
    // a recognised provider/SDK error is rendered from our template for its code (whatHappened, likelyCause,
    // nextStep), and its original text prints only as a diagnostic detail — never as a headline.
    const foreign = e?.local !== true && code !== 'unknown' && !has;
    const own = (v) => (e?.local === true && v ? clean(v) : undefined);
    throw Object.assign(new Error(code !== 'unknown' && !has ? `${message}\n${guide(code, { message, secrets })}` : message), { code: e?.code, local: e?.local === true || code !== 'unknown', short: own(e?.short) ?? (foreign ? g.whatHappened : undefined), reason: own(e?.reason) ?? (foreign ? g.likelyCause : undefined), next: own(e?.next) ?? (foreign ? g.nextStep : undefined), neutral: e?.neutral, wrapShort: e?.wrapShort, nextCmd: (e?.local === true && e?.nextCmd === true) || undefined, details: e?.local === true && Array.isArray(e?.details) ? e.details.map((d) => clean(d)) : foreign ? [message] : undefined });
  }
}

// A recovery the user can run gets "→ Next:"; an instruction in prose gets the quiet › hint marker.
// A command is a line that starts with a known CLI word and carries no sentence punctuation.
const CMD_HEAD = /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:cloudy-cloud|npx|msb|ssh|git|claude|curl|docker|tmux|instabox|printf|sudo|apt-get|open)\b/;
const runnable = (s) => CMD_HEAD.test(s) && !/[,;:!?]|\.(?:\s|$)/.test(s);

// How an error prints. One guidance layer on a terminal: ✖ short, dim details and reason, then exactly one
// recovery line — → Next for a command, › for prose. Embedded label text parses once (parseGuidance) into the
// same shape; "Tell the user" never prints. Problem and reason text wraps whole words, never an ellipsis.
// Plain stderr is `cloudy-cloud: message`, unchanged for scripts.
export function errorScreen(e, u) {
  const text = redact(safeText(e.message ?? e));
  if (!u.term) return `cloudy-cloud: ${text}`;
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
  // Guidance — embedded labels or the short/reason/next/details fields — is trusted only from an error our
  // own code created (`local`). Anything else is provider text: it prints as dim diagnostics under a generic
  // short line, with the generic Next — never as our instructions.
  const ours = e?.local === true;
  const structured = ours && Boolean(e.next || e.short || e.reason || Array.isArray(e.details)); // author-chosen fields: the embedded text is not re-read
  const first = text.split('\n')[0];
  const short = scrub((ours && e.short) || (ours ? (structured ? first : head[0] ?? fields['What happened'] ?? first) : 'Something failed.'));
  let reason = scrub((ours && e.reason) || (structured || !ours ? undefined : bare(fields['Likely cause'] ?? fields['What happened'] ?? ''))) || undefined;
  const next = human(scrub(((ours && e.next) || (structured || !ours ? undefined : [fields['Next step'], fields.Next, fields.Run].map((v) => v && bare(v.trim())).find(Boolean))) ?? 'cloudy-cloud coordinator --help')) || 'cloudy-cloud coordinator --help';
  const details = (ours ? (Array.isArray(e.details) ? e.details : structured ? [] : [...head.slice(1), ...(fields['Likely cause'] ? [fields['What happened']] : [])].filter((l) => l !== undefined && l !== '')) : text.split('\n')).map((d) => scrub(String(d)));
  // The short and reason lines wrap at word boundaries; nothing is ever cut mid-word with an ellipsis.
  // The headline's room is the width minus the prefix it renders with — '  [x] ' under LANG=C is wider than '  ✖ '.
  const shortLines = wrapText(u, short, u.width - cellWidth(u.err('')));
  const seen = new Set([short.trim(), ...shortLines.map((l) => l.trim())]); // never print the same line twice
  if (reason && seen.has(reason.trim())) reason = undefined;
  const body = details.flatMap((d) => d.split('\n').flatMap((l) => (l.trim() ? wrapText(u, bare(l)) : ['']))).filter((l) => { const t = l.trim(); if (!t) return true; if (seen.has(t)) return false; seen.add(t); return true; });
  return [
    ...(ours && e.neutral ? shortLines.map((l, i) => (i ? `    ${l}` : `  ${l}`)) : shortLines.map((l, i) => (i ? `    ${u.dim(l)}` : u.err(l)))),
    ...body.map((l) => (l ? `    ${u.dim(l)}` : '')),
    ...(reason ? wrapText(u, reason, u.width - 8).map((l) => `    ${u.dim(l)}`) : []),
    (ours && e.nextCmd === true) || runnable(next) ? nextFit(u, next) : hintFit(u, next),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch((e) => {
    console.error(errorScreen(e, makeUi({ tty: Boolean(process.stderr.isTTY) })));
    process.exit(1);
  });
}
