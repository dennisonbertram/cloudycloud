// Parser for `omp -p --mode json` (fixtures: test/fixtures/omp-json-*.jsonl, recorded in the #36 spike). The events match pi's, so this
// wraps createPiProgress. Differences: there is no agent_settled (the stream ends at agent_end, and p.end() settles), and the
// model is in message.model rather than responseModel. advisor_cost_changed is ignored; noisy tool_execution_update and
// message_update events are dropped before anything else sees them.
import { createPiProgress } from './progress-pi.mjs';

const NOISY = new Set(['tool_execution_update', 'message_update', 'advisor_cost_changed']);

export function createOmpProgress(now) {
  const p = createPiProgress(now);
  const piEvent = p.event;
  p.event = (j) => {
    if (NOISY.has(j?.type)) return;
    piEvent(j);
    if (j?.type === 'message_end' && j.message?.role === 'assistant') p.setModel(j.message.model);
  };
  return p;
}

export function parseOmpStream(text) {
  const p = createOmpProgress();
  p.feed(text);
  p.end();
  return p;
}
