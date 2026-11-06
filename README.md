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

The session gets five tools in place of the built-in `Agent` tool:

| Tool | What it does |
| --- | --- |
| `cloud_agent` | Starts a subagent and returns its ID at once |
| `cloud_agent_wait` | Waits for one or more subagents and returns their answers |
| `cloud_agent_message` | Sends a follow-up to an open subagent, continuing the same conversation |
| `cloud_agent_list` | Shows every subagent's status |
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
- A 50-subagent swarm since subagents started pushing their own work to GitHub.
- Any single task longer than 10 minutes.

## Development

```sh
npm install
npm test
```

The code is in `src/`:
- `run-subagent.mjs`: the agent lifecycle.
- `instabox.mjs`: the Instabox machines.
- `server.mjs`: the MCP tools.

The launcher is `bin/claude-cloud`.
