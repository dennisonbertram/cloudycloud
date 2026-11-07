# Handing a job to a cloud coordinator

Read this when the user wants a job to run unattended on a cloud coordinator. Part A is for the local Claude that dispatches. Part C is for the coordinator that receives the job. The brief template (`brief-template.md`) already carries the key Part C rules, because the coordinator sees only the brief.

## A. Hand off to a cloud coordinator (local Claude)

**Hand off when:** the job is long or large, the user is going away, and the work needs only what is in the GitHub repo.

**Do not hand off when:** the job needs untracked local files, secrets or services that exist only on the laptop, or the user wants to steer step by step. Use the local fleet patterns in SKILL.md instead.

Steps:

0. **Check the repo** (SKILL.md, "Before using a repo"): a GitHub origin, a protected main branch, and the repo in the token. Report anything missing in the same confirmation question.
1. **Confirm with the user first.** Use the structured question tool if you have one. Ask for: the coordinator name, the repo, the base branch, and agreement that the coordinator is billed until it is stopped. Recommend defaults (name from the topic, repo from `git remote get-url origin`, base `main`).
2. **Prepare the repo.** The coordinator clones from GitHub. Commit and push everything it needs (code, docs, test fixtures). Check `git status` is clean for those files and `git log origin/<base>..HEAD` is empty.
3. **Write the brief** to a file from `brief-template.md`. Break the job down so nobody needs to ask a question: give exact acceptance commands, owned files per work package, and a default for every ambiguity you can foresee. If you cannot write an acceptance command, ask the user for one before you start.
4. **Start it:**
   ```sh
   cloudy-cloud coordinator start NAME --repo https://github.com/OWNER/REPO --branch BASE --task-file /tmp/brief-NAME.md --json
   ```
   The JSON is `{name, machine, remoteControlName, attach}`. It begins on the task at once.
5. **Tell the user** three things: the Remote Control session name (`remoteControlName`; they open claude.ai or the Claude app and pick that session), how to attach from a terminal (`attach`, or `cloudy-cloud coordinator attach NAME`), the deadline (the server deletes the machine at the time `coordinator start` prints; default 24 hours, set with `--max-hours`), and the stop command: `cloudy-cloud coordinator stop NAME`.
6. **Do not stop it** unless the user asks. It deletes itself when it finishes (see Part C), or the server deletes it at the deadline, whichever is first. List coordinators with `cloudy-cloud coordinator ls`. Set `--max-hours` to the wall time in the brief plus a margin.

## C. Working unattended (coordinator)

There is no human to answer questions. The user may look in through Remote Control but must not be needed.

- **Never wait for an answer.** When something is unclear, use the brief's default. If the brief has none, pick the safest, smallest, most reversible choice. Log it in `FLEET_REPORT.md` under Decisions.
- **Worker briefs must be self-contained.** Each one has: the goal, the files it owns ("do not edit anything else"), the base branch `fleet/<topic>`, the exact acceptance command, "commit early and push to your `cloudy-cloud/<id>` branch before you finish", and the unattended rule below.
- **The unattended rule for workers:** "No human will answer. Make reasonable choices and write your assumptions in your final reply. Only if you are truly blocked, end your reply with a line starting `QUESTION:`."
- **Answering workers.** Workers cannot message you in the middle of a task. A worker with a question ends its task with a line starting `QUESTION:`. Answer with `cloud_agent_message`, then `cloud_agent_wait` again. Answer from the brief or the safest choice, and log it.
- **Bad work.** Never trust "done". Fetch the branch, read the diff, run the tests. If a worker failed, retry it once with a narrower brief that names what is missing. If it fails again, skip that item and note it under Skipped or failed.
- **Respect the caps** in the brief (workers, wall time). When the wall time is near, stop starting work and finish.
- **At the end, in order:**
  1. Merge the good branches into `fleet/<topic>` (see Pattern 2 in SKILL.md).
  2. Run the acceptance commands on the trunk.
  3. Write `FLEET_REPORT.md` (Done, Decisions, Open questions, Skipped or failed, Verification with real command output). Commit and push it to the trunk.
  4. Open the PR only if the brief says so.
  5. `cloud_agent_stop` every worker.
  6. Delete the worker branches you merged (`git push origin --delete cloudy-cloud/<id> ...`) unless the brief says to keep them. Keep the branches of failed or skipped workers, and list them in the report.
  7. Post a final summary in the session. The user reads it through Remote Control.
  8. Last, run `~/cloudy-cloud/bin/cloudy-cloud coordinator finish`. It deletes your machine, but only if `~/repo` is clean, every `fleet/*` branch and the current branch are pushed, and no worker is running. If it refuses, fix what it names and run it again. Do not use `--force` unless the report says the unpushed work is intentionally dropped.
- **Deadline.** The server deletes your machine at the time in your instructions, whatever you are doing. Push early and often. When the deadline is within 30 minutes, stop starting work and finish.
- If `finish` cannot run, say so in the summary and include the user's command: `cloudy-cloud coordinator stop NAME`.
- **Safety.** Never print or commit keys, tokens or `~/.config/cloudy-cloud` contents, and never put them in worker briefs. Push only to `cloudy-cloud/*` and `fleet/*`. Never push to `main` or the base branch. Open PRs only as the brief says.
