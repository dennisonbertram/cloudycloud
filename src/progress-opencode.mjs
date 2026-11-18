// Parser for `opencode run --format json` (opencode 1.18.31; fixtures: test/fixtures/opencode-json-*.jsonl, captured live).
// One JSON object per line: step_start, tool_use (one event per finished tool call), text, step_finish (tokens, reason) and
// error. A step_finish whose reason is not "tool-calls" ends the run; its step's text is the answer. Every event carries sessionID.
// The stream names no model, so the footer says "requested; not confirmed". Cost is not shown, like pi and omp.
import { createProgress, num, stepOf } from './progress.mjs';

export const createOpencodeProgress = (now) => {
  const p = createProgress(now);
  let tin = 0, tout = 0, sessionId, text = '';
  p.event = (j) => {
    if (typeof j?.sessionID === 'string') sessionId = j.sessionID;
    const part = j?.part ?? {};
    if (j?.type === 'step_start') { text = ''; p.final = undefined; }
    else if (j?.type === 'tool_use' && !p.seenTools.has(part.callID)) {
      p.seenTools.add(part.callID);
      p.tools++;
      const input = part.state?.input ?? {};
      p.step = stepOf({ name: part.tool, input: { ...input, file_path: input.filePath } });
    } else if (j?.type === 'text' && typeof part.text === 'string') text += part.text;
    else if (j?.type === 'step_finish') {
      const t = part.tokens;
      tin += num(t?.input) + num(t?.cache?.read) + num(t?.cache?.write);
      tout += num(t?.output) + num(t?.reasoning);
      if (part.reason !== 'tool-calls') p.final = { subtype: part.reason, is_error: false, session_id: sessionId, result: text.trim() };
    } else if (j?.type === 'error') {
      const e = j.error ?? {};
      p.final = { subtype: 'error', is_error: true, session_id: sessionId, result: [e.data?.message ?? e.message ?? e.name ?? 'opencode reported an error', e.data?.ref && `(ref ${e.data.ref})`].filter(Boolean).join(' ') };
    }
  };
  p.totals = () => ({ tools: p.tools, in: tin, out: tout });
  return p;
};

export function parseOpencodeStream(text) {
  const p = createOpencodeProgress();
  p.feed(text);
  p.end();
  return p;
}
