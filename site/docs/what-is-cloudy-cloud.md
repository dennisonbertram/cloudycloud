# What is Cloudy Cloud?

> What Cloudy Cloud is, how it differs from running subagents locally, who it is for and what it costs.

Source: https://cloudycloud.tech/docs/what-is-cloudy-cloud.html

Cloudy Cloud is open-source software (MIT license, install with npx cloudycloud setup) that gives every subagent of your coding agent its own cloud machine, a copy of your repo, and its own branch.

It works with Claude Code, Codex, opencode, pi and free-pi as your main session, and Claude Code, pi, oh-my-pi, Codex and opencode as the agent that runs on each cloud machine. Claude Code is the default for both. free-pi can only be a main session.

## What is Cloudy Cloud?

Cloudy Cloud is a command, `cloudy-cloud`, that starts a coding agent (Claude Code by default) with an extra MCP server. The server adds tools such as `cloud_agent`. When your session hands work to a subagent, Cloudy Cloud creates a cloud machine, uploads a snapshot of your repo, runs the worker agent there (Claude Code by default), and pushes the result to a branch named `cloudy-cloud/<id>` on your GitHub repo.

In a `cloudy-cloud` session, the built-in `Agent` and `Workflow` tools are turned off, so subagents run in the cloud and not on your laptop. Sessions you start with plain `claude` are not changed. See [How it works](https://cloudycloud.tech/docs/how-it-works.html) for each step.

## How is it different from running subagents locally?

Subagents that run on your laptop share its CPU, memory and battery with you, so their builds and tests can slow your session down. With Cloudy Cloud you still start and steer everything from your laptop, but each subagent runs on its own machine in the cloud.

- **Where it runs:** on a cloud machine, one per subagent.
- **What it sees:** files tracked by git in your repo, including uncommitted edits. It cannot see untracked files or your personal Claude settings. It has your MCP servers only if you copy them with `cloudy-cloud mcp add`.
- **What you get back:** a git branch per subagent, `cloudy-cloud/<id>`, pushed to your GitHub repo, plus a reply with the branch, commit and token totals.
- **How long it lives:** a subagent stops after 60 idle minutes or when your session ends. Its machine is deleted at a fixed deadline, 6 hours by default and 24 at most. Only work pushed to GitHub is kept.

## Who is it for?

It is for people who use a coding agent (Claude Code, Codex, opencode, pi or free-pi) and want subagents to run on cloud machines instead of on their own computer. You need a GitHub repo you can push to, because each subagent pushes its work there.

For a long job that must keep going with your laptop closed, use a [cloud coordinator](https://cloudycloud.tech/docs/fleets.html), which runs on its own machine.

## What do I need?

- An account with a sandbox provider. Instabox is the default; a machine you own over SSH (self-hosted) and microsandbox on this computer also work.
- A credential for each kind of worker you run. For Claude Code workers and coordinators, a Claude subscription or API key. Workers on pi, oh-my-pi, Codex or opencode use another credential instead; see [Models and keys](https://cloudycloud.tech/docs/models.html). Setup asks for a Claude token only if you use Claude; see [Getting started](https://cloudycloud.tech/docs/index.html#agent-credentials).
- A GitHub repo you can push to.
- Node.js 20 or later.

Subagents run Claude Code by default. A profile can run them on open models such as GLM and DeepSeek, or on another agent: pi, oh-my-pi, Codex or opencode. See [Models and keys](https://cloudycloud.tech/docs/models.html).

## What does it cost?

Cloudy Cloud is open source under the MIT license, and the tool itself has no price in this repo. You pay your own providers: your sandbox provider plan (such as an Instabox plan), your Claude subscription or API usage, and any other provider (OpenAI, open-model hosts) you use. The free Instabox plan is too small for more than a few subagents at once.

## How do I start it?

In a terminal, inside a git repo with a GitHub remote, run the command for your agent where you would run that agent: `cloudy-cloud` for Claude Code, `cloudy-cloud codex`, `cloudy-cloud opencode`, `cloudy-cloud pi` or `cloudy-cloud free-pi`. It opens a normal session of that agent; when the session uses a subagent, that subagent runs on its own cloud machine and pushes its work to the branch `cloudy-cloud/<id>`. `cloudycloud` is the same command, and `npx cloudycloud` works without a global install.

## How do I install it?

Run this once in a terminal:

```
npx -y cloudycloud setup
```

It checks your tools, offers to install the `cloudy-cloud` command, and asks for your keys. The steps are in [Getting started](https://cloudycloud.tech/docs/). The source is on [GitHub](https://github.com/dennisonbertram/cloudycloud) and the package is [cloudycloud on npm](https://www.npmjs.com/package/cloudycloud).

## Where to read next

- [FAQ](https://cloudycloud.tech/docs/faq.html) for short answers.
- [Glossary](https://cloudycloud.tech/docs/glossary.html) for the terms used in these docs.
- [Command and tool reference](https://cloudycloud.tech/docs/reference.html) for every command and option.
