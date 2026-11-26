#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNamedSessionTransport } from './session-transport.mjs';

const usage = 'usage: cloudy-cloud run --repo PATH [--profile NAME] [--workspace PATH] [--session NAME] [--timeout SECONDS] [--json] -- PROMPT';
const resumeUsage = 'usage: cloudy-cloud resume RUN-ID [--json] [--timeout SECONDS]';
const MAX_TIMEOUT_SECONDS = 86_400;
const packageVersion = createRequire(import.meta.url)('../package.json').version;
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
export const isDifferentRunTurn = (candidate, expectedTurnId) => Boolean(expectedTurnId && candidate?.turn_id && candidate.turn_id !== expectedTurnId);
const currentUid = () => process.getuid?.() ?? 0;
const runHome = () => resolve(process.env.CLOUDY_CLOUD_SESSION_HOME || homedir());
const runDirectory = () => join(runHome(), '.config', 'cloudy-cloud', 'runs');
const runFile = (id) => join(runDirectory(), `${id}.json`);
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function writeRunRecord(record) {
  const dir = runDirectory();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort on platforms without chmod */ }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== currentUid()) || (stat.mode & 0o077)) throw new Error('Run records are not private to this user.');
  const file = runFile(record.id);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}

function readRunRecord(id) {
  if (!runIdPattern.test(id)) throw new Error('Run ID is invalid. Copy the full ID printed by cloudy-cloud run.');
  const file = runFile(id);
  let stat;
  try { stat = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') throw new Error(`Run ${id} is not available for this user.`); throw e; }
  if (!stat.isFile() || (process.getuid && stat.uid !== currentUid()) || (stat.mode & 0o077)) throw new Error('Run record is not private to this user.');
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Run record is unreadable.'); }
  if (record.id !== id || record.uid !== currentUid()) throw new Error('Run record does not belong to this user.');
  return record;
}

function parse(argv) {
  const out = { json: false, timeout: 35 * 60, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { out.rest = argv.slice(i + 1); break; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (['--repo', '--profile', '--workspace', '--session', '--timeout', '--description', '--model', '--issue', '--base', '--prompt'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--timeout') {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_SECONDS) throw new Error(`--timeout must be from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
        out.timeout = Number(value);
      } else out[arg.slice(2).replaceAll('-', '_')] = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    out.rest = argv.slice(i);
    break;
  }
  if (!out.help && !out.repo) throw new Error('--repo is required');
  out.prompt ??= out.rest.join(' ');
  if (!out.help && !out.prompt.trim()) throw new Error('a task prompt is required');
  return out;
}

function rpcClient(transport) {
  let nextId = 0;
  const pending = new Map();
  transport.onmessage = (message) => {
    if (message?.id === undefined) return;
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    if (message.error) wait.reject(Object.assign(new Error(message.error.message ?? 'MCP request failed'), { code: message.error.code }));
    else wait.resolve(message.result);
  };
  transport.onerror = (error) => {
    for (const wait of pending.values()) wait.reject(error instanceof Error ? error : new Error(String(error)));
    pending.clear();
  };
  transport.onclose = () => {
    for (const wait of pending.values()) wait.reject(new Error('the MCP owner connection closed'));
    pending.clear();
  };
  const request = (method, params = {}, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    Promise.resolve(transport.send({ jsonrpc: '2.0', id, method, params })).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });
  const notify = (method, params = {}) => transport.send({ jsonrpc: '2.0', method, params });
  return { request, notify };
}

const toolCall = async (client, name, args) => client.request('tools/call', { name, arguments: args }, name === 'cloud_agent_wait' ? ((args.timeout_seconds ?? 600) * 1000 + 5000) : 15_000);
const outputText = (result) => result?.content?.find((block) => block.type === 'text')?.text ?? '';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(options, resumeRecord) {
  const repo = await realpath(options.repo).catch(() => { throw new Error(`repo does not exist: ${options.repo}`); });
  if (resumeRecord && repo !== resumeRecord.repo) throw new Error(`Run ${resumeRecord.id} belongs to ${resumeRecord.repo}; resume it from that repository.`);
  const id = resumeRecord?.id ?? randomUUID();
  const name = resumeRecord?.session ?? options.session ?? `run-${randomBytes(6).toString('hex')}`;
  let record = resumeRecord ?? { id, uid: currentUid(), repo, session: name, agent_id: null, description: options.description ?? options.prompt.replace(/\s+/g, ' ').slice(0, 80), created_at: Date.now() };
  if (!resumeRecord) {
    writeRunRecord(record);
  }
  const transport = await createNamedSessionTransport({ name, repo, home: runHome(), requireExisting: !!resumeRecord });
  const client = rpcClient(transport);
  let agentId;
  let final;
  let timedOut = false;
  try {
    await transport.start();
    const init = await client.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cloudy-cloud-run', version: packageVersion },
    });
    if (init?.protocolVersion !== '2025-11-25') throw new Error('the MCP owner did not accept the CLI protocol');
    await client.notify('notifications/initialized');

    const args = resumeRecord ? {} : {
      prompt: options.prompt,
      description: options.description ?? options.prompt.replace(/\s+/g, ' ').slice(0, 80),
      ...(options.profile && { profile: options.profile }),
      ...(options.workspace && { workspace: options.workspace }),
      ...(options.model && { model: options.model }),
      ...(options.issue && { issue: options.issue }),
      ...(options.base && { base: options.base }),
    };
    let started;
    try {
      if (resumeRecord) {
        if (!record.agent_id) throw new Error('The worker start was not confirmed before the original terminal disconnected; refusing to start a duplicate worker.');
        agentId = record.agent_id;
        started = { structuredContent: { agent_id: agentId, branch: record.branch, provider: record.provider, profile: record.profile } };
      } else started = await toolCall(client, 'cloud_agent', args);
    }
    catch (error) {
      final = {
        status: 'failed', error: true, recoverable: true, session: name, repo,
        run_id: id,
        message: `The CLI could not confirm whether the worker started: ${error.message}`,
        action: `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and call cloud_agent_list to check for the worker described as ${JSON.stringify(args.description)}; stop it after you have preserved any result.`,
      };
      return final;
    }
    const startData = started?.structuredContent;
    agentId = startData?.agent_id ?? /agent_id: ([0-9a-f]{8})/.exec(outputText(started))?.[1];
    if (started?.isError || !agentId) {
      final = { ...(startData ?? {}), status: 'failed', error: true, message: startData?.message ?? outputText(started) };
      final.run_id = id;
      if (agentId) Object.assign(final, { agent_id: agentId, recoverable: true, session: name, repo, action: `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and call cloud_agent_result or cloud_agent_wait for agent ${agentId}.` });
      return final;
    }
    if (!resumeRecord) {
      record = { ...record, agent_id: agentId, turn_id: startData?.turn_id, branch: startData?.branch, provider: startData?.provider, profile: startData?.profile };
      writeRunRecord(record);
      process.stderr.write(`Run ID: ${id}\nResume with: cloudy-cloud resume ${id}\n`);
    }

    const reconnect = `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)}, then call cloud_agent_result or cloud_agent_wait for agent ${agentId} and stop it after you have preserved the result.`;
    const preserveAction = (agent) => agent?.workspace_dirty === true
      ? `Keep the worker open. Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)}, call cloud_agent_message for ${agentId} to ask it to commit and push the remaining workspace changes, then inspect cloud_agent_result before stopping it.`
      : `Keep the worker open. Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and inspect cloud_agent_result and cloud_agent_list for ${agentId}; workspace status was not confirmed, so do not stop it until you have checked for uncommitted work.`;
    const preserveFailure = (agent) => ({ ...agent, status: 'failed', error: true, preserve_worker: true, recoverable: true, session: name, repo,
      message: agent.workspace_dirty === true ? 'The worker left uncommitted workspace changes; the CLI kept it open for recovery.' : 'The worker workspace status could not be confirmed; the CLI kept it open for inspection.',
      action: preserveAction(agent) });
    const changedTurnFailure = () => ({ status: 'failed', error: true, recoverable: true, preserve_worker: true, agent_id: agentId, session: name, repo,
      message: 'The worker has a newer turn than the one attached to this run; the CLI left it open.',
      action: `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and inspect cloud_agent_list and cloud_agent_result for ${agentId} before deciding what to stop.` });
    const deadline = Date.now() + options.timeout * 1000;
    while (Date.now() < deadline) {
      const seconds = Math.max(1, Math.min(1500, Math.ceil((deadline - Date.now()) / 1000)));
      let waited;
      try { waited = await toolCall(client, 'cloud_agent_wait', { agent_ids: [agentId], timeout_seconds: seconds }); }
      catch (error) {
        final = { status: 'failed', agent_id: agentId, branch: startData?.branch, provider: startData?.provider, profile: startData?.profile, error: true, recoverable: true, session: name, repo, message: `Could not confirm worker completion: ${error.message}`, action: reconnect };
        break;
      }
      let agent = waited?.structuredContent?.agents?.[0];
      if (isDifferentRunTurn(agent, record.turn_id)) {
        final = changedTurnFailure();
        break;
      }
      if (agent && ['idle', 'failed', 'stopped'].includes(agent.status) && (!agent.result || agent.reported)) {
        try {
          const latest = await toolCall(client, 'cloud_agent_result', { agent_id: agentId });
          const latestAgent = latest?.structuredContent;
          if (isDifferentRunTurn(latestAgent, record.turn_id)) {
            final = changedTurnFailure();
            break;
          }
          if (!latest?.isError && latestAgent?.result) agent = { ...agent, ...latestAgent };
        } catch { /* the wait response remains the best available state */ }
      }
      if (agent && ['idle', 'failed', 'stopped'].includes(agent.status)) {
        if (waited?.isError || !agent.result || agent.error || agent.status !== 'idle') {
          final = { ...agent, status: 'failed', error: true, recoverable: true, session: name, repo, action: reconnect };
          if (agent.preserve_worker) final = preserveFailure(agent);
          break;
        }
        final = { ...agent, status: 'completed', error: false };
        break;
      }
    }
    if (!final) {
      timedOut = true;
      final = { status: 'failed', agent_id: agentId, branch: startData?.branch, profile: startData?.profile, error: true, recoverable: true, session: name, repo, message: `Worker did not finish within ${options.timeout} seconds.`, action: `${reconnect} To wait longer next time, increase the limit with --timeout ${Math.min(MAX_TIMEOUT_SECONDS, options.timeout * 2)}.` };
    }
    if (final.status === 'completed') {
      if (final.preserve_worker) {
        final = preserveFailure(final);
      } else if (!final.turn_id) {
        final = { ...final, status: 'failed', error: true, preserve_worker: true, recoverable: true, session: name, repo,
          message: 'The result did not identify its completed turn, so the CLI kept the worker open instead of stopping a possibly resumed task.',
          action: `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and inspect cloud_agent_list before stopping ${agentId}.` };
      } else {
        let outcome, stopText = '', stopError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const stopped = await toolCall(client, 'cloud_agent_stop', { agent_ids: [agentId], expected_turn_id: final.turn_id, expected_status: 'idle' });
            outcome = stopped?.structuredContent?.agents?.[0];
            stopText = outputText(stopped);
            if (stopped?.isError) stopError = stopText || 'the stop request failed';
            else if (outcome?.status === 'stopped' || outcome?.status === 'not-open') { stopError = undefined; break; }
            else if (outcome?.status === 'not-stopped') { stopError = outcome.message ?? 'the worker changed state before automatic cleanup'; break; }
            else stopError = outcome?.message ?? stopText ?? 'the provider did not confirm machine deletion';
          } catch (error) { stopError = error.message; }
          if (attempt < 2) await pause(250 * (attempt + 1));
        }
        if (stopError) {
          const changedTurn = outcome?.status === 'not-stopped';
          const action = changedTurn
            ? `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and inspect cloud_agent_list for ${agentId}; a newer turn may be running, so decide manually whether to stop it.`
            : `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and retry cloud_agent_stop for ${agentId}. The worker remains tracked while deletion is unconfirmed.`;
          final = { ...final, status: 'failed', error: true, cleanup_error: true, preserve_worker: !changedTurn, recoverable: true, session: name, repo,
            message: changedTurn ? 'The worker resumed before automatic cleanup; the CLI did not stop the newer turn.' : `The worker finished, but deletion was not confirmed after three attempts: ${stopError}`,
            action };
        }
      }
    }
    final.run_id = id;
    record = {
      ...record,
      status: final.status,
      ...(final.turn_id && { turn_id: final.turn_id }),
      ...(!timedOut && final.turn_id && typeof final.result === 'string' && { cached_result: final }),
      updated_at: Date.now(),
    };
    writeRunRecord(record);
    return final;
  } catch (error) {
    error.runId = id;
    throw error;
  } finally {
    await transport.close().catch(() => {});
    if (timedOut) process.exitCode = 124;
  }
}

function print(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (value.result) process.stdout.write(`${value.result}\n`);
  if (value.error) {
    process.stderr.write(`${value.message ?? 'Worker failed.'}${value.action ? `\nNext step: ${value.action}` : ''}\n`);
  } else {
    if (value.branch) process.stdout.write(`Branch: ${value.branch}\n`);
    if (value.provider) process.stdout.write(`Provider: ${value.provider}\n`);
    if (value.profile) process.stdout.write(`Profile: ${value.profile}\n`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--resume') {
    let id, json = false, timeout = 35 * 60;
    try {
      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') json = true;
        else if (arg === '--help' || arg === '-h') { process.stdout.write(`${resumeUsage}\n`); return 0; }
        else if (arg === '--timeout') {
          const value = argv[++i];
          if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_SECONDS) throw new Error(`--timeout must be from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
          timeout = Number(value);
        } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        else if (!id) id = arg;
        else throw new Error(`unexpected argument ${arg}`);
      }
      if (!id) throw new Error('a run ID is required');
      const record = readRunRecord(id);
      if (record.cached_result) {
        const result = { ...record.cached_result, run_id: id };
        print(result, json);
        return result.error ? 1 : 0;
      }
      const result = await run({ repo: record.repo, timeout }, record);
      result.run_id = id;
      print(result, json);
      return result.error ? (process.exitCode === 124 ? 124 : 1) : 0;
    } catch (error) {
      if (!id) { process.stderr.write(`${error.message}\n${resumeUsage}\n`); return 2; }
      const result = { status: 'failed', error: true, recoverable: true, run_id: id, message: error.message, action: 'Retry resume; it uses the repository recorded for this run and never starts a replacement worker.' };
      print(result, json);
      return 1;
    }
  }
  let options;
  try { options = parse(argv); }
  catch (error) { process.stderr.write(`${error.message}\n${usage}\n`); return 2; }
  if (options.help) { process.stdout.write(`${usage}\n`); return 0; }
  try {
    const result = await run(options);
    print(result, options.json);
    return result.error ? (process.exitCode === 124 ? 124 : 1) : 0;
  } catch (error) {
    const result = { status: 'failed', error: true, ...(error.runId && { run_id: error.runId }), message: error.message, action: 'check the repo path and MCP owner, then run the command again' };
    print(result, options.json);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
