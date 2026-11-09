import { stripVTControlCharacters } from 'node:util';

export const safeText = (value) => stripVTControlCharacters(String(value))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
  .replace(/\t/g, ' ');

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cells = (s) => [...segments.segment(s)].reduce((total, { segment }) => {
  const cp = segment.codePointAt(0);
  if (/^\p{Mark}+$/u.test(segment)) return total;
  const wide = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ||
    cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 ||
      cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000);
  return total + (wide ? 2 : 1);
}, 0);

export const displayDate = (value) => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
};

export const coordinatorFields = (m) => [m.metadata?.name ?? 'unnamed', m.state ?? 'unknown', displayDate(m.startedAt), m.name ?? 'unknown']
  .map((value) => safeText(value).replace(/\n/g, ' '));

export function formatError(error, ui = terminal({ stream: process.stderr })) {
  const message = safeText(error?.message ?? error)
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_|ibk_)[A-Za-z0-9_-]+/g, '[redacted]');
  return [`\n  ${ui.paint('1;31', 'error')}  ${ui.paint('1', 'claude-cloud')}`, ui.text(message), ''].join('\n');
}

// Human-facing CLI output only. MCP messages never pass through this renderer.
export function terminal({ stream = process.stdout, env = process.env, columns = stream.columns ?? 80, isTTY = !!stream.isTTY } = {}) {
  const color = isTTY && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
  const paint = (code, value) => color ? `\x1b[${code}m${safeText(value)}\x1b[0m` : safeText(value);
  const width = Math.max(24, columns);
  const text = (value, indent = 2) => safeText(value).split('\n').map((line) => {
    const lines = []; let current = '';
    for (const word of line.split(/\s+/).filter(Boolean)) {
      if (current && cells(current) + cells(word) + 1 > width - indent) { lines.push(current); current = ''; }
      if (cells(word) > width - indent) {
        for (const { segment } of segments.segment(word)) {
          if (cells(current) + cells(segment) > width - indent) { lines.push(current); current = ''; }
          current += segment;
        }
        continue;
      }
      current += `${current ? ' ' : ''}${word}`;
    }
    lines.push(current);
    return lines.map((s) => `${' '.repeat(indent)}${s}`).join('\n');
  }).join('\n');
  return {
    isTTY, width, text, paint,
    title: (name, detail) => `\n  ${paint('1;36', 'claude-cloud')}  ${paint('1', name)}\n${detail ? `${text(detail)}\n` : ''}`,
    section: (label) => `\n  ${paint('1', label)}`,
    // Let the terminal soft-wrap commands so copied text remains executable.
    command: (value) => `  ${safeText(value)}`,
    item: (name, description) => width < 64 || cells(description) + 24 > width
      ? `  ${paint('36', name)}\n${text(description, 4)}`
      : `  ${paint('36', name.padEnd(22))}${description}`,
  };
}

export function coordinatorTable(rows, ui = terminal()) {
  const values = rows.map(coordinatorFields);
  const headings = ['NAME', 'STATE', 'CREATED', 'MACHINE'];
  const widths = headings.map((heading, i) => Math.max(cells(heading), ...values.map((row) => cells(row[i]))));
  const lines = [ui.title('coordinators', `${rows.length} ${rows.length === 1 ? 'machine' : 'machines'}`)];
  if (widths.reduce((a, b) => a + b, 0) + 8 <= ui.width) {
    const line = (row) => `  ${row.map((value, i) => value + ' '.repeat(widths[i] - cells(value))).join('  ').trimEnd()}`;
    lines.push(ui.paint('1', line(headings)), ...values.map(line));
  } else {
    for (const [name, state, created, machine] of values) {
      lines.push(ui.text(`${name} [${state}]`), ui.text(`Machine: ${machine}`, 4), ui.text(`Created: ${created}`, 4), '');
    }
  }
  lines.push(ui.section('CONNECT'), ui.command('claude-cloud coordinator attach NAME'), '');
  return lines.join('\n');
}
