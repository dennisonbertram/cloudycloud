# J2: First real use (start, ask, follow, get the branch)

Method: read code and help text only; no machines were created. Evidence is cited as file:line. "Suspected" means I inferred it from code and did not observe it in a live run.

Journey: run `cloudy-cloud` in a repo, ask for work, a `cloud_agent` starts on a cloud machine, the user follows progress, gets the result, finds and merges `cloudy-cloud/<id>`.

Ideal path: run one command, ask, get a reviewable branch with a link. Verdict: acceptable.

## Friction Scorecard

Actual steps from a set-up machine (setup itself is J1):

1. `cd repo && cloudy-cloud` (starts Claude Code with the cloud tools; bin/cloudy-cloud:222).
2. Type the request.
3. Claude calls `cloud_agent`. The permission list pre-allows it, so there is no approval prompt (bin/cloudy-cloud:204 `settings`). Good.
4. User waits. In "task mode" they watch `/tasks`; otherwise Claude calls `cloud_agent_wait` for up to 600 s per call (src/mcp.mjs wait tool, default 600, max 1500).
5. Result arrives in the Claude session, ending with "Pushed to origin cloudy-cloud/<id> at <sha>. Fetch with: git fetch origin cloudy-cloud/<id>." (src/run-subagent.mjs:229).
6. User copies `git fetch origin cloudy-cloud/<id>` and runs it.
7. User inspects (`git diff`, `git log origin/cloudy-cloud/<id>`), then merges, or opens a PR by hand (README.md:85).
8. Agent stays open until stopped or 60 idle minutes; Claude is told to stop it (system prompt, bin/cloudy-cloud:204).

Ideal: 1 command, 1 request, 1 link to a reviewable branch or PR, nothing else. Actual is 8 steps, of which 1, 2, 5 are inherent and 6 to 7 are extra work the tool could do.

| Heuristic | Finding |
| --- | --- |
| Step economy | Steps 6 and 7 are manual: the user must turn a branch name into a fetch command, then into a review. The tool knows the GitHub repo (`a.origin`, src/run-subagent.mjs:895) and the branch, so it could print a compare URL. It prints none (measured: the only branch text is line 229). |
| Decision economy | Defaults carry most choices. `profile`, `model`, `machine`, `size`, `role` are all optional (src/mcp.mjs). One decision the default hides: `autofix` is off, so by default there is no PR. A user who wants "a branch with a link" must know to ask for autofix. That is the one decision that matters for this journey and it sits last in an 8-field schema. |
| Don't ask for what you know | The launcher asks the user to run setup only when a key is missing, and offers to run it (bin/cloudy-cloud:152). Good. No re-entry in this journey. |
| Confirmation budget | No confirmations in the happy path. Costly machine kinds (gpu, macos) need an env-file edit and a retry (errors.mjs `machine_needs_consent`); this is reasonable for money. |
| Dead ends | (a) A successful result ends at a git command, not at a review surface. (b) Push failure says "ask the agent to push" (line 231), which is a valid next step. (c) Branch exists only on GitHub; nothing local is updated (README.md describes "nothing is copied into the local repo"), so `git branch` shows nothing and the user must remember the id. |
| Re-entry | The user must keep the 8-character id. If the Claude session scrolls or restarts, `cloud_agent_list` only works while the same server is alive (`open` map is per server, src/run-subagent.mjs:78). After a restart, `agent_gone` tells them to `git fetch origin cloudy-cloud/<id>` (errors.mjs:49), but the id is gone from their screen. They would use README line 88: `git fetch origin 'refs/heads/cloudy-cloud/*:...'`, which works but is not mentioned in the result. (suspected for the restart case; the code path is clear.) |
| Hesitation points | See below. |

Hesitation points:

- Right after the request: nothing in the launcher says the machine takes time to start or what the cost is. The user sees whatever Claude says. The system prompt tells Claude to say "watch /tasks and stop an agent there" in task mode (bin/cloudy-cloud:204), so this depends on Claude relaying it. If the client does not support tasks, the user sees Claude silently calling `cloud_agent_wait`, which can block up to 10 minutes per call with no live output (suspected: depends on the Claude client's rendering of a long MCP call).
- Queued starts: the message is "queued, N ahead: <reason>" or "queued for a machine (waiting to retry)" (src/run-subagent.mjs:768-771). It names the cause but not an expected delay, and not whether the user has to do anything. "Waiting to retry" does not say retry what, or when.
- Errors: each tool error prints four lines (What happened / Likely cause / Next step / Tell the user), see src/errors.mjs:105. These are written for the Claude agent, which is right, but the user sees them too in the tool block. See Take-away Pass.

## Take-away Pass

What the user sees, output by output.

1. Start result (non-task mode, src/run-subagent.mjs:~944): `agent_id: <id>`, `status: starting`, optional price lines, then "Call cloud_agent_wait with the agent_ids to get the result." This text is for Claude, not the user. Nothing in it tells the user the branch name, even though the branch is known at this moment (`branch: cloudy-cloud/${id}` is already emitted as an event, line 940). Add: branch name here, so the user learns the branch exists at start, not at the end. Removable: nothing. Missing: the branch.
2. Progress: `tool uses, tokens, elapsed, current step` in `/tasks` and `cloud_agent_list`. `cloud_agent_list` adds per-machine CPU and memory with a sample age, plus a hint about stopping quiet agents (src/mcp.mjs list description; src/run-subagent.mjs:1025). CPU/memory and "usage n/a (timeout|unavailable|none yet)" are noise for a first-time user following one agent. Collapsible: show usage only with `all` or when an agent is quiet (under 3 % CPU for 10 minutes, which is the one case the text says matters). Deferrable: spend line.
3. Result text: `<agent final message>` + blank + `Pushed to origin cloudy-cloud/<id> at <sha>. Fetch with: git fetch origin cloudy-cloud/<id>.` + model line + totals line + MCP footer (src/run-subagent.mjs:345, 254). Three issues:
   - The sha is 7 characters and does not help the user act. Removable.
   - The fetch command is the only next step offered, and it only downloads. The obvious next step is "review it". A link `https://github.com/<owner>/<repo>/compare/<base>...cloudy-cloud/<id>` is what the user wants; `a.origin` and the base branch are already known. (Proposal, not measured.)
   - Totals, model line and MCP footer follow the branch line, so the branch line is not last. The line the user must act on should be the last or the first line of the result, not buried between prose and statistics.
4. Idle follow-up: after the first turn the agent stays open and billing continues until stop or 60 minutes. The result does not say so. The system prompt tells Claude to stop agents when done (bin/cloudy-cloud:204), so this depends on Claude following it (suspected risk: a Claude that forgets leaves a machine running up to 60 minutes; cost is small at 4x8 $0.034/h per src/mcp.mjs size text, but it is also the limit-bearing resource on the free plan, see `quota_exceeded`).
5. Error blocks (src/errors.mjs): 4 labelled lines. "Likely cause" is useful for Claude, mostly redundant for the user when "Tell the user" exists. For human-only fixes (`HUMAN_CODES`), the "Tell the user" line is the only one the human needs; the other three are agent text shown in the user's terminal. Collapsible: none is easily removed, since the design serves the agent first (project memory: "Errors guide the agent"). Keep, but make sure Claude is told to relay only the "Tell the user" line rather than paste the block. Not verified that Claude does this.
6. Repeated information: the branch name appears in the start event, the result, `agent_gone`, `push_failed`, autofix messages, the dashboard, and the README. Each is fine in context, but the one place the user reads it first (the start result) lacks it.
7. Autofix result (when on): gives PR URL and whether it is clean (README.md:258). This is exactly the ideal ending, and it is off by default and not mentioned in the launcher or start text.

## The Simpler Version

Ideal steps:

1. Run `cloudy-cloud`.
2. Say what you want done.
3. Claude says: "Started agent a1b2c3d4 on branch cloudy-cloud/a1b2c3d4. Watch it in /tasks."
4. Result arrives: summary of changes, then one line: "Review: https://github.com/owner/repo/compare/main...cloudy-cloud/a1b2c3d4 (or: git fetch origin cloudy-cloud/a1b2c3d4 && git diff main...FETCH_HEAD)".
5. Merge from GitHub, or ask Claude "merge it" / "open a PR".

That is 2 user actions plus review. Today it is the same plus a manual fetch, an id the user must remember, and no link.

Concrete changes, ordered by value:

1. Print the compare URL in the result (and in the start result). Build it from `a.origin` and the base branch (the HEAD branch name at start). One line, replaces the sha. Evidence: line 229 builds the sentence; origin and id are in scope at src/run-subagent.mjs:895.
2. Put the branch in the start result, so the user learns it exists immediately: "Branch: cloudy-cloud/<id> (pushed after each step)". Today they learn it only at the end.
3. Give the user a one-line PR path without autofix: the result's last line offers "Say 'open a PR' and I will" and the system prompt tells Claude it may run `gh pr create --head cloudy-cloud/<id>` locally (the user's gh, not the worker). Decide whether autofix should instead be the default for single workers (it costs CI rounds and time, so probably not; offer, do not force). Also mention autofix in the launcher's system prompt as the way to get a PR.
4. Move totals/model/MCP footer above the branch line, or into one dim line, so the actionable line is last.
5. Hide per-machine CPU/mem from `cloud_agent_list` unless quiet or requested.
6. In the system prompt, tell Claude to quote the "Tell the user" line only, not the whole error block, and to name the branch when it reports the result.
7. Queue note: replace "(waiting to retry)" with what is retried and the next attempt time, or drop the word.
8. After the result, state once that the agent stays open for follow-ups for 60 minutes and that `cloud_agent_stop` ends it, so a user who is done knows to ask for a stop. Claude is already told to; the tool text is the backup.

What is not worth changing: the zero-approval tool list, the 4-field required schema (only `prompt` and `description` required), the pacing and queue, the error guidance structure. These are already minimal for this journey.

## Clarity Issues

- "Sandbox", "machine", "box", "agent", "worker", "subagent": the same thing under several names. Tool text says "sandbox" (src/mcp.mjs cloud_agent description), `cloud_agent_list` says "machine", the CLI help says "boxes" (bin/cloudy-cloud:89: "your cloud machines" next to "boxes" at line 11), the user-facing noun is "subagent". Pick "agent" for the thing that works and "machine" for where; stop saying sandbox and box. (measured by grep of the strings cited.)
- "idle" is explained in the list description as not meaning the machine is idle ("Status idle means the turn finished and the agent waits for a message; it does not mean the machine does nothing"). If a word needs that disclaimer, use another: "waiting for you" or "done, open".
- "turn", "task", "MCP task", "task mode": the system prompt tells Claude about two modes, "task mode" and the other, and tells it to say "watch /tasks". A user who has never heard of MCP tasks sees `/tasks` mentioned with no explanation of what it shows. Suspected confusion: the user may also confuse Claude Code's own Task tool (disabled here, `deny: Agent`) with `/tasks`.
- `cloudy-cloud/<id>`: the 8-character random id is the only handle. A name like `cloudy-cloud/<id>-add-login-tests` (from `description`) would be recognisable in `git branch -r` and PR lists. Id-only names fail "recognition over recall". Minor; the id also prevents clashes.
- "Fetch with" does not say what fetch does. A first-time user may expect it to merge. The text could read "Download it: ... then compare with git diff main...origin/cloudy-cloud/<id>".
- Error wording: "Tell the user:" appears in text the user reads as well as Claude. It reads oddly when the user is the one being told in the third person. If Claude relays it properly the user never sees the label; if not, they do. Suspected only.
- Machine/size price text sits in the tool description in dollars per hour (src/mcp.mjs size field), which is good for Claude; the user sees price only for gpu/macos (`machine_needs_consent`) and not for the default linux, so first-time cost is never stated before the first run. Not necessarily wrong (setup may cover it); flag as a hesitation, not a defect.

## Summary

The core path is short and well defaulted: one command, one request, no approvals, and a working branch at the end. The gap is the last mile: the result ends at a `git fetch` command and a sha instead of a review link, the user learns the branch name only after the work finishes, and a PR requires knowing about the off-by-default `autofix` option.

Verdict: acceptable (about 2 extra steps, fetching and hand-assembling the review; nothing structural).
