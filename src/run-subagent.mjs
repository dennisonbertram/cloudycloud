import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const run = promisify(execFile);
const SAFE = /^[A-Za-z0-9._:-]+$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'INSTABOX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'];
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;
const GITHUB_SSH = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?$/;
const NO_ORIGIN = 'claude-cloud needs the repo to have an `origin` remote on github.com (https://github.com/owner/repo.git or git@github.com:owner/repo.git), because each agent pushes its own branch there. Add one with `git remote add origin https://github.com/OWNER/REPO.git`, then retry.';
const IDLE_MS = 60 * 60_000;
const AGENT_MS = 29 * 60_000;
const SETUP_MS = 120_000;
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1500;
const IDENT = ['-c', 'user.name=claude-cloud', '-c', 'user.email=claude-cloud@localhost'];
const commitHint = (id) => `You are on branch claude-cloud/${id}, which tracks origin. After each meaningful step, commit with a short message and run git push. Your sandbox can disappear at any time; only pushed work survives. Never push to any other branch.`;

const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 1 << 28 }).then((r) => r.stdout.trim());
const log = (...a) => console.error('[claude-cloud]', ...a);

// Returns the https GitHub URL for an origin URL (https or git@github.com:), or undefined.
const githubUrl = (raw) => {
  const m = GITHUB_SSH.exec(raw);
  const url = m ? `https://github.com/${m[1]}/${m[2]}.git` : raw;
  return GITHUB_URL.test(url) ? url : undefined;
};
// Last lines of git's stderr with any user:password@ part of a URL removed.
const tail = (s) => String(s ?? '').replace(/:\/\/[^/@\s]+@/g, '://[redacted]@').trim().slice(-1500);

// deps: { createSandbox(envs), env, cwd, open: Map<id, agent>, idleMs }.
// Agent: { id, description, status: starting|running|idle|failed|stopped, result: {text, error, reported},
//          sandbox, home, root, sha, sessionId, model, agent, idleSince, timers... }.
function helpers(env) {
  const secrets = SECRETS.map((k) => env[k]).filter(Boolean);
  const scrub = (s) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), String(s ?? ''));
  const ok = (text) => ({ content: [{ type: 'text', text: scrub(text) }] });
  return { scrub, ok, fail: (text) => ({ ...ok(text), isError: true }) };
}
const ctxOf = (deps) => ({ ...deps, env: deps.env ?? process.env, ...helpers(deps.env ?? process.env) });
const active = (a) => a.status === 'starting' || a.status === 'running';

function wake(a) {
  const w = a.waiters.splice(0);
  for (const r of w) r();
}

// Kill the sandbox and forget the agent. Idempotent.
async function stop(a, open) {
  clearTimeout(a.idleTimer);
  if (open.get(a.id) === a) open.delete(a.id);
  a.status = 'stopped';
  wake(a);
  await a.sandbox?.kill().catch(() => {});
}

function armIdle(a, ctx) {
  clearTimeout(a.idleTimer);
  a.idleSince = Date.now();
  a.idleTimer = setTimeout(() => { log(`agent ${a.id} idle, stopping`); stop(a, ctx.open); }, ctx.idleMs ?? IDLE_MS);
  a.idleTimer.unref?.();
}

// After a turn: push whatever the agent committed (never commits for it) and report what is left.
// The command always exits 0, so a throw means the sandbox itself is unreachable.
async function safetyPush(a) {
  const branch = `claude-cloud/${a.id}`;
  try {
    const out = (await a.sandbox.commands.run(
      `if err=$(git push -q origin HEAD:refs/heads/${branch} 2>&1); then echo PUSHOK; else echo PUSHFAIL; printf '%s\n' "$err" | tail -n 8 | sed 's/^/ERR /'; fi;` +
      ` echo "SHA $(git rev-parse HEAD)"; git status --porcelain | head -20 | sed 's/^/ST /'; true`,
      { cwd: `${a.home}/repo`, timeoutMs: SETUP_MS },
    )).stdout;
    const lines = out.split('\n');
    const paths = lines.filter((l) => l.startsWith('ST ')).map((l) => l.slice(6));
    const sha = lines.find((l) => l.startsWith('SHA '))?.slice(4, 11);
    const dirty = paths.length ? ` Uncommitted changes left in the sandbox (ask the agent to commit and push): ${paths.join(', ')}.` : '';
    if (out.includes('PUSHOK')) return { where: `Pushed to origin ${branch} at ${sha}. Fetch with: git fetch origin ${branch}.${dirty}` };
    const err = tail(lines.filter((l) => l.startsWith('ERR ')).map((l) => l.slice(4)).join('\n'));
    return { where: `Push failed: ${err}; the agent is still open, ask it to push.${dirty}` };
  } catch (e) {
    log('safety push failed:', e?.message);
    return { failed: true, where: `The sandbox could not be reached to push. Only work the agent already pushed to origin ${branch} survives.` };
  }
}

// One claude run in the sandbox (first turn, or --resume), then a safety push.
// Returns { text, error, gone }. a.sessionId is updated from the JSON reply.
async function turn(a, message, ctx) {
  const { scrub } = ctx;
  try {
    await a.sandbox.files.write(`${a.home}/prompt.txt`, message);
  } catch (e) {
    return { error: true, gone: true, text: `The sandbox is no longer reachable (${scrub(e?.message)}). Only work the agent already pushed to origin claude-cloud/${a.id} survives.` };
  }
  // model, agent and session id are validated, so they are safe inside the command string.
  const cmd = ['claude -p', a.sessionId && `--resume ${a.sessionId}`, '--dangerously-skip-permissions --output-format json',
    `--append-system-prompt '${commitHint(a.id)}'`, a.model && `--model ${a.model}`, a.agent && `--agent ${a.agent}`,
    `< ${a.home}/prompt.txt`].filter(Boolean).join(' ');
  let stdout, failure;
  try {
    stdout = (await a.sandbox.commands.run(cmd, { cwd: `${a.home}/repo`, timeoutMs: AGENT_MS })).stdout;
  } catch (e) {
    failure = e;
  }
  const { where, failed } = await safetyPush(a);

  let text = stdout, error = false;
  if (failure) {
    const code = failure.exitCode ?? 'none (timeout or sandbox error)';
    const stderr = String(failure.stderr ?? failure.message ?? '').slice(-4000);
    return { error: true, gone: failed, text: `Subagent failed, exit code ${code}.\n${stderr}\n${where}` };
  }
  try {
    const j = JSON.parse(stdout);
    if (typeof j?.result !== 'string') throw new Error('no result field');
    text = j.result;
    error = j.is_error === true;
    if (j.session_id !== undefined) {
      if (typeof j.session_id === 'string' && SESSION.test(j.session_id)) a.sessionId = j.session_id;
      else { text = 'Sandbox returned an invalid session_id, so it was not used.'; error = true; }
    }
  } catch {
    text = `${stdout}\n\n(Could not parse claude's JSON output, so this is the raw stdout.)`;
  }
  return { text: `${text}\n\n${where}`, error: error || failed };
}

const limitText = (e) => {
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/quota_exceeded/.test(s)) return 'Provider machine limit reached (quota_exceeded). Stop other agents or wait; nothing was retried.';
  if (/rate_limited/.test(s)) return 'Provider start rate limit reached (rate_limited). Start fewer agents at once; nothing was retried.';
};

// Sandbox creation, upload, repo setup and the first push. Runs in the background.
async function setup(a, ctx) {
  const { env, createSandbox } = ctx;
  const tmp = await mkdtemp(join(tmpdir(), 'claude-cloud-'));
  const branch = `claude-cloud/${a.id}`;
  try {
    // Snapshot tracked files (including uncommitted edits) without touching the worktree or index.
    a.sha = (await git(a.root, ...IDENT, 'stash', 'create')) || (await git(a.root, 'rev-parse', 'HEAD'));
    const ref = `refs/cc-keep/${a.id}`; // temporary: only so `git bundle` can name the snapshot
    const bundle = join(tmp, 'in.bundle');
    await git(a.root, 'update-ref', ref, a.sha);
    try {
      await git(a.root, 'bundle', 'create', bundle, ref);
    } finally {
      await git(a.root, 'update-ref', '-d', ref).catch(() => {});
    }
    const envs = {};
    // Prefer the subscription token; sending both would make Claude Code bill the API key.
    if (env.CLAUDE_CODE_OAUTH_TOKEN) envs.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
    else if (env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    a.sandbox = await createSandbox(envs);
    a.home = a.sandbox.home ?? '/home/user';
    log(`sandbox up, id ${a.id}, ${a.description}`);
    await a.sandbox.files.write(`${a.home}/in.bundle`, await readFile(bundle));
    // a.origin passed GITHUB_URL, which has no quote or shell character, so it is safe in single quotes.
    await a.sandbox.commands.run(
      `git init -q repo && cd repo && git config user.name claude-cloud && git config user.email claude-cloud@localhost &&` +
      ` git fetch -q ../in.bundle ${ref} && git checkout -q --detach ${a.sha} &&` +
      ` git remote add origin '${a.origin}' && git checkout -q -b ${branch}`,
      { cwd: a.home, timeoutMs: SETUP_MS },
    );
    const repo = { cwd: `${a.home}/repo`, timeoutMs: SETUP_MS };
    await a.sandbox.commands.run('gh auth setup-git', repo).catch((e) => {
      throw new Error(`Could not run \`gh auth setup-git\` in the sandbox (is gh installed there?): ${tail(e?.stderr ?? e?.message)}`);
    });
    await a.sandbox.commands.run(`git push -q -u origin ${branch}`, repo).catch((e) => {
      throw new Error(`The first push to origin ${branch} failed. Usual causes: the GH_TOKEN Instabox secret is missing (see docs/RUNBOOK.md, step 2.4) or the token has no write access to this repo. Git said: ${tail(e?.stderr ?? e?.message)}`);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Background job for one turn. Never throws; records the outcome and wakes waiters.
async function work(a, message, first, ctx) {
  let r;
  try {
    if (first) await setup(a, ctx);
    a.status = 'running';
    r = await turn(a, message, ctx);
    if (first && !r.error && !a.sessionId) r = { error: true, text: `${r.text}\n\nNo valid session_id came back, so the agent cannot be resumed.` };
  } catch (e) {
    log('error:', ctx.scrub(e?.message));
    r = { error: true, text: limitText(e) ?? `claude-cloud error: ${e?.message}` };
  }
  if (a.status === 'stopped') return;
  // A failed first turn cannot be resumed (no session id); a later turn fails the agent only when its sandbox is gone.
  const dead = first ? r.error : r.gone;
  a.result = { text: ctx.scrub(r.text), error: r.error, reported: false };
  a.status = dead ? 'failed' : 'idle';
  if (dead) await a.sandbox?.kill().catch(() => {});
  armIdle(a, ctx);
  wake(a);
}

// cloud_agent: returns at once; the sandbox starts in the background.
export async function runSubagent(args, deps) {
  const ctx = ctxOf(deps);
  const { fail, ok } = ctx;
  const { prompt, model, subagent_type: agent, description } = args;
  if (typeof prompt !== 'string' || !prompt) return fail('prompt is required');
  for (const [name, v] of [['model', model], ['subagent_type', agent]]) {
    if (v !== undefined && !(typeof v === 'string' && SAFE.test(v))) return fail(`invalid ${name}: must match ${SAFE}`);
  }
  let root;
  try {
    root = await git(deps.cwd ?? process.cwd(), 'rev-parse', '--show-toplevel');
    await git(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    return fail('claude-cloud needs a git repository with at least one commit. Run `git init` and commit your files, then retry.');
  }
  const origin = githubUrl(await git(root, 'config', '--get', 'remote.origin.url').catch(() => ''));
  if (!origin) return fail(NO_ORIGIN);
  const id = randomUUID().slice(0, 8);
  const a = { id, description: description ?? '', status: 'starting', root, origin, model, agent, waiters: [], result: null, idleSince: Date.now() };
  ctx.open.set(id, a);
  work(a, prompt, true, ctx);
  return ok(`agent_id: ${id}\nstatus: starting\nCall cloud_agent_wait with the agent_ids to get the result.`);
}

// cloud_agent_message: returns at once; the turn runs in the background.
export async function messageAgent({ agent_id: id, message } = {}, deps) {
  const ctx = ctxOf(deps);
  const { fail, ok } = ctx;
  if (typeof message !== 'string' || !message) return fail('message is required');
  const a = typeof id === 'string' ? ctx.open.get(id) : undefined;
  if (!a) return fail(`Agent ${id} is not open. It may have been stopped, been idle for 60 minutes, or never existed.`);
  if (active(a)) return fail(`Agent ${id} is still working (status ${a.status}). Wait for it with cloud_agent_wait; messages are not queued.`);
  if (a.status === 'failed') return fail(`Agent ${id} failed and cannot take messages. Call cloud_agent_wait for the error, then cloud_agent_stop.`);
  clearTimeout(a.idleTimer);
  a.status = 'running';
  work(a, message, false, ctx);
  return ok(`agent_id: ${id}\nstatus: running\nCall cloud_agent_wait with the agent_ids to get the reply.`);
}

// cloud_agent_wait: read-only. Waits for every listed agent to finish its current turn, or the timeout.
// Each result is returned once.
// Models sometimes pass one id as a string or as agent_id; accept those too.
const idList = (a) => [a.agent_ids ?? a.agent_id].flat().filter((x) => x !== undefined);

export async function waitAgents(args = {}, deps) {
  const ctx = ctxOf(deps);
  const ids = idList(args), t = args.timeout_seconds;
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) return ctx.fail('agent_ids must be a non-empty array of strings');
  const secs = Math.min(typeof t === 'number' && t > 0 ? t : WAIT_DEFAULT_S, WAIT_MAX_S);
  const agents = ids.map((id) => ctx.open.get(id));
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(r, secs * 1000); });
  await Promise.race([
    Promise.all(agents.map((a) => (a && active(a) ? new Promise((r) => a.waiters.push(r)) : null))),
    timeout,
  ]);
  clearTimeout(timer);
  const parts = ids.map((id, i) => {
    const a = agents[i];
    if (!a || a.status === 'stopped') return `## ${id}\nstatus: stopped\nNot open (stopped, idle for 60 minutes, or never existed).`;
    const head = `## ${id}${a.description ? ` (${a.description})` : ''}\nstatus: ${a.status}`;
    if (active(a) || !a.result) return head;
    if (a.result.reported) return `${head}\n(result already reported)`;
    a.result.reported = true;
    return `${head}\n${a.result.error ? 'ERROR: ' : ''}${a.result.text}`;
  });
  return ctx.ok(parts.join('\n\n'));
}

// cloud_agent_list: read-only.
export async function listAgents(_args, deps) {
  const { ok, open } = ctxOf(deps);
  if (!open.size) return ok('No agents.');
  return ok([...open.values()].map((a) =>
    `${a.id}  ${a.status}  idle ${active(a) ? 0 : Math.floor((Date.now() - a.idleSince) / 60_000)} min  ${a.description}`).join('\n'));
}

// cloud_agent_stop: idempotent.
export async function stopAgents(args = {}, deps) {
  const ctx = ctxOf(deps);
  const ids = idList(args);
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return ctx.fail('agent_ids must be an array of strings');
  const lines = await Promise.all(ids.map(async (id) => {
    const a = ctx.open.get(id);
    if (!a) return `${id}: not open (already stopped or never existed)`;
    await stop(a, ctx.open);
    return `${id}: stopped`;
  }));
  return ctx.ok(lines.join('\n') || 'No agent ids given.');
}

// Server shutdown: kill every open sandbox.
export const killAll = (open) => Promise.allSettled([...open.values()].map((a) => stop(a, open)));
