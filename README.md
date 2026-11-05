# claude-cloud

`claude-cloud [claude args...]` starts normal Claude Code, but every subagent runs in a
remote [E2B](https://e2b.dev) sandbox (template `claude`). Plain `claude` is unaffected.

## Setup
    npm install
    npm link            # or symlink bin/claude-cloud onto your PATH
    export E2B_API_KEY=...
    export CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`; or set ANTHROPIC_API_KEY

## How it works
The launcher disables the built-in `Agent` and `Workflow` tools and adds an MCP tool,
`mcp__cloud__cloud_agent`. Each call snapshots your repo's tracked files (including uncommitted
edits), sends a git bundle to a new sandbox, runs `claude -p` there, and returns the text.
Any commits the subagent makes come back as a local branch `claude-cloud/<id>`. Your working
tree, index, and current branch are not touched. Secrets reach the tool through
`${VAR:-}` expansion in the MCP config, so they never appear in process arguments.

## Limits
- The directory must be a git repo with at least one commit.
- Untracked and ignored files are not sent. Subagents cannot use your local MCP servers or settings.
- Sandbox lifetime is 30 minutes; the subagent is stopped after 29. Nested subagents are not routed to the cloud.
- A branch that began from uncommitted edits includes a stash-style snapshot commit in its history.
- No retries. Failures return an error with the exit code and the last 4000 characters of stderr;
  commits made before the failure are still recovered.
- Needs `git`, `node` 20+, and `claude` on PATH.
- Not yet run in a real E2B sandbox. Tested with a fake sandbox, and against real Claude Code with a placeholder E2B key.
- The sandbox runs `claude` with permission checks off and holds your Claude credential, so a prompt injection there could misuse or leak it.
- `subagent_type` only works for agents committed in the repo or built into Claude Code; agents in `~/.claude/agents` are not sent.
- Skills that fork their own subagent (`context: fork`) are not intercepted.
- Setting `ANTHROPIC_API_KEY` also moves the parent session to API billing.
