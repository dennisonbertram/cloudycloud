# Getting started

> Install Cloudy Cloud, start a session and run your first subagent on a cloud machine.

Source: https://cloudycloud.tech/docs/

Cloudy Cloud runs each subagent of your coding agent on its own cloud machine, with a copy of your repo and its own branch. You stay in your local session and fetch the finished work from GitHub.

This page applies to every supported main session (Claude Code, Codex, opencode, pi and free-pi) and every worker agent (Claude Code, pi, oh-my-pi, Codex and opencode). Where steps differ by agent, the step says which.

## Before you start

You need these accounts and tools:

- **An Instabox account.** Instabox is the cloud provider supported today. The free plan is too small for more than a few subagents at once; swarms need a paid plan.
- **A credential for each agent you use.** Claude Code workers (the default) use a Claude subscription token from `claude setup-token`, or an Anthropic API key that is billed separately. Workers on another agent use that profile's key instead: `PARTICLE_API_KEY` for pi, oh-my-pi and opencode, `OPENROUTER_API_KEY` for the OpenRouter profiles, and `OPENAI_API_KEY` or a ChatGPT login file for Codex. [Models and keys](https://cloudycloud.tech/docs/models.html#agents) lists them all. A session that uses only non-Claude workers needs no Claude credential.
- **A GitHub repository you can push to.** The repo you work in must have a `github.com` remote named `origin`.
- **On your computer:** macOS or Linux (tested on macOS), `git`, Node.js 20 or later, `npm`, `curl`, and the agent you will start as your main session: [Claude Code](https://code.claude.com) signed in (the default), or Codex, opencode, pi or free-pi (see Start a session with another agent).

## Install

### Run the installer with npx

```
npx -y cloudycloud setup
```

The `-y` skips npm's own "Ok to proceed?" question. Without it, npm asks that first; answer `y`.

### Or add the skill and ask Claude Code

```
npx skills add dennisonbertram/cloudycloud
```

Then ask Claude to "set up Cloudy Cloud". Claude checks your tools and asks you to run `npx -y cloudycloud setup` yourself, because setup asks for secret keys that Claude should not see.

This route is for Claude Code: `npx skills add` installs the skill for Claude Code, and setup copies the `cloud-fleet` and `cloudy-cloud-setup` skills into `~/.claude/skills/`, which only Claude Code reads. Nothing installs them for Codex, opencode, pi or free-pi, and whether those agents can use them has not been checked. If your main session is one of them, run `npx -y cloudycloud setup` yourself in a terminal (above). The session still gets the cloud tools and Cloudy Cloud's built-in instructions for them.

### From source

```
git clone https://github.com/dennisonbertram/cloudycloud.git
cd cloudycloud
./install.sh
```

Run it in a terminal. It asks for keys, so it does not work from a pipe. It checks your tools, offers to install `cloudy-cloud` onto your PATH (`npm install -g cloudycloud` for the npx route, `npm link` from source). If an older `cloudy-cloud` command is already installed, setup says so and offers to replace it; if npm still fails, setup prints the fix commands and carries on, and you can use `npx cloudycloud` instead, copies the Cloudy Cloud skills into `~/.claude/skills/`, and then asks which agents you run locally (claude, codex, opencode, pi, free-pi; Enter accepts the ones it finds on your PATH). It asks only for the keys those agents need. Cloud coordinators are set up only from source for now. Nothing shows as you paste, and only the last four characters are printed back.

| Key | Where to get it |
|---|---|
| Instabox API key (`ibk_…`) | Create it at [dashboard.instabox.sh](https://dashboard.instabox.sh/dashboard/api-keys). The installer checks it with Instabox before saving. |
| Claude token (`sk-ant-oat01-…`), only if you chose claude or want Claude workers | Run `claude setup-token` in another terminal, or press Enter at the Claude step and let the installer get it. Your own `claude` login is not changed. |
| OpenAI key (`OPENAI_API_KEY`), only if you chose codex; optional | Create it at [platform.openai.com](https://platform.openai.com/api-keys), or use your ChatGPT login file instead (see below). It is stored in Instabox as a proxy secret. |
| GitHub token | Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to the repos you will use, with Contents, Pull requests and Workflows set to read and write, and Actions set to read. The Instabox command-line tool asks for it. |

> Note: **No Claude token is needed unless you use Claude.** If you choose only Codex, opencode, pi or free-pi, setup does not ask for a Claude token and does not need the `claude` command. You do need one credential for the workers you will run (an OpenAI, Particle.ai or OpenRouter key, or the Codex login file); setup warns at the end if none is saved. Workers run Claude Code unless `cloud_agent` gets a `profile`, so with no Claude token the host command prints the profile to pass, such as `codex`. You can also skip setup and save the keys by hand: add `INSTABOX_API_KEY=ibk_...` to `~/.config/cloudy-cloud/env`, store the GitHub token with `npx --yes instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com`, then run `cloudy-cloud setup --check-only`. The by-hand route has not been tested end to end.

### Credentials for each worker agent

Setup asks only for the three keys above, plus optional Particle.ai and OpenRouter keys. Set up the rest yourself, once, for the worker agents you use:

| Worker agent and profile | Credential | How to set it up |
|---|---|---|
| Claude Code (no profile) | Claude token or `ANTHROPIC_API_KEY` | Asked by setup (token). The API key is a line in the env file. |
| pi, oh-my-pi and opencode profiles, and Claude Code `glm`, `deepseek`, `particle` | `PARTICLE_API_KEY` | Optional step in setup. |
| `openrouter`, `codex-openrouter`, `opencode-openrouter` | `OPENROUTER_API_KEY` | Optional step in setup. Pass `model` with the OpenRouter model id. |
| Codex `codex` | `OPENAI_API_KEY` | Not asked by setup. On Instabox: `printf %s "$OPENAI_API_KEY" \| npx --yes instabox@latest secrets set OPENAI_API_KEY --host api.openai.com`, then add `OPENAI_API_KEY` to `CLOUDY_CLOUD_PROXY_SECRETS` in the env file. Self-hosted: add `OPENAI_API_KEY=...` to the env file. |
| Codex `codex-chatgpt` | Your ChatGPT login file | Not asked by setup. Run `codex login`, then `install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json`. |

More detail is in [Models and keys](https://cloudycloud.tech/docs/models.html#codex-profiles).

The Instabox key is saved in `~/.config/cloudy-cloud/env` and stays on your computer. The folder has mode 700 and the file is readable only by your user. The Claude token, the provider keys and the GitHub token are stored in Instabox as proxy secrets (for example `GH_TOKEN`), and setup lists their names in `CLOUDY_CLOUD_PROXY_SECRETS`. A subagent's machine only gets a placeholder, never the key. If setup finds a key already in the env file, it asks before moving it into a secret.

Later, `cloudy-cloud setup` runs the installer again from any folder. It shows each saved key masked and asks before replacing it. Restart any open session to use new keys.

> Warning: Subagents can push to any branch your GitHub token reaches. Add a branch ruleset that blocks direct pushes to your main branch (GitHub: Settings, Rules, Rulesets).

## Start a session

Run `cloudy-cloud` from inside your repo, instead of `claude`. The package installs the same command under two names, `cloudy-cloud` and `cloudycloud`; use either. If you skipped the global install, run `npx cloudycloud` instead; everything below works the same:

```
cd <your repo>
cloudy-cloud
```

With no subcommand this is an ordinary Claude Code session with one change: the built-in `Agent` tool is turned off, and every subagent goes to a cloud machine through the `cloud_agent` tools. Plain `claude` is unaffected. If a key is missing, `cloudy-cloud` says `cloudy-cloud is not set up yet` and offers to run setup. If the folder is not a git repo, or has no `github.com` origin, it warns you that subagents cannot start or push.

### Run without the interactive UI

Pass a prompt with `-p` to run once and print the answer. Any argument other than the Cloudy Cloud commands goes to Claude Code:

```
cloudy-cloud -p "use a subagent to run hostname, then report the result"
```

Without a terminal there is nobody to approve permission prompts, so your session cannot run commands such as `git fetch` to check a subagent's branch. Allow the commands you want with `--allowedTools`, or pick a mode with `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` or `plan`):

```
cloudy-cloud -p "<prompt>" --allowedTools "Bash(git fetch *)" "Bash(git show *)"
```

Put `--allowedTools` after the prompt, because it takes a list. See `claude --help` for all options. `cloudy-cloud --help` prints Cloudy Cloud's own help, and `cloudy-cloud --version` prints the version.

## Start a session with another agent

The main session does not have to be Claude Code. Run the subcommand for your agent from inside your repo. The cloud tools are added for that session only, and your own settings for the agent are not edited. All of them need the Instabox key from setup (or the self-hosted settings), and none needs a Claude token.

| Main session | Command | Install the agent first | Status |
|---|---|---|---|
| Claude Code | `cloudy-cloud` | See [code.claude.com](https://code.claude.com) | Verified live |
| Codex | `cloudy-cloud codex` | `npm install -g @openai/codex` | Partly verified: it listed the six cloud tools (codex-cli 0.166.0) |
| opencode | `cloudy-cloud opencode` | `npm install -g opencode-ai` | Verified live |
| pi | `cloudy-cloud pi` | Optional: without `pi` on your PATH it runs a pinned copy through `npx` | Partly verified: MCP connection only, no model turn |
| free-pi | `cloudy-cloud free-pi` | Optional: without `free-pi-cli` on your PATH it runs a pinned copy through `npx` | Partly verified: `mcp list` only |

**Signing in to the agent itself.** Cloudy Cloud does not sign you in to your main agent. Sign in to Codex (`codex login`) or opencode the way you normally do before you start `cloudy-cloud codex` or `cloudy-cloud opencode`. pi and free-pi need a model configured in the agent itself; Cloudy Cloud never passes them a key, and how to configure one has not been checked here. `free-pi-cli` asks for consent the first time it runs, and that needs an interactive terminal, so start it once yourself in a terminal. These logins are separate from the worker credentials in [Models and keys](https://cloudycloud.tech/docs/models.html#agents).

Arguments after the subcommand go to that agent, for example `cloudy-cloud codex exec` uses Codex's non-interactive mode. Codex, opencode and pi cannot receive MCP task results, so the session calls `cloud_agent_wait` to get results; there is no `/tasks` view. In opencode the tools are named `cloud_cloud_agent`, `cloud_cloud_agent_wait` and so on. free-pi writes a `cloud` entry into `~/.free-pi/agent/mcp.json` each time it starts. free-pi can only be a main session, not a worker.

The full status table is in [Models and keys](https://cloudycloud.tech/docs/models.html#verified).

Which agent a *worker* runs is separate from your main session: it is set by the `profile` argument of `cloud_agent`. Any main session can start any kind of worker. See [Models and keys](https://cloudycloud.tech/docs/models.html#agents).

## Your first subagent

These steps are the same on every main session. Ask in plain language. This prompt is the runbook's check that everything works:

```
use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
```

Claude starts the subagent and returns at once. In a terminal session on Claude Code 2.1.304 or later, the footer shows a count such as `3 MCP tasks`, and `/tasks` lists each subagent with a progress line, for example:

```
12 tool uses · 48.2k tokens · 3m10s · Edit src/parser.ts
```

`starting machine…` means the machine is not up yet. When the subagent finishes, its result reaches Claude automatically. In the VS Code extension, the desktop app, or a one-shot `claude -p` run, Claude calls `cloud_agent_wait` instead.

The answer should name a hostname starting with `instabox-sbx-` and end with `Pushed to origin cloudy-cloud/<id> at <sha>`.

The subagent stays open for follow-up messages until it is stopped. It is stopped after 60 idle minutes, and all subagents are stopped when the session ends.

> Note: Subagents see only files tracked by git, including uncommitted edits to tracked files. They do not see untracked files or your settings. They have MCP servers only if you copy them with `cloudy-cloud mcp add`; see [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

## Get the work back

Nothing is copied into your local repo automatically. Each subagent pushes to its own branch, `cloudy-cloud/<id>`. Fetch it:

```
git fetch origin cloudy-cloud/<id>
git show FETCH_HEAD:proof.txt
```

Then check out, merge, cherry-pick or open a pull request from the branch with ordinary git. For example, `git merge FETCH_HEAD` merges what you just fetched. To fetch every subagent branch at once:

```
git fetch origin 'refs/heads/cloudy-cloud/*:refs/remotes/origin/cloudy-cloud/*'
```

## Stop and clean up

Ask Claude to "stop all subagents", which calls `cloud_agent_stop` and deletes their machines. In `/tasks`, select a task and press `x` to stop a single subagent.

- An idle subagent is stopped after 60 minutes.
- Every subagent is stopped when you exit the session.
- Separately, the Instabox server deletes each worker machine after a fixed time (default 6 hours, set by `CLOUDY_CLOUD_WORKER_HOURS`, maximum 24).

> Warning: A deleted machine takes unpushed work with it. Only work the subagent pushed to GitHub survives. Fetch what you need before you exit.

To list leftover machines, run `npx instabox@latest ls`. To delete one, run `npx instabox@latest rm <name>`.

## Next steps

- [How it works](https://cloudycloud.tech/docs/how-it-works.html): what runs where, and what a subagent can see.
- [Models and keys](https://cloudycloud.tech/docs/models.html): run workers on open models.
- [Dashboard and app previews](https://cloudycloud.tech/docs/dashboard.html): watch your machines in a local web page.
- [Troubleshooting, security and FAQ](https://cloudycloud.tech/docs/troubleshooting.html): fix a missing key, a failed push or a queued subagent.
