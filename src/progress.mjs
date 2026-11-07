// Parser for `claude -p --output-format stream-json --verbose` output, and the progress line shown to the user.
// Only these events matter: `assistant` (tool_use blocks, usage per message id) and `result` (the final answer).
// Lines that are not JSON (stderr mixed into a Instabox background log) are ignored.

const ARG_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description'];
const TOKEN_LIKE = /\b(?:sk-|ghp_|gho_|github_pat_|ibk_)[A-Za-z0-9_-]+/g;
const STEP_MAX = 60;
export const STATUS_MAX = 200;
export const LOCAL_ALIAS = 'worker';

export const num = (n) => (typeof n === 'number' && n > 0 ? n : 0);
const inputTokens = (u) => num(u?.input_tokens) + num(u?.cache_creation_input_tokens) + num(u?.cache_read_input_tokens);

// "Edit src/parser.ts": the tool name and a short argument. Secret-looking tokens are removed.
export function stepOf(block) {
  const input = block.input ?? {};
  const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k]);
  const arg = key ? input[key].replace(TOKEN_LIKE, '[redacted]').replace(/\s+/g, ' ').trim() : '';
  const short = arg.length > STEP_MAX ? `${arg.slice(0, STEP_MAX - 1)}…` : arg;
  return `${block.name}${short ? ` ${short}` : ''}`;
}

export function createProgress(now = Date.now) {
  const p = {
    startedAt: now(), tools: 0, step: '', final: undefined, model: '',
    usage: new Map(), // message id -> { in, out }; the same message repeats in several events, so keep the largest values
    seenTools: new Set(), buf: '',
  };
  // The model the harness reports. "worker" is the local gateway alias, so it says nothing about what ran.
  p.setModel = (m) => { if (typeof m === 'string' && m.trim() && m !== LOCAL_ALIAS) p.model = m.trim(); };
  p.event = (j) => {
    if (j?.type === 'system' && j.subtype === 'init') p.setModel(j.model);
    if (j?.type === 'assistant' && j.message) {
      p.setModel(j.message.model);
      const u = j.message.usage;
      if (u) {
        const prev = p.usage.get(j.message.id) ?? { in: 0, out: 0 };
        p.usage.set(j.message.id, { in: Math.max(prev.in, inputTokens(u)), out: Math.max(prev.out, num(u.output_tokens)) });
      }
      for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
        if (b?.type !== 'tool_use' || p.seenTools.has(b.id)) continue;
        p.seenTools.add(b.id);
        p.tools++;
        p.step = stepOf(b);
      }
    } else if (j?.type === 'result') {
      p.final = j;
    }
  };
  p.line = (l) => {
    if (!l.trim().startsWith('{')) return;
    try { p.event(JSON.parse(l)); } catch { /* not JSON */ }
  };
  // Feed raw output chunks, which may split lines anywhere.
  p.feed = (chunk) => {
    p.buf += chunk;
    const lines = p.buf.split('\n');
    p.buf = lines.pop();
    lines.forEach(p.line);
  };
  p.end = () => { p.line(p.buf); p.buf = ''; };
  // Totals: the final result's usage when present (exact), else the sum over messages seen so far (live estimate).
  p.totals = () => {
    const u = p.final?.usage;
    if (u) return { tools: p.tools, in: inputTokens(u), out: num(u.output_tokens), cost: p.final.total_cost_usd };
    let tin = 0, tout = 0;
    for (const m of p.usage.values()) { tin += m.in; tout += m.out; }
    return { tools: p.tools, in: tin, out: tout };
  };
  p.elapsedMs = () => now() - p.startedAt;
  return p;
}

// Parse a whole captured output at once.
export function parseStream(text) {
  const p = createProgress();
  p.feed(text);
  p.end();
  return p;
}

export const fmtTokens = (n) => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);

export function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

// "12 tool uses · 48.2k tokens · 3m10s · Edit src/parser.ts". Tokens are input (including cache) plus output.
export function statusLine(p) {
  const t = p.totals();
  const parts = [...(p.model ? [shortModel(p.model)] : []), `${t.tools} tool ${t.tools === 1 ? 'use' : 'uses'}`, `${fmtTokens(t.in + t.out)} tokens`, fmtElapsed(p.elapsedMs())];
  if (p.step && !p.final) parts.push(p.step);
  return parts.join(' · ');
}

// One line for the end of a result: "12 tool uses, 93.1k in / 327 out tokens, $0.0078, 3m10s".
export function totalLine(p, { cost: showCost = true } = {}) {
  const t = p.totals();
  const cost = showCost && typeof t.cost === 'number' ? `, $${t.cost.toFixed(4)}` : '';
  return `Total: ${t.tools} tool ${t.tools === 1 ? 'use' : 'uses'}, ${fmtTokens(t.in)} in / ${fmtTokens(t.out)} out tokens${cost}, ${fmtElapsed(p.elapsedMs())}`;
}

// "z-ai/glm-5.3-flash" -> "glm-5.3-flash"
export const shortModel = (m) => m.split('/').pop();
const sameModel = (a, b) => shortModel(a).toLowerCase() === shortModel(b).toLowerCase();

// "Model: ..." line for a result. `req` is { model, host, name } for a profile worker, else undefined (a plain Claude worker:
// only the reported model is shown, because its --model may be an alias such as haiku).
export function modelLine(p, req) {
  const via = req ? ` via ${req.host} (profile ${req.name})` : '';
  if (!req) return p.model ? `Model: ${p.model}` : 'Model: not reported';
  if (!p.model) return `Model: ${req.model} requested${via}; not confirmed by the provider`;
  if (sameModel(p.model, req.model)) return `Model: ${p.model}${via}`;
  return `WARNING Model: asked for ${req.model}, provider reported ${p.model}${via}`;
}
