# claude-cloud runbook

This covers setting up `claude-cloud`, using it, operating it day to day, and fixing common problems.

## 1. What you need

| Item | Notes |
| --- | --- |
| macOS or Linux | Tested on macOS. |
| `git` and Node.js 20 or later | Check with `git --version` and `node --version`. |
| [Claude Code](https://code.claude.com) | Check with `claude --version`. You must be signed in. |
| A Claude subscription or Anthropic API key | Subagents use a long-lived token from `claude setup-token`. An API key works too but is billed separately. |
| An [Instabox](https://instabox.sh) account | **Free plan:** too small for more than a few subagents at once. **Paid plan:** needed for swarms. |
| A GitHub repository you can push to | Subagents push their branches there. |

## 2. One-time setup

### 2.1 Install the tool

```sh
git clone https://github.com/dennisonbertram/ai-seamless-sandboxes.git
cd ai-seamless-sandboxes
npm install
npm link
```

`npm link` puts `claude-cloud` on your PATH. Check with `which claude-cloud`.

### 2.2 Create an Instabox API key

1. Sign in at https://dashboard.instabox.sh.
2. Open **API keys** and create a key. It starts with `ibk_`.
3. Keep it for step 2.5.

### 2.3 Create a Claude token for subagents

```sh
claude setup-token
```

This prints a long-lived token, which you will use in step 2.5. Subagents use it, so your own session keeps its normal login.

### 2.4 Give subagents GitHub access

Subagents push their work to GitHub. Instabox stores the GitHub token and adds it only to requests to GitHub, so a subagent's machine sees a placeholder, never the token.

1. **Create a fine-grained GitHub token** at https://github.com/settings/personal-access-tokens/new.
   - **Repository access:** *Only select repositories*. Choose only the repos you will use `claude-cloud` in.
   - **Permissions:** *Contents*, read and write. *Metadata*, read-only, is added automatically.
   - **Expiration:** your choice. Shorter limits the damage if it leaks.
2. **Store it in Instabox.** An Instabox API key cannot create secrets, so you sign in with the CLI first:

   ```sh
   npx instabox@latest login
   npx instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com
   ```

   Paste the GitHub token when asked; nothing appears as you paste. The name must be exactly `GH_TOKEN`.
3. **Protect your main branch.** In the repo on GitHub, open *Settings → Rules → Rulesets* and add a branch ruleset that blocks direct pushes to your main branch. Subagents run with permission checks off, and the token can push to any branch it reaches.

### 2.5 First run

The repo you work in needs a GitHub `origin` that your token can push to:

```sh
cd <your repo>
git remote -v        # should show github.com
claude-cloud
```

The first run asks for your Instabox key and Claude token. Nothing appears as you type. It saves them to `~/.config/claude-cloud/env`, which only your user account can read, and doesn't ask again.

## 3. Check that it works

In the `claude-cloud` session, type:

```
use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
```

**Expected:** the answer names a hostname starting with `instabox-sbx-`, and ends with `Pushed to origin claude-cloud/<id> at <sha>`. Then confirm the file reached GitHub:

```sh
git fetch origin claude-cloud/<id>
git show FETCH_HEAD:proof.txt
```

## 4. Daily use

- **Start:** run `claude-cloud` from inside the repo you want subagents to work on.
- **Ask for subagents in plain language.** The session decides when to use them.
  - "use 5 subagents in parallel to …"
  - "ask the second subagent to also …"
  - "list the subagents"
  - "stop all subagents"
- **Collect work** from GitHub. Each subagent has its own branch:

  ```sh
  git fetch origin 'refs/heads/claude-cloud/*:refs/remotes/origin/claude-cloud/*'
  git branch -r --list 'origin/claude-cloud/*'
  ```

  Merge, cherry-pick or open pull requests from these branches as usual.
- **Watch and stop subagents.** In a terminal session on Claude Code 2.1.304 or later, each subagent call is an MCP task:
  - The footer shows `N MCP tasks`.
  - `/tasks` shows one line per task, updated every few seconds: `12 tool uses · 48.2k tokens · 3m10s · Edit src/parser.ts`. `starting machine…` means the machine is not up yet. The tokens are input (including cached input) plus output.
  - Select a task and press `x` to stop it. For a task started by `cloud_agent` this stops the agent and deletes its machine. For a task started by `cloud_agent_message` it stops only that follow-up, and the agent stays open and idle.
  - The result reaches the session by itself when the task ends. It ends with a line such as `Total: 12 tool uses, 93.1k in / 327 out tokens, $0.0078, 3m10s` (the cost appears when Claude reports it).
  - Asking "list the subagents" shows the same progress line for each one.
- **Without tasks.** In the VS Code extension, the desktop app, or a one-shot `claude -p "<prompt>"` run, Claude Code does not make MCP tasks. The tools then return an agent ID and Claude uses `cloud_agent_wait`, exactly as in older versions. Nothing needs configuring. Task mode is not turned on or off with any setting of this tool, so do not set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` or `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`.
- **Large swarms.** Ask the session to pace them, for example "start the 50 subagents in batches of 10 per minute, and send them work in waves of about 25". Without pacing, some starts fail; see section 6.
- **When subagents stop:**
  - when you or the session stops them;
  - after 60 minutes with nothing to do;
  - when the session ends.

  Their machines are deleted at that point. Anything a subagent didn't push is lost with its machine.

## 5. Maintenance

| Task | Command or step |
| --- | --- |
| **List cloud machines** | `npx instabox@latest ls`. Machines created by this tool have the label `purpose=claude-cloud`. |
| **Delete a leftover machine** | `npx instabox@latest rm <name>` |
| **Delete all subagent branches on GitHub** | `git ls-remote --heads origin 'claude-cloud/*' \| awk '{print $2}' \| xargs -n 50 git push origin --delete` |
| **Replace the Claude token** | Run `claude setup-token`, then edit the `CLAUDE_CODE_OAUTH_TOKEN=` line in `~/.config/claude-cloud/env` |
| **Replace the Instabox key** | Edit the `INSTABOX_API_KEY=` line in `~/.config/claude-cloud/env` |
| **Replace the GitHub token** | Run `npx instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com` again. Running machines pick it up. |
| **Remove all saved keys** | `rm ~/.config/claude-cloud/env` |
| **Update the tool** | `git pull && npm install` in the `ai-seamless-sandboxes` folder, then restart `claude-cloud` |
| **Uninstall** | `npm unlink -g claude-cloud`, then delete the folder and `~/.config/claude-cloud` |

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `claude-cloud needs the repo to have an origin remote on github.com` | Add one with `git remote add origin https://github.com/<owner>/<repo>.git`, and make sure your token includes that repo. |
| `The first push to origin claude-cloud/<id> failed` | The `GH_TOKEN` secret is missing, or the token can't write to this repo. Redo step 2.4, and check the token's repository list. |
| `The GH_TOKEN Instabox secret could not be attached` | The secret doesn't exist or is named differently. Redo step 2.4.2, with the name exactly `GH_TOKEN`. |
| `Not logged in · Please run /login` or `401` from a subagent | No valid Claude token reached the machine. Run `claude setup-token` and replace the `CLAUDE_CODE_OAUTH_TOKEN=` line in `~/.config/claude-cloud/env`. This also happens if you only have `ANTHROPIC_API_KEY` exported, because some wrappers, such as cmux's `claude`, remove it. |
| `quota_exceeded` (machine limit) | Your Instabox plan's machine limit is reached. Paused machines count too. Stop subagents you don't need, delete leftover machines (section 5), or upgrade the plan. |
| `rate_limited` (start rate) | Too many machines started in a minute. Start in smaller batches, about 10 a minute. |
| Some subagents fail when many work at once | Instabox allows 32 commands at once per account, and each working subagent holds about one. Send work in waves of about 25. |
| A subagent's work is missing | Only pushed work survives. Check the result for `Push failed` or `Uncommitted changes left in the sandbox`. While the subagent is open, ask it to commit and push. |
| The session uses no subagents, or says `Agent` is unavailable | That's expected: `claude-cloud` turns off the built-in `Agent` and `Workflow` tools. Ask for "a subagent" and it uses `cloud_agent`. Plain `claude` still has the built-in tools. |
| A subagent can't use an agent type you defined | Only agents committed in the repo, or built into Claude Code, exist on the machine. Agents in `~/.claude/agents` aren't sent. |

## 7. How it works

1. **The launcher.** `bin/claude-cloud` starts Claude Code with three changes:
   - the built-in `Agent` and `Workflow` tools turned off;
   - an extra system prompt;
   - an MCP server, `src/server.mjs`, that provides the `cloud_agent_*` tools.
2. **Starting a subagent.** `cloud_agent` takes a snapshot of your repo's tracked files, including uncommitted edits, without touching your working tree. Then:
   - it creates an Instabox machine and attaches the `GH_TOKEN` secret;
   - it uploads the snapshot and checks it out on branch `claude-cloud/<id>`;
   - it pushes that branch, then runs `claude -p` in the background.

   The call returns at once, because Claude Code runs MCP tools one at a time unless they're marked read-only. When the client supports MCP tasks, the call returns a task (id `cc-<agent id>-t<turn number>`, for example `cc-3f2a91bc-t2`). The server detects this from the client capabilities that Claude Code sends with each request on MCP revision 2026-07-28, and the server answers `tasks/get` and `tasks/cancel` for the task.
3. **Getting answers.** In task mode, Claude Code polls `tasks/get` and passes on the result when the task ends. Otherwise `cloud_agent_wait`, which is read-only, collects answers. Follow-ups use `claude -p --resume <session>` on the same machine. The machine runs `claude -p --output-format stream-json --verbose`; the server reads that stream as it arrives to count tool uses and tokens and to find the current step.
4. **After every task.** The tool runs `git push` once more, in case the subagent forgot. It never commits for the subagent; it lists any uncommitted files instead.
5. **Secrets.**
   - **Instabox key and Claude token:** these stay in `~/.config/claude-cloud/env` and the MCP server. They never appear in process arguments.
   - **Claude token on the machine:** only the Claude token is placed on each machine.
   - **GitHub token:** it stays in Instabox. The machine sees only a placeholder, which Instabox's proxy replaces on requests to `github.com` and `api.github.com`.
