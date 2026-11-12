import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { createLimiter } from '../limits.mjs';

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

// Attach the org's GH_TOKEN secret (a proxy placeholder) plus any MCP_<NAME>_TOKEN secrets in one PATCH (the selection is
// replaced, so all names go together), and wait until Instabox has applied them.
export async function attachSecrets(id, apiKey, fetchFn, names = [], { pollMs = 2000, timeoutMs = 60_000 } = {}) {
  const url = `${API}/${encodeURIComponent(id)}/secrets`;
  const call = async (method, body) => {
    const res = await fetchFn(url, {
      method, headers: { 'X-API-Key': apiKey, ...(body && { 'Content-Type': 'application/json' }) }, body,
    }).catch((e) => { throw new Error(`${SECRET_HELP} (${method}: ${e?.message})`); });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let j = {};
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      const e = j.error && typeof j.error === 'object' ? j.error : j;
      const detail = e.code || e.message ? `code ${e.code ?? '?'}: ${e.message ?? ''}${e.hint ? ` (${e.hint})` : ''}` : t.slice(0, 200);
      const missing = names.find((n) => `${t}`.includes(n));
      const help = missing ? `The Instabox secret ${missing} could not be attached. Create it with: printf %s "$TOKEN" | npx --yes instabox@latest secrets set ${missing} --host <host>`
        : names.length ? `${SECRET_HELP} Secrets tried: GH_TOKEN, ${names.join(', ')}.` : SECRET_HELP;
      throw new Error(`${help} (${method} returned HTTP ${res.status}, ${detail})`);
    }
    return res;
  };
  await call('PATCH', JSON.stringify({ secrets: ['GH_TOKEN', ...names] }));
  const applied = (x) => x?.appliedRevision >= x?.revision;
  for (const deadline = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, pollMs))) {
    const d = await (await call('GET')).json().catch(() => ({}));
    if (applied(d.proxy) && applied(d.guest)) return;
    if (Date.now() >= deadline) throw new Error(`${SECRET_HELP} (not applied within ${timeoutMs / 1000} s)`);
  }
}

export const attachGithubToken = (id, apiKey, fetchFn, opts) => attachSecrets(id, apiKey, fetchFn, [], opts);

// The SDK (0.6.0) has no deleteAfterSeconds option, but Instabox accepts it in the create request. Instabox then deletes the
// machine at that time in any state, even if every cloudy-cloud process has died. Pass this as the SDK's `fetch` option: it
// adds the field to the POST /v1/machines body and leaves every other request alone.
export const withDeleteAfter = (seconds, fetchFn = fetch) => (url, init = {}) =>
  fetchFn(url, init.method === 'POST' && /\/v1\/machines\/?$/.test(String(url)) && typeof init.body === 'string'
    ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body), deleteAfterSeconds: seconds }) } : init);

// Seconds a worker or nested coordinator machine lives: CLOUDY_CLOUD_WORKER_HOURS, default 6, at most 24 (Instabox caps it at 86400 s).
export const workerSeconds = (env) => {
  const h = Number(env.CLOUDY_CLOUD_WORKER_HOURS);
  return Math.max(60, Math.round((h > 0 ? Math.min(h, 24) : 6) * 3600));
};

const KEY_NAME = 'INSTABOX_API_KEY';
const MAX_TTL_SECONDS = 86_400; // Instabox caps deleteAfterSeconds at 86400 s.
const STATUS = { creating: 'starting', starting: 'starting', running: 'running', resuming: 'starting', stopping: 'stopped', stopped: 'stopped', suspending: 'stopped', suspended: 'stopped', deleting: 'stopped', deleted: 'stopped', error: 'failed' };
const SSH = (machine, rest) => `npx --yes instabox@latest ssh ${machine}${rest ? ` -- ${rest}` : ''}`;
const INSTABOX_CLI = ['npx', '--yes', 'instabox@latest'];

// Give an SDK or HTTP error one of the provider's normalised codes. An error that already has a code keeps it.
function normalize(e) {
  if (!e || typeof e !== 'object' || e.code) return e;
  if (e.status === 429) e.code = 'rate_limited';
  else if (e.status === 404) e.code = 'not_found';
  else if (e.status >= 500 || isTransientWaitError(e)) e.code = 'transient';
  return e;
}

const defaultSpawn = (argv, { inherit, env } = {}) => new Promise((resolve) => {
  const p = nodeSpawn(argv[0], argv.slice(1), { stdio: inherit ? 'inherit' : ['inherit', 'pipe', 'pipe'], env: { ...process.env, ...(env?.[KEY_NAME] && { [KEY_NAME]: env[KEY_NAME] }) } });
  let stdout = '', stderr = '';
  p.stdout?.on('data', (d) => (stdout += d));
  p.stderr?.on('data', (d) => (stderr += d));
  p.on('error', (e) => resolve({ code: 1, stdout, stderr: String(e.message) }));
  p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

let shared; // one limiter for the whole server process
const sharedLimiter = (env) => (shared ??= createLimiter(Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) > 0 ? Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) : 24));

// The Provider for Instabox. `deps` = { sdk, fetchFn, spawn, timing, limiter, now, sleep, sliceMs }, all injectable for tests.
// Every command, file and job-wait call goes through one limiter (Instabox allows 32 concurrent requests per account);
// a 429 is retried after a short backoff, outside the slot. list and delete use raw fetch so the reaper never loads the SDK.
export function createProvider(env, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const limiter = deps.limiter ?? sharedLimiter(env);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sliceMs = deps.sliceMs ?? WAIT_SLICE_MS;
  const rawSandboxes = new WeakMap(); // wrapped sandbox -> SDK sandbox, for snapshot()
  const apiKey = () => {
    if (!env[KEY_NAME]) throw Object.assign(new Error(`${KEY_NAME} is not set.`), { code: 'no_key' });
    return env[KEY_NAME];
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
      home: '/data/home',
      files: { write: (...a) => call(() => sbx.files.write(...a)), read: (...a) => call(() => sbx.files.read(...a)) },
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
                throw Object.assign(new Error(`command timed out after ${ms} ms`), { stderr: `job still running after ${ms} ms` });
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
        const err = normalize(Object.assign(new Error(`Could not list machines: HTTP ${res.status}`), { status: res.status }));
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
      if (r) last = Object.assign(new Error(`Delete of ${id} failed: HTTP ${r.status}`), { status: r.status });
      log?.(`delete ${id} failed: ${r ? `HTTP ${r.status}` : 'network error'}`);
    }
    throw normalize(last ?? new Error(`Delete of ${id} failed`));
  }

  const spawn = (argv, o = {}) => (deps.spawn ?? defaultSpawn)(argv, { ...o, env });

  return {
    name: 'instabox',
    keyName: KEY_NAME,
    caps: {
      hasServerTTL: true, hasProxySecrets: true, hasSnapshots: true, hasPortForward: true, hasPublish: true,
      maxForegroundMs: FOREGROUND_MAX_MS, maxTtlSeconds: MAX_TTL_SECONDS,
      startsPerMin: Number(env.CLOUDY_CLOUD_STARTS_PER_MIN) || 25,
      maxConcurrentCalls: Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) > 0 ? Number(env.CLOUDY_CLOUD_MAX_INSTABOX_CALLS) : 24,
      uploadMaxBytes: 10 * 1024 * 1024,
    },

    // `secrets` are MCP secret names; the adapter adds GH_TOKEN itself and never sees a token value.
    async create({ image = 'agent-browser', envs, labels, name, ttlSeconds = workerSeconds(env), secrets = [], neverSuspend = false, retry = true } = {}) {
      const key = apiKey();
      const { Sandbox } = await loadSdk();
      let sbx;
      try {
        const lifetime = neverSuspend ? { autoSuspendMs: 0 } : { archiveMs: ARCHIVE_MS };
        // Key order is part of the recorded request (golden files): named machines are the coordinator's, the rest are workers or images.
        sbx = await Sandbox.create(image, {
          ...(name ? { apiKey: key, name, ...(envs && { envs }), ...lifetime, metadata: labels } : { apiKey: key, envs, metadata: labels, ...lifetime }),
          fetch: withDeleteAfter(ttlSeconds, fetchFn),
        });
      } catch (e) { throw normalize(e); }
      try {
        await attachSecrets(sbx.sandboxId, key, fetchFn, secrets, deps.timing);
      } catch (e) {
        await sbx.kill().catch(() => {});
        throw e;
      }
      return wrap(sbx, name, { retry, nameFromInfo: neverSuspend });
    },

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
  return (envs, { deleteAfterSeconds = workerSeconds(env), secrets = [] } = {}) =>
    provider.create({ envs, labels: { purpose: 'cloudy-cloud', owner }, ttlSeconds: deleteAfterSeconds, secrets });
}
