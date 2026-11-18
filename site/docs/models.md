# Models and keys

> Choose the agent and model for a subagent (Claude Code, pi, oh-my-pi, Codex or opencode) and set up the keys each one needs.

Source: https://cloudycloud.tech/docs/models.html

Cloudy Cloud uses your own keys. By default each subagent runs Claude Code. You can run a subagent on another agent or model by naming a profile.

This page covers every worker agent: Claude Code (the default), pi, oh-my-pi (`omp`), Codex and opencode. Each section says which credential that agent needs. The main session, which you start with `cloudy-cloud`, `cloudy-cloud codex`, `cloudy-cloud opencode`, `cloudy-cloud pi` or `cloudy-cloud free-pi`, is covered in [Getting started](https://cloudycloud.tech/docs/index.html#other-hosts).

## Bring your own keys

Each user supplies their own credentials, because Anthropic's terms require each end user to use their own.

You pay your providers directly. Cloudy Cloud does not resell model access, and this page gives no prices.

## Claude credentials

Applies to: workers that run Claude Code (no profile, or `glm`, `deepseek`, `particle`, `openrouter`) and the Claude Code main session. Workers on pi, omp, Codex or opencode profiles do not need it.

Claude Code subagents need one Claude credential. The setup step (`cloudy-cloud setup`) asks for it. Two kinds work:

- **A token from `claude setup-token`** (starts with `sk-ant-oat01-`). This uses your Claude subscription. At the Claude step, press Enter and setup runs `claude setup-token` for you, or paste a token you made yourself. Setup checks the token with one small Claude request. It is saved as `CLAUDE_CODE_OAUTH_TOKEN`.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`). Setup does not ask for it. Add the line `ANTHROPIC_API_KEY=...` to the env file yourself (see below). Usage is billed per use.

If both are saved, subagents use the token and not the API key.

Setup saves all keys to `~/.config/cloudy-cloud/env`. Setup creates the folder with mode 700 and writes the file so that only your user account can read it. The file is plain text with one `NAME=value` line per key. To use another location, set `CLOUDY_CLOUD_CONFIG`.

## Default model and choosing another

With no `profile`, a subagent runs Claude Code. To pick a Claude model, pass the optional `model` argument of `cloud_agent`, for example `haiku`.

To run a subagent on another agent or a non-Claude model, pass the `profile` argument of `cloud_agent`. Do not use `model` for non-Claude models, except as noted for `openrouter`, `codex-openrouter` and `opencode-openrouter`. You can ask in plain language, for example "use a glm subagent for this". Follow-up messages to that subagent reuse its profile.

## Worker agents at a glance

| Agent on the machine | Profiles | Credential it needs | Started as | Proven live |
|---|---|---|---|---|
| Claude Code (default) | none, or `glm`, `deepseek`, `particle`, `openrouter` | Claude token or API key; for the four profiles, the provider key instead | `claude -p ... --output-format stream-json` | Yes, including GLM and DeepSeek through Particle.ai |
| pi | `pi-glm`, `pi-deepseek`, `pi-particle` | `PARTICLE_API_KEY` | `pi --mode json --provider worker --model ... --session ID` | Yes (`pi-glm`) |
| oh-my-pi | `omp-glm`, `omp-deepseek`, `omp-particle` | `PARTICLE_API_KEY` | `omp -p --mode json --model worker/MODEL [--session ID] ...` | Yes (`omp-glm`) |
| Codex | `codex`, `codex-chatgpt`, `codex-openrouter` | `OPENAI_API_KEY`, your ChatGPT login file, or `OPENROUTER_API_KEY` | `CODEX_HOME=~/codex-home codex exec [resume ID] --json --dangerously-bypass-approvals-and-sandbox -c developer_instructions=... -` | No. Only fake-sandbox tests have run it. |
| opencode | `opencode-glm`, `opencode-deepseek`, `opencode-particle`, `opencode-openrouter` | `PARTICLE_API_KEY` or `OPENROUTER_API_KEY` | `opencode run --format json --model worker/MODEL [--session ses_...]` | No. Only fake-sandbox tests have run it. |

free-pi can be a main session but not a worker: free-pi-cli has no headless mode, and its terms forbid scripted use.

## Built-in profiles

| Profile | Provider | Model id | Key needed | Notes |
|---|---|---|---|---|
| `glm` | Particle.ai | `z-ai/glm-5.3-flash` | `PARTICLE_API_KEY` | Runs Claude Code on the model. |
| `deepseek` | Particle.ai | `deepseek-ai/deepseek-v41-flash-1017` | `PARTICLE_API_KEY` | Runs Claude Code on the model. |
| `particle` | Particle.ai | `particle-ai/particle-1` | `PARTICLE_API_KEY` | Runs Claude Code on the model. |
| `pi-glm` | Particle.ai | `z-ai/glm-5.3-flash` | `PARTICLE_API_KEY` | Runs the pi coding agent, not Claude Code. |
| `pi-deepseek` | Particle.ai | `deepseek-ai/deepseek-v41-flash-1017` | `PARTICLE_API_KEY` | Runs the pi coding agent. |
| `pi-particle` | Particle.ai | `particle-ai/particle-1` | `PARTICLE_API_KEY` | Runs the pi coding agent. |
| `omp-glm` | Particle.ai | `z-ai/glm-5.3-flash` | `PARTICLE_API_KEY` | Runs the oh-my-pi (`omp`) coding agent, not Claude Code. |
| `omp-deepseek` | Particle.ai | `deepseek-ai/deepseek-v41-flash-1017` | `PARTICLE_API_KEY` | Runs the oh-my-pi coding agent. |
| `omp-particle` | Particle.ai | `particle-ai/particle-1` | `PARTICLE_API_KEY` | Runs the oh-my-pi coding agent. |
| `codex` | OpenAI | Codex's own default | `OPENAI_API_KEY` | Runs the Codex CLI. See The codex profiles. |
| `codex-chatgpt` | OpenAI, through your ChatGPT plan | Codex's own default | The login file `~/.config/cloudy-cloud/codex-auth.json` | Runs the Codex CLI. |
| `codex-openrouter` | OpenRouter | None built in. You pass one. | `OPENROUTER_API_KEY` | Runs the Codex CLI. |
| `opencode-glm` | Particle.ai | `z-ai/glm-5.3-flash` | `PARTICLE_API_KEY` | Runs opencode. See The opencode profiles. |
| `opencode-deepseek` | Particle.ai | `deepseek-ai/deepseek-v41-flash-1017` | `PARTICLE_API_KEY` | Runs opencode. |
| `opencode-particle` | Particle.ai | `particle-ai/particle-1` | `PARTICLE_API_KEY` | Runs opencode. |
| `opencode-openrouter` | OpenRouter | None built in. You pass one. | `OPENROUTER_API_KEY` | Runs opencode. |
| `openrouter` | OpenRouter | None built in. You pass one. | `OPENROUTER_API_KEY` | Runs Claude Code. See OpenRouter. |

A profile worker receives only its own provider key. It never receives your Claude credential. The one exception to "a key" is `codex-chatgpt`, which receives your ChatGPT login file. If the key for a profile is missing, `cloud_agent` fails at once and names the key. Coordinators always run Claude Code, so a coordinator cannot use a pi, omp, Codex or opencode profile.

### The pi profiles

The `pi-*` profiles run the [pi coding agent](https://pi.dev) in the worker instead of Claude Code. They use none of your Claude allowance. Results from pi workers have no cost line. They get the MCP servers from `cloudy-cloud mcp add`, except `sse` servers, because pi has no SSE transport. See [MCP servers for subagents](https://cloudycloud.tech/docs/mcp.html).

### The omp profiles

The `omp-*` profiles run [oh-my-pi](https://github.com/can1357/oh-my-pi) (the `omp` command) in the worker instead of Claude Code. oh-my-pi is a fork of pi rewritten as a coding-first agent. It adds LSP support, persistent Python and Bun kernels, subagents and many providers. The profiles use the same three Particle.ai models as the pi profiles, and none of your Claude allowance.

Each omp worker installs the pinned oh-my-pi release v18.18.7 with the official installer, which checks the binary's SHA-256. The binary is about 243 MB and is downloaded on every omp worker, so an omp worker starts slower than a pi or Claude worker. In one live check the whole omp worker setup (clone, first push, omp install and config) took about 20 seconds from machine creation to running, against 11 seconds for a pi worker started at the same time (one run each). Results from omp workers have no cost line. A follow-up resumes the same omp session. omp workers get the servers from `cloudy-cloud mcp add`, including `sse` servers.

### The codex profiles

The `codex`, `codex-chatgpt` and `codex-openrouter` profiles run the [Codex CLI](https://github.com/openai/codex) in the worker. Cloudy Cloud installs the pinned `@openai/codex@0.166.0` under `~/.local` and runs `codex exec --json` with `CODEX_HOME=~/codex-home`. Follow-up messages use `codex exec resume ID`. Servers from `cloudy-cloud mcp add` go into `~/codex-home/config.toml`, except `sse` servers and entries that Codex cannot read a secret from. Skipped servers are named in the reply.

Codex only speaks the Responses API, and Particle.ai does not offer it, so there is no `codex-glm`. Set up the credential for the profile you use:

**`codex` (OpenAI API key).** Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). `cloudy-cloud setup` does not ask for it. On Instabox, store it as a proxy secret limited to OpenAI, then add the name to `CLOUDY_CLOUD_PROXY_SECRETS` in `~/.config/cloudy-cloud/env`:

```
printf %s "$OPENAI_API_KEY" | npx --yes instabox@latest secrets set OPENAI_API_KEY --host api.openai.com
```

- On a self-hosted machine, add the line `OPENAI_API_KEY=...` to the env file.

**`codex-chatgpt` (ChatGPT plan).** On your computer run `codex login` and choose "Sign in with ChatGPT". Then copy the login file where Cloudy Cloud reads it:

```
install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json
```

- Set `CLOUDY_CLOUD_CODEX_AUTH` to use another path. The file must have mode 600. This is the one real credential that Cloudy Cloud sends to a machine as a file, even on Instabox, because a ChatGPT login cannot be a proxy secret. Its tokens are scrubbed from replies, and the machine may refresh them. Do not pass `model` unless your plan supports it: with no model, Codex uses the default model of your plan.
- **`codex-openrouter`.** Uses `OPENROUTER_API_KEY`, set up as in OpenRouter. Pass the OpenRouter model id in `model`.

> Note: Not proven live: no Codex worker has run on a real Instabox machine yet. The code has passed tests against a fake sandbox. Resume and the ChatGPT-login error message were also recorded locally with `codex exec`.

### The opencode profiles

The `opencode-*` profiles run [opencode](https://opencode.ai) in the worker. Cloudy Cloud installs the pinned `opencode-ai@1.18.31` with npm under `~/.local` and runs `opencode run --format json --model worker/MODEL`. A follow-up passes `--session ses_...`. The configuration is `~/opencode-agent/opencode.json` (mode 600). It holds key names such as `{env:PARTICLE_API_KEY}`, never key values, and the servers from `cloudy-cloud mcp add`. Keys: `opencode-glm`, `opencode-deepseek` and `opencode-particle` use `PARTICLE_API_KEY`, and `opencode-openrouter` uses `OPENROUTER_API_KEY` and needs `model`. Both are set up with `cloudy-cloud setup` (see OpenRouter for the second).

No profile uses opencode's own login, because that would copy a login to the machine.

> Note: Not proven live: no opencode worker has run on a real Instabox machine yet. The code has passed tests against a fake sandbox.

## OpenRouter

To use OpenRouter:

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Run `cloudy-cloud setup` and paste it at the OpenRouter step. It is saved as `OPENROUTER_API_KEY`.
3. Start a subagent with `profile: "openrouter"` (Claude Code), `"codex-openrouter"` (Codex) or `"opencode-openrouter"` (opencode), and pass the OpenRouter model id in `model`. These are the cases where `model` goes with a non-Claude model, because the profiles have no built-in model.

If you pass no model, the call fails with "needs a model". To avoid passing it every time, set a `model` for `openrouter` in `profiles.json` (below).

> Note: Signing in with OpenRouter is not available: you paste an API key. A ChatGPT sign-in works only through the `codex-chatgpt` profile (see above).

## Your own profiles

Create `~/.config/cloudy-cloud/profiles.json` (or point `CLOUDY_CLOUD_PROFILES` at another file) to override a built-in profile or add one:

```
{
  "openrouter": {
    "format": "anthropic",
    "baseUrl": "https://openrouter.ai/api",
    "model": "MODEL-ID",
    "keyName": "OPENROUTER_API_KEY"
  }
}
```

`format` is `anthropic` or `openai`. `keyName` must be a key in your env file whose name ends in `_API_KEY`. An optional `"harness"` is `"claude"` (the default), `"pi"`, `"omp"`, `"codex"` or `"opencode"`. It picks the agent that runs on the machine. The `codex` and `opencode` harnesses need `"format": "openai"`, and `codex` needs a provider that offers the Responses API. A `codex` profile can use `"auth": "chatgpt"` instead of `keyName`. Replace `MODEL-ID` with a model id from your provider.

## Adding or changing keys later

- Run `cloudy-cloud setup` again. It shows each saved key masked and asks before replacing it. The Particle.ai and OpenRouter steps are optional: press Enter to skip. Setup does not ask for `OPENAI_API_KEY` or the Codex login file: see The codex profiles.
- Or edit `~/.config/cloudy-cloud/env` directly. Keep the file private. To remove all saved keys, delete it.
- Restart `cloudy-cloud` afterwards. It reads keys once at start, so a running session keeps the old ones.

> Warning: A provider key is stored on each worker machine that uses that profile. A prompt-injected worker could read it. Use keys you can revoke.
