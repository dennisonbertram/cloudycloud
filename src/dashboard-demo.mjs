// Sample data for `cloudy-cloud dashboard --demo`. Nothing here is real.
const M = 60_000, H = 60 * M;

export function demoState(now = Date.now()) {
  const ago = (ms) => now - ms;
  const box = (o) => ({ kind: 'agent', role: 'worker', machineState: o.status === 'stopped' ? 'deleted' : 'running', ...o, branch: `cloudy-cloud/${o.id}`, machine: `m-${o.id}` });
  const boxes = [
    box({
      id: '7c1e90ab', description: 'Add retry with backoff to the upload client', status: 'running', profile: undefined, model: 'claude-sonnet-5-5',
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
        { t: ago(41 * M), kind: 'reply', text: 'Two problems.\n\n1. The idempotency check reads processedEvents, then writes it in a separate query (lines 84-97). Two deliveries arriving together both pass the check.\n2. A failed handler still marks the event as processed, so Stripe\'s retry is ignored.\n\nPushed notes to origin cloudy-cloud/b42f0d17 at 3fa9c01.' },
        { t: ago(30 * M), kind: 'out', text: 'Fix problem 1 only, with a unique constraint and an insert-or-ignore. Keep the change small.' },
        { t: ago(26 * M), kind: 'progress', text: 'Edit src/billing/webhook.ts' },
        { t: ago(14 * M), kind: 'reply', text: 'Done. The event id is now inserted first; a duplicate insert returns early. Added a migration and one test that sends the same event twice.\n\nPushed to origin cloudy-cloud/b42f0d17 at 9d2e7b4.' },
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
        { t: ago(2.6 * H), kind: 'reply', error: true, text: 'Subagent failed, exit code 1.\nnpm ERR! 403 Forbidden - GET https://registry.npmjs.org/date-fns\n\nOnly work the agent already pushed to origin cloudy-cloud/90aa13fc survives.' },
      ],
    }),
    box({
      id: 'a7716be4', description: 'Write the changelog for 2.4', status: 'stopped', model: 'claude-sonnet-5-5',
      startedAt: ago(5 * H), lastActivity: ago(4.2 * H), stoppedAt: ago(4.2 * H),
      messages: [
        { t: ago(5 * H), kind: 'out', text: 'Read the commits since v2.3.0 and draft CHANGELOG.md for 2.4 in the existing style.' },
        { t: ago(4.5 * H), kind: 'reply', text: 'CHANGELOG.md has a new 2.4 section with 14 entries, grouped as Added, Changed and Fixed.\n\nPushed to origin cloudy-cloud/a7716be4 at 1c80e55.' },
      ],
    }),
    box({
      id: '3e5b7a60', description: 'Add dark mode tokens to the design system', status: 'stopped', profile: 'openrouter', model: 'anthropic/claude-haiku-5',
      startedAt: ago(7 * H), lastActivity: ago(6.5 * H), stoppedAt: ago(6.5 * H),
      messages: [{ t: ago(7 * H), kind: 'out', text: 'Add a dark palette to tokens.css behind prefers-color-scheme.' }, { t: ago(6.6 * H), kind: 'reply', text: 'Added 24 tokens and a dark block. Pushed at e4410aa.' }],
    }),
    { kind: 'coordinator', id: 'fleet-main', machine: 'm-fleet-main', role: 'coordinator', description: 'Cloud coordinator for the migration fleet', status: 'running', machineState: 'running', startedAt: ago(7.5 * H), lastActivity: ago(2 * M), deadline: ago(7.5 * H) + 8 * H, messages: [] },
  ];
  return { now, demo: true, hasLog: true, machines: { ok: true }, boxes };
}
