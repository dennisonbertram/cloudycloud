import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createStartQueue, MAX_START_TRIES } from './limits.mjs';
import { PROVIDER_KEY } from './config.mjs';
import { resolveProfile, gatewayConfig, claudeEnv, GATEWAY_PORT, MODEL } from './profiles.mjs';
import { createProgress, parseStream, statusLine, totalLine, STATUS_MAX } from './progress.mjs';

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
const POLL_MS = 3000;
const GATEWAY_WAIT_MS = 200_000;
const CANCEL_WAIT_MS = 15_000;
const IDENT = ['-c', 'user.name=claude-cloud', '-c', 'user.email=claude-cloud@localhost'];
const commitHint = (id) => `You are on branch claude-cloud/${id}, which tracks origin. After each meaningful step, commit with a short message and run git push. Your sandbox can disappear at any time; only pushed work survives. Never push to any other branch. Run every command in the foreground and wait for it to finish. Never end your turn while work is still running.`;

const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 1 << 28 }).then((r) => r.stdout.trim());
const log = (...a) => console.error('[claude-cloud]', ...a);

// Returns the https GitHub URL for an origin URL (https or git@github.com:), or undefined.
const githubUrl = (raw) => {
  const m = GITHUB_SSH.exec(raw);
  const url = m ? `https://github.com/${m[1]}/${m[2]}.git` : raw;
  return GITHUB_URL.test(url) ? url : undefined;
};
// Last lines of git's stderr with any user:password@ part of a URL removed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH_FAIL = /403|Permission to|denied|Authentication failed|could not read Username|invalid credentials/i;
const tail = (s) => String(s ?? '').replace(/:\/\/[^/@\s]+@/g, '://[redacted]@').trim().slice(-1500);

// deps: { createSandbox(envs), env, cwd, open: Map<id, agent>, tasks: Map<taskId, turn>, asTask, idleMs }.
// asTask is true when the MCP client can take a task answer (see server.mjs); then cloud_agent and cloud_agent_message
// answer with a task and the result arrives through getTask. Otherwise they answer at once and cloud_agent_wait collects.
// Agent: { id, description, status: queued|starting|running|idle|failed|stopped, result: {text, error, reported},
//          sandbox, home, root, sha, sessionId, model, agent, idleSince, turn (the latest), turns, timers... }.
// Turn (one claude run, and the MCP task for it): { id: 'cc-<agent>-t<n>', n, agent, status: working|completed|failed|cancelled,
//          progress, result, createdAt, updatedAt, cancelled, abort, done }.
function helpers(env) {
  const secrets = [...SECRETS, ...Object.keys(env).filter((k) => PROVIDER_KEY.test(k))].map((k) => env[k]).filter(Boolean);
  const scrub = (s) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), String(s ?? ''));
  const ok = (text) => ({ content: [{ type: 'text', text: scrub(text) }] });
  return { scrub, ok, fail: (text) => ({ ...ok(text), isError: true }) };
}
const ctxOf = (deps) => {
  deps.tasks ??= new Map();
  deps.queue ??= createStartQueue({ perMin: Number(deps.env?.CLAUDE_CLOUD_STARTS_PER_MIN) || 25 });
  return { ...deps, env: deps.env ?? process.env, ...helpers(deps.env ?? process.env) };
};
const active = (a) => a.status === 'queued' || a.status === 'starting' || a.status === 'running';

function wake(a) {
  const w = a.waiters.splice(0);
  for (const r of w) r();
}

// Kill the sandbox and forget the agent. Idempotent.
async function stop(a, open) {
  clearTimeout(a.idleTimer);
  a.cancelled = true;
  a.cancelQueue?.();
  if (open.get(a.id) === a) open.delete(a.id);
  a.status = 'stopped';
  if (a.turn?.status === 'working') endTurn(a.turn, 'cancelled', { text: 'Agent stopped.', error: false, reported: true });
  wake(a);
  await a.sandbox?.kill().catch(() => {});
}

function endTurn(t, status, result) {
  if (t.status !== 'working') return;
  t.status = status;
  t.result = result;
  t.updatedAt = Date.now();
  t.resolve();
}

function newTurn(a) {
  a.turns = (a.turns ?? 0) + 1;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const t = { id: `cc-${a.id}-t${a.turns}`, n: a.turns, agent: a, status: 'working', progress: createProgress(), createdAt: Date.now(), updatedAt: Date.now(), abort: new AbortController(), done, resolve };
  a.turn = t;
  return t;
}

function armIdle(a, ctx) {
  clearTimeout(a.idleTimer);
  a.idleSince = Date.now();
  a.idleTimer = setTimeout(() => { log(`agent ${a.id} idle, stopping`); stop(a, ctx.open); }, ctx.idleMs ?? IDLE_MS);
  a.idleTimer.unref?.();
}

// After a turn: push whatever the agent committed (never commits for it) and report what is left.
// The command always exits 0, so a throw means the sandbox itself is unreachable.
async function safetyPush(a, ctx) {
  const branch = `claude-cloud/${a.id}`;
  try {
    const push = async () => (await a.sandbox.commands.run(
      `if err=$(git push -q origin HEAD:refs/heads/${branch} 2>&1); then echo PUSHOK; else echo PUSHFAIL; printf '%s\n' "$err" | tail -n 8 | sed 's/^/ERR /'; fi;` +
      ` echo "SHA $(git rev-parse HEAD)"; git status --porcelain | head -20 | sed 's/^/ST /'; true`,
      { cwd: `${a.home}/repo`, timeoutMs: SETUP_MS },
    )).stdout;
    let out = await push();
    if (!out.includes('PUSHOK')) { await (ctx.sleep ?? sleep)(5000); out = await push(); } // one retry: GitHub rejects pushes transiently
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

// One claude run in the sandbox (first turn, or --resume), then a safety push. Output is stream-json, fed to t.progress as it arrives.
// Returns { text, error, gone, cancelled }. a.sessionId is updated from the final result event.
async function turn(a, message, ctx, t) {
  const { scrub } = ctx;
  try {
    await a.sandbox.files.write(`${a.home}/prompt.txt`, message);
  } catch (e) {
    return { error: true, gone: true, text: `The sandbox is no longer reachable (${scrub(e?.message)}). Only work the agent already pushed to origin claude-cloud/${a.id} survives.` };
  }
  // model, agent and session id are validated, so they are safe inside the command string.
  // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS stops Claude Code moving long commands to the background, which ends a one-shot -p turn.
  const cmd = [`${a.profile ? `${claudeEnv(a.profile)} ` : ''}CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 BASH_DEFAULT_TIMEOUT_MS=1680000 BASH_MAX_TIMEOUT_MS=1680000 claude -p`, a.sessionId && `--resume ${a.sessionId}`, '--dangerously-skip-permissions --output-format stream-json --verbose',
    `--append-system-prompt '${commitHint(a.id)}'`, !a.profile && a.model && `--model ${a.model}`, a.agent && `--agent ${a.agent}`,
    `< ${a.home}/prompt.txt`].filter(Boolean).join(' ');
  let stdout, failure;
  try {
    stdout = (await a.sandbox.commands.run(cmd, {
      cwd: `${a.home}/repo`, timeoutMs: AGENT_MS, signal: t.abort.signal, onStdout: (chunk) => t.progress.feed(chunk),
    })).stdout;
  } catch (e) {
    failure = e;
  }
  t.progress.end();
  const { where, failed } = await safetyPush(a, ctx);

  if (t.cancelled) return { cancelled: true, gone: failed, text: `Turn cancelled. The agent is still open.\n${where}\n${totalLine(t.progress)}` };
  if (failure) {
    const code = failure.exitCode ?? 'none (timeout or sandbox error)';
    const stderr = String(failure.stderr ?? failure.message ?? '').slice(-4000);
    return { error: true, gone: failed, text: `Subagent failed, exit code ${code}.\n${stderr}\n${where}\n${totalLine(t.progress)}` };
  }
  // A sandbox that does not stream still returns the whole output; parse that instead.
  if (!t.progress.final) {
    const whole = parseStream(stdout);
    whole.startedAt = t.progress.startedAt;
    t.progress = whole;
  }
  const j = t.progress.final;
  let text, error = false;
  if (!j) {
    text = `${String(stdout).slice(-4000)}\n\n(Could not parse claude's stream-json output, so this is the raw stdout.)`;
  } else if (typeof j.result !== 'string') {
    text = `Claude stopped without a result (${j.subtype ?? 'unknown reason'}).`;
    error = true;
  } else {
    text = j.result;
    error = j.is_error === true;
    if (j.session_id !== undefined) {
      if (typeof j.session_id === 'string' && SESSION.test(j.session_id)) a.sessionId = j.session_id;
      else { text = 'Sandbox returned an invalid session_id, so it was not used.'; error = true; }
    }
  }
  return { text: `${text}\n\n${where}\n${totalLine(t.progress)}`, error: error || failed };
}

const limitText = (e) => {
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/quota_exceeded/.test(s)) return `Provider machine limit reached (quota_exceeded) and still full after waiting in the start queue. Stop other agents or upgrade the plan. Provider message: ${e?.message}`;
  if (/rate_limited/.test(s)) return `Provider start rate limit reached (rate_limited) and still limited after ${MAX_START_TRIES} tries. Provider message: ${e?.message}`;
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
    // A profile worker gets only its provider key, never the Claude login. Otherwise prefer the subscription token;
    // sending both would make Claude Code bill the API key.
    if (a.profile) envs[a.profile.keyName] = env[a.profile.keyName];
    else if (env.CLAUDE_CODE_OAUTH_TOKEN) envs.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
    else if (env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    a.cancelQueue = () => ctx.queue.cancel(a);
    a.sandbox = await ctx.queue.create(a, () => createSandbox(envs));
    if (a.cancelled) { await a.sandbox.kill().catch(() => {}); throw new Error('cancelled'); }
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
    // All agents push the same new base history at once and GitHub sometimes rejects one, so retry.
    for (let n = 1; ; n++) {
      try {
        await a.sandbox.commands.run(`git push -q -u origin ${branch}`, repo);
        break;
      } catch (e) {
        const said = tail(e?.stderr ?? e?.message);
        if (AUTH_FAIL.test(said)) throw new Error(`The first push to origin ${branch} failed. Usual causes: the GH_TOKEN Instabox secret is missing (see docs/RUNBOOK.md, step 2.4) or the token has no write access to this repo. Git said: ${said}`);
        if (n === 3) throw new Error(`The first push to origin ${branch} failed after 3 attempts. Git said: ${said}`);
        await (ctx.sleep ?? sleep)(n === 1 ? 5000 : 15000);
      }
    }
    if (a.profile?.format === 'openai') await startGateway(a, ctx);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Starts LiteLLM in the sandbox so claude can talk to an OpenAI-format provider, and waits until it is healthy.
// The config names the key's environment variable (os.environ/NAME); the key itself is only in the sandbox environment.
async function startGateway(a, ctx) {
  const p = a.profile, sh = (cmd, timeoutMs) => a.sandbox.commands.run(cmd, { cwd: a.home, timeoutMs });
  await a.sandbox.files.write(`${a.home}/litellm.yaml`, gatewayConfig(p));
  await sh(`nohup uvx --from 'litellm[proxy]' litellm --config ${a.home}/litellm.yaml --port ${GATEWAY_PORT} > ${a.home}/gateway.log 2>&1 < /dev/null &`, SETUP_MS);
  const out = (await sh(
    `for i in $(seq 1 90); do curl -fsS -m 2 http://127.0.0.1:${GATEWAY_PORT}/health/liveliness >/dev/null 2>&1 && { echo GATEWAYOK; exit 0; }; sleep 2; done; echo GATEWAYFAIL; tail -n 30 ${a.home}/gateway.log 2>&1; true`,
    GATEWAY_WAIT_MS,
  )).stdout;
  if (!out.includes('GATEWAYOK')) {
    throw new Error(`The ${p.name} model gateway (LiteLLM) did not become healthy within 180 s. Log tail:\n${ctx.scrub(tail(out.replace('GATEWAYFAIL', '')))}`);
  }
}

// Background job for one turn. Never throws; records the outcome and wakes waiters.
async function work(a, message, first, ctx, t) {
  let r;
  try {
    if (first) await setup(a, ctx);
    a.status = 'running';
    r = await turn(a, message, ctx, t);
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
  endTurn(t, r.cancelled ? 'cancelled' : r.error ? 'failed' : 'completed', a.result);
  if (dead) await a.sandbox?.kill().catch(() => {});
  armIdle(a, ctx);
  wake(a);
}

// The progress line for a turn, safe to show: scrubbed, one line, at most STATUS_MAX characters.
function statusOf(t, ctx) {
  let m;
  if (t.status === 'working') {
    const a = t.agent, ahead = ctx.queue.ahead(a);
    m = a.status === 'queued' ? `queued for a machine (${ahead === undefined ? 'waiting to retry' : `${ahead} ahead`})`
      : a.status === 'starting' ? 'starting machine…' : statusLine(t.progress);
  }
  else if (t.status === 'completed') m = statusLine(t.progress);
  else m = `${t.status}: ${t.result?.text ?? ''}`;
  if (t.agent.profile) m = `[${t.agent.profile.name}] ${m}`;
  const one = ctx.scrub(m).replace(/\s+/g, ' ').trim();
  return one.length > STATUS_MAX ? `${one.slice(0, STATUS_MAX - 1)}…` : one;
}
const iso = (ms) => new Date(ms).toISOString();

// What cloud_agent and cloud_agent_message answer with in task mode.
function taskAnswer(t, ctx) {
  return {
    resultType: 'task', taskId: t.id, status: 'working', statusMessage: statusOf(t, ctx),
    createdAt: iso(t.createdAt), lastUpdatedAt: iso(Date.now()), ttlMs: null, pollIntervalMs: POLL_MS,
  };
}

// tasks/get. Returns undefined for an unknown task id. A finished task's text counts as reported, so cloud_agent_wait does not repeat it.
export function getTask(taskId, deps) {
  const ctx = ctxOf(deps);
  const t = ctx.tasks.get(taskId);
  if (!t) return undefined;
  const v = {
    resultType: 'complete', taskId: t.id, status: t.status, createdAt: iso(t.createdAt),
    lastUpdatedAt: iso(t.status === 'working' ? Date.now() : t.updatedAt), ttlMs: null, statusMessage: statusOf(t, ctx),
  };
  if (t.status === 'working') v.pollIntervalMs = POLL_MS;
  else t.result.reported = true;
  // Claude needs the agent id for cloud_agent_message and cloud_agent_stop, and the task result is all it sees.
  const text = `agent_id: ${t.agent.id} (turn ${t.n})\n\n${t.result?.text}`;
  if (t.status === 'completed') v.result = { content: [{ type: 'text', text }] };
  if (t.status === 'failed') v.error = { code: -32000, message: text, data: null };
  return v;
}

// tasks/cancel. Cancelling the first turn (cloud_agent) stops the whole agent and deletes its machine.
// Cancelling a later turn (cloud_agent_message) kills only that claude run; the agent stays open and idle.
// A finished task is returned unchanged. Returns undefined for an unknown task id.
export async function cancelTask(taskId, deps) {
  const ctx = ctxOf(deps);
  const t = ctx.tasks.get(taskId);
  if (!t) return undefined;
  if (t.status === 'working') {
    t.cancelled = true;
    if (t.n === 1) await stop(t.agent, ctx.open);
    else {
      t.abort.abort();
      let timer;
      await Promise.race([t.done, new Promise((r) => { timer = setTimeout(r, ctx.cancelWaitMs ?? CANCEL_WAIT_MS); })]);
      clearTimeout(timer);
    }
  }
  return getTask(taskId, deps);
}

// cloud_agent: returns at once; the sandbox starts in the background.
export async function runSubagent(args, deps) {
  const ctx = ctxOf(deps);
  const { fail, ok } = ctx;
  const { prompt, model, subagent_type: agent, description, profile: profileName } = args;
  if (typeof prompt !== 'string' || !prompt) return fail('prompt is required');
  for (const [name, v] of [['model', model], ['subagent_type', agent]]) {
    if (v === undefined) continue;
    const re = name === 'model' && profileName !== undefined ? MODEL : SAFE; // profile models may contain "/"
    if (!(typeof v === 'string' && re.test(v))) return fail(`invalid ${name}: must match ${re}`);
  }
  let profile;
  if (profileName !== undefined) {
    const r = resolveProfile(profileName, model, ctx.env);
    if (r.error) return fail(r.error);
    profile = r.ok;
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
  const a = { id, description: description ?? '', status: 'starting', root, origin, model, agent, profile, waiters: [], result: null, idleSince: Date.now() };
  ctx.open.set(id, a);
  const t = newTurn(a);
  ctx.tasks.set(t.id, t);
  work(a, prompt, true, ctx, t);
  if (ctx.asTask) return taskAnswer(t, ctx);
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
  const t = newTurn(a);
  ctx.tasks.set(t.id, t);
  work(a, message, false, ctx, t);
  if (ctx.asTask) return taskAnswer(t, ctx);
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
  const ctx = ctxOf(deps);
  const { ok, open } = ctx;
  if (!open.size) return ok('No agents.');
  return ok([...open.values()].map((a) =>
    `${a.id}  ${a.status}${a.profile ? `  profile ${a.profile.name}` : ''}  idle ${active(a) ? 0 : Math.floor((Date.now() - a.idleSince) / 60_000)} min  ${a.description}` +
    (a.turn ? `\n    ${a.turn.id}: ${statusOf(a.turn, ctx)}` : '')).join('\n'));
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
