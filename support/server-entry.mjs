// Test-only entry: the real MCP server (buildServer + serveStdio) with a scripted fake sandbox instead of Instabox.
// The fake runs no shell. The prompt picks what the "claude" run does: OK, SLOW, FAIL, HANG (waits until cancelled).
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from '../src/mcp.mjs';

const SID = '11111111-2222-3333-4444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (id, name, input) => JSON.stringify({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id: `tu${id}`, name, input }], usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10 } } });
const result = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SID, result: text, total_cost_usd: 0.0123, usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 42 } });

const createSandbox = async () => {
  let prompt = '';
  const dead = new AbortController();
  const aborted = (signal) => new Promise((_, rej) => {
    for (const s of [signal, dead.signal]) s?.addEventListener('abort', () => rej(Object.assign(new Error('killed'), { exitCode: 143, stderr: 'terminated' })), { once: true });
  });
  return {
    home: '/home/user',
    files: { write: async (_p, d) => { prompt = String(d); } },
    kill: async () => { dead.abort(); },
    commands: {
      async run(cmd, { onStdout, signal } = {}) {
        if (!cmd.startsWith('claude -p')) return { stdout: cmd.includes('PUSHOK') ? 'PUSHOK\nSHA abcdef1234567\n' : '', stderr: '', exitCode: 0 };
        const out = [];
        const emit = async (l) => { out.push(l); await onStdout?.(`${l}\n`); };
        await emit(tool(1, 'Read', { file_path: 'src/a.ts' }));
        if (prompt.startsWith('FAIL')) throw Object.assign(new Error('exit'), { exitCode: 3, stderr: 'boom' });
        if (prompt.startsWith('HANG')) await aborted(signal);
        if (prompt.startsWith('SLOW')) await sleep(700);
        await emit(tool(2, 'Edit', { file_path: 'src/b.ts' }));
        await emit(result(`done ${prompt.split(' ')[0]}`));
        return { stdout: `${out.join('\n')}\n`, stderr: '', exitCode: 0 };
      },
    },
  };
};

serveStdio(() => buildServer({ createSandbox, env: {}, open: new Map(), tasks: new Map(), cancelWaitMs: 3000 }));
