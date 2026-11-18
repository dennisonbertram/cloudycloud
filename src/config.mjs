import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Provider keys for model profiles, such as PARTICLE_API_KEY or OPENROUTER_API_KEY.
// The key of the default provider (Instabox), which a coordinator's machine loads: it is sent no CLOUDY_CLOUD_PROVIDER.
export const DEFAULT_PROVIDER_KEY = 'INSTABOX_API_KEY';
export const PROVIDER_KEY = /^[A-Z][A-Z0-9_]{2,63}_API_KEY$/;
const KEYS = ['CLOUDY_CLOUD_AGENTS', 'CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_SSH_HOST', 'CLOUDY_CLOUD_SSH_KEY', 'CLOUDY_CLOUD_SSH_PORT', 'CLOUDY_CLOUD_CONTAINER_RUNTIME', 'CLOUDY_CLOUD_CONTAINER_BIN', 'CLOUDY_CLOUD_SELF_HOSTED_SLOTS', 'CLOUDY_CLOUD_SELF_HOSTED_CPUS', 'CLOUDY_CLOUD_SELF_HOSTED_MEMORY', 'CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX', 'CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS', 'CLOUDY_CLOUD_SELF_HOSTED_LOCAL', 'CLOUDY_CLOUD_DOCKER_SOCKET', 'GH_TOKEN', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'INSTABOX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_COORDINATOR_SNAPSHOT', 'CLOUDY_CLOUD_TOKEN_ACCOUNT', 'CLOUDY_CLOUD_SNAPSHOT_ACCOUNT', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_DEPTH', 'CLOUDY_CLOUD_MAX_DEPTH', 'CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION', 'CLOUDY_CLOUD_PROXY_SECRETS', 'CLOUDY_CLOUD_APT_PACKAGES', 'CLOUDY_CLOUD_ALLOW_MACHINE_KINDS'];

// Names of the Instabox secrets that hold the Claude token and provider keys (comma-separated). Names only, never values.
export const proxySecrets = (env = process.env) => new Set(String(env.CLOUDY_CLOUD_PROXY_SECRETS ?? '').split(/[\s,]+/).filter(Boolean));

// Extra Debian packages for the worker image (space-separated). Returns { list } or { error }.
const APT_NAME = /^[a-z0-9][a-z0-9.+-]*$/;
export function aptPackages(env = process.env) {
  const list = String(env.CLOUDY_CLOUD_APT_PACKAGES ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').split(/\s+/).filter(Boolean);
  const bad = list.find((n) => !APT_NAME.test(n));
  return bad ? { error: `CLOUDY_CLOUD_APT_PACKAGES has an invalid package name "${bad.slice(0, 40)}". Names must match ${APT_NAME}, separated by spaces. Fix the value in ~/.config/cloudy-cloud/env.` } : { list };
}

// Environment values win over the saved file. Empty values count as unset; a missing file is fine.
export function loadEnv(env = process.env) {
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
  return { ...saved, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
}

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

// Workers run the Claude harness unless cloud_agent gets a profile. A host session for another agent (codex, opencode, pi) starts
// without a Claude token, so this says what to pass instead. '' when a Claude credential exists. env is the result of loadEnv().
export function defaultWorkerNote(env) {
  const proxied = proxySecrets(env);
  const has = (k) => env[k] || proxied.has(k);
  if (has('CLAUDE_CODE_OAUTH_TOKEN') || has('ANTHROPIC_API_KEY')) return '';
  const login = existsSync(env.CLOUDY_CLOUD_CODEX_AUTH || join(homedir(), '.config/cloudy-cloud/codex-auth.json'));
  const profile = has('OPENAI_API_KEY') ? 'codex' : login ? 'codex-chatgpt' : has('PARTICLE_API_KEY') ? 'pi-glm' : has('OPENROUTER_API_KEY') ? 'openrouter (also pass model, an OpenRouter model id)' : '';
  const head = 'No Claude token is saved, so a cloud_agent call without a profile is refused.';
  return profile ? `${head}\nNext step: pass profile: ${profile} on every cloud_agent call.`
    : `${head}\nNext step: run: cloudy-cloud setup (save OPENAI_API_KEY, PARTICLE_API_KEY or OPENROUTER_API_KEY, or a Claude token).`;
}
