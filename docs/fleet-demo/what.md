# What claude-cloud is

claude-cloud runs Claude Code subagents in the cloud instead of on your machine.
When your session uses a subagent, that subagent runs as its own Claude Code on its own Instabox cloud machine.
Each subagent works on a copy of your repo and commits its work there.
It then pushes that work to a `claude-cloud/<id>` branch on your GitHub repo.
Subagents stay open for follow-up messages until they are stopped, and plain `claude` is unaffected.
