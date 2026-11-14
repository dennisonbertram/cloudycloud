import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, rulesetBody } from '../src/protect.mjs';

const R = 'acme/app';
const ok = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });
const fail = (stderr) => ({ status: 1, stdout: '', stderr });
const repo = { default_branch: 'main', permissions: { admin: true } };
const THREE = { type: 'pull_request', parameters: {} };
const equivalent = { id: 7, name: 'x', target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [THREE, { type: 'non_fast_forward' }, { type: 'deletion' }] };

// A fake gh: routes maps "METHOD path" to a result (or a function of stdin).
function setup(routes, { yes = false, answer = true } = {}) {
  const calls = [], out = [], err = [], asked = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'auth') return routes.auth ?? { status: 0, stdout: '', stderr: '' };
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
    const path = args.find((a) => a.startsWith('repos/'))?.split('?')[0];
    const r = routes[`${method} ${path}`];
    if (!r) return fail('gh: Not Found (HTTP 404)');
    return typeof r === 'function' ? r(input) : r;
  };
  const argv = yes ? [R, '--yes'] : [R];
  const deps = { gh, confirm: async (q) => { asked.push(q); return answer; }, out: (s) => out.push(s), err: (s) => err.push(s), interactive: true };
  return { calls, out, err, asked, run: (a = argv, d = {}) => run(a, { ...deps, ...d }) };
}
const posts = (s) => s.calls.filter((c) => c.args.includes('POST'));

test('the ruleset has the three rules, 0 approvals and no bypass actors', () => {
  const b = rulesetBody();
  assert.deepEqual(b.bypass_actors, []);
  assert.deepEqual(b.rules.map((r) => r.type).sort(), ['deletion', 'non_fast_forward', 'pull_request']);
  assert.equal(b.rules.find((r) => r.type === 'pull_request').parameters.required_approving_review_count, 0);
  assert.equal(b.enforcement, 'active');
  assert.deepEqual(b.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
});

test('create: asks first, posts the ruleset with no bypass actors, confirms through the API', async () => {
  let created;
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`POST repos/${R}/rulesets`]: (i) => { created = JSON.parse(i); return ok({ id: 9 }); }, [`GET repos/${R}/rulesets/9`]: ok({ ...equivalent, id: 9 }) });
  assert.equal(await s.run(), 0);
  assert.equal(s.asked.length, 1);
  assert.deepEqual(created.bypass_actors, []);
  assert.match(s.out.join('\n'), /your own direct pushes to main are blocked too/i);
  assert.match(s.out.join('\n'), /active/);
});

test('declining the question changes nothing', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]) }, { answer: false });
  assert.equal(await s.run(), 1);
  assert.equal(posts(s).length, 0);
});

test('without a terminal and without --yes it refuses and changes nothing; --yes skips the question', async () => {
  const routes = { [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok(equivalent) };
  const a = setup(routes);
  assert.equal(await a.run([R], { interactive: false }), 1);
  assert.equal(posts(a).length, 0);
  assert.match(a.err.join('\n'), /--yes/);
  const b = setup(routes, { yes: true });
  assert.equal(await b.run(), 0);
  assert.equal(b.asked.length, 0);
  assert.equal(posts(b).length, 1);
});

test('already protected by an equivalent ruleset: reports it and changes nothing', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(equivalent) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 0);
  assert.match(s.out.join('\n'), /already protected/i);
});

test('a ruleset that lets someone bypass does not count as protection', async () => {
  const weak = { ...equivalent, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] };
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(weak), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok(equivalent) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 1);
});

test('classic branch protection that applies to admins counts as protected', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`GET repos/${R}/branches/main/protection`]: ok({ enforce_admins: { enabled: true }, required_pull_request_reviews: {} }) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 0);
  assert.match(s.out.join('\n'), /classic branch protection/i);
});

test('not an admin: says so, gives a sentence for the admin, changes nothing', async () => {
  const s = setup({ [`GET repos/${R}`]: ok({ ...repo, permissions: { admin: false, push: true } }) }, { yes: true });
  assert.equal(await s.run(), 1);
  assert.equal(posts(s).length, 0);
  assert.match(s.err.join('\n'), /not an admin of acme\/app/);
  assert.match(s.err.join('\n'), /Send this to an admin/);
});

test('gh not signed in: says to run gh auth login', async () => {
  const s = setup({ auth: fail('You are not logged into any GitHub hosts.') }, { yes: true });
  assert.equal(await s.run(), 1);
  assert.match(s.err.join('\n'), /gh auth login/);
});

test('gh missing: says how to install it', async () => {
  const s = setup({ auth: { status: 127, stdout: '', stderr: '', error: 'ENOENT' } }, { yes: true });
  assert.equal(await s.run(), 1);
  assert.match(s.err.join('\n'), /Install the GitHub CLI/);
});

test('plan without rulesets: names the plans and classic protection, changes nothing', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: fail('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)') }, { yes: true });
  assert.equal(await s.run(), 1);
  assert.equal(posts(s).length, 0);
  assert.match(s.err.join('\n'), /GitHub Pro or Team/);
  assert.match(s.err.join('\n'), /Do not allow bypassing/);
});

test('plan error on create is reported the same way', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`POST repos/${R}/rulesets`]: fail('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)') }, { yes: true });
  assert.equal(await s.run(), 1);
  assert.match(s.err.join('\n'), /GitHub Pro or Team/);
});

test('created but the API shows it is not active: says so', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok({ ...equivalent, enforcement: 'disabled' }) }, { yes: true });
  assert.equal(await s.run(), 1);
  assert.match(s.err.join('\n'), /not active/);
});

test('bad repository argument', async () => {
  const s = setup({}, { yes: true });
  assert.equal(await s.run(['not a repo']), 1);
  assert.match(s.err.join('\n'), /owner\/repo/);
});

test('no argument: uses the repo of the current folder', async () => {
  const s = setup({ 'GET repos/{owner}/{repo}': ok({ ...repo, full_name: R }), [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(equivalent) }, { yes: true });
  assert.equal(await s.run([]), 0);
  assert.match(s.out.join('\n'), /acme\/app/);
});

test('a ruleset that includes ~ALL but excludes the default branch does not protect it', async () => {
  const ex = { ...equivalent, conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/main'] } } };
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(ex), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok(equivalent) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 1);
});

for (const pat of ['refs/heads/**', 'refs/heads/ma*', 'refs/heads/*']) {
  test(`a ruleset that excludes the default branch with ${pat} does not protect it`, async () => {
    const ex = { ...equivalent, conditions: { ref_name: { include: ['~ALL'], exclude: [pat] } } };
    const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(ex), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok(equivalent) }, { yes: true });
    assert.equal(await s.run(), 0);
    assert.equal(posts(s).length, 1);
  });
}

test('a ruleset that excludes only refs/heads/release/* still protects the default branch', async () => {
  const ex = { ...equivalent, conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/release/*'] } } };
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(ex) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 0);
});

test('a ruleset whose bypass_actors is hidden (omitted) does not count, and the output says so', async () => {
  const { bypass_actors, ...hidden } = equivalent;
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([{ id: 7 }]), [`GET repos/${R}/rulesets/7`]: ok(hidden), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok(equivalent) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 1);
  assert.match(s.out.join('\n'), /bypass_actors/);
});

test('classic protection that lets someone bypass, force push or delete is not protection', async () => {
  const good = { enforce_admins: { enabled: true }, required_pull_request_reviews: {}, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
  const variants = [
    { ...good, required_pull_request_reviews: { bypass_pull_request_allowances: { users: [{ login: 'me' }], teams: [], apps: [] } } },
    { ...good, allow_force_pushes: { enabled: true } },
    { ...good, allow_deletions: { enabled: true } },
  ];
  for (const classic of variants) {
    const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`GET repos/${R}/branches/main/protection`]: ok(classic), [`POST repos/${R}/rulesets`]: ok({ id: 9 }), [`GET repos/${R}/rulesets/9`]: ok(equivalent) }, { yes: true });
    assert.equal(await s.run(), 0);
    assert.equal(posts(s).length, 1, JSON.stringify(classic));
  }
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([]), [`GET repos/${R}/branches/main/protection`]: ok(good) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 0);
});

test('the ruleset list is paginated: an equivalent ruleset on a later page is found', async () => {
  const s = setup({ [`GET repos/${R}`]: ok(repo), [`GET repos/${R}/rulesets`]: ok([[{ id: 1 }], [{ id: 7 }]]), [`GET repos/${R}/rulesets/1`]: ok({ ...equivalent, id: 1, enforcement: 'disabled' }), [`GET repos/${R}/rulesets/7`]: ok(equivalent) }, { yes: true });
  assert.equal(await s.run(), 0);
  assert.equal(posts(s).length, 0);
  const list = s.calls.find((c) => c.args.some((a) => a.startsWith(`repos/${R}/rulesets?`)));
  assert.ok(list.args.includes('--paginate') && list.args.includes('--slurp'));
});
