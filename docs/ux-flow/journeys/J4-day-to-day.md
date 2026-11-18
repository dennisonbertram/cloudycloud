# J4 Day-to-day: watch, inspect, reach, stop, confirm nothing bills

Verdict: **acceptable, leaning convoluted on the "is anything still billing?" question.** Each single command (`shell`, `open`, `display`, dashboard) is close to minimal. The gaps are between them: there is no terminal list of agents, no one-step cleanup, and no one-glance "nothing is running" answer.

Evidence key: "measured" = I ran or saw it (dashboard demo on 127.0.0.1:4491 with agent-browser, now stopped; `--help` text; code read). "suspected" = inferred from code only.

## Friction Scorecard

| Goal | Ideal steps | Actual steps | Evidence |
| --- | --- | --- | --- |
| See what each agent is doing | 1 (`cloudy-cloud status`) | 2: `cloudy-cloud dashboard`, then read the page. In-session, ask Claude (`cloud_agent_list`) or `/tasks`. No terminal list command exists. | `bin/cloudy-cloud:79-110` help lists no `ls`/`status` for agents; `coordinator ls` exists only for coordinators (measured, README Commands table) |
| Look inside one agent | 1 | 1 command, but the id must come from somewhere first: `shell <agent-id-or-machine>` needs the 8-hex id from `cloud_agent_list` or the dashboard (`src/shell.mjs:11`). Extra step: copy id. With one agent it still needs the id. | `src/open.mjs:55-65` error lists running ids when you guess wrong (good) |
| Reach an app it serves | 1 | 1 plus a prerequisite the user must know: the app must already run in the background on the machine (`nohup ...`). Port is also an argument the user must know. | `src/open.mjs:12-15`, README "Reaching an app" |
| Check spend | 1 | Dashboard header shows Instabox month total (measured: "Instabox this month: $66.03 used, $16.61 included, $49.42 beyond it (pay as you go)"). Per-agent cost shows only for gpu/macos as a static price note (`dashboard.html:414-417`) and per-turn `$costUsd` in the message thread (`:596`). No per-agent running cost, no "all running machines cost $X/hour right now". | measured + code |
| Check metrics | 1 | Dashboard has CPU/mem per row (measured) and an hour of samples in detail (`dashboard.html:438-493`). Longer history is a copied `npx --yes instabox@latest metrics ... --since 6h` command. Fine. | code |
| Stop one agent | 1 | Only inside the Claude session: tell Claude to `cloud_agent_stop`, or `/tasks` then `x` (README Commands). From a second terminal or after the session is gone: `npx instabox@latest rm <name>` (needs the machine name, not the agent id). No `cloudy-cloud stop <id>`. Dashboard is read-only by design (`README Dashboard`, Security). | README:260-305, RUNBOOK:207-208 |
| Clean up leftovers | 1 (`cloudy-cloud cleanup`) | 2 to 3: `npx instabox@latest ls`, find the ones labelled `purpose=cloudy-cloud`, `rm` each by hand. Coordinators are never auto-reaped, so they are the usual leftover (`RUNBOOK:314`). | README:329 (Uninstall section gives the only copy-paste recipe); RUNBOOK:207-208, 314 |
| Know nothing is still billing | 1 (a "0 machines running" line) | No direct answer. The dashboard header counts Running/Starting/Waiting/Failed/Finished, but it only shows agents in the local event log plus machines it can list; a machine created by another session or a coordinator with no local log shows "only status" (README Dashboard). Paused machines still count against plan limits (RUNBOOK:237) and it is not stated whether they bill. | README Dashboard text; measured header |

Decisions the user faces: which id (from where), which port, `--share` vs tunnel, whether the machine is a "machine" or an "agent" (the commands accept both: `<agent-id-or-machine>`).

Re-entry: every `shell`/`open`/`display` call re-resolves the id by listing all machines on the provider (`open.mjs:73-80`). That is not a user cost, but it means each call needs the network and a valid key.

Needless confirmations: none found. `open --share` and `display` print a link and a warning with no prompt. Good.

Dead ends:
- `cloudy-cloud shell` on a stopped agent: error plus `guide('machine_not_running')` (`shell.mjs:46`). Not a dead end.
- `open` on a stopped agent says "start a new agent or coordinator" (`open.mjs:41`), with no pointer to the branch `cloudy-cloud/<id>` where its work still is. The in-session error `agent_gone` does give that (`errors.mjs:49`). Inconsistent.
- Dashboard list view, detail pane: in my headless run the right-hand pane stayed blank after selecting a row (clicking via ref and via DOM, 4 attempts, `#panel` had 0 children, the first row was marked selected). 14 empty console errors appeared. The checked-in screenshots in the README show it working, so this is **suspected a headless or version problem, not proven a bug**. I could not read the error text. Worth one real-browser check.

## Take-away Pass

**Dashboard header** (measured): five counters (Running, Starting, Waiting for you, Failed, Finished today), one spend sentence, `Demo` badge, List/Fleet toggle, "Live".
- Keep: counters, spend sentence (it answers "what is this costing", which is the top day-to-day question).
- Remove or merge: the List/Fleet toggle. Both views group by Needs you / Active / Finished and show the same cards (measured). List adds the detail pane; Fleet adds nothing List does not show except bigger cards. Two views of the same data is the "one way to do one thing" failure. Make Fleet the grid mode of one screen, or drop it.
- "Live" is useful only when it turns red; when fine it is noise.

**List rail rows** (measured): each row has title, time, a mono line (status, id, model, machine tag, "deletes in Nm"), a cpu/mem line, and a last-message line. That is four lines per row, so the rail shows about 7 agents on a 800px screen. The id is on every row, which is right (you need it for `shell`). The cpu/mem line repeats in Fleet cards. The last-message preview is the most useful line and should stay; cpu/mem is trivia unless an agent is idle (the `quiet` tag already covers that case).

**"Needs you" group contents** (measured): in the Fleet view, the running coordinator "Cloud coordinator for the migration fleet" and a failed agent sit under "Needs you" with the two "waiting for you" agents. A running coordinator does not need the user. "3 Needs you" therefore overstates; the header says "2 Waiting for you". Two numbers for one idea.

**"deletes in 29m" / "deletes within an hour"** (measured): the best answer to "will this keep billing?" on the page, shown only for some rows. Good element; promote it.

**`cloudy-cloud shell/open/display` output**:
- `open` prints `Forwarding http://127.0.0.1:P to port R on <machine id>. Press Ctrl-C to stop.` (`open.mjs:85`). The machine id is the provider id, not the agent id the user typed. Take-away candidate.
- `open --share` prints the URL then a one-line warning (`open.mjs:80-81`). Right amount.
- `display` prints only the link on stdout (README). Right for scripts; a human at a terminal gets no hint that it expires in 1 hour or is a secret. The README says so, the command output does not (not checked in code beyond README; suspected).

**README sections**: "Looking inside" and "Reaching an app" are short and correct. "Kinds of machines" (a pricing table) sits between "Dashboard" and "Looking inside", so someone looking for `shell` scrolls past a 5-row table. Move it up under "How it works" or down to its own heading.

## The Simpler Version

Ideal steps for the whole journey:

1. `cloudy-cloud status` prints one line per agent and coordinator: id, state, what it is doing, time to auto-delete, hourly cost, and a last line "N machines running, about $X/hour. Nothing else is running." (or lists the stragglers).
2. `cloudy-cloud shell <id>` (already exists; make the id optional when only one agent runs).
3. `cloudy-cloud open <id> <port>` (already exists).
4. `cloudy-cloud stop <id>` or `cloudy-cloud stop --all` stops agents from any terminal.
5. `cloudy-cloud status` again ends with "0 machines running".

Concrete changes, in order of value:

1. **Add `cloudy-cloud status`** (terminal twin of `cloud_agent_list`) that reads the same provider list the dashboard uses (`listMachines`, already imported by `open.mjs` and `shell.mjs`). End it with the total running machines and an hourly cost estimate. This answers "what is each doing" and "is anything billing" without opening a browser or going through Claude. Today the same question needs the dashboard, whose header counts only what the local log knows.
2. **Add `cloudy-cloud stop <id>|--all`** and use it in the README Uninstall step and the RUNBOOK leftover tables in place of `npx instabox@latest ls`/`rm`. It deletes only machines labelled `purpose=cloudy-cloud` (label already exists, `RUNBOOK:207`). Include coordinators, since the reaper never removes them (`RUNBOOK:314`). The user then never needs the provider's own CLI, which also prints "instabox X is outdated" on every call (owner's transcript).
3. **Show a billing line on the dashboard**: "N machines running now, about $X/hour" next to the monthly sentence, and show "deletes in" on every row, not only some. Today there is a monthly total but no "right now" number.
4. **Make shell/open/display accept no id when one agent is running**, and print the running ids in the "missing id" usage error (the Unknown-id error already does this, `open.mjs:60-61`; the missing-id error prints only USAGE).
5. **Merge List and Fleet** into one view (grid with an optional detail drawer), or remove the toggle.
6. **Put the same next step on every dead end**: `open` on a stopped machine should say what `shell` and the agent_gone error say, including `git fetch origin cloudy-cloud/<id>`.
7. **Move "Kinds of machines"** out from between "Dashboard" and "Looking inside".

Do not change: the dashboard being read-only (a stated security choice), the `--` separator in `shell`, the private-by-default `open`.

## Clarity Issues

- `<agent-id-or-machine>` is in every usage line, but the user has two kinds of names: an 8-hex agent id (`7c1e90ab`) and a provider machine name (`m-7c1e90ab` in the demo). The branch name uses a third form, `cloudy-cloud/<id>`. Say "agent id (the 8 characters shown in the dashboard)" and accept the machine name only in a footnote.
- "Needs you 3" (Fleet/List groups) vs "2 Waiting for you" (header): different counts for similar words (measured). A failed agent and a running coordinator are in the first group but not the second. Name the group "Needs attention" or put only waiting and failed agents in it.
- "Finished today 2" in the header vs two agents with status `stopped` under "Finished" (measured). "Stopped" and "finished" are used for the same state; the README for `cloud_agent_stop` says "deletes their machines". Say "stopped (machine deleted)".
- "deletes within an hour" (row label read by the screen reader) vs "deletes in 29m" (visible): same fact, two precisions. Use one.
- "quiet" tag (measured, on the android agent: "under 3 % CPU ... the whole hour" per `dashboard-demo.mjs:14`) is unexplained on the row. A hover title or "quiet, may be idle" would tell the user why it matters (it still bills).
- Spend sentence: "$66.03 used, $16.61 included, $49.42 beyond it (pay as you go)" (measured). The arithmetic is right but the reader must work it out. Lead with the part that costs extra: "$49.42 over your $16.61 plan this month".
- Idle limit: "Agents stay open until stopped or 60 idle minutes pass" appears in the model prompt (`bin/cloudy-cloud:198`) but not in the README Dashboard, shell, or open sections. A user leaving agents overnight does not know this unless Claude tells them. Add it to the first mention of `cloud_agent_stop` in the README.
- `open` stop text: "The tunnel and link stop when the machine is deleted." Say whether the machine keeps billing while a tunnel is open and the agent is idle (not stated anywhere I read; unverified).
- RUNBOOK:237: "Paused machines count too" does not say whether paused machines bill. A user checking "is anything billing" needs that fact.
- Dashboard detail pane blank in headless Chrome (see Dead ends); if it reproduces, the first thing a user sees after clicking an agent is an empty panel with no state text. The code has an empty-state message (`dashboard.html:666`), so a thrown error is more likely than a missing state.
