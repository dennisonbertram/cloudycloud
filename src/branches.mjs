#!/usr/bin/env node
// `cloudy-cloud branches prune [--yes] [--dry-run]`: delete the cloudy-cloud/<id> branches on origin that add nothing
// to the default branch (empty, or already merged). Dry run unless --yes. Never touches any other branch name.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const OURS = /^cloudy-cloud\/(issue-\d{1,10}-)?[0-9a-f]{8}$/; // cloudy-cloud/<id> or, for a worker started from an issue, cloudy-cloud/issue-<n>-<id>
const USAGE = 'Usage: cloudy-cloud branches prune [--yes] [--dry-run]\n  Lists cloudy-cloud/<id> branches on origin that are empty or merged into the default branch.\n  Nothing is deleted unless you pass --yes.';

export async function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const [cmd, ...flags] = argv;
  if (cmd !== 'prune' || flags.some((f) => f !== '--yes' && f !== '--dry-run')) { err(USAGE); return 2; }
  const del = flags.includes('--yes') && !flags.includes('--dry-run');
  const git = (...a) => run('git', a, { cwd, maxBuffer: 1 << 26 }).then((r) => r.stdout.trim());
  try {
    const listed = (await git('ls-remote', '--heads', 'origin', 'refs/heads/cloudy-cloud/*')).split('\n').filter(Boolean)
      .map((l) => l.split(/\s+/)).map(([sha, ref]) => [sha, ref.replace(/^refs\/heads\//, '')]).filter(([, b]) => OURS.test(b));
    if (!listed.length) { out('No cloudy-cloud/<id> branches on origin.'); return 0; }
    const head = (await git('ls-remote', '--symref', 'origin', 'HEAD')).match(/^ref: refs\/heads\/(\S+)\tHEAD/m)?.[1];
    if (!head || !/^[A-Za-z0-9._/-]+$/.test(head) || head.startsWith('-')) throw new Error('could not read the default branch of origin');
    await git('fetch', '-q', 'origin', head, ...listed.map(([, b]) => `+refs/heads/${b}:refs/remotes/origin/${b}`));
    const base = `origin/${head}`;
    const gone = [];
    for (const [sha, b] of listed) {
      const merged = await git('merge-base', '--is-ancestor', sha, base).then(() => true, () => false);
      out(`${b}  ${sha.slice(0, 7)}  ${merged ? 'prune (in ' + head + ')' : 'keep (has commits not in ' + head + ')'}`);
      if (merged) gone.push(b);
    }
    if (!del) { out(`Dry run: nothing deleted${gone.length ? `; ${gone.length} would be deleted` : ''}. Run again with --yes to delete.`); return 0; }
    for (const b of gone) { await git('push', '-q', 'origin', '--delete', b); out(`Deleted ${b}`); }
    return 0;
  } catch (e) {
    err(`cloudy-cloud branches: ${e.stderr || e.message}\nNext step: run it inside a git repo whose origin you can access.`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
