// Terminal styling for the coordinator commands. Same look as install.sh.
// `ui.term` is a terminal (a TTY of any flavour); `ui.on` is term plus colour allowed
// (TERM not dumb, no NO_COLOR, CLICOLOR not 0). Layout keys on `term`, colour on `on`;
// piped output keeps its script text, so it does not change.
// Width of one character in terminal cells: 0 for combining marks and control characters, 2 for East Asian wide and emoji, else 1.
const charWidth = (cp) => (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) ? 0
  : (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1);
export const cellWidth = (str) => { let n = 0; for (const ch of String(str).replace(/\x1b\[[0-9;]*m/g, '')) n += charWidth(ch.codePointAt(0)); return n; };
// Cuts text to at most max cells with a trailing …, never splitting a character.
export const fitCells = (str, max) => {
  if (cellWidth(str) <= max) return str;
  let out = '', n = 0;
  for (const ch of str) { const w = charWidth(ch.codePointAt(0)); if (n + w > max - 1) break; out += ch; n += w; }
  return `${out}…`;
};

export function makeUi({ tty = process.stdout.isTTY, env = process.env, cols = process.stdout.columns } = {}) {
  // term: the output is a terminal (a TTY of any flavour). on: colour is allowed there too
  // (TERM not dumb, no NO_COLOR, CLICOLOR not 0). Callers key the layout off `term`, colour off `on`.
  const term = Boolean(tty);
  const on = term && (env.TERM || 'dumb') !== 'dumb' && !env.NO_COLOR && env.CLICOLOR !== '0';
  const utf = /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
  // The basic 16 colours are themed by the terminal, so they stay readable on light and dark
  // backgrounds where a fixed colour cannot. Marks carry the meaning; colour supports it.
  const at = (a) => (on ? `\x1b[${a}m` : '');
  const col = { acc: at('1;34'), dim: at(2), ok: at(32), warn: at(33), err: at(31), bold: at(1) };
  const x = on ? '\x1b[0m' : '';
  const paint = (c, s) => (on && c ? `${c}${s}${x}` : String(s));
  const mark = { ok: utf ? '✔' : '[ok]', err: utf ? '✖' : '[x]', warn: utf ? '▲' : '!', hint: utf ? '›' : '>' };
  const width = Math.min(cols || 80, 160); // the real column count, up to a wide-terminal cap

  const line = (kind, msg, detail) => `  ${paint(col[kind], mark[kind])} ${msg}${detail ? `  ${paint(col.dim, detail)}` : ''}`;

  // Time from now in short form: "in 23h", "5m ago".
  const rel = (when, now = Date.now()) => {
    const s = Math.round((new Date(when).getTime() - now) / 1000), a = Math.abs(s);
    const t = a < 60 ? 'under a minute' : a < 3600 ? `${Math.round(a / 60)}m` : a < 172800 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
    return a < 60 ? 'now' : s > 0 ? `in ${t}` : `${t} ago`;
  };

  // table(headers, rows): a cell is a string or a list of [text, colour] parts. Columns are padded to the widest cell.
  const table = (headers, rows) => {
    const parts = (c) => (Array.isArray(c) ? c : [[String(c)]]);
    const len = (c) => parts(c).reduce((n, [t]) => n + cellWidth(t), 0);
    const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => len(r[i]))));
    const cell = (c, i) => parts(c).map(([t, k]) => (k ? paint(k, t) : t)).join('') + ' '.repeat(w[i] - len(c));
    return [`  ${headers.map((h, i) => paint(col.dim, h.padEnd(w[i]))).join('   ')}`, ...rows.map((r) => `  ${r.map(cell).join('   ').trimEnd()}`)].join('\n');
  };

  // block(title, rows): a heading and aligned [label, value] rows.
  const block = (title, rows) => {
    const w = Math.max(...rows.map(([l]) => l.length));
    return [`  ${paint(col.bold, title)}`, ...rows.map(([l, v, d]) => `    ${paint(col.acc, l.padEnd(w))}   ${v}${d ? `\n    ${' '.repeat(w)}   ${paint(col.dim, d)}` : ''}`)].join('\n');
  };

  return { on, term, utf, col, mark, width, paint, rel, table, block, dim: (s) => paint(col.dim, s), bold: (s) => paint(col.bold, s),
    ok: (m, d) => line('ok', m, d), err: (m, d) => line('err', m, d), warn: (m, d) => line('warn', m, d),
    hint: (m) => `  ${paint(col.dim, `${mark.hint} ${m}`)}`,
    // The one command to run next. Plain "Next: ..." for piped output.
    next: (cmd) => (term ? `  ${paint(col.acc, `${utf ? '→' : '->'} Next: ${cmd}`)}` : `Next: ${cmd}`) };
}
