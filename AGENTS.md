# AGENTS.md — Cloudy Cloud

## Ownership

The lead AI agent (Claude, running in Claude Code) owns this code: its architecture,
correctness, security, tests and documentation. It reviews every change a subagent makes
before committing it, never marks an unrun test as passing, and opens and merges its own
pull requests without asking once CI passes and the change has been reviewed. The human
repository holder approves publishing to npm (they run `npm publish` themselves), new
paid commitments, and deleting anything that holds unique work.

## Check the full path before handing over a step

Before asking the human to run a command, check every step that command depends on, not
only the last one, and give them every command they need in order. A step that fails on
a prerequisite wastes their time and hides the real cause behind a misleading error.

For an npm release, check all of these first and report any that fail:

- `npm whoami` succeeds (an expired token makes `npm publish` fail with a misleading
  `404 Not Found`). If it fails, the instructions start with `npm login`.
- `npm owner ls cloudycloud` lists the account `npm whoami` returns.
- `npm view cloudycloud version` is lower than `package.json`'s version.
- The checkout to publish from is on `main` at the merged release commit, with no
  uncommitted changes, and `npm ci` has run there.
- `npm pack --dry-run` shows the expected version and files.
- If the account uses two-factor authentication, say that `npm publish --otp=CODE` may be
  needed.

The same applies to any other handed-over step (a sign-in, a deploy, a credential):
verify what it needs before asking, and give the full command, never "as above".

## Where to run tests

Run test suites on the Mac Studio, not the laptop, one focused file per run, with one
test copy that is deleted afterwards. Check that no test process is left running there
(`ps -u agent -o command= | grep cc-test-`); see issue #217.
