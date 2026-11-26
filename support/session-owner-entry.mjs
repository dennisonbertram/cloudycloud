// A subprocess-only named owner for the reconnect regression. It uses the real MCP handlers and a fake sandbox.
import { buildServer } from '../src/mcp.mjs';
import { SocketTransport, serveNamedSession } from '../src/session-transport.mjs';
import { parseServerArgs } from '../src/session-args.mjs';
import { createFakeProvider } from '../test/fake-provider.mjs';
import { killAll } from '../src/run-subagent.mjs';

let machine = 0;
const createSandbox = async () => {
  let prompt = '';
  const dead = new AbortController();
  const aborted = (signal) => new Promise((_, reject) => {
    for (const s of [signal, dead.signal]) s?.addEventListener('abort', () => reject(Object.assign(new Error('killed'), { exitCode: 143, stderr: 'terminated' })), { once: true });
  });
  return {
    id: `fake-machine-${++machine}`,
    home: '/home/user',
    files: { write: async (path, data) => { if (path.endsWith('prompt.txt')) prompt = String(data); } },
    kill: async () => dead.abort(),
    commands: {
      async run(cmd, { onStdout, signal } = {}) {
        if (!cmd.includes('claude -p')) return { stdout: cmd.includes('PUSHOK') ? 'PUSHOK\nSHA abcdef1234567\nSTATUS_OK\n' : '', stderr: '', exitCode: 0 };
        const emit = async (line) => { await onStdout?.(`${line}\n`); };
        await emit('{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"src/a.ts"}}],"usage":{"input_tokens":100,"output_tokens":10}}}');
        if (prompt.startsWith('HANG')) await aborted(signal);
        if (prompt.startsWith('SLOW')) await new Promise((resolve) => setTimeout(resolve, 500));
        await emit(`{"type":"result","subtype":"success","is_error":false,"session_id":"11111111-2222-3333-4444-555555555555","result":"done ${prompt.split(' ')[0]}","total_cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":10}}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
  };
};

const options = parseServerArgs(process.argv.slice(2));
const owner = `test-${process.pid}`;
const env = { FAKE_API_KEY: 'fake-key', ANTHROPIC_API_KEY: 'sk-ant-test-claude-key', CLOUDY_CLOUD_PROXY_SECRETS: 'ANTHROPIC_API_KEY' };
const deps = { provider: createFakeProvider({ FAKE_API_KEY: 'fake-key' }), owner, env, createSandbox, open: new Map(), tasks: new Map(), events: () => {}, cancelWaitMs: 300 };
const host = await serveNamedSession({
  name: options.session, repo: options.repo, owner, deps, idleCheckMs: Number(process.env.CC_TEST_IDLE_MS) || 100,
  onClose: () => setImmediate(() => process.exit(0)),
  onConnection: (socket) => { void buildServer(deps).connect(new SocketTransport(socket)).catch(() => socket.destroy()); },
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => killAll(deps.open).finally(() => host.close().finally(() => process.exit())));
