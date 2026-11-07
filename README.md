# claude-cloud

Run Claude Code subagents in the cloud instead of on your machine.

`claude-cloud` starts an ordinary Claude Code session. When that session uses a subagent, the
subagent runs as its own Claude Code on its own [Instabox](https://instabox.sh) cloud machine. It
commits and pushes its work to a branch on your GitHub repo, and stays open for follow-up messages
until it is stopped. Plain `claude` is unaffected.

```
your Mac                                  Instabox (one machine per subagent)
┌──────────────────────────┐   task     ┌──────────────────────────────┐
│ claude-cloud session     │──────────▶ │ Claude Code on a copy of     │
│  (your normal login)     │◀────────── │ your repo, branch            │
│                          │   answer   │ claude-cloud/<id>            │
└──────────────────────────┘            └──────────────┬───────────────┘
            ▲                                          │ git push
            │ git fetch origin claude-cloud/<id>       ▼
            └──────────────────────────────────── GitHub (your repo)
```

**Set up:** clone this repo and run `./install.sh` once. After that, `claude-cloud setup` runs it again from any folder. It checks your tools, links `claude-cloud`, and asks for three keys, with where to get each one. Details: [docs/RUNBOOK.md](docs/RUNBOOK.md). Setup takes about 15 minutes and needs:

- **Accounts:** an Instabox account (a paid plan for more than a few subagents at once), a Claude subscription or API key, and a GitHub repo you can push to.
- **On your machine:** `git`, Node.js 20 or later, and Claude Code.

**Status:** everything built and proven live, with evidence, is in [docs/STATUS.md](docs/STATUS.md). A hosted version (Clerk sign-in, GitHub App, one central Instabox account) is sketched in [docs/HOSTED-DESIGN.md](docs/HOSTED-DESIGN.md).

## Model profiles (open-model workers)

A worker can run Claude Code on a non-Anthropic model while your session stays on Claude. Ask for it in plain language ("use a glm subagent for this"); `cloud_agent` takes an optional `profile`. Follow-up messages reuse the agent's profile, and `cloud_agent_list` and the status line show it.

| Profile | Format | Endpoint and model |
| --- | --- | --- |
| `glm` | openai | Particle.ai, `z-ai/glm-5.3-flash` |
| `deepseek` | openai | Particle.ai, `deepseek-ai/deepseek-v41-flash-1017` |
| `particle` | openai | Particle.ai, `particle-ai/particle-1` |
| `openrouter` | anthropic | `https://openrouter.ai/api`; pass `model` per call or set it in the file |

- **Keys:** `install.sh` has an optional step for `PARTICLE_API_KEY` (platform.particle.ai) and `OPENROUTER_API_KEY` (openrouter.ai/keys). Press Enter to skip. A profile whose key is missing makes `cloud_agent` fail at once.
- **Your own profiles:** `~/.config/claude-cloud/profiles.json` (or the path in `CLAUDE_CLOUD_PROFILES`) overrides or adds to the built-ins:
  `{ "<name>": { "format": "anthropic" | "openai", "baseUrl": "...", "model": "...", "keyName": "PARTICLE_API_KEY" } }`.
  `keyName` is a key saved in `~/.config/claude-cloud/env` and must end in `_API_KEY`.
- **How it works:** Claude Code needs the Anthropic Messages API. An `anthropic` profile points Claude Code straight at the endpoint (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`). An `openai` profile (Particle speaks only OpenAI Chat Completions) starts LiteLLM in the worker with `uvx --from 'litellm[proxy]' litellm` (the Instabox `agent-browser` template includes `uv`), waits up to 180 s for it, and points Claude Code at it on `127.0.0.1:4000`. A profile worker never receives your Claude token.
- **The pi harness:** the profiles `pi-glm`, `pi-deepseek` and `pi-particle` run the [pi coding agent](https://pi.dev) in the worker instead of Claude Code. pi speaks OpenAI-format providers natively, so these workers need no LiteLLM gateway and use none of your Claude allowance. The worker installs a pinned pi (1.5.0) under `~/.local` and writes `~/pi-agent/models.json`, which names the key by its environment variable (`$PARTICLE_API_KEY`) and never holds it. Follow-ups resume the pi session by id. A pi run whose last assistant message is an error counts as a failed turn. A profile in `profiles.json` can set `"harness": "pi"` too. Coordinators always run Claude Code, so a pi profile is for workers only. The result has no cost line. This path has not been run live yet.
- **Security:** the provider key sits on the worker machine that uses it, unlike `GH_TOKEN`, which is only a placeholder there. A prompt-injected worker could read it. Moving it to an Instabox proxy secret is the next step (docs/FLEET-DESIGN.md, section 2). Only workers that use a profile get that profile's key.
- **Unverified:** the gateway start has been tested only against a fake sandbox, not a live Instabox machine.

## Nested coordinators

`cloud_agent` accepts `role: "coordinator"` (default `"worker"`). A coordinator is a Claude subagent that can itself start cloud subagents, so you can build trees such as Opus coordinator, Opus sub-coordinators, then DeepSeek or GLM workers (`profile` combines with `role`; a coordinator with no profile uses the parent's Claude login).

For a coordinator the sandbox also gets claude-cloud: this checkout of claude-cloud is sent as a git bundle (HEAD plus uncommitted tracked edits) and unpacked into `~/claude-cloud`, so it runs exactly your laptop's version without being pushed to GitHub, `npm install` runs there, and `~/.config/claude-cloud/env` is written with mode 600. That file holds the Instabox key, the Claude credential and any `*_API_KEY` provider keys from the parent, written as a file and never put in a command. Each turn then runs `~/claude-cloud/bin/claude-cloud -p ...` instead of plain `claude`, with a system prompt that tells it to keep keys private and delegate only through the cloud_agent tools.

Because the nested session runs with `-p`, MCP tasks are not offered, so a nested coordinator uses the `cloud_agent_wait` flow, not task mode. This is expected.

Limits, both passed down to child coordinators:

- `CLAUDE_CLOUD_MAX_DEPTH` (default 3): levels below your laptop session. Starting a coordinator past it is refused. Workers cannot start agents, so they do not add depth.
- `CLAUDE_CLOUD_MAX_AGENTS_PER_SESSION` (default 200): agents one claude-cloud server may start. Further starts are refused.

Every machine in a tree counts against your Instabox machine limit and start rate.

## Ways of working

Starting many subagents is easy, but 100 PRs are hard to review. The [cloud-fleet skill](skills/cloud-fleet/SKILL.md) teaches Claude how to run a fleet so the output stays manageable: merge worker branches into one `fleet/<topic>` trunk, use sub-coordinators for large jobs, work in waves, and clean up branches. Install it by copying or symlinking it:

```sh
ln -s "$PWD/skills/cloud-fleet" ~/.claude/skills/cloud-fleet
```

## Quick reference

| Task | How |
| --- | --- |
| **Start a session** | `claude-cloud` from inside a git repo that has a GitHub `origin` |
| **Use a subagent** | Ask normally, for example: "use a subagent to …" or "start 10 subagents that …" |
| **Get a subagent's work** | `git fetch origin claude-cloud/<id>` (nothing is copied into your local repo automatically) |
| **Get every subagent's work** | `git fetch origin 'refs/heads/claude-cloud/*:refs/remotes/origin/claude-cloud/*'` |
| **See cloud machines** | `npx instabox@latest ls` |

### Watching subagents

In a terminal Claude Code session, each `cloud_agent` and `cloud_agent_message` call is an MCP task:

- The footer shows a count such as `3 MCP tasks`.
- `/tasks` lists each task with a progress line that updates every few seconds, for example `12 tool uses · 48.2k tokens · 3m10s · Edit src/parser.ts`. A machine that is still starting shows `starting machine…`.
- Select a task in `/tasks` and press `x` to stop it. Stopping a `cloud_agent` task stops that agent and deletes its machine. Stopping a `cloud_agent_message` task stops only that follow-up; the agent stays open.
- When a task ends, Claude receives the result automatically and does not need to call `cloud_agent_wait`.

This needs Claude Code 2.1.304 or later in a terminal session. It does not work in the VS Code extension, the desktop app, or a one-shot `claude -p "<prompt>"` run. In those cases the tools return an agent ID at once and Claude calls `cloud_agent_wait`, as before. `cloud_agent_list` shows the same progress line for every agent in both modes.

The session gets five tools in place of the built-in `Agent` tool:

| Tool | What it does |
| --- | --- |
| `cloud_agent` | Starts a subagent. Returns at once, as an MCP task when the client supports it |
| `cloud_agent_wait` | Waits for one or more subagents and returns their answers (not needed in task mode) |
| `cloud_agent_message` | Sends a follow-up to an open subagent, continuing the same conversation |
| `cloud_agent_list` | Shows every subagent's status and progress |
| `cloud_agent_stop` | Stops subagents and deletes their machines |

## Limits

Read these before relying on it:

- **What subagents see:**
  - Subagents see only files tracked by git. That includes uncommitted edits to tracked files, but not untracked files.
  - They can't use your local MCP servers, your settings, or agents defined in `~/.claude/agents`.
- **What survives:** only work a subagent has pushed to GitHub survives if its machine is lost.
- **Delete deadline:** the Instabox server deletes every machine this tool creates after a fixed time, even if `claude-cloud` has died. Workers and nested coordinators: `CLAUDE_CLOUD_WORKER_HOURS` (default 6, maximum 24). Cloud coordinators: `coordinator start --max-hours N` (default and maximum 24). The deadline cannot be extended, so push before it. A cloud coordinator deletes itself earlier with `claude-cloud coordinator finish`, which first checks that its work is on GitHub and its workers are stopped. See docs/RUNBOOK.md, section 8.5.
- **When subagents stop:** an idle subagent is stopped after 60 minutes, and every subagent is stopped when the session ends.
  - A single task is stopped after 29 minutes.
- **Nested subagents:** a subagent's own subagents run inside the same machine, not on new ones.
- **Large swarms:** start as many subagents as you need. `claude-cloud` paces them for Instabox's limits.
  - Machines start at most `CLAUDE_CLOUD_STARTS_PER_MIN` times a minute (default 25). Waiting subagents show the status `queued`, for example `queued for a machine (12 ahead)`.
  - A `rate_limited` start is retried after the delay Instabox gives, up to 5 tries. When the plan's machine limit is full (`quota_exceeded`), the subagent stays queued and retries every 60 seconds for up to 30 minutes, then fails with Instabox's message.
  - At most `CLAUDE_CLOUD_MAX_INSTABOX_CALLS` Instabox command and file requests run at once (default 24, below Instabox's 32). Working subagents share them in turn, so hundreds can run. Set either value in the environment or in the config file.
  - The machine limit of your plan still caps how many subagents run at once; the rest wait in the queue.
- **Security:** each machine runs Claude with permission checks off.
  - **Claude credential:** it is on the machine, so a prompt injection there could misuse or leak it.
  - **GitHub token:** it never reaches the machine, which gets only a placeholder. A subagent can still push to any branch the token can reach, so protect your main branch. The runbook shows how.

## Tested so far

These ran on real Instabox machines with a real Claude login:
- 50 subagents running at once on a paid plan.
- Follow-up messages.
- Three subagents pushing their own branches to GitHub at the same time.
- MCP task mode in an interactive session:
  - the footer count;
  - live progress in `/tasks`;
  - automatic completion;
  - follow-ups as tasks;
  - stopping subagents.
- `install.sh`:
  - rejecting malformed and invalid keys;
  - saving real keys privately;
  - finding the stored `GH_TOKEN`;
  - offering to replace each key on a re-run;
  - leaving the terminal echoing normally after Ctrl-C at a hidden prompt.
- Machine cleanup when a session ends, including when the terminal is closed outright while a subagent is working. The machine was gone within 10 seconds.

These have not been run live:
- A 50-subagent swarm since subagents started pushing their own work to GitHub.
- Any single task longer than 10 minutes.

## Development

```sh
npm install
npm test
```

The code is in `src/`:
- `run-subagent.mjs`: the agent lifecycle and the task state.
- `progress.mjs`: reads claude's `stream-json` output and builds the progress line.
- `instabox.mjs`: the Instabox machines.
- `mcp.mjs`: the MCP tools and the `tasks/get` and `tasks/cancel` methods. `server.mjs` starts it on stdio.

The launcher is `bin/claude-cloud`.
