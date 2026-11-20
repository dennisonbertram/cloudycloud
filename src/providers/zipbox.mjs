// Zipbox provider (EXPERIMENTAL): one box per sandbox on Zipbox (https://zipbox.ai, Tribes Inc.),
// driven over the REST API at https://api.tribes.xyz (OpenAPI: https://zipbox.ai/openapi.json).
// Bring-your-own-key: ZIPBOX_API_KEY (zb_...) authenticates every control-plane call; a per-box
// bearer `boxToken` (from GET /sandbox/:id) authenticates the box's own API at its baseUrl.
//
// Guards the adapter enforces, because Zipbox lacks them:
// - No server TTL ("nothing stops on a clock"): caps.hasServerTTL is false and the deadline is
//   kept client-side. The box name carries it — `cc-<deadline-unix-seconds-base36>-<6 hex>` —
//   so ANY cloudy-cloud process can read it back from GET /sandbox alone, even if the local
//   state file is lost. Names match ^(?!.*--)[a-z](?:[a-z0-9-]{0,53}[a-z0-9])?$.
// - No labels: a small JSON state file (<config dir>/zipbox-boxes.json, written at create before
//   provisioning so a mid-create crash still leaves the box tracked) holds purpose/owner/name
//   labels per sandbox id. A cc-* box missing from it still lists (labels default to
//   purpose=cloudy-cloud) and is still swept when its name says the deadline passed.
// - No proxy secrets: credential VALUES are written onto the box (as /root/.cloudy-cloud-env,
//   mode 600) only after the user opts in with CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX=yes, the same
//   consent shape as self-hosted. create() refuses before any HTTP call without it.
// - No egress allowlist and no private tunnel: egress is refused (egress_unsupported), and
//   forwardPort throws — previews (publishPort) are PUBLIC zbox.sh URLs via `tribes-caddy`.
// - No images: create() provisions each box with one idempotent script (marker file) mirroring
//   docker/worker.Dockerfile (git, gh, node, claude, uv, tmux).
// Coordinators are refused: a box has no Docker socket for sibling workers.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createLimiter } from '../limits.mjs';

const API = 'https://api.tribes.xyz';
const KEY_NAME = 'ZIPBOX_API_KEY';
const CONSENT = 'CLOUDY_CLOUD_ZIPBOX_TOKEN_ON_BOX';
const HOME = '/root/workspace'; // the box user is root; its work area per Zipbox docs
const ENVFILE = '/root/.cloudy-cloud-env'; // consented credential values live here on the box (mode 600)
const PREFIX = /^cc-([0-9a-z]+)-[0-9a-z]{6}$/; // our boxes: deadline (unix seconds, base36) + random tag
const STATUS = { provisioning: 'starting', running: 'running', stopping: 'stopped', paused: 'stopped', deleting: 'stopped', destroyed: 'stopped' };
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const portOf = (port) => {
  const p = String(port);
  if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new Error(`port must be a number from 1 to 65535, not "${p.slice(0, 30)}"`);
  return p;
};
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote, inside the box's bash -lc

// One idempotent install run (marker file exits at once on a rerun), mirroring docker/worker.Dockerfile.
const PROVISION = `set -eu
MARK=/root/.cc-provisioned-v1
[ -f "$MARK" ] && exit 0
export DEBIAN_FRONTEND=noninteractive
have() { command -v "$1" >/dev/null 2>&1; }
if ! have git || ! have tmux || ! have curl || ! have python3; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends git tmux curl ca-certificates python3 openssh-client
fi
if ! have gh; then
  have gpg || { apt-get update -qq; apt-get install -y -qq --no-install-recommends gnupg; }
  mkdir -p /usr/share/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends gh
fi
if ! have node; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq --no-install-recommends nodejs
fi
have uv || curl -fsSL "https://astral.sh/uv/0.5.14/install.sh" | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
have claude || npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.322
touch "$MARK"`;

export function createProvider(env = process.env, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const limiter = deps.limiter ?? createLimiter(8);
  const maxTtlSeconds = 86400;
  const consented = env[CONSENT] === 'yes';
  const apiKey = () => {
    if (!env[KEY_NAME]) throw fail('no_key', api.text.noKeyFix);
    return env[KEY_NAME];
  };
  // Every secret-shaped string that could ride a request: scrubbed from any error text before it is shown.
  const sensitive = new Set([env[KEY_NAME]].filter(Boolean));
  const scrub = (s) => [...sensitive].reduce((t, v) => (typeof v === 'string' && v.length >= 8 ? t.split(v).join('<redacted>') : t), String(s));

  // ---- durable state: labels per box (Zipbox has none), in a file next to the env file ----
  const stateFile = deps.stateFile ?? join(dirname(env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env')), 'zipbox-boxes.json');
  const readState = () => {
    try { const j = JSON.parse(readFileSync(stateFile, 'utf8')); return j?.boxes && typeof j.boxes === 'object' ? j.boxes : {}; }
    catch { return {}; }
  };
  const writeState = (boxes) => {
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ boxes }, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, stateFile);
  };
  // Mutations run under a lock dir and re-read the file inside it, so two cloudy-cloud processes
  // (a create racing a machines stop, say) can never lose each other's rows. A lock older than
  // 30 s is a crashed holder and is taken over; Atomics.wait works on Node's main thread.
  const lockDir = `${stateFile}.lock`;
  const withStateLock = (fn) => {
    mkdirSync(dirname(stateFile), { recursive: true });
    for (let tries = 0; ; tries++) {
      try { mkdirSync(lockDir); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let stale = false;
        try { stale = Date.now() - statSync(lockDir).mtimeMs > 30_000; } catch { stale = true; }
        if (stale) { try { rmdirSync(lockDir); } catch { /* raced to it */ } continue; }
        if (tries >= 300) throw fail('transient', 'the Zipbox state file stayed locked by another process');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); } finally { try { rmdirSync(lockDir); } catch { /* lock holder vanished */ } }
  };
  const setState = (id, entry) => withStateLock(() => {
    const b = readState();
    const e = typeof entry === 'function' ? entry(b[id]) : entry;
    if (e) b[id] = e; else delete b[id];
    writeState(b);
  });

  // ---- HTTP ----
  const httpError = (status, e, raw, retryAfter) => {
    // Scrub the WHOLE field before cutting it: truncating first could leave a visible token fragment.
    const msg = scrub(String(e?.message ?? raw)).replaceAll('\n', ' ').slice(0, 200);
    if (status === 429 || e?.code === 'rate_limited')
      return fail('rate_limited', `The Zipbox API rate-limited the request.`, { retryAfterSeconds: Math.max(1, Math.ceil((e?.retryAfterMs ?? (Number(retryAfter) * 1000 || 1000)) / 1000)) });
    if (status === 401 || ['unauthorized', 'box_key_changed'].includes(e?.code))
      return fail('no_key', `The Zipbox API key was refused (HTTP ${status}). ${api.text.noKeyFix}`);
    if (status === 404 || e?.code === 'not_found') return fail('not_found', `Zipbox: ${msg || 'not found'}`);
    if (status === 402 || e?.code === 'insufficient_credits')
      return fail('quota_exceeded', `Zipbox: ${msg || e?.code || 'the account limit was reached'}`);
    // A machine name is never freed (a deleted box keeps it), so the 250-name cap is permanent:
    // no retry helps. Box names encode the deadline, so this adapter always claims a fresh one.
    if (e?.code === 'machine_limit_reached')
      return fail('machine_limit_reached', `Zipbox refused the create: the account already holds its 250 machine names, and a name is never freed, not even by deleting its box. Retrying cannot help.\nNext step: tell the user the limit is permanent — a different Zipbox account key for ZIPBOX_API_KEY, or another CLOUDY_CLOUD_PROVIDER (microsandbox, instabox), is needed.`);
    if (status >= 500 || e?.retryable === true || ['unavailable', 'box_not_running', 'source_busy'].includes(e?.code))
      return fail('transient', `Zipbox: ${msg || `HTTP ${status}`}`);
    if (e?.code) return fail(e.code, `Zipbox: ${msg || e.code}`); // name_taken, conflict, forbidden, invalid_request, ...
    // A 4xx without a code is still permanent; the box API often carries only a string `error`.
    if (status === 403) return fail('forbidden', `Zipbox: ${msg || 'forbidden (HTTP 403)'}`);
    if (status === 400 || status === 413) return fail('invalid_request', `Zipbox: ${msg || `HTTP ${status}`}`);
    return fail('transient', `The Zipbox API returned HTTP ${status}${msg ? ` (${msg})` : ''}`);
  };

  // One control-plane call. Errors: {error:{code,message,retryable,retryAfterMs}}.
  const ctl = async (method, path, body, { idempotencyKey } = {}) => {
    const key = apiKey(); // no_key must surface as no_key, not be wrapped into transient below
    let res;
    try {
      res = await limiter.run(() => fetchFn(`${API}${path}`, {
        method,
        redirect: 'error', // never follow a redirect while a credential header is attached
        headers: { Authorization: `Bearer ${key}`, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }));
    } catch (e) { throw fail('transient', `The Zipbox API could not be reached (${scrub(e?.message ?? e).replaceAll('\n', ' ')})`); }
    const t = await res.text().catch(() => '');
    if (res.ok) { try { return JSON.parse(t); } catch { return {}; } }
    let j = {};
    try { j = JSON.parse(t); } catch { /* not JSON */ }
    throw httpError(res.status, j?.error && typeof j.error === 'object' ? j.error : {}, t, res.headers?.get?.('retry-after'));
  };

  const deadlineOf = (name) => { const m = PREFIX.exec(String(name ?? '')); return m ? Number.parseInt(m[1], 36) * 1000 : 0; };

  // The box record (GET /sandbox/:id), carrying baseUrl + boxToken once the box is ready.
  const boxInfo = async (id) => {
    const rec = await ctl('GET', `/sandbox/${encodeURIComponent(id)}`);
    if (rec?.boxToken) sensitive.add(rec.boxToken);
    return rec;
  };

  // One call to a box's own API (bearer = boxToken). A 401 or a request that never reached the box
  // re-reads GET /sandbox/:id once (the token list can lag, and baseUrl moves once after create).
  const boxCall = async (id, info, path, { method = 'GET', body, headers = {}, signal } = {}) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await limiter.run(() => fetchFn(`${info.baseUrl}${path}`, {
          method, signal, redirect: 'error', headers: { Authorization: `Bearer ${info.boxToken}`, ...headers },
          ...(body !== undefined && { body }), // credential bodies must never ride a redirect to another origin
        }));
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (attempt === 0) { Object.assign(info, await boxInfo(id).catch(() => info)); continue; }
        throw fail('transient', `The Zipbox box could not be reached (${scrub(e?.message ?? e).replaceAll('\n', ' ')})`);
      }
      if (res.status === 401 && attempt === 0) { await res.text().catch(() => {}); Object.assign(info, await boxInfo(id).catch(() => info)); continue; }
      return res;
    }
  };

  // Parse an SSE stream (POST /exec): event/data lines until the `exit` event. Calls back per event.
  const sseRead = async (res, onEvent) => {
    const cut = /\r?\n\r?\n/;
    const feed = (buf) => { // consume complete events, return the rest
      for (;;) {
        const m = cut.exec(buf);
        if (!m) return buf;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let ev = '', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data = `${data}${line.slice(5).replace(/^ /, '')}\n`;
        }
        if (ev) onEvent(ev, data.replace(/\n$/, ''));
      }
    };
    if (res.body?.getReader) {
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf = feed(buf + dec.decode(value, { stream: true }));
      }
      feed(`${buf}\n\n`);
    } else feed(`${await res.text()}\n\n`);
  };

  const sandbox = (id, name, info, deleteAt) => {
    // Past its deadline the box must not serve again; every handle operation removes it first.
    // A failed delete propagates instead of being swallowed: removal is not confirmed, so the op
    // must not report the box gone while it may still be running.
    const guard = async () => { if (deleteAt && deleteAt <= now()) { await api.delete(id); throw fail('not_found', `the Zipbox box ${name} passed its deleteAt and was removed`); } };
    // A foreground exec: POST /exec, SSE until the exit event. Disconnecting kills the command on the box,
    // so an abort needs nothing more; timeoutMs lets the box enforce the deadline itself.
    const run = async (cmd, { cwd, timeoutMs, signal, onStdout } = {}) => {
      await guard();
      const inner = `set -a; [ ! -f ${ENVFILE} ] || . ${ENVFILE}; set +a; exec sh -c ${q(cmd)}`;
      const body = { cmd: inner, cwd: cwd || HOME, ...(timeoutMs > 0 && { timeoutMs: Math.ceil(timeoutMs) }) };
      const res = await boxCall(id, info, '/exec', { method: 'POST', body: JSON.stringify(body), headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, signal });
      if (!res.ok) { const t = await res.text().catch(() => ''); throw boxErr(res.status, t); }
      let stdout = '', stderr = '', exit, broken;
      await sseRead(res, (ev, data) => {
        let j;
        try { j = JSON.parse(data); } catch { j = undefined; }
        // `gap` means the stream dropped output; a malformed event on an output channel means the
        // same thing. Partial stdout must never come back as a success.
        if (ev === 'gap') { broken = 'the exec stream reported dropped output (a gap event)'; return; }
        if (ev === 'stdout' && typeof j?.data === 'string') { stdout += j.data; try { onStdout?.(j.data); } catch { /* a bad callback must not kill the call */ } return; }
        if (ev === 'stderr' && typeof j?.data === 'string') { stderr += j.data; return; }
        if (ev === 'exit' && j && typeof j === 'object') { exit = j; return; }
        if (ev === 'stdout' || ev === 'stderr' || ev === 'exit') broken = `the exec stream carried a malformed ${ev} event`;
      });
      // Errors carry redacted output only: the worker's stdout/stderr can hold secret values.
      const out = () => ({ stdout: scrub(stdout), stderr: scrub(stderr), ...(exit && typeof exit.exitCode === 'number' ? { exitCode: exit.exitCode } : {}) });
      if (broken) throw fail('incomplete_output', `the Zipbox exec output is incomplete (${broken}), so its result cannot be trusted — run the command again`, out());
      if (!exit) throw fail('transient', 'the Zipbox exec stream ended without an exit event', out());
      const r = { stdout, stderr, exitCode: exit.exitCode ?? 1 };
      if (exit.timedOut) throw fail('timeout', `timed out after ${Math.ceil((timeoutMs ?? 0) / 1000)} s`, out());
      if (r.exitCode !== 0) throw Object.assign(new Error(scrub(stderr.trim()).slice(-300) || `exit ${r.exitCode}`), out());
      return r;
    };
    // Box-API errors predate the control-plane envelope: {error: "<message>", code: "<code>"}.
    const boxErr = (status, raw) => {
      let j = {};
      try { j = JSON.parse(raw); } catch { /* not JSON */ }
      const e = j?.error && typeof j.error === 'object' ? j.error
        : { ...(typeof j?.error === 'string' && { message: j.error }), ...(typeof j?.code === 'string' && { code: j.code }) };
      return httpError(status, e, raw);
    };
    return {
      id, name, home: HOME,
      files: {
        async write(path, data) {
          await guard();
          const p = String(path), i = p.lastIndexOf('/');
          const dir = i > 0 ? p.slice(0, i) : i === 0 ? '/' : '.';
          await run(`mkdir -p -- ${q(dir)}`);
          const res = await boxCall(id, info, `/files/write?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(p.slice(i + 1))}`,
            { method: 'POST', body: typeof data === 'string' ? data : Buffer.from(data) });
          if (!res.ok) { const t = await res.text().catch(() => ''); throw boxErr(res.status, t); }
          return true;
        },
        async read(path) {
          await guard();
          const res = await boxCall(id, info, `/files/download?path=${encodeURIComponent(String(path))}`);
          if (!res.ok) { const t = await res.text().catch(() => ''); throw boxErr(res.status, t); }
          return res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text());
        },
      },
      commands: { run },
      kill: () => api.delete(id),
      loadName: async () => name, // the box's subdomain name
    };
  };

  const api = {
    name: 'zipbox',
    keyName: KEY_NAME,
    caps: {
      // hasServerTTL: Zipbox deletes nothing on a clock — the name-encoded deadline above is enforced
      // by this adapter (guard on every handle + the list sweep), exactly like the microsandbox pattern.
      // hasProxySecrets: Zipbox has no edge secret injection, so values go on the box, but only with consent.
      hasServerTTL: false, hasProxySecrets: false, hasConsentedSecrets: consented, hasEgressPolicy: false,
      hasSnapshots: false, hasPortForward: false, hasPublish: true, hasSizes: false, hasShell: false,
      hasDisplay: false, hasMetrics: false,
      maxForegroundMs: Infinity, maxTtlSeconds, startsPerMin: 60, maxConcurrentCalls: 8, uploadMaxBytes: 250 * 1024 * 1024,
      machineKinds: ['linux'],
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [], image: _ignored, role = labels.role, kind, egress } = {}) {
      if (egress) throw fail('egress_unsupported', 'zipbox cannot limit where a machine connects.');
      if (kind && kind.name !== 'linux') throw fail('machine_kind_unsupported', `zipbox runs only linux machines, not ${kind.name}. Use machine "linux".`);
      if (role === 'coordinator') throw new Error(api.text.coordinatorRefusal);
      apiKey(); // no_key before the consent check: the key is required either way
      if (!consented) throw new Error(`Zipbox has no proxy secrets, so every worker credential (GH_TOKEN, the Claude credential, profile keys) would be written onto the box in plaintext, where anything running on the box could read it.\nTo allow that, add ${CONSENT}=yes to ~/.config/cloudy-cloud/env, then call cloud_agent again.`);

      const ttl = Math.min(Math.max(1, ttlSeconds || maxTtlSeconds), maxTtlSeconds);
      const t0 = now();
      const deleteAt = t0 + ttl * 1000;
      const boxName = `cc-${Math.floor(deleteAt / 1000).toString(36)}-${randomBytes(3).toString('hex')}`;
      const all = { ...labels, ...(role && { role }), ...(name && !labels.name && { name }), deleteAt: new Date(deleteAt).toISOString(), startedAt: new Date(t0).toISOString() };
      for (const [k, v] of Object.entries(all)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`invalid label name "${k}"`);
        if (typeof v === 'string' && /[\r\n]/.test(v)) throw new Error(`invalid label value for "${k}"`);
      }
      const vars = { ...envs };
      // With consent GH_TOKEN goes on the box like the self-hosted provider's; other names in `secrets`
      // are MCP tokens the core asked for after the user allowed that server.
      for (const n of [...new Set(['GH_TOKEN', ...secrets])]) {
        if (env[n] === undefined) throw fail('no_key', `The secret ${n} cannot be put on a Zipbox box. ${api.text.githubTokenHelp}`);
        vars[n] = env[n];
      }
      for (const n of Object.keys(vars)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid environment variable name "${n}"`);
      for (const v of Object.values(vars)) if (typeof v === 'string') sensitive.add(v); // never let a written value reach an error string

      // ONE Idempotency-Key for the whole claim: replaying the same key + body returns the original
      // answer, so a response lost on the wire is recovered by retrying instead of claiming twice.
      const idem = randomUUID();
      let claim, lastErr;
      for (let attempt = 0; attempt < 3 && !claim; attempt++) {
        try { claim = await ctl('POST', '/sandbox/identity/claim', { name: boxName, tier: 's' }, { idempotencyKey: idem }); }
        catch (e) {
          lastErr = e;
          if (e.code !== 'transient' && e.code !== 'rate_limited') break; // a definitive refusal
          await sleep(500 * (attempt + 1));
        }
      }
      if (!claim) {
        // The claim may still have landed though every answer was lost — or a crashed earlier create
        // claimed this name. The unique name lets a list recover it (names are account-scoped).
        const found = (await ctl('GET', '/sandbox').then((bs) => (Array.isArray(bs) ? bs : [])).catch(() => [])).find((b) => b?.name === boxName);
        if (found?.id) claim = { sandboxId: found.id, name: boxName, created: false };
        else throw lastErr;
      }
      const id = claim.sandboxId ?? claim.id;
      if (!id) throw fail('transient', 'the Zipbox claim answer carried no sandbox id');
      if (claim.boxToken) sensitive.add(claim.boxToken);
      try {
        // Everything after the claim — including the first state write — is covered by cleanup:
        // any failure deletes the claimed box instead of leaking a billed, untracked machine.
        setState(id, { name: boxName, labels: all }); // tracked before provisioning: a crash still sweeps it
        // wait?until=ready is server-held; loop briefly in case it returns early or the box is still settling.
        let rec;
        for (const deadline = t0 + 180_000; ; ) {
          rec = await ctl('GET', `/sandbox/${encodeURIComponent(id)}/wait?until=ready`);
          if (rec?.ready && rec?.baseUrl && rec?.boxToken) break;
          if (now() >= deadline) throw fail('transient', 'the Zipbox box did not become ready within 180 s');
          await sleep(1000);
        }
        sensitive.add(rec.boxToken); // registered before the first box call, so errors can never leak it
        const sb = sandbox(id, boxName, { baseUrl: rec.baseUrl, boxToken: rec.boxToken }, deleteAt);
        await sb.commands.run(PROVISION, { timeoutMs: 600_000 });
        const envText = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}\n`).join('');
        await sb.files.write(ENVFILE, envText);
        await sb.commands.run(`chmod 600 ${ENVFILE}`);
        return sb;
      } catch (e) {
        await api.delete(id).catch(() => {});
        throw e;
      }
    },

    async connect(id) {
      const rec = await boxInfo(id);
      if (!PREFIX.test(rec?.name ?? '')) throw fail('not_found', `No cloudy-cloud Zipbox box ${id}`);
      const deleteAt = deadlineOf(rec?.name) || Date.parse(readState()[id]?.labels?.deleteAt ?? '') || 0;
      if (deleteAt && deleteAt <= now()) { await api.delete(id); throw fail('not_found', `the Zipbox box ${id} passed its deleteAt and was removed`); }
      if (!rec?.baseUrl || !rec?.boxToken) throw fail('transient', `the Zipbox box ${id} is not running (status ${rec?.status ?? 'unknown'})`);
      return sandbox(id, rec.name ?? id, { baseUrl: rec.baseUrl, boxToken: rec.boxToken }, deleteAt);
    },

    async list(labels = {}, { onError } = {}) {
      const state = readState();
      const boxes = await ctl('GET', '/sandbox');
      if (!Array.isArray(boxes)) throw fail('transient', 'the Zipbox sandbox list answer was not a JSON array — the account cannot be read, so nothing can be shown or swept');
      const rows = [];
      for (const rec of boxes) {
        if (!PREFIX.test(rec?.name ?? '')) continue; // not ours: only cc-* names are cloudy-cloud boxes
        const st = state[rec.id] ?? {};
        const deleteAt = deadlineOf(rec.name) || Date.parse(st?.labels?.deleteAt ?? '') || 0;
        let deleteError = st.deleteError;
        if (deleteAt && deleteAt <= now()) {
          // Sweep expired owned boxes. A failed delete is reported and the row kept: the box is still
          // out there billing, so it must stay visible (and the next sweep tries again).
          try { await api.delete(rec.id); continue; }
          catch (e) { deleteError = `delete failed: ${e.message}`; onError?.(e); }
        }
        const l = { purpose: 'cloudy-cloud', ...(st.labels ?? {}) };
        if (!Object.entries(labels).every(([k, v]) => l[k] === v)) continue;
        rows.push({
          id: rec.id, name: l.name ?? rec.name, machineName: rec.name, labels: l,
          state: rec.status ?? '', status: STATUS[rec.status] ?? (rec.startFailedAt ? 'failed' : 'stopped'),
          startedAt: Date.parse(l.startedAt) || Date.parse(rec.createdAt) || 0,
          deleteAt: new Date(deleteAt).toISOString(),
          ...(deleteError && { deleteError }),
        });
      }
      return rows;
    },

    // Ownership state is dropped only after the API confirms the delete (or says 404). A failed delete
    // keeps the record, marked with the error, so the box stays listed and the next sweep retries.
    async delete(id, { retries = 2, log } = {}) {
      try {
        for (let attempt = 0; ; attempt++) {
          try { await ctl('DELETE', `/sandbox/${encodeURIComponent(id)}`, { archiveBeforeDestroy: false }); break; }
          catch (e) {
            if (e.code === 'not_found') break;
            if (attempt >= retries || (e.code !== 'transient' && e.code !== 'rate_limited')) throw e;
            log?.(`delete ${id} failed (${e.message}); retrying`);
            await sleep(500 * (attempt + 1));
          }
        }
      } catch (e) {
        try { setState(id, (prev) => ({ ...(prev ?? {}), deleteError: `delete failed: ${e.message}` })); } catch { /* still visible by name */ }
        throw e;
      }
      try { setState(id, null); } catch { /* state cleanup must not block a confirmed delete */ }
    },

    async snapshot() { throw new Error('zipbox does not support snapshots'); },
    async getSnapshot() { throw new Error('zipbox does not support snapshots'); },

    // Zipbox has no private tunnel (its private boxes reach the API only over Tailscale); previews are the
    // public share path. `cloudy-cloud open` refuses earlier because caps.hasPortForward is false.
    async forwardPort() { throw new Error('zipbox has no private port tunnel for `cloudy-cloud open`; use --share for a public preview link.'); },
    async publishPort(id, port) {
      const p = portOf(port);
      const sb = await api.connect(id);
      // previews run through the box's own caddy: tribes-caddy add <label>.<box host> 127.0.0.1:<port> --no-wait;
      // exit 75 means the wildcard certificate is still being issued — retry briefly.
      const label = `p${p}`;
      for (let n = 0; ; n++) {
        try {
          await sb.commands.run(`tribes-caddy add ${label}.${sb.name}.zbox.sh 127.0.0.1:${p} --no-wait`, { timeoutMs: 30_000 });
          return { url: `https://${label}.${sb.name}.zbox.sh` };
        } catch (e) {
          // A URL is only returned after the route actually took: the last failure propagates.
          if (e.exitCode !== 75 || n === 3) throw e;
          await sleep(Number(e.stderr?.match(/retryAfterMs\D*(\d+)/i)?.[1]) || 3000);
        }
      }
    },
    async unpublishPort(id, port) {
      const p = portOf(port);
      const sb = await api.connect(id);
      const r = await sb.commands.run(`tribes-caddy rm p${p}.${sb.name}.zbox.sh`, { timeoutMs: 30_000 }).catch((e) => e);
      return r.exitCode ?? 1;
    },

    localMachineName: (hostname) => (hostname.startsWith('cc-') ? hostname : ''),

    // No SSH: a box would need an sshPublicKey at create, which we do not generate. The dashboard terminal
    // or `cloudy-cloud open --share` are the ways in. hasShell is false so shellArgv is never called.
    shellArgv() { throw new Error('cloudy-cloud shell is not supported on zipbox (no SSH key is provisioned); use the box terminal on https://zipbox.ai.'); },
    async displayLink() { throw noDisplay(); },
    async revokeDisplayLinks() { throw noDisplay(); },
    async screenshot() { throw noDisplay(); },
    async plan() { return null; },
    async metrics() { throw fail('metrics_unsupported', 'zipbox machines have no usage numbers.', { provider: 'zipbox' }); },

    text: {
      ssh: (machine, cmd) => `the box terminal at https://zipbox.ai (box: ${machine})${cmd ? `, then run: ${cmd}` : ''}`,
      // The header is piped to curl on stdin (-K -), so the key never sits in the command's argv.
      listMachines: `printf 'header = "Authorization: Bearer %s"\\n' "$ZIPBOX_API_KEY" | curl -s -K - https://api.tribes.xyz/sandbox`,
      noKeyFix: `ZIPBOX_API_KEY is not set.\nCreate a key at https://zipbox.ai (Settings -> API keys), then add\nZIPBOX_API_KEY=<the key> to ~/.config/cloudy-cloud/env.`,
      apiFix: `Check that the Zipbox API answers:\n  printf 'header = "Authorization: Bearer %s"\\n' "$ZIPBOX_API_KEY" | curl -s -K - https://api.tribes.xyz/sandbox`,
      githubTokenHelp: `Zipbox has no proxy secrets, so GH_TOKEN is written onto the box in plaintext.\nAdd GH_TOKEN=<a token with write access> and ${CONSENT}=yes to ~/.config/cloudy-cloud/env.`,
      hostLabel: 'a Zipbox box',
      coordinatorRefusal: 'Coordinators are not supported on the zipbox provider (a box has no Docker socket for sibling workers). Start workers directly from your own session with cloud_agent.',
    },
  };
  function noDisplay() { return fail('display_unsupported', 'zipbox machines have no desktop display. Use the box terminal on https://zipbox.ai.'); }
  return api;
}
