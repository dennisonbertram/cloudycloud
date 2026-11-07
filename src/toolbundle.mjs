// Ships the laptop's claude-cloud to a machine as a git bundle, so it runs exactly this version without it being pushed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const git = (root, ...a) => execFileSync('git', ['-C', root, '-c', 'user.name=claude-cloud', '-c', 'user.email=claude-cloud@localhost', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

// HEAD plus uncommitted tracked edits (like the work-repo snapshot). Returns { data: Buffer, ref, sha }.
export function toolBundle(root) {
  const sha = git(root, 'stash', 'create') || git(root, 'rev-parse', 'HEAD');
  const ref = `refs/cc-keep/tool-${randomUUID().slice(0, 8)}`; // temporary: only so `git bundle` can name the snapshot
  const dir = mkdtempSync(join(tmpdir(), 'claude-cloud-tool-'));
  try {
    git(root, 'update-ref', ref, sha);
    try { git(root, 'bundle', 'create', join(dir, 't.bundle'), ref); } finally { try { git(root, 'update-ref', '-d', ref); } catch {} }
    return { data: readFileSync(join(dir, 't.bundle')), ref, sha };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Shell command that recreates ~/claude-cloud from the uploaded bundle (cwd must be the home folder). origin is for reference only.
export const toolInstallCmd = (b, bundlePath, origin) =>
  `rm -rf claude-cloud && git init -q claude-cloud && cd claude-cloud && git fetch -q ${bundlePath} ${b.ref} && git checkout -q --detach ${b.sha}` +
  (origin ? ` && git remote add origin '${origin}'` : '');
