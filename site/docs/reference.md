# Command and tool reference

> Every cloudy-cloud command, MCP tool, option and environment variable.

Source: https://cloudycloud.tech/docs/reference.html

This page lists every `cloudy-cloud` command and flag, the five tools Claude uses to run cloud agents, and the environment variables and files that change how they behave.

## Command line

These commands run on your computer. `cloudy-cloud` checks the first argument. If it is `dashboard`, `open`, `coordinator`, `setup` or `--setup`, it runs that command. `mcp ls`, `mcp add NAME`, `mcp add NAME --allow-literal` and `mcp rm NAME` run cloudy-cloud mcp; any other `mcp` arguments go to Claude Code. Any other arguments start a Claude Code session.

### cloudy-cloud

```
cloudy-cloud [claude arguments]
```

The package installs the same command under two names, `cloudy-cloud` and `cloudycloud`; use either. Without a global install, `npx cloudycloud` runs the same command. Plain `claude` is not affected.

Starts a normal Claude Code session in the current folder. In that session the built-in `Agent` and `Workflow` tools are denied, and Claude starts subagents with the five cloud tools described below. Run it from inside a git repository that has a `github.com` origin, because each cloud agent pushes its work to a branch there.

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

### cloudy-cloud --help and --version

```
cloudy-cloud --help
cloudy-cloud --version
```

`--help` (also `-h` or `help`, when it is the only argument) prints Cloudy Cloud's own commands, then points to `claude --help` for Claude Code's options. `--version` prints the Cloudy Cloud version. With any other arguments, everything goes to Claude Code, for example `cloudy-cloud -p "<prompt>" --allowedTools "Bash(git fetch *)"`; see [Run without the interactive UI](https://cloudycloud.tech/docs/#no-interactive-ui).

### cloudy-cloud setup

```
cloudy-cloud setup [--check-only] [--provider instabox|self-hosted]
```

Runs the bundled `install.sh`, whatever folder you are in. `cloudy-cloud --setup` does the same, and `npx -y cloudycloud setup` runs it without installing anything first (`-y` skips npm's "Ok to proceed?" question). Setup checks your tools, offers to install the `cloudy-cloud` command (`npm install -g cloudycloud`, or a link when you run it from a git clone), copies the Cloudy Cloud skills into `~/.claude/skills`, and asks for your Instabox key, your Claude token and your GitHub token, then offers optional steps for model provider keys and cloud coordinators. If an older `cloudy-cloud` global command blocks the install, setup offers to replace it (`npm rm -g cloudy-cloud`, then `npm install -g cloudycloud`). Run it again to change a key. It needs a terminal because it asks for keys. See [Getting started](https://cloudycloud.tech/docs/).

| Flag | Meaning |
|---|---|
| `--provider instabox\|self-hosted` | Choose where subagents run without being asked. `self-hosted` asks for your machine instead of an Instabox key. See [Run on your own machine](https://cloudycloud.tech/docs/self-hosted.html). |
| `--check-only` | Check that `git`, Node.js, `npm`, `curl` and `claude` are installed, then exit. Does not need a terminal and changes nothing. |

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
```

Starts a read-only web page on `127.0.0.1` that shows your cloud agents, coordinators and the messages between your session and them. It prints a link that contains a random token for this run, and opens it in your browser. Press Ctrl+C to stop it. There is no `--help` option. See [Dashboard and app previews](https://cloudycloud.tech/docs/dashboard.html).

| Flag | Meaning |
|---|---|
| `--demo` | Show sample data instead of your machines. Nothing in it is real. |
| `--port N` | Listen on port N, from 0 to 65535. The default is 4477. If that port is in use, the dashboard uses a free port instead. Port 0 always picks a free port. |
| `--no-open` | Only print the link. Do not open a browser. |

Example:

```
cloudy-cloud dashboard --port 5000 --no-open
```

### cloudy-cloud open

```
cloudy-cloud open <agent-id-or-machine> <port> [--share]
cloudy-cloud open <agent-id-or-machine> <port> --unshare
```

Reaches an app, such as a dev server, that runs on a cloud agent's machine. The first argument is an agent id (the `<id>` in the branch `cloudy-cloud/<id>`, shown by `cloud_agent_list`), a machine name or a machine id (a coordinator's machine is named `coord-NAME`). It may use only letters, digits, dots, dashes and underscores. The machine must be running. The command needs your Instabox key.

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

### cloudy-cloud coordinator

```
cloudy-cloud coordinator image [--save]
cloudy-cloud coordinator start NAME --repo URL [--branch B] [--task TEXT | --task-file PATH] [--max-hours N] [--json]
cloudy-cloud coordinator attach NAME
cloudy-cloud coordinator ls
cloudy-cloud coordinator stop NAME
cloudy-cloud coordinator finish [--force]
```

Manages cloud coordinators: long-lived Claude Code sessions that run on their own Instabox machines and start workers there. All subcommands except `finish` need your Instabox key. With any other first argument, or none, the command prints this usage line. See [Coordinators and fleets](https://cloudycloud.tech/docs/fleets.html) for when to use them.

#### coordinator image

Builds the machine image that coordinators start from. It is a one-time step. Without `--save`, it creates an image machine, installs cloudy-cloud on it, and prints the steps to sign in to Claude on it (`claude auth login` in a shell on the machine). With `--save`, it saves a snapshot of that machine, stores its id as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT` in the config file, and deletes the image machine. The server deletes an unsaved image machine after 2 hours. Only one image machine can exist at a time.

| Flag | Meaning |
|---|---|
| `--save` | Save the signed-in image machine as a snapshot and delete the machine. |

#### coordinator start

Starts a coordinator named NAME on a new machine from the saved image. It sends the current checkout of cloudy-cloud, writes the coordinator's key file (mode 600), clones your repository to `~/repo`, and starts Claude Code in a `tmux` session called `claude`, with Remote Control under the name NAME. The coordinator never pauses. The server deletes its machine after `--max-hours`. You can reach it from claude.ai/code or the Claude app (pick the session named NAME) or from a terminal with `coordinator attach`. The first time, attach once and accept any trust or Remote Control prompts.

| Argument or flag | Default | Meaning |
|---|---|---|
| `NAME` | required | Lowercase letters, digits and `-`, up to 40 characters, starting with a letter or digit. A coordinator with the same name must not already exist. |
| `--repo URL` | required | A `https://github.com/OWNER/REPO` URL. |
| `--branch B` | the repository's default branch | Branch to clone. |
| `--task TEXT` | none | A task for the coordinator to start on. Up to 100,000 bytes. Cannot be empty. |
| `--task-file PATH` | none | Read the task from a local file instead. Same limits. |
| `--max-hours N` | 24 | Hours until the server deletes the machine. At most 24, at least 60 seconds (1/60 hour). The deadline cannot be extended. |
| `--json` | off | Print one line of JSON with `name`, `machine`, `remoteControlName` and `attach` instead of the usual text. |

If neither `--task` nor `--task-file` is given, the coordinator starts without a task. The command fails with a message if no coordinator image has been saved.

Example:

```
cloudy-cloud coordinator start docs-fleet --repo https://github.com/OWNER/REPO --task-file task.md --max-hours 8
```

#### coordinator attach

Prints the command that opens the coordinator's `tmux` session over SSH. It does not run the command. Copy it into your terminal. It has the form `npx --yes instabox@latest ssh <machine> -- tmux attach -t claude`.

```
cloudy-cloud coordinator attach docs-fleet
```

#### coordinator ls

Lists your coordinators in a table with the columns NAME, STATE, STARTED (CREATED when the output is not a terminal), MACHINE and DELETES. It prints `No coordinators.` when there are none.

```
cloudy-cloud coordinator ls
```

#### coordinator stop

Deletes the coordinator's machine now. Its workers are deleted by the coordinator's cleanup process, or at their own deadline (6 hours by default). Anything the coordinator did not push to GitHub is lost.

```
cloudy-cloud coordinator stop docs-fleet
```

#### coordinator finish

Runs on the coordinator machine, started by the coordinator itself when its work is done. It checks that the working tree in `~/repo` is clean, that the current branch and every `fleet/*` branch are pushed to their upstream, and that none of the coordinator's workers are still running. If all checks pass, it deletes its own machine. If a check fails, it lists the problems and deletes nothing. It refuses to run on a machine that is not a coordinator.

| Flag | Meaning |
|---|---|
| `--force` | Skip the git and worker checks and delete the machine anyway. |

> Warning: `--force` can delete work that has not been pushed. Use it only when you accept losing that work.

### cloudy-cloud mcp

```
cloudy-cloud mcp add NAME [--allow-literal]
cloudy-cloud mcp ls
cloudy-cloud mcp rm NAME
```

Chooses which of your Claude Code MCP servers cloud subagents get. `add` copies one server from your Claude Code settings (local, project or user scope) to `~/.config/cloudy-cloud/mcp.json`, replaces a secret value with `${MCP_<NAME>_TOKEN}` and prints the `npx --yes instabox@latest secrets set ... --host ...` command that stores the value once in Instabox. `ls` lists the saved servers and the secrets they need. `rm` removes one. Only `https` servers on public hosts and `npx` or `uvx` servers are accepted; a refused server prints `Not added: REASON` and exits with status 1. `--allow-literal` asks you to confirm and then copies the real token to the machines instead of using an Instabox secret. All of this is described in [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

## Tools Claude uses (MCP)

`cloudy-cloud` adds an MCP server named `cloud` to the session. Claude sees its tools as `mcp__cloud__cloud_agent` and so on. The session is configured to allow these five tools without asking and to deny the built-in `Agent` and `Workflow` tools. You normally ask for subagents in plain language and Claude calls the tools. This section is for when you want to know exactly what each tool takes.

In a terminal Claude Code session that supports MCP tasks, `cloud_agent` and `cloud_agent_message` run as background tasks. Their progress shows in `/tasks` and the result arrives on its own with the agent id, so Claude does not need `cloud_agent_wait`. In other clients these two tools return an agent id at once and Claude calls `cloud_agent_wait`. The server also answers the task methods `tasks/get` and `tasks/cancel`.

### cloud_agent

Starts a Claude subagent in a remote sandbox on the committed and tracked files of the current repository. It does not include untracked files. The repository needs a `github.com` origin. The call returns at once while the sandbox starts and the task runs. The agent pushes its work to the origin branch `cloudy-cloud/<id>`. Nothing is copied into your local repository. The agent stays open for follow-ups until it is stopped or has been idle for 60 minutes.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `prompt` | string | yes | none | The full task for the subagent. |
| `description` | string | yes | none | A short label for the task. |
| `model` | string | no | the Claude default | A Claude model name, such as `haiku`. For a non-Claude model, use `profile` instead. It may contain only letters, digits and `. _ : -`. When `profile` is also set, `/` is allowed too. |
| `profile` | string | no | Claude | Runs the worker on another model. Built in: `glm`, `deepseek`, `particle`, `pi-glm`, `pi-deepseek`, `pi-particle`, `omp-glm`, `omp-deepseek`, `omp-particle` and `openrouter`. You can add names in `profiles.json`. An unknown name, or a profile whose key is missing, makes the call fail at once. See [Models and keys](https://cloudycloud.tech/docs/models.html). |
| `role` | string, `worker` or `coordinator` | no | `worker` | A worker does the task. A coordinator also gets cloudy-cloud installed and can start its own cloud agents, limited by `CLOUDY_CLOUD_MAX_DEPTH` (default 3). A coordinator cannot use a `pi-` profile. |
| `subagent_type` | string | no | none | The name of an agent to run, passed to Claude Code as `--agent`. It may contain only letters, digits and `. _ : -`. |

When `~/.config/cloudy-cloud/mcp.json` holds at least one valid server, a Claude subagent (not a `pi` profile) starts with `--mcp-config` for that file and `--strict-mcp-config`, so a repo's own `.mcp.json` is not loaded on the machine. The reply ends with an `MCP servers:` line. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

The call is refused if the session has already started `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` agents (default 200), or if the folder is not a git repository with at least one commit and a `github.com` origin.

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

Lists every agent with its id, description, status, idle minutes and progress (tool uses, tokens, elapsed time and current step). The tool is read-only and takes no parameters.

### cloud_agent_stop

Stops agents and deletes their sandboxes. It is safe to repeat, and safe to call with ids that do not exist. Stop agents when they are finished, because they stay open until stopped or idle for 60 minutes.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent_ids` | array of strings | yes | none | The agent ids to stop. |

### Limits that apply to the tools

- An agent that is idle for 60 minutes is stopped. Every agent is stopped when the session ends.
- A single task is stopped after 29 minutes.
- Machines start at most `CLOUDY_CLOUD_STARTS_PER_MIN` times a minute. Agents waiting for a machine show the status `queued`.
- Instabox deletes every machine the tool creates after `CLOUDY_CLOUD_WORKER_HOURS` hours, even if `cloudy-cloud` has died.

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

> Note: The launcher only checks the config file for the Claude token, not the environment, so save it there with `cloudy-cloud setup`. The Instabox key can come from either place.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDY_CLOUD_CONFIG` | `~/.config/cloudy-cloud/env` | Path of the config file. |
| `CLOUDY_CLOUD_PROVIDER` | `instabox` | Sandbox provider: `instabox` or `self-hosted`. |
| `CLOUDY_CLOUD_SSH_HOST` | none | Self-hosted: the SSH address of your machine, `user@host`. |
| `CLOUDY_CLOUD_SSH_KEY` | none | Self-hosted: path to the SSH key. Optional. |
| `CLOUDY_CLOUD_SSH_PORT` | the SSH default | Self-hosted: the SSH port, when it is not the default. |
| `CLOUDY_CLOUD_CONTAINER_RUNTIME` | `docker` | Self-hosted: `docker` or `podman`. |
| `CLOUDY_CLOUD_CONTAINER_BIN` | none | Self-hosted: absolute path of the `docker` or `podman` program on the machine. Setup finds and saves it. |
| `CLOUDY_CLOUD_SELF_HOSTED_SLOTS` | 2 if unset; setup suggests half the CPUs or one per 4 GB of memory, whichever is lower | Self-hosted: how many subagents run at once. |
| `CLOUDY_CLOUD_SELF_HOSTED_CPUS` | 2 if unset | Self-hosted: CPU limit per container. Setup saves a value. |
| `CLOUDY_CLOUD_SELF_HOSTED_MEMORY` | 4g if unset | Self-hosted: memory limit per container. Setup saves a value. |
| `CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX` | unset | Self-hosted: `yes` means you allowed the GitHub token inside worker containers on your machine. Without it, workers do not start. |
| `CLOUDY_CLOUD_PROFILES` | `~/.config/cloudy-cloud/profiles.json` | Path of the file that adds or overrides model profiles. |
| `CLOUDY_CLOUD_MCP` | `~/.config/cloudy-cloud/mcp.json` | Path of the file that lists the MCP servers cloud subagents get. If the file is missing, no servers are sent. |
| `CLOUDY_CLOUD_EVENTS` | `~/.config/cloudy-cloud/events.jsonl` | Path of the event log that the dashboard reads. Set it in the environment before you start `cloudy-cloud` and the dashboard. |
| `CLOUDY_CLOUD_WORKER_HOURS` | 6 | Hours until the server deletes a worker or nested coordinator machine. At most 24. A value that is not a positive number uses 6. |
| `CLOUDY_CLOUD_STARTS_PER_MIN` | 25 | The most machine starts per minute. Extra agents wait in the queue. |
| `CLOUDY_CLOUD_MAX_INSTABOX_CALLS` | 24 | The most Instabox command and file requests that run at once. Instabox's own limit is 32. |
| `CLOUDY_CLOUD_MAX_DEPTH` | 3 | How many levels of coordinators can exist below your session. Starting a coordinator past this is refused. Workers do not add depth. Passed down to child coordinators. |
| `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` | 200 | How many agents one cloudy-cloud session may start. Passed down to child coordinators. |
| `CLOUDY_CLOUD_CHECK_SECONDS` | 60 | Setup only: how long to wait for the test request that checks your Claude token. |
| `CLOUDY_CLOUD_NO_ANIMATION` | unset | Setup only: set to `1` to skip the animated banner. The banner is also skipped when `CI` is set or there is no terminal. |
| `MCP_TOOL_TIMEOUT` | 1800000 | Claude Code's timeout for one MCP tool call, in milliseconds. The launcher sets it only if you have not. |
| `NO_COLOR`, `CLICOLOR=0`, `TERM=dumb` | unset | Any of these turns off colour and the animated setup display. Output is plain text with the same messages. |

> Note: You can set `CLOUDY_CLOUD_STARTS_PER_MIN`, `CLOUDY_CLOUD_MAX_INSTABOX_CALLS`, `CLOUDY_CLOUD_WORKER_HOURS`, `CLOUDY_CLOUD_MAX_DEPTH` and `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` in the config file as well as in the environment.

### Files

| Path | What it holds |
|---|---|
| `~/.config/cloudy-cloud/env` | The config file. One `NAME=value` per line, mode 600. `cloudy-cloud setup` writes it. Only the settings and keys listed above are read from it, plus `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT`, which `coordinator image --save` writes. Change the location with `CLOUDY_CLOUD_CONFIG`. |
| `~/.config/cloudy-cloud/profiles.json` | Optional. Adds or overrides model profiles. See [Models and keys](https://cloudycloud.tech/docs/models.html). |
| `~/.config/cloudy-cloud/mcp.json` | Optional. The MCP servers that cloud subagents get, in Claude Code's `mcpServers` format, mode 600. `cloudy-cloud mcp add` writes it. Secret values are stored as `${MCP_<NAME>_TOKEN}` references unless you used `--allow-literal`. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html). |
| `~/.config/cloudy-cloud/events.jsonl` | The event log. The MCP server appends one JSON line per agent event (agent, message, machine, status, progress, reply). The file has mode 600 inside a folder with mode 700. It holds your prompts and replies, so it stays on your computer. Key-shaped text is redacted before writing, and each text is cut at 20,000 characters. It is never rotated: delete it to clear the history. The dashboard reads the newest 16 MB. |
| `~/.config/cloudy-cloud/owner` | An id the MCP server writes next to the config file, so `coordinator finish` can tell which running machines are its workers. You do not need to edit it. |

If you used the tool under its old name, claude-cloud, the first run copies `~/.config/claude-cloud` to `~/.config/cloudy-cloud` and renames the `CLAUDE_CLOUD_` keys in the config file. The old folder is left in place.
