// Detached cleanup process. The server starts it; once the server is gone it deletes every machine the server owned.
// Usage: node reaper.mjs <server pid> <instance id>. The API key comes from the chosen provider's key variable
// (provider.keyName) and CLOUDY_CLOUD_PROVIDER picks the provider, as in the server. It never loads a provider SDK.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { loadProvider } from './providers/index.mjs';
import { resolveMsbBin } from './providers/microsandbox.mjs';

const MAX_LIFETIME_MS = 24 * 60 * 60_000;

const REAPER = fileURLToPath(import.meta.url);

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

// The key goes only in the child's environment, never in argv (argv is visible in `ps`).
export const reaperSpawn = (pid, owner, env, provider, baseEnv = process.env) => {
  const providers = provider.providers ?? [provider];
  const childEnv = { ...baseEnv, CLOUDY_CLOUD_PROVIDERS: providers.map((p) => p.name).join(','), CLOUDY_CLOUD_PROVIDER: providers[0].name };
  for (const p of providers) {
    const key = providerKey(env, p);
    if (key) childEnv[p.keyName] = key;
  }
  return { command: process.execPath, args: [REAPER, String(pid), owner], options: { detached: true, stdio: 'ignore', env: childEnv } };
};

// Starts the detached reaper for the server and returns the child (null when the spawn itself threw),
// so the server can start a new one once this child is gone. Every provider key is passed in its env variable.
export function startReaper(pid, owner, env, provider, spawnFn = nodeSpawn) {
  const { command, args, options } = reaperSpawn(pid, owner, env, provider);
  let child;
  try { child = spawnFn(command, args, options); } catch { return null; }
  child.on('error', () => {}).unref();
  return child;
}

export const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

// Deletes the machines owned by `owner`. Returns the number deleted. provider.delete retries and treats 404 as deleted.
async function reapAttempt({ owner, provider, log = () => {} }) {
  let failed = false;
  let machines;
  const listFailed = (e) => { failed = true; log(`list failed${e.provider ? ` on ${e.provider}` : ''}: ${e.message}`); };
  try { machines = await provider.list({ owner }, { onError: listFailed }); }
  catch (e) { if (!failed) listFailed(e); return { deleted: 0, failed: true }; }
  let deleted = 0;
  for (const m of machines) {
    if (m?.labels?.owner !== owner || !m.id) continue;
    let logged = false; // the adapter logs each failed attempt itself; log the final error only if it did not
    try { await (provider.for ? provider.for(m) : provider).delete(m.id, { retries: 2, log: (l) => { logged = true; log(l); } }); deleted++; }
    catch (e) { failed = true; if (!logged) log(`delete ${m.id} failed: ${e.message}`); }
  }
  return { deleted, failed };
}

export async function reap(args) { return (await reapAttempt(args)).deleted; }

// Polls until the parent is gone, then reaps. Resolves when done (or after the lifetime backstop).
export async function watch({ pid, owner, provider, alive = isAlive, log, pollMs = 2000, retryMs = 5000, maxMs = MAX_LIFETIME_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let waited = 0; waited < maxMs; waited += pollMs) {
    if (!alive(pid)) {
      let retry = 0;
      for (let elapsed = 0; elapsed < maxMs; retry++) {
        const result = await reapAttempt({ owner, provider, log });
        if (!result.failed) return result.deleted;
        const delay = Math.min(retryMs * 2 ** Math.min(retry, 4), 60_000, maxMs - elapsed);
        if (delay < 0) return result.deleted;
        await sleep(delay);
        elapsed += delay || 1;
      }
      return 0;
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pid, owner] = process.argv.slice(2);
  // The saved settings file too: self-hosted needs CLOUDY_CLOUD_CONTAINER_BIN, _SSH_KEY and _SSH_PORT from it.
  const env = loadEnv(process.env);
  const provider = await loadProvider(env, { owner }).catch(() => null);
  // The same resolution the server used (a coordinator's proxy-secret name counts, msb is found by the ladder).
  const ready = provider && (provider.providers ?? [provider]).some((p) => providerKey(env, p));
  if (!provider || !ready || !(Number(pid) > 0) || !owner) process.exit(1);
  watch({ pid: Number(pid), owner, provider }).finally(() => process.exit(0));
}
