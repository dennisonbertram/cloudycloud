// Help for `cloudy-cloud` subcommands.
import { fileURLToPath } from 'node:url';
// Every line is at most 80 columns. The top-level help lives in bin/cloudy-cloud (it must work without node).
const WIDTH = 80;

// Wraps words to WIDTH; later lines start with `indent`.
function wrap(text, first = '', indent = '') {
  const lines = [];
  let line = first;
  for (const w of text.split(' ')) {
    if (line.trim() && line.length + 1 + w.length > WIDTH) { lines.push(line); line = indent + w; }
    else line += (line.trim() && !line.endsWith(' ') ? ' ' : '') + w;
  }
  return [...lines, line];
}

// usages: arrays of pieces that stay together when a line wraps; rows: [option, meaning].
export function render({ desc, usages, rows = [], note }) {
  const out = [...wrap(desc), ''];
  usages.forEach((u, i) => out.push(...wrap(u.map((x) => x.replaceAll(' ', '\u00a0')).join(' '), i ? '       cloudy-cloud' : 'Usage: cloudy-cloud', '         ').map((l) => l.replaceAll('\u00a0', ' '))));
  if (rows.length) {
    const w = Math.min(Math.max(...rows.map(([a]) => a.length)), 22);
    out.push('');
    for (const [a, b] of rows) {
      if (a.length > w) out.push(`  ${a}`, ...wrap(b, `  ${' '.repeat(w)}  `, `  ${' '.repeat(w)}  `));
      else out.push(...wrap(b, `  ${a.padEnd(w)}  `, `  ${' '.repeat(w)}  `));
    }
  }
  if (note) out.push('', ...wrap(note));
  return out.join('\n');
}

const ID = '<agent-id-or-machine>';
const WHERE = 'The id is the agent_id from cloud_agent or cloud_agent_list, or shown in the dashboard.';
const cmds = {
  setup: { desc: 'Check your tools and save your keys.', usages: [['setup', '[--more]', '[--check-only]'], ['setup', '--provider instabox|self-hosted']], rows: [
    ['--more', 'Add coordinators, usage alerts and other model keys'],
    ['--check-only', 'Check everything and change nothing'],
    ['--provider NAME', 'instabox (default) or self-hosted'],
  ], note: 'Run it in a terminal: it asks for your keys.' },
  shell: { desc: 'Open a shell on a cloud machine, or run one command there.', usages: [['shell', ID, '[-- command [args...]]']], rows: [
    ['(no command)', 'Interactive login shell on the machine'],
    ['-- command', 'Run the command, stream its output and exit with its exit code'],
  ], note: `Each argument after -- reaches the machine unchanged. Do not put secrets in the command. ${WHERE}` },
  display: { desc: "Print a link to a cloud machine's desktop. Only the link goes to stdout.", usages: [['display', ID, '[--control]', '[--ttl SECONDS]'], ['display', ID, '--screenshot FILE'], ['display', ID, '--unshare']], rows: [
    ['(default)', 'View-only link for 1 hour'],
    ['--control', 'Let the viewer click and type'],
    ['--ttl SECONDS', 'Link lifetime, 60 to 86400'],
    ['--screenshot FILE', 'Write a PNG of the screen to FILE and print the path'],
    ['--unshare', 'Revoke every display link for the machine'],
  ], note: `linux, android and gpu machines have a desktop (the first gpu start is slow); omarchy has none and macos is not verified. Display links need the Instabox provider. ${WHERE}` },
  open: { desc: "Reach an app (for example a dev server) running on a cloud agent's machine.", usages: [['open', ID, '<port>', '[--share]'], ['open', ID, '<port>', '--unshare']], rows: [
    ['<port>', 'App port on the machine, or LOCAL:REMOTE to use another port on your computer'],
    ['(default)', 'Private tunnel to http://127.0.0.1:<port> until you press Ctrl-C'],
    ['--share', 'Publish a private link (token in the URL) that anyone holding it can open (Instabox only)'],
    ['--unshare', 'Remove that link'],
  ], note: "Start the app in the background on the machine (nohup npm run dev > /tmp/dev.log 2>&1 &), because a turn's foreground processes end with the turn. The tunnel and link stop when the machine is deleted." },
  mcp: { desc: 'Choose which MCP servers cloud subagents get.', usages: [['mcp', 'add', '<name>', '[--allow-literal]'], ['mcp', 'ls'], ['mcp', 'rm', '<name>']], rows: [
    ['add <name>', 'Give subagents the MCP server <name> from your Claude Code settings'],
    ['ls', 'List the servers subagents get'],
    ['rm <name>', 'Stop giving subagents that server'],
    ['--allow-literal', 'Copy the actual credential value onto subagent machines'],
  ], note: "Claude Code's own `mcp list` and `mcp add <name> -- <command>` still go to claude." },
  protect: { desc: "Block direct pushes to a repo's default branch with a GitHub ruleset.", usages: [['protect', '[owner/repo]', '[--yes]']], rows: [
    ['owner/repo', 'The repo (default: the repo of the current folder)'],
    ['--yes', 'Do not ask first (you are saying yes to the change shown)'],
  ], note: 'Changes need a pull request, no force pushes, no deletion, and nobody can bypass it (including you and the cloud agents). Uses your own gh sign-in; you must be a repo admin.' },
  doctor: { desc: 'Check your own machine when subagents run there (self-hosted provider only).', usages: [['doctor']], note: 'Changes nothing. Run `cloudy-cloud setup --provider self-hosted` to choose that provider.' },
  dashboard: { desc: 'Open a read-only web page about your cloud machines.', usages: [['dashboard', '[--demo]', '[--port N]', '[--no-open]'], ['dashboard', '--prune']], rows: [
    ['--demo', 'Show made-up machines instead of yours'],
    ['--port N', 'Listen on port N (default: 4477)'],
    ['--no-open', 'Print the link but do not open a browser'],
    ['--prune', 'Delete stored agent logs older than 30 days (then the oldest over 1 GB), then exit'],
  ], note: 'The page is served on 127.0.0.1 only. Press Ctrl+C to stop.' },
};

const guides = {
  image: ['Prepare a reusable Claude Code sign-in for coordinators.', 'image [--save]', [
    ['image', 'Create a machine, sign in to Claude in your browser, save it and delete the machine'],
    ['image --save', 'Save a machine you signed in on by hand (when image ran without a terminal)'],
  ], 'Run image on a terminal: you only do the browser sign-in. The machine is deleted 2 hours after it is created.'],
  start: ['Start an always-on cloud coordinator (it runs Claude Code).', 'start NAME --repo URL [--branch BRANCH] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--json]', [
    ['NAME', 'Lowercase letters, digits and hyphens, up to 40'],
    ['--repo URL', 'Required GitHub https URL'],
    ['--branch BRANCH', 'Branch to clone (default: the repo default)'],
    ['--task TEXT', 'Start the coordinator on this task'],
    ['--task-file PATH', 'Same, read from a file'],
    ['--max-hours N', 'Delete the machine after N hours (up to 24, the default)'],
    ['--model NAME', 'Claude Code model for the session (for example opus or claude-opus-5-5)'],
    ['--json', 'Print the result as JSON (includes started: true)'],
  ], 'Run coordinator image once first. Stop the coordinator when you are done.'],
  attach: ['Open a coordinator\'s Claude session.', 'attach NAME', [], 'On a terminal it opens the session. When piped, it prints the SSH command instead; run that to connect.'],
  ls: ['List your cloud coordinators and whether one waits on a prompt.', 'ls', [], 'When piped, prints tab-separated NAME, STATE, CREATED, MACHINE, DELETES, WAITING, or "No coordinators.". It reads each running coordinator\'s screen once.'],
  status: ['Show one coordinator: state, the prompt it waits on (if any) and the attach command.', 'status NAME [--json]', [], 'Read-only. Reads the screen once. A coordinator runs with permission checks off, so a waiting prompt is unexpected: attach and answer it.'],
  stop: ['Delete one coordinator machine.', 'stop NAME', [], 'Its workers are cleaned up separately; check for remaining machines afterwards.'],
  finish: ['Run on a coordinator machine by the coordinator: check nothing is lost, then delete this machine.', 'finish [--force]', [
    ['--force', 'Skip the git and worker checks'],
  ], 'Refuses while work is unpushed or workers are running.'],
};


export const commandNames = Object.keys(cmds);

// Text for one command; `short` leaves out the description (for error messages that start with Usage).
export function helpText(name, short = false) {
  const text = render(cmds[name]);
  return short ? text.slice(text.indexOf('Usage:')) : text;
}

export function coordinatorHelp(command) {
  if (command && guides[command]) {
    const [desc, usage, rows, note] = guides[command];
    let depth = 0;
    const pieces = usage.split('').map((c) => { if (c === '[') depth++; if (c === ']') depth--; return c === ' ' && !depth ? '\n' : c; }).join('').split('\n');
    return render({ desc, usages: [['coordinator', ...pieces]], rows, note: `${note} All coordinator commands: cloudy-cloud coordinator --help` });
  }
  return render({
    desc: 'Cloudy Cloud coordinators: always-on Claude Code sessions on their own cloud machines. A coordinator always runs Claude Code, never pi, omp, Codex or opencode.',
    usages: [['coordinator', '<command>']],
    rows: [
      ['image [--save]', 'Save a Claude sign-in for coordinators (do this once)'],
      ['start NAME --repo URL', 'Start a coordinator'],
      ['ls', 'List your coordinators'],
      ['status NAME', 'Show one coordinator and whether it waits on a prompt'],
      ['attach NAME', 'Open its session (prints the command when piped)'],
      ['stop NAME', 'Delete one'],
      ['finish [--force]', 'Used by a coordinator itself to delete its own machine'],
    ],
    note: 'More on one command: cloudy-cloud coordinator <command> --help. Machines do not pause on their own. Stop coordinators when you are done.',
  });
}

const hosts = {
  codex: 'starts the Codex CLI with the cloud_agent tools. Its own help: cloudy-cloud codex --help',
  opencode: 'starts opencode with the cloud_agent tools. Its own help: cloudy-cloud opencode --help',
  pi: 'starts pi as the main session with the cloud_agent tools. Its own help: cloudy-cloud pi --help',
  'free-pi': 'starts free-pi as the main session with the cloud_agent tools. Its own help: cloudy-cloud free-pi --help',
};

// `node cli-help.mjs <command> [subcommand]` (from bin/cloudy-cloud for `help <command>` and `<command> --help`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [name, sub, ...extra] = process.argv.slice(2).filter((a) => a !== '--help' && a !== '-h');
  const ok = (name === 'coordinator' && (sub === undefined || Object.hasOwn(guides, sub)) && !extra.length)
    || ((Object.hasOwn(cmds, name) || Object.hasOwn(hosts, name)) && (sub === undefined || (name === 'mcp' && ['add', 'ls', 'rm'].includes(sub))) && !extra.length);
  if (!ok) { console.error(`cloudy-cloud: no help for "${[name, sub].filter(Boolean).join(' ')}". See: cloudy-cloud --help`); process.exitCode = 2; }
  else if (name === 'coordinator') console.log(coordinatorHelp(sub));
  else console.log(Object.hasOwn(hosts, name) ? `cloudy-cloud ${name} ${hosts[name]}` : helpText(name));
}
