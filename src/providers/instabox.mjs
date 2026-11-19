import { randomUUID } from 'node:crypto';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { createLimiter } from '../limits.mjs';

import { guide, SECRET_HOSTS } from '../errors.mjs';
const ARCHIVE_MS = 8 * 60 * 60_000; // backstop; agents are normally stopped sooner.
const FOREGROUND_MAX_MS = 600_000; // Instabox caps a foreground command at 10 minutes.
const WAIT_SLICE_MS = 20_000; // one job.wait() holds a request slot, so wait in short slices.
const MAX_429_TRIES = 8;

// Errors that mean "ask again" while waiting on a job that is still running: SDK request timeouts (any code),
// network failures and HTTP 5xx. job_lost, 404 not_found and a command exit are real results and are not here.
const NETWORK_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i;
function isTransientWaitError(e) {
  if (e?.exitCode !== undefined || e?.code === 'job_lost' || e?.code === 'not_found' || e?.status === 404) return false;
  return e?.name === 'InstaboxTimeoutError' || /timed out after/i.test(e?.message ?? '') || e?.status >= 500
    || NETWORK_RE.test(`${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? ''}`);
}

const API = 'https://api.instabox.sh/v1/machines';
const SECRET_HELP = 'The GH_TOKEN Instabox secret could not be attached to the sandbox. Create it as described in https://github.com/dennisonbertram/cloudycloud/blob/HEAD/docs/RUNBOOK.md, step 2.4.';

// Hosts of the keys cloudy-cloud itself stores as secrets (#62); other names keep the <host> placeholder.
const KEY_HOSTS = { CLAUDE_CODE_OAUTH_TOKEN: 'api.anthropic.com', ANTHROPIC_API_KEY: 'api.anthropic.com', PARTICLE_API_KEY: 'api.particle.ai', OPENROUTER_API_KEY: 'openrouter.ai' };

// Attach the org's GH_TOKEN secret (a proxy placeholder) plus any MCP_<NAME>_TOKEN secrets in one PATCH (the selection is
// replaced, so all names go together), and wait until Instabox has applied them.
export async function attachSecrets(id, apiKey, fetchFn, names = [], { pollMs = 2000, timeoutMs = 60_000 } = {}) {
  const url = `${API}/${encodeURIComponent(id)}/secrets`;
  const call = async (method, body) => {
    const res = await fetchFn(url, {
      method, headers: { 'X-API-Key': apiKey, ...(body && { 'Content-Type': 'application/json' }) }, body,
    }).catch((e) => { throw Object.assign(new Error(`${SECRET_HELP} (${method}: ${String(e?.message ?? '').replaceAll('\n', ' ')})`), { local: true }); });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let j = {};
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      const e = j.error && typeof j.error === 'object' ? j.error : j;
      // Server text folds onto one line: a newline inside it could forge a guidance label in our message.
      const detail = String(e.code || e.message ? `code ${e.code ?? '?'}: ${e.message ?? ''}${e.hint ? ` (${e.hint})` : ''}` : t.slice(0, 200)).replaceAll('\n', ' ');
      const missing = names.find((n) => `${t}`.includes(n));
      const help = missing ? guide('secret_missing', { secret: missing, host: KEY_HOSTS[missing] })
        : names.length ? `${SECRET_HELP} Secrets tried: GH_TOKEN, ${names.join(', ')}.` : SECRET_HELP;
      throw Object.assign(new Error(`${help} (${method} returned HTTP ${res.status}, ${detail})`), { local: true });
    }
    return res;
  };
  await call('PATCH', JSON.stringify({ secrets: ['GH_TOKEN', ...names] }));
  const applied = (x) => x?.appliedRevision >= x?.revision;
  for (const deadline = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, pollMs))) {
    const d = await (await call('GET')).json().catch(() => ({}));
    if (applied(d.proxy) && applied(d.guest)) return;
    if (Date.now() >= deadline) throw Object.assign(new Error(`${guide('secret_not_applied', { id })}\n${SECRET_HELP} (not applied within ${timeoutMs / 1000} s)`), { local: true });
  }
}

export const attachGithubToken = (id, apiKey, fetchFn, opts) => attachSecrets(id, apiKey, fetchFn, [], opts);

// The SDK (0.6.0) has no deleteAfterSeconds option, but Instabox accepts it in the create request. Instabox then deletes the
// machine at that time in any state, even if every cloudy-cloud process has died. Pass this as the SDK's `fetch` option: it
// adds the field to the POST /v1/machines body and leaves every other request alone.
// `extra` (gpu, model, acceptMinimumLease for non-linux kinds) goes into the same body; the SDK has no option for them.
export const withDeleteAfter = (seconds, fetchFn = fetch, extra) => (url, init = {}) =>
  fetchFn(url, init.method === 'POST' && /\/v1\/machines\/?$/.test(String(url)) && typeof init.body === 'string'
    ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body), deleteAfterSeconds: seconds, ...extra }) } : init);

// Template id per machine kind (linux keeps the requested image, agent-browser by default). Spike: docs/research/machine-kinds.md.
const TEMPLATES = { android: 'android', omarchy: 'omarchy', gpu: 'gpu', macos: 'macos' };
const KINDS = ['linux', ...Object.keys(TEMPLATES)];
// Instabox error codes that have their own guidance.
const CODE_MAP = { template_not_allowed: 'machine_not_on_plan', template_limit: 'machine_gpu_limit', spec_not_allowed: 'size_not_allowed' };

// Seconds a worker or nested coordinator machine lives: CLOUDY_CLOUD_WORKER_HOURS, default 6, at most 24 (Instabox caps it at 86400 s).
export const workerSeconds = (env) => {
  const h = Number(env.CLOUDY_CLOUD_WORKER_HOURS);
  return Math.max(60, Math.round((h > 0 ? Math.min(h, 24) : 6) * 3600));
};

const KEY_NAME = 'INSTABOX_API_KEY';
const MAX_TTL_SECONDS = 86_400; // Instabox caps deleteAfterSeconds at 86400 s.
const STATUS = { creating: 'starting', starting: 'starting', running: 'running', resuming: 'starting', stopping: 'stopped', stopped: 'stopped', suspending: 'stopped', suspended: 'stopped', deleting: 'stopped', deleted: 'stopped', error: 'failed' };
const SSH = (machine, rest) => `npx --yes instabox@latest ssh ${machine}${rest ? ` -- ${rest}` : ''}`;
const NPX_CLI = ['npx', '--yes', 'instabox@latest'];
// The floor is the CLI version Cloudy Cloud is tested with; raise it when a newer CLI flag is needed.
const MIN_INSTABOX_CLI = '0.8.289';
const newEnough = (f, PATH) => {
  try {
    const v = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(execFileSync(f, ['--version'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH } }));
    const min = MIN_INSTABOX_CLI.split('.').map(Number);
    if (!v) return false;
    for (let i = 0; i < 3; i++) if (Number(v[i + 1]) !== min[i]) return Number(v[i + 1]) > min[i];
    return !v[4]; // numbers equal the floor: a prerelease is below it
  } catch { return false; }
};
// An executable `instabox` file on PATH at or above the floor is spawned directly (no npm registry round trip); otherwise npx.
const findInstabox = (PATH = '') => {
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    const f = resolve(dir, 'instabox');
    try { if (statSync(f).isFile()) { accessSync(f, constants.X_OK); if (newEnough(f, PATH)) return [f]; } } catch { /* next */ }
  }
  return NPX_CLI;
};

// Give an SDK or HTTP error one of the provider's normalised codes. An error that already has a code keeps it.
function normalize(e) {
  if (!e || typeof e !== 'object') return e;
  if (CODE_MAP[e.code]) return Object.assign(e, { instaboxCode: e.code, code: CODE_MAP[e.code] });
  if (e.code) return e;
  if (e.status === 429) e.code = 'rate_limited';
  else if (e.status === 404) e.code = 'not_found';
  else if (e.status >= 500 || isTransientWaitError(e)) e.code = 'transient';
  return e;
}

// Environment and cwd for a spawned CLI. The npx fallback runs npm, which reads the checkout's .npmrc (registry,
// script-shell) and every npm_config_* the caller exported — a repository could then run code while the Instabox
// key is in the environment. So npx runs from os.tmpdir() (no project config) with this allowlist plus the key.
// The proxy and CA variables are there so a corporate proxy or a custom CA bundle can still reach the registry.
// A resolved instabox binary does not read npm config and keeps the caller's environment.
const CLI_ENV = new Set(['PATH', 'HOME', 'TERM', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SSH_AUTH_SOCK',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']);
export const cliSpawnOpts = (argv, env, base = process.env) => {
  // A coordinator machine holds the key under its proxy-secret name; the CLI only reads the canonical one.
  const key = env?.[KEY_NAME] || env?.CLOUDY_CLOUD_INSTABOX_API_KEY;
  if (argv[0] !== 'npx') return { env: { ...base, ...(key && { [KEY_NAME]: key }) } };
  const child = {};
  for (const [k, v] of Object.entries(base)) if (CLI_ENV.has(k) || k.startsWith('LC_')) child[k] = v;
  if (key) child[KEY_NAME] = key;
  return { env: child, cwd: tmpdir() };
};

const defaultSpawn = (argv, { inherit, env, input, cwd } = {}) => new Promise((resolve) => {
  const p = nodeSpawn(argv[0], argv.slice(1), { stdio: inherit ? 'inherit' : [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'], env, ...(cwd && { cwd }) });
  let stdout = '', stderr = '';
  p.stdout?.on('data', (d) => (stdout += d));
  p.stderr?.on('data', (d) => (stderr += d));
  p.on('error', (e) => resolve({ code: 1, stdout, stderr: String(e.message) }));
  if (input !== undefined) { p.stdin?.on('error', () => {}); p.stdin?.end(input); }
  p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

let shared; // one limiter for the whole server process
const sharedLimiter = (env) => (shared ??= createLimiter(Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) > 0 ? Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) : 24));

// The Provider for Instabox. `deps` = { sdk, fetchFn, spawn, timing, limiter, now, sleep, sliceMs }, all injectable for tests.
// Every command, file and job-wait call goes through one limiter (Instabox allows 32 concurrent requests per account);
// a 429 is retried after a short backoff, outside the slot. list and delete use raw fetch so the reaper never loads the SDK.
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote

export function createProvider(env, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const limiter = deps.limiter ?? sharedLimiter(env);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sliceMs = deps.sliceMs ?? WAIT_SLICE_MS;
  let cli; // resolved on first spawn, once per provider
  const INSTABOX_CLI = { *[Symbol.iterator]() { cli ??= findInstabox(env.PATH ?? process.env.PATH); yield* cli; } };
  const rawSandboxes = new WeakMap(); // wrapped sandbox -> SDK sandbox, for snapshot()
  const apiKey = () => {
    // A coordinator holds the key as the proxy secret CLOUDY_CLOUD_INSTABOX_API_KEY (Instabox reserves the INSTABOX_ prefix).
    const key = env[KEY_NAME] || env.CLOUDY_CLOUD_INSTABOX_API_KEY;
    if (!key) throw Object.assign(new Error(`${KEY_NAME} is not set.`), { code: 'no_key', local: true });
    return key;
  };
  const loadSdk = async () => deps.sdk ?? (await import('@insforge/instabox-sdk'));
  // tries = 1 for coordinator sandboxes ({ retry: false }): a single attempt, as before the adapter.
  const callWith = (tries) => async (fn) => {
    for (let n = 1; ; n++) {
      try {
        return await limiter.run(fn);
      } catch (e) {
        if (e?.status !== 429 || n >= tries) throw normalize(e);
        await sleep(Math.min(1000 * 2 ** (n - 1), 10_000));
      }
    }
  };

  const wrap = (sbx, name, { retry = true, nameFromInfo = false } = {}) => {
    const call = callWith(retry ? MAX_429_TRIES : 1);
    const sandbox = {
      id: sbx.sandboxId,
      ...(name !== undefined && { name }),
      home: '/data/home', // macOS replaces this with the machine's $HOME in create
      files: {
        write: (...a) => call(() => sbx.files.write(...a)),
        read: (...a) => call(() => sbx.files.read(...a)),
        // files.write falls back to sending the file as base64 inside a shell command when the upload route is missing. That is
        // fine for a config, not for a secret, so this uses the upload route only (the SDK's writeStream) and fails closed.
        writeSecret: (path, data) => call(async () => {
          if ((await sbx.files.writeStream?.(path, typeof data === 'string' ? new TextEncoder().encode(data) : data)) !== true) {
            throw Object.assign(new Error(`The file upload route of this Instabox machine is not available, so ${path} (it holds a secret) was not written: the only other route sends the file inside a shell command, where it can appear in logs.\nNext step: start the agent again in a minute. If it keeps failing, do not use a login file or an MCP server with a real token (cloudy-cloud mcp rm NAME), and use proxy secrets instead.`), { code: 'secret_write_unsupported', local: true });
          }
        }),
      },
      kill: () => sbx.kill(),
      // The server's machine name, fetched on demand (the coordinator asks after setup, as it did before the adapter).
      loadName: async () => (nameFromInfo ? (sandbox.name = (await sbx.getInfo()).name) : sandbox.name),
      commands: {
        // opts.onStdout receives output as it is written. opts.signal stops the command (a background job is killed).
        async run(cmd, { timeoutMs: ms, onStdout, signal, ...opts } = {}) {
          if (!(ms > FOREGROUND_MAX_MS)) return call(() => sbx.commands.run(cmd, { ...opts, onStdout, signal, timeoutMs: ms }));
          // The SDK does not enforce a timeout on background jobs, so wait with a deadline and kill on expiry.
          const job = await call(() => sbx.commands.run(cmd, { ...opts, background: true }));
          const kill = () => job.kill().catch(() => {});
          if (signal?.aborted) await kill();
          else signal?.addEventListener('abort', kill, { once: true });
          // wait() replays the whole log from the start on every call, so count the characters already delivered
          // and pass only the new tail to onStdout.
          let delivered = 0;
          let failures = 0; // consecutive transient errors, for the backoff
          const deadline = now() + ms;
          try {
            for (;;) {
              const left = deadline - now();
              if (left <= 0) {
                await kill();
                throw Object.assign(new Error(`command timed out after ${ms} ms`), { local: true, stderr: `job still running after ${ms} ms` });
              }
              let pos = 0;
              const fresh = (chunk) => {
                const end = pos + chunk.length, skip = Math.max(0, delivered - pos);
                pos = end;
                if (end <= delivered) return;
                delivered = end;
                return onStdout?.(skip ? chunk.slice(skip) : chunk);
              };
              try {
                return await call(() => { pos = 0; return job.wait({ timeoutMs: Math.min(sliceMs, left), onStdout: fresh }); });
              } catch (e) {
                if (e?.code === 'job_wait_timeout') failures = 0; // a slice ended; the job keeps running
                else if (isTransientWaitError(e)) await sleep(Math.min(Math.min(2000 * 2 ** failures++, 15_000), Math.max(0, deadline - now())));
                else throw e;
              }
            }
          } catch (e) {
            // Background output is one combined log in stdout; surface it as stderr for run-subagent.
            if (e?.exitCode !== undefined && !e.stderr) e.stderr = e.stdout;
            throw e;
          } finally {
            signal?.removeEventListener('abort', kill);
          }
        },
      },
    };
    rawSandboxes.set(sandbox, sbx);
    return sandbox;
  };

  // onError: a failing page after the first returns the rows collected so far and reports the error instead of throwing.
  async function rawList(labels = {}, onError) {
    const meta = Object.entries(labels).map(([k, v]) => `metadata=${encodeURIComponent(`${k}:${v}`)}`).join('&');
    const rows = [];
    for (let cursor; ;) {
      const url = `${API}${meta || cursor ? '?' : ''}${[meta, cursor && `cursor=${encodeURIComponent(cursor)}`].filter(Boolean).join('&')}`;
      const res = await fetchFn(url, { headers: { 'X-API-Key': apiKey() } });
      if (!res.ok) {
        const err = normalize(Object.assign(new Error(`Could not list machines: HTTP ${res.status}`), { status: res.status, local: true }));
        if (onError && cursor) { onError(err); return rows; }
        throw err;
      }
      const page = await res.json();
      rows.push(...(page.machines ?? []));
      if (!(cursor = page.nextCursor)) return rows;
    }
  }

  async function deleteMachine(id, { retries = 2, log } = {}) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await fetchFn(`${API}/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { 'X-API-Key': apiKey(), 'Idempotency-Key': randomUUID(), 'X-Confirm-Delete': id },
      }).catch((e) => { last = e; return null; });
      if (r?.ok || r?.status === 404) return;
      if (r) last = Object.assign(new Error(`Delete of ${id} failed: HTTP ${r.status}`), { status: r.status, local: true });
      log?.(`delete ${id} failed: ${r ? `HTTP ${r.status}` : 'network error'}`);
    }
    throw normalize(last ?? Object.assign(new Error(`Delete of ${id} failed`), { local: true }));
  }

  // Raw GET: SDK 0.6.0 does not type some fields. Goes through the same limiter and 429 retry as SDK calls, with a 15 s deadline.
  // Errors are built from fixed text and allow-listed codes; neither the response text nor the key is ever echoed.
  // `coded(status, code)` words an error that carries an allowed code; `tag(err, status, code)` sets err.code.
  async function rawGet(url, what, { codes = [], coded, tag } = {}) {
    const key = apiKey();
    const scrub = (s) => String(s).split(key).join('[redacted]');
    const known = new WeakSet(); // errors built here from fixed text; anything else (a fetch rejection) is replaced
    const mk = (message, props) => { const e = Object.assign(new Error(scrub(message)), { local: true, ...props }); known.add(e); return e; };
    const attempt = async (signal) => {
      const res = await fetchFn(url, { headers: { 'X-API-Key': key }, signal });
      if (res.ok) return res.json();
      let j = {};
      try { j = JSON.parse(await res.text()); } catch { /* not JSON */ }
      const raw = (j.error && typeof j.error === 'object' ? j.error : j).code;
      const code = codes.find((c) => c === raw); // allow-list; never echo the response
      const err = mk(code && coded ? coded(res.status, code) : `${what} request failed (HTTP ${res.status})`, { status: res.status });
      tag?.(err, res.status, code);
      throw err;
    };
    return callWith(MAX_429_TRIES)(async () => {
      const ac = new AbortController();
      let timer;
      const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(mk(`${what} request timed out`, { code: 'transient' })); }, deps.metricsTimeoutMs ?? 15_000); });
      try { return await Promise.race([attempt(ac.signal), deadline]); } catch (e) { throw known.has(e) ? e : mk(`${what} request failed (network error)`, { code: 'transient' }); } finally { clearTimeout(timer); }
    });
  }

  async function fetchMetrics(id, { since } = {}) {
    const t = now();
    const from = Math.min(t, Math.max(t - 86_400_000, since ?? t - 3_600_000)); // within the last 24 h, never in the future
    const body = await rawGet(`${API}/${encodeURIComponent(id)}/metrics?since=${new Date(from).toISOString()}`, 'metrics', {
      codes: ['not_found', 'metrics_unavailable', 'missing_scope'],
      coded: (status, code) => `Could not read metrics of ${id}: HTTP ${status} ${code}`,
      tag: (err, status, code) => { if (status === 503 && code === 'metrics_unavailable') err.code = 'metrics_unavailable'; else if (status === 403 && code === 'missing_scope') err.code = 'metrics_forbidden'; },
    });
    const samples = (body.metrics ?? []).map((m) => ({ t: +new Date(m.timestamp), cpuPct: m.cpuUsedPct, cpuCount: m.cpuCount, memUsed: m.memUsed, memTotal: m.memTotal,
      netIn: m.netInBytesPerSec, netOut: m.netOutBytesPerSec, diskRead: m.diskReadBytesPerSec, diskWrite: m.diskWriteBytesPerSec }));
    return { samples, fetchedAt: t };
  }

  // The account's plan: GET /v1/me for the org id, then GET /v1/orgs/<id> for its limits. Cached for the process (successes only);
  // { refresh: true } fetches again. Any failure resolves null, so a missing plan never stops a start.
  let planCache, planInflight, planLogged;
  async function plan({ refresh } = {}) {
    if (planCache && !refresh) return planCache;
    planInflight ??= (async () => {
      try {
        const me = await rawGet('https://api.instabox.sh/v1/me', 'plan');
        if (typeof me?.org?.id !== 'string') throw new Error('no org id');
        const org = await rawGet(`https://api.instabox.sh/v1/orgs/${encodeURIComponent(me.org.id)}`, 'plan');
        const l = org.limits ?? {};
        const sizes = (org.allowedSpecs?.length ? org.allowedSpecs : me.allowedSpecs ?? []).map((x) => ({ vcpus: x.vcpus, memMiB: x.memMiB }));
        const usage = {};
        for (const k of ['costUSD', 'allowanceUSD', 'creditRemainingUSD', 'overageUSD', 'ratedUntil', 'periodEnd']) if (['number', 'string'].includes(typeof org.usage?.[k])) usage[k] = org.usage[k];
        return (planCache = { ...(org.usage && typeof org.usage === 'object' && { usage }), tier: me.org.tier, specs: sizes, startsPerMinute: l.startsPerMinute ?? 0, maxRunning: l.maxRunning ?? 0, maxMachines: l.maxMachines ?? 0, fetchedAt: now() });
      } catch (e) {
        if (!planLogged) { planLogged = true; console.error('[cloudy-cloud] could not read the Instabox plan:', String(e?.message ?? 'error').split(apiKeyOrEmpty()).join('[redacted]')); }
        return null;
      } finally { planInflight = undefined; }
    })();
    return planInflight;
  }
  const apiKeyOrEmpty = () => { try { return apiKey(); } catch { return '\0'; } };

  const spawn = (argv, o = {}) => (deps.spawn ?? defaultSpawn)(argv, { ...o, ...cliSpawnOpts(argv, env) });

  return {
    name: 'instabox',
    keyName: KEY_NAME,
    caps: {
      hasServerTTL: true, hasProxySecrets: true, hasSnapshots: true, hasPortForward: true, hasPublish: true,
      maxForegroundMs: FOREGROUND_MAX_MS, maxTtlSeconds: MAX_TTL_SECONDS,
      startsPerMin: Number(env.CLOUDY_CLOUD_STARTS_PER_MIN) || 25,
      maxConcurrentCalls: Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) > 0 ? Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) : 24,
      uploadMaxBytes: 10 * 1024 * 1024,
      machineKinds: KINDS, hasShell: true, hasDisplay: true, hasMetrics: true, hasSizes: true, hasEgressPolicy: false,
    },

    // `secrets` are MCP secret names; the adapter adds GH_TOKEN itself and never sees a token value.
    async create({ image = 'agent-browser', envs, labels, name, ttlSeconds = workerSeconds(env), secrets = [], neverSuspend = false, retry = true, kind, size, egress } = {}) {
      if (egress) throw Object.assign(new Error('Instabox cannot limit where a machine connects.'), { code: 'egress_unsupported', local: true });
      const key = apiKey();
      const kindName = kind?.name ?? 'linux';
      if (!KINDS.includes(kindName)) throw Object.assign(new Error(`Instabox has no ${kindName} machines`), { code: 'machine_kind_unsupported', local: true });
      if (kindName !== 'linux') image = TEMPLATES[kindName];
      const extra = kindName === 'gpu' ? { gpu: kind.gpu ?? 'l4' }
        : kindName === 'macos' ? { acceptMinimumLease: true, ...(kind.model && { model: kind.model }) } : undefined; // ponytail: macos `model` body field is a guess; unverified live
      const { Sandbox } = await loadSdk();
      let sbx;
      try {
        const lifetime = neverSuspend ? { autoSuspendMs: 0 } : { archiveMs: ARCHIVE_MS };
        // Key order is part of the recorded request (golden files): named machines are the coordinator's, the rest are workers or images.
        sbx = await Sandbox.create(image, {
          ...(name ? { apiKey: key, name, ...(envs && { envs }), ...lifetime, metadata: labels } : { apiKey: key, envs, metadata: labels, ...lifetime }),
          ...(size && { vcpus: size.vcpus, memMiB: size.memMiB }),
          fetch: withDeleteAfter(ttlSeconds, fetchFn, extra),
        });
      } catch (e) { throw e?.code === 'no_capacity' || (kindName !== 'linux' && e?.status === 503 && !e.code) ? Object.assign(e, { code: 'machine_no_capacity' }) : normalize(e); }
      try {
        await attachSecrets(sbx.sandboxId, key, fetchFn, secrets, deps.timing);
      } catch (e) {
        await sbx.kill().catch(() => {});
        throw e;
      }
      const sandbox = wrap(sbx, name, { retry, nameFromInfo: neverSuspend });
      if (kindName === 'macos') {
        const home = (await sandbox.commands.run('printf %s "$HOME"').catch(() => null))?.stdout?.trim();
        if (home) sandbox.home = home;
      }
      return sandbox;
    },

    // A desktop that cannot run (omarchy: no xdotool, no X server) becomes desktop_unavailable; a 403 permission_denied here becomes display_forbidden.
    async desktop(id, fn) {
      const { Sandbox } = await loadSdk();
      try {
        const sbx = await Sandbox.connect(id, { apiKey: apiKey() });
        return await callWith(MAX_429_TRIES)(() => fn(sbx.desktop));
      } catch (e) {
        // Only a desktop that cannot run (its script exited non-zero, or it did not start) is desktop_unavailable;
        // auth, quota, capacity and network errors keep their own codes.
        if (e?.status === 403 && e.code === 'permission_denied') throw Object.assign(e, { code: 'display_forbidden' });
        if (e?.code === 'command_exit' || e?.code === 'desktop_not_running') throw Object.assign(e, { code: 'desktop_unavailable' });
        throw normalize(e);
      }
    },
    async displayLink(id, { control = false, ttlSeconds } = {}) {
      return this.desktop(id, async (d) => {
        if (!(await d.status()).running) await d.start();
        return d.streamUrl({ viewOnly: !control, ...(ttlSeconds && { ttlSeconds }) });
      });
    },
    revokeDisplayLinks(id) { return this.desktop(id, (d) => d.revokeStreamUrls()); },
    metrics: fetchMetrics,
    plan,
    screenshot(id) { return this.desktop(id, (d) => d.screenshot()); },
    // ssh joins remote arguments with spaces and the machine's shell parses them again, so send ONE quoted string; -T: no TTY for a command, -t when tty is true (for a sign-in).
    // Extra environment for the spawned `instabox ssh`, so it uses the same account as the SDK (the key may live only in the config file).
    shellEnv() { try { return { INSTABOX_API_KEY: apiKey() }; } catch { return {}; } },
    shellArgv: (id, cmd = [], { tty = false } = {}) => [...INSTABOX_CLI, 'ssh', id, ...(cmd.length ? ['--', tty ? '-t' : '-T', cmd.map(shq).join(' ')] : [])],
    // An interactive spawn of shellArgv (coordinator attach, sign-in, cloudy-cloud shell) gets the same policy as
    // the provider's own CLI calls: the npx fallback runs from a trusted directory with the allowlisted environment.
    shellSpawnOpts: (argv) => cliSpawnOpts(argv, env),

    async connect(id, { retry = true } = {}) {
      const { Sandbox } = await loadSdk();
      try { return wrap(await Sandbox.connect(id, { apiKey: apiKey() }), undefined, { retry }); } catch (e) { throw normalize(e); }
    },

    async snapshot(sandbox, { name, description } = {}) {
      const snap = await rawSandboxes.get(sandbox).createSnapshot({ name, description });
      return { id: snap.id, status: snap.status };
    },

    async getSnapshot(id) {
      const { Sandbox } = await loadSdk();
      const snap = await Sandbox.getSnapshot(id, { apiKey: apiKey() });
      return { id: snap.id, status: snap.status };
    },

    // Raw fetch by default so the reaper never loads the SDK; { sdk: true } lists through Sandbox.list instead.
    async list(labels = {}, { sdk, onError } = {}) {
      const row = (m) => ({
        id: m.id ?? m.sandboxId, name: m.name, labels: m.metadata ?? {}, state: m.state, status: STATUS[m.state] ?? 'failed',
        startedAt: +new Date(m.createdAt ?? m.startedAt), archiveAt: m.archiveAt ? +new Date(m.archiveAt) : undefined, deleteAt: m.deleteAt ?? m.machine?.deleteAt,
      });
      if (sdk) {
        const { Sandbox } = await loadSdk();
        try { return (await Sandbox.list({ apiKey: apiKey(), metadata: labels })).map(row); } catch (e) { throw normalize(e); }
      }
      return (await rawList(labels, onError)).filter((m) => Object.entries(labels).every(([k, v]) => m.metadata?.[k] === v)).map(row);
    },

    // opts: { sdk } uses Sandbox.kill (waits for the delete, false on 404); { retries = 2, log } apply to the raw path.
    async delete(id, { sdk, ...opts } = {}) {
      if (!sdk) return deleteMachine(id, opts);
      const { Sandbox } = await loadSdk();
      try { await Sandbox.kill(id, { apiKey: apiKey() }); } catch (e) { throw normalize(e); }
    },

    async forwardPort(id, localRemote) { return (await spawn([...INSTABOX_CLI, 'port-forward', id, localRemote], { inherit: true })).code; },
    async publishPort(id, port) {
      const r = await spawn([...INSTABOX_CLI, 'port', 'publish', id, port, '--private', '--json']);
      if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout || '').trim().slice(0, 300)), { exitCode: r.code });
      let url;
      try { url = JSON.parse(r.stdout).url; } catch { /* fall through */ }
      return { url: url ?? r.stdout.trim() };
    },
    async unpublishPort(id, port) { return (await spawn([...INSTABOX_CLI, 'port', 'unpublish', id, port])).code; },

    // Stores an org secret through `instabox secrets set`: the value goes on stdin (never argv) and the output is
    // dropped — the same mechanism `cloudy-cloud setup` uses. Needs the instabox login session, like setup.
    async storeSecret(name, value) {
      const host = SECRET_HOSTS[name];
      if (!host) throw Object.assign(new Error(`no host is known for the secret ${String(name).replaceAll('\n', ' ')}`), { code: 'unknown_secret', local: true });
      const r = await spawn([...INSTABOX_CLI, 'secrets', 'set', name, '--host', host], { input: String(value) });
      if (r.code !== 0) {
        const detail = (r.stderr || r.stdout || '').split(String(value)).join('[redacted]').split(apiKeyOrEmpty()).join('[redacted]').replaceAll('\n', ' ').trim().slice(0, 200);
        throw Object.assign(new Error(`Could not store the ${String(name).replaceAll('\n', ' ')} secret (exit ${r.code})${detail ? `: ${detail}` : ''}`), { exitCode: r.code, local: true });
      }
    },

    // The effective org's secret names, through the same CLI and env as storeSecret (`instabox secrets ls --json`).
    // Names only — a secret value never appears here. Used to check CLOUDY_CLOUD_INSTABOX_API_KEY before writing it.
    async listSecrets() {
      const r = await spawn([...INSTABOX_CLI, 'secrets', 'ls', '--json']);
      if (r.code !== 0) throw Object.assign(new Error(`Could not list the Instabox secrets (exit ${r.code})`), { exitCode: r.code, local: true });
      let j;
      try { j = JSON.parse(r.stdout); } catch { throw Object.assign(new Error('Could not read the Instabox secrets list (not JSON).'), { local: true }); }
      const a = Array.isArray(j) ? j : (j.items ?? j.data ?? j.secrets);
      if (!Array.isArray(a)) throw Object.assign(new Error('Could not read the Instabox secrets list (unexpected shape).'), { local: true });
      return new Set(a.map((x) => x?.name).filter((n) => typeof n === 'string'));
    },

    localMachineName: (hostname) => (hostname.startsWith('instabox-') ? hostname.slice('instabox-'.length) : ''),

    text: {
      ssh: SSH,
      listMachines: 'npx --yes instabox@latest ls --meta purpose=cloudy-cloud',
      noKeyFix: 'Add your Instabox key: run cloudy-cloud setup (or npx cloudycloud setup), or put INSTABOX_API_KEY=... in ~/.config/cloudy-cloud/env.',
      apiFix: 'Check your internet connection and that INSTABOX_API_KEY in ~/.config/cloudy-cloud/env is still valid (create a new one at instabox.sh if not).',
      githubTokenHelp: SECRET_HELP,
    },
  };
}

// Today's entry point: returns createSandbox(envs, { deleteAfterSeconds, secrets }) for run-subagent. `owner` is the server
// instance id the reaper deletes by. Kept until the core uses createProvider.
export function createInstaboxSandbox(env, sdk, fetchFn = fetch, timing, owner, rt = {}) {
  const provider = createProvider(env, { sdk, fetchFn, timing, ...rt });
  return (envs, { deleteAfterSeconds = workerSeconds(env), secrets = [], egress } = {}) =>
    provider.create({ envs, labels: { purpose: 'cloudy-cloud', owner }, ttlSeconds: deleteAfterSeconds, secrets, ...(egress && { egress }) });
}
