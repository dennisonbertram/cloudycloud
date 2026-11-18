# J3 - Coordinator lifecycle

Verdict: convoluted. Making the image takes 8 manual steps across 3 commands when one command could do it, and the owner lost a sign-in to a hidden 2-hour limit. Starting, reaching, status and stop are close to minimal.

Evidence labels: "measured" = read in code or ran; "owner" = the owner's transcript; "suspected" = not verified.

## Friction Scorecard

### Steps, actual vs ideal

Making the image (once):

| # | Actual step | Who acts |
|---|---|---|
| 1 | `cloudy-cloud coordinator image` (creates machine, installs tools; waits minutes) | user |
| 2 | Copy `npx --yes instabox@latest ssh sbx-...` and run it | user |
| 3 | Run `claude auth login` in the shell | user |
| 4 | Browser sign-in, paste code | user (the only step that needs a person) |
| 5 | Notice "Login successful." and type `exit` | user (owner: "now I'm stuck here") |
| 6 | `cloudy-cloud coordinator image --save` | user |

Ideal: run `coordinator image`, do the browser sign-in, done. That is 2 user actions against 6. Starting: `coordinator start NAME --repo URL` is 1 command and is at its ideal (src/coordinator.mjs:131-222). Reaching it: Remote Control, or `coordinator attach NAME`, which only prints an ssh command that the user must copy and run again (coordinator.mjs:224-229). `cloudy-cloud shell` could run it directly.

### Decisions
- The user must decide to type `exit` after the login. Nothing says when sign-in has finished (owner transcript). Everyone makes the same choice, so it should not be a decision.
- Name of the coordinator: needed, fine.
- Whether to use `image --save` or re-run `image`: forced on the user after any failure (see dead ends).

### Re-entry (making the user type what the tool knows)
- The user types the machine name `sbx-fx0tlwph` into an ssh command. The tool just created it (coordinator.mjs:99-105).
- `coordinator attach NAME` prints a command instead of running it (coordinator.mjs:228). The user copies and pastes it. `cloudy-cloud shell` already opens a shell by name (shell.mjs:46-50), so the tool can do this without a paste.
- Heuristic 3 (don't ask for what you know): fails twice.

### Needless confirmations
None found. No prompts in this journey; the cost is manual steps, not dialogs.

### Dead ends
1. After "Login successful." the user sits in the box's shell with no instruction (owner transcript). Measured: the hint text at coordinator.mjs:106 only says "leave the shell" before the shell opens, never after.
2. The image machine is deleted after IMAGE_SECONDS = 2 h (coordinator.mjs:29, :99). Owner lost the sign-in this way: "Connection to ssh.instabox.sh closed by remote host" during "Paste code here if prompted >". Neither the `image` output nor the hint mentions the limit (coordinator.mjs:104-109; README 247-254; cli-help.mjs:3). RUNBOOK 8.1 line 278-280 does not mention it either (measured by grep for "2 h"/"hour": only the 24 h coordinator limit appears).
3. `image --save` with no machine says "No image machine found. Run: cloudy-cloud coordinator image" (coordinator.mjs:113). It does not say the machine expired or may have been deleted, so the user cannot tell whether they made a mistake. They must repeat steps 1-6.
4. `image` when a machine already exists fails with "Finish it with: image --save" (coordinator.mjs:97). If the user abandoned that machine, they have no way to discard it except guessing at `instabox` commands or `coordinator stop` (which looks only for role `coordinator`, not `coordinator-image`; suspected from `find(c.provider,'coordinator', name)` usage, not run).
5. Expired login later: `start` fails with a 4-step recovery (coordinator.mjs:193, :203-204). Correct but long; it repeats the whole 6-step image flow.

### Hesitations
- The raw `npx --yes instabox@latest ssh ...` is a different tool's command with its own "instabox X is outdated" banner on every call (owner). The user is inside cloudy-cloud and is asked to leave it (owner asked: "Can this be a cloudy cloud command instead...?").
- The reason line "A setup-token cannot open Remote Control sessions" explains an internal limitation, not a user decision. It is useful once, but it is shown on every run.

## Take-away Pass

Output after `coordinator image` (coordinator.mjs:104-107), per element:

| Element | Keep? | Reason |
|---|---|---|
| "Image machine sbx-... is ready  cloudy-cloud is installed on it" | Shorten | Machine name and "installed" are internals. Say "Ready. Sign in to Claude." |
| Block "Now sign in to Claude on it" with steps 1-3 | Remove | All three steps become automatic or one action (see Simpler Version). |
| `npx --yes instabox@latest ssh <machine>` | Remove | Replace by the tool opening the shell itself. Fallback only if a TTY is missing. |
| "In that shell run: claude auth login" | Remove | The tool runs it. |
| "Finish the browser sign-in, then leave the shell" | Remove | The tool detects success and leaves. |
| Hint: setup-token cannot open Remote Control | Move to `--help` or RUNBOOK | Not needed to succeed. |
| Hint: "Then run: ... image --save" | Remove | The tool saves automatically. |
| After `--save`: "Saved snapshot snap-... the image machine is deleted" | Keep, shorten | User needs to know it finished. The snapshot id is not needed by them. |
| After `--save`: "Saved as CLOUDY_CLOUD_COORDINATOR_SNAPSHOT in <path>" | Move to `--verbose` | Internal storage detail. |
| After `--save`: Start hint with `--repo https://github.com/OWNER/REPO` | Keep | The correct next action. |
| `coordinator start` output: Remote Control line, Terminal line, delete time, stop hint | Keep | Each is used. Fine. |
| `start` hint "The first time, attach once and accept any trust or Remote Control prompts" | Keep until the prompt is removed | RUNBOOK 8.2 says the first Remote Control prompt may still appear. Better: the tool should accept it (see Simpler Version, step 6). |
| `coordinator attach NAME` prints text | Replace | Open the session instead. |
| `coordinator ls` / `status` | Keep | Clear, one screen read, stable. |
| `coordinator stop` hints: workers go with cleanup; check with list command | Shorten | Two hints; keep one. |

## The Simpler Version

Design goal from the owner: "This should be invisible." The only thing the user should do is the browser sign-in.

### Numbered ideal steps

1. User runs `cloudy-cloud coordinator image`.
2. Tool prints "Preparing a machine (about 3 minutes)..." and then, with the machine ready, "Sign in to Claude: open this link" and runs `claude auth login` in the user's own terminal over a TTY. The user opens the link, signs in, and pastes the code if asked. This is the only human step.
3. The tool sees sign-in succeed, ends the shell itself, takes the snapshot, saves the id, and deletes the machine.
4. Tool prints: "Done. Start a coordinator: cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO".
5. `coordinator start NAME --repo ...` (unchanged).
6. Reach it: Remote Control, or `cloudy-cloud coordinator attach NAME`, which opens the session directly.
7. `coordinator ls|status NAME`, `coordinator stop NAME` (unchanged).

If sign-in is needed again, the same `coordinator image` command is the whole fix (step 1-4); `start` errors should say that one command, not 4 steps.

### Concrete changes

1. **Run the sign-in from `coordinator image` itself.**
   - Use `provider.shellArgv(machine, ['claude','auth','login'])` and spawn it with `stdio: 'inherit'`, as `cloudy-cloud shell` already does (shell.mjs:53-56).
   - Measured limit: on Instabox, `shellArgv` with a command always adds `-T`, which means no TTY (providers/instabox.mjs:400). Self-hosted does the same (providers/self-hosted.mjs:262-268 comment: "A command gets no TTY"). `claude auth login` needs a TTY for the paste prompt (owner transcript shows "Paste code here if prompted >"), so this exact call will not work as it stands.
   - Smallest provider change: let `shellArgv` take an option `{ tty: true }`. Instabox: `[...INSTABOX_CLI, 'ssh', id, '--', '-t', cmd]`; self-hosted: `-t` and `exec -it`. Whether `instabox ssh -- -t ...` really allocates a TTY is suspected (the existing code passes `-T` the same way, which suggests extra args go to ssh, but I did not run it; no real machines per the brief).
   - Fallback that needs no provider change: open the plain interactive shell (`shellArgv(id)` with no command, already TTY) and print one line before it: "Run: claude auth login. When it says Login successful, type exit." That removes step 2 and the paste of the npx command but not the "stuck here" problem.

2. **Detect success and leave without the user.**
   - `claude auth status` exists (verified from `claude auth --help` on this machine: commands login, logout, status; status has `--json` and `--text`).
   - Do not rely on the login process exit code alone: if the command is run as a direct ssh command, the ssh session ends when `claude auth login` exits, which is what the user wants. Exit code 0 on success is suspected; confirm.
   - After the shell returns, verify with `sbx.commands.run('claude auth status --json')` through the existing `provider.connect(...).commands.run` used at coordinator.mjs:114 and :248. Whether `status` exits non-zero when logged out is suspected, not verified; parse the JSON for a logged-in field instead and treat a missing field as "not signed in".
   - If verified, snapshot straight away (existing code at coordinator.mjs:115-127 becomes a function called from `image` after success). Keep `image --save` as a retry for a failed snapshot only.

3. **Remove the 2-hour trap.**
   - Create the machine only right before the sign-in, not before a multi-minute install, or start the 2 h clock after the install: the install happens in `image` (coordinator.mjs:101) and the user comes later.
   - Say the limit once at the start of the sign-in: "This machine is deleted in 2 hours." Better: raise IMAGE_SECONDS if the provider allows it, since the automatic flow deletes the machine in minutes anyway. Whether Instabox allows a longer ttl is not verified; coordinator `--max-hours` max is 24 (coordinator.mjs:150-152), so a longer value is likely allowed (suspected).
   - Handle a dropped connection: if the shell exits and `claude auth status` says not signed in, ask "Sign-in did not finish. Try again? Y/n" and re-run the login in the same machine, instead of printing "run --save".

4. **Recovery when `--save` or the machine is gone.**
   - `image --save` with no machine should say: "The image machine is gone (machines are deleted after 2 hours). Run: cloudy-cloud coordinator image" (change at coordinator.mjs:113). Even better, make plain `image` the single recovery and drop `--save` from the normal path.
   - `image` with an existing image machine: offer to reuse it (if running and the user is not signed in, resume the sign-in) or delete it, instead of failing (coordinator.mjs:97).

5. **Check sign-in before `start` takes 5 s and then fails.**
   - Optional: `start` could run `claude auth status` on the new machine first and say "Saved sign-in expired. Run: cloudy-cloud coordinator image" in one line, replacing the 4-step messages (coordinator.mjs:193, :203-204). Suspected feasible with the existing `sbx.commands.run`.

6. **Coordinator start does the sign-in on first use (alternative).**
   - If no snapshot is saved, `coordinator start NAME --repo ...` could run the whole image flow first ("No saved sign-in. Setting that up first"), then continue to start. This removes the need to know that `image` exists at all (heuristic 6: first value). It makes the first `start` slow (several minutes) and requires an interactive terminal; in a non-TTY (the owner's local agent, `--json`) it should fail with the `image` command as today. Recommended after change 1 lands.

7. **`attach` opens the session.**
   - `coordinator attach NAME` should run `provider.shellArgv(machine, ['tmux','attach','-t','claude'])` with a TTY (same `{tty:true}` option as change 1) rather than print the text. Keep printing the command when stdin is not a TTY, like shell.mjs:51-52.

### What makes this feasible or not (summary)
- Feasible: `cloudy-cloud shell` already spawns the provider's shell with inherited stdio (shell.mjs:50-56), and `connect(...).commands.run` already runs remote commands (coordinator.mjs:114, :248).
- Blocker to fix: `shellArgv` with a command uses `-T`/`-i` (no TTY) on both providers (instabox.mjs:400; self-hosted.mjs:262-268). It needs a TTY option, or `image` must open the plain shell and run the command by typing, which is not reliable.
- Unverified: that `instabox ssh -- -t cmd` allocates a TTY; that `claude auth login` exits 0 on success and non-zero on a failed paste; the JSON field names of `claude auth status`. Check these on one real image machine before building (Claude Code docs were not available through `npx ctx7` in this pass; I used the local `claude auth --help`).
- Security: the browser sign-in code is typed by the user into their own terminal and never read by cloudy-cloud; spawn with `stdio: 'inherit'` and do not log the stream.

## Clarity Issues

1. "Leave the shell" (coordinator.mjs:106) is ambiguous and the owner did not know to type `exit` ("now I'm stuck here"). Measured from the owner's transcript. Fixed by removing the manual shell.
2. Step order across two commands: the sentence "Then run: cloudy-cloud coordinator image --save" is a hint (grey) at the bottom of the block, below a different instruction, so it reads as optional. The plain-text version (coordinator.mjs:108-109) numbers it as step 4. The two outputs differ in how important they make the same step.
3. The 2-hour limit and what happens at it are not stated anywhere the user reads (see Dead ends 2).
4. The "image machine" is a name for an internal step. The user thinks "sign in to Claude". Name the command's outcome ("save a Claude sign-in for coordinators", as cli-help.mjs:37 already does) and avoid "image machine" in output.
5. `coordinator image` vs `coordinator image --save` are one task split in two commands; help says "Run 'image' and 'image --save' once first" (cli-help.mjs:16) without saying why two or in what order.
6. The failed-start messages (coordinator.mjs:193, :203-204) name three commands in one sentence, with `claude auth login` described as something to run on "it", where "it" is the image machine, not the coordinator that just failed. Rewrite as: "Your saved Claude sign-in expired. Run: cloudy-cloud coordinator image".
7. The ssh hint comes from `provider.text.ssh` (`npx --yes instabox@latest ssh ...`, providers/instabox.mjs:83), which triggers the Instabox "outdated" banner (owner) and mixes tools. Everywhere cloudy-cloud has its own command (`shell`, and after change 7, `attach`), use it. The raw ssh text should remain only as a fallback.
8. `coordinator stop` hint is 2 sentences plus a list command, where the truth the user needs is "workers are deleted too".
