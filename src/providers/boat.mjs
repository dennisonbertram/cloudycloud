// Boat provider: one persistent Ubuntu VM per sandbox on Boat (https://boat.dev), driven
// over the REST API at https://boat.dev/api/v1 (docs: https://docs.boat.dev — plain fetch,
// no SDK). BOAT_API_KEY (boat_...) is a bearer token on every call; BOAT_API_BASE overrides
// the base URL (tests only).
//
// Guards the adapter enforces:
// - Ownership: an organization key lists OTHER people's sandboxes too, so every sandbox is
//   created with label purpose=cloudy-cloud, list() asks the server for that label AND
//   re-checks it client-side on every row, and connect/delete/publishPort refuse (code
//   not_found) any sandbox whose labels lack it. A foreign sandbox is never touched.
// - Lifetime: ttlSeconds is Boat's server-side auto-stop, so caps.hasServerTTL is true and
//   a lost client still stops the machine. snapshots:false erases the disk on stop instead
//   of keeping it 14 days; kill()/delete() permanently deletes the sandbox (DELETE +
//   X-Ascii-Confirm-Delete header), it never merely stops it.
// - Credentials: real token VALUES go on the VM — the env file /home/user/.cloudy-cloud-env
//   (mode 600, written through the create `files` field so it lands before `ready`, sourced
//   by every command) — only after the user opts in with
//   CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX=yes, the same consent shape as self-hosted. create()
//   refuses before any HTTP call without it, and consent is read again on every create.
//   noEnv:true also keeps the account's own secrets off the worker, and
//   visibility:private keeps other organization members out.
// - No egress API: egress allow lists are refused (egress_unsupported). Coordinators are
//   refused: a Boat worker is not expected to start sibling machines for a session.
// - No server shell/private tunnel: hasShell and hasPortForward are false; previews
//   (publishPort) are token-gated public HTTPS URLs via POST /sandboxes/{id}/host.
// Commands run detached and are polled (GET .../commands/{processId} with byte offsets),
// so long-running work is not bound by the 600 s synchronous cap and abort/timeout kills
// the process with DELETE .../commands/{processId} (SIGTERM, then SIGKILL after 5 s).
import { randomBytes, randomUUID } from 'node:crypto';
import { createLimiter } from '../limits.mjs';

const API = 'https://boat.dev/api/v1';
const KEY_NAME = 'BOAT_API_KEY';
const CONSENT = 'CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX';
const HOME = '/home/user';
const ENVFILE = `${HOME}/.cloudy-cloud-env`; // consented credential values live here on the VM (mode 600)
const READY = new Set(['ready', 'idle', 'running']);
const STARTING = new Set(['init', 'provisioning', 'provisioned', 'cloning']);
const STATUS = { init: 'starting', provisioning: 'starting', provisioned: 'starting', cloning: 'starting', ready: 'running', idle: 'running', running: 'running', archiving: 'stopped', archived: 'stopped', error: 'failed', cancelled: 'failed' };
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const portOf = (port) => {
  const p = String(port);
  if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new Error(`port must be a number from 1 to 65535, not "${p.slice(0, 30)}"`);
  return Number(p);
};
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote, inside the VM's shell

// One idempotent install run (marker file exits at once on a rerun), mirroring
// docker/worker.Dockerfile. A Boat VM already carries git/gh/node/claude/uv, so this is
// usually a fast no-op that also locks the env file down.
const PROVISION = `set -eu
MARK="$HOME/.cc-provisioned-v1"
[ -f "$MARK" ] && exit 0
have() { command -v "$1" >/dev/null 2>&1; }
export DEBIAN_FRONTEND=noninteractive
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"
if ! have git || ! have tmux || ! have curl || ! have python3; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends git tmux curl ca-certificates python3 openssh-client
fi
if ! have gh; then
  have gpg || { $SUDO apt-get update -qq; $SUDO apt-get install -y -qq --no-install-recommends gnupg; }
  $SUDO mkdir -p /usr/share/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$($SUDO dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends gh
fi
if ! have node; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y -qq --no-install-recommends nodejs
fi
have uv || curl -fsSL "https://astral.sh/uv/0.5.14/install.sh" | $SUDO env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
have claude || $SUDO npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.322
chmod 600 "$HOME/.cloudy-cloud-env" 2>/dev/null || true
touch "$MARK"`;

export function createProvider(env = process.env, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const limiter = deps.limiter ?? createLimiter(8);
  const base = String(env.BOAT_API_BASE || API).replace(/\/+$/, '');
  const maxTtlSeconds = 86400;
  const consented = () => env[CONSENT] === 'yes';
  const apiKey = () => {
    if (!env[KEY_NAME]) throw fail('no_key', api.text.noKeyFix);
    return env[KEY_NAME];
  };
  // Every secret-shaped string that could ride a request: scrubbed from any error text before
  // it is shown. Seed from the env's credential-named values now (a list() can fail before any
  // create), then add each consented value as it is written onto a sandbox.
  const SECRETISH = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;
  const sensitive = new Set(Object.entries(env).filter(([k, v]) => SECRETISH.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v));
  const scrub = (s) => [...sensitive].reduce((t, v) => (typeof v === 'string' && v.length >= 8 ? t.split(v).join('<redacted>') : t), String(s));

  // ---- HTTP ----
  // Errors use the documented envelope {ok:false, status, code, message, error:{code,message,details}}.
  const httpError = (status, j, raw, retryAfter) => {
    const e = j?.error && typeof j.error === 'object' ? j.error : {};
    const code = String(e.code ?? j?.code ?? '');
    const msg = scrub(String(e.message ?? j?.message ?? raw)).replaceAll('\n', ' ').slice(0, 200);
    const wait = e.details?.retryAfterSeconds ?? j?.retryAfterSeconds ?? j?.retryAfter ?? e.details?.retryAfter ?? (Number(retryAfter) || undefined);
    const retry = { ...(wait !== undefined && { retryAfterSeconds: Math.max(1, Math.ceil(wait)) }) };
    if (status === 401) return fail('no_key', `The Boat API key was refused (HTTP 401). ${api.text.noKeyFix}`);
    if (status === 429) {
      if (['limit_reached', 'member_limit_reached'].includes(code)) return fail('concurrency_limit', `Boat: ${msg || 'too many sandboxes at once'}`, retry);
      if (code === 'trial_compute_limit_reached') return fail('quota_exceeded', `Boat: ${msg || 'the trial compute limit is full'}`, retry);
      return fail('rate_limited', `Boat rate-limited the request${msg ? ` (${msg})` : ''}`, retry);
    }
    if (status === 402) return fail('quota_exceeded', `Boat: ${msg || code || 'billing is required'}`);
    if (status === 403) {
      if (['machine_class_plan_required', 'trial_machine_class_not_allowed'].includes(code)) return fail('size_not_allowed', `Boat: ${msg || 'this machine size needs a higher plan'}`);
      return fail('forbidden', `Boat: ${msg || 'forbidden (HTTP 403)'}`);
    }
    if (status === 404) return fail('not_found', `Boat: ${msg || 'not found'}`);
    if (status === 409) {
      // sandbox_starting is documented as retryable ("retry every few seconds"); the other two
      // mean the machine cannot run commands at all, which for a cloudy-cloud worker is "gone".
      if (['sandbox_starting', 'boat_starting'].includes(code)) return fail('sandbox_starting', `Boat: ${msg || 'the sandbox is still starting'}`, { retryable: true });
      if (['sandbox_not_ready', 'machine_not_running', 'snapshot_data_expired'].includes(code)) return fail('not_found', `Boat: ${msg || code}`);
      if (code === 'idempotency_in_progress') return fail('transient', `Boat: ${msg || 'another request holds this idempotency key'}`, retry);
      if (['agent_outdated', 'monitoring_off'].includes(code)) return fail(code, `Boat: ${msg || code}`);
      return fail(code || 'conflict', `Boat: ${msg || 'HTTP 409'}`);
    }
    if (status === 502) return fail('transient', `Boat: ${msg || 'the sandbox did not complete the call'}`, { retryable: e.details?.retryable === true });
    if (status === 503 || status >= 500) return fail('transient', `Boat: ${msg || `HTTP ${status}`}`, retry);
    if (status === 400 || status === 413) {
      if (code === 'machine_not_running') return fail('not_found', `Boat: ${msg || code}`);
      return fail(code || 'invalid_request', `Boat: ${msg || `HTTP ${status}`}`);
    }
    return fail(code || 'transient', `Boat: ${msg || `HTTP ${status}`}`);
  };

  // One control-plane call. `retry` auto-retries rate_limited/transient failures — only for
  // operations that are safe to replay (GETs, deletes, the idempotent host call, and POST
  // /sandboxes behind an Idempotency-Key). A command start is NEVER retried automatically:
  // a lost answer can mean the command already ran.
  const ctl = async (method, path, body, { signal, idem, retry = true, headers = {} } = {}) => {
    const key = apiKey(); // no_key must surface as no_key, not be wrapped into transient below
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await limiter.run(() => fetchFn(`${base}${path}`, {
          method, signal, redirect: 'error', // never follow a redirect while a credential header is attached
          headers: { Authorization: `Bearer ${key}`, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(idem && { 'Idempotency-Key': idem }), ...headers },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }));
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (retry && attempt < 3) { await sleep(300 * (attempt + 1)); continue; }
        throw fail('transient', `The Boat API could not be reached (${scrub(e?.message ?? e).replaceAll('\n', ' ')})`);
      }
      const t = await res.text().catch(() => '');
      if (res.ok) { try { return JSON.parse(t); } catch { return {}; } }
      let j = {};
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      const err = httpError(res.status, j, t, res.headers?.get?.('retry-after'));
      if (retry && ['rate_limited', 'concurrency_limit', 'transient'].includes(err.code) && attempt < 3) {
        await sleep((err.retryAfterSeconds ?? 1) * 1000);
        continue;
      }
      throw err;
    }
  };

  const getSandbox = (id) => ctl('GET', `/sandboxes/${encodeURIComponent(id)}`);
  // Fetch + ownership check in one: a sandbox without our label is not ours, whatever the id.
  const owned = async (id) => {
    const rec = (await getSandbox(id))?.sandbox;
    if (rec?.labels?.purpose !== 'cloudy-cloud') throw fail('not_found', `No cloudy-cloud boat sandbox ${id}`);
    return rec;
  };

  const sandbox = (id, rec) => {
    // A foreground command, run detached and polled with byte offsets so output streams and the
    // 600 s synchronous cap does not apply. The process is killed with DELETE on timeout/abort.
    const run = async (cmd, { cwd, timeoutMs, signal, onStdout } = {}) => {
      const inner = `set -a; [ ! -f ${ENVFILE} ] || . ${ENVFILE}; set +a; ${cwd ? `cd -- ${q(cwd)} && ` : ''}exec bash -c ${q(cmd)}`;
      let started;
      // A command sent while the sandbox starts waits server-side up to 60 s; the 409
      // sandbox_starting answer is documented retryable (the command provably never ran).
      for (const until = now() + 90_000; ; ) {
        try {
          started = await ctl('POST', `/sandboxes/${encodeURIComponent(id)}/commands`, { command: inner, detached: true }, { signal, retry: false });
          break;
        } catch (e) {
          if (e.code === 'sandbox_starting' && now() < until) { await sleep(3000); continue; }
          throw e;
        }
      }
      const pid = started?.processId;
      if (pid == null) throw fail('transient', 'the Boat command start answer carried no processId');
      const statusUrl = `/sandboxes/${encodeURIComponent(id)}/commands/${encodeURIComponent(pid)}`;
      const stop = () => ctl('DELETE', statusUrl).catch(() => {});
      let stdout = '', stderr = '';
      const deadline = timeoutMs > 0 ? now() + timeoutMs : Infinity;
      const out = (exitCode) => ({ stdout: scrub(stdout), stderr: scrub(stderr), ...(typeof exitCode === 'number' ? { exitCode } : {}) });
      const aborted = () => { const a = new Error('aborted'); a.name = 'AbortError'; return a; };
      const finish = (st) => {
        const r = { stdout, stderr, exitCode: typeof st.exitCode === 'number' ? st.exitCode : st.status === 'exited' ? 0 : 1 };
        if (r.exitCode !== 0) throw Object.assign(new Error(scrub(stderr.trim()).slice(-300) || `exit ${r.exitCode}`), out(r.exitCode));
        return r;
      };
      const poll = async (useOffsets) => {
        let outOff = 0, errOff = 0;
        for (;;) {
          if (signal?.aborted) { await stop(); throw aborted(); }
          let st;
          try {
            st = await ctl('GET', `${statusUrl}${useOffsets ? `?stdoutOffset=${outOff}&stderrOffset=${errOff}` : ''}`, undefined, { signal });
          } catch (e) {
            if (useOffsets && e.code === 'agent_outdated') return poll(false); // agent too old for offsets: take whole tails instead
            throw e;
          }
          const so = typeof st.stdout === 'string' ? st.stdout : '';
          const se = typeof st.stderr === 'string' ? st.stderr : '';
          if (useOffsets) {
            if (so) { stdout += so; try { onStdout?.(so); } catch { /* a bad callback must not kill the call */ } }
            if (se) stderr += se;
            outOff = st.stdoutNextOffset ?? outOff + Buffer.byteLength(so);
            errOff = st.stderrNextOffset ?? errOff + Buffer.byteLength(se);
          } else { // no offsets: the answer is the tail of each log — deliver only the new tail
            if (so.length > stdout.length) { const add = so.slice(stdout.length); stdout = so; if (add) try { onStdout?.(add); } catch { /* a bad callback must not kill the call */ } }
            if (se.length > stderr.length) stderr = se;
          }
          if (st.running === false || ['exited', 'lost'].includes(st.status)) return finish(st);
          if (now() >= deadline) { await stop(); throw fail('timeout', `timed out after ${Math.ceil(timeoutMs / 1000)} s`, out()); }
          await sleep(1000);
        }
      };
      return poll(true);
    };
    return {
      id, name: rec?.name ?? id, home: HOME,
      files: {
        async write(path, data) {
          await ctl('PUT', `/sandboxes/${encodeURIComponent(id)}/files`, { path: String(path), content: Buffer.from(data).toString('base64'), encoding: 'base64' });
          return true;
        },
        async read(path) {
          const r = await ctl('GET', `/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(String(path))}&encoding=base64`);
          return Buffer.from(String(r?.content ?? ''), 'base64');
        },
      },
      commands: { run },
      kill: () => api.delete(id),
    };
  };

  const api = {
    name: 'boat',
    keyName: KEY_NAME,
    caps: {
      // hasServerTTL: ttlSeconds is Boat's server-side auto-stop — a lost client still stops the
      // machine. It archives rather than deletes, which is why delete() permanently deletes and
      // snapshots:false erases the disk on stop.
      // hasProxySecrets: Boat has no edge secret injection for a worker it did not prompt itself,
      // so values go on the VM, but only with consent.
      hasServerTTL: true, hasProxySecrets: false, hasEgressPolicy: false,
      hasSnapshots: false, hasPortForward: false, hasPublish: true, hasSizes: false, hasShell: false,
      hasDisplay: false, hasMetrics: false,
      maxForegroundMs: Infinity, maxTtlSeconds, startsPerMin: 8, maxConcurrentCalls: 8, uploadMaxBytes: 5 * 1024 * 1024,
      machineKinds: ['linux'],
      get hasConsentedSecrets() { return consented(); }, // live: consent is read again on every create
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [], image: _ignored, role = labels.role, kind, size, egress } = {}) {
      if (egress) throw fail('egress_unsupported', 'boat cannot limit where a machine connects.');
      if (kind && kind.name !== 'linux') throw fail('machine_kind_unsupported', `boat runs only linux machines, not ${kind.name}. Use machine "linux".`);
      if (role === 'coordinator') throw new Error(api.text.coordinatorRefusal);
      if (size) throw fail('size_not_allowed', 'boat machine types are fixed (small/default/large/xlarge); Cloudy Cloud does not map a size yet.');
      apiKey(); // no_key before the consent check: the key is required either way
      if (!consented()) throw new Error(`Boat has no proxy secrets, so every worker credential (GH_TOKEN, the Claude credential, profile keys) would be written onto the sandbox in plaintext, where anything running on the sandbox could read it.\nTo allow that, add ${CONSENT}=yes to ~/.config/cloudy-cloud/env, then call cloud_agent again.`);

      const ttl = Math.min(Math.max(1, ttlSeconds || maxTtlSeconds), maxTtlSeconds);
      const t0 = now();
      const deleteAt = t0 + ttl * 1000;
      const idem = randomUUID(); // ONE key for the whole create: a lost answer is retried with it.
      const all = { ...labels, purpose: 'cloudy-cloud', ...(role && { role }), ...(name && !labels.name && { name }), deleteAt: new Date(deleteAt).toISOString(), startedAt: new Date(t0).toISOString(), ccid: idem };
      const labelNames = Object.keys(all);
      if (labelNames.length > 20) throw new Error(`too many sandbox labels (${labelNames.length} > 20)`);
      for (const [k, v] of Object.entries(all)) {
        if (!LABEL_KEY.test(k)) throw new Error(`invalid label name "${k}"`);
        if (typeof v !== 'string' || Buffer.byteLength(v) > 256) throw new Error(`invalid label value for "${k}"`);
      }
      const vars = { ...envs };
      // With consent GH_TOKEN goes on the VM like the self-hosted provider's; other names in
      // `secrets` are MCP tokens the core asked for after the user allowed that server.
      for (const n of [...new Set(['GH_TOKEN', ...secrets])]) {
        if (env[n] === undefined) throw fail('no_key', `The secret ${n} cannot be put on a Boat sandbox. ${api.text.githubTokenHelp}`);
        vars[n] = env[n];
      }
      for (const n of Object.keys(vars)) if (!ENV_NAME.test(n)) throw new Error(`invalid environment variable name "${n}"`);
      for (const v of Object.values(vars)) if (typeof v === 'string') sensitive.add(v); // never let a written value reach an error string

      const envText = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}\n`).join('');
      const boxName = `cc-${String(all.agent ?? all.name ?? 'worker').replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40) || 'worker'}-${randomBytes(3).toString('hex')}`;
      const body = {
        type: 'default', ttlSeconds: ttl, name: boxName.slice(0, 120), labels: all,
        noEnv: true, visibility: 'private', snapshots: false,
        ...(envText.length <= 250_000 && { files: [{ path: ENVFILE, content: envText, encoding: 'utf8' }] }),
      };
      // Everything after the create is covered by cleanup: a failure deletes the sandbox.
      let rec;
      try {
        rec = (await ctl('POST', '/sandboxes', body, { idem }))?.sandbox;
      } catch (e) {
        // The create may still have landed though every answer was lost: the ccid label lets a
        // list recover it, so a retry never bills a second sandbox.
        const found = (await ctl('GET', `/sandboxes?label=${encodeURIComponent(`purpose=cloudy-cloud`)}&label=${encodeURIComponent(`ccid=${idem}`)}&limit=1`).then((r) => r?.sandboxes ?? []).catch(() => []))[0];
        if (found?.id) rec = found;
        else throw e;
      }
      const id = rec?.id;
      if (!id) throw fail('transient', 'the Boat create answer carried no sandbox id');
      try {
        for (const deadline = t0 + 240_000; !READY.has(rec?.state); ) {
          if (['error', 'cancelled'].includes(rec?.state)) throw fail('transient', `the Boat sandbox failed while starting (${rec?.error ?? rec.state})`);
          if (now() >= deadline) throw fail('transient', 'the Boat sandbox did not become ready within 240 s');
          await sleep(1000);
          rec = (await getSandbox(id))?.sandbox;
        }
        const sb = sandbox(id, rec);
        await sb.commands.run(PROVISION, { timeoutMs: 600_000 });
        // An env file too big for the create `files` field lands here instead (still before return).
        if (envText.length > 250_000) {
          await sb.files.write(ENVFILE, envText);
          await sb.commands.run(`chmod 600 ${ENVFILE}`, { timeoutMs: 30_000 });
        }
        return sb;
      } catch (e) {
        await api.delete(id).catch(() => {});
        throw e;
      }
    },

    async connect(id) {
      const rec = await owned(id);
      if (READY.has(rec.state)) return sandbox(id, rec);
      if (STARTING.has(rec.state)) throw fail('transient', `the Boat sandbox ${id} is still starting (${rec.state})`);
      throw fail('not_found', `the Boat sandbox ${id} is ${rec.state}${rec.error ? ` (${scrub(rec.error)})` : ''}`);
    },

    async list(labels = {}, { onError } = {}) {
      const rows = [];
      let cursor = '';
      for (let pages = 0; pages < 50; pages++) {
        const qs = [`label=${encodeURIComponent('purpose=cloudy-cloud')}`, ...Object.entries(labels).map(([k, v]) => `label=${encodeURIComponent(`${k}=${v}`)}`), 'limit=200', ...(cursor && [`cursor=${encodeURIComponent(cursor)}`])].join('&');
        const page = await ctl('GET', `/sandboxes?${qs}`);
        const sandboxes = Array.isArray(page?.sandboxes) ? page.sandboxes : [];
        for (const rec of sandboxes) {
          // The server filter is not trusted alone: an organization list can hold other people's
          // sandboxes, so every row is re-checked, and a caller label must match exactly.
          if (rec?.labels?.purpose !== 'cloudy-cloud') continue;
          if (!Object.entries(labels).every(([k, v]) => rec.labels[k] === v)) continue;
          const deleteAt = Date.parse(rec.labels.deleteAt ?? '');
          if (deleteAt && deleteAt <= now()) {
            // Sweep expired owned sandboxes. A failed delete keeps the row visible (and the next
            // sweep tries again) — the machine is still out there.
            try { await api.delete(rec.id); continue; }
            catch (e) { onError?.(e); rows.push(rowOf(rec, { deleteError: `delete failed: ${e.message}` })); continue; }
          }
          rows.push(rowOf(rec));
        }
        cursor = page?.pageInfo?.nextCursor;
        if (!cursor) break;
      }
      return rows;
    },

    // A foreign id is refused with not_found before the delete is even attempted; a 404 counts
    // as deleted; the API answers 202 for an accepted background deletion.
    async delete(id, { retries = 2, log } = {}) {
      let rec;
      try { rec = (await getSandbox(id))?.sandbox; } catch (e) { if (e.code === 'not_found') return; throw e; }
      if (rec?.labels?.purpose !== 'cloudy-cloud') throw fail('not_found', `No cloudy-cloud boat sandbox ${id}`);
      for (let attempt = 0; ; attempt++) {
        try {
          await ctl('DELETE', `/sandboxes/${encodeURIComponent(id)}`, undefined, { headers: { 'X-Ascii-Confirm-Delete': id } });
          return;
        } catch (e) {
          if (e.code === 'not_found') return;
          if (attempt >= retries || (e.code !== 'transient' && e.code !== 'rate_limited')) throw e;
          log?.(`delete ${id} failed (${e.message}); retrying`);
          await sleep((e.retryAfterSeconds ?? 1) * 1000);
        }
      }
    },

    async snapshot() { throw new Error('boat snapshots are not used: a worker is never resumed or forked.'); },
    async getSnapshot() { throw new Error('boat snapshots are not used: a worker is never resumed or forked.'); },

    // No private tunnel in the API (SSH needs a provisioned key); previews are the public share
    // path. `cloudy-cloud open` refuses earlier because caps.hasPortForward is false.
    async forwardPort() { throw new Error('boat has no private port tunnel for `cloudy-cloud open`; use --share for a public preview link.'); },
    async publishPort(id, port) {
      const p = portOf(port);
      await owned(id); // refuse foreign sandboxes before opening anything
      const r = await ctl('POST', `/sandboxes/${encodeURIComponent(id)}/host`, { port: p });
      // `public` is left unset, so the URL is token-gated — the _token IS the access control, so
      // the returned URL is secret-shaped and scrubbed from errors like a credential.
      if (r?.url) sensitive.add(r.url);
      if (!r?.url) throw fail('transient', 'the Boat host answer carried no URL');
      return { url: r.url };
    },
    async unpublishPort(id, port) {
      const p = portOf(port);
      const sb = await api.connect(id);
      const r = await sb.commands.run(`host hide ${p}`, { timeoutMs: 30_000 }).catch((e) => e);
      return r.exitCode ?? 1;
    },

    localMachineName: (hostname) => (String(hostname).startsWith('cc-') ? hostname : ''),

    // No SSH: a sandbox would need an ssh key provisioned (see ssh-access docs). hasShell is
    // false so shellArgv is never called; the boat CLI or dashboard terminal are the ways in.
    shellArgv() { throw new Error('cloudy-cloud shell is not supported on boat (no SSH key is provisioned); use `boat ssh <id>` or the boat.dev dashboard terminal.'); },
    async displayLink() { throw noDisplay(); },
    async revokeDisplayLinks() { throw noDisplay(); },
    async screenshot() { throw noDisplay(); },
    async metrics() { throw fail('metrics_unsupported', 'boat machines expose no usage numbers to Cloudy Cloud.', { provider: 'boat' }); },
    async plan() {
      try {
        const l = await ctl('GET', '/limits');
        return { tier: l.sandboxPlanKey ?? (l.sandboxPlanDollars ? `$${l.sandboxPlanDollars}` : undefined), startsPerMinute: l.startLimits?.perMinute ?? 0, maxRunning: l.maxActiveSandboxes ?? 0, maxMachines: l.maxActiveSandboxes ?? 0, fetchedAt: now() };
      } catch { return null; } // a plan answer is best-effort: an org key may not read /limits
    },

    text: {
      ssh: (machine, cmd) => `\`boat ssh ${machine}\` or the boat.dev dashboard terminal${cmd ? `, then run: ${cmd}` : ''}`,
      // The header is piped to curl on stdin (-K -), so the key never sits in the command's argv.
      listMachines: `printf 'header = "Authorization: Bearer %s"\\n' "$BOAT_API_KEY" | curl -s -K - 'https://boat.dev/api/v1/sandboxes?label=purpose%3Dcloudy-cloud'`,
      noKeyFix: `BOAT_API_KEY is not set.\nCreate a key on https://boat.dev (Settings -> API keys), then add\nBOAT_API_KEY=<the key> to ~/.config/cloudy-cloud/env.`,
      apiFix: `Check that the Boat API answers:\n  printf 'header = "Authorization: Bearer %s"\\n' "$BOAT_API_KEY" | curl -s -K - 'https://boat.dev/api/v1/sandboxes?limit=1'`,
      githubTokenHelp: `Boat has no proxy secrets, so GH_TOKEN is written onto the sandbox in plaintext.\nAdd GH_TOKEN=<a token with write access> and ${CONSENT}=yes to ~/.config/cloudy-cloud/env.`,
      hostLabel: 'a Boat sandbox',
      coordinatorRefusal: 'Coordinators are not supported on the boat provider. Start workers directly from your own session with cloud_agent.',
    },
  };
  const rowOf = (rec, extra = {}) => ({
    id: rec.id, name: rec.labels?.name ?? rec.name, machineName: rec.name, labels: rec.labels ?? {},
    state: rec.state ?? '', status: STATUS[rec.state] ?? 'stopped',
    startedAt: Date.parse(rec.labels?.startedAt ?? '') || Date.parse(rec.createdAt) || 0,
    deleteAt: rec.labels?.deleteAt, archiveAt: rec.archiveAfter, ...extra,
  });
  function noDisplay() { return fail('display_unsupported', 'boat desktops are not wired into cloudy-cloud yet; use `boat ssh <id>` or the dashboard.'); }
  return api;
}
