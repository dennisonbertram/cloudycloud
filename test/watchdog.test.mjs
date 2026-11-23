import './tmp-cleanup.mjs';
// The watchdog script runs locally with a fake clock (CC_NOW_FILE, re-read every poll) and a tmux PATH shim
// that records its arguments. Poll deadlines, never fixed sleeps.
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
  // A tmux shim on PATH records every invocation, one line per call.
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

function run(r, { deleteAt, now }) {
  const env = { ...process.env, HOME: r.home, PATH: `${r.bin}:${process.env.PATH}`, CC_NOW_FILE: r.nowFile, CC_WATCHDOG_POLL: '0.1', ...(deleteAt !== undefined && { CLOUDY_CLOUD_DELETE_AT: deleteAt }) };
  writeFileSync(r.nowFile, String(now));
  const p = spawn('sh', [r.script], { env });
  // True when the watchdog exits; kills it and resolves false after a 30 s deadline so a stuck
  // script fails the test instead of hanging the file.
  const exited = new Promise((res) => {
    const timer = setTimeout(() => { p.kill('SIGKILL'); res(false); }, 30_000);
    p.on('exit', () => { clearTimeout(timer); res(true); });
  });
  return { p, exited };
}

const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const iso = (epoch) => new Date(epoch * 1000).toISOString();

test('warns at 30 and 10 minutes, then exits after the save step at 5', async () => {
  const r = repo({ branch: 'feat/x' });
  const { p, exited } = run(r, { deleteAt: iso(T0), now: T0 - 1800 });
  try {
    assert.ok(await until(() => lines(r.tmuxLog).some((l) => l.includes('in 30 minutes'))), '30-minute send-keys');
    const at30 = lines(r.tmuxLog);
    assert.match(at30.join('\n'), /send-keys -t claude -l \[cloudy-cloud\] This machine is deleted at .* \(in 30 minutes\)\. Finish the current step, commit, and push your branch now\./);
    assert.ok(at30.includes('send-keys -t claude Enter'), 'the Enter key follows the literal text');
    writeFileSync(r.nowFile, String(T0 - 600));
    assert.ok(await until(() => lines(r.tmuxLog).some((l) => l.includes('in 10 minutes'))), '10-minute send-keys');
    // A change appears 4 minutes before deletion: committed and pushed by the save step.
    writeFileSync(join(r.home, 'repo', 'left.txt'), 'unfinished');
    writeFileSync(r.nowFile, String(T0 - 240));
    assert.equal(await exited, true, 'watchdog exits after the save step');
    assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'WIP: automatic save before the machine is deleted');
    const log = readFileSync(r.watchLog, 'utf8');
    assert.match(log, /warned the Claude session \(30 minutes left\)/);
    assert.match(log, /warned the Claude session \(10 minutes left\)/);
    assert.match(log, /committed the remaining changes/);
    assert.match(log, /pushed feat\/x to origin/);
  } finally {
    p.kill('SIGKILL');
  }
});

test('the default branch is never pushed: work goes to cloudy-cloud/wip-<timestamp>', async () => {
  const r = repo({ branch: 'main' });
  writeFileSync(join(r.home, 'repo', 'wip.txt'), 'half done');
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.ok(await exited, 'watchdog exits');
  const heads = r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads');
  assert.match(heads, /refs\/heads\/cloudy-cloud\/wip-1799999760/); // timestamp = CC_NOW
  assert.equal(r.ogit('log', 'main', '--format=%s', '-1'), 'c0', 'origin main was not pushed to');
  assert.equal(r.ogit('log', 'cloudy-cloud/wip-1799999760', '--format=%s', '-1'), 'WIP: automatic save before the machine is deleted');
  assert.match(readFileSync(r.watchLog, 'utf8'), /saved the work to cloudy-cloud\/wip-1799999760/);
});

test('unpushed commits on a feature branch are pushed without a commit', async () => {
  const r = repo({ branch: 'feat/x' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'local work'); // committed, not pushed
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.ok(await exited, 'watchdog exits');
  assert.equal(r.ogit('log', 'feat/x', '--format=%s', '-1'), 'local work');
  assert.match(readFileSync(r.watchLog, 'utf8'), /pushed feat\/x to origin/);
});

test('a release branch is protected too', async () => {
  const r = repo({ branch: 'release/1.0' });
  r.rgit('commit', '-q', '--allow-empty', '-m', 'release work');
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.ok(await exited, 'watchdog exits');
  assert.match(r.ogit('for-each-ref', '--format=%(refname)', 'refs/heads'), /refs\/heads\/cloudy-cloud\/wip-/);
  assert.equal(r.ogit('log', 'release/1.0', '--format=%s', '-1'), 'on release/1.0', 'origin release/1.0 was not pushed to');
});

test('nothing to save: a clean pushed tree only logs and exits', async () => {
  const r = repo();
  const { exited } = run(r, { deleteAt: iso(T0), now: T0 - 240 });
  assert.ok(await exited, 'watchdog exits');
  assert.match(readFileSync(r.watchLog, 'utf8'), /nothing to save/);
  assert.equal(r.ogit('log', 'main', '--format=%s', '-1'), 'c0');
});

test('a missing or unparsable deleteAt logs and exits', async () => {
  const r = repo();
  assert.ok(await run(r, { deleteAt: undefined, now: T0 }).exited, 'watchdog exits');
  assert.match(readFileSync(r.watchLog, 'utf8'), /no CLOUDY_CLOUD_DELETE_AT/);
  const r2 = repo();
  assert.ok(await run(r2, { deleteAt: 'not a time', now: T0 }).exited, 'watchdog exits');
  assert.match(readFileSync(r2.watchLog, 'utf8'), /could not parse the delete time/);
});
