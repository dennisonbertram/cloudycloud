// E2B provider (EXPERIMENTAL): one Firecracker microVM per sandbox on E2B (https://e2b.dev),
// driven over the REST control plane at https://api.e2b.app (OpenAPI: https://docs.e2b.dev)
// and envd inside each sandbox at the shared host https://sandbox.e2b.app.
// Bring-your-own-key: E2B_API_KEY (e2b_...) authenticates every control-plane call; a per-sandbox
// `envdAccessToken` (from POST /v2/sandboxes) authenticates envd as X-Access-Token.
//
// Guards and mappings the adapter enforces:
// - Ownership: sandboxes are created with metadata purpose=cloudy-cloud (+ the caller's labels
//   and deleteAt). list() filters by metadata server-side and re-checks client-side; delete,
//   connect, metrics and publishPort refuse (not_found) a sandbox that is not ours — foreign
//   sandboxes are never killed.
// - Server TTL: E2B deletes the sandbox when its timeout expires, so a lost client still ends it
//   (caps.hasServerTTL). The plan caps each timeout call, so create() walks a ladder
//   (requested -> 3600 -> 300 s) and, while the handle is alive, a refresher keeps posting
//   POST /sandboxes/{id}/timeout to reach the full deadline.
// - No proxy secrets: credential VALUES go into the sandbox (create envVars plus an env file
//   sourced by every command) only after CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes, the same consent
//   shape as self-hosted/zipbox. create() refuses before any HTTP call without it.
// - Egress: egress.allow maps to E2B's API-enforced network.allowOut (domains, *.suffix wildcards)
//   with denyOut 0.0.0.0/0, so hasEgressPolicy is true.
// - Commands run through envd's Connect-RPC stream (POST /process.Process/Start, Connect framing);
//   abort signals the process by tag (POST /process.Process/SendSignal) and a dropped stream
//   re-attaches through POST /process.Process/Connect.
// - Files go through envd's /files upload/download; previews are PUBLIC https://<port>-<id>.e2b.app
//   URLs — anyone with the link can open them until the sandbox is deleted.
// Coordinators are refused: a sandbox has no Docker socket for sibling workers.
import { randomBytes, randomUUID } from 'node:crypto';
import { createLimiter } from '../limits.mjs';

const KEY_NAME = 'E2B_API_KEY';
const CONSENT = 'CLOUDY_CLOUD_E2B_TOKEN_ON_BOX';
const TEMPLATE = 'base';
const HOME = '/home/user'; // the base template's default user
const ENVFILE = '/home/user/.cloudy-cloud-env'; // consented credential values live here too (mode 600)
const ENVD_HOST = 'https://sandbox.e2b.app';
const ENVD_PORT = 49983;
const MAX_TTL_SECONDS = 86400;
const TTL_LADDER = [3600, 300]; // fallbacks when the plan caps the requested timeout
const MAX_LEN_RE = /max(imum)? (instance|sandbox).*(length|duration|timeout)|timeout cannot be (greater|longer|more) than/i; // live API: 'Timeout cannot be greater than 1 hours'
const STATUS = { running: 'running', paused: 'stopped' };
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote, inside the sandbox's sh -c
const portOf = (port) => {
  const p = String(port);
  if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new Error(`port must be a number from 1 to 65535, not "${p.slice(0, 30)}"`);
  return p;
};

// One idempotent install run (marker file exits at once on a rerun), mirroring docker/worker.Dockerfile:
// git, gh, node 22, claude, uv, tmux. The base template's user can sudo without a password.
const PROVISION = `set -eu
MARK=$HOME/.cc-provisioned-v1
[ -f "$MARK" ] && exit 0
export DEBIAN_FRONTEND=noninteractive
# Root skips sudo entirely (it may not be installed); a normal user needs passwordless sudo.
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"
have() { command -v "$1" >/dev/null 2>&1; }
if ! have git || ! have tmux || ! have curl || ! have python3; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends git tmux curl ca-certificates python3 openssh-client
fi
if ! have gh; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends gnupg
  $SUDO mkdir -p /usr/share/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends gh
  $SUDO apt-get purge -y -qq gnupg || true
fi
if ! have node; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y -qq --no-install-recommends nodejs
fi
have uv || curl -fsSL "https://astral.sh/uv/0.5.14/install.sh" | $SUDO env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
have claude || $SUDO npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.322
touch "$MARK"`;

// Connect-RPC envelope: flags byte, four-byte big-endian payload length, UTF-8 JSON.
const frame = (obj) => {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
};

export function createProvider(env = process.env, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const limiter = deps.limiter ?? createLimiter(8);
  const API = (env.E2B_API_BASE || 'https://api.e2b.app').replace(/\/$/, '');
  const consented = () => env[CONSENT] === 'yes';
  const apiKey = () => {
    if (!env[KEY_NAME]) throw fail('no_key', api.text.noKeyFix, { local: true });
    return env[KEY_NAME];
  };
  // Every secret-shaped string that could ride a request or a response: scrubbed from any error
  // text before it is shown. The API key, the envd token and consented values all register here.
  const sensitive = new Set();
  const scrub = (s) => [...sensitive].reduce((t, v) => (typeof v === 'string' && v.length >= 8 ? t.split(v).join('<redacted>') : t), String(s));

  const parseErrorBody = async (res) => {
    const t = await res.text().catch(() => '');
    let j = {};
    try { j = JSON.parse(t); } catch { /* not JSON */ }
    const e = j?.error && typeof j.error === 'object' ? j.error : j;
    return { code: typeof e?.error_code === 'string' ? e.error_code : '', message: typeof e?.message === 'string' ? e.message : '', raw: t };
  };

  const httpError = (status, e, retryAfter) => {
    // Scrub the WHOLE field before cutting it: truncating first could leave a visible token fragment.
    const msg = scrub(e.message || e.raw || '').replaceAll('\n', ' ').slice(0, 200);
    const tagged = (err) => Object.assign(err, { e2bCode: e.code || undefined });
    if (status === 429 || e.code === 'rate_limited')
      return tagged(fail('rate_limited', 'The E2B API rate-limited the request.', { retryAfterSeconds: Math.max(1, Math.ceil(Number(retryAfter) || 1)) }));
    if (status === 401 || status === 403)
      return tagged(fail('no_key', `The E2B API key was refused (HTTP ${status}). ${api.text.noKeyFix}`));
    if (status === 404 || e.code === 'not_found' || (status === 502 && /not found/i.test(msg))) return tagged(fail('not_found', `E2B: ${msg || 'not found'}`));
    if (status === 402 || ['quota_exceeded', 'insufficient_credits', 'secret_limit_reached'].includes(e.code))
      return tagged(fail('quota_exceeded', `E2B: ${msg || e.code || 'the account limit was reached'}`));
    if (e.code === 'concurrency_limit' || /concurrent sandbox/i.test(e.code))
      return tagged(fail('concurrency_limit', `E2B: ${msg || 'too many sandboxes running at once'}`));
    if (MAX_LEN_RE.test(e.message) || MAX_LEN_RE.test(msg))
      return tagged(fail('ttl_capped', `E2B: ${msg}`));
    if (status >= 500 || ['sandbox_capacity_unavailable', 'sandbox_placement_timeout', 'sandbox_no_compatible_node', 'sandbox_create_failed', 'internal_server_error', 'idempotency_in_progress', 'idempotency_outcome_unknown', 'unavailable'].includes(e.code))
      return tagged(fail('transient', `E2B: ${msg || `HTTP ${status}`}`));
    if (e.code === 'sandbox_create_refused') return tagged(fail('invalid_request', `E2B refused the create: ${msg}`));
    if (status === 400 || status === 413 || status === 422) return tagged(fail('invalid_request', `E2B: ${msg || `HTTP ${status}`}`));
    if (e.code) return tagged(fail(e.code, `E2B: ${msg || e.code}`));
    return tagged(fail('transient', `The E2B API returned HTTP ${status}${msg ? ` (${msg})` : ''}`));
  };

  // One control-plane call; body objects go as JSON. 429 is retried after Retry-After (outside the
  // slot it holds), anything else normalizes once. Errors never echo the key or headers.
  const ctl = async (method, path, body, { headers = {}, tries = 2 } = {}) => {
    const key = apiKey();
    sensitive.add(key);
    for (let n = 1; ; n++) {
      let res;
      try {
        res = await limiter.run(() => fetchFn(`${API}${path}`, {
          method,
          redirect: 'error', // never follow a redirect while a credential header is attached
          headers: { 'X-API-Key': key, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }));
      } catch (e) {
        throw fail('transient', `The E2B API could not be reached (${scrub(e?.message ?? e).replaceAll('\n', ' ')})`);
      }
      if (res.ok) { const t = await res.text().catch(() => ''); try { return { data: JSON.parse(t), res }; } catch { return { data: {}, res }; } }
      const e = await parseErrorBody(res);
      if (res.status === 429 && n < tries) { await sleep(Math.max(500, Math.ceil(Number(res.headers?.get?.('retry-after')) || 1) * 1000)); continue; }
      throw httpError(res.status, e, res.headers?.get?.('retry-after'));
    }
  };

  // One envd call on the shared host: the sandbox and its envd port ride as routing headers,
  // the sandbox's envdAccessToken authenticates as X-Access-Token.
  const envd = async (sb, path, { method = 'POST', body, headers = {}, signal } = {}) => {
    let res;
    try {
      res = await limiter.run(() => fetchFn(`${ENVD_HOST}${path}`, {
        method, signal, redirect: 'error',
        headers: { 'E2b-Sandbox-Id': sb.id, 'E2b-Sandbox-Port': String(ENVD_PORT), 'X-Access-Token': sb.envdToken, ...headers },
        ...(body !== undefined && { body }),
      }));
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw fail('transient', `The E2B sandbox could not be reached (${scrub(e?.message ?? e).replaceAll('\n', ' ')})`);
    }
    return res;
  };

  // Read a Connect server stream into decoded { event, end } objects until the terminal frame
  // (flags & 2). A stream that ends without it returns { dropped: true } so the caller can re-attach.
  const readConnect = async (res, onEvent) => {
    const dec = new TextDecoder();
    let buf = new Uint8Array(0);
    const push = (chunk) => { const b = new Uint8Array(buf.length + chunk.length); b.set(buf); b.set(chunk, buf.length); buf = b; };
    let dropped = false, end = null;
    const drain = () => {
      for (;;) {
        if (buf.length < 5) return;
        const flags = buf[0];
        const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0);
        if (buf.length < 5 + len) return;
        const payload = dec.decode(buf.subarray(5, 5 + len));
        buf = buf.subarray(5 + len);
        if (flags & 2) { try { end = JSON.parse(payload); } catch { end = {}; } return; }
        if (flags & 1) { end = { error: { code: 'internal', message: 'compressed Connect frame is not supported' } }; return; }
        let j;
        try { j = JSON.parse(payload); } catch { j = undefined; }
        onEvent(j);
      }
    };
    try {
      const rd = res.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        push(value instanceof Uint8Array ? value : new Uint8Array(value));
        drain();
        if (end) return { end, dropped: false };
      }
    } catch { dropped = true; }
    if (!end) dropped = true;
    return { end, dropped };
  };

  const connectErr = (e) => {
    const msg = scrub(e?.message ?? '').replaceAll('\n', ' ').slice(0, 200);
    if (e?.code === 'not_found') return fail('not_found', `E2B envd: ${msg || 'not found'}`);
    if (e?.code === 'unauthenticated' || e?.code === 'permission_denied') return fail('transient', `E2B envd refused the sandbox credentials (${e.code})`);
    if (e?.code === 'invalid_argument') return fail('invalid_request', `E2B envd: ${msg}`);
    return fail('transient', `E2B envd: ${msg || e?.code || 'RPC failed'}`);
  };

  const sandbox = (id, envdToken, deleteAt) => {
    sensitive.add(envdToken);
    const sb = { id, envdToken };
    // Past its advertised deadline the sandbox must not serve again: remove it and say not_found.
    const guard = async () => { if (deleteAt && deleteAt <= now()) { await api.delete(id).catch(() => {}); throw fail('not_found', `the E2B sandbox ${id} passed its deleteAt and was removed`); } };
    const run = async (cmd, { cwd, timeoutMs, signal, onStdout } = {}) => {
      await guard();
      const secs = timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0;
      const inner = `set -a; [ ! -f ${ENVFILE} ] || . ${ENVFILE}; set +a; exec ${secs ? `timeout -k 5 ${secs} ` : ''}sh -c ${q(cmd)}`;
      const tag = `cc-${randomBytes(6).toString('hex')}`;
      const start = (path, body, sig) => envd(sb, path, {
        body: frame(body), signal: sig,
        headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1' },
      });
      // An aborted run still finishes the process: SIGKILL by tag (a unary envd call), never by
      // guessing a pid. The request itself gets aborted locally first so the slot frees up.
      const killProc = () => envd(sb, '/process.Process/SendSignal', {
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: JSON.stringify({ process: { tag }, signal: 'SIGNAL_SIGKILL' }),
      }).then((r) => r.text().catch(() => {})).catch(() => {});
      let stdout = '', stderr = '', exitCode, streamed = false;
      const onFrame = (j) => {
        const ev = j?.event;
        if (!ev) return;
        if (typeof ev.start?.pid === 'number') { streamed = true; return; }
        if (ev.data) {
          for (const ch of ['stdout', 'stderr']) {
            if (typeof ev.data[ch] !== 'string') continue;
            const text = Buffer.from(ev.data[ch], 'base64').toString('utf8');
            if (ch === 'stdout') { stdout += text; try { onStdout?.(text); } catch { /* a bad callback must not kill the call */ } }
            else stderr += text;
          }
          return;
        }
        // proto3 JSON omits zero values, so a clean exit arrives as end: { exited: true } with no exitCode.
        if (ev.end) exitCode = typeof ev.end.exitCode === 'number' ? ev.end.exitCode : 0;
      };
      try {
        for (let attach = 0; ; attach++) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const res = attach === 0
            ? await start('/process.Process/Start', { process: { cmd: '/bin/sh', args: ['-c', inner], envs: {}, cwd: cwd || HOME }, stdin: false, tag }, signal)
            : await start('/process.Process/Connect', { process: { tag } }, signal);
          if (!res.ok) {
            const e = await parseErrorBody(res);
            throw httpError(res.status, e);
          }
          const { end, dropped } = await readConnect(res, onFrame);
          if (end?.error) throw connectErr(end.error);
          if (!dropped && end) break; // completed stream
          if (!streamed || attach >= 2) throw fail('transient', 'the E2B command stream ended before the process result arrived');
          // The stream dropped but the tagged process is still running: re-attach by tag.
        }
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) {
          // By tag this is a no-op when the process never started or already ended.
          await killProc();
          throw Object.assign(e?.name === 'AbortError' ? e : new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
        }
        throw e;
      }
      if (exitCode === undefined) throw fail('transient', 'the E2B command stream ended without an exit event', { stdout: scrub(stdout), stderr: scrub(stderr) });
      const r = { stdout, stderr, exitCode };
      if (secs && exitCode === 124) throw fail('timeout', `timed out after ${secs} s`, { stdout: scrub(stdout), stderr: scrub(stderr), exitCode: 124 });
      if (exitCode !== 0) throw Object.assign(new Error(scrub(stderr.trim()).slice(-300) || `exit ${exitCode}`), r);
      return r;
    };
    return {
      id, home: HOME,
      files: {
        async write(path, data) {
          await guard();
          // Raw bytes, octet-stream: no multipart; envd creates the parent directories.
          const res = await envd(sb, `/files?path=${encodeURIComponent(String(path))}&username=user`, {
            headers: { 'Content-Type': 'application/octet-stream' },
            body: typeof data === 'string' ? data : Buffer.from(data),
          });
          if (!res.ok) { const e = await parseErrorBody(res); throw httpError(res.status, e); }
          return true;
        },
        async read(path) {
          await guard();
          const res = await envd(sb, `/files?path=${encodeURIComponent(String(path))}&username=user`, { method: 'GET' });
          if (!res.ok) { const e = await parseErrorBody(res); throw httpError(res.status, e); }
          return Buffer.from(await res.arrayBuffer());
        },
      },
      commands: { run },
      kill: () => api.delete(id),
      loadName: async () => id,
    };
  };

  // Ownership gate for every destructive or privileged call: the sandbox must carry
  // metadata.purpose === 'cloudy-cloud'. Returns the detail record; throws not_found otherwise
  // (e.foreign marks "exists but not ours" so delete can tell it from a plain 404).
  const ownSandbox = async (id) => {
    const { data: d } = await ctl('GET', `/sandboxes/${encodeURIComponent(id)}`);
    if (d?.metadata?.purpose !== 'cloudy-cloud') throw fail('not_found', `No cloudy-cloud E2B sandbox ${id}`, { foreign: true });
    if (d?.envdAccessToken) sensitive.add(d.envdAccessToken);
    if (d?.trafficAccessToken) sensitive.add(d.trafficAccessToken);
    return d;
  };

  // While a handle lives, keep the server timeout ahead of the clock until deleteAt. Each call sets
  // expiry to now+step (step is the timeout the plan accepted), so a lost client still ends it at
  // the last posted expiry. The timer is unref'd: it must never hold a CLI or test process open.
  const armRefresh = (id, deleteAt, step) => {
    if (!step || !deleteAt) return;
    const tick = async () => {
      const left = deleteAt - now();
      if (left <= 0) { clearInterval(timer); await api.delete(id).catch(() => {}); return; }
      await ctl('POST', `/sandboxes/${encodeURIComponent(id)}/timeout`, { timeout: Math.min(Math.ceil(left / 1000), step) })
        .catch((e) => { if (e?.code === 'ttl_capped' && step > 300) step = Math.max(300, Math.floor(step / 2)); });
    };
    const timer = setInterval(tick, Math.max(60_000, Math.min(step * 500, 600_000)));
    timer.unref?.();
  };

  const api = {
    name: 'e2b',
    keyName: KEY_NAME,
    caps: {
      // hasServerTTL: E2B deletes the sandbox when its timeout expires; the refresher only extends it.
      // hasConsentedSecrets is a getter: consent added to the env file applies to the next create.
      hasServerTTL: true, hasProxySecrets: false, get hasConsentedSecrets() { return consented(); }, hasEgressPolicy: true,
      hasSnapshots: false, hasPortForward: false, hasPublish: true, hasSizes: false, hasShell: false,
      hasDisplay: false, hasMetrics: true,
      maxForegroundMs: Infinity, maxTtlSeconds: MAX_TTL_SECONDS, startsPerMin: 30, maxConcurrentCalls: 8,
      uploadMaxBytes: 100 * 1024 * 1024, machineKinds: ['linux'],
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [], image: _ignored, role = labels.role, kind, egress }) {
      if (kind && kind.name !== 'linux') throw fail('machine_kind_unsupported', `e2b runs only linux sandboxes, not ${kind.name}. Use machine "linux".`);
      if (role === 'coordinator') throw new Error(api.text.coordinatorRefusal);
      apiKey(); // no_key before the consent check: the key is required either way
      if (!consented()) throw new Error(`E2B has no proxy secrets, so every worker credential (GH_TOKEN, the Claude credential, profile keys) would be written into the sandbox environment, where anything running in the sandbox could read it.\nTo allow that, add ${CONSENT}=yes to ~/.config/cloudy-cloud/env, then call cloud_agent again.`);

      const ttl = Math.min(Math.max(1, ttlSeconds || MAX_TTL_SECONDS), MAX_TTL_SECONDS);
      const t0 = now();
      const deleteAt = t0 + ttl * 1000;
      const idem = randomUUID();
      const all = { ...labels, purpose: 'cloudy-cloud', ...(role && { role }), ...(name && !labels.name && { name }), ccIdem: idem, deleteAt: new Date(deleteAt).toISOString(), startedAt: new Date(t0).toISOString() };
      for (const [k, v] of Object.entries(all)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`invalid label name "${k}"`);
        if (typeof v === 'string' && /[\r\n]/.test(v)) throw new Error(`invalid label value for "${k}"`);
      }
      const vars = { ...envs };
      // With consent GH_TOKEN goes into the sandbox like the self-hosted provider's; other names in
      // `secrets` are MCP tokens the core asked for after the user allowed that server.
      for (const n of [...new Set(['GH_TOKEN', ...secrets])]) {
        if (env[n] === undefined) throw fail('no_key', `The secret ${n} cannot be put into an E2B sandbox. ${api.text.githubTokenHelp}`);
        vars[n] = env[n];
      }
      for (const n of Object.keys(vars)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid environment variable name "${n}"`);
      for (const v of Object.values(vars)) if (typeof v === 'string') sensitive.add(v); // never let a written value reach an error string

      // The Idempotency-Key makes a dropped answer safe to retry (same key replays the original
      // response); the ccIdem metadata lets a list recover the sandbox when every answer was lost.
      const net = egress?.allow?.length ? { allowOut: egress.allow, denyOut: ['0.0.0.0/0'] } : undefined;
      let created, step = ttl, lastErr;
      for (const want of [ttl, ...TTL_LADDER.filter((s) => s < ttl)]) {
        for (let attempt = 0; ; attempt++) {
          try {
            created = await ctl('POST', '/v2/sandboxes', {
              templateID: TEMPLATE, timeout: want, metadata: all, envVars: vars,
              ...(net && { network: net }),
            }, { headers: { 'Idempotency-Key': `${idem}-${want}` }, tries: 4 }); // one key per rung: E2B refuses a reused key with a different body
            step = want;
            break;
          } catch (e) {
            lastErr = e;
            if (e.code === 'ttl_capped') break; // plan caps the timeout: try the next rung
            if (e.e2bCode === 'idempotency_in_progress' && attempt < 3) { await sleep(3000); continue; }
            if (e.code === 'transient' || e.code === 'rate_limited' || e.e2bCode === 'idempotency_outcome_unknown') {
              const found = await api.list({ ccIdem: idem }).then((rows) => rows[0]).catch(() => null);
              if (found) {
                // The sandbox exists but its create answer was lost: fetch the detail for the envd token.
                created = await ctl('GET', `/sandboxes/${encodeURIComponent(found.id)}`);
                step = want;
              }
            }
            break;
          }
        }
        if (created) break;
        if (lastErr?.code !== 'ttl_capped') break;
      }
      if (!created) throw lastErr;
      const id = created.data.sandboxID;
      const envdToken = created.data.envdAccessToken;
      if (!id || !envdToken) throw fail('transient', 'the E2B create answer carried no sandbox id or envd token');
      try {
        const sb = sandbox(id, envdToken, deleteAt);
        // envd readiness: the create returns once the VM is up, but envd can still be settling.
        for (const deadline = now() + 90_000; ; ) {
          const res = await envd(sb, '/health', { method: 'GET' }).catch(() => null);
          if (res?.status === 204 || res?.ok) break;
          await res?.text?.().catch(() => {});
          if (now() >= deadline) throw fail('transient', 'the E2B sandbox envd did not answer within 90 s');
          await sleep(1500);
        }
        await sb.commands.run(PROVISION, { timeoutMs: 600_000 });
        const envText = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}\n`).join('');
        await sb.files.write(ENVFILE, envText);
        await sb.commands.run(`chmod 600 ${ENVFILE}`);
        armRefresh(id, deleteAt, step);
        return sb;
      } catch (e) {
        await api.delete(id).catch(() => {});
        throw e;
      }
    },

    async connect(id) {
      const d = await ownSandbox(id);
      const deleteAt = Date.parse(d.metadata?.deleteAt ?? '') || Date.parse(d.endAt ?? '') || 0;
      if (deleteAt && deleteAt <= now()) { await api.delete(id); throw fail('not_found', `the E2B sandbox ${id} passed its deleteAt and was removed`); }
      let envdToken = d.envdAccessToken;
      if (d.state === 'paused') {
        // Resume and extend toward the recorded deadline (connect never shortens the expiry).
        const want = Math.min(Math.max(Math.ceil((deleteAt - now()) / 1000), 300), 3600);
        const { data: c } = await ctl('POST', `/v2/sandboxes/${encodeURIComponent(id)}/connect`, { timeout: want }, { tries: 2 });
        envdToken = c?.envdAccessToken ?? envdToken;
        if (c?.envdAccessToken) sensitive.add(c.envdAccessToken);
      }
      if (!envdToken) throw fail('transient', `the E2B sandbox ${id} has no envd access token (state ${d.state ?? 'unknown'})`);
      armRefresh(id, deleteAt, 3600);
      return sandbox(id, envdToken, deleteAt);
    },

    async list(labels = {}, { onError } = {}) {
      const filter = { purpose: 'cloudy-cloud', ...labels };
      const meta = Object.entries(filter).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const rows = [];
      for (let token; ;) {
        const { data, res } = await ctl('GET', `/v2/sandboxes?metadata=${encodeURIComponent(meta)}&limit=100${token ? `&nextToken=${encodeURIComponent(token)}` : ''}`);
        const page = Array.isArray(data) ? data : [];
        for (const m of page) {
          const l = m.metadata ?? {};
          // The server-side filter is a hint: ownership and every requested label are re-checked here.
          if (l.purpose !== 'cloudy-cloud') continue;
          if (!Object.entries(labels).every(([k, v]) => l[k] === v)) continue;
          rows.push({
            id: m.sandboxID, name: l.name ?? m.sandboxID, labels: l, state: m.state, status: STATUS[m.state] ?? 'stopped',
            startedAt: Date.parse(m.startedAt) || 0, deleteAt: m.endAt,
          });
        }
        token = res?.headers?.get?.('x-next-token');
        if (!token || page.length === 0) return rows; // a token without rows must not loop forever
      }
    },

    async delete(id, { retries = 2, log } = {}) {
      try { await ownSandbox(id); } catch (e) { if (e.code === 'not_found' && !e.foreign) return; throw e; }
      for (let attempt = 0; ; attempt++) {
        try {
          await ctl('DELETE', `/sandboxes/${encodeURIComponent(id)}`);
          return;
        } catch (e) {
          if (e.code === 'not_found') return;
          if (attempt >= retries || (e.code !== 'transient' && e.code !== 'rate_limited')) throw e;
          log?.(`delete ${id} failed (${e.message}); retrying`);
          await sleep(500 * (attempt + 1));
        }
      }
    },

    async publishPort(id, port) {
      const p = portOf(port);
      const d = await ownSandbox(id);
      const domain = d.domain || env.E2B_DOMAIN || 'e2b.app';
      // The URL is public by default: anyone who knows it can reach the app while the sandbox lives.
      return { url: `https://${p}-${id}.${domain}` };
    },
    // E2B public URLs exist for as long as the sandbox runs; there is no per-port unpublish call.
    async unpublishPort() { throw new Error('e2b public URLs cannot be unpublished one by one — they stop working when the sandbox is deleted (cloudy-cloud machines stop / cloud_agent_stop).'); },

    async forwardPort() { throw new Error('e2b has no private port tunnel for `cloudy-cloud open`; use --share for a public preview link.'); },

    async metrics(id, { since } = {}) {
      await ownSandbox(id);
      const { data } = await ctl('GET', `/sandboxes/${encodeURIComponent(id)}/metrics`);
      const from = since ?? now() - 3_600_000;
      const samples = (Array.isArray(data) ? data : [])
        .map((m) => ({ t: (m.timestampUnix ?? 0) * 1000, cpuPct: m.cpuUsedPct, cpuCount: m.cpuCount, memUsed: m.memUsed, memTotal: m.memTotal }))
        .filter((s) => s.t >= Math.max(from, now() - 86_400_000))
        .sort((a, b) => a.t - b.t);
      return { samples, fetchedAt: now() };
    },

    async snapshot() { throw new Error('e2b does not support cloudy-cloud snapshots'); },
    async getSnapshot() { throw new Error('e2b does not support cloudy-cloud snapshots'); },
    async displayLink() { throw noDisplay(); },
    async revokeDisplayLinks() { throw noDisplay(); },
    async screenshot() { throw noDisplay(); },
    async plan() { return null; },
    localMachineName: () => '',

    // No SSH: the base image has no sshd and we do not provision one. The envd terminal in the
    // E2B dashboard or `cloudy-cloud open --share` are the ways in. hasShell is false so shellArgv is never called.
    shellArgv() { throw new Error('cloudy-cloud shell is not supported on e2b (no SSH is provisioned); use the sandbox terminal on https://e2b.dev.'); },

    text: {
      ssh: (machine, cmd) => `the sandbox terminal at https://e2b.dev (sandbox: ${machine})${cmd ? `, then run: ${cmd}` : ''}`,
      listMachines: `curl -s -H "X-API-Key: $E2B_API_KEY" 'https://api.e2b.app/v2/sandboxes?metadata=purpose%3Dcloudy-cloud'`,
      noKeyFix: `E2B_API_KEY is not set.\nCreate a key at https://e2b.dev (dashboard -> API Keys), then add\nE2B_API_KEY=<the key> to ~/.config/cloudy-cloud/env.`,
      apiFix: `Check that the E2B API answers:\n  curl -s -H "X-API-Key: $E2B_API_KEY" https://api.e2b.app/v2/sandboxes`,
      githubTokenHelp: `E2B has no proxy secrets, so GH_TOKEN is written into the sandbox environment in plaintext.\nAdd GH_TOKEN=<a token with write access> and ${CONSENT}=yes to ~/.config/cloudy-cloud/env.`,
      hostLabel: 'an E2B sandbox',
      coordinatorRefusal: 'Coordinators are not supported on the e2b provider (a sandbox has no Docker socket for sibling workers). Start workers directly from your own session with cloud_agent.',
    },
  };
  function noDisplay() { return fail('display_unsupported', 'e2b sandboxes have no desktop display. Use the sandbox terminal on https://e2b.dev.'); }
  return api;
}
