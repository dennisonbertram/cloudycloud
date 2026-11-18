// Tells the user when a newer cloudycloud is on npm. The launcher runs `node update-check.mjs` once per session start.
// It only reads a cache file; a detached `refresh` process updates the cache at most once a day, so startup never waits.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 3600 * 1000;
export const cachePath = (home = homedir()) => join(home, '.config', 'cloudy-cloud', 'update-check.json');

// isNewer(a, b): true when version a is newer than b, by SemVer precedence (build metadata ignored).
export function isNewer(a, b) {
  const parse = (v) => { const [core, pre] = String(v).trim().replace(/^v/, '').split('+')[0].split(/-(.*)/s); return { n: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre === undefined ? null : pre.split('.') }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0);
  if (!x.pre || !y.pre) return !x.pre && !!y.pre;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q);
    if (pn !== qn) return qn; // numeric identifiers rank below alphanumeric ones
    return p > q;
  }
  return x.pre.length > y.pre.length;
}

// The path for `cd`: ~ replaces the home folder only at a path boundary; odd characters are single-quoted (after ~/ so ~ still expands).
const q = (p) => (/^[A-Za-z0-9_./-]*$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`);
const shown = (root, home) => (root === home ? '~' : root.startsWith(home + sep) ? `~/${q(root.slice(home.length + 1))}` : q(root));

// An unreadable or invalid cache (not an object, bad or future checkedAt) counts as missing.
const readCache = (home, now = Date.now()) => {
  try {
    const c = JSON.parse(readFileSync(cachePath(home), 'utf8'));
    return c && typeof c === 'object' && Number.isFinite(c.checkedAt) && c.checkedAt <= now ? c : {};
  } catch { return {}; }
};

// check(opts): prints the notice when a newer version is cached and starts a refresh when the cache is missing or old.
// Returns nothing; every failure is ignored. opts is injectable for tests.
export function check({ version, env = process.env, home = homedir(), isTTY = process.stdout.isTTY && process.stderr.isTTY, now = Date.now(), write = (s) => process.stderr.write(s), root = join(dirname(fileURLToPath(import.meta.url)), '..'), startRefresh = defaultRefresh } = {}) {
  try {
    if (!isTTY || env.CI || env.CLOUDY_CLOUD_NO_UPDATE_CHECK === '1') return;
    const c = readCache(home, now);
    if (typeof c.latest === 'string' && isNewer(c.latest, version)) {
      const how = existsSync(join(root, '.git')) ? `cd ${shown(root, home)} && git pull && npm install` : 'npm install -g cloudycloud@latest';
      write(`Cloudy Cloud ${c.latest} is available (you have ${version}). Update: ${how}\n`);
    }
    if (!(now - c.checkedAt < DAY)) startRefresh();
  } catch { /* never block a session */ }
}

function defaultRefresh() {
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'refresh'], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

// refresh(opts): fetches the latest version and writes the cache atomically. Ignores every error.
export async function refresh({ home = homedir(), now = Date.now(), fetchFn = fetch } = {}) {
  try {
    const file = cachePath(home);
    const save = (latest) => { writeFileSync(`${file}.${process.pid}`, JSON.stringify({ checkedAt: now, latest })); renameSync(`${file}.${process.pid}`, file); };
    mkdirSync(dirname(file), { recursive: true });
    // Claim the attempt first (keeping the old latest), so an offline machine retries at most daily. No claim, no fetch.
    const prev = readCache(home, now).latest;
    save(prev);
    const r = await fetchFn('https://registry.npmjs.org/cloudycloud/latest', { signal: AbortSignal.timeout(3000) });
    const { version } = await r.json();
    if (typeof version === 'string') save(version);
  } catch { /* ignored */ }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'refresh') await refresh();
  else check({ version: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version });
}
