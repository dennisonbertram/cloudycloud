// The provider interface. A provider is a plain object; one file per provider in this folder exports
// `createProvider(env, deps)` and is listed in REGISTRY below (no directory scanning).

/**
 * @typedef {object} Caps
 * @property {boolean} hasServerTTL      the server deletes a machine at its deadline
 * @property {boolean} hasProxySecrets   secrets reach the machine as placeholders, never as values
 * @property {boolean} [hasSudo]         the worker user can run passwordless sudo (apt installs); absent means hasProxySecrets
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
 * @property {{ ssh(machine: string, cmd: string): string, listMachines: string, listMachinesUi?: string, noKeyFix: string, apiFix: string, githubTokenHelp: string }} text   listMachines is the provider-native command piped output has always named; listMachinesUi, when present, is the friendlier line a terminal shows
 */

// Adapters are imported lazily, so a missing or heavy adapter costs nothing until it is chosen.
const REGISTRY = {
  instabox: () => import('./instabox.mjs'),
  'self-hosted': () => import('./self-hosted.mjs'),
  microsandbox: () => import('./microsandbox.mjs'),
  boat: () => import('./boat.mjs'),
  e2b: () => import('./e2b.mjs'),
};

/** Ordered, de-duplicated provider configuration. A legacy single setting remains the fallback. */
export function providerNames(env = process.env) {
  const configured = [...new Set(String(env.CLOUDY_CLOUD_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean))];
  const names = configured.length ? configured : [env.CLOUDY_CLOUD_PROVIDER || 'instabox'];
  for (const name of names) {
    if (!Object.hasOwn(REGISTRY, name)) throw new Error(`Unknown CLOUDY_CLOUD_PROVIDER "${name}". Known: ${Object.keys(REGISTRY).join(', ')}.`);
  }
  return names;
}

/** Load each configured adapter in order. */
export async function loadProviders(env = process.env, deps = {}) {
  return Promise.all(providerNames(env).map(async (name) => (await REGISTRY[name]()).createProvider(env, deps)));
}

/**
 * @param {Record<string, string | undefined>} env   reads CLOUDY_CLOUD_PROVIDERS, then CLOUDY_CLOUD_PROVIDER (default instabox)
 * @param {object} [deps]   passed to the adapter's createProvider (injectable sdk, fetchFn, ...)
 * @returns {Promise<Provider>} the adapter itself for one provider, otherwise a tagged composite facade
 */
export async function loadProvider(env = process.env, deps = {}) {
  const providers = await loadProviders(env, deps);
  return providers.length === 1 ? providers[0] : combine(providers);
}

/**
 * A provider facade for legacy consumers. Creation stays on the primary; listed rows carry their provider
 * name, and ID operations use the owner last discovered by list. Duplicate IDs are intentionally ambiguous.
 */
export function combine(providers) {
  if (!providers?.length) throw new Error('At least one provider is required.');
  const primary = providers[0];
  const owners = new Map();
  const duplicate = new Set();
  let listIncomplete = false;
  const forMachine = (machineOrId) => {
    if (machineOrId && typeof machineOrId === 'object') {
      if (machineOrId.provider) return providers.find((p) => p.name === machineOrId.provider);
      machineOrId = machineOrId.id;
    }
    if (listIncomplete) throw Object.assign(new Error('Machine ownership is unknown because one or more configured providers could not be listed.'), { code: 'provider_ownership_unavailable' });
    if (duplicate.has(machineOrId)) throw Object.assign(new Error(`Machine ID ${machineOrId} appears on more than one provider.`), { code: 'ambiguous' });
    return owners.get(machineOrId);
  };
  const tagError = (error, name) => {
    if (error && typeof error === 'object' && typeof error.provider === 'string' && error.provider) return error;
    if (error && typeof error === 'object') {
      try { error.provider = name; if (error.provider === name) return error; } catch { /* provider error may be frozen */ }
    }
    const tagged = new Error(String(error?.message ?? error), { cause: error });
    if (error?.name) tagged.name = error.name;
    for (const key of ['code', 'status', 'exitCode', 'stdout', 'stderr']) if (error?.[key] !== undefined) tagged[key] = error[key];
    tagged.provider = name;
    return tagged;
  };
  const list = async (labels = {}, opts = {}) => {
    const reported = providers.map(() => []);
    const report = (index, error) => {
      const prior = reported[index].find((entry) => entry.source === error);
      if (prior) return prior.tagged;
      const tagged = tagError(error, providers[index].name);
      reported[index].push({ source: error, tagged });
      opts.onError?.(tagged);
      return tagged;
    };
    const results = await Promise.allSettled(providers.map((p, index) => p.list(labels, {
      ...opts,
      onError: (e) => report(index, e),
    })));
    const rows = [], errors = [];
    results.forEach((result, index) => {
      const p = providers[index];
      if (result.status === 'rejected') {
        report(index, result.reason);
      }
      for (const { tagged } of reported[index]) if (!errors.includes(tagged)) errors.push(tagged);
      if (result.status === 'rejected') return;
      for (const row of result.value) {
        if (owners.has(row.id) && owners.get(row.id) !== p) duplicate.add(row.id);
        owners.set(row.id, p);
        rows.push({ ...row, provider: p.name });
      }
    });
    listIncomplete = errors.length > 0;
    if (providers.every((_, i) => results[i].status === 'rejected' || reported[i].length > 0)) throw errors[0];
    return rows;
  };
  const route = async (id) => {
    let p = forMachine(id);
    if (!p) {
      const errors = [];
      await list({ purpose: 'cloudy-cloud' }, { onError: (e) => errors.push(e) });
      if (errors.length) throw Object.assign(new Error('Cannot route a bare machine ID while a configured provider could not be listed.'), { code: 'provider_ownership_unavailable', providers: errors.map((e) => e.provider) });
      p = forMachine(id);
    }
    if (!p) throw Object.assign(new Error(`Machine ${id} was not found on a configured provider.`), { code: 'not_found' });
    return p;
  };
  const caps = {};
  for (const key of new Set(providers.flatMap((p) => Object.keys(p.caps ?? {})))) {
    const values = providers.map((p) => p.caps?.[key]);
    caps[key] = values.every((v) => typeof v === 'boolean') ? values.every(Boolean)
      : Array.isArray(values[0]) ? values[0].filter((v) => values.every((xs) => Array.isArray(xs) && xs.includes(v)))
      : values[0];
  }
  const facade = {
    name: primary.name, keyName: primary.keyName, caps, text: primary.text, providers, for: forMachine, list,
    create: (...args) => primary.create(...args),
    connect: async (id, ...args) => (await route(id)).connect(id, ...args),
    delete: async (id, ...args) => { await (await route(id)).delete(id, ...args); owners.delete(id); duplicate.delete(id); },
    metrics: async (id, ...args) => (await route(id)).metrics(id, ...args),
  };
  for (const method of ['snapshot', 'getSnapshot', 'forwardPort', 'publishPort', 'unpublishPort', 'shellEnv', 'shellArgv', 'shellSpawnOpts', 'displayLink', 'plan', 'revokeDisplayLinks', 'screenshot', 'localMachineName']) {
    if (typeof primary[method] === 'function') facade[method] = (...args) => primary[method](...args);
  }
  return facade;
}

/**
 * Writes a file that holds a real secret (a login, or an MCP token the user allowed). A provider whose files.write can fall back
 * to a base64 shell command (Instabox) offers files.writeSecret, which uploads or fails; the others write through stdin or a file API.
 */
export const writeSecretFile = (sandbox, path, data) => (sandbox.files.writeSecret ?? sandbox.files.write)(path, data);
