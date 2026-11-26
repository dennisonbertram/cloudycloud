// `cloudy-cloud open <agent-id-or-machine> <port> [--share|--unshare]`: reach an app a cloud agent runs on its machine.
import { helpText } from './cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { eventsFile, foldAgents, readEvents } from './events.mjs';
import { listMachines } from './dashboard.mjs';
import { loadProvider } from './providers/index.mjs';
import { providerFor, qualifiedMachine, assertProviderListed } from './provider-lookup.mjs';

export const ID_RE = /^[A-Za-z0-9._:-]+$/;
export const ID_ERR = 'The id has invalid characters. Use letters, digits, dots, dashes and underscores; provider-qualified machine ids use provider:id.';

export const USAGE = helpText('open', true);

const fail = (m) => { throw new Error(m); };
const PORT_ERR = 'The port must be a number from 1 to 65535 (or LOCAL:REMOTE).';
const validPort = (p) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;

export function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--')), pos = argv.filter((a) => !a.startsWith('--'));
  const bad = flags.find((f) => f !== '--share' && f !== '--unshare');
  if (bad) fail(`Unknown option ${bad}.\n${USAGE}`);
  const [id, port, ...extra] = pos;
  if (!id) fail(USAGE);
  if (!ID_RE.test(id)) fail(ID_ERR);
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
  const matchesId = (machineId, provider) => machines.filter((m) => m.id === machineId && (!provider || m.provider === provider));
  const unique = (rows, label) => {
    if (rows.length > 1) fail(`${label} matches machines from more than one provider. Use the provider-qualified machine in the dashboard or list machines to identify the target.`);
    return rows[0];
  };
  const agents = foldAgents(events, { alive });
  const check = (m, label) => (m.status === 'running' ? m : fail(`${label} is not running (state: ${m.state}). Its machine was stopped or deleted; start a new agent or coordinator.`));
  const scopedName = id.includes(':') ? id.slice(0, id.indexOf(':')) : undefined;
  const agentTarget = agents.find((a) => a.id === id);
  assertProviderListed(machines, agentTarget?.provider ?? scopedName, `target "${id}"`);
  const qualified = qualifiedMachine(id, machines);
  if (qualified) return check(qualified, `Machine ${id}`);
  const agent = agentTarget;
  if (agent) {
    const m = unique(matchesId(agent.machine, agent.provider), `Agent ${id}`);
    return m ? check(m, `Agent ${id}`) : fail(`Agent ${id} is not running (its machine is gone).`);
  }
  const byId = matchesId(id);
  const m = byId.length ? unique(byId, `Machine ${id}`) : unique(machines.filter((x) => x.name === id), `Machine ${id}`);
  if (m) return check(m, `Machine ${id}`);
  const known = agents.filter((a) => unique(matchesId(a.machine, a.provider), `Agent ${a.id}`)?.state === 'running').map((a) => a.id);
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
    let machines;
    try { machines = await (deps.list ?? listMachines)(env, provider); } catch (e) {
      if (e.code === 'no_key') fail(`${Name} is not signed in. Run: cloudy-cloud setup`);
      fail(`Could not list your machines (${e.message}). Check your internet connection and that ${provider.keyName} is still valid.`);
    }
    const events = (deps.events ?? (() => readEvents(eventsFile(env))))();
    const machine = resolveTarget(a.id, { machines, events, alive: deps.alive });
    const selected = providerFor(provider, machine);
    const machineId = machine.id;
    const selectedName = selected.name[0].toUpperCase() + selected.name.slice(1);
    const signIn = `If ${selectedName} is not signed in, run: cloudy-cloud setup`;
    const need = (cap, what) => selected.caps[cap] || fail(`${selected.name} does not support ${what}.`);
    if (a.unshare) { need('hasPublish', 'published links'); return await selected.unpublishPort(machineId, a.port); }
    if (a.share) {
      need('hasPublish', 'published links');
      let r;
      try { r = await selected.publishPort(machineId, a.port); } catch (e) { fail(`Publishing failed: ${e.message}\n${signIn}`); }
      out(r.url);
      out(`Anyone with this link can open the app until the machine is deleted or you run: cloudy-cloud open ${a.id} ${a.port} --unshare`);
      return 0;
    }
    need('hasPortForward', 'port forwarding');
    const [local, remote = local] = a.port.split(':');
    out(`Forwarding http://127.0.0.1:${local} to port ${remote} on ${machineId}. Press Ctrl-C to stop.`);
    return await selected.forwardPort(machineId, a.port);
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud open: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
