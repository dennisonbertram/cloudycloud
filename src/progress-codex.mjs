// Parser for `codex exec --json` (fixtures: test/fixtures/codex-json-*.jsonl, recorded from codex-cli 0.166.0). It builds the same
// progress object as progress.mjs. Events used: thread.started (thread_id, the id for `codex exec resume`), item.started and
// item.completed (command_execution, mcp_tool_call, file_change, web_search count as tool uses; the last agent_message is the answer),
// turn.completed (usage) and turn.failed (error.message). Codex does not report the model, so the model stays unconfirmed.
// input_tokens already includes the cached ones. A top-level `error` event can be a retry notice, so only turn.failed fails a turn.
import { createProgress, num, stepOf } from './progress.mjs';

const stepFor = (item) => {
  if (item.type === 'command_execution') return stepOf({ name: 'Bash', input: { command: item.command } });
  if (item.type === 'mcp_tool_call') return `${item.server}.${item.tool}`.slice(0, 60);
  if (item.type === 'file_change') return stepOf({ name: 'Edit', input: { path: item.changes?.[0]?.path } });
  if (item.type === 'web_search') return stepOf({ name: 'WebSearch', input: { query: item.query } });
};

export function createCodexProgress(now) {
  const p = createProgress(now);
  let tin = 0, tout = 0, sessionId, last;
  p.event = (j) => {
    if (j?.type === 'thread.started') sessionId = j.thread_id;
    else if ((j?.type === 'item.started' || j?.type === 'item.completed') && j.item) {
      const step = stepFor(j.item);
      if (step && !p.seenTools.has(j.item.id)) { p.seenTools.add(j.item.id); p.tools++; p.step = step; }
      if (j.type === 'item.completed' && j.item.type === 'agent_message' && typeof j.item.text === 'string') last = j.item.text;
    } else if (j?.type === 'turn.completed') {
      tin += num(j.usage?.input_tokens);
      tout += num(j.usage?.output_tokens);
      p.final = { subtype: 'success', is_error: false, session_id: sessionId, result: last ?? '' };
    } else if (j?.type === 'turn.failed') {
      p.final = { subtype: 'failed', is_error: true, session_id: sessionId, result: String(j.error?.message ?? 'codex turn failed') };
    }
  };
  p.totals = () => ({ tools: p.tools, in: tin, out: tout });
  return p;
}

export function parseCodexStream(text) {
  const p = createCodexProgress();
  p.feed(text);
  p.end();
  return p;
}
