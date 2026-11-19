// `cloudy-cloud dashboard [--demo] [--port N] [--no-open] [--prune]`: a read-only web page on 127.0.0.1 that shows the cloud
// boxes (agents and coordinators) and the messages between your session and them.
// Data: the local event log (see events.mjs) plus the live machine list from the provider. Keys stay on the server side.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadEnv, ownerFile } from './config.mjs';
import { loadProvider } from './providers/index.mjs';
import { resolveMsbBin } from './providers/microsandbox.mjs';
import { eventsFile, foldAgents, readEvents, redact, redactText } from './events.mjs';
import { createMachineReader } from './machine-read.mjs';
import { paneState } from './pane-state.mjs';
import { secretValues } from './run-subagent.mjs';
import { consentedLiterals } from './mcpsync.mjs';
import { planSnapshot } from './machine.mjs';
import { demoState, demoStream } from './dashboard-demo.mjs';
import { guideObj } from './errors.mjs';
import { createLimiter } from './limits.mjs';
import { normalise, pruneStreams, streamsDir } from './stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4477;
// One async init shared by concurrent first callers; a failed init is tried again next time.
export const lazy = (f) => { let p; return () => (p ??= f().catch((e) => { p = undefined; throw e; })); };
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";
const GENERIC_FIX = 'Check CLOUDY_CLOUD_PROVIDER and your internet connection, then your provider API key in ~/.config/cloudy-cloud/env.';

// Machine label values for the page: strings only, ANSI and control characters removed, redacted, 200 characters at most.
const cleanLabel = (v) => redact(v.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '')).slice(0, 200);
const cleanLabels = (l) => Object.fromEntries(Object.entries(l ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, cleanLabel(v)]));

// Live machines the tool labelled (label purpose=cloudy-cloud). Throws with a `code` the page can explain.
export async function listMachines(env, provider) {
  provider ??= await loadProvider(env);
  // The msb "key" is its binary, also found at ~/.local/bin/msb or on PATH without the variable.
  if (!env[provider.keyName] && !(provider.name === 'microsandbox' && resolveMsbBin(env))) throw Object.assign(new Error(`${provider.keyName} is not set.`), { code: 'no_key' });
  return (await provider.list({ purpose: 'cloudy-cloud' }, { sdk: true })).map((m) => ({
    id: m.id, name: m.name, role: m.labels?.role, owner: m.labels?.owner, labels: cleanLabels(m.labels), state: m.state, status: m.status,
    startedAt: m.startedAt, archiveAt: m.archiveAt,
  }));
}

const NO_TITLE = 'no title: started before labels (#48)';
const ACTIVE = ['queued', 'starting', 'running', 'idle'];
// A fleet trunk name; the strict form is also the validation gate for the git merge check below.
const TRUNK = /\bfleet\/[A-Za-z0-9._-]{1,60}/;
const FLEET_TRUNK = /^fleet\/[A-Za-z0-9._-]{1,60}$/;

// One list of boxes: every agent from the event log, with its live machine, plus live machines no agent explains
// (coordinators, and agents from sessions that never wrote an event log). `owner` is this server's owner id.
export function buildState({ events, machines, machineError, now = Date.now(), alive, provider, owner, coordLogs = {} }) {
  const agents = foldAgents(events, { alive, now });
  const live = new Map((machines ?? []).map((m) => [m.id, m]));
  const byAgent = new Map((machines ?? []).filter((m) => m.labels?.agent).map((m) => [m.labels.agent, m]));
  const turns = new Map();
  for (const e of events) if (e.type === 'message' && typeof e.id === 'string') turns.set(e.id, (turns.get(e.id) ?? 0) + 1);
  const used = new Set();
  const boxes = agents.map((a) => {
    const m = live.get(a.machine) ?? (a.machine ? undefined : byAgent.get(a.id));
    if (m) used.add(m.id);
    // A listed machine is the truth about "running": if it is gone, an agent that looked active has ended.
    const gone = machines && a.machine && !m && ACTIVE.includes(a.status);
    const title = a.description || m?.labels?.description || m?.name;
    return { kind: (m?.labels?.role ?? a.role) === 'coordinator' ? 'coordinator' : 'agent', ...a, pid: undefined, machine: a.machine ?? m?.id, status: gone ? 'stopped' : a.status, machineState: m?.state, deadline: a.deadline ?? m?.archiveAt,
      labels: m?.labels, machineKind: m?.labels?.kind || undefined, title, titleSource: a.description ? 'log' : m?.labels?.description ? 'label' : 'machine', source: 'log', turns: turns.get(a.id), startedByOwner: m?.owner };
  });
  for (const m of machines ?? []) {
    if (used.has(m.id)) continue;
    const status = m.status ?? 'stopped', l = m.labels ?? {}, described = !!l.description, title = l.description || m.name || m.id;
    boxes.push({ kind: l.role === 'coordinator' || m.role === 'coordinator' ? 'coordinator' : l.agent ? 'agent' : 'machine', id: l.agent || m.name || m.id, machine: m.id, role: m.role, status, machineState: m.state, startedAt: m.startedAt, lastActivity: m.startedAt, deadline: m.archiveAt,
      description: title, title, machineKind: l.kind || undefined, titleSource: described ? 'label' : 'machine', ...(!described && { note: NO_TITLE }), labels: l, source: 'machine', startedByOwner: m.owner, messages: [] });
  }
  // A coordinator's own log (read from its machine) is the authority on its workers: fill live boxes, add the ones whose machine is gone.
  for (const c of boxes.filter((b) => b.kind === 'coordinator' && coordLogs[b.machine])) {
    const all = [];
    for (const w of coordLogs[c.machine]) {
      const msgs = w.messages.map((m) => ({ ...m, agent: w.id }));
      all.push(...msgs);
      let b = boxes.find((x) => x !== c && (x.id === w.id || x.labels?.agent === w.id));
      if (b && b.source !== 'machine') continue; // this session's own log knows it better
      if (b) { delete b.note; Object.assign(b, { messages: w.messages, description: w.description ?? b.description, title: w.description ?? b.title, titleSource: w.description ? 'log' : b.titleSource, profile: w.profile, model: w.model, branch: w.branch, push: w.push, turns: w.turns, harness: w.harness, autofix: w.autofix, source: 'coordinator-log' }); }
      else boxes.push(b = { ...w, kind: 'agent', pid: undefined, status: w.status === 'failed' ? 'failed' : 'stopped', title: w.description, titleSource: 'log', source: 'coordinator-log', turns: w.turns });
      b.parent = c.id;
      (c.children ??= []).push(b.id);
    }
    if (!c.messages.length) c.messages = all.sort((x, y) => x.t - y.t).slice(-300);
  }
  // Tree: a worker's `parent` label names a coordinator by its name label or id. It is never matched against an owner id:
  // cloud_agent sets owner and parent to the creating session's id, so that would make siblings children of each other.
  // A worker the coordinator's own log lists was linked above. A parent chain that would loop is not followed.
  const coords = boxes.filter((b) => b.kind === 'coordinator');
  const loops = (c, b) => { for (let x = c, n = 0; x && n <= boxes.length; x = coords.find((y) => y.id === x.parent), n++) if (x === b) return true; return false; };
  for (const b of boxes) {
    const p = b.labels?.parent;
    const c = b.parent ? coords.find((x) => x.id === b.parent) : p && coords.find((x) => x !== b && (x.labels?.name === p || x.id === p) && !loops(x, b));
    if (c) { if (!b.parent) { b.parent = c.id; (c.children ??= []).push(b.id); } } else if (p && p !== owner) b.parentUnknown = true;
    const o = b.startedByOwner;
    b.startedBy = o && o === owner ? 'this session' : c ? (c.labels?.name || c.id) : o;
  }
  for (const b of boxes) delete b.startedByOwner;
  // A fleet trunk (fleet/<topic>) is named in the worker's brief — its first `out` message — or, when it has none of
  // its own, in the coordinator's copy of that brief (merged messages carry `agent`) or the coordinator's own brief.
  const trunkIn = (msgs, pred) => { const m = msgs?.find((x) => x.kind === 'out' && (!pred || pred(x))); return m && TRUNK.exec(m.text)?.[0]; };
  for (const b of boxes) {
    const c = b.parent && boxes.find((x) => x.id === b.parent);
    const f = trunkIn(b.messages) ?? (c && (trunkIn(c.messages, (m) => m.agent === b.id) ?? trunkIn(c.messages, (m) => !m.agent || m.agent === c.id)));
    if (f) b.fleet = f;
  }
  const error = machineError && { code: machineError.code ?? 'api', message: redact(machineError.message), fix: (machineError.code === 'no_key' ? provider?.text.noKeyFix : provider?.text.apiFix) ?? GENERIC_FIX };
  return { now, hasLog: events.length > 0, ...(provider?.caps && { caps: { hasShell: !!provider.caps.hasShell, hasDisplay: !!provider.caps.hasDisplay } }), machines: machines ? { ok: true } : { ok: false, ...error }, boxes };
}

// state.fleets: one row per valid trunk on any box. `merged` is the trunk's agents whose own branch git lists as
// merged into it, or null when the check could not answer — the page then says the merge status is unknown.
export function fleetsOf(boxes, merged) {
  return [...new Set(boxes.map((b) => b.fleet).filter((t) => t && FLEET_TRUNK.test(t)))].map((trunk) => {
    const l = merged?.get(trunk) ?? null;
    return { trunk, merged: l === null ? null : boxes.filter((b) => b.fleet === trunk && l.has(b.branch)).map((b) => b.id) };
  });
}

const FLEET_MERGED_MS = 30_000;
const execP = promisify(execFile);
// The origin/cloudy-cloud/* remote branches merged into origin/<trunk>, as a Set of short branch names, or null when
// git cannot answer (not a repo, no remote). Runs `git fetch` then `git branch -r` via execFile — never a shell — in
// the dashboard's cwd so the remote-tracking ref is fresh, and caches each trunk's answer about 30 s so a poll loop
// does not spawn git every time. A failed fetch is an unknown answer, not the stale one.
export function makeMergedCheck({ now = Date.now, run = (args, opts) => execP('git', args, opts) } = {}) {
  const cache = new Map();
  return async (trunk) => {
    let c = cache.get(trunk);
    if (!c || now() - c.at >= FLEET_MERGED_MS) {
      let list = null;
      try {
        await run(['fetch', '--quiet', 'origin', trunk], { timeout: 15_000 });
        const { stdout } = await run(['branch', '-r', '--merged', 'origin/' + trunk, '--list', 'origin/cloudy-cloud/*']);
        list = new Set(stdout.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean));
      } catch { /* no answer: merged stays null */ }
      cache.set(trunk, c = { at: now(), list });
    }
    return c.list;
  };
}

// Pattern redaction plus the exact secret values (`secrets`), on every string and every key.
const deepRedact = (v, secrets = []) => {
  const str = (t) => redactText(secrets.reduce((a, x) => a.split(x).join('[redacted]'), t));
  const go = (x) => (typeof x === 'string' ? str(x) : Array.isArray(x) ? x.map(go) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [str(k), go(y)])) : x);
  return go(v);
};
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FULL_MAX = 256 * 1024;
const MEMO_MAX = 24;
const REMOTE_MS = 3000; // one machine read per file per 3 s; the reader enforces its own limits on top
const REASON = { not_found: 'machine_gone', not_listed: 'machine_gone' };
const reasonOf = (e) => REASON[e?.code] ?? 'provider_error';
const isLive = (b) => !!b.machine && !!b.machineState && b.machineState !== 'deleted';
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '');
const capFull = (s) => ({ text: redactText(s).slice(0, FULL_MAX), truncated: s.length > FULL_MAX });

// The harness is not recorded with the stream, so each format is tried and the one that yields most events wins.
const parseStream = (raw, turn) => ['claude', 'pi', 'omp', 'codex', 'opencode'].map((harness) => normalise(raw, { harness, turn })).reduce((a, b) => (b.length > a.length ? b : a));

// The untruncated (still redacted) input or result text of one event, from its source line (`off` is a byte offset into raw).
function fullEvent(ev, raw) {
  let j;
  try { j = JSON.parse(Buffer.from(raw).subarray(ev.off).toString('utf8').split('\n', 1)[0]); } catch { return ev; }
  const blocks = Array.isArray(j.message?.content) ? j.message.content : [];
  if (ev.kind === 'tool_use') { const { text, truncated } = capFull(JSON.stringify(blocks.find((b) => b?.type === 'tool_use' && b.id === ev.id)?.input ?? j.args ?? {})); return { ...ev, input: text, truncated }; }
  if (ev.kind === 'tool_result') { const { text, truncated } = capFull(textOf(blocks.find((b) => b?.type === 'tool_result' && b.tool_use_id === ev.id)?.content ?? j.result?.content)); return { ...ev, summary: text, truncated }; }
  if (ev.kind === 'result' && typeof j.result === 'string') return { ...ev, text: capFull(j.result).text };
  return ev;
}

const totalsOf = (events) => events.reduce((t, e) => {
  if (e.kind === 'tool_use') t.tools++;
  if (e.kind === 'result') { t.in += (e.usage?.input ?? 0) + (e.usage?.cacheRead ?? 0) + (e.usage?.cacheCreation ?? 0); t.out += e.usage?.output ?? 0; t.costUsd += e.costUsd ?? 0; }
  return t;
}, { tools: 0, in: 0, out: 0, costUsd: 0 });

// The request handler, separate from listen() so tests can drive it without a network.
// `streamsDir`: this laptop's stream copies. `getReader`: async, gives the machine reader (see machine-read.mjs); none means no machine reads.
// `getSecrets`: async, the exact secret values to drop from every response (see secretValues in run-subagent.mjs).
// `demo`: { stream(box, turn) -> raw stream text, pane(box) -> lines } replaces both for --demo.
export function createHandler({ token, getState, html, streamsDir: sdir = streamsDir(), getReader, getSecrets, getMetrics, demo, now = Date.now }) {
  const memo = new Map(); // file or machine path -> { sig, raw, events }: a stream is parsed again only when it has grown
  const panes = new Map(); // box id -> the last real pane read
  const remote = new Map(); // machine/path -> { raw, next, at, fetchedAt }: what has been read from a machine so far
  const parsed = (key, sig, raw, turn) => {
    let m = memo.get(key);
    if (m?.sig !== sig) { m = { sig, raw: raw(), events: undefined }; m.events = parseStream(m.raw, turn); memo.set(key, m); if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value); } // ponytail: whole-file parse; a 20 MB file costs a few hundred ms per growth
    return m;
  };
  async function fromMachine(reader, machine, name) {
    const k = `${machine}/${name}`;
    let st = remote.get(k);
    remote.delete(k); // most recently used last; the oldest goes with the memo's oldest, so neither grows without bound
    if (!st) st = { raw: '', next: 0, at: -Infinity, fetchedAt: 0, more: false };
    remote.set(k, st);
    if (remote.size > MEMO_MAX) remote.delete(remote.keys().next().value);
    // While the tail still holds unread bytes (`more`, #83) a poll reads on at once; the reader's own limit still applies.
    if (now() - st.at >= REMOTE_MS || st.more) {
      const r = await reader.readTail(machine, name, st.next);
      st.at = now();
      if (r.from === st.next && (!r.data || st.raw.length < 20 * 1024 * 1024)) { st.raw += r.data; st.next = r.next; } // `next` always moves: the reader skips an oversize line with no data
      st.more = r.size > r.next;
      if (r.source !== 'cache') st.fetchedAt = r.fetchedAt;
    }
    return st;
  }
  // Where the stream of one box and turn comes from: this laptop's copy, the box's machine, then the reader's cache.
  async function resolve(box, n, boxes) {
    const agent = box.kind === 'agent' ? box.id : box.labels?.agent, rel = `stream/t${n}.jsonl`;
    const found = (kind, machine, path, fetchedAt, key, sig, raw, more) => ({ kind, machine, path, fetchedAt, ...(more !== undefined && { more }), ...parsed(key, sig, raw, n) });
    if (demo) { const raw = demo.stream(box.id, n); return raw ? found('local', undefined, `streams/${box.id}/t${n}.jsonl`, now(), `demo/${box.id}/${n}`, 0, () => raw) : { kind: 'none', reason: 'no_stream_yet' }; }
    if (agent && SAFE_ID.test(agent)) {
      const f = join(sdir, agent, `t${n}.jsonl`);
      try { const st = statSync(f); return found('local', undefined, `streams/${agent}/t${n}.jsonl`, st.mtimeMs, f, `${st.size}/${st.mtimeMs}`, () => readFileSync(f, 'utf8')); } catch { /* no local copy */ }
    }
    let reason = !box.machine || isLive(box) ? 'no_stream_yet' : 'machine_gone';
    const reader = await getReader?.().catch(() => null);
    if (!reader) return { kind: 'none', reason: box.machine ? 'provider_error' : reason, machine: box.machine };
    if (isLive(box)) {
      try {
        const st = await fromMachine(reader, box.machine, rel);
        if (st.raw) return found('machine', box.machine, rel, st.fetchedAt, `${box.machine}/${rel}`, st.raw.length, () => st.raw, st.more);
      } catch (e) { reason = reasonOf(e); }
    }
    // A coordinator keeps its workers' streams under streams/<agent>/, even after the worker's machine is deleted.
    const co = boxes.find((b) => b.id === box.parent && b.kind === 'coordinator'), crel = `streams/${agent}/t${n}.jsonl`;
    if (co && isLive(co) && /^[0-9a-f]{8}$/.test(agent)) {
      try {
        const st = await fromMachine(reader, co.machine, crel);
        if (st.raw) return found('coordinator', co.machine, crel, st.fetchedAt, `${co.machine}/${crel}`, st.raw.length, () => st.raw, st.more);
      } catch (e) { if (reasonOf(e) === 'provider_error') reason = 'provider_error'; }
    }
    for (const [m, name] of [[box.machine, rel], [co?.machine, crel]]) {
      const cached = m && await reader.readCached(m, name).catch(() => null);
      if (cached?.data) return found('cache', m, name, cached.fetchedAt, `cache/${m}/${name}`, cached.data.length, () => cached.data);
    }
    return { kind: 'none', reason, machine: box.machine };
  }

  const secretsNow = async () => (await getSecrets?.().catch(() => null)) ?? [];
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  return async (req, res) => {
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'same-origin' });
      res.end(body);
    };
    // DNS rebinding: a rebound page still sends its own hostname as Host, so only loopback names are served.
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1') return send(403, 'Forbidden host\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Read-only\n');
    const url = new URL(req.url, 'http://localhost');
    const given = url.searchParams.get('t') ?? '';
    if (!eq(given, token)) return send(401, 'This dashboard link is missing its access key, or it is from an earlier run.\nOpen the newest link that cloudy-cloud dashboard printed in your terminal, or run cloudy-cloud dashboard again.\n');
    if (url.pathname === '/') {
      let page;
      try { page = typeof html === 'function' ? html() : html; } catch (e) { return send(500, 'Could not read the dashboard page: ' + redact(e.message) + '\n'); }
      return send(200, page, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/state') {
      try { return send(200, JSON.stringify(deepRedact(await getState(), await secretsNow())), 'application/json'); } catch (e) { return send(500, JSON.stringify({ error: redact(e.message) }), 'application/json'); }
    }
    if (url.pathname === '/api/stream' || url.pathname === '/api/pane' || url.pathname === '/api/metrics') {
      let secrets = [];
      const json = (code, body) => send(code, JSON.stringify(deepRedact(body, secrets)), 'application/json');
      try {
        secrets = await secretsNow();
        const q = url.searchParams, boxes = (await getState()).boxes ?? [], box = boxes.find((b) => b.id === q.get('box'));
        if (!box) return json(404, { error: 'unknown box' });
        if (url.pathname === '/api/metrics') {
          if (box.machineState !== 'running' || !box.machine) return json(404, { error: 'unknown box' });
          const m = demo ? demo.metrics(box.id) : getMetrics?.(box.machine);
          return json(200, { box: box.id, samples: m?.samples ?? [], fetchedAt: m?.fetchedAt ?? null, window: METRICS_WINDOW_MS, source: m?.source ?? 'none', ...(m?.error && { error: m.error }) });
        }
        if (url.pathname === '/api/pane') {
          if (box.kind !== 'coordinator' || !isLive(box)) return json(404, { error: 'unknown box' });
          if (demo) return json(200, { lines: demo.pane(box.id) ?? [], fetchedAt: now(), source: { kind: 'machine', machine: box.machine } });
          try {
            const r = await (await getReader()).capturePane(box.machine);
            if (r.source === 'cache' && !r.lines.length) { // the reader's rate-limit fallback: not a new read, so show the last real one
              const last = panes.get(box.id);
              return json(200, last ? { ...last, source: { kind: 'cache', machine: box.machine } } : { lines: [], fetchedAt: null, source: { kind: 'none', machine: box.machine, reason: 'rate_limited' } });
            }
            panes.delete(box.id); panes.set(box.id, { lines: r.lines, fetchedAt: r.fetchedAt });
            if (panes.size > MEMO_MAX) panes.delete(panes.keys().next().value);
            return json(200, { lines: r.lines, fetchedAt: r.fetchedAt, source: { kind: 'machine', machine: box.machine } });
          } catch (e) { return json(200, { lines: [], fetchedAt: null, source: { kind: 'none', machine: box.machine, reason: reasonOf(e) } }); }
        }
        const turn = q.get('turn') ?? String(box.turns || 1), from = q.get('from') ?? '0', one = q.get('event');
        if (!/^\d{1,4}$/.test(turn) || !/^\d{1,9}$/.test(from) || (one !== null && !/^\d{1,9}$/.test(one))) return json(404, { error: 'unknown box' });
        const r = await resolve(box, Number(turn), boxes), events = r.events ?? [];
        const source = { kind: r.kind, machine: r.machine, path: r.path, fetchedAt: r.fetchedAt, bytes: r.raw === undefined ? undefined : Buffer.byteLength(r.raw), reason: r.reason };
        const next = events.length;
        let out = events.filter((e) => e.seq >= Number(from));
        if (one !== null && q.get('full') === '1') {
          const ev = events.find((e) => e.seq === Number(one));
          if (!ev) return json(404, { error: 'unknown event' });
          out = [fullEvent(ev, r.raw)];
        }
        return json(200, { box: box.id, turn: Number(turn), events: out, next, complete: !r.more && (events.some((e) => e.kind === 'result') || ['stopped', 'failed'].includes(box.status)), source, totals: totalsOf(events) });
      } catch (e) { return send(500, JSON.stringify({ error: redact(e.message) }), 'application/json'); }
    }
    return send(404, 'Not found\n');
  };
}

const readOwner = (env) => { try { return readFileSync(ownerFile(env), 'utf8').trim() || undefined; } catch { return undefined; } };

const COORD_MS = 10_000;
const PANE_MS = 30_000; // a coordinator's screen is checked for a waiting prompt at most this often
const METRICS_MS = 30_000; // one Instabox usage read per running machine at most this often, only while something polls
const METRICS_WINDOW_MS = 3_600_000; // the page gets the last hour of samples
const METRICS_AT_ONCE = 4;
const METRICS_MAX_SAMPLES = 150; // an hour at 30 s, with margin
// Quiet: marked running; the newest sample is under 2 minutes old; the last 10 minutes are covered without a gap over 90 s
// (at least 18 samples); every sample is under 3 % CPU. Network under 1 KB/s counts only where the sample reports it
// (a new machine reports none for its first minutes: then CPU alone decides). The page shows this flag in the list, fleet and detail.
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const sampleQuiet = (x) => fin(x.cpuPct) && x.cpuPct < 3 && (!(fin(x.netIn) && fin(x.netOut)) || x.netIn + x.netOut < 1024);
export function isQuiet(samples, t) {
  const ss = samples.filter((x) => x && fin(x.t) && fin(x.cpuPct)).sort((a, b) => a.t - b.t), last = ss.at(-1);
  if (!last || t - last.t > 120_000) return false;
  const from = last.t - 600_000, w = ss.filter((x) => x.t >= from);
  return w.length >= 18 && w[0].t - from <= 90_000 && w.every((x, i) => (i === 0 || x.t - w[i - 1].t <= 90_000) && sampleQuiet(x));
}
const METRICS_POLL_GRACE_MS = METRICS_MS * 2; // reads start only while the state was asked for this recently
const MAX_EVENTS = 5000; // events kept per coordinator: its recent history, not all of it
const MAX_LOG = 16 * 1024 * 1024; // like readEvents: a coordinator log over 16 MB is read from its last 16 MB

// Live state with a short cache so several open tabs do not each call the provider API. With `getReader`, each live
// coordinator's own events.jsonl is also read from its machine (one chunk at a time, at most every 10 s, only while
// something polls this function) and folded into the workers it started.
export function liveState(env, { list = listMachines, file = eventsFile(env), cacheMs = 2500, provider, getReader, now = Date.now, mergedCheck } = {}) {
  let cached, at = 0;
  const usage = new Map(); // running machine id -> { samples, fetchedAt, at, error } (#117)
  let limiter; // made on first use: metrics reads leave at least one provider slot free for the state's own reads
  const lastRead = new Map(); // machine id -> when its last read started; kept after the machine stops so a quick restart is not read again within METRICS_MS
  let listSeq = 0, appliedSeq = 0; // a list answer older than the one already applied is ignored
  mergedCheck ??= makeMergedCheck({ now });
  const logs = new Map(); // coordinator machine id -> { offset, size, at, events }
  const pull = async (reader, m) => {
    let st = logs.get(m.id);
    if (!st) logs.set(m.id, st = { id: m.id, offset: 0, at: -Infinity, events: [], folded: [] });
    if (now() - st.at < COORD_MS && !st.behind) return; // read recently; while catching up a long log, only the reader's own interval applies
    try {
      const r = await reader.readTail(m.id, 'events.jsonl', st.offset);
      if (r.source !== 'cache') st.at = now();
      if (r.from !== st.offset) return;
      if (st.offset === 0 && r.size > MAX_LOG) { st.offset = r.size - MAX_LOG; st.behind = true; return; } // the first line of the tail is cut off and skipped below
      st.offset = r.next;
      st.behind = r.data !== '' && r.size - r.next >= 4096; // an unfinished last line (under 4 KB) is not 'behind'
      let added = 0;
      for (const l of r.data.split('\n')) try { const j = JSON.parse(l); if (j && typeof j === 'object') { st.events.push(j); added++; } } catch { /* blank or cut line */ }
      if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
      if (added) st.dirty = true;
    } catch { /* keep what was read; the next poll tries again */ }
  };
  // A prompt on a coordinator's screen that a person must answer (#88). Read at most every PANE_MS, through the reader's own limit.
  const checkPane = async (reader, st) => {
    if (!reader.capturePane || now() - (st.paneAt ?? -Infinity) < PANE_MS) return;
    st.paneAt = now();
    try {
      const r = await reader.capturePane(st.id);
      if (r.source === 'cache' && !r.lines.length) { st.paneAt = undefined; return; } // rate limited: not a read, try again at the next poll
      const p = paneState(r.lines.join('\n')); // a fatal state (login, limit) needs a person too, with a different fix
      st.waiting = p.blocked || p.waiting || undefined; st.fatal = !!p.blocked;
    } catch { /* keep the last answer */ }
  };
  // One read per running machine per METRICS_MS, started in the background so a slow read never delays the state. A failure keeps
  // the last good samples and records the error code. A machine that is not running is never read; a machine with a read in flight is not read again.
  const inflight = new Map(); // machine id -> promise (never rejects)
  let running = [], lastPoll = 0;
  const recent = (samples, t) => (Array.isArray(samples) ? samples : []).filter((x) => x.t >= t - METRICS_WINDOW_MS).slice(-METRICS_MAX_SAMPLES);
  const refreshUsage = (machines) => {
    running = machines.filter((m) => m.state === 'running').map((m) => m.id);
    limiter ??= createLimiter(Math.max(1, Math.min(METRICS_AT_ONCE, (provider.caps?.maxConcurrentCalls || 24) - 1)));
    for (const [id, t] of lastRead) if (now() - t >= METRICS_MS) lastRead.delete(id);
    for (const id of usage.keys()) if (!running.includes(id)) usage.delete(id);
    for (const id of running) {
      const prev = usage.get(id);
      if (inflight.has(id) || now() - (lastRead.get(id) ?? -Infinity) < METRICS_MS) continue;
      if (!provider.caps?.hasMetrics) { usage.set(id, { samples: [], fetchedAt: null, at: now(), error: { code: 'metrics_unsupported' } }); lastRead.set(id, now()); continue; }
      // Eligibility is checked when the limiter grants the slot, not when the read was queued; a read that is no longer wanted is dropped.
      inflight.set(id, limiter.run(async () => {
        if (!running.includes(id) || now() - lastPoll > METRICS_POLL_GRACE_MS) return;
        const t = now(); // the 30 s interval counts from here
        lastRead.set(id, t);
        let u;
        try { const r = await provider.metrics(id, { since: t - METRICS_WINDOW_MS }); u = { samples: recent(r.samples, t), fetchedAt: r.fetchedAt, at: t }; }
        catch (e) { u = { samples: prev?.samples ?? [], fetchedAt: prev?.fetchedAt ?? null, at: t, error: { code: e?.code ?? 'unknown' } }; }
        if (running.includes(id)) usage.set(id, u);
      }).catch(() => {}).finally(() => inflight.delete(id)));
    }
  };
  const errorOf = (code) => (code === 'not_found' ? { code: 'machine_gone' } : (({ code: c, whatHappened, nextStep }) => ({ code: c, whatHappened, nextStep }))(guideObj(code, { provider: provider.name })));
  const sourceOf = (u) => (u.fetchedAt != null && now() - u.fetchedAt < METRICS_MS * 2 ? 'live' : 'cache');
  const usageOf = (id) => {
    const u = usage.get(id);
    if (!u) return { none: 'no_samples_yet', fetchedAt: null };
    if (u.error) return { error: errorOf(u.error.code) };
    const n = recent(u.samples, now()).at(-1);
    if (!n) return { none: 'no_samples_yet', fetchedAt: u.fetchedAt };
    return { at: n.t, cpuPct: n.cpuPct, cpuCount: n.cpuCount, memUsed: n.memUsed, memTotal: n.memTotal, netIn: n.netIn, netOut: n.netOut, fetchedAt: u.fetchedAt, source: sourceOf(u) };
  };
  const state = async () => {
    lastPoll = now();
    if (cached && now() - at < cacheMs) return cached;
    let machines, machineError;
    const seq = ++listSeq;
    try {
      provider ??= await loadProvider(env);
      machines = await list(env, provider);
    } catch (e) { machineError = { code: e.code ?? 'api', message: String(e.message).split((provider && env[provider.keyName]) || '\0').join('[redacted]') }; }
    const coordLogs = {};
    const reader = getReader && machines?.some((m) => m.labels?.role === 'coordinator') ? await getReader().catch(() => null) : null;
    if (machines) for (const id of logs.keys()) if (!machines.some((m) => m.id === id)) logs.delete(id); // its machine is gone: forget its history
    if (reader) for (const m of machines.filter((x) => x.labels?.role === 'coordinator' && x.status !== 'stopped' && x.state !== 'deleting')) {
      await pull(reader, m);
      const st = logs.get(m.id);
      await checkPane(reader, st);
      if (st.dirty || !st.folded.length) { st.folded = foldAgents(st.events, { alive: () => true, now: now() }); st.dirty = false; } // refolded only when events arrived
      coordLogs[m.id] = st.folded;
    }
    if (machines && provider && seq > appliedSeq) { appliedSeq = seq; refreshUsage(machines); }
    cached = buildState({ events: readEvents(file), machines, machineError, provider, owner: readOwner(env), coordLogs });
    for (const b of cached.boxes) if (b.kind === 'coordinator' && b.machineState === 'running' && logs.get(b.machine)?.waiting) { b.waiting = logs.get(b.machine).waiting; if (logs.get(b.machine).fatal) b.fatal = true; }
    for (const b of cached.boxes) if (b.machineState === 'running' && b.machine) { const u = usageOf(b.machine); if (u) { b.usage = u; if (b.status === 'running' && u.at != null && isQuiet(recent(usage.get(b.machine).samples, now()), now())) u.quiet = true; } }
    const u = planSnapshot(provider, now())?.usage;
    if (typeof u?.costUSD === 'number') cached.usage = Object.fromEntries(['costUSD', 'allowanceUSD', 'overageUSD', 'ratedUntil'].filter((k) => u[k] != null).map((k) => [k, u[k]]));
    const trunks = [...new Set(cached.boxes.map((b) => b.fleet).filter((t) => t && FLEET_TRUNK.test(t)))];
    if (trunks.length) cached.fleets = fleetsOf(cached.boxes, new Map(await Promise.all(trunks.map(async (t) => [t, await mergedCheck(t)]))));
    at = now();
    return cached;
  };
  // The last hour of samples for one running machine, from the same map (no provider call): what /api/metrics returns.
  state.settle = () => Promise.all(inflight.values()); // tests: wait for the background reads
  state.metrics = (machineId) => {
    const u = usage.get(machineId);
    return u && { samples: recent(u.samples, now()), fetchedAt: u.fetchedAt, source: sourceOf(u), ...(u.error && { error: errorOf(u.error.code) }) };
  };
  return state;
}

export function listen(handler, port = DEFAULT_PORT) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    const go = (p) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && p !== 0 ? go(0) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(server));
    };
    go(port);
  });
}

export const openBrowser = (url) => execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {}).on('error', () => {});

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--prune')) { // delete stored agent streams older than 30 days, then the oldest until the folder is under 1 GB
    const dir = streamsDir(), r = pruneStreams(dir);
    console.log(`Pruned ${dir}: removed ${r.removed} file${r.removed === 1 ? '' : 's'} (${Math.round(r.freed / 1024)} KB).`);
    return;
  }
  const demo = argv.includes('--demo');
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) : DEFAULT_PORT;
  if (pi >= 0 && !(port >= 0 && port < 65536)) { console.error('cloudy-cloud dashboard: --port needs a number from 0 to 65535'); process.exit(1); }
  const env = loadEnv();
  const token = randomBytes(18).toString('base64url');
  // one provider and one reader per process; consented MCP token values are read at each use, so values added later are covered
  const getProvider = lazy(() => loadProvider(env));
  const literals = { [Symbol.iterator]: () => consentedLiterals(env)[Symbol.iterator]() };
  const getReader = lazy(async () => createMachineReader(await getProvider(), env, { literals }));
  const getSecrets = async () => secretValues(env, (await getProvider()).keyName, consentedLiterals(env));
  const html = () => readFileSync(join(HERE, 'dashboard.html'), 'utf8'); // read per request, so a missing file is a clear 500 and edits show on reload
  const live = demo ? undefined : liveState(env, { getReader });
  const server = await listen(createHandler({ token, html, getReader, getSecrets, getMetrics: live?.metrics, ...(demo && { demo: demoStream }), getState: demo ? async () => ({ ...demoState(Date.now()), now: Date.now() }) : live }), port);
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  console.log(`Cloudy Cloud dashboard${demo ? ' (demo data)' : ''}: ${url}\nRead-only. Press Ctrl+C to stop.`);
  if (!argv.includes('--no-open')) openBrowser(url);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
