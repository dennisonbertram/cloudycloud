# Limits

- Subagents see only files tracked by git, including uncommitted edits to tracked files; untracked files are not copied to workers.
- An idle subagent is stopped after 60 minutes, a single task is stopped after 29 minutes, and every subagent stops when the session ends.
- `CLAUDE_CLOUD_MAX_DEPTH` (default 3) caps coordinator levels below your session; workers cannot start agents, so they do not add depth.
- `CLAUDE_CLOUD_MAX_AGENTS_PER_SESSION` (default 200) caps the agents one claude-cloud server may start; further starts are refused.
- Starts are paced at `CLAUDE_CLOUD_STARTS_PER_MIN` per minute (default 25), Instabox requests share `CLAUDE_CLOUD_MAX_INSTABOX_CALLS` slots (default 24), and your plan's machine limit queues the rest.
