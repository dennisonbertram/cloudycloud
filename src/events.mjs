// Local event log: the MCP server appends one JSON line per agent event; the dashboard reads it.
// File: ~/.config/cloudy-cloud/events.jsonl (or CLOUDY_CLOUD_EVENTS), mode 600 inside a mode 700 folder.
// Prompts and replies are stored (the dashboard shows them), so the file never leaves the machine; anything that
// looks like a key is redacted first and no key is ever passed in.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const eventsFile = (env = process.env) => env.CLOUDY_CLOUD_EVENTS || join(homedir(), '.config/cloudy-cloud/events.jsonl');

const MAX_TEXT = 20_000;
const MAX_READ = 16 * 1024 * 1024; // only the newest 16 MB are read; older history is dropped
// Known key shapes, "Authorization: Bearer ...", and NAME=value for names that end in KEY, TOKEN, SECRET or PASSWORD.
const SECRET_RES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|ibk|xox[abp])[_-][A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)["']?[^\s"']{6,}["']?/g,
];
export function redact(text) {
  let s = String(text ?? '');
  for (const re of SECRET_RES) s = s.replace(re, (m, pre) => `${typeof pre === 'string' ? pre : ''}[redacted]`);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… [truncated]` : s;
}

// Returns emit(event). Never throws: a full disk must not break an agent. `scrub` removes exact secret values too.
export function createEventLog(env, owner, { scrub = (s) => s, file = eventsFile(env), now = Date.now } = {}) {
  let ready = false;
  return (event) => {
    try {
      if (!ready) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); ready = true; }
      const e = { ...event, t: now(), owner, pid: process.pid };
      for (const k of ['text', 'prompt', 'description']) if (typeof e[k] === 'string') e[k] = redact(scrub(e[k]));
      appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    } catch { /* logging is best effort */ }
  };
}

// Parsed events, oldest first. A missing file is an empty log; damaged lines are skipped.
export function readEvents(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - MAX_READ), buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is cut off
    return lines.flatMap((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? [j] : []; } catch { return []; } });
  } finally { closeSync(fd); }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const ACTIVE = new Set(['queued', 'starting', 'running']);
const IDLE_MS = 60 * 60_000; // run-subagent.mjs stops an agent after 60 idle minutes
const DEFAULT_WORKER_MS = 6 * 60 * 60_000; // default server delete time (CLOUDY_CLOUD_WORKER_HOURS) when an old log has no deleteAt

// The push outcome run-subagent.mjs writes at the end of every reply; the last matching line wins.
// Returns { sha, branch }, { failed: true }, or undefined.
export function pushOf(text) {
  for (const line of String(text).split('\n').reverse()) {
    const m = /^Pushed to origin (\S+) at ([0-9a-f]{7,40})\./.exec(line);
    if (m) return { sha: m[2], branch: m[1] };
    if (line.startsWith('Push failed:') || line.startsWith('The sandbox could not be reached to push.')) return { failed: true };
  }
}

// Folds events into one record per agent: { id, description, status, profile, role, model, branch, machine, startedAt,
// lastActivity, deadline, stoppedAt, push: {sha, branch, t} | {failed, t} from the last reply, messages: [{t, kind: out|reply|progress, text, error?}] }.
// An agent whose server process has died while it looked active is shown as stopped (the reaper deletes its machine).
export function foldAgents(events, { alive = isAlive, now = Date.now() } = {}) {
  const agents = new Map();
  const get = (id) => { let a = agents.get(id); if (!a) agents.set(id, a = { id, status: 'starting', messages: [] }); return a; };
  for (const e of events) {
    if (typeof e.id !== 'string') continue;
    const a = get(e.id);
    a.pid = e.pid ?? a.pid;
    a.lastActivity = e.t;
    if (e.type === 'agent') {
      Object.assign(a, { description: e.description, profile: e.profile, role: e.role, model: e.model, branch: e.branch, startedAt: e.t });
      a.mcp = Array.isArray(e.mcp) ? e.mcp.filter((n) => typeof n === 'string') : undefined; // names only
    } else if (e.type === 'machine') { a.machine = e.machine; if (e.deleteAt) a.deleteAt = e.deleteAt; }
    else if (e.type === 'status') {
      a.status = e.status;
      if (e.status === 'idle') a.idleSince = e.t;
      if (e.status === 'stopped' || e.status === 'failed') a.stoppedAt = e.t;
    } else if (e.type === 'message') a.messages.push({ t: e.t, kind: 'out', text: e.text });
    else if (e.type === 'reply') { a.messages.push({ t: e.t, kind: 'reply', text: e.text, error: !!e.error }); const p = pushOf(e.text); if (p) a.push = { ...p, t: e.t }; }
    else if (e.type === 'progress') a.messages.push({ t: e.t, kind: 'progress', text: e.text });
  }
  for (const a of agents.values()) {
    if (ACTIVE.has(a.status) && a.pid && !alive(a.pid)) { a.status = 'stopped'; a.stoppedAt = a.lastActivity; a.sessionEnded = true; }
    if (a.status === 'idle') a.deadline = a.idleSince + IDLE_MS;
    else if (ACTIVE.has(a.status) && a.startedAt) a.deadline = a.deleteAt ?? a.startedAt + DEFAULT_WORKER_MS;
    a.messages = a.messages.slice(-300);
  }
  return [...agents.values()].filter((a) => a.startedAt).sort((x, y) => y.startedAt - x.startedAt);
}
