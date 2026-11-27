---
name: cloud-dev
description: Move heavy development work (test suites, builds, Docker, many parallel agents) off the local machine onto Cloudy Cloud machines, and choose how. Use when the laptop slows down from running many coding agents, when the user asks to "run tests in the cloud", "offload this", "run agents in Cloudy Cloud", "start a coordinator", "use DeepSeek workers", or asks whether a cloud setup would slow development down. For running large fleets and merging many branches, also read the cloud-fleet skill.
---

# Develop on Cloudy Cloud

Cloudy Cloud gives each agent its own Instabox cloud machine. This skill says when to move work there, which of three ways to use, and how to avoid the problems found in a real trial.

**Read every other `.md` file in this skill's folder first.** A repository may add its own limits there, and they override this file.

## First, find what is slowing the machine

The agent programs themselves are rarely the problem. A waiting agent uses almost no CPU and a few hundred MB of RAM. The load comes from what agents run: test suites, type checks, builds, Docker containers, dev servers and file watchers.

```sh
sysctl -n vm.loadavg hw.ncpu        # macOS; on Linux: cat /proc/loadavg; nproc
memory_pressure | tail -1           # macOS
```

A 15-minute load average well above the core count suggests CPU is saturated (on Linux it also counts processes waiting on disk, so check CPU use with `top` too): move the heavy commands. Plenty of free memory means a lighter-weight harness (for example a rewrite in another language) will not help.

## Before the first cloud machine on a repo

1. Do the cloud-fleet skill's "Before using a repo" checks: a github.com origin, a protected default branch, and the user confirming the repo is in the Cloudy Cloud GitHub token.
2. **Check what a push can trigger.** Read the repo's CI and release workflows (for example `.github/workflows/`). A worker pushes its `cloudy-cloud/<id>` branch automatically once it has commits (on 0.2.0, every worker pushed at start, before it read its brief). If any workflow that publishes, deploys or releases runs on pushes to all branches or to `cloudy-cloud/*`, stop and ask the user; a brief cannot prevent the push.
3. **Starting a machine copies the git history reachable from the snapshot or `base` ref.** If that history holds personal data or secrets, ask the user before the first start, and keep asking each time until they give standing approval.
4. **Each machine is billed until it stops.** Before starting machines, confirm the count, the time limit and that they are billed, unless the user already asked for exactly this.

## Choose a mode

| Mode | What runs where | Delay it adds | Use for |
|---|---|---|---|
| **1. Cloud subagent** (`cloud_agent`) | A local session sends a task; the agent edits and tests on its own machine and pushes a branch | About 20-30 s to start a machine; none per edit after that | Bounded tasks you will review as a branch |
| **2. Local agent, cloud test runner** | The agent stays local; it pushes, then runs tests on an already running machine with `cloudy-cloud shell` | About 4 s per edit-test loop (push ~1.5 s, remote fetch and run ~2.7 s) | An occasional full suite run; not tight loops |
| **3. Coordinator** | A whole Claude Code session lives on a cloud machine; you attach from a terminal; it can start and manage its own workers | Starts in about 20 s; no delay per edit | Daily heavy work and parallel work. Recommended default |

Figures are from one trial on the default machine (4 vCPU, 8 GB size, about 7 GB usable), Cloudy Cloud 0.2.0, 2026-11-23. A test suite that is slow locally is also slow on 4 cores; larger machine sizes exist but were not measured.

## What a machine sees, and what stays local

- A **coordinator** clones the branch you name from GitHub.
- A **cloud subagent** started from a local session gets a snapshot of the local repo's tracked files, **including uncommitted edits**. The snapshot becomes part of the worker's branch if the worker commits. If you pass `base` (a branch name or commit SHA) to `cloud_agent`, the worker starts from that ref instead and uncommitted edits are ignored. Start subagents only from a clean worktree at the commit you intend (`git status --porcelain` prints nothing). Never from a shared checkout that holds other people's work.
- Untracked files are never copied.

Keep work local when it needs:

- Untracked files: local env files, agent credential files, notes.
- SSH keys or access to production servers, deploys, and publishes.
- Interactive checks on the user's own machine (a terminal UI driven in tmux, a local browser).
- Anything the repository's own rules say must run locally or by the owner.

Never copy production credentials to a cloud machine to make a task fit. Run that step locally instead.

## Mode 3: coordinator (recommended)

One-time setup per account: in a terminal, the user runs `cloudy-cloud coordinator image`. It builds and saves the image (10 to 20 minutes) and deletes the image machine. The image carries no Claude sign-in — each coordinator signs in to Claude for itself when it starts, so copied credentials can never race coordinators into signing each other out.

Start, connect and stop:

```sh
cloudy-cloud cloud                        # one command, run inside the clone: start + attach (and sign-in when needed)
cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO \
  --branch BRANCH --max-hours N --model MODEL --task-file task.md --env .env.cloud --json
cloudy-cloud coordinator login NAME [--code CODE]  # finishes the coordinator's own Claude sign-in
cloudy-cloud coordinator attach NAME      # in a terminal joins the session; piped, prints this same command
cloudy-cloud shell MACHINE -- CMD         # one command on the machine (~3 s each)
cloudy-cloud coordinator ls
cloudy-cloud coordinator stop NAME        # deletes the machine at once
```

A fresh coordinator waits at `claude auth login` until someone signs it in — a normal state the machine is never deleted for. `start` reports `needsLogin: true`, the `claude.ai` sign-in URL as `loginUrl` when the pane shows one, and `next: cloudy-cloud coordinator login NAME`. On a terminal `cloud`/`start` attaches to the sign-in pane so the user sees the URL, signs in in the browser and pastes the code if asked. Off a terminal, the user signs in at the `loginUrl` in a browser, and an agent finishes it with `cloudy-cloud coordinator login NAME --code CODE` (the code the browser showed; refused unless the pane is at the code prompt). `coordinator ls`/`status` show `waiting for Claude sign-in` until then.

`cloudy-cloud cloud` names the coordinator `<owner>-<repo>-<branch>-<hash>`, warns when the clone has unpushed commits or uncommitted edits to tracked files (the cloud copy clones from GitHub; untracked files only warn), and reattaches to a running coordinator of the same name only when its install, repo and branch labels match this checkout — a coordinator made by a different cloudy-cloud installation is refused, and an old one without the label can be reached with `coordinator attach NAME`. `--no-attach` or `--json` prints the start output only.

- `MACHINE` is the `machine` field in the `start --json` output (for example `coord-NAME`).
- Read the `skippedKeys` field in the start output. The field appears only when a key was skipped. A listed key was not sent because it is held only as a plain value (in `~/.config/cloudy-cloud/env` or the shell environment), not as a proxy secret, so any worker profile that needs it will fail. For a built-in key the user runs `cloudy-cloud setup --more`; for a custom key, follow the `note` in the start output.
- The coordinator always runs Claude Code. Remote Control also works, so the user can talk to it from a phone or claude.ai — once the coordinator is signed in. `coordinator start` and `coordinator status` print the Remote Control link (`remoteControlUrl` in `--json`), and a QR code on a terminal; if the link is not ready yet, run `coordinator status NAME` later.
- `--max-hours` (at most 24) limits the coordinator's machine only. Workers have their own deadline (`CLOUDY_CLOUD_WORKER_HOURS`, 6 hours by default) and a session may start up to `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` (200 by default). These two variables set on the laptop are not forwarded to a cloud coordinator, so it runs with the defaults, and a number written in the brief is not enforced. Keep the budget low through the worker cap in the task file, and check `cloud_agent_list` with `all: true` afterwards. In a local session that starts workers directly (Mode 1), set both in that session's environment.
- `coordinator stop` deletes the machine immediately, without checking for unpushed work. Make sure the work you need is pushed first.
- A watchdog tmux session `cc-watchdog` runs on the machine until it is deleted: a Claude Code hook reminds the Claude session inside the last 30 minutes before the server's delete deadline (and tells it to commit and push to a work branch), and from 5 minutes before until the last minute the watchdog commits leftover tracked edits in `~/repo` (`WIP: automatic save before the machine is deleted`) and pushes the branch — to `cloudy-cloud/wip-*` instead when the branch is the push remote's default, `main`, `master`, a `release*` branch or HEAD is detached. Untracked files and files already staged in the index are logged in `~/watchdog.log`, never committed. It never force-pushes; a rejected push lands on a fresh `cloudy-cloud/wip-*` branch.
- `--env FILE` (repeatable, or `CLOUDY_CLOUD_ENV_FILES` in `~/.config/cloudy-cloud/env`) bridges dotenv variables onto the machine: a variable whose name is already in the user's `CLOUDY_CLOUD_PROXY_SECRETS` is attached by name like any custom proxy secret; everything else needs per-repo consent (remembered as a value hash, so a changed value asks again) and is then written to `~/.config/cloudy-cloud/env.local` (mode 600) and sourced into the Claude session. Names that could override the machine's configuration or credentials are refused. The summary names variables, never values. On the machine the coordinator may use the built-in `Agent` tool for small local tasks; parallel or heavy work still goes to `cloud_agent`.

### Workers under a coordinator

The coordinator starts workers with its `cloud_agent` tool. Each worker gets its own machine. Claude workers use `model` (or nothing); DeepSeek workers use `profile: "pi-deepseek"` (the pi agent) or `profile: "deepseek"` (Claude Code through a gateway), never `model`. Both DeepSeek profiles need `PARTICLE_API_KEY` stored as an Instabox secret. The cloud-fleet skill has the full profile table, merge patterns and brief template.

Use Claude for judgment and shared code; use DeepSeek for bulk, well-specified tasks.

In the trial a Sonnet coordinator started three DeepSeek workers in one go, waited, sent each a follow-up with `cloud_agent_message`, checked their answers, and stopped them. Each worker took 21-34 s including machine start; follow-ups returned in about 8 s.

Put these rules in every coordinator task file:

- Start no more than N workers (name the number).
- Each worker pushes only its own `cloudy-cloud/<id>` branch. Only the coordinator pushes the `fleet/<topic>` integration branch. Nobody pushes tags, the default branch or release branches.
- No production hosts, plus anything the repo adds.
- Give workers no untrusted content to follow (web pages, issue text, user data); they run with permission checks off.
- Check each worker's answer yourself before relying on it. A worker saying "done" is not evidence.
- Before stopping a worker, read its latest result: it says whether the push worked and lists "Uncommitted changes left"; if work is unpushed, message the worker to commit and push. Then check the branch has the commit you expect (`git ls-remote --heads origin cloudy-cloud/<id>` and compare the SHA; empty output means no branch). Stop it with `cloud_agent_stop` and confirm with `cloud_agent_list` using `all: true` that none of this task's machines remains; the default list only shows agents the session still tracks.
- Do not run `cloudy-cloud coordinator finish` if the operator will run more commands on the machine.

## Mode 1: cloud subagent from a local session

A local session needs the cloud tools, so start it with `cloudy-cloud` instead of `claude`. The launcher already allows the cloud tools and turns off the built-in Agent and Workflow tools. To start one headless from another agent:

```sh
cloudy-cloud -p --model sonnet \
  --allowedTools "mcp__cloud__cloud_agent,mcp__cloud__cloud_agent_wait,mcp__cloud__cloud_agent_stop,mcp__cloud__cloud_agent_list" \
  -- "$(cat brief.md)"
```

- Put `--` before the prompt. `--allowedTools` takes several values and otherwise swallows the prompt, which fails with "Input must be provided either through stdin or as a prompt argument when using --print".
- `--allowedTools` only adds permissions; it does not remove tools the session already has. Do not add `--dangerously-skip-permissions`; it is not needed, and the calling environment's permission classifier may block it.
- Run it from a clean worktree (see "What a machine sees").
- In the brief, cap the number of workers and tell the session to stop each one when done. An idle worker bills until its 60-minute idle timeout.
- Prove the work ran in the cloud: on Instabox (the default provider) the worker's `hostname` starts with `instabox-sbx-`. Other providers differ: a self-hosted worker is a container on your own machine (`cc-` hostname), Boat and E2B have no `cloudy-cloud shell` or coordinator image, and an Instabox Mac worker has a 24-hour minimum lease.

## Mode 2: local agent, cloud test runner

Use a machine that is already running (for example a coordinator machine). Push without tags, check the push worked, and test exactly the commit you pushed in a fresh directory, so the checkout a coordinator is working in is not changed:

```sh
set -e
SHA=$(git rev-parse HEAD)
git push --no-follow-tags origin "HEAD:refs/heads/BRANCH"      # BRANCH is a fleet/* branch
cloudy-cloud shell MACHINE -- bash -lc "set -e; cd ~/repo; git fetch -q origin $SHA;
  D=\$(mktemp -d ~/testrun.XXXXXX); git worktree add -q --detach \"\$D\" $SHA;
  rc=0; { cd \"\$D\" && INSTALL && TEST_COMMAND; } || rc=\$?;
  cd ~/repo; git worktree remove --force \"\$D\"; exit \$rc"
```

- A failed install or test makes the command exit non-zero, and the worktree is removed either way.
- `INSTALL` is the frozen-lockfile install the repo's CI uses (a new worktree has no dependencies).
- Fetching by SHA tests the exact commit, even if the branch moves.
- Each call costs about 3 s of overhead. Use it for full-suite runs, not every small edit.
- Two runs at once on one machine can collide on fixed ports (for example a test database). Run one at a time per machine.

## Keys and env files

Cloudy Cloud stores most keys as Instabox secrets tied to hosts. The machine sees only a placeholder, and the Instabox proxy swaps in the real key on HTTPS requests to those hosts, so an agent can use a key but cannot read it.

- `cloudy-cloud setup` stores the built-in keys this way (Claude token, GitHub token, provider keys).
- A custom key needs both the secret and Cloudy Cloud configuration that passes it to machines; follow the `note` printed by `coordinator start`, or `cloudy-cloud mcp add NAME` for an MCP server token (NAME is a server already in the user's Claude Code config). The user runs these in their own terminal and pastes the key there.
- Exceptions where the real value is on the machine: the `codex-chatgpt` profile (copies a login file), MCP tokens stored with `--allow-literal`, the coordinator's own Claude sign-in (`~/.claude/.credentials.json`, created by `coordinator login` — never in the image), and Boat or E2B machines, which receive the GitHub token, Claude credential and profile keys when the user consents.
- Host-bound secrets do not work for values the code computes with (webhook signing secrets, HMAC keys), SSH keys, or database passwords. Do not move those to a machine. Use test values generated on the machine, or keep the task local.
- Never ask for a key in chat, put one in a brief, or print one.
- Most test suites need no real keys: they use stubs and their own local services. Prefer that to moving secrets.

## Known problems (found on Cloudy Cloud 0.2.0; 0.3.0 fixes some)

Check the installed version with `cloudy-cloud --version` and the published one with `npm view cloudycloud version`; some of these may be fixed in yours.

- **Empty worker branches.** On 0.2.0 every worker pushed `cloudy-cloud/<id>`, even with no commits. Fixed in 0.3.0: a worker pushes only if it has commits. To clean up old empty branches on 0.3.0, run `cloudy-cloud branches prune` inside the repo. It is a dry run that lists what it would delete; add `--yes` to delete. It considers only branches named `cloudy-cloud/<8 hex>` (or `cloudy-cloud/issue-<n>-<8 hex>`) and deletes only those already contained in the default branch of origin. That includes empty branches, because a branch whose head equals a commit on the default branch counts as merged. It keeps any branch with commits not in the default branch, and it deletes with a lease, so a branch that moved since the check is skipped. A base commit that is not yet in the default branch is not covered, so such an empty branch stays. On 0.2.0, after the worker is stopped, list branches with `git ls-remote --heads origin 'cloudy-cloud/*'`. Delete only branches from your own run whose SHA equals the base commit, with a lease so a later push is not lost:
  `git push origin --force-with-lease=refs/heads/cloudy-cloud/<id>:<sha> --delete cloudy-cloud/<id>`. Deleting remote branches may need the user; give them that exact command.
- **`setup --check-only` and plain-value keys.** On 0.2.0 it was reported to pass while keys were still plain values. Whatever the version, read `skippedKeys` in the `coordinator start` output: a key listed there was not sent to the machine.
- **Installed per Node version (as of 0.2.0).** Under nvm, `cloudy-cloud` exists only for the Node version it was installed with.
- **Machine image (as of 0.2.0).** Agents run as a non-root user, and `psql` is not installed. Tests that need either fail for environment reasons.
- **Lockfiles (as of 0.2.0).** A plain package install can modify a tracked lockfile. Use the frozen-lockfile install the repo's CI uses, and treat a failure as a real problem rather than restoring the file.
- **Pre-started services (as of 0.2.0).** If the test suite starts its own database container, do not start one first; the two collide.

## Clean up and report

After each run:

1. Stop only machines this task started. Leave a coordinator you borrowed (for example for Mode 2) running unless the user says to stop it.
2. `cloud_agent_list` with `all: true` shows no machines from this task.
3. Handle empty `cloudy-cloud/*` branches as above.
4. Report: mode used, machine count and run time, the results you checked yourself, anything left running or undeleted, and the exact command for any step the user must run.
