import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Provider keys for model profiles, such as PARTICLE_API_KEY or OPENROUTER_API_KEY.
export const PROVIDER_KEY = /^[A-Z][A-Z0-9_]{2,63}_API_KEY$/;
const KEYS = ['CLAUDE_CLOUD_STARTS_PER_MIN', 'CLAUDE_CLOUD_MAX_INSTABOX_CALLS', 'INSTABOX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CLOUD_COORDINATOR_SNAPSHOT', 'CLAUDE_CLOUD_WORKER_HOURS', 'CLAUDE_CLOUD_DEPTH', 'CLAUDE_CLOUD_MAX_DEPTH', 'CLAUDE_CLOUD_MAX_AGENTS_PER_SESSION'];

// Environment values win over the saved file. Empty values count as unset; a missing file is fine.
export function loadEnv(env = process.env) {
  const file = env.CLAUDE_CLOUD_CONFIG || join(homedir(), '.config/claude-cloud/env');
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
export const ownerFile = (env = process.env) => join(dirname(env.CLAUDE_CLOUD_CONFIG || join(homedir(), '.config/claude-cloud/env')), 'owner');
