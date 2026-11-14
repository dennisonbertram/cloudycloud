// `cloudy-cloud dashboard [--demo] [--port N] [--no-open] [--prune]`: a read-only web page on 127.0.0.1 that shows the cloud
// boxes (agents and coordinators) and the messages between your session and them.
// Data: the local event log (see events.mjs) plus the live machine list from the provider. Keys stay on the server side.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ownerFile } from './config.mjs';
import { loadProvider } from './providers/index.mjs';
import { eventsFile, foldAgents, readEvents, redact, redactText } from './events.mjs';
import { createMachineReader } from './machine-read.mjs';
import { isLiteralSecret, mcpFile } from './mcpsync.mjs';
import { demoState, demoStream } from './dashboard-demo.mjs';
import { normalise, pruneStreams, streamsDir } from './stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4477;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";
const GENERIC_FIX = 'Check CLOUDY_CLOUD_PROVIDER and your internet connection, then your provider API key in ~/.config/cloudy-cloud/env.';

// Machine label values for the page: strings only, ANSI and control characters removed, redacted, 200 characters at most.
const cleanLabel = (v) => redact(v.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '')).slice(0, 200);
const cleanLabels = (l) => Object.fromEntries(Object.entries(l ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, cleanLabel(v)]));

// Live machines the tool labelled (label purpose=cloudy-cloud). Throws with a `code` the page can explain.
export async function listMachines(env, provider) {
  provider ??= await loadProvider(env);
  if (!env[provider.keyName]) throw Object.assign(new Error(`${provider.keyName} is not set.`), { code: 'no_key' });
  return (await provider.list({ purpose: 'cloudy-cloud' }, { sdk: true })).map((m) => ({
    id: m.id, name: m.name, role: m.labels?.role, owner: m.labels?.owner, labels: cleanLabels(m.labels), state: m.state, status: m.status,
    startedAt: m.startedAt, archiveAt: m.archiveAt,
  }));
}

const NO_TITLE = 'no title: started before labels (#48)';
const ACTIVE = ['queued', 'starting', 'running', 'idle'];

// One list of boxes: every agent from the event log, with its live machine, plus live machines no agent explains
// (coordinators, and agents from sessions that never wrote an event log). `owner` is this server's owner id.
export function buildState({ events, machines, machineError, now = Date.now(), alive, provider, owner }) {
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
      labels: m?.labels, title, titleSource: a.description ? 'log' : m?.labels?.description ? 'label' : 'machine', source: 'log', turns: turns.get(a.id), startedByOwner: m?.owner };
  });
  for (const m of machines ?? []) {
    if (used.has(m.id)) continue;
    const status = m.status ?? 'stopped', l = m.labels ?? {}, described = !!l.description, title = l.description || m.name || m.id;
    boxes.push({ kind: l.role === 'coordinator' || m.role === 'coordinator' ? 'coordinator' : l.agent ? 'agent' : 'machine', id: m.name || m.id, machine: m.id, role: m.role, status, machineState: m.state, startedAt: m.startedAt, lastActivity: m.startedAt, deadline: m.archiveAt,
      description: title, title, titleSource: described ? 'label' : 'machine', ...(!described && { note: NO_TITLE }), labels: l, source: 'machine', startedByOwner: m.owner, messages: [] });
  }
  // Tree: a worker's `parent` label names a coordinator by its name label or owner id. A parent this session started is not unknown.
  const coords = boxes.filter((b) => b.kind === 'coordinator');
  for (const b of boxes) {
    const p = b.labels?.parent;
    const c = p && coords.find((x) => x !== b && (x.labels?.name === p || x.labels?.owner === p || x.startedByOwner === p));
    if (c) { b.parent = c.id; (c.children ??= []).push(b.id); } else if (p && p !== owner) b.parentUnknown = true;
    const o = b.startedByOwner;
    b.startedBy = o && o === owner ? 'this session' : c ? (c.labels?.name || c.id) : o;
  }
  for (const b of boxes) delete b.startedByOwner;
  const error = machineError && { code: machineError.code ?? 'api', message: redact(machineError.message), fix: (machineError.code === 'no_key' ? provider?.text.noKeyFix : provider?.text.apiFix) ?? GENERIC_FIX };
  return { now, hasLog: events.length > 0, machines: machines ? { ok: true } : { ok: false, ...error }, boxes };
}

const deepRedact = (v) => (typeof v === 'string' ? redactText(v) : Array.isArray(v) ? v.map(deepRedact) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x)])) : v);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FULL_MAX = 256 * 1024;
const REMOTE_MS = 3000; // one machine read per file per 3 s; the reader enforces its own limits on top
const REASON = { not_found: 'machine_gone', not_listed: 'machine_gone' };
const reasonOf = (e) => REASON[e?.code] ?? 'provider_error';
const isLive = (b) => !!b.machine && !!b.machineState && b.machineState !== 'deleted';
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '');
const capFull = (s) => ({ text: redactText(s).slice(0, FULL_MAX), truncated: s.length > FULL_MAX });

// The harness is not recorded with the stream, so each format is tried and the one that yields most events wins.
const parseStream = (raw, turn) => ['claude', 'pi', 'omp'].map((harness) => normalise(raw, { harness, turn })).reduce((a, b) => (b.length > a.length ? b : a));

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
// `demo`: { stream(box, turn) -> raw stream text, pane(box) -> lines } replaces both for --demo.
export function createHandler({ token, getState, html, streamsDir: sdir = streamsDir(), getReader, demo, now = Date.now }) {
  const memo = new Map(); // file or machine path -> { sig, raw, events }: a stream is parsed again only when it has grown
  const remote = new Map(); // machine/path -> { raw, next, at, fetchedAt }: what has been read from a machine so far
  const parsed = (key, sig, raw, turn) => {
    let m = memo.get(key);
    if (m?.sig !== sig) { m = { sig, raw: raw(), events: undefined }; m.events = parseStream(m.raw, turn); memo.set(key, m); if (memo.size > 24) memo.delete(memo.keys().next().value); } // ponytail: whole-file parse; a 20 MB file costs a few hundred ms per growth
    return m;
  };
  async function fromMachine(reader, machine, name) {
    const k = `${machine}/${name}`;
    let st = remote.get(k);
    if (!st) remote.set(k, st = { raw: '', next: 0, at: -Infinity, fetchedAt: 0 });
    if (now() - st.at >= REMOTE_MS) {
      const r = await reader.readTail(machine, name, st.next);
      st.at = now();
      if (r.from === st.next && r.data && st.raw.length < 20 * 1024 * 1024) { st.raw += r.data; st.next = r.next; }
      if (r.source !== 'cache') st.fetchedAt = r.fetchedAt;
    }
    return st;
  }
  // Where the stream of one box and turn comes from: this laptop's copy, the box's machine, then the reader's cache.
  async function resolve(box, n) {
    const agent = box.kind === 'agent' ? box.id : box.labels?.agent, rel = `stream/t${n}.jsonl`;
    const found = (kind, machine, path, fetchedAt, key, sig, raw) => ({ kind, machine, path, fetchedAt, ...parsed(key, sig, raw, n) });
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
        if (st.raw) return found('machine', box.machine, rel, st.fetchedAt, `${box.machine}/${rel}`, st.raw.length, () => st.raw);
      } catch (e) { reason = reasonOf(e); }
    }
    const cached = box.machine && await reader.readCached(box.machine, rel).catch(() => null);
    if (cached?.data) return found('cache', box.machine, rel, cached.fetchedAt, `cache/${box.machine}/${rel}`, cached.data.length, () => cached.data);
    return { kind: 'none', reason, machine: box.machine };
  }

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
      try { return send(200, JSON.stringify(deepRedact(await getState())), 'application/json'); } catch (e) { return send(500, JSON.stringify({ error: redact(e.message) }), 'application/json'); }
    }
    if (url.pathname === '/api/stream' || url.pathname === '/api/pane') {
      const json = (code, body) => send(code, JSON.stringify(deepRedact(body)), 'application/json');
      try {
        const q = url.searchParams, box = (await getState()).boxes?.find((b) => b.id === q.get('box'));
        if (!box) return json(404, { error: 'unknown box' });
        if (url.pathname === '/api/pane') {
          if (box.kind !== 'coordinator' || !isLive(box)) return json(404, { error: 'unknown box' });
          if (demo) return json(200, { lines: demo.pane(box.id) ?? [], fetchedAt: now(), source: { kind: 'machine', machine: box.machine } });
          try { const r = await (await getReader()).capturePane(box.machine); return json(200, { lines: r.lines, fetchedAt: r.fetchedAt, source: { kind: 'machine', machine: box.machine } }); } catch (e) { return json(200, { lines: [], fetchedAt: null, source: { kind: 'none', machine: box.machine, reason: reasonOf(e) } }); }
        }
        const turn = q.get('turn') ?? String(box.turns || 1), from = q.get('from') ?? '0', one = q.get('event');
        if (!/^\d{1,4}$/.test(turn) || !/^\d{1,9}$/.test(from) || (one !== null && !/^\d{1,9}$/.test(one))) return json(404, { error: 'unknown box' });
        const r = await resolve(box, Number(turn)), events = r.events ?? [];
        const source = { kind: r.kind, machine: r.machine, path: r.path, fetchedAt: r.fetchedAt, bytes: r.raw === undefined ? undefined : Buffer.byteLength(r.raw), reason: r.reason };
        const next = events.length;
        let out = events.filter((e) => e.seq >= Number(from));
        if (one !== null && q.get('full') === '1') {
          const ev = events.find((e) => e.seq === Number(one));
          if (!ev) return json(404, { error: 'unknown event' });
          out = [fullEvent(ev, r.raw)];
        }
        return json(200, { box: box.id, turn: Number(turn), events: out, next, complete: events.some((e) => e.kind === 'result') || ['stopped', 'failed'].includes(box.status), source, totals: totalsOf(events) });
      } catch (e) { return send(500, JSON.stringify({ error: redact(e.message) }), 'application/json'); }
    }
    return send(404, 'Not found\n');
  };
}

// Token values the user consented to put on machines (cloudyCloudAllowLiteral), as run-subagent.mjs scrubs them.
function consentedLiterals(env) {
  try {
    const servers = JSON.parse(readFileSync(mcpFile(env), 'utf8')).mcpServers ?? {};
    return Object.values(servers).filter((e) => e?.cloudyCloudAllowLiteral === true).flatMap((e) => [['env', false], ['headers', true]].flatMap(([f, h]) => Object.entries(e[f] ?? {}).filter(([k, v]) => typeof v === 'string' && isLiteralSecret(k, v, h)).flatMap(([, v]) => [v, v.replace(/^Bearer /, '')]))).filter((t) => t.length >= 6);
  } catch { return []; }
}

const readOwner = (env) => { try { return readFileSync(ownerFile(env), 'utf8').trim() || undefined; } catch { return undefined; } };

// Live state with a short cache so several open tabs do not each call the provider API.
export function liveState(env, { list = listMachines, file = eventsFile(env), cacheMs = 2500, provider } = {}) {
  let cached, at = 0;
  return async () => {
    if (cached && Date.now() - at < cacheMs) return cached;
    let machines, machineError;
    try {
      provider ??= await loadProvider(env);
      machines = await list(env, provider);
    } catch (e) { machineError = { code: e.code ?? 'api', message: String(e.message).split((provider && env[provider.keyName]) || '\0').join('[redacted]') }; }
    cached = buildState({ events: readEvents(file), machines, machineError, provider, owner: readOwner(env) });
    at = Date.now();
    return cached;
  };
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
  let reader; // one reader per process; consented MCP token values are read at each use, so values added later are covered
  const literals = { [Symbol.iterator]: () => consentedLiterals(env)[Symbol.iterator]() };
  const getReader = async () => (reader ??= createMachineReader(await loadProvider(env), env, { literals }));
  const html = () => readFileSync(join(HERE, 'dashboard.html'), 'utf8'); // read per request, so a missing file is a clear 500 and edits show on reload
  const server = await listen(createHandler({ token, html, getReader, ...(demo && { demo: demoStream }), getState: demo ? async () => ({ ...demoState(Date.now()), now: Date.now() }) : liveState(env) }), port);
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  console.log(`Cloudy Cloud dashboard${demo ? ' (demo data)' : ''}: ${url}\nRead-only. Press Ctrl+C to stop.`);
  if (!argv.includes('--no-open')) openBrowser(url);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
