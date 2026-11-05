import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const SAFE = /^[A-Za-z0-9._:-]+$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'E2B_API_KEY', 'INSTABOX_API_KEY'];
const IDLE_MS = 60 * 60_000;
const CHECKPOINT_MS = 3 * 60_000;
const AGENT_MS = 29 * 60_000;
const SETUP_MS = 120_000;
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1500;
const IDENT = ['-c', 'user.name=claude-cloud', '-c', 'user.email=claude-cloud@localhost'];
const COMMIT_HINT = 'Commit your work with git after each meaningful step, at least every few minutes, with a short message. Your sandbox can disappear at any time and only committed work is recovered.';

const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 1 << 28 }).then((r) => r.stdout.trim());
const log = (...a) => console.error('[claude-cloud]', ...a);

// deps: { createSandbox(envs), env, cwd, open: Map<id, agent>, idleMs, checkpointMs }.
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

// Kill the sandbox, forget the agent, drop its local ref. Idempotent.
async function stop(a, open) {
  clearTimeout(a.idleTimer);
  if (open.get(a.id) === a) open.delete(a.id);
  a.status = 'stopped';
  wake(a);
  await a.sandbox?.kill().catch(() => {});
  await git(a.root, 'update-ref', '-d', `refs/cc-keep/${a.id}`).catch(() => {});
}

function armIdle(a, ctx) {
  clearTimeout(a.idleTimer);
  a.idleSince = Date.now();
  a.idleTimer = setTimeout(() => { log(`agent ${a.id} idle, stopping`); stop(a, ctx.open); }, ctx.idleMs ?? IDLE_MS);
  a.idleTimer.unref?.();
}

// Checkpoints run one at a time across all agents (Instabox caps concurrent exec calls per account).
let queue = Promise.resolve();
function schedule(a, ctx) {
  if (a.cp) return;
  const p = queue.then(() => checkpoint(a, ctx));
  queue = p;
  a.cp = p;
  p.then(() => { if (a.cp === p) a.cp = null; });
}

// Copy the working tree (uncommitted and untracked files included) to local claude-cloud/<id>-wip
// using a temporary index, so the agent's index, HEAD and branch are untouched. Never throws.
async function checkpoint(a, ctx) {
  if (!a.inTurn) return;
  const tmp = await mkdtemp(join(tmpdir(), 'claude-cloud-wip-'));
  try {
    const idx = `${a.home}/cc-wip-index`;
    const out = await a.sandbox.commands.run(
      `export GIT_INDEX_FILE=${idx}; git read-tree HEAD && git add -A && tree=$(git write-tree) && key="$tree $(git rev-parse HEAD)" || exit 1;` +
      ` if [ "$key" = "${a.wipKey ?? ''}" ]; then echo SAME; exit 0; fi;` +
      ` c=$(git commit-tree "$tree" -p HEAD -m wip) && git update-ref refs/cc/wip "$c" &&` +
      ` git bundle create ${a.home}/wip.bundle ^${a.sha} refs/cc/wip && echo "KEY $key"`,
      { cwd: `${a.home}/repo`, timeoutMs: SETUP_MS },
    );
    const key = out.stdout.match(/^KEY (.+)$/m)?.[1];
    if (!key || !a.inTurn) return;
    const bundle = join(tmp, 'wip.bundle');
    await writeFile(bundle, await a.sandbox.files.read(`${a.home}/wip.bundle`, { format: 'bytes' }));
    await git(a.root, 'fetch', '-q', bundle, `+refs/cc/wip:refs/heads/claude-cloud/${a.id}-wip`);
    a.wipKey = key;
  } catch (e) {
    log(`checkpoint of ${a.id} failed:`, ctx.scrub(e?.message));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Commit anything left in the sandbox and bring new commits back to the local branch.
// The branch only moves forward; if it was changed locally, the update goes to claude-cloud/<id>-<n>.
async function collect(a, { scrub }) {
  const branch = `claude-cloud/${a.id}`;
  const tmp = await mkdtemp(join(tmpdir(), 'claude-cloud-'));
  try {
    const out = await a.sandbox.commands.run(
      `git add -A && (git diff --cached --quiet || git ${IDENT.join(' ')} commit -q -m "claude-cloud: subagent changes");` +
      ` if [ "$(git rev-parse HEAD)" != "${a.sha}" ]; then git update-ref refs/heads/out HEAD &&` +
      ` git bundle create ${a.home}/out.bundle ^${a.sha} refs/heads/out && echo CHANGED; fi`,
      { cwd: `${a.home}/repo`, timeoutMs: SETUP_MS },
    );
    if (!out.stdout.includes('CHANGED')) return { where: 'No changes were made.' };
    const bundle = join(tmp, 'out.bundle');
    await writeFile(bundle, await a.sandbox.files.read(`${a.home}/out.bundle`, { format: 'bytes' }));
    await git(a.root, 'fetch', '-q', bundle, 'refs/heads/out');
    const tip = await git(a.root, 'rev-parse', 'FETCH_HEAD');
    let target = branch, note = '';
    const cur = await git(a.root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).catch(() => '');
    if (cur && !(await git(a.root, 'merge-base', '--is-ancestor', cur, tip).then(() => true, () => false))) {
      let n = 1;
      while (await git(a.root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}-${n}`).catch(() => '')) n++;
      target = `${branch}-${n}`;
      note = ` Local branch ${branch} was changed and the update is not a fast-forward, so it was left alone.`;
    }
    await git(a.root, 'update-ref', `refs/heads/${target}`, tip);
    await git(a.root, 'update-ref', `refs/cc-keep/${a.id}`, tip); // keeps objects for the next bundle
    a.sha = tip;
    return { where: `Changes are on local branch ${target}.${note}` };
  } catch (e) {
    log('recovery failed:', scrub(e?.message));
    return { failed: true, where: `Any changes could not be recovered. Latest work may be on claude-cloud/${a.id} or claude-cloud/${a.id}-wip.` };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// One claude run in the sandbox (first turn, or --resume) with periodic checkpoints, then change recovery.
// Returns { text, error, gone }. a.sessionId is updated from the JSON reply.
async function turn(a, message, ctx) {
  const { scrub } = ctx;
  try {
    await a.sandbox.files.write(`${a.home}/prompt.txt`, message);
  } catch (e) {
    return { error: true, gone: true, text: `The sandbox is no longer reachable (${scrub(e?.message)}). Latest work may be on claude-cloud/${a.id} or claude-cloud/${a.id}-wip.` };
  }
  // model, agent and session id are validated, so they are safe inside the command string.
  const cmd = ['claude -p', a.sessionId && `--resume ${a.sessionId}`, '--dangerously-skip-permissions --output-format json',
    `--append-system-prompt '${COMMIT_HINT}'`, a.model && `--model ${a.model}`, a.agent && `--agent ${a.agent}`,
    `< ${a.home}/prompt.txt`].filter(Boolean).join(' ');
  let stdout, failure;
  a.inTurn = true;
  const iv = setInterval(() => schedule(a, ctx), ctx.checkpointMs ?? CHECKPOINT_MS);
  iv.unref?.();
  try {
    stdout = (await a.sandbox.commands.run(cmd, { cwd: `${a.home}/repo`, timeoutMs: AGENT_MS })).stdout;
  } catch (e) {
    failure = e;
  } finally {
    clearInterval(iv);
    a.inTurn = false;
    await a.cp?.catch(() => {});
  }
  const { where, failed } = await collect(a, ctx);

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
  // The turn ended normally and its content is on the normal branch: the recovery copy is not needed.
  if (!error && !failed) {
    a.wipKey = null;
    await git(a.root, 'update-ref', '-d', `refs/heads/claude-cloud/${a.id}-wip`).catch(() => {});
  }
  return { text: `${text}\n\n${where}`, error: error || failed };
}

const limitText = (e) => {
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/quota_exceeded/.test(s)) return 'Provider machine limit reached (quota_exceeded). Stop other agents or wait; nothing was retried.';
  if (/rate_limited/.test(s)) return 'Provider start rate limit reached (rate_limited). Start fewer agents at once; nothing was retried.';
};

// Sandbox creation, upload and repo setup for the first turn. Runs in the background.
async function setup(a, ctx) {
  const { env, createSandbox } = ctx;
  const tmp = await mkdtemp(join(tmpdir(), 'claude-cloud-'));
  try {
    // Snapshot tracked files (including uncommitted edits) without touching the worktree or index.
    a.sha = (await git(a.root, ...IDENT, 'stash', 'create')) || (await git(a.root, 'rev-parse', 'HEAD'));
    const ref = `refs/cc-keep/${a.id}`;
    await git(a.root, 'update-ref', ref, a.sha);
    const bundle = join(tmp, 'in.bundle');
    await git(a.root, 'bundle', 'create', bundle, ref);
    const envs = {};
    // Prefer the subscription token; sending both would make Claude Code bill the API key.
    if (env.CLAUDE_CODE_OAUTH_TOKEN) envs.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
    else if (env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    a.sandbox = await createSandbox(envs);
    a.home = a.sandbox.home ?? '/home/user';
    log(`sandbox up, id ${a.id}, ${a.description}`);
    await a.sandbox.files.write(`${a.home}/in.bundle`, await readFile(bundle));
    await a.sandbox.commands.run(
      `git init -q repo && cd repo && git config user.name claude-cloud && git config user.email claude-cloud@localhost &&` +
      ` git fetch -q ../in.bundle ${ref} && git checkout -q --detach ${a.sha}`,
      { cwd: a.home, timeoutMs: SETUP_MS },
    );
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
  const id = randomUUID().slice(0, 8);
  const a = { id, description: description ?? '', status: 'starting', root, model, agent, waiters: [], result: null, idleSince: Date.now() };
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
