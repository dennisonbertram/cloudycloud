# Hosted claude-cloud: design sprint

Status: **proposal.** Items marked *(verify)* need checking before building. Items marked **TBD** need a decision.

## Goal

Make claude-cloud usable without the local setup:
- **Sign in:** a user signs in with GitHub.
- **Pick repos:** they choose which repos fleets may work on.
- **Start coordinators:** from a web page, or from Claude Code.
- **Leave it running:** they close the laptop.
- **Infrastructure:** one central Instabox account, ours, runs every machine.
- **Users never handle** Instabox keys, `GH_TOKEN` secrets or snapshots.

## What carries over from the CLI

Everything that runs on machines:
- the agent lifecycle;
- the cloud tools and MCP tasks;
- model profiles, including the `pi` harness and the gateway;
- the fleet skill;
- cleanup;
- coordinator setup, including marking first-run setup done.

All of it is proven live (see [STATUS.md](STATUS.md)). The hosted service replaces the **laptop-side setup**: the keys file, `install.sh`, `coordinator image` and the local MCP server's role as the place that holds credentials.

## Architecture

```
Browser / Claude app ──► Web app (Next.js) ──► API ──► Instabox (central account)
        │  Clerk sign-in         │                     │  coordinators + workers
        │                        ├─► Postgres (tenants, fleets, runs, usage)
        │                        ├─► GitHub App (installation tokens per repo)
        │                        └─► Secret store (per-user model keys, encrypted)
        └──── Remote Control ───────────────────────────► coordinator sessions
```

| Piece | Choice | Why |
| --- | --- | --- |
| **Accounts** | Clerk, with GitHub as the sign-in method and Clerk organizations for teams | The user asked for Clerk. Sign-in, teams and webhooks come built in. |
| **Repo access** | A **GitHub App** that the user installs on chosen repos | Installation tokens are short-lived (1 hour) and limited to the installed repos. They're better than a user's OAuth token, which reaches all of their repos. Clerk's `getUserOauthAccessToken()` can return a user's GitHub OAuth token, but only with custom OAuth credentials, so keep it for identity and use the App for repos. |
| **Machines** | Our one Instabox account. Each tenant gets its own Instabox **workspace** if Instabox supports enough workspaces *(verify)*. Otherwise, metadata labels plus per-tenant caps enforced in the API. | Isolation and per-tenant usage. |
| **GitHub credential on machines** | Per-machine Instabox proxy secret holding a **fresh installation token**, refreshed before its 1-hour expiry *(verify Instabox's per-machine secret refresh, `PATCH /v1/machines/{id}/secrets`)* | Machines never hold a long-lived GitHub credential. |
| **Claude login for coordinators** | The user connects their own Claude account. Remote Control needs a full claude.ai login on the machine. **TBD:** a per-user snapshot after a one-time in-browser login on a setup machine (today's flow, automated), or Anthropic API keys per user (no Remote Control). | Coordinators run as the user, on the user's subscription. |
| **Open-model workers** | Per-user keys for Particle or OpenRouter, held as Instabox proxy secrets for the provider's host, or a pooled key that we pay for. **TBD.** | `pi` workers need no gateway and use no Claude allowance. |
| **Web app** | Next.js on Vercel, plus a small API using the same `src/` modules | Pages for fleets and coordinators, live status and a stop button. |
| **Database** | Postgres for tenants, GitHub installations, coordinators, fleets, agents, usage and audit logs | The CLI keeps this in memory today, so it is lost on restart. |

## User flows

1. **Sign up:**
   - The user signs in with GitHub through Clerk.
   - They install the GitHub App on chosen repos.
   - They connect Claude: an automated one-time login on a setup machine, giving a per-user coordinator snapshot.
   - Optionally, they add Particle or OpenRouter keys.
2. **Start a coordinator:** pick a repo and model profile, then press Start. The API:
   - creates the machine from the user's snapshot;
   - attaches the GitHub installation token and model keys as proxy secrets;
   - marks Claude's first-run setup done;
   - starts Remote Control.

   The page links to the Remote Control session.
3. **Watch and steer:** the dashboard shows coordinators, their workers, live progress from the MCP task status, and machine counts. The user talks to a coordinator from claude.ai, the Claude app or the page.
4. **Results:** coordinators trunk-merge into `fleet/<topic>` and open one PR through the GitHub App. The dashboard links to the PR.
5. **Stop:** a stop button per coordinator or per fleet. Caps stop runaway fan-out.

## Limits and billing

- **Per tenant:** maximum machines, maximum concurrent workers, maximum depth (already in code), daily machine-hours, and an idle stop for coordinators (a new **TBD** default, for example 12 hours).
- **Metering:** machine-hours from Instabox usage APIs (`GET /v1/machines/{id}/usage` exists), plus model tokens from the progress streams.
- **Billing:** **TBD.** Options are free for a small trusted group, or Stripe usage-based billing.

## Security

- **Tenant isolation:** no tenant's credentials ever reach another tenant's machine. Instabox workspaces per tenant if available; otherwise strict label checks on every API call.
- **GitHub:** installation tokens are limited to the installed repos. Branch rules block pushes to main. The App asks only for Contents (read and write), Pull requests (write) and Metadata (read).
- **Proxy secrets:** machines hold placeholders only, for GitHub and model keys. The Claude login on coordinators is the exception: it's the user's own, on their own machine.
- **Audit log:** who started what, which repos and which machines.
- **Abuse:** caps, plus outbound network limits on machines if Instabox supports them *(verify)*.

## Build phases

1. **Private alpha, about 1 week of work:**
   - Clerk sign-in and the GitHub App;
   - one shared tenant;
   - start, stop and list coordinators from a page;
   - the existing CLI code imported as a library.
2. **Teams:** Clerk organizations, per-tenant caps and Postgres state, plus a dashboard with live progress.
3. **Self-serve:** an automated Claude connection, provider keys, metering and billing.

## Open questions (TBD)

1. Who is it for first: you and a few teammates, or the public?
2. Coordinator Claude login: a per-user snapshot after an in-browser login, or API keys (no Remote Control)?
3. Open models: each user's own keys, or a pooled key we pay for, such as the free Particle deal?
4. Can Instabox create enough workspaces per tenant, and refresh a machine's proxy secret without a restart? *(verify)*
5. Billing model and default caps.
