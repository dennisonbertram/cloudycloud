#!/usr/bin/env node
// `cloudy-cloud branches prune [--yes] [--dry-run]`: delete the cloudy-cloud/<id> branches on origin that add nothing
// to the default branch (empty, or already merged). Dry run unless --yes. Never touches any other branch name.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { helpText } from './cli-help.mjs';
import { makeUi } from './ui.mjs';

const run = promisify(execFile);
const OURS = /^cloudy-cloud\/(issue-\d{1,10}-)?[0-9a-f]{8}$/; // cloudy-cloud/<id> or, for a worker started from an issue, cloudy-cloud/issue-<n>-<id>
// Piped stderr keeps the classic text (unchanged for scripts); a terminal gets the wrapped shared-help version.
// --help always prints the full entry.
const USAGE = 'Usage: cloudy-cloud branches prune [--yes] [--dry-run]\n  Lists cloudy-cloud/<id> branches on origin that are empty or merged into the default branch.\n  Nothing is deleted unless you pass --yes.';
const onTerm = () => makeUi({ tty: Boolean(process.stderr.isTTY) }).term;

export async function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const [cmd, ...flags] = argv;
  if (cmd === '--help' || cmd === '-h') { out(helpText('branches')); return 0; }
  if (cmd !== 'prune' || flags.some((f) => f !== '--yes' && f !== '--dry-run')) { err(onTerm() ? helpText('branches', true) : USAGE); return 2; }
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
      if (merged) gone.push([sha, b]);
    }
    if (!del) { out(`Dry run: nothing deleted${gone.length ? `; ${gone.length} would be deleted` : ''}. Run again with --yes to delete.`); return 0; }
    if (gone.length) { // the delete push must go to the remote the listing came from
      const fetchUrl = await git('remote', 'get-url', 'origin');
      const pushUrls = (await git('remote', 'get-url', '--push', '--all', 'origin')).split('\n').map((s) => s.trim()).filter(Boolean);
      if (pushUrls.length !== 1 || pushUrls[0] !== fetchUrl) throw new Error('origin pushes to a different URL than it fetches (or to several); refusing to delete remote branches. Check: git remote -v');
    }
    for (const [sha, b] of gone) { // the lease rejects the delete if the branch moved since it was listed
      try {
        await git('push', '-q', `--force-with-lease=refs/heads/${b}:${sha}`, 'origin', `:refs/heads/${b}`);
        out(`Deleted ${b}`);
      } catch (e) {
        if (!String(e.stderr ?? '').includes('stale info')) throw e;
        out(`${b} skipped (changed since check)`);
      }
    }
    return 0;
  } catch (e) {
    err(`cloudy-cloud branches: ${e.stderr || e.message}\nNext step: run it inside a git repo whose origin you can access.`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
