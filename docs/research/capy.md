# Capy (capy.ai): what it is and how Cloudy Cloud competes

Read 2026-11-17 from capy.ai, capy.ai/llms.txt and a Daytona case study. Almost everything here is Capy's own marketing; nothing was tested.

## What Capy is

- Pitch: "Agent swarms for your engineering team. Orchestrate thousands of agents on any model, across the cloud and your machines." Company: Scrapybara, Inc. (YC).
- **Captains:** long-lived orchestrator agents that run hundreds of agents and surface only what needs a human. Build agents execute; a Review agent reviews.
- **One isolated VM per thread** (Ubuntu). Daytona says Capy started 100k sandboxes in one week.
- **Work arrives from** Slack, Linear (progress streams back into the issue), GitHub, the web app, desktop apps, a CLI and an API.
- **Ends in a PR**, then **Autofix** handles CI failures, review comments and merge conflicts until it is mergeable. **Guided review** walks a reviewer through each PR.
- **Extras:** browser and desktop QA on the VM, cloud iPhone/Android QA, live preview URLs, shared "Drive" storage for rules and skills, multiplayer threads, threads that move between cloud and laptop mid-task.
- **Models:** ChatGPT, Copilot and SuperGrok subscriptions; gateways (OpenRouter, Vercel, Bedrock, Fireworks, Together, ...); Anthropic/OpenAI/xAI/Gemini keys. No markup on your own models.
- **Enterprise:** SOC 2 Type II, SSO, ZDR, audit logs, deploy in your own cloud.
- **Pricing:** Free (your own machines and keys), Lite $20, Pro $100, Max $200 per month, unlimited members. Paid plans bundle machine minutes plus the same dollar amount of model usage.
- **Benchmark:** a Terminal-Bench chart whose labels are unclear. Not worth citing.

## Where they overlap with us

Both run one machine per agent, swarms with orchestrators (their Captains, our coordinators), open models next to frontier models, and results as branches/PRs. Capy already has everything in our HOSTED-DESIGN.md and much more.

## Where Cloudy Cloud is different

1. **It is your Claude Code session, not a new app.** Your skills, CLAUDE.md, hooks and habits stay. Capy asks a team to move into its app and its agent harness.
2. **Claude subscription works.** Capy's subscription list is ChatGPT, Copilot and SuperGrok; Claude needs an API key. Our workers can use the user's Claude login.
3. **Open source, self-run, no middleman.** Your Instabox account, your keys, your GitHub token stays out of the machine. No per-seat or bundled usage.
4. **Cheap tree swarms.** Opus coordinator to GLM/DeepSeek/pi workers is proven live today.

## What to do (proposals, not decisions)

Do not chase Capy feature for feature; they are a funded team selling to companies. Compete for the individual Claude Code power user, then grow from there.

1. **Rewrite the site's position around point 1 above**: "Keep Claude Code. Give it a cloud fleet." Add Capy to the comparison table under hosted agents.
2. **Close the gaps that hurt an individual user most**, in this order:
   - Autofix: a worker that watches its own PR's CI and review comments and fixes them (we have the pieces: follow-up messages plus `gh`).
   - PRs instead of bare branches, opt-in, plus one merged `fleet/<topic>` PR per swarm (the fleet skill already does trunk merging).
   - A live preview URL for a worker (check whether Instabox exposes ports).
   - Start a worker from a GitHub issue or Linear ticket.
3. **Skip for now:** mobile device QA, desktop apps, SOC 2, SSO, multiplayer, Drive (agent-drive covers part of it). Revisit if teams ask.
4. **Pricing message:** "free, bring your own machines and models" matches Capy's free tier but runs in the cloud, which their free tier does not.

## Unknowns

- Whether Capy accepts a Claude Pro/Max subscription in some other way (not listed on the site).
- Real Capy reliability, speed and cost per task.
- How many Claude Code users want a separate app versus staying in the terminal.

Sources: https://capy.ai, https://capy.ai/llms.txt, https://capy.ai/about, https://www.daytona.io/customers/capy
