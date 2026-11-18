import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, check, refresh, cachePath } from '../src/update-check.mjs';

const home = (cache) => {
  const h = mkdtempSync(join(tmpdir(), 'cc-upd-'));
  if (cache) { mkdirSync(join(h, '.config/cloudy-cloud'), { recursive: true }); writeFileSync(cachePath(h), JSON.stringify(cache)); }
  return h;
};
const NOW = 1_000_000_000_000;
const run = (cache, extra = {}) => {
  const out = []; let refreshed = 0;
  check({ version: '0.2.0', home: home(cache), env: {}, isTTY: true, now: NOW, write: (s) => out.push(s), startRefresh: () => refreshed++, ...extra });
  return { out, refreshed };
};

test('isNewer compares numeric parts and ranks a prerelease below its release', () => {
  assert.ok(isNewer('0.10.0', '0.9.0'));
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.ok(!isNewer('0.2.0', '0.2.0'));
  assert.ok(!isNewer('0.2.0-beta.1', '0.2.0'));
  assert.ok(isNewer('0.2.0', '0.2.0-beta.1'));
  assert.ok(!isNewer('0.1.9', '0.2.0'));
});

test('a cached newer version prints one line; a fresh cache starts no refresh', () => {
  const r = run({ checkedAt: NOW - 1000, latest: '0.3.0' });
  assert.deepEqual(r.out, ['Cloudy Cloud 0.3.0 is available (you have 0.2.0). Update: npm install -g cloudycloud@latest\n']);
  assert.equal(r.refreshed, 0);
});

test('nothing is printed when current, in CI, opted out, or not a TTY', () => {
  assert.deepEqual(run({ checkedAt: NOW, latest: '0.2.0' }).out, []);
  const c = { checkedAt: NOW, latest: '0.3.0' };
  assert.deepEqual(run(c, { env: { CI: 'true' } }).out, []);
  assert.deepEqual(run(c, { env: { CLOUDY_CLOUD_NO_UPDATE_CHECK: '1' } }).out, []);
  const nt = run(c, { isTTY: false });
  assert.deepEqual(nt.out, []);
  assert.equal(nt.refreshed, 0);
});

test('a missing or day-old cache starts a refresh', () => {
  assert.equal(run(undefined).refreshed, 1);
  assert.equal(run({ checkedAt: NOW - 25 * 3600 * 1000, latest: '0.2.0' }).refreshed, 1);
});

test('refresh writes the cache from the registry reply, and ignores a failure', async () => {
  const h = home();
  await refresh({ home: h, now: NOW, fetchFn: async () => ({ json: async () => ({ version: '0.4.0' }) }) });
  assert.deepEqual(JSON.parse(readFileSync(cachePath(h), 'utf8')), { checkedAt: NOW, latest: '0.4.0' });
  const h2 = home();
  await refresh({ home: h2, fetchFn: async () => { throw new Error('offline'); } });
  assert.throws(() => readFileSync(cachePath(h2)));
});
