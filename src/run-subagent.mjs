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
// `open` holds kept-open subagents by id: { sandbox, root, sha }.
export async function runSubagent(args, { createSandbox, env = process.env, cwd = process.cwd(), open = new Map() }) {
  const { prompt, model, subagent_type: agent, keep_open: keepOpen, session_id: sessionId, close } = args;
  const secrets = SECRETS.map((k) => env[k]).filter(Boolean);
  const scrub = (s) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), String(s ?? ''));
  const fail = (text) => ({ isError: true, content: [{ type: 'text', text: scrub(text) }] });

  if (sessionId !== undefined && !(typeof sessionId === 'string' && /^[0-9a-f]{8}$/.test(sessionId))) {
    return fail('invalid session_id: must match /^[0-9a-f]{8}$/');
  }
  const session = sessionId === undefined ? undefined : open.get(sessionId);
  if (sessionId !== undefined && !session) {
    return fail(`Subagent ${sessionId} is not open. It may have been closed or reached the 30-minute sandbox lifetime.`);
  }
  if (close) {
    if (!session) return fail('close requires session_id');
    open.delete(sessionId);
    await session.sandbox.kill().catch(() => {});
    return { content: [{ type: 'text', text: `Subagent ${sessionId} closed.` }] };
  }
  if (typeof prompt !== 'string' || !prompt) return fail('prompt is required');
  for (const [name, v] of [['model', model], ['subagent_type', agent]]) {
    if (v !== undefined && !(typeof v === 'string' && SAFE.test(v))) {
      return fail(`invalid ${name}: must match ${SAFE}`);
    }
  }

  let root = session?.root;
  if (!session) {
    try {
      root = await git(cwd, 'rev-parse', '--show-toplevel');
      await git(root, 'rev-parse', '--verify', 'HEAD');
    } catch {
      return fail('claude-cloud needs a git repository with at least one commit. Run `git init` and commit your files, then retry.');
    }
  }

  const id = sessionId ?? randomUUID().slice(0, 8);
  const ref = `refs/claude-cloud/${id}`;
  const branch = `claude-cloud/${id}`;
  const tmp = await mkdtemp(join(tmpdir(), 'claude-cloud-'));
  let sandbox = session?.sandbox;
  let keep = false;
  try {
    let sha = session?.sha;
    let home;
    if (session) {
      home = sandbox.home ?? '/home/user';
      await sandbox.files.write(`${home}/prompt.txt`, prompt);
    } else {
      // Snapshot tracked files (including uncommitted edits) without touching the worktree or index.
      sha = (await git(root, ...IDENT, 'stash', 'create')) || (await git(root, 'rev-parse', 'HEAD'));
      await git(root, 'update-ref', ref, sha);
      const inBundle = join(tmp, 'in.bundle');
      await git(root, 'bundle', 'create', inBundle, ref);

      const envs = {};
      // Prefer the subscription token; sending both would make Claude Code bill the API key.
      if (env.CLAUDE_CODE_OAUTH_TOKEN) envs.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
      else if (env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
      sandbox = await createSandbox(envs, LIFETIME_MS);
      home = sandbox.home ?? '/home/user';
      log(`sandbox up, id ${id}, ${args.description ?? ''}`);

      await sandbox.files.write(`${home}/in.bundle`, await readFile(inBundle));
      await sandbox.files.write(`${home}/prompt.txt`, prompt);
      await sandbox.commands.run(
        `git init -q repo && cd repo && git fetch -q ../in.bundle ${ref} && git checkout -q --detach ${sha}`,
        { cwd: home, timeoutMs: SETUP_MS },
      );
    }

    // model and agent were validated against SAFE, so they are safe inside the command string.
    const cmd = ['claude -p --dangerously-skip-permissions --output-format text',
      session && '--continue', model && `--model ${model}`, agent && `--agent ${agent}`, `< ${home}/prompt.txt`].filter(Boolean).join(' ');
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
    if (keepOpen) {
      keep = true;
      open.set(id, { sandbox, root, sha });
      const note = `Subagent ${id} is still open. Pass session_id "${id}" to send it another message, or close: true to end it.`;
      return { content: [{ type: 'text', text: scrub(`${text}\n\n${where}\n${note}`) }] };
    }
    return { content: [{ type: 'text', text: scrub(`${text}\n\n${where}`) }] };
  } catch (e) {
    log('error:', scrub(e?.message));
    return fail(`claude-cloud error: ${e?.message}`);
  } finally {
    if (!keep) {
      open.delete(id);
      await sandbox?.kill().catch(() => {});
    }
    await git(root, 'update-ref', '-d', ref).catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
