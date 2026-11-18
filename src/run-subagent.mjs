import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createStartQueue, MAX_START_TRIES, QUOTA_GIVE_UP_MS } from './limits.mjs';
import { planSnapshot, usageLine, parseMachine, parseSize, sizeLabel, offeredBy, planFee, TIERS, sizeCostLine, EXPENSIVE, PRICE } from './machine.mjs';
import { PROVIDER_KEY, DEFAULT_PROVIDER_KEY, proxySecrets, aptPackages } from './config.mjs';
import { loadMcp, checkServer, cleanEntry, isLiteralSecret, mcpFile, mcpConfigText, forHarness } from './mcpsync.mjs';
import { ownsRepo, toolBundle, toolInstallCmd } from './toolbundle.mjs';
import { resolveProfile, coordinatorKeys, profileHint, profileHost, gatewayConfig, claudeEnv, GATEWAY_PORT, MODEL, PI_VERSION, PI_PROVIDER, piModels, OMP_VERSION, ompModels, ompConfig, ompCommand } from './profiles.mjs';
import { guide, classify } from './errors.mjs';
import { createProgress, mcpLine, parseStream, statusLine, totalLine, modelLine, STATUS_MAX } from './progress.mjs';
import { createPiProgress, parsePiStream } from './progress-pi.mjs';
import { createOmpProgress, parseOmpStream } from './progress-omp.mjs';
import { createCodexProgress, parseCodexStream } from './progress-codex.mjs';
import { setupCodex, codexCommand, codexNextStep } from './harness-codex.mjs';
import { createLocalStream, pruneStreams, streamsDir } from './stream.mjs';
import { redact, redactText } from './events.mjs';
import { FIRST_RUN_SCRIPT } from './first-run.mjs';
import { MERGE_MCP_SCRIPT } from './worker-mcp.mjs';

const run = promisify(execFile);
const SAFE = /^[A-Za-z0-9._:-]+$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

// Seconds a worker machine lives: CLOUDY_CLOUD_WORKER_HOURS, default 6, at most the provider's TTL cap (hours).
export const workerSeconds = (env, maxTtlSeconds = 86_400) => {
  const h = Number(env.CLOUDY_CLOUD_WORKER_HOURS);
  return Math.max(60, Math.round((h > 0 ? Math.min(h, maxTtlSeconds / 3600) : 6) * 3600));
};
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;
const GITHUB_SSH = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?$/;
const NO_ORIGIN = guide('no_origin');
// A real key was about to go to a machine whose provider keeps keys off machines.
export const refused = (name) => Object.assign(new Error(`${name} is set as a real value, not as a proxy secret.\n${guide('key_on_machine_refused')}`), { code: 'key_on_machine_refused' });
const IDLE_MS = 60 * 60_000;
const AGENT_MS = 29 * 60_000;
const SETUP_MS = 120_000;
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1500;
const POLL_MS = 3000;
const GATEWAY_WAIT_MS = 200_000;
const CANCEL_WAIT_MS = 15_000;
const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_MS = 300_000;
const MAX_DEPTH = 3;
const MAX_AGENTS = 200;
const ROLES = ['worker', 'coordinator'];
const COORDINATOR_HINT = 'You are a coordinator. You can start your own cloud subagents with the cloud_agent tools. Never print, share, commit or send any API key or token you can see in the environment or in ~/.config/cloudy-cloud. Pass work to subagents only through the cloud_agent tools. No human is watching in real time. Do not stop to ask; choose the documented default and record each decision. If the reply of a subagent ends with a QUESTION: line, answer it with cloud_agent_message. Your workers are deleted as soon as your reply ends, even if they have not pushed, so never end your reply while a worker is running: call cloud_agent_wait on every worker you started, and merge or record its result first. Before you finish, stop your workers with cloud_agent_stop and push your work. If you run on a machine made by cloudy-cloud coordinator start, your last step is to run ~/cloudy-cloud/bin/cloudy-cloud coordinator finish; a nested coordinator just ends its reply and its parent stops it.';
const IDENT = ['-c', 'user.name=cloudy-cloud', '-c', 'user.email=cloudy-cloud@localhost'];
const commitHint = (id, deleteAt, serverTtl = true) => `You are on branch cloudy-cloud/${id}, which tracks origin. After each meaningful step, commit with a short message and run git push. Your sandbox can disappear at any time; only pushed work survives. Never push to any other branch. Run every command in the foreground and wait for it to finish. Never end your turn while work is still running. No human is available to answer questions. Make reasonable choices, write down any assumptions in your final reply, and keep going. Only if you are truly blocked, stop and end your reply with a line starting QUESTION: that states exactly what you need; whoever started you can answer with a follow-up message.${deleteAt ? ` Your machine is deleted ${serverTtl ? 'by the server ' : ''}at ${new Date(deleteAt).toISOString()}; push your work well before then.` : ''}`;

const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 1 << 28 }).then((r) => r.stdout.trim());
const log = (...a) => console.error('[cloudy-cloud]', ...a);

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
// `literals`: exact token values the user consented to put on the machines (see agentMcp); filled when an agent starts.
// Exact secret values to remove from any text: the known key names, provider keys, MCP tokens, plus consented literals.
const MCP_TOKEN = /^MCP_[A-Z0-9_]+_TOKEN$/;
export const secretValues = (env, keyName, literals = []) => [...[...SECRETS, keyName, ...Object.keys(env).filter((k) => PROVIDER_KEY.test(k) || MCP_TOKEN.test(k))].map((k) => env[k]).filter(Boolean), ...literals];
function helpers(env, literals, keyName, tool) {
  const scrub = (s) => secretValues(env, keyName, literals).reduce((t, v) => t.split(v).join('[redacted]'), String(s ?? ''));
  const ok = (text) => ({ content: [{ type: 'text', text: scrub(text) }] });
  return { scrub, ok, fail: (text, bare) => ({ ...ok(bare || /^What happened:/.test(text) ? text : `${text}\n${guide('invalid_args', { tool })}`), isError: true }) };
}
// The start queue paces every machine create of one server, so it must be one object for all tool calls.
// The pace is the env setting if set, else the plan's starts a minute less a 10 % reserve, else the provider default (25).
// q.learnPlan() reads the plan once (fire and forget from runSubagent); a failed read keeps the default.
export const startQueue = (env, provider, open, opts) => {
  let plan, learning;
  const pace = () => Number(env?.CLOUDY_CLOUD_STARTS_PER_MIN) || (plan?.startsPerMinute > 0 && Math.max(1, plan.startsPerMinute - Math.ceil(plan.startsPerMinute / 10))) || provider?.caps.startsPerMin || 25;
  // This server's other agents holding or creating a machine. Admission counts a start whose create is still in flight; the count shown to people (shown) counts only agents that own a machine.
  const live = (me, shown) => [...(open?.() ?? [])].filter((a) => a !== me && (a.status === 'running' || a.status === 'idle' || (a.status === 'starting' && !(shown && !a.sandbox)))).length;
  const q = createStartQueue({ perMin: pace, liveCount: live, maxRunning: () => plan?.maxRunning, tierName: () => plan?.tier, ...opts });
  q.plan = () => plan;
  q.learnPlan = () => (learning ??= Promise.resolve().then(() => provider?.plan?.()).then((p) => {
    if (!p) return;
    plan = p;
    q.poke(); // starts already waiting for the old, lower rate may go now
    const per = (n) => (n > 0 ? `${n}` : 'no limit');
    log(`${provider.name === 'instabox' ? 'Instabox' : provider.name} plan ${p.tier}: ${per(p.startsPerMinute)} starts/min (using ${pace()}), ${per(p.maxRunning)} running at once, sizes ${p.specs.map((x) => `${x.vcpus}x${x.memMiB / 1024}`).join(' ')}`);
  }).catch(() => {}));
  return q;
};
// One shared queue per server, built the same way for every caller (buildServer and the tool handlers).
export const sharedQueue = (deps) => (deps.queue ??= startQueue(deps.env, deps.provider, () => deps.open?.values()));
const ctxOf = (deps, tool) => {
  deps.tasks ??= new Map();
  sharedQueue(deps);
  deps.literals ??= new Set();
  return { ...deps, env: deps.env ?? process.env, ...helpers(deps.env ?? process.env, deps.literals, deps.provider?.keyName, tool) };
};
const hasMcp = (a) => Object.keys(a.mcp?.servers ?? {}).length > 0;
const harnessOf = (a) => a.profile?.harness ?? 'claude'; // 'claude' | 'pi' | 'omp' | 'codex'
const PROGRESS = { claude: createProgress, pi: createPiProgress, omp: createOmpProgress, codex: createCodexProgress };
const PARSE = { claude: parseStream, pi: parsePiStream, omp: parseOmpStream, codex: parseCodexStream };

// Consent path: a server whose token cannot go through an Instabox proxy secret is delivered only when its entry in
// mcp.json carries "cloudyCloudAllowLiteral": true (the user put it there on purpose; the real value then sits on the
// machine, in a mode-600 file). Off by default. The flag is not sent to the machine.
const ALLOW = 'cloudyCloudAllowLiteral';
const MCP_REF = /\$\{(MCP_[A-Z0-9_]+_TOKEN)\}/g;
function agentMcp(env, proxy = true) {
  const { servers, skipped, secrets } = loadMcp(env); // throws "Could not read <file>: ..."
  const out = { servers: { ...servers }, skipped: [], secrets: new Set(secrets), literal: [], values: new Set() };
  let raw;
  for (const x of skipped) {
    // Only a literal env or header value is consentable; secrets in a url or an argument have other reasons.
    if (!x.reason.startsWith('contains a secret value')) { out.skipped.push(x); continue; }
    raw ??= JSON.parse(readFileSync(mcpFile(env), 'utf8')).mcpServers;
    const e = raw[x.name];
    // Re-check with the literal env/header values swapped for a reference: any other problem still rejects the server.
    const mask = (m) => m && Object.fromEntries(Object.keys(m).map((k) => [k, '${MCP_X_TOKEN}']));
    const clean = e && typeof e === 'object' ? cleanEntry(e) : {}; // also drops the consent flag and any field the type does not use
    const sane = e?.[ALLOW] === true && checkServer(x.name, { ...clean, ...(clean.env && { env: mask(clean.env) }), ...(clean.headers && { headers: mask(clean.headers) }) }).ok;
    if (!sane) { out.skipped.push(x); continue; }
    out.servers[x.name] = clean;
    out.literal.push(x.name);
    for (const m of JSON.stringify(clean).matchAll(MCP_REF)) out.secrets.add(m[1]);
    // Every literal value is scrubbed from replies, events and the dashboard (exact match, so an opaque token is caught too).
    for (const [field, header] of [['env', false], ['headers', true]])
      for (const [k, v] of Object.entries(clean[field] ?? {})) if (isLiteralSecret(k, v, header)) [v, v.replace(/^Bearer /, '')].filter((t) => t.length >= 6).forEach((t) => out.values.add(t));
  }
  if (!proxy) {
    // No proxy secrets: a ${MCP_X_TOKEN} reference would be filled with the real value from this machine's environment.
    // That needs the same consent as a literal token; the GitHub token consent covers GH_TOKEN only.
    const refs = (e) => [...JSON.stringify(e).matchAll(MCP_REF)].map((m) => m[1]);
    raw ??= Object.keys(out.servers).some((n) => refs(out.servers[n]).length) ? JSON.parse(readFileSync(mcpFile(env), 'utf8')).mcpServers : {};
    out.secrets = new Set();
    for (const [name, e] of Object.entries(out.servers)) {
      if (!refs(e).length) continue;
      if (!out.literal.includes(name) && raw[name]?.[ALLOW] !== true) {
        delete out.servers[name];
        out.skipped.push({ name, reason: `its token would be copied from your environment to this machine; allow it with: cloudy-cloud mcp add ${name} --allow-literal` });
      } else {
        if (!out.literal.includes(name)) out.literal.push(name);
        refs(e).forEach((n) => { out.secrets.add(n); if (env[n]?.length >= 6) out.values.add(env[n]); });
      }
    }
  }
  out.secrets = [...out.secrets].sort();
  return out;
}
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
  a.emit?.({ type: 'status', status: 'stopped' });
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
  const t = { id: `cc-${a.id}-t${a.turns}`, n: a.turns, agent: a, status: 'working', progress: PROGRESS[harnessOf(a)](), createdAt: Date.now(), updatedAt: Date.now(), abort: new AbortController(), done, resolve };
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
  const branch = `cloudy-cloud/${a.id}`;
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
// MCP footer lines. Names and reasons only, never entries. `progress.mcp` (from the init event) says what connected.
function mcpFooter(a, t) {
  const m = a.mcp;
  if (!m || (!Object.keys(m.servers).length && !m.skipped.length)) return '';
  const names = Object.keys(m.servers);
  const lines = [];
  if (names.length) lines.push(mcpLine(t.progress) || `MCP servers: ${names.join(', ')}`);
  if (m.literal.length) lines.push(`MCP servers with a real token on the machine (you allowed it): ${m.literal.join(', ')}`);
  if (m.skipped.length) lines.push(`MCP servers skipped: ${m.skipped.map((x) => `${x.name} (${x.reason})`).join('; ')}`);
  return `\n${lines.join('\n')}`;
}

// Self-hosted: the user allowed the GitHub token on their own machine, so every reply says where it is.
const tokenLine = (a) => a.tokenOnBox ? `\nGitHub token: on your machine ${a.tokenOnBox} (you allowed it)` : '';
const totals = (a, t) => `${modelLine(t.progress, a.profile && { model: a.profile.model, host: profileHost(a.profile), name: a.profile.name })}\n${totalLine(t.progress, { cost: !a.profile })}${tokenLine(a)}${mcpFooter(a, t)}`;

// Raw stream of every turn, kept on the machine (tee) next to meta.json; the laptop keeps a redacted copy (createLocalStream).
// The harness exit code goes through a file because the pipe to tee hides it; `umask 077` only covers the stream files.
const STREAM_DIR = '$HOME/.config/cloudy-cloud/stream';
// A missing or empty exit file (the write failed) exits 1, never tee's status.
export const teed = (cmd, n) => `D=${STREAM_DIR}; (umask 077; mkdir -p $D && : >> $D/t${n}.jsonl) && ({ ${cmd}; echo $? > $D/t${n}.exit; }) | tee -a $D/t${n}.jsonl; s=$(cat $D/t${n}.exit 2>/dev/null); exit \${s:-1}`;
// meta.json on the machine, best effort: the first write may fail before the folder exists; the one after the turn lands.
async function writeMeta(a, ctx) {
  try {
    const meta = { agent: a.id, description: redact(ctx.scrub(a.description)).slice(0, 200), role: a.role, profile: a.profile?.name, model: a.profile ? a.profile.model : a.model, parent: ctx.owner, branch: `cloudy-cloud/${a.id}`, turns: a.turnMeta };
    await a.sandbox.files.write(`${a.home}/.config/cloudy-cloud/stream/meta.json`, `${JSON.stringify(meta)}\n`);
  } catch { /* meta is best effort */ }
}

async function turn(a, message, ctx, t) {
  const { scrub } = ctx;
  try {
    await a.sandbox.files.write(`${a.home}/prompt.txt`, message);
  } catch (e) {
    return { error: true, gone: true, text: `The sandbox is no longer reachable (${scrub(e?.message)}). Only work the agent already pushed to origin cloudy-cloud/${a.id} survives.` };
  }
  // model, agent and session id are validated, so they are safe inside the command string.
  // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS stops Claude Code moving long commands to the background, which ends a one-shot -p turn.
  // A coordinator runs through the cloudy-cloud launcher, which passes its own --append-system-prompt. Its extra
  // instructions go to the launcher in CLOUDY_CLOUD_EXTRA_PROMPT instead of a second flag, so neither is dropped.
  const coord = a.role === 'coordinator';
  const hint = `${commitHint(a.id, a.deleteAt, a.serverTtl)}${a.profile ? ` ${profileHint(a.profile)}` : ''}${coord ? ` ${COORDINATOR_HINT}` : ''}`;
  // A Claude worker starts with one merged MCP file and --strict-mcp-config, so a repo's .mcp.json is never loaded: the image's
  // servers except `instabox` (no sign-in on the box) plus the shared ones (#145). A coordinator keeps its own flags.
  const worker = !coord && harnessOf(a) === 'claude';
  const merge = `node -e '${MERGE_MCP_SCRIPT.replaceAll("'", "'\\''")}' $D/mcp.json ${a.home}/.config/cloudy-cloud/mcp.json || (umask 077; rm -f $D/mcp.json; echo '{"mcpServers":{}}' > $D/mcp.json);`;
  const cmd = [worker && merge, `${a.profile ? `${claudeEnv(a.profile)} ` : ''}CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 BASH_DEFAULT_TIMEOUT_MS=1680000 BASH_MAX_TIMEOUT_MS=1680000 ${coord ? `CLOUDY_CLOUD_EXTRA_PROMPT='${hint}' ${a.home}/cloudy-cloud/bin/cloudy-cloud` : 'claude'} -p`, a.sessionId && `--resume ${a.sessionId}`, '--dangerously-skip-permissions --output-format stream-json --verbose',
    worker ? '--mcp-config $D/mcp.json --strict-mcp-config' : hasMcp(a) && harnessOf(a) === 'claude' && `--mcp-config ${a.home}/.config/cloudy-cloud/mcp.json --strict-mcp-config`,
    !coord && `--append-system-prompt '${hint}'`, !a.profile && a.model && `--model ${a.model}`, a.agent && `--agent ${a.agent}`,
    `< ${a.home}/prompt.txt`].filter(Boolean).join(' ');
  // pi reads the prompt from stdin (docs: "Piped stdin: prepend its contents to the first prompt") and resumes with --session <id>.
  const piCmd = `PI_CODING_AGENT_DIR=${a.home}/pi-agent PATH=${a.home}/.local/bin:$PATH pi --mode json --provider ${PI_PROVIDER} --model ${a.profile?.model} ${a.sessionId ? `--session ${a.sessionId} ` : ''}--append-system-prompt '${hint}' < ${a.home}/prompt.txt`;
  let stdout, failure;
  (a.turnMeta ??= []).push(t.meta = { n: t.n, startedAt: Date.now() });
  if (!a.pruned) { a.pruned = true; pruneStreams(streamsDir(ctx.env)); }
  await writeMeta(a, ctx);
  const local = createLocalStream(join(streamsDir(ctx.env), a.id, `t${t.n}.jsonl`), { scrub });
  try {
    const ompCmd = harnessOf(a) === 'omp' && ompCommand(a.profile, { home: a.home, sessionId: a.sessionId, hint });
    const codexCmd = harnessOf(a) === 'codex' && codexCommand(a.profile, { home: a.home, sessionId: a.sessionId, hint });
    stdout = (await a.sandbox.commands.run(teed(ompCmd || codexCmd || (harnessOf(a) === 'pi' ? piCmd : cmd), t.n), {
      cwd: `${a.home}/repo`, timeoutMs: AGENT_MS, signal: t.abort.signal, onStdout: (chunk) => { local.write(chunk); t.progress.feed(chunk); if (t.progress.step !== t.lastStep) a.emit?.({ type: 'progress', text: (t.lastStep = t.progress.step) }); },
    })).stdout;
  } catch (e) {
    failure = e;
  }
  t.progress.end();
  local.end();
  Object.assign(t.meta, { endedAt: Date.now(), exit: failure ? (failure.exitCode ?? null) : 0 });
  await writeMeta(a, ctx);
  const { where, failed } = await safetyPush(a, ctx);

  if (t.cancelled) return { cancelled: true, gone: failed, text: `Turn cancelled. The agent is still open.\n${where}\n${totals(a, t)}` };
  if (failure) {
    const code = failure.exitCode ?? 'none (timeout or sandbox error)';
    // omp and codex exit 1 with the error in their own events; show that rather than an empty stderr.
    const h = harnessOf(a), f = (h === 'omp' || h === 'codex') && (t.progress.final ?? PARSE[h](failure.stdout ?? '').final);
    const said = f?.is_error && typeof f.result === 'string' ? `${f.result}\n${h === 'codex' ? codexNextStep(f.result) : ''}\n` : '';
    const stderr = `${said}${String(failure.stderr ?? failure.message ?? '')}`.slice(-4000);
    return { error: true, gone: failed, text: `Subagent failed, exit code ${code}.\n${stderr}\n${where}\n${totals(a, t)}` };
  }
  // A sandbox that does not stream still returns the whole output; parse that instead.
  if (!t.progress.final) {
    const whole = PARSE[harnessOf(a)](stdout);
    whole.startedAt = t.progress.startedAt;
    t.progress = whole;
  }
  const j = t.progress.final;
  let text, error = false;
  if (!j) {
    text = `${String(stdout).slice(-4000)}\n\n(Could not parse the agent's JSON output, so this is the raw stdout.)`;
  } else if (typeof j.result !== 'string') {
    text = `The agent stopped without a result (${j.subtype ?? 'unknown reason'}).`;
    error = true;
  } else {
    text = j.result;
    error = j.is_error === true;
    if (j.session_id !== undefined) {
      if (typeof j.session_id === 'string' && SESSION.test(j.session_id)) a.sessionId = j.session_id;
      else { text = 'Sandbox returned an invalid session_id, so it was not used.'; error = true; }
    }
  }
  return { text: `${text}\n\n${where}\n${totals(a, t)}`, error: error || failed, pushed: where.startsWith('Pushed to') };
}

// Stay 1 MiB under the provider's upload limit. Over that, upload only the commits GitHub lacks.
const BUNDLE_MARGIN = 1024 * 1024;

const limitText = (e, plan, kind) => {
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`;
  const waitedQuota = Math.round(QUOTA_GIVE_UP_MS / 60_000); // minutes the queue already retried quota and concurrency limits
  const waitedRate = Math.round(((e?.retryAfterSeconds ?? e?.retryAfter) > 0 ? (e.retryAfterSeconds ?? e.retryAfter) : 60) * ((MAX_START_TRIES - 1) * MAX_START_TRIES / 2) / 60); // backoff 1x, 2x, 3x ... between the tries
  if (e?.code === 'machine_not_on_plan') return `${guide('machine_not_on_plan', { plan, kind })}\nProvider message: ${e?.message}`;
  if (/concurrency_limit/.test(s)) return `${guide('concurrency_limit', { plan, waited: waitedQuota })}\nProvider message: ${e?.message}`;
  if (/quota_exceeded/.test(s)) return `${guide('quota_exceeded', { plan, waited: waitedQuota })}\nProvider message: ${e?.message}`;
  if (/rate_limited/.test(s)) return `${guide('rate_limited', { plan, waited: waitedRate })}\n(Still limited after ${MAX_START_TRIES} tries.) Provider message: ${e?.message}`;
};

// Label values: letters, digits, "_", "." and "-" only, at most 60 characters, so no provider rejects them.
const labelValue = (v) => String(v ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
// What `cloud_agent_list {all: true}` and the dashboard read. The description is redacted first; owner and purpose are added by createSandbox.
const machineLabels = (a, ctx) => Object.fromEntries(Object.entries({ role: a.role, kind: a.kind.name === 'linux' ? '' : a.kind.label, size: a.size?.label, profile: a.profile?.name ?? 'claude', parent: ctx.owner, agent: a.id, description: ctx.scrub(a.description) })
  .map(([k, v]) => [k, labelValue(v)]).filter(([, v]) => v));

// Only the linux image is known to carry the agent tools; any other kind must prove it before work starts.
async function checkTools(a) {
  const names = ['git', 'gh', 'node', ...(harnessOf(a) === 'claude' ? ['claude'] : [])];
  // Each tool is checked alone and must resolve to an executable file: one aggregate exit status, aliases and functions all hide a missing tool.
  const probe = `for t in ${names.join(' ')}; do p=$(command -v "$t" 2>/dev/null); case "$p" in /*) [ -x "$p" ] || echo "$t";; *) echo "$t";; esac; done`;
  let out;
  try { out = (await a.sandbox.commands.run(probe, { cwd: a.home, timeoutMs: SETUP_MS })).stdout; } catch (e) { out = e?.stdout; }
  const missing = String(out ?? '').split('\n').map((l) => l.trim()).filter((l) => names.includes(l));
  if (missing.length) throw Object.assign(new Error(`${a.kind.label} machine lacks ${missing.join(', ')}`), { guideText: guide('machine_missing_tools', { kind: a.kind.label, tools: missing.join(', ') }) });
}

// Sandbox creation, upload, repo setup and the first push. Runs in the background.
async function setup(a, ctx) {
  const { env, provider } = ctx;
  const createSandbox = ctx.createSandbox ?? ((envs, { deleteAfterSeconds, secrets, role, kind, size }, labels) => provider.create({ image: 'agent-browser', kind: kind ?? parseMachine(), ...(size && { size }), envs, labels: { purpose: 'cloudy-cloud', owner: ctx.owner, ...labels }, ttlSeconds: deleteAfterSeconds, secrets: secrets ?? [], ...(role && { role }) })); // role is an option, not a label: Instabox's wire request stays the same
  if (a.mcpError) throw new Error(a.mcpError);
  const tmp = await mkdtemp(join(tmpdir(), 'cloudy-cloud-'));
  const branch = `cloudy-cloud/${a.id}`;
  try {
    // Snapshot tracked files (including uncommitted edits) without touching the worktree or index.
    // Many agents starting together can collide on index.lock here; wait and retry.
    let snap;
    for (let i = 1; ; i++) {
      try { snap = await git(a.root, ...IDENT, 'stash', 'create'); break; } catch (e) {
        if (i >= 8 || !/index\.lock|could not write index/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`)) throw e;
        await new Promise((r) => setTimeout(r, 100 * i));
      }
    }
    a.sha = snap || (await git(a.root, 'rev-parse', 'HEAD'));
    const ref = `refs/cc-keep/${a.id}`; // temporary: only so `git bundle` can name the snapshot
    const bundle = join(tmp, 'in.bundle');
    await git(a.root, 'update-ref', ref, a.sha);
    let prereqs = []; // commits a thin bundle needs from GitHub; empty means the bundle is full
    let data;
    const max = ctx.bundleMax ?? provider.caps.uploadMaxBytes - BUNDLE_MARGIN;
    try {
      await git(a.root, 'bundle', 'create', bundle, ref);
      data = await readFile(bundle);
      if (data.length > max) {
        const tooBig = () => new Error(`The uncommitted/unpushed changes are too large to upload (${data?.length ?? 0} bytes, limit ${max}). Push the branch to GitHub first, then start the agent again.`);
        // The bundle header lists each prerequisite commit on a line starting with "-".
        const thin = await git(a.root, 'bundle', 'create', bundle, ref, '--not', '--remotes=origin').then(() => true, (e) => {
          if (/empty bundle/i.test(`${e?.stderr ?? ''}`)) return false; // everything is already on GitHub
          throw e;
        });
        data = thin ? await readFile(bundle) : null;
        if (thin) prereqs = data.toString('latin1', 0, data.indexOf('\n\n')).split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1, 41));
        else prereqs = [a.sha];
        if (!prereqs.length || data?.length > max) throw tooBig();
      }
    } finally {
      await git(a.root, 'update-ref', '-d', ref).catch(() => {});
    }
    const envs = {};
    // A profile worker gets only its provider key, never the Claude login. Otherwise prefer the subscription token;
    // sending both would make Claude Code bill the API key.
    // With proxy secrets (Instabox) a key named in CLOUDY_CLOUD_PROXY_SECRETS goes as a secret name; the machine sees a placeholder.
    const named = proxySecrets(env);
    const proxied = provider.caps.hasProxySecrets ? named : new Set();
    const keyName = a.profile ? a.profile.keyName : ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].find((n) => env[n] || named.has(n));
    const keySecrets = [];
    if (keyName && proxied.has(keyName)) keySecrets.push(keyName);
    else if (keyName && !env[keyName]) throw new Error(`${keyName} is only named in CLOUDY_CLOUD_PROXY_SECRETS, and provider ${provider.name} cannot attach proxy secrets. Put ${keyName}=... in ~/.config/cloudy-cloud/env, or use the Instabox provider and store it as a secret.`);
    else if (keyName && provider.caps.hasProxySecrets) throw refused(keyName); // never copy a real key to such a machine
    else if (keyName) envs[keyName] = env[keyName]; // a provider without proxy secrets (self-hosted) keeps the env-file path
    // LiteLLM refuses to start without a master key; the worker uses the same random key to reach it.
    if (a.profile?.format === 'openai' && harnessOf(a) === 'claude') envs.LITELLM_MASTER_KEY = `sk-${randomBytes(24).toString('hex')}`;
    if (a.role === 'coordinator') Object.assign(envs, { CLOUDY_CLOUD_DEPTH: String(a.depth), CLOUDY_CLOUD_MAX_DEPTH: String(a.maxDepth), CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION: String(a.maxAgents) });
    const coord = a.role === 'coordinator' ? coordinatorKeys(env, provider, { single: true }) : { secrets: [] };
    if (coord.legacy?.length) throw refused(coord.legacy[0]);
    a.cancelQueue = () => ctx.queue.cancel(a);
    a.sandbox = await ctx.queue.create(a, () => {
      const deleteAfterSeconds = workerSeconds(env, provider.caps.maxTtlSeconds);
      a.deleteAt = Date.now() + deleteAfterSeconds * 1000; // the server deletes the machine then, whatever happens to this process
      const secrets = [...new Set([...keySecrets, ...coord.secrets, ...(hasMcp(a) ? a.mcp.secrets : [])])];
      return createSandbox(envs, { deleteAfterSeconds, ...(a.kind.name !== 'linux' && { kind: a.kind }), ...(a.size && { size: a.size }), ...(a.role === 'coordinator' && { role: 'coordinator' }), ...(secrets.length && { secrets }) }, machineLabels(a, ctx));
    });
    if (a.cancelled) { await a.sandbox.kill().catch(() => {}); throw new Error('cancelled'); }
    a.home = a.sandbox.home ?? '/home/user';
    a.emit?.({ type: 'machine', machine: a.sandbox.id, deleteAt: a.deleteAt });
    log(`sandbox up, id ${a.id}, ${a.description}`);
    if (a.kind.name !== 'linux') await checkTools(a);
    if (data) await a.sandbox.files.write(`${a.home}/in.bundle`, data);
    const repo = { cwd: `${a.home}/repo`, timeoutMs: SETUP_MS };
    const ghAuth = () => a.sandbox.commands.run('gh auth setup-git', repo).catch((e) => {
      throw new Error(`Could not run \`gh auth setup-git\` in the sandbox (is gh installed there?): ${tail(e?.stderr ?? e?.message)}`);
    });
    const init = `git init -q repo && cd repo && git config user.name cloudy-cloud && git config user.email cloudy-cloud@localhost`;
    // a.origin passed GITHUB_URL, which has no quote or shell character, so it is safe in single quotes.
    if (!prereqs.length) {
      await a.sandbox.commands.run(
        `${init} && git fetch -q ../in.bundle ${ref} && git checkout -q --detach ${a.sha} &&` +
        ` git remote add origin '${a.origin}' && git checkout -q -b ${branch}`,
        { cwd: a.home, timeoutMs: SETUP_MS },
      );
      await ghAuth();
    } else {
      // Thin bundle: git must be logged in to GitHub before it can fetch the commits the bundle builds on.
      await a.sandbox.commands.run(`${init} && git remote add origin '${a.origin}'`, { cwd: a.home, timeoutMs: SETUP_MS });
      await ghAuth();
      await a.sandbox.commands.run(
        `git fetch -q origin ${prereqs.join(' ')}${data ? ` && git fetch -q ../in.bundle ${ref}` : ''} && git checkout -q --detach ${a.sha} && git checkout -q -b ${branch}`,
        repo,
      );
    }
    // All agents push the same new base history at once and GitHub sometimes rejects one, so retry.
    for (let n = 1; ; n++) {
      try {
        await a.sandbox.commands.run(`git push -q -u origin ${branch}`, repo);
        break;
      } catch (e) {
        const said = tail(e?.stderr ?? e?.message);
        if (AUTH_FAIL.test(said) && !provider.caps.hasProxySecrets) throw new Error(`The first push to origin ${branch} failed. ${provider.text.githubTokenHelp} Also check that the token has write access to this repo. Git said: ${said}`);
        if (AUTH_FAIL.test(said)) throw new Error(`The first push to origin ${branch} failed. Usual causes: the GH_TOKEN Instabox secret is missing (see https://github.com/dennisonbertram/cloudycloud/blob/HEAD/docs/RUNBOOK.md, step 2.4) or the token has no write access to this repo. Git said: ${said}`);
        if (n === 3) throw new Error(`The first push to origin ${branch} failed after 3 attempts. Git said: ${said}`);
        await (ctx.sleep ?? sleep)(n === 1 ? 5000 : 15000);
      }
    }
    const apt = aptPackages(env).list; // validated at start
    if (apt.length) await a.sandbox.commands.run(`sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${apt.join(' ')}`, { cwd: a.home, timeoutMs: INSTALL_MS }).catch((e) => { throw new Error(`Could not install the apt packages ${apt.join(' ')} on the worker: ${ctx.scrub(tail(e?.stderr ?? e?.message))}`); });
    if (a.role === 'coordinator') await installCoordinator(a, ctx, envs);
    if (hasMcp(a) && harnessOf(a) !== 'codex') { // codex gets its servers in config.toml (setupCodex). References only, except servers the user allowed to carry a real value
      // pi and omp read mcp.json from their agent dir (PI_CODING_AGENT_DIR), written here; Claude reads the other one.
      const dir = { pi: `${a.home}/pi-agent`, omp: `${a.home}/omp-agent` }[harnessOf(a)] ?? `${a.home}/.config/cloudy-cloud`;
      // The file may hold a real token. files.write of the SDK sends it to a temp file beside the target and renames it,
      // with the default umask, so the file could briefly be mode 644. So the folder is made mode 700 first (nobody else
      // can enter it, whatever the file mode) and an empty mode-600 file exists before the write; the chmod after is a
      // second guard. The token travels in the write body, never on a command line.
      await a.sandbox.commands.run(`umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && : > ${dir}/mcp.json`, { cwd: a.home, timeoutMs: SETUP_MS });
      await a.sandbox.files.write(`${dir}/mcp.json`, mcpConfigText(a.mcp.servers));
      await a.sandbox.commands.run(`chmod 600 ${dir}/mcp.json`, { cwd: a.home, timeoutMs: SETUP_MS });
    }
    if (harnessOf(a) === 'pi') await setupPi(a, ctx);
    else if (harnessOf(a) === 'omp') await setupOmp(a, ctx);
    else if (harnessOf(a) === 'codex') await setupCodex(a, ctx, { tail, installMs: INSTALL_MS, setupMs: SETUP_MS });
    else if (a.profile?.format === 'openai') await startGateway(a, ctx);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Puts cloudy-cloud on a coordinator's machine, at the commit the laptop runs, with the keys it needs in a mode-600 env file.
// The keys go through files.write, never through a command string.
async function installCoordinator(a, ctx, envs) {
  const { env } = ctx, sh = (cmd, timeoutMs = SETUP_MS) => a.sandbox.commands.run(cmd, { cwd: a.home, timeoutMs });
  const b = toolBundle(a.tool.root); // the laptop's exact cloudy-cloud, pushed or not
  await a.sandbox.files.write(`${a.home}/cloudy-cloud.bundle`, b.data);
  await sh(toolInstallCmd(b, `${a.home}/cloudy-cloud.bundle`, a.tool.origin));
  await sh('mkdir -p .claude/skills && ln -sfn ~/cloudy-cloud/skills/cloud-fleet .claude/skills/cloud-fleet'); // the fleet skill, at the parent's commit
  await sh(`node -e '${FIRST_RUN_SCRIPT.replaceAll("'", "'\\''")}'`); // no bypass confirmation or folder-trust dialog can wait there (#88)
  await sh('cd cloudy-cloud && npm install --no-audit --no-fund', INSTALL_MS).catch((e) => { throw new Error(`npm install failed in the sandbox: ${tail(e?.stderr ?? e?.message)}`); });
  // Keys named in CLOUDY_CLOUD_PROXY_SECRETS were attached at create time; the file holds their names and the settings only.
  // The machine gets no CLOUDY_CLOUD_PROVIDER, so it loads the default provider (Instabox) and reads its key from the placeholder.
  // A provider may instead say which of its own names go in and add fixed lines (self-hosted: local mode, no SSH key, #41).
  const { lines } = coordinatorKeys(env, ctx.provider, { single: true });
  lines.push(`CLOUDY_CLOUD_DEPTH=${a.depth}`, `CLOUDY_CLOUD_MAX_DEPTH=${a.maxDepth}`, `CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION=${a.maxAgents}`);
  const dir = `${a.home}/.config/cloudy-cloud`;
  await sh(`mkdir -p ${dir}`);
  await a.sandbox.files.write(`${dir}/env`, `${lines.join('\n')}\n`);
  await sh(`chmod 600 ${dir}/env`);
}

// Installs pinned pi under ~/.local (no sudo needed, whatever the global npm prefix is) and writes its provider config.
// The config names the key's environment variable; the key itself is only in the sandbox environment.
async function setupPi(a, ctx) {
  const sh = (cmd, timeoutMs) => a.sandbox.commands.run(cmd, { cwd: a.home, timeoutMs });
  await sh(`mkdir -p ${a.home}/pi-agent && npm install -g --ignore-scripts --prefix ${a.home}/.local @earendil-works/pi-coding-agent@${PI_VERSION}`, INSTALL_MS)
    .catch((e) => { throw new Error(`Could not install pi in the sandbox: ${ctx.scrub(tail(e?.stderr ?? e?.message))}`); });
  await a.sandbox.files.write(`${a.home}/pi-agent/models.json`, piModels(a.profile));
}

// Installs pinned omp with its official installer (it checks the binary's SHA-256 itself) into ~/.local/bin, then writes its
// key-free config. The agent dir may already hold mcp.json (written above), so only models.yml and config.yml are added.
async function setupOmp(a, ctx) {
  const sh = (cmd, timeoutMs) => a.sandbox.commands.run(cmd, { cwd: a.home, timeoutMs });
  await sh(`mkdir -p ${a.home}/omp-agent ${a.home}/.local/bin && curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v${OMP_VERSION} && test -x ${a.home}/.local/bin/omp`, INSTALL_MS)
    .catch((e) => { throw new Error(`Could not install omp in the sandbox: ${ctx.scrub(tail(e?.stderr ?? e?.message))}`); });
  await a.sandbox.files.write(`${a.home}/omp-agent/models.yml`, ompModels(a.profile));
  await a.sandbox.files.write(`${a.home}/omp-agent/config.yml`, ompConfig());
  await a.sandbox.files.write(`${a.home}/omp-agent/overlay.yml`, ompConfig());
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

// Autofix: after a pushed turn, the server opens the PR, waits for checks and starts fix turns until the PR is clean or the cap is hit.
// Every command is fixed text: only the branch (from the id), numbers from gh's own JSON and a validated ref go in a command string.
// Text from GitHub (logs, comments, reviews) is untrusted: redacted before it is cut, and review text counts only from people with write access.
// Never throws for a gh problem: it returns { text } saying what to do. Also { gone } (sandbox lost) or { cancelled }.
const GH_MS = 60_000, AUTOFIX_MARGIN_MS = 10 * 60_000, PR_FIELDS = 'number,url,state,headRefOid,baseRefName,mergeable,author,reviews';
const REF = /^[A-Za-z0-9._/-]{1,100}$/, SHA = /^[0-9a-f]{40}$/, RUN = /\/actions\/runs\/(\d+)/, LINK = /^https:\/\/github\.com\/[A-Za-z0-9._/-]+$/, LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/, WRITE = new Set(['admin', 'maintain', 'write']);
const nap = (ms, t) => { let id, off; return Promise.race([new Promise((r) => { id = setTimeout(r, ms); }), t.done, new Promise((r) => { t.abort.signal.addEventListener('abort', r, { once: true }); off = () => t.abort.signal.removeEventListener('abort', r); })]).finally(() => { clearTimeout(id); off(); }); };
function autofix(a, ctx, t) {
  const { scrub } = ctx, branch = `cloudy-cloud/${a.id}`, cwd = `${a.home}/repo`;
  const rounds = Number(ctx.env.CLOUDY_CLOUD_AUTOFIX_ROUNDS), cap = Number.isInteger(rounds) && rounds >= 0 ? Math.min(rounds, 10) : 3;
  const poll = ctx.autofixPollMs ?? 20_000, grace = ctx.autofixGraceMs ?? 90_000, checksMs = ctx.autofixChecksMs ?? 25 * 60_000;
  const halted = () => t.cancelled || t.status !== 'working' || a.status === 'stopped';
  const left = () => (a.deleteAt ? a.deleteAt - Date.now() : Infinity);
  const safe = (x) => redactText(scrub(x)); // before any cut, so a secret cannot be split by the cut
  const seen = (a.autofixSeen ??= new Set());
  let fixes = 0, lastPush = '', ignored = 0;
  const say = (note) => { t.prefix = `autofix ${fixes}/${cap}: `; t.note = note; a.emit?.({ type: 'progress', text: `${t.prefix}${note}` }); };
  const hand = `open or fix the pull request by hand (git fetch origin ${branch}), or send cloud_agent_message to agent ${a.id} asking it to run \`gh auth status\` and report.`;
  const done = (text) => ({ text: safe(`${text}${lastPush ? `\n${lastPush}` : ''}${ignored ? `\n${ignored} comment${ignored === 1 ? '' : 's'} from people without write access ${ignored === 1 ? 'was' : 'were'} ignored.` : ''}`) });
  const stop = (why) => done(`Autofix stopped: ${why}\nNext step: ${hand}`);
  const bail = (result) => { throw Object.assign(new Error('autofix ends'), { result }); };
  const exec = async (cmd, ms = GH_MS) => {
    if (left() < 5000) bail(done(`Autofix stopped: the machine is deleted at ${new Date(a.deleteAt).toISOString()}.\nNext step: ${hand}`));
    let r;
    try { r = { ok: true, out: String((await a.sandbox.commands.run(cmd, { cwd, timeoutMs: Math.min(ms, left()), signal: t.abort.signal })).stdout ?? '') }; }
    catch (e) { r = { ok: false, out: String(e?.stdout ?? ''), err: tail(e?.stderr || e?.message), code: e?.exitCode }; }
    if (halted()) bail({ cancelled: true }); // an aborted call must never read as a result
    if (!r.ok && typeof r.code !== 'number') { // the command did not run to its end: is the machine still there?
      const alive = await a.sandbox.commands.run('true', { cwd, timeoutMs: 15_000 }).then(() => true, () => false);
      if (halted()) bail({ cancelled: true });
      if (!alive) bail({ gone: true, text: `The sandbox is no longer reachable during autofix (${r.err}). Only work the agent already pushed to origin ${branch} survives.` });
    }
    return r;
  };
  const gh = (cmd, ms) => exec(`gh ${cmd}`, ms);
  const wait = async (ms) => { await nap(Math.min(ms, Math.max(left(), 0)), t); if (halted()) bail({ cancelled: true }); };
  const headSha = async () => { const o = (await exec('git rev-parse HEAD')).out.trim(); if (!SHA.test(o)) bail(stop('could not read the commit the worker pushed.')); return o; };
  const view = async () => { const r = await gh(`pr view ${branch} --json ${PR_FIELDS}`); try { return { pr: JSON.parse(r.out) }; } catch { return { err: r.err || tail(r.out) }; } };
  // The PR must be open and show the commit just pushed; GitHub can lag behind a push.
  const sync = async (sha) => {
    const t0 = Date.now();
    for (;;) {
      const v = await view();
      if ((v.pr?.state === 'OPEN' && v.pr.headRefOid === sha) || Date.now() - t0 >= grace) return v;
      await wait(poll);
    }
  };
  const go = async () => {
    let sha = await headSha();
    let v = await view();
    if (!v.pr || v.pr.state !== 'OPEN') {
      say('opening the pull request');
      const c = await gh(`pr create --head ${branch} --title '${branch}' --body 'Opened by cloudy-cloud autofix.'`);
      if (!c.ok) return stop(`gh could not create a pull request for ${branch}. gh said: ${c.err || tail(c.out)}`);
    }
    v = await sync(sha);
    if (!v.pr) return stop(`gh could not read the pull request for ${branch}. gh said: ${v.err}`);
    let pr = v.pr;
    a.prUrl = pr.url;
    const n = pr.number;
    if (!Number.isInteger(n)) return stop('gh returned no pull request number.');
    const unsynced = (p) => `Autofix: pull request ${p.url} could not be confirmed clean: GitHub shows it ${p.state === 'OPEN' ? `at commit ${String(p.headRefOid).slice(0, 7)} instead of the pushed ${sha.slice(0, 7)}` : `as ${p.state}`}.\nNext step: look at ${p.url} later, or ${hand}`;
    if (pr.state !== 'OPEN' || pr.headRefOid !== sha) return done(unsynced(pr));
    const waitChecks = async () => {
      const t0 = Date.now(), limit = Math.min(t0 + checksMs, Date.now() + left() - AUTOFIX_MARGIN_MS);
      for (;;) {
        const r = await gh(`pr checks ${n} --json name,bucket,link 2>&1; true`); // gh exits 8 while pending and 1 on a failure, and a provider may drop stdout of a failed command, so exit 0 and read everything from stdout
        let list; try { list = JSON.parse(r.out); } catch { /* no JSON */ }
        const none = /no checks reported/i.test(r.out) || (Array.isArray(list) && !list.length); // new commits show none for a moment, so wait out the grace time
        if (Array.isArray(list) && list.length && !list.some((c) => c.bucket === 'pending')) return { list };
        if (none && Date.now() - t0 >= grace) return { list: [] };
        if (!none && !Array.isArray(list)) return { error: r.err || tail(r.out) };
        if (Date.now() >= limit) return { timeout: Math.round((Date.now() - t0) / 60_000) };
        await wait(poll);
      }
    };
    for (;;) {
      say('waiting for checks');
      const w = await waitChecks();
      if (w.error) return stop(`gh could not read the checks. gh said: ${w.error}`);
      if (w.timeout !== undefined) return done(`Autofix stopped: checks on ${pr.url} were still running after ${w.timeout} minutes.\nNext step: check ${pr.url} later; send cloud_agent_message to agent ${a.id} if something fails.`);
      say('reading failures and review comments');
      const problems = [], incomplete = [], pendingSeen = []; // comments sent are remembered only once a fix turn pushed a new commit
      ignored = 0;
      const bad = w.list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
      const logs = new Map();
      for (const id of [...new Set(bad.map((c) => RUN.exec(c.link ?? '')?.[1]).filter(Boolean))].slice(0, 3)) logs.set(id, tail(safe((await gh(`run view ${id} --log-failed`, 120_000)).out)));
      for (const c of bad) {
        const id = RUN.exec(c.link ?? '')?.[1];
        problems.push(`Failed check "${safe(c.name).slice(0, 100)}"${c.bucket === 'cancel' ? ' (cancelled)' : ''}${LINK.test(c.link ?? '') ? ` (${c.link})` : ''}${id && logs.get(id) ? `. End of the failed log:\n${logs.get(id)}` : ''}`);
        if (id) logs.delete(id); // one log per run
      }
      let r = await view();
      for (let i = 0; r.pr?.mergeable === 'UNKNOWN' && i < 4; i++) { await wait(poll); r = await view(); }
      if (!r.pr) incomplete.push(`gh could not refresh the pull request (${r.err})`);
      else {
        pr = r.pr;
        if (pr.state !== 'OPEN') incomplete.push(`the pull request is ${pr.state}`);
        else if (pr.headRefOid !== sha) incomplete.push('the pull request head is not the pushed commit');
        if (pr.mergeable === 'UNKNOWN') incomplete.push('GitHub has not computed mergeability yet');
        const mine = pr.author?.login;
        const cand = []; // [id, login, text], newest first
        const take = (id, login, text) => { if (login !== mine && !seen.has(id)) cand.push([id, login, text]); };
        for (const rv of pr.reviews ?? []) if ((rv.state === 'CHANGES_REQUESTED' || rv.state === 'COMMENTED') && String(rv.body ?? '').trim()) take(rv.id, rv.author?.login, `Review by ${safe(rv.author?.login).slice(0, 40)}: ${safe(rv.body).slice(0, 500)}`);
        // --paginate reads every page; --jq prints one compact JSON object per line (ponytail: no cap on pages, GitHub allows at most 1000 review comments)
        const c = await gh(`api --paginate 'repos/{owner}/{repo}/pulls/${n}/comments?per_page=100' --jq '.[] | {id, login: .user.login, path, line, body, created_at} | tojson'`);
        const inline = [];
        for (const l of c.out.split('\n').filter(Boolean).slice(0, 2000)) { try { inline.push(JSON.parse(l)); } catch { inline.length = 0; inline.bad = true; break; } }
        if (!c.ok || inline.bad) incomplete.push('the inline review comments could not be read');
        else for (const x of inline.sort((p, q) => String(q.created_at).localeCompare(String(p.created_at)))) take(`c${x.id}`, x.login, `Comment by ${safe(x.login).slice(0, 40)} on ${safe(x.path).slice(0, 100)}${x.line ? `:${Number(x.line) || 0}` : ''}: ${safe(x.body).slice(0, 500)}`);
        // Write access is asked of GitHub for each author (an owner, member or collaborator can still be read-only).
        const perm = (a.autofixPerm ??= new Map());
        const trusted = [];
        for (const [id, login, text] of cand.slice(0, 30)) {
          if (!LOGIN.test(login ?? '')) { ignored++; continue; }
          if (!perm.has(login)) {
            const q = await gh(`api 'repos/{owner}/{repo}/collaborators/${login}/permission' --jq .permission`);
            if (q.ok && /^(admin|maintain|write|triage|read|none)$/.test(q.out.trim())) perm.set(login, WRITE.has(q.out.trim())); // a failed lookup is not cached: it counts as untrusted and is asked again
          }
          if (perm.get(login)) trusted.push([id, text]); else ignored++;
        }
        for (const [id, text] of trusted.slice(0, 10)) { pendingSeen.push(id); problems.push(text); }
        if (pr.mergeable === 'CONFLICTING') problems.push(REF.test(pr.baseRefName ?? '') ? `Merge conflict with ${pr.baseRefName}. Fetch origin, merge origin/${pr.baseRefName} into your branch, resolve the conflicts, commit and push.` : 'Merge conflict with the base branch. Fetch origin, merge the pull request base branch into your branch, resolve the conflicts, commit and push.');
      }
      const why = incomplete.length ? `\nNot confirmed: ${incomplete.join('; ')}.` : '';
      if (!problems.length) {
        if (incomplete.length) return done(`Autofix: pull request ${pr.url} could not be confirmed clean after ${fixes} fix round${fixes === 1 ? '' : 's'}: ${incomplete.join('; ')}.\nNext step: look at ${pr.url}, or ${hand}`);
        return done(`Autofix: pull request ${pr.url} is clean (checks pass, no new review comments, no merge conflicts) after ${fixes} fix round${fixes === 1 ? '' : 's'}.`);
      }
      const list = problems.map((p) => `- ${p}`).join('\n');
      const next = `Next step: send cloud_agent_message to agent ${a.id} saying what to fix, or fix it by hand (git fetch origin ${branch}).`;
      if (fixes >= cap) return done(`Autofix: pull request ${pr.url} is NOT clean after ${fixes} fix round${fixes === 1 ? '' : 's'} (the cap, CLOUDY_CLOUD_AUTOFIX_ROUNDS=${cap}). Still failing:\n${list}${why}\n${next}`);
      if (left() <= AGENT_MS + AUTOFIX_MARGIN_MS) return done(`Autofix stopped: the machine is deleted at ${new Date(a.deleteAt).toISOString()}, too soon for another fix round. Still failing on ${pr.url}:\n${list}${why}\n${next}`);
      fixes++;
      say('worker is fixing');
      t.note = '';
      t.progress = PROGRESS[harnessOf(a)]();
      if (halted()) return { cancelled: true };
      const res = await turn(a, scrub(`Autofix round ${fixes} of ${cap}. Pull request ${pr.url} has these problems. Fix them, commit, and push to your branch ${branch}. Do not open a new pull request or push to another branch.\n\n${list}`), ctx, t);
      if (res.cancelled || halted()) return { cancelled: true };
      if (res.gone) return { gone: true, text: res.text };
      lastPush = /^(Pushed to origin|Push failed).*$/m.exec(res.text)?.[0] ?? lastPush;
      if (res.error || !res.pushed) return done(`Autofix stopped: the fix turn ${res.error ? 'failed' : 'did not push'}. Still failing on ${pr.url}:\n${list}\nWorker said: ${tail(res.text)}\n${next}`);
      const was = sha;
      sha = await headSha();
      if (sha !== was) pendingSeen.forEach((id) => seen.add(id));
      if (sha === was) return done(`Autofix stopped: the worker pushed no new commits, so the checks cannot change. Still failing on ${pr.url}:\n${list}\n${next}`);
      v = await sync(sha);
      if (!v.pr) return stop(`gh could not read the pull request after the fix. gh said: ${v.err}`);
      pr = v.pr;
      if (pr.state !== 'OPEN' || pr.headRefOid !== sha) return done(unsynced(pr));
    }
  };
  return go().catch((e) => { if (e?.result) return e.result; throw e; });
}

// Background job for one turn. Never throws; records the outcome and wakes waiters.
async function work(a, message, first, ctx, t) {
  let r;
  try {
    if (first) await setup(a, ctx);
    a.status = 'running';
    a.emit?.({ type: 'status', status: 'running' });
    r = await turn(a, message, ctx, t);
    if (first && a.notice) r = { ...r, text: r.error ? `${r.text}\n\n${a.notice}` : `${a.notice}\n\n${r.text}` }; // before the reply, so the totals stay last
    if (first && !r.error && !a.sessionId) r = { error: true, text: `${r.text}\n\nNo valid session_id came back, so the agent cannot be resumed.` };
    if (a.autofix && !r.error && !r.cancelled && !r.gone && r.pushed && a.status !== 'stopped' && !t.cancelled) {
      const f = await autofix(a, ctx, t).catch((e) => ({ text: `Autofix stopped on an unexpected error: ${ctx.scrub(e?.message)}` }));
      t.prefix = t.note = '';
      r = { ...r, text: f.cancelled ? `${r.text}\n\nAutofix cancelled. The agent is still open.` : `${r.text}\n\n${f.text}`, ...(f.gone && { error: true, gone: true }), ...(f.cancelled && { cancelled: true }) };
    }
  } catch (e) {
    log('error:', ctx.scrub(e?.message));
    r = { error: true, text: limitText(e, ctx.queue.plan?.(), a.kind?.label) ?? e?.guideText ?? (e?.code === 'size_not_allowed' && a.size ? await sizeGuide(a.size, ctx.provider, true) : guide(classify(e?.message), { message: e?.message })) };
  }
  if (a.status === 'stopped') return;
  // A failed first turn cannot be resumed (no session id); a later turn fails the agent only when its sandbox is gone.
  const dead = first ? r.error : r.gone;
  if (r.error && !/Next step:/.test(r.text)) r = { ...r, text: `${r.text}\n${guide(dead ? 'agent_failed' : 'worker_error', { id: a.id })}` };
  a.result = { text: ctx.scrub(r.text), error: r.error, reported: false };
  a.status = dead ? 'failed' : 'idle';
  a.emit?.({ type: 'reply', text: a.result.text, error: r.error });
  a.emit?.({ type: 'status', status: a.status });
  endTurn(t, r.cancelled ? 'cancelled' : r.error ? 'failed' : 'completed', a.result);
  if (dead) await a.sandbox?.kill().catch(() => {});
  armIdle(a, ctx);
  wake(a);
}

// Why a queued agent waits, shown by list, wait, task status and the dashboard: the capacity reason (when one holds the line) and the place in line.
function queuedText(a, queue) {
  const ahead = queue.ahead(a), why = queue.reason?.(a);
  if (ahead === undefined) return a.queueNote ?? 'queued for a machine (waiting to retry)';
  return why ? (ahead ? `queued, ${ahead} ahead: ${why}` : why) : `queued for a machine (${ahead} ahead)`;
}

// The progress line for a turn, safe to show: scrubbed, one line, at most STATUS_MAX characters.
function statusOf(t, ctx) {
  let m;
  if (t.status === 'working') {
    const a = t.agent, ahead = ctx.queue.ahead(a);
    m = a.status === 'queued' ? queuedText(a, ctx.queue)
      : a.status === 'starting' ? 'starting machine…' : `${t.prefix ?? ''}${t.note || statusLine(t.progress)}`;
  }
  else if (t.status === 'completed') m = statusLine(t.progress);
  else m = `${t.status}: ${t.result?.text ?? ''}`;
  if (t.agent.profile) m = `[${t.agent.profile.name}] ${m}`;
  if (t.agent.role === 'coordinator') m = `[coordinator] ${m}`;
  const one = ctx.scrub(m).replace(/\s+/g, ' ').trim();
  return one.length > STATUS_MAX ? `${one.slice(0, STATUS_MAX - 1)}…` : one;
}
const iso = (ms) => new Date(ms).toISOString();

// The size_not_allowed guide. With `read`, the plan is read first (cached, else refreshed once); an unreadable plan gives the generic text.
function sizeGuide(size, planOrProvider, read) {
  const build = (plan) => {
    const sorted = (plan?.specs ?? []).slice().sort((x, y) => x.vcpus - y.vcpus || x.memMiB - y.memMiB).map(sizeLabel);
    const p = offeredBy(size.label); // the lowest plan that lists exactly this size; none means no plan offers it
    const up = p && !(plan?.tier && TIERS.indexOf(p) <= TIERS.indexOf(plan.tier)) ? p : undefined; // suggest an upgrade only to a higher plan
    return guide('size_not_allowed', { size: size.label, notOffered: !p, plan: up, ...(p && !up && plan?.tier && { onPlan: true }), fee: planFee(up), ...(sorted.length && { tier: plan.tier, sizes: sorted.join(' '), largest: sorted.at(-1) }) });
  };
  if (!read) return build(planOrProvider);
  return (async () => {
    let plan = await planOrProvider.plan?.().catch(() => null);
    if (!plan?.specs?.length) plan = await planOrProvider.plan?.({ refresh: true }).catch(() => null);
    return build(plan);
  })();
}

// What cloud_agent and cloud_agent_message answer with in task mode.
const priceOf = (a) => (EXPENSIVE.includes(a.kind?.name) ? `${PRICE[a.kind.name]}. Stop it with cloud_agent_stop as soon as it is done.` : a.size ? [sizeCostLine(a.size.vcpus, a.size.memMiB / 1024), a.sizeNote].filter(Boolean).join(' ') : '');
const priceNote = (t) => priceOf(t.agent);
function taskAnswer(t, ctx) {
  return {
    resultType: 'task', taskId: t.id, status: 'working', statusMessage: [statusOf(t, ctx), priceNote(t)].filter(Boolean).join(' '),
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
  const text = `agent_id: ${t.agent.id} (turn ${t.n})\n${priceNote(t) ? `${priceNote(t)}\n` : ''}\n${t.result?.text}`;
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
  deps.refreshEnv?.(); // keys added to the env file since startup apply to this agent
  const ctx = ctxOf(deps, 'cloud_agent');
  ctx.queue.learnPlan?.(); // fire and forget; the pace follows once the plan arrives
  const { fail, ok } = ctx;
  const { hasProxySecrets, hasConsentedSecrets } = ctx.provider.caps;
  if (!hasProxySecrets && !hasConsentedSecrets) return fail(`Provider ${ctx.provider.name} cannot keep the GitHub token off the machine; cloudy-cloud only runs on providers with proxy secrets. On your own machine you can allow it: run cloudy-cloud setup and answer yes to the GitHub token question. That means the token is stored on your machine (in memory only, never on disk) while an agent runs.`);
  const { prompt, model, subagent_type: agent, description, profile: profileName, role = 'worker', autofix: autofixOn = false } = args;
  if (!ROLES.includes(role)) return fail(`invalid role: must be one of ${ROLES.join(', ')}`);
  if (typeof autofixOn !== 'boolean') return fail('invalid autofix: must be true or false');
  if (autofixOn && role === 'coordinator') return fail('autofix works for workers only, because a coordinator does not own a branch with a pull request. Call cloud_agent again with role "worker" and autofix, or start the coordinator without autofix and start a worker with autofix for the code change.');
  if (typeof prompt !== 'string' || !prompt) return fail('prompt is required');
  for (const [name, v] of [['model', model], ['subagent_type', agent]]) {
    if (v === undefined) continue;
    const re = name === 'model' && profileName !== undefined ? MODEL : SAFE; // profile models may contain "/"
    if (!(typeof v === 'string' && re.test(v))) return fail(`invalid ${name}: must match ${re}`);
  }
  let profile;
  if (profileName !== undefined) {
    const r = resolveProfile(profileName, model, ctx.env, { proxyOnly: hasProxySecrets });
    if (r.error) return fail(r.error);
    profile = r.ok;
  }
  const apt = aptPackages(ctx.env);
  if (apt.error) return fail(apt.error);
  if (apt.list.length && !ctx.provider.caps.hasProxySecrets) return fail(`CLOUDY_CLOUD_APT_PACKAGES needs sudo on the worker, and the ${ctx.provider.name} image has none. Add the packages to the image (docker/worker.Dockerfile) and rebuild it, then clear CLOUDY_CLOUD_APT_PACKAGES.`);
  const kind = parseMachine(args.machine);
  if (kind.error) return fail(guide('machine_kind_unknown', { message: String(args.machine).slice(0, 60) }));
  const offered = ctx.provider.caps.machineKinds ?? ['linux'];
  if (!offered.includes(kind.name)) return fail(guide('machine_kind_unsupported', { provider: ctx.provider.name, kind: kind.name, kinds: offered.join(', ') }));
  if (EXPENSIVE.includes(kind.name) && !String(ctx.env.CLOUDY_CLOUD_ALLOW_MACHINE_KINDS ?? '').split(/[\s,]+/).includes(kind.name)) return fail(guide('machine_needs_consent', { kind: kind.name, price: PRICE[kind.name] }));
  if (apt.list.length && ['omarchy', 'macos'].includes(kind.name)) return fail(`CLOUDY_CLOUD_APT_PACKAGES cannot be installed on a ${kind.name} machine (it has no apt-get). Call cloud_agent again with machine "linux" or "android", or clear CLOUDY_CLOUD_APT_PACKAGES.`);
  const size = parseSize(args.size);
  let sizeNote;
  if (size?.error) return fail(size.error, true);
  if (size) {
    if (EXPENSIVE.includes(kind.name)) return fail('gpu and macos machines have their own sizes, so size cannot be used with them. Call cloud_agent again without size.');
    if (!ctx.provider.caps.hasSizes) return fail(`size is not available: the ${ctx.provider.name} provider has one machine size. Call cloud_agent again without size.`);
    const has = (p) => p?.specs?.some((s) => s.vcpus === size.vcpus && s.memMiB === size.memMiB);
    let plan = await ctx.provider.plan?.().catch(() => null);
    if (plan?.specs && !has(plan)) plan = await ctx.provider.plan({ refresh: true }).catch(() => null); // the plan may have been upgraded since it was cached
    if (plan?.specs && !has(plan)) {
      return fail(sizeGuide(size, plan));
    }
    if (!plan?.specs) sizeNote = `Your Instabox plan could not be read, so size ${size.label} was not checked against it and Instabox may refuse it (read the reason with cloud_agent_result).`;
  }
  if (role === 'coordinator' && ctx.provider.text?.coordinatorRefusal) return fail(ctx.provider.text.coordinatorRefusal);
  if (role === 'coordinator' && (profile?.harness === 'pi' || profile?.harness === 'omp' || profile?.harness === 'codex')) return fail('A coordinator cannot use a pi, omp or codex profile, because coordinators run Claude Code. Use a pi, omp or codex profile for workers only.');
  let root;
  try {
    root = await git(deps.cwd ?? process.cwd(), 'rev-parse', '--show-toplevel');
    await git(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    return fail('cloudy-cloud needs a git repository with at least one commit. Run `git init` and commit your files, then retry.');
  }
  const origin = githubUrl(await git(root, 'config', '--get', 'remote.origin.url').catch(() => ''));
  if (!origin) return fail(NO_ORIGIN);
  const depth = (Number(ctx.env.CLOUDY_CLOUD_DEPTH) || 0) + 1;
  const maxDepth = Number(ctx.env.CLOUDY_CLOUD_MAX_DEPTH) || MAX_DEPTH;
  const maxAgents = Number(ctx.env.CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION) || MAX_AGENTS;
  if (role === 'coordinator' && depth > maxDepth) return fail(`Cannot start a coordinator: this session is already at the maximum depth of ${maxDepth} (CLOUDY_CLOUD_MAX_DEPTH). Start a worker instead.`);
  const count = (deps.count ??= { started: 0 });
  if (count.started >= maxAgents) return fail(`This session has already started ${count.started} agents, the limit (CLOUDY_CLOUD_MAX_AGENTS_PER_SESSION is ${maxAgents}). Stop idle agents or raise the limit.`);
  let tool;
  if (role === 'coordinator') {
    const toolRoot = deps.toolRoot ?? TOOL_ROOT;
    try {
      if (ownsRepo(toolRoot)) {
        await git(toolRoot, 'rev-parse', 'HEAD');
        tool = { root: toolRoot, origin: githubUrl(await git(toolRoot, 'remote', 'get-url', 'origin').catch(() => '')) || '' };
      } else tool = { root: toolRoot, origin: '' }; // an npm install: toolBundle packs its files into a temporary repo
    } catch (e) {
      return fail(`A coordinator needs cloudy-cloud's own folder (${toolRoot}) to be a git checkout, so it can be sent to the sandbox: ${e.message}`);
    }
  }
  count.started++;
  const id = randomUUID().slice(0, 8);
  const a = { role, autofix: autofixOn, kind, ...(size && { size, sizeNote }), depth, maxDepth, maxAgents, tool, id, description: description ?? '', status: 'starting', root, origin, model, agent, profile, waiters: [], result: null, idleSince: Date.now(),
    serverTtl: ctx.provider.caps.hasServerTTL, tokenOnBox: !hasProxySecrets && hasConsentedSecrets ? (ctx.provider.text?.hostLabel ?? ctx.provider.name) : '' };
  ctx.open.set(id, a);
  try { a.mcp = forHarness(agentMcp(ctx.env, hasProxySecrets), profile?.harness); a.mcp.values.forEach((v) => ctx.literals.add(v)); } catch (e) { a.mcpError = e.message; }
  a.emit = (e) => ctx.events?.({ id, ...e, ...(e.text && { text: ctx.scrub(e.text) }), ...(e.description && { description: ctx.scrub(e.description) }) });
  a.emit({ type: 'agent', description: a.description, profile: profile?.name, role, ...(kind.name !== 'linux' && { machine: kind.label }), model: profile ? profile.model : model, branch: `cloudy-cloud/${id}`, ...(hasMcp(a) && { mcp: Object.keys(a.mcp.servers) }) });
  a.emit({ type: 'message', text: prompt });
  const t = newTurn(a);
  ctx.tasks.set(t.id, t);
  work(a, prompt, true, ctx, t);
  if (ctx.asTask) return taskAnswer(t, ctx);
  const skipped = role === 'coordinator' ? coordinatorKeys(ctx.env, ctx.provider, { single: true }).skipped ?? [] : [];
  return ok(`agent_id: ${id}\nstatus: starting\n${skipped.length ? `Not sent to the coordinator (not stored as proxy secrets): ${skipped.join(', ')}. Store them with \`cloudy-cloud setup\`.\n` : ''}${EXPENSIVE.includes(kind.name) ? `${PRICE[kind.name]}. Stop it with cloud_agent_stop as soon as it is done.\n` : ''}${size ? `${priceOf({ size, sizeNote })}\n` : ''}Call cloud_agent_wait with the agent_ids to get the result.`);
}

// cloud_agent_message: returns at once; the turn runs in the background.
export async function messageAgent({ agent_id: id, message } = {}, deps) {
  const ctx = ctxOf(deps, 'cloud_agent_message');
  const { fail, ok } = ctx;
  if (typeof message !== 'string' || !message) return fail('message is required');
  const a = typeof id === 'string' ? ctx.open.get(id) : undefined;
  if (!a) return fail(guide('agent_gone', { id }));
  if (active(a)) return fail(guide('agent_busy', { id }));
  if (a.status === 'failed') return fail(guide('agent_failed', { id }));
  clearTimeout(a.idleTimer);
  a.status = 'running';
  a.emit?.({ type: 'message', text: message });
  a.emit?.({ type: 'status', status: 'running' });
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
  const ctx = ctxOf(deps, 'cloud_agent_wait');
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
    if (active(a) || !a.result) return a.status === 'queued' ? `${head}\n${queuedText(a, ctx.queue)}` : head;
    if (a.result.reported) return `${head}\nresult already delivered; call cloud_agent_result to read it again`;
    a.result.reported = true;
    return `${head}\n${a.result.error ? 'ERROR: ' : ''}${a.result.text}${priceOf(a) ? `\n${priceOf(a)}` : ''}`;
  });
  return ctx.ok(parts.join('\n\n'));
}

// cloud_agent_list {all: true}: every machine labelled purpose=cloudy-cloud, grouped by parent label.
async function allMachines({ provider }) {
  const rows = await provider.list({ purpose: 'cloudy-cloud' });
  if (!rows.length) return 'No cloudy-cloud machines.';
  const groups = new Map();
  for (const m of rows) { const k = m.labels?.parent || m.labels?.owner || 'unknown'; groups.set(k, [...(groups.get(k) ?? []), m]); }
  return [...groups].map(([parent, ms]) => `parent ${parent}\n${ms.map((m) => `  ${m.id}  ${m.state ?? m.status}  ${m.labels?.role ?? '?'}  profile ${m.labels?.profile ?? '?'}${m.labels?.kind ? `  machine ${m.labels.kind}` : ''}  agent ${m.labels?.agent ?? '?'}${m.labels?.description ? `  ${m.labels.description}` : ''}`).join('\n')}`).join('\n');
}

// cloud_agent_result: read-only. Returns the latest result as often as asked.
export async function resultAgent(args = {}, deps) {
  const ctx = ctxOf(deps, 'cloud_agent_result');
  const id = idList(args)[0];
  const a = typeof id === 'string' ? ctx.open.get(id) : undefined;
  if (!a || a.status === 'stopped') return ctx.fail(guide('agent_gone', { id }));
  if (!a.result) return ctx.ok(`${guide('agent_result_pending', { id, status: a.status })}\nno result yet, status ${a.status}`);
  return ctx.ok(`${active(a) ? `(status ${a.status}: a newer turn is running; this is the previous result)\n` : ''}${a.result.error ? 'ERROR: ' : ''}${a.result.text}${priceOf(a) ? `\n${priceOf(a)}` : ''}`);
}

// cloud_agent_list: read-only.
export async function listAgents(args, deps) {
  const ctx = ctxOf(deps, 'cloud_agent_list');
  const { ok, open } = ctx;
  const spend = usageLine(planSnapshot(ctx.provider)), tail = (t) => ok(spend ? `${t}\n${spend}` : t);
  if (args?.all === true) return tail(await allMachines(ctx));
  if (!open.size) return tail('No agents.');
  const usage = await usageOf([...open.values()], ctx);
  const seg = (a) => usage.get(a) ?? '';
  return ok([[...open.values()].map((a) => (
    `${a.id}  ${a.status}${a.profile ? `  profile ${a.profile.name}` : ''}${a.kind.name !== 'linux' ? `  machine ${a.kind.label}` : ''}${a.role === 'coordinator' ? '  role coordinator' : ''}  idle ${active(a) ? 0 : Math.floor((Date.now() - a.idleSince) / 60_000)} min${a.deleteAt ? `  deleted at ${new Date(a.deleteAt).toISOString()}` : ''}${seg(a)}  ${a.description}` +
    (hasMcp(a) ? `\n    mcp ${Object.keys(a.mcp.servers).join(', ')}` : '') +
    (a.turn?.progress.model || a.profile ? `\n    ${modelLine(a.turn?.progress ?? { model: '' }, a.profile && { model: a.profile.model, host: profileHost(a.profile), name: a.profile.name })}` : '') +
    (a.turn ? `\n    ${a.turn.id}: ${statusOf(a.turn, ctx)}` : ''))).join('\n'), ...(spend ? [spend] : [])].join('\n'));
}

// Usage segment per running or idle agent, placed before the description. Never throws; a failure reads "usage n/a (unavailable)", slowness "(timeout)", no samples "(none yet)".
// At most 4 reads at once (the provider's own limiter paces the calls), 3 s in total. Stopped and queued agents are never touched.
async function usageOf(agents, { provider, usageBudgetMs = 3000 }) {
  const out = new Map();
  const eligible = (a) => a.sandbox?.id && (a.status === 'running' || a.status === 'idle');
  const todo = provider?.caps?.hasMetrics ? agents.filter(eligible) : [];
  for (const a of todo) out.set(a, '  usage n/a (timeout)');
  let next = 0, timer;
  const read = async () => {
    for (let a; (a = todo[next++]);) {
      if (!eligible(a)) { out.delete(a); continue; } // stopped while it waited for a slot: no call, no segment
      try {
        const { samples } = await provider.metrics(a.sandbox.id, { since: Date.now() - 120_000 });
        const s = samples?.at(-1);
        if (s && Number.isFinite(s.cpuPct) && s.memTotal > 0) {
          const gib = (n) => (n / 2 ** 30).toFixed(1).replace(/\.0$/, ''), sec = Math.max(0, Math.round((Date.now() - s.t) / 1000));
          out.set(a, `  cpu ${Math.round(s.cpuPct)}% mem ${gib(s.memUsed)}/${gib(s.memTotal)} GiB${Number.isFinite(s.t) ? ` (${sec < 60 ? sec + 's' : Math.round(sec / 60) + 'm'} ago)` : ''}`);
        } else out.set(a, '  usage n/a (none yet)');
      } catch { out.set(a, '  usage n/a (unavailable)'); }
    }
  };
  const budget = new Promise((r) => { timer = setTimeout(r, usageBudgetMs); });
  await Promise.race([Promise.all(Array.from({ length: Math.min(4, todo.length) }, read)), budget]);
  clearTimeout(timer);
  next = todo.length; // a late timeout stops workers from starting more reads
  return new Map(out); // snapshot: a read that finishes after the budget cannot change the output
}

// cloud_agent_stop: idempotent.
export async function stopAgents(args = {}, deps) {
  const ctx = ctxOf(deps, 'cloud_agent_stop');
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
