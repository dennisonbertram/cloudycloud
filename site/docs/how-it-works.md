# How it works

> What runs where when a subagent runs on a cloud machine, what it can see, and how its work comes back.

Source: https://cloudycloud.tech/docs/how-it-works.html

The `cloudy-cloud` command starts your coding agent with its built-in subagents turned off. Every subagent runs on its own cloud machine and pushes its work to a branch on GitHub.

This page applies to every main session (Claude Code, Codex, opencode, pi, free-pi) and every worker agent (Claude Code, pi, oh-my-pi, Codex, opencode). Differences are marked.

## One subagent, start to finish

1. **You start `cloudy-cloud` in a git repo.** With no subcommand it launches Claude Code with the built-in `Agent` and `Workflow` tools disabled, an extra system prompt, and an MCP server that provides the `cloud_agent` tools. The system prompt tells the session to use `cloud_agent` for anything that would have used a subagent. `cloudy-cloud codex`, `cloudy-cloud opencode`, `cloudy-cloud pi` and `cloudy-cloud free-pi` do the same for those agents with the same MCP server, added for that session only. Codex, opencode and pi cannot receive MCP task results, so they use `cloud_agent_wait`.
2. **The main session calls `cloud_agent`** (Claude Code, Codex, opencode or pi, whichever you started) with a prompt and a short description. The call returns at once while the machine starts.
3. **A snapshot of your repo is made.** It holds the committed files plus your uncommitted edits to tracked files. It is made without touching your working tree or index.
4. **A machine is created** from the Instabox `agent-browser` image, and the GitHub token is attached to it as a proxy secret (see Secrets).
5. **The snapshot is uploaded** as a git bundle and checked out on a new branch, `cloudy-cloud/<id>`. The branch is pushed to your `origin` remote right away. If the bundle is over about 9 MB, only the commits GitHub does not already have are uploaded. If that is still too large, the start fails and asks you to push the branch first.
6. **The worker agent runs on the machine** in the repo folder. With no profile that is `claude -p`. A profile can pick another agent: `pi --mode json` (pi profiles), `omp -p --mode json` (oh-my-pi), `codex exec --json` (Codex) or `opencode run --format json` (opencode). Each is installed on the machine from a pinned version when it is not part of the image. The subagent is told to commit after each meaningful step and to push to its own branch only.
7. **After the turn, the tool pushes once more** in case the subagent forgot (and retries once if GitHub rejects it). It never commits for the subagent. If files were left uncommitted, the reply lists them.
8. **The result comes back** with the branch name and commit, and token and tool-use totals.

Fetch the work with `git fetch origin cloudy-cloud/<id>`. The repo needs a `github.com` origin, because each subagent pushes there.

### Getting the result: task mode or wait

- **Task mode.** When your Claude Code supports MCP tasks, `cloud_agent` becomes a background task. Its progress shows in `/tasks` and the result arrives on its own.
- **Otherwise,** `cloud_agent` returns an `agent_id` and the main session calls `cloud_agent_wait` to collect the result. The default wait is 600 seconds and the maximum is 1500. Each result is marked as reported, so a later wait does not repeat it.

One task is stopped after 29 minutes.

## The six tools

| Tool | What it does |
|---|---|
| `cloud_agent` | Starts a subagent in a new machine. |
| `cloud_agent_message` | Sends a follow-up to an open, idle agent. It continues the same session of whichever agent the worker runs, on the same machine: Claude Code resumes its session, pi and oh-my-pi use their session ID, Codex runs `codex exec resume ID`, and opencode passes `--session ses_...`. It is rejected if the agent is busy or gone. |
| `cloud_agent_wait` | Waits for agents to finish their current turn and returns their results. |
| `cloud_agent_list` | Lists every agent with its status, idle minutes and progress (tool uses, tokens, elapsed time, current step). |
| `cloud_agent_stop` | Stops agents and deletes their machines. It is safe to repeat. |

An agent's status is one of `queued`, `starting`, `running`, `idle`, `failed` or `stopped`. After a turn ends, the agent is `idle` and its machine stays open for follow-ups.

## How long a machine lives

| What ends it | When |
|---|---|
| You or the main session call `cloud_agent_stop` | Immediately. |
| Idle timeout | 60 minutes after the agent went idle. |
| Session end | When you quit your main session, `cloudy-cloud` deletes every open machine. |
| Cleanup process | A separate process deletes the session's machines after the session is gone, even after a hard kill. It checks every 2 seconds. |
| Delete deadline | Instabox deletes the machine at a fixed time in any state. The default is 6 hours. Set `CLOUDY_CLOUD_WORKER_HOURS` to change it, up to 24. |

> Warning: Only work that a subagent has pushed to GitHub survives if its machine is lost. The deadline cannot be extended, and the subagent is told its deadline so it can push in time.

## Starting many at once

You can start many subagents at once. `cloudy-cloud` paces the starts for Instabox's limits.

- At most 25 machines start per minute, in the order requested. Set `CLOUDY_CLOUD_STARTS_PER_MIN` to change this. A waiting subagent shows the status `queued`, for example `queued for a machine (12 ahead)`.
- If Instabox answers `rate_limited`, the start is retried after the delay Instabox gives, up to 5 tries.
- If your plan's machine limit is full (`quota_exceeded`), the subagent stays queued, retries every 60 seconds for up to 30 minutes, and then fails with Instabox's message.
- At most 24 Instabox command and file requests run at once (`CLOUDY_CLOUD_MAX_INSTABOX_CALLS`). Working subagents share them in turn.
- One session can start at most 200 agents (`CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION`).

Your plan's machine limit still caps how many run at the same time. The rest wait in the queue.

## What reaches the machine

- **GitHub token:** not sent to the machine. The machine gets a placeholder named `GH_TOKEN`, and Instabox's proxy swaps in the real token for requests to `github.com` and `api.github.com`.
- **Claude credential:** sent to the machine, as `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, for Claude Code workers with no profile. For a subagent on a profile, the provider key for that profile is sent instead of your Claude credential: `PARTICLE_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY`. The `codex-chatgpt` profile sends your ChatGPT login file (`codex-auth.json`) to the machine as a file, even on Instabox.
- **MCP server tokens:** only if you added a server that needs one. The token stays in Instabox as a secret named `MCP_<NAME>_TOKEN`, and the machine sees a placeholder that Instabox replaces in request headers to the host you chose. With `mcp add --allow-literal` the real value is on the machine instead.
- **Instabox API key:** not sent to the machine. It stays in your config file and the local server.

> Warning: Each machine runs its agent with permission checks off (Codex runs with `--dangerously-bypass-approvals-and-sandbox`), and the worker's credential is on it. A prompt injection on the machine could misuse or leak that credential. A subagent can also push to any branch the GitHub token can reach, so protect your main branch.

Output shown to you is scrubbed of known key values. See [Troubleshooting, security and FAQ](https://cloudycloud.tech/docs/troubleshooting.html) for more.

## What does not happen

- Nothing is copied into your local repo. Your branch, working tree and index are not changed. You fetch the branch yourself.
- Untracked files are not sent. If a subagent needs a new file, `git add` it first (staging counts as tracked) or commit it.
- Your local MCP servers are not available on the machine, except the ones you copy with `cloudy-cloud mcp add` (remote `https` servers and `npx` or `uvx` servers). See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).
- Your settings and agents from `~/.claude/agents` are not available on the machine.
- A subagent's own subagents run inside the same machine, not on new ones.

## Why the cloud

Subagents run on remote machines, so your laptop stays free for your own work. You can run many at once, limited by your Instabox plan and the pacing above, instead of by your computer.
