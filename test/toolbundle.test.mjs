import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownsRepo, toolBundle, toolInstallCmd } from '../src/toolbundle.mjs';

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

// An npm install is not a git checkout: git resolves to any enclosing repo, whose objects the bundle cannot carry.
const pkgCopy = (parent, name = 'pkg') => {
  const p = join(parent, name);
  mkdirSync(join(p, 'src'), { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'x', files: ['src/', 'README.md'] }));
  writeFileSync(join(p, 'src', 'a.mjs'), 'export default 1\n');
  writeFileSync(join(p, 'README.md'), 'hi\n');
  writeFileSync(join(p, 'junk.txt'), 'not published\n');
  return p;
};
const clones = (b) => {
  const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
  writeFileSync(join(home, 'x.bundle'), b.data);
  sh(home, toolInstallCmd(b, join(home, 'x.bundle')));
  return join(home, 'cloudy-cloud');
};

test('a package copy inside an unrelated shallow repo bundles its own files', () => {
  const outer = mkdtempSync(join(tmpdir(), 'cc-outer-'));
  const src = mkdtempSync(join(tmpdir(), 'cc-outer-src-'));
  sh(src, 'git init -q -b main && git config user.name t && git config user.email t@t && echo 1 > f && git add -A && git commit -qm 1 && echo 2 > f && git commit -qam 2');
  sh(tmpdir(), `git clone -q --depth 1 file://${src} ${outer}/repo`);
  const pkg = pkgCopy(join(outer, 'repo'));
  assert.equal(ownsRepo(pkg), false);
  const dest = clones(toolBundle(pkg));
  assert.equal(readFileSync(join(dest, 'src', 'a.mjs'), 'utf8'), 'export default 1\n');
  assert.equal(existsSync(join(dest, 'junk.txt')), false);
  assert.equal(sh(outer + '/repo', 'git status --porcelain | head -1'), '?? pkg/'); // the outer repo was left alone
});

test('a package dir with no repo at all bundles its own files', () => {
  const pkg = pkgCopy(mkdtempSync(join(tmpdir(), 'cc-norepo-')));
  assert.equal(readFileSync(join(clones(toolBundle(pkg)), 'package.json'), 'utf8').includes('"files"'), true);
});

test('a source checkout owns its repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cc-own-'));
  sh(repo, 'git init -q');
  assert.equal(ownsRepo(repo), true);
});

test('toolRepoUrl on an npm-style copy prints nothing to stderr', () => {
  const pkg = pkgCopy(mkdtempSync(join(tmpdir(), 'cc-quiet-')));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { toolRepoUrl } from ${JSON.stringify(new URL('../src/coordinator.mjs', import.meta.url).href)}; console.log(JSON.stringify(toolRepoUrl(${JSON.stringify(pkg)})))`], { encoding: 'utf8' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim(), '""');
});
