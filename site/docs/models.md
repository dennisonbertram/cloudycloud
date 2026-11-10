# Models and keys

> Choose Claude or an open model for a subagent and set up the keys each one needs.

Source: https://cloudycloud.tech/docs/models.html

Cloudy Cloud uses your own keys. By default each subagent runs Claude, and you can run a subagent on another model by naming a profile.

## Bring your own keys

Each user supplies their own credentials, because Anthropic's terms require each end user to use their own.

You pay your providers directly. Cloudy Cloud does not resell model access, and this page gives no prices.

## Claude credentials

Subagents need one Claude credential. The setup step (`cloudy-cloud setup`) asks for it. Two kinds work:

- **A token from `claude setup-token`** (starts with `sk-ant-oat01-`). This uses your Claude subscription. At the Claude step, press Enter and setup runs `claude setup-token` for you, or paste a token you made yourself. Setup checks the token with one small Claude request. It is saved as `CLAUDE_CODE_OAUTH_TOKEN`.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`). Setup does not ask for it. Add the line `ANTHROPIC_API_KEY=...` to the env file yourself (see below). Usage is billed per use.

If both are saved, subagents use the token and not the API key.

Setup saves all keys to `~/.config/cloudy-cloud/env`. Setup creates the folder with mode 700 and writes the file so that only your user account can read it. The file is plain text with one `NAME=value` line per key. To use another location, set `CLOUDY_CLOUD_CONFIG`.

## Default model and choosing another

With no `profile`, a subagent runs Claude. To pick a Claude model, pass the optional `model` argument of `cloud_agent`, for example `haiku`.

To run a subagent on a non-Claude model, pass the `profile` argument of `cloud_agent`. Do not use `model` for non-Claude models. You can ask in plain language, for example "use a glm subagent for this". Follow-up messages to that subagent reuse its profile.

## Built-in profiles

| Profile | Provider | Model id | Key needed | Notes |
|---|---|---|---|---|
| `glm` | Particle.ai | `z-ai/glm-5.3-flash` | `PARTICLE_API_KEY` | Runs Claude Code on the model. |
| `deepseek` | Particle.ai | `deepseek-ai/deepseek-v41-flash-1017` | `PARTICLE_API_KEY` | Runs Claude Code on the model. |
| `particle` | Particle.ai | `particle-ai/particle-1` | `PARTICLE_API_KEY` | Runs Claude Code on the model. |
| `pi-glm` | Particle.ai | `z-ai/glm-5.3-flash` | `PARTICLE_API_KEY` | Runs the pi coding agent, not Claude Code. |
| `pi-deepseek` | Particle.ai | `deepseek-ai/deepseek-v41-flash-1017` | `PARTICLE_API_KEY` | Runs the pi coding agent. |
| `pi-particle` | Particle.ai | `particle-ai/particle-1` | `PARTICLE_API_KEY` | Runs the pi coding agent. |
| `openrouter` | OpenRouter | None built in. You pass one. | `OPENROUTER_API_KEY` | See OpenRouter. |

A profile worker receives only its own provider key. It never receives your Claude credential. If the key for a profile is missing, `cloud_agent` fails at once and names the key.

### The pi profiles

The `pi-*` profiles run the [pi coding agent](https://pi.dev) in the worker instead of Claude Code. They use none of your Claude allowance. The README says this path has not been run live yet, so treat it as experimental. A pi profile is for workers only, because coordinators always run Claude Code. Results from pi workers have no cost line. They get no MCP servers from `cloudy-cloud mcp add`.

## OpenRouter

To use OpenRouter:

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Run `cloudy-cloud setup` and paste it at the OpenRouter step. It is saved as `OPENROUTER_API_KEY`.
3. Start a subagent with `profile: "openrouter"` and pass the OpenRouter model id in `model`. This is the one case where `model` goes with a non-Claude model, because the profile has no built-in model.

If you pass no model, the call fails with "needs a model". To avoid passing it every time, set a `model` for `openrouter` in `profiles.json` (below).

> Note: Signing in with OpenRouter or ChatGPT is not available. You paste an API key.

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

`format` is `anthropic` or `openai`. `keyName` must be a key in your env file whose name ends in `_API_KEY`. An optional `"harness": "pi"` runs the pi agent. Replace `MODEL-ID` with a model id from your provider.

## Adding or changing keys later

- Run `cloudy-cloud setup` again. It shows each saved key masked and asks before replacing it. The Particle.ai and OpenRouter steps are optional: press Enter to skip.
- Or edit `~/.config/cloudy-cloud/env` directly. Keep the file private. To remove all saved keys, delete it.
- Restart `cloudy-cloud` afterwards. It reads keys once at start, so a running session keeps the old ones.

> Warning: A provider key is stored on each worker machine that uses that profile. A prompt-injected worker could read it. Use keys you can revoke.
