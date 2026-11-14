# Cloudy Cloud runbook

This covers setting up `cloudy-cloud`, using it, operating it day to day, and fixing common problems.

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
git clone https://github.com/dennisonbertram/cloudycloud.git
cd cloudycloud
./install.sh
```

Run it in a terminal; it asks for keys, so it will not run from a pipe. It checks `git`, Node.js 20 or later, `npm`, `curl` and Claude Code, runs `npm install`, and links `cloudy-cloud` onto your PATH. If `cloudy-cloud` already points at another folder, it asks before changing that, and the default is to keep the current link. Then it asks for three keys. Nothing shows as you paste, and nothing is printed back except the last four characters.

| Key | Where to get it |
| --- | --- |
| **Instabox API key** (`ibk_…`) | Create it at https://dashboard.instabox.sh/dashboard/api-keys. The script checks it with Instabox before saving. |
| **Claude token** (`sk-ant-oat01-…`) | In another terminal run `claude setup-token`. Your own `claude` login is not changed. |
| **GitHub token** | Create a fine-grained token (section 2.3). The Instabox command-line tool asks for it, so `install.sh` never sees it. |

The first two are saved to `~/.config/cloudy-cloud/env`, which only your user account can read. The GitHub token is stored in Instabox as the secret `GH_TOKEN`. After the first install, run `cloudy-cloud setup` at any time (it runs `install.sh` from the folder `cloudy-cloud` was linked from, whatever folder you are in); it shows each saved key as masked and asks before replacing it.

`cloudy-cloud` runs from the folder you ran `install.sh` in, on whatever branch is checked out there. The final message of `install.sh` shows the folder and branch.

### 2.2 Providers

Set `CLOUDY_CLOUD_PROVIDER` to choose the sandbox provider: `instabox` (the default) or `self-hosted` (Docker or Podman containers on a machine you own, reached over SSH). `cloudy-cloud setup --provider instabox|self-hosted` saves the choice and the settings that provider needs. A provider must enforce a server-side delete deadline, support snapshots for coordinators, and forward ports for `cloudy-cloud open`.

- **Instabox** keeps the GitHub token behind proxy secrets, so a machine only sees a placeholder. It needs `INSTABOX_API_KEY`.
- **Self-hosted** has no proxy secrets. You consent once, during setup, to storing the GitHub token on your own machine (`CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes`); it lives only in memory (a tmpfs file) while an agent runs. That consent covers `GH_TOKEN` only. An MCP server whose token is a `${MCP_X_TOKEN}` reference or a literal value is delivered only if its entry in `mcp.json` has `"cloudyCloudAllowLiteral": true` (or you added it with `cloudy-cloud mcp add NAME --allow-literal`); otherwise it is skipped and the reply says why. It needs `CLOUDY_CLOUD_SSH_HOST`, not an Instabox key. Coordinators are allowed only after a second consent in setup (`CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes`, see section 9); without it they are refused and the reply says to run setup. Run `cloudy-cloud doctor` to check the machine.

See the [sandbox provider research](research/sandbox-providers.md) for other options.

### 2.3 The GitHub token

Subagents push their work to GitHub. Instabox stores the token and adds it only to requests to GitHub, so a subagent's machine sees a placeholder, never the token.

- Create it at https://github.com/settings/personal-access-tokens/new.
- **Repository access:** *Only select repositories*. Choose only the repos you will use `cloudy-cloud` in.
- **Permissions:** *Contents*, read and write. *Metadata*, read-only, is added automatically.
- **Expiration:** your choice. Shorter limits the damage if it leaks.
- `install.sh` runs `npx --yes instabox@latest login` if you are not signed in, then `npx --yes instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com`, and the Instabox tool asks for the token. The name must be exactly `GH_TOKEN`.

### 2.4 Protect your main branch

In the repo on GitHub, open *Settings → Rules → Rulesets* and add a branch ruleset that blocks direct pushes to your main branch. Subagents run with permission checks off, and the token can push to any branch it reaches.

### 2.4 First run

The repo you work in needs a GitHub `origin` that your token can push to:

```sh
cd <your repo>
git remote -v        # should show github.com
cloudy-cloud
```

Setup happens only in `install.sh`. If a key is missing, `cloudy-cloud` prints `cloudy-cloud is not set up yet (...). Run: cloudy-cloud setup`. In a terminal it also asks `Run setup now? [Y/n]` and continues into the session after setup; without a terminal it exits 1.

### 2.5 MCP servers for subagents (optional)

By default a subagent has no MCP servers. To give it some, copy them from your Claude Code settings, one at a time:

1. Run `cloudy-cloud mcp add <name>`. It looks for `<name>` in your Claude Code local scope, the repo's `.mcp.json`, then your user scope (`~/.claude.json`), shows what it found, and saves the server to `~/.config/cloudy-cloud/mcp.json` (mode 600). Change the path with `CLOUDY_CLOUD_MCP`.
2. If the server sends a token, the command prints a line like this. Run it once, with the real token in `$TOKEN`:

   ```sh
   printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host mcp.notion.com
   ```

   You must be signed in with `npx --yes instabox@latest login`. The Instabox API key in your cloudy-cloud config fails here with `missing_scope: workspace:admin`. Always keep `--host`: without it, Instabox would add the token to a request to any host.
3. Start subagents as usual. The reply ends with `MCP servers: notion`, or `MCP servers: notion, context7 (failed: linear)` when a server did not connect. For `pi` and `omp` workers the line is `MCP servers: a, b`, the servers delivered; it does not confirm that they connected. `cloud_agent_list` and the dashboard also show the names.

Other commands: `cloudy-cloud mcp ls` lists what is saved and which secrets it needs, and `cloudy-cloud mcp rm <name>` removes a server (the Instabox secret stays; remove it with `npx --yes instabox@latest secrets rm MCP_<NAME>_TOKEN`). The file is read every time a subagent starts, so no restart is needed.

**What is accepted.** Remote `http` or `sse` servers with an `https` URL on a public host, and stdio servers whose command is exactly `npx` or `uvx` with no absolute path, `~` or `..` in the arguments. Anything else is refused with `Not added: <reason>`: other commands, OAuth sign-in, `headersHelper`, localhost and private addresses, plain `http`, and secret values in a URL or an argument. `pi` and `omp` workers get the same servers, with the file at `~/pi-agent/mcp.json` or `~/omp-agent/mcp.json` on the machine. `pi` has no SSE transport, so it skips `sse` servers and the reply says `MCP servers skipped: <name> (pi does not support the SSE transport)`.

**What reaches the machine.** The checked servers are written to `~/.config/cloudy-cloud/mcp.json` on the machine (mode 600) and Claude starts with `--mcp-config` for that file and `--strict-mcp-config`. A repo's own `.mcp.json` is therefore not loaded there once you have added a server. Tokens are written as `${MCP_<NAME>_TOKEN}` references. Instabox replaces the placeholder only in HTTPS request headers sent to the hosts you named. Coordinators get the same file.

**Real token on the machine.** `cloudy-cloud mcp add <name> --allow-literal` keeps the real `env` or header value in `mcp.json` and copies it to the machine of each subagent you start (a coordinator's own session gets it, its workers do not), after a warning and a `[y/N]` question in a terminal. Permission checks are off on the machine, so a prompt injection could leak that token. Use a token you can revoke. The reply then adds `MCP servers with a real token on the machine (you allowed it): <name>`.

## 3. Check that it works

In the `cloudy-cloud` session, type:

```
use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
```

**Expected:** the answer names a hostname starting with `instabox-sbx-`, and ends with `Pushed to origin cloudy-cloud/<id> at <sha>`. Then confirm the file reached GitHub:

```sh
git fetch origin cloudy-cloud/<id>
git show FETCH_HEAD:proof.txt
```

## 4. Daily use

- **Start:** run `cloudy-cloud` from inside the repo you want subagents to work on.
- **Ask for subagents in plain language.** The session decides when to use them.
  - "use 5 subagents in parallel to …"
  - "ask the second subagent to also …"
  - "list the subagents"
  - "stop all subagents"
- **Collect work** from GitHub. Each subagent has its own branch:

  ```sh
  git fetch origin 'refs/heads/cloudy-cloud/*:refs/remotes/origin/cloudy-cloud/*'
  git branch -r --list 'origin/cloudy-cloud/*'
  ```

  Merge, cherry-pick or open pull requests from these branches as usual.
- **Watch and stop subagents.** In a terminal session on Claude Code 2.1.304 or later, each subagent call is an MCP task:
  - The footer shows `N MCP tasks`.
  - `/tasks` shows one line per task, updated every few seconds: `12 tool uses · 48.2k tokens · 3m10s · Edit src/parser.ts`. `starting machine…` means the machine is not up yet. The tokens are input (including cached input) plus output.
  - Claude Code's task view says each task "runs on the server; survives exiting this session". That text does not apply to `cloudy-cloud`: when you exit the session, every subagent stops and its machine is deleted. Push or collect work before you exit.
  - Select a task and press `x` to stop it. For a task started by `cloud_agent` this stops the agent and deletes its machine. For a task started by `cloud_agent_message` it stops only that follow-up, and the agent stays open and idle.
  - The result reaches the session by itself when the task ends. It ends with a line such as `Total: 12 tool uses, 93.1k in / 327 out tokens, $0.0078, 3m10s` (the cost appears when Claude reports it).
  - Asking "list the subagents" shows the same progress line for each one.
- **Without tasks.** In the VS Code extension, the desktop app, or a one-shot `claude -p "<prompt>"` run, Claude Code does not make MCP tasks. The tools then return an agent ID and Claude uses `cloud_agent_wait`, exactly as in older versions. Nothing needs configuring. Task mode is not turned on or off with any setting of this tool, so do not set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` or `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`.
- **Large swarms.** Start as many as you need. Starts are paced and queued automatically (`CLOUDY_CLOUD_STARTS_PER_MIN`, default 25 a minute), and Instabox requests share `CLOUDY_CLOUD_MAX_INSTABOX_CALLS` slots (default 24). Queued subagents show the status `queued`. Set either variable in the environment, or as `NAME=value` in `~/.config/cloudy-cloud/env`, before you start `cloudy-cloud`.
- **When subagents stop:**
  - when you or the session stops them;
  - after 60 minutes with nothing to do;
  - when the session ends.

  Their machines are deleted at that point. Anything a subagent didn't push is lost with its machine.

## 5. Maintenance

| Task | Command or step |
| --- | --- |
| **List cloud machines** | `npx instabox@latest ls`. Machines created by this tool have the label `purpose=cloudy-cloud`. |
| **Delete a leftover machine** | `npx instabox@latest rm <name>` |
| **Delete all subagent branches on GitHub** | `git ls-remote --heads origin 'cloudy-cloud/*' \| awk '{print $2}' \| xargs -n 50 git push origin --delete` |
| **Replace a key** (Claude token, Instabox key or GitHub token) | Run `cloudy-cloud setup`, answer `y` for that key, then restart `cloudy-cloud`. A running session keeps the old key until you restart it. |
| **Remove all saved keys** | `rm ~/.config/cloudy-cloud/env` |
| **Update the tool** | `git pull && npm install` in the folder that `install.sh` printed, then restart `cloudy-cloud` |
| **Uninstall** | npm install: `npm uninstall -g cloudycloud`. Git clone: `npm unlink -g cloudycloud` (on a clone from before the rename, also `npm unlink -g cloudy-cloud`), then delete the folder. Then delete `~/.config/cloudy-cloud` and the two skills in `~/.claude/skills` (`cloud-fleet`, `cloudy-cloud-setup`) |

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `cloudy-cloud is not set up yet ... Run: cloudy-cloud setup` | A key is missing. Run `cloudy-cloud setup`. |
| `Got 103 of 108 characters, so it looks cut off` | The Claude token was cut short when pasted. Press Enter at the Claude step to let the installer get the token itself, or copy the whole token again; wrapping onto two lines is fine. |
| `Got N of 56 characters` or `starts like an Instabox key` | The Instabox key is incomplete or has a typo. The dashboard shows a key only once, so if it was lost, create a new one at https://dashboard.instabox.sh/dashboard/api-keys. |
| `Claude rejected this token` | The token is revoked or from another login. Run `cloudy-cloud setup` and press Enter at the Claude step. |
| `Stopped the ... step after 3 tries` | Nothing was changed. The saved key stays. Run `cloudy-cloud setup` to try again. |
| `malformed API key`, or `401` from Instabox in a session | The Instabox key is wrong or revoked. Run `cloudy-cloud setup`, replace the key, and restart `cloudy-cloud`. |
| You changed a key but the session still uses the old one | `cloudy-cloud` reads keys once at start. Restart it. |
| `cloudy-cloud needs the repo to have an origin remote on github.com` | Add one with `git remote add origin https://github.com/<owner>/<repo>.git`, and make sure your token includes that repo. |
| `The first push to origin cloudy-cloud/<id> failed` | The `GH_TOKEN` secret is missing, or the token can't write to this repo. Run `cloudy-cloud setup` and replace the GitHub token, and check the token's repository list. |
| `The Instabox secret MCP_<NAME>_TOKEN could not be attached` | The MCP token secret does not exist. Create it with `printf %s "$TOKEN" \| npx --yes instabox@latest secrets set MCP_<NAME>_TOKEN --host <host>`, signed in with `instabox login` (section 2.5). |
| `The GH_TOKEN Instabox secret could not be attached` | The secret doesn't exist or is named differently. Run `cloudy-cloud setup` and replace the GitHub token. The name must be exactly `GH_TOKEN`. |
| `Not logged in · Please run /login` or `401` from a subagent | No valid Claude token reached the machine. Run `claude setup-token`, then run `cloudy-cloud setup` and replace the Claude token, and restart `cloudy-cloud`. This also happens if you only have `ANTHROPIC_API_KEY` exported, because some wrappers, such as cmux's `claude`, remove it. |
| A subagent stays `queued` | Your Instabox plan's machine limit (`quota_exceeded`) is full, or starts are waiting for the pace limit. Paused machines count too. It retries every 60 seconds for up to 30 minutes, then fails with Instabox's message. Stop subagents you don't need, delete leftover machines (section 5), or upgrade the plan. |
| `rate_limited` after 5 tries | Instabox kept refusing starts. Lower `CLOUDY_CLOUD_STARTS_PER_MIN` (the default 25 is under the Pro plan's about 30 a minute) and restart `cloudy-cloud`. |
| A subagent's work is missing | Only pushed work survives. Check the result for `Push failed` or `Uncommitted changes left in the sandbox`. While the subagent is open, ask it to commit and push. |
| The session uses no subagents, or says `Agent` is unavailable | That's expected: `cloudy-cloud` turns off the built-in `Agent` and `Workflow` tools. Ask for "a subagent" and it uses `cloud_agent`. Plain `claude` still has the built-in tools. |
| A subagent can't use an agent type you defined | Only agents committed in the repo, or built into Claude Code, exist on the machine. Agents in `~/.claude/agents` aren't sent. |

## 7. How it works

1. **The launcher.** `bin/cloudy-cloud` starts Claude Code with three changes:
   - the built-in `Agent` and `Workflow` tools turned off;
   - an extra system prompt;
   - an MCP server, `src/server.mjs`, that provides the `cloud_agent_*` tools.
2. **Starting a subagent.** `cloud_agent` takes a snapshot of your repo's tracked files, including uncommitted edits, without touching your working tree. Then:
   - it creates an Instabox machine and attaches the `GH_TOKEN` secret;
   - it uploads the snapshot and checks it out on branch `cloudy-cloud/<id>`;
   - it pushes that branch, then runs `claude -p` in the background.

   The call returns at once, because Claude Code runs MCP tools one at a time unless they're marked read-only. When the client supports MCP tasks, the call returns a task (id `cc-<agent id>-t<turn number>`, for example `cc-3f2a91bc-t2`). The server detects this from the client capabilities that Claude Code sends with each request on MCP revision 2026-07-28, and the server answers `tasks/get` and `tasks/cancel` for the task.
3. **Getting answers.** In task mode, Claude Code polls `tasks/get` and passes on the result when the task ends. Otherwise `cloud_agent_wait`, which is read-only, collects answers. Follow-ups use `claude -p --resume <session>` on the same machine. The machine runs `claude -p --output-format stream-json --verbose`; the server reads that stream as it arrives to count tool uses and tokens and to find the current step.
4. **After every task.** The tool runs `git push` once more, in case the subagent forgot. It never commits for the subagent; it lists any uncommitted files instead.
5. **Secrets.**
   - **Instabox key and Claude token:** these stay in `~/.config/cloudy-cloud/env` and the MCP server. They never appear in process arguments.
   - **Claude token on the machine:** only the Claude token is placed on each machine.
   - **GitHub token:** it stays in Instabox. The machine sees only a placeholder, which Instabox's proxy replaces on requests to `github.com` and `api.github.com`.
   - **MCP tokens:** for servers added with `cloudy-cloud mcp add`, each token is an Instabox secret named `MCP_<NAME>_TOKEN`, attached in the same call as `GH_TOKEN`. The machine sees a placeholder that Instabox replaces in request headers to the host given with `--host`. With `--allow-literal` the real value is on the machine instead (not on a coordinator's workers).

## 8. Cloud coordinators

A coordinator is a long-lived Claude Code session on its own Instabox machine. It runs `cloudy-cloud` there, so it can start worker machines. You reach it through Remote Control (claude.ai or the Claude app) or SSH, and it keeps working while your laptop is closed.

### 8.1 Make the coordinator image (once)

Remote Control needs a full Claude login. A token from `claude setup-token` can only make model requests, so it cannot open Remote Control sessions. You sign in once on an image machine and keep the result in an Instabox snapshot.

1. `cloudy-cloud coordinator image` creates a machine labelled `role=coordinator-image`, installs `cloudy-cloud` on it, and prints an SSH command.
2. Run that SSH command, then `claude auth login` inside the machine, and finish the sign-in in your browser.
3. `cloudy-cloud coordinator image --save` snapshots the machine, saves the snapshot id as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT` in `~/.config/cloudy-cloud/env`, and deletes the image machine. A snapshot keeps the home folder, including the saved sign-in.

### 8.2 Commands

| Command | What it does |
| --- | --- |
| `cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO [--branch B] [--max-hours N]` | Creates a machine from the snapshot (label `role=coordinator`, never pauses), attaches the `GH_TOKEN` secret, writes the keys file, installs your laptop's exact `cloudy-cloud` there (sent as a git bundle, so it need not be pushed to GitHub), clones the repo, and starts a tmux session `claude` running `cloudy-cloud --remote-control "NAME"`. With `--task TEXT` or `--task-file PATH` (not empty, at most 100 KB) the task is uploaded to `~/task.md` on the machine and passed as the session's first prompt, so the coordinator starts working at once. `--max-hours N` sets the delete deadline (default and maximum 24; see 8.5). `--json` prints `{name, machine, remoteControlName, attach}` instead of the text. |
| `cloudy-cloud coordinator attach NAME` | Prints `npx --yes instabox@latest ssh <machine> -- tmux attach -t claude`. Run it to see the session. |
| `cloudy-cloud coordinator ls` | Lists coordinators: name, state, created time, machine name, and the time the server deletes the machine. |
| `cloudy-cloud coordinator stop NAME` | Deletes that coordinator's machine. Its workers are deleted by its own `cloudy-cloud` cleanup process when its session ends, or by their own delete deadline. |
| `cloudy-cloud coordinator finish [--force]` | Run on the coordinator machine, by the coordinator. Deletes that machine after checking that the work is on GitHub (see 8.5). It refuses to run on a laptop. |
| `cloudy-cloud open <agent-id-or-machine> <port> [--share]` | Reaches an app on an agent or coordinator machine. Default: private tunnel to `127.0.0.1:<port>` until Ctrl-C (`LOCAL:REMOTE` allowed). `--share` prints a private link (anyone with it can open the app); `--unshare` removes it. Start the app in the background on the machine (`nohup npm run dev > /tmp/dev.log 2>&1 &`); it ends when the machine is deleted. |

The first time you attach, accept any trust or Remote Control prompts. Then pick the session named NAME in claude.ai/code.

### 8.3 Keys on the coordinator

- The coordinator's `~/.config/cloudy-cloud/env` (mode 600) holds the real Instabox key, the Claude setup-token and the provider keys that profiles use (the built-in ones and any `keyName` in `profiles.json`). Other `*_API_KEY` variables in your shell stay on the laptop. Workers started from the coordinator need them.
- The values are written with a file upload, never in a command line.
- The coordinator's system prompt tells it never to print, share, commit or send these keys, and never to pass them to workers except through `cloudy-cloud`.
- GitHub access uses the `GH_TOKEN` Instabox secret, as on your laptop.
- Anyone who can SSH into the coordinator can read these keys. Use keys you can revoke.

### 8.4 Cleanup

Your laptop's cleanup process deletes only machines whose `owner` label is that session's id (`src/reaper.mjs` checks `metadata.owner === owner`). Coordinators have no `owner` label, so it never deletes them. Delete one with `coordinator stop NAME`, or list leftovers with `npx --yes instabox@latest ls --meta role=coordinator`.

### 8.5 Delete deadlines and `finish`

Every machine this tool creates has a delete deadline set when it is created (`deleteAfterSeconds`, shown by Instabox as `deleteAt`). Instabox deletes the machine at that time in any state, even if every `cloudy-cloud` process has died, so orphaned machines cannot pile up. The deadline cannot be changed after create (`PATCH /v1/machines/{id}` has no field for it).

| Machine | Deadline |
| --- | --- |
| Worker and nested coordinator | `CLOUDY_CLOUD_WORKER_HOURS`, default 6, at most 24 |
| Cloud coordinator | `coordinator start --max-hours N`, default 24, at most 24 (Instabox allows at most 86400 s); a larger value is refused |
| Image machine | 2 hours |

The agent is told its deadline ("Your machine is deleted by the server at <time>; push your work well before then."). `coordinator ls` and `cloud_agent_list` show it. A work package that must outlive 24 hours needs a new coordinator from a pushed branch.

The coordinator ends its job with `~/cloudy-cloud/bin/cloudy-cloud coordinator finish`. It deletes the machine only when all of these hold, and prints what it verified:

- it runs on a machine named `instabox-<name>` whose Instabox record has `role=coordinator`;
- `git status --porcelain` in `~/repo` is empty;
- the current branch and every local `fleet/*` branch have no commits beyond their upstream;
- no machine owned by this coordinator's `cloudy-cloud` server is still running (stop workers with `cloud_agent_stop` first; the server records its owner id in `~/.config/cloudy-cloud/owner`).

`--force` skips the git and worker checks, not the machine check.

## 9. Your own machine

Subagents can run on a computer you own instead of Instabox. Each one gets a Docker container on that machine, reached over SSH. This section describes what the code does. The first live run on a Mac Studio is still to come (see [STATUS.md](STATUS.md)).

### Prerequisites

On a Mac:

- Turn on **Remote Login** (System Settings > General > Sharing). Put your public key in `~/.ssh/authorized_keys` on the Mac. Cloudy Cloud runs `ssh` with `BatchMode=yes`, so it cannot answer a password prompt. Test with `ssh user@host true`.
- Install **Tailscale** on the Mac and on your computer, and use the Mac's Tailscale name or `100.x` address. Tailscale's own SSH server runs on Linux only, so on a Mac use Remote Login with a key.
- Install **OrbStack or Docker Desktop** and open it once so the engine runs. Setup saves the absolute path of `docker` (`CLOUDY_CLOUD_CONTAINER_BIN`), because non-interactive SSH on a Mac has no `/opt/homebrew/bin` on its `PATH`.
- Stop the Mac from sleeping, or every subagent on it stops. In System Settings > Battery (or Energy) turn on "Prevent automatic sleeping when the display is off", or run `sudo pmset -a sleep 0`. Doctor warns when `pmset -g` shows a sleep time.

On Linux: install Docker (or Podman). Use an SSH key, or Tailscale SSH (`sudo tailscale up --ssh`) and no key.

Keep about 20 GB of disk free. Setup and doctor warn below that.

### Run setup

```sh
cloudy-cloud setup --provider self-hosted
```

Without `--provider`, `install.sh` asks "Where should subagents run?"; type 2. Setup asks for:

1. The SSH address, `user@host`.
2. The path to your SSH key (optional; Enter uses your default keys or Tailscale SSH).
3. How many subagents may run at once. The suggestion is half the CPUs or one per 4 GB of memory, whichever is lower, at least 1. On a Mac it uses the lower of the Mac's and the container VM's CPU and memory.
4. Whether to allow the GitHub token on the machine (default no), then the token itself, typed without echo.

It checks SSH, sleep (Mac), the container runtime and disk, builds `cloudy-cloud-worker:<version>` on the machine, and writes `CLOUDY_CLOUD_PROVIDER`, `CLOUDY_CLOUD_SSH_HOST`, `CLOUDY_CLOUD_SSH_KEY`, `CLOUDY_CLOUD_CONTAINER_RUNTIME`, `CLOUDY_CLOUD_CONTAINER_BIN`, the slot, CPU and memory settings, and the token settings to `~/.config/cloudy-cloud/env`. Run it again after updating Cloudy Cloud: the image version must match, or the next subagent fails with "Run: cloudy-cloud setup". The step that asks for a GitHub token on Instabox is skipped; setup still asks for the Claude token and optional model keys.

### Doctor

```sh
cloudy-cloud doctor
```

Prints `ok`, `warn` or `fail` lines, each problem with a `fix:` line, and exits 1 on any fail. It checks SSH (and warns if the answer took over 5 seconds, which can mean Tailscale check mode wants you to sign in again; give the machine an `accept` rule or a longer `checkPeriod`), sleep on a Mac, the container runtime and its path, free disk, the worker image and its version, whether your slot count exceeds the suggestion, running Cloudy Cloud containers (stale ones past their deadline get a removal command), and the saved settings. With another provider it only says so.

### The GitHub token

Instabox keeps the token off its machines behind a proxy. Your own machine has no such proxy, so the token must be inside the worker. Setup asks once. If you say yes, it saves `GH_TOKEN` and `CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes` in the env file (mode 600). For each worker the token goes over SSH stdin into `/run/secrets/env`, a memory-only file (mode 600) in the container, never into a command line, label or `docker inspect`, and it is removed with the container. Each `cloud_agent` reply says `GitHub token: on your machine <host> (you allowed it)`. If you say no, workers refuse to start. A subagent can read the token while it runs and push to any branch it reaches, so use a fine-grained token for the repos you choose and protect your main branch.

### Slots and sizing

`CLOUDY_CLOUD_SELF_HOSTED_SLOTS` is how many containers may run at once. Another start waits as `queued`. Each container gets `CLOUDY_CLOUD_SELF_HOSTED_CPUS` (whole CPUs, at least 1) and `CLOUDY_CLOUD_SELF_HOSTED_MEMORY` (80% of memory divided by the slots), plus a limit of 2048 processes. On a Mac the container VM's own limit (Docker Desktop or OrbStack settings) applies; if you change it, run setup again.

### Cleanup

Each container's main process is `timeout <seconds> sleep infinity` and it runs with `--rm`, so it ends at its deadline (at most 24 hours) with no help from your computer. The reaper also deletes a session's containers when the session ends. By hand:

```sh
ssh user@host /absolute/path/to/docker ps -a --filter label=cloudy-cloud.purpose
ssh user@host /absolute/path/to/docker rm -f cc-<id>
```

What containers do after a reboot of the machine is not checked; doctor lists leftovers.

### Limits

- One machine per setup.
- Coordinators use Docker images instead of Instabox snapshots (`hasSnapshots` is true). `cloudy-cloud coordinator image` creates the image container; you sign in with `claude auth login` as in 8.1. `coordinator image --save` then runs `docker commit --pause=true` on that container, which makes the image `cloudy-cloud-coordinator:<name>` on the machine, saves that name as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT`, and removes the image container. The image keeps the Claude login in the home folder. It never contains `/run/secrets`, because that folder is a tmpfs mount and `docker commit` skips it, so the GitHub token and other keys are not saved. `coordinator start NAME` creates a container from the image and gives it its keys at start. The adapter can list and remove these images (`docker image ls --filter 'reference=cloudy-cloud-coordinator:*'`, `docker rmi cloudy-cloud-coordinator:<name>` on the machine), but `cloudy-cloud` has no command for it yet. Not yet proven live on a real Mac Studio.

  **Coordinators start workers through Docker, with no SSH key on the coordinator.** Setup asks once: "Coordinators on <host> can start containers through Docker, which gives them full control of Docker on that machine. Allow? [y/N]". Yes saves `CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes` and `CLOUDY_CLOUD_DOCKER_SOCKET` (the socket path on the machine; `/var/run/docker.sock` on a Mac, because that is the path inside the Docker Desktop or OrbStack VM). Only a coordinator container gets `-v <socket>:/var/run/docker.sock` and the socket's group (`--group-add`); workers never do. The worker image carries the docker CLI (rebuild it with setup after upgrading). Inside the coordinator, `CLOUDY_CLOUD_SELF_HOSTED_LOCAL=1` makes the adapter run the same docker commands locally with `sh -c`, so its workers are siblings on the same Docker. The slot count still sees every `cloudy-cloud.purpose` container, whoever started it. The coordinator's `~/.config/cloudy-cloud/env` holds these names: `CLOUDY_CLOUD_PROVIDER`, `CLOUDY_CLOUD_SELF_HOSTED_LOCAL`, `CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS`, `CLOUDY_CLOUD_DOCKER_SOCKET`, `CLOUDY_CLOUD_CONTAINER_RUNTIME`, `CLOUDY_CLOUD_CONTAINER_BIN`, `CLOUDY_CLOUD_SELF_HOSTED_SLOTS`, `CLOUDY_CLOUD_SELF_HOSTED_CPUS`, `CLOUDY_CLOUD_SELF_HOSTED_MEMORY`, the Claude credential, provider `*_API_KEY` values, the depth settings, and (only if you allowed the token) `CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX` and `GH_TOKEN`. It never holds `CLOUDY_CLOUD_SSH_HOST`, `CLOUDY_CLOUD_SSH_KEY` or `CLOUDY_CLOUD_SSH_PORT`. The risk you accept: a coordinator, and anything it runs, can control every container on that machine. Docker only; Podman is not supported for coordinators.
- `cloudy-cloud open <agent> <port>` works through an SSH bridge. `--share` is refused.
- Docker is the path to use. Podman is accepted; rootless Podman may ignore CPU and memory limits.
- The container can reach whatever the machine can reach on your network.

### Docker Desktop: image build fails over SSH

Docker Desktop can keep registry logins in the macOS keychain (`credsStore` in `~/.docker/config.json`). A build started over SSH cannot unlock it, and pulling `node:22-bookworm-slim` can fail with a credentials error. Either run `docker pull node:22-bookworm-slim` in a Terminal on the Mac and run setup again, or use OrbStack. This is a known Docker Desktop behavior and is not yet checked on the Mac Studio.

