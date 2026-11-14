// `cloudy-cloud protect [owner/repo] [--yes]`: create a GitHub ruleset on the default branch that nobody can bypass.
// Cloud agents push with your GitHub token, so they act as you: a ruleset that admins may bypass lets the agents bypass it too.
// It uses your own gh sign-in (you must be an admin of the repo) and never changes anything without a yes.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: cloudy-cloud protect [owner/repo] [--yes]
Create a GitHub ruleset on the repo's default branch: changes need a pull request, no force pushes, no deletion,
and nobody can bypass it (including you and the cloud agents). Uses your own gh sign-in; you must be a repo admin.
  owner/repo   the repo (default: the repo of the current folder)
  --yes        do not ask first (you are saying yes to the change shown)`;

const NAME = 'cloudy-cloud: protect the default branch';
export const rulesetBody = () => ({
  name: NAME,
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
    { type: 'non_fast_forward' },
    { type: 'deletion' },
  ],
});

const realGh = (args, input) => {
  const r = spawnSync('gh', args, { input, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.code };
};
const realConfirm = async (q) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y/i.test(await rl.question(`${q} [y/N] `)); } finally { rl.close(); }
};

const NO_PLAN = (repo) => `${repo} is on a GitHub plan without rulesets for this repo. Rulesets on a private repo need GitHub Pro or Team (they are free on public repos).
Next step: upgrade the plan or make the repo public, then run: cloudy-cloud protect ${repo}
Or set up classic branch protection instead (repo Settings, then Branches): require a pull request, and tick "Do not allow bypassing the above settings" so admins (and your agents) cannot push directly.`;
const isPlan = (e) => /upgrade to github|rulesets? .*(not|isn't) (available|supported)/i.test(e);

export async function run(argv, deps = {}) {
  const { gh = realGh, confirm = realConfirm, out = (s) => console.log(s), err = (s) => console.error(s), interactive = !!process.stdin.isTTY } = deps;
  const yes = argv.includes('--yes');
  const rest = argv.filter((a) => a !== '--yes');
  const bad = rest.find((a) => a.startsWith('-'));
  if (bad || rest.length > 1 || (rest[0] && !/^[\w.-]+\/[\w.-]+$/.test(rest[0]))) { err(`cloudy-cloud protect: ${bad ? `unknown option ${bad}` : 'the repo must look like owner/repo'}.\n${USAGE}`); return 1; }
  const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  const auth = gh(['auth', 'status']);
  if (auth.error === 'ENOENT') { err('The GitHub CLI (gh) is not installed.\nNext step: Install the GitHub CLI from https://cli.github.com, run: gh auth login, then run cloudy-cloud protect again.'); return 1; }
  if (auth.status !== 0) { err('gh is not signed in to GitHub.\nNext step: run: gh auth login, then run cloudy-cloud protect again.'); return 1; }

  const info = gh(['api', rest[0] ? `repos/${rest[0]}` : 'repos/{owner}/{repo}']);
  const meta = info.status === 0 ? json(info) : null;
  if (!meta) { err(`Could not read ${rest[0] || 'the repo of this folder'} with gh: ${info.stderr.trim() || 'no answer'}\nNext step: check the name (owner/repo), that you can see the repo, and that this folder has a github.com origin if you gave no name.`); return 1; }
  const repo = rest[0] || meta.full_name;
  const branch = meta.default_branch;
  if (!meta.permissions?.admin) {
    err(`You are not an admin of ${repo}, so GitHub will not let you create a ruleset there.\nSend this to an admin: "Please run cloudy-cloud protect ${repo} (or add a ruleset on ${branch} that requires pull requests, blocks force pushes and deletion, and has no bypass actors), because my cloud agents push as me."`);
    return 1;
  }

  const list = gh(['api', '--paginate', '--slurp', `repos/${repo}/rulesets?per_page=100`]);
  if (list.status !== 0) {
    err(isPlan(list.stderr) ? NO_PLAN(repo) : `Could not list the rulesets of ${repo}: ${list.stderr.trim()}`);
    return 1;
  }
  const want = ['pull_request', 'non_fast_forward', 'deletion'];
  const matches = (p) => p === '~DEFAULT_BRANCH' || p === '~ALL' || globMatch(p, `refs/heads/${branch}`);
  // fnmatch-style: ** crosses "/", * stays inside one path segment, ? is one non-"/" character.
  function globMatch(pattern, ref) {
    const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*|\?/g, (t) => (t === '**' ? '.*' : t === '*' ? '[^/]*' : '[^/]'));
    return new RegExp(`^${re}$`).test(ref);
  }
  for (const { id } of (json(list) || []).flat()) {
    const rs = json(gh(['api', `repos/${repo}/rulesets/${id}`]));
    const ref = rs?.conditions?.ref_name;
    const covers = ref?.include?.some(matches) && !ref.exclude?.some(matches);
    // GitHub leaves bypass_actors out when the caller cannot edit the ruleset, so an absent list proves nothing.
    if (rs && !Array.isArray(rs.bypass_actors)) { out(`Ruleset "${rs.name}" does not count: GitHub did not show its bypass_actors to you, so it may let someone bypass.`); continue; }
    if (rs?.enforcement === 'active' && rs.target === 'branch' && covers && !rs.bypass_actors.length && want.every((t) => rs.rules?.some((r) => r.type === t))) {
      out(`${branch} on ${repo} is already protected by ruleset "${rs.name}" (no bypass actors). Nothing changed.`);
      return 0;
    }
  }
  const classic = json(gh(['api', `repos/${repo}/branches/${branch}/protection`]));
  const allow = classic?.required_pull_request_reviews?.bypass_pull_request_allowances;
  if (classic?.enforce_admins?.enabled && classic.required_pull_request_reviews && !classic.allow_force_pushes?.enabled && !classic.allow_deletions?.enabled
    && !['users', 'teams', 'apps'].some((k) => allow?.[k]?.length)) {
    out(`${branch} on ${repo} already has classic branch protection that applies to admins. Nothing changed.`);
    return 0;
  }

  out(`This will create a GitHub ruleset on ${repo} for its default branch (${branch}):\n  - changes need a pull request (0 approvals)\n  - no force pushes, no deleting the branch\n  - nobody can bypass it, including you and your cloud agents\nAfter this, your own direct pushes to ${branch} are blocked too; changes go through pull requests.`);
  if (!yes) {
    if (!interactive) { err('Not changing anything: this needs your yes. Run it in a terminal, or pass --yes if you agree to the change shown above.'); return 1; }
    if (!(await confirm('Create this ruleset?'))) { out('Nothing changed.'); return 1; }
  }

  const made = gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(rulesetBody()));
  if (made.status !== 0) {
    err(isPlan(made.stderr) ? NO_PLAN(repo)
      : /HTTP 40[13]/.test(made.stderr) ? `GitHub refused: ${made.stderr.trim()}\nNext step: you need admin rights on ${repo}. Send an admin: "Please run cloudy-cloud protect ${repo}".`
      : `Could not create the ruleset: ${made.stderr.trim()}`);
    return 1;
  }
  const id = json(made)?.id;
  const rs = id ? json(gh(['api', `repos/${repo}/rulesets/${id}`])) : null;
  if (rs?.enforcement !== 'active' || rs.bypass_actors?.length) {
    err(`The ruleset was created but is not active with no bypass actors (the API shows ${rs ? `enforcement ${rs.enforcement}` : 'nothing'}).\nNext step: open https://github.com/${repo}/settings/rules and set it to Active.`);
    return 1;
  }
  out(`Done. Ruleset "${NAME}" is active on ${branch} in ${repo} (confirmed through the GitHub API).\nYour own direct pushes to ${branch} are blocked too; make changes on a branch and merge a pull request.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
