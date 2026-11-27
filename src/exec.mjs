#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSnapshotManager } from './snapshot.mjs';
import { egressAllow, loadEnv } from './config.mjs';
import { loadProviders, writeSecretFile } from './providers/index.mjs';
import { classifyCreateFailure, reconcileCreate } from './create-routing.mjs';

const runFile = promisify(execFile);
const MAX_TIMEOUT_SECONDS = 86_400;
const SANDBOX_OVERHEAD_SECONDS = 300;
const MAX_CAPTURE_BYTES = 128 * 1024;
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const shellCommand = (argv) => `exec ${argv.map(quote).join(' ')}`;

async function git(root, ...args) {
  return (await runFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}

const capAppend = (state, text) => {
  if (!text) return;
  const bytes = Buffer.from(text);
  const room = Math.max(0, MAX_CAPTURE_BYTES - state.bytes);
  if (room) {
    const part = bytes.subarray(0, room).toString('utf8');
    state.text += part;
    state.bytes += Buffer.byteLength(part);
  }
  if (bytes.length > room) state.truncated = true;
};
const emit = (fn, text) => { try { fn(text); } catch { /* output callbacks must not change remote command or cleanup state */ } };

const bounded = (state) => `${state.text}${state.truncated ? '\n[output truncated after 131072 bytes]' : ''}`;
const textOf = (error) => String(error?.message ?? error ?? 'Unknown error');
const exitOf = (error) => Number.isInteger(error?.exitCode) ? error.exitCode
  : error?.code === 'timeout' ? 124
    : Number.isInteger(error?.code) && typeof error.code === 'number' ? error.code : undefined;
const ownerFor = (provider, id, deleteAt) => ({ provider: provider.name, machine_id: String(id), selector: `${provider.name}:${id}`, hasShell: provider.caps?.hasShell !== false, ...(deleteAt && { delete_at: new Date(deleteAt).toISOString() }) });

function ownerAction(owner) {
  if (owner.hasShell === false) return `This provider has no shell you can attach to. Inspect machine ${owner.machine_id} (provider ${owner.provider}) with the provider's own tools${owner.delete_at ? ` — it is deleted at ${owner.delete_at}` : ''}.\nAfter preserving any needed files, delete it with:\n  cloudy-cloud machines stop ${quote(owner.selector)}`;
  return `Inspect this machine:\n  cloudy-cloud shell ${quote(owner.selector)} -- /bin/sh\nAfter preserving any needed files, delete it with:\n  cloudy-cloud machines stop ${quote(owner.selector)}`;
}

function failed(message, extra = {}) {
  return { status: 'failed', error: true, message, ...extra };
}

async function deleteAndConfirm(provider, id) {
  await provider.delete(id);
}

async function place(providers, env, labels, bundleSize, egress, timeoutSeconds) {
  const requestedTtl = timeoutSeconds + SANDBOX_OVERHEAD_SECONDS;
  const eligible = providers.filter((provider) => (provider.caps?.machineKinds ?? ['linux']).includes('linux')
    && (provider.caps?.uploadMaxBytes ?? Infinity) >= bundleSize
    && (provider.caps?.maxTtlSeconds ?? Infinity) >= requestedTtl
    && (!egress.length || provider.caps?.hasEgressPolicy));
  const rejected = providers.filter((provider) => !eligible.includes(provider));
  const tried = [];
  // A provider may grant a shorter lifetime than requested (E2B caps the timeout by plan): when the
  // granted deadline cannot cover the command, the machine is deleted and the next provider tried.
  const lifetimeOk = async (provider, sandbox) => {
    const granted = Number(sandbox?.deleteAt) || Date.parse(sandbox?.deleteAt ?? '') || 0;
    if (!granted || granted >= Date.now() + timeoutSeconds * 1000) return true;
    try { await sandbox.kill(); }
    catch (e) {
      const owner = ownerFor(provider, sandbox.id, sandbox?.deleteAt);
      throw Object.assign(new Error(`Provider ${provider.name} granted a sandbox lifetime ending ${new Date(granted).toISOString()} — before the ${timeoutSeconds}-second command could finish — and the sandbox could not be deleted: ${textOf(e)}`), { cause: e, owner, provider: provider.name, machine_id: owner.machine_id, selector: owner.selector });
    }
    tried.push({ provider: provider.name, code: 'ttl_too_short', message: `the granted sandbox lifetime ends ${new Date(granted).toISOString()}, before the ${timeoutSeconds}s command can finish` });
    return false;
  };
  for (const provider of eligible) {
    const ttlSeconds = requestedTtl;
    try {
      const sandbox = await provider.create({
        image: 'agent-browser', envs: {}, labels, name: labels.owner, ttlSeconds, includeGithubToken: false,
        ...(egress.length && { egress: { allow: egress } }),
      });
      if (await lifetimeOk(provider, sandbox)) return { provider, sandbox, owner: ownerFor(provider, sandbox.id, sandbox.deleteAt), ttlSeconds };
      continue;
    } catch (error) {
      if (error?.code === 'cleanup_unconfirmed' && error?.allocated === true) {
        const owner = ownerFor(provider, error.machineId ?? 'unknown');
        throw Object.assign(new Error(textOf(error)), { cause: error, owner, provider: provider.name, machine_id: owner.machine_id, selector: owner.selector });
      }
      const how = classifyCreateFailure(error);
      if (how === 'reconcile') {
        const adopted = await reconcileCreate(provider, labels);
        if (await lifetimeOk(provider, adopted.sandbox)) return { provider, sandbox: adopted.sandbox, owner: { ...adopted.owner, hasShell: provider.caps?.hasShell !== false }, ttlSeconds, reconciled: true };
        continue;
      }
      if (how !== 'next') throw error;
      tried.push({ provider: provider.name, code: error?.code, message: textOf(error).split('\n')[0] });
    }
  }
  if (!eligible.length) {
    throw new Error(rejected.length
      ? `No configured provider can run a Linux sandbox with this ${bundleSize}-byte local snapshot, a ${timeoutSeconds}-second timeout plus setup/inspection time, and the current network policy. ${rejected.map((p) => `${p.name} is not Linux-compatible, its upload limit or machine lifetime is too small, or it cannot enforce the configured network policy.`).join(' ')}`
      : 'No configured providers are available.');
  }
  const detail = tried.map((item) => `${item.provider}${item.code ? ` (${item.code})` : ''}: ${item.message}`).join('; ');
  throw new Error(`No configured provider could create the exec sandbox.${detail ? ` ${detail}` : ''}`);
}

async function inspectWorkspace(sandbox, repoPath, originalSha, originalRefs) {
  try {
    const r = await sandbox.commands.run(String.raw`git status --porcelain --untracked-files=all --ignored=matching && printf '\n--CC-HEAD--\n' && git rev-parse HEAD && printf '\n--CC-REFS--\n' && git for-each-ref --format='%(refname) %(objectname)' && printf '\n--CC-WT--\n' && git worktree list | wc -l`, {
      cwd: repoPath, timeoutMs: 30_000,
    });
    const raw = String(r.stdout ?? '');
    const headMark = '\n--CC-HEAD--\n';
    const refsMark = '\n--CC-REFS--\n';
    const wtMark = '\n--CC-WT--\n';
    const headAt = raw.lastIndexOf(headMark);
    const refsAt = raw.lastIndexOf(refsMark);
    const wtAt = raw.lastIndexOf(wtMark);
    const status = headAt < 0 ? '' : raw.slice(0, headAt).trim();
    const currentSha = headAt < 0 || refsAt < headAt ? '' : raw.slice(headAt + headMark.length, refsAt).trim();
    const refs = refsAt < 0 || wtAt < refsAt ? '' : raw.slice(refsAt + refsMark.length, wtAt).trim();
    const worktrees = wtAt < 0 ? NaN : Number(raw.slice(wtAt + wtMark.length).trim());
    if (!/^[0-9a-f]{40}$/i.test(currentSha)) throw new Error('remote HEAD output was incomplete');
    if (!Number.isInteger(worktrees) || worktrees < 1) throw new Error('remote worktree count was incomplete');
    return { verified: true, dirty: Boolean(status), changed: currentSha !== originalSha, refsChanged: refs !== originalRefs, extraWorktrees: worktrees > 1, head: currentSha };
  } catch (error) {
    return { verified: false, dirty: null, changed: null, error: textOf(error) };
  }
}

async function runExec(options, deps) {
  if (!Array.isArray(options.argv) || options.argv.length === 0 || options.argv.some((value) => typeof value !== 'string')) {
    throw new Error('argv must be a non-empty list of strings');
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const env = deps.env ?? loadEnv();
  const root = await realpath(options.repo).catch(() => { throw new Error(`repo does not exist: ${options.repo}`); });
  const isRepo = await git(root, 'rev-parse', '--show-toplevel').catch(() => '');
  if (!isRepo || await realpath(isRepo) !== root) throw new Error('--repo must name the root of a git repository');
  const head = await git(root, 'rev-parse', 'HEAD').catch(() => '');
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('the local repository needs at least one commit before exec can snapshot it');
  const providers = deps.providers ?? await loadProviders(env, deps.providerDeps);
  if (!providers.length) throw new Error('No configured providers are available.');
  const network = egressAllow(env);
  if (network.error) throw new Error(network.error);

  // Include tracked worktree and index edits in a commit-shaped snapshot without changing the
  // caller's index or worktree. Like worker snapshots, untracked files are not uploaded.
  const dirtySnapshot = await git(root, '-c', 'core.quotePath=false', 'stash', 'create');
  const maxUpload = Math.max(...providers.map((p) => Math.max(0, (p.caps?.uploadMaxBytes ?? Infinity) - 1024)));
  const snapshots = createSnapshotManager({ git, remoteRefs: async () => '' });
  const snapshot = await snapshots.acquire(root, head, dirtySnapshot || undefined, maxUpload);
  const ownerId = `exec-${randomBytes(4).toString('hex')}`;
  const labels = { purpose: 'cloudy-cloud', owner: ownerId };
  let placement;
  let sandbox;
  let remoteRepo;
  let argvFile;
  let bundleFile;
  let originalRefs = '';
  try {
    placement = await place(providers, env, labels, snapshot.size, network.list, options.timeout);
    sandbox = placement.sandbox;
    remoteRepo = `${sandbox.home ?? '/home/user'}/repo`;
    const bundle = await snapshot.read();
    if (!bundle) throw new Error('the full local repository snapshot could not be read');
    const home = sandbox.home ?? '/home/user';
    // The bundle can carry a credential inside tracked history, so it uses the upload-only route (writeSecret fails closed).
    bundleFile = `${home}/in.bundle`;
    await writeSecretFile(sandbox, bundleFile, bundle);
    // argv can hold a credential too, so it is never interpolated into the provider's command string: the script is uploaded
    // through the same secret route and the remote command names only its path.
    argvFile = `${home}/exec-argv.sh`;
    await writeSecretFile(sandbox, argvFile, `${shellCommand(options.argv)}\n`);
    const setup = [
      `chmod 600 ${quote(argvFile)}`,
      'git init -q repo',
      'cd repo',
      'git config user.name cloudy-cloud',
      'git config user.email cloudy-cloud@localhost',
      `git fetch -q ../in.bundle ${snapshot.sha}`,
      `git checkout -q --detach ${snapshot.sha}`,
    ].join(' && ');
    const initialized = await sandbox.commands.run(`${setup} && git for-each-ref --format='%(refname) %(objectname)'`, { cwd: home, timeoutMs: 120_000 });
    originalRefs = String(initialized.stdout ?? '').trim();
  } catch (error) {
    await snapshot.release();
    if (sandbox && placement) {
      // The uploaded argv script (and bundle) can hold a credential: remove it before a possibly
      // preserved machine is handed back, then delete.
      if (argvFile) await sandbox.commands.run(`rm -f ${quote(argvFile)} ${quote(bundleFile)}`, { timeoutMs: 10_000 }).catch(() => {});
      try { await deleteAndConfirm(placement.provider, sandbox.id); }
      catch (deleteError) {
        const owner = placement.owner;
        return failed(`Exec setup failed and the provider did not confirm sandbox deletion: ${textOf(deleteError)}`, {
          provider: owner.provider, machine_id: owner.machine_id, owner, preserve_machine: true,
          action: ownerAction(owner), cleanup_command: `cloudy-cloud machines stop ${quote(owner.selector)}`,
        });
      }
    }
    const owner = error.owner ?? (error.owners?.length === 1 ? error.owners[0] : undefined);
    const uncertain = error.owners?.length > 0;
    return failed(`Exec setup failed: ${textOf(error)}`, {
      ...(owner && { provider: owner.provider, machine_id: owner.machine_id, owner }),
      ...(uncertain && { owners: error.owners }),
      ...(owner || uncertain ? {
        preserve_machine: true,
        ...(owner && { cleanup_command: `cloudy-cloud machines stop ${quote(owner.selector)}` }),
        action: owner ? ownerAction(owner) : 'Inspect provider-qualified machines with: cloudy-cloud machines ls',
      } : {}),
    });
  }

  const stdoutState = { text: '', bytes: 0, truncated: false };
  const stderrState = { text: '', bytes: 0, truncated: false };
  const emitStdout = deps.stdout ?? (() => {});
  const emitStderr = deps.stderr ?? (() => {});
  let streamedChars = 0;
  let streamedErrChars = 0;
  let commandError;
  let commandResult;
  try {
    // The argv script removes itself (and the consumed bundle) when the command ends, so a retained
    // machine never keeps a file that can hold a credential; the exit code is passed through.
    commandResult = await sandbox.commands.run(`sh ${quote(argvFile)}; s=$?; rm -f ${quote(argvFile)} ${quote(bundleFile)}; exit $s`, {
      cwd: remoteRepo,
      timeoutMs: options.timeout * 1000,
      onStdout: (chunk) => {
        const value = String(chunk);
        streamedChars += value.length;
        capAppend(stdoutState, value);
        emit(emitStdout, value);
      },
      onStderr: (chunk) => {
        const value = String(chunk);
        streamedErrChars += value.length;
        capAppend(stderrState, value);
        emit(emitStderr, value);
      },
    });
  } catch (error) { commandError = error; }
  const returnedOut = String(commandResult?.stdout ?? commandError?.stdout ?? '');
  if (returnedOut.length > streamedChars) {
    const tail = returnedOut.slice(streamedChars);
    capAppend(stdoutState, tail);
    emit(emitStdout, tail);
  }
  const returnedErr = String(commandResult?.stderr ?? commandError?.stderr ?? '');
  if (returnedErr.length > streamedErrChars) {
    const tail = returnedErr.slice(streamedErrChars);
    capAppend(stderrState, tail);
    emit(emitStderr, tail);
  }

  // A command killed before its own cleanup (or a removed-file race) still leaves the script: remove it
  // here too so a machine the inspection keeps never retains it.
  if (argvFile) await sandbox.commands.run(`rm -f ${quote(argvFile)} ${quote(bundleFile)}`, { timeoutMs: 10_000 }).catch(() => {});
  const inspection = await inspectWorkspace(sandbox, remoteRepo, snapshot.sha, originalRefs);
  const code = commandError ? exitOf(commandError) : Number.isInteger(commandResult?.exitCode) ? commandResult.exitCode : 0;
  const commandKnown = !commandError || code !== undefined;
  const preserve = !inspection.verified || inspection.dirty === true || inspection.changed === true || inspection.refsChanged === true || inspection.extraWorktrees === true || !commandKnown;
  const owner = placement.owner;
  let cleanupError;
  if (!preserve) {
    try { await deleteAndConfirm(placement.provider, sandbox.id); }
    catch (error) { cleanupError = error; }
  }
  await snapshot.release();

  const output = {
    status: code === 0 && !commandError && !cleanupError && inspection.verified ? 'completed' : 'failed',
    exit_code: code ?? null,
    provider: placement.provider.name,
    machine_id: owner.machine_id,
    owner,
    stdout: bounded(stdoutState),
    stderr: bounded(stderrState),
    stderr_streamed: streamedErrChars > 0,
    output_truncated: stdoutState.truncated || stderrState.truncated,
    workspace_dirty: inspection.dirty,
    workspace_changed: inspection.changed,
    refs_changed: inspection.refsChanged,
    extra_worktrees: inspection.extraWorktrees,
    preserve_machine: preserve || Boolean(cleanupError),
    error: Boolean(commandError || code !== 0 || cleanupError || !inspection.verified),
  };
  if (commandError || code !== 0) output.message = commandKnown ? `Remote command exited with code ${code}.` : `The command result could not be confirmed: ${textOf(commandError)}`;
  else if (cleanupError) output.message = `The command finished, but the provider did not confirm sandbox deletion: ${textOf(cleanupError)}`;
  else if (!inspection.verified) output.message = `The command ended, but the remote workspace could not be verified (${inspection.error}); the sandbox was retained.`;
  else if (inspection.dirty || inspection.changed || inspection.refsChanged || inspection.extraWorktrees) output.message = 'The command finished with uncommitted files, changed Git commits or branches, or additional worktrees; the sandbox was retained.';
  if (output.preserve_machine) {
    output.action = ownerAction(owner);
    output.cleanup_command = `cloudy-cloud machines stop ${quote(owner.selector)}`;
  }
  if (cleanupError) output.cleanup_error = textOf(cleanupError);
  return output;
}

function parse(argv) {
  const options = { timeout: 35 * 60, json: false, argv: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { options.argv = argv.slice(i + 1); break; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo' || arg === '--timeout') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--repo') options.repo = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_SECONDS) throw new Error(`--timeout must be from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
        options.timeout = Number(value);
      }
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  if (!options.help && !options.repo) throw new Error('--repo is required');
  if (!options.help && !options.argv.length) throw new Error('a command is required after --');
  if (options.argv.some((arg) => typeof arg !== 'string')) throw new Error('every command argument must be a string');
  return options;
}

export const parseExecArgs = parse;
export const executeRemoteArgv = (argv, deps = {}) => runExec({ repo: deps.repo ?? deps.cwd ?? process.cwd(), argv, timeout: deps.timeout ?? 35 * 60 }, deps);

export async function main(argv = process.argv.slice(2), deps = {}) {
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  let options;
  try { options = parse(argv); }
  catch (error) { writeErr(`${error.message}\nusage: cloudy-cloud exec --repo PATH [--timeout SECONDS] [--json] -- COMMAND [ARG ...]\n`); return 2; }
  if (options.help) { writeOut('usage: cloudy-cloud exec --repo PATH [--timeout SECONDS] [--json] -- COMMAND [ARG ...]\n'); return 0; }
  try {
    const result = await runExec(options, {
      ...deps,
      json: options.json,
      stdout: options.json ? () => {} : (chunk) => writeOut(chunk),
      stderr: (chunk) => writeErr(chunk),
    });
    if (options.json) writeOut(`${JSON.stringify(result)}\n`);
    else {
      if (result.error || result.preserve_machine) writeErr(`${result.message ?? 'Remote command failed.'}${result.action ? `\nNext step: ${result.action}` : ''}\n`);
      else writeErr(`Provider: ${result.provider}\n`);
    }
    if (result.status === 'completed') return Number.isInteger(result.exit_code) ? result.exit_code : 0;
    return Number.isInteger(result.exit_code) && result.exit_code !== 0 ? result.exit_code : 1;
  } catch (error) {
    const result = failed(textOf(error));
    if (options.json) writeOut(`${JSON.stringify(result)}\n`);
    else writeErr(`cloudy-cloud exec: ${result.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
