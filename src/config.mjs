import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveProfile } from './profiles.mjs';

// Provider keys for model profiles, such as PARTICLE_API_KEY or OPENROUTER_API_KEY.
// The key of the default provider (Instabox), which a coordinator's machine loads: it is sent no CLOUDY_CLOUD_PROVIDER.
export const DEFAULT_PROVIDER_KEY = 'INSTABOX_API_KEY';
export const PROVIDER_KEY = /^[A-Z][A-Z0-9_]{2,63}_API_KEY$/;
const KEYS = ['CLOUDY_CLOUD_AGENTS', 'CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_SSH_HOST', 'CLOUDY_CLOUD_SSH_KEY', 'CLOUDY_CLOUD_SSH_PORT', 'CLOUDY_CLOUD_CONTAINER_RUNTIME', 'CLOUDY_CLOUD_CONTAINER_BIN', 'CLOUDY_CLOUD_SELF_HOSTED_SLOTS', 'CLOUDY_CLOUD_SELF_HOSTED_CPUS', 'CLOUDY_CLOUD_SELF_HOSTED_MEMORY', 'CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX', 'CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS', 'CLOUDY_CLOUD_SELF_HOSTED_LOCAL', 'CLOUDY_CLOUD_SELF_HOSTED_CONSENT_HOST', 'CLOUDY_CLOUD_DOCKER_SOCKET', 'GH_TOKEN', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'INSTABOX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_COORDINATOR_SNAPSHOT', 'CLOUDY_CLOUD_TOKEN_ACCOUNT', 'CLOUDY_CLOUD_SNAPSHOT_ACCOUNT', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_TURN_MINUTES', 'CLOUDY_CLOUD_DEPTH', 'CLOUDY_CLOUD_MAX_DEPTH', 'CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION', 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES', 'CLOUDY_CLOUD_ALLOW_MACHINE_KINDS', 'CLOUDY_CLOUD_PROFILE_MAX', 'CLOUDY_CLOUD_PROVIDER_RETRIES', 'CLOUDY_CLOUD_EGRESS_ALLOW', 'CLOUDY_CLOUD_MSB_BIN', 'CLOUDY_CLOUD_MSB_SLOTS', 'BOAT_API_KEY', 'CLOUDY_CLOUD_BOAT_TOKEN_ON_BOX'];

// Names of the Instabox secrets that hold the Claude token and provider keys (comma-separated). Names only, never values.
export const proxySecrets = (env = process.env) => new Set(String(env.CLOUDY_CLOUD_PROXY_SECRETS ?? '').split(/[\s,]+/).filter(Boolean));

// Minutes one agent turn may run: CLOUDY_CLOUD_TURN_MINUTES, default 29, a whole number from 5 up to the machine's TTL minus 30 minutes.
// Returns { minutes } or { error }.
export const TURN_DEFAULT_MINUTES = 29;
export function turnMinutes(env = process.env, maxTtlSeconds = 86_400) {
  const raw = String(env.CLOUDY_CLOUD_TURN_MINUTES ?? '').trim();
  if (!raw) return { minutes: TURN_DEFAULT_MINUTES };
  const max = Math.floor(maxTtlSeconds / 60) - 30, n = Number(raw);
  if (/^\d+$/.test(raw) && n >= 5 && n <= max) return { minutes: n };
  return { error: `CLOUDY_CLOUD_TURN_MINUTES is "${raw.slice(0, 20)}", but it must be a whole number from 5 to ${max}.\nNext step: set CLOUDY_CLOUD_TURN_MINUTES to a whole number from 5 to ${max} in ~/.config/cloudy-cloud/env, or remove the line to use the default ${TURN_DEFAULT_MINUTES}, then call cloud_agent again.` };
}

// Extra Debian packages for the worker image (space-separated). Returns { list } or { error }.
const APT_NAME = /^[a-z0-9][a-z0-9.+-]*$/;
export function aptPackages(env = process.env) {
  const list = String(env.CLOUDY_CLOUD_APT_PACKAGES ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').split(/\s+/).filter(Boolean);
  const bad = list.find((n) => !APT_NAME.test(n));
  return bad ? { error: `CLOUDY_CLOUD_APT_PACKAGES has an invalid package name "${bad.slice(0, 40)}". Names must match ${APT_NAME}, separated by spaces. Fix the value in ~/.config/cloudy-cloud/env.` } : { list };
}

// Hosts a worker machine may connect to (comma- or space-separated; *.example.com covers the domain and its
// subdomains). No ports, schemes or paths; labels are at most 63 characters and may not start or end in a hyphen.
// Unset means no policy ({ list: [] }), and "off" or "none" says so on purpose (the per-command opt-out:
// CLOUDY_CLOUD_EGRESS_ALLOW=off ahead of a coordinator command). A value that is set but names nothing is an
// error, so a blank override cannot silently switch a saved policy off. Returns { list } (lowercased) or { error }.
const EGRESS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const EGRESS_HOST = new RegExp(`^(\\*\\.)?${EGRESS_LABEL}(\\.${EGRESS_LABEL})+$`);
export function egressAllow(env = process.env) {
  const raw = env.CLOUDY_CLOUD_EGRESS_ALLOW;
  if (raw === undefined || raw === null) return { list: [] };
  const value = String(raw).trim().replace(/^(["'])(.*)\1$/, '$2');
  if (/^(off|none)$/i.test(value)) return { list: [] };
  const parts = value.split(/[\s,]+/).filter(Boolean);
  // The error paragraph is what scripts always saw; the fix wording lives in the trusted fields a terminal
  // renders (short, dim details, next) — not appended to the script text.
  const fix = 'fix CLOUDY_CLOUD_EGRESS_ALLOW in ~/.config/cloudy-cloud/env, or remove it.';
  const names = 'Use host names such as api.example.com or *.example.com, separated by commas or spaces.';
  if (!parts.length) return { error: `CLOUDY_CLOUD_EGRESS_ALLOW is set but lists no hosts. ${names} Fix the value in ~/.config/cloudy-cloud/env or remove it.`, local: true, short: 'CLOUDY_CLOUD_EGRESS_ALLOW is set but lists no hosts.', details: [names], next: fix };
  // Name the position, never the content: a pasted entry can carry a token (a URL with credentials).
  const bad = parts.findIndex((n) => !EGRESS_HOST.test(n));
  return bad === -1 ? { list: parts.map((h) => h.toLowerCase()) } : { error: `CLOUDY_CLOUD_EGRESS_ALLOW entry ${bad + 1} is not a host name. ${names} Fix the value in ~/.config/cloudy-cloud/env.`, local: true, short: `CLOUDY_CLOUD_EGRESS_ALLOW entry ${bad + 1} is not a host name.`, details: [names], next: fix };
}

// What setup stores in CLOUDY_CLOUD_SELF_HOSTED_CONSENT_HOST to bind a self-hosted consent (token on the box,
// coordinators) to one SSH destination: the sha256 of "host:port". The destination stays opaque, so the id can be
// forwarded to a coordinator container without giving it the SSH endpoint the laptop uses.
export const consentHostId = (dest) => createHash('sha256').update(String(dest)).digest('hex');

// One env-file line is NAME=value, so a value holding CR, LF or NUL would inject lines or corrupt the file.
// Every writer builds its lines through this; the error names the key, never the value.
export function envLine(key, value) {
  const v = String(value);
  if (/[\r\n\0]/.test(v)) throw new Error(`${key}: the value may not contain CR, LF or NUL`);
  return `${key}=${v}`;
}

// What the env file holds (only the names cloudy-cloud knows); a missing file is fine.
export function savedEnv(env = process.env) {
  const file = env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env');
  const saved = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && (KEYS.includes(line.slice(0, i)) || PROVIDER_KEY.test(line.slice(0, i)))) saved[line.slice(0, i)] = line.slice(i + 1).trim();
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return saved;
}

// Environment values win over the saved file. Empty values count as unset — except an explicitly empty
// CLOUDY_CLOUD_EGRESS_ALLOW, which must reach egressAllow as "set but lists no hosts", not as no policy.
// A missing file is fine.
export const loadEnv = (env = process.env) => ({ ...savedEnv(env), ...Object.fromEntries(Object.entries(env).filter(([k, v]) => v || k === 'CLOUDY_CLOUD_EGRESS_ALLOW')) });

// Returns a function that re-reads the env file into `env` (the object the server shares) when the file's mtime changed,
// so a key added after startup applies to the next agent. Keys deleted from the file are removed; real environment values stay.
export function envRefresher(env, base = process.env) {
  const file = base.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env');
  const stamp = () => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  let seen = stamp(), fromFile = Object.keys(loadEnv(base)).filter((k) => !base[k]);
  return () => {
    const now = stamp();
    if (now === seen) return;
    seen = now;
    const fresh = loadEnv(base);
    for (const k of fromFile) if (!(k in fresh)) delete env[k];
    fromFile = Object.keys(fresh).filter((k) => !base[k]);
    Object.assign(env, fresh);
  };
}

// The server writes its owner id here, so `coordinator finish` can tell which running machines are its workers.
export const ownerFile = (env = process.env) => join(dirname(env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env')), 'owner');

// This installation's stable id: 16 random hex chars in <config dir>/install-id (the folder ownerFile names),
// created once — dir 0700, file 0600, written atomically — and never rewritten. Providers stamp it as the
// `install` label so every session of this installation owns the same workers; the per-session owner id
// only scopes which machines a reaper may delete.
export function installId(env = process.env) {
  const file = join(dirname(ownerFile(env)), 'install-id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (id) return id;
  } catch { /* missing or unreadable: created below */ }
  const id = randomBytes(8).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive create: two first-run processes must agree on one id, so the loser reads the winner's.
    writeFileSync(file, `${id}\n`, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e?.code === 'EEXIST') { try { return readFileSync(file, 'utf8').trim() || id; } catch { /* fall through */ } }
  }
  return id;
}

// Workers run the Claude harness unless cloud_agent gets a profile. A host session for another agent (codex, opencode, pi) starts
// without a Claude token, so this says what to pass instead. '' when a Claude credential exists. env is the result of loadEnv().
// It names only a profile that resolveProfile accepts under the provider's rules: on Instabox a key must be a proxy secret.
export function defaultWorkerNote(env) {
  const proxied = proxySecrets(env);
  const has = (k) => env[k] || proxied.has(k);
  if (has('CLAUDE_CODE_OAUTH_TOKEN') || has('ANTHROPIC_API_KEY')) return '';
  // self-hosted and boat keep consented values on the machine and microsandbox substitutes local values into
  // matching requests (caps.localSecrets), so a plain key is usable on all three; everywhere else it must be a proxy secret.
  const proxyOnly = !['self-hosted', 'microsandbox', 'boat'].includes(env.CLOUDY_CLOUD_PROVIDER || 'instabox');
  const profile = [['codex'], ['codex-chatgpt'], ['pi-glm'], ['openrouter', ' (also pass model, an OpenRouter model id)']].find(([n]) => resolveProfile(n, 'x', env, { proxyOnly }).ok);
  const head = 'No Claude token is saved, so a cloud_agent call without a profile is refused.';
  const step = proxyOnly
    ? 'run: cloudy-cloud setup --more (save OPENAI_API_KEY, PARTICLE_API_KEY or OPENROUTER_API_KEY as a proxy secret, or a Claude token).'
    : `add OPENAI_API_KEY, PARTICLE_API_KEY or OPENROUTER_API_KEY (or a Claude token) to ~/.config/cloudy-cloud/env; the ${env.CLOUDY_CLOUD_PROVIDER} provider reads the value on this computer.`;
  return profile ? `${head}\nNext step: pass profile: ${profile[0]}${profile[1] ?? ''} on every cloud_agent call.`
    : `${head}\nNext step: ${step}`;
}
