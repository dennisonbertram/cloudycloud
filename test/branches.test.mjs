import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/branches.mjs';

const sh = (cwd, c) => execFileSync('sh', ['-c', c], { cwd, encoding: 'utf8' }).trim();
// A bare origin with main, plus a clone. Branches: empty (at main), merged, unmerged, and two names that must never be touched.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'branches-'));
  const bare = join(dir, 'origin.git'), work = join(dir, 'work');
  sh(dir, `git init -q --bare -b main ${bare} && git clone -q ${bare} work`);
  const g = 'git -c user.name=t -c user.email=t@t';
  sh(work, `${g} commit -q --allow-empty -m base && git push -q origin HEAD:main`);
  const mk = (name, commit) => sh(work, `git checkout -q -b tmp main && ${commit ? `${g} commit -q --allow-empty -m ${name.replace('/', '-')} &&` : ''} git push -q origin tmp:${name} && git checkout -q main && git branch -q -D tmp`);
  mk('cloudy-cloud/00000001', false); // empty
  mk('cloudy-cloud/00000002', true); // merged below
  sh(work, `git fetch -q origin cloudy-cloud/00000002 && git merge -q --ff-only FETCH_HEAD && git push -q origin main`);
  mk('cloudy-cloud/00000003', true); // unmerged
  mk('cloudy-cloud/issue-12-00000004', false); // ours (started from an issue), empty
  mk('feature/x', false); // not ours, empty
  mk('cloudy-cloud/notahex1', false); // not ours, empty
  return { work, bare, branches: () => sh(bare, "git for-each-ref '--format=%(refname:short)' refs/heads").split('\n') };
}
const run = async (argv, cwd) => { const out = [], err = []; const code = await main(argv, { cwd, out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; };

test('without --yes nothing is deleted and the list says what would be', async () => {
  const f = fixture();
  const before = f.branches();
  const r = await run(['prune'], f.work);
  assert.equal(r.code, 0);
  assert.match(r.out, /cloudy-cloud\/00000001 .* prune/);
  assert.match(r.out, /cloudy-cloud\/00000002 .* prune/);
  assert.match(r.out, /cloudy-cloud\/00000003 .* keep/);
  assert.match(r.out, /cloudy-cloud\/issue-12-00000004 .* prune/);
  assert.match(r.out, /Dry run: nothing deleted/);
  assert.deepEqual(f.branches(), before);
  await run(['prune', '--yes', '--dry-run'], f.work);
  assert.deepEqual(f.branches(), before);
});

test('--yes deletes only empty and merged cloudy-cloud/<id> branches', async () => {
  const f = fixture();
  const r = await run(['prune', '--yes'], f.work);
  assert.equal(r.code, 0);
  assert.deepEqual(f.branches().sort(), ['cloudy-cloud/00000003', 'cloudy-cloud/notahex1', 'feature/x', 'main']);
});

test('unknown arguments print usage and exit 2', async () => {
  const f = fixture();
  assert.equal((await run(['prune', '--all'], f.work)).code, 2);
  assert.equal((await run([], f.work)).code, 2);
});

test('usage and --help come through the help wrapper: every line fits 80 cells', async () => {
  const { cellWidth } = await import('../src/ui.mjs');
  const OLD_USAGE = 'Usage: cloudy-cloud branches prune [--yes] [--dry-run]\n  Lists cloudy-cloud/<id> branches on origin that are empty or merged into the default branch.\n  Nothing is deleted unless you pass --yes.';
  for (const argv of [[], ['bogus'], ['prune', '--all']]) {
    const r = await run(argv, '/'); // an injected err is a piped stream: the script text is unchanged
    assert.equal(r.code, 2);
    assert.equal(r.err, OLD_USAGE);
  }
  if (process.platform === 'darwin') { // a real terminal gets the wrapped help instead (BSD script(1) for the pty)
    const { spawnSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const r = spawnSync('script', ['-q', '/dev/null', 'sh', '-c', `${process.execPath} ${resolve('src/branches.mjs')} bogus 2>&1`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); // BSD script(1) needs a non-pipe stdin
    assert.equal(r.error, undefined);
    assert.match(r.stdout, /Usage: cloudy-cloud branches prune/);
    assert.match(r.stdout, /--yes/);
    for (const l of r.stdout.replace(/\r/g, '').split('\n')) assert.ok(cellWidth(l) <= 80, l);
  }
  for (const arg of ['--help', '-h']) {
    const r = await run([arg], '/');
    assert.equal(r.code, 0);
    assert.match(r.out, /Usage: cloudy-cloud branches prune/);
    for (const l of r.out.split('\n')) assert.ok(cellWidth(l) <= 80, l);
  }
});

test('--yes skips a branch that changed since it was listed: the delete carries a lease', async () => {
  const f = fixture();
  const real = sh('/', 'command -v git');
  const bin = mkdtempSync(join(tmpdir(), 'git-shim-'));
  // A git shim: on a delete push it first advances the target branch, like a worker racing the prune.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
t=""; p=""
for a in "$@"; do
  case "$a" in :refs/heads/*) t=\${a#:refs/heads/};; esac
  [ "$p" = "--delete" ] && t="$a"
  p="$a"
done
if [ -n "$t" ]; then
  "${real}" -C "${f.work}" -c user.name=t -c user.email=t@t commit -q --allow-empty -m race
  "${real}" -C "${f.work}" push -q origin "HEAD:refs/heads/$t"
fi
exec "${real}" "$@"
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  let r;
  try { r = await run(['prune', '--yes'], f.work); } finally { process.env.PATH = path; }
  assert.equal(r.code, 0);
  assert.match(r.out, /cloudy-cloud\/00000001 skipped \(changed since check\)/);
  assert.match(r.out, /cloudy-cloud\/issue-12-00000004 skipped \(changed since check\)/);
  const after = f.branches();
  for (const b of ['cloudy-cloud/00000001', 'cloudy-cloud/00000002', 'cloudy-cloud/issue-12-00000004']) assert.ok(after.includes(b), `${b} must survive a racing push`);
});

test('--yes refuses to delete when origin pushes somewhere other than it fetches', async () => {
  const f = fixture();
  const before = f.branches();
  sh(f.work, 'git remote set-url --push origin https://elsewhere.example/repo.git');
  const r = await run(['prune', '--yes'], f.work);
  assert.equal(r.code, 1);
  assert.match(r.err, /push/);
  assert.match(r.err, /refus/i);
  assert.deepEqual(f.branches(), before);
  const dry = await run(['prune'], f.work); // listing is still fine: nothing is deleted
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Dry run/);
});

test('--yes refuses to delete when origin has several push URLs', async () => {
  const f = fixture();
  const before = f.branches();
  sh(f.work, `git remote set-url --push origin ${f.bare}`);
  sh(f.work, 'git remote set-url --push --add origin https://second.example/repo.git');
  const r = await run(['prune', '--yes'], f.work);
  assert.equal(r.code, 1);
  assert.match(r.err, /refus/i);
  assert.deepEqual(f.branches(), before);
});
