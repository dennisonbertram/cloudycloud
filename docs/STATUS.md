# Cloudy Cloud: what is built, and what has been proven

As of 2026-11-11. **"Proven live"** means it was run against real Instabox machines, a real Claude login and real GitHub, and the result was checked on GitHub or Instabox, not taken from an agent's reply.

Provider interface refactor (2026-11-10): provider selection uses `CLOUDY_CLOUD_PROVIDER` (`instabox`, the default, or `self-hosted`). `install.sh` asks which one, and `cloudy-cloud setup --provider` skips the question. See [sandbox provider research](research/sandbox-providers.md).

## What it is

`cloudy-cloud` starts Claude Code with every subagent running on its own Instabox cloud machine.
- **Pushing:** each subagent works on branch `cloudy-cloud/<id>`, and commits and pushes its own work to the repo's GitHub origin.
- **Models:** subagents can run Claude, or open models such as GLM and DeepSeek through Particle.ai or OpenRouter.
- **Coordinators:** a coordinator, nested inside a session or long-lived in the cloud, can run its own fleet and merge the work into one branch.

## Components

| Part | Where | What it does |
| --- | --- | --- |
| Installer | `install.sh` | Checks prerequisites and asks for each key with a one-line note on where to get it: Instabox, Claude token, GitHub token, and optional Particle or OpenRouter keys. It checks keys before saving. The Instabox key stays in the env file (mode 600); the others are stored as Instabox proxy secrets with a host list and listed in `CLOUDY_CLOUD_PROXY_SECRETS`. Keys already in the env file are moved after a yes. Shown masked. |
| Launcher | `bin/cloudy-cloud` | Starts Claude Code with the built-in `Agent` and `Workflow` tools turned off and the cloud tools added. If setup is missing, it points to `cloudy-cloud setup` and offers to run it. It warns about folders that aren't repos or have no GitHub origin. |
| Cloud tools (MCP server) | `src/server.mjs`, `src/mcp.mjs` | `cloud_agent`, `cloud_agent_message`, `cloud_agent_wait`, `cloud_agent_list` and `cloud_agent_stop`. On terminal sessions they run as **MCP tasks**: footer count, live progress in `/tasks`, stop with `x`, automatic completion. |
| Agent lifecycle | `src/run-subagent.mjs` | Snapshot upload, branch setup, push retries, the after-each-task safety push, follow-ups through `--resume`, a 60-minute idle stop, depth and per-session limits. |
| Instabox provider | `src/providers/instabox.mjs`, `src/limits.mjs` | Machine creation and the `GH_TOKEN` proxy secret. Paced starts (25 a minute) with retries on `rate_limited` and `quota_exceeded`. One global limit of 24 Instabox calls. Sliced job waits that survive brief request errors. |
| MCP server sync | `src/mcpsync.mjs`, `src/mcp-cli.mjs` | `cloudy-cloud mcp add\|ls\|rm`: copies chosen servers from Claude Code settings to `~/.config/cloudy-cloud/mcp.json` (remote `https` and `npx`/`uvx` only), rewrites secrets to `${MCP_<NAME>_TOKEN}` Instabox secrets, validates again at agent start, writes the file to the machine and passes `--mcp-config --strict-mcp-config`. Footer line, `cloud_agent_list` and dashboard MCP row show the names. `--allow-literal` is the confirmed exception that copies the real token. Covered by unit tests; not yet proven live end to end with a real MCP server (see issue #9 for the proxy-secret spike). |
| Cleanup | `src/reaper.mjs` | A separate process that deletes a session's machines when the session ends, even after a hard kill. |
| Model profiles | `src/profiles.mjs` | `glm`, `deepseek` and `particle` (Claude Code through a LiteLLM gateway on the worker machine), `openrouter`, `pi-glm`, `pi-deepseek` and `pi-particle` (the `pi` harness, with no gateway), and `omp-glm`, `omp-deepseek` and `omp-particle` (the `omp` harness, with no gateway). |
| Progress | `src/progress.mjs`, `src/progress-pi.mjs`, `src/progress-omp.mjs` | Streams tool uses, tokens, elapsed time and the current step from Claude Code, `pi` or `omp`. |
| The `omp` harness | `src/profiles.mjs`, `src/run-subagent.mjs` | `omp-glm`, `omp-deepseek` and `omp-particle` run oh-my-pi (`omp`, pinned v18.18.7, installed on each worker with the official installer in `--binary` mode) with the same Particle.ai models as `pi-*`. `"harness"` in `profiles.json` may be `claude`, `pi` or `omp`. Config is in `~/omp-agent`. Follow-ups resume the omp session. Coordinators refuse `pi` and `omp` profiles. Proven live once (see below); follow-ups covered by unit tests only. |
| MCP servers for `pi` and `omp` workers | `src/mcpsync.mjs`, `src/run-subagent.mjs` | The servers from `cloudy-cloud mcp add` are written to `~/pi-agent/mcp.json` or `~/omp-agent/mcp.json` (mode 600). `pi` skips `sse` servers with a reason in the reply; `omp` accepts them. The footer lists delivered servers and does not confirm a connection. Proven live with a stdio server (see below). |
| Self-hosted provider (your own machine over SSH) | `src/providers/self-hosted.mjs`, `src/providers/ssh.mjs`, `src/self-hosted-setup.mjs`: one Docker container per subagent, `setup --provider self-hosted`, `doctor`, slots, consented GitHub token, `open` through an SSH bridge. Covered by unit tests and an opt-in local test against a throwaway sshd container. Docs: [RUNBOOK section 9](RUNBOOK.md#9-your-own-machine). **Not yet proven live:** the first live check on a Mac Studio over Tailscale is still to do. Coordinators use `docker commit --pause=true` images named `cloudy-cloud-coordinator:<name>` (issue #35); they are covered by unit tests only and not proven live on a Mac Studio. Coordinators on this provider start workers as sibling containers through the box's Docker socket (`CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes`, local transport `src/providers/local.mjs`, #41); covered by unit tests and an opt-in local test with a real coordinator container starting a sibling worker, not proven live on a Mac Studio. |
| Cloud coordinators | `src/coordinator.mjs` | `coordinator image` (sign in once, then snapshot), `start`, `attach`, `ls` and `stop`. They are long-lived, never pause and run Remote Control. |
| Fleet skill | `skills/cloud-fleet/SKILL.md` | Teaches Claude flat fan-out, trunk merging into `fleet/<topic>`, waves, model choice per level, briefs and safety. |

## Proven live

| Behaviour | Evidence |
| --- | --- |
| Install script | Ran in a real terminal. It rejected a malformed key and an invalid key, saved the real keys at mode 600, found `GH_TOKEN`, offered to replace each key on a re-run, and left the terminal echoing after Ctrl-C at a hidden prompt. |
| Single subagent | "Use a subagent…" ran on an Instabox machine, and its `proof.txt` was fetched from GitHub. |
| MCP tasks in Claude Code | Footer `2 MCP tasks`, a live `/tasks` line (`1 tool use · 18.5k tokens · 45s · Bash …`), automatic completion, a follow-up as a task, and stop. |
| 100-worker swarm | 100 of 100 branches on GitHub, each holding a different valid hostname, so 100 machines. No machines were left afterwards. |
| Long command | A 700-second command ran on a worker for 12 minutes, and `long.txt` reached GitHub. |
| Cleanup | A terminal killed mid-task had its machine deleted within 10 seconds. |
| Open models through the gateway | Two GLM workers and one DeepSeek worker through Particle pushed their files, and DeepSeek handled a follow-up. |
| The `pi` harness | Two `pi-glm` workers pushed in about 25 seconds each, and one handled a follow-up in the same `pi` session. |
| The `omp` harness with MCP | 2026-11-11, a Haiku-coordinated session started one `omp-glm` worker with the no-auth context7 stdio server. Branch `cloudy-cloud/45f4d2a8` on GitHub holds `omp-proof.txt` with `mcp__context7_query_docs`, `mcp__context7_resolve_library_id` and a greeting. Footer: `MCP servers: context7`, `Total: 2 tool uses, 25.6k in / 439 out tokens, 45s`. Setup including the omp install took about 20 s. The Particle key value was absent from the run output, the event log and the branch. The machine was gone afterwards. |
| MCP servers for `pi` workers | Same session shape with `pi-glm`: branch `cloudy-cloud/6434a4e7` holds `pi-proof.txt` with `mcp__context7__resolve_library_id`, `mcp__context7__query_docs` and a greeting. Footer: `MCP servers: context7`, and `WARNING Model: asked for z-ai/glm-5.3-flash, provider reported glm5.3flash` (Particle's own name for the model). Key absent, machine gone afterwards. |
| Nested tree | A Claude coordinator subagent started two GLM workers and merged both into `fleet/tree-test-*` with `--no-ff`, and both files are on GitHub. |
| Fleet skill | A session loaded `cloud-fleet` on its own, chose trunk merging, and delivered one `fleet/fleet-demo` branch whose comparison shows only the three requested pages. |
| Cloud coordinator | Started from the snapshot with no manual steps. Remote Control came up active, and it started a `pi-glm` worker whose push was checked on GitHub. Stop deleted the machine. |

## Bugs found by live runs, all fixed with regression tests

- **Wrong branches:** commits landed on other agents' branches under load, caused by a shared `FETCH_HEAD`. The copy-back was later removed entirely in favour of agents pushing their own branches.
- **Leaked token:** an exported `ANTHROPIC_API_KEY` was removed by the cmux wrapper, so the sandbox wasn't logged in.
- **Orphaned machines:** sessions that ended left machines behind. Fixed by the cleanup process.
- **Early endings:** workers put long commands in the background, so their tasks ended early. Fixed with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, plus a 28-minute Bash timeout.
- **Lost waits:** a single Instabox request timeout killed a healthy job. Waits now retry.
- **Push failures:** GitHub rejected 1 push in 100 during a mass first push. First pushes now retry, and the token hint appears only for auth errors.
- **LiteLLM gateway:** it needed a master key, and it routed requests to the Responses API, which Particle lacks (405). Fixed in config.
- **Misleading cost:** open-model results showed Anthropic-priced costs. The cost is now hidden for them.
- **Coordinator tool version:** cloud and nested coordinators get the laptop's exact cloudy-cloud (a git bundle of HEAD plus uncommitted tracked edits), not a clone of GitHub. The tool repo no longer needs to be pushed or reachable by `GH_TOKEN`. Covered by unit tests only; not yet run against a live machine.
- **Coordinator setup:** `tmux` was missing and the package lists were empty; `gh auth setup-git` ran after the clone; Claude Code's first-run screens blocked Remote Control. All fixed.
- **Skill gap:** the fleet skill switched the user's own folder's branch. It now uses a worktree.

## Open items

- **Self-hosted live check:** run setup, one worker that pushes, a follow-up, `open`, stop, and a killed-session cleanup on the real Mac Studio, then move the row above to "Proven live". Also try a coordinator (`coordinator image`, `--save`, `start`) there.
- **agent-drive access for workers:** not built. It needs a `delegate` credential and a dedicated drive.
- **Particle key:** setup now stores it as an Instabox proxy secret (host `api.particle.ai`) and offers to move an existing env-file key. Covered by stub tests only; not yet proven live end to end (issue #63 spike, #65).
- **MCP proxy secrets for pi and omp:** the live checks used a server with no token, so the `MCP_<NAME>_TOKEN` proxy path is still not proven live for any harness.
- **The `omp` harness:** a follow-up resuming the omp session, `sse` servers on omp, and the model line (omp reports only the requested id, so the footer says "not confirmed by the provider") have not been run live.
- **The `pi` harness:** fixtures were synthetic, but the live run passed. There's no per-command time limit setting for `pi`.
- **Old-session shim:** delete `bin/claude-cloud` once no session started before the rename to Cloudy Cloud is still running.
- **Hosted service:** see [HOSTED-DESIGN.md](HOSTED-DESIGN.md).
