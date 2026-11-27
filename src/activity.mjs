// Live activity of cloud agents, read from local files only: one view for the dashboard feed, `cloudy-cloud watch`,
// `cloudy-cloud statusline` and the cloud_agent_activity MCP tool.
//   Workers:      the event log (events.mjs); each "progress" event is one step ("Edit src/parser.ts", "thinking").
//   Coordinators: Claude Code's session transcript on the coordinator machine, polled by createCoordinatorPoller() while
//                 the dashboard or `watch` runs, converted with the stream normaliser, redacted, and cached under
//                 ~/.config/cloudy-cloud/activity/<name>.jsonl. Lines there are { t, step } or { t, state, note? }.
// Row: { id, name, kind: worker|coordinator, state, step, t, steps: [{ t, step }], quietMin? }.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { installId, loadEnv } from './config.mjs';
import { eventsFile, foldAgents, readEvents, redactText } from './events.mjs';
import { paneState } from './pane-state.mjs';
import { providerFor } from './provider-lookup.mjs';
import { stepOf } from './progress.mjs';
import { normalise } from './stream.mjs';

export const activityDir = (env = process.env) => env.CLOUDY_CLOUD_ACTIVITY || join(homedir(), '.config/cloudy-cloud/activity');
export const QUIET_MS = 5 * 60_000; // a working agent with no new step for this long is flagged
const FRESH_MS = 90_000; // a coordinator's cache counts as live while its poller touched it this recently
const KEEP = 10;
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/;
const STATES = { running: 'working', idle: 'idle', queued: 'queued', starting: 'starting' };
const jsonl = (text) => text.split('\n').flatMap((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? [j] : []; } catch { return []; } });

// One short line for a normalised stream event, or undefined when it is not a step.
export function stepFor(e) {
  if (e.kind === 'tool_use') {
    let input = {};
    try { input = JSON.parse(e.input); } catch { /* a truncated input still names the tool */ }
    return stepOf({ name: e.name, input });
  }
  if (e.kind === 'thinking') return 'thinking';
  if (e.kind === 'text') return 'writing a reply';
  if (e.kind === 'retry') return 'retrying after a provider error';
  if (e.kind === 'error') return String(e.message ?? 'error');
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

// Rows for the coordinators whose poller touched the cache recently.
export function coordinatorRows(dir, now = Date.now()) {
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return names.flatMap((f) => {
    try {
      const file = join(dir, f), name = f.slice(0, -6);
      const mtime = statSync(file).mtimeMs;
      if (!NAME_OK.test(name) || now - mtime > FRESH_MS) return [];
      const lines = jsonl(readFileSync(file, 'utf8')), steps = lines.filter((l) => l.step).slice(-KEEP).map((l) => ({ t: l.t, step: l.step }));
      const st = lines.findLast((l) => l.state), last = steps.at(-1), signal = st && !['working', 'idle'].includes(st.state);
      return [withQuiet({ id: name, name, kind: 'coordinator', state: st?.state ?? 'working', step: signal ? (st.note || st.state) : (last?.step ?? ''), t: Math.max(last?.t ?? 0, signal ? st.t : 0) || st?.t || mtime, steps }, now)];
    } catch { return []; }
  });
}

// All rows. `events` may be passed in; otherwise the event log is read (a bounded tail with `maxBytes`, for speed).
export function readActivity({ env = process.env, events, now = Date.now(), alive, maxBytes, dir = activityDir(env) } = {}) {
  let ev = events;
  try { ev ??= readEvents(eventsFile(env), maxBytes ? { maxBytes } : undefined); } catch { ev = []; }
  return [...workerRows(ev, { alive, now }), ...coordinatorRows(dir, now)];
}

// What a coordinator's tmux screen says, as { state, note? }. Claude Code prints "esc to interrupt" while it works.
export function coordinatorState(pane, scrub = (s) => s) {
  const p = paneState(scrub(pane));
  if (p.blocked) return { state: 'blocked', note: p.blocked };
  if (p.signin) return { state: 'waiting for sign-in' };
  if (p.waiting) return { state: 'waiting on a prompt', note: p.waiting };
  return { state: /esc to interrupt/i.test(pane) ? 'working' : 'idle' };
}

// Polls the running coordinators of THIS installation (install label, as coordinator.mjs checks) and caches their steps.
// Reads the transcript through the provider's file API and keeps the byte offset, so only new lines are converted.
// ponytail: files.read returns the whole transcript each poll; a range read is the upgrade if transcripts get huge.
export function createCoordinatorPoller({ provider, env = process.env, scrub = (s) => s, dir = activityDir(env), now = Date.now }) {
  const sbxs = new Map(), seen = new Map(); // machine id -> sandbox; name -> { path, off, state }
  const clean = (s) => redactText(scrub(String(s)));
  async function one(m, name) {
    const key = `${m.provider ?? ''}/${m.id}`;
    let sbx = sbxs.get(key);
    if (!sbx) sbxs.set(key, sbx = await providerFor(provider, m).connect(m.id));
    try {
      const run = async (cmd) => (await sbx.commands.run(cmd, { timeoutMs: 15_000 })).stdout ?? '';
      const path = (await run('ls -t "$HOME"/.claude/projects/*-repo/*.jsonl 2>/dev/null | head -1')).trim();
      const pane = await run('tmux capture-pane -t claude -p -J 2>/dev/null || true').catch(() => '');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${name}.jsonl`), t = now();
      let st = seen.get(name);
      if (path && /^\/[\w./-]+\.jsonl$/.test(path)) {
        const buf = Buffer.from(await sbx.files.read(path));
        const first = !st || st.path !== path || buf.length < st.off;
        if (first) st = { path, off: 0 };
        const evs = normalise(buf.subarray(st.off).toString('utf8'), { harness: 'claude', from: st.off });
        const steps = evs.flatMap((e) => { const s = stepFor(e); return s ? [{ t: e.t ?? t, step: clean(s).slice(0, 200) }] : []; });
        st.off = evs.next;
        const text = steps.slice(first ? -20 : 0).map((s) => `${JSON.stringify(s)}\n`).join('');
        if (first) writeFileSync(file, text, { mode: 0o600 }); else if (text) appendFileSync(file, text, { mode: 0o600 });
      }
      st ??= { off: 0 };
      seen.set(name, st);
      const cs = coordinatorState(pane, scrub), sig = `${cs.state}|${cs.note ?? ''}`;
      if (sig !== st.sig) { appendFileSync(file, `${JSON.stringify({ t, state: cs.state, ...(cs.note && { note: clean(cs.note) }) })}\n`, { mode: 0o600 }); st.sig = sig; }
      utimesSync(file, new Date(t), new Date(t)); // the reader counts the file as live while this is recent
    } catch (e) { sbxs.delete(key); throw e; }
  }
  return {
    async poll() {
      const { OUR_PURPOSES } = await import('./coordinator.mjs'); // loaded here: coordinator.mjs is heavy and mcp.mjs imports this file
      const mine = installId(env), rows = await provider.list({ role: 'coordinator' }, { sdk: true, onError() {} });
      const own = rows.filter((m) => OUR_PURPOSES.has(m.labels?.purpose) && m.labels?.role === 'coordinator' && m.state === 'running' && m.labels?.install === mine && NAME_OK.test(m.labels?.name ?? ''));
      await Promise.all(own.map((m) => one(m, m.labels.name).catch(() => { /* the next poll tries again */ })));
    },
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

// "☁ 3 working · boss: Bash npm test · 12s ago", '' when nothing runs.
export function statuslineText(rows, now = Date.now()) {
  if (!rows.length) return '';
  const working = rows.filter((r) => r.state === 'working');
  const pick = [...(working.length ? working : rows)].sort((a, b) => (b.t ?? 0) - (a.t ?? 0))[0];
  const quiet = rows.find((r) => r.quietMin);
  return ['☁ ' + (working.length ? `${working.length} working` : `${rows.length} idle`),
    `${cut(pick.name, 20)}: ${cut(pick.step || pick.state, 40)}`, ago(now - pick.t), ...(quiet ? [`quiet ${quiet.quietMin}m: ${cut(quiet.name, 20)}`] : [])].join(' · ');
}

export async function statuslineMain(_argv, { out = (s) => process.stdout.write(s), env = process.env, now = Date.now } = {}) {
  out(`${statuslineText(readActivity({ env, now: now(), maxBytes: 2 * 1024 * 1024 }), now())}\n`);
}

// Text for the MCP tool: one block per agent with its last steps.
export function activityText(rows, now = Date.now()) {
  if (!rows.length) return 'No running cloud agents.';
  return rows.map((r) => [`${r.name} (${r.id}, ${r.kind}) ${r.state}${r.quietMin ? `, quiet for ${r.quietMin} min` : ''}`,
    ...(r.steps.length ? r.steps.map((s) => `  ${new Date(s.t).toTimeString().slice(0, 8)} ${s.step}`) : ['  no steps yet'])].join('\n')).join('\n');
}

// Follow loop of `watch`: prints each new step once. `read()` gives rows; stops when `signal` aborts.
export async function follow({ read, out, json = false, filter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal, intervalMs = 2000, now = Date.now }) {
  const lastT = new Map(), lastState = new Map(), warned = new Set();
  const emit = (r, t, text, state = r.state) => out(json ? `${JSON.stringify({ id: r.id, name: r.name, kind: r.kind, t, state, step: text })}\n`
    : `${new Date(t).toTimeString().slice(0, 8)} ${r.name} (${r.id.slice(0, 8)}) ${text}\n`);
  let first = true;
  while (!signal?.aborted) {
    for (const r of read().filter((x) => !filter || x.id === filter || x.name === filter || x.id.startsWith(filter))) {
      const prev = lastT.get(r.id);
      const fresh = r.steps.filter((s) => prev === undefined ? s === r.steps.at(-1) : s.t > prev); // first sight: only the current step
      for (const s of fresh) emit(r, s.t, s.step);
      if (r.steps.length) lastT.set(r.id, r.steps.at(-1).t); else if (prev === undefined) lastT.set(r.id, 0);
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
  const stop = () => ac.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let timer;
  try {
    const provider = await (getProvider ?? (async () => (await import('./providers/index.mjs')).loadProvider(env)))().catch(() => undefined);
    if (provider) { // coordinators need the provider; without one, only workers are followed
      const poller = createCoordinatorPoller({ provider, env, now, scrub: deps.scrub ?? await scrubberFor(provider, env) });
      const tick = () => poller.poll().catch(() => {});
      tick(); timer = setInterval(tick, 10_000);
    }
    await follow({ read: () => readActivity({ env, now: now() }), out, json, filter: rest[0], sleep, signal: ac.signal, intervalMs, now });
  } finally { clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'statusline') await statuslineMain(args);
  else process.exitCode = await watchMain(args);
}
