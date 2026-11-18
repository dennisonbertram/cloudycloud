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
  assert.ok(isNewer('1.0.0-beta.10', '1.0.0-beta.2'));
  assert.ok(!isNewer('1.2.3+build.5', '1.2.3'));
  assert.ok(!isNewer('1.2.3', '1.2.3+build.5'));
  assert.ok(isNewer('1.0.0-beta', '1.0.0-1'));
  assert.ok(isNewer('1.0.0-beta.1', '1.0.0-beta'));
  assert.ok(isNewer('1.0.0-rc.1', '1.0.0-beta.9'));
});

test('a cached newer version prints one line; a fresh cache starts no refresh', () => {
  const r = run({ checkedAt: NOW - 1000, latest: '0.3.0' }, { root: '/x/node_modules/cloudycloud' });
  assert.deepEqual(r.out, ['Cloudy Cloud 0.3.0 is available (you have 0.2.0). Update: npm install -g cloudycloud@latest\n']);
  assert.equal(r.refreshed, 0);
});

test('an npm install keeps the npm command; a clone (has .git) says how to pull', () => {
  const c = { checkedAt: NOW - 1000, latest: '0.3.0' };
  const h = home(c);
  const clone = (rel, git = true) => { const r = join(h, rel); mkdirSync(r, { recursive: true }); if (git) mkdirSync(join(r, '.git')); return r; };
  const say = (root, homeDir = h) => { const out = []; check({ version: '0.2.0', home: homeDir, env: {}, isTTY: true, now: NOW, write: (s) => out.push(s), startRefresh() {}, root }); return out[0]; };
  const head = 'Cloudy Cloud 0.3.0 is available (you have 0.2.0). Update: ';
  assert.equal(say(clone('x/node_modules/cloudycloud', false)), `${head}npm install -g cloudycloud@latest\n`);
  assert.equal(say(clone('src/cloudy')), `${head}cd ~/src/cloudy && git pull && npm install\n`);
  assert.equal(say(clone('linked/node_modules/cloudycloud')), `${head}cd ~/linked/node_modules/cloudycloud && git pull && npm install\n`); // a linked clone is still a clone
  assert.equal(say(clone('my repo/it\'s')), `${head}cd ~/'my repo/it'\\''s' && git pull && npm install\n`);
  mkdirSync(join(h, '.git'));
  assert.equal(say(h), `${head}cd ~ && git pull && npm install\n`);
  const sib = h + '-other'; mkdirSync(join(sib, '.git'), { recursive: true });
  assert.equal(say(sib), `${head}cd ${sib} && git pull && npm install\n`); // a sibling folder that merely starts with the home path
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
  assert.equal(JSON.parse(readFileSync(cachePath(h2), 'utf8')).latest, undefined);
});

test('an invalid or future cache counts as missing', () => {
  for (const bad of [null, 'x', { latest: '9.0.0' }, { checkedAt: 'now', latest: '9.0.0' }, { checkedAt: NOW + 1e6, latest: '9.0.0' }]) {
    const r = run(bad);
    assert.deepEqual(r.out, []);
    assert.equal(r.refreshed, 1);
  }
});

test('refresh claims the attempt before fetching, so a failing fetch is not retried until tomorrow', async () => {
  const h = home({ checkedAt: NOW - 30 * 3600 * 1000, latest: '0.3.0' });
  await refresh({ home: h, now: NOW, fetchFn: async () => { throw new Error('offline'); } });
  assert.deepEqual(JSON.parse(readFileSync(cachePath(h), 'utf8')), { checkedAt: NOW, latest: '0.3.0' });
  const blocked = mkdtempSync(join(tmpdir(), 'cc-upd-'));
  writeFileSync(join(blocked, '.config'), 'a file, so the cache folder cannot be made');
  let fetched = 0;
  await refresh({ home: blocked, fetchFn: async () => { fetched++; return { json: async () => ({}) }; } });
  assert.equal(fetched, 0);
});
