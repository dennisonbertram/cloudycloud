# Command and tool reference

> Every cloudy-cloud command, MCP tool, option and environment variable.

Source: https://cloudycloud.tech/docs/reference.html

This page lists Cloudy Cloud's commands, MCP tools, environment variables and local files.

The built-in host commands cover Claude Code (`cloudy-cloud`), Codex (`cloudy-cloud codex`), opencode (`cloudy-cloud opencode`), pi (`cloudy-cloud pi`) and free-pi (`cloudy-cloud free-pi`). Other MCP clients can connect through `cloudy-cloud mcp-server --repo PATH`. The `cloud_agent` `profile` argument picks the worker agent: Claude Code, pi, oh-my-pi, Codex or opencode. Live verification differs by client and worker; see [the status table](https://cloudycloud.tech/docs/models.html#verified).

## Command line

These commands run on your computer. `cloudy-cloud` checks the first argument. If it is `help`, `codex`, `opencode`, `pi`, `free-pi`, `dashboard`, `open`, `shell`, `display`, `coordinator`, `cloud`, `setup`, `--setup`, `doctor`, `protect`, `machines`, `branches` or `mcp-server`, it runs that command. `mcp ls`, `mcp add NAME`, `mcp add NAME --allow-literal`, `mcp rm NAME` and bare `mcp` (which prints that command's usage) run cloudy-cloud mcp; any other `mcp` arguments go to Claude Code. Any other arguments start a Claude Code session. One bare word that is not a command and not a Claude Code subcommand (for example `cloudy-cloud ls`) is treated as a typo and fails with "is not a command", exit status 2.

### cloudy-cloud (Claude Code as the main session)

```
cloudy-cloud [claude arguments]
```

The package installs the same command under two names, `cloudy-cloud` and `cloudycloud`; use either. Without a global install, `npx cloudycloud` runs the same command. Plain `claude` is not affected.

Starts a normal Claude Code session in the current folder. In that session the built-in `Agent` and `Workflow` tools are denied, and Claude starts subagents with the cloud tools described below. Run it from inside a git repository that has a `github.com` origin, because each cloud agent pushes its work to a branch there.

Every argument is passed to `claude` after the flags that `cloudy-cloud` adds itself (`--mcp-config`, `--settings` and `--append-system-prompt`). There are no `cloudy-cloud` flags of its own for a session.

Before it starts Claude, the command checks three things:

- It needs an Instabox API key (from the environment or the config file) and a Claude token or Anthropic API key in the config file. If one is missing, it tells you. In a terminal it offers to run `cloudy-cloud setup` now. Outside a terminal it exits with status 1.
- If the folder is not a git repository, it prints a warning that subagents cannot start.
- If the repository has no `github.com` origin, it prints a warning that subagents cannot push their work.

Example:

```
cloudy-cloud --model opus
```

It also sets `MCP_TOOL_TIMEOUT` to 1800000 (30 minutes) unless you already set it.

### cloudy-cloud codex, opencode, pi and free-pi

```
cloudy-cloud codex [codex arguments]
cloudy-cloud opencode [opencode arguments]
cloudy-cloud pi [pi arguments]
cloudy-cloud free-pi [free-pi-cli arguments]
```

Each command starts another coding agent as your main session, with the same cloud tools. Every argument after the subcommand goes to that agent. They are subcommands, not a flag, because Claude Code already has its own `--agent` option. None of them needs a Claude token to start, and setup does not ask for one unless you choose claude. They check only that the Instabox key (or the self-hosted settings) is saved, and run from inside a git repository with a `github.com` origin like `cloudy-cloud`. Workers run Claude Code unless `cloud_agent` gets a `profile`, so when no Claude token is saved, the command prints the profile to pass (for example `codex`) and tells the agent to pass it. To install an agent first, use the command in the third column.

| Command | How the tools are added | If the agent is missing | Checked live |
|---|---|---|---|
| `cloudy-cloud codex` | Codex `-c mcp_servers.cloud.*` overrides and `developer_instructions`. `~/.codex/config.toml` is not edited. The tools keep their names. | Prints `npm install -g @openai/codex`. Then sign in with `codex login`. | Yes. With codex-cli 0.166.0, `cloudy-cloud codex exec` listed the six cloud tools. |
| `cloudy-cloud opencode` | One `OPENCODE_CONFIG_CONTENT` value for this session. Your `opencode.json` is not edited. opencode's own `task` tool is denied. The tools are named `cloud_cloud_agent` and so on. | Prints `npm install -g opencode-ai`. Then sign in the way you normally do. | Yes, by the opencode build. |
| `cloudy-cloud pi` | A per-session pi extension that registers `node src/server.mjs` as an MCP server over stdio (the handlers do not run inside pi), and an appended system prompt. | Runs the pinned `@earendil-works/pi-coding-agent@1.5.0` with `npx`. To install it yourself: `npm install -g @earendil-works/pi-coding-agent`. | The MCP connection only. No model turn was run. |
| `cloudy-cloud free-pi` | Writes a `cloudy-cloud` entry (a stdio server, `node src/server.mjs`, with a 1,800 s timeout) into `~/.free-pi/agent/mcp.json` on every start. Your own `cloud` entry is not touched. A `cloudy-cloud` entry that cloudy-cloud did not write is not replaced: remove it with `free-pi-cli mcp remove cloudy-cloud`. | Runs the pinned `free-pi-cli@0.6.23` with `npx`. To install it yourself: `npm install -g free-pi-cli`. | `mcp list` only. |

The Codex, opencode and pi hosts cannot receive MCP task results, so the session starts agents and then calls `cloud_agent_wait`. free-pi is a main session only. It cannot be a worker.

### cloudy-cloud --help and --version

```
cloudy-cloud --help
cloudy-cloud --version
```

`--help` (also `-h` or `help`, when it is the only argument) prints Cloudy Cloud's own commands, then points to `claude --help` for Claude Code's options. `cloudy-cloud help <command>` and `cloudy-cloud <command> --help` print one command's help without running it. The host commands are the exception: `help codex` (or `opencode`, `pi`, `free-pi`) prints a short note, while `codex --help` starts the host launcher and passes `--help` to the agent. `--version` prints the Cloudy Cloud version. With any other arguments, everything goes to Claude Code, for example `cloudy-cloud -p "<prompt>" --allowedTools "Bash(git fetch *)"`; see [Run without the interactive UI](https://cloudycloud.tech/docs/#no-interactive-ui).

### cloudy-cloud setup

```
cloudy-cloud setup [--more] [--check-only] [--provider instabox|boat|e2b|self-hosted|microsandbox] [--default-profile NAME]
```

Runs the bundled `install.sh`, whatever folder you are in. `cloudy-cloud --setup` does the same, and `npx -y cloudycloud setup` runs it without installing anything first (`-y` skips npm's "Ok to proceed?" question). Setup checks your tools, offers to install the `cloudy-cloud` command (`npm install -g cloudycloud`, or a link when you run it from a git clone), copies the Cloudy Cloud skills into `~/.claude/skills`, uses the saved agent list or the agents it finds on your PATH (a fresh install picks `claude` alone when it is found; it asks which agents you run only when it finds none, and `--more` asks anyway), and asks for your Instabox key and your GitHub token, plus a Claude token only if you chose claude or want Claude workers and an OpenAI key for codex workers (`--more` offers it when codex is chosen or installed; plain setup offers it when codex is chosen and no saved credential could start a first worker — a saved Codex login file counts as one, even one a worker would later reject). Plain setup asks for the other model keys only in that same no-credential case; `--more` adds those steps and the cloud coordinators. Setup exits with status 1 when it ends without any worker credential. If an older `cloudy-cloud` global command blocks the install, setup offers to replace it (`npm rm -g cloudy-cloud`, then `npm install -g cloudycloud`). Run it again to change a key. It needs a terminal because it asks for keys. See [Getting started](https://cloudycloud.tech/docs/).

| Flag | Meaning |
|---|---|
| `--more` | Add the optional steps: cloud coordinators, Instabox usage alert emails and the other model keys (`PARTICLE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`). |
| `--provider instabox\|boat\|e2b\|self-hosted\|microsandbox` | Choose the provider to configure. Feature support and credential handling vary by provider; see the provider guides. Any other value is refused. |
| `--default-profile NAME` | Save the worker profile to use when a request or `cloudy-cloud run` does not name one. Claude Code remains the default unless a profile is selected. |
| `--check-only` | Check the tools, the saved keys and the Instabox usage alert emails (on microsandbox: the `msb` binary, the worker image, the local keys and `CLOUDY_CLOUD_EGRESS_ALLOW` — an empty exported value with none saved in the env file is reported as unset, even though a worker rejects it), then exit. Does not need a terminal and changes nothing. |

Example:

```
cloudy-cloud setup --check-only
```

### cloudy-cloud doctor

```
cloudy-cloud doctor
```

Checks the machine that subagents run on when `CLOUDY_CLOUD_PROVIDER` is `self-hosted`: SSH, sleep settings on a Mac, the container runtime, disk, the worker image, slots, leftover containers and saved settings. Prints `ok`, `warn` or `fail` per check with a fix, and exits 1 if any check fails. With another provider it prints a one-line note. See [Run on your own machine](https://cloudycloud.tech/docs/self-hosted.html#doctor).

### cloudy-cloud dashboard

```
cloudy-cloud dashboard [--demo] [--port N] [--no-open]
cloudy-cloud dashboard --prune
```

Starts a read-only web page on `127.0.0.1` that shows your cloud agents, coordinators and the messages between your session and them. It prints a link that contains a random token for this run, and opens it in your browser. Press Ctrl+C to stop it. See [Dashboard and app previews](https://cloudycloud.tech/docs/dashboard.html).

| Flag | Meaning |
|---|---|
| `--demo` | Show sample data instead of your machines. Nothing in it is real. |
| `--port N` | Listen on port N, from 0 to 65535. The default is 4477. If that port is in use, the dashboard uses a free port instead. Port 0 always picks a free port. |
| `--no-open` | Only print the link. Do not open a browser. |
| `--prune` | Delete every file under the streams folder (`CLOUDY_CLOUD_STREAMS`) that is older than 30 days, then the oldest until the folder is under 1 GB, and exit. Every file in that folder counts, not only stream files. The same pruning runs once when each agent's first turn starts. |

Example:

```
cloudy-cloud dashboard --port 5000 --no-open
```

### cloudy-cloud branches

```
cloudy-cloud branches prune [--yes] [--dry-run]
```

Run it inside your repository. It lists the `cloudy-cloud/<8 hex characters>` branches on origin (and `cloudy-cloud/issue-<n>-<id>` branches, for workers started from an issue) and compares each with origin's default branch. A branch that adds no commits to the default branch (it is empty, or already merged) is marked `prune`. A branch with commits not in the default branch is marked `keep`. It never touches a branch with another name.

It is a dry run: nothing is deleted unless you pass `--yes`. `--dry-run` forces a dry run even with `--yes`.

```
cloudy-cloud branches prune
cloudy-cloud branches prune --yes
```

### cloudy-cloud open

```
cloudy-cloud open <agent-id-or-machine> <port> [--share]
cloudy-cloud open <agent-id-or-machine> <port> --unshare
```

Reaches an app, such as a dev server, that runs on a cloud machine. The first argument is an agent id, a machine name or a machine id. Use `provider:id` or `provider:name` (for example `boat:abc123`) when selecting a machine across configured providers. A bare id or name is accepted only when it identifies one listed machine; ambiguous targets are refused. The machine must be running.

With no flag, it opens a private tunnel from `http://127.0.0.1:<port>` on your computer to that port on the machine. It runs until you press Ctrl-C. Start the app in the background on the machine (for example `nohup npm run dev > /tmp/dev.log 2>&1 &`), because the foreground processes of a turn end with the turn. The tunnel and any shared link stop when the machine is deleted.

| Argument or flag | Meaning |
|---|---|
| `<port>` | A port from 1 to 65535 on the machine. Write `LOCAL:REMOTE` to use a different port on your computer (not allowed with `--share` or `--unshare`). |
| `--share` | Publish a private link, with a token in the URL, instead of a tunnel. Anyone who has the link can open the app until the machine is deleted or you unshare it. It never publishes publicly. |
| `--unshare` | Remove the link for that port. Cannot be combined with `--share`. |

Example:

```
cloudy-cloud open 3f9a1c2e 5173
```

### cloudy-cloud shell

```
cloudy-cloud shell <agent-id-or-machine> [-- command [args...]]
```

Opens an interactive login shell on a cloud machine. With `-- command` it runs that command, streams its output and exits with the command's exit code. Each argument after `--` reaches the machine unchanged. Do not put secrets in the command. The first argument works as in open, and the machine must be running. Without a command it needs a terminal.

```
cloudy-cloud shell 3f9a1c2e -- uname -a
```

### cloudy-cloud display

```
cloudy-cloud display <agent-id-or-machine> [--control] [--ttl SECONDS]
cloudy-cloud display <agent-id-or-machine> --screenshot FILE
cloudy-cloud display <agent-id-or-machine> --unshare
```

Prints a link to the desktop of a `linux`, `android`, `gpu` or `macos` machine (`macos` is not verified). The machine argument accepts an agent id, machine name or machine id; use `provider:id` or `provider:name` to identify a machine across providers. Bare ids and names must be unambiguous. Only the link goes to standard output. Anyone with the link can see the screen, so do not paste it into a PR, an issue or a report. An `omarchy` machine has no display. The first desktop start on a `gpu` machine takes about 2 minutes.

| Flag | Meaning |
|---|---|
| (none) | A view-only link. It stops taking new viewers after 1 hour; a viewer already connected can stay. |
| `--control` | The viewer can click and type. |
| `--ttl SECONDS` | Seconds until the link stops taking new viewers, 60 to 86400. Not combined with `--screenshot` or `--unshare`. |
| `--screenshot FILE` | Write a PNG of the screen to a new file (an existing file or symlink is refused) and print the path. |
| `--unshare` | Revoke every display link for the machine, including viewers already connected. |

### cloudy-cloud machines

```
cloudy-cloud machines [ls]
cloudy-cloud machines stop <id-or-name>
cloudy-cloud machines stop --all [--yes]
```

Lists Cloudy Cloud machines from the configured providers and can delete one or all of them. On microsandbox, listing also removes expired microVMs as a side effect. In a terminal it prints NAME, PROVIDER, ROLE, STATE, AGE and DELETES; when piped it prints those fields plus STARTED and ID as tab-separated values. Provider listing errors are reported while results from providers that did respond are still shown. It prints `No Cloudy Cloud machines running.` when none are found.

| Argument or flag | Meaning |
|---|---|
| `ls` | List the machines (the default). |
| `stop <id-or-name>` | Delete one machine at once, without asking. Use `provider:id` or `provider:name` to target a machine when IDs or names overlap across providers (for example `boat:abc123`). Bare IDs or names work only when unambiguous. The command rechecks the selected provider and machine before deletion. |
| `stop --all` | Delete every machine in the list. It asks once on a terminal. |
| `--yes` | Say yes to that question; needed to delete without a terminal. |

### cloudy-cloud protect

```
cloudy-cloud protect [owner/repo] [--yes]
```

Creates a GitHub ruleset named "cloudy-cloud: protect the default branch" on the default branch: changes need a pull request (zero approvals required), force pushes and branch deletion are refused, and the ruleset has no bypass actors — nobody it covers can push around it, including you and the cloud agents, which push as you. A repo admin can still edit or disable the ruleset in the repo settings. If an equivalent ruleset or classic branch protection already covers the branch, the command says so and changes nothing. It uses your own `gh` sign-in and you must be a repo admin. Without `owner/repo` it uses the repo of the current folder. It asks for confirmation first and changes nothing without a yes. On a private repo whose GitHub plan has no rulesets it explains the options (upgrade, make the repo public, or classic branch protection).

| Argument or flag | Meaning |
|---|---|
| `owner/repo` | The repo to protect. Default: the repo of the current folder. |
| `--yes` | Do not ask first; you are saying yes to the change shown. |

### cloudy-cloud coordinator

```
cloudy-cloud coordinator image [--forget]
cloudy-cloud coordinator start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--env FILE]... [--account LABEL] [--json]
cloudy-cloud coordinator login NAME [--code CODE] [--account LABEL]
cloudy-cloud coordinator attach NAME
cloudy-cloud coordinator ls
cloudy-cloud coordinator status NAME [--json]
cloudy-cloud coordinator stop NAME
cloudy-cloud coordinator finish [--force]
```

Manages cloud coordinators: long-lived Claude Code sessions that run on their own Instabox machines and start workers there. All subcommands except `finish` need your Instabox key. With any other first argument, or none, the command prints this usage line. See [Coordinators and fleets](https://cloudycloud.tech/docs/fleets.html) for when to use them.

#### coordinator image

Optional and normally unnecessary: coordinators start from the base template when no image is saved. The command builds a saved image in one run (about 20 minutes). It creates an image machine (or reuses one you already started), installs cloudy-cloud on it, removes `~/.claude/.credentials.json` on the machine — the image never holds a Claude sign-in, because each coordinator signs in for itself when it starts — then saves a snapshot, stores its id as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT` in the config file, and deletes the image machine. It is safe to interrupt: run it again and it resumes the pending snapshot without starting a second one. The server deletes an unsaved image machine after 2 hours. Only one image machine can exist at a time.

| Flag | Meaning |
|---|---|
| `--save` | Alias for plain `coordinator image`, kept for old scripts. |
| `--forget` | Remove the saved image setting from the config file. The snapshot is not deleted; delete it with `npx instabox snapshot rm ID`. `start` ignores an image that holds a sign-in and says so. |

#### coordinator start

Starts a coordinator named NAME on a new machine from the saved clean image, or from the base template when none is saved. It sends this copy of cloudy-cloud (the checkout — a bundle of its committed state plus tracked uncommitted edits, leaving out files named like credentials, untracked files and staged additions — or the npm package's files), writes the coordinator's key file (mode 600), clones your repository to `~/repo`, and starts Claude Code in a `tmux` session called `claude` through a launcher (`~/.config/cloudy-cloud/launch.sh`) that runs `claude auth login` while the coordinator is not signed in, then execs the session with Remote Control under the name NAME. A fresh coordinator waits at the sign-in until you finish it with `coordinator login NAME` — waiting for sign-in is a normal state and the machine is never deleted for it; on a terminal `start` attaches you to that pane so you sign in there. The coordinator never pauses. The server deletes its machine after `--max-hours`. Once signed in you can reach it from claude.ai/code or the Claude app (pick the session named NAME) or from a terminal with `coordinator attach`. The coordinator's Claude runs with permission checks off, like a worker, and the machine is set up so the bypass-mode confirmation and the folder-trust dialog never appear. If one still waits on a prompt, `coordinator ls` and `coordinator status` show it, and you attach and answer it. The first time, attach once and accept any Remote Control prompt.

| Argument or flag | Default | Meaning |
|---|---|---|
| `NAME` | required | Lowercase letters, digits and `-`, up to 40 characters, starting with a letter or digit. A coordinator with the same name must not already exist. |
| `--repo URL` | required | A `https://github.com/OWNER/REPO` URL. |
| `--branch B` | the repository's default branch | Branch to clone. |
| `--task TEXT` | none | A task for the coordinator to start on. Up to 100,000 bytes. Cannot be empty. |
| `--task-file PATH` | none | Read the task from a local file instead. Same limits. |
| `--max-hours N` | 24 | Hours until the server deletes the machine. At most 24, at least 60 seconds (1/60 hour). The deadline cannot be extended. |
| `--model NAME` | Claude Code's default | Model for the coordinator's Claude Code session, such as `opus` or `claude-opus-5-5`. Rejected before any machine is created if it has characters other than letters, digits and `._:[]-`. |
| `--env FILE` | none (repeatable) | Bridge variables from a dotenv-style file to the machine; may be given several times. See Bridged env variables. |
| `--account LABEL` | least-recently-used free account | Sign the coordinator in with the saved Claude account LABEL instead of the least-recently-used free one. A label leased by another coordinator is refused, naming that coordinator. See [Saved Claude accounts](https://cloudycloud.tech/docs/fleets.html#accounts). |
| `--json` | off | Print one line of JSON with `name`, `machine`, `remoteControlName`, `attach` and `started` (`true`) instead of the usual text. A coordinator waiting for sign-in adds `needsLogin`, `loginUrl` (the `claude.ai`, `claude.com` or `platform.claude.com` URL the pane shows — never any other pane text) and `next`; one on a saved account adds `account`. |

About 5 seconds after starting the session, the command reads its screen. If it shows a spend or usage limit or an invalid key, the command deletes the machine and fails with that line. If it waits on a trust, MCP approval or Remote Control prompt, the machine stays and the output (and `waiting` in `--json`) says to run `coordinator attach NAME` and accept it. A coordinator waiting at `claude auth login` is a normal state: the machine stays, the output says to run `coordinator login NAME`, and once you sign in (in the attached pane, or in your browser plus `--code`) the session starts. The session runs with `--strict-mcp-config` and has `cloudy-cloud` on `PATH`. If neither `--task` nor `--task-file` is given, the coordinator starts without a task. The command fails with a message if no coordinator image has been saved. A coordinator always runs Claude Code.

Example:

```
cloudy-cloud coordinator start docs-fleet --repo https://github.com/OWNER/REPO --task-file task.md --max-hours 8
```

#### cloudy-cloud cloud

`cloudy-cloud cloud [--name N] [--branch B] [--max-hours H] [--model M] [--env FILE]... [--account LABEL] [--no-attach] [--json]` is the one-command form of `coordinator start` plus `coordinator attach`: run inside a git clone whose origin is on github.com, it takes the repo from the origin URL, the branch from the checkout, and names the coordinator an `<owner>-<repo>-<branch>-<hash>` slug (`--name` overrides; the 7-character hash of owner/repo@branch always rides along so two different repos — or the same repo on two branches — can never collide, and a slug over 40 characters is truncated keeping the hash). If local `<branch>` has commits `origin/<branch>` does not (it is fetched first), or tracked files have uncommitted edits, it warns that the cloud clone comes from GitHub and will not have them — on a terminal it asks `Start anyway? [y/N]`; off one it refuses and names the push command. Untracked files only warn. It never pushes for you. An already-running coordinator of that name is reattached to (`Reattaching to NAME`) only when its machine is running and its `install`, `repo` and `branch` labels all match this checkout — a machine whose `install` label names a different cloudy-cloud installation, or that has no `install` label at all (made before coordinators carried one), is refused with the conflict named and `--name` or `coordinator attach` suggested. `--env` on a reattach does nothing (env files apply at start only) and says so. Otherwise it starts the coordinator exactly like `coordinator start` and, on a terminal, attaches; `--no-attach`, `--json` or a pipe prints the start output only, which includes the attach command.

#### Bridged env variables

`coordinator start --env FILE` and `cloud --env FILE` copy variables from a dotenv-style file to the machine (repeatable; the `CLOUDY_CLOUD_ENV_FILES` comma list in `~/.config/cloudy-cloud/env` adds more). A variable whose name is already listed in your `CLOUDY_CLOUD_PROXY_SECRETS` is attached by name like any other custom proxy secret — the bridge never writes provider secrets. Any other variable needs per-repo consent (`y` for once, `a` remembered per origin in `env-consent.json`, which stores a SHA-256 of the value so a changed value asks again) and is then written `NAME='value'` into `~/.config/cloudy-cloud/env.local` (mode 600, uploaded through the file route, never a command line) and sourced into the session's environment when tmux starts Claude. Names that could override the machine's own configuration or credentials (`PATH`, `HOME`, `GIT_*`, `NODE_*`, `CLOUDY_CLOUD_*`, `CLAUDE_*`, `ANTHROPIC_*`, `XDG_*`, `INSTABOX_*`, `npm_config_*`/`NPM_CONFIG_*`, `PYTHON*`, `RUBY*`, `PERL5*`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` in any case, `CURL_*`, `SSL_CERT_*`, `REQUESTS_CA_BUNDLE`, `EDITOR`, `VISUAL`, `PAGER`, `BROWSER`, `TERM*`, `TMPDIR` and the like) are always refused. On a provider without proxy secrets every variable needs consent. Variables cloudy-cloud already sends are always skipped. The summary names the proxied, copied and skipped variables with reasons, never values; a malformed line is reported by file and line number only, and an unterminated quote ends parsing there — nothing from that line onward is used; without a terminal unconsented variables are skipped.

A coordinator machine also runs a deadline watchdog in a detached tmux session `cc-watchdog` (script `~/watchdog.sh`, log `~/watchdog.log`), started with `CLOUDY_CLOUD_COORDINATOR=1` and `CLOUDY_CLOUD_DELETE_AT` set to the deadline the provider reported for the machine. The deadline reminder reaches the Claude session through a Claude Code command hook (`bin/deadline-hook.sh`, wired for `UserPromptSubmit` and `PostToolUse` in the launcher's `--settings`): inside the last 30 minutes it emits `additionalContext` telling the session the delete time and to commit and push to a work branch — the watchdog never types into the session. Starting 5 minutes before deletion until the last minute the watchdog saves leftover work in `~/repo` every poll: `git add -u` stages tracked edits only (untracked files are logged by name and count, never staged; files already added to the index are unstaged, logged by name and never committed — a staged credential file must not ride a WIP commit), a `WIP: automatic save before the machine is deleted` commit is made when needed (a failed commit is retried each poll and never pushed), then the current branch is pushed — done means a clean tree AND `HEAD` on `origin/<branch>` (fetched each poll; a failed fetch counts as unpushed). It never pushes to the push remote's default branch (a configured `remote.origin.pushurl` is asked with `git ls-remote --symref <pushurl> HEAD`; an unreadable remote means "protected"), to `main`, `master` or a `release*` branch, or while HEAD is detached — protected work goes to `cloudy-cloud/wip-<timestamp>` instead. It never force-pushes and never deletes anything; after a successful save it keeps polling and saves again only when something new appears, a push rejected at the branch destination is not retried there but lands on a fresh `cloudy-cloud/wip-<timestamp>`, and work still unsaved at the deadline exits non-zero. On the machine, the coordinator session may also use the built-in `Agent` tool for small tasks on its own machine; parallel or heavy work still goes to `cloud_agent`.

#### coordinator attach

Opens the coordinator's `tmux` session over SSH. On a terminal it opens the session itself. When the output is piped it prints `cloudy-cloud coordinator attach NAME` instead, and you run that in your own terminal. `coordinator start` and `coordinator status` show this same command, never the provider's own. It refuses a coordinator whose `install` label names a different cloudy-cloud installation; a coordinator with no `install` label (made before coordinators carried one) is still attached by name.

```
cloudy-cloud coordinator attach docs-fleet
```

#### coordinator login

Finishes a coordinator's Claude sign-in — each coordinator signs in for itself, and a fresh one waits at `claude auth login` until this runs. Without `--code` it attaches to the `claude` pane so you sign in there; a terminal is required (off one it prints an error pointing at `--code`), and when the pane shows `Login expired` or `/login` it prints `Type /login and sign in.` first. With `--code` — the way an agent finishes a sign-in the user did in a browser — it types the code (1–512 characters of letters, digits, `#`, `_`, `-`; anything else is rejected) into the pane's sign-in prompt, presses Enter, and waits up to 60 seconds for `claude auth status` to report the sign-in. It refuses `--code` when the pane is not showing the sign-in code prompt. A finished sign-in is saved on the laptop as an account — labeled `--account LABEL` if given, else the sign-in's email, else `account-N` — and the next coordinator that takes it starts already signed in; `--account LABEL` leased by a different coordinator is refused, naming it.

```
cloudy-cloud coordinator login docs-fleet
cloudy-cloud coordinator login docs-fleet --code OK-code_#9
```

#### coordinator ls

Lists your coordinators in a table with the columns NAME, STATE, STARTED (CREATED when the output is not a terminal), MACHINE and DELETES, plus a WAITING (SCREEN in a terminal) column when a screen needs a look. It reads each running coordinator's screen once: `waiting for Claude sign-in` means the pane waits at `claude auth login` (finish it with `coordinator login NAME`), `waiting on a prompt: <line>` means a prompt needs an answer, `screen not read` means the screen could not be read. It prints `No coordinators.` when there are none.

```
cloudy-cloud coordinator ls
```

When the output is piped, it prints tab-separated NAME, STATE, CREATED, MACHINE, DELETES and WAITING.

#### coordinator status

Read-only. Prints the coordinator's state, `waiting for Claude sign-in` when the pane waits at the sign-in (with the sign-in URL when the pane shows one), the prompt line it is waiting on (if any, with keys removed), the Remote Control link once Remote Control is connected (with a QR code on a terminal, to scan with a phone) and the attach command — or `coordinator login NAME` while it waits for sign-in. It reads the screen once. `--json` prints `name`, `machine`, `state`, `screenRead`, `waiting`, `needsLogin`, `loginUrl`, `remoteControlUrl`, `account` and `attach` (`waiting`, `needsLogin`, `loginUrl`, `remoteControlUrl` and `account` only when set; `next` names the finish-sign-in command while it waits). `coordinator start` prints the same link, and the QR code on a terminal, when Remote Control has connected by the end of the start wait; otherwise run `coordinator status NAME` later.

```
cloudy-cloud coordinator status NAME [--json]
```

Example:

```
cloudy-cloud coordinator status docs-fleet
```

#### coordinator stop

Deletes the coordinator's machine now. When the machine holds a saved-account lease, its newest credential is first synced back to the laptop and the lease released. Its workers are deleted by the coordinator's cleanup process, or at their own deadline (6 hours by default). Anything the coordinator did not push to GitHub is lost.

```
cloudy-cloud coordinator stop docs-fleet
```

#### coordinator finish

Runs on the coordinator machine, started by the coordinator itself when its work is done. It checks that the working tree in `~/repo` is clean, that the current branch and every `fleet/*` branch are pushed to their upstream, and that none of the coordinator's workers are still running. If all checks pass, it deletes its own machine. If a check fails, it lists the problems and deletes nothing. It refuses to run on a machine that is not a coordinator.

| Flag | Meaning |
|---|---|
| `--force` | Skip the git and worker checks and delete the machine anyway. |

> Warning: `--force` can delete work that has not been pushed. Use it only when you accept losing that work.

### cloudy-cloud accounts

```
cloudy-cloud accounts ls [--json]
cloudy-cloud accounts rm LABEL
cloudy-cloud accounts sync [--watch]
```

Manages the saved Claude accounts that coordinators sign in with. A finished `coordinator login` sign-in is saved automatically under `~/.config/cloudy-cloud/accounts/` (mode 700; each `<label>.json` is the machine's credential file at mode 600; `index.json` tracks labels, emails, leases and usage limits — never a token). One account serves one coordinator at a time: `coordinator start` leases it to the new machine and delivers its credential before the session starts.

`ls` prints LABEL, EMAIL, STATE (`free`, `used by NAME`, `limited until T` or `needs sign-in`) and LAST USED; `--json` prints the same rows as JSON. `rm LABEL` forgets a saved account — it refuses while a coordinator holds the lease, deletes only this laptop's saved file and index entry, and leaves the Claude account itself unaffected. `sync` copies each leased machine's newest credential back to the laptop now; `sync --watch` keeps doing it every 30 minutes (and once more about 10 minutes before a machine's delete deadline) until no leased coordinator remains — `coordinator start` launches it automatically, running it twice is harmless, and a cloudy-cloud command resumes it after a laptop sleep. See [Saved Claude accounts](https://cloudycloud.tech/docs/fleets.html#accounts).

### cloudy-cloud mcp

```
cloudy-cloud mcp add NAME [--allow-literal]
cloudy-cloud mcp ls
cloudy-cloud mcp rm NAME
```

Chooses which of your Claude Code MCP servers cloud subagents get. `add` copies one server from your Claude Code settings (local, project or user scope) to `~/.config/cloudy-cloud/mcp.json`, replaces a secret value with `${MCP_<NAME>_TOKEN}` and prints the `npx --yes instabox@latest secrets set ... --host ...` command that stores the value once in Instabox. `ls` lists the saved servers and the secrets they need. `rm` removes one. Only `https` servers on public hosts and `npx` or `uvx` servers are accepted; a refused server prints `Not added: REASON` and exits with status 1. `--allow-literal` asks you to confirm and then copies the real token to the machines — into the worker's own config file — instead of using an Instabox secret. All of this is described in [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

### cloudy-cloud mcp-server

```
cloudy-cloud mcp-server --repo PATH [--session NAME]
```

Runs the Cloudy Cloud MCP server on stdio for an MCP client configured outside the built-in host commands. Bind it to the repository the client is allowed to use with `--repo`. An optional `--session` names a local owner so separate client connections can reconnect to its workers; without it, the server uses the normal ephemeral lifetime. The server reads its keys from `~/.config/cloudy-cloud/env`. The reported MCP server version comes from this package's version.

### cloudy-cloud run

```
cloudy-cloud run --repo PATH [--profile NAME] [--workspace PATH] [--session NAME] [--timeout SECONDS] [--description TEXT] [--model NAME] [--issue N] [--base REF] [--explain] [--json] -- PROMPT
```

Runs one worker to completion in the required repository, which must be a git repository with a `github.com` origin. The profile is optional; `--workspace` selects a directory within the bound repository. `--session` attaches to a named MCP owner session; without it, the command creates a temporary owner. `--explain` asks for a local launch preview and exits without starting a worker. The preview reports locally eligible and rejected providers, plus checks that remain unknown until a real launch, such as current capacity, provider acceptance, and model preflight. It does not create a machine or call a model provider. `--json` writes the structured result to stdout; any legacy-configuration migration notice and run ID are written to stderr. For a real run, the ID is printed after worker admission and private record persistence, before waiting for the result. Use `cloudy-cloud resume RUN-ID` to reconnect after interruption. The command waits for the worker, stops it after collecting the result, and exits nonzero when startup or the worker turn fails. Use `cloudy-cloud setup --default-profile NAME` to set the default worker profile; without that setting, Claude Code remains the default.

### cloudy-cloud resume

```
cloudy-cloud resume RUN-ID [--json] [--timeout SECONDS]
```

Resumes a `cloudy-cloud run` as the same local user, using its saved repository from any current directory. The private record in `~/.config/cloudy-cloud/runs` includes the original agent and turn IDs. If the run completed and its result was cached, resume returns that result even after the owner exits. Active or incomplete work needs the original owner to still be running; a missing or stale owner fails closed. Resume only collects or stops the recorded turn, never a newer concurrent turn, and never creates a replacement owner or worker. The default timeout is 2100 seconds; the maximum is 86400.

### cloudy-cloud exec

```
cloudy-cloud exec --repo PATH [--timeout SECONDS] [--json] -- COMMAND [ARG ...]
```

Runs literal command arguments in a fresh Linux sandbox seeded from the tracked index and working-tree state of a local Git root with at least one commit. A GitHub origin is not required. Untracked files are omitted. It does not send model or GitHub credentials. The command runs outside your local working tree. The default timeout is 2100 seconds (35 minutes), minimum 1 second and maximum 86400 seconds. A verified clean, unchanged workspace is deleted even after a nonzero command exit; the exact exit code is reported. Dirty or changed state, uncertain transport, or failed inspection retains the sandbox and returns a provider-qualified owner selector and an inspection command. The CLI streams stdout and stderr where supported; buffered providers return both at completion. Example: `cloudy-cloud exec --repo . -- npm test`.

## Tools the session uses (MCP)

`cloudy-cloud` adds an MCP server named `cloud` to the session. Claude sees its tools as `mcp__cloud__cloud_agent` and so on. The server includes worker lifecycle tools, capability discovery and checkpoint recovery. Recovery is available only from a confirmed pushed checkpoint and starts a fresh worker conversation on a configured alternate provider. The launcher configures its host tools and turns off local built-in subagents. This section describes the MCP arguments.

In a terminal Claude Code session that supports MCP tasks, `cloud_agent` and `cloud_agent_message` run as background tasks. Their progress shows in `/tasks` and the result arrives on its own with the agent id, so Claude does not need `cloud_agent_wait`. In other clients these two tools return an agent id at once and Claude calls `cloud_agent_wait`. The server also answers the task methods `tasks/get` and `tasks/cancel`.

### cloud_agent

Starts a subagent in a remote sandbox on the committed and tracked files of the current repository. It does not include untracked files. The repository needs a `github.com` origin. The call returns at once while the sandbox starts and the task runs. The agent pushes its work to the origin branch `cloudy-cloud/<id>`. Nothing is copied into your local repository. The agent stays open for follow-ups until it is stopped or has been idle for 60 minutes.

Each turn is limited to 29 minutes by default. `CLOUDY_CLOUD_TURN_MINUTES` changes the limit (see Settings), and the prompt tells the agent when its turn ends. If a turn fails or hits the limit after the agent has started, the agent stays open with its session: call `cloud_agent_message` to continue it. A worker that commits nothing pushes no branch; the result says `No changes, no branch pushed.` and autofix does not start.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `prompt` | string | yes | none | The full task for the subagent. |
| `description` | string | yes | none | A short label for the task. |
| `model` | string | no | the Claude default | A Claude model name, such as `haiku`. For a non-Claude model, use `profile` instead. It is needed with a profile only for `openrouter`, `codex-openrouter` and `opencode-openrouter`, which have no built-in model. It may contain only letters, digits and `. _ : -`. When `profile` is also set, `/` is allowed too. |
| `profile` | string | no | saved default profile; Claude Code if unset | Runs the worker on another agent or model. A per-call value overrides the saved default profile. Built in: `glm`, `deepseek`, `particle` and `openrouter` (Claude Code on another model); `pi-glm`, `pi-deepseek` and `pi-particle` (pi); `omp-glm`, `omp-deepseek` and `omp-particle` (oh-my-pi); `codex`, `codex-chatgpt` and `codex-openrouter` (Codex); `opencode-glm`, `opencode-deepseek`, `opencode-particle` and `opencode-openrouter` (opencode). You can add names in `profiles.json`, where each entry's `harness` (`claude`, `pi`, `omp`, `codex` or `opencode`) says which agent runs the worker. An unknown name, or a profile whose key is missing, makes the call fail at once. See [Models and keys](https://cloudycloud.tech/docs/models.html). |
| `workspace` | string | no | bound repository root | Directory for this worker, relative to the repository bound when the MCP server started. An absolute path is also accepted if it resolves inside that repository. Paths outside the bound repository are refused. |
| `role` | string, `worker` or `coordinator` | no | `worker` | A worker does the task. A coordinator also gets cloudy-cloud installed and can start its own cloud agents, limited by `CLOUDY_CLOUD_MAX_DEPTH` (default 3). A coordinator always runs Claude Code, so it cannot use a pi, omp, Codex or opencode profile. |
| `machine` | string | no | `linux` | The kind of machine: `linux`, `android`, `omarchy`, `gpu`, `gpu:TYPE`, `gpu:TYPE:COUNT` (COUNT 1 to 4 for any GPU type), `macos` or `macos:MODEL`. `gpu` and `macos` cost much more (GPU: from $0.765 per GPU-hour; Mac: $0.45 to $1.25 per hour with a 24-hour minimum) and are refused until `CLOUDY_CLOUD_ALLOW_MACHINE_KINDS` in `~/.config/cloudy-cloud/env` names them (for example `gpu,macos`). Only on Instabox. |
| `size` | string | no | `4x8` | Machine size as VCPUSxGIB, for example `2x4`, `4x8` or `8x16`. Your Instabox plan decides which sizes are allowed; a size no plan lists is refused. |
| `autofix` | boolean | no | `false` | After the worker pushes, the server opens a pull request for its branch and keeps the worker fixing failed checks, review comments and merge conflicts, for at most `CLOUDY_CLOUD_AUTOFIX_ROUNDS` rounds, before the task ends. The result says whether the pull request is clean. Not for coordinators. |
| `base` | string | no | the local `HEAD` | A branch name or a commit hash of 7 to 40 hex characters. The worker starts from it instead of your local `HEAD`; the server fetches it from origin if needed. Uncommitted edits are ignored when `base` is set. |
| `fallback` | array of strings | no | the profile's `fallback` in `profiles.json`, else none | Profile names to try, in order, when the chosen profile has no key or the provider refuses the one-token check before the machine starts. It overrides the profile's own `fallback`. The result says which profile ran. |
| `preflight` | boolean | no | `true` | Set `false` to skip the one-token provider check that runs before the machine is created. |
| `subagent_type` | string | no | none | The name of an agent to run, passed to Claude Code as `--agent` (Claude Code workers only). It may contain only letters, digits and `. _ : -`. |
| `issue` | string | no | none | A GitHub issue in this repo's origin: a number like `"12"`, or a URL like `https://github.com/<owner>/<repo>/issues/<n>`. The title and body are fetched on your computer with `gh` and quoted into the prompt as untrusted text. The branch is `cloudy-cloud/issue-<n>-<id>`, and an autofix pull request body says `Fixes #<n>`, so merging it closes the issue. Workers only; needs `gh` signed in. |
| `preview_port` | integer | no | none | A port from 1 to 65535 (a digit string also works) where the worker's app is already running on its machine. After a turn that pushed, a share link is published, the same as `cloudy-cloud open <id> <port> --share`, and the result shows `Preview: <url>`. The link is never posted to a pull request. Anyone with the link can open the app until the machine is deleted. Needs a provider that supports published links (Instabox); if publishing fails, the turn still succeeds and the result gives the manual command. |

When `~/.config/cloudy-cloud/mcp.json` holds at least one valid server, a Claude Code subagent (not a pi, omp, Codex or opencode worker) starts with `--mcp-config` for that file and `--strict-mcp-config`, so a repo's own `.mcp.json` is not loaded on the machine. pi, omp, Codex and opencode workers get the same servers in their own config files. The reply ends with an `MCP servers:` line. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

The call is refused if the session has already started `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` agents (default 200), or if the folder is not a git repository with at least one commit and a `github.com` origin.

### cloud_agent_capabilities

Reports configured worker profiles, providers and machine kinds. It reads local configuration and does not create a machine or call a model provider. Provider readiness and capabilities in the result describe the active local configuration; they do not prove that a live provider or model call will succeed.

### cloud_agent_explain

Previews the same local request eligibility checks used by `cloud_agent`, without creating a machine, checking provider plans or capacity, probing a model, or making a provider create request. It reports `eligible`, `conditional` or `ineligible`, eligible and rejected providers, and unknown checks. Dynamic capacity, provider acceptance, and model preflight remain unknown. The arguments match `cloud_agent`.

### cloud_exec

Runs a command as literal argv in a fresh Linux sandbox from tracked local git state. Arguments are `argv` (required string array), optional `repo` (defaults to the MCP-bound repository), and optional `timeout_seconds` (default 2100, range 1-86400). The repository must be a Git root with at least one commit; it needs no GitHub origin. Untracked files are omitted. It does not send model or GitHub credentials. Captured stdout and stderr are each limited to 131072 bytes and report `output_truncated` when clipped. When the MCP client supplies a `progressToken`, output chunks are also sent as ordered `notifications/progress` messages with increasing integer progress values. Each message identifies `stdout` or `stderr` and contains scrubbed text. Without a token, no progress notifications are sent. Instabox buffers output until the command completes; `stderr_streamed` indicates whether stderr chunks were streamed by the provider. A verified clean, unchanged workspace is deleted, even when the command exits nonzero. Dirty, changed, unverified or transport-lost state is retained with an owner selector and inspection command. Results include exit code, stdout and stderr, workspace state, provider, machine and owner, and whether cleanup or retention occurred.

### cloud_agent_recover

Starts a fresh worker conversation from a previously confirmed, pushed checkpoint. It confirms the old machine is positively absent and that the origin branch still points to the exact checkpoint SHA, then starts the same agent ID and branch using only the new message. A named provider targets that provider. `provider: "auto"` tries eligible configured providers other than the checkpoint's original provider; candidates must support the saved profile, harness and egress policy. The normal placement rules only fall through after a definite refusal; an ambiguous create stops without another attempt. It does not replay the old prompt or restore in-memory conversation state. It refuses when the old machine is live or its state is unknown, the checkpoint is missing or the branch moved, or the workspace/user does not match.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `agent_id` | string | yes | The failed worker's agent ID with a confirmed checkpoint. |
| `provider` | string | yes | A configured alternate provider allowed for this worker, or `auto` to try eligible configured alternates. |
| `message` | string | yes | The new message for the fresh worker conversation. |

### cloud_agent_message

Sends a follow-up message to an open agent that is idle, and continues the same conversation. It returns at once. As an MCP task the reply arrives on its own. Otherwise Claude calls `cloud_agent_wait`. It is rejected if the agent is busy or gone.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent_id` | string | yes | none | The id returned by `cloud_agent`. |
| `message` | string | yes | none | The follow-up text. |

### cloud_agent_wait

Waits until every listed agent finishes its current turn, or until the timeout passes. For each agent it returns the status (`starting`, `running`, `idle`, `failed` or `stopped`) and its latest result. Each result is returned once. Later calls mark it as already reported. The tool is read-only.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent_ids` | array of strings | yes | none | The agent ids to wait for. |
| `timeout_seconds` | number | no | 600 | How long to wait. Values above 1500 are limited to 1500. |

### cloud_agent_result

Returns an agent's latest result again, as often as asked, even after `cloud_agent_wait` or a task notification delivered it. If the agent has no result yet it says `no result yet, status running`. If the agent is not open it returns an error with a next step. The tool is read-only.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `agent_id` | string | yes | The agent id. |

### cloud_agent_list

Lists every agent with its id, description, status, idle minutes and progress (tool uses, tokens, elapsed time and current step). The tool is read-only. With `all: true` it instead lists every machine on the provider labelled `purpose=cloudy-cloud` (other sessions and coordinators included), grouped by its `parent` label. Each worker machine carries the labels `role`, `profile` (`claude` for the default), `parent`, `agent` and a short redacted `description`.

### cloud_agent_stop

Stops agents owned by this MCP server and deletes their sandboxes. A successful result means the provider confirmed deletion or confirmed that the machine was already absent. If deletion fails transiently, the agent remains tracked as `stop-pending` and the result gives retry guidance. Stop agents when they are finished, because they otherwise remain open until stopped or idle for 60 minutes.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent_ids` | array of strings | yes | none | The agent ids owned by this server session. Machine IDs and provider-qualified machine selectors are for the `cloudy-cloud machines` command, not this MCP tool. |

### Limits that apply to the tools

- An agent that is idle for 60 minutes is stopped. Default ephemeral sessions stop their agents when the session ends; named MCP sessions can reconnect to a local owner while that owner is running.
- A single task is stopped after 29 minutes.
- Machines start at most `CLOUDY_CLOUD_STARTS_PER_MIN` times a minute. Agents waiting for a machine show the status `queued`.
- Instabox deletes every machine the tool creates after `CLOUDY_CLOUD_WORKER_HOURS` hours, even if `cloudy-cloud` has died.

## Kinds of machines

The `machine` argument of cloud_agent picks the machine. Prices are Instabox's ([pricing](https://instabox.sh/docs/account/pricing.md)). Live facts are from one run on 2026-11-15.

| machine | What it is | Price | Consent | Display |
|---|---|---|---|---|
| `linux` | The standard machine (default). | Your plan | no | yes |
| `android` | Android emulator with `adb`. Its desktop starts in about 1 second. | Not checked | no | yes |
| `gpu` | NVIDIA GPU (one L4 by default). The first desktop start takes about 2 minutes. | $0.765 per GPU-hour (NVIDIA L4) | yes | yes |
| `omarchy` | Omarchy Linux with a Hyprland desktop. `display` and `--screenshot` are refused; `shell` works. | Not checked | no | no |
| `macos` | A Mac, for Xcode builds. Experimental, not yet run live. | $0.45 to $1.25 per hour, 24-hour minimum lease | yes | not verified |

See cloudy-cloud shell and cloudy-cloud display to look at a machine.

## Environment variables and files

Environment variables win over values in the config file. An empty value counts as unset.

### Keys

| Variable | Default | Meaning |
|---|---|---|
| `INSTABOX_API_KEY` | none | Your Instabox API key. Read from the environment or the config file. |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | The long-lived token from `claude setup-token`. Cloud agents use it to sign in to Claude. |
| `GH_TOKEN` | none | Your GitHub token. On a self-hosted machine it is read from the config file and placed in each worker container if you allowed that. See [Run on your own machine](https://cloudycloud.tech/docs/self-hosted.html#github-token). |
| `ANTHROPIC_API_KEY` | none | An Anthropic API key, used by cloud agents when there is no Claude token. It is billed separately. |
| `PARTICLE_API_KEY`, `OPENROUTER_API_KEY`, and any other name ending in `_API_KEY` | none | Provider keys for model profiles. A profile's `keyName` must name one of these. A worker that uses a profile receives that profile's key. |
| `OPENAI_API_KEY` | none | Your OpenAI API key, for the `codex` profile. Setup asks for it when you choose codex. See [The codex profiles](https://cloudycloud.tech/docs/models.html#codex-profiles). |

> Note: The launcher only checks the config file for the Claude token, not the environment, so save it there with `cloudy-cloud setup`. The Instabox key can come from either place.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDY_CLOUD_CONFIG` | `~/.config/cloudy-cloud/env` | Path of the config file. |
| `CLOUDY_CLOUD_ALLOW_MACHINE_KINDS` | none | Comma-separated machine kinds you allow although they cost much more: `gpu`, `macos`. Without it, `cloud_agent` refuses those kinds and starts nothing. |
| `CLOUDY_CLOUD_PROVIDERS` | unset | Ordered comma- or space-separated provider names to try. Lists must use compatible credential handling: `instabox,microsandbox` keeps model values out of the worker guest through provider proxying or host-side substitution, while `boat,e2b,self-hosted` delivers credentials to the machine only with provider-specific consent. Mixing these groups is refused because failover cannot change the credential model. Cloudy Cloud skips providers that cannot meet the requested machine, feature and credential requirements and advances after eligible definite creation failures such as missing key, capacity, quota or rate limit. A transient or uncertain create response triggers reconciliation using the stable agent label: Cloudy Cloud adopts a match only when exactly one machine is found and connects successfully. If no match, multiple matches, listing errors or connection failure prevent confirmation, it refuses to start another machine. Errors after a sandbox is returned do not trigger provider failover. If unset or empty, the legacy single-provider setting is used. |
| `CLOUDY_CLOUD_PROVIDER` | `instabox` | Legacy single-provider setting used when `CLOUDY_CLOUD_PROVIDERS` is unset or empty. Providers currently include `instabox`, `boat`, `e2b`, `self-hosted` and `microsandbox`. |
| `CLOUDY_CLOUD_MSB_BIN` | `~/.local/bin/msb`, then `msb` on PATH | Microsandbox: path of the `msb` program. |
| `CLOUDY_CLOUD_MSB_SLOTS` | 2 | Microsandbox: how many microVMs run at once. |
| `CLOUDY_CLOUD_EGRESS_ALLOW` | unset | Hosts a worker machine may connect to, separated by commas or spaces; `*.example.com` covers the domain and its subdomains. The worker can also always reach `github.com`, `api.github.com`, its model host and every configured `https` MCP server host, plus DNS. `off` (or `none`) sets no policy on purpose. Only the `microsandbox` provider enforces the list; on another provider `cloud_agent` refuses to start while it is set, and a set-but-empty value is an error. Workers only, and only Claude Code workers that reach their model host directly. See [Troubleshooting](https://cloudycloud.tech/docs/troubleshooting.html). |
| `CLOUDY_CLOUD_NO_UPDATE_CHECK` | unset | Set to `1` to turn off the update notice. The check for a newer version runs once a day; a notice already in the cache can print on every launch. |
| `CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS` | unset | Self-hosted, written by setup: `yes` means coordinators on your machine may start containers through Docker. |
| `CLOUDY_CLOUD_SELF_HOSTED_LOCAL` | unset | Self-hosted, set on a coordinator container: workers start as sibling containers on the same machine instead of over SSH. |
| `CLOUDY_CLOUD_SELF_HOSTED_CONSENT_HOST` | unset | Self-hosted, written by setup: the machine the GitHub-token and Docker consents apply to. |
| `CLOUDY_CLOUD_DOCKER_SOCKET` | `/var/run/docker.sock` | Self-hosted local mode: path of the Docker socket on the machine. |
| `CLOUDY_CLOUD_CLAUDE_JSON` | `~/.claude.json` | The Claude Code settings file `cloudy-cloud mcp add` reads servers from. |
| `CLOUDY_CLOUD_STREAMS` | `~/.config/cloudy-cloud/streams` | Folder of the redacted per-agent stream copies the dashboard reads. Pruning (`dashboard --prune`, and once at each agent's first turn) deletes any file in it by age and size, not only stream files. |
| `CLOUDY_CLOUD_STREAM_THINKING` | unset | The stored streams keep the redacted raw lines either way; set to `1` where the dashboard runs to show thinking text instead of only its length. |
| `CLOUDY_CLOUD_OPENCODE_BIN` | `opencode` | Program `cloudy-cloud opencode` runs. |
| `CLOUDY_CLOUD_CODEX_AUTH` | `~/.config/cloudy-cloud/codex-auth.json` | Path of the ChatGPT login file the `codex-chatgpt` profile copies to a machine. |
| `CLOUDY_CLOUD_DOCTOR_SLOW_MS` | 5000 | Milliseconds before the SSH probe in `doctor` and self-hosted setup is reported as slow. |
| `CLOUDY_CLOUD_INSTABOX_API_KEY` | unset | Set on a coordinator machine: a placeholder for the Instabox key, which the launcher reads when `INSTABOX_API_KEY` is not set. You do not set it. |
| `CLOUDY_CLOUD_SSH_HOST` | none | Self-hosted: the SSH address of your machine, `user@host`. |
| `CLOUDY_CLOUD_SSH_KEY` | none | Self-hosted: path to the SSH key. Optional. |
| `CLOUDY_CLOUD_SSH_PORT` | the SSH default | Self-hosted: the SSH port, when it is not the default. |
| `CLOUDY_CLOUD_CONTAINER_RUNTIME` | `docker` | Self-hosted: `docker` or `podman`. |
| `CLOUDY_CLOUD_CONTAINER_BIN` | none | Self-hosted: absolute path of the `docker` or `podman` program on the machine. Setup finds and saves it. |
| `CLOUDY_CLOUD_SELF_HOSTED_SLOTS` | 2 if unset; setup suggests half the CPUs or one per 4 GB of memory, whichever is lower | Self-hosted: how many subagents run at once. |
| `CLOUDY_CLOUD_SELF_HOSTED_CPUS` | 2 if unset | Self-hosted: CPU limit per container. Setup saves a value. |
| `CLOUDY_CLOUD_SELF_HOSTED_MEMORY` | 4g if unset | Self-hosted: memory limit per container. Setup saves a value. |
| `CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX` | unset | Self-hosted: `yes` means you allowed the GitHub token inside worker containers on your machine. Without it, workers do not start. |
| `CLOUDY_CLOUD_PROFILES` | `~/.config/cloudy-cloud/profiles.json` | Path of the file that adds or overrides model profiles. Each entry can set `harness` to choose the agent (`claude`, `pi`, `omp`, `codex` or `opencode`), `fallback` (profile names to try in order) and `maxConcurrent` (a positive whole number). |
| `CLOUDY_CLOUD_MCP` | `~/.config/cloudy-cloud/mcp.json` | Path of the file that lists the MCP servers cloud subagents get. If the file is missing, no servers are sent. |
| `CLOUDY_CLOUD_EVENTS` | `~/.config/cloudy-cloud/events.jsonl` | Path of the event log that the dashboard reads. Set it in the environment before you start `cloudy-cloud` and the dashboard. |
| `CLOUDY_CLOUD_WORKER_HOURS` | 6 | Hours until the server deletes a worker or nested coordinator machine. At most 24. A value that is not a positive number uses 6. |
| `CLOUDY_CLOUD_STARTS_PER_MIN` | 25 | The most machine starts per minute. Extra agents wait in the queue. |
| `CLOUDY_CLOUD_MAX_INSTABOX_CALLS` | 24 | The most Instabox command and file requests that run at once. Instabox's own limit is 32. |
| `CLOUDY_CLOUD_TURN_MINUTES` | 29 | The most minutes one agent turn may run. A whole number from 5 to the provider's machine lifetime in minutes minus 30; any other value is refused with the allowed range. The server sets `CLOUDY_CLOUD_TURN_DEADLINE` (the turn's end time) inside the worker command. You do not set it. |
| `CLOUDY_CLOUD_PROVIDER_RETRIES` | 3 | How many times a pi, omp, Codex or opencode turn is retried after a transient provider error (model not found, 429, 5xx or a connection error). Errors such as 400, 401 and 403 are not retried. |
| `CLOUDY_CLOUD_PROFILE_MAX` | no cap | The default most agents one profile may run at once. A profile's `maxConcurrent` in `profiles.json` overrides it. Agents over the cap wait in the queue and say why in `cloud_agent_list`. The count covers this server's own agents only. |
| `CLOUDY_CLOUD_AUTOFIX_ROUNDS` | 3 | The most fix rounds `autofix` runs on a pull request (0 to 10). |
| `CLOUDY_CLOUD_MAX_DEPTH` | 3 | How many levels of coordinators can exist below your session. Starting a coordinator past this is refused. Workers do not add depth. Passed down to child coordinators. |
| `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` | 200 | How many agents one cloudy-cloud session may start. Passed down to child coordinators. |
| `CLOUDY_CLOUD_PROXY_SECRETS` | empty | Comma-separated names of Instabox secrets that hold your Claude token and provider keys, for example `CLAUDE_CODE_OAUTH_TOKEN,PARTICLE_API_KEY,OPENROUTER_API_KEY`. A worker that needs a listed key gets the secret by name, so no key value reaches its environment. A key not listed is still copied to the machine, and the agent reply says so. Has no effect on providers without proxy secrets. |
| `CLOUDY_CLOUD_APT_PACKAGES` | empty | Space-separated Debian package names (for example `ffmpeg postgresql-client`) that each worker installs with `sudo -n apt-get install` after its repo is set up. A name with other characters is refused when the agent starts. |
| `CLOUDY_CLOUD_AGENTS` | none | The agents you chose in setup, comma-separated (`claude`, `codex`, `opencode`, `pi`, `free-pi`). `setup --check-only` reads it; when it is not set, claude is assumed. |
| `CLOUDY_CLOUD_CHECK_SECONDS` | 60 | Setup only: how long to wait for the test request that checks your Claude token. |
| `CLOUDY_CLOUD_NO_ANIMATION` | unset | Setup only: set to `1` to skip the animated banner. The banner is also skipped when `CI` is set or there is no terminal. |
| `MCP_TOOL_TIMEOUT` | 1800000 | Claude Code's timeout for one MCP tool call, in milliseconds. The launcher sets it only if you have not. |
| `NO_COLOR`, `CLICOLOR=0`, `TERM=dumb` | unset | Any of these turns off colour and the animated setup display. Output is plain text with the same messages. |

> Note: You can set `CLOUDY_CLOUD_STARTS_PER_MIN`, `CLOUDY_CLOUD_MAX_INSTABOX_CALLS`, `CLOUDY_CLOUD_WORKER_HOURS`, `CLOUDY_CLOUD_TURN_MINUTES`, `CLOUDY_CLOUD_MAX_DEPTH`, `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION`, `CLOUDY_CLOUD_PROXY_SECRETS` and `CLOUDY_CLOUD_APT_PACKAGES` in the config file as well as in the environment.

### Files

| Path | What it holds |
|---|---|
| `~/.config/cloudy-cloud/env` | The config file. One `NAME=value` per line, mode 600. `cloudy-cloud setup` writes it. Only the settings and keys listed above are read from it, plus `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT`, which `coordinator image` writes (optional). Change the location with `CLOUDY_CLOUD_CONFIG`. |
| `~/.config/cloudy-cloud/codex-auth.json` | Optional. A copy of `~/.codex/auth.json` (mode 600) for the `codex-chatgpt` profile. Create it with `install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json`. Set `CLOUDY_CLOUD_CODEX_AUTH` to use another path. |
| `~/.config/cloudy-cloud/profiles.json` | Optional. Adds or overrides model profiles, including each profile's `harness`. See [Models and keys](https://cloudycloud.tech/docs/models.html). |
| `~/.config/cloudy-cloud/mcp.json` | Optional. The MCP servers that cloud subagents get, in Claude Code's `mcpServers` format, mode 600. `cloudy-cloud mcp add` writes it. Secret values are stored as `${MCP_<NAME>_TOKEN}` references unless you used `--allow-literal`. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html). |
| `~/.config/cloudy-cloud/events.jsonl` | The event log. The MCP server appends one JSON line per agent event (agent, message, machine, status, progress, reply). The file has mode 600 inside a folder with mode 700. It holds your prompts and replies, so it stays on your computer. Key-shaped text is redacted before writing, and each text is cut at 20,000 characters. It is never rotated: delete it to clear the history. The dashboard reads the newest 16 MB. |
| `~/.config/cloudy-cloud/owner` | An id the MCP server writes next to the config file, so `coordinator finish` can tell which running machines are its workers. You do not need to edit it. |

If you used the tool under its old name, claude-cloud, the first run copies `~/.config/claude-cloud` to `~/.config/cloudy-cloud` and renames the `CLAUDE_CLOUD_` keys in the config file. The old folder is left in place.
