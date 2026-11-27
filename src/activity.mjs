// Live activity of cloud agents, read from local files only: one view for the dashboard feed, `cloudy-cloud watch`,
// `cloudy-cloud statusline` and the cloud_agent_activity MCP tool.
//   Workers:      the event log (events.mjs); each "progress" event is one step ("Edit src/parser.ts", "thinking").
//   Coordinators: Claude Code's session transcript on the coordinator machine, polled by createCoordinatorPoller() while
//                 the dashboard or `watch` runs. Only a short summary per tool call is kept (see stepFor), scrubbed first.
//                 One snapshot file per installation + provider + machine id: <activityDir>/<hash>.json, holding the last
//                 50 steps, the pane state and the transcript cursor. One process polls a machine at a time (a lock file).
// Row: { id, name, kind: worker|coordinator, state, step, t, steps: [{ t, step }], quietMin? }.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnv, readInstallId } from './config.mjs';
import { eventsFile, foldAgents, readEvents, redactText } from './events.mjs';
import { createLimiter } from './limits.mjs';
import { paneState } from './pane-state.mjs';
import { providerFor } from './provider-lookup.mjs';
import { normalise } from './stream.mjs';
import { safeText } from './terminal.mjs';

export const activityDir = (env = process.env) => env.CLOUDY_CLOUD_ACTIVITY || join(homedir(), '.config/cloudy-cloud/activity');
export const QUIET_MS = 5 * 60_000; // a working agent with no new step for this long is flagged
const FRESH_MS = 90_000; // a coordinator's snapshot counts as live while a poller wrote it this recently
const KEEP = 50;
const TAIL_BYTES = 256 * 1024; // first read of a transcript: only its last 256 KiB
const CHUNK_BYTES = 1024 * 1024; // later reads: at most 1 MiB past the saved offset
const LOCK_MS = 90_000;
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/;
const STATES = { running: 'working', idle: 'idle', queued: 'queued', starting: 'starting' };
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const tidy = (s, n = 200) => safeText(s).replace(/\s+/g, ' ').trim().slice(0, n); // one line of plain text

// One short line for a normalised stream event, or undefined when it is not a step. Only an allowlisted summary is kept:
// the tool name, the file path of a file tool, the program name of a Bash command. `clean` removes secrets and runs
// BEFORE any cut, so a secret is never shortened into something the exact-value scrubber no longer recognises.
export function stepFor(e, clean = redactText) {
  const c = (s, n = 100) => tidy(clean(String(s)), n);
  if (e.kind === 'tool_use') {
    const name = /^[\w.:-]{1,64}$/.test(e.name) ? e.name : 'tool';
    let input = {};
    try { input = JSON.parse(e.input); } catch { /* a truncated input still names the tool */ }
    if (FILE_TOOLS.has(name)) { const p = input.file_path ?? input.notebook_path; return typeof p === 'string' && p ? `${name} ${c(p)}` : name; }
    if (name === 'Bash') {
      const prog = String(input.command ?? '').trim().split(/\s+/).find((w) => !/^\w+=/.test(w)); // skips `VAR=value` prefixes
      return prog && /^[\w./+-]{1,40}$/.test(prog) ? `Bash ${c(prog, 40)}` : 'Bash';
    }
    return name;
  }
  if (e.kind === 'thinking') return 'thinking';
  if (e.kind === 'text') return 'writing a reply';
  if (e.kind === 'retry') return 'retrying after a provider error';
  if (e.kind === 'error') return c(e.message ?? 'error', 200);
  if (e.kind === 'result') return e.isError ? 'turn failed' : 'turn finished';
}

const withQuiet = (row, now) => (row.state === 'working' && row.t && now - row.t >= QUIET_MS ? { ...row, quietMin: Math.floor((now - row.t) / 60_000) } : row);

// Rows for workers (and coordinators started with cloud_agent), newest first, from the event log.
export function workerRows(events, { alive, now = Date.now() } = {}) {
  return foldAgents(events, { alive, now }).filter((a) => STATES[a.status]).map((a) => {
    const steps = a.messages.filter((m) => m.kind === 'progress').slice(-KEEP).map((m) => ({ t: m.t, step: m.text }));
    const last = steps.at(-1);
    return withQuiet({ id: a.id, name: a.description || a.id, kind: a.role === 'coordinator' ? 'coordinator' : 'worker', state: STATES[a.status],
      step: last?.step ?? (a.status === 'running' ? 'thinking' : ''), t: last?.t ?? a.lastActivity, steps }, now);
  });
}

// The event log is read as a bounded tail, so a long-running worker's "agent" event can fall out of it. Its description and
// role are kept in <dir>/agents.json (only while the directory's parent exists) and put back in front of the tail.
function withAgentMeta(events, dir, now) {
  let meta = {}, next;
  try { meta = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')); } catch { /* none yet */ }
  next = Object.fromEntries(Object.entries(meta).filter(([, m]) => now - m.t < 25 * 3_600_000)); // a worker lives 24 h at most
  const have = new Set();
  for (const e of events) if (e.type === 'agent' && typeof e.id === 'string') { have.add(e.id); next[e.id] = { t: e.t, description: e.description, role: e.role, profile: e.profile }; }
  if (JSON.stringify(next) !== JSON.stringify(meta)) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch { /* exists, or the config folder does not (no migration is blocked by creating it) */ }
    try { writeFileSync(join(dir, 'agents.json'), JSON.stringify(next), { mode: 0o600 }); } catch { /* best effort */ }
  }
  const missing = [...new Set(events.filter((e) => typeof e.id === 'string' && !have.has(e.id) && next[e.id]).map((e) => e.id))];
  return missing.length ? [...missing.map((id) => ({ id, type: 'agent', ...next[id] })), ...events] : events;
}

// Rows for the coordinators of this installation whose poller wrote a snapshot recently.
export function coordinatorRows(dir, now = Date.now(), install = '') {
  let names;
  try { names = readdirSync(dir).filter((f) => /^[0-9a-f]{24}\.json$/.test(f)); } catch { return []; }
  if (!install) return [];
  return names.flatMap((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j?.v !== 1 || j.install !== install || !(now - j.t <= FRESH_MS) || typeof j.machine !== 'string') return [];
      const steps = (Array.isArray(j.steps) ? j.steps : []).slice(-KEEP).map((s) => ({ n: s.n, t: s.t, step: String(s.step) }));
      const st = j.state ?? { state: 'working', t: j.t }, last = steps.at(-1), signal = !['working', 'idle'].includes(st.state);
      return [withQuiet({ id: j.machine, name: tidy(j.name ?? j.machine, 64), kind: 'coordinator', state: String(st.state), step: signal ? tidy(st.note || st.state) : (last?.step ?? ''),
        t: Math.max(last?.t ?? 0, signal ? st.t : 0) || st.t || j.t, steps }, now)];
    } catch { return []; }
  });
}

// All rows. `events` may be passed in; otherwise the event log is read (a bounded tail with `maxBytes`, for speed).
export function readActivity({ env = process.env, events, now = Date.now(), alive, maxBytes, dir = activityDir(env) } = {}) {
  let ev = events;
  try { ev ??= readEvents(eventsFile(env), maxBytes ? { maxBytes } : undefined); } catch { ev = []; }
  return [...workerRows(withAgentMeta(ev, dir, now), { alive, now }), ...coordinatorRows(dir, now, readInstallId(env))];
}

// What a coordinator's tmux screen says, as { state, note? }. Claude Code prints "esc to interrupt" while it works.
export function coordinatorState(pane, scrub = (s) => s) {
  const p = paneState(scrub(pane));
  if (p.blocked) return { state: 'blocked', note: p.blocked };
  if (p.signin) return { state: 'waiting for sign-in' };
  if (p.waiting) return { state: 'waiting on a prompt', note: p.waiting };
  return { state: /esc to interrupt/i.test(pane) ? 'working' : 'idle' };
}

// The transcript of the Claude session running in the `claude` tmux pane: the session file whose pid is the pane's process or one
// of its descendants, then ~/.claude/projects/*/<session id>.jsonl. '' when it cannot be told (never "the newest file").
const SESSION_CMD = `p=$(tmux display-message -p -t claude '#{pane_pid}' 2>/dev/null); echo "PANE \${p:-0}"; ps -e -o pid=,ppid= 2>/dev/null; echo SESSIONS; for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] && { head -c 4096 "$f" | tr -d '\n'; echo; }; done; true`;
export function sessionIdFrom(out) {
  const lines = out.split('\n'), i = lines.indexOf('SESSIONS');
  const root = Number(/^PANE (\d+)/.exec(lines[0] ?? '')?.[1]);
  if (!root || i < 0) return '';
  const parent = new Map(lines.slice(1, i).flatMap((l) => { const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(l); return m ? [[Number(m[1]), Number(m[2])]] : []; }));
  const inPane = (pid) => { for (let n = 0; pid && n < 64; n++, pid = parent.get(pid)) if (pid === root) return true; return false; };
  const found = lines.slice(i + 1).flatMap((l) => { try { const j = JSON.parse(l); return /^[0-9a-f-]{36}$/.test(j.sessionId) && inPane(Number(j.pid)) ? [j] : []; } catch { return []; } });
  return found.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))[0]?.sessionId ?? '';
}
// First line "SIZE START", then the base64 of at most CHUNK_BYTES from START (nothing when the file did not grow).
const readCmd = (path, off) => `f='${path}'; n=$(wc -c < "$f" 2>/dev/null || echo 0); o=${off ?? '-'}; [ "$o" = - ] && o=$((n > ${TAIL_BYTES} ? n - ${TAIL_BYTES} : 0)); echo "$n $o"; [ "$n" -gt "$o" ] && tail -c +$((o + 1)) "$f" | head -c ${CHUNK_BYTES} | base64 | tr -d '\n'; echo; true`;

const readSnap = (file, id) => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return j?.v === 1 && j.install === id.install && j.provider === id.provider && j.machine === id.machine ? j : null; } catch { return null; } };
function writeSnap(file, snap) { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 }); renameSync(tmp, file); }
// One writer per machine: an exclusive lock file, taken over when older than LOCK_MS (its owner died). Returns release() or null.
function lock(file) {
  const l = `${file}.lock`;
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(l, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => { try { unlinkSync(l); } catch { /* gone */ } }; } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try { if (Date.now() - statSync(l).mtimeMs <= LOCK_MS) return null; unlinkSync(l); } catch { /* raced with its owner */ }
    }
  }
  return null;
}

// Polls the running coordinators of THIS installation (install label) and writes their snapshots. poll() runs one at a time (a call
// during a poll joins it), at most `concurrency` machines are read at once, and stop() cancels what is outstanding.
export function createCoordinatorPoller({ provider, env = process.env, scrub = (s) => s, dir = activityDir(env), now = Date.now, concurrency = 3 }) {
  const sbxs = new Map(), ac = new AbortController(), limiter = createLimiter(concurrency);
  const stopped = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true }));
  stopped.catch(() => {});
  const guard = (p) => Promise.race([p, stopped]);
  const clean = (s) => redactText(scrub(String(s)));
  async function one(m, install) {
    const id = { install, provider: m.provider ?? provider.name ?? '', machine: m.id };
    const file = join(dir, `${createHash('sha256').update(Object.values(id).join('\0')).digest('hex').slice(0, 24)}.json`);
    const release = lock(file);
    if (!release) return; // another process is polling this machine and updates the same snapshot
    const key = `${id.provider}/${m.id}`;
    try {
      let sbx = sbxs.get(key);
      if (!sbx) sbxs.set(key, sbx = await guard(providerFor(provider, m).connect(m.id)));
      const run = async (cmd) => (await guard(sbx.commands.run(cmd, { timeoutMs: 15_000, signal: ac.signal }))).stdout ?? '';
      const t = now(), snap = readSnap(file, id) ?? { v: 1, ...id, steps: [], seq: 0 };
      snap.name = tidy(m.labels.name, 64);
      if (!snap.path || t - (snap.resolvedAt ?? 0) > 60_000) {
        const sid = sessionIdFrom(await run(SESSION_CMD));
        const path = sid ? (await run(`ls "$HOME"/.claude/projects/*/${sid}.jsonl 2>/dev/null | head -1`)).trim() : '';
        snap.resolvedAt = t;
        const next = /^\/[\w./-]+\.jsonl$/.test(path) ? path : '';
        if (next !== snap.path) { snap.path = next; delete snap.off; }
      }
      if (snap.path) {
        const out = await run(readCmd(snap.path, snap.off)), nl = out.indexOf('\n');
        const [size, start] = out.slice(0, nl < 0 ? 0 : nl).trim().split(/\s+/).map(Number);
        if (Number.isFinite(size) && Number.isFinite(start)) {
          if (snap.off !== undefined && size < snap.off) delete snap.off; // the file was replaced: start again from its tail
          else if (size > start) {
            let buf = Buffer.from(out.slice(nl + 1).trim(), 'base64'), from = start;
            if (snap.off === undefined && start > 0) { const cut = buf.indexOf(10) < 0 ? buf.length : buf.indexOf(10) + 1; from += cut; buf = buf.subarray(cut); } // the first line of a tail is cut off
            const evs = normalise(buf.toString('utf8'), { harness: 'claude', from });
            for (const e of evs) { const step = stepFor(e, clean); if (step) snap.steps.push({ n: ++snap.seq, t: e.t ?? t, step }); }
            snap.steps = snap.steps.slice(-KEEP);
            snap.off = evs.next > from || buf.length < CHUNK_BYTES ? evs.next : from + buf.length; // a single line over 1 MiB is skipped
          } else snap.off ??= start;
        }
      }
      const cs = coordinatorState(await run('tmux capture-pane -t claude -p -J 2>/dev/null || true').catch((e) => { if (ac.signal.aborted) throw e; return ''; }), scrub), sig = `${cs.state}|${cs.note ?? ''}`;
      if (sig !== snap.sig) { snap.state = { t, state: cs.state, ...(cs.note && { note: tidy(clean(cs.note)) }) }; snap.sig = sig; }
      snap.t = t;
      writeSnap(file, snap);
    } catch (e) { sbxs.delete(key); throw e; } finally { release(); }
  }
  async function pollOnce() {
    const install = readInstallId(env);
    if (!install || ac.signal.aborted) return;
    const { OUR_PURPOSES } = await import('./coordinator.mjs'); // loaded here: coordinator.mjs is heavy and mcp.mjs imports this file
    const rows = await guard(provider.list({ role: 'coordinator' }, { sdk: true, onError() {} }));
    const own = rows.filter((m) => OUR_PURPOSES.has(m.labels?.purpose) && m.labels?.role === 'coordinator' && m.state === 'running' && m.labels?.install === install && NAME_OK.test(m.labels?.name ?? ''));
    if (!own.length) return;
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') return; } // not recursive: the config folder is never created here, so config migration is not blocked
    await Promise.all(own.map((m) => limiter.run(() => (ac.signal.aborted ? undefined : one(m, install).catch(() => { /* the next poll tries again */ })))));
  }
  let inflight;
  return {
    poll: () => (inflight ??= pollOnce().finally(() => { inflight = undefined; })),
    stop: () => ac.abort(),
  };
}

// Removes the exact secret values of the configured providers (and consented MCP tokens) from a string.
export async function scrubberFor(provider, env) {
  const [{ secretValues }, { consentedLiterals }] = await Promise.all([import('./run-subagent.mjs'), import('./mcpsync.mjs')]);
  return (s) => [...new Set((provider.providers ?? [provider]).flatMap((p) => secretValues(env, p.keyName, consentedLiterals(env))))].reduce((t, v) => t.split(v).join('[redacted]'), s);
}

// ---- output ----

export const ago = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// "☁ 2 working, 1 idle · boss: Bash npm · 12s ago", '' when nothing runs. A single agent shows its real state ("blocked").
export function statuslineText(rows, now = Date.now()) {
  if (!rows.length) return '';
  const counts = new Map();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const states = [...counts].sort(([x], [y]) => (y === 'working') - (x === 'working')).map(([k, n]) => `${n} ${tidy(k, 30)}`).join(', ');
  const working = rows.filter((r) => r.state === 'working');
  const pick = [...(working.length ? working : rows)].sort((a, b) => (b.t ?? 0) - (a.t ?? 0))[0];
  const quiet = rows.find((r) => r.quietMin);
  return ['☁ ' + states, `${cut(tidy(pick.name), 20)}: ${cut(tidy(pick.step || pick.state), 40)}`, ago(now - pick.t), ...(quiet ? [`quiet ${quiet.quietMin}m: ${cut(tidy(quiet.name), 20)}`] : [])].join(' · ');
}

export async function statuslineMain(_argv, { out = (s) => process.stdout.write(s), env = process.env, now = Date.now } = {}) {
  out(`${statuslineText(readActivity({ env, now: now(), maxBytes: 2 * 1024 * 1024 }), now())}\n`);
}

// Text for the MCP tool: one block per agent with its last steps.
export function activityText(rows, now = Date.now()) {
  if (!rows.length) return 'No running cloud agents.';
  return rows.map((r) => [`${r.name} (${r.id}, ${r.kind}) ${r.state}${r.quietMin ? `, quiet for ${r.quietMin} min` : ''}`,
    ...(r.steps.length ? r.steps.slice(-10).map((s) => `  ${new Date(s.t).toTimeString().slice(0, 8)} ${s.step}`) : ['  no steps yet'])].join('\n')).join('\n');
}

// Follow loop of `watch`: prints each new step once. `read()` gives rows; stops when `signal` aborts. A step is identified by its
// sequence number (coordinators) and time and text, kept per agent, so a burst of steps or two steps in the same millisecond are not lost.
// An agent seen for the first time prints its current step, or its state when it has no step yet.
export async function follow({ read, out, json = false, filter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal, intervalMs = 2000, now = Date.now }) {
  const seen = new Map(), lastState = new Map(), warned = new Set();
  const emit = (r, t, text, state = r.state) => out(json ? `${JSON.stringify({ id: r.id, name: r.name, kind: r.kind, t, state, step: text })}\n`
    : `${new Date(t).toTimeString().slice(0, 8)} ${tidy(r.name, 64)} (${tidy(r.id, 64).slice(0, 8)}) ${tidy(text)}\n`);
  let first = true;
  while (!signal?.aborted) {
    for (const r of read().filter((x) => !filter || x.id === filter || x.name === filter || x.id.startsWith(filter))) {
      const keys = r.steps.map((s) => `${s.n ?? ''}|${s.t}|${s.step}`), known = seen.get(r.id);
      if (!known) { if (r.steps.length) emit(r, r.steps.at(-1).t, r.steps.at(-1).step); else emit(r, r.t ?? now(), r.step || `state: ${r.state}`); }
      else r.steps.forEach((s, i) => { if (!known.has(keys[i])) emit(r, s.t, s.step); });
      seen.set(r.id, new Set([...(known ?? []), ...keys].slice(-300)));
      if (!first && lastState.has(r.id) && lastState.get(r.id) !== r.state) emit(r, now(), `state: ${r.state}`);
      lastState.set(r.id, r.state);
      if (r.quietMin && !warned.has(r.id)) { warned.add(r.id); emit(r, now(), `quiet for ${r.quietMin} min`); } else if (!r.quietMin) warned.delete(r.id);
    }
    first = false;
    await sleep(intervalMs);
  }
}

// `cloudy-cloud watch [NAME|ID] [--json]`
export async function watchMain(argv, deps = {}) {
  const { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), env = loadEnv(), now = Date.now, sleep, intervalMs, getProvider } = deps;
  const json = argv.includes('--json'), rest = argv.filter((a) => a !== '--json');
  if (rest.some((a) => a.startsWith('-')) || rest.length > 1) { err('Usage: cloudy-cloud watch [NAME|ID] [--json]\n'); return 2; }
  const ac = new AbortController();
  let timer, poller;
  const stop = () => { ac.abort(); poller?.stop(); clearInterval(timer); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const provider = await (getProvider ?? (async () => (await import('./providers/index.mjs')).loadProvider(env)))().catch(() => undefined);
    if (provider) { // coordinators need the provider; without one, only workers are followed
      poller = createCoordinatorPoller({ provider, env, now, scrub: deps.scrub ?? await scrubberFor(provider, env) });
      const tick = () => poller.poll().catch(() => {});
      tick(); timer = setInterval(tick, 10_000);
    }
    await follow({ read: () => readActivity({ env, now: now() }), out, json, filter: rest[0], sleep, signal: ac.signal, intervalMs, now });
  } finally { clearInterval(timer); poller?.stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'statusline') await statuslineMain(args);
  else process.exitCode = await watchMain(args);
}
