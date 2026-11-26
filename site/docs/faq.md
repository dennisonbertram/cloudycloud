# FAQ

> Short answers about what Cloudy Cloud does, what it needs, what it keeps and how to remove it.

Source: https://cloudycloud.tech/docs/faq.html

Short answers about what Cloudy Cloud does, what it needs, what it keeps and how to remove it.

## Questions

### What is a subagent?

When your coding agent (Claude Code, Codex, opencode, pi or free-pi) hands a piece of work to a helper agent, that helper is a subagent. Cloudy Cloud runs each helper on its own cloud machine instead of on your laptop.

### How do I start Cloudy Cloud?

Run `cloudy-cloud` instead of `claude`, from inside a git repo with a GitHub remote. It starts a normal Claude Code session in which every subagent runs on its own cloud machine. To use another main session, run `cloudy-cloud codex`, `cloudy-cloud opencode`, `cloudy-cloud pi` or `cloudy-cloud free-pi`. `cloudycloud` is the same command; if you skipped the global install, use `npx cloudycloud`. Set it up first with `npx -y cloudycloud setup`.

### What do I need?

An account with a configured sandbox provider, a GitHub repo you can push to, Node.js 20 or later, and a credential for each agent your workers use: a Claude subscription or API key for Claude Code workers (the default), or the provider key for a profile (Particle.ai, OpenRouter or OpenAI, or a ChatGPT login for Codex). Provider support varies by feature and limits; see [provider settings](https://cloudycloud.tech/docs/reference.html#env-settings) and [Models and keys](https://cloudycloud.tech/docs/models.html).

### What can a subagent see?

Files tracked by git in your repo, including uncommitted edits. It can't see untracked files or your personal agent settings (for example your Claude settings). It has MCP servers only if you copy them with `cloudy-cloud mcp add`. Add a new file with `git add` if the subagent needs it.

### Can subagents use my MCP servers?

Yes, the ones you choose. Run `cloudy-cloud mcp add NAME` for each server. Remote `https` servers on public hosts and `npx` or `uvx` servers work. OAuth sign-in, localhost, local paths and secrets in URLs or arguments do not, and `pi` workers skip `sse` servers. Tokens stay in Instabox. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

### What happens to the machines?

A subagent stops after 60 idle minutes. In the default ephemeral MCP mode, it also stops when the session ends. With `cloudy-cloud mcp-server --session NAME --repo PATH`, separate MCP connections can reconnect to the same local owner while it is running. The provider deletes the machine at its configured deadline. Only work pushed to GitHub is kept.

### What is kept after a subagent stops?

Only work pushed to GitHub on branch `cloudy-cloud/<id>`. The machine is deleted.

### Is it safe?

Your GitHub token never reaches the cloud machine. Subagents run with permission checks off, so protect your main branch. The [setup guide](https://github.com/dennisonbertram/cloudycloud/blob/HEAD/docs/RUNBOOK.md) shows how. See [Security](https://cloudycloud.tech/docs/troubleshooting.html#security) for which credentials reach the cloud machine.

### Does it change plain `claude`?

Launching `cloudy-cloud` does not change ordinary `claude` sessions. Cloudy Cloud runs only in sessions where its MCP server is configured.

### What does it cost?

The tool itself has no price in this repo. You pay for your Instabox plan, your Claude subscription or API usage, and any open-model provider you use. The free Instabox plan is too small for more than a few subagents at once. Results end with a token total, and a cost when Claude reports one.

### Which models and agents can subagents use?

Workers use the saved default profile (Claude Code unless you changed it with `cloudy-cloud setup --default-profile NAME`). A per-request `profile` can choose pi, oh-my-pi, Codex, opencode, or a different model. Status of each agent: [what has been verified](https://cloudycloud.tech/docs/models.html#verified). See [Models and keys](https://cloudycloud.tech/docs/models.html).

### Can I use my own computer?

Yes. Run `cloudy-cloud setup --provider self-hosted` to send subagents to a Mac or Linux machine you own, reached over SSH (for example through Tailscale). Each subagent runs in its own Docker container there. You must allow the GitHub token on that machine. Coordinators work through Docker images but have not been run live yet. See [Run on your own machine](https://cloudycloud.tech/docs/self-hosted.html).

### Can work continue with my laptop closed?

A named MCP session can outlive an individual client connection on the same computer, but it still depends on that local owner process and provider machine deadlines. For work that must continue with your computer offline, use a [cloud coordinator](https://cloudycloud.tech/docs/fleets.html).

### How do I uninstall it?

Delete leftover machines first. If you installed with `npx cloudycloud setup`, run `npm uninstall -g cloudycloud`, then delete `~/.config/cloudy-cloud`, `~/.claude/skills/cloud-fleet`, `~/.claude/skills/cloudy-cloud-setup` and `~/.claude/skills/cloud-dev` (only those setup installed; keep any skill folder you made yourself). The full steps, including the install-from-clone case and deleting the subagent branches on GitHub, are in [Troubleshooting](https://cloudycloud.tech/docs/troubleshooting.html#faq-uninstall).

### Is there a hosted version?

Not yet. A hosted version is coming. Today Cloudy Cloud is open source (MIT) and you bring your own keys: your cloud account, your Claude credentials and your GitHub token.

### Is it affiliated with Anthropic?

No.

## More help

For error messages and fixes, see [Troubleshooting, security and FAQ](https://cloudycloud.tech/docs/troubleshooting.html). For the terms used here, see the [Glossary](https://cloudycloud.tech/docs/glossary.html).
