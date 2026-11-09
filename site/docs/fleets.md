# Coordinators and fleets

> Run a cloud coordinator that manages many workers, and the limits that apply.

Source: https://cloudycloud.tech/docs/fleets.html

A coordinator is a Claude session that starts and manages many worker agents, each on its own cloud machine. This page covers when to use one, how to run one, and how to merge many worker branches into one pull request.

## When to use a coordinator

For a few independent tasks, start plain cloud agents from your own session. You wait for them and review their branches yourself.

Use a **cloud coordinator** when all of these are true:

- The job is long or large.
- You want to leave, or close your laptop.
- The work needs only what is already on GitHub.

Do not hand a job to a cloud coordinator if it needs untracked local files, secrets or services that exist only on your laptop, or if you want to steer it step by step. Run the fleet from your own session instead.

There is also a lighter option. A cloud agent started with `role: "coordinator"` is a Claude subagent that can start its own cloud agents. Use this to build a tree: a coordinator, sub-coordinators for separate areas of the code, then workers. It lives only as long as your session. A cloud coordinator (below) runs on its own machine and keeps working with your laptop closed.

## Cloud coordinator lifecycle

### 1. Make the coordinator image (once)

Remote Control needs a full Claude login. A token from `claude setup-token` cannot open Remote Control sessions. So you sign in once on an image machine and save it as an Instabox snapshot.

```
cloudy-cloud coordinator image
```

This creates a machine, installs `cloudy-cloud` on it, and prints an SSH command. Run that command, then run this in the shell it opens:

```
claude auth login
```

Finish the browser sign-in, leave the shell, then save the snapshot:

```
cloudy-cloud coordinator image --save
```

This saves the snapshot id as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT` in `~/.config/cloudy-cloud/env` and deletes the image machine. The image machine is deleted by the server after 2 hours if you do not finish.

### 2. Start a coordinator

```
cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO --branch main --task-file brief.md
```

- `NAME`: lowercase letters, digits and `-`, up to 40 characters.
- `--repo`: a github.com https URL. The coordinator clones it into `~/repo`.
- `--branch B`: the branch to clone. Optional.
- `--task TEXT` or `--task-file PATH`: the brief. Optional, up to 100 KB. Without one, the coordinator waits for you.
- `--max-hours N`: when the server deletes the machine. Default and maximum 24.
- `--json`: print the machine name, Remote Control name and attach command as JSON.

The coordinator sees only the brief and the repo on GitHub. Commit and push everything it needs first. Give it exact acceptance commands, the files each work package owns, and a default for every question you can foresee, because nobody is there to answer.

### 3. Reach it

- **Remote Control:** open claude.ai/code or the Claude app and pick the session named `NAME`.
- **Terminal:** `cloudy-cloud coordinator attach NAME` prints an SSH command that attaches to its tmux session. Run the command it prints.

The first time, attach once and accept any trust or Remote Control prompts. To list your coordinators and their delete times, run `cloudy-cloud coordinator ls`.

### 4. Finish or stop

- The coordinator ends its own job with `~/cloudy-cloud/bin/cloudy-cloud coordinator finish`. This deletes its machine only if the working tree is clean, the current branch and every `fleet/*` branch are pushed, and no worker is still running. If a check fails it tells you what to fix. `--force` skips the git and worker checks.
- You can delete it at any time with `cloudy-cloud coordinator stop NAME`.
- If neither happens, the server deletes the machine at its deadline.

> Warning: A coordinator is billed until it is stopped, finished or deleted. Its `~/.config/cloudy-cloud/env` holds your real Instabox key, your Claude setup-token and your provider API keys, because it needs them to start workers. Anyone who can SSH into the machine can read them. Use keys you can revoke.

## Getting one result from many workers

Each worker pushes a branch named `cloudy-cloud/<id>`. Starting 100 workers is easy. Reviewing 100 pull requests is not. The `cloud-fleet` skill teaches Claude these patterns:

| Situation | Pattern |
|---|---|
| Many unrelated small fixes, and reviewers want separate PRs | Flat fan-out: one PR per branch. Keep it to about 10 to 15. |
| One feature or one large job split across many workers | Trunk merging (the default) |
| Stage B needs the merged result of stage A | Waves |
| More than about 50 workers, or clearly separate areas | Trunk merging with sub-coordinators |

### Trunk merging

The coordinator creates an integration branch `fleet/<topic>` and is the only one that merges into it.

Create and push the trunk before starting workers. Workers copy only tracked files, so commit everything they need first.

```
git fetch origin
git checkout -b fleet/<topic> origin/<base>
git push -u origin fleet/<topic>
```

2. Start the workers. Give each a brief with its goal, the files it owns, the base branch `fleet/<topic>`, the exact test command, and an instruction to push to its `cloudy-cloud/<id>` branch before it finishes.

As workers finish, fetch their branches and merge them one at a time, running the tests after each merge:

```
git fetch origin 'refs/heads/cloudy-cloud/*:refs/remotes/origin/cloudy-cloud/*'
git checkout fleet/<topic>
git merge --no-ff origin/cloudy-cloud/<id> -m "Merge <description> (<id>)"
git push origin fleet/<topic>
```

4. On a conflict, resolve small ones yourself, or abort the merge and ask the worker to rebase. If the tests fail after a merge, do not push it. Send the worker the failing output.
5. When every good branch is merged and the full tests pass, open one PR from `fleet/<topic>`.
6. Delete merged worker branches: `git push origin --delete cloudy-cloud/<id>`. Keep the branch of a failed worker until you decide what to keep.

> Note: Do not trust a worker that says it is done. Fetch its branch, read the diff and run the tests before merging. If a worker pushed nothing, retry it with a narrower brief that names what is missing.

Only push to `cloudy-cloud/*` and `fleet/*` branches. Never push to `main`. Protect your main branch with a GitHub ruleset, because workers run with permission checks off.

### Sub-coordinators and waves

For large jobs, the top coordinator gives each area to a sub-coordinator with its own sub-trunk `fleet/<topic>/<area>`. Each sub-coordinator merges its workers, tests its area, and reports. The top coordinator merges the sub-trunks and opens the PR. Git cannot hold both `fleet/x` and `fleet/x/y`, so if that happens name them `fleet/<topic>-<area>`.

For waves, merge wave 1 into the trunk and push it before you start wave 2. Never start a dependent worker before its dependency is merged and pushed.

Keep coordinators on Claude, because merging and judging results needs a strong model. Open-model workers suit bulk, well-specified tasks. See [Models and keys](https://cloudycloud.tech/docs/models.html). Check their branches more carefully.

## Limits and costs to watch

| Limit | Value |
|---|---|
| Cloud coordinator delete deadline | 24 hours by default and at most; set shorter with `--max-hours N`. It cannot be extended. A job that must run longer needs a new coordinator from a pushed branch. |
| Worker and nested coordinator delete deadline | `CLOUDY_CLOUD_WORKER_HOURS`, default 6, at most 24 |
| Idle agent | Stopped after 60 minutes with nothing to do |
| One task | Stopped after 29 minutes |
| Nesting depth | `CLOUDY_CLOUD_MAX_DEPTH`, default 3 |
| Agents per session | `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION`, default 200 |
| Start rate | `CLOUDY_CLOUD_STARTS_PER_MIN`, default 25 a minute. Extra agents show as `queued`. |
| Instabox calls at once | `CLOUDY_CLOUD_MAX_INSTABOX_CALLS`, default 24 |

Every machine in a tree counts against your Instabox machine limit and start rate. If many agents stay `queued`, the machine limit is full. Wait, or use fewer, larger tasks. Stop agents you no longer need with `cloud_agent_stop`, because idle agents cost money until they time out.

> Warning: Only work pushed to GitHub survives. A worker's unpushed work is lost with its machine. When you stop a coordinator, its workers are deleted by its cleanup process or at their own deadline (6 hours by default), so stop or collect them first. Machines your laptop session started are deleted when that session ends, so push or collect their work before you exit.

To see what is running, use the [dashboard](https://cloudycloud.tech/docs/dashboard.html).
