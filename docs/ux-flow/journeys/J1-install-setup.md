# J1: Install and first-time setup

Persona: a daily Claude Code user, new to Cloudy Cloud, with (or about to make) an Instabox account.
Scope read: README.md Quick start, `install.sh` (main at line 1160), `bin/cloudy-cloud` (setup route line 73, not-set-up gate lines 123-136), `skills/cloudy-cloud-setup/SKILL.md`, `src/coordinator.mjs`. "Measured" means I ran it (only `setup --check-only` with an empty config; no machine, key or account was used). Everything else is read from code and marked "read".

Verdict: **convoluted** for the default path (one correct happy path, but about 12 prompts, 5 browser hops and 3 separate credentials with no "done" moment until the very end). Each individual screen is clearly written; the cost is the number and order of the things asked.

## Friction Scorecard

Ideal path: `npx -y cloudycloud setup`, sign in to Instabox once, paste nothing, answer at most two questions, see "Ready. Run: cloudy-cloud". Compare:

| Measure | Actual (Claude Code user, Instabox, all defaults) | Ideal |
| --- | --- | --- |
| Commands typed | 1 (`npx -y cloudycloud setup`), plus a second one (`cloudy-cloud`) to start | 1 + start |
| Interactive prompts | about 12: global-install y/N (install.sh:1196 via 553), provider 1/2 (1104), agents (1120), Instabox key paste (785), alerts y/N (1018), Claude token Enter (834), GitHub token paste (1044), Particle.ai key (1074), OpenRouter key (1074), coordinators y/N (922), plus "Replace it?" y/N on a re-run for each saved key (829, 1070, 779) | 3 to 5 |
| Browser hops | Instabox dashboard (create key), Claude sign-in (`claude setup-token`), GitHub fine-grained token page, Instabox `login` (GitHub token step, and again for alerts), then on coordinators a second Claude sign-in over SSH | 1 to 2 |
| Credentials the user ends up holding | Instabox API key, an Instabox CLI login (separate), Claude token, GitHub token | 2 (Instabox, GitHub) |
| Dead ends | Coordinator image step (below); self-hosted answer 2 is a different journey that surfaces in prompt 2 | none |

Specific friction points:

1. **Provider and agents are asked before the tool has done anything useful** (read, install.sh:1104, 1120). 90% of users pick "1 Instabox" and "claude"; both questions have a default but still stop the flow. The self-hosted choice is already available as `--provider self-hosted` (cli-help line "setup [--check-only]"), so the prompt could be dropped and shown only as a one-line hint. The agents question is detected from PATH and Enter accepts it, so for most users it is a no-op question.
2. **Two Instabox credentials.** Setup asks you to paste an API key (install.sh:785) and, later, runs `npx instabox login` for the GitHub token and alerts (1052, 1022). The user signs in to the same account twice, in two different ways. Suspected: the CLI login could mint or reveal the API key; I did not check whether Instabox allows that.
3. **Instabox API key paste with a hidden prompt** (785-786). The user must leave the terminal, create a key in the dashboard, copy it, return and paste blind ("nothing shows as you paste"). This is unavoidable unless the Instabox login can supply it (see 2). It is the single biggest hesitation point.
4. **Usage alerts prompt sits in the middle of setup** (setup_alerts, 1006-1027). It is not required for a working install, changes the user's Instabox account ("Saying yes changes your Instabox account through your instabox login"), and its default is no. It is in the critical path before the Claude token. It costs a network read (spinner) on every run and a y/N each time alerts are off. This belongs after "ready", or in `cloudy-cloud setup alerts`.
5. **Optional provider keys are asked as if required** (setup_provider, 1065-1081; main lines 1221-1222). Particle.ai and OpenRouter are asked of every user, with "Enter to skip". A new Claude Code user does not know what Particle.ai is. Two prompts, two links, zero value for the default journey.
6. **GitHub token step is the heaviest and is buried as step 4 of "GitHub token, optional keys and coordinators"** (main line 1218). It has a 9-line instruction (1044-1049) with four permissions. The README adds the same text again. If the user has `gh auth status` (SKILL.md step 1 already checks this) the tool could offer to reuse it, but a fine-grained, repo-limited token is a security choice; I would not auto-reuse, only offer it as one option ("Use my `gh` login" vs "Make a limited token").
7. **Coordinators offered inside first-time setup** (setup_coordinators, 900-946). Default is no (`yn`, line 273). It is a 3-8 minute build, then an interactive SSH Claude sign-in, then a save. First-time users do not yet know what a coordinator is. The step is documented as optional in `check_setup` (line 450 "optional") but not in the prompt. Evidence from the owner's live run: `claude auth login` over SSH was cut off with "Connection to ssh.instabox.sh closed by remote host" because the image machine reached its 2-hour lifetime (IMAGE_SECONDS = 2 * 3600, src/coordinator.mjs:29). Then `coordinator image --save` said "No image machine found. Run: cloudy-cloud coordinator image" (src/coordinator.mjs:113), so the whole step restarts. The setup prompt "This can take a few minutes." (line 927) does not mention the 2-hour limit, and the failure message from install.sh:937 says only "The sign-in on the image machine did not finish." with no reason.
8. **Install of the `cloudy-cloud` command is a y/N that defaults to no** (install.sh:553 via `yn`, line 273). Someone who runs `npx -y cloudycloud setup` is already installing; a "no" leaves them with a README that says `cloudy-cloud` everywhere. Default should be yes (`yn_yes` exists, line 290). Note the later launcher prompt uses `[Y/n]` ("Run setup now?", bin/cloudy-cloud:128) so the two tools use opposite defaults for similar questions.
9. **Stale global command is not detected** (owner evidence: global `cloudy-cloud` was a link to an old release worktree after 0.2.0 shipped). install_global (516-533) handles an old link only when the user already runs setup from npx; `cloudy-cloud` itself never says it is out of date. The Instabox CLI does ("instabox X is outdated: run instabox update") on every call, so the user sees an upgrade nag for the dependency but not for the product.
10. **Re-run is not idempotent in feel.** Each saved key asks "Replace it?" (779, 829, 1070) and the coordinator step asks "Sign in again to use a different account?" (922). A re-run to fix one thing walks through all of them. Skipping what is already healthy would be quieter.
11. **Confirmation that guards nothing.** "Left as they are" after the alerts y/N, "Skipped Particle.ai", "Kept the saved key". Each prints a line for a non-action.

## Take-away Pass

Screen by screen, what could be removed, collapsed or deferred.

1. **Banner and animation (install.sh:195-224).** A 14-frame animated logo and a description line "Checks your tools, links the command and saves your keys." The description restates the first step. Skip animation for returning users; remove the description line, or keep one line total. Low value, low cost.
2. **"[1/4] Tools: git, node, npm and curl are installed" (1177-1180).** Passing checks do not need a section; print nothing on success, and name the one failed tool otherwise. Measured: `setup --check-only` already prints step 1 with no ok line when tools pass, so the full run and check disagree.
3. **Step counter "N of 4"** (step(), 41-54). Steps are really: tools, provider, agents, Instabox, alerts, Claude, GitHub, 2 optional keys, coordinators. "4" hides that step 4 is four or five separate prompts (GitHub, OpenAI, Particle, OpenRouter, coordinators). The counter promises less than is asked.
4. **Provider question (1104).** Remove; default Instabox; keep `--provider`.
5. **Agents question (1120).** Remove for the common case: use what is on PATH, ask only if it finds none or more than one. Setup then states the result ("Agents: claude"), not asks it.
6. **Alerts (1006-1027).** Defer to after Summary, one line: "Optional: turn on Instabox usage alert emails: cloudy-cloud setup alerts".
7. **Particle.ai and OpenRouter prompts (1221-1222).** Defer. A line in Summary: "Open-model workers (glm, deepseek) need a key: cloudy-cloud setup keys".
8. **Coordinators (offer_coordinators, 949).** Defer out of first setup; mention in Summary under "Optional". This is also where the 2-hour image-machine trap lives, so removing it from the default path removes the owner's reported failure from first-time users.
9. **Summary box, then three hints, then a warning, then a "Next" box (1226-1259).** Information appears three times:
   - "To update, run..." (1240-1244) and "To change a key later, run: cloudy-cloud setup" (1246) and "Restart any open cloudy-cloud session" (1247): maintenance advice, not needed at the moment of success.
   - "Recommended: block direct pushes to your main branch" (1248-1249): this is a warning (yellow) placed above the real "Next" box, so the last thing the user sees before the box is a warning, and the command `cloudy-cloud protect` is in a dim hint line.
   - The "Next" box then says run `cloudy-cloud` and paste a prompt. This is the right ending but is in a box after 4 to 5 lines of noise. Move it to be the last visible line and drop the three maintenance hints (they are in the README and `--help`).
10. **"Ready" is never stated.** The Summary box lists rows with check marks and the word "ready" appears only per row (e.g. "Coordinators ready"). There is no line like "Setup complete" and no check that proves workers work. `setup --check-only` prints "Check passed: nothing needs fixing" (install.sh:476) but only when run separately. The full run does not end with that line. Measured text of the failing case: "Check failed: fix the items above  run cloudy-cloud setup".
11. **`--check-only` on a fresh machine** (measured). With nothing saved it prints "Could not confirm GH_TOKEN  check with: npx --yes instabox@latest secrets ls" even though no Instabox key exists, so GH_TOKEN cannot be confirmed for an obvious reason. That is a second, misleading line under an already-failed Instabox check. Suppress it when the Instabox key is missing.
12. **Not-set-up gate in the launcher** (bin/cloudy-cloud:123-136). Good: it says "cloudy-cloud is not set up yet", offers "Run setup now? [Y/n]". Redundant output: the warn line and a hint ("Run: cloudy-cloud setup") say the same thing, then the prompt asks the same thing a third time. One of the three can go.
13. **README Quick start is longer than the install.** The `EEXIST` paragraph, the by-hand route ("has not been tested end to end"), the "Other main sessions" paragraph, the keys table and the setup screenshot all sit before "Start a session". A new reader must read about 90 lines to learn the command is one line. Lead with the command and "then run `cloudy-cloud` in a repo"; move the table to a "Keys" section.
14. **Setup skill duplicates the README.** SKILL.md step 2 repeats the full list of prompts and says "Wait until they say it finished", then step 3 verifies with `--check-only`. Fine as a skill, but it adds a second way (the skill) to do the same one command, and `!` prefix usage is a Claude Code detail. Keep, but trim step 2's prompt list: the user will see the prompts.

## The Simpler Version

Numbered ideal path (Claude Code user, Instabox, all defaults):

1. `npx -y cloudycloud setup`. The tool installs the `cloudy-cloud` command with no question (or says it will), copies skills, and prints one line per check only on failure.
2. "Sign in to Instabox" opens a browser once. If Instabox allows it, setup obtains the API key itself, so nothing is pasted. If not, show the dashboard link and ask for the key (today's behavior).
3. "Claude token for subagents: press Enter to sign in" (browser; same as today's step 3, already well designed).
4. "GitHub token" (paste, with the four permissions). Offer "use my `gh` login" as a faster option.
5. Final screen: `[ok] Ready.` plus the Summary rows, then the Next box as the last thing on screen. Below it, one dim line: "Optional later: cloudy-cloud setup --more (alerts, coordinators, open-model keys)".

Three questions asked in the default path: Instabox sign-in, Claude sign-in, GitHub token. Today it is about twelve.

Concrete changes, ordered by value per effort:

1. **Move optional steps behind a flag or a post-ready line.** Alerts (1006), Particle.ai and OpenRouter (1221-1222), coordinators (949). Biggest cut: 5 prompts and 2 browser hops from the default path. Small code change (guard the four calls in `main`).
2. **Stop asking provider and agents when the default is certain.** Use `--provider` and PATH detection; ask only on ambiguity. Removes 2 prompts.
3. **Flip the global install default to yes** (use `yn_yes`, 553) and say what it does in one line.
4. **End on one clear "Ready".** Print "Setup complete" when all required rows are OK, then the Next box last. Move "To update", "To change a key later", "Restart any open session" and the protect recommendation to after the box or to the README. Put the `cloudy-cloud protect` suggestion into the first `cloudy-cloud` run's start banner for a repo with a github origin instead.
5. **Coordinator image step: tell the truth about its limits.** If kept in setup: print "The image machine is deleted after 2 hours; finish the sign-in before then" (src/coordinator.mjs:29), and when `coordinator image --save` finds no machine, say why ("the image machine was deleted at its 2-hour limit; run `cloudy-cloud coordinator image` to start over") instead of the bare "No image machine found" (113). Also let the image step resume from a still-live machine instead of rebuilding.
6. **Warn when the installed command is old.** `cloudy-cloud` could check the npm version once a day and print one line "0.2.1 is available: npm install -g cloudycloud@latest". The Instabox CLI already trains users to expect this nag. For link-installs (owner evidence) print where the command is running from in `--version`.
7. **Trim the README Quick start** to the command, the 3 sign-ins, and "run `cloudy-cloud` in a repo". Move the keys table and the EEXIST paragraph below.
8. **Make `--check-only` honest and keep it for scripts.** Suppress the GH_TOKEN line when no Instabox key exists. Have the full run end by calling the same check silently and print its pass/fail line.
9. **Unify default direction of y/N questions**: today `yn` defaults no for install and coordinators, but the launcher's "Run setup now?" defaults yes. Use "default = recommended action" consistently and show it capitalized.

Do not remove: the key check before saving (install.sh:795-803, it prevents the worst dead end), the hidden-paste handling (`clean_paste`, `read_secret`), the 3-try limit, the explicit rerun command in every stop message, or the "nothing is saved" wording. Those are doing their job.

## Clarity Issues

1. **"Provider"** (step 2 title, `--provider`) versus "Where should subagents run?" (the prompt that sets it, 1104) versus "Instabox key" (the step title when it is the answer). Three names for one choice. Use "Where subagents run" everywhere.
2. **"Instabox" is never explained.** README says "the cloud provider supported today". The first prompt that mentions it ("Instabox cloud (default)") assumes the reader knows. Add a half-line: "Instabox: the cloud service that runs your subagents (instabox.sh)".
3. **"Worker", "subagent", "agent", "cloud machine", "box", "coordinator", "host", "main session" all appear in setup and README.** The README says "worker" for the agent on the machine and "subagent" for the task; setup says "Worker keys" (install.sh:1217), "subagents use the account you sign in with" (834), "Codex workers" (1220) and "subagent machines" (1044). Pick "subagent" for the user-facing word and use "worker" only in the README table.
4. **"Claude token for subagents"** (834) versus "Claude token" (summary) versus "setup-token" (README) versus `claude setup-token`. A user who has run `claude auth login` may think they are already done ("Your own claude login is not changed" helps, but it appears in a dim hint). Plain label: "Claude sign-in for subagents".
5. **"Proxy secret"** (README, check output "stored as an Instabox proxy secret"). The user never needs the term to finish setup; it appears in error text (`check_setup`, "Instabox refuses to copy a real key to a machine"). Say "stored in Instabox; subagents never see the key".
6. **"Coordinator", "coordinator image", "image machine"** (setup_coordinators). Three nouns for one build step, none defined in setup. The prompt "Set up cloud coordinators (they keep working when your laptop is closed)?" is the only explanation. Good sentence; keep it and drop the other two nouns from the status lines or define them in a single clause.
7. **"Replace it?" y/N** (779, 829, 1070) does not say what "it" is on the same line if the previous lines scrolled. Say "Replace the saved GitHub token?" Same for the alerts prompt.
8. **`[y/N]` versus `[Y/n]`** use opposite defaults across setup and the launcher (see Friction Scorecard, point 8).
9. **"Setup" is both a command and the name of a skill and of a `claude setup-token` subcommand.** `cloudy-cloud setup`, skill `cloudy-cloud-setup`, `claude setup-token`. A user told "run setup" can run the wrong one. Qualify in prose: "run `cloudy-cloud setup`".
10. **Package versus command names.** npm package `cloudycloud`, command `cloudy-cloud`, old package `cloudy-cloud`, old command `claude-cloud` (install.sh:572-578). The README explains the EEXIST case, but a user typing `npx cloudy-cloud setup` (the product's displayed name) gets the old package. Suspected, not measured: the old package is still published under `cloudy-cloud`; worth a deprecation message there pointing to `cloudycloud`.
11. **Error wording is good but long.** install_global_done prints three lines for a failure (the error line, "To fix it yourself, run", "If that fails, check what is at") plus a warn "Continuing without it". Merge into one.
12. **Success language is per row, not overall** (see Take-away 10). The user cannot tell "I am done" from "something above may need me".
