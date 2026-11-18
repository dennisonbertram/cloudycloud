// Help for `cloudy-cloud coordinator`. The top-level help lives in bin/cloudy-cloud.
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
  ], 'Run "image" and "image --save" once first. Stop the coordinator when you are done.'],
  attach: ['Print the SSH command for a coordinator.', 'attach NAME', [], 'Run the printed command to connect.'],
  ls: ['List your cloud coordinators and whether one waits on a prompt.', 'ls', [], 'When piped, prints tab-separated NAME, STATE, CREATED, MACHINE, DELETES, WAITING, or "No coordinators.". It reads each running coordinator\'s screen once.'],
  status: ['Show one coordinator: state, the prompt it waits on (if any) and the attach command.', 'status NAME [--json]', [], 'Read-only. Reads the screen once. A coordinator runs with permission checks off, so a waiting prompt is unexpected: attach and answer it.'],
  stop: ['Delete one coordinator machine.', 'stop NAME', [], 'Its workers are cleaned up separately; check for remaining machines afterwards.'],
  finish: ['Run on a coordinator machine by the coordinator: check nothing is lost, then delete this machine.', 'finish [--force]', [
    ['--force', 'Skip the git and worker checks'],
  ], 'Refuses while work is unpushed or workers are running.'],
};

export function coordinatorHelp(command) {
  if (command && guides[command]) {
    const [description, usage, options, note] = guides[command];
    return [description, '', `Usage: cloudy-cloud coordinator ${usage}`,
      ...(options.length ? ['', ...options.map(([a, b]) => `  ${a.padEnd(18)} ${b}`)] : []),
      '', note, '', 'All coordinator commands: cloudy-cloud coordinator --help'].join('\n');
  }
  return `Cloudy Cloud coordinators: always-on Claude Code sessions on their own cloud machines. A coordinator always runs Claude Code, never pi, omp, Codex or opencode.

Usage: cloudy-cloud coordinator <command>

  image [--save]          save a Claude sign-in for coordinators (do this once)
  start NAME --repo URL   start a coordinator
  ls                      list your coordinators
  attach NAME             print the command that connects to one
  stop NAME               delete one
  finish [--force]        used by a coordinator itself to delete its own machine

More on one command: cloudy-cloud coordinator <command> --help
Machines do not pause on their own. Stop coordinators when you are done.`;
}
