// Parser for `pi --mode json` output (https://pi.dev/docs/latest/json). It builds the same progress object as progress.mjs.
// Events used: `session` (id), `tool_execution_start` (toolName, args), assistant `message_end` (usage, stopReason, content,
// errorMessage) and `agent_settled` (the run is over). `agent_end` is ignored, because pi may retry after it.
import { createProgress, num, stepOf } from './progress.mjs';

const textOf = (m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('');

export function createPiProgress(now) {
  const p = createProgress(now);
  let tin = 0, tout = 0, last, sessionId;
  const settle = () => {
    if (!last) return;
    const failed = last.stopReason === 'error' || last.stopReason === 'aborted';
    const text = textOf(last);
    p.final = { subtype: last.stopReason, is_error: failed, session_id: sessionId, result: failed ? (last.errorMessage || text || `pi stopped: ${last.stopReason}`) : text };
  };
  p.event = (j) => {
    if (j?.type === 'session') sessionId = j.id;
    else if (j?.type === 'tool_execution_start' && !p.seenTools.has(j.toolCallId)) {
      p.seenTools.add(j.toolCallId);
      p.tools++;
      p.step = stepOf({ name: j.toolName, input: j.args });
    } else if (j?.type === 'message_end' && j.message?.role === 'assistant') {
      const u = j.message.usage;
      tin += num(u?.input) + num(u?.cacheRead) + num(u?.cacheWrite);
      tout += num(u?.output);
      // responseModel is the model the provider answered with; `model` only repeats the request, so it confirms nothing.
      p.setModel(j.message.responseModel);
      p.answered = true;
      last = j.message;
      p.final = undefined; // a retry produced a newer message
    } else if (j?.type === 'agent_settled') settle();
  };
  p.totals = () => ({ tools: p.tools, in: tin, out: tout });
  const end = p.end;
  p.end = () => { end(); if (!p.final) settle(); };
  return p;
}

export function parsePiStream(text) {
  const p = createPiProgress();
  p.feed(text);
  p.end();
  return p;
}
