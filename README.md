# Cloudy Cloud

Cloudy Cloud is open-source software (MIT license, install with `npx cloudycloud setup`) that gives every Claude Code subagent its own cloud machine, a copy of your repo, and its own branch.

[![npm version](https://img.shields.io/npm/v/cloudycloud)](https://www.npmjs.com/package/cloudycloud)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-cloudycloud.tech-5b6cff)](https://cloudycloud.tech/docs/)

[Website](https://cloudycloud.tech) · [Docs](https://cloudycloud.tech/docs/) · [npm](https://www.npmjs.com/package/cloudycloud)

![The Cloudy Cloud website: "Your subagents, up in the clouds", with the setup command npx -y cloudycloud setup](https://raw.githubusercontent.com/dennisonbertram/cloudycloud/feat/claude-cloud/docs/images/website.jpg)

You run `cloudy-cloud` instead of `claude`. It starts an ordinary Claude Code session. When that session uses a subagent, the subagent runs as its own Claude Code on its own cloud machine. It commits and pushes its work to a branch on your GitHub repo, and it stays open for follow-up messages until it is stopped. Plain `claude` is not affected.

## Why

Subagents that run on your laptop share its CPU, memory and network. Ten of them building, testing and installing packages at once can slow your own work down. With Cloudy Cloud each subagent runs on a separate cloud machine, so your laptop stays free for you, and a subagent that runs a long build or test does not compete with the others. Each subagent also gets its own branch, so parallel work does not collide in one working folder.

## Quick start

Requirements:

- **Accounts:** an [Instabox](https://instabox.sh) account (the cloud provider supported today; its free plan is too small for more than a few subagents at once), a Claude subscription (setup makes a long-lived token with `claude setup-token`) or an Anthropic API key (add `ANTHROPIC_API_KEY=...` to `~/.config/cloudy-cloud/env` yourself; setup only asks for the token), and a GitHub repo you can push to.
- **On your computer:** macOS or Linux (tested on macOS), `git`, Node.js 20 or later, `npm`, `curl`, and [Claude Code](https://code.claude.com) signed in.

Run setup once, in a terminal:

```sh
npx -y cloudycloud setup
```

(`-y` skips npm's "Ok to proceed?" question. If `npm install -g cloudycloud` fails with `EEXIST`, the old `cloudy-cloud` package left a link in npm's global `bin` folder: remove the file named in the error with `rm <that path>`, then run `npm install -g cloudycloud` again. Setup offers to remove it for you.) Setup checks your tools, offers to install the `cloudy-cloud` command (`npm install -g cloudycloud`), copies the Cloudy Cloud skills into `~/.claude/skills/`, and asks for three keys, with a note on where to get each one:

| Key | Where to get it |
| --- | --- |
| Instabox API key (`ibk_...`) | [dashboard.instabox.sh](https://dashboard.instabox.sh/dashboard/api-keys). Setup checks it with Instabox before saving. |
| Claude token (`sk-ant-oat01-...`) | `claude setup-token`, or press Enter at that step and let setup get it. Your own `claude` login is not changed. |
| GitHub token | A [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to the repos you will use, with Contents, Pull requests and Workflows set to read and write (Workflows lets a subagent push `.github/workflows`), and Actions set to read (so it can see CI). It is stored in Instabox as the secret `GH_TOKEN`. |

Setup also has optional steps for model provider keys (Particle.ai, OpenRouter). The Instabox key is saved in `~/.config/cloudy-cloud/env` (setup creates the folder with mode 700 and writes the file with mode 600) and stays on your computer. The Claude token and the provider keys are stored as Instabox proxy secrets, so worker machines see a placeholder; setup asks before moving keys that are already in the env file. Run `cloudy-cloud setup` again from any folder to change a key.

![Terminal showing npx cloudycloud setup: the tools check, the skills copied, and the Instabox key prompt](https://raw.githubusercontent.com/dennisonbertram/cloudycloud/feat/claude-cloud/docs/images/setup.jpg)

You can also run `npx skills add dennisonbertram/cloudycloud`, then ask Claude to "set up Cloudy Cloud". Claude checks your tools and asks you to run the setup command yourself, because setup asks for secret keys.

Protect your main branch before you start. A subagent can push to any branch your GitHub token can reach, so add a branch ruleset that blocks direct pushes to it (GitHub: Settings, Rules, Rulesets).

**Start a session** from inside a git repo that has a `github.com` origin:

```sh
cd <your repo>
cloudy-cloud          # or: npx cloudycloud, if you skipped the global install
```

**Run your first subagent.** Ask in plain language:

```
use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
```

Claude starts the subagent and returns at once. The answer ends with `Pushed to origin cloudy-cloud/<id> at <sha>`. For several at once, ask for "10 subagents that ...".

**Get the work back.** Nothing is copied into your local repo automatically. Each subagent pushes to its own branch:

```sh
git fetch origin cloudy-cloud/<id>
git show FETCH_HEAD:proof.txt
```

Then merge, cherry-pick or open a pull request with ordinary git. To fetch every subagent branch at once:

```sh
git fetch origin 'refs/heads/cloudy-cloud/*:refs/remotes/origin/cloudy-cloud/*'
```

![Terminal output: three agents each pushed a branch named cloudy-cloud/<id>, with one commit that changes README.md](https://raw.githubusercontent.com/dennisonbertram/cloudycloud/feat/claude-cloud/docs/images/results.jpg)

To run once without the interactive UI, pass `-p`. Nobody is there to approve permission prompts, so allow the commands you need:

```sh
cloudy-cloud -p "<prompt>" --allowedTools "Bash(git fetch *)" "Bash(git show *)"
```

If a key is missing, `cloudy-cloud` says so and offers to run setup. If the folder is not a git repo, or has no `github.com` origin, it warns you that subagents cannot start or push.

## How it works

1. You ask your session for a subagent. The built-in `Agent` tool is turned off, so the request goes to the `cloud_agent` tool.
2. Cloudy Cloud creates a cloud machine and uploads a snapshot of your repo: files tracked by git, including uncommitted edits to tracked files, but not untracked files.
3. Claude Code starts on the machine on a new branch, `cloudy-cloud/<id>`, and does the task.
4. The subagent commits and pushes to your GitHub repo. The call returns an MCP task, so you can watch it in `/tasks` (Claude Code 2.1.304 or later, terminal session). Elsewhere Claude calls `cloud_agent_wait`.
5. You fetch the branch. You can send follow-up messages to the open subagent first.

```
your computer                              cloud machine (one per subagent)
+--------------------------+   task      +------------------------------+
| cloudy-cloud session     |-----------> | Claude Code on a copy of     |
|  (your normal login)     |<----------- | your repo, branch            |
|                          |   answer    | cloudy-cloud/<id>            |
+--------------------------+             +--------------+---------------+
            ^                                           | git push
            | git fetch origin cloudy-cloud/<id>        v
            +------------------------------------ GitHub (your repo)
```

**How long a machine lives:**

| What ends it | When |
| --- | --- |
| `cloud_agent_stop` | Immediately. |
| Idle timeout | 60 minutes after the subagent went idle. |
| Session end | When you quit Claude Code, every open machine is deleted. A separate cleanup process does the same after a hard kill. |
| Delete deadline | Instabox deletes the machine at a fixed time in any state. The default is 6 hours (`CLOUDY_CLOUD_WORKER_HOURS`, at most 24). It cannot be extended. |

Only work a subagent has pushed to GitHub survives if its machine is lost. A single turn of Claude on the machine is stopped after 29 minutes (machine start-up and queueing are not counted).

Many subagents at once are paced for Instabox's limits. A subagent waiting for a machine shows the status `queued`. Your plan's machine limit still caps how many run at the same time. More in [How it works](https://cloudycloud.tech/docs/how-it-works.html).

## Providers

Cloudy Cloud selects its sandbox provider with `CLOUDY_CLOUD_PROVIDER`: `instabox` (the default) or `self-hosted`. A provider must keep the GitHub token behind proxy secrets or, on your own machine, have your consent to store it there. It must also enforce a delete deadline and forward ports for `cloudy-cloud open`. See the [sandbox provider research](docs/research/sandbox-providers.md) for other options.

## Run on your own machine

Instead of Instabox, subagents can run in Docker containers on a Mac or Linux computer you own, reached over SSH (for example through Tailscale).

```sh
cloudy-cloud setup --provider self-hosted
cloudy-cloud doctor
```

Setup asks for the SSH address (`user@host`), an optional SSH key, how many subagents may run at once, and whether to allow your GitHub token inside the worker containers on that machine. It builds the worker image there and saves the settings. `doctor` checks the machine afterwards.

- **A Mac needs** Remote Login turned on, an SSH key, Docker Desktop or OrbStack running, and sleep turned off.
- **The GitHub token** must be stored in each worker container while it runs. Setup asks for your consent once. Workers do not start without it.
- **Coordinators:** `cloudy-cloud coordinator image` signs in once on a container and saves it with `docker commit --pause=true` as the image `cloudy-cloud-coordinator:<name>`. The image keeps the Claude login but not `/run/secrets`, which is a tmpfs, so no token is saved. `coordinator start` creates a container from that image. Coordinators on the self-hosted provider need one more consent in `cloudy-cloud setup --provider self-hosted` ("Coordinators on <host> can start containers through Docker, which gives them full control of Docker on that machine. Allow?"). A coordinator container then gets the machine's Docker socket and starts its workers as sibling containers, so no SSH key is copied onto it. They are covered by unit tests and the opt-in local test, but have not been run live on a real Mac Studio yet.
- **Not supported:** `cloudy-cloud open --share`, `cloudy-cloud display` and machine kinds other than `linux`.

Details are in [docs/RUNBOOK.md](docs/RUNBOOK.md#9-your-own-machine) and [Run on your own machine](https://cloudycloud.tech/docs/self-hosted.html).

## Dashboard

```sh
cloudy-cloud dashboard
```

This opens a read-only web page on your own machine (`127.0.0.1`) that lists every subagent and coordinator with its status. For subagents started from your session it also shows the model, branch, deadline and the messages between your session and the subagent. Cloud coordinators and machines with no local log show only their status. Add `--demo` to see sample data, `--no-open` to only print the link, or `--port N` to pick a port (default 4477).

![Dashboard in list view with demo data: a list of subagents on the left and the activity of one running subagent on the right](https://raw.githubusercontent.com/dennisonbertram/cloudycloud/feat/claude-cloud/docs/images/dashboard.jpg)

![Dashboard in fleet view with demo data: one card per subagent, grouped as Needs you, Active and Finished](https://raw.githubusercontent.com/dennisonbertram/cloudycloud/feat/claude-cloud/docs/images/dashboard-fleet.jpg)

Both screenshots show demo data (`--demo`). Details: [Dashboard and app previews](https://cloudycloud.tech/docs/dashboard.html).

### Kinds of machines

`cloud_agent` takes an optional `machine` argument. The default, `linux`, is the standard machine. The others are Instabox templates for work that needs a device or a desktop. Your Instabox plan must include the template; if it does not, the call fails with a message that says so.

| `machine` | What it is | Price | Consent needed | Display |
| --- | --- | --- | --- | --- |
| `linux` (default) | Standard machine | Your plan | no | no |
| `android` | Android emulator with `adb`, for running or testing an Android app | Not checked | no | yes |
| `gpu`, `gpu:TYPE`, `gpu:TYPE:COUNT` | NVIDIA GPU machine (one L4 by default; COUNT is 1 to 4 (Instabox's limit for an L4)) for training, inference and CUDA builds | $0.765 per GPU-hour (NVIDIA L4) | yes | yes |
| `omarchy` | Omarchy Linux (Hyprland desktop) | Not checked | no | no (see below) |
| `macos`, `macos:MODEL` | Mac (`m2`, `m2pro`, `m4`, `m4pro`) for Xcode builds. Experimental, not yet run live | $0.45 to $1.25 per hour by model, 24-hour minimum lease | yes | not verified |

Prices are Instabox's, from [instabox.sh/docs/account/pricing.md](https://instabox.sh/docs/account/pricing.md); check it before relying on a number. `gpu` and `macos` are refused until you name them in `~/.config/cloudy-cloud/env`, for example `CLOUDY_CLOUD_ALLOW_MACHINE_KINDS=gpu` (add only the kinds you want). Without it the call starts nothing and tells Claude to ask you. Live facts (2026-11-15, one run each): the android desktop started in about 1 second; the first desktop start on a `gpu` machine took about 2 minutes; `omarchy` runs Hyprland, which the Instabox desktop API does not support yet, so `display` and `--screenshot` are refused there, while `shell` works. More: [docs/research/machine-kinds.md](docs/research/machine-kinds.md).

### Looking inside a cloud machine

`cloudy-cloud shell <agent-id-or-machine>` opens an interactive shell on the machine. `cloudy-cloud shell <agent-id-or-machine> -- <command>` runs one command, streams its output and exits with the command's exit code. Each argument after `--` reaches the machine unchanged. Do not put secrets in the command.

`cloudy-cloud display <agent-id-or-machine>` prints a link to the machine's desktop (`android`, `gpu`, `macos`) and nothing else on stdout. The link is view-only and lasts 1 hour by default.

| Flag | Meaning |
| --- | --- |
| `--control` | Let the viewer click and type. |
| `--ttl SECONDS` | Link lifetime, 60 to 86400. |
| `--screenshot FILE` | Write a PNG of the screen to a new file and print its path. Use it when there is no browser tool. |
| `--unshare` | Cut off every display link for the machine, including viewers already connected. |

Anyone with the link can see the screen, so treat it like a password: do not paste it into a PR, an issue, a report or a log. Open it in a browser tool, for example `agent-browser open "$(cloudy-cloud display <id>)"`. The first desktop start on a `gpu` machine takes about 2 minutes.

### Reaching an app on a cloud machine

`cloudy-cloud open <agent-id-or-machine> <port>` opens a private tunnel from `http://127.0.0.1:<port>` on your computer to that port on the subagent's machine. Use the agent id from `cloud_agent_list` (the `<id>` in the branch name). `LOCAL:REMOTE` picks a different local port. `--share` publishes a private link instead (anyone with the link can open the app), and `--unshare` removes it. It never publishes publicly.

Start the app in the background on the machine (`nohup npm run dev > /tmp/dev.log 2>&1 &`), because a turn's foreground processes end with the turn. The tunnel or link stops when the machine is deleted.

## Models and keys

You bring your own keys and your own cloud account. Your session stays on Claude. A subagent runs Claude by default, and can run another model through a profile. Ask in plain language ("use a glm subagent for this"); `cloud_agent` takes an optional `profile`. Follow-up messages reuse the subagent's profile.

| Profile | Harness | Provider and model |
| --- | --- | --- |
| `glm` | Claude Code through a LiteLLM gateway on the machine | Particle.ai, `z-ai/glm-5.3-flash` |
| `deepseek` | Claude Code through a LiteLLM gateway | Particle.ai, `deepseek-ai/deepseek-v41-flash-1017` |
| `particle` | Claude Code through a LiteLLM gateway | Particle.ai, `particle-ai/particle-1` |
| `pi-glm`, `pi-deepseek`, `pi-particle` | The [pi coding agent](https://pi.dev), no gateway | The same three Particle.ai models |
| `omp-glm`, `omp-deepseek`, `omp-particle` | The [oh-my-pi](https://github.com/can1357/oh-my-pi) coding agent (`omp`), no gateway | The same three Particle.ai models |
| `openrouter` | Claude Code, direct | OpenRouter (`https://openrouter.ai/api`); no built-in model, so pass `model` per call or set it in `profiles.json` |

- **Keys:** setup has optional steps for `PARTICLE_API_KEY` ([platform.particle.ai](https://platform.particle.ai)) and `OPENROUTER_API_KEY` ([openrouter.ai/keys](https://openrouter.ai/keys)). You paste an API key; signing in with OpenRouter or ChatGPT is not available. A profile whose key is missing makes `cloud_agent` fail at once.
- **omp profiles:** oh-my-pi is a fork of pi rewritten as a coding-first agent (it adds LSP, persistent Python and Bun kernels, subagents and many providers). Each omp worker installs the pinned `omp` v18.18.7 binary (about 243 MB) with the official installer, so an omp worker starts slower than a pi or Claude worker. In one live check the whole omp worker setup (clone, first push, omp install and config) took about 20 seconds from machine creation to running, against 11 seconds for a pi worker started at the same time (one run each). Workers only, not coordinators.
- **Your own profiles:** put them in `~/.config/cloudy-cloud/profiles.json` (or the path in `CLOUDY_CLOUD_PROFILES`). They add to or override the built-ins. An optional `"harness"` is `"claude"` (the default), `"pi"` or `"omp"`.
- **Security:** an ordinary profile subagent gets that profile's provider key on its machine instead of your Claude token. Coordinators are different; see [Security](#security).

Details and the `profiles.json` format: [Models and keys](https://cloudycloud.tech/docs/models.html).

## MCP servers

Cloud subagents have no MCP servers until you copy some. Copying is opt-in, one server at a time:

```sh
cloudy-cloud mcp add notion
printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host mcp.notion.com
cloudy-cloud mcp ls
```

`mcp add` finds the server in your Claude Code settings, saves it to `~/.config/cloudy-cloud/mcp.json` and prints the exact `secrets set` command for its token. Run that command once with the real token, signed in with `instabox login` (the Instabox API key cannot create secrets). Every subagent you start afterwards gets the server, and the reply ends with a line such as `MCP servers: notion`. Remove one with `cloudy-cloud mcp rm notion`.

Only remote `https` servers on public hosts and `npx` or `uvx` servers are accepted. No OAuth sign-in, no localhost or local paths, no secrets in URLs or arguments, and a `pi` worker skips `sse` servers (pi has no SSE transport). `pi` and `omp` workers get the same servers and the same Instabox token secrets; their file goes to `~/pi-agent/mcp.json` or `~/omp-agent/mcp.json` on the machine, and their reply shows `MCP servers: a, b` for the servers delivered, which does not confirm a connection. Once you have copied a server, a repo's own `.mcp.json` is no longer loaded on the machine. The token stays in Instabox and is added only to requests to the host you named; never store the secret without `--host`. `--allow-literal` is an explicit, confirmed exception that puts the real token on the machine of each subagent you start; a coordinator's own session gets it, but the workers the coordinator starts do not. Details: [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

## Coordinators

A coordinator is a subagent that can start subagents of its own, so one session can run a tree of work and merge the results into one branch. There are two kinds:

- **Nested coordinators:** `cloud_agent` with `role: "coordinator"`. They live as long as a worker. Depth is limited by `CLOUDY_CLOUD_MAX_DEPTH` (default 3) and one session may start at most `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION` agents (default 200).
- **Cloud coordinators:** long-lived sessions on their own machines, so work continues with your laptop closed (`cloudy-cloud coordinator start NAME --repo URL`). The server deletes the machine after `--max-hours` (default and maximum 24).

Both kinds of coordinator work from a git clone or an npm install: a coordinator ships cloudy-cloud to its machine from the checkout, or from the package's published files when there is no checkout. The [cloud-fleet skill](skills/cloud-fleet/SKILL.md) (copied by setup) teaches Claude to keep fleet output manageable: merge worker branches into one `fleet/<topic>` trunk instead of opening 100 PRs. Every machine in a tree counts against your Instabox machine limit. More in [Coordinators and fleets](https://cloudycloud.tech/docs/fleets.html).

## Commands

`cloudy-cloud --help` prints these. Any other arguments go to `claude`. The package installs two command names, `cloudy-cloud` and `cloudycloud`.

| Command | What it does |
| --- | --- |
| `cloudy-cloud` | Starts a Claude Code session with subagents on cloud machines. |
| `cloudy-cloud setup [--check-only] [--provider instabox\|self-hosted]` | Checks your tools and saves your keys. `--check-only` only checks tools. `--provider` picks where subagents run without asking. |
| `cloudy-cloud doctor` | Checks your own machine when subagents run there (`self-hosted`). |
| `cloudy-cloud dashboard [--demo] [--port N] [--no-open]` | Opens the read-only local dashboard. |
| `cloudy-cloud open <agent> <port> [--share\|--unshare]` | Reaches an app running on a cloud machine. |
| `cloudy-cloud shell <agent> [-- command]` | Opens a shell on a cloud machine, or runs one command there. |
| `cloudy-cloud display <agent> [--control] [--ttl S] [--screenshot FILE] [--unshare]` | Prints a link to a machine's desktop, or saves a screenshot. |
| `cloudy-cloud mcp add <name> [--allow-literal]` \| `ls` \| `rm <name>` | Chooses which of your MCP servers cloud subagents get. |
| `cloudy-cloud coordinator ...` | Manages cloud coordinators: `image`, `start`, `attach`, `ls`, `stop`, `finish`. |
| `cloudy-cloud --version` | Prints the version. |

Full reference with every option and environment variable: [Command and tool reference](https://cloudycloud.tech/docs/reference.html).

**Tools Claude uses** (they replace the built-in `Agent` tool in the session):

| Tool | What it does |
| --- | --- |
| `cloud_agent` | Starts a subagent. Returns at once. Optional `size` (VCPUSxGIB, such as `8x16`) picks a bigger Instabox machine when your plan allows it; the default is 4x8. |
| `cloud_agent_message` | Sends a follow-up to an open subagent. |
| `cloud_agent_wait` | Waits for subagents and returns their answers (not needed in task mode). |
| `cloud_agent_list` | Shows every subagent's status and progress. |
| `cloud_agent_stop` | Stops subagents and deletes their machines. |

In a terminal session, `/tasks` lists each subagent with a progress line. Selecting the first task of a subagent and pressing `x` stops the subagent and deletes its machine; cancelling a follow-up message only stops that turn, and the subagent stays open.

## Security

- **GitHub token:** it never reaches the machine. The machine gets a placeholder, and Instabox's proxy swaps in the real token for requests to GitHub. A subagent can still push to any branch the token can reach, so protect your main branch with `cloudy-cloud protect OWNER/REPO`.
- **Claude credential and provider keys:** `cloudy-cloud setup` stores your Claude token, `PARTICLE_API_KEY` and `OPENROUTER_API_KEY` as Instabox secrets limited to their API host (`api.anthropic.com`, `api.particle.ai`, `openrouter.ai`). The machine sees only a placeholder, which Instabox replaces in requests to that host, so a prompt injection can use the key against that host but cannot read it. A subagent on a profile gets the provider key, never the Claude token. On Instabox, a key that is still a plain value in your config file is refused with a message telling you to run `cloudy-cloud setup`; on a self-hosted box, keys go in as values.
- **Instabox API key:** for ordinary subagents it stays on your computer, in the config file and the local server.
- **MCP server tokens:** for servers you add with `cloudy-cloud mcp add`, the token stays in Instabox as the secret `MCP_<NAME>_TOKEN`. The machine sees a placeholder that Instabox replaces in request headers to the host you named, so a subagent can use the token against that host but cannot read it. Create the secret with `--host`; without it, a prompt injection could send the token to any host. With `--allow-literal` the real token is on the machine instead (a coordinator's session, not its workers), and you confirm that at the prompt.
- **Coordinators:** a coordinator starts machines itself, so it needs the Instabox key, your Claude credential and the provider keys that profiles use. On Instabox it gets all of them as placeholders: the Instabox key is stored as the secret `CLOUDY_CLOUD_INSTABOX_API_KEY` (host `api.instabox.sh`), and its config file on the machine holds only the secret names. Other `*_API_KEY` variables in your shell are not sent. A coordinator can still use those keys against their hosts, for example to start machines, so use keys you can revoke.
- **Dashboard:** local only. It listens on `127.0.0.1`, needs a random per-run token in the link, accepts only GET and HEAD requests, and never sends keys to the browser. The event log it reads (`~/.config/cloudy-cloud/events.jsonl`, created with mode 600) can contain your prompts and code, so treat it as private.

See [Troubleshooting, security and FAQ](https://cloudycloud.tech/docs/troubleshooting.html).

## Limits and known issues

- Subagents see only files tracked by git. They cannot see your settings or agents in `~/.claude/agents`. They get MCP servers only if you copy them with `cloudy-cloud mcp add`, and only remote `https` servers on public hosts and `npx` or `uvx` servers can be copied (see [MCP servers](#mcp-servers)).
- An ordinary subagent's own subagents run inside the same machine, not on new ones. Only coordinators start new machines.
- Tested on macOS.
- Two items are still open: the Particle.ai proxy secret is covered by stub tests but not yet proven live end to end, and agent-drive access for workers is not built. See [docs/STATUS.md](docs/STATUS.md) for what has been proven live.
- Task mode (`/tasks`) does not work in the VS Code extension, the desktop app, or `claude -p`. There Claude uses `cloud_agent_wait`.
- Problems? See [Troubleshooting](https://cloudycloud.tech/docs/troubleshooting.html) and [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Uninstall

Delete any leftover machines first: list them with `npx instabox@latest ls` and delete each with `npx instabox@latest rm <name>`. Then:

```sh
npm uninstall -g cloudycloud
```

and remove `~/.config/cloudy-cloud`, `~/.claude/skills/cloud-fleet` and `~/.claude/skills/cloudy-cloud-setup`. If you installed from a git clone, run `npm unlink -g cloudycloud` instead of the first command. Full steps, including deleting the `cloudy-cloud/*` branches on GitHub: [Troubleshooting](https://cloudycloud.tech/docs/troubleshooting.html#faq-uninstall).

## Hosted version

A hosted version is coming. Today Cloudy Cloud is open source and you bring your own keys: your cloud account, your Claude credentials and your GitHub token. There is no date or pricing yet. The design sketch is in [docs/HOSTED-DESIGN.md](docs/HOSTED-DESIGN.md).

## Contributing

```sh
git clone https://github.com/dennisonbertram/cloudycloud.git
cd cloudycloud
npm install
npm test
```

The code is in `src/` (`run-subagent.mjs` is the subagent lifecycle, `mcp.mjs` the tools, `instabox.mjs` the machines, `dashboard.mjs` the dashboard); the launcher is `bin/cloudy-cloud`. Run `npm test` before you open a pull request.

## License

[MIT](LICENSE). Copyright (c) 2026 Dennison Bertram.
