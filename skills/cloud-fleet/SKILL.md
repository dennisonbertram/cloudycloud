---
name: cloud-fleet
description: How to run fleets of cloudy-cloud subagents (Instabox cloud machines that push cloudy-cloud/<id> branches to GitHub) and keep the output manageable. Use when starting many cloud_agent workers, fanning out a swarm, using coordinators or sub-coordinators, merging many worker branches into one trunk, or avoiding a flood of PRs.
---

# Managing a Cloudy Cloud fleet

Each `cloud_agent` is a full Claude Code on its own Instabox machine. It works on a copy of the repo and pushes `cloudy-cloud/<id>` to GitHub. Starting 100 agents is easy. Reviewing 100 PRs is not. This skill is about getting one reviewable result out of many agents.

Tools: `cloud_agent(prompt, description, model?, subagent_type?, profile?)` (a coordinator also takes `role: "coordinator"` where available), `cloud_agent_message`, `cloud_agent_wait`, `cloud_agent_result` (reads the latest result again), `cloud_agent_list`, `cloud_agent_stop`.

## Choosing a worker's model

Workers can run Claude or open models. Do not tell the user otherwise.

| Want | Use |
| --- | --- |
| A Claude model | `cloud_agent` with `model` (for example `haiku`), or nothing for the default |
| A non-Claude model | `cloud_agent` with `profile`, never `model` |

Profiles: `omp-particle`, `omp-glm`, `omp-deepseek` (the oh-my-pi `omp` harness, no gateway; each worker installs `omp`, so it starts slower); `pi-particle`, `pi-glm`, `pi-deepseek` (the `pi` harness, no gateway, uses no Claude allowance); `particle`, `glm`, `deepseek` (Claude Code through a gateway on the machine); `openrouter`. `particle` means Particle.ai's `particle-1` model.

- Use the `mcp__cloud__cloud_agent` tool. Never use the built-in `Agent` tool or `isolation: "remote"`: it takes Claude models only, and it can silently run on the local machine.
- If you do not have `mcp__cloud__cloud_agent`, you are not in a `cloudy-cloud` session. Say so, and ask the user to restart with `cloudy-cloud`.
- To prove a worker ran in the cloud, check its hostname starts with `instabox-sbx-`.

## Before using a repo

Check these once per repo, before the first subagent or coordinator. Tell the user plainly about any that fail. Never change GitHub settings yourself.

1. **GitHub origin.** Run `git remote get-url origin`. It must be a github.com URL, because subagents push there. If it isn't, stop and tell the user how to add one.
2. **Main branch protected.** Subagents run with permission checks off and can push to any branch the token reaches.
   - Check with `gh api repos/OWNER/REPO/rulesets --jq 'length'` and `gh api repos/OWNER/REPO/branches/<default>/protection` (a 404 means unprotected).
   - If the default branch is unprotected, warn the user and suggest a ruleset that blocks direct pushes (repo Settings, then Rules, then Rulesets). Continue only if they say so.
3. **Token access: ask the user.** The GitHub token stored in Instabox as `GH_TOKEN` must include this repo, and you cannot check that from here.
   - The first time you use a repo, ask with the structured question tool if you have one: "Is OWNER/REPO in your cloudy-cloud GitHub token?" Offer three options:
     - **Already included:** continue.
     - **Add it to my current token** (recommended): at https://github.com/settings/personal-access-tokens, open the cloudy-cloud token, add the repo under "Only select repositories" with Contents read and write, and save. The value does not change, so nothing else needs updating.
     - **Generate a new token:** create a fine-grained token at https://github.com/settings/personal-access-tokens/new with "Only select repositories" set to **every** repo they use with cloudy-cloud, not just this one, and Contents read and write. Then store it with `npx instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com`, pasting the token at the prompt.
   - There is only one `GH_TOKEN`, so a new token replaces the old one for every repo. Tell the user that, and to delete the old token on GitHub afterwards.
   - Never ask for the token in chat. The user pastes it into the Instabox CLI prompt themselves. Wait until they say it is done.
   - If the first push of the first agent still fails with a permission error, the repo is not in the token: go back to these options.
   - Never suggest "All repositories". Adding repos one at a time keeps a confused or prompt-injected subagent away from the rest.

## Handing a job to a cloud coordinator

When the user wants a long job to run unattended, start a cloud coordinator instead of running the fleet from this session. The user checks in through Remote Control (claude.ai or the Claude app).

- Hand off when the job is long or large, the user is leaving, and the work needs only what is on GitHub. Do not hand off when it needs untracked local files or the user wants to steer step by step.
- Confirm first: coordinator name, repo, base branch, and that it is billed until stopped. Commit and push what it needs.
- Write the brief from [brief-template.md](brief-template.md), then run `cloudy-cloud coordinator start NAME --repo URL --branch BASE --task-file FILE --json`.
- Tell the user the Remote Control session name, how to attach, and `cloudy-cloud coordinator stop NAME`. Do not stop it unless asked. The server deletes it at its deadline (24 hours by default; `--max-hours N` shortens it), and the coordinator deletes itself with `coordinator finish` when its work is pushed.

Full steps, and the rules a coordinator follows when working unattended: [handoff.md](handoff.md).

## Pick a pattern

| Situation | Pattern |
| --- | --- |
| Many unrelated small fixes; reviewers want separate PRs | 1. Flat fan-out |
| One feature or one large job split across many agents | 2. Trunk merging (default) |
| Stage B needs the merged result of stage A | 3. Waves |
| More than about 50 workers, or clearly separate areas | 2, with sub-coordinators |

If unsure, use trunk merging. One PR for one job is almost always what a reviewer wants.

## Pattern 1: flat fan-out, one PR per agent

1. Give each agent one independent task and tell it which files it owns.
2. Start all agents, wait for results.
3. Fetch each branch, run the tests, open one PR per good branch from `cloudy-cloud/<id>`.

Only use this when the tasks really are independent and the user wants separate PRs. Cap it at what a human can review (about 10 to 15).

## Pattern 2: trunk (tree) merging

The coordinator is the session that starts workers. It owns an integration branch and is the only one that merges.

**Where to do the git work:**
- **On a cloud coordinator machine (`~/repo`):** checking out the trunk in place is fine.
- **In the user's own working folder,** for example a `cloudy-cloud` session on their laptop, never switch that folder's branch. It is the user's checkout, and an installed `cloudy-cloud` may run from it, so a switch silently changes their files and tools.
  - Do the trunk work in a separate worktree instead: `git worktree add ../<repo>-fleet -b fleet/<topic> origin/<base>`. Run the merge commands below there, and remove the worktree when done.
  - Workers then start from the folder's current commit, so their brief must say to `git fetch origin fleet/<topic> && git rebase origin/fleet/<topic>` first.

1. Create and push the trunk first. Workers copy your tracked files when they start, so commit everything you want them to see before you start them:
   ```sh
   git fetch origin
   git checkout -b fleet/<topic> origin/<base>   # base is usually main
   git push -u origin fleet/<topic>
   ```
   Untracked files are not copied. `git add` and commit anything the workers need. Tell each worker to `git fetch origin fleet/<topic>` and `git rebase origin/fleet/<topic>` (or `git merge`) before it starts if the trunk has moved since it was created.
2. Start the workers (see "Writing briefs"). Each pushes `cloudy-cloud/<id>`.
3. As workers finish, merge them one at a time:
   ```sh
   git fetch origin 'refs/heads/cloudy-cloud/*:refs/remotes/origin/cloudy-cloud/*'
   git checkout fleet/<topic>
   git merge --no-ff origin/cloudy-cloud/<id> -m "Merge <description> (<id>)"   # one-line subject; put any trailers in a second -m
   <test command>
   git push origin fleet/<topic>
   ```
4. If the merge conflicts, either resolve it yourself (small, obvious conflicts) or `git merge --abort` and use `cloud_agent_message` to ask that worker to rebase onto the current trunk, fix it and push again.
5. If the tests fail after a merge, do not push. Revert the merge (`git reset --hard HEAD~1` on your local trunk only) and message the worker with the failing output.
6. When all workers are merged and the full tests pass, open one PR from `fleet/<topic>` to the base. A few PRs are fine if the job is truly separable.

### Sub-coordinators (deep trees)

For large jobs the top coordinator splits the work into areas. Each area gets a sub-coordinator (a `cloud_agent` with `role: "coordinator"`, on Claude) and a sub-trunk `fleet/<topic>/<area>`.

- The top coordinator creates `fleet/<topic>`, pushes it, then gives each sub-coordinator its area, the base branch `fleet/<topic>`, and the name of its sub-trunk.
- Each sub-coordinator creates and pushes `fleet/<topic>/<area>`, runs its own workers, merges them as in step 3, runs the area tests, and reports when its sub-trunk is ready.
- The top coordinator merges each sub-trunk into `fleet/<topic>`, runs the full tests, and opens the PR.
- Git cannot hold both `fleet/x` and `fleet/x/y` as branch names. If that happens, name the sub-trunks `fleet/<topic>-<area>` instead.
- A sub-coordinator's workers run on their own machines and its depth counts toward `CLOUDY_CLOUD_MAX_DEPTH` (3).

## Pattern 3: waves

Use when later work depends on earlier work (for example: wave 1 adds an API, wave 2 writes callers).

1. Run wave 1 as pattern 2 and merge it into `fleet/<topic>`.
2. Push the trunk, then start wave 2 workers. They start from the merged trunk.
3. Never start a dependent worker before its dependency is merged and pushed.

## Tree shapes and models

| Shape | Use for |
| --- | --- |
| 1 Opus coordinator, 10 to 50 workers | One feature, work split by file or module |
| Opus coordinator, 5 Opus sub-coordinators, each 10 to 20 workers | Big migrations, many areas |
| Claude coordinators, open-model workers at the leaves | Bulk work where each task is small and clearly specified |

- Keep coordinators and sub-coordinators on Claude. Merging, resolving conflicts and judging results needs the strongest model.
- Use Claude workers for design, tricky bugs, anything needing judgment, and for tasks that change shared code.
- Use open-model workers for bulk, well-specified tasks: mechanical renames, adding tests to existing code, filling in many similar files, doc updates. Set `profile` to `glm`, `deepseek`, `particle` or `openrouter` (for `openrouter`, also pass `model`). The user must have the profile's key installed; a missing key makes `cloud_agent` fail at once.
- Check an open-model worker's output more carefully. Run the tests on every branch before you merge it.

Example: an Opus coordinator starts 5 Opus sub-coordinators. Each starts 15 `deepseek` workers for its area. The result is one PR with 75 workers behind it.

## Writing worker briefs

A worker sees only your prompt and the repo. Write each brief so it can work alone:

- Goal in one or two sentences.
- Files it owns, by path. Give workers disjoint files so merges stay clean. Say "do not edit anything else". If a shared file must change, one worker owns it, or you edit it yourself after merging.
- Base branch: "Your work builds on `fleet/<topic>`."
- The acceptance check and the exact test command, for example `npm test -- test/parser.test.mjs`. Say what passing looks like.
- "Commit early and often, and push to your `cloudy-cloud/<id>` branch before you finish. Work that is not pushed is lost."
- Do not push to `main`, do not open PRs, do not touch other branches.
- What to put in the final reply: one short paragraph, the files changed, the test result.
- A worker has only the MCP servers the user saved with `cloudy-cloud mcp add` (listed in the reply's `MCP servers:` line, and `pi` workers skip `sse` servers). Do not tell it to use other tools such as a Notion or Linear server unless `cloudy-cloud mcp ls` shows it.

When a cloud_agent tool returns an error, follow its Next step, and relay its Tell the user line to the user when present.

Use a short `description` (it is the label in `/tasks` and `cloud_agent_list`).

## Running the fleet

- Start all agents first, in one go. The tool queues and paces starts and limits Instabox calls itself. Do not add sleeps or batch them by hand.
- In task mode (terminal Claude Code 2.1.304 or later) results arrive on their own. Do not call `cloud_agent_wait`. Otherwise call `cloud_agent_wait` with all the ids, and again after each `cloud_agent_message`.
- **A nested coordinator's workers are deleted when its reply ends.** Each coordinator turn is one `-p` run, and its workers go when that run exits, pushed or not. A coordinator always calls `cloud_agent_wait` on every worker and does not end its reply until all have finished.
- Use `cloud_agent_list` to see status and progress. `queued` is normal while machines start.
- Never trust a worker's reply. A worker saying "done" does not mean the work is pushed or correct. Fetch the branch, look at the diff, run the tests, then merge.
- Check the branch exists: `git ls-remote --heads origin 'cloudy-cloud/<id>'`.
- Merge in the order results arrive. Do not wait for the slowest worker before starting.
- When an agent is merged or abandoned, `cloud_agent_stop` it. Idle agents cost money until they time out at 60 minutes.

## When things go wrong

- A failed or vanished worker: its pushed commits are still on `cloudy-cloud/<id>`. Fetch it and look. Keep what is good.
- To retry: start a new agent from the current trunk with a narrower brief that names what is still missing. Do not re-run the whole original brief.
- No branch found: the worker did not push. Note it in your plan ("worker X: nothing pushed, retried as Y") and retry. Do not pretend it was done.
- A worker that edited outside its files: cherry-pick only the files it owned (`git checkout origin/cloudy-cloud/<id> -- <path>`), drop the rest.
- Quota or queue stalls: if `cloud_agent_list` shows many `queued` agents, the plan's machine limit is full. Wait; the tool retries by itself. Consider fewer, larger tasks.
- Tell the user plainly what failed and what you did about it.

## Safety

- Never print, log, paste into a prompt, or commit keys and tokens: anything in the environment, `~/.config/cloudy-cloud`, `.env` files, `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY`, `*_API_KEY`, `GH_TOKEN`. Do not put them in worker briefs.
- Only push to `cloudy-cloud/*` and `fleet/*` branches. Never push to `main` or the base branch. Tell workers the same.
- Respect the caps: `CLOUDY_CLOUD_MAX_DEPTH` (default 3) limits how deep coordinators can nest, and `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` (default 200) limits how many agents one session starts. Plan the tree to fit. If a start is refused for a cap, do not try to get around it; tell the user.
- Workers run with permission checks off. Do not give them untrusted instructions or content to follow.

## Cleanup

After a branch is merged into the trunk and the trunk is pushed, delete the worker branch:

```sh
git push origin --delete cloudy-cloud/<id>
```

Delete several at once: `git push origin --delete cloudy-cloud/<id1> cloudy-cloud/<id2>`.

Do this only for branches already merged. Keep the branch of a failed worker until you have decided what to keep. After the trunk PR merges, delete `fleet/<topic>` and any `fleet/<topic>/*` branches the same way. Prune local refs with `git fetch --prune`. Then run `cloud_agent_list` and `cloud_agent_stop` any agents still open.

## Final report to the user

Say what the trunk contains, the PR link, which workers succeeded, which failed or needed retries, the test result you saw yourself, and any branches you left behind and why.
