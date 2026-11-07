# Brief template for an unattended coordinator

Copy this into a file (for example `/tmp/brief-<topic>.md`), fill in every section, delete the guidance in parentheses, and pass the file with `--task-file`. The coordinator and its workers have no human to ask. Anything you leave out, they will guess. Do not put keys or tokens in the brief.

```markdown
# Task: <short title>

## Goal
<What must be true when the job is done, and why it matters. Two to five sentences.>

## Repo and branches
- Repo: https://github.com/OWNER/REPO
- Base branch: <main>
- Trunk branch: fleet/<topic>   (create it from the base and push it first)

## Scope
In scope:
- <areas, files or directories to change>

Off limits:
- <files, directories, dependencies, or behaviors not to touch>
- Never push to main or the base branch. Push only to `cloudy-cloud/*` and `fleet/*`.

## Acceptance
Exact commands, run on the trunk at the end. All must pass:
- `<install command>`
- `<test command>`
- `<lint or build command>`
Done means: <one or two observable conditions, for example "every file in src/legacy/ is converted and no test is skipped">.

## Decomposition hint
Suggested work packages. Each owns separate files so merges stay clean.
1. <package name>: owns `<paths>`. <one-line goal>
2. <package name>: owns `<paths>`. <one-line goal>
Run later packages after earlier ones are merged if they depend on them (waves).

## Models
- Coordinator: Claude.
- Workers: `pi-glm` or `glm` for bulk, well-specified work (renames, tests for existing code, many similar files). Claude for design, tricky bugs, shared code, and anything needing judgment.
- Run the tests on every open-model branch before merging it.

## Defaults for likely ambiguities
- If <X is unclear>, do <Y>.
- If <X is unclear>, do <Y>.
- Anything else unclear: choose the smallest, safest, most reversible option and log it.

## When blocked
Do not wait. Skip the blocked item, note it in FLEET_REPORT.md under Open questions, and continue with the rest.

## Budget and caps
- Maximum workers at once: <N>. Maximum workers in total: <N>.
- Maximum wall time: <for example 4 hours>. At that time, stop starting work, merge what is good, and finish.
- Deadline: the server deletes the coordinator machine at the time in its instructions (`coordinator start --max-hours N`, at most 24). Push before then. When the work is done, run `~/cloudy-cloud/bin/cloudy-cloud coordinator finish` as the last step.

## Stop condition
Stop when the acceptance commands pass on the trunk, or the wall time is reached, or every remaining item is skipped. Then do the deliverables below.

## Deliverables
- <One PR from `fleet/<topic>` to `<base>`>  OR  <The trunk branch only. Do not open a PR.>
- `FLEET_REPORT.md` at the repo root of the trunk, with these sections: Done, Decisions (every choice you made without asking), Open questions, Skipped or failed, Verification (the commands you ran and their output).
- A final summary posted in the session.

## Reaching the user
The user checks in through Remote Control and may not answer for hours. Never wait for a reply. Assume no question will be answered.
```

## Example

```markdown
# Task: Convert the CSV importer to TypeScript

## Goal
Move src/importers/*.js to TypeScript so the importer package can enable `strict`. Behavior must not change.

## Repo and branches
- Repo: https://github.com/acme/ledger
- Base branch: main
- Trunk branch: fleet/importer-ts

## Scope
In scope: src/importers/ and its tests.
Off limits: src/api/, package.json dependencies, any generated files.
Never push to main. Push only to `cloudy-cloud/*` and `fleet/*`.

## Acceptance
- `npm ci`
- `npm test`
- `npx tsc --noEmit`
Done means: no .js file remains in src/importers/ and no test is skipped.

## Decomposition hint
1. csv: owns src/importers/csv*. 2. xlsx: owns src/importers/xlsx*. 3. shared types: owns src/importers/types.ts (do this first, merge, then start 1 and 2).

## Models
Coordinator on Claude. Workers `pi-glm` (mechanical conversion). Claude for types.ts.

## Defaults for likely ambiguities
- If a type is unclear, use `unknown` plus a narrowing check, not `any`.
- If a test fails before the change, leave it and note it.

## When blocked
Skip it, note it in FLEET_REPORT.md, continue.

## Budget and caps
At most 6 workers at once, 12 in total. Maximum wall time 3 hours.

## Stop condition
Acceptance commands pass, or 3 hours, or all remaining items skipped.

## Deliverables
One PR from fleet/importer-ts to main, and FLEET_REPORT.md on the trunk.

## Reaching the user
Remote Control only. Never wait for an answer.
```
