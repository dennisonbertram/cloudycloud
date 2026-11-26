# How it works

> What runs where when a subagent runs on a cloud machine, what it can see, and how its work comes back.

Source: https://cloudycloud.tech/docs/how-it-works.html

The `cloudy-cloud` command starts your coding agent with its built-in subagents turned off. Every subagent runs on its own cloud machine and pushes its work to a branch on GitHub.

The built-in host commands cover Claude Code, Codex, opencode, pi and free-pi; other MCP clients can use the standalone server. Workers can use Claude Code, pi, oh-my-pi, Codex or opencode. Live verification differs by client and worker; see [the status table](https://cloudycloud.tech/docs/models.html#verified).

## One subagent, start to finish

1. **You start Cloudy Cloud in a git repo.** The built-in host commands launch Claude Code, Codex, opencode, pi or free-pi with Cloudy Cloud's MCP tools. Another MCP client can connect to `cloudy-cloud mcp-server --repo PATH`. The repository is bound when that server starts; a call's `workspace` can select a directory only inside that repository. A named server session uses `--session NAME` to let separate MCP connections reconnect to the same local worker owner.
2. **The main session calls `cloud_agent`** (Claude Code, Codex, opencode or pi, whichever you started) with a prompt and a short description. The call returns at once while the machine starts.
3. **A snapshot of your repo is made.** It holds the committed files plus your uncommitted edits to tracked files. It is made without touching your working tree or index.
4. **A provider is selected** from the configured provider order. The first provider eligible for the request is tried. If creation fails in a recoverable way, Cloudy Cloud may try the next eligible provider; it does not start a second worker after a machine has been returned. Ambiguous creation results are reconciled before proceeding.
5. **The snapshot is uploaded** as a git bundle and checked out on a new branch, `cloudy-cloud/<id>`. The branch is pushed to your `origin` remote right away. If the bundle is over about 9 MB, only the commits GitHub does not already have are uploaded. If that is still too large, the start fails and asks you to push the branch first.
6. **The selected worker agent runs on the machine** in the repo folder. The saved default is Claude Code unless setup changed it. A per-request `profile` overrides that default and can select `pi --mode json`, `omp -p --mode json` (oh-my-pi), `codex exec --json` or `opencode run --format json`. Each is installed on the machine from a pinned version when it is not part of the image. The subagent is told to commit after each meaningful step and to push to its own branch only.
7. **After the turn, the tool pushes once more** in case the subagent forgot (and retries once if GitHub rejects it). It never commits for the subagent. If files were left uncommitted, the reply lists them.
8. **The result comes back** with the branch name and commit, and token and tool-use totals.

Fetch the work with `git fetch origin cloudy-cloud/<id>`. The repo needs a `github.com` origin, because each subagent pushes there.

### Getting the result: task mode or wait

- **Task mode.** When your Claude Code supports MCP tasks, `cloud_agent` becomes a background task. Its progress shows in `/tasks` and the result arrives on its own.
- **Otherwise,** `cloud_agent` returns an `agent_id` and the main session calls `cloud_agent_wait` to collect the result. The default wait is 600 seconds and the maximum is 1500. Each result is marked as reported, so a later wait does not repeat it.

One task is stopped after 29 minutes by default. Provider eligibility and machine limits vary; use `cloud_agent_capabilities` to inspect the configured worker profiles and providers without creating a machine or calling a model provider.

## MCP tools

| Tool | What it does |
|---|---|
| `cloud_agent` | Starts a subagent in a new machine. |
| `cloud_agent_message` | Sends a follow-up to an open, idle agent. It continues the same session of whichever agent the worker runs, on the same machine: Claude Code resumes its session, pi and oh-my-pi use their session ID, Codex runs `codex exec resume ID`, and opencode passes `--session ses_...`. It is rejected if the agent is busy or gone. |
| `cloud_agent_wait` | Waits for agents to finish their current turn and returns their results. |
| `cloud_agent_list` | Lists every agent with its status, idle minutes and progress (tool uses, tokens, elapsed time, current step). |
| `cloud_agent_stop` | Stops this server's agents after the provider confirms deletion or confirms the machine is absent. A transient failure leaves the agent tracked for retry. |
| `cloud_agent_capabilities` | Reports configured profiles, providers and machine kinds without creating a machine or calling a model provider. |

An agent's status is one of `queued`, `starting`, `running`, `idle`, `failed` or `stopped`. After a turn ends, the agent is `idle` and its machine stays open for follow-ups.

## How long a machine lives

| What ends it | When |
|---|---|
| You or the main session call `cloud_agent_stop` | After the provider confirms deletion or confirms the machine is absent. |
| Idle timeout | 60 minutes after the agent went idle. |
| Ephemeral session end | Without `--session`, quitting the MCP server ends its workers. A separate cleanup process handles a hard kill. |
| Named MCP session | With `mcp-server --session NAME --repo PATH`, separate stdio connections can reconnect to the same local owner. The owner remains while workers run and exits after workers finish or idle-expire and clients disconnect. |
| Delete deadline | Instabox deletes the machine at a fixed time in any state. The default is 6 hours. Set `CLOUDY_CLOUD_WORKER_HOURS` to change it, up to 24. |

> Warning: Only work that a subagent has pushed to GitHub survives if its machine is lost. The deadline cannot be extended, and the subagent is told its deadline so it can push in time.

## Starting many at once

You can start many subagents at once. Cloudy Cloud applies provider-specific start pacing and capacity limits.

- At most 25 machines start per minute, in the order requested. Set `CLOUDY_CLOUD_STARTS_PER_MIN` to change this. A waiting subagent shows the status `queued`, for example `queued for a machine (12 ahead)`.
- If Instabox answers `rate_limited`, the start is retried after the delay Instabox gives, up to 5 tries.
- If your plan's machine limit is full (`quota_exceeded`), the subagent stays queued, retries every 60 seconds for up to 30 minutes, and then fails with Instabox's message.
- At most 24 Instabox command and file requests run at once (`CLOUDY_CLOUD_MAX_INSTABOX_CALLS`). Working subagents share them in turn.
- One session can start at most 200 agents (`CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION`).

Your plan's machine limit still caps how many run at the same time. The rest wait in the queue.

## What reaches the machine

- **GitHub token:** not sent to the machine. The machine gets a placeholder named `GH_TOKEN`, and Instabox's proxy swaps in the real token for requests to `github.com` and `api.github.com`.
- **Worker credential:** the credential for the selected profile is sent to the machine in the provider-specific form. Claude Code workers use `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; other profiles use their configured provider key. The `codex-chatgpt` profile sends your ChatGPT login file (`codex-auth.json`) to the machine as a file. Credential handling varies by sandbox provider; see the provider guides.
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
