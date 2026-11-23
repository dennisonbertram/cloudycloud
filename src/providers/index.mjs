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
};

/**
 * @param {Record<string, string | undefined>} env   reads CLOUDY_CLOUD_PROVIDER (default instabox)
 * @param {object} [deps]   passed to the adapter's createProvider (injectable sdk, fetchFn, ...)
 * @returns {Promise<Provider>}
 */
export async function loadProvider(env = process.env, deps = {}) {
  const name = env.CLOUDY_CLOUD_PROVIDER || 'instabox';
  if (!Object.hasOwn(REGISTRY, name)) throw new Error(`Unknown CLOUDY_CLOUD_PROVIDER "${name}". Known: ${Object.keys(REGISTRY).join(', ')}.`);
  return (await REGISTRY[name]()).createProvider(env, deps);
}

/**
 * Writes a file that holds a real secret (a login, or an MCP token the user allowed). A provider whose files.write can fall back
 * to a base64 shell command (Instabox) offers files.writeSecret, which uploads or fails; the others write through stdin or a file API.
 */
export const writeSecretFile = (sandbox, path, data) => (sandbox.files.writeSecret ?? sandbox.files.write)(path, data);
