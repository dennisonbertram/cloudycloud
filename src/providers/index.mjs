// The provider interface. A provider is a plain object; one file per provider in this folder exports
// `createProvider(env, deps)` and is listed in REGISTRY below (no directory scanning).
import { resolveMsbBin } from './microsandbox.mjs';

/**
 * @typedef {object} Caps
 * @property {boolean} hasServerTTL      the server deletes a machine at its deadline
 * @property {boolean} hasProxySecrets   secrets reach the machine as placeholders, never as values
 * @property {boolean} hasEgressPolicy   create accepts an egress allowlist and the provider enforces it
 * @property {boolean} hasSizes          create accepts a size option
 * @property {boolean} hasSnapshots
 * @property {boolean} hasPortForward
 * @property {boolean} hasPublish
 * @property {number} maxForegroundMs    longest foreground command
 * @property {number} maxTtlSeconds
 * @property {number} startsPerMin       default for CLOUDY_CLOUD_STARTS_PER_MIN
 * @property {number} maxConcurrentCalls default for CLOUDY_CLOUD_MAX_INSTABOX_CALLS
 * @property {number} uploadMaxBytes
 * @property {string[]} machineKinds     kind names (see src/machine.mjs KINDS) create accepts; always includes 'linux'
 * @property {boolean} hasShell          shellArgv works
 * @property {boolean} hasDisplay        displayLink, revokeDisplayLinks and screenshot work
 * @property {boolean} hasMetrics        metrics works
 */

/**
 * @typedef {object} Sandbox
 * @property {string} id
 * @property {string} [name]
 * @property {string} home
 * @property {{ write(path: string, data: any): Promise<any>, read(path: string): Promise<any> }} files
 * @property {{ run(cmd: string, opts?: { cwd?: string, timeoutMs?: number, signal?: AbortSignal, onStdout?: (chunk: string) => any }): Promise<{ stdout: string, stderr: string, exitCode: number }> }} commands
 *   a failed command rejects with { exitCode, stdout, stderr }
 * @property {() => Promise<any>} kill
 * @property {() => Promise<string|undefined>} [loadName]   fetches the machine name the server gave (coordinators)
 */

/**
 * Errors thrown by a provider carry a normalised `code`: rate_limited (+ retryAfterSeconds), quota_exceeded,
 * not_found, no_key or transient, plus machine_kind_unsupported, display_unsupported,
 * display_forbidden, desktop_unavailable, metrics_unavailable, metrics_forbidden, metrics_unsupported, machine_* (see src/errors.mjs). displayLink starts the desktop when it is not running.
 * @typedef {object} Provider
 * @property {string} name
 * @property {string} keyName            environment variable that holds the API key
 * @property {Caps} caps
 * @property {(o: { image: string, envs: Record<string, string>, labels: Record<string, string>, name?: string, ttlSeconds: number, secrets?: string[], neverSuspend?: boolean, retry?: boolean, kind?: { name: string, gpu?: string, model?: string }, egress?: { allow?: string[] } }) => Promise<Sandbox>} create   kind absent means linux; egress.allow is a hostname allowlist (with '*.suffix' wildcards) for providers with hasEgressPolicy
 * @property {(id: string, o?: { retry?: boolean }) => Promise<Sandbox>} connect
 * @property {(labels?: Record<string, string>, opts?: { sdk?: boolean, onError?: (e: Error) => void }) => Promise<Array<{ id: string, name: string, labels: Record<string, string>, state: string, status: 'starting'|'running'|'stopped'|'failed', startedAt: number, archiveAt?: number, deleteAt?: string }>>} list
 * @property {(id: string, opts?: { sdk?: boolean, retries?: number, log?: (line: string) => void }) => Promise<void>} delete   a 404 counts as deleted
 * @property {(sandbox: Sandbox, o: { name: string, description?: string }) => Promise<{ id: string, status: string }>} snapshot
 * @property {(id: string) => Promise<{ id: string, status: string }>} getSnapshot
 * @property {(id: string, localRemote: string) => Promise<number>} forwardPort   resolves the exit code
 * @property {(id: string, port: string) => Promise<{ url: string }>} publishPort
 * @property {(id: string, port: string) => Promise<number>} unpublishPort
 * @property {() => Record<string, string>} [shellEnv]   extra environment variables for the process that shellArgv starts
 * @property {(id: string, cmd?: string[], o?: { tty?: boolean }) => string[]} shellArgv   argv that opens an interactive shell on the machine, or runs cmd (with a TTY when o.tty is true)
 * @property {(argv: string[]) => { env?: Record<string, string>, cwd?: string }} [shellSpawnOpts]   spawn options for the process shellArgv builds; Instabox's npx fallback gets a trusted cwd and an allowlisted env, other providers need none
 * @property {(id: string, o?: { control?: boolean, ttlSeconds?: number }) => Promise<{ url: string, expiresAt: Date|string }>} displayLink   a desktop link; starts the desktop when it is not running
 * @property {(id: string, o?: { since?: number }) => Promise<{ samples: Array<{ t: number, cpuPct: number, cpuCount: number, memUsed: number, memTotal: number, netIn?: number, netOut?: number, diskRead?: number, diskWrite?: number }>, fetchedAt: number }>} metrics   since is a ms timestamp (default now - 1 h, at most 24 h back); t is ms, bytes and bytes per second as reported; oldest first; empty when the machine did not run in the window
 * @property {(o?: { refresh?: boolean }) => Promise<{ tier: string, specs: Array<{ vcpus: number, memMiB: number }>, startsPerMinute: number, maxRunning: number, maxMachines: number, fetchedAt: number }|null>} plan   the account's plan, cached for the process; 0 in a limit means no limit; null when there is no plan or it could not be read (never throws)
 * @property {(id: string) => Promise<void>} revokeDisplayLinks
 * @property {(id: string) => Promise<Uint8Array>} screenshot   PNG bytes
 * @property {(hostname: string) => string} localMachineName   machine name for the host this runs on, or ''
 * @property {{ ssh(machine: string, cmd: string): string, listMachines: string, noKeyFix: string, apiFix: string, githubTokenHelp: string }} text
 * @property {Provider[]} [providers]   combine(...) only: the adapters, in order (first is the primary)
 * @property {(machineOrId: object|string) => Provider|undefined} [for]   combine(...) only: the adapter that owns a machine row (its provider tag) or id
 */

// Adapters are imported lazily, so a missing or heavy adapter costs nothing until it is chosen.
const REGISTRY = {
  instabox: () => import('./instabox.mjs'),
  'self-hosted': () => import('./self-hosted.mjs'),
  microsandbox: () => import('./microsandbox.mjs'),
};

/**
 * The configured providers in order: CLOUDY_CLOUD_PROVIDERS (comma- or space-separated, deduped) when it
 * names at least one provider, else [CLOUDY_CLOUD_PROVIDER || 'instabox']. An unknown name fails the same
 * way the single-name setting always did.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function providerNames(env = process.env) {
  const list = [...new Set(String(env.CLOUDY_CLOUD_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean))];
  const names = list.length ? list : [env.CLOUDY_CLOUD_PROVIDER || 'instabox'];
  for (const name of names) {
    if (!Object.hasOwn(REGISTRY, name)) throw new Error(`Unknown CLOUDY_CLOUD_PROVIDER "${name}". Known: ${Object.keys(REGISTRY).join(', ')}.`);
  }
  return names;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {object} [deps]   passed to each adapter's createProvider (injectable sdk, fetchFn, ...)
 * @returns {Promise<Provider[]>}   one adapter per providerNames(env), in order
 */
export async function loadProviders(env = process.env, deps = {}) {
  return Promise.all(providerNames(env).map(async (name) => (await REGISTRY[name]()).createProvider(env, deps)));
}

/**
 * @param {Record<string, string | undefined>} env   reads CLOUDY_CLOUD_PROVIDERS, then CLOUDY_CLOUD_PROVIDER (default instabox)
 * @param {object} [deps]   passed to the adapter's createProvider (injectable sdk, fetchFn, ...)
 * @returns {Promise<Provider>}   the adapter itself when one provider is configured, combine(...) when several
 */
export async function loadProvider(env = process.env, deps = {}) {
  const ps = await loadProviders(env, deps);
  return ps.length === 1 ? ps[0] : combine(ps);
}

/**
 * One Provider face over several adapters. list returns every provider's rows tagged `provider: p.name`;
 * connect, delete and metrics route by machine id through an owner map every list fills (an unseen id
 * triggers one list {purpose:'cloudy-cloud'} refresh; an id claimed by two providers throws rather than
 * guessing). A provider whose list fails is reported through opts.onError with e.provider set; list throws
 * only when every provider failed. caps AND-s booleans, intersects lists and takes numbers, keyName, name
 * and text from the primary. `.providers` is the adapter list; `.for(machineOrId)` returns the owning
 * adapter (by a row's provider tag, else the owner map) or undefined.
 * @param {Provider[]} ps   first entry is the primary
 * @returns {Provider}
 */
export function combine(ps) {
  const primary = ps[0];
  const owner = new Map(); // machine id -> provider that last listed it
  const dupOf = new Map(); // machine id -> Set of providers that claimed it, when more than one did
  const tag = (e, name) => {
    if (e && typeof e === 'object' && e.provider === undefined) { try { e.provider = name; } catch { /* read-only error */ } }
    return e;
  };
  const claim = (p, id) => {
    const prev = owner.get(id);
    if (prev !== p && prev) (dupOf.get(id) ?? dupOf.set(id, new Set([prev])).get(id)).add(p);
    owner.set(id, p);
  };
  const dupError = (id) => Object.assign(new Error(`machine ${id} is on more than one provider (${[...dupOf.get(id)].map((p) => p.name).join(', ')}); ids must be unique across providers`), { code: 'ambiguous' });
  const notFound = (id) => Object.assign(new Error(`machine ${id} not found`), { code: 'not_found' });

  const list = async (labels = {}, opts = {}) => {
    const call = (p) => p.list(labels, opts.onError ? { ...opts, onError: (e) => opts.onError(tag(e, p.name)) } : opts);
    const settled = await Promise.allSettled(ps.map(call));
    const rows = [], errs = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') for (const m of r.value) { claim(ps[i], m.id); rows.push({ ...m, provider: ps[i].name }); }
      else { errs.push(tag(r.reason, ps[i].name)); opts.onError?.(r.reason); }
    });
    if (errs.length === ps.length) throw errs[0];
    return rows;
  };
  const route = async (id) => {
    if (dupOf.has(id)) throw dupError(id);
    if (!owner.has(id)) await list({ purpose: 'cloudy-cloud' });
    if (dupOf.has(id)) throw dupError(id);
    if (owner.has(id)) return owner.get(id);
    throw notFound(id);
  };

  // Capability merge: booleans hold only when every provider offers them, a list (machineKinds) is the
  // intersection, and anything else (numbers, keyName, text) is the primary's.
  const caps = {};
  for (const k of new Set(ps.flatMap((p) => Object.keys(p.caps ?? {})))) {
    const vals = ps.map((p) => p.caps?.[k]);
    caps[k] = vals.every((v) => v === undefined || typeof v === 'boolean') ? vals.every((v) => v === true)
      : Array.isArray(vals[0]) ? vals[0].filter((x) => vals.every((vs) => Array.isArray(vs) && vs.includes(x)))
      : vals[0];
  }

  const combined = {
    name: primary.name, keyName: primary.keyName, caps, providers: ps, text: primary.text,
    for: (x) => {
      if (x && typeof x === 'object') {
        if (x.provider) return ps.find((p) => p.name === x.provider);
        x = x.id;
      }
      return owner.get(x);
    },
    list,
    connect: async (id, o) => (await route(id)).connect(id, o),
    delete: async (id, o) => { await (await route(id)).delete(id, o); owner.delete(id); },
    metrics: async (id, o) => (await route(id)).metrics(id, o),
  };
  // Everything not routed by id (create, shellArgv, displayLink, plan, ...) is the primary's.
  for (const m of ['create', 'snapshot', 'getSnapshot', 'forwardPort', 'publishPort', 'unpublishPort', 'shellEnv', 'shellArgv', 'shellSpawnOpts', 'displayLink', 'plan', 'revokeDisplayLinks', 'screenshot', 'localMachineName']) {
    if (typeof primary[m] === 'function') combined[m] = (...a) => primary[m](...a);
  }
  return combined;
}

// The credential the adapter itself would use, so the reaper's start decision and the key the child
// receives match what launches workers. A coordinator's machine holds the Instabox key only as the proxy
// secret CLOUDY_CLOUD_INSTABOX_API_KEY (COORDINATOR_KEY_SECRET in profiles.mjs: the INSTABOX_ prefix is
// reserved there), and `cloudy-cloud mcp-server` execs before the launcher maps it. The microsandbox
// "key" is its binary, also found at ~/.local/bin/msb or on PATH, not only via the variable.
export const providerKey = (env, provider) =>
  env[provider.keyName]
  || (provider.name === 'instabox' && env.CLOUDY_CLOUD_INSTABOX_API_KEY)
  || (provider.name === 'microsandbox' && resolveMsbBin(env))
  || '';

// Whether this provider has the credential it needs on this computer (same resolution as providerKey).
export const hasKey = (env, provider) => Boolean(providerKey(env, provider));

/**
 * Writes a file that holds a real secret (a login, or an MCP token the user allowed). A provider whose files.write can fall back
 * to a base64 shell command (Instabox) offers files.writeSecret, which uploads or fails; the others write through stdin or a file API.
 */
export const writeSecretFile = (sandbox, path, data) => (sandbox.files.writeSecret ?? sandbox.files.write)(path, data);
