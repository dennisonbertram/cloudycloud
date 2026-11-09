# What is Cloudy Cloud?

> What Cloudy Cloud is, how it differs from running subagents locally, who it is for and what it costs.

Source: https://cloudycloud.tech/docs/what-is-cloudy-cloud.html

Cloudy Cloud is open-source software (MIT license, install with npx cloudycloud setup) that gives every Claude Code subagent its own cloud machine, a copy of your repo, and its own branch.

## What is Cloudy Cloud?

Cloudy Cloud is a command, `cloudy-cloud`, that starts Claude Code with an extra MCP server. The server adds tools such as `cloud_agent`. When Claude hands work to a subagent, Cloudy Cloud creates a cloud machine, uploads a snapshot of your repo, runs Claude there, and pushes the result to a branch named `cloudy-cloud/<id>` on your GitHub repo.

In a `cloudy-cloud` session, the built-in `Agent` and `Workflow` tools are turned off, so subagents run in the cloud and not on your laptop. Sessions you start with plain `claude` are not changed. See [How it works](https://cloudycloud.tech/docs/how-it-works.html) for each step.

## How is it different from running subagents locally?

Subagents that run on your laptop share its CPU, memory and battery with you, so their builds and tests can slow your session down. With Cloudy Cloud you still start and steer everything from your laptop, but each subagent runs on its own machine in the cloud.

- **Where it runs:** on a cloud machine, one per subagent.
- **What it sees:** files tracked by git in your repo, including uncommitted edits. It cannot see untracked files, your local MCP servers or your personal Claude settings.
- **What you get back:** a git branch per subagent, `cloudy-cloud/<id>`, pushed to your GitHub repo, plus a reply with the branch, commit and token totals.
- **How long it lives:** a subagent stops after 60 idle minutes or when your session ends. Its machine is deleted at a fixed deadline, 6 hours by default and 24 at most. Only work pushed to GitHub is kept.

## Who is it for?

It is for people who use Claude Code and want subagents to run on cloud machines instead of on their own computer. You need a GitHub repo you can push to, because each subagent pushes its work there.

For a long job that must keep going with your laptop closed, use a [cloud coordinator](https://cloudycloud.tech/docs/fleets.html), which runs on its own machine.

## What do I need?

- An account with a cloud sandbox provider. Instabox is supported today.
- A Claude subscription or API key.
- A GitHub repo you can push to.
- Node.js 20 or later.

Subagents run Claude by default. They can also run open models such as GLM and DeepSeek. See [Models and keys](https://cloudycloud.tech/docs/models.html).

## What does it cost?

Cloudy Cloud is open source under the MIT license, and the tool itself has no price in this repo. You pay your own providers: your Instabox plan, your Claude subscription or API usage, and any open-model provider you use. The free Instabox plan is too small for more than a few subagents at once.

## How do I install it?

Run this once in a terminal:

```
npx cloudycloud setup
```

It checks your tools, offers to install the `cloudy-cloud` command, and asks for your keys. The steps are in [Getting started](https://cloudycloud.tech/docs/). The source is on [GitHub](https://github.com/dennisonbertram/cloudycloud) and the package is [cloudycloud on npm](https://www.npmjs.com/package/cloudycloud).

## Where to read next

- [FAQ](https://cloudycloud.tech/docs/faq.html) for short answers.
- [Glossary](https://cloudycloud.tech/docs/glossary.html) for the terms used in these docs.
- [Command and tool reference](https://cloudycloud.tech/docs/reference.html) for every command and option.
