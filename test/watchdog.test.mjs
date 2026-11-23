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

test('the default branch is never pushed: work goes to cloudy-cloud/wip-<timestamp>', async () => {
  const r = repo({ branch: 'main' });
  writeFileSync(join(r.home, 'repo', 'wip.txt'), 'half done');
  r.rgit('add', 'wip.txt');
  r.rgit('commit', '-q', '-m', 'add wip');
  r.rgit('push', '-q', 'origin', 'main');
  writeFileSync(join(r.home, 'repo', 'wip.txt'), 'edited');
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.equal(await exited, 0, 'watchdog exits');
  const heads = r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads');
  assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-1799999760/); // timestamp = CC_NOW
  assert.equal(r.ogit('log', 'main', '--format=%s', '-1'), 'add wip', 'origin main was not pushed to');
  assert.equal(r.ogit('log', 'cloudy-cloud/wip-1799999760', '--format=%s', '-1'), 'WIP: automatic save before the machine is deleted');
  assert.match(readFileSync(r.watchLog, 'utf8'), /saved the work to cloudy-cloud\/wip-1799999760/);
});

test('unpushed commits on a feature branch are pushed without a commit', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'local work'); // committed, not pushed
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.equal(await exited, 0, 'watchdog exits');
  assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'local work');
  assert.match(readFileSync(r.watchLog, 'utf8'), /pushed feat\/x to origin/);
});

test('a branch the remote does not have counts as unpushed and is pushed', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('checkout', '-q', '-b', 'feat/new');
  r.rgit('commit', '-q', '--allow-empty', '-m', 'new branch work');
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.equal(await exited, 0, 'watchdog exits');
  assert.equal(r.ogit('log', 'feat/new', '--format=%s', '-1'), 'new branch work', 'a local-only branch still reaches origin');
  assert.match(readFileSync(r.watchLog, 'utf8'), /pushed feat\/new to origin/);
});

test('a release branch is protected too', async () => {
  const r = repo({ branch: 'release/1.0' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'release work');
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.equal(await exited, 0, 'watchdog exits');
  assert.match(r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads'), /refs\/heads\/cloudy-cloud\/wip-/);
  assert.equal(r.ogit('log', 'release/1.0', '--format=%s', '-1'), 'on release/1.0', 'origin release/1.0 was not pushed to');
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
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.equal(await exited, 0, 'watchdog exits');
  const heads = ogit2('for-each-ref', '--format=%(refname)', 'refs/heads');
  assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-/, 'with no remote default known, the wip branch is the only safe target');
  assert.doesNotMatch(heads, /refs\/heads\/feat\/x/);
  assert.match(readFileSync(r.watchLog, 'utf8'), /could not read the default branch/);
});

test('nothing to save: a clean pushed tree only logs and exits; untracked files do not dirty it', async () => {
  const r = repo();
  writeFileSync(join(r.home, 'repo', 'stray.txt'), 'untracked');
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.equal(await exited, 0, 'watchdog exits');
  const log = readFileSync(r.watchLog, 'utf8');
  assert.match(log, /nothing to save/);
  assert.match(log, /1 untracked file\(s\).*stray\.txt/, 'the stray file is still reported');
  assert.equal(r.ogit('log', 'main', '--format=%s', '-1'), 'c0');
});

test('a failed commit pushes nothing; the save is retried each poll and exits non-zero at the deadline', async () => {
  const r = repo({ branch: 'feat/x' });
  writeFileSync(join(r.home, 'repo', 'tracked.txt'), 'edit');
  r.rgit('add', 'tracked.txt'); // tracked: `add -u` would stage it
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
    assert.equal(await exited, 0, 'the next poll saves the work');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'retry me');
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
