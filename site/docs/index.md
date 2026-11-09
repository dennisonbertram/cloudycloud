# Getting started

> Install Cloudy Cloud, start a session and run your first subagent on a cloud machine.

Source: https://cloudycloud.tech/docs/

Cloudy Cloud runs each Claude Code subagent on its own cloud machine, with a copy of your repo and its own branch. You stay in your local Claude Code session and fetch the finished work from GitHub.

## Before you start

You need these accounts and tools:

- **An Instabox account.** Instabox is the cloud provider supported today. The free plan is too small for more than a few subagents at once; swarms need a paid plan.
- **A Claude subscription or an Anthropic API key.** Subagents use a long-lived token from `claude setup-token`. An API key works too but is billed separately.
- **A GitHub repository you can push to.** The repo you work in must have a `github.com` remote named `origin`.
- **On your computer:** macOS or Linux (tested on macOS), `git`, Node.js 20 or later, `npm`, `curl`, and [Claude Code](https://code.claude.com) signed in.

## Install

### Run the installer with npx

```
npx -y cloudycloud setup
```

The `-y` skips npm's own "Ok to proceed?" question. Without it, npm asks that first; answer `y`.

### Or add the skill and ask Claude

```
npx skills add dennisonbertram/cloudycloud
```

Then ask Claude to "set up Cloudy Cloud". Claude checks your tools and asks you to run `npx -y cloudycloud setup` yourself, because setup asks for secret keys that Claude should not see.

### From source

```
git clone https://github.com/dennisonbertram/cloudycloud.git
cd cloudycloud
./install.sh
```

Run it in a terminal. It asks for keys, so it does not work from a pipe. It checks your tools, offers to install `cloudy-cloud` onto your PATH (`npm install -g cloudycloud` for the npx route, `npm link` from source). If an older `cloudy-cloud` command is already installed, setup says so and offers to replace it; if npm still fails, setup prints the fix commands and carries on, and you can use `npx cloudycloud` instead, copies the Cloudy Cloud skills into `~/.claude/skills/`, and then asks for three keys. Cloud coordinators are set up only from source for now. Nothing shows as you paste, and only the last four characters are printed back.

| Key | Where to get it |
|---|---|
| Instabox API key (`ibk_…`) | Create it at [dashboard.instabox.sh](https://dashboard.instabox.sh/dashboard/api-keys). The installer checks it with Instabox before saving. |
| Claude token (`sk-ant-oat01-…`) | Run `claude setup-token` in another terminal, or press Enter at the Claude step and let the installer get it. Your own `claude` login is not changed. |
| GitHub token | Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to the repos you will use, with Contents set to read and write. The Instabox command-line tool asks for it. |

The Instabox key and Claude token are saved in `~/.config/cloudy-cloud/env`. The folder has mode 700 and the file is readable only by your user. The GitHub token is stored in Instabox as the secret `GH_TOKEN`. A subagent's machine only gets a placeholder, never the token.

Later, `cloudy-cloud setup` runs the installer again from any folder. It shows each saved key masked and asks before replacing it. Restart any open session to use new keys.

> Warning: Subagents can push to any branch your GitHub token reaches. Add a branch ruleset that blocks direct pushes to your main branch (GitHub: Settings, Rules, Rulesets).

## Start a session

Run `cloudy-cloud` from inside your repo, instead of `claude`. If you skipped the global install, run `npx cloudycloud` instead; everything below works the same:

```
cd <your repo>
cloudy-cloud
```

This is an ordinary Claude Code session with one change: the built-in `Agent` tool is turned off, and every subagent goes to a cloud machine through the `cloud_agent` tools. Plain `claude` is unaffected. If a key is missing, `cloudy-cloud` says `cloudy-cloud is not set up yet` and offers to run setup. If the folder is not a git repo, or has no `github.com` origin, it warns you that subagents cannot start or push.

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

## Your first subagent

Ask in plain language. This prompt is the runbook's check that everything works:

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

> Note: Subagents see only files tracked by git, including uncommitted edits to tracked files. They do not see untracked files, your local MCP servers or your settings.

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
