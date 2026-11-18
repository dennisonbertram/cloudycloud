// Tells the user when a newer cloudycloud is on npm. The launcher runs `node update-check.mjs` once per session start.
// It only reads a cache file; a detached `refresh` process updates the cache at most once a day, so startup never waits.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 3600 * 1000;
export const cachePath = (home = homedir()) => join(home, '.config', 'cloudy-cloud', 'update-check.json');

// isNewer(a, b): true when version a is newer than b. Numeric parts compare as numbers; a prerelease is older than its release.
export function isNewer(a, b) {
  const parse = (v) => { const [core, pre] = String(v).trim().replace(/^v/, '').split('-'); return { n: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre !== undefined }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0);
  return !x.pre && y.pre;
}

const readCache = (home) => { try { return JSON.parse(readFileSync(cachePath(home), 'utf8')); } catch { return {}; } };

// check(opts): prints the notice when a newer version is cached and starts a refresh when the cache is missing or old.
// Returns nothing; every failure is ignored. opts is injectable for tests.
export function check({ version, env = process.env, home = homedir(), isTTY = process.stdout.isTTY && process.stderr.isTTY, now = Date.now(), write = (s) => process.stderr.write(s), startRefresh = defaultRefresh } = {}) {
  try {
    if (!isTTY || env.CI || env.CLOUDY_CLOUD_NO_UPDATE_CHECK === '1') return;
    const c = readCache(home);
    if (typeof c.latest === 'string' && isNewer(c.latest, version)) {
      write(`Cloudy Cloud ${c.latest} is available (you have ${version}). Update: npm install -g cloudycloud@latest\n`);
    }
    if (!(now - c.checkedAt < DAY)) startRefresh();
  } catch { /* never block a session */ }
}

function defaultRefresh() {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'refresh'], { detached: true, stdio: 'ignore' }).unref();
}

// refresh(opts): fetches the latest version and writes the cache atomically. Ignores every error.
export async function refresh({ home = homedir(), now = Date.now(), fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn('https://registry.npmjs.org/cloudycloud/latest', { signal: AbortSignal.timeout(3000) });
    const { version } = await r.json();
    if (typeof version !== 'string') return;
    const file = cachePath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.${process.pid}`, JSON.stringify({ checkedAt: now, latest: version }));
    renameSync(`${file}.${process.pid}`, file);
  } catch { /* ignored */ }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'refresh') await refresh();
  else check({ version: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version });
}
