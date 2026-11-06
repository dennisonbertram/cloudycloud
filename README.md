# claude-cloud

`claude-cloud [claude args...]` starts normal Claude Code, but every subagent runs in a
remote [Instabox](https://instabox.sh) sandbox, and pushes its own commits to GitHub. Plain `claude` is unaffected.

## Setup
    npm install
    npm link
    claude-cloud      # the first run asks for your keys

The repo must have an `origin` remote on github.com (`https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`, which is converted to https).
Then store a GitHub token once, so sandboxes can push without holding it:

    claude-cloud-setup-github

Create a fine-grained token limited to the repos you will use, with Contents read and write and Metadata read. The script runs
`instabox login` and `instabox secrets set GH_TOKEN` (an API key cannot create secrets), then checks the saved secret. Instabox
delivers it through its proxy for github.com and api.github.com, so the sandbox only sees a placeholder.
Subagents can push to any branch the token reaches, so protect your main branch with a GitHub ruleset.

Then say "use a subagent" in the session. Keys are saved to `~/.config/claude-cloud/env`
with owner-only permissions and reach only the MCP server, so your main session keeps its
normal login. Environment variables with the same names take priority. Get a Claude token
with `claude setup-token`.

## How it works
The launcher disables the built-in `Agent` and `Workflow` tools and adds MCP tools. Each agent is a full Claude
(`claude -p --output-format json`) in its own sandbox, kept open until you stop it.

| Tool | What it does |
| --- | --- |
| `cloud_agent(prompt, description, model?, subagent_type?)` | Returns an `agent_id` at once (status `starting`). The sandbox is created, your repo's tracked files (including uncommitted edits) are uploaded as a git bundle, and the first turn runs in the background. All starts run concurrently with no local cap. |
| `cloud_agent_message(agent_id, message)` | Sends a follow-up (`claude -p --resume <session_id>`) and returns at once with status `running`. Rejected if the agent is busy, failed or stopped; messages are not queued. A sandbox that vanished is only discovered in the background, so the agent turns `failed` and `cloud_agent_wait` reports it. |
| `cloud_agent_wait(agent_ids, timeout_seconds?)` | Read-only (`readOnlyHint`). Waits until every listed agent finishes its current turn or the timeout passes (default 600, max 1500). Returns status (`starting`, `running`, `idle`, `failed`, `stopped`) and the latest result, once; afterwards it says the result was already reported. |
| `cloud_agent_list()` | Read-only. Id, description, status and idle minutes for every agent. |
| `cloud_agent_stop(agent_ids)` | Kills sandboxes and forgets the agents. Safe to repeat or use with unknown ids. |

Claude Code runs MCP tools one at a time unless they are marked read-only, so starting is separate from waiting:
start every agent first, then wait for all of them in one call.

Each agent works on branch `claude-cloud/<id>` in its sandbox and pushes it to your GitHub origin. Nothing is copied into your local repo
automatically; get the work with `git fetch origin claude-cloud/<id>`. The sandbox Claude is told to commit and push after each step.
After every turn, including failed ones, the server also runs `git push` of the agent's HEAD to that branch. It never commits for the agent:
uncommitted files are listed in the result so you can ask the agent to commit and push them. A failed push is reported in the result;
the agent stays open. If the first push at start-up fails, the agent fails with git's message. Your working tree, index and branches are not touched.
Secrets reach the tool through `${VAR:-}` expansion in the MCP config, so they never appear in process arguments.

## Cleanup
- An agent with no running turn and no message for 60 minutes is stopped and its sandbox deleted.
- On server shutdown (stdin closed, SIGINT, SIGTERM) every open sandbox is killed.
- Backstop sandbox lifetime: Instabox `archiveMs` 8 hours.
- Open agents are in server memory only. Nothing is saved to disk, so restarting Claude Code loses track of them (their sandboxes are killed).

## Instabox notes
Home directory is `/data/home`. Instabox caps a foreground command at 10 minutes, so each 29-minute turn runs as a
background job that the client waits on and kills at the deadline. Disks stay after archive.
Background output is one combined log, so a failing subagent's error text is that log's last 4000 characters.
- Plan limits: the free plan allows 1 machine in any state and 3 starts a minute. An open agent keeps its machine, so it blocks
  every other agent until stopped. Starts beyond the limit fail with `quota_exceeded` (machine limit) or `rate_limited` (start rate);
  that agent is marked `failed` with the provider message, and nothing is retried.
- Instabox allows 32 concurrent requests per account across commands and file reads. Per the SDK docs, a background command counts
  only while it starts, but each `wait()` holds a slot while it waits (it polls the job log, up to 25 seconds per request).
  Each running turn therefore holds roughly one slot for its whole duration, so about 30 agents running turns at once plus
  pushes and uploads can reach the cap and get 429 errors. This was read from the SDK docs, not measured.
- Instabox: machine lifecycle, background jobs, and the git round trip were run on real machines with a stand-in `claude` script. The GitHub push flow has been tested only with a fake sandbox and a local bare repo.

## Limits
- The directory must be a git repo with at least one commit.
- Untracked and ignored files are not sent. Subagents cannot use your local MCP servers or settings.
- A single turn is stopped after 29 minutes. Nested subagents are not routed to the cloud.
- A branch that began from uncommitted edits includes a stash-style snapshot commit in its history, and it is pushed to GitHub.
- Only work pushed to GitHub survives a lost sandbox. Start large swarms in batches of about 10-25 per minute and send work in waves of about 25.
- No retries. Failures return an error with the exit code and the last 4000 characters of stderr;
  commits made before the failure are still pushed.
- Needs `git`, `node` 20+, and `claude` on PATH.
- The sandbox runs `claude` with permission checks off and holds your Claude credential, so a prompt injection there could misuse or leak it.
- `subagent_type` only works for agents committed in the repo or built into Claude Code; agents in `~/.claude/agents` are not sent.
- Skills that fork their own subagent (`context: fork`) are not intercepted.
- Setting `ANTHROPIC_API_KEY` also moves the parent session to API billing.
