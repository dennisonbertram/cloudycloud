import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These tests spawn the real server over stdio. support/server-entry.mjs is the server with a scripted fake sandbox
// (the production server.mjs builds an Instabox sandbox and cannot take one), so everything from the wire protocol through
// serveStdio, the tool handlers and the task methods is real.
const exec = promisify(execFile);
const ENTRY = new URL('../support/server-entry.mjs', import.meta.url).pathname;
const TASKS = 'io.modelcontextprotocol/tasks';
const META = (extensions) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': extensions ? { extensions: { [TASKS]: {} } } : {},
});
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
after(() => children.forEach((c) => c.kill()));

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-srv-'));
  const sh = (c) => exec('sh', ['-c', c], { cwd: dir });
  await sh('git init -q -b main && git config user.name t && git config user.email t@t && echo x > a.txt && git add -A && git commit -qm init && git remote add origin https://github.com/test/repo.git');
  return dir;
}

// A client for one connection. mode: 'modern' (2026-07-28, with or without the tasks extension) or 'legacy' (2025-11-25 initialize).
async function connect(mode) {
  const child = spawn('node', [ENTRY], { cwd: await repo(), stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const pending = new Map();
  let id = 0, buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines.filter(Boolean)) { const m = JSON.parse(l); pending.get(m.id)?.(m); }
  });
  const raw = (method, params) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const meta = mode === 'legacy' ? undefined : META(mode === 'modern+tasks');
  const rpc = (method, params = {}) => raw(method, meta ? { ...params, _meta: meta } : params);
  if (mode === 'legacy') {
    const init = await raw('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  } else {
    const d = await rpc('server/discover');
    assert.deepEqual(d.result.supportedVersions, ['2026-07-28']);
  }
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const poll = async (taskId, until, ms = 8000) => {
    const seen = [];
    for (const end = Date.now() + ms; Date.now() < end; await tick(50)) {
      const r = await rpc('tasks/get', { taskId });
      seen.push(r);
      if (until(r)) return { last: r, seen };
    }
    assert.fail(`timed out; last responses: ${JSON.stringify(seen.slice(-3))}`);
  };
  return { rpc, call, poll, child };
}
const done = (r) => r.result?.status === 'completed' || r.result?.status === 'failed' || r.result?.status === 'cancelled';
const text = (r) => r.result.content[0].text;

test('with the tasks extension, cloud_agent answers with a task; tasks/get shows live progress, then the result', async () => {
  const c = await connect('modern+tasks');
  const r = await c.call('cloud_agent', { prompt: 'SLOW go', description: 'd' });
  const t = r.result;
  assert.equal(t.resultType, 'task');
  assert.match(t.taskId, /^cc-[0-9a-f]{8}-t1$/);
  assert.equal(t.status, 'working');
  assert.equal(t.ttlMs, null);
  assert.ok(t.createdAt && t.lastUpdatedAt);
  assert.ok(t.pollIntervalMs >= 250);

  const { last, seen } = await c.poll(t.taskId, (x) => done(x));
  const working = seen.filter((x) => x.result.status === 'working');
  assert.ok(working.some((x) => /^1 tool use · 1\.0k tokens · \ds · Read src\/a\.ts$/.test(x.result.statusMessage)), JSON.stringify(working.map((x) => x.result.statusMessage)));
  assert.ok(working.every((x) => x.result.resultType === 'complete' && x.result.statusMessage.length <= 200));
  assert.equal(last.result.status, 'completed');
  assert.equal(last.result.resultType, 'complete');
  const out = last.result.result.content[0].text;
  assert.match(out, new RegExp(`agent_id: ${t.taskId.split('-')[1]} \\(turn 1\\)`));
  assert.match(out, /done SLOW/);
  assert.match(out, /Pushed to origin cloudy-cloud\//);
  assert.match(out, /Total: 2 tool uses, 1\.0k in \/ 42 out tokens, \$0\.0123, \d+s$/);
  assert.equal(last.result.statusMessage.startsWith('2 tool uses · 1.0k tokens'), true);

  // the task result counts as reported, and cloud_agent_list shows the same progress fields
  const w = await c.call('cloud_agent_wait', { agent_ids: [t.taskId.split('-')[1]], timeout_seconds: 5 });
  assert.match(text(w), /already reported/);
  const list = text(await c.call('cloud_agent_list', {}));
  assert.match(list, /idle\s+idle 0 min\s+deleted at \S+\s+d\n\s+cc-[0-9a-f]{8}-t1: 2 tool uses · 1\.0k tokens/);
});

test('cloud_agent_message answers with a task for turn 2 of the same agent', async () => {
  const c = await connect('modern+tasks');
  const t1 = (await c.call('cloud_agent', { prompt: 'OK one', description: 'd' })).result;
  await c.poll(t1.taskId, done);
  const agent = t1.taskId.split('-')[1];
  const t2 = (await c.call('cloud_agent_message', { agent_id: agent, message: 'OK two' })).result;
  assert.equal(t2.resultType, 'task');
  assert.equal(t2.taskId, `cc-${agent}-t2`);
  const { last } = await c.poll(t2.taskId, done);
  assert.match(last.result.result.content[0].text, /done OK/);
});

test('a failed turn is a failed task with error.message', async () => {
  const c = await connect('modern+tasks');
  const t = (await c.call('cloud_agent', { prompt: 'FAIL now', description: 'd' })).result;
  const { last } = await c.poll(t.taskId, done);
  assert.equal(last.result.status, 'failed');
  assert.match(last.result.error.message, /Subagent failed, exit code 3\.\nboom/);
  assert.equal(typeof last.result.error.code, 'number');
  assert.equal(last.result.result, undefined);
});

test('an unknown task id is JSON-RPC error -32602 for tasks/get and tasks/cancel', async () => {
  const c = await connect('modern+tasks');
  for (const m of ['tasks/get', 'tasks/cancel']) {
    const r = await c.rpc(m, { taskId: 'cc-00000000-t1' });
    assert.equal(r.error?.code, -32602, JSON.stringify(r));
  }
});

test('tasks/cancel on cloud_agent stops the whole agent', async () => {
  const c = await connect('modern+tasks');
  const t = (await c.call('cloud_agent', { prompt: 'HANG', description: 'd' })).result;
  await c.poll(t.taskId, (x) => /Read src\/a\.ts/.test(x.result.statusMessage ?? ''));
  const r = await c.rpc('tasks/cancel', { taskId: t.taskId });
  assert.equal(r.result.status, 'cancelled');
  assert.equal((await c.rpc('tasks/get', { taskId: t.taskId })).result.status, 'cancelled');
  assert.match(text(await c.call('cloud_agent_list', {})), /No agents\./);
});

test('tasks/cancel on cloud_agent_message stops only that turn; the agent stays open and takes another message', async () => {
  const c = await connect('modern+tasks');
  const t1 = (await c.call('cloud_agent', { prompt: 'OK one', description: 'd' })).result;
  await c.poll(t1.taskId, done);
  const agent = t1.taskId.split('-')[1];
  const t2 = (await c.call('cloud_agent_message', { agent_id: agent, message: 'HANG' })).result;
  await c.poll(t2.taskId, (x) => /Read src\/a\.ts/.test(x.result.statusMessage ?? ''));
  const r = await c.rpc('tasks/cancel', { taskId: t2.taskId });
  assert.equal(r.result.status, 'cancelled');
  assert.match(text(await c.call('cloud_agent_list', {})), new RegExp(`${agent}  idle`));
  const t3 = (await c.call('cloud_agent_message', { agent_id: agent, message: 'OK three' })).result;
  assert.equal(t3.taskId, `cc-${agent}-t3`);
  const { last } = await c.poll(t3.taskId, done);
  assert.equal(last.result.status, 'completed');
  // cancelling a finished task changes nothing
  assert.equal((await c.rpc('tasks/cancel', { taskId: t3.taskId })).result.status, 'completed');
});

test('modern revision without the tasks extension: immediate result, cloud_agent_wait collects it', async () => {
  const c = await connect('modern');
  const r = await c.call('cloud_agent', { prompt: 'OK plain', description: 'd' });
  assert.notEqual(r.result.resultType, 'task');
  assert.match(text(r), /agent_id: [0-9a-f]{8}\nstatus: starting\nCall cloud_agent_wait/);
  const id = text(r).match(/agent_id: ([0-9a-f]{8})/)[1];
  const w = await c.call('cloud_agent_wait', { agent_ids: [id], timeout_seconds: 10 });
  assert.match(text(w), /status: idle\ndone OK/);
  assert.match(text(w), /Total: 2 tool uses/);
});

test('older protocol revision (2025-11-25): all five tools are listed and work with immediate results', async () => {
  const c = await connect('legacy');
  const list = (await c.rpc('tools/list')).result.tools;
  assert.deepEqual(list.map((t) => t.name), ['cloud_agent', 'cloud_agent_message', 'cloud_agent_wait', 'cloud_agent_list', 'cloud_agent_stop']);
  assert.deepEqual(list.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name), ['cloud_agent_wait', 'cloud_agent_list']);
  const r = await c.call('cloud_agent', { prompt: 'OK old', description: 'd' });
  assert.equal(r.result.resultType, undefined);
  const id = text(r).match(/agent_id: ([0-9a-f]{8})/)[1];
  assert.match(text(await c.call('cloud_agent_wait', { agent_ids: id, timeout_seconds: 10 })), /done OK/);
  assert.match(text(await c.call('cloud_agent_message', { agent_id: id, message: 'OK again' })), /status: running/);
  assert.match(text(await c.call('cloud_agent_wait', { agent_ids: [id], timeout_seconds: 10 })), /done OK/);
  assert.match(text(await c.call('cloud_agent_stop', { agent_ids: [id] })), /stopped/);
});
