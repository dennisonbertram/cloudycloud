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

const guides = {
  image: ['Prepare a reusable Claude login.', 'image [--save]', [
    ['image', 'Create a machine to sign in on'],
    ['image --save', 'Save its snapshot and delete the machine'],
  ], 'Sign in on the image machine before saving it.'],
  start: ['Start an always-on cloud session.', 'start NAME --repo URL [--branch BRANCH]', [
    ['NAME', 'Lowercase letters, digits, hyphens; max 40'],
    ['--repo URL', 'Required GitHub HTTPS repository URL'],
    ['--branch BRANCH', 'Optional branch to clone'],
  ], 'Create and save an image first. Stop the coordinator when done.'],
  attach: ['Print the SSH command for a coordinator.', 'attach NAME', [], 'Copy and run the printed command to connect.'],
  ls: ['List your cloud coordinators.', 'ls', [], 'Redirect or pipe output for tab-separated NAME, STATE, CREATED, MACHINE.'],
  stop: ['Delete one coordinator machine.', 'stop NAME', [], 'Worker cleanup runs separately; check for remaining machines afterward.'],
};

export function coordinatorHelp(command, ui = terminal()) {
  if (command && guides[command]) {
    const [description, usage, options, note] = guides[command];
    return [ui.title(`coordinator / ${command}`, description), ui.section('USAGE'),
      ui.command(`claude-cloud coordinator ${usage}`),
      ...(options.length ? [ui.section('ARGUMENTS'), ...options.map(([a, b]) => ui.item(a, b))] : []),
      ui.section('NOTE'), ui.text(note), '',
      ui.text('All commands: claude-cloud coordinator --help'), ''].join('\n');
  }
  return [ui.title('coordinators', 'Always-on Claude sessions, managed from your terminal.'),
    ui.section('USAGE'), ui.command('claude-cloud coordinator <command>'),
    ui.section('SET UP ONCE'), ui.item('image', 'Create a machine for Claude sign-in'),
    ui.item('image --save', 'Save its login as a reusable image'),
    ui.section('EVERY DAY'), ui.item('start NAME --repo URL', 'Start a cloud session'),
    ui.item('ls', 'See your coordinators'), ui.item('attach NAME', 'Get the terminal connection command'),
    ui.item('stop NAME', 'Delete a coordinator when finished'),
    ui.section('NEXT'), ui.command('claude-cloud coordinator image'),
    '', ui.text('More detail: claude-cloud coordinator <command> --help'),
    ui.text('Machines do not pause automatically. Stop them when finished.'), ''].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(process.argv[2] === '--version' ? version : rootHelp());
}
