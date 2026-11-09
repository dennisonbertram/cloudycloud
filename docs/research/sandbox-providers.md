# Supporting more sandbox providers than Instabox

Research note, 2026-11-09. A subagent read the pricing pages on 2026-11-08 and 2026-11-09. Prices change, so check a provider's pricing page before relying on its number. "[I]" marks an inference; everything else came from the cited page. Prices are USD, billed per second unless noted.

## Summary

- **Instabox is the cheapest option found:** 2 vCPU / 4 GiB costs about $0.017 an hour ([instabox.sh](https://instabox.sh)). That is about 10 times cheaper than E2B or Daytona. Nobody checked why it is so low; it may be promotional pricing.
- **The reason to add a second provider is risk, not price:** depending on one vendor, quotas, and the hosted service.
- **The cheapest alternative that meets the hard requirements is Cloudflare Sandbox/Containers,** at about $0.05–0.18 an hour. It also keeps credentials out of the machine best. Vercel Sandbox is the quickest to integrate.
- **Running directly on AWS or Google Cloud is not cheaper once the work is counted.** Compute is cheap (a GCE e2-medium is about $0.034 an hour), but we would have to build a command and file API, a secret proxy, cleanup when a machine's time runs out, and a machine image ourselves.

## What Cloudy Cloud needs from a provider

These are the Instabox operations the code uses today:

| Operation | Code | Needed? |
|---|---|---|
| Create a machine from an image, with env vars and labels | `src/instabox.mjs:84` | Required. The image needs node, git, gh, tmux and claude. |
| Server-side delete deadline (`deleteAfterSeconds`, 6 h default, 24 h max) | `src/instabox.mjs:49-57`, `src/coordinator.mjs` | Strongly wanted. It is the only protection against leftover machines if every local process dies. |
| GitHub token as a proxy secret, so the token never reaches the machine | `src/instabox.mjs:21-40` | Required in practice. |
| Run a command with streaming output and a timeout; background jobs for turns longer than 10 min | `src/instabox.mjs:101-128` | Required. |
| Write files, binary-safe, up to about 9 MB (git bundles, keys, prompts) | `src/run-subagent.mjs`, `src/coordinator.mjs` | Required. |
| Delete a machine; list machines by label for the reaper | `src/instabox.mjs:97`, `src/reaper.mjs` | Required. |
| Snapshots, never-pause, SSH | `src/coordinator.mjs` | Coordinators only. |
| Handling for rate limits and quotas | `src/limits.mjs` | The logic works for any provider; only the error names and default limits are Instabox's. |

### Proposed interface

The code already passes a small sandbox object around (`home`, `files.write/read`, `commands.run`, `kill`). Making that object formal would look like this:

```
Provider { create({image, envs, labels, ttlSeconds, secrets}) -> Sandbox; list(labels); delete(id) }
Sandbox  { home; run(cmd, {cwd, timeoutMs, signal, onStdout}); write(path, bytes); read(path); kill();
           snapshot()/createFromSnapshot()  // coordinators only }
Capabilities { maxForegroundMs, hasServerTTL, hasProxySecrets, hasSnapshots, startsPerMin }
```

Estimated work [I]: rewrite or move about 300–400 of the 1,720 lines.
- `src/instabox.mjs` becomes one implementation of the interface.
- `src/reaper.mjs` calls the provider's list and delete instead of the Instabox API.
- `src/coordinator.mjs` has about 10 Instabox-specific spots.
- `install.sh`, the config, and the docs need updates.

A provider with no server-side delete deadline needs its own cleanup job, about 100 lines each.

## Price for 2 vCPU / 4 GiB

| Provider | 1 sandbox for 1 h | 50 sandboxes for 1 h | Notes |
|---|---|---|---|
| Instabox | $0.017 | $0.85, plus Pro at $20/mo | Free plan: 1 machine |
| Cloudflare Containers/Sandbox | $0.052 at 10% CPU, $0.182 at 100% | $2.60–9.10 | Workers Paid is $5/mo; [pricing](https://developers.cloudflare.com/containers/pricing/) |
| Fly.io Machines | about $0.092 [I, from the monthly price] | about $4.58 | [pricing](https://docs.fly.io/about/pricing) |
| Vercel Sandbox (Pro) | $0.110 at 10% CPU, $0.341 at 100% | $5.52–17.05 | Hobby sessions stop after 45 min; [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |
| E2B | $0.166 | $8.28 | Pro is $150/mo; [pricing](https://e2b.dev/pricing) |
| Daytona | $0.166 | $8.28 | The lowest tier allows only about 5 sandboxes at once; [pricing](https://www.daytona.io/pricing) |
| Modal Sandbox | $0.238 | $11.90 | [pricing](https://modal.com/pricing) |
| Runloop | $0.317 | $15.84 | [pricing](https://runloop.ai/pricing) |
| GCE e2-medium | $0.0335; Spot $0.005–0.032 | $1.68 | Third-party price source. Engineering cost is high. |
| AWS EC2 t3.medium | $0.0416; Spot about $0.015 | $2.08 | Third-party price source. Engineering cost is high. |
| AWS Fargate | $0.099 (x86) / $0.079 (ARM) | $4.94 / $3.95 | [pricing](https://aws.amazon.com/fargate/pricing/) |
| GKE Autopilot | $0.109; Spot $0.0325 | $5.43 / $1.63 | [pricing](https://cloud.google.com/kubernetes-engine/pricing) |
| Cloud Run jobs | $0.158 | $7.92 (about $3 after the free tier) | Up to 7 days per task |

Notes on the table:
- The 50-sandbox figures assume each sandbox runs the full hour [I].
- The AWS and Google Cloud rows leave out disk, egress, NAT, cluster fees and engineering time.
- The Morph and CodeSandbox pages were unreadable, so they are not in the table.

## How well each provider fits

- **Cloudflare:**
  - Firecracker microVMs that start in 1–3 seconds.
  - Commands with streaming output, and a guide for running Claude Code.
  - Outbound Workers add credentials on the way out, so tokens never enter the sandbox.
  - Downsides: it needs a TypeScript control plane (a Worker plus a Durable Object), there is no server-side delete deadline, and redeploying the Worker may restart running containers [I].
- **Vercel Sandbox:**
  - Firecracker microVMs, 24-hour sessions on Pro, and an SDK with commands, files and timeouts.
  - Credential brokering adds the header on the way out ([firewall docs](https://vercel.com/docs/sandbox/concepts/firewall)).
  - Unverified: whether brokering works for `git push` over HTTPS to GitHub.
  - On Pro, vCPU allocation starts at 150 a minute.
- **E2B, Daytona, Modal and Fly:**
  - Good APIs, but none documents a way to keep secrets off the machine. Without one, the fallback is a short-lived GitHub App token, scoped to the repo, placed on the machine.
  - Modal documents no file API.
- **Running on AWS or Google Cloud ourselves** means building:
  1. A machine image with Claude Code installed.
  2. A daemon on each machine for commands and files, because EC2, Fargate and Cloud Run have no exec-and-upload API.
  3. Start-up and quota handling.
  4. Cleanup when a machine's time runs out (a scheduler plus a function).
  5. An egress proxy that adds the GitHub token, or a scoped token on the machine.
  6. Networking: VPC, NAT and egress rules.
  7. Budget alarms and a cap on how many machines can run at once.

  Of these, GKE fits the interface best, because `kubectl exec` and `kubectl cp` cover running commands and writing files.

## Recommendation

1. **Phase 0:** extract the `Provider`/`Sandbox` interface, move Instabox to `src/providers/instabox.mjs`, and add a `CLOUDY_CLOUD_PROVIDER` setting. Behavior does not change.
2. **Phase 1:** add Vercel Sandbox as the second provider. It covers every hard requirement through a plain SDK, so it is the quickest proof that the interface works for more than one provider. Check first that GitHub git-over-HTTPS works through header brokering.
3. **Phase 2:** add Cloudflare Sandbox for cost and for the hosted service, with a client-side cleanup job.
4. **Phase 3:** run on AWS or Google Cloud directly (GKE Autopilot Spot or Fargate) only if volume grows beyond what a vendor will price.

## Risks

- **Claude Code terms** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)):
  - Running the unmodified Claude Code in hosted sandboxes is allowed, provided each end user signs in with their own Anthropic API key, subscription, or third-party provider credential.
  - Third parties may not route requests through Free, Pro, Max or Ultra plan credentials on their users' behalf, and may not collect, store or act as a middleman for Claude.ai credentials.
  - The bring-your-own-key CLI looks like the permitted shape [I].
  - The hosted design in `docs/HOSTED-DESIGN.md` stores a login snapshot for each user, so it needs a legal read before it is built. This is not legal advice.
- **Egress:** about $0.02–0.025/GB at Instabox, Fly and Cloudflare. The traffic is mostly git and API calls, so this should be small [I].
- **Secrets:** on every design, the Claude token stays on the machine.

## Still unknown

- Cold-start times for most providers.
- Cloudflare's maximum container lifetime.
- AWS and Google Cloud default quotas and egress rates.
- Fly's hourly price.
- Whether Vercel's header brokering works with GitHub git over HTTPS.
- Why Instabox's price is so low.
