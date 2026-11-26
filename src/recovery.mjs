import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { resolveProfile } from './profiles.mjs';
import { egressAllow } from './config.mjs';

const exec = promisify(execFile);
const ID = /^[0-9a-f]{8}$/;
const BRANCH = /^cloudy-cloud\/(?:[a-z0-9][a-z0-9-]*-)?[0-9a-f]{8}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const HARNESS = new Set(['claude', 'pi', 'omp', 'codex', 'opencode']);

const userBinding = () => String(process.getuid?.() ?? userInfo().username);
export const recoveryDirectory = (env = process.env) => resolve(env.CLOUDY_CLOUD_RECOVERY || join(dirname(env.CLOUDY_CLOUD_CONFIG || join(homedir(), '.config/cloudy-cloud/env')), 'recovery'));
const checkpointPath = (env, id) => {
  if (!ID.test(String(id ?? ''))) throw new Error('invalid agent id');
  return join(recoveryDirectory(env), `${id}.json`);
};

function validateRecord(r) {
  if (!r || r.version !== 1 || !ID.test(r.id) || !BRANCH.test(r.branch) || !r.branch.endsWith(r.id)) throw new Error('invalid recovery checkpoint identity');
  if (typeof r.workspace !== 'string' || !isAbsolute(r.workspace)) throw new Error('invalid recovery workspace');
  if (typeof r.user !== 'string' || !r.user || r.user.length > 128) throw new Error('invalid recovery user binding');
  if (typeof r.originRepo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.originRepo)) throw new Error('invalid recovery origin');
  if (!HARNESS.has(r.harness) || (r.profile !== null && (typeof r.profile !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(r.profile)))) throw new Error('invalid recovery harness or profile');
  if (r.profile === null && r.harness !== 'claude') throw new Error('a non-Claude recovery checkpoint needs a profile');
  if (typeof r.model !== 'string' || r.model.length > 160 || /[\r\n\0]/.test(r.model)) throw new Error('invalid recovery model');
  if (typeof r.machineKind !== 'string' || !/^[A-Za-z0-9:_.-]{1,80}$/.test(r.machineKind)) throw new Error('invalid recovery machine kind');
  if (!Array.isArray(r.egress) || r.egress.some((h) => typeof h !== 'string') || (r.egress.length && egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: r.egress.join(',') }).error)) throw new Error('invalid recovery network policy');
  if (r.size !== null && (typeof r.size !== 'string' || !/^\d+x\d+$/.test(r.size))) throw new Error('invalid recovery machine size');
  if (!PROVIDER.test(r.provider) || typeof r.machine !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(r.machine) || typeof r.owner !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(r.owner)) throw new Error('invalid recovery machine ownership');
  if (!OID.test(r.checkpointSha)) throw new Error('invalid recovery checkpoint commit');
  const allowed = new Set(['version', 'id', 'branch', 'workspace', 'user', 'originRepo', 'harness', 'profile', 'model', 'machineKind', 'size', 'egress', 'checkpointSha', 'provider', 'machine', 'owner']);
  if (Object.keys(r).some((k) => !allowed.has(k))) throw new Error('recovery checkpoint contains unsupported data');
  return r;
}

export async function saveCheckpoint(env, record) {
  const safe = validateRecord({ ...record });
  const file = checkpointPath(env, safe.id), dir = dirname(file), temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(temp, `${JSON.stringify(safe)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temp, file); } catch (e) { await rm(temp, { force: true }); throw e; }
  return safe;
}

export async function readCheckpoint(env, id) {
  const file = checkpointPath(env, id);
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error('recovery checkpoint is damaged; refusing to recover'); }
  try { validateRecord(record); } catch { throw new Error('recovery checkpoint is invalid; refusing to recover'); }
  if (record.id !== String(id)) throw new Error('recovery checkpoint id does not match its file; refusing to recover');
  return record;
}

export async function updateCheckpointPlacement(env, id, { provider, machine, owner }) {
  const prior = await readCheckpoint(env, id);
  if (!prior) throw new Error('recovery checkpoint is missing');
  return saveCheckpoint(env, { ...prior, provider, machine, owner });
}

const originRepoOf = (url) => {
  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url ?? '');
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url ?? '');
  return (https ?? ssh)?.[1];
};

export async function verifyOriginCheckpoint(repo, record, { git = async (cwd, ...args) => (await exec('git', args, { cwd, maxBuffer: 1 << 20 })).stdout.trim() } = {}) {
  let root, origin, rows;
  try {
    root = await git(repo, 'rev-parse', '--show-toplevel');
    origin = await git(root, 'config', '--get', 'remote.origin.url');
    rows = await git(root, 'ls-remote', '--heads', 'origin', `refs/heads/${record.branch}`);
  } catch { return { ok: false, reason: 'origin is unreachable, so the checkpoint cannot be verified' }; }
  let canonicalRoot;
  try { canonicalRoot = realpathSync(root); } catch { return { ok: false, reason: 'the current workspace does not match the saved checkpoint' }; }
  if (canonicalRoot !== record.workspace) return { ok: false, reason: 'the current workspace does not match the saved checkpoint' };
  if (originRepoOf(origin) !== record.originRepo) return { ok: false, reason: 'the current origin does not match the saved checkpoint repository' };
  const line = rows.split('\n').find(Boolean);
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t([^\s]+)$/.exec(line ?? '');
  if (!match || match[2] !== `refs/heads/${record.branch}`) return { ok: false, reason: 'the checkpoint branch is no longer on origin' };
  if (match[1] !== record.checkpointSha) return { ok: false, reason: 'origin branch changed after the confirmed checkpoint; recovery will not overwrite it' };
  return { ok: true, sha: match[1] };
}

export function checkpointRecord({ id, branch, workspace, origin, harness, profile, model, machineKind, size, egress, checkpointSha, provider, machine, owner }) {
  const originRepo = originRepoOf(origin);
  if (!originRepo) throw new Error('recovery requires a GitHub origin');
  return validateRecord({ version: 1, id, branch, workspace: realpathSync(workspace), user: userBinding(), originRepo, harness, profile: profile ?? null, model: model ?? '', machineKind, size: size ?? null, egress: egress ?? [], checkpointSha, provider, machine, owner });
}

async function acquireLock(env, id) {
  const dir = recoveryDirectory(env), file = join(dir, `${id}.lock`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `${id}.${randomUUID()}.lock.tmp`), token = `${process.pid} ${randomUUID()}\n`;
  await writeFile(temp, token, { mode: 0o600, flag: 'wx' });
  try { await link(temp, file); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let contents = '';
    try { contents = await readFile(file, 'utf8'); } catch { /* unreadable or changing lock remains a refusal */ }
    const pid = Number(contents.trim().split(/\s+/, 1)[0]);
    let alive = Number.isInteger(pid) && pid > 0;
    if (alive) { try { process.kill(pid, 0); } catch (err) { alive = err.code === 'EPERM'; } }
    if (alive) throw new Error(`Recovery is already in progress for agent ${id}.`);
    const why = Number.isInteger(pid) && pid > 0 ? 'The previous recovery process is no longer running' : 'The existing recovery lock cannot be verified';
    throw new Error(`${why} for agent ${id}, so recovery is refused. After confirming no recovery process is running and the target provider has no replacement machine for this agent, remove ${file} and retry.`);
  } finally { await rm(temp, { force: true }); }
  return async () => {
    let contents = '';
    try { contents = await readFile(file, 'utf8'); } catch { return; }
    if (contents === token) await rm(file, { force: true });
  };
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], structuredContent: { status: isError ? 'failed' : 'unknown', error: isError, message: text }, ...(isError && { isError: true }) });
const stateOf = (row) => String(row?.status ?? row?.state ?? '').toLowerCase();
const goneCodes = new Set(['not_found', 'machine_not_found']);
const terminal = new Set(['stopped', 'failed', 'deleted', 'expired', 'terminated']);

async function confirmOriginalGone(record, provider) {
  let rows;
  try { rows = await provider.list({ purpose: 'cloudy-cloud', agent: record.id }); }
  catch { return { ok: false, reason: 'the original provider is unreachable; its machine state is unknown' }; }
  if (!Array.isArray(rows)) return { ok: false, reason: 'the original provider returned an incomplete machine list; its machine state is unknown' };
  const related = rows.filter((m) => m?.labels?.agent === record.id);
  const row = related.find((m) => String(m.id) === record.machine);
  if (related.some((m) => m.labels?.parent !== record.owner)) return { ok: false, reason: 'the original machine ownership labels do not match the checkpoint' };
  if (related.length && !row) return { ok: false, reason: 'the original agent has a different machine than its checkpoint; refusing recovery' };
  if (row && terminal.has(stateOf(row))) return { ok: true };
  try {
    await provider.connect(record.machine);
    return { ok: false, reason: 'the original machine is still reachable; recovery will not start a duplicate worker' };
  } catch (e) {
    if (goneCodes.has(e?.code) || e?.status === 404) return { ok: true };
    return { ok: false, reason: 'could not confirm whether the original machine is gone; its state is unknown' };
  }
}

export async function recoverFromCheckpoint({ agent_id: id, provider: providerName, message } = {}, deps) {
  if (!ID.test(String(id ?? ''))) return textResult('agent_id must be an eight-character Cloudy Cloud agent id.', true);
  if (typeof message !== 'string' || !message.trim()) return textResult('A new message is required; recovery never replays the previous task.', true);
  if (typeof providerName !== 'string' || !PROVIDER.test(providerName)) return textResult('Choose a configured alternate provider by name.', true);
  let release;
  try { release = await acquireLock(deps.env ?? process.env, id); } catch (e) { return textResult(e.message, true); }
  let lockTransferred = false;
  try {
    let record;
    try { record = await readCheckpoint(deps.env ?? process.env, id); } catch (e) { return textResult(e.message, true); }
    if (!record) return textResult(`No confirmed recovery checkpoint exists for agent ${id}.`, true);
    let workspace = '';
    try { workspace = realpathSync((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd ?? process.cwd() })).stdout.trim()); } catch { /* a repository is required */ }
    if (workspace !== record.workspace || userBinding() !== record.user) return textResult('This checkpoint belongs to a different workspace or user.', true);
    const previous = deps.open?.get(id);
    if (previous && !['failed', 'stopped', 'idle'].includes(previous.status)) return textResult(`Agent ${id} is already open in this session; use cloud_agent_message or cloud_agent_list.`, true);
    const providers = deps.providers ?? deps.provider?.providers ?? [deps.provider].filter(Boolean);
    const oldProvider = providers.find((p) => p.name === record.provider);
    const target = providers.find((p) => p.name === providerName);
    if (!oldProvider) return textResult(`The original provider ${record.provider} is not configured, so its machine state is unknown.`, true);
    if (!target) return textResult(`Provider ${providerName} is not configured for this session.`, true);
    if (target.name === record.provider) return textResult('Recovery requires a different configured provider from the original machine.', true);
    const old = await confirmOriginalGone(record, oldProvider);
    if (!old.ok) return textResult(old.reason, true);
    if (record.profile) {
      const profile = resolveProfile(record.profile, record.model || undefined, deps.env ?? process.env, { proxyOnly: !!target.caps?.hasProxySecrets && !target.caps?.localSecrets });
      if (profile.error || profile.ok?.harness !== record.harness) return textResult(`The saved profile cannot be restored on ${target.name} with the current configuration${profile.error ? `: ${profile.error.split('\n')[0]}` : ''}.`, true);
    }
    if (record.egress.length && !target.caps?.hasEgressPolicy) return textResult(`Provider ${target.name} cannot enforce the saved network allowlist; recovery was refused.`, true);
    const verified = await (deps.verifyCheckpoint ?? verifyOriginCheckpoint)(record.workspace, record);
    if (!verified?.ok || verified.sha !== record.checkpointSha) return textResult(verified?.reason ?? 'the exact origin checkpoint could not be verified', true);
    if (typeof deps.startRecovery !== 'function') return textResult('Recovery start is unavailable in this session.', true);
    const started = await deps.startRecovery({ id, branch: record.branch, base: record.checkpointSha, profile: record.profile ?? undefined, model: record.model || undefined, machine: record.machineKind, size: record.size ?? undefined, egress: record.egress, harness: record.harness, prompt: message.trim(), description: `Recovered agent ${id}`, recoveryRecord: record }, target, { release, previous });
    if (started?.isError) return textResult(started.content?.find((item) => item.type === 'text')?.text ?? 'The recovery worker could not be started.', true);
    lockTransferred = true;
    const note = `Recovery start requested on ${target.name} from verified checkpoint ${record.checkpointSha}. It will restore ${record.branch} under agent id ${id} and start a fresh ${record.harness} conversation. The previous prompt and conversation were not replayed.`;
    for (const item of started?.content ?? []) if (item.type === 'text') item.text += `\n${note}`;
    started.structuredContent = { status: 'starting', error: false, agent_id: id, branch: record.branch, requested_provider: target.name, checkpoint_sha: record.checkpointSha, message: note };
    return started;
  } finally { if (!lockTransferred) await release().catch(() => {}); }
}
