// `cloudy-cloud shell <agent-id-or-machine> [-- cmd...]`: a shell on a cloud machine, for you and the local Claude session.
import { helpText } from './cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { loadEnv } from './config.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { listMachines } from './dashboard.mjs';
import { loadProvider } from './providers/index.mjs';
import { ID_RE, ID_ERR, resolveTarget } from './open.mjs';
import { guide } from './errors.mjs';
import { providerFor } from './provider-lookup.mjs';

export const USAGE = helpText('shell', true);

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
    if (argv.slice(0, argv.includes('--') ? argv.indexOf('--') : undefined).some((x) => x === '--help' || x === '-h')) { (deps.out ?? ((s) => console.log(s)))(helpText('shell')); return 0; }
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
    const selected = providerFor(provider, machine);
    if (!selected.caps.hasShell) fail(guide('shell_unsupported', { provider: selected.name }));
    const tty = deps.isTTY ?? !!process.stdin.isTTY;
    if (!a.cmd && !tty) fail(`An interactive shell needs a terminal, and this has none. Pass a command instead: cloudy-cloud shell ${a.id} -- <command>`);
    const shArgv = selected.shellArgv(machine.id, a.cmd);
    const r = (deps.spawn ?? ((argv, o) => spawnSync(argv[0], argv.slice(1), o)))(shArgv, { stdio: 'inherit', env: { ...process.env, ...selected.shellEnv?.() }, ...selected.shellSpawnOpts?.(shArgv) });
    // doctor checks self-hosted boxes only; everywhere else the fix is the missing provider CLI itself.
    if (r.error) fail(selected.name === 'self-hosted' ? `Could not start ${shArgv[0]} (${r.error.message}). Install it or run: cloudy-cloud doctor` : `Could not start ${shArgv[0]} (${r.error.message}). Install ${shArgv[0]} first.`);
    return r.status ?? (r.signal ? 128 + (constants.signals[r.signal] ?? 0) : 1);
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud shell: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
