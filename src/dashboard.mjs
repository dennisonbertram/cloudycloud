// `cloudy-cloud dashboard [--demo] [--port N] [--no-open]`: a read-only web page on 127.0.0.1 that shows the cloud
// boxes (agents and coordinators) and the messages between your session and them.
// Data: the local event log (see events.mjs) plus the live Instabox machine list. Keys stay on the server side.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { eventsFile, foldAgents, readEvents, redact } from './events.mjs';
import { demoState } from './dashboard-demo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4477;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";
const MACHINE_STATE = { creating: 'starting', starting: 'starting', running: 'running', resuming: 'starting', stopping: 'stopped', stopped: 'stopped', suspending: 'stopped', suspended: 'stopped', deleting: 'stopped', deleted: 'stopped', error: 'failed' };

// Live machines the tool labelled (metadata purpose=cloudy-cloud). Throws with a `code` the page can explain.
export async function listMachines(env, sdk) {
  if (!env.INSTABOX_API_KEY) throw Object.assign(new Error('INSTABOX_API_KEY is not set.'), { code: 'no_key' });
  const { Sandbox } = sdk ?? (await import('@insforge/instabox-sdk'));
  return (await Sandbox.list({ apiKey: env.INSTABOX_API_KEY, metadata: { purpose: 'cloudy-cloud' } })).map((m) => ({
    id: m.sandboxId, name: m.name, role: m.metadata?.role, owner: m.metadata?.owner, state: m.state,
    startedAt: +new Date(m.startedAt), archiveAt: m.archiveAt ? +new Date(m.archiveAt) : undefined,
  }));
}

const FIXES = {
  no_key: 'Add your Instabox key: run ./install.sh from the cloudy-cloud folder, or put INSTABOX_API_KEY=... in ~/.config/cloudy-cloud/env.',
  api: 'Check your internet connection and that INSTABOX_API_KEY in ~/.config/cloudy-cloud/env is still valid (create a new one at instabox.sh if not).',
};

// One list of boxes: every agent from the event log, with its live machine, plus live machines no agent explains
// (coordinators, and agents from sessions that never wrote an event log).
export function buildState({ events, machines, machineError, now = Date.now(), alive }) {
  const agents = foldAgents(events, { alive, now });
  const live = new Map((machines ?? []).map((m) => [m.id, m]));
  const used = new Set();
  const boxes = agents.map((a) => {
    const m = live.get(a.machine);
    if (m) used.add(m.id);
    // A listed machine is the truth about "running": if it is gone, an agent that looked active has ended.
    const gone = machines && a.machine && !m && ['queued', 'starting', 'running', 'idle'].includes(a.status);
    return { kind: 'agent', ...a, pid: undefined, status: gone ? 'stopped' : a.status, machineState: m?.state, deadline: a.deadline ?? m?.archiveAt };
  });
  for (const m of machines ?? []) {
    if (used.has(m.id)) continue;
    const status = MACHINE_STATE[m.state] ?? 'stopped';
    boxes.push({ kind: m.role === 'coordinator' ? 'coordinator' : 'machine', id: m.name || m.id, machine: m.id, role: m.role, status, machineState: m.state, startedAt: m.startedAt, lastActivity: m.startedAt, deadline: m.archiveAt, description: m.role === 'coordinator' ? 'Cloud coordinator' : 'Machine without a session log', messages: [] });
  }
  const error = machineError && { code: machineError.code ?? 'api', message: redact(machineError.message), fix: FIXES[machineError.code] ?? FIXES.api };
  return { now, hasLog: events.length > 0, machines: machines ? { ok: true } : { ok: false, ...error }, boxes };
}

// The request handler, separate from listen() so tests can drive it without a network.
export function createHandler({ token, getState, html }) {
  const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
    if (!eq(given, token)) return send(401, 'Missing or wrong token. Open the URL that cloudy-cloud dashboard printed.\n');
    if (url.pathname === '/') return send(200, typeof html === 'function' ? html() : html, 'text/html; charset=utf-8');
    if (url.pathname === '/api/state') {
      try { return send(200, JSON.stringify(await getState()), 'application/json'); } catch (e) { return send(500, JSON.stringify({ error: redact(e.message) }), 'application/json'); }
    }
    return send(404, 'Not found\n');
  };
}

// Live state with a short cache so several open tabs do not each call the Instabox API.
export function liveState(env, { list = listMachines, file = eventsFile(env), cacheMs = 2500 } = {}) {
  let cached, at = 0;
  return async () => {
    if (cached && Date.now() - at < cacheMs) return cached;
    let machines, machineError;
    try { machines = await list(env); } catch (e) { machineError = { code: e.code ?? 'api', message: String(e.message).split(env.INSTABOX_API_KEY || '\0').join('[redacted]') }; }
    cached = buildState({ events: readEvents(file), machines, machineError });
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
  const demo = argv.includes('--demo');
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) : DEFAULT_PORT;
  if (pi >= 0 && !(port >= 0 && port < 65536)) { console.error('cloudy-cloud dashboard: --port needs a number from 0 to 65535'); process.exit(1); }
  const env = loadEnv();
  const token = randomBytes(18).toString('base64url');
  const html = () => readFileSync(join(HERE, 'dashboard.html'), 'utf8'); // read per request, so a missing file is a clear 500 and edits show on reload
  const server = await listen(createHandler({ token, html, getState: demo ? async () => ({ ...demoState(Date.now()), now: Date.now() }) : liveState(env) }), port);
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  console.log(`Cloudy Cloud dashboard${demo ? ' (demo data)' : ''}: ${url}\nRead-only. Press Ctrl+C to stop.`);
  if (!argv.includes('--no-open')) openBrowser(url);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
