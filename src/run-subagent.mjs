import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const SAFE = /^[A-Za-z0-9._:-]+$/;
const SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'E2B_API_KEY', 'INSTABOX_API_KEY'];
const LIFETIME_MS = 30 * 60_000;
const AGENT_MS = 29 * 60_000;
const SETUP_MS = 120_000;
const IDENT = ['-c', 'user.name=claude-cloud', '-c', 'user.email=claude-cloud@localhost'];

const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 1 << 28 }).then((r) => r.stdout.trim());
const log = (...a) => console.error('[claude-cloud]', ...a);

// createSandbox(envs, timeoutMs) -> sandbox with files.write/read, commands.run, kill.
export async function runSubagent(args, { createSandbox, env = process.env, cwd = process.cwd() }) {
  const { prompt, model, subagent_type: agent } = args;
  const secrets = SECRETS.map((k) => env[k]).filter(Boolean);
  const scrub = (s) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), String(s ?? ''));
  const fail = (text) => ({ isError: true, content: [{ type: 'text', text: scrub(text) }] });

  if (typeof prompt !== 'string' || !prompt) return fail('prompt is required');
  for (const [name, v] of [['model', model], ['subagent_type', agent]]) {
    if (v !== undefined && !(typeof v === 'string' && SAFE.test(v))) {
      return fail(`invalid ${name}: must match ${SAFE}`);
    }
  }

  let root;
  try {
    root = await git(cwd, 'rev-parse', '--show-toplevel');
    await git(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    return fail('claude-cloud needs a git repository with at least one commit. Run `git init` and commit your files, then retry.');
  }

  const id = randomUUID().slice(0, 8);
  const ref = `refs/claude-cloud/${id}`;
  const branch = `claude-cloud/${id}`;
  const tmp = await mkdtemp(join(tmpdir(), 'claude-cloud-'));
  let sandbox;
  try {
    // Snapshot tracked files (including uncommitted edits) without touching the worktree or index.
    const sha = (await git(root, ...IDENT, 'stash', 'create')) || (await git(root, 'rev-parse', 'HEAD'));
    await git(root, 'update-ref', ref, sha);
    const inBundle = join(tmp, 'in.bundle');
    await git(root, 'bundle', 'create', inBundle, ref);

    const envs = {};
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (env[k]) envs[k] = env[k];
    sandbox = await createSandbox(envs, LIFETIME_MS);
    const home = sandbox.home ?? '/home/user';
    log(`sandbox up, id ${id}, ${args.description ?? ''}`);

    await sandbox.files.write(`${home}/in.bundle`, await readFile(inBundle));
    await sandbox.files.write(`${home}/prompt.txt`, prompt);
    await sandbox.commands.run(
      `git init -q repo && cd repo && git fetch -q ../in.bundle ${ref} && git checkout -q --detach ${sha}`,
      { cwd: home, timeoutMs: SETUP_MS },
    );

    // model and agent were validated against SAFE, so they are safe inside the command string.
    const cmd = ['claude -p --dangerously-skip-permissions --output-format text',
      model && `--model ${model}`, agent && `--agent ${agent}`, `< ${home}/prompt.txt`].filter(Boolean).join(' ');
    let text, failure;
    try {
      text = (await sandbox.commands.run(cmd, { cwd: `${home}/repo`, timeoutMs: AGENT_MS })).stdout;
    } catch (e) {
      failure = e;
    }

    // Recover commits even on failure so work is not lost.
    let recovered = false, recoveryFailed = false;
    try {
      const out = await sandbox.commands.run(
        `git add -A && (git diff --cached --quiet || git ${IDENT.join(' ')} commit -q -m "claude-cloud: subagent changes");` +
        ` if [ "$(git rev-parse HEAD)" != "${sha}" ]; then git update-ref refs/heads/out HEAD &&` +
        ` git bundle create ${home}/out.bundle ^${sha} refs/heads/out && echo CHANGED; fi`,
        { cwd: `${home}/repo`, timeoutMs: SETUP_MS },
      );
      if (out.stdout.includes('CHANGED')) {
        const outBundle = join(tmp, 'out.bundle');
        await writeFile(outBundle, await sandbox.files.read(`${home}/out.bundle`, { format: 'bytes' }));
        await git(root, 'fetch', '-q', outBundle, `refs/heads/out:refs/heads/${branch}`);
        recovered = true;
      }
    } catch (e) {
      log('recovery failed:', scrub(e?.message));
      recoveryFailed = true;
    }
    const where = recovered ? `Changes are on local branch ${branch}.`
      : recoveryFailed ? 'Any changes could not be recovered and were lost when the sandbox closed.'
      : 'No changes were made.';

    if (failure || recoveryFailed) {
      if (!failure) return fail(`${text}\n\n${where}`);
      const code = failure.exitCode ?? 'none (timeout or sandbox error)';
      const stderr = String(failure.stderr ?? failure.message ?? '').slice(-4000);
      return fail(`Subagent failed, exit code ${code}.\n${stderr}\n${where}`);
    }
    return { content: [{ type: 'text', text: scrub(`${text}\n\n${where}`) }] };
  } catch (e) {
    log('error:', scrub(e?.message));
    return fail(`claude-cloud error: ${e?.message}`);
  } finally {
    await sandbox?.kill().catch(() => {});
    await git(root, 'update-ref', '-d', ref).catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
