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
  const box = (o) => ({ kind: 'agent', role: 'worker', machineState: o.status === 'stopped' ? 'deleted' : 'running', ...o, ...lastPush(o.messages), branch: `cloudy-cloud/${o.id}`, machine: `m-${o.id}` });
  const boxes = [
    box({
      id: '7c1e90ab', description: 'Add retry with backoff to the upload client', status: 'running', parent: 'fleet-main', startedBy: 'fleet-main', turns: 1, role: 'worker', profile: undefined, model: 'claude-sonnet-5-5', mcp: ['notion', 'context7'],
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
      id: 'b42f0d17', description: 'Review the billing webhook for race conditions', status: 'idle', turns: 2, startedBy: 'this session', profile: 'glm', model: 'z-ai/glm-5.3-flash',
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
      id: 'e08a5c33', description: 'Port the settings page to the new form components', status: 'starting', parent: 'fleet-main', startedBy: 'fleet-main', turns: 1, model: 'claude-sonnet-5-5',
      startedAt: ago(40_000), lastActivity: ago(5_000), deadline: ago(40_000) + 8 * H,
      messages: [{ t: ago(40_000), kind: 'out', text: 'Replace the hand-written inputs in app/settings/page.tsx with the shared Form, Field and Switch components. Keep the page behaviour the same.' }],
    }),
    box({
      id: '51d9ee02', description: 'Fix flaky checkout e2e test', status: 'queued', profile: 'deepseek', model: 'deepseek-ai/deepseek-v41-flash-1017',
      startedAt: ago(12_000), lastActivity: ago(12_000), deadline: ago(12_000) + 8 * H,
      messages: [{ t: ago(12_000), kind: 'out', text: 'The checkout e2e test fails about one run in five. Find out why and fix the cause, not with a longer timeout.' }],
    }),
    box({
      id: '90aa13fc', description: 'Migrate the date helpers off moment', status: 'failed', turns: 1, model: 'claude-sonnet-5-5',
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
    { kind: 'coordinator', id: 'fleet-main', machine: 'm-fleet-main', role: 'coordinator', children: ['7c1e90ab', 'e08a5c33', 'sbx-qqiksa86'], turns: 1, description: 'Cloud coordinator for the migration fleet', status: 'running', machineState: 'running', startedAt: ago(7.5 * H), lastActivity: ago(2 * M), deadline: ago(7.5 * H) + 8 * H, messages: [] },
    // A machine started before titles and stream capture existed: only the cloud list knows it.
    { kind: 'machine', id: 'sbx-qqiksa86', machine: 'sbx-qqiksa86', title: 'sbx-qqiksa86', description: 'sbx-qqiksa86', note: 'no title: started before labels (#48)', parent: 'fleet-main', startedBy: 'fleet-main', status: 'running', machineState: 'running', startedAt: ago(26 * M), lastActivity: ago(26 * M), deadline: ago(26 * M) + 8 * H, messages: [], turns: 1 },
  ];
  return { now, demo: true, hasLog: true, machines: { ok: true }, boxes };
}

// Demo stream for `GET /api/stream?box&turn&from` in the shape of the dashboard streams epic (#75): events { seq, t, turn, kind, ... },
// `next` is the value to pass as `from` next time. `event` (a seq) returns that one event untruncated, like `&event=<seq>&full=1`.
const T0 = Date.now(), BIG = Array.from({ length: 140 }, (_, i) => `export const step${i} = retry(upload, { attempt: ${i % 5}, baseMs: ${100 * (1 + i % 4)} });`).join('\n');
const FULL9 = JSON.stringify({ file_path: 'src/upload/client.ts', old_string: 'return fetchWithAuth(url, init);', new_string: BIG }, null, 2);
export function demoStream(box, turn, from = 0, now = Date.now(), event) {
  const t = (ms) => now - ms, tu = (seq, ms, name, input) => ({ seq, t: t(ms), turn: 1, kind: 'tool_use', name, input });
  const tr = (seq, ms, summary, isError) => ({ seq, t: t(ms), turn: 1, kind: 'tool_result', summary, isError: !!isError });
  const src = { machine: 'm-' + box, fetchedAt: now - 3000 };
  let events = [], source = { kind: 'machine', ...src }, complete = false, totals = { tools: 0, in: 0, out: 0, costUsd: 0 };
  if (box === '7c1e90ab') {
    events = [
      { seq: 0, t: t(18 * M), turn: 1, kind: 'init', model: 'claude-sonnet-5-5' },
      { seq: 1, t: t(17 * M), turn: 1, kind: 'thinking', chars: 1240 },
      { seq: 2, t: t(16.8 * M), turn: 1, kind: 'text', text: 'I will read the upload client first, then add a retry wrapper that only retries 429 and 5xx.' },
      tu(3, 16 * M, 'Read', { file_path: 'src/upload/client.ts' }), tr(4, 16 * M - 800, 'export async function uploadChunk(url, body) { ... } (212 lines)'),
      tu(5, 14 * M, 'Grep', { pattern: 'fetchWithAuth', path: 'src' }), tr(6, 14 * M - 600, '7 matches in 3 files'),
      { seq: 7, t: t(12 * M), turn: 1, kind: 'retry', attempt: 1, maxRetries: 5, errorStatus: 529, error: 'overloaded_error', retryDelayMs: 1000 },
      { seq: 8, t: t(11.9 * M), turn: 1, kind: 'text', text: 'The API was busy for a moment. Continuing with the edit.' },
      { seq: 9, t: t(11 * M), turn: 1, kind: 'tool_use', name: 'Edit', input: FULL9.slice(0, 4096), truncated: true },
      tr(10, 11 * M - 900, 'The file src/upload/client.ts has been updated.'),
      tu(11, 6 * M, 'Write', { file_path: 'test/upload/retry.test.ts', content: 'import { test } from "node:test";\n// retries on 429, gives up after 5 tries' }), tr(12, 6 * M - 700, 'File created successfully at test/upload/retry.test.ts'),
      tu(13, 2 * M, 'Bash', { command: 'npm test -- upload', description: 'Run the upload tests' }),
      tr(14, 2 * M - 30000, 'FAIL test/upload/retry.test.ts\n  expected 5 attempts, got 4\nnpm ERR! Test failed. See above for more details.', true),
      tu(15, 9_000, 'Edit', { file_path: 'src/upload/client.ts', old_string: 'attempt < max', new_string: 'attempt <= max' }),
    ];
    // one more tool call every 8 seconds so the live tail has something to append
    const extra = Math.min(12, Math.floor((now - T0) / 8000));
    for (let i = 0; i < extra; i++) events.push(i % 2 ? tr(16 + i, (extra - i) * 8000, 'ok (' + (i + 1) + ' tests passed)') : tu(16 + i, (extra - i) * 8000, 'Bash', { command: 'npm test -- upload' }));
    totals = { tools: events.filter((e) => e.kind === 'tool_use').length, in: 18400, out: 2100, costUsd: 0.0912 };
  } else if (box === 'b42f0d17') {
    source = { kind: 'local', path: '~/.config/cloudy-cloud/streams/b42f0d17/t' + turn + '.jsonl', bytes: 5120, fetchedAt: now };
    complete = true;
    events = [
      { seq: 0, t: t(52 * M), turn: 1, kind: 'init', model: 'z-ai/glm-5.3-flash' },
      { seq: 1, t: t(48 * M), turn: 1, kind: 'tool_use', name: 'Read', input: { file_path: 'src/billing/webhook.ts' } },
      { seq: 2, t: t(48 * M) + 700, turn: 1, kind: 'tool_result', summary: 'export async function handleWebhook(req) { ... } (140 lines)' },
      { seq: 3, t: t(41 * M), turn: 1, kind: 'result', text: 'Two problems.', isError: false, costUsd: 0.0123, usage: { in: 9100, out: 800 }, durationMs: 11 * M },
      { seq: 4, t: t(26 * M), turn: 2, kind: 'tool_use', name: 'Edit', input: { file_path: 'src/billing/webhook.ts' } },
      { seq: 5, t: t(26 * M) + 900, turn: 2, kind: 'tool_result', summary: 'The file src/billing/webhook.ts has been updated.' },
      { seq: 6, t: t(14 * M), turn: 2, kind: 'result', text: 'Done.', isError: false, costUsd: 0.0201, usage: { in: 12300, out: 1400 }, durationMs: 16 * M },
    ].filter((e) => e.turn === +turn);
    totals = { tools: events.filter((e) => e.kind === 'tool_use').length, in: 0, out: 0, costUsd: 0 };
  } else if (box === '90aa13fc') {
    source = { kind: 'cache', machine: 'm-' + box, fetchedAt: now - 2.6 * H };
    complete = true;
    events = [
      tu(0, 2.7 * H, 'Bash', { command: 'npm install date-fns' }),
      { ...tr(1, 2.7 * H - 4000, 'npm ERR! code E403\nnpm ERR! 403 403 Forbidden - GET https://registry.npmjs.org/date-fns', true) },
      { seq: 2, t: t(2.65 * H), turn: 1, kind: 'error', message: 'Subagent failed, exit code 1.' },
      { seq: 3, t: t(2.6 * H), turn: 1, kind: 'result', text: 'Subagent failed', isError: true, costUsd: 0.214, usage: { in: 41200, out: 3100 }, durationMs: 12 * M },
    ];
  } else if (box === 'sbx-qqiksa86') source = { kind: 'none', reason: 'no_stream_yet', machine: 'sbx-qqiksa86' };
  else if (box === 'fleet-main') source = { kind: 'none', reason: 'machine_gone' };
  else source = { kind: 'none', reason: 'no_stream_yet' };
  if (event != null) { const e = events.find((x) => x.seq === +event); return e && (box === '7c1e90ab' && e.seq === 9 ? { ...e, input: FULL9, truncated: false } : e); }
  const out = events.filter((e) => e.seq >= from);
  return { box, turn: +turn, events: out, next: out.length ? out.at(-1).seq + 1 : from, complete, source, totals };
}

// Demo tmux pane for `GET /api/pane?box`: only a coordinator has one.
export function demoPane(box, now = Date.now()) {
  if (box !== 'fleet-main') return null;
  return { lines: ['> Plan: split the migration into three workers.', '', '● cloud_agent_start (Port the settings page)', '  ⎿ started e08a5c33', '● cloud_agent_start (Add retry with backoff)', '  ⎿ started 7c1e90ab', '', '✻ Waiting for workers… (' + Math.floor(now / 1000 % 60) + 's)'], fetchedAt: now, source: { kind: 'machine', machine: 'm-fleet-main' } };
}
