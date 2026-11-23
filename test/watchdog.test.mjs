import './tmp-cleanup.mjs';
// The watchdog script runs locally with a fake clock (CC_NOW_FILE, re-read every poll) and a tmux PATH shim
// that records its arguments. Poll deadlines, never fixed sleeps. The warnings now reach the session through
// a Claude Code hook (bin/deadline-hook.sh), so the script must never touch tmux; a stub on PATH proves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WATCHDOG_SCRIPT } from '../src/watchdog.mjs';

const T0 = 1_800_000_000; // a fixed epoch all tests count down from

// A bare "GitHub" origin (its HEAD is main) plus a home directory whose ~/repo is a clone checked out
// on `branch` — the same shape coordinator start leaves on the machine.
function repo({ branch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-watch-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const git = (...a) => execFileSync('git', ['-C', work, ...a]);
  git('config', 'user.email', 'w@x');
  git('config', 'user.name', 'W');
  git('commit', '-q', '--allow-empty', '-m', 'c0');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  if (branch !== 'main') {
    git('checkout', '-q', '-b', branch);
    git('commit', '-q', '--allow-empty', '-m', `on ${branch}`);
    git('push', '-q', 'origin', branch);
  }
  execFileSync('git', ['clone', '-q', '-b', branch, origin, join(home, 'repo')]);
  const rgit = (...a) => execFileSync('git', ['-C', join(home, 'repo'), ...a], { encoding: 'utf8' }).trim();
  rgit('config', 'user.email', 'w@x');
  rgit('config', 'user.name', 'W');
  // A tmux shim on PATH records every invocation, one line per call: the watchdog must never call it.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, 'tmux.log')}"\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  const script = join(dir, 'watchdog.sh');
  writeFileSync(script, WATCHDOG_SCRIPT);
  const ogit = (...a) => execFileSync('git', ['-C', origin, ...a], { encoding: 'utf8' }).trim();
  return { dir, home, origin, bin, script, rgit, ogit, tmuxLog: join(dir, 'tmux.log'), nowFile: join(dir, 'now'), watchLog: join(home, 'watchdog.log') };
}

// Polls fn until it is truthy or the deadline passes; returns fn's last value.
async function until(fn, ms = 30_000) {
  for (const end = Date.now() + ms; ;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Resolves with the watchdog's exit code (-1 when it was killed for overrunning). Pass
// `coordinator: undefined` explicitly to leave CLOUDY_CLOUD_COORDINATOR unset.
function run(r, opts) {
  const { deleteAt, now } = opts;
  const coordinator = Object.hasOwn(opts, 'coordinator') ? opts.coordinator : '1';
  const env = { ...process.env, HOME: r.home, PATH: `${r.bin}:${process.env.PATH}`, CC_NOW_FILE: r.nowFile, CC_WATCHDOG_POLL: '0.1', ...(coordinator !== undefined && { CLOUDY_CLOUD_COORDINATOR: coordinator }), ...(deleteAt !== undefined && { CLOUDY_CLOUD_DELETE_AT: deleteAt }) };
  writeFileSync(r.nowFile, String(now));
  const p = spawn('sh', [r.script], { env });
  const exited = new Promise((res) => {
    const timer = setTimeout(() => { p.kill('SIGKILL'); res(-1); }, 30_000);
    p.on('exit', (code, signal) => { clearTimeout(timer); res(signal ? -1 : code); });
  });
  return { p, exited };
}

const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const iso = (epoch) => new Date(epoch * 1000).toISOString();

test('the deadline reminders go through the hook, not tmux: the watchdog never calls send-keys', async () => {
  const r = repo({ branch: 'feat/x' });
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 1800 });
  try {
    // Through the 30- and 10-minute marks and the save at 5, tmux is never invoked.
    writeFileSync(r.nowFile, String(T0 - 600));
    writeFileSync(r.nowFile, String(T0 - 240));
    assert.ok(await until(() => lines(r.watchLog).some((l) => /nothing to save|pushed|saved/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30)); // inside the final minute: the watchdog winds down
    assert.equal(await exited, 0, 'watchdog exits after the save step');
    assert.deepEqual(lines(r.tmuxLog), [], 'no tmux call happened at any point');
    assert.doesNotMatch(WATCHDOG_SCRIPT, /send-keys/, 'the warning mechanism is gone from the script');
  } finally {
    p.kill('SIGKILL');
  }
});

test('untracked files are never staged: a tracked edit is saved, the untracked file is only logged', async () => {
  const r = repo({ branch: 'feat/x' });
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'v1');
  r.rgit('add', 'tracked.txt');
  r.rgit('commit', '-q', '-m', 'add tracked');
  r.rgit('push', '-q', 'origin', 'feat/x');
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'modified');
  writeFileSync(join(r.home, 'repo', 'left.env'), 'SECRET=must-not-leak');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits after the save step');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'WIP: automatic save before the machine is deleted');
    const tree = r.ogit('ls-tree', '-r', '--name-only', 'feat/x');
    assert.match(tree, /tracked\.txt/);
    assert.doesNotMatch(tree, /left\.env/, 'the untracked env file never reached origin');
    assert.equal(r.ogit('show', 'feat/x:tracked.txt'), 'modified', 'the tracked edit was committed and pushed');
    const log = readFileSync(r.watchLog, 'utf8');
    assert.match(log, /committed the remaining changes/);
    assert.match(log, /1 untracked file\(s\).*left\.env/, 'the untracked file is logged by name');
    assert.doesNotMatch(log, /must-not-leak/, 'never the value');
    assert.match(log, /pushed feat\/x to origin/);
  } finally {
    p.kill('SIGKILL');
  }
});

test('a file already staged as an addition is unstaged and logged, never committed or pushed', async () => {
  const r = repo({ branch: 'feat/x' });
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'v1');
  r.rgit('add', 'tracked.txt');
  r.rgit('commit', '-q', '-m', 'add tracked');
  r.rgit('push', '-q', 'origin', 'feat/x');
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'modified');
  writeFileSync(join(r.home, 'repo', '.env'), 'API_KEY=must-not-leak');
  r.rgit('add', '.env'); // staged before the watchdog ran: `add -u` will not remove it
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits after the save step');
    const tree = r.ogit('ls-tree', '-r', '--name-only', 'feat/x');
    assert.doesNotMatch(tree, /\.env/, 'the staged credential file never reached origin');
    assert.equal(r.ogit('show', 'feat/x:tracked.txt'), 'modified', 'the tracked edit was still committed and pushed');
    const log = readFileSync(r.watchLog, 'utf8');
    assert.match(log, /unstaged newly added file\(s\), not committed: \.env/, 'the staged file is logged by name');
    assert.doesNotMatch(log, /must-not-leak/, 'never the value');
    assert.equal(r.rgit('status', '--porcelain'), '?? .env', 'it ends up untracked, not staged');
  } finally {
    p.kill('SIGKILL');
  }
});

test('the default branch is never pushed: work goes to cloudy-cloud/wip-<timestamp>', async () => {
  const r = repo({ branch: 'main' });
  writeFileSync(join(r.home, 'repo', 'wip.txt'), 'half done');
  r.rgit('add', 'wip.txt');
  r.rgit('commit', '-q', '-m', 'add wip');
  r.rgit('push', '-q', 'origin', 'main');
  writeFileSync(join(r.home, 'repo', 'wip.txt'), 'edited');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /saved the work/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    const heads = r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads');
    assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-1799999760/); // timestamp = CC_NOW
    assert.equal(r.ogit('log', 'main', '--format=%s', '-1'), 'add wip', 'origin main was not pushed to');
    assert.equal(r.ogit('log', 'cloudy-cloud/wip-1799999760', '--format=%s', '-1'), 'WIP: automatic save before the machine is deleted');
    assert.match(readFileSync(r.watchLog, 'utf8'), /saved the work to cloudy-cloud\/wip-1799999760/);
  } finally {
    p.kill('SIGKILL');
  }
});

test('unpushed commits on a feature branch are pushed without a commit', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'local work'); // committed, not pushed
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'local work');
    assert.match(readFileSync(r.watchLog, 'utf8'), /pushed feat\/x to origin/);
  } finally {
    p.kill('SIGKILL');
  }
});

test('a branch the remote does not have counts as unpushed and is pushed', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('checkout', '-q', '-b', 'feat/new');
  r.rgit('commit', '-q', '--allow-empty', '-m', 'new branch work');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/new/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.equal(r.ogit('log', 'feat/new', '--format=%s', '-1'), 'new branch work', 'a local-only branch still reaches origin');
    assert.match(readFileSync(r.watchLog, 'utf8'), /pushed feat\/new to origin/);
  } finally {
    p.kill('SIGKILL');
  }
});

test('a release branch is protected too', async () => {
  const r = repo({ branch: 'release/1.0' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'release work');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /saved the work/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.match(r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads'), /refs\/heads\/cloudy-cloud\/wip-/);
    assert.equal(r.ogit('log', 'release/1.0', '--format=%s', '-1'), 'on release/1.0', 'origin release/1.0 was not pushed to');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a remote that names no default branch (detached HEAD) protects every branch', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'detached-head remote work');
  // A second bare origin whose HEAD is detached at a commit: `ls-remote --symref` reports no branch.
  const origin2 = join(r.dir, 'origin2.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin2]);
  execFileSync('git', ['-C', join(r.dir, 'work'), 'push', '-q', origin2, 'main']);
  const sha = execFileSync('git', ['-C', join(r.dir, 'work'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', origin2, 'update-ref', '--no-deref', 'HEAD', sha]);
  r.rgit('remote', 'set-url', 'origin', origin2);
  const ogit2 = (...a) => execFileSync('git', ['-C', origin2, ...a], { encoding: 'utf8' }).trim();
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /saved the work/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    const heads = ogit2('for-each-ref', '--format=%(refname)', 'refs/heads');
    assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-/, 'with no remote default known, the wip branch is the only safe target');
    assert.doesNotMatch(heads, /refs\/heads\/feat\/x/);
    assert.match(readFileSync(r.watchLog, 'utf8'), /could not read the default branch/);
  } finally {
    p.kill('SIGKILL');
  }
});

test('nothing to save: a clean pushed tree only logs and exits; untracked files do not dirty it', async () => {
  const r = repo();
  writeFileSync(join(r.home, 'repo', 'stray.txt'), 'untracked');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /nothing to save/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    const log = readFileSync(r.watchLog, 'utf8');
    assert.match(log, /nothing to save/);
    assert.match(log, /1 untracked file\(s\).*stray\.txt/, 'the stray file is still reported');
    assert.equal(r.ogit('log', 'main', '--format=%s', '-1'), 'c0');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a failed commit pushes nothing; the save is retried each poll and exits non-zero at the deadline', async () => {
  const r = repo({ branch: 'feat/x' });
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'v1');
  r.rgit('add', 'tracked.txt');
  r.rgit('commit', '-q', '-m', 'add tracked');
  r.rgit('push', '-q', 'origin', 'feat/x');
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'edit'); // a tracked edit `add -u` would stage
  mkdirSync(join(r.home, 'repo', '.git', 'hooks'), { recursive: true });
  writeFileSync(join(r.home, 'repo', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(r.home, 'repo', '.git', 'hooks', 'pre-commit'), 0o755);
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).filter((l) => /commit failed|could not be staged/.test(l)).length >= 2), 'the failed save is retried on the next polls');
    assert.doesNotMatch(r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads'), /wip|WIP/, 'a failed commit never reaches origin');
    writeFileSync(r.nowFile, String(T0 + 10)); // past the deadline
    assert.equal(await exited, 1, 'an unfinished save exits non-zero at the deadline');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a failed push is retried each poll: fixing the remote mid-window saves the work', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'retry me');
  r.rgit('remote', 'set-url', 'origin', '/nonexistent/origin.git');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).filter((l) => /failed/.test(l)).length >= 2), 'the failed push is retried');
    assert.match(readFileSync(r.watchLog, 'utf8'), /could not read the default branch/, 'a dead remote counts as "no default known"');
    r.rgit('remote', 'set-url', 'origin', r.origin); // the remote comes back
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the next poll saves the work');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'retry me');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a failed push logs the remote\'s reason, with credentials in URLs removed', async () => {
  const r = repo({ branch: 'feat/x' });
  mkdirSync(join(r.origin, 'hooks'), { recursive: true });
  writeFileSync(join(r.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refusing to allow a Personal Access Token to create or update workflow without workflow scope https://user:tok@github.com/x" >&2\nexit 1\n');
  chmodSync(join(r.origin, 'hooks', 'pre-receive'), 0o755);
  r.rgit('commit', '-q', '--allow-empty', '-m', 'blocked');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /failed \(/.test(l))), 'the failure line carries a reason');
    const log = readFileSync(r.watchLog, 'utf8');
    assert.match(log, /the push to cloudy-cloud\/wip-\d+ failed \(.*remote rejected.*pre-receive hook declined\)\); will retry/);
    assert.doesNotMatch(log, /tok@/, 'credentials never reach the log');
    writeFileSync(r.nowFile, String(T0 + 10));
    await exited;
  } finally {
    p.kill('SIGKILL');
  }
});

test('a push that still fails at the deadline exits non-zero', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'unreachable');
  r.rgit('remote', 'set-url', 'origin', '/nonexistent/origin.git');
  writeFileSync(r.nowFile, String(T0 - 240));
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /failed/.test(l))), 'the first failed push is logged');
    writeFileSync(r.nowFile, String(T0 + 10));
    assert.equal(await exited, 1, 'non-zero at the deadline');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a failed fetch counts as not pushed: a stale origin ref never proves the work is safe', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'pushed work');
  r.rgit('push', '-q', 'origin', 'feat/x');
  // The remote loses the branch (deleted remotely); the local clone still holds the stale origin/feat/x ref.
  r.ogit('update-ref', '-d', 'refs/heads/feat/x');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    // A stale remote-tracking ref must not satisfy the save: the branch is re-pushed to the remote.
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the save re-pushes the branch');
    assert.doesNotMatch(readFileSync(r.watchLog, 'utf8'), /nothing to save/, 'a failed fetch is never "already pushed"');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'pushed work', 'the branch is back on the remote');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a configured pushurl decides both the destination and the default branch', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'pushurl work');
  // The push target is a different repository whose default branch IS feat/x — pushing the branch
  // itself would publish straight onto its default branch.
  const pushRepo = join(r.dir, 'push.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'feat/x', pushRepo]);
  execFileSync('git', ['-C', join(r.dir, 'work'), 'push', '-q', pushRepo, 'main:refs/heads/feat/x']);
  const pgit = (...a) => execFileSync('git', ['-C', pushRepo, ...a], { encoding: 'utf8' }).trim();
  r.rgit('remote', 'set-url', '--push', 'origin', pushRepo);
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /saved the work/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    const heads = pgit('for-each-ref', '--format=%(refname)', 'refs/heads');
    assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-/, 'protected by the push repo\'s own default, not the fetch repo\'s');
    assert.equal(pgit('log', 'feat/x', '--format=%s', '-1'), 'c0', 'the push repo\'s default branch was not pushed to');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'on feat/x', 'the fetch repo never saw the push');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a pushurl whose default differs still pushes the feature branch — to the push remote', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'pushurl feat work');
  const pushRepo = join(r.dir, 'push.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', pushRepo]);
  execFileSync('git', ['-C', join(r.dir, 'work'), 'push', '-q', pushRepo, 'main']);
  const pgit = (...a) => execFileSync('git', ['-C', pushRepo, ...a], { encoding: 'utf8' }).trim();
  r.rgit('remote', 'set-url', '--push', 'origin', pushRepo);
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.equal(pgit('log', 'feat/x', '--format=%s', '-1'), 'pushurl feat work', 'the push repo received the branch');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'on feat/x', 'the fetch repo never saw the push');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a detached HEAD is always saved to cloudy-cloud/wip-*', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('checkout', '-q', '--detach', 'HEAD');
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'edit');
  r.rgit('add', 'tracked.txt');
  r.rgit('commit', '-q', '-m', 'detached work');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /saved the work/.test(l))), 'the save ran');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    const heads = r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads');
    assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-/, 'a detached HEAD lands on a wip branch');
    assert.equal(r.ogit('log', 'cloudy-cloud/wip-1799999760', '--format=%s', '-1'), 'detached work');
  } finally {
    p.kill('SIGKILL');
  }
});

test('after a successful save the watchdog keeps polling and saves new work', async () => {
  const r = repo({ branch: 'feat/x' });
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'v1');
  r.rgit('add', 'tracked.txt');
  r.rgit('commit', '-q', '-m', 'add tracked');
  r.rgit('push', '-q', 'origin', 'feat/x');
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'first edit');
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /pushed feat\/x/.test(l))), 'the first save ran');
    assert.equal(r.ogit('show', 'feat/x:tracked.txt'), 'first edit');
    // More work happens after the save: the next poll commits and pushes it too.
    writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'second edit');
    writeFileSync(r.nowFile, String(T0 - 180));
    assert.ok(await until(() => lines(r.watchLog).filter((l) => /committed the remaining changes/.test(l)).length >= 2), 'the second save committed');
    assert.ok(await until(() => r.ogit('show', 'feat/x:tracked.txt') === 'second edit', 15_000), 'the second edit reached origin');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits inside the final minute');
  } finally {
    p.kill('SIGKILL');
  }
});

test('a non-fast-forward rejection saves to a fresh cloudy-cloud/wip-<timestamp> instead of retrying', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'local work');
  // Someone else advances origin/feat/x: the local push is a non-fast-forward.
  const other = join(r.dir, 'other');
  execFileSync('git', ['clone', '-q', '-b', 'feat/x', r.origin, other]);
  execFileSync('git', ['-C', other, 'config', 'user.email', 'o@x']);
  execFileSync('git', ['-C', other, 'config', 'user.name', 'O']);
  execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'someone else']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'feat/x']);
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  try {
    assert.ok(await until(() => lines(r.watchLog).some((l) => /was rejected; saved the work to cloudy-cloud\/wip-/.test(l))), 'the rejected push lands on a wip branch');
    writeFileSync(r.nowFile, String(T0 - 180));
    assert.ok(await until(() => lines(r.watchLog).some((l) => /nothing to save/.test(l))), 'the next poll does not retry the branch');
    writeFileSync(r.nowFile, String(T0 - 30));
    assert.equal(await exited, 0, 'watchdog exits');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'someone else', 'the remote branch was not force-pushed');
    assert.match(r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads'), /refs\/heads\/cloudy-cloud\/wip-/, 'the work is on a wip branch');
  } finally {
    p.kill('SIGKILL');
  }
});

test('the watchdog runs only on a coordinator (CLOUDY_CLOUD_COORDINATOR exactly "1")', async () => {
  for (const coordinator of [undefined, '0', 'false', 'yes']) {
    const r = repo({ branch: 'feat/x' });
    r.rgit('commit', '-q', '--allow-empty', '-m', `worker ${coordinator}`);
    writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'edit');
    r.rgit('add', 'tracked.txt');
    const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 240, coordinator });
    try {
      assert.equal(await exited, 0, `coordinator=${coordinator}: exits at once`);
      assert.match(readFileSync(r.watchLog, 'utf8'), /not a coordinator/, `coordinator=${coordinator}`);
      assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'on feat/x', 'nothing was pushed');
      assert.equal(gitStatus(r), 'A  tracked.txt', 'nothing was staged or committed');
    } finally {
      p.kill('SIGKILL');
    }
  }
});
const gitStatus = (r) => execFileSync('git', ['-C', join(r.home, 'repo'), 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();

test('a missing or unparsable deleteAt logs and exits', async () => {
  const r = repo();
  assert.equal(await run(r, { deleteAt: undefined, now: T0 }).exited, 0, 'watchdog exits');
  assert.match(readFileSync(r.watchLog, 'utf8'), /no CLOUDY_CLOUD_DELETE_AT/);
  const r2 = repo();
  assert.equal(await run(r2, { deleteAt: 'not a time', now: T0 }).exited, 0, 'watchdog exits');
  assert.match(readFileSync(r2.watchLog, 'utf8'), /could not parse the delete time/);
});
