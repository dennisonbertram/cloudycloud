// Detached cleanup process. The server starts it; once the server is gone it deletes every machine the
// server owned, on every configured provider.
// Usage: node reaper.mjs <server pid> <instance id>. The providers come from CLOUDY_CLOUD_PROVIDERS /
// CLOUDY_CLOUD_PROVIDER and each provider's credential rides in its own key variable (provider.keyName),
// as in the server. It never loads a provider SDK.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { hasKey, loadProvider, providerKey } from './providers/index.mjs';

export { providerKey };

const MAX_LIFETIME_MS = 24 * 60 * 60_000;

const REAPER = fileURLToPath(import.meta.url);

// The keys go only in the child's environment, never in argv (argv is visible in `ps`). Only a key that
// resolves is set — an unresolved one must never reach the child as the string "undefined".
// CLOUDY_CLOUD_PROVIDERS names the whole list so the child reaps every provider;
// CLOUDY_CLOUD_PROVIDER is the first, the same value loadEnv derives.
export const reaperSpawn = (pid, owner, env, provider, baseEnv = process.env) => {
  const ps = provider.providers ?? [provider];
  const childEnv = { ...baseEnv, CLOUDY_CLOUD_PROVIDERS: ps.map((p) => p.name).join(','), CLOUDY_CLOUD_PROVIDER: ps[0].name };
  for (const p of ps) {
    const key = providerKey(env, p);
    if (key) childEnv[p.keyName] = key;
  }
  return {
    command: process.execPath,
    args: [REAPER, String(pid), owner],
    options: { detached: true, stdio: 'ignore', env: childEnv },
  };
};

// Starts the detached reaper for the server and returns the child (null when the spawn itself threw),
// so the server can start a new one once this child is gone. Each provider's key comes from providerKey.
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

// Deletes the machines owned by `owner`. Returns the number deleted. provider.delete retries and treats
// 404 as deleted. With several providers (a combined provider) one provider's list failure is reported
// through onError with e.provider set and the rest are still reaped; list throws only when all failed —
// that error was already reported, so it is not logged again.
export async function reap({ owner, provider, log = () => {} }) {
  let machines;
  const failed = (e) => log(`list failed${e.provider ? ` on ${e.provider}` : ''}: ${e.message}`);
  try { machines = await provider.list({ owner }, { onError: failed }); } catch (e) { if (!e.provider) failed(e); return 0; }
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
  // The same resolution the server used (a coordinator's proxy-secret name counts, msb is found by the
  // ladder): the reaper is ready when any configured provider has its credential.
  const ready = provider && (provider.providers ?? [provider]).some((p) => hasKey(env, p));
  if (!provider || !ready || !(Number(pid) > 0) || !owner) process.exit(1);
  watch({ pid: Number(pid), owner, provider }).finally(() => process.exit(0));
}
