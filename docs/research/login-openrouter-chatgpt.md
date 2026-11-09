# Signing in with OpenRouter and ChatGPT

Research note, 2026-11-09. Every fact cites the page it came from; "[I]" marks an inference. For now, users bring their own API keys for every provider. These sign-in options are for later.

## Log in with OpenRouter: possible, and small to build

- OpenRouter supports OAuth with PKCE for any app, including CLIs with a localhost callback on any port ([docs](https://openrouter.ai/docs/guides/overview/auth/oauth)).
  - The browser goes to `https://openrouter.ai/auth` with `callback_url`, `code_challenge` (S256), `state` and `key_label`.
  - The CLI exchanges the code with `POST https://openrouter.ai/api/v1/auth/keys` and `{code, code_verifier, code_challenge_method}`. The response is `{key, user_id}` ([spec](https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key.md)).
  - A code can be used once and expires after 10 minutes.
  - In headless mode you leave out `callback_url` and the user pastes the code into the CLI.
- The key is an ordinary inference key that bills to the user's credits. A CLI cannot set a credit cap on it. Caps need a management key ([spec](https://openrouter.ai/docs/api/api-reference/oauth/create-authorization-code.md)). The user may be able to edit the key's limit on openrouter.ai/keys; not verified.
- **Proposed `cloudy-cloud login openrouter`** [I]:
  1. Run PKCE through a one-shot server on `127.0.0.1`.
  2. Check `state`.
  3. Exchange the code for a key.
  4. Save `OPENROUTER_API_KEY` with mode 600 using the existing `write_env`, and never print it.
  5. Check the key with `GET /api/v1/key`.
  6. Over SSH, fall back to pasting the code.

  The `openrouter` worker profile already reads this key, so workers need no change.
- **Claude Code on OpenRouter** is documented: set `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, put the key in `ANTHROPIC_AUTH_TOKEN`, and leave `ANTHROPIC_API_KEY` empty ([guide](https://openrouter.ai/docs/guides/guides/claude-code-integration)). Only Anthropic models are guaranteed to work. Other models "may not work correctly", so test any model before advertising it.
- **Fees** ([pricing](https://openrouter.ai/pricing)):
  - Buying credits costs 5.5% (Standard plan).
  - Bringing your own provider key is free up to $25,000 a month, then 5%.

## Log in with ChatGPT

- **OpenAI now has an official "Sign in with ChatGPT" program for third-party apps, in preview** ([overview](https://developers.openai.com/siwc)). Open-source apps can use a user's ChatGPT plan through the Responses API.
  - The app registers a `client_id` and runs a loopback PKCE flow ([open-source flow](https://developers.openai.com/siwc/token-sharing-open-source)).
  - Calls go to `POST /v1/responses` only, with `store:false` and `stream:true` ([inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)).
  - There are many limits: no system-role items and no hosted tools ([preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)).
  - Copying the credential to a self-hosted VM is documented ([self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)).
  - "Paid or remotely hosted apps" must fill in OpenAI's interest form.
- **Codex CLI** supports ChatGPT sign-in and, in beta, device-code login for headless machines; the user enables it in ChatGPT settings. It also documents copying `~/.codex/auth.json` to a headless machine, and says to treat that file like a password ([auth docs](https://learn.chatgpt.com/docs/auth)).
- **Verdicts:**
  - **(a) A ChatGPT plan through the Claude Code harness:** technically possible but unproven, and the terms are unclear. It needs a gateway that translates Anthropic Messages into the Responses API under the preview's limits. Cloud workers may count as "remotely hosted", which means asking OpenAI first. Do not build this first.
  - **(b) A ChatGPT plan through a Codex harness on the worker:** the option easiest to defend, because it is OpenAI's own client with the user's own login (device code, or a copied `auth.json`). Workers run on a third-party VM, which OpenAI does not address, so the user must agree and be warned that the token sits on the worker [I].
  - Do not use the old unofficial route through `chatgpt.com/backend-api`.

## Anthropic's terms

From [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
- An end user may sign in to the unmodified Claude Code with their own subscription, including where a platform hosts Claude Code.
- Third parties may not offer Claude.ai login in their own apps, route requests through Free, Pro, Max or Ultra plan credentials for their users, or collect, store or act as a middleman for those credentials.
- Plan usage limits assume "ordinary, individual usage".

`claude setup-token` makes a one-year token for CI and scripts ([authentication](https://code.claude.com/docs/en/authentication)).

Today's flow, where each user runs their own token on their own machines, fits the allowed case [I]. Large fleets are a risk under the "ordinary, individual usage" wording, but no rule bans them.

## What to build, in order

1. Users bring their own API keys for every provider. This is how the product works now.
2. `cloudy-cloud login openrouter`, as described above. Verify it with one live run.
3. An opt-in `codex-*` worker harness using `codex login --device-auth`. Test it on a worker first.
4. Wait on Claude Code over a ChatGPT plan until OpenAI answers through the interest form.

## Not verified

- The OpenRouter key cap that a user can set.
- The details of OpenAI's help article (the page returned 403).
- SIWC client registration URLs.
- Whether LiteLLM supports SIWC.
- Whether Instabox VMs count as self-hosted or remotely hosted for SIWC.
