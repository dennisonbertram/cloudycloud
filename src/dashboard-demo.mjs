// Sample data for `cloudy-cloud dashboard --demo`. Nothing here is real.
import { pushOf } from './events.mjs';

const M = 60_000, H = 60 * M;

// A failed turn: the exit line, a long npm log, then the footer the real server writes.
const failedText = ['Subagent failed, exit code 1.',
  'npm ERR! code E403', 'npm ERR! 403 403 Forbidden - GET https://registry.npmjs.org/date-fns',
  ...Array.from({ length: 38 }, (_, i) => `npm verb stack step ${i + 1}: request to https://registry.npmjs.org/date-fns failed, reason: 403`),
  '', 'The sandbox could not be reached to push. Only work the agent already pushed to origin cloudy-cloud/90aa13fc survives.',
  'Model: claude-sonnet-5-5', 'Total: 9 tool uses, 41.2k in / 3.1k out tokens, $0.2140, 12m 4s'].join('\n');

export function demoState(now = Date.now()) {
  const ago = (ms) => now - ms;
  const lastPush = (msgs) => { const r = msgs.findLast((m) => m.kind === 'reply'), p = r && pushOf(r.text); return p ? { push: { ...p, t: r.t } } : {}; };
  const kids = new Set(['7c1e90ab', 'b42f0d17', 'e08a5c33']); // the demo coordinator's workers; the rest were started by this session
  const box = (o) => ({
    kind: 'agent', role: 'worker', machineState: o.status === 'stopped' ? 'deleted' : 'running', ...o, ...lastPush(o.messages), branch: `cloudy-cloud/${o.id}`, machine: `m-${o.id}`,
    title: o.description, titleSource: 'log', source: 'log', turns: o.messages.filter((m) => m.kind === 'out').length,
    labels: { purpose: 'cloudy-cloud', role: 'worker', profile: o.profile ?? 'claude', parent: kids.has(o.id) ? 'fleet-main' : 'demo-session', agent: o.id, description: o.description },
    ...(kids.has(o.id) && { parent: 'fleet-main' }), startedBy: kids.has(o.id) ? 'fleet-main' : 'this session',
  });
  const boxes = [
    box({
      id: '7c1e90ab', description: 'Add retry with backoff to the upload client', status: 'running', profile: undefined, model: 'claude-sonnet-5-5', mcp: ['notion', 'context7'],
      startedAt: ago(18 * M), lastActivity: ago(9_000), deadline: ago(18 * M) + 8 * H,
      messages: [
        { t: ago(18 * M), kind: 'out', text: 'Add exponential backoff with jitter to src/upload/client.ts. Retry only on 429 and 5xx, at most 5 tries. Add tests next to the existing ones and push to your branch.' },
        { t: ago(16 * M), kind: 'progress', text: 'Read src/upload/client.ts' },
        { t: ago(14 * M), kind: 'progress', text: 'Grep fetchWithAuth' },
        { t: ago(11 * M), kind: 'progress', text: 'Edit src/upload/client.ts' },
        { t: ago(6 * M), kind: 'progress', text: 'Write test/upload/retry.test.ts' },
        { t: ago(2 * M), kind: 'progress', text: 'Bash npm test -- upload' },
        { t: ago(9_000), kind: 'progress', text: 'Edit src/upload/client.ts' },
      ],
    }),
    box({
      id: 'b42f0d17', description: 'Review the billing webhook for race conditions', status: 'idle', profile: 'glm', model: 'z-ai/glm-5.3-flash',
      startedAt: ago(52 * M), lastActivity: ago(14 * M), idleSince: ago(14 * M), deadline: ago(14 * M) + H,
      messages: [
        { t: ago(52 * M), kind: 'out', text: 'Read src/billing/webhook.ts and list any way two deliveries of the same event could be applied twice. Do not change code yet.' },
        { t: ago(48 * M), kind: 'progress', text: 'Read src/billing/webhook.ts' },
        { t: ago(44 * M), kind: 'progress', text: 'Grep processedEvents' },
        { t: ago(41 * M), kind: 'reply', text: 'Two problems.\n\n1. The idempotency check reads processedEvents, then writes it in a separate query (lines 84-97). Two deliveries arriving together both pass the check.\n2. A failed handler still marks the event as processed, so Stripe\'s retry is ignored.\n\nPushed to origin cloudy-cloud/b42f0d17 at 3fa9c01. Fetch with: git fetch origin cloudy-cloud/b42f0d17.\nModel: z-ai/glm-5.3-flash\nTotal: 2 tool uses, 6.8k in / 0.9k out tokens, 41s' },
        { t: ago(30 * M), kind: 'out', text: 'Fix problem 1 only, with a unique constraint and an insert-or-ignore. Keep the change small.' },
        { t: ago(26 * M), kind: 'progress', text: 'Edit src/billing/webhook.ts' },
        { t: ago(14 * M), kind: 'reply', text: 'Done. The event id is now inserted first; a duplicate insert returns early. Added a migration and one test that sends the same event twice.\n\nPushed to origin cloudy-cloud/b42f0d17 at 9d2e7b4. Fetch with: git fetch origin cloudy-cloud/b42f0d17.\nModel: z-ai/glm-5.3-flash\nTotal: 5 tool uses, 14.2k in / 1.7k out tokens, 3m 12s' },
      ],
    }),
    box({
      id: 'e08a5c33', description: 'Port the settings page to the new form components', status: 'starting', model: 'claude-sonnet-5-5',
      startedAt: ago(40_000), lastActivity: ago(5_000), deadline: ago(40_000) + 8 * H,
      messages: [{ t: ago(40_000), kind: 'out', text: 'Replace the hand-written inputs in app/settings/page.tsx with the shared Form, Field and Switch components. Keep the page behaviour the same.' }],
    }),
    box({
      id: '51d9ee02', description: 'Fix flaky checkout e2e test', status: 'queued', profile: 'deepseek', model: 'deepseek-ai/deepseek-v41-flash-1017',
      startedAt: ago(12_000), lastActivity: ago(12_000), deadline: ago(12_000) + 8 * H,
      messages: [{ t: ago(12_000), kind: 'out', text: 'The checkout e2e test fails about one run in five. Find out why and fix the cause, not with a longer timeout.' }],
    }),
    box({
      id: '90aa13fc', description: 'Migrate the date helpers off moment', status: 'failed', model: 'claude-sonnet-5-5',
      startedAt: ago(3 * H), lastActivity: ago(2.6 * H), stoppedAt: ago(2.6 * H),
      messages: [
        { t: ago(3 * H), kind: 'out', text: 'Replace moment with date-fns in src/lib/dates.ts and every caller.' },
        { t: ago(2.7 * H), kind: 'progress', text: 'Bash npm install date-fns' },
        { t: ago(2.6 * H), kind: 'reply', error: true, text: failedText },
      ],
    }),
    box({
      id: 'a7716be4', description: 'Write the changelog for 2.4', status: 'stopped', model: 'claude-sonnet-5-5',
      startedAt: ago(5 * H), lastActivity: ago(4.2 * H), stoppedAt: ago(4.2 * H),
      messages: [
        { t: ago(5 * H), kind: 'out', text: 'Read the commits since v2.3.0 and draft CHANGELOG.md for 2.4 in the existing style.' },
        { t: ago(4.5 * H), kind: 'reply', text: 'CHANGELOG.md has a new 2.4 section with 14 entries, grouped as Added, Changed and Fixed.\n\nPushed to origin cloudy-cloud/a7716be4 at 1c80e55. Fetch with: git fetch origin cloudy-cloud/a7716be4.\nModel: claude-sonnet-5-5\nTotal: 7 tool uses, 22.5k in / 2.4k out tokens, 4m 50s' },
      ],
    }),
    box({
      id: '3e5b7a60', description: 'Add dark mode tokens to the design system', status: 'stopped', profile: 'openrouter', model: 'anthropic/claude-haiku-5',
      startedAt: ago(7 * H), lastActivity: ago(6.5 * H), stoppedAt: ago(6.5 * H),
      messages: [{ t: ago(7 * H), kind: 'out', text: 'Add a dark palette to tokens.css behind prefers-color-scheme.' }, { t: ago(6.6 * H), kind: 'reply', text: 'Added 24 tokens and a dark block.\n\nPushed to origin cloudy-cloud/3e5b7a60 at e4410aa. Fetch with: git fetch origin cloudy-cloud/3e5b7a60.\nModel: anthropic/claude-haiku-5\nTotal: 3 tool uses, 5.1k in / 1.2k out tokens, 1m 8s' }],
    }),
    { kind: 'coordinator', id: 'fleet-main', machine: 'm-fleet-main', role: 'coordinator', description: 'Cloud coordinator for the migration fleet', title: 'Cloud coordinator for the migration fleet', titleSource: 'label', source: 'machine', labels: { purpose: 'cloudy-cloud', role: 'coordinator', name: 'fleet-main', description: 'Cloud coordinator for the migration fleet' }, children: [...kids], startedBy: 'this session', status: 'running', machineState: 'running', startedAt: ago(7.5 * H), lastActivity: ago(2 * M), deadline: ago(7.5 * H) + 8 * H, messages: [] },
  ];
  return { now, demo: true, hasLog: true, machines: { ok: true }, boxes };
}

// Demo stream (raw Claude Code stream-json lines) and coordinator pane for `--demo`: built from each demo box's messages, so
// every progress line becomes a tool call with a result and every reply becomes text plus a result line.
export const demoStream = {
  stream(id, turn) {
    const box = demoState().boxes.find((b) => b.id === id && b.kind === 'agent');
    let n = 0;
    const msgs = (box?.messages ?? []).filter((m) => { if (m.kind === 'out') n++; return n === turn && m.kind !== 'out'; });
    if (!msgs.length) return undefined;
    const lines = [{ type: 'system', subtype: 'init', model: box.model, session_id: 'demo', tools: ['Bash', 'Read', 'Edit'], mcp_servers: (box.mcp ?? []).map((name) => ({ name, status: 'connected' })), timestamp: box.startedAt }];
    msgs.forEach((m, i) => {
      if (m.kind === 'progress') {
        const [name, ...rest] = m.text.split(' '), arg = rest.join(' ');
        lines.push({ type: 'assistant', timestamp: m.t, message: { content: [{ type: 'tool_use', id: `tu${i}`, name, input: name === 'Bash' ? { command: arg } : name === 'Grep' ? { pattern: arg } : { file_path: arg } }] } });
        lines.push({ type: 'user', timestamp: m.t + 1500, message: { content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: `(demo output of ${m.text})` }] } });
      } else {
        lines.push({ type: 'assistant', timestamp: m.t, message: { content: [{ type: 'text', text: m.text }] } });
        lines.push({ type: 'result', timestamp: m.t, subtype: m.error ? 'error' : 'success', is_error: !!m.error, result: m.text, total_cost_usd: 0.0214, duration_ms: 124_000, session_id: 'demo', usage: { input_tokens: 4100, cache_read_input_tokens: 37_000, output_tokens: 3100 } });
      }
    });
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  },
  pane: (id) => (id === 'fleet-main' ? ['$ claude', '> cloud_agent_list', '  7c1e90ab  running  Add retry with backoff to the upload client', '  b42f0d17  idle     Review the billing webhook for race conditions', '  e08a5c33  starting Port the settings page to the new form components', '> cloud_agent_wait 7c1e90ab b42f0d17', 'Waiting for 2 agents...'] : undefined),
};
