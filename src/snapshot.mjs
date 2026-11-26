import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Prepared bundles live on disk while their callers wait for a machine. The bytes are
// read only when setup is ready to upload them, and the last caller removes the file.
export function createSnapshotManager({ git, remoteRefs, tempDir = tmpdir(), maxEntries = 16 }) {
  const entries = new Map();
  let preparations = 0;

  async function prepare(root, sha, maxBytes) {
    const dir = await mkdtemp(join(tempDir, 'cloudy-cloud-snapshot-'));
    const path = join(dir, 'in.bundle');
    const ref = `refs/cc-keep/${randomUUID()}`;
    let prereqs = [];
    let hasBundle = false;
    try {
      await git(root, 'update-ref', ref, sha);
      await git(root, 'bundle', 'create', path, ref);
      let size = (await stat(path)).size;
      hasBundle = true;
      if (size > maxBytes) {
        let refs = [];
        try {
          const advertised = await (remoteRefs ? remoteRefs(root) : git(root, 'ls-remote', '--refs', 'origin'));
          const advertisedRefs = new Set(String(advertised).split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((rev) => /^[0-9a-f]{40}$/i.test(rev)));
          // Intersect live advertised tips with local origin tracking refs. This avoids using
          // stale refs and limits thin bundles to history already available in this object store.
          const localRefs = String(await git(root, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin')).split('\n').filter(Boolean);
          refs = [...new Set(localRefs.filter((rev) => advertisedRefs.has(rev)))];
        } catch { /* An unreachable or unauthenticated origin cannot justify a thin bundle. */ }
        if (refs.length) {
          const thin = await git(root, 'bundle', 'create', path, ref, '--not', ...refs).then(() => true, (e) => {
            if (/empty bundle/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`)) return false;
            throw e;
          });
          if (!thin) {
            hasBundle = false;
            prereqs = [sha];
            size = 0;
          } else {
            size = (await stat(path)).size;
            let header = '';
            const stream = createReadStream(path, { encoding: 'latin1' });
            try {
              for await (const chunk of stream) {
                header += chunk;
                if (header.includes('\n\n')) break;
              }
            } finally { stream.destroy(); }
            prereqs = header.slice(0, header.indexOf('\n\n')).split('\n').filter((line) => line.startsWith('-')).map((line) => line.slice(1, 41));
          }
        } else {
          hasBundle = true;
        }
        if (size > maxBytes) {
          throw new Error(`The uncommitted/unpushed changes are too large to upload (${size} bytes, limit ${maxBytes}). Push the branch to GitHub first, then start the agent again.`);
        }
      }
      return { dir, path, size, prereqs, hasBundle, sha, read: () => hasBundle ? readFile(path) : Promise.resolve(undefined) };
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      await git(root, 'update-ref', '-d', ref).catch(() => {});
    }
  }

  async function acquire(root, head, snapshot, maxBytes) {
    const sha = snapshot || head;
    const tree = await git(root, 'rev-parse', `${sha}^{tree}`);
    // The absolute worktree path is part of identity: identical commits in separate worktrees
    // can have different index state, Git config, remotes, and upload limits.
    const key = `${root}\0${head}\0${tree}\0${maxBytes}`;
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxEntries) throw new Error('Too many repository snapshots are waiting for machines. Try again after some agents finish setup.');
      entry = { users: 0, prepared: undefined };
      entries.set(key, entry);
      preparations++;
      entry.prepared = prepare(root, sha, maxBytes).catch((e) => { entry.error = e; throw e; });
    }
    entry.users++;
    try {
      const prepared = await entry.prepared;
      let released = false;
      return {
        ...prepared,
        release: async () => {
          if (released) return;
          released = true;
          if (--entry.users === 0) {
            entries.delete(key);
            await rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
          }
        },
      };
    } catch (e) {
      if (--entry.users === 0) entries.delete(key);
      throw e;
    }
  }
  return { acquire, get preparations() { return preparations; }, get size() { return entries.size; } };
}
