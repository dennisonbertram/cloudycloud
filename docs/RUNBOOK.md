# claude-cloud runbook

This covers setting up `claude-cloud`, using it, operating it day to day, and fixing common problems.

## 1. What you need

| Item | Notes |
| --- | --- |
| macOS or Linux | Tested on macOS. |
| `git` and Node.js 20 or later | Check with `git --version` and `node --version`. |
| [Claude Code](https://code.claude.com) | Check with `claude --version`. You must be signed in. |
| A Claude subscription or Anthropic API key | Subagents use a long-lived token from `claude setup-token`. An API key works too but is billed separately. |
| An [Instabox](https://instabox.sh) account | **Free plan:** too small for more than a few subagents at once. **Paid plan:** needed for swarms. |
| A GitHub repository you can push to | Subagents push their branches there. |

## 2. One-time setup

### 2.1 Install and enter your keys

```sh
git clone https://github.com/dennisonbertram/ai-seamless-sandboxes.git
cd ai-seamless-sandboxes
./install.sh
```

Run it in a terminal; it asks for keys, so it will not run from a pipe. It checks `git`, Node.js 20 or later, `npm`, `curl` and Claude Code, runs `npm install`, and links `claude-cloud` onto your PATH. If `claude-cloud` already points at another folder, it asks before changing that, and the default is to keep the current link. Then it asks for three keys. Nothing shows as you paste, and nothing is printed back except the last four characters.

| Key | Where to get it |
| --- | --- |
| **Instabox API key** (`ibk_…`) | Create it at https://dashboard.instabox.sh/dashboard/api-keys. The script checks it with Instabox before saving. |
| **Claude token** (`sk-ant-oat01-…`) | In another terminal run `claude setup-token`. Your own `claude` login is not changed. |
| **GitHub token** | Create a fine-grained token (section 2.2). The Instabox command-line tool asks for it, so `install.sh` never sees it. |

The first two are saved to `~/.config/claude-cloud/env`, which only your user account can read. The GitHub token is stored in Instabox as the secret `GH_TOKEN`. After the first install, run `claude-cloud setup` at any time (it runs `install.sh` from the folder `claude-cloud` was linked from, whatever folder you are in); it shows each saved key as masked and asks before replacing it.

`claude-cloud` runs from the folder you ran `install.sh` in, on whatever branch is checked out there. The final message of `install.sh` shows the folder and branch.

### 2.2 The GitHub token

Subagents push their work to GitHub. Instabox stores the token and adds it only to requests to GitHub, so a subagent's machine sees a placeholder, never the token.

- Create it at https://github.com/settings/personal-access-tokens/new.
- **Repository access:** *Only select repositories*. Choose only the repos you will use `claude-cloud` in.
- **Permissions:** *Contents*, read and write. *Metadata*, read-only, is added automatically.
- **Expiration:** your choice. Shorter limits the damage if it leaks.
- `install.sh` runs `npx --yes instabox@latest login` if you are not signed in, then `npx --yes instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com`, and the Instabox tool asks for the token. The name must be exactly `GH_TOKEN`.

### 2.3 Protect your main branch

In the repo on GitHub, open *Settings → Rules → Rulesets* and add a branch ruleset that blocks direct pushes to your main branch. Subagents run with permission checks off, and the token can push to any branch it reaches.

### 2.4 First run

The repo you work in needs a GitHub `origin` that your token can push to:

```sh
cd <your repo>
git remote -v        # should show github.com
claude-cloud
```

Setup happens only in `install.sh`. If a key is missing, `claude-cloud` prints `claude-cloud is not set up yet (...). Run: claude-cloud setup`. In a terminal it also asks `Run setup now? [Y/n]` and continues into the session after setup; without a terminal it exits 1.

## 3. Check that it works

In the `claude-cloud` session, type:

```
use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
```

**Expected:** the answer names a hostname starting with `instabox-sbx-`, and ends with `Pushed to origin claude-cloud/<id> at <sha>`. Then confirm the file reached GitHub:

```sh
git fetch origin claude-cloud/<id>
git show FETCH_HEAD:proof.txt
```

## 4. Daily use

- **Start:** run `claude-cloud` from inside the repo you want subagents to work on.
- **Ask for subagents in plain language.** The session decides when to use them.
  - "use 5 subagents in parallel to …"
  - "ask the second subagent to also …"
  - "list the subagents"
  - "stop all subagents"
- **Collect work** from GitHub. Each subagent has its own branch:

  ```sh
  git fetch origin 'refs/heads/claude-cloud/*:refs/remotes/origin/claude-cloud/*'
  git branch -r --list 'origin/claude-cloud/*'
  ```

  Merge, cherry-pick or open pull requests from these branches as usual.
- **Watch and stop subagents.** In a terminal session on Claude Code 2.1.304 or later, each subagent call is an MCP task:
  - The footer shows `N MCP tasks`.
  - `/tasks` shows one line per task, updated every few seconds: `12 tool uses · 48.2k tokens · 3m10s · Edit src/parser.ts`. `starting machine…` means the machine is not up yet. The tokens are input (including cached input) plus output.
  - Claude Code's task view says each task "runs on the server; survives exiting this session". That text does not apply to `claude-cloud`: when you exit the session, every subagent stops and its machine is deleted. Push or collect work before you exit.
  - Select a task and press `x` to stop it. For a task started by `cloud_agent` this stops the agent and deletes its machine. For a task started by `cloud_agent_message` it stops only that follow-up, and the agent stays open and idle.
  - The result reaches the session by itself when the task ends. It ends with a line such as `Total: 12 tool uses, 93.1k in / 327 out tokens, $0.0078, 3m10s` (the cost appears when Claude reports it).
  - Asking "list the subagents" shows the same progress line for each one.
- **Without tasks.** In the VS Code extension, the desktop app, or a one-shot `claude -p "<prompt>"` run, Claude Code does not make MCP tasks. The tools then return an agent ID and Claude uses `cloud_agent_wait`, exactly as in older versions. Nothing needs configuring. Task mode is not turned on or off with any setting of this tool, so do not set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` or `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`.
- **Large swarms.** Start as many as you need. Starts are paced and queued automatically (`CLAUDE_CLOUD_STARTS_PER_MIN`, default 25 a minute), and Instabox requests share `CLAUDE_CLOUD_MAX_INSTABOX_CALLS` slots (default 24). Queued subagents show the status `queued`. Set either variable in the environment, or as `NAME=value` in `~/.config/claude-cloud/env`, before you start `claude-cloud`.
- **When subagents stop:**
  - when you or the session stops them;
  - after 60 minutes with nothing to do;
  - when the session ends.

  Their machines are deleted at that point. Anything a subagent didn't push is lost with its machine.

## 5. Maintenance

| Task | Command or step |
| --- | --- |
| **List cloud machines** | `npx instabox@latest ls`. Machines created by this tool have the label `purpose=claude-cloud`. |
| **Delete a leftover machine** | `npx instabox@latest rm <name>` |
| **Delete all subagent branches on GitHub** | `git ls-remote --heads origin 'claude-cloud/*' \| awk '{print $2}' \| xargs -n 50 git push origin --delete` |
| **Replace a key** (Claude token, Instabox key or GitHub token) | Run `claude-cloud setup`, answer `y` for that key, then restart `claude-cloud`. A running session keeps the old key until you restart it. |
| **Remove all saved keys** | `rm ~/.config/claude-cloud/env` |
| **Update the tool** | `git pull && npm install` in the folder that `install.sh` printed, then restart `claude-cloud` |
| **Uninstall** | `npm unlink -g claude-cloud`, then delete the folder and `~/.config/claude-cloud` |

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `claude-cloud is not set up yet ... Run: claude-cloud setup` | A key is missing. Run `claude-cloud setup`. |
| `Got 103 of 108 characters, so it looks cut off` | The Claude token was cut short when pasted. Press Enter at the Claude step to let the installer get the token itself, or copy the whole token again; wrapping onto two lines is fine. |
| `Got N of 56 characters` or `starts like an Instabox key` | The Instabox key is incomplete or has a typo. The dashboard shows a key only once, so if it was lost, create a new one at https://dashboard.instabox.sh/dashboard/api-keys. |
| `Claude rejected this token` | The token is revoked or from another login. Run `claude-cloud setup` and press Enter at the Claude step. |
| `Stopped the ... step after 3 tries` | Nothing was changed. The saved key stays. Run `claude-cloud setup` to try again. |
| `malformed API key`, or `401` from Instabox in a session | The Instabox key is wrong or revoked. Run `claude-cloud setup`, replace the key, and restart `claude-cloud`. |
| You changed a key but the session still uses the old one | `claude-cloud` reads keys once at start. Restart it. |
| `claude-cloud needs the repo to have an origin remote on github.com` | Add one with `git remote add origin https://github.com/<owner>/<repo>.git`, and make sure your token includes that repo. |
| `The first push to origin claude-cloud/<id> failed` | The `GH_TOKEN` secret is missing, or the token can't write to this repo. Run `claude-cloud setup` and replace the GitHub token, and check the token's repository list. |
| `The GH_TOKEN Instabox secret could not be attached` | The secret doesn't exist or is named differently. Run `claude-cloud setup` and replace the GitHub token. The name must be exactly `GH_TOKEN`. |
| `Not logged in · Please run /login` or `401` from a subagent | No valid Claude token reached the machine. Run `claude setup-token`, then run `claude-cloud setup` and replace the Claude token, and restart `claude-cloud`. This also happens if you only have `ANTHROPIC_API_KEY` exported, because some wrappers, such as cmux's `claude`, remove it. |
| A subagent stays `queued` | Your Instabox plan's machine limit (`quota_exceeded`) is full, or starts are waiting for the pace limit. Paused machines count too. It retries every 60 seconds for up to 30 minutes, then fails with Instabox's message. Stop subagents you don't need, delete leftover machines (section 5), or upgrade the plan. |
| `rate_limited` after 5 tries | Instabox kept refusing starts. Lower `CLAUDE_CLOUD_STARTS_PER_MIN` (the default 25 is under the Pro plan's about 30 a minute) and restart `claude-cloud`. |
| A subagent's work is missing | Only pushed work survives. Check the result for `Push failed` or `Uncommitted changes left in the sandbox`. While the subagent is open, ask it to commit and push. |
| The session uses no subagents, or says `Agent` is unavailable | That's expected: `claude-cloud` turns off the built-in `Agent` and `Workflow` tools. Ask for "a subagent" and it uses `cloud_agent`. Plain `claude` still has the built-in tools. |
| A subagent can't use an agent type you defined | Only agents committed in the repo, or built into Claude Code, exist on the machine. Agents in `~/.claude/agents` aren't sent. |

## 7. How it works

1. **The launcher.** `bin/claude-cloud` starts Claude Code with three changes:
   - the built-in `Agent` and `Workflow` tools turned off;
   - an extra system prompt;
   - an MCP server, `src/server.mjs`, that provides the `cloud_agent_*` tools.
2. **Starting a subagent.** `cloud_agent` takes a snapshot of your repo's tracked files, including uncommitted edits, without touching your working tree. Then:
   - it creates an Instabox machine and attaches the `GH_TOKEN` secret;
   - it uploads the snapshot and checks it out on branch `claude-cloud/<id>`;
   - it pushes that branch, then runs `claude -p` in the background.

   The call returns at once, because Claude Code runs MCP tools one at a time unless they're marked read-only. When the client supports MCP tasks, the call returns a task (id `cc-<agent id>-t<turn number>`, for example `cc-3f2a91bc-t2`). The server detects this from the client capabilities that Claude Code sends with each request on MCP revision 2026-07-28, and the server answers `tasks/get` and `tasks/cancel` for the task.
3. **Getting answers.** In task mode, Claude Code polls `tasks/get` and passes on the result when the task ends. Otherwise `cloud_agent_wait`, which is read-only, collects answers. Follow-ups use `claude -p --resume <session>` on the same machine. The machine runs `claude -p --output-format stream-json --verbose`; the server reads that stream as it arrives to count tool uses and tokens and to find the current step.
4. **After every task.** The tool runs `git push` once more, in case the subagent forgot. It never commits for the subagent; it lists any uncommitted files instead.
5. **Secrets.**
   - **Instabox key and Claude token:** these stay in `~/.config/claude-cloud/env` and the MCP server. They never appear in process arguments.
   - **Claude token on the machine:** only the Claude token is placed on each machine.
   - **GitHub token:** it stays in Instabox. The machine sees only a placeholder, which Instabox's proxy replaces on requests to `github.com` and `api.github.com`.

## 8. Cloud coordinators

A coordinator is a long-lived Claude Code session on its own Instabox machine. It runs `claude-cloud` there, so it can start worker machines. You reach it through Remote Control (claude.ai or the Claude app) or SSH, and it keeps working while your laptop is closed.

### 8.1 Make the coordinator image (once)

Remote Control needs a full Claude login. A token from `claude setup-token` can only make model requests, so it cannot open Remote Control sessions. You sign in once on an image machine and keep the result in an Instabox snapshot.

1. `claude-cloud coordinator image` creates a machine labelled `role=coordinator-image`, installs `claude-cloud` on it, and prints an SSH command.
2. Run that SSH command, then `claude auth login` inside the machine, and finish the sign-in in your browser.
3. `claude-cloud coordinator image --save` snapshots the machine, saves the snapshot id as `CLAUDE_CLOUD_COORDINATOR_SNAPSHOT` in `~/.config/claude-cloud/env`, and deletes the image machine. A snapshot keeps the home folder, including the saved sign-in.

### 8.2 Commands

| Command | What it does |
| --- | --- |
| `claude-cloud coordinator start NAME --repo https://github.com/OWNER/REPO [--branch B] [--max-hours N]` | Creates a machine from the snapshot (label `role=coordinator`, never pauses), attaches the `GH_TOKEN` secret, writes the keys file, installs your laptop's exact `claude-cloud` there (sent as a git bundle, so it need not be pushed to GitHub), clones the repo, and starts a tmux session `claude` running `claude-cloud --remote-control "NAME"`. With `--task TEXT` or `--task-file PATH` (not empty, at most 100 KB) the task is uploaded to `~/task.md` on the machine and passed as the session's first prompt, so the coordinator starts working at once. `--max-hours N` sets the delete deadline (default and maximum 24; see 8.5). `--json` prints `{name, machine, remoteControlName, attach}` instead of the text. |
| `claude-cloud coordinator attach NAME` | Prints `npx --yes instabox@latest ssh <machine> -- tmux attach -t claude`. Run it to see the session. |
| `claude-cloud coordinator ls` | Lists coordinators: name, state, created time, machine name, and the time the server deletes the machine. |
| `claude-cloud coordinator stop NAME` | Deletes that coordinator's machine. Its workers are deleted by its own `claude-cloud` cleanup process when its session ends, or by their own delete deadline. |
| `claude-cloud coordinator finish [--force]` | Run on the coordinator machine, by the coordinator. Deletes that machine after checking that the work is on GitHub (see 8.5). It refuses to run on a laptop. |

The first time you attach, accept any trust or Remote Control prompts. Then pick the session named NAME in claude.ai/code.

### 8.3 Keys on the coordinator

- The coordinator's `~/.config/claude-cloud/env` (mode 600) holds the real Instabox key, the Claude setup-token and every `*_API_KEY` provider key from your laptop config. Workers started from the coordinator need them.
- The values are written with a file upload, never in a command line.
- The coordinator's system prompt tells it never to print, share, commit or send these keys, and never to pass them to workers except through `claude-cloud`.
- GitHub access uses the `GH_TOKEN` Instabox secret, as on your laptop.
- Anyone who can SSH into the coordinator can read these keys. Use keys you can revoke.

### 8.4 Cleanup

Your laptop's cleanup process deletes only machines whose `owner` label is that session's id (`src/reaper.mjs` checks `metadata.owner === owner`). Coordinators have no `owner` label, so it never deletes them. Delete one with `coordinator stop NAME`, or list leftovers with `npx --yes instabox@latest ls --meta role=coordinator`.

### 8.5 Delete deadlines and `finish`

Every machine this tool creates has a delete deadline set when it is created (`deleteAfterSeconds`, shown by Instabox as `deleteAt`). Instabox deletes the machine at that time in any state, even if every `claude-cloud` process has died, so orphaned machines cannot pile up. The deadline cannot be changed after create (`PATCH /v1/machines/{id}` has no field for it).

| Machine | Deadline |
| --- | --- |
| Worker and nested coordinator | `CLAUDE_CLOUD_WORKER_HOURS`, default 6, at most 24 |
| Cloud coordinator | `coordinator start --max-hours N`, default 24, at most 24 (Instabox allows at most 86400 s); a larger value is refused |
| Image machine | 2 hours |

The agent is told its deadline ("Your machine is deleted by the server at <time>; push your work well before then."). `coordinator ls` and `cloud_agent_list` show it. A work package that must outlive 24 hours needs a new coordinator from a pushed branch.

The coordinator ends its job with `~/claude-cloud/bin/claude-cloud coordinator finish`. It deletes the machine only when all of these hold, and prints what it verified:

- it runs on a machine named `instabox-<name>` whose Instabox record has `role=coordinator`;
- `git status --porcelain` in `~/repo` is empty;
- the current branch and every local `fleet/*` branch have no commits beyond their upstream;
- no machine owned by this coordinator's `claude-cloud` server is still running (stop workers with `cloud_agent_stop` first; the server records its owner id in `~/.config/claude-cloud/owner`).

`--force` skips the git and worker checks, not the machine check.
