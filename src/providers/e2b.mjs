// E2B provider (EXPERIMENTAL): one Firecracker microVM per sandbox on E2B (https://e2b.dev),
// driven over the REST control plane at https://api.e2b.app (OpenAPI: https://docs.e2b.dev)
// and envd inside each sandbox at the shared host https://sandbox.e2b.app.
// Bring-your-own-key: E2B_API_KEY (e2b_...) authenticates every control-plane call; a per-sandbox
// `envdAccessToken` (from POST /v2/sandboxes) authenticates envd as X-Access-Token.
//
// Guards and mappings the adapter enforces:
// - Ownership: sandboxes are created with metadata purpose=cloudy-cloud, this installation's
//   stable install id (installId() — <config>/install-id, shared by every session on this
//   machine), a per-create ccIdem marker and deleteAt. list() filters by metadata server-side
//   and re-checks purpose AND install client-side; delete, connect, metrics and publishPort
//   refuse (not_found) a sandbox that is not ours — a teammate installation's sandboxes are
//   never touched. The per-session `owner` metadata only scopes what the reaper may delete.
// - Server TTL: E2B deletes the sandbox when its timeout expires, so a lost client still ends it
//   (caps.hasServerTTL). caps.maxTtlSeconds advertises the largest plan limit E2B documents (Pro:
//   24 h); create() asks for the requested timeout and walks a ladder (requested -> 3600 -> 300 s)
//   when the plan caps it, so the accepted rung sets the real deadline — stamped into metadata and
//   returned on the handle as deleteAt. A refresher keeps posting
//   POST /sandboxes/{id}/timeout to reach, never exceed, the recorded deadline.
// - Credential values go into the sandbox (create envVars plus a mode-600 env file sourced by
//   every command) only after CLOUDY_CLOUD_E2B_TOKEN_ON_BOX=yes, re-read from the env file right
//   before each credential-bearing POST — a revoked consent stops the dispatch itself.
// - Egress: egress.allow maps to E2B's API-enforced network.allowOut (domains, *.suffix wildcards)
//   with denyOut 0.0.0.0/0, so hasEgressPolicy is true. On a non-base template the provisioning
//   hosts (apt, gh, node, uv, npm) are added; stock base already carries the tools.
// - Commands run through envd's Connect-RPC stream (POST /process.Process/Start, Connect framing);
//   abort signals the process by tag (POST /process.Process/SendSignal). Output is also teed to a
//   per-tag file inside the sandbox, because a dropped stream re-attaches through
//   POST /process.Process/Connect, which only sends NEW data — the file is the whole transcript.
// - Files go through envd's /files upload/download; ANY listening port of a running sandbox is
//   publicly reachable at https://<port>-<id>.e2b.app — anyone with the link can open it, before
//   and after sharing (sharing only hands out the URL; there is no per-port unpublish).
// Coordinators are refused: a sandbox has no Docker socket for sibling workers.
import { randomBytes, randomUUID } from 'node:crypto';
import { createLimiter } from '../limits.mjs';
import { installId, savedEnv } from '../config.mjs';

const KEY_NAME = 'E2B_API_KEY';
const CONSENT = 'CLOUDY_CLOUD_E2B_TOKEN_ON_BOX';
const HOME = '/home/user'; // the base template's default user
const ENVFILE = '/home/user/.cloudy-cloud-env'; // consented credential values live here too (mode 600)
const API = 'https://api.e2b.app'; // fixed: a configurable base could redirect the API key and consented values
const ENVD_HOST = 'https://sandbox.e2b.app';
const ENVD_PORT = 49983;
// The largest sandbox timeout any E2B plan documents — Pro allows a 24 h continuous lifetime,
// Enterprise more. It is the advertised cap (caps.maxTtlSeconds): the request itself is never
// clamped to a learned plan limit up front; the create ladder finds what the plan accepts.
const MAX_TTL_SECONDS = 86400;
// The one-hour continuous lifetime the E2B Hobby plan enforces; a create the plan answers with a
// wider timeout teaches the adapter the real ceiling (learnedMax below) for resume/refresh budgets.
const DEFAULT_MAX_TTL_SECONDS = 3600;
const TTL_LADDER = [3600, 300]; // fallbacks when the plan caps the requested timeout
// Hosts a non-base template may still need for provisioning (apt, gh, node, uv, the claude npm
// package). The stock base template already carries every tool, so they are added only there.
const PROVISION_HOSTS = ['deb.debian.org', 'security.debian.org', 'cli.github.com', 'deb.nodesource.com', 'astral.sh', 'registry.npmjs.org'];
const MAX_LEN_RE = /max(imum)? (instance|sandbox).*(length|duration|timeout)|timeout cannot be (greater|longer|more) than/i; // live API: 'Timeout cannot be greater than 1 hours'
const STATUS = { running: 'running', paused: 'stopped' };
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const cleanupUnconfirmed = (id) => fail('cleanup_unconfirmed', `E2B sandbox ${id} failed setup and cleanup could not be confirmed; refusing to use it or start another provider.`, { provider: 'e2b', machineId: id, allocated: true });
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
  // The widest sandbox timeout this account has accepted, starting at the Hobby plan's one-hour
  // continuous-lifetime cap — it budgets resume/refresh asks, never the advertised cap or the request.
  let learnedMax = DEFAULT_MAX_TTL_SECONDS;
  // The real environment (injectable in tests). Consent is re-read at every create — a value
  // exported here consents and an explicit one wins over the file, but the env OBJECT this
  // provider was built with is never trusted: the server shares it and refreshes it from the
  // file, so only a fresh savedEnv() read sees a revoked line before the credential POST.
  const baseEnv = deps.baseEnv ?? process.env;
  const consented = () => (baseEnv[CONSENT] || savedEnv(env)[CONSENT]) === 'yes';
  const createdIds = new Set(); // ids this process created — ours whatever their metadata says now
  // Ours = our purpose metadata AND this installation's id (or an id we created this run). The
  // per-session owner metadata is NOT an ownership proof: a second session must still see the
  // first session's workers, and only the reaper scopes deletions by it.
  const ours = (meta, id) => meta?.purpose === 'cloudy-cloud' && (meta.install === installId(env) || createdIds.has(id));
  const apiKey = () => {
    if (!env[KEY_NAME]) throw fail('no_key', api.text.noKeyFix, { local: true });
    return env[KEY_NAME];
  };
  // Every secret-shaped string that could ride a request or a response: scrubbed from any error
  // text before it is shown. Seed from the env's credential-named values now, then add the API key,
  // the envd token and each consented value as they are written onto a sandbox.
  const SECRETISH = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;
  const sensitive = new Set(Object.entries(env).filter(([k, v]) => SECRETISH.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v));
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
  const ctl = async (method, path, body, { headers = {}, tries = 2, signal, before } = {}) => {
    const key = apiKey();
    sensitive.add(key);
    for (let n = 1; ; n++) {
      // `before` runs inside the slot: a consent revoked while the call waited on the limiter
      // stops the credential-bearing POST itself — on every attempt, retries included.
      const res = await limiter.run(async () => {
        before?.();
        try {
          return await fetchFn(`${API}${path}`, {
            method,
            signal,
            redirect: 'error', // never follow a redirect while a credential header is attached
            headers: { 'X-API-Key': key, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
            ...(body !== undefined && { body: JSON.stringify(body) }),
          });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          throw fail('transient', `The E2B API could not be reached (${scrub(e?.message ?? e).replaceAll('\n', ' ')})`);
        }
      });
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
    const files = {
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
    };
    const run = async (cmd, { cwd, timeoutMs, signal, onStdout } = {}) => {
      await guard();
      const secs = timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0;
      const tag = `cc-${randomBytes(6).toString('hex')}`;
      // Each stream is also teed to a per-tag file inside the sandbox: envd's Process/Connect only
      // ever sends NEW data, so after a dropped stream the file is the only complete transcript.
      // The fd swap pipes stderr through one tee and stdout through the other, and bash's pipefail
      // keeps the command's exit code. The transcripts are created private in a subshell first, so the
      // command itself keeps the normal umask (a global umask 077 made `sudo npm install -g` files root-only).
      const ioOut = `${HOME}/.cc-io-${tag}.out`, ioErr = `${HOME}/.cc-io-${tag}.err`;
      const pipeline = `{ sh -c ${q(cmd)} 2>&1 1>&3 | tee ${q(ioErr)} >&2; } 3>&1 | tee ${q(ioOut)}`;
      const inner = `set -a; [ ! -f ${ENVFILE} ] || . ${ENVFILE}; set +a; (umask 077; : > ${q(ioOut)}; : > ${q(ioErr)}); exec ${secs ? `timeout -k 5 ${secs} ` : ''}bash -o pipefail -c ${q(pipeline)}`;
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
      let stdout = '', stderr = '', exitCode, streamed = false, reattached = false;
      // envd event boundaries do not respect UTF-8 character boundaries, so each stream gets its
      // own streaming decoder — a multibyte character split across events decodes whole.
      const utf8 = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      const onFrame = (j) => {
        const ev = j?.event;
        if (!ev) return;
        if (typeof ev.start?.pid === 'number') { streamed = true; return; }
        if (ev.data) {
          for (const ch of ['stdout', 'stderr']) {
            if (typeof ev.data[ch] !== 'string') continue;
            const text = utf8[ch].decode(Buffer.from(ev.data[ch], 'base64'), { stream: true });
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
          reattached = true; // the stream dropped: output emitted in the gap never replays on envd
        }
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) {
          // By tag this is a no-op when the process never started or already ended.
          await killProc();
          throw Object.assign(e?.name === 'AbortError' ? e : new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
        }
        throw e;
      }
      if (reattached) {
        // The reconnect stream reported only events after it: the tee'd files hold the whole run,
        // so the partial transcript is never returned as complete.
        try {
          const [outB, errB] = await Promise.all([files.read(ioOut), files.read(ioErr)]);
          const full = outB.toString('utf8');
          const delta = full.startsWith(stdout) ? full.slice(stdout.length) : full;
          if (delta) { try { onStdout?.(delta); } catch { /* a bad callback must not kill the call */ } }
          stdout = full;
          stderr = errB.toString('utf8');
        } catch (e) {
          throw fail('transient', `the E2B command stream dropped and its output could not be read back (${scrub(e?.message ?? e)})`, { stdout: scrub(stdout), stderr: scrub(stderr) });
        }
      } else {
        // Flush the decoders' pending bytes: a character the stream left incomplete still decodes.
        const tailOut = utf8.stdout.decode(), tailErr = utf8.stderr.decode();
        if (tailOut) { stdout += tailOut; try { onStdout?.(tailOut); } catch { /* a bad callback must not kill the call */ } }
        stderr += tailErr;
      }
      if (exitCode === undefined) throw fail('transient', 'the E2B command stream ended without an exit event', { stdout: scrub(stdout), stderr: scrub(stderr) });
      if (secs && exitCode === 124) throw fail('timeout', `timed out after ${secs} s`, { stdout: scrub(stdout), stderr: scrub(stderr), exitCode: 124 });
      // A caller that consumes error.stderr must never receive a raw credential value either.
      if (exitCode !== 0) throw Object.assign(new Error(scrub(stderr.trim()).slice(-300) || `exit ${exitCode}`), { stdout: scrub(stdout), stderr: scrub(stderr), exitCode });
      return { stdout, stderr, exitCode };
    };
    return { id, home: HOME, deleteAt, files, commands: { run }, kill: () => api.delete(id), loadName: async () => id };
  };

  // Ownership gate for every destructive or privileged call: our purpose metadata AND this
  // installation's stable install id — a same-purpose sandbox a teammate's installation runs is
  // foreign. Returns the detail record; throws not_found otherwise (e.foreign marks "exists but
  // not ours" so delete can tell it from a plain 404).
  const ownSandbox = async (id) => {
    const { data: d } = await ctl('GET', `/sandboxes/${encodeURIComponent(id)}`);
    if (!ours(d?.metadata, id)) throw fail('not_found', `No cloudy-cloud E2B sandbox ${id} owned by this installation`, { foreign: true });
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
      // hasSudo: the base template's user has passwordless sudo (the provisioning script relies
      // on `sudo -n`), so CLOUDY_CLOUD_APT_PACKAGES can install on the stock image.
      hasServerTTL: true, hasProxySecrets: false, hasSudo: true, get hasConsentedSecrets() { return consented(); }, hasEgressPolicy: true,
      hasSnapshots: false, hasPortForward: false, hasPublish: true, hasSizes: false, hasShell: false,
      hasDisplay: false, hasMetrics: true,
      maxForegroundMs: Infinity, maxTtlSeconds: MAX_TTL_SECONDS, startsPerMin: 30, maxConcurrentCalls: 8,
      uploadMaxBytes: 100 * 1024 * 1024, machineKinds: ['linux'],
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [], image: _ignored, role = labels.role, kind, egress, signal }) {
      if (kind && kind.name !== 'linux') throw fail('machine_kind_unsupported', `e2b runs only linux sandboxes, not ${kind.name}. Use machine "linux".`);
      if (role === 'coordinator') throw new Error(api.text.coordinatorRefusal);
      apiKey(); // no_key before the consent check: the key is required either way
      if (!consented()) throw new Error(`This adapter writes every worker credential (GH_TOKEN, the Claude credential, profile keys) into each sandbox's environment, where anything running in the sandbox could read it.\nTo allow that, add ${CONSENT}=yes to ~/.config/cloudy-cloud/env, then call cloud_agent again.`);
      signal?.throwIfAborted?.();

      const ttl = Math.min(Math.max(1, ttlSeconds || MAX_TTL_SECONDS), MAX_TTL_SECONDS);
      const t0 = now();
      const idem = randomUUID();
      const all = { ...labels, purpose: 'cloudy-cloud', install: installId(env), ...(role && { role }), ...(name && !labels.name && { name }), ccIdem: idem, startedAt: new Date(t0).toISOString() };
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
      const template = env.E2B_TEMPLATE || 'base';
      // The stock base image already carries git/gh/node/claude/tmux/uv, so its installs are
      // skipped and it needs no extra egress. A custom template only gets the provisioning hosts.
      const provisionHosts = template === 'base' ? [] : PROVISION_HOSTS;
      const net = egress?.allow?.length ? { allowOut: [...new Set([...egress.allow, ...provisionHosts])], denyOut: ['0.0.0.0/0'] } : undefined;

      // A create answer can be lost after the sandbox exists (dropped connection, truncated body).
      // The ccIdem label identifies OUR copy — ambiguous copies (forks share the labels) are
      // deleted rather than adopted, and a list that cannot be answered surfaces the first error.
      const recover = async () => {
        let found;
        try {
          found = await api.list({ ccIdem: idem });
        } catch { /* the first list often dies with the same blip that ate the answer; retry once */ found = await api.list({ ccIdem: idem }).catch(() => []); }
        const match = found.filter((r) => ours(r.labels, r.id) && r.labels.ccIdem === idem);
        if (match.length > 1) {
          await Promise.allSettled(match.map((r) => ctl('DELETE', `/sandboxes/${encodeURIComponent(r.id)}`)));
          throw fail('ambiguous', `${match.length} E2B sandboxes share idempotency marker ${idem} (a fork copies every label) — deleted rather than adopted`);
        }
        return match[0]?.id;
      };

      let created, step = ttl, lastErr;
      // The fresh file read runs inside ctl before every credential-bearing POST, so a consent the
      // user pulled while this create waited on a retry or a queue slot stops the dispatch itself.
      const stillConsented = () => { if (!consented()) throw new Error(`Consent for E2B was revoked while this create was queued.\nAdd ${CONSENT}=yes to ~/.config/cloudy-cloud/env, then call cloud_agent again.`); };
      for (const want of [ttl, ...TTL_LADDER.filter((s) => s < ttl)]) {
        all.deleteAt = new Date(t0 + want * 1000).toISOString(); // stamped from the rung, not the request
        for (let attempt = 0; ; attempt++) {
          try {
            created = await ctl('POST', '/v2/sandboxes', {
              templateID: template, timeout: want, metadata: all, envVars: vars,
              ...(net && { network: net }),
            }, { headers: { 'Idempotency-Key': `${idem}-${want}` }, tries: 4, signal, before: stillConsented }); // one key per rung: E2B refuses a reused key with a different body
            step = want;
            if (want > learnedMax) learnedMax = want; // the plan accepted more than the Hobby hour
            break;
          } catch (e) {
            lastErr = e;
            if (e?.name === 'AbortError' || signal?.aborted) {
              // The POST may have landed before its answer was lost: the sandbox our ccIdem labels
              // can exist. Recover it by that marker (fresh calls, never the aborted signal) and
              // delete whatever it created — an aborted create must not leave an orphan running.
              const lostId = await recover().catch(() => undefined);
              if (lostId) {
                try { await api.delete(lostId); } catch { throw cleanupUnconfirmed(lostId); }
              }
              throw e?.name === 'AbortError' ? e : Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            if (e.code === 'ttl_capped') break; // plan caps the timeout: try the next rung
            if (e.e2bCode === 'idempotency_in_progress' && attempt < 3) { await sleep(3000); continue; }
            if (e.code === 'transient' || e.code === 'rate_limited' || e.e2bCode === 'idempotency_outcome_unknown') {
              const lostId = await recover(); // a sandbox OUR ccIdem labels, or none
              if (lostId) {
                // The sandbox exists but its create answer was lost: fetch the detail for the envd token.
                created = await ctl('GET', `/sandboxes/${encodeURIComponent(lostId)}`);
                step = want;
                if (want > learnedMax) learnedMax = want;
              }
            }
            break;
          }
        }
        if (created) break;
        if (lastErr?.code !== 'ttl_capped') break;
      }
      if (!created) throw lastErr;
      const deleteAt = t0 + step * 1000; // the deadline the plan actually accepted, not the requested one
      let id = created.data.sandboxID, envdToken = created.data.envdAccessToken;
      if (!id) {
        // The answer was OK on the wire but its body arrived cut (or empty): the sandbox our
        // ccIdem labels may still exist. Recover it by that label before giving up.
        const lostId = await recover();
        if (lostId) ({ data: { sandboxID: id, envdAccessToken: envdToken } } = await ctl('GET', `/sandboxes/${encodeURIComponent(lostId)}`));
        if (!id) throw fail('transient', 'the E2B create answer carried no sandbox id or envd token');
      }
      if (!envdToken) {
        try { await api.delete(id); } catch { throw cleanupUnconfirmed(id); }
        throw fail('transient', 'the E2B create answer carried no envd access token');
      }
      createdIds.add(id);
      try {
        const sb = sandbox(id, envdToken, deleteAt);
        // envd readiness: the create returns once the VM is up, but envd can still be settling.
        for (const deadline = now() + 90_000; ; ) {
          signal?.throwIfAborted?.();
          const res = await envd(sb, '/health', { method: 'GET', signal }).catch((e) => { if (e?.name === 'AbortError') throw e; return null; });
          if (res?.status === 204 || res?.ok) break;
          await res?.text?.().catch(() => {});
          if (now() >= deadline) throw fail('transient', 'the E2B sandbox envd did not answer within 90 s');
          await sleep(1500);
        }
        await sb.commands.run(PROVISION, { timeoutMs: 600_000, signal });
        // The env file must exist private BEFORE the values land: create it at mode 600, write
        // through the still-empty file, then enforce and verify the mode — a sandbox whose umask
        // or envd made it world-readable fails the create instead of keeping loose credentials.
        const envText = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}\n`).join('');
        await sb.commands.run(`install -m 600 /dev/null ${q(ENVFILE)}`, { signal });
        await sb.files.write(ENVFILE, envText);
        const mode = (await sb.commands.run(`chmod 600 ${q(ENVFILE)} && stat -c %a ${q(ENVFILE)}`, { signal })).stdout.trim();
        if (mode !== '600') throw fail('provision_failed', `${ENVFILE} is mode ${mode}, not 600 — refusing to keep credentials in a readable file`);
        armRefresh(id, deleteAt, step);
        return sb;
      } catch (e) {
        try { await api.delete(id); } catch { throw cleanupUnconfirmed(id); }
        throw e;
      }
    },

    async connect(id) {
      const d = await ownSandbox(id);
      const deleteAt = Date.parse(d.metadata?.deleteAt ?? '') || Date.parse(d.endAt ?? '') || 0;
      if (deleteAt && deleteAt <= now()) { await api.delete(id); throw fail('not_found', `the E2B sandbox ${id} passed its deleteAt and was removed`); }
      let envdToken = d.envdAccessToken;
      if (d.state === 'paused') {
        // Resume with only the life it actually has left: the timeout extends expiry to now+want,
        // so asking for the floor (300) when deleteAt is sooner would run past the deadline.
        const want = Math.min(Math.max(Math.ceil((deleteAt - now()) / 1000), 1), learnedMax);
        const { data: c } = await ctl('POST', `/v2/sandboxes/${encodeURIComponent(id)}/connect`, { timeout: want }, { tries: 2 });
        envdToken = c?.envdAccessToken ?? envdToken;
        if (c?.envdAccessToken) sensitive.add(c.envdAccessToken);
      }
      if (!envdToken) throw fail('transient', `the E2B sandbox ${id} has no envd access token (state ${d.state ?? 'unknown'})`);
      armRefresh(id, deleteAt, learnedMax); // each tick posts min(left, step): never past deleteAt
      return sandbox(id, envdToken, deleteAt);
    },

    async list(labels = {}, { onError } = {}) {
      // The server-side filter asks for purpose + this installation's id (an explicit caller
      // label like the reaper's owner narrows it further); ownership is re-checked below anyway.
      const filter = { purpose: 'cloudy-cloud', install: installId(env), ...labels };
      const meta = Object.entries(filter).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const rows = [];
      for (let token; ;) {
        const { data, res } = await ctl('GET', `/v2/sandboxes?metadata=${encodeURIComponent(meta)}&limit=100${token ? `&nextToken=${encodeURIComponent(token)}` : ''}`);
        const page = Array.isArray(data) ? data : [];
        for (const m of page) {
          const l = m.metadata ?? {};
          // The server-side filter is a hint: ownership and every requested label are re-checked here.
          if (!ours(l, m.sandboxID)) continue;
          if (!Object.entries(labels).every(([k, v]) => l[k] === v)) continue;
          rows.push({
            id: m.sandboxID, name: l.name ?? m.sandboxID, labels: l, state: m.state, status: STATUS[m.state] ?? 'stopped',
            startedAt: Date.parse(m.startedAt) || 0, archiveAt: Date.parse(m.endAt) || 0,
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
      await ownSandbox(id);
      // The preview host is fixed e2b.app: a configurable domain could point a credential-bearing
      // URL at an attacker's endpoint. Public by design — anyone with the link reaches a listening
      // port whether or not it was ever shared, and no per-port unpublish exists.
      return { url: `https://${p}-${id}.e2b.app` };
    },
    // E2B public URLs exist for as long as the sandbox runs; there is no per-port unpublish call.
    async unpublishPort() { throw new Error('e2b public URLs cannot be unpublished one by one — they stop working when the sandbox is deleted (cloudy-cloud machines stop / cloud_agent_stop).'); },

    async forwardPort() { throw new Error('e2b has no private port tunnel for `cloudy-cloud open` — any port the app listens on is already publicly reachable at https://<port>-<id>.e2b.app; use --share to get the link.'); },

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
      listMachines: `echo 'header = "X-API-Key: '"$E2B_API_KEY"'"' | curl -s -K - 'https://api.e2b.app/v2/sandboxes?metadata=purpose%3Dcloudy-cloud'`,
      noKeyFix: `E2B_API_KEY is not set.\nCreate a key at https://e2b.dev (dashboard -> API Keys), then add\nE2B_API_KEY=<the key> to ~/.config/cloudy-cloud/env.`,
      apiFix: `Check that the E2B API answers:\n  echo 'header = "X-API-Key: '"$E2B_API_KEY"'"' | curl -s -K - https://api.e2b.app/v2/sandboxes\n(the key goes to curl on stdin, never in argv — the expanded value must not reach a process list or log).`,
      githubTokenHelp: `This adapter writes GH_TOKEN into the sandbox environment in plaintext.\nAdd GH_TOKEN=<a token with write access> and ${CONSENT}=yes to ~/.config/cloudy-cloud/env.`,
      hostLabel: 'an E2B sandbox',
      coordinatorRefusal: 'Coordinators are not supported on the e2b provider (a sandbox has no Docker socket for sibling workers). Start workers directly from your own session with cloud_agent.',
    },
  };
  function noDisplay() { return fail('display_unsupported', 'e2b sandboxes have no desktop display. Use the sandbox terminal on https://e2b.dev.'); }
  return api;
}
