# Cloudy Cloud runbook

This covers setting up `cloudy-cloud`, using it, operating it day to day, and fixing common problems.

## 1. What you need

This runbook applies to every main session (Claude Code, Codex, opencode, pi, free-pi) and every worker agent (Claude Code, pi, oh-my-pi, Codex, opencode). Steps that differ by agent say so. Commands that start a session use Claude Code unless a section says otherwise.

| Item | Notes |
| --- | --- |
| macOS or Linux | Tested on macOS. |
| `git` and Node.js 20 or later | Check with `git --version` and `node --version`. |
| At least one coding agent | Claude Code, Codex, opencode, pi or free-pi, as your main session. [Claude Code](https://code.claude.com) is needed only if you choose it (as your main session or for Claude workers); check with `claude --version`. You must be signed in. |
| Another main session (optional) | Codex: `npm install -g @openai/codex`. opencode: `npm install -g opencode-ai`. pi and free-pi run through `npx` if they are not installed. They need no Claude token, at run time or in setup. |
| A credential for each worker agent you use | Claude Code workers (the default): a long-lived token from `claude setup-token`, or an Anthropic API key billed separately. pi, oh-my-pi and opencode workers: `PARTICLE_API_KEY`. OpenRouter profiles: `OPENROUTER_API_KEY`. Codex workers: `OPENAI_API_KEY` or a ChatGPT login file (section 2.5). |
| An [Instabox](https://instabox.sh) account | **Free plan:** too small for more than a few subagents at once. **Paid plan:** needed for swarms. |
| A GitHub repository you can push to | Subagents push their branches there. |

## 2. One-time setup

### 2.1 Install and enter your keys

```sh
git clone https://github.com/dennisonbertram/cloudycloud.git
cd cloudycloud
./install.sh
```

Run it in a terminal; it asks for keys, so it will not run from a pipe. It checks `git`, Node.js 20 or later, `npm` and `curl`, runs `npm install`, and links `cloudy-cloud` onto your PATH. If `cloudy-cloud` already points at another folder, it asks before changing that, and the default is to keep the current link. Then it uses the agents it finds on your PATH (it prints `Agents: claude`) and asks only if it finds none; a saved `CLOUDY_CLOUD_AGENTS` is kept. Plain setup asks only for the Instabox key, the Claude sign-in and the GitHub token, Instabox is the provider unless you pass `--provider` or a self-hosted choice is saved. The extras (usage alert emails, Particle.ai and OpenRouter keys, cloud coordinators) are in `cloudy-cloud setup --more`; plain setup never asks about them, even on a configured machine, and saved values are left as they are. The one exception: if no saved credential could start a first worker (no Claude token and no usable provider key), plain setup asks for the keys your agents use. If none is saved, it ends with `Setup incomplete: ... Next: cloudy-cloud setup` and exit status 1 (`--more` when the coordinator image is the unfinished part); any failed step ends the same way. In the `--more` coordinator step, answering yes runs `cloudy-cloud coordinator image` on your terminal: it builds and saves the image (10 to 20 minutes). The image carries no Claude sign-in — each coordinator signs in to Claude for itself when it starts (`coordinator login NAME`). Nothing shows as you paste, and nothing is printed back except the last four characters. 

| Key | Where to get it |
| --- | --- |
| **Instabox API key** (`ibk_…`) | Create it at https://dashboard.instabox.sh/dashboard/api-keys. The script checks it with Instabox before saving. |
| **Claude token** (`sk-ant-oat01-…`), only if you chose claude, or answered `y` to "Also run Claude Code workers" | In another terminal run `claude setup-token`. Your own `claude` login is not changed. |
| **OpenAI key** (`OPENAI_API_KEY`), only if codex is one of your agents; asked in `setup --more` | https://platform.openai.com/api-keys. Or use your ChatGPT login file instead (section 2.5). |
| **GitHub token** | Create a fine-grained token (section 2.3). The Instabox command-line tool asks for it, so `install.sh` never sees it. |

The Claude step runs only when claude is one of your agents, or you want Claude workers. A Codex, opencode or pi user is not asked for a Claude token, and the `claude` command is not required. Such a user needs at least one worker credential, though: setup warns at the end if none is saved (an OpenAI, Particle.ai or OpenRouter key, or the Codex login file). Workers use the Claude harness unless `cloud_agent` gets a `profile`, so a host session with no Claude token tells the agent which profile to pass, and `cloudy-cloud codex|opencode|pi|free-pi` prints the same next step on start. `cloudy-cloud setup --check-only` reads the saved `CLOUDY_CLOUD_AGENTS` (default: claude).

The Instabox key is saved to `~/.config/cloudy-cloud/env`, which only your user account can read; it never leaves your laptop. The Claude token, the optional Particle.ai and OpenRouter keys, and the GitHub token are stored in Instabox as proxy secrets (`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` for `api.anthropic.com`, `PARTICLE_API_KEY` for `api.particle.ai`, `OPENROUTER_API_KEY` for `openrouter.ai`, `GH_TOKEN` for GitHub), so a worker machine sees only a placeholder. Setup lists the stored names in `CLOUDY_CLOUD_PROXY_SECRETS` (comma-separated). Storing a secret, and turning on the usage alert emails (a question in `setup --more`), needs your `instabox login` session; setup runs the login if needed and sends each key on stdin, never on a command line. If a secret cannot be stored, setup says so and keeps that key in the env file instead. After the first install, run `cloudy-cloud setup` at any time (it runs `install.sh` from the folder `cloudy-cloud` was linked from, whatever folder you are in); it shows each saved key as masked and asks before replacing it.

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
- **Permissions:** *Contents*, *Pull requests* and *Workflows*: read and write. *Actions* and *Commit statuses*: read-only. *Metadata*, read-only, is added automatically. Pushing needs only Contents; Autofix needs Pull requests (to open and read the pull request) and Actions and Commit statuses (to read CI results and logs); Workflows lets a subagent push files under `.github/workflows`.
- **Expiration:** your choice. Shorter limits the damage if it leaks.
- `install.sh` runs `npx --yes instabox@latest login` if you are not signed in, then `npx --yes instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com`, and the Instabox tool asks for the token. The name must be exactly `GH_TOKEN`.

#### Rotating keys and moving old ones

- **Rotate a key:** run `cloudy-cloud setup`, answer yes to "Replace it?" and paste the new key. Machines that are already running keep the old value; only new machines get the new one.
- **Keys already in the env file:** when setup finds a real `PARTICLE_API_KEY`, `OPENROUTER_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` line, it asks "Move NAME into an Instabox secret (host H)? [Y/n]". Yes stores it and deletes the line. No changes nothing, and on Instabox a worker that needs that key is then refused (`key_on_machine_refused`) until you store it as a secret: cloudy-cloud never copies a real key to an Instabox machine.
- **Edit a host list:** run `npx --yes instabox@latest secrets set NAME --host HOST ...` again and paste the key (a profile in `profiles.json` that points at a new host needs that host added to its key's secret).
- **Check:** `cloudy-cloud setup --check-only` confirms every name in `CLOUDY_CLOUD_PROXY_SECRETS` exists in your Instabox org with the hosts your profiles use, and prints the fix command if not. It also shows your Instabox usage alert emails (read with the saved key, nothing changed): a warning, never a failure, when they are off.

### 2.4 Protect your main branch

Subagents run with permission checks off and push with your GitHub token, so they act as you. A ruleset that lets admins bypass also lets them bypass it. Run, in the repo:

```sh
cloudy-cloud protect            # or: cloudy-cloud protect owner/repo
```

It shows what it will do and asks first (`--yes` answers for you). It uses your own `gh` sign-in (you must be a repo admin) and creates a ruleset on the default branch: changes need a pull request (0 approvals), no force pushes, no deleting the branch, and no bypass actors. Running it again changes nothing if the branch is already protected. Afterwards your own direct pushes to the default branch are blocked too; changes go through pull requests.

If it stops: run `gh auth login` when `gh` is not signed in; ask a repo admin to run it when you are not one; a private repo on a plan without rulesets needs GitHub Pro or Team, or classic branch protection with "Do not allow bypassing the above settings".

### 2.4 First run

The repo you work in needs a GitHub `origin` that your token can push to:

```sh
cd <your repo>
git remote -v        # should show github.com
cloudy-cloud
```

Setup happens only in `install.sh`. If a key is missing, `cloudy-cloud` prints `cloudy-cloud is not set up yet (...). Run: cloudy-cloud setup`. In a terminal it also asks `Run setup now? [Y/n]` and continues into the session after setup; without a terminal it exits 1.

### 2.5 Other agents (optional)

**Main session.** Run one of these from inside your repo instead of `cloudy-cloud`. Arguments after the subcommand go to that agent. Each needs only the Instabox key from setup at run time, not a Claude token. They add the cloud tools for that session only and do not edit the agent's own config. Codex, opencode and pi cannot receive MCP task results, so the session uses `cloud_agent_wait`.

```sh
cloudy-cloud codex
cloudy-cloud opencode
cloudy-cloud pi
cloudy-cloud free-pi
```

Checked live: Codex (codex-cli 0.166.0 listed the six cloud tools) and opencode. pi: the MCP connection only, no model turn. free-pi: `mcp list` only; it writes a `cloudy-cloud` entry into `~/.free-pi/agent/mcp.json` on each start (a stdio server running `node src/server.mjs`, with a 1,800 s timeout) and refuses to replace a `cloudy-cloud` entry it did not write; remove such an entry with `free-pi-cli mcp remove cloudy-cloud`. Your own `cloud` entry is not touched. free-pi cannot be a worker, because free-pi-cli has no headless mode and its terms forbid scripted use. In opencode the tools are named `cloud_cloud_agent`, `cloud_cloud_agent_wait` and so on.

**Worker profiles.** Pass `profile` to `cloud_agent` (or ask "use a codex subagent"). Coordinators refuse pi, omp, Codex and opencode profiles.

| Agent | Profiles | Credential |
| --- | --- | --- |
| Claude Code (default) | no profile; `glm`, `deepseek`, `particle`; `openrouter` (pass `model`) | Claude token or API key; the profiles use `PARTICLE_API_KEY` or `OPENROUTER_API_KEY` |
| pi | `pi-glm`, `pi-deepseek`, `pi-particle` | `PARTICLE_API_KEY` |
| oh-my-pi | `omp-glm`, `omp-deepseek`, `omp-particle` | `PARTICLE_API_KEY` |
| Codex | `codex`, `codex-chatgpt`, `codex-openrouter` (pass `model`) | `OPENAI_API_KEY`, the ChatGPT login file, `OPENROUTER_API_KEY` |
| opencode | `opencode-glm`, `opencode-deepseek`, `opencode-particle`, `opencode-openrouter` (pass `model`) | `PARTICLE_API_KEY` or `OPENROUTER_API_KEY` |

`cloudy-cloud setup --more` asks for `PARTICLE_API_KEY`, `OPENROUTER_API_KEY` and `OPENAI_API_KEY` (when codex is chosen or installed; it is stored as an Instabox proxy secret for `api.openai.com`). It does not set up the ChatGPT login file. To set the Codex credentials by hand:

- `codex`: on Instabox run `printf %s "$OPENAI_API_KEY" | npx --yes instabox@latest secrets set OPENAI_API_KEY --host api.openai.com`, then add `OPENAI_API_KEY` to `CLOUDY_CLOUD_PROXY_SECRETS` in `~/.config/cloudy-cloud/env`. On a self-hosted machine add the line `OPENAI_API_KEY=...` to that file.
- `codex-chatgpt`: run `codex login` and choose "Sign in with ChatGPT", then `install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json`. The file must have mode 600. It is copied to the worker machine as a file, even on Instabox. If a worker reports a 401, repeat both commands.

**Custom profiles (`profiles.json`).** `~/.config/cloudy-cloud/profiles.json` (or `CLOUDY_CLOUD_PROFILES`) adds profiles or overrides built-in ones. Each entry may set `harness`, the agent that runs the worker: `claude` (the default when the key is absent), `pi`, `omp`, `codex` or `opencode`. Every entry also needs `format` (`openai` or `anthropic`), `baseUrl` and `keyName`; `model` can be given per call instead. Rules:

- `codex`, `omp` and `opencode` need `"format": "openai"`. The `claude` and `pi` harnesses accept either value.
- `codex` also accepts `"auth": "chatgpt"` (the login file) in place of `keyName`.
- `keyName` must look like `NAME_API_KEY`.
- `fallback` (optional) is a list of profile names. When the profile has no key, or the provider refuses a one-token check before the machine starts, the server tries them in order. The `fallback` argument of `cloud_agent` overrides it, and `preflight: false` skips the check.
- `maxConcurrent` (optional) is a positive whole number: the most agents this profile runs at once. Extra agents wait in the queue. `CLOUDY_CLOUD_PROFILE_MAX` sets the same cap for profiles without one. The count covers this server's own agents only.

```json
{ "my-codex": { "harness": "codex", "format": "openai", "baseUrl": "https://api.openai.com/v1", "model": "default", "keyName": "OPENAI_API_KEY" } }
```

Verification status of every agent: see the table in [STATUS.md](STATUS.md#supported-agents-and-what-is-proven). Codex and opencode workers are not verified on a real machine.

### 2.6 MCP servers for subagents (optional)

By default a subagent has no MCP servers. To give it some, copy them from your Claude Code settings, one at a time:

1. Run `cloudy-cloud mcp add <name>`. It looks for `<name>` in your Claude Code local scope, the repo's `.mcp.json`, then your user scope (`~/.claude.json`), shows what it found, and saves the server to `~/.config/cloudy-cloud/mcp.json` (mode 600). Change the path with `CLOUDY_CLOUD_MCP`.
2. If the server sends a token, the command prints a line like this. Run it once, with the real token in `$TOKEN`:

   ```sh
   printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host mcp.notion.com
   ```

   You must be signed in with `npx --yes instabox@latest login`. The Instabox API key in your cloudy-cloud config fails here with `missing_scope: workspace:admin`. Always keep `--host`: without it, Instabox would add the token to a request to any host.
3. Start subagents as usual. The reply ends with `MCP servers: notion`, or `MCP servers: notion, context7 (failed: linear)` when a server did not connect. For pi, omp, Codex and opencode workers the line is `MCP servers: a, b`, the servers delivered; it does not confirm that they connected. `cloud_agent_list` and the dashboard also show the names.

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
- **Large swarms.** Start as many as you need. Starts are paced and queued automatically (the pace comes from your Instabox plan's starts a minute, less 10 %; `CLOUDY_CLOUD_STARTS_PER_MIN` overrides it, and 25 a minute is used when the plan cannot be read), and Instabox requests share `CLOUDY_CLOUD_MAX_INSTABOX_CALLS` slots (default 24). Queued subagents show the status `queued`. Set either variable in the environment, or as `NAME=value` in `~/.config/cloudy-cloud/env`, before you start `cloudy-cloud`.
- **Turn limit.** Each turn is limited to 29 minutes by default. `CLOUDY_CLOUD_TURN_MINUTES` in `~/.config/cloudy-cloud/env` changes it: a whole number from 5 to the provider's machine lifetime in minutes minus 30. The prompt tells the agent when the turn ends. If a turn fails or hits the limit after the agent has started, the agent stays `idle` with its session and machine, and the result is marked as an error: send `cloud_agent_message` ("continue where you stopped"). A Codex or opencode first turn that times out still fails, because only Claude and pi report their session id early. `CLOUDY_CLOUD_PROVIDER_RETRIES` (default 3) sets the retries after a transient provider error in pi, omp, Codex and opencode workers.
- **Start from another commit.** `cloud_agent` takes `base` (a branch name or a 7 to 40 character commit hash). The worker starts from it, not from your local `HEAD`, and uncommitted edits are ignored. A worker that commits nothing pushes no branch; the result says "No changes, no branch pushed." and autofix does not start.
- **Work on a GitHub issue.** `cloud_agent` takes `issue` (workers only): a number like `"12"`, or an issue URL in this repo. The issue title and body are fetched on your computer with `gh` (so `gh` must be signed in) and quoted into the worker's prompt as untrusted text. The worker pushes to `cloudy-cloud/issue-<n>-<id>` instead of `cloudy-cloud/<id>`. With autofix the pull request body says `Fixes #<n>`, so merging it closes the issue.
- **Share a running app.** `cloud_agent` takes `preview_port`: a port from 1 to 65535 where the worker's app is already running on its machine. After a turn that pushed, a share link is published, the same as `cloudy-cloud open <id> <port> --share`, and the result shows `Preview: <url>`. The link is never posted to a pull request. Anyone with the link can open the app until the machine is deleted. It needs a provider with published links, so Instabox. If publishing fails the turn still succeeds and the result gives the manual command.
- **When subagents stop:**
  - when you or the session stops them;
  - after 60 minutes with nothing to do;
  - when the session ends.

  Their machines are deleted at that point. Anything a subagent didn't push is lost with its machine.

## 5. Maintenance

| Task | Command or step |
| --- | --- |
| **List cloud machines** | `cloudy-cloud machines`. Machines created by this tool have the label `purpose=cloudy-cloud`; it lists only those. |
| **Delete a leftover machine** | `cloudy-cloud machines stop <id-or-name>` (`cloudy-cloud machines stop --all` for all of them) |
| **Delete empty or merged subagent branches on GitHub** | `cloudy-cloud branches prune` lists them (dry run); `cloudy-cloud branches prune --yes` deletes them. `cloudy-cloud/issue-<n>-<id>` branches are covered too. |
| **Delete all subagent branches on GitHub** | `git ls-remote --heads origin 'cloudy-cloud/*' \| awk '{print $2}' \| xargs -n 50 git push origin --delete` |
| **Replace a key** (Claude token, Instabox key or GitHub token) | Run `cloudy-cloud setup`, answer `y` for that key, then restart `cloudy-cloud`. A running session keeps the old key until you restart it. |
| **Remove all saved keys** | `rm ~/.config/cloudy-cloud/env` |
| **Update the tool** | `git pull && npm install` in the folder that `install.sh` printed, then restart `cloudy-cloud` |
| **Uninstall** | npm install: `npm uninstall -g cloudycloud`. Git clone: `npm unlink -g cloudycloud` (on a clone from before the rename, also `npm unlink -g cloudy-cloud`), then delete the folder. Then delete `~/.config/cloudy-cloud` and the three skills in `~/.claude/skills` (`cloud-fleet`, `cloudy-cloud-setup`, `cloud-dev`), only those setup installed (a link into the cloudycloud folder, or a copy it made) |

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
| `The GitHub access check for origin cloudy-cloud/<id> failed` (the setup check is `git ls-remote origin HEAD`) | The `GH_TOKEN` secret is missing, or the token can't write to this repo. Run `cloudy-cloud setup` and replace the GitHub token, and check the token's repository list. |
| `the codex command was not found` or `opencode is not installed` | Install the main-session agent: `npm install -g @openai/codex` or `npm install -g opencode-ai`. |
| `Profile NAME needs KEY, which is not set` | The profile's provider key is missing (`PARTICLE_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY`). Run `cloudy-cloud setup --more` for the first two; for `OPENAI_API_KEY` too (see section 2.5). |
| `The Codex ChatGPT login file ... was not found` | Run `codex login`, then `install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json`. |
| `The Codex login file ... can be read by other users` | Run `chmod 600 ~/.config/cloudy-cloud/codex-auth.json`. |
| `coordinator cannot use a pi, omp, codex or opencode profile` | Coordinators always run Claude Code. Start the coordinator without a profile; its workers can use any profile. |
| `The Instabox secret MCP_<NAME>_TOKEN could not be attached` | The MCP token secret does not exist. Create it with `printf %s "$TOKEN" \| npx --yes instabox@latest secrets set MCP_<NAME>_TOKEN --host <host>`, signed in with `instabox login` (section 2.5). |
| `The GH_TOKEN Instabox secret could not be attached` | The secret doesn't exist or is named differently. Run `cloudy-cloud setup` and replace the GitHub token. The name must be exactly `GH_TOKEN`. |
| `Not logged in · Please run /login` or `401` from a subagent | No valid Claude token reached the machine. Run `claude setup-token`, then run `cloudy-cloud setup` and replace the Claude token, and restart `cloudy-cloud`. This also happens if you only have `ANTHROPIC_API_KEY` exported, because some wrappers, such as cmux's `claude`, remove it. |
| `Instabox usage alert emails are off` or `Could not change the alerts` | Instabox emails the workspace's owner and admins at 80% of included usage and when usage goes beyond it. Turn them on with `npx --yes instabox@latest workspace alerts <org-id> --usage 80 --overage on` (needs `instabox login` as the owner or an admin; `<org-id>` is printed in the message). A monthly spend cap, which stops machines when reached, is never set by setup: `npx --yes instabox@latest workspace spend-cap <org-id> <usd>`. |
| A subagent stays `queued` | Your Instabox plan's machine limit (`quota_exceeded`) is full, or starts are waiting for the pace limit. Paused machines count too. It retries every 60 seconds for up to 30 minutes, then fails with Instabox's message. Stop subagents you don't need, delete leftover machines (section 5), or upgrade the plan. |
| A subagent stays `queued` with "waiting for a free machine slot (N running on the pro plan)" | This server already runs as many agents as your plan allows at once (pro 100, builder 200, team 500, free 1). It waits up to 10 minutes for one to stop, then asks Instabox anyway. The Instabox `concurrency_limit` answer is retried every 60 seconds for up to 30 minutes, like `quota_exceeded`. Stop agents you don't need or upgrade: `npx --yes instabox@latest workspace plan <workspace> <next tier>` (needs `npx --yes instabox@latest login`; find `<workspace>` with `npx --yes instabox@latest workspace ls`) or the dashboard billing page. Every queued agent shows this reason in `cloud_agent_list`, `cloud_agent_wait` and the dashboard. |
| `rate_limited` after 5 tries | Instabox kept refusing starts, and Cloudy Cloud already retried for about 10 minutes. Do not retry at once. Stop agents you don't need, or lower `CLOUDY_CLOUD_STARTS_PER_MIN` (the pace normally comes from your plan; this overrides it) and restart `cloudy-cloud`. |
| `quota_exceeded` or `concurrency_limit` failure | Cloudy Cloud already retried for 30 minutes. Stop agents you don't need (`cloud_agent_list`, `cloud_agent_stop`) or upgrade: `npx --yes instabox@latest workspace plan <workspace> <next tier>` (find `<workspace>` with `npx --yes instabox@latest workspace ls`), or the dashboard billing page. |
| `The size 16x32 is not on your Instabox plan (pro)` | The plan does not list that size, but a higher plan does. Use a listed size (pro: 2x4 4x8 8x16; builder adds 16x32; team adds 32x64) or upgrade as in the row above. Nothing was started. |
| `The size 3x5 is not an Instabox size` | No plan offers that size, so an upgrade does not help. Use a size from the message. |
| `size is not available: the <provider> provider has one machine size` | Self-hosted, local and ssh providers have one size. Call `cloud_agent` without `size`. |
| `gpu and macos machines have their own sizes` | `size` cannot be combined with `machine` gpu or macos. Drop `size`, or use `machine` linux. |
| A reply says the plan could not be read | The size was sent unchecked and Instabox may refuse it; `cloud_agent_result` shows the refusal. Check your Instabox key with `cloudy-cloud doctor`. |
| A subagent's work is missing | Only pushed work survives. Check the result for `Push failed` or `Uncommitted changes left in the sandbox`. While the subagent is open, ask it to commit and push. |
| The session uses no subagents, or says `Agent` is unavailable | That's expected: `cloudy-cloud` turns off the built-in `Agent` and `Workflow` tools. Ask for "a subagent" and it uses `cloud_agent`. Plain `claude` still has the built-in tools. |
| A subagent can't use an agent type you defined | Only agents committed in the repo, or built into Claude Code, exist on the machine. Agents in `~/.claude/agents` aren't sent. |

## 7. How it works

1. **The launcher.** `bin/cloudy-cloud` starts Claude Code with three changes (`cloudy-cloud codex|opencode|pi|free-pi` start those agents with the same MCP server instead):
   - the built-in `Agent` and `Workflow` tools turned off;
   - an extra system prompt;
   - an MCP server, `src/server.mjs`, that provides the `cloud_agent_*` tools.
2. **Starting a subagent.** `cloud_agent` takes a snapshot of your repo's tracked files, including uncommitted edits, without touching your working tree. Then:
   - it creates an Instabox machine and attaches the `GH_TOKEN` secret;
   - it uploads the snapshot and checks it out on branch `cloudy-cloud/<id>`;
   - it pushes that branch, then runs the worker agent in the background: `claude -p` by default, or `pi --mode json`, `omp -p --mode json`, `codex exec --json` or `opencode run --format json` for a profile.

   The call returns at once, because Claude Code runs MCP tools one at a time unless they're marked read-only. When the client supports MCP tasks, the call returns a task (id `cc-<agent id>-t<turn number>`, for example `cc-3f2a91bc-t2`). The server detects this from the client capabilities that Claude Code sends with each request on MCP revision 2026-07-28, and the server answers `tasks/get` and `tasks/cancel` for the task.
3. **Getting answers.** In task mode, Claude Code polls `tasks/get` and passes on the result when the task ends. Otherwise `cloud_agent_wait`, which is read-only, collects answers. Follow-ups use `claude -p --resume <session>` on the same machine. The machine runs `claude -p --output-format stream-json --verbose`; the server reads that stream as it arrives to count tool uses and tokens and to find the current step.
4. **After every task.** The tool runs `git push` once more, in case the subagent forgot. It never commits for the subagent; it lists any uncommitted files instead.
5. **Secrets.**
   - **Instabox key:** it stays in `~/.config/cloudy-cloud/env` and the MCP server on your laptop. It never appears in process arguments and never goes to a machine. A coordinator's machine gets the secret `CLOUDY_CLOUD_INSTABOX_API_KEY` (a placeholder; see 8.3).
   - **Claude token and provider keys:** on Instabox they are proxy secrets (`CLOUDY_CLOUD_PROXY_SECRETS` names them). A machine sees only a placeholder, which Instabox swaps for the real key on requests to the key's own host. A real value is never copied to an Instabox machine: a key that is not stored as a secret makes the start fail with `key_on_machine_refused` and the instruction to run `cloudy-cloud setup`. On a self-hosted machine, which has no proxy, the env-file path remains, see section 9.
   - **GitHub token:** it stays in Instabox. The machine sees only a placeholder, which Instabox's proxy replaces on requests to `github.com` and `api.github.com`.
   - **MCP tokens:** for servers added with `cloudy-cloud mcp add`, each token is an Instabox secret named `MCP_<NAME>_TOKEN`, attached in the same call as `GH_TOKEN`. The machine sees a placeholder that Instabox replaces in request headers to the host given with `--host`. With `--allow-literal` the real value is on the machine instead (not on a coordinator's workers).

## 8. Cloud coordinators

A coordinator is a long-lived Claude Code session on its own Instabox machine. It runs `cloudy-cloud` there, so it can start worker machines. You reach it through Remote Control (claude.ai or the Claude app) or SSH, and it keeps working while your laptop is closed.

### 8.1 The coordinator base (no image step)

Remote Control needs a full Claude login. A token from `claude setup-token` can only make model requests, so it cannot open Remote Control sessions. Each coordinator signs in to Claude for itself when it starts, so a copied login's single-use refresh token can never race several coordinators into signing each other out.

New users go straight to `cloudy-cloud cloud` (or `coordinator start`). With no saved image, the coordinator machine is created from the base template `agent-browser`, which already has Claude Code, Node, npm, git and gh; `start` installs tmux, connects GitHub, sets the git identity and uploads cloudy-cloud on every coordinator anyway, so an image saves almost nothing.

`cloudy-cloud coordinator image` is optional and normally unnecessary. It builds a saved image in one run (about 20 minutes): it creates a machine (or reuses a running one), installs `cloudy-cloud`, removes `~/.claude/.credentials.json` before it snapshots, saves the snapshot id as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT` (with `CLOUDY_CLOUD_SNAPSHOT_CLEAN=1`) in `~/.config/cloudy-cloud/env`, and deletes the image machine. It is safe to interrupt (Ctrl-C, a laptop sleep, or the 30-minute wait limit): the pending snapshot is recorded, and running the same command again resumes it without starting a second snapshot. `--save` is accepted as an alias. An image saved by an older cloudy-cloud (no clean marker) holds a Claude sign-in: `start` ignores it, uses the base template and prints a note. Remove that setting with `cloudy-cloud coordinator image --forget`; it changes only the config file and does not delete the snapshot (delete it with `npx instabox snapshot rm ID`).

### 8.2 Commands

| Command | What it does |
| --- | --- |
| `cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO [--branch B] [--task TEXT \| --task-file PATH] [--max-hours N] [--model NAME] [--env FILE]... [--json]` | Creates a machine from the saved clean image, or from the base template when none is saved (labels `role=coordinator` and `install=<this installation's id>`, never pauses), attaches the `GH_TOKEN` secret and the secrets named in `CLOUDY_CLOUD_PROXY_SECRETS` (including `CLOUDY_CLOUD_INSTABOX_API_KEY`), writes the env file (names only), installs your laptop's `cloudy-cloud` there (sent as a git bundle of the checkout's committed state plus tracked uncommitted edits — files named like credentials, untracked files and staged additions are left out), clones the repo, and starts a tmux session `claude` running a launcher (`~/.config/cloudy-cloud/launch.sh`, mode 700) that removes a credentials file an older image may have copied in — once, at the first launch only, so a relaunch never deletes the coordinator's own sign-in — runs `claude auth login` when the coordinator is not signed in, and then execs `cloudy-cloud --remote-control "NAME"`. A fresh coordinator waits at the sign-in until you finish it with `coordinator login NAME` (see below); waiting for sign-in is a normal state and the machine is never deleted for it. With `--task TEXT` or `--task-file PATH` (not empty, at most 100 KB) the task is uploaded to `~/task.md` on the machine and passed as the session's first prompt, so the coordinator starts working at once. `--max-hours N` sets the delete deadline (default and maximum 24; see 8.5). `--model NAME` starts the session on that model (a name or alias such as `opus`). About 5 seconds after the session starts, `start` reads its screen; if it shows a spend or usage limit or an invalid key, `start` deletes the machine and fails with that line. If it waits on a trust, MCP approval or Remote Control prompt, the machine stays, `start` succeeds and says so, and you run `coordinator attach NAME` and accept the prompt. When the session is waiting for its Claude sign-in, the output (and `needsLogin` in `--json`, with `loginUrl` when the pane shows the `claude.ai` sign-in URL and `next: cloudy-cloud coordinator login NAME`) says so — a sign-in URL is only ever a `https://claude.ai/`, `https://claude.com/` or `https://platform.claude.com/` URL, never a Remote Control `/code/` link or other pane text. `--json` prints `{name, machine, remoteControlName, attach, started}` instead of the text; `started` is `true`; `waiting` holds the prompt line when the session waits on one (omitted otherwise). `--env FILE` (repeatable, plus the `CLOUDY_CLOUD_ENV_FILES` comma list in the env file) bridges variables from a dotenv file onto the machine; see "Bridged env variables" below. |
| `cloudy-cloud cloud [--name N] [--branch B] [--max-hours H] [--model M] [--env FILE]... [--no-attach] [--json]` | One step instead of `start` plus `attach`, run inside a git clone whose origin is on github.com: the repo is the origin URL, the branch the current one, the name an `<owner>-<repo>-<branch>-<hash>` slug (the 7-character hash of `owner/repo@branch` always rides along). If the branch has commits `origin/<branch>` does not (local `<branch>` compared, fetched first), or tracked files have uncommitted edits, it warns first (the cloud copy clones from GitHub): on a terminal it asks `Start anyway? [y/N]`; off one it refuses and names the push command. A running coordinator of that name is reattached to only when its `install`, `repo` and `branch` labels match this checkout; a machine with no `install` label predates labelling and is refused (attach to it by name instead), as is one belonging to a different cloudy-cloud installation. `--no-attach`, `--json` or a pipe prints only the start output. |
| `cloudy-cloud coordinator attach NAME` | On a terminal, joins the session. Piped, it prints `cloudy-cloud coordinator attach NAME`; run that in your own terminal. It refuses a coordinator whose `install` label names a different cloudy-cloud installation. |
| `cloudy-cloud coordinator login NAME [--code CODE]` | Finishes a coordinator's Claude sign-in. Without `--code` it attaches to the `claude` pane so you sign in there (a terminal is required; off one it points at `--code`). When the pane shows `Login expired` or `/login` it prints `Type /login and sign in.` first. With `--code` — the way an agent finishes a sign-in you did in the browser — it types the code (1–512 characters of letters, digits, `#`, `_`, `-`) into the pane's sign-in prompt and waits up to 60 seconds for `claude auth status` to report the sign-in; it refuses when the pane is not at the code prompt. |
| `cloudy-cloud coordinator ls` | Lists coordinators: name, state, created time, machine name, the time the server deletes the machine, and WAITING: `waiting for Claude sign-in` when the pane waits at the sign-in, `waiting on a prompt: <line>` when the screen shows a prompt a person must answer, `screen not read` when the screen could not be read, `-` otherwise. It reads each running coordinator's screen once. |
| `cloudy-cloud coordinator status NAME [--json]` | Read-only. Prints the state, `waiting for Claude sign-in` when the pane waits at the sign-in (with the sign-in URL when the pane shows one), the waiting prompt line if any (redacted), the Remote Control link when Remote Control is connected (with a QR code on a terminal), and the attach command — or `coordinator login NAME` while it waits for sign-in. One screen read. `--json` prints `{name, machine, state, screenRead, waiting, needsLogin, loginUrl, remoteControlUrl, attach}` (`waiting`, `needsLogin`, `loginUrl` and `remoteControlUrl` only when set; `next` names `coordinator login NAME` while it waits for sign-in). `start` prints the same link, and a QR code on a terminal, once Remote Control connects; if it is not connected yet, run `status` later. |
| `cloudy-cloud coordinator stop NAME` | Deletes that coordinator's machine. Its workers are deleted by its own `cloudy-cloud` cleanup process when its session ends, or by their own delete deadline. |
| `cloudy-cloud coordinator finish [--force]` | Run on the coordinator machine, by the coordinator. Deletes that machine after checking that the work is on GitHub (see 8.5). It refuses to run on a laptop. |
| `cloudy-cloud open <agent-id-or-machine> <port> [--share]` | Reaches an app on an agent or coordinator machine. Default: private tunnel to `127.0.0.1:<port>` until Ctrl-C (`LOCAL:REMOTE` allowed). `--share` prints a private link (anyone with it can open the app); `--unshare` removes it. Start the app in the background on the machine (`nohup npm run dev > /tmp/dev.log 2>&1 &`); it ends when the machine is deleted. |
| `cloudy-cloud shell <agent-id-or-machine> [-- command]` | Interactive shell on the machine, or runs one command there and exits with its exit code. |
| `cloudy-cloud display <agent-id-or-machine> [--control] [--ttl SECONDS] [--screenshot FILE] [--unshare]` | Prints a link to the desktop (linux, android, gpu; not omarchy; macos not verified). View-only for 1 hour by default. The link is a secret. `--screenshot` writes a PNG; `--unshare` revokes every link. |

A coordinator's Claude runs with permission checks off, like a worker (`--dangerously-skip-permissions`; the deny list for the built-in Workflow tool still applies). Only a coordinator session keeps the built-in `Agent` tool — for small tasks on its own machine; laptop sessions deny it and `Workflow` so all delegation goes through `cloud_agent`. `start` also writes `skipDangerousModePermissionPrompt` to `~/.claude/settings.json` and marks `~/repo` as trusted in `~/.claude.json` on the machine, so neither the bypass-mode confirmation nor the folder-trust dialog appears. A nested coordinator started by `cloud_agent` gets the same files. Nothing should wait on a prompt except the Claude sign-in on a fresh coordinator — `coordinator ls` and `status` show it as `waiting for Claude sign-in` until you finish it with `coordinator login NAME`. If `coordinator ls` or `status` (or "Needs you" in the dashboard) shows a real prompt waiting anyway, run `coordinator attach NAME`, answer it, and tell the maintainers which prompt it was (#88). The first time you attach you may still need to accept a Remote Control prompt. Then pick the session named NAME in claude.ai/code.

### 8.3 Keys on the coordinator

- **Which login the coordinator session bills.** The env file is read by `cloudy-cloud` tools and no longer holds the Claude token. Instabox puts a placeholder for `CLAUDE_CODE_OAUTH_TOKEN` in the machine environment, which the launcher unsets for the coordinator's own session (`env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY` — an env token beats a sign-in and cannot open Remote Control sessions). So the coordinator's own Claude uses the `claude auth login` sign-in you finish at `coordinator start`/`coordinator login` (your subscription, with its spend limit), while its workers use the token from the keys file. This follows from reading the code (#44) and has not been checked on a live machine with the placeholder present. If the coordinator's turns stop with a spend limit, `start` fails with that line, or you can read the pane with `cloudy-cloud coordinator attach NAME`.
- **Project MCP servers.** On a coordinator the launcher adds `--strict-mcp-config`, so a `.mcp.json` in the repo is ignored and Claude Code never waits on "New MCP server found in this project" (needs Claude Code 2.1.246 or later). Only the `cloud` server is loaded.
- **PATH.** The session has `~/cloudy-cloud/bin` on `PATH`, and `CLOUDY_CLOUD_BIN` holds the full path.

- **Placeholders, not keys.** A coordinator gets the Instabox key, the Claude token and the provider keys that profiles use (the built-in ones and any `keyName` in `profiles.json`) as attached Instabox secrets, like workers do. Its machine environment holds `ibsec_` placeholders, and Instabox swaps each one for the real key only in requests to that key's host (`api.anthropic.com`, `api.particle.ai`, `openrouter.ai`, `api.instabox.sh`).
- **The Instabox key has its own secret name.** Instabox reserves every name that starts with `INSTABOX_`, so the secret is `CLOUDY_CLOUD_INSTABOX_API_KEY` (host `api.instabox.sh`), the same value as your `INSTABOX_API_KEY`. `cloudy-cloud setup` stores it when you set up coordinators; your laptop keeps using the real `INSTABOX_API_KEY`. On the coordinator the launcher and the Instabox provider read the placeholder from `CLOUDY_CLOUD_INSTABOX_API_KEY`. `coordinator start` needs this secret.
- The coordinator's `~/.config/cloudy-cloud/env` (mode 600) holds names and settings only: `CLOUDY_CLOUD_PROXY_SECRETS` (the secret names) and the depth and package settings. Other `*_API_KEY` variables in your shell stay on the laptop. The file is written with a file upload, never in a command line.
- A key that is not stored as a secret is never copied into that file: `coordinator start` and a nested coordinator fail with `key_on_machine_refused` and tell you to run `cloudy-cloud setup`.
- The coordinator's system prompt tells it never to print, share, commit or send a placeholder, and never to pass one to workers except through `cloudy-cloud`.
- GitHub access uses the `GH_TOKEN` Instabox secret, as on your laptop.
- The coordinator's own Claude sign-in (`~/.claude/.credentials.json` on its machine) is a real login — Remote Control refuses setup-tokens. Use an account you can revoke. The image never holds one: `coordinator image` removes the file before it snapshots, and `launch.sh` removes a copy an older image may have left, once, before `claude auth login` runs.
- **Bridged env variables.** `coordinator start --env FILE` and `cloud --env FILE` (repeatable; also `CLOUDY_CLOUD_ENV_FILES`, comma-separated, in `~/.config/cloudy-cloud/env`) copy variables from a dotenv-style file to the machine. A variable whose name is already listed in your `CLOUDY_CLOUD_PROXY_SECRETS` is attached by name like any other custom proxy secret — the bridge never writes provider secrets. Any other variable needs per-repo consent (`y` once, `a` remembered in `~/.config/cloudy-cloud/env-consent.json`, which stores a SHA-256 of the value — a changed value asks again) and is then written `NAME='value'` into `~/.config/cloudy-cloud/env.local` (mode 600, via the file-upload route) and sourced into the session's environment when tmux starts Claude. Names that could override the machine's own configuration or credential behaviour (`PATH`, `HOME`, `GIT_*`, `NODE_*`, `CLOUDY_CLOUD_*`, `CLAUDE_*`, `ANTHROPIC_*`, `XDG_*`, `INSTABOX_*`, `npm_config_*`/`NPM_CONFIG_*`, `PYTHON*`, `RUBY*`, `PERL5*`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` in any case, `CURL_*`, `SSL_CERT_*`, `REQUESTS_CA_BUNDLE`, `EDITOR`, `VISUAL`, `PAGER`, `BROWSER`, `TERM*`, `TMPDIR` and the like) are always refused. On a provider without proxy secrets every variable needs consent. Variables `cloudy-cloud` already sends (the Instabox, Claude and GitHub keys and profile keys) are always skipped. The summary names the proxied, copied and skipped variables with reasons, never values; a malformed line is reported by file and line number only, and an unterminated quote ends parsing there — nothing from that line onward is used; without a terminal unconsented variables are skipped.

### 8.4 Cleanup

Your laptop's cleanup process deletes only machines whose `owner` label is that session's id (`src/reaper.mjs` checks `metadata.owner === owner`). Coordinators have no `owner` label, so it never deletes them. Delete one with `coordinator stop NAME`, or list leftovers with `cloudy-cloud machines` (role `coordinator`).

### 8.5 Delete deadlines and `finish`

Every machine this tool creates has a delete deadline set when it is created (`deleteAfterSeconds`, shown by Instabox as `deleteAt`). Instabox deletes the machine at that time in any state, even if every `cloudy-cloud` process has died, so orphaned machines cannot pile up. The deadline cannot be changed after create (`PATCH /v1/machines/{id}` has no field for it).

| Machine | Deadline |
| --- | --- |
| Worker and nested coordinator | `CLOUDY_CLOUD_WORKER_HOURS`, default 6, at most 24 |
| Cloud coordinator | `coordinator start --max-hours N`, default 24, at most 24 (Instabox allows at most 86400 s); a larger value is refused |
| Image machine | 2 hours |

The agent is told its deadline ("Your machine is deleted by the server at <time>; push your work well before then."). `coordinator ls` and `cloud_agent_list` show it. A work package that must outlive 24 hours needs a new coordinator from a pushed branch.

A coordinator machine also runs a deadline watchdog in its own tmux session `cc-watchdog` (`~/watchdog.sh`, log `~/watchdog.log`), started with `CLOUDY_CLOUD_COORDINATOR=1` and `CLOUDY_CLOUD_DELETE_AT` set to the deadline the provider reported for the machine. The reminder reaches the Claude session through a Claude Code command hook (`bin/deadline-hook.sh`, wired for `UserPromptSubmit` and `PostToolUse` in the launcher's `--settings`): inside the last 30 minutes it emits `additionalContext` telling the session the delete time and to commit and push to a work branch — the watchdog never types into the session. The watchdog polls every 60 seconds and, starting 5 minutes before deletion until the last minute, saves whatever is left in `~/repo` every poll: `git add -u` stages tracked edits only (untracked files are logged by name and count, never staged; files already added to the index are unstaged, logged by name and never committed — a staged credential file must not ride a WIP commit), a `WIP: automatic save before the machine is deleted` commit is made when staging leaves anything (a failed commit is retried each poll and never pushed), then the current branch is pushed. Nothing counts as done until the tree is clean AND `HEAD` is on `origin/<branch>` (fetched each poll; a failed fetch or a branch the remote does not have counts as unpushed). It never pushes to the push remote's default branch — a configured `remote.origin.pushurl` is asked with `git ls-remote --symref <pushurl> HEAD`, and an unreadable remote means "protected" — nor to `main`, `master` or a `release*` branch, and a detached HEAD always saves to `cloudy-cloud/wip-<timestamp>`. It never force-pushes and never deletes anything. After a successful save it keeps polling and saves again only when something new appears; a push rejected at the branch destination is not retried there but lands on a fresh `cloudy-cloud/wip-<timestamp>`. If work is still unsaved at the deadline it exits non-zero, otherwise it exits 0. A missing or unparsable `CLOUDY_CLOUD_DELETE_AT`, or a `CLOUDY_CLOUD_COORDINATOR` that is not exactly `1`, is logged and the watchdog exits.

The coordinator ends its job with `~/cloudy-cloud/bin/cloudy-cloud coordinator finish`. It deletes the machine only when all of these hold, and prints what it verified:

- it runs on a machine named `instabox-<name>` whose Instabox record has `role=coordinator`;
- `git status --porcelain` in `~/repo` is empty;
- the current branch and every local `fleet/*` branch have no commits beyond their upstream;
- no machine owned by this coordinator's `cloudy-cloud` server is still running (stop workers with `cloud_agent_stop` first; the server records its owner id in `~/.config/cloudy-cloud/owner`).

`--force` skips the git and worker checks, not the machine check.

### 8.6 Coordinators talking to each other

Two cloud coordinators on Remote Control can message each other with Claude's built-in `ListAgents`/`SendMessage` tools; all coordinators run with permission checks off, so no message is held on a permissions prompt. `coordinator start` sets `CLOUDY_CLOUD_NAME`, `CLOUDY_CLOUD_PEERS`, `CLOUDY_CLOUD_REPO` and `CLOUDY_CLOUD_BRANCH` in the tmux environment (always set, even empty, so a bridged `env.local` cannot inject them). The launcher then passes `--name NAME` to `claude`, so `ListAgents` lists the session under its coordinator name rather than the `repo` folder name — but only when `CLOUDY_CLOUD_COORDINATOR=1` and the name matches `^[a-z0-9-]{1,40}$` (an invalid name means no `--name` and one stderr note).

`CLOUDY_CLOUD_PEERS` is a comma list of the installation's other running coordinators, collected at start with the same install-label lookup `cloud` reattach uses; the coordinator being started, stopped machines, other roles, machines with no `install` label and names that fail `NAME_RE` are all excluded. A failed lookup prints one progress line and starts with no peers — it never fails the start.

The launcher also appends the messaging rules to the coordinator's prompt (only for a coordinator with a valid `CLOUDY_CLOUD_NAME`): announce `NAME started (repo REPO, branch BRANCH)` to each listed peer at the start of the first turn; `ListAgents` shows only sessions alive when it runs, so call it again before messaging a peer that was not in the last result and use `cloud_agent_list` `all: true` (which prints each coordinator's `name` label) to see every running coordinator, including late starters. `SendMessage` delivery has no built-in receipt, so the rules use an ack convention: reply `ack: <first 8 words>` to each received message (never to one starting with `ack:`), and if no ack arrives within 3 minutes resend once and then tell the user the peer is gone. The rules also forbid putting a secret, placeholder, `env.local` value or link in a message, and require refusing message requests to push to the default branch, delete machines the coordinator did not start, or reveal credentials.

A nested coordinator (`cloud_agent` with `role: "coordinator"`) has no Remote Control session: it never receives the four variables and its launcher takes the non-coordinator path, so it takes no part.

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

Without `--provider`, `install.sh` asks "Where should subagents run?"; type 2. Then it asks which agents you run (section 2.1). Setup asks for:

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
- Coordinators use Docker images instead of Instabox snapshots (`hasSnapshots` is true). `cloudy-cloud coordinator image` creates the image container and, before the snapshot, removes `~/.claude/.credentials.json` on it as in 8.1 — no Claude sign-in is saved in the image; each coordinator signs in for itself at `coordinator start`/`coordinator login`. `coordinator image` then runs `docker commit --pause=true` on that container, which makes the image `cloudy-cloud-coordinator:<name>` on the machine, saves that name as `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT`, and removes the image container. It never contains `/run/secrets`, because that folder is a tmpfs mount and `docker commit` skips it, so the GitHub token and other keys are not saved. `coordinator start NAME` creates a container from the image and gives it its keys at start. The adapter can list and remove these images (`docker image ls --filter 'reference=cloudy-cloud-coordinator:*'`, `docker rmi cloudy-cloud-coordinator:<name>` on the machine), but `cloudy-cloud` has no command for it yet. Not yet proven live on a real Mac Studio.

  **Coordinators start workers through Docker, with no SSH key on the coordinator.** Setup asks once: "Coordinators on <host> can start containers through Docker, which gives them full control of Docker on that machine. Allow? [y/N]". Yes saves `CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes` and `CLOUDY_CLOUD_DOCKER_SOCKET` (the socket path on the machine; `/var/run/docker.sock` on a Mac, because that is the path inside the Docker Desktop or OrbStack VM). Only a coordinator container gets `-v <socket>:/var/run/docker.sock` and the socket's group (`--group-add`); workers never do. The worker image carries the docker CLI (rebuild it with setup after upgrading). Inside the coordinator, `CLOUDY_CLOUD_SELF_HOSTED_LOCAL=1` makes the adapter run the same docker commands locally with `sh -c`, so its workers are siblings on the same Docker. The slot count still sees every `cloudy-cloud.purpose` container, whoever started it. The coordinator's `~/.config/cloudy-cloud/env` holds these names: `CLOUDY_CLOUD_PROVIDER`, `CLOUDY_CLOUD_SELF_HOSTED_LOCAL`, `CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS`, `CLOUDY_CLOUD_DOCKER_SOCKET`, `CLOUDY_CLOUD_CONTAINER_RUNTIME`, `CLOUDY_CLOUD_CONTAINER_BIN`, `CLOUDY_CLOUD_SELF_HOSTED_SLOTS`, `CLOUDY_CLOUD_SELF_HOSTED_CPUS`, `CLOUDY_CLOUD_SELF_HOSTED_MEMORY`, the Claude credential, provider `*_API_KEY` values, the depth settings, and (only if you allowed the token) `CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX` and `GH_TOKEN`. It never holds `CLOUDY_CLOUD_SSH_HOST`, `CLOUDY_CLOUD_SSH_KEY` or `CLOUDY_CLOUD_SSH_PORT`. The risk you accept: a coordinator, and anything it runs, can control every container on that machine. Docker only; Podman is not supported for coordinators.
- `cloudy-cloud open <agent> <port>` works through an SSH bridge. `--share` is refused.
- Docker is the path to use. Podman is accepted; rootless Podman may ignore CPU and memory limits.
- The container can reach whatever the machine can reach on your network.

### Docker Desktop: image build fails over SSH

Docker Desktop can keep registry logins in the macOS keychain (`credsStore` in `~/.docker/config.json`). A build started over SSH cannot unlock it, and pulling `node:22-bookworm-slim` can fail with a credentials error. Either run `docker pull node:22-bookworm-slim` in a Terminal on the Mac and run setup again, or use OrbStack. This is a known Docker Desktop behavior and is not yet checked on the Mac Studio.

