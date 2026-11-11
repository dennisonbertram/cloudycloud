// Detached cleanup process. The server starts it; once the server is gone it deletes every machine the server owned.
// Usage: node reaper.mjs <server pid> <instance id>. The API key comes from the chosen provider's key variable
// (provider.keyName) and CLOUDY_CLOUD_PROVIDER picks the provider, as in the server. It never loads a provider SDK.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { loadProvider } from './providers/index.mjs';

const MAX_LIFETIME_MS = 24 * 60 * 60_000;

const REAPER = fileURLToPath(import.meta.url);

// The key goes only in the child's environment, never in argv (argv is visible in `ps`).
export const reaperSpawn = (pid, owner, apiKey, provider, baseEnv = process.env) => ({
  command: process.execPath,
  args: [REAPER, String(pid), owner],
  options: { detached: true, stdio: 'ignore', env: { ...baseEnv, [provider.keyName]: apiKey, CLOUDY_CLOUD_PROVIDER: provider.name } },
});

// Starts the detached reaper for the server. The server calls this with its provider and the key from its own env.
export function startReaper(pid, owner, env, provider, spawnFn = nodeSpawn) {
  const { command, args, options } = reaperSpawn(pid, owner, env[provider.keyName], provider);
  spawnFn(command, args, options).on('error', () => {}).unref();
}

export const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

// Deletes the machines owned by `owner`. Returns the number deleted. provider.delete retries and treats 404 as deleted.
export async function reap({ owner, provider, log = () => {} }) {
  let machines;
  try { machines = await provider.list({ owner }, { onError: (e) => log(`list failed: ${e.message}`) }); } catch (e) { log(`list failed: ${e.message}`); return 0; }
  let deleted = 0;
  for (const m of machines) {
    if (m?.labels?.owner !== owner || !m.id) continue;
    let logged = false; // the adapter logs each failed attempt itself; log the final error only if it did not
    try { await provider.delete(m.id, { retries: 2, log: (l) => { logged = true; log(l); } }); deleted++; } catch (e) { if (!logged) log(`delete ${m.id} failed: ${e.message}`); }
  }
  return deleted;
}

// Polls until the parent is gone, then reaps. Resolves when done (or after the lifetime backstop).
export async function watch({ pid, owner, provider, alive = isAlive, log, pollMs = 2000, maxMs = MAX_LIFETIME_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let waited = 0; waited < maxMs; waited += pollMs) {
    if (!alive(pid)) return reap({ owner, provider, log });
    await sleep(pollMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pid, owner] = process.argv.slice(2);
  // The saved settings file too: self-hosted needs CLOUDY_CLOUD_CONTAINER_BIN, _SSH_KEY and _SSH_PORT from it.
  const env = loadEnv(process.env);
  const provider = await loadProvider(env).catch(() => null);
  if (!provider || !env[provider.keyName] || !(Number(pid) > 0) || !owner) process.exit(1);
  watch({ pid: Number(pid), owner, provider }).finally(() => process.exit(0));
}
