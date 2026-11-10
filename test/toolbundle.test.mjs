import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolBundle, toolInstallCmd } from '../src/toolbundle.mjs';

const sh = (cwd, cmd) => execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' }).trim();

test('the tool bundle carries an uncommitted tracked edit, leaves no ref behind, and can be installed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cc-tb-'));
  sh(repo, 'git init -q -b main && git config user.name t && git config user.email t@t');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'git add -A && git commit -qm one');
  writeFileSync(join(repo, 'a.txt'), 'edited\n'); // tracked, uncommitted
  const b = toolBundle(repo);
  assert.equal(sh(repo, 'git for-each-ref refs/cc-keep'), '');
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'edited\n');
  const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
  writeFileSync(join(home, 'x.bundle'), b.data);
  sh(home, toolInstallCmd(b, join(home, 'x.bundle'), 'https://github.com/o/t.git'));
  assert.equal(readFileSync(join(home, 'cloudy-cloud', 'a.txt'), 'utf8'), 'edited\n');
  sh(home, toolInstallCmd(b, join(home, 'x.bundle'))); // re-install works
  assert.equal(sh(join(home, 'cloudy-cloud'), 'git rev-parse HEAD'), b.sha);
});

test('retryIndexLock retries a locked index, and rethrows anything else', async () => {
  const { retryIndexLock } = await import('../src/toolbundle.mjs');
  let n = 0;
  assert.equal(retryIndexLock(() => { if (++n < 3) throw Object.assign(new Error('x'), { stderr: 'fatal: Unable to create .git/index.lock' }); return 'ok'; }), 'ok');
  assert.equal(n, 3);
  assert.throws(() => retryIndexLock(() => { throw new Error('other'); }), /other/);
});
