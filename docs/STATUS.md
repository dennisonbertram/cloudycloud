# claude-cloud: what is built, and what has been proven

As of 2026-11-06. **"Proven live"** means it was run against real Instabox machines, a real Claude login and real GitHub, and the result was checked on GitHub or Instabox, not taken from an agent's reply.

## What it is

`claude-cloud` starts Claude Code with every subagent running on its own Instabox cloud machine.
- **Pushing:** each subagent works on branch `claude-cloud/<id>`, and commits and pushes its own work to the repo's GitHub origin.
- **Models:** subagents can run Claude, or open models such as GLM and DeepSeek through Particle.ai or OpenRouter.
- **Coordinators:** a coordinator, nested inside a session or long-lived in the cloud, can run its own fleet and merge the work into one branch.

## Components

| Part | Where | What it does |
| --- | --- | --- |
| Installer | `install.sh` | Checks prerequisites and asks for each key with a one-line note on where to get it: Instabox, Claude token, GitHub token (stored as an Instabox proxy secret), and optional Particle or OpenRouter keys. It checks keys before saving, saves them at mode 600 and shows them masked. |
| Launcher | `bin/claude-cloud` | Starts Claude Code with the built-in `Agent` and `Workflow` tools turned off and the cloud tools added. If setup is missing, it points to `install.sh`. It warns about folders that aren't repos or have no GitHub origin. |
| Cloud tools (MCP server) | `src/server.mjs`, `src/mcp.mjs` | `cloud_agent`, `cloud_agent_message`, `cloud_agent_wait`, `cloud_agent_list` and `cloud_agent_stop`. On terminal sessions they run as **MCP tasks**: footer count, live progress in `/tasks`, stop with `x`, automatic completion. |
| Agent lifecycle | `src/run-subagent.mjs` | Snapshot upload, branch setup, push retries, the after-each-task safety push, follow-ups through `--resume`, a 60-minute idle stop, depth and per-session limits. |
| Instabox layer | `src/instabox.mjs`, `src/limits.mjs` | Machine creation and the `GH_TOKEN` proxy secret. Paced starts (25 a minute) with retries on `rate_limited` and `quota_exceeded`. One global limit of 24 Instabox calls. Sliced job waits that survive brief request errors. |
| Cleanup | `src/reaper.mjs` | A separate process that deletes a session's machines when the session ends, even after a hard kill. |
| Model profiles | `src/profiles.mjs` | `glm`, `deepseek` and `particle` (Claude Code through a LiteLLM gateway on the worker machine), `openrouter`, and `pi-glm`, `pi-deepseek` and `pi-particle` (the `pi` harness, with no gateway). |
| Progress | `src/progress.mjs`, `src/progress-pi.mjs` | Streams tool uses, tokens, elapsed time and the current step from Claude Code or `pi`. |
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
- **Coordinator tool version:** cloud and nested coordinators get the laptop's exact claude-cloud (a git bundle of HEAD plus uncommitted tracked edits), not a clone of GitHub. The tool repo no longer needs to be pushed or reachable by `GH_TOKEN`. Covered by unit tests only; not yet run against a live machine.
- **Coordinator setup:** `tmux` was missing and the package lists were empty; `gh auth setup-git` ran after the clone; Claude Code's first-run screens blocked Remote Control. All fixed.
- **Skill gap:** the fleet skill switched the user's own folder's branch. It now uses a worktree.

## Open items

- **agent-drive access for workers:** not built. It needs a `delegate` credential and a dedicated drive.
- **Particle key:** it sits on worker machines; moving it into an Instabox proxy secret needs the user to run `npx instabox@latest secrets set PARTICLE_API_KEY --host api.particle.ai`.
- **The `pi` harness:** fixtures were synthetic, but the live run passed. There's no per-command time limit setting for `pi`.
- **Hosted service:** see [HOSTED-DESIGN.md](HOSTED-DESIGN.md).
