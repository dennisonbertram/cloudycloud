// Turns the raw stream of one agent turn (claude stream-json, `pi --mode json`, `omp --mode json`) into one event list:
//   { seq, t, turn, kind, off, ...fields }, kind = init | text | thinking | tool_use | tool_result | retry | error | result
// `off` is the byte offset of the source line. normalise() returns an array with two extra properties: `skipped` (lines that
// are not JSON or not an event we show) and `next` (byte offset after the last complete line). To resume, pass the rest of
// the text with { from: next, seq: events.length }. Everything text-like passes redact().
// pi/omp keep state inside one call (the last message and token totals for the result), so resume those from the start.
import { appendFileSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { redact, redactText } from './events.mjs';

const INPUT_MAX = 4096;
const SUMMARY_MAX = 400;
const n = (x) => (typeof x === 'number' && x > 0 ? x : 0);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
const cut = (s, max) => (s.length > max ? s.slice(0, max) : s);
const when = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : undefined; };

function toolUse(id, name, input) {
  const json = JSON.stringify(input ?? {}) ?? '{}';
  const red = redact(json);
  return { kind: 'tool_use', id, name: String(name ?? ''), input: cut(red, INPUT_MAX), inputBytes: Buffer.byteLength(json), truncated: red.length > INPUT_MAX };
}
const toolResult = (id, content, isError) => ({ kind: 'tool_result', id, summary: cut(redact(textOf(content)), SUMMARY_MAX), isError: isError === true });
const thinkingOf = (b, o) => ({ kind: 'thinking', length: String(b.thinking ?? '').length, ...(o.thinking && { text: redact(b.thinking) }) });

// Each handler returns the events for one parsed line.
function claude(j, o) {
  if (j.type === 'system' && j.subtype === 'init') {
    return [{ kind: 'init', model: j.model, sessionId: j.session_id, tools: Array.isArray(j.tools) ? j.tools.length : undefined,
      mcp: Array.isArray(j.mcp_servers) ? j.mcp_servers.filter((x) => typeof x?.name === 'string').map((x) => ({ name: x.name, status: String(x.status ?? '') })) : [] }];
  }
  if (j.type === 'system' && j.subtype === 'api_retry') return [{ kind: 'retry', attempt: j.attempt, maxRetries: j.max_retries, delayMs: j.retry_delay_ms, status: j.error_status, error: redact(j.error) }];
  if (j.type === 'permission_denied') return [{ kind: 'error', message: redact(`Permission denied${j.tool_name ? ` for ${j.tool_name}` : ''}`) }];
  if (j.type === 'cloudy-cloud') return [{ kind: 'error', message: `stream ${j.note}` }];
  const content = Array.isArray(j.message?.content) ? j.message.content : [];
  if (j.type === 'assistant') {
    return content.flatMap((b) => {
      if (b?.type === 'text' && b.text) return [{ kind: 'text', text: redact(b.text) }];
      if (b?.type === 'thinking') return [thinkingOf(b, o)];
      if (b?.type === 'tool_use') return o.seen.has(b.id) ? [] : (o.seen.add(b.id), [toolUse(b.id, b.name, b.input)]);
      return [];
    });
  }
  if (j.type === 'user') return content.filter((b) => b?.type === 'tool_result').map((b) => toolResult(b.tool_use_id, b.content, b.is_error));
  if (j.type === 'result') {
    const u = j.usage ?? {};
    return [{ kind: 'result', text: redact(j.result), isError: j.is_error === true, costUsd: j.total_cost_usd, durationMs: j.duration_ms, sessionId: j.session_id,
      usage: { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheCreation: n(u.cache_creation_input_tokens) } }];
  }
  return [];
}

// pi and omp: tool events from tool_execution_*, text from assistant message_end, one result at agent_settled (pi) / agent_end (omp).
function pi(j, o) {
  const s = o.state;
  if (j.type === 'session') return [{ kind: 'init', sessionId: j.id }];
  if (j.type === 'tool_execution_start') return [toolUse(j.toolCallId, j.toolName, j.args)];
  if (j.type === 'tool_execution_end') return [toolResult(j.toolCallId, j.result?.content, j.isError)];
  if (j.type === 'message_end' && j.message?.role === 'assistant') {
    const m = j.message, u = m.usage ?? {};
    s.input += n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
    s.output += n(u.output);
    s.last = m;
    return (Array.isArray(m.content) ? m.content : []).flatMap((b) => {
      if (b?.type === 'text' && b.text) return [{ kind: 'text', text: redact(b.text) }];
      if (b?.type === 'thinking') return [thinkingOf(b, o)];
      return [];
    });
  }
  if (j.type === (o.harness === 'omp' ? 'agent_end' : 'agent_settled') && s.last) {
    const m = s.last, failed = m.stopReason === 'error' || m.stopReason === 'aborted', text = textOf(m.content);
    return [{ kind: 'result', text: redact(failed ? (m.errorMessage || text || `stopped: ${m.stopReason}`) : text), isError: failed,
      usage: { input: s.input, output: s.output, cacheRead: 0, cacheCreation: 0 } }];
  }
  return [];
}

export function normalise(source, { harness = 'claude', turn, from = 0, seq = 0, thinking = process.env.CLOUDY_CLOUD_STREAM_THINKING === '1' } = {}) {
  const text = Array.isArray(source) ? source.join('\n') : String(source ?? '');
  const o = { harness, thinking, seen: new Set(), state: { input: 0, output: 0 } };
  const handle = harness === 'claude' ? claude : pi;
  const out = [];
  let skipped = 0, off = from, next = from;
  const parts = text.split('\n'), last = parts.length - 1;
  parts.forEach((line, i) => {
    const lineOff = off;
    off += Buffer.byteLength(line) + 1;
    if (!line.trim()) { if (i < last) next = off; return; }
    let j;
    try { j = JSON.parse(line); } catch { if (i < last) { skipped++; next = off; } return; } // an unfinished last line waits for the next call
    next = Math.min(off, from + Buffer.byteLength(text));
    const evs = j && typeof j === 'object' ? handle(j, o) : [];
    if (!evs.length) skipped++;
    for (const e of evs) out.push({ seq: seq + out.length, t: when(j.timestamp ?? j.message?.timestamp), turn, ...e, off: lineOff });
  });
  return Object.assign(out, { skipped, next });
}

// ---- the redacted copy this laptop keeps: ~/.config/cloudy-cloud/streams/<agent>/t<n>.jsonl (CLOUDY_CLOUD_STREAMS overrides) ----

export const streamsDir = (env = process.env) => env.CLOUDY_CLOUD_STREAMS || process.env.CLOUDY_CLOUD_STREAMS || join(homedir(), '.config/cloudy-cloud/streams');

const mapStrings = (v, f) => (typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStrings(x, f)])) : v);
// One raw line, redacted. A JSON line is redacted string by string, so it stays valid JSON.
export function redactLine(line, scrub = (s) => s) {
  const f = (s) => redactText(scrub(s));
  try { return JSON.stringify(mapStrings(JSON.parse(line), f)); } catch { return f(line); }
}

// Returns { write(chunk), end() }: complete lines are appended redacted (folder 700, file 600). Never throws.
// After `cap` bytes it writes one {"type":"cloudy-cloud","note":"truncated"} line and drops the rest.
export function createLocalStream(file, { scrub, cap = 20 * 1024 * 1024 } = {}) {
  let buf = '', bytes, done = false;
  const append = (text) => {
    try {
      if (bytes === undefined) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); bytes = (() => { try { return statSync(file).size; } catch { return 0; } })(); }
      appendFileSync(file, text, { mode: 0o600 });
      bytes += Buffer.byteLength(text);
    } catch { /* storing the stream is best effort */ }
  };
  const stop = () => { done = true; buf = ''; append('{"type":"cloudy-cloud","note":"truncated"}\n'); };
  const line = (l) => {
    if (done || !l.trim()) return;
    const out = `${redactLine(l, scrub)}\n`;
    if (bytes === undefined) append(''); // learn the size of an existing file first
    if (bytes + Buffer.byteLength(out) > cap) return stop();
    append(out);
  };
  return {
    write(chunk) {
      if (done) return;
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(line);
      if (buf.length > cap) stop(); // one unterminated line past the cap: drop it
    },
    end() { line(buf); buf = ''; },
  };
}

// Deletes files older than maxAgeMs, then the oldest files until the folder is under maxBytes. Never throws.
export function pruneStreams(dir, { maxBytes = 1024 ** 3, maxAgeMs = 30 * 86_400_000, now = Date.now() } = {}) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); files.push({ p, size: s.size, t: s.mtimeMs }); }
    }
  };
  const res = { removed: 0, freed: 0 };
  try {
    walk(dir);
    let total = files.reduce((a, f) => a + f.size, 0);
    for (const f of files.sort((a, b) => a.t - b.t)) {
      if (now - f.t <= maxAgeMs && total <= maxBytes) break;
      unlinkSync(f.p);
      total -= f.size; res.removed++; res.freed += f.size;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { try { rmdirSync(join(dir, e.name)); } catch { /* not empty */ } }
  } catch { /* nothing to prune */ }
  return res;
}
