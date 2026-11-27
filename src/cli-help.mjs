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

// usages: arrays of pieces that stay together when a line wraps. Returns the wrapped Usage line(s) only.
function usageLines(usages) {
  return usages.flatMap((u, i) => wrap(u.map((x) => x.replaceAll(' ', '\u00a0')).join(' '), i ? '       cloudy-cloud' : 'Usage: cloudy-cloud', '         ').map((l) => l.replaceAll('\u00a0', ' ')));
}

// usages: arrays of pieces that stay together when a line wraps; rows: [option, meaning].
export function render({ desc, usages, rows = [], note }) {
  const out = [...wrap(desc), '', ...usageLines(usages)];
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
const WHERE = 'The id is the agent_id from cloud_agent or cloud_agent_list, or shown in the dashboard. Use provider:id or provider:name to select a machine when needed.';
const cmds = {
  cloud: { desc: 'Start a cloud coordinator for this repository and attach to its Claude session, in one command. Run inside a git clone whose origin is on github.com.', usages: [['cloud', '[--name N]', '[--branch B]', '[--max-hours H]', '[--model M]', '[--env FILE]...', '[--no-attach]', '[--json]']], rows: [
    ['--name N', 'Coordinator name (default: <owner>-<repo>-<branch> as a slug)'],
    ['--branch B', 'Branch to clone (default: the current branch)'],
    ['--max-hours H', 'Delete the machine after H hours (up to 24, the default)'],
    ['--model M', 'Claude Code model for the session'],
    ['--env FILE', 'Bridge variables from a dotenv file (repeatable)'],
    ['--no-attach', 'Start the coordinator without attaching'],
    ['--json', 'Print the start result as JSON'],
  ], note: 'The repo is the origin URL and the machine clones from GitHub, so local commits and uncommitted edits are flagged first — on a terminal you confirm, off one the command refuses and names the push command. A running coordinator of the same name whose repo and branch match is reattached to instead of restarted. Run coordinator image once first.' },
  setup: { desc: 'Check your tools and save your keys.', usages: [['setup', '[--more]', '[--check-only]', '[--default-profile NAME]'], ['setup', '--provider instabox|self-hosted|microsandbox']], rows: [
    ['--more', 'Add coordinators, usage alerts and other model keys'],
    ['--check-only', 'Check everything and change nothing'],
    ['--provider NAME', 'Check or configure one provider: instabox, self-hosted, microsandbox, boat or e2b'],
    ['--default-profile NAME', 'Set the worker profile used when a request omits profile'],
    ['CLOUDY_CLOUD_PROVIDERS', 'Set a comma-separated provider list to check readiness for every configured provider'],
  ], note: 'Run it in a terminal: it asks for your keys.' },
  shell: { desc: 'Open a shell on a cloud machine, or run one command there.', usages: [['shell', ID, '[-- command [args...]]']], rows: [
    ['(no command)', 'Interactive login shell on the machine'],
    ['-- command', 'Run the command, stream its output and exit with its exit code'],
  ], note: `Each argument after -- reaches the machine unchanged. Do not put secrets in the command. ${WHERE}` },
  display: { desc: "Print a link to a cloud machine's desktop. Only the link goes to stdout.", usages: [['display', ID, '[--control]', '[--ttl SECONDS]'], ['display', ID, '--screenshot FILE'], ['display', ID, '--unshare']], rows: [
    ['(default)', 'View-only link; stops taking new viewers after 1 hour'],
    ['--control', 'Let the viewer click and type'],
    ['--ttl SECONDS', 'Seconds until the link stops taking new viewers, 60 to 86400'],
    ['--screenshot FILE', 'Write a PNG of the screen to FILE and print the path'],
    ['--unshare', 'Revoke every display link for the machine, including connected viewers'],
  ], note: `Display links are available only when the machine's provider supports them; omarchy has no desktop and macos is not verified. ${WHERE}` },
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
    ['--allow-literal', 'Copy the actual credential value into the worker config file on subagent machines'],
  ], note: "Claude Code's own `mcp list` and `mcp add <name> -- <command>` still go to claude." },
  'mcp-server': { desc: 'Run the Cloudy Cloud MCP server on stdio, for MCP clients other than the built-in hosts.', usages: [['mcp-server', '[--repo PATH]', '[--session NAME]']], rows: [
    ['--repo PATH', 'Bind workers to this workspace (default: the current directory)'],
    ['--session NAME', 'Share workers across MCP client connections and reconnects; combine with --repo'],
  ], note: 'Named sessions use one private local owner process while workers are open. The server reads its keys from ~/.config/cloudy-cloud/env itself; run `cloudy-cloud setup` once first. Claude Code, Codex, opencode and pi sessions get the same tools through their own cloudy-cloud host command.' },
  run: { desc: 'Run one Cloudy Cloud worker in the foreground and print its result when it finishes.', usages: [['run', '--repo', 'PATH', '[--profile NAME]', '[--workspace PATH]', '[--session NAME]', '[--timeout SECONDS]', '[--description TEXT]', '[--model NAME]', '[--issue N]', '[--base REF]', '[--explain]', '[--json]', '--', '<prompt>']], rows: [
    ['--repo PATH', 'Required repository with a github.com origin'],
    ['--profile NAME', 'Worker profile (default: saved default profile)'],
    ['--workspace PATH', 'Run the worker in a directory inside the bound repository'],
    ['--session NAME', 'Attach to a named MCP owner session; without it, the command creates a temporary owner'],
    ['--timeout SECONDS', 'Maximum wait (default: 2100 seconds; maximum: 86400)'],
    ['--description TEXT', 'Short worker label'],
    ['--model NAME', 'Model override where the worker profile supports it'],
    ['--issue N', 'GitHub issue number or URL'],
    ['--base REF', 'Branch name or commit SHA to start from'],
    ['--explain', 'Preview local eligibility without starting a worker'],
    ['--prompt TEXT', 'Task prompt, equivalent to text after --'],
    ['--json', 'Write one structured result object to stdout'],
  ], note: 'A real run prints its run ID to stderr after worker admission and record persistence, before waiting. Resume it as the same local user with `cloudy-cloud resume RUN-ID`; the saved repo is used. Use -- to separate options from the prompt. Any legacy-config migration notice is written to stderr.' },
  resume: { desc: 'Reconnect to a foreground run started on this computer.', usages: [['resume', 'RUN-ID', '[--json]', '[--timeout SECONDS]']], rows: [
    ['RUN-ID', 'The ID printed by `cloudy-cloud run`'],
    ['--json', 'Write one structured result object to stdout'],
    ['--timeout SECONDS', 'Maximum wait for the worker result'],
  ], note: 'Default timeout: 2100 seconds; maximum: 86400. Run as the same local user; the saved repo is used. A cached result remains available after its owner exits. Active work needs the original owner running. Resume never starts a replacement worker.' },
  exec: { desc: 'Run a command in a fresh Linux sandbox seeded from a local git snapshot.', usages: [['exec', '--repo', 'PATH', '[--timeout SECONDS]', '[--json]', '--', 'COMMAND', '[ARG ...]']], rows: [
    ['--repo PATH', 'Required local git repository to snapshot'],
    ['--timeout SECONDS', 'Maximum command execution time'],
    ['--json', 'Write one structured result object to stdout'],
    ['-- COMMAND', 'Literal command and arguments for the sandbox'],
  ], note: 'No model or GitHub credentials are sent. The default timeout is 2100 seconds (35 minutes); minimum 1, maximum 86400. Clean, unchanged sandboxes are deleted. Dirty or uncertain state is retained with an inspection command. The CLI streams output where supported; buffered adapters report it at completion.' },
  protect: { desc: "Block direct pushes to a repo's default branch with a GitHub ruleset.", usages: [['protect', '[owner/repo]', '[--yes]']], rows: [
    ['owner/repo', 'The repo (default: the repo of the current folder)'],
    ['--yes', 'Do not ask first (you are saying yes to the change shown)'],
  ], note: 'Changes need a pull request, no force pushes, no deletion, and no bypass actors (it covers you and the cloud agents). A repo admin can still edit or disable the ruleset. Uses your own gh sign-in; you must be a repo admin.' },
  doctor: { desc: 'Check your own machine when subagents run there (self-hosted provider only).', usages: [['doctor']], note: 'Changes nothing. Run `cloudy-cloud setup --provider self-hosted` to choose that provider.' },
  dashboard: { desc: 'Open a read-only web page about your cloud machines.', usages: [['dashboard', '[--demo]', '[--port N]', '[--no-open]'], ['dashboard', '--prune']], rows: [
    ['--demo', 'Show made-up machines instead of yours'],
    ['--port N', 'Listen on port N (default: 4477)'],
    ['--no-open', 'Print the link but do not open a browser'],
    ['--prune', 'Delete every file in the streams folder older than 30 days (then the oldest over 1 GB), then exit'],
  ], note: 'The page is served on 127.0.0.1 only. Press Ctrl+C to stop.' },
  watch: { desc: 'Follow what your cloud agents do, like tail -f: one line per new step.', usages: [['watch', '[NAME|ID]', '[--json]']], rows: [
    ['NAME|ID', 'Follow one agent (default: every running agent of this install)'],
    ['--json', 'Print one JSON object per line'],
  ], note: 'Each line shows the time, the agent and its step. While it runs, it also reads your running coordinators every 10 seconds. Press Ctrl+C to stop.' },
  statusline: { desc: 'Print one short line of agent activity for a Claude Code status line.', usages: [['statusline']], note: 'Reads local files only and prints nothing when no agent runs. Coordinators show while cloudy-cloud watch or dashboard runs. Set it in Claude Code settings: "statusLine": {"type": "command", "command": "cloudy-cloud statusline"}.' },
  machines: { desc: 'List or delete the Cloudy Cloud machines of the active provider.', usages: [['machines', '[ls]'], ['machines', 'stop', ID], ['machines', 'stop', '--all', '[--yes]']], rows: [
    ['ls', 'One line per machine: name, provider, role, state, age and deletion time'],
    ['stop <id>', 'Delete one machine at once (an id, a machine name or an agent id)'],
    ['stop --all', 'Delete every machine in the list (asks once on a terminal)'],
    ['--yes', 'Say yes to that question, or delete without a terminal'],
  ], note: `Only machines Cloudy Cloud made are listed or deleted (labels purpose=cloudy-cloud and the older purpose=claude-cloud); a machine without one is never touched. Use provider:id or provider:name to resolve a shared ID or name. On microsandbox, listing also removes expired microVMs. ${WHERE}` },
  branches: { desc: 'List or delete the cloudy-cloud/<id> branches on origin that add nothing to the default branch (empty, or already merged).', usages: [['branches', 'prune', '[--yes]', '[--dry-run]']], rows: [
    ['(default)', 'Dry run: list what would be deleted'],
    ['--yes', 'Actually delete the listed branches'],
    ['--dry-run', 'List only, even together with --yes'],
  ], note: 'Only branches named cloudy-cloud/<id> are ever listed; every other name is skipped. Run it inside a git repo whose origin you can access.' },
  accounts: { desc: 'List, remove and re-sync the saved Claude accounts that coordinators sign in with. A saved account serves one coordinator at a time.', usages: [['accounts', 'ls', '[--json]'], ['accounts', 'rm', '<label>'], ['accounts', 'sync', '[--watch]']], rows: [
    ['ls', 'One line per account: label, email, state and last use'],
    ['ls --json', 'The same as a JSON array'],
    ['rm <label>', 'Forget a saved account; refuses while a coordinator holds it'],
    ['sync', 'Copy every leased machine\'s newest credential back to this laptop'],
    ['sync --watch', 'Keep syncing until no leased coordinator remains (start launches it; running it twice is harmless)'],
  ], note: 'A finished coordinator sign-in is saved as an account automatically; the next coordinator start reuses a free one, or the label given with --account. Saved credentials live under ~/.config/cloudy-cloud/accounts (mode 600; the index holds no tokens). Removing an account deletes only this laptop\'s saved credential — the Claude account itself is unaffected. Coordinators on different Claude accounts cannot message each other through Claude\'s ListAgents/SendMessage.' },
};

const guides = {
  image: ['Prepare the image coordinators start from (no sign-in: each coordinator signs in to Claude itself).', 'image [--forget]', [
    ['image', 'Build and save an image in one run (about 20 minutes)'],
    ['image --save', 'Same as image (kept for old scripts)'],
    ['image --forget', 'Remove the saved image setting (keeps the snapshot)'],
  ], 'Optional: start uses the base template without it. Safe to interrupt: run image again to resume. The image carries no Claude sign-in — a coordinator signs in at start (coordinator login). The image machine is deleted 2 hours after it is created.'],
  start: ['Start an always-on cloud coordinator (it runs Claude Code).', 'start NAME --repo URL [--branch BRANCH] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--env FILE]... [--account LABEL] [--json]', [
    ['NAME', 'Lowercase letters, digits and hyphens, up to 40'],
    ['--repo URL', 'Required GitHub https URL'],
    ['--branch BRANCH', 'Branch to clone (default: the repo default)'],
    ['--task TEXT', 'Start the coordinator on this task'],
    ['--task-file PATH', 'Same, read from a file'],
    ['--max-hours N', 'Delete the machine after N hours (up to 24, the default)'],
    ['--model NAME', 'Claude Code model for the session (for example opus or claude-opus-5-5)'],
    ['--env FILE', 'Bridge variables from a dotenv file (repeatable)'],
    ['--account LABEL', 'Sign in with the saved account LABEL (default: the free account used least recently)'],
    ['--json', 'Print the result as JSON (includes started: true)'],
  ], 'No image step is needed. A free saved account (cloudy-cloud accounts ls) signs the coordinator in itself; with none free the coordinator waits for its own Claude sign-in: finish it with coordinator login NAME. Stop the coordinator when you are done.'],
  attach: ['Open a coordinator\'s Claude session.', 'attach NAME', [], 'On a terminal it opens the session. When piped, it prints cloudy-cloud coordinator attach NAME instead; run that in your own terminal.'],
  login: ['Finish a coordinator\'s Claude sign-in and save it as an account the next coordinator reuses.', 'login NAME [--code CODE|-] [--account LABEL]', [
    ['NAME', 'The coordinator that waits for sign-in'],
    ['--code CODE', 'The code the browser sign-in showed, sent to the pane\'s prompt (letters, digits, #, _ and -)'],
    ['--code -', 'Read the code from stdin (first line) — the recommended form for agents'],
    ['--account LABEL', 'Save the sign-in under this label instead of the account email'],
  ], 'Without --code it attaches to the session so you sign in there. With --code it types the code for you — how an agent finishes a sign-in the user did in the browser. A finished sign-in is saved as an account (cloudy-cloud accounts ls) unless the machine already leases one.'],
  ls: ['List your cloud coordinators and whether one waits on a prompt.', 'ls', [], 'When piped, prints tab-separated NAME, STATE, CREATED, MACHINE, DELETES, WAITING, or "No coordinators.". It reads each running coordinator\'s screen once. "waiting for Claude sign-in" finishes with coordinator login NAME.'],
  status: ['Show one coordinator: state, the prompt it waits on (if any) and the attach command.', 'status NAME [--json]', [], 'Read-only. Reads the screen once. A coordinator runs with permission checks off, so a waiting prompt is unexpected: attach and answer it. A coordinator waiting for its Claude sign-in shows the login command.'],
  stop: ['Delete one coordinator machine.', 'stop NAME', [], 'Use provider:NAME when coordinator names are shared across providers. Its workers are cleaned up separately; check for remaining machines afterwards.'],
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

// A guide usage string ('start NAME --repo URL [--branch B]') split into pieces that never break across
// lines: a bracketed option group, and any word inside it, stays whole on one line.
const usagePieces = (usage) => { let depth = 0; return usage.split('').map((c) => { if (c === '[') depth++; if (c === ']') depth--; return c === ' ' && !depth ? '\n' : c; }).join('').split('\n'); };

// The wrapped Usage line(s) for one coordinator subcommand (or the general form): for error messages.
export function coordinatorUsage(command) {
  return usageLines([['coordinator', ...(command && guides[command] ? usagePieces(guides[command][1]) : ['<command>'])]]).join('\n');
}

export function coordinatorHelp(command) {
  if (command && guides[command]) {
    const [desc, usage, rows, note] = guides[command];
    return render({ desc, usages: [['coordinator', ...usagePieces(usage)]], rows, note: `${note} All coordinator commands: cloudy-cloud coordinator --help` });
  }
  return render({
    desc: 'Cloudy Cloud coordinators: always-on Claude Code sessions on their own cloud machines. A coordinator always runs Claude Code, never pi, omp, Codex or opencode.',
    usages: [['coordinator', '<command>']],
    rows: [
      ['image [--forget]', 'Optional: build a saved image (normally unneeded)'],
      ['start NAME --repo URL', 'Start a coordinator'],
      ['login NAME [--code CODE]', 'Finish its Claude sign-in (attaches, or sends the browser code)'],
      ['ls', 'List your coordinators'],
      ['status NAME', 'Show one coordinator and whether it waits on a prompt'],
      ['attach NAME', 'Open its session (prints the command when piped)'],
      ['stop NAME', 'Delete one'],
      ['finish [--force]', 'Used by a coordinator itself to delete its own machine'],
    ],
    note: 'More on one command: cloudy-cloud coordinator <command> --help. Each coordinator signs in to Claude for itself (coordinator login); a finished sign-in is saved as an account the next coordinator reuses — see cloudy-cloud accounts --help. Machines do not pause on their own. Stop coordinators when you are done.',
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
  const subs = { mcp: ['add', 'ls', 'rm'], machines: ['ls', 'stop'], branches: ['prune'], accounts: ['ls', 'rm', 'sync'] };
  // Options after a known command do not change which help is shown (e.g. `machines stop --all --help`).
  const opts = extra.every((a) => a.startsWith('-'));
  const ok = (name === 'coordinator' && (sub === undefined || Object.hasOwn(guides, sub)) && opts)
    || ((Object.hasOwn(cmds, name) || Object.hasOwn(hosts, name)) && (sub === undefined || subs[name]?.includes(sub)) && opts);
  if (!ok) { console.error(`cloudy-cloud: no help for "${[name, sub].filter(Boolean).join(' ')}". See: cloudy-cloud --help`); process.exitCode = 2; }
  else if (name === 'coordinator') console.log(coordinatorHelp(sub));
  else console.log(Object.hasOwn(hosts, name) ? `cloudy-cloud ${name} ${hosts[name]}` : helpText(name));
}
