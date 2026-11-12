import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const lib = resolve('bin/migrate-config.sh');
const OLD = 'CLAUDE_CLOUD_COORDINATOR_SNAPSHOT=snap-fake1\nCLAUDE_CLOUD_SNAPSHOT_ACCOUNT=acct-fake\nINSTABOX_API_KEY=ibk_fake\nNOTE=has CLAUDE_CLOUD_ inside\n';
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'cc-migrate-'));
  const old = join(home, '.config/claude-cloud');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'env'), OLD, { mode: 0o600 });
  writeFileSync(join(old, 'owner'), 'owner-fake\n');
  return { home, old, neu: join(home, '.config/cloudy-cloud') };
}
const migrate = (home, env = {}) => spawnSync('/bin/sh', ['-c', `. "${lib}"; migrate_config`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env } });

test('migrates the old config folder, renaming only key names', () => {
  const { home, old, neu } = setup();
  const r = migrate(home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(neu, 'env'), 'utf8'), OLD.replace('CLAUDE_CLOUD_COORDINATOR', 'CLOUDY_CLOUD_COORDINATOR').replace('CLAUDE_CLOUD_SNAPSHOT', 'CLOUDY_CLOUD_SNAPSHOT'));
  assert.equal(readFileSync(join(neu, 'owner'), 'utf8'), 'owner-fake\n');
  assert.equal(statSync(join(neu, 'env')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(old, 'env'), 'utf8'), OLD); // old folder untouched
  assert.match(r.stdout, /Moved/);
  assert.ok(!r.stdout.includes('fake'), 'values are never printed');
  assert.deepEqual(readdirSync(join(home, '.config')).sort(), ['claude-cloud', 'cloudy-cloud']);
});

test('a second run does not overwrite the new folder', () => {
  const { home, neu } = setup();
  migrate(home);
  writeFileSync(join(neu, 'env'), 'INSTABOX_API_KEY=changed\n', { mode: 0o600 });
  const r = migrate(home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(join(neu, 'env'), 'utf8'), 'INSTABOX_API_KEY=changed\n');
});

test('CLOUDY_CLOUD_CONFIG set skips migration; no old folder does nothing', () => {
  const a = setup();
  migrate(a.home, { CLOUDY_CLOUD_CONFIG: '/x/env' });
  assert.ok(!existsSync(a.neu));
  const home = mkdtempSync(join(tmpdir(), 'cc-migrate-'));
  assert.equal(migrate(home).status, 0);
  assert.ok(!existsSync(join(home, '.config/cloudy-cloud')));
});
