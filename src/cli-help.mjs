import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { terminal } from './terminal.mjs';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function rootHelp(ui = terminal()) {
  return [
    ui.title(`v${version}`, 'Your local Claude. A cloud of remote workers.'),
    ui.section('GET STARTED'),
    ui.item('claude-cloud', 'Start Claude with cloud subagents'),
    ui.item('./install.sh', 'Set up this checkout'),
    ui.section('COORDINATORS'),
    ui.item('coordinator --help', 'Manage always-on cloud sessions'),
    ui.text('Run: claude-cloud coordinator --help'),
    ui.section('OPTIONS'),
    ui.item('--help, -h', 'Show this guide'),
    ui.item('--version', 'Show the claude-cloud version'),
    ui.section('TRY IT'),
    ui.text('From a git repository with a GitHub origin:'),
    ui.command('claude-cloud'),
    ui.text('Then ask: use a subagent to review this repo.'),
    '',
    ui.text('Other arguments go to Claude unchanged. For Claude options, run: claude --help'),
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(process.argv[2] === '--version' ? version : rootHelp());
}
