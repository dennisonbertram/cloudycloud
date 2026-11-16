import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envRefresher, loadEnv } from '../src/config.mjs';

test('saved keys load, environment wins, empty means unset, other names ignored', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'INSTABOX_API_KEY=saved=value\nCLAUDE_CODE_OAUTH_TOKEN=saved-token\nPATH=/evil\n');
  const env = loadEnv({ CLOUDY_CLOUD_CONFIG: file, CLAUDE_CODE_OAUTH_TOKEN: 'from-env', INSTABOX_API_KEY: '' });
  assert.equal(env.INSTABOX_API_KEY, 'saved=value');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'from-env');
  assert.equal(env.PATH, undefined);
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file + '-missing' }).INSTABOX_API_KEY, undefined);
});

test('envRefresher applies keys added, changed or removed in the env file without a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cc-envr-')), 'env');
  const base = { CLOUDY_CLOUD_CONFIG: file, GH_TOKEN: 'shell' };
  writeFileSync(file, 'INSTABOX_API_KEY=a\n');
  const env = loadEnv(base);
  const refresh = envRefresher(env, base);
  writeFileSync(file, 'INSTABOX_API_KEY=a\nPARTICLE_API_KEY=p\nCLOUDY_CLOUD_PROXY_SECRETS=PARTICLE_API_KEY\n');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  refresh();
  assert.equal(env.PARTICLE_API_KEY, 'p');
  assert.equal(env.CLOUDY_CLOUD_PROXY_SECRETS, 'PARTICLE_API_KEY');
  writeFileSync(file, 'INSTABOX_API_KEY=b\n');
  utimesSync(file, new Date(), new Date(Date.now() + 9000));
  refresh();
  assert.equal(env.INSTABOX_API_KEY, 'b');
  assert.equal(env.PARTICLE_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, 'shell');
});

test('CLOUDY_CLOUD_ALLOW_MACHINE_KINDS is read from the env file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'env');
  writeFileSync(file, 'CLOUDY_CLOUD_ALLOW_MACHINE_KINDS=gpu\n');
  assert.equal(loadEnv({ CLOUDY_CLOUD_CONFIG: file }).CLOUDY_CLOUD_ALLOW_MACHINE_KINDS, 'gpu');
});
