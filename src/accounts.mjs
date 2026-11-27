// Saved Claude accounts for coordinators. Sign in once per account: when a coordinator finishes its
// browser sign-in, the machine's credential is read back and saved on this laptop, and the next
// coordinator that picks the account starts already signed in. One account serves one coordinator at
// a time — the refresh token rotates about every eight hours and a second machine renewing with an
// old copy loses the sign-in — so a saved account is leased to exactly one coordinator, and the
// machine's newest credential is synced back while it runs and before it is deleted.
//
// Storage under <config>/accounts/ (the config dir CLOUDY_CLOUD_CONFIG points into, default
// ~/.config/cloudy-cloud): the directory is mode 700, each <label>.json holds the credential file
// content verbatim at mode 600, and index.json tracks labels, emails, leases, usage limits and stale
// sign-ins — never a token. Every write is atomic: a mode-600 temp file renamed into place.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeSecretFile } from './providers/index.mjs';

export const LABEL_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
export const SYNC_EVERY_MS = 30 * 60_000; // the detached watcher syncs leased accounts every half hour
export const BEFORE_DELETE_MS = 10 * 60_000; // and once more about this long before the machine dies
export const LIMIT_MS = 5 * 60 * 60_000; // an unparseable reset time limits an account for 5 hours
export const WATCH_PID = 'sync-watch.pid';
// The pane lines that mean this Claude account is out of room (an invalid key is not a usage limit).
export const LIMIT_LINE = /^(?:You've hit your [\w -]*limit|Credit balance is too low)/i;

export const accountsDir = (env) => join(dirname(env?.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config', 'cloudy-cloud', 'env')), 'accounts');
export const credFile = (dir, label) => join(dir, `${label}.json`);

const ensureDir = (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); };
const atomicWrite = (path, text, mode = 0o600) => {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path); // mode was set at creation, before the rename publishes it
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The index maps label → { email, leasedBy: {name, machineId, provider, deleteAt}, leasedAt,
// lastUsed, limitedUntil, needsSignIn } — all timestamps in ms. It never holds a token.
export const readIndex = (dir) => {
  try { const j = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')); return isObj(j) ? j : {}; }
  catch { return {}; }
};
const writeIndex = (dir, idx) => atomicWrite(join(dir, 'index.json'), `${JSON.stringify(idx, null, 2)}\n`);
export const updateAccount = (dir, label, fn) => {
  const idx = readIndex(dir);
  const next = fn(isObj(idx[label]) ? { ...idx[label] } : {});
  if (next == null) delete idx[label]; else idx[label] = next;
  writeIndex(dir, idx);
  return next;
};

export const credJson = (text) => {
  try { const j = JSON.parse(text); return isObj(j?.claudeAiOauth) ? j.claudeAiOauth : null; }
  catch { return null; }
};
export const readCredential = (dir, label) => { try { return readFileSync(credFile(dir, label), 'utf8'); } catch { return ''; } };
export const saveCredential = (dir, label, text) => atomicWrite(credFile(dir, label), text);
// The credential from a finished sign-in: overwrites the label's saved file and clears a stale
// sign-in mark (a fresh sign-in is exactly what clears it). The lease it sits under is kept.
export const saveAccount = (dir, label, { email, credText, now = 0 }) => {
  saveCredential(dir, label, credText);
  return updateAccount(dir, label, (e) => ({ ...e, email: email ?? e.email, lastUsed: now, needsSignIn: undefined }));
};

// The saved-account label: an email sanitised to [a-z0-9._@-], '' when nothing usable remains.
export const emailLabel = (email) => {
  const l = String(email ?? '').trim().toLowerCase().replace(/[^a-z0-9._@-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return LABEL_RE.test(l) ? l : '';
};
const readdir = (dir) => { try { return readdirSync(dir); } catch { return []; } };
// Index entries plus credential files dropped in by hand: a <label>.json with no index row is still
// an account the next start may pick.
export const listAccounts = (dir) => {
  const idx = readIndex(dir);
  const labels = new Set(Object.keys(idx));
  for (const f of readdir(dir)) if (f.endsWith('.json') && f !== 'index.json') labels.add(f.slice(0, -5));
  return [...labels].sort().map((label) => ({ label, ...(isObj(idx[label]) ? idx[label] : {}), saved: existsSync(credFile(dir, label)) }));
};
// Pickable accounts: saved credential present, not leased, not limited, sign-in not stale — least
// recently used first, so several accounts rotate instead of wearing out one.
export const freeAccounts = (dir, now) => listAccounts(dir)
  .filter((a) => a.saved && !a.leasedBy?.name && !a.needsSignIn && !(Number(a.limitedUntil) > now))
  .sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0) || a.label.localeCompare(b.label));
export const leasedAccounts = (dir) => listAccounts(dir).filter((a) => a.leasedBy?.name);
export const nextAccountLabel = (dir) => {
  const used = new Set(listAccounts(dir).map((a) => a.label));
  for (let i = 1; ; i++) if (!used.has(`account-${i}`)) return `account-${i}`;
};

export const lease = (dir, label, leasedBy, now) => updateAccount(dir, label, (e) => ({ ...e, leasedBy, leasedAt: now, lastUsed: now }));
export const release = (dir, label) => updateAccount(dir, label, (e) => { const { leasedBy, leasedAt, ...rest } = e; return rest; });
export const markNeedsSignIn = (dir, label, on = true) => updateAccount(dir, label, (e) => ({ ...e, needsSignIn: on || undefined }));
export const markLimited = (dir, label, until) => updateAccount(dir, label, (e) => ({ ...e, limitedUntil: until }));

// When a usage-limit line resets: "resets 3pm" / "resets at 15:30" / "resets in 2 hours" / an ISO
// time — otherwise 5 hours from now. A time that already passed today rolls to tomorrow.
export const limitUntil = (line, now) => {
  const text = String(line ?? '');
  let m = /\bresets?\s+in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i.exec(text);
  if (m) return now + Number(m[1]) * (/^h/i.test(m[2]) ? 3_600_000 : 60_000);
  m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i.exec(text);
  if (m) return nextTime(now, (Number(m[1]) % 12) + (/^p/i.test(m[3]) ? 12 : 0), Number(m[2] ?? 0));
  m = /\bresets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\b/.exec(text);
  if (m) return nextTime(now, Number(m[1]), Number(m[2]));
  m = /\bresets?\s+(?:at|on)?\s*(\d{4}-\d{2}-\d{2}(?:[T ][0-9:]+)?(?:Z|[+-][0-9:]+)?)/.exec(text);
  if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) return t; }
  return now + LIMIT_MS;
};
const nextTime = (now, h, min) => { const d = new Date(now); d.setHours(h, min, 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime(); };

// The credential path on the machine follows launch.sh exactly: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}.
const CRED_DIR_CMD = 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
export const credDir = async (sbx) => (await sbx.commands.run(CRED_DIR_CMD, { timeoutMs: 15_000 })).stdout.trim();
// The machine's saved sign-in, when the file parses and still carries a refresh token.
export const readMachineCredential = async (sbx) => {
  if (typeof sbx?.files?.read !== 'function') return null;
  const dir = await credDir(sbx);
  if (!dir) return null;
  const raw = await sbx.files.read(`${dir}/.credentials.json`);
  const text = typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '';
  const oauth = credJson(text);
  return oauth?.refreshToken ? { text, oauth } : null;
};
// Deliver a saved account's credential before the tmux session starts: the file mode is created
// narrow, the body travels the secret-file route (never a command string), then a chmod. The
// .credentials-removed marker goes in first so launch.sh's one-time image-credential removal can
// never delete what was just delivered.
export const deliverCredential = async (sbx, confDir, credText) => {
  const dir = await credDir(sbx);
  if (!dir) throw new Error('Could not read the Claude config dir on the machine.');
  const creds = `${dir}/.credentials.json`;
  await sbx.commands.run(`umask 077 && : > "${creds}" && touch "${confDir}/.credentials-removed"`);
  await writeSecretFile(sbx, creds, credText);
  await sbx.commands.run(`chmod 600 "${creds}"`);
};
// Copy the machine's credential back to the laptop — only when it parses, carries a refresh token,
// and is newer by expiresAt than the saved one. Returns true when the saved file was refreshed.
export const syncBack = async (dir, sbx, label, now) => {
  const got = await readMachineCredential(sbx);
  if (!got) return false;
  const saved = credJson(readCredential(dir, label));
  if (saved && !(Number(got.oauth.expiresAt) > Number(saved.expiresAt ?? 0))) return false;
  saveCredential(dir, label, got.text);
  updateAccount(dir, label, (e) => ({ ...e, lastUsed: now }));
  return true;
};

// The detached `accounts sync --watch` process marks itself in a pid file so a second one exits at
// once; a dead pid lets the next cloudy-cloud command resume the sync after a laptop sleep.
export const watcherPid = (dir) => { try { const p = Number(readFileSync(join(dir, WATCH_PID), 'utf8').trim()); return Number.isInteger(p) && p > 0 ? p : 0; } catch { return 0; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
export const watcherAlive = (dir) => { const p = watcherPid(dir); return p > 0 && pidAlive(p); };
export const acquireWatcher = (dir, pid = process.pid) => {
  if (watcherAlive(dir)) return false;
  ensureDir(dir);
  writeFileSync(join(dir, WATCH_PID), String(pid), { mode: 0o600 });
  return watcherPid(dir) === pid; // a same-instant second writer loses and exits
};
export const releaseWatcher = (dir, pid = process.pid) => { try { if (watcherPid(dir) === pid) unlinkSync(join(dir, WATCH_PID)); } catch { /* a newer watcher's file stays */ } };
export const spawnWatcher = (script) => {
  const child = spawn(process.execPath, [script, 'accounts', 'sync', '--watch'], { detached: true, stdio: 'ignore' });
  child.unref();
};
// Called by every coordinator command: with leases outstanding and no live watcher, resume the sync.
// Bookkeeping only — it must never fail a command.
export const ensureWatcher = (env, spawnIt) => {
  try {
    const dir = accountsDir(env);
    if (!leasedAccounts(dir).length || watcherAlive(dir)) return;
    spawnIt();
  } catch { /* bookkeeping only */ }
};

// `accounts ls` rows and --json fields. No token ever leaves the credential files into these.
const shortTime = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
export const accountState = (a, now) =>
  a.leasedBy?.name ? `used by ${a.leasedBy.name}` :
    a.needsSignIn ? 'needs sign-in' :
      Number(a.limitedUntil) > now ? `limited until ${shortTime(a.limitedUntil)}` : 'free';
export const accountRow = (a, now) => ({ label: a.label, email: a.email ?? '', state: accountState(a, now), lastUsed: a.lastUsed ? shortTime(a.lastUsed) : 'never' });
