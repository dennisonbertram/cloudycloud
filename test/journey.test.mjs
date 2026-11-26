import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/mcp.mjs';
import { createEventLog, readEvents } from '../src/events.mjs';
import { combine } from '../src/providers/index.mjs';
import { serveNamedSession, SocketTransport } from '../src/session-transport.mjs';
import { run as runShell } from '../src/shell.mjs';
import { run as runMachines } from '../src/machines.mjs';
import { createFakeProvider, setGithub } from './fake-provider.mjs';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(paths) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socket);
    socket.setEncoding('utf8');
    let buffer = '', id = 0;
    const pending = new Map();
    const client = {
      socket,
      request(method, params = {}) {
        const requestId = ++id;
        return new Promise((done, fail) => {
          const timer = setTimeout(() => { pending.delete(requestId); fail(new Error(`timed out: ${method}`)); }, 15_000);
          pending.set(requestId, (message) => { clearTimeout(timer); done(message); });
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
        });
      },
      notify(method, params = {}) { socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
      async close() { socket.end(); await new Promise((done) => socket.once('close', done)); },
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    socket.once('connect', async () => {
      try {
        const init = await client.request('initialize', {
          protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'journey-acceptance', version: '1' },
        });
        assert.equal(init.result.protocolVersion, '2025-11-25');
        client.notify('notifications/initialized');
        resolve(client);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('error', reject);
  });
}

async function tool(client, name, args = {}) {
  const response = await client.request('tools/call', { name, arguments: args });
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
  return response.result.content?.[0]?.text ?? '';
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('an agent stays addressable across MCP reconnects, fills the secondary provider at primary capacity, and management follows placement', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cc-journey-'));
  const repo = join(temp, 'repo');
  const github = join(temp, 'github');
  const bare = join(github, 'test', 'repo.git');
  execFileSync('mkdir', ['-p', repo, join(github, 'test')]);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'journey fixture');
  git(repo, 'config', 'user.email', 'journey@example.invalid');
  execFileSync('sh', ['-c', 'printf "synthetic repository\\n" > README.md'], { cwd: repo });
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'synthetic base');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/test/repo.git');
  git(temp, 'init', '-q', '--bare', '-b', 'main', bare);
  setGithub(github);

  const env = {
    ANTHROPIC_API_KEY: 'sk-test-synthetic-credential',
    CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY',
    CLOUDY_CLOUD_PROFILES: join(temp, 'no-profiles.json'),
    CLOUDY_CLOUD_MCP: join(temp, 'no-mcp.json'),
    CLOUDY_CLOUD_EVENTS: join(temp, 'events.jsonl'),
  };
  const primary = createFakeProvider({ FAKE_API_KEY: 'offline-primary' }, { name: 'primary' });
  const secondary = createFakeProvider({ FAKE_API_KEY: 'offline-secondary' }, { name: 'secondary' });
  const createSecondary = secondary.create.bind(secondary);
  secondary.create = async (options) => {
    const sandbox = await createSecondary(options);
    const nativeId = sandbox.id, id = `secondary-${nativeId}`;
    const row = secondary.machines.get(nativeId);
    secondary.machines.delete(nativeId);
    secondary.machines.set(id, { ...row, id });
    sandbox.id = id;
    const kill = sandbox.kill;
    sandbox.kill = async () => { await kill(); secondary.machines.delete(id); };
    return sandbox;
  };
  const createPrimary = primary.create.bind(primary);
  primary.create = async (options) => {
    if ([...primary.machines.values()].some((machine) => machine.state === 'running')) {
      throw Object.assign(new Error('synthetic primary capacity is full'), { code: 'machine_no_capacity' });
    }
    return createPrimary(options);
  };
  const secondaryShell = [];
  secondary.shellArgv = (machine, command = []) => { secondaryShell.push(machine); return ['secondary-shell', machine, ...command]; };
  const provider = combine([primary, secondary]);
  const open = new Map();
  const writeEvent = createEventLog(env, 'journey-owner');
  let host;
  const deps = {
    provider, providers: [primary, secondary], env, owner: 'journey-owner', cwd: repo,
    open, tasks: new Map(),
    events: (event) => {
      writeEvent(event);
      if (event.type === 'machine') host?.recordPlacement({
        provider: event.provider, machine: event.machine, id: event.id, branch: event.branch, root: repo,
      });
    },
  };
  host = await serveNamedSession({
    name: 'journey acceptance', repo, home: join(temp, 'home'), owner: 'journey-owner', deps, idleCheckMs: 25,
    onConnection: (socket) => { void buildServer(deps).connect(new SocketTransport(socket)).catch(() => socket.destroy()); },
  });

  let first, reconnected;
  try {
    first = await connect(host.paths);
    const started = await tool(first, 'cloud_agent', { prompt: 'EDIT first turn', description: 'journey primary' });
    const firstId = /agent_id: ([0-9a-f]{8})/.exec(started)?.[1];
    assert.ok(firstId, started);
    assert.match(await tool(first, 'cloud_agent_wait', { agent_ids: [firstId], timeout_seconds: 10 }), /status: idle[\s\S]*Pushed to origin cloudy-cloud\//);
    await first.close();
    first = undefined;

    reconnected = await connect(host.paths);
    const continued = await tool(reconnected, 'cloud_agent_message', { agent_id: firstId, message: 'EDIT2 follow-up' });
    assert.match(continued, new RegExp(`agent_id: ${firstId}`));
    const followed = await tool(reconnected, 'cloud_agent_wait', { agent_ids: [firstId], timeout_seconds: 10 });
    assert.match(followed, /status: idle[\s\S]*resumed [0-9a-f-]{36} edited2/);
    assert.match(await tool(reconnected, 'cloud_agent_result', { agent_id: firstId }), /resumed [0-9a-f-]{36} edited2/);

    const secondStarted = await tool(reconnected, 'cloud_agent', { prompt: 'EDIT second worker', description: 'journey secondary fill' });
    const secondId = /agent_id: ([0-9a-f]{8})/.exec(secondStarted)?.[1];
    assert.ok(secondId && secondId !== firstId, secondStarted);
    const secondResult = await tool(reconnected, 'cloud_agent_wait', { agent_ids: [secondId], timeout_seconds: 10 });
    assert.match(secondResult, /status: idle[\s\S]*Started on secondary because primary could not start it \(machine_no_capacity:/);
    assert.equal(primary.log.create.length, 1, 'the full primary did not create a second machine');
    assert.equal(secondary.log.create.length, 1, 'the secondary filled the next worker request');

    const events = readEvents(env.CLOUDY_CLOUD_EVENTS);
    const placementEvents = events.filter((event) => event.type === 'machine');
    assert.deepEqual(placementEvents.map(({ id, provider: name }) => [id, name]).sort(), [[firstId, 'primary'], [secondId, 'secondary']].sort());
    const metadata = JSON.parse(await readFile(host.paths.metadata, 'utf8'));
    const firstPlacement = metadata.placements.find((row) => row.id === firstId);
    const secondPlacement = metadata.placements.find((row) => row.id === secondId);
    assert.deepEqual([firstPlacement.provider, firstPlacement.machine, firstPlacement.branch, firstPlacement.workspace], [
      'primary', [...primary.machines.keys()][0], `cloudy-cloud/${firstId}`, repo,
    ]);
    assert.deepEqual([secondPlacement.provider, secondPlacement.machine, secondPlacement.branch, secondPlacement.workspace], [
      'secondary', [...secondary.machines.keys()][0], `cloudy-cloud/${secondId}`, repo,
    ]);

    const shellArgs = [], shellErrors = [];
    assert.equal(await runShell([secondId, '--', 'printf', 'route-check'], {
      provider, env, list: async () => provider.list({ purpose: 'cloudy-cloud' }), events: () => readEvents(env.CLOUDY_CLOUD_EVENTS),
      spawn: (argv) => { shellArgs.push(argv); return { status: 0 }; }, out: () => {}, err: (message) => shellErrors.push(message),
    }), 0, shellErrors.join('\n'));
    assert.deepEqual(shellArgs, [['secondary-shell', secondPlacement.machine, 'printf', 'route-check']]);
    assert.deepEqual(secondaryShell, [secondPlacement.machine]);

    const stopOutput = [], stopErrors = [];
    assert.equal(await runMachines(['stop', secondId], {
      provider, env, list: async () => provider.list({ purpose: 'cloudy-cloud' }), events: () => readEvents(env.CLOUDY_CLOUD_EVENTS),
      out: (message) => stopOutput.push(message), err: (message) => stopErrors.push(message),
    }), 0, stopErrors.join('\n'));
    assert.match(stopOutput.join('\n'), /Deleted/);
    assert.ok(secondary.log.delete.includes(secondPlacement.machine), 'the secondary owner received the confirmed stop');
    assert.deepEqual(primary.log.delete, [], 'stopping a secondary machine did not delete from primary');
    assert.equal(secondary.machines.has(secondPlacement.machine), false, 'the stopped machine is absent from the owner list');

    assert.match(await tool(reconnected, 'cloud_agent_stop', { agent_ids: [secondId] }), /stopped/i);
    assert.equal(secondary.machines.has(secondPlacement.machine), false, 'stopping the secondary worker through MCP kept the recorded owner');
    assert.match(await tool(reconnected, 'cloud_agent_stop', { agent_ids: [firstId] }), /stopped/i);
    assert.equal(primary.machines.has(firstPlacement.machine), false, 'the first worker stop removed its primary machine');
    await reconnected.close();
    reconnected = undefined;
  } finally {
    if (first) await first.close().catch(() => {});
    if (reconnected) await reconnected.close().catch(() => {});
    for (const agent of open.values()) await agent.sandbox?.kill?.().catch(() => {});
    await host.close();
  }
});
