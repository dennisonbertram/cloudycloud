// Terminal styling for the coordinator commands. Same look as install.sh.
// Styling is on only for a colour terminal: not piped, no NO_COLOR, CLICOLOR not 0, TERM not dumb.
// Callers keep their plain text for the off case (`ui.on`), so scripts that read the output do not change.
export function makeUi({ tty = process.stdout.isTTY, env = process.env, cols = process.stdout.columns } = {}) {
  const on = Boolean(tty) && !env.NO_COLOR && (env.TERM || 'dumb') !== 'dumb' && env.CLICOLOR !== '0';
  const utf = /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
  const wide = on && (/256/.test(env.TERM || '') || Boolean(env.COLORTERM));
  const code = (n256, basic) => (on ? `\x1b[${wide ? `38;5;${n256}` : basic}m` : '');
  const col = { acc: code(75, 36), dim: wide ? code(245) : on ? '\x1b[2m' : '', ok: code(42, 32), warn: code(214, 33), err: code(203, 31), bold: on ? '\x1b[1m' : '' };
  const x = on ? '\x1b[0m' : '';
  const paint = (c, s) => (on ? `${c}${s}${x}` : String(s));
  const mark = { ok: utf ? '✔' : '[ok]', err: utf ? '✖' : '[x]', warn: utf ? '▲' : '!', hint: utf ? '›' : '>' };
  const width = Math.min(cols || 80, 100);

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
    const len = (c) => parts(c).reduce((n, [t]) => n + t.length, 0);
    const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => len(r[i]))));
    const cell = (c, i) => parts(c).map(([t, k]) => (k ? paint(k, t) : t)).join('') + ' '.repeat(w[i] - len(c));
    return [`  ${headers.map((h, i) => paint(col.dim, h.padEnd(w[i]))).join('   ')}`, ...rows.map((r) => `  ${r.map(cell).join('   ').trimEnd()}`)].join('\n');
  };

  // block(title, rows): a heading and aligned [label, value] rows.
  const block = (title, rows) => {
    const w = Math.max(...rows.map(([l]) => l.length));
    return [`  ${paint(col.bold, title)}`, ...rows.map(([l, v, d]) => `    ${paint(col.acc, l.padEnd(w))}   ${v}${d ? `\n    ${' '.repeat(w)}   ${paint(col.dim, d)}` : ''}`)].join('\n');
  };

  return { on, utf, col, mark, width, paint, rel, table, block, dim: (s) => paint(col.dim, s), bold: (s) => paint(col.bold, s),
    ok: (m, d) => line('ok', m, d), err: (m, d) => line('err', m, d), warn: (m, d) => line('warn', m, d),
    hint: (m) => `  ${paint(col.dim, `${mark.hint} ${m}`)}` };
}
