// Detached cleanup process. The server starts it; once the server is gone it deletes every machine the server owned.
// Usage: node reaper.mjs <server pid> <instance id>. The API key comes from the INSTABOX_API_KEY environment variable.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const API = 'https://api.instabox.sh/v1/machines';
const MAX_LIFETIME_MS = 24 * 60 * 60_000;

const REAPER = fileURLToPath(import.meta.url);

// The key goes only in the child's environment, never in argv (argv is visible in `ps`).
export const reaperSpawn = (pid, owner, apiKey, baseEnv = process.env) => ({
  command: process.execPath,
  args: [REAPER, String(pid), owner],
  options: { detached: true, stdio: 'ignore', env: { ...baseEnv, INSTABOX_API_KEY: apiKey } },
});

export const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

// Deletes the machines owned by `owner`. Returns the number deleted.
export async function reap({ owner, apiKey, fetchFn = fetch, log = () => {}, retries = 2 }) {
  const res = await fetchFn(`${API}?metadata=${encodeURIComponent(`owner:${owner}`)}`, { headers: { 'X-API-Key': apiKey } });
  if (!res.ok) { log(`list failed: HTTP ${res.status}`); return 0; }
  const { machines = [] } = await res.json();
  let deleted = 0;
  for (const m of machines) {
    if (m?.metadata?.owner !== owner || !m.id) continue;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await fetchFn(`${API}/${encodeURIComponent(m.id)}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': apiKey, 'Idempotency-Key': randomUUID(), 'X-Confirm-Delete': m.id },
      }).catch(() => null);
      if (r?.ok || r?.status === 404) { deleted++; break; }
      log(`delete ${m.id} failed: ${r ? `HTTP ${r.status}` : 'network error'}`);
    }
  }
  return deleted;
}

// Polls until the parent is gone, then reaps. Resolves when done (or after the lifetime backstop).
export async function watch({ pid, owner, apiKey, fetchFn, alive = isAlive, log, pollMs = 2000, maxMs = MAX_LIFETIME_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let waited = 0; waited < maxMs; waited += pollMs) {
    if (!alive(pid)) return reap({ owner, apiKey, fetchFn, log });
    await sleep(pollMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pid, owner] = process.argv.slice(2);
  const apiKey = process.env.INSTABOX_API_KEY;
  if (!apiKey || !(Number(pid) > 0) || !owner) process.exit(1);
  watch({ pid: Number(pid), owner, apiKey }).finally(() => process.exit(0));
}
