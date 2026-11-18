# Cloudy Cloud CLI: redundancy and information architecture

Scope: v0.2.0 on branch ux-flow/cli. "Measured" means I read the code or ran a command; "suspected" means inferred. No cloud machine was created.

## Command Map

Top-level (`bin/cloudy-cloud`, help text at lines 85-106):

| Command | Source | What it does |
|---|---|---|
| (none) | bin/cloudy-cloud end | Starts Claude Code with the `cloud` MCP server. Any other args pass to `claude`. |
| `setup [--check-only] [--provider instabox\|self-hosted]` (also `--setup`) | install.sh | Tools check, command link, skill copy, provider, agents, keys, alerts, GitHub token, optional coordinator image. |
| `doctor` | self-hosted-setup.mjs | Checks the self-hosted machine only. |
| `dashboard [--demo] [--port N] [--no-open] [--prune]` | dashboard.mjs | Read-only local web page: machines, messages, usage, panes. |
| `open <agent> <port> [--share\|--unshare]` | open.mjs | Port-forward or publish an app. (`--unshare` is in USAGE but not in top-level help.) |
| `shell <agent> [-- cmd]` | shell.mjs | Interactive shell or one command on a machine. |
| `display <agent> [--control] [--ttl S] [--screenshot FILE] [--unshare]` | display.mjs | Desktop link or screenshot. |
| `protect [owner/repo] [--yes]` | protect.mjs | GitHub ruleset on default branch, uses `gh`. |
| `codex`, `opencode`, `pi`, `free-pi` | host-*.mjs | Start another main session with the same tools. |
| `coordinator image [--save] / start NAME --repo URL [...] / ls / status NAME / attach NAME / stop NAME / finish [--force]` | coordinator.mjs, cli-help.mjs | Long-lived cloud Claude Code sessions. |
| `mcp add\|ls\|rm` | mcp-cli.mjs | Which MCP servers cloud workers get. Other `mcp ...` forms fall through to `claude mcp` (bin lines 55-59). |
| `--version`, `--help`, `-h`, `help` | bin | Own help only when it is the single argument (bin line 76). |
| `claude-cloud` | bin/claude-cloud | Old name; marked temporary for deletion. |

MCP tools the local agent sees (src/mcp.mjs): `cloud_agent`, `cloud_agent_message`, `cloud_agent_wait`, `cloud_agent_result`, `cloud_agent_list [all]`, `cloud_agent_stop`. Their `cloud_agent` parameters: prompt, description, model, profile, role (worker|coordinator), autofix, machine, size, subagent_type.

Other surfaces: `install.sh` (same code as `setup`; its only flags are `--provider` and `--check-only`, install.sh:1165-1177), the dashboard (served by `dashboard`, read-only), the setup skill (`skills/cloudy-cloud-setup/SKILL.md`, tells the user to run `! npx cloudycloud setup`), and the fleet skill (`skills/cloud-fleet`).

## Duplicate Paths

D1. Reach a coordinator's terminal. Four ways, same end result (an SSH/tmux session):
- `cloudy-cloud coordinator attach NAME` only prints `npx --yes instabox@latest ssh <machine> -- tmux attach -t claude`; it does not run it (coordinator.mjs:225-229, RUNBOOK:287). Measured.
- `coordinator start` prints the same raw command again as "runs: ..." (coordinator.mjs:217, 222). `coordinator status` prints it a third time (251).
- `cloudy-cloud shell <machine>` runs SSH itself, but takes an agent id or machine name, not a coordinator NAME (resolveTarget, open.mjs:42-56). Neither opens the tmux session, so a user needs `shell MACHINE -- tmux attach -t claude`, which is not documented.
- The `npx instabox ssh` command itself.
Verdict: drift. `attach` is a "print a command" wrapper where `shell` runs the command. Recommend one canonical: make `coordinator attach NAME` run the tmux attach (like `shell`), keep `--print` for the raw string, and stop printing the raw `npx` form elsewhere.

D2. Setup. `cloudy-cloud setup` = `./install.sh` = `npx cloudycloud setup` = README's `npx -y cloudycloud setup` = the skill's `! npx cloudycloud setup` (bin line 65; skill step 2). Same code. The skill adds only a prerequisite check, which `setup --check-only` already performs (install.sh:1177, `check_prereqs`). Deliberate and cheap, but the skill's step 1 (five manual commands) duplicates `check_prereqs`. Recommend: keep one entry (`cloudy-cloud setup`), have the skill run `npx cloudycloud setup --check-only` first instead of listing five commands. Also first-run auto-prompt: running `cloudy-cloud` unconfigured asks "Run setup now?" and runs install.sh (bin lines 150-158), a third trigger; fine, it is the same path.

D3. Coordinator image build. Reachable as `setup` (offers it in step 4, install.sh:904-945) and as `coordinator image` + manual `claude auth login` + `coordinator image --save`. Setup drives the same commands, but it also calls `npx instabox ssh ... claude auth login` itself (install.sh:925). Same result, two UIs. Deliberate for convenience. The failure case is the owner's transcript: the 2-hour image machine (coordinator.mjs:29) expired mid sign-in and `--save` then said "No image machine found" (coordinator.mjs:117). Neither path mentions the limit. Recommend: print the 2-hour deadline at creation and let `image --save` say "the image machine expired; rerun `coordinator image`" (it currently says only "Run: cloudy-cloud coordinator image").

D4. Looking at a worker. `shell <id>`, `display <id>`, `dashboard` (pane view), `open <id> <port>`, `cloud_agent_list` (progress), plus `npx instabox@latest ls`/`ssh` in RUNBOOK:207. Different capabilities mostly; the redundancy is list-the-machines, which exists as `cloud_agent_list all`, the dashboard, `coordinator ls` (coordinators only), and `npx instabox@latest ls` (printed in text.listMachines, instabox.mjs:452, and in `coordinator stop` output, coordinator.mjs:297). No `cloudy-cloud ls` exists for a human at a terminal. Recommend adding one top-level `ls` (agents and coordinators, one table) and printing that instead of the `npx` line.

D5. Secret storage. `setup` stores keys; `errors.mjs` prints `printf %s "$KEY" | npx --yes instabox@latest secrets set ...` (errors.mjs:12, 55, 60); `mcp add` prints the same raw command (mcp-cli.mjs:126); RUNBOOK:67, 142, 145 and README:239 repeat it. Same end state, two mechanisms (setup stores, errors/mcp tell the user to do it by hand). Recommend: `cloudy-cloud secrets set NAME --host H` (reads stdin) that wraps it, and have errors and `mcp add` print that.

D6. Branch protection. `protect` (gh) vs. setup's closing warning that only tells the user to run `protect` (install.sh near end). Deliberate; fine. But `protect` needs the `gh` CLI the user may not have; `setup` could offer it inline once a repo is detected.

D7. Update. Three different update instructions depending on install mode (install.sh summary: `npm install -g cloudycloud@latest` vs `git pull && npm install`); no `cloudy-cloud update`. Owner evidence: their global command still pointed at a release worktree after 0.2.0 and nothing said so. Recommend: `cloudy-cloud --version` also checks npm latest, or a `doctor` that includes this.

D8. Name alias. `claude-cloud` is a leftover binary (bin/claude-cloud). Already marked for deletion; remove when unused.

## Duplicate Information

I1. The raw `npx --yes instabox@latest ssh <machine> -- tmux attach -t claude` string appears three times across `coordinator start` output in both TTY and plain mode (coordinator.mjs:217 and 222), and again in `status` (251) and `attach` (228). A user sees it plus "cloudy-cloud coordinator attach NAME" on adjacent lines in one block ("Terminal: cloudy-cloud coordinator attach X, runs: npx ..."). Measured. Show one line; the tool name is enough.

I2. `coordinator start` states "Stop it earlier with: ... coordinator stop" and "It never pauses ... deleted at ...", and the help footer says "Machines do not pause on their own. Stop coordinators when you are done." (cli-help.mjs:47). Repeated three times across help and output. Keep once in output.

I3. "Run `cloudy-cloud coordinator image --save`" follows the image output step-by-step (coordinator.mjs:106-109) and also appears in the `image` guide note and RUNBOOK 8.1. In `image` output it is listed as step 4 (plain) but as a trailing hint (TTY), two layouts for one sequence. Measured.

I4. Setup summary prints a Next box and also the earlier hints "To change a key later, run: cloudy-cloud setup" and the update hint right before it (install.sh near line 1230). The "Restart any open session" line is separate. About six hint lines before the one thing the user should do next. Suspected clutter; fix by ordering Next first.

I5. The same Instabox limits and plan facts (pro 100 agents, etc.) are in RUNBOOK, README, cloud_agent `size` description and errors. Not measured for drift; suspected source of future inconsistency.

I6. The Instabox CLI's own "instabox X is outdated: run instabox update" prints on every `npx instabox ...` call (owner evidence). Cloudy Cloud hands users these calls repeatedly (installs, attach, ls), so the noise multiplies. Another reason to wrap them (D1, D4, D5).

I7. Top-level help lists `codex`, `opencode`, `pi`, `free-pi` as four separate commands with near-identical text (bin lines 89-92).

## Overlapping Features

O1. `coordinator attach` vs `coordinator status`: status already prints the attach command; attach is a subset. Recommend merging: `status NAME` shows state, screen, and a copy-ready attach line; `attach` becomes the action that runs it (see D1).

O2. `coordinator ls` vs `cloud_agent_list all` vs dashboard vs `npx instabox ls`: four views of "what is running." The local human view is missing at top level (D4). Recommend one `ls` that covers both, keep the MCP tool for the agent, and keep the dashboard as the detailed view.

O3. `doctor` vs `setup --check-only`: both check health. `doctor` is only for self-hosted (bin lines 40-44; help says "check your own machine when subagents run there"). `setup --check-only` is the general check. A new user will not know which to run. Recommend `doctor` become the one health command for any provider (it can delegate to `--check-only`), and `--check-only` stay as an alias.

O4. `open`, `display`, `shell` are three "reach a machine" commands with identical `<agent-id-or-machine>` argument and different payloads. They share resolveTarget, so the overlap is deliberate. They could be one `cloudy-cloud machine <id> shell|open|display`, but they are rare. Keep as is; just document them in help as one group, because top-level help already lists them in the middle.

O5. `cloud_agent` `role: coordinator` (a cloud agent that can start its own) vs `cloudy-cloud coordinator start` (a long-lived Remote Control session). Both are called "coordinator" and differ: one is a depth-limited worker with the tool installed (mcp.mjs, `CLOUDY_CLOUD_MAX_DEPTH`), the other is an always-on Claude session. Different capabilities under one word. Recommend differentiate in naming (for example "nested coordinator" is already used in bin line ~170 comments), at least in tool text.

O6. `cloud_agent` `model` vs `profile` vs `subagent_type`: three ways to choose what runs. The system prompt itself has to warn "never the model argument" for non-Claude (bin prompt). The warning is evidence the schema is overlapping. Recommend `profile` as the one selector in the tool description; leave `model` as an override with a smaller note.

O7. `cloud_agent_wait` vs `cloud_agent_result` vs task notifications: the prompt describes two modes. This is protocol-driven, not a CLI problem; keep.

## Hierarchy & IA

H1. Order of top-level help (bin lines 83-102): `setup`, `doctor`, `dashboard`, `open`, `shell`, `display`, `protect`, then four host commands, `coordinator`, `mcp`. By likely use: after the (no command) session and `setup`, a developer wants `ls`/status (missing), `dashboard`, `shell`, `protect`, `coordinator`. `doctor` is rare and self-hosted only, but sits second. `open` and `display` are niche. Suspected, not user-tested. Recommend grouping: Start (no command, codex/opencode/pi/free-pi), Watch (dashboard, ls, shell), Reach (open, display), Setup and health (setup, doctor, protect, mcp), Coordinators.

H2. Nesting is mostly right: coordinator subcommands are nested, rare. But `image [--save]` is a two-command ritual with a hidden wait. The first-time coordinator path is `setup` -> `coordinator image` -> `claude auth login` on a machine -> `coordinator image --save` -> `coordinator start`; five steps to first value. Recommend `coordinator image` runs the whole sequence (create, open sign-in, wait, save), as `setup` already does internally (install.sh:904-945), and `--save` stays as the recovery path.

H3. Four host launchers (`codex`, `opencode`, `pi`, `free-pi`) are top-level siblings of `setup` and `dashboard`. They are one concept (choose the main agent). Recommend `cloudy-cloud --agent codex` is blocked (claude owns `--agent`; bin lines 62-63 and 85 explain), so the alternatives are keeping them top-level but grouped in help, or `cloudy-cloud host codex`. Weak evidence either way; grouping in help is cheapest.

H4. Naming. One concept, several words (measured from help and errors):
- The thing a task runs on: "cloud machine" (help), "box" (dashboard help comment: "cloud boxes"), "sandbox" (MCP tool text, `createSandbox`, `cloud_agent` description), "machine" (shell, display, open, coordinator output), "worker" (docs, prompt, coordinator guide), "subagent" (README, bin prompt), "agent" (CLI args `<agent>`, `agent_id`), "image machine" (coordinator). Recommend: user-facing nouns are "agent" (the work) and "machine" (where it runs). Replace "box" and "sandbox" in user text.
- "image" in `coordinator image` is actually a snapshot (it saves `CLOUDY_CLOUD_COORDINATOR_SNAPSHOT`, coordinator.mjs, and says "Saved snapshot ..."). It uses "image" for the command and "snapshot" for the result. Recommend one word: "sign-in image" for both, or rename the command `coordinator prepare`.
- "coordinator" is used for the long-lived machine, the cloud_agent role (O5), and the main session in cloud-fleet skill. Recommend keeping the term but marking the three meanings in docs.
- `<agent-id-or-machine>` appears in four USAGE strings; coordinator NAME is a third identifier type accepted only by `coordinator` commands (D1).

H5. Places that tell the user to run another tool where a cloudy-cloud command could do it (measured, grep):
- `npx --yes instabox@latest ssh/ls/rm/login/secrets/workspace` in errors.mjs, mcp-cli.mjs, coordinator.mjs (via `text.ssh`, `text.listMachines`), install.sh (about 20 places), RUNBOOK and README. Biggest group. Wrappers needed: `ls`, `rm` (stop already exists for agents? `cloud_agent_stop` is MCP only; there is no human `cloudy-cloud stop <agent>`), `attach`, `secrets set`, `login`.
- `claude setup-token` and `claude auth login` (errors.mjs:43, install.sh:669, 925): needed, since they are Claude's own auth; the setup flow already runs them. Keep.
- `gh` for `protect`: acceptable.
- `git fetch origin cloudy-cloud/<id>` to collect work (prompt, RUNBOOK:179-185): no `cloudy-cloud pull <id>` or `merge`. For many workers, skill cloud-fleet tells the user a merge routine by hand. Suspected common friction; recommend a `cloudy-cloud branches`/`pull` helper if journeys show it is frequent.
- There is no human-facing `cloudy-cloud stop <agent>`; a leftover machine is deleted with `npx instabox@latest rm <name>` (install.sh:895, RUNBOOK:208, README:329). `shell`/`display` accept an id; `stop` does not exist at top level. Recommend adding it, because owners hit leftover machines.

H6. `--help` consistency. Measured by code: `shell`, `open`, `display`, `protect`, `coordinator <cmd>` have `--help`/USAGE. `dashboard` has no help handler (dashboard.mjs `main` only reads `--prune`, `--demo`, `--port`, `--no-open`), so `cloudy-cloud dashboard --help` would start the server and open a browser. `doctor`, `mcp` and `setup` also have no per-command help handler in the launcher. `cloudy-cloud codex --help` goes to the host launcher, not Cloudy Cloud help. Top-level help prints only when it is the single argument (bin line 76), so `cloudy-cloud --help --foo` falls through to `claude`. Recommend one consistent `<cmd> --help`.

H7. Top-level help does not mention `--unshare` (open, display), `--prune` (dashboard), `--demo`, `--port`, `--no-open`, or `setup --provider` beyond a parenthetical. These live only in each USAGE or in the file header. Fine for rare flags; but `dashboard --demo` is the only way to see the dashboard without a key and is unlisted.

H8. Where the user starts at the end of `setup`: the Next box (install.sh end) is the right dead-end fix. The Claude CLI path appears to be fine for the first success; the redundancy and IA problems concentrate in coordinators, which is a second journey, and in the repeated hand-off to `instabox`.

## Counts

- Command Map: 13 command groups, 6 MCP tools, 4 other surfaces.
- Duplicate Paths: 8.
- Duplicate Information: 7.
- Overlapping Features: 7.
- Hierarchy & IA: 8 (H1-H8).

## Top 3 recommendations

1. Wrap the `npx instabox` calls users are told to run (attach, ls, rm, secrets set, ssh) as `cloudy-cloud` commands, starting with a human `ls` and `stop`; the same change removes the Instabox "outdated" noise and the raw-command repetition in coordinator output.
2. Make `coordinator attach NAME` run the session (not print a string), print the 2-hour image-machine limit at `coordinator image`, and have `image --save` say the machine expired.
3. Reorder and group `--help` by use (start, watch, setup and health, coordinators), give every subcommand a working `--help` (`dashboard` has none), and use "agent" and "machine" as the only user-facing nouns.
