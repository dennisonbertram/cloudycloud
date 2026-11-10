// The provider interface. A provider is a plain object; one file per provider in this folder exports
// `createProvider(env, deps)` and is listed in REGISTRY below (no directory scanning).

/**
 * @typedef {object} Caps
 * @property {boolean} hasServerTTL      the server deletes a machine at its deadline
 * @property {boolean} hasProxySecrets   secrets reach the machine as placeholders, never as values
 * @property {boolean} hasSnapshots
 * @property {boolean} hasPortForward
 * @property {boolean} hasPublish
 * @property {number} maxForegroundMs    longest foreground command
 * @property {number} maxTtlSeconds
 * @property {number} startsPerMin       default for CLOUDY_CLOUD_STARTS_PER_MIN
 * @property {number} maxConcurrentCalls default for CLOUDY_CLOUD_MAX_INSTABOX_CALLS
 * @property {number} uploadMaxBytes
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
 */

/**
 * Errors thrown by a provider carry a normalised `code`: rate_limited (+ retryAfterSeconds), quota_exceeded,
 * not_found, no_key or transient.
 * @typedef {object} Provider
 * @property {string} name
 * @property {string} keyName            environment variable that holds the API key
 * @property {Caps} caps
 * @property {(o: { image: string, envs: Record<string, string>, labels: Record<string, string>, name?: string, ttlSeconds: number, secrets?: string[], neverSuspend?: boolean }) => Promise<Sandbox>} create
 * @property {(id: string) => Promise<Sandbox>} connect
 * @property {(labels?: Record<string, string>, opts?: { sdk?: boolean }) => Promise<Array<{ id: string, name: string, labels: Record<string, string>, state: string, status: 'starting'|'running'|'stopped'|'failed', startedAt: number, archiveAt?: number, deleteAt?: string }>>} list
 * @property {(id: string, opts?: { sdk?: boolean, retries?: number, log?: (line: string) => void }) => Promise<void>} delete   a 404 counts as deleted
 * @property {(sandbox: Sandbox, o: { name: string, description?: string }) => Promise<{ id: string, status: string }>} snapshot
 * @property {(id: string) => Promise<{ id: string, status: string }>} getSnapshot
 * @property {(id: string, localRemote: string) => Promise<number>} forwardPort   resolves the exit code
 * @property {(id: string, port: string) => Promise<{ url: string }>} publishPort
 * @property {(id: string, port: string) => Promise<number>} unpublishPort
 * @property {(hostname: string) => string} localMachineName   machine name for the host this runs on, or ''
 * @property {{ ssh(machine: string, cmd: string): string, listMachines: string, noKeyFix: string, apiFix: string, githubTokenHelp: string }} text
 */

// Adapters are imported lazily, so a missing or heavy adapter costs nothing until it is chosen.
const REGISTRY = {
  instabox: () => import('./instabox.mjs'),
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
