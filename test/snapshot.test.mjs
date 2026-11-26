import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshotManager } from '../src/snapshot.mjs';

const exec = promisify(execFile);
const sh = (cwd, cmd) => exec('sh', ['-c', cmd], { cwd }).then((r) => r.stdout.trim());
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-snapshot-'));
  await sh(dir, 'git init -q -b main && git config user.name t && git config user.email t@t');
  await writeFile(join(dir, 'tracked.txt'), 'base\n');
  await sh(dir, 'git add tracked.txt && git commit -qm init');
  return dir;
}
const git = (cwd, ...args) => exec('git', args, { cwd }).then((r) => r.stdout.trim());

test('equivalent concurrent snapshots share one disk bundle and release it after the last user', async () => {
  const root = await repo();
  const manager = createSnapshotManager({ git });
  try {
    await writeFile(join(root, 'tracked.txt'), 'working tree\n');
    const head = await git(root, 'rev-parse', 'HEAD');
    const snapshot = await git(root, 'stash', 'create');
    const [a, b] = await Promise.all([
      manager.acquire(root, head, snapshot, 1_000_000),
      manager.acquire(root, head, snapshot, 1_000_000),
    ]);
    assert.equal(manager.preparations, 1);
    assert.equal(a.path, b.path);
    assert.equal(a.sha, b.sha, 'both callers check out the commit represented by the shared bundle');
    assert.equal(a.size, b.size);
    assert.equal(Object.hasOwn(a, 'data'), false, 'queued callers keep only a disk path, not bundle bytes');
    assert.match((await a.read()).toString('utf8', 0, 16), /^# v2 git bundle/);
    const bundlePath = a.path;
    await a.release();
    assert.equal(await readFile(bundlePath).then(() => true, () => false), true);
    await b.release();
    assert.equal(await readFile(bundlePath).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed index or tracked contents with unchanged HEAD get different snapshots', async () => {
  const root = await repo();
  const manager = createSnapshotManager({ git });
  const handles = [];
  try {
    const head = await git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'tracked.txt'), 'staged one\n');
    await git(root, 'add', 'tracked.txt');
    const first = await manager.acquire(root, head, await git(root, 'stash', 'create'), 1_000_000);
    handles.push(first);
    assert.match(await git(root, 'status', '--porcelain'), /^M  tracked\.txt$/m, 'snapshot capture leaves the staged index intact');
    await writeFile(join(root, 'tracked.txt'), 'staged two\n');
    await git(root, 'add', 'tracked.txt');
    const second = await manager.acquire(root, head, await git(root, 'stash', 'create'), 1_000_000);
    handles.push(second);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
    assert.match(await git(root, 'status', '--porcelain'), /^M  tracked\.txt$/m, 'a second capture still leaves the staged index intact');
    assert.notEqual(first.path, second.path);
    assert.equal(manager.preparations, 2);
  } finally {
    await Promise.all(handles.map((h) => h.release()));
    await rm(root, { recursive: true, force: true });
  }
});

test('identical commit and tree in different worktrees use separate disk snapshots', async () => {
  const root = await repo();
  const parent = await mkdtemp(join(tmpdir(), 'cc-worktrees-'));
  const other = join(parent, 'other');
  const manager = createSnapshotManager({ git });
  const handles = [];
  try {
    await exec('git', ['clone', '-q', '--shared', root, other]);
    const head = await git(root, 'rev-parse', 'HEAD');
    assert.equal(await git(other, 'rev-parse', 'HEAD'), head);
    const a = await manager.acquire(root, head, undefined, 1_000_000);
    const b = await manager.acquire(other, head, undefined, 1_000_000);
    handles.push(a, b);
    assert.notEqual(a.path, b.path);
    assert.equal(manager.preparations, 2);
  } finally {
    await Promise.all(handles.map((h) => h.release()));
    await rm(parent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('different candidate upload limits do not share an incompatible bundle', async () => {
  const root = await repo();
  const manager = createSnapshotManager({ git });
  const handles = [];
  try {
    await writeFile(join(root, 'tracked.txt'), 'working tree\n');
    const head = await git(root, 'rev-parse', 'HEAD');
    const snapshot = await git(root, 'stash', 'create');
    const a = await manager.acquire(root, head, snapshot, 1_000_000);
    const b = await manager.acquire(root, head, snapshot, 500_000);
    handles.push(a, b);
    assert.notEqual(a.path, b.path);
    assert.equal(manager.preparations, 2);
  } finally {
    await Promise.all(handles.map((h) => h.release()));
    await rm(root, { recursive: true, force: true });
  }
});

test('the manager caps distinct retained bundles while queued callers wait', async () => {
  const root = await repo();
  const manager = createSnapshotManager({ git, maxEntries: 1 });
  let handle;
  try {
    const head = await git(root, 'rev-parse', 'HEAD');
    handle = await manager.acquire(root, head, undefined, 1_000_000);
    await assert.rejects(manager.acquire(root, head, undefined, 500_000), /Too many repository snapshots/);
    assert.equal(manager.size, 1);
  } finally {
    await handle?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed bundle preparation releases its temporary directory', async () => {
  const root = await repo();
  const tempRoot = await mkdtemp(join(tmpdir(), 'cc-snapshot-temp-'));
  const manager = createSnapshotManager({
    tempDir: tempRoot,
    git: async (_cwd, ...args) => {
      if (args[0] === 'rev-parse') return 'b'.repeat(40);
      if (args[0] === 'update-ref') return '';
      throw new Error('prepare failed');
    },
  });
  try {
    await assert.rejects(manager.acquire(root, 'a'.repeat(40), undefined, 1_000_000), /prepare failed/);
    assert.equal(manager.size, 0);
    assert.deepEqual(await readdir(tempRoot), [], 'the failed bundle directory is removed');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
