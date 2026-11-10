# FAQ

> Short answers about what Cloudy Cloud does, what it needs, what it keeps and how to remove it.

Source: https://cloudycloud.tech/docs/faq.html

Short answers about what Cloudy Cloud does, what it needs, what it keeps and how to remove it.

## Questions

### What is a subagent?

When Claude Code hands a piece of work to a helper agent, that helper is a subagent. Cloudy Cloud runs each helper on its own cloud machine instead of on your laptop.

### How do I start Cloudy Cloud?

Run `cloudy-cloud` instead of `claude`, from inside a git repo with a GitHub remote. It starts a normal Claude Code session in which every subagent runs on its own cloud machine. `cloudycloud` is the same command; if you skipped the global install, use `npx cloudycloud`. Set it up first with `npx -y cloudycloud setup`.

### What do I need?

An account with a cloud sandbox provider (Instabox is supported today), a Claude subscription or API key, a GitHub repo you can push to, and Node.js 20 or later.

### What can a subagent see?

Files tracked by git in your repo, including uncommitted edits. It can't see untracked files, your local MCP servers, or your personal Claude settings. Add a new file with `git add` if the subagent needs it.

### What happens to the machines?

A subagent stops after 60 idle minutes or when your session ends. Its machine is deleted after 6 hours by default, 24 at most. Only work pushed to GitHub is kept.

### What is kept after a subagent stops?

Only work pushed to GitHub on branch `cloudy-cloud/<id>`. The machine is deleted.

### Is it safe?

Your GitHub token never reaches the cloud machine. Subagents run with permission checks off, so protect your main branch. The [setup guide](https://github.com/dennisonbertram/cloudycloud/blob/HEAD/docs/RUNBOOK.md) shows how. See [Security](https://cloudycloud.tech/docs/troubleshooting.html#security) for which credentials reach the cloud machine.

### Does it change plain `claude`?

No. Only sessions you start with `cloudy-cloud` use the cloud.

### What does it cost?

The tool itself has no price in this repo. You pay for your Instabox plan, your Claude subscription or API usage, and any open-model provider you use. The free Instabox plan is too small for more than a few subagents at once. Results end with a token total, and a cost when Claude reports one.

### Which models can subagents use?

Claude by default, or open models such as GLM and DeepSeek through Particle.ai or OpenRouter. See [Models and keys](https://cloudycloud.tech/docs/models.html).

### Can work continue with my laptop closed?

Not from a laptop session: subagents stop when the session ends. For work that must continue with the laptop closed, use a [cloud coordinator](https://cloudycloud.tech/docs/fleets.html).

### How do I uninstall it?

Delete leftover machines first. If you installed with `npx cloudycloud setup`, run `npm uninstall -g cloudycloud`, then delete `~/.config/cloudy-cloud`, `~/.claude/skills/cloud-fleet` and `~/.claude/skills/cloudy-cloud-setup`. The full steps, including the install-from-clone case and deleting the subagent branches on GitHub, are in [Troubleshooting](https://cloudycloud.tech/docs/troubleshooting.html#faq-uninstall).

### Is there a hosted version?

Not yet. A hosted version is coming. Today Cloudy Cloud is open source (MIT) and you bring your own keys: your cloud account, your Claude credentials and your GitHub token.

### Is it affiliated with Anthropic?

No.

## More help

For error messages and fixes, see [Troubleshooting, security and FAQ](https://cloudycloud.tech/docs/troubleshooting.html). For the terms used here, see the [Glossary](https://cloudycloud.tech/docs/glossary.html).
