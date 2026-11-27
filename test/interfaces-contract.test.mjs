import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ENTRY = new URL('../support/server-entry.mjs', import.meta.url).pathname;
const TASKS = 'io.modelcontextprotocol/tasks';
const META = (tasks = false) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'interface-contract-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': tasks ? { extensions: { [TASKS]: {} } } : {},
});
const children = [];
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-contract-'));
  await exec('sh', ['-c', 'git init -q -b main && git config user.name t && git config user.email t@t && echo x > a.txt && git add -A && git commit -qm init && git remote add origin https://github.com/test/repo.git'], { cwd: dir });
  return dir;
}

async function connect(tasks = false) {
  const cwd = await repo();
  const child = spawn('node', [ENTRY], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  children.push(child);
  const pending = new Map();
  let id = 0, buf = '';
  child.stdout.on('data', (data) => {
    buf += data;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });
  const raw = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const meta = META(tasks);
  const rpc = (method, params = {}) => raw(method, { ...params, _meta: meta });
  await rpc('server/discover');
  return { child, cwd, rpc, call: (name, args = {}) => rpc('tools/call', { name, arguments: args }) };
}

test('agent-first tools advertise workspace binding, capabilities and typed results', async (t) => {
  const c = await connect();
  t.after(() => c.child.kill());
  const list = (await c.rpc('tools/list')).result.tools;
  const agent = list.find((tool) => tool.name === 'cloud_agent');
  assert.ok(agent.inputSchema.properties.workspace, 'cloud_agent accepts an explicitly bound workspace');
  assert.ok(agent.outputSchema, 'cloud_agent advertises a structured result');
  assert.ok(list.some((tool) => tool.name === 'cloud_agent_capabilities'), 'callers can discover local profiles, providers and machine kinds');

  const capabilities = await c.call('cloud_agent_capabilities', {});
  assert.ok(capabilities.result.structuredContent.profiles.some((profile) => profile.name === 'claude'));
  assert.ok(capabilities.result.structuredContent.providers.some((provider) => provider.name === 'instabox'));
  assert.match(capabilities.result.content[0].text, /profiles[\s\S]*providers/);

  const started = await c.call('cloud_agent', { prompt: 'OK contract', description: 'contract', workspace: '.' });
  const result = started.result.structuredContent;
  assert.equal(result.status, 'starting');
  assert.match(result.agent_id, /^[0-9a-f]{8}$/);
  assert.equal(result.branch, `cloudy-cloud/${result.agent_id}`);
  assert.equal(result.provider, undefined, 'the response does not claim an adapter before the machine exists');
  assert.match(started.result.content[0].text, /agent_id: [0-9a-f]{8}[\s\S]*Call cloud_agent_wait/);
});

test('task completion preserves readable text and includes the same typed lifecycle fields', async (t) => {
  const c = await connect(true);
  t.after(() => c.child.kill());
  const started = await c.call('cloud_agent', { prompt: 'OK task', description: 'task', workspace: '.' });
  const task = started.result;
  assert.equal(task.resultType, 'task');
  let complete;
  for (let i = 0; i < 100; i++) {
    complete = await c.rpc('tasks/get', { taskId: task.taskId });
    if (complete.result?.status === 'completed') break;
    await tick(50);
  }
  assert.equal(complete.result.status, 'completed', JSON.stringify(complete.result));
  assert.match(complete.result.result.content[0].text, /done OK/);
  assert.equal(complete.result.result.structuredContent.agent_id, task.taskId.split('-')[1]);
  assert.equal(complete.result.result.structuredContent.status, 'idle');
  assert.equal(complete.result.result.structuredContent.provider, 'fake');
});

test('workspace traversal is rejected before a worker starts', async (t) => {
  const c = await connect();
  t.after(() => c.child.kill());
  const r = await c.call('cloud_agent', { prompt: 'OK escape', description: 'escape', workspace: '../' });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /workspace must stay inside the bound repo/);
});
