# UX flow critique: the Cloudy Cloud CLI, 2026-11-18

## Run summary

| Metric | Value |
|---|---|
| Journeys critiqued | 5, plus one review across all commands |
| Evidence | Code and help text at origin/feat/claude-cloud (v0.2.0), `setup --check-only` with an empty config, the dashboard demo with fake data, and the owner's live coordinator sign-in on 2026-11-17 and 2026-11-18. No cloud machines were created. |
| Verdicts | 0 minimal, 3 acceptable, 2 convoluted (J1 and J3 are the convoluted ones) |

## Friction scorecard

| Journey | Steps (actual/ideal) | Main friction | Verdict |
|---|---|---|---|
| [J1 Install and setup](journeys/J1-install-setup.md) | ~12 prompts and ~5 browser hops / ~3 prompts | Optional steps (alerts, Particle.ai and OpenRouter keys, coordinators) are in the default path. There is no "Setup complete", and the Next box comes last. | convoluted |
| [J2 First agent run](journeys/J2-first-agent.md) | ~4 / ~2 | The result ends in `git fetch origin <branch>` and a short sha, not a link to review. The branch name appears only at the end. | acceptable |
| [J3 Coordinator](journeys/J3-coordinator.md) | 6 user actions across 3 commands / 2 | Copy a raw `npx --yes instabox@latest ssh` command, run `claude auth login`, know to exit, then run `--save`. The image machine's 2-hour limit is never stated. | convoluted |
| [J4 Day to day](journeys/J4-day-to-day.md) | each command near ideal | No terminal answer to "is anything still costing money?", and no Cloudy Cloud command to stop or clean up a machine. | acceptable |
| [J5 Settings and upgrades](journeys/J5-config-upgrade.md) | changing one key takes ~6 prompts / 1 | Almost every later change means running setup again. Nothing says an update exists. | acceptable |

## Redundancy map ([redundancy.md](redundancy.md))

- **Duplicate paths (8).** The CLI prints raw `npx --yes instabox@latest ...` commands (ssh, ls, rm, secrets set) where a Cloudy Cloud command does the job or could. `coordinator attach` prints an SSH command instead of opening the session.
- **Duplicate information (7).** The same raw SSH command is printed several times in the coordinator output. The dashboard counts "Needs you 3" and "2 Waiting for you" for the same thing.
- **Overlapping features (7).** `doctor` checks only self-hosted setups, while `setup --check-only` is the checker that works for Instabox. The dashboard's List and Fleet views overlap.
- **Hierarchy and naming (8).** There is no top-level `ls` or `stop` you can run yourself. `--help` lists commands in no order of use, and `dashboard --help` starts the server (found by reading the code). The same thing is called agent, subagent, worker, machine, sandbox and box.

## Simplification proposals (ranked)

The ranking weighs how often the path is used and how much it removes against the effort.

### 1. Coordinator image in one command, with only the browser sign-in left to the user
- **Now:** `coordinator image` prints three manual steps, including a raw `npx` SSH command. The user has to know to exit after "Login successful." and then run `image --save`. The machine silently deletes itself after 2 hours (`IMAGE_SECONDS`, src/coordinator.mjs:29). The owner hit both problems.
- **Proposed:** `coordinator image` creates the machine, then runs `claude auth login` on it over an interactive terminal. It confirms the sign-in with `claude auth status`, then saves the image and deletes the machine. If the sign-in fails, it offers to try again on the same machine. `image --save` remains only as a retry, and when no machine exists it says the machine expired after 2 hours. Later, `coordinator start` could make the image itself the first time.
- **Saves:** 4 of 6 user actions and one command to remember. It also removes the 2-hour trap.
- **Effort:** M. `shellArgv` always turns off the interactive terminal when it runs a command (`-T`, src/providers/instabox.mjs:400; self-hosted.mjs:262-268), so it needs an option to keep one. Not yet verified: that `instabox ssh -- -t` gives an interactive terminal, the exit code of `claude auth login`, and the JSON fields `claude auth status` returns.

### 2. Tell people when they're out of date
- **Now:** No update notice exists. On the `npx` install path, `link_command` says "cloudy-cloud is already on your PATH" for any copy it finds, even an old worktree link (install.sh:560-567). The owner ran an old release this way.
- **Proposed:** Check for a new version at most once a day, cached, and print one line at session start when there is one. `--version` prints where the running copy is installed. `link_command` offers to replace a copy that is not the npm global install, as the clone path already does.
- **Saves:** Prevents silent stale installs. **Effort:** S.

### 3. Shorter first setup
- **Now:** About 12 prompts. Setup ends with maintenance hints and a warning, and the Next box comes last.
- **Proposed:** Ask only for what the first agent run needs. Move alerts, Particle.ai and OpenRouter keys, and coordinators to after "Ready", or behind `setup --more`. Take the provider from `--provider`, and detect which agents are installed from PATH. Default the global install to yes. End with one "Setup complete" line followed by the Next box.
- **Saves:** About 5 prompts, and keeps the coordinator image step out of the first-run path. **Effort:** M.

### 4. End each agent result with a link to review the branch
- **Now:** "Pushed to origin cloudy-cloud/<id> at abc1234. Fetch with: git fetch origin ..." (src/run-subagent.mjs:229).
- **Proposed:** Give the branch name in the start result. End the finished result with a GitHub compare URL for the branch. Offer to open a PR.
- **Saves:** Two manual steps on the most-used path. **Effort:** S.

### 5. `cloudy-cloud ls` and `cloudy-cloud stop`
- **Now:** To see or remove machines from the terminal, users run `npx instabox ls` or `rm`, and the README and RUNBOOK tell them to. Coordinators are never cleaned up automatically.
- **Proposed:** `ls` shows one line per agent and coordinator: id, activity and time left, ending with "N machines running, about $X/hour". `stop <id>` or `stop --all` deletes machines, including coordinators. The README Uninstall section and the RUNBOOK use these commands.
- **Saves:** One command answers "is anything still costing money?" **Effort:** M.

### 6. Cloudy Cloud commands instead of raw `npx --yes instabox@latest ...` hints
- **Now:** The CLI prints provider commands for ssh, ls, rm and secrets. `coordinator attach` prints a command instead of running it.
- **Proposed:** Print `cloudy-cloud shell <machine>` and the other Cloudy Cloud equivalents. `coordinator attach` opens the session, and prints the command only when there is no interactive terminal.
- **Saves:** Users run one tool, and the same text works on every provider. **Effort:** S.

### 7. One-command key changes and one health check
- **Now:** Changing one key means going through setup again, and removing one means editing a file. `doctor` checks only self-hosted setups.
- **Proposed:** Add `cloudy-cloud key set NAME`, `key rm NAME` and `key ls`, which shows names only, never values. `doctor` checks whichever provider is active, and takes over from `setup --check-only`.
- **Effort:** M.

### 8. Help that follows use, and one name for each thing
- **Proposed:** Group `--help` by how often each command is used. Make every subcommand's `--help` print help instead of running. Use only "agent" and "machine" in anything users read.
- **Effort:** S.

## Already minimal

These are close to the fewest steps possible and should stay as they are:
- Starting work: you run `cloudy-cloud`, ask, and an agent starts with no approval prompts.
- `mcp add`, `mcp ls` and `mcp rm`.
- Switching the main agent with `cloudy-cloud codex` and the other agent names.
- `shell`, `open` and `display`, each on its own.
- `coordinator start`, `status` and `stop`.

## Unverified

- In the dashboard demo, the list view's detail pane stayed blank after a row was selected, with empty console errors. This was seen only in a headless browser, so it may be a test artifact. Check it before filing.
- `mcp add` says "every subagent gets it" even when its secret is not stored yet. This comes from reading the code.
