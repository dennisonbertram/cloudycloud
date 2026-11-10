# Glossary

> The terms used in the Cloudy Cloud docs, such as subagent, worker, coordinator, profile and delete deadline.

Source: https://cloudycloud.tech/docs/glossary.html

The terms used in the Cloudy Cloud docs, with one short definition each.

## Terms

### Subagent

A helper agent that Claude Code hands a piece of work to. Cloudy Cloud runs each subagent on its own cloud machine instead of on your laptop.

### Cloud agent

A Claude subagent started with the `cloud_agent` tool: it runs in a remote sandbox on the committed and tracked files of your repo and pushes its work to its own branch.

### Worker

The default role of a cloud agent: it does the task it was given and does not start agents of its own.

### Coordinator

A cloud agent started with `role: "coordinator"`, which gets `cloudy-cloud` installed and can start its own cloud agents, limited by `CLOUDY_CLOUD_MAX_DEPTH` (default 3). A cloud coordinator is the longer-lived kind that runs on its own machine and keeps working with your laptop closed.

### Box (machine)

The cloud machine, an Instabox sandbox, that Cloudy Cloud creates for one cloud agent. It is deleted when the agent stops or at its delete deadline.

### Profile

A named setting that runs a worker on another model, such as `glm`, `deepseek` or `openrouter`. With no profile, a subagent runs Claude.

### Branch cloudy-cloud/<id>

The git branch a subagent works on and pushes to your `origin` remote; `<id>` is the agent id shown by `cloud_agent_list`.

### Task mode

The way `cloud_agent` runs as a background task when your Claude Code supports MCP tasks, so its progress shows in `/tasks` and its result arrives on its own.

### Idle stop

Cloudy Cloud stops a subagent that has been idle for 60 minutes, and stops every subagent when the session ends.

### Delete deadline

The fixed time at which Instabox deletes a machine in any state: 6 hours by default for workers (set `CLOUDY_CLOUD_WORKER_HOURS`, up to 24) and at most 24 hours for a cloud coordinator. It cannot be extended, so push your work before it.

### Reaper

A separate cleanup process that the session starts. After the session is gone, even after a hard kill, it deletes every machine the session created.

### Setup-token

The long-lived token that `claude setup-token` creates (it starts with `sk-ant-oat01-`). It lets cloud agents use your Claude subscription, as `CLAUDE_CODE_OAUTH_TOKEN`.

### Event log

The file `~/.config/cloudy-cloud/events.jsonl`, where the MCP server appends one JSON line per agent event. It stays on your computer and the dashboard reads it.

### Dashboard

A read-only web page on your own machine, opened with `cloudy-cloud dashboard`, that shows every box and the messages between your session and each subagent.

## Related pages

See [How it works](https://cloudycloud.tech/docs/how-it-works.html), [Command and tool reference](https://cloudycloud.tech/docs/reference.html) and the [FAQ](https://cloudycloud.tech/docs/faq.html).
