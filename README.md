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

**Set up and run it:** follow [docs/RUNBOOK.md](docs/RUNBOOK.md). Setup takes about 15 minutes and needs:

- **Accounts:** an Instabox account (a paid plan for more than a few subagents at once), a Claude subscription or API key, and a GitHub repo you can push to.
- **On your machine:** `git`, Node.js 20 or later, and Claude Code.

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
- **When subagents stop:** an idle subagent is stopped after 60 minutes, and every subagent is stopped when the session ends.
  - A single task is stopped after 29 minutes.
- **Nested subagents:** a subagent's own subagents run inside the same machine, not on new ones.
- **Large swarms:** these hit Instabox's machine limit, its start rate, and its limit of 32 commands running at once.
  - Start them in batches of about 10 to 25 a minute.
  - Nothing is retried automatically.
- **Security:** each machine runs Claude with permission checks off.
  - **Claude credential:** it is on the machine, so a prompt injection there could misuse or leak it.
  - **GitHub token:** it never reaches the machine, which gets only a placeholder. A subagent can still push to any branch the token can reach, so protect your main branch. The runbook shows how.

## Tested so far

These ran on real Instabox machines with a real Claude login:
- 50 subagents running at once on a paid plan.
- Follow-up messages.
- Three subagents pushing their own branches to GitHub at the same time.

These have not been run live:
- MCP task mode (`/tasks`, the footer count, stopping with `x`). It is covered by tests against a fake sandbox only.
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
