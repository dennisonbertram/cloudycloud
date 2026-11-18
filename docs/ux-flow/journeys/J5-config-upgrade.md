# J5: Changing things later and staying current

Scope: switch model or harness, add or remove a key, share an MCP server, use profiles, switch provider, upgrade, troubleshoot, uninstall. Evidence is marked "measured" (I ran it or read the exact line) or "suspected" (inferred, not run). I ran `bash bin/cloudy-cloud --help` and `--version` (0.2.0) and read install.sh, bin/cloudy-cloud, src/mcp-cli.mjs, src/profiles.mjs. I did not run setup, because it writes keys and creates cloud state.

Ideal path: each change is one obvious command that says what it changed.

Verdict: setup-only management. Only the `mcp` commands (and the `coordinator` commands) behave like this ideal. Everything else is "re-run the whole setup wizard" or "edit a file by hand", and nothing tells you that you are out of date.

## Friction Scorecard

| Task | Actual steps | Ideal | Where it hurts |
|---|---|---|---|
| Share an MCP server | `mcp add NAME`, then for a secret `printf ... \| npx instabox secrets set ...` per token, copy-pasted from the output (src/mcp-cli.mjs:126). 2-3 steps | 1 | Mostly good: `mcp ls`/`rm` exist and each prints what changed (:128, :149). The extra Instabox step is printed ready to paste, which is fine. |
| Remove an MCP server | `mcp rm NAME` | 1 | Minimal. But it does not say that a stored Instabox secret remains (suspected: rm only edits the file, :143-151). |
| Add or replace an API key | `cloudy-cloud setup`, then walk every step: provider, agents, Instabox key, Claude token, GitHub, each optional key, coordinators (install.sh:1197-1223). About 8 screens to change one key | 1 (`cloudy-cloud key set NAME`) | No command targets one key. The only hint is "To change a key later, run: cloudy-cloud setup" (install.sh:1249, measured). Each existing key gets a "Replace it?" prompt, so a re-run is roughly 6 "no" answers (install.sh:778, 826, 1042, 1071). |
| Remove a key | Edit `~/.config/cloudy-cloud/env` by hand, and `instabox secrets rm` separately for proxied ones (suspected; no remove command exists in `--help`) | 1 | Dead end: setup can only add or replace. |
| Switch main harness (Claude to Codex etc.) | `cloudy-cloud codex` (a different command, README:267) | 1 | Good, one command. But the saved agent list (`CLOUDY_CLOUD_AGENTS`) only changes by re-running setup, so `setup --check-only` still checks for the old agent set (RUNBOOK:38). |
| Switch worker model or harness | Not a command. Say "use a codex subagent" or pass `profile` to the tool (RUNBOOK:107). No saved default | 1 | No `cloudy-cloud profiles` command to list what is available or to set a default. The list is in a very long system prompt (bin/cloudy-cloud:198), the README table, and an error text. Unknown names give "Known profiles: ..." only at failure (src/profiles.mjs:95). |
| Add a custom profile | Hand-write JSON in `~/.config/cloudy-cloud/profiles.json` (profiles.mjs:39, README:228) | 1 | Every field is hand-typed (format, baseUrl, keyName, harness); the errors are specific (profiles.mjs:98-106) but you only see them when you first use the profile. |
| Switch provider (Instabox to self-hosted) | `cloudy-cloud setup --provider self-hosted`, then the whole wizard again, including re-asking agents (install.sh:1164-1215) | 1 | Works, and switching back resets the setting silently (install.sh:1206). But `--provider` is shown only in setup's help line, not in the final summary. |
| Upgrade | `npm install -g cloudycloud@latest`, a line printed only at the end of setup (install.sh:1243, measured) | 1, or an automatic notice | No `cloudy-cloud update`. No version check anywhere (I grepped src and bin for "update available", "npm view", "outdated": no match, measured). `--version` prints only the number (bin/cloudy-cloud:79). |
| Detect a stale link | Impossible without `readlink` | 0 (it tells you) | Owner's case, measured from the transcript: the global command stayed linked to release-013. Cause in code: in the npx path, `link_command` sees any `cloudy-cloud` on PATH and prints "already on your PATH" without checking where it points (install.sh:560-564). The clone path does ask "runs from X. Point it at this folder instead?" (install.sh:~585) but npx users never reach that. |
| Troubleshoot | `setup --check-only` (good: no prompts, exit code), `doctor` (self-hosted only, bin/cloudy-cloud:35) | 1 | Two checkers with different scopes. `doctor` help says "check your own machine when subagents run there", so an Instabox user does not know to use `--check-only`. |
| Uninstall | README:327-335: delete machines with `npx instabox ls` and `rm` each, `npm uninstall -g` (or `npm unlink -g` for a clone), then manually delete 3 paths. 5+ steps | 1 | No `cloudy-cloud uninstall`. The README gives different commands for npm and clone installs; you must know which you used. |

Decisions the user makes in this journey that most people would answer the same way: "Replace it?" for keys they did not come to change (6 prompts, measured count in install.sh); which provider (re-asked on every setup run); which agents (re-asked, though the default is the saved choice, install.sh:1132).

Re-entry: running setup again re-asks provider, agents and each key, though all are saved. Only the agent list and keys are prefilled.

Needless confirmations: "Replace it?" on each saved key during a re-run, when the user's goal was a different key. Replacing the skill copy also prompts (install.sh:740).

Dead ends: remove a key; change the default worker model; learn that a new version exists; image machine lost to the 2-hour limit (owner's evidence: "No image machine found. Run: cloudy-cloud coordinator image", src/coordinator.mjs:113), which makes the user redo the whole sign-in with nothing telling them why.

## Take-away Pass

Per output, what could be removed or moved.

1. `cloudy-cloud --help` (measured): 15 command lines. Keep. Missing: any command for update, key, uninstall, profiles. `setup` is described as "check your tools and save your keys", which hides that it is also the upgrade-hint, provider-switch and agent-switch command. Add rather than remove.
2. End-of-setup hints (install.sh:1243-1252): "To update, run ..." sits among five hint lines, after the summary box and before the "protect" warning and "Next" box. This is the only mention of updating in the product. A reader who finished setup is looking at the Next box and will not scroll back. Move the update hint to `--version` and a periodic notice, and cut the setup copy of it.
3. `mcp add` output (src/mcp-cli.mjs:52-128): about 8 lines for a secret server: Found, type, url/command, env rows, "This server sends a secret...", "It is written as ...", "Store it once: ...", "Added ...". The last line is the only one that says the job is done, and it comes after the command the user still has to run. Reorder: print "Added" first or say "Not usable until you run:". Today the user can read "Added ... Every cloud subagent you start from now on gets it." while the secret is still not stored (measured, :121-128).
4. `mcp ls` (:136-139): prints name, type, target, "needs X". It does not say whether the needed secret is stored in Instabox. The user cannot tell a working server from one waiting on `secrets set`. Add "(stored)" or "(not stored yet)".
5. `setup` re-run banner and steps: the "Tools" step, dependency check and skill copy (install.sh:1177-1190) run every time, even when the user is only changing a key. They add several lines of green checks before the user reaches what they came for.
6. `--check-only` header: does not print the version or the path the command runs from. Both are the first facts a troubleshooter needs (owner's stale-link case).

## The Simpler Version

Ideal steps for the five most common changes:

1. Update: run `cloudy-cloud update` (prints "0.2.0 to 0.2.1 (npm install -g cloudycloud@latest)" and does it, or says "already latest"). Separately, an ordinary run prints one line when a newer version exists: "cloudycloud 0.2.1 is out (you have 0.2.0). Run: cloudy-cloud update". Check at most once a day, cache the answer, never block start.
2. Change one key: `cloudy-cloud key set OPENROUTER_API_KEY` (hidden prompt, stores it the same way setup would, prints "Saved OpenRouter key, stored in Instabox"). `cloudy-cloud key rm NAME` removes it from the env file and Instabox. `cloudy-cloud key ls` lists names and where each is stored.
3. Change provider: `cloudy-cloud provider self-hosted` (or `instabox`): asks only the new provider's questions, prints "Subagents now run on your machine at HOST".
4. Pick a worker model: `cloudy-cloud profile ls` (name, harness, model, key, ready or missing key) and `cloudy-cloud profile use codex` to set the default worker. Per-call `profile` stays.
5. Uninstall: `cloudy-cloud uninstall` lists machines and branches it will remove, asks once, then removes the global package, skills and config. Print the equivalent manual steps only when a step fails.

Concrete changes, in order of payoff:

- A. Add a version notice. When `cloudy-cloud` starts a session, compare to `npm view cloudycloud version` (cached for 24 hours in `~/.config/cloudy-cloud/`, fail silent offline, skipped when stdout is not a TTY) and print one line. Owner's problem solved in one place.
- B. In `link_command`, when `cloudy-cloud` is on PATH, resolve where it points. If the target is a worktree or another clone and this copy is a newer npm version, warn: "cloudy-cloud on your PATH runs from /path/release-013 (0.1.3). Replace it?" The clone path already has this prompt (install.sh:~585); apply it to the npx path (install.sh:560-564).
- C. `--version` should print version and install path (`0.2.0 (/opt/.../node_modules/cloudycloud)`), so a stale link is visible in one command.
- D. Add `cloudy-cloud update` as an alias for the npm command, or for `git pull && npm install` on a clone.
- E. Add `key set|rm|ls` so a one-key change does not walk the wizard. Reuse the setup functions that already exist (`keep_key`, `del_env`, install.sh:317, 625).
- F. Put `setup --check-only` under a name users guess. `cloudy-cloud doctor` should check whichever provider is active, not only self-hosted, and print version, path, provider, agents, keys. Keep `--check-only` as an alias. This merges two troubleshooting commands.
- G. Add `cloudy-cloud profile ls`. The data is already in `loadProfiles` (src/profiles.mjs:38).
- H. Add `cloudy-cloud uninstall`. The README already lists the steps in order.
- I. Coordinator image: print the 2-hour limit at the start of `coordinator image`, and when the machine is gone, say "The image machine expired (they last 2 hours). Run `cloudy-cloud coordinator image` again and sign in faster, or run `claude auth login` here and paste the token." Scope is J-coordinator, noted here because it is the owner's reported trouble.
- J. `mcp add`: print "Added" first, and put "Store the token now" as the last block with the label "Not working until you do this". Make `mcp ls` mark stored vs not stored.

Reuse note: A, C and D can share one small function. E, F and G reuse existing code. No new framework is needed.

## Clarity Issues

1. "To update, run: npm install -g cloudycloud@latest" appears once, after setup (install.sh:1243, measured). A returning user never sees setup output again. Clarity fix: show it where the version appears.
2. "cloudy-cloud is already on your PATH" (install.sh:564) reports success with a path but does not say which version or whether it is the one the user just ran. For the owner this line was the exact moment the stale link was accepted (suspected: they ran npx setup, and the text matches the code path). It should say "already on your PATH, version X".
3. `setup` is overloaded: first-time install, change a key, switch provider, switch agent set, check only, and the update hint. The help line "check your tools and save your keys" covers only two of these.
4. "Replace it?" is repeated for Instabox key, Claude token, GitHub, OpenAI, Particle, OpenRouter, and the skill, with the same text each time (install.sh:740, 778, 826, 1042, 1071). It does not say that "no" is the safe default for a key the user is not changing.
5. `mcp add` says "Added" and "Every cloud subagent you start from now on gets it" even when the token is not yet stored (src/mcp-cli.mjs:128). Wording promises more than is true.
6. `doctor` says "check your own machine when subagents run there" (bin/cloudy-cloud help). Instabox users reasonably skip it, though a doctor is what they would type when something is wrong. Name mismatch between `doctor` and `setup --check-only`.
7. Profile errors name `profiles.json` fields (profiles.mjs:98-106) but there is no command to create a valid one, so the first feedback on a hand-written file comes at first use, not when the file is saved.
8. After an expired image machine the error text "No image machine found. Run: cloudy-cloud coordinator image" (src/coordinator.mjs:113) does not say why it is gone. The user cannot learn the 2-hour limit anywhere (owner transcript; no mention in setup output, measured by grep of install.sh for "2 hour"/"IMAGE_SECONDS"; suspected for other docs).
9. Uninstall steps differ for npm vs clone installs (README:332-335) and the user must know which they used. `--version` printing the path (change C) would answer that too.

Not friction: `cloudy-cloud codex|opencode|pi` to switch the main harness is one command, and `mcp ls|rm` are already close to ideal. Do not change those.
