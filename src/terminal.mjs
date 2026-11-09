// Human-facing CLI output only. MCP messages never pass through this renderer.
export function terminal({ stream = process.stdout, env = process.env, columns = stream.columns ?? 80, isTTY = !!stream.isTTY } = {}) {
  const color = isTTY && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : String(value);
  const width = Math.max(24, columns);
  const text = (value, indent = 2) => String(value).split('\n').map((line) => {
    const lines = []; let current = '';
    for (const word of line.split(/\s+/).filter(Boolean)) {
      if (current && current.length + word.length + 1 > width - indent) { lines.push(current); current = ''; }
      current += `${current ? ' ' : ''}${word}`;
    }
    lines.push(current);
    return lines.map((s) => `${' '.repeat(indent)}${s}`).join('\n');
  }).join('\n');
  return {
    isTTY, width, text, paint,
    title: (name, detail) => `\n  ${paint('1;36', 'claude-cloud')}  ${paint('1', name)}\n${detail ? `${text(detail)}\n` : ''}`,
    section: (label) => `\n  ${paint('1', label)}`,
    command: (value) => text(value),
    item: (name, description) => width < 64
      ? `  ${paint('36', name)}\n${text(description, 4)}`
      : `  ${paint('36', name.padEnd(22))}${description}`,
  };
}

export function coordinatorTable(rows, ui = terminal()) {
  const values = rows.map((m) => [m.metadata.name, m.state, new Date(m.startedAt).toISOString(), m.name].map(String));
  const headings = ['NAME', 'STATE', 'CREATED', 'MACHINE'];
  const widths = headings.map((heading, i) => Math.max(heading.length, ...values.map((row) => row[i].length)));
  const lines = [ui.title('coordinators', `${rows.length} ${rows.length === 1 ? 'machine' : 'machines'}`)];
  if (widths.reduce((a, b) => a + b, 0) + 8 <= ui.width) {
    const line = (row) => `  ${row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd()}`;
    lines.push(ui.paint('1', line(headings)), ...values.map(line));
  } else {
    for (const [name, state, created, machine] of values) {
      lines.push(ui.text(`${name} [${state}]`), ui.text(`Machine: ${machine}`, 4), ui.text(`Created: ${created}`, 4), '');
    }
  }
  lines.push(ui.section('CONNECT'), ui.command('claude-cloud coordinator attach NAME'), '');
  return lines.join('\n');
}
