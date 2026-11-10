// `cloudy-cloud open <agent-id-or-machine> <port> [--share|--unshare]`: reach an app a cloud agent runs on its machine.
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { eventsFile, foldAgents, readEvents } from './events.mjs';
import { listMachines } from './dashboard.mjs';
import { loadProvider } from './providers/index.mjs';

export const USAGE = `Usage: cloudy-cloud open <agent-id-or-machine> <port> [--share]
       cloudy-cloud open <agent-id-or-machine> <port> --unshare
Reach an app (for example a dev server) running on a cloud agent's machine.
  <port>      app port on the machine, or LOCAL:REMOTE to use another port on your computer
  (default)   private tunnel to http://127.0.0.1:<port> until you press Ctrl-C
  --share     publish a private link (token in the URL) that anyone holding it can open
  --unshare   remove that link
Start the app in the background on the machine (nohup npm run dev > /tmp/dev.log 2>&1 &), because a turn's
foreground processes end with the turn. The tunnel and link stop when the machine is deleted.`;

const fail = (m) => { throw new Error(m); };
const PORT_ERR = 'The port must be a number from 1 to 65535 (or LOCAL:REMOTE).';
const validPort = (p) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;

export function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--')), pos = argv.filter((a) => !a.startsWith('--'));
  const bad = flags.find((f) => f !== '--share' && f !== '--unshare');
  if (bad) fail(`Unknown option ${bad}.\n${USAGE}`);
  const [id, port, ...extra] = pos;
  if (!id) fail(USAGE);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) fail('The id may only use letters, digits, dots, dashes and underscores (characters outside A-Z a-z 0-9 . _ - are not allowed).');
  if (!port || extra.length) fail(`Missing port. ${PORT_ERR}\n${USAGE}`);
  const parts = port.split(':');
  if (parts.length > 2 || !parts.every(validPort)) fail(`"${port}" is not a valid port. ${PORT_ERR}`);
  const share = flags.includes('--share'), unshare = flags.includes('--unshare');
  if (share && unshare) fail('Use either --share or --unshare, not both.');
  if ((share || unshare) && parts.length > 1) fail('--share and --unshare take a single port, not LOCAL:REMOTE.');
  return { id, port, share, unshare };
}

// Returns the provider's machine id for an agent id (from the event log) or a machine id/name; throws with a plain fix.
export function resolveTarget(id, { machines, events, alive }) {
  const live = new Map(machines.map((m) => [m.id, m]));
  const agents = foldAgents(events, { alive });
  const check = (m, label) => (m.status === 'running' ? m.id : fail(`${label} is not running (state: ${m.state}). Its machine was stopped or deleted; start a new agent or coordinator.`));
  const agent = agents.find((a) => a.id === id);
  if (agent) {
    const m = live.get(agent.machine);
    return m ? check(m, `Agent ${id}`) : fail(`Agent ${id} is not running (its machine is gone).`);
  }
  const m = machines.find((x) => x.name === id || x.id === id);
  if (m) return check(m, `Machine ${id}`);
  const known = agents.filter((a) => live.get(a.machine)?.state === 'running').map((a) => a.id);
  const names = machines.filter((x) => x.state === 'running').map((x) => x.name || x.id);
  fail(`Unknown id "${id}". Running agent ids: ${known.join(', ') || 'none'}. Running machines: ${names.join(', ') || 'none'}.`);
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? loadEnv();
  const out = deps.out ?? ((s) => console.log(s)), err = deps.err ?? ((s) => console.error(s));
  try {
    const a = parseArgs(argv);
    const provider = deps.provider ?? await loadProvider(env);
    const Name = provider.name[0].toUpperCase() + provider.name.slice(1);
    const signIn = `If ${Name} is not signed in, run: cloudy-cloud setup`;
    let machines;
    try { machines = await (deps.list ?? listMachines)(env, provider); } catch (e) {
      if (e.code === 'no_key') fail(`${Name} is not signed in. Run: cloudy-cloud setup`);
      fail(`Could not list your machines (${e.message}). Check your internet connection and that ${provider.keyName} is still valid.`);
    }
    const events = (deps.events ?? (() => readEvents(eventsFile(env))))();
    const machine = resolveTarget(a.id, { machines, events, alive: deps.alive });
    const need = (cap, what) => provider.caps[cap] || fail(`${Name} does not support ${what}.`);
    if (a.unshare) { need('hasPublish', 'published links'); return await provider.unpublishPort(machine, a.port); }
    if (a.share) {
      need('hasPublish', 'published links');
      let r;
      try { r = await provider.publishPort(machine, a.port); } catch (e) { fail(`Publishing failed: ${e.message}\n${signIn}`); }
      out(r.url);
      out(`Anyone with this link can open the app until the machine is deleted or you run: cloudy-cloud open ${a.id} ${a.port} --unshare`);
      return 0;
    }
    need('hasPortForward', 'port forwarding');
    const [local, remote = local] = a.port.split(':');
    out(`Forwarding http://127.0.0.1:${local} to port ${remote} on ${machine}. Press Ctrl-C to stop.`);
    return await provider.forwardPort(machine, a.port);
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud open: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
