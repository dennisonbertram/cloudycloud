#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createNamedSessionTransport } from './session-transport.mjs';

const usage = 'usage: cloudy-cloud run --repo PATH [--profile NAME] [--workspace PATH] [--session NAME] [--timeout SECONDS] [--json] -- PROMPT';
const MAX_TIMEOUT_SECONDS = 86_400;
const packageVersion = createRequire(import.meta.url)('../package.json').version;
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

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

async function run(options) {
  const repo = await realpath(options.repo).catch(() => { throw new Error(`repo does not exist: ${options.repo}`); });
  const name = options.session ?? `run-${randomBytes(6).toString('hex')}`;
  const transport = await createNamedSessionTransport({ name, repo });
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

    const args = {
      prompt: options.prompt,
      description: options.description ?? options.prompt.replace(/\s+/g, ' ').slice(0, 80),
      ...(options.profile && { profile: options.profile }),
      ...(options.workspace && { workspace: options.workspace }),
      ...(options.model && { model: options.model }),
      ...(options.issue && { issue: options.issue }),
      ...(options.base && { base: options.base }),
    };
    let started;
    try { started = await toolCall(client, 'cloud_agent', args); }
    catch (error) {
      final = {
        status: 'failed', error: true, recoverable: true, session: name, repo,
        message: `The CLI could not confirm whether the worker started: ${error.message}`,
        action: `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and call cloud_agent_list to check for the worker described as ${JSON.stringify(args.description)}; stop it after you have preserved any result.`,
      };
      return final;
    }
    const startData = started?.structuredContent;
    agentId = startData?.agent_id ?? /agent_id: ([0-9a-f]{8})/.exec(outputText(started))?.[1];
    if (started?.isError || !agentId) {
      final = { ...(startData ?? {}), status: 'failed', error: true, message: startData?.message ?? outputText(started) };
      if (agentId) Object.assign(final, { agent_id: agentId, recoverable: true, session: name, repo, action: `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and call cloud_agent_result or cloud_agent_wait for agent ${agentId}.` });
      return final;
    }

    const reconnect = `Reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)}, then call cloud_agent_result or cloud_agent_wait for agent ${agentId} and stop it after you have preserved the result.`;
    const deadline = Date.now() + options.timeout * 1000;
    while (Date.now() < deadline) {
      const seconds = Math.max(1, Math.min(1500, Math.ceil((deadline - Date.now()) / 1000)));
      let waited;
      try { waited = await toolCall(client, 'cloud_agent_wait', { agent_ids: [agentId], timeout_seconds: seconds }); }
      catch (error) {
        final = { status: 'failed', agent_id: agentId, branch: startData?.branch, provider: startData?.provider, profile: startData?.profile, error: true, recoverable: true, session: name, repo, message: `Could not confirm worker completion: ${error.message}`, action: reconnect };
        break;
      }
      const agent = waited?.structuredContent?.agents?.[0];
      if (agent && ['idle', 'failed', 'stopped'].includes(agent.status)) {
        if (waited?.isError || !agent.result || agent.error || agent.status !== 'idle') {
          final = { ...agent, status: 'failed', error: true, recoverable: true, session: name, repo, action: reconnect };
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
      try {
        const stopped = await toolCall(client, 'cloud_agent_stop', { agent_ids: [agentId] });
        const outcome = stopped?.structuredContent?.agents?.[0];
        if (stopped?.isError || !outcome || outcome.status !== 'stopped' || outcome.error) {
          final = { ...final, status: 'failed', error: true, cleanup_error: true, message: outcome?.message ?? outputText(stopped) ?? 'the provider did not confirm machine deletion', action: outcome?.action ?? `run cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and call cloud_agent_stop for ${agentId}; the server reaper will also retry cleanup` };
        }
      } catch (error) {
        final = { ...final, status: 'failed', error: true, cleanup_error: true, message: `The worker finished, but cleanup was not confirmed: ${error.message}`, action: `reconnect with cloudy-cloud mcp-server --session ${name} --repo ${shellQuote(repo)} and call cloud_agent_stop for ${agentId}; the server reaper will also retry cleanup` };
      }
    }
    return final;
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
  let options;
  try { options = parse(argv); }
  catch (error) { process.stderr.write(`${error.message}\n${usage}\n`); return 2; }
  if (options.help) { process.stdout.write(`${usage}\n`); return 0; }
  try {
    const result = await run(options);
    print(result, options.json);
    return result.error ? (process.exitCode === 124 ? 124 : 1) : 0;
  } catch (error) {
    const result = { status: 'failed', error: true, message: error.message, action: 'check the repo path and MCP owner, then run the command again' };
    print(result, options.json);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main());
