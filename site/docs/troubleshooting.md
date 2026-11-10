# Troubleshooting, security and FAQ

> Fix common errors, see which credentials reach the cloud, and read answers to common questions.

Source: https://cloudycloud.tech/docs/troubleshooting.html

Find the message you see, what causes it, and the command that fixes it. The security and FAQ sections follow.

## Troubleshooting

### "cloudy-cloud is not set up yet"

A key is missing from `~/.config/cloudy-cloud/env`. In a terminal, `cloudy-cloud` asks `Run setup now? [Y/n]`. Without a terminal it exits with status 1. Run setup yourself:

```
cloudy-cloud setup
```

If you changed a key but the session still uses the old one, restart `cloudy-cloud`. It reads keys once, at start.

### The installer rejects a key

- `Got 103 of 108 characters, so it looks cut off`: the Claude token was cut short when pasted. Press Enter at the Claude step so the installer gets the token itself, or copy the whole token again.
- `Got N of 56 characters` or `starts like an Instabox key`: the Instabox key is incomplete or has a typo. The dashboard shows a key only once. If you lost it, create a new one at https://dashboard.instabox.sh/dashboard/api-keys.
- `Claude rejected this token`: the token is revoked or from another login. Run `cloudy-cloud setup` and press Enter at the Claude step.
- `Stopped the ... step after 3 tries`: nothing was changed and the saved key stays. Run `cloudy-cloud setup` again.

### "malformed API key" or 401 from Instabox

The Instabox key is wrong or revoked. Run `cloudy-cloud setup`, replace the key, and restart `cloudy-cloud`.

### No git repository, or no github.com origin

The launcher warns `This folder is not a git repository, so subagents can't start here.` or `This repo has no github.com origin, so subagents can't push their work.` Run `cloudy-cloud` from inside a repo and add an origin:

```
git remote add origin https://github.com/OWNER/REPO.git
```

Your GitHub token must also include that repository.

### The first push failed, or "Push failed"

`The first push to origin cloudy-cloud/<id> failed` usually means the `GH_TOKEN` Instabox secret is missing or the token cannot write to this repo. Run `cloudy-cloud setup`, replace the GitHub token, and check the token's repository list. The secret must be named exactly `GH_TOKEN`. The same fix applies to `The GH_TOKEN Instabox secret could not be attached`.

After each task, `cloudy-cloud` pushes once more, retrying once after five seconds. If that fails, the result says `Push failed: ...; the agent is still open, ask it to push.` It may also list `Uncommitted changes left in the sandbox`. The tool never commits for the agent. While the agent is open, ask it to commit and push.

### "The sandbox could not be reached to push"

The machine is gone or not answering. The result continues: `Only work the agent already pushed to origin cloudy-cloud/<id> survives.` Fetch that branch:

```
git fetch origin cloudy-cloud/<id>
```

Unpushed work on that machine is lost. A failed agent cannot take messages. Use `cloud_agent_wait` to read the error, then `cloud_agent_stop`.

### "Subagent failed, exit code N"

The Claude run on the machine exited with an error. The result includes its error output, the push status and the token totals. If the output says `Not logged in · Please run /login` or shows a 401, no valid Claude token reached the machine. Run `claude setup-token`, then `cloudy-cloud setup` and replace the Claude token, then restart. This also happens if you only export `ANTHROPIC_API_KEY`, because wrappers such as cmux's `claude` remove it.

### A subagent stays "queued"

Starts are paced (`CLOUDY_CLOUD_STARTS_PER_MIN`, default 25 a minute), or your Instabox plan's machine limit is full (`quota_exceeded`). Paused machines count toward the limit. A subagent blocked by the quota retries every 60 seconds for up to 30 minutes, then fails with Instabox's message. Stop subagents you do not need, delete leftover machines (below), or upgrade the plan.

If you see `rate_limited` after 5 tries, lower `CLOUDY_CLOUD_STARTS_PER_MIN` and restart `cloudy-cloud`.

### An agent was stopped for being idle

An agent with nothing to do is stopped after 60 minutes and its machine is deleted. A message to it then returns `Agent <id> is not open. It may have been stopped, been idle for 60 minutes, or never existed.` A single task is also stopped after 29 minutes. Start a new subagent from the branch the old one pushed.

### "This session has already started N agents"

One session may start 200 agents by default. Stop idle agents or raise `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION`.

### Leftover machines

When a session ends, a separate cleanup process deletes that session's machines, even after a hard kill. It deletes only machines labelled with that session's id, so it never touches coordinators. Instabox also deletes every machine at its delete deadline (6 hours by default for workers, 24 at most). To check by hand:

```
npx instabox@latest ls
npx instabox@latest rm <name>
```

Machines made by this tool have the label `purpose=cloudy-cloud`. To stop a cloud coordinator, run `cloudy-cloud coordinator stop NAME`.

### The session says the built-in Agent tool is unavailable

This is expected. `cloudy-cloud` turns off Claude Code's built-in `Agent` and `Workflow` tools. Ask for "a subagent" and it uses `cloud_agent`. Plain `claude` keeps its built-in tools.

### Dashboard problems

- `This dashboard link is missing its access key, or it is from an earlier run.` (a plain 401 page), or the heading `This link is from an earlier run` on an open dashboard page: you opened an old or edited link, or the dashboard was restarted. Open the newest link that `cloudy-cloud dashboard` printed, or run it again. The token changes on every run.
- `The dashboard cannot reach its server`, or the banner `The dashboard server is not answering` (the list may be out of date): the dashboard process stopped. Run `cloudy-cloud dashboard` again and open the new link.
- `Live machines unavailable.`: the page could not list machines from Instabox. Check your connection and that `INSTABOX_API_KEY` in `~/.config/cloudy-cloud/env` is still valid. Session history still shows.

See [Dashboard and app previews](https://cloudycloud.tech/docs/dashboard.html) for the full dashboard guide.

### MCP server problems

- `The Instabox secret MCP_..._TOKEN could not be attached`: the secret does not exist. Create it with `printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NAME_TOKEN --host HOST`. Creating a secret needs your `instabox login` session, not the API key.
- `MCP servers skipped: NAME (REASON)` at the end of a reply: the entry in `mcp.json` did not pass the checks. Fix it in Claude Code and run `cloudy-cloud mcp add NAME` again.
- `MCP servers: ... (failed: NAME)`: the server was sent but did not connect on the machine. Check the token, the host in `--host` and the server's address.
- `Could not read FILE: ...`: `mcp.json` is not valid JSON. Fix or delete the file.

See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html) for what a cloud machine can and cannot run.

## Security

### What runs where

Your Claude Code session and the `cloudy-cloud` tool server run on your machine. Each subagent runs `claude -p` on its own Instabox machine, on a snapshot of your repo's tracked files. Subagents run with permission checks off, so protect your main branch with a GitHub ruleset that blocks direct pushes. The GitHub token can push to any branch it reaches.

### Which credentials reach the cloud machine

- **Claude token:** placed on each machine. It can only make model requests.
- **GitHub token:** never reaches the machine. Instabox stores it as the secret `GH_TOKEN`. The machine sees a placeholder that Instabox's proxy replaces on requests to `github.com` and `api.github.com`.
- **Instabox key:** stays in `~/.config/cloudy-cloud/env` (readable only by you) and in the tool server. It is never put in process arguments.
- **MCP server tokens:** only for servers you added with `cloudy-cloud mcp add`. The token stays in Instabox as `MCP_<NAME>_TOKEN`, and the machine sees a placeholder that Instabox replaces in request headers to the host you named. The subagent can use the token against that host but cannot read it. Never create the secret without `--host`. With `--allow-literal` the real token is on the machine. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).
- **Provider keys** (for example Particle): these sit on the worker machines that use them. See [Models and keys](https://cloudycloud.tech/docs/models.html).

Create the GitHub token as a fine-grained token, limited to the repos you use, with Contents read and write.

### The dashboard is local only

The dashboard is a read-only page on `127.0.0.1`. Requests without the random per-run token, or with another `Host` header, are refused. Keys never reach the browser.

### The event log

The tool server appends one JSON line per event to `~/.config/cloudy-cloud/events.jsonl` (folder mode 700, file mode 600). Prompts can contain code, so the file stays on your machine. Exact secret values are scrubbed and key-shaped text is redacted before writing. The file is never rotated. Delete it to clear history.

### Revoking keys

Revoke the Instabox key in the Instabox dashboard, the GitHub token at https://github.com/settings/personal-access-tokens, and the Claude token by revoking it in your Claude account. Then run `cloudy-cloud setup` to enter new ones. To remove saved keys from your machine:

```
rm ~/.config/cloudy-cloud/env
```

> Warning: On a cloud coordinator, `~/.config/cloudy-cloud/env` holds the real Instabox key, the Claude token and your provider keys. Anyone who can SSH into the coordinator can read them. Use keys you can revoke.

## FAQ

### What does it cost?

The tool itself has no price in this repo. You pay for your Instabox plan, your Claude subscription or API usage, and any open-model provider you use. The free Instabox plan is too small for more than a few subagents at once. Results end with a token total, and a cost when Claude reports one.

### Which models can subagents use?

Claude by default, or open models such as GLM and DeepSeek through Particle.ai or OpenRouter. See [Models and keys](https://cloudycloud.tech/docs/models.html).

### Does it copy untracked files?

No. A subagent gets files tracked by git, including uncommitted edits to them. Add a new file with `git add` if the subagent needs it.

### Can work continue with my laptop closed?

Not from a laptop session: subagents stop when the session ends. For work that must continue with the laptop closed, use a [cloud coordinator](https://cloudycloud.tech/docs/fleets.html).

### What is kept after a subagent stops?

Only work pushed to GitHub on branch `cloudy-cloud/<id>`. The machine is deleted.

### Does it change plain `claude`?

No. Only sessions you start with `cloudy-cloud` use the cloud.

### How do I uninstall it?

Delete leftover machines first (see above). If you installed with `npx cloudycloud setup`, run:

```
npm uninstall -g cloudycloud
rm -rf ~/.config/cloudy-cloud ~/.claude/skills/cloud-fleet ~/.claude/skills/cloudy-cloud-setup
```

If you installed from a git clone, run `npm unlink -g cloudycloud` instead (also `npm unlink -g cloudy-cloud` for a clone from before the package was renamed), then delete the clone.

To delete the subagent branches on GitHub, run this in your repo:

```
git ls-remote --heads origin 'cloudy-cloud/*' | awk '{print $2}' | xargs -n 50 git push origin --delete
```

### Is it affiliated with Anthropic?

No.
