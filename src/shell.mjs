// `cloudy-cloud shell <agent-id-or-machine> [-- cmd...]`: a shell on a cloud machine, for you and the local Claude session.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnv } from './config.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { listMachines } from './dashboard.mjs';
import { loadProvider } from './providers/index.mjs';
import { ID_RE, ID_ERR, resolveTarget } from './open.mjs';
import { guide } from './errors.mjs';

export const USAGE = `Usage: cloudy-cloud shell <agent-id-or-machine> [-- command [args...]]
Open a shell on a cloud machine, or run one command there.
  (no command)   interactive login shell on the machine
  -- command     run the command, stream its output, and exit with its exit code
Each argument after -- reaches the machine unchanged. Do not put secrets in the command.`;

const fail = (m) => { throw new Error(m); };

export function parseArgs(argv) {
  const i = argv.indexOf('--');
  const head = i < 0 ? argv : argv.slice(0, i), tail = i < 0 ? [] : argv.slice(i + 1);
  const bad = head.find((a) => a.startsWith('--'));
  if (bad) fail(`Unknown option ${bad}.\n${USAGE}`);
  if (head.length !== 1) fail(USAGE);
  if (!ID_RE.test(head[0])) fail(ID_ERR);
  return { id: head[0], cmd: tail.length ? tail : undefined };
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? loadEnv();
  const err = deps.err ?? ((s) => console.error(s));
  try {
    const a = parseArgs(argv);
    const provider = deps.provider ?? await loadProvider(env);
    const Name = provider.name[0].toUpperCase() + provider.name.slice(1);
    let machines;
    try { machines = await (deps.list ?? listMachines)(env, provider); } catch (e) {
      if (e.code === 'no_key') fail(`${Name} is not signed in. Run: cloudy-cloud setup`);
      fail(`Could not list your machines (${e.message}). Check your internet connection and that ${provider.keyName} is still valid.`);
    }
    const events = (deps.events ?? (() => readEvents(eventsFile(env))))();
    let machine;
    try { machine = resolveTarget(a.id, { machines, events, alive: deps.alive }); } catch (e) {
      if (/is not running/.test(e.message)) fail(`${e.message}\n${guide('machine_not_running', { id: a.id })}`);
      throw e;
    }
    if (!provider.caps.hasShell) fail(guide('shell_unsupported', { provider: provider.name }));
    const [bin, ...args] = provider.shellArgv(machine, a.cmd);
    const r = (deps.spawn ?? ((argv) => spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' })))([bin, ...args]);
    if (r.error) fail(`Could not start ${bin} (${r.error.message}). Install it or run: cloudy-cloud doctor`);
    return r.status ?? (r.signal ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 })[r.signal] ?? 0) : 1);
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud shell: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
