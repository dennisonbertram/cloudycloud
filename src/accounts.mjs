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
import { randomUUID } from 'node:crypto';
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

// Cross-process mutual exclusion for every read-modify-write of the index, re-entrant within this
// process. The lock is a Lamport bakery over claim files in <dir>/index.lock.d/: each contender
// writes only its own uniquely-named claim (pid + start token + uuid + ticket + choosing flag),
// published through a temp file and rename, and deletes only its own file on release. A contender
// enters when no live claim is still choosing and none outranks its (ticket, pid) pair — tickets
// are assigned one past the largest assigned one seen, so a claim created later can never slip in
// below the holder's. The only claims ever unlinked are the holder's own or ones whose recorded
// owner is provably dead — a dead pid, or a reused pid (the stored start token no longer matches
// the live one) — so reclamation can never remove a live holder's file, whatever the interleaving.
const LOCK_DIR = 'index.lock.d';
const LOCK_WAIT_MS = 15_000;
const held = new Map(); // dir → re-entry depth
const normTok = (s) => String(s ?? '').trim().split(/\s+/).join(' ');
const CLAIM_RE = /^claim-\d+-[0-9a-f-]{36}$/;
// A claim file line is `pid uuid ticket choosing <lstart…>`. A file that vanished or fails to parse
// is not a claim.
const readClaim = (path) => {
  try {
    const [pid, uuid, ticket, choosing, ...tok] = readFileSync(path, 'utf8').trim().split(/\s+/);
    const p = Number(pid);
    return Number.isInteger(p) && p > 0 ? { pid: p, uuid, ticket: Number(ticket) || 0, choosing: choosing === '1', token: tok.join(' '), path } : null;
  } catch { return null; }
};
// The recorded owner is dead when the pid is dead, or the pid was reused — the live start token no
// longer matches the stored one. An unreadable token falls back to the pid check alone, like the
// watcher file's.
const claimDead = (c) => {
  if (!c || !pidAlive(c.pid)) return true;
  const live = watcherToken(c.pid);
  return Boolean(c.token && live && c.token !== normTok(live));
};
export const withLock = (dir, fn) => {
  const depth = held.get(dir) ?? 0;
  if (depth > 0) { held.set(dir, depth + 1); try { return fn(); } finally { held.set(dir, depth); } }
  ensureDir(dir);
  const lockDir = join(dir, LOCK_DIR);
  ensureDir(lockDir);
  const uuid = randomUUID();
  const mine = join(lockDir, `claim-${process.pid}-${uuid}`);
  const write = (ticket, choosing) => {
    const tmp = `${mine}.tmp`;
    writeFileSync(tmp, `${process.pid} ${uuid} ${ticket} ${choosing ? 1 : 0} ${normTok(watcherToken(process.pid))}`, { mode: 0o600 });
    renameSync(tmp, mine); // readers only ever see a whole claim
  };
  // Every claim whose recorded owner is still alive; provably-dead claims are swept — deleting one
  // can never remove a live holder's file, which always names a live pid and its start token.
  const liveClaims = () => {
    const live = [];
    for (const f of readdir(lockDir)) {
      if (!CLAIM_RE.test(f)) continue;
      const c = readClaim(join(lockDir, f));
      if (!c) continue;
      if (claimDead(c)) { try { unlinkSync(c.path); } catch { /* another sweeper got there first */ } continue; }
      live.push(c);
    }
    return live;
  };
  try {
    write(0, 1); // choosing: visible before a ticket is assigned
    // A later claim always sees our assigned ticket and picks a larger one — a contender whose claim
    // appears between our two writes orders behind us or ties on ticket, where the pid decides.
    const ticket = Math.max(0, ...liveClaims().filter((c) => !c.choosing && c.uuid !== uuid).map((c) => c.ticket)) + 1;
    write(ticket, 0);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const ahead = liveClaims().some((c) => c.uuid !== uuid && (c.choosing || c.ticket < ticket || (c.ticket === ticket && c.pid < process.pid)));
      if (!ahead) break;
      if (Date.now() > deadline) throw Object.assign(new Error('Timed out waiting for the accounts lock.'), { code: 'accounts_locked', local: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    held.set(dir, 1);
    try { return fn(); } finally { held.delete(dir); }
  } finally {
    try { unlinkSync(mine); } catch { /* release already removed it */ }
    try { unlinkSync(`${mine}.tmp`); } catch { /* none */ }
  }
};

// The index maps label → { email, accountUuid, leasedBy: {name, machineId, provider, deleteAt,
// pending}, leasedAt, lastUsed, limitedUntil, needsSignIn, verifiedAt } — all timestamps in ms. It
// never holds a token. `verifiedAt` is set when the saved credential was written by a finished
// sign-in or proved current by a sync while its machine was alive; a lease handoff clears it, so a
// credential that was only ever delivered — never verified — is marked needsSignIn if that machine
// later goes away. A damaged index is never an empty pool: refusing is safer than treating leased accounts as
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
// The ONLY key we save or deliver is claudeAiOauth: a credentials file can also carry MCP OAuth
// entries and other secrets that must never be copied between machines. Everything else is stripped
// — including from files an earlier version of this branch already saved verbatim.
const oauthOnly = (text) => {
  const oauth = credJson(text);
  return oauth ? JSON.stringify({ claudeAiOauth: oauth }) : '';
};
export const readCredential = (dir, label) => { try { return oauthOnly(readFileSync(credFile(dir, label), 'utf8')); } catch { return ''; } };
export const saveCredential = (dir, label, text) => atomicWrite(credFile(dir, label), text);
// The credential from a finished sign-in: overwrites the label's saved file and clears a stale
// sign-in mark (a fresh sign-in is exactly what clears it). The lease it sits under is kept. The
// index row (its owner identity) is written BEFORE the credential file lands, so a crash mid-save
// can never leave a selectable credential with no owner. Both are one locked step so a concurrent
// sync cannot slide between them.
export const saveAccount = (dir, label, { email, accountUuid, credText, now = 0 }) => withLock(dir, () => {
  const e = updateAccount(dir, label, (x) => ({ ...x, email: email ?? x.email, accountUuid: accountUuid ?? x.accountUuid, lastUsed: now, needsSignIn: undefined, verifiedAt: now }));
  saveCredential(dir, label, oauthOnly(credText));
  return e;
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
// Index entries plus credential files dropped in by hand — but a <label>.json with no index row has
// no verified owner, so it is listed as needing attention (`indexed: false`) and is never picked.
// Reserved and malformed labels are never listed.
export const listAccounts = (dir) => {
  const idx = readIndex(dir);
  const labels = new Set(Object.keys(idx).filter(validLabel));
  for (const f of readdir(dir)) if (f.endsWith('.json') && f !== 'index.json' && validLabel(f.slice(0, -5))) labels.add(f.slice(0, -5));
  return [...labels].sort().map((label) => ({ label, ...(isObj(idx[label]) ? idx[label] : {}), indexed: isObj(idx[label]), saved: existsSync(credFile(dir, label)) }));
};
// Pickable accounts: indexed, saved credential present, not leased, not limited, sign-in not stale —
// least recently used first, so several accounts rotate instead of wearing out one.
export const freeAccounts = (dir, now) => listAccounts(dir)
  .filter((a) => a.indexed && a.saved && !a.leasedBy?.name && !a.needsSignIn && !(Number(a.limitedUntil) > now))
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
export const release = (dir, label, { machineId, pending, resId } = {}) => {
  let did = false;
  updateAccount(dir, label, (e) => {
    if (machineId !== undefined && e.leasedBy?.machineId !== machineId) return e;
    if (pending !== undefined && (Boolean(e.leasedBy?.pending) !== pending || (pending && e.leasedBy?.machineId))) return e;
    // A reservation is identified by its resId: expiry touches only a still-unbound reservation with
    // exactly that id — a lease that bound (or was re-reserved) while the listing was in flight is kept.
    if (resId !== undefined && (e.leasedBy?.resId !== resId || e.leasedBy?.machineId)) return e;
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
    // A lease handoff to a fresh machine clears the credential's verification — it was verified on
    // the previous machine, not on this one.
    return { ...e, leasedBy: { ...e.leasedBy, ...leasedBy }, leasedAt: now, verifiedAt: undefined }; // keeps the reservation's resId for expiry checks
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
// `accounts rm` file removal: the credential file plus leftover temp files of its writes — the
// exact `<label>.json.tmp-<pid>` format atomicWrite uses, so a sibling label that shares the prefix
// is never swept up. Only ENOENT is ignored — every other failure is reported so nothing is
// silently left behind.
export const removeAccountFiles = (dir, label) => {
  const failed = [];
  const rm = (p) => { try { unlinkSync(p); return true; } catch (e) { if (e.code !== 'ENOENT') failed.push(`${p} (${e.code ?? e.message})`); return e.code === 'ENOENT'; } };
  const gone = rm(credFile(dir, label));
  const tmpRe = new RegExp(`^${label.replace(/[.^$]/g, '\\$&')}\\.json\\.tmp-\\d+$`);
  for (const f of readdir(dir)) if (tmpRe.test(f)) rm(join(dir, f));
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

// `claude auth status` answers over its exit code: 0 carries the JSON on stdout, 1 is the CLI's
// definite signed-out answer — the JSON is still on stdout, on the error object. Only a
// transport-level failure (no exit code at all) is inconclusive and returns null.
export const AUTH_STATUS = 'env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY claude auth status --json';
const parseAuthStatus = (text) => {
  try { const s = String(text ?? ''); const i = s.indexOf('{'); if (i < 0) return null; const j = JSON.parse(s.slice(i)); return isObj(j) ? j : null; }
  catch { return null; }
};
export const authStatus = async (sbx) => {
  try { return parseAuthStatus((await sbx.commands.run(AUTH_STATUS, { timeoutMs: 60_000 })).stdout); }
  catch (e) { if (typeof e?.exitCode === 'number') return parseAuthStatus(e.stdout); return null; }
};

// The credential path on the machine follows launch.sh exactly: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}.
const CRED_DIR_CMD = 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
export const credDir = async (sbx) => (await sbx.commands.run(CRED_DIR_CMD, { timeoutMs: 15_000 })).stdout.trim();
// The machine's saved sign-in, when the file parses and still carries a refresh token. reads go
// through files.readSecret where the adapter provides one — it fails closed when the only route
// left would put the credential in command stdout (Instabox's base64 exec fallback). Only the
// claudeAiOauth object leaves the machine — MCP OAuth entries and other keys in the file stay.
export const readMachineCredential = async (sbx) => {
  const read = sbx?.files?.readSecret ?? sbx?.files?.read;
  if (typeof read !== 'function') return null;
  const dir = await credDir(sbx);
  if (!dir) return null;
  const raw = await read.call(sbx.files, `${dir}/.credentials.json`);
  const text = typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '';
  const oauth = credJson(text);
  return oauth?.refreshToken ? { text: JSON.stringify({ claudeAiOauth: oauth }), oauth } : null;
};
// Deliver a saved account's credential before the tmux session starts. Only our claudeAiOauth is
// delivered — merged over the machine's existing file so MCP OAuth entries and other keys already
// there are kept. The body is staged inside the mode-700 config dir on an empty 600 file (the same
// pattern env.local uses), then moved into place by one same-filesystem mv — the credentials path is
// never a partial write, and the upload never travels a command string. The .credentials-removed
// marker goes in first so launch.sh's one-time image-credential removal can never delete what was
// just delivered.
export const deliverCredential = async (sbx, confDir, credText) => {
  const dir = await credDir(sbx);
  if (!dir) throw new Error('Could not read the Claude config dir on the machine.');
  const oauth = credJson(credText);
  if (!oauth?.refreshToken) throw Object.assign(new Error('The saved credential is not a usable Claude sign-in.'), { code: 'account_cred_unusable', local: true });
  const creds = `${dir}/.credentials.json`;
  const staged = `${confDir}/credentials.new`;
  let existing = {};
  try {
    const read = sbx?.files?.readSecret ?? sbx?.files?.read;
    if (typeof read === 'function') {
      const raw = await read.call(sbx.files, creds);
      const j = JSON.parse(typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '');
      if (isObj(j)) existing = j;
    }
  } catch { /* no existing file, or unreadable: ours alone is delivered */ }
  const body = JSON.stringify({ ...existing, claudeAiOauth: oauth });
  await sbx.commands.run(`umask 077 && mkdir -p "${confDir}" && chmod 700 "${confDir}" && : > "${staged}" && touch "${confDir}/.credentials-removed"`);
  await writeSecretFile(sbx, staged, body);
  await sbx.commands.run(`chmod 600 "${staged}" && mkdir -p "${dir}" && mv -f "${staged}" "${creds}"`);
};
// Copy the machine's credential back to the laptop — only when it parses, carries a refresh token,
// and is newer by expiresAt than the saved one. Returns 'synced', 'current' (the saved copy proved
// at least as new), 'moved' (the label was removed, its lease moved, or the machine's Claude
// identity no longer matches — nothing is written) or 'failed' (no usable machine credential): the
// caller needs the difference — releasing a lease after an unverified read makes a possibly-spent
// token the only copy, so it is marked needsSignIn instead. The machine read happens outside the
// lock (it is slow); under the lock the entry is re-verified: it must still exist (a removed
// account is never recreated), still hold the lease the caller synced for (`lease`), and still be
// the same Claude identity when auth status carries one. The freshness compare and the write are
// the same locked step.
export const syncBack = async (dir, sbx, label, now, lease = null) => {
  const [got, j] = await Promise.all([readMachineCredential(sbx).catch(() => null), authStatus(sbx).catch(() => null)]);
  if (!got) return 'failed';
  return withLock(dir, () => {
    const idx = readIndex(dir);
    const entry = idx[label];
    if (!isObj(entry)) return 'moved'; // the account was removed while the read ran — never recreate it
    if (lease && (entry.leasedBy?.machineId !== lease.machineId || (lease.provider && entry.leasedBy?.provider !== lease.provider))) return 'moved';
    if (j?.loggedIn === true && (j.accountUuid || j.email) && (entry.accountUuid || entry.email) && !sameAccount(entry, j)) return 'moved'; // the machine now holds a different Claude identity
    const saved = credJson(readCredential(dir, label));
    if (saved && !(Number(got.oauth.expiresAt) > Number(saved.expiresAt ?? 0))) {
      updateAccount(dir, label, (e) => ({ ...e, lastUsed: now, verifiedAt: now }));
      return 'current';
    }
    saveCredential(dir, label, got.text);
    updateAccount(dir, label, (e) => ({ ...e, lastUsed: now, verifiedAt: now }));
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
  // Stored and live tokens must compare in the same whitespace-normalized form — macOS ps pads
  // single-digit days with a second space, which readWatcherFile's split already collapses.
  if (token) return token === normTok(live);
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
export const releaseWatcher = (dir, pid = process.pid) => { try { const wf = readWatcherFile(dir); const live = watcherToken(pid); if (wf.pid === pid && (!wf.token || !live || wf.token === normTok(live))) unlinkSync(join(dir, WATCH_PID)); } catch { /* a newer watcher's file stays */ } };
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
  !a.indexed || !a.saved ? 'needs sign-in' :
    a.leasedBy?.pending ? `reserved for ${a.leasedBy.name}` :
      a.leasedBy?.name ? `used by ${a.leasedBy.name}` :
        a.needsSignIn ? 'needs sign-in' :
          Number(a.limitedUntil) > now ? `limited until ${shortTime(a.limitedUntil)}` : 'free';
export const accountRow = (a, now) => ({ label: a.label, email: a.email ?? '', state: accountState(a, now), lastUsed: a.lastUsed ? shortTime(a.lastUsed) : 'never' });
