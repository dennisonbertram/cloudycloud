import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS = ['CLAUDE_CLOUD_STARTS_PER_MIN', 'CLAUDE_CLOUD_MAX_INSTABOX_CALLS', 'INSTABOX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Environment values win over the saved file. Empty values count as unset; a missing file is fine.
export function loadEnv(env = process.env) {
  const file = env.CLAUDE_CLOUD_CONFIG || join(homedir(), '.config/claude-cloud/env');
  const saved = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && KEYS.includes(line.slice(0, i))) saved[line.slice(0, i)] = line.slice(i + 1).trim();
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { ...saved, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
}
