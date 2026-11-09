# Fleet design: cloud coordinators managing fleets of open-model subagents

Status: **proposal, not built.** Items marked *(verify)* are assumptions to check before building.

## Goal

- **Start fleets from your laptop.** From one Claude session on your laptop, start a few coordinator sessions on Instabox, for example 5 running Opus 5.5.
- **Coordinators fan out.** Each coordinator starts and manages many worker subagents on their own machines, running cheaper or open models such as DeepSeek through custom endpoints.
- **Work survives a closed laptop.** Everything keeps working while your laptop is closed.
- **Work is never lost.** Every worker pushes its work to GitHub and can save data to agent-drive.
- **Reach any session.** You can message any coordinator, and through it any worker.

```
laptop: cloudy-cloud (you)
  ├── coordinator-1 (Instabox, Opus 5.5, long-lived, reachable by Remote Control/SSH)
  │     ├── worker (Instabox, DeepSeek)  → pushes cloudy-cloud/<id>, saves to agent-drive
  │     └── worker ... (tens to hundreds)
  ├── coordinator-2 ...
  └── coordinator-5 ...
```

## Building blocks

### 1. Reliability (in progress, branch `fix/reliability`)
- **No early endings:** workers run with background tasks turned off, so a long command can't end a task early. In a live test, a worker backgrounded an 11-minute command and its task ended after 26 seconds.
- **Paced starts:** the tool queues starts and paces them under Instabox's start rate. It retries `rate_limited` errors, and holds agents in a queue when `quota_exceeded` says the machine limit is reached.
- **Shared command slots:** every Instabox call goes through one global limiter, which stays below the account's 32 simultaneous commands. Waits are short slices, so hundreds of agents can share the slots.

### 2. Model profiles
A profile names the inference endpoint for a session:

| Field | Example (DeepSeek) | Example (Opus) |
| --- | --- | --- |
| `name` | `deepseek` | `opus` |
| `baseUrl` | `https://api.deepseek.com/anthropic` *(verify)* | Anthropic default |
| `model` | `deepseek-chat` *(verify)* | `claude-opus-5-5` |
| `secret` | Instabox proxy secret `DEEPSEEK_API_KEY`, host `api.deepseek.com` | Claude token as a proxy secret for `api.anthropic.com` *(verify)* |

- **How it's used:** `cloud_agent` gets a `profile` argument. The worker's Claude Code runs with `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and an auth variable holding the secret's **placeholder**. The real key never reaches the machine.
- **Claude through the proxy too:** if the Claude token also moves to a proxy secret, the last real credential on worker machines goes away. That closes the prompt-injection risk the README warns about today.
- **Where profiles come from:** profiles live in `~/.config/cloudy-cloud/profiles.json`, and `install.sh` can add them.
- **Status:** built. A profile's optional `harness` (`claude`, the default, or `pi`) picks the worker's agent. The built-in `pi-glm`, `pi-deepseek` and `pi-particle` profiles run the pi coding agent, which talks to Particle's OpenAI API directly, so there is no LiteLLM gateway. Not yet run live.
- **Compatibility:** DeepSeek and others must offer an Anthropic-compatible API, or run behind a gateway that translates.
- **Providers (decided):** any number of profiles can be added.
  - **OpenRouter** is the default for open models.
  - **Particle.ai** is tested first, because of the free, unlimited deal.
- **Particle's API speaks a different protocol.** Based on third-party docs, not yet confirmed against Particle's own reference:
  - **API:** Particle's API at `https://api.particle.ai/v1` speaks only OpenAI Chat Completions, with keys from platform.particle.ai.
  - **Models:** `particle-ai/particle-1`, and others such as DeepSeek models listed on the account.
  - **The problem:** Claude Code needs the Anthropic Messages API, so it can't call Particle directly.
- **Options for Particle:**
  - **a. Translating gateway:** run a gateway such as LiteLLM, either on the worker machine or once per fleet, that converts Anthropic requests to OpenAI ones.
  - **b. A different agent:** run OpenCode or Codex as the worker agent for OpenAI-format endpoints. Both come preinstalled on the Instabox `agent-browser` template.
  - **c. Through OpenRouter:** reach Particle through OpenRouter. OpenRouter has an Anthropic-compatible layer, but that probably bills through OpenRouter rather than the free Particle deal.
- **Decided direction:**
  - **Translating gateway:** use one for OpenAI-format endpoints such as Particle.
  - **The `pi` harness:** consider it as a second worker agent.
  - **OpenCode:** rejected as inefficient.
- **The `pi` harness (TBD):** before building, check its package, its headless and streaming output modes, its session resume, and its provider config. The user's `factory-local` skill already runs `pi` workers on OpenRouter. A pi worker would need its own progress parser and follow-up handling, alongside the Claude Code ones.
- **OpenRouter itself:** its documented Claude Code setup is `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>` and `ANTHROPIC_API_KEY=""`. OpenRouter warns that Claude Code is guaranteed only with Anthropic's own models.
  - Opus runs through Anthropic.

### 3. Cloud coordinators
- **Starting one:** `cloudy-cloud coordinator start NAME --profile opus [--repo URL]` creates a long-lived Instabox machine labelled as a coordinator. Then:
  - it clones the repo and installs `cloudy-cloud`;
  - it starts Claude Code there in a tmux session, with Remote Control on.
- **Reaching it:** from claude.ai or the Claude app through Remote Control, or with `cloudy-cloud coordinator attach NAME` (SSH).
- **Starting workers without the Instabox key:** coordinators start workers with the **Instabox key held as a proxy secret** for `api.instabox.sh`, so coordinator machines don't hold the real key either. *(verify that Instabox's proxy accepts its own API host.)*
- **Not tied to your laptop:**
  - a coordinator is never deleted by the laptop session's cleanup process;
  - it has no idle timeout;
  - it stops only with `cloudy-cloud coordinator stop NAME`, or at a spending or time cap.
- **Cleanup still works below it:** a coordinator's own workers keep today's cleanup-on-exit, scoped to that coordinator.
- **Messaging:** you message a coordinator directly through Remote Control or SSH. Its workers are reachable through it with `cloud_agent_message`.

### 4. Fleet limits and visibility
- **Labels:** every machine carries `fleet=<id>`, `role=coordinator|worker` and `parent=<coordinator>` metadata.
- **Limits:** per-fleet caps on machines, concurrent workers and total runtime, set at fleet start. Fan-out stops at the cap.
- **Visibility:** `cloudy-cloud fleet ls` shows coordinators, worker counts and status. `cloudy-cloud fleet stop` stops everything in a fleet.

### 5. agent-drive access
- **How it differs from GitHub:** agent-drive encrypts on the client, so each machine needs a real credential bundle (`AGENT_DRIVE_CREDENTIALS`). The proxy cannot hide it.
- **Scoped credentials:** the coordinator holds a `delegate` credential. For each worker it issues a scoped one with `agent-drive credentials issue --name <id> --write-path /fleet/<fleet>/<id> --stdout`, and passes it to that worker only.
- **The limit:** writes are restricted to the worker's folder, but reads stay drive-wide, so use a dedicated drive for fleet work.
- **Installing it:** workers install the CLI with `npx -y https://agentdrive.xyz/cli/agent-drive.tgz` and add its skill.

## Order of work

1. **Reliability:** finish and test live with 100 workers and an over-10-minute task.
2. **Model profiles:** add them, and prove a DeepSeek worker pushes a commit.
3. **Cloud coordinators:** start one, close the laptop, check that its workers finish and push, then message it from the phone.
4. **Fleet labels, caps, `fleet ls` and `fleet stop`.**
5. **agent-drive scoped credentials.**

## Open questions

- **Particle.ai:** what is the endpoint, the API format and the model names? Is it compatible with the Anthropic Messages API, or only with OpenAI's?
- **agent-drive:** who issues the `delegate` credential, and on which drive?
- **Limits:** spending and time caps per fleet.

Decided: Remote Control and SSH are both supported for reaching coordinators. The build order above is approved.
