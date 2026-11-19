// `cloudy-cloud machines [ls]` lists the Cloudy Cloud machines of the active provider (the label
// purpose=cloudy-cloud). `machines stop <id-or-name>` deletes one, `machines stop --all` deletes
// them all. Machines without the cloudy-cloud label are never listed or deleted.
import { helpText } from './cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from './config.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { loadProvider } from './providers/index.mjs';
import { safeText } from './terminal.mjs';
import { fitCells, makeUi } from './ui.mjs';

export const USAGE = helpText('machines', true);

const fail = (m) => { throw new Error(m); };

// Anything from outside (names, labels, provider errors) prints on one line: control sequences
// stripped, and \r\n folded to spaces so a field cannot smuggle extra lines into the output.
const one = (v) => safeText(v ?? '').replace(/[\r\n]+/g, ' ');

// Live machines this tool made (label purpose=cloudy-cloud). The provider also accepts the key
// under its CLOUDY_CLOUD_-prefixed name (a coordinator holds it as a proxy secret).
const ours = async (env, provider) => {
  if (!env[provider.keyName] && !env[`CLOUDY_CLOUD_${provider.keyName}`]) throw Object.assign(new Error(`${provider.keyName} is not set.`), { code: 'no_key' });
  return provider.list({ purpose: 'cloudy-cloud' }, { sdk: true });
};

// The label is checked again on the rows, so a provider that ignored the list filter still cannot
// put a foreign machine in the list, and every displayed field is normalised and safe to print.
// `id` stays raw: it is the value provider.delete is called with.
const clean = (rows) => rows.filter((m) => m.labels?.purpose === 'cloudy-cloud').map((m) => ({
  id: m.id, name: one(m.labels?.name ?? m.name ?? m.id) || one(m.id),
  agent: m.labels?.agent, cname: one(m.labels?.name), machineName: one(m.name ?? m.id),
  role: m.labels?.role === 'coordinator-image' ? 'image' : one(m.labels?.role ?? 'machine'),
  state: one(m.state ?? '') || 'unknown', status: m.status, startedAt: m.startedAt, deleteAt: m.deleteAt,
}));

const when = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : 'unknown'; };
const deleted = (m) => (m.deleteAt ? when(m.deleteAt) : 'never');

const askOnce = async (q) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await rl.question(q); } finally { rl.close(); }
};

async function ls(c) {
  const rows = await c.list();
  if (!rows.length) return c.out('No Cloudy Cloud machines running.');
  if (!c.ui.term) {
    c.out(['NAME', 'ROLE', 'STATE', 'STARTED', 'DELETES', 'ID'].join('\t'));
    for (const m of rows) c.out([m.name, m.role, m.state, when(m.startedAt), deleted(m), one(m.id)].join('\t'));
    return;
  }
  const u = c.ui, color = { running: u.col.ok, creating: u.col.warn, starting: u.col.warn, suspended: u.col.warn, paused: u.col.warn };
  const rel = (v) => (Number.isFinite(new Date(v).getTime()) ? u.rel(v) : 'unknown');
  const cells = rows.map((m) => [fitCells(m.name, 24), m.role, [[m.state, color[m.state] ?? u.col.err]], rel(m.startedAt), m.deleteAt ? [[rel(m.deleteAt)]] : [['never', u.col.dim]]]);
  const running = rows.filter((m) => m.status === 'running').length;
  const count = running === rows.length ? `${running} running.` : `${running} of ${rows.length} running.`;
  c.out([u.table(['NAME', 'ROLE', 'STATE', 'AGE', 'DELETES'], cells), '', `  ${count}`, u.next('cloudy-cloud machines stop NAME')].join('\n'));
}

// The one machine a token means, in precedence order: an exact machine id first (so a machine can
// never hide behind another's id), then an agent id (the `agent` label, or the event log's
// agent→machine record), then a name (the coordinator `name` label or the provider's machine
// name). A name matching more than one machine is refused, not guessed. Any listed state matches:
// machines are deleted, not connected to, so a non-running state is not a reason to refuse.
function resolve(token, rows, events) {
  const byId = rows.find((m) => m.id === token);
  if (byId) return byId;
  const byAgent = rows.find((m) => m.agent === token);
  if (byAgent) return byAgent;
  let machineId;
  for (const e of events) if (e.type === 'machine' && e.id === token && e.machine) machineId = e.machine;
  if (machineId) {
    const m = rows.find((x) => x.id === machineId);
    if (m) return m;
    fail(`Agent ${one(token)} is not running (its machine is gone).`);
  }
  const named = rows.filter((m) => m.cname === token || m.machineName === token);
  if (named.length > 1) fail(`"${one(token)}" is the name of ${named.length} machines (${named.map((m) => one(m.id)).join(', ')}). Stop one by id instead.`);
  if (named.length) return named[0];
  fail(`Unknown id "${one(token)}". Running machines: ${rows.map((m) => m.name).join(', ') || 'none'}.`);
}

const oneDeleted = (c, m) => (c.ui.term ? c.out(c.ui.ok(`Deleted ${m.name}`, one(m.id))) : c.out(`Deleted ${m.name} (${one(m.id)}).`));

async function stop(c, { all, yes, pos }) {
  const rows = await c.list();
  if (!all) {
    const m = resolve(pos[0], rows, c.events());
    // List again right before deleting: the resolved row may have changed or gone since it was read.
    const still = (await c.list()).find((x) => x.id === m.id);
    if (!still) return c.out(`${m.name} (${one(m.id)}) is already gone; nothing to delete.`);
    await c.provider.delete(still.id, { sdk: true });
    oneDeleted(c, still);
    if (c.ui.term) c.out(c.ui.next('cloudy-cloud machines'));
    return;
  }
  if (!rows.length) return c.out('No Cloudy Cloud machines running.');
  if (!yes) {
    if (!c.tty) fail(`Deleting all ${rows.length} Cloudy Cloud machines needs --yes when there is no terminal to ask. Run: cloudy-cloud machines stop --all --yes`);
    const names = fitCells(rows.map((m) => m.name).join(', '), Math.max(20, c.ui.width - 30));
    if (!/^y/i.test((await c.ask(`Delete ${rows.length} Cloudy Cloud machine${rows.length === 1 ? '' : 's'} (${names})? [y/N] `)).trim())) return c.out('Nothing deleted.');
  }
  // The confirmed list can be stale by the time the user answers: re-list and delete only the
  // shown ids that are still there (still purpose-filtered by list()).
  const shown = new Set(rows.map((m) => m.id));
  const del = (await c.list()).filter((m) => shown.has(m.id));
  if (!del.length) return c.out('All those machines were already deleted.');
  let failed = 0;
  for (const m of del) {
    try { await c.provider.delete(m.id, { sdk: true }); oneDeleted(c, m); }
    catch (e) { failed++; c.err(`cloudy-cloud machines: could not delete ${m.name} (${one(m.id)}): ${one(e.message)}`); }
  }
  c.out(`Deleted ${del.length - failed} machine${del.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
  if (failed) fail(`${failed} of ${del.length} machines could not be deleted. List what is left: cloudy-cloud machines`);
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? loadEnv();
  const out = deps.out ?? ((s) => console.log(s)), err = deps.err ?? ((s) => console.error(s));
  const [cmd, ...args] = argv;
  if (cmd === '--help' || cmd === '-h') { out(helpText('machines')); return 0; }
  const flags = args.filter((a) => a.startsWith('--')), pos = args.filter((a) => !a.startsWith('--'));
  const all = flags.includes('--all'), yes = flags.includes('--yes');
  let bad = flags.some((f) => f !== '--all' && f !== '--yes');
  if (cmd === 'ls') bad ||= args.length > 0;
  else if (cmd === 'stop') bad ||= all ? pos.length !== 0 : pos.length !== 1;
  else if (cmd !== undefined) bad = true;
  if (bad) { err(USAGE); return 2; }
  try {
    const provider = deps.provider ?? await loadProvider(env);
    const Name = provider.name[0].toUpperCase() + provider.name.slice(1);
    const c = {
      env, provider, out, err,
      ui: deps.ui ?? makeUi(),
      tty: deps.tty ?? !!process.stdin.isTTY,
      ask: deps.ask ?? askOnce,
      events: deps.events ?? (() => readEvents(eventsFile(env))),
      list: async () => {
        let rows;
        try { rows = await (deps.list ?? ours)(env, provider); }
        catch (e) {
          if (e.code === 'no_key') fail(`${Name} is not signed in. Run: cloudy-cloud setup`);
          fail(`Could not list your machines (${one(e.message)}). Check your internet connection and that ${provider.keyName} is still valid.`);
        }
        return clean(rows);
      },
    };
    if (cmd === 'stop') await stop(c, { all, yes, pos });
    else await ls(c);
    return 0;
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud machines: ${one(e.message)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await run(process.argv.slice(2));
