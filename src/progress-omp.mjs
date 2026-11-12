// Parser for `omp -p --mode json` (fixtures: test/fixtures/omp-json-*.jsonl, recorded in the #36 spike). The events match pi's, so this
// wraps createPiProgress. Differences: there is no agent_settled (the stream ends at agent_end, and p.end() settles), and there
// is no responseModel. message.model only repeats the requested id (live on Particle: pi saw glm5.3flash, omp still said
// z-ai/glm-5.3-flash), so the model stays unconfirmed and the footer says "requested; not confirmed by the provider". advisor_cost_changed is ignored; noisy tool_execution_update and
// message_update events are dropped before anything else sees them.
import { createPiProgress } from './progress-pi.mjs';

const NOISY = new Set(['tool_execution_update', 'message_update', 'advisor_cost_changed']);

export function createOmpProgress(now) {
  const p = createPiProgress(now);
  const piEvent = p.event;
  p.event = (j) => {
    if (NOISY.has(j?.type)) return;
    piEvent(j);
    p.answered = false; // pi's "no responseModel means the same model" reasoning does not hold for omp
  };
  return p;
}

export function parseOmpStream(text) {
  const p = createOmpProgress();
  p.feed(text);
  p.end();
  return p;
}
