import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/config.mjs';

test('saved keys load, environment wins, empty means unset, other names ignored', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'INSTABOX_API_KEY=saved=value\nCLAUDE_CODE_OAUTH_TOKEN=saved-token\nPATH=/evil\n');
  const env = loadEnv({ CLAUDE_CLOUD_CONFIG: file, CLAUDE_CODE_OAUTH_TOKEN: 'from-env', INSTABOX_API_KEY: '' });
  assert.equal(env.INSTABOX_API_KEY, 'saved=value');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'from-env');
  assert.equal(env.PATH, undefined);
  assert.equal(loadEnv({ CLAUDE_CLOUD_CONFIG: file + '-missing' }).INSTABOX_API_KEY, undefined);
});
