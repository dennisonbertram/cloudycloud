// Help for `cloudy-cloud coordinator`. The top-level help lives in bin/cloudy-cloud.
const guides = {
  image: ['Prepare a reusable Claude sign-in for coordinators.', 'image [--save]', [
    ['image', 'Create a machine to sign in on'],
    ['image --save', 'Save its snapshot and delete the machine'],
  ], 'Sign in on the image machine (claude auth login) before you save it.'],
  start: ['Start an always-on cloud coordinator.', 'start NAME --repo URL [--branch BRANCH] [--task TEXT | --task-file PATH] [--max-hours N] [--model NAME] [--json]', [
    ['NAME', 'Lowercase letters, digits and hyphens, up to 40'],
    ['--repo URL', 'Required GitHub https URL'],
    ['--branch BRANCH', 'Branch to clone (default: the repo default)'],
    ['--task TEXT', 'Start the coordinator on this task'],
    ['--task-file PATH', 'Same, read from a file'],
    ['--max-hours N', 'Delete the machine after N hours (up to 24, the default)'],
    ['--model NAME', 'Claude model for the session (for example opus or claude-opus-5-5)'],
    ['--json', 'Print the result as JSON (includes started: true)'],
  ], 'Run "image" and "image --save" once first. Stop the coordinator when you are done.'],
  attach: ['Print the SSH command for a coordinator.', 'attach NAME', [], 'Run the printed command to connect.'],
  ls: ['List your cloud coordinators.', 'ls', [], 'When piped, prints tab-separated NAME, STATE, CREATED, MACHINE, DELETES, or "No coordinators.".'],
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
  return `Cloudy Cloud coordinators: always-on Claude sessions on their own cloud machines.

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
