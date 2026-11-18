import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
