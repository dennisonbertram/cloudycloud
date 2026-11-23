// Ships the laptop's cloudy-cloud to a machine as a git bundle, so it runs exactly this version without it being pushed.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const git = (root, ...a) => execFileSync('git', ['-C', root, '-c', 'user.name=cloudy-cloud', '-c', 'user.email=cloudy-cloud@localhost', ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// git stash create refreshes the index, so runs starting at the same moment can collide on index.lock. Wait and retry.
export function retryIndexLock(fn, tries = 8) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !/index\.lock|could not write index/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
    }
  }
}

// True when `root` is itself the top of a git checkout. An npm install is not: git would resolve to whatever repo encloses it (such as ~/.nvm).
export function ownsRepo(root) {
  try { return realpathSync(git(root, 'rev-parse', '--show-toplevel')) === realpathSync(root); } catch { return false; }
}

// A throwaway git repo holding exactly the package's published files, for installs that are not a git checkout. Fills `dir`; the caller removes it.
function packageRepo(root, dir) {
  const files = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files ?? [];
  for (const f of new Set([...files, 'package.json', 'README.md', 'LICENSE'])) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dir, f), { recursive: true });
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A', '-f');
  git(dir, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'cloudycloud package'); // not the user's signing or hooks
}

// HEAD plus uncommitted tracked edits (like the work-repo snapshot), minus credential-looking paths.
// Returns { data: Buffer, ref, sha, dropped: string[] }.
export function toolBundle(root) {
  if (ownsRepo(root)) return bundleOf(root);
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-cloud-pkg-'));
  try { packageRepo(root, dir); return bundleOf(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Basenames that can carry credentials and must never reach a machine inside the tool bundle. Such a file is
// dropped even when committed: the machine rebuilds the tool without it rather than receiving its bytes.
const SENSITIVE_NAME = /(?:^|\/)(?:\.env(?:rc)?(?:\.[^/]*)?|[^/]*\.env|\.netrc|\.dockercfg|\.git-credentials|\.pypirc|\.npmrc|credentials(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|keystore|jks|ppk)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;

function bundleOf(root) {
  const ref = `refs/cc-keep/tool-${randomUUID().slice(0, 8)}`; // temporary: only so `git bundle` can name the snapshot
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-cloud-tool-'));
  try {
    const { sha, dropped } = retryIndexLock(() => snapshotCommit(root, join(dir, 'index')));
    git(root, 'update-ref', ref, sha);
    try { git(root, 'bundle', 'create', join(dir, 't.bundle'), ref); } finally { try { git(root, 'update-ref', '-d', ref); } catch {} }
    return { data: readFileSync(join(dir, 't.bundle')), ref, sha, dropped };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The snapshot commit, built on a temporary index seeded from HEAD: `add -u` then carries every uncommitted
// edit and deletion of tracked files, exactly like `git stash create` — but a file added to the user's index
// and never committed (a staged .env) is untracked to this index, and untracked or ignored files are never
// read at all. Sensitive basenames are then removed from the index before the tree is written. When any were
// removed the snapshot is a root commit with no parent, so their blobs cannot ride along in HEAD's history.
function snapshotCommit(root, indexFile) {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const g = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=cloudy-cloud', '-c', 'user.email=cloudy-cloud@localhost', ...a], { encoding: 'utf8', env, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('read-tree', 'HEAD');
  g('add', '-u');
  const dropped = g('ls-files').split('\n').filter((p) => SENSITIVE_NAME.test(p));
  for (const p of dropped) g('update-index', '--force-remove', '--', p);
  const tree = g('write-tree');
  if (!dropped.length && tree === g('rev-parse', 'HEAD^{tree}')) return { sha: g('rev-parse', 'HEAD'), dropped };
  const sha = g('commit-tree', tree, ...(dropped.length ? [] : ['-p', 'HEAD']), '-m', 'cloudy-cloud tool snapshot');
  return { sha, dropped };
}

// Shell command that recreates ~/cloudy-cloud from the uploaded bundle (cwd must be the home folder). origin is for reference only.
export const toolInstallCmd = (b, bundlePath, origin) =>
  `rm -rf cloudy-cloud && git init -q cloudy-cloud && cd cloudy-cloud && git fetch -q ${bundlePath} ${b.ref} && git checkout -q --detach ${b.sha}` +
  (origin ? ` && git remote add origin '${origin}'` : '');
