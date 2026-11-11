import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Provider keys for model profiles, such as PARTICLE_API_KEY or OPENROUTER_API_KEY.
export const PROVIDER_KEY = /^[A-Z][A-Z0-9_]{2,63}_API_KEY$/;
const KEYS = ['CLOUDY_CLOUD_PROVIDER', 'CLOUDY_CLOUD_SSH_HOST', 'CLOUDY_CLOUD_SSH_KEY', 'CLOUDY_CLOUD_SSH_PORT', 'CLOUDY_CLOUD_CONTAINER_RUNTIME', 'CLOUDY_CLOUD_CONTAINER_BIN', 'CLOUDY_CLOUD_SELF_HOSTED_SLOTS', 'CLOUDY_CLOUD_SELF_HOSTED_CPUS', 'CLOUDY_CLOUD_SELF_HOSTED_MEMORY', 'CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX', 'GH_TOKEN', 'CLOUDY_CLOUD_STARTS_PER_MIN', 'CLOUDY_CLOUD_MAX_INSTABOX_CALLS', 'INSTABOX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLOUDY_CLOUD_COORDINATOR_SNAPSHOT', 'CLOUDY_CLOUD_TOKEN_ACCOUNT', 'CLOUDY_CLOUD_SNAPSHOT_ACCOUNT', 'CLOUDY_CLOUD_WORKER_HOURS', 'CLOUDY_CLOUD_DEPTH', 'CLOUDY_CLOUD_MAX_DEPTH', 'CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION'];

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

// The server writes its owner id here, so `coordinator finish` can tell which running machines are its workers.
export const ownerFile = (env = process.env) => join(dirname(env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env')), 'owner');
