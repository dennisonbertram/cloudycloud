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
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeSecretFile } from './providers/index.mjs';

export const LABEL_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
export const SYNC_EVERY_MS = 30 * 60_000; // the detached watcher syncs leased accounts every half hour
export const BEFORE_DELETE_MS = 10 * 60_000; // and once more about this long before the machine dies
export const LIMIT_MS = 5 * 60 * 60_000; // an unparseable reset time limits an account for 5 hours
export const WATCH_PID = 'sync-watch.pid';
export const PENDING_LEASE_MS = 10 * 60_000; // a start reservation that never bound a machine expires
// The pane lines that mean this Claude account is out of room (an invalid key is not a usage limit).
export const LIMIT_LINE = /^(?:You've hit your [\w -]*limit|Credit balance is too low)/i;

export const accountsDir = (env) => join(dirname(env?.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config', 'cloudy-cloud', 'env')), 'accounts');
// Labels that already name files inside the directory: `index` is the lease database itself and a
// *.tmp name can collide with a write's temp file. No credential may ever be saved under them.
export const reservedLabel = (label) => label === 'index' || label === WATCH_PID || String(label).endsWith('.tmp');
export const validLabel = (label) => LABEL_RE.test(label ?? '') && !reservedLabel(label);
export const credFile = (dir, label) => {
  if (!validLabel(label)) throw Object.assign(new Error(`Not a usable account label: ${JSON.stringify(String(label))}`), { code: 'invalid_label', local: true });
  return join(dir, `${label}.json`);
};

const ensureDir = (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); };
const atomicWrite = (path, text, mode = 0o600) => {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path); // mode was set at creation, before the rename publishes it
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Cross-process mutual exclusion for every read-modify-write of the index: an O_EXCL lock file,
// re-entrant within this process. A lock whose holder died — or that is simply too old — is
// reclaimed, so a killed run can never wedge the accounts.
const LOCK_FILE = 'index.lock';
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 15_000;
const held = new Map(); // dir → re-entry depth
const lockState = (file) => {
  try {
    const [pid] = readFileSync(file, 'utf8').split(/\s+/);
    return { pid: Number(pid), mtime: statSync(file).mtimeMs };
  } catch { return null; } // a half-written or missing lock is stale
};
export const withLock = (dir, fn) => {
  const depth = held.get(dir) ?? 0;
  if (depth > 0) { held.set(dir, depth + 1); try { return fn(); } finally { held.set(dir, depth); } }
  ensureDir(dir);
  const file = join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { writeFileSync(file, `${process.pid} ${Date.now()}`, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const snap = lockState(file);
    const stale = !snap || !(snap.pid > 0) || !pidAlive(snap.pid) || Date.now() - snap.mtime > LOCK_STALE_MS;
    if (stale) {
      // Reclaim only when the file is still the same stale one we just inspected.
      const again = lockState(file);
      if (!snap ? !again : again && again.pid === snap.pid && again.mtime === snap.mtime) { try { unlinkSync(file); } catch { /* someone else reclaimed it */ } }
      continue;
    }
    if (Date.now() > deadline) throw Object.assign(new Error('Timed out waiting for the accounts lock.'), { code: 'accounts_locked', local: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  held.set(dir, 1);
  try { return fn(); } finally { held.delete(dir); try { unlinkSync(file); } catch { /* a reclaimer owns the file now */ } }
};

// The index maps label → { email, accountUuid, leasedBy: {name, machineId, provider, deleteAt,
// pending}, leasedAt, lastUsed, limitedUntil, needsSignIn } — all timestamps in ms. It never holds a
// token. A damaged index is never an empty pool: refusing is safer than treating leased accounts as
// free and delivering a live refresh token to a second machine.
export const readIndex = (dir) => {
  let text;
  try { text = readFileSync(join(dir, 'index.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  try { const j = JSON.parse(text); if (isObj(j)) return j; } catch { /* falls through */ }
  throw Object.assign(new Error(`The saved-accounts index at ${join(dir, 'index.json')} is damaged — refusing to treat every account as free. Fix or remove it, then retry.`), { code: 'accounts_index_corrupt', local: true });
};
const writeIndex = (dir, idx) => atomicWrite(join(dir, 'index.json'), `${JSON.stringify(idx, null, 2)}\n`);
export const updateAccount = (dir, label, fn) => withLock(dir, () => {
  const idx = readIndex(dir);
  const next = fn(isObj(idx[label]) ? { ...idx[label] } : {});
  if (next == null) delete idx[label]; else idx[label] = next;
  writeIndex(dir, idx);
  return next;
});

export const credJson = (text) => {
  try { const j = JSON.parse(text); return isObj(j?.claudeAiOauth) ? j.claudeAiOauth : null; }
  catch { return null; }
};
export const readCredential = (dir, label) => { try { return readFileSync(credFile(dir, label), 'utf8'); } catch { return ''; } };
export const saveCredential = (dir, label, text) => atomicWrite(credFile(dir, label), text);
// The credential from a finished sign-in: overwrites the label's saved file and clears a stale
// sign-in mark (a fresh sign-in is exactly what clears it). The lease it sits under is kept. The
// file write and the index update are one locked step so a concurrent sync cannot slide between
// the freshness check and the write.
export const saveAccount = (dir, label, { email, accountUuid, credText, now = 0 }) => withLock(dir, () => {
  saveCredential(dir, label, credText);
  return updateAccount(dir, label, (e) => ({ ...e, email: email ?? e.email, accountUuid: accountUuid ?? e.accountUuid, lastUsed: now, needsSignIn: undefined }));
});

// The saved-account label: an email sanitised to [a-z0-9._@-], '' when nothing usable remains.
export const emailLabel = (email) => {
  const l = String(email ?? '').trim().toLowerCase().replace(/[^a-z0-9._@-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return validLabel(l) ? l : '';
};
// One Claude account, one label: the auth-status identity (accountUuid first, then email) decides
// whether an index entry already names the account a machine just signed into.
export const sameAccount = (entry, j) =>
  (typeof j?.accountUuid === 'string' && entry?.accountUuid === j.accountUuid) ||
  (typeof j?.email === 'string' && typeof entry?.email === 'string' && entry.email.toLowerCase() === j.email.toLowerCase());
const readdir = (dir) => { try { return readdirSync(dir); } catch { return []; } };
// Index entries plus credential files dropped in by hand: a <label>.json with no index row is still
// an account the next start may pick. Reserved and malformed labels are never listed.
export const listAccounts = (dir) => {
  const idx = readIndex(dir);
  const labels = new Set(Object.keys(idx).filter(validLabel));
  for (const f of readdir(dir)) if (f.endsWith('.json') && f !== 'index.json' && validLabel(f.slice(0, -5))) labels.add(f.slice(0, -5));
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
// Releasing is conditional when options are given: `machineId` must match the lease generation the
// caller checked (a recycled label's newer lease is never released), `pending` releases only a
// start reservation. Returns whether anything was released.
export const release = (dir, label, { machineId, pending } = {}) => {
  let did = false;
  updateAccount(dir, label, (e) => {
    if (machineId !== undefined && e.leasedBy?.machineId !== machineId) return e;
    if (pending !== undefined && Boolean(e.leasedBy?.pending) !== pending) return e;
    did = true;
    const { leasedBy, leasedAt, ...rest } = e;
    return rest;
  });
  return did;
};
// Second step of a start reservation: bind the pending lease (same coordinator, still pending, no
// machine yet) to the machine that was just created. False when the reservation is no longer ours —
// delivery must then not happen.
export const bindLease = (dir, label, leasedBy, now) => {
  let ok = false;
  updateAccount(dir, label, (e) => {
    if (e.leasedBy?.name !== leasedBy.name || !e.leasedBy.pending || e.leasedBy.machineId) return e;
    ok = true;
    return { ...e, leasedBy, leasedAt: now };
  });
  return ok;
};
// Final step: the credential was delivered, so the lease becomes eligible for sync. Generation-
// checked like release.
export const markDelivered = (dir, label, machineId) => updateAccount(dir, label, (e) => {
  if (e.leasedBy?.machineId !== machineId || !e.leasedBy?.pending) return e;
  const { pending, ...leasedBy } = e.leasedBy;
  return { ...e, leasedBy };
});
// `accounts rm` file removal: the credential file plus leftover temp files of its writes. Only
// ENOENT is ignored — every other failure is reported so nothing is silently left behind.
export const removeAccountFiles = (dir, label) => {
  const failed = [];
  const rm = (p) => { try { unlinkSync(p); return true; } catch (e) { if (e.code !== 'ENOENT') failed.push(`${p} (${e.code ?? e.message})`); return e.code === 'ENOENT'; } };
  const gone = rm(credFile(dir, label));
  for (const f of readdir(dir)) if (f.startsWith(`${label}.json.tmp-`)) rm(join(dir, f));
  return { gone, failed };
};
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
// The machine's saved sign-in, when the file parses and still carries a refresh token. reads go
// through files.readSecret where the adapter provides one — it fails closed when the only route
// left would put the credential in command stdout (Instabox's base64 exec fallback).
export const readMachineCredential = async (sbx) => {
  const read = sbx?.files?.readSecret ?? sbx?.files?.read;
  if (typeof read !== 'function') return null;
  const dir = await credDir(sbx);
  if (!dir) return null;
  const raw = await read.call(sbx.files, `${dir}/.credentials.json`);
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
// and is newer by expiresAt than the saved one. Returns 'synced', 'current' (the saved copy proved
// at least as new) or 'failed' (no usable machine credential): the caller needs the difference —
// releasing a lease after an unverified read makes a possibly-spent token the only copy, so it is
// marked needsSignIn instead. The freshness compare and the write are one locked step.
export const syncBack = async (dir, sbx, label, now) => {
  const got = await readMachineCredential(sbx);
  if (!got) return 'failed';
  return withLock(dir, () => {
    const saved = credJson(readCredential(dir, label));
    if (saved && !(Number(got.oauth.expiresAt) > Number(saved.expiresAt ?? 0))) return 'current';
    saveCredential(dir, label, got.text);
    updateAccount(dir, label, (e) => ({ ...e, lastUsed: now }));
    return 'synced';
  });
};

// The detached `accounts sync --watch` process marks itself in an exclusively-created pid file so
// a second one exits at once. The file carries the holder's start-time token (ps lstart): a reused
// pid fails the token check and its file is reclaimed, so pid reuse can never suppress a restart.
export const watcherToken = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const readWatcherFile = (dir) => {
  try {
    const [pid, ...rest] = readFileSync(join(dir, WATCH_PID), 'utf8').trim().split(/\s+/);
    const p = Number(pid);
    return { pid: Number.isInteger(p) && p > 0 ? p : 0, token: rest.join(' ') };
  } catch { return { pid: 0, token: '' } };
};
export const watcherPid = (dir) => readWatcherFile(dir).pid;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
export const watcherAlive = (dir) => {
  const { pid, token } = readWatcherFile(dir);
  if (!(pid > 0) || !pidAlive(pid)) return false;
  const live = watcherToken(pid);
  if (!live) return true; // ps is unavailable — a live pid stays trusted rather than double-running
  if (token) return token === live;
  // A file without a token (written before the token existed) is owned only when its pid is older
  // than the file: a pid reused after the write started later.
  try { return statSync(join(dir, WATCH_PID)).mtimeMs >= new Date(live).getTime() - 2000; } catch { return false; }
};
export const acquireWatcher = (dir, pid = process.pid) => {
  ensureDir(dir);
  const file = join(dir, WATCH_PID);
  for (let i = 0; i < 10; i++) {
    try { writeFileSync(file, `${pid} ${watcherToken(pid)}`, { flag: 'wx', mode: 0o600 }); return true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (watcherAlive(dir)) return false; // still owned — the second watcher exits at once
    try { unlinkSync(file); } catch { return false; } // someone else reclaimed it first
  }
  return false;
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
  a.leasedBy?.pending ? `reserved for ${a.leasedBy.name}` :
    a.leasedBy?.name ? `used by ${a.leasedBy.name}` :
      a.needsSignIn ? 'needs sign-in' :
        Number(a.limitedUntil) > now ? `limited until ${shortTime(a.limitedUntil)}` : 'free';
export const accountRow = (a, now) => ({ label: a.label, email: a.email ?? '', state: accountState(a, now), lastUsed: a.lastUsed ? shortTime(a.lastUsed) : 'never' });
