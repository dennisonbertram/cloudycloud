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

// HEAD plus uncommitted tracked edits (like the work-repo snapshot). Returns { data: Buffer, ref, sha }.
export function toolBundle(root) {
  if (ownsRepo(root)) return bundleOf(root);
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-cloud-pkg-'));
  try { packageRepo(root, dir); return bundleOf(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function bundleOf(root) {
  const sha = retryIndexLock(() => git(root, 'stash', 'create')) || git(root, 'rev-parse', 'HEAD');
  const ref = `refs/cc-keep/tool-${randomUUID().slice(0, 8)}`; // temporary: only so `git bundle` can name the snapshot
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-cloud-tool-'));
  try {
    git(root, 'update-ref', ref, sha);
    try { git(root, 'bundle', 'create', join(dir, 't.bundle'), ref); } finally { try { git(root, 'update-ref', '-d', ref); } catch {} }
    return { data: readFileSync(join(dir, 't.bundle')), ref, sha };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Shell command that recreates ~/cloudy-cloud from the uploaded bundle (cwd must be the home folder). origin is for reference only.
export const toolInstallCmd = (b, bundlePath, origin) =>
  `rm -rf cloudy-cloud && git init -q cloudy-cloud && cd cloudy-cloud && git fetch -q ${bundlePath} ${b.ref} && git checkout -q --detach ${b.sha}` +
  (origin ? ` && git remote add origin '${origin}'` : '');
