// `cloudy-cloud machines [ls]` lists the Cloudy Cloud machines of the active provider (the label
// purpose=cloudy-cloud). `machines stop <id-or-name>` deletes one, `machines stop --all` deletes
// them all. Machines without the cloudy-cloud label are never listed or deleted.
import { helpText } from './cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from './config.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { resolveTarget } from './open.mjs';
import { loadProvider } from './providers/index.mjs';
import { safeText } from './terminal.mjs';
import { fitCells, makeUi } from './ui.mjs';

export const USAGE = helpText('machines', true);

const fail = (m) => { throw new Error(m); };

// Live machines this tool made (label purpose=cloudy-cloud).
const ours = async (env, provider) => {
  if (!env[provider.keyName]) throw Object.assign(new Error(`${provider.keyName} is not set.`), { code: 'no_key' });
  return provider.list({ purpose: 'cloudy-cloud' }, { sdk: true });
};

// The label is checked again on the rows, so a provider that ignored the list filter still cannot
// put a foreign machine in the list, and every row is normalised and safe to print.
const clean = (rows) => rows.filter((m) => m.labels?.purpose === 'cloudy-cloud').map((m) => ({
  id: m.id, name: safeText(m.labels?.name ?? m.name ?? m.id) || m.id,
  role: m.labels?.role === 'coordinator-image' ? 'image' : m.labels?.role ?? 'machine',
  state: safeText(m.state ?? '') || 'unknown', status: m.status, startedAt: m.startedAt, deleteAt: m.deleteAt,
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
    for (const m of rows) c.out([m.name, m.role, m.state, when(m.startedAt), deleted(m), m.id].join('\t'));
    return;
  }
  const u = c.ui, color = { running: u.col.ok, creating: u.col.warn, starting: u.col.warn, suspended: u.col.warn, paused: u.col.warn };
  const rel = (v) => (Number.isFinite(new Date(v).getTime()) ? u.rel(v) : 'unknown');
  const cells = rows.map((m) => [fitCells(m.name, 24), m.role, [[m.state, color[m.state] ?? u.col.err]], rel(m.startedAt), m.deleteAt ? [[rel(m.deleteAt)]] : [['never', u.col.dim]]]);
  const running = rows.filter((m) => m.status === 'running').length;
  const count = running === rows.length ? `${running} running.` : `${running} of ${rows.length} running.`;
  c.out([u.table(['NAME', 'ROLE', 'STATE', 'AGE', 'DELETES'], cells), '', `  ${count}`, u.next('cloudy-cloud machines stop NAME')].join('\n'));
}

const oneDeleted = (c, m) => (c.ui.term ? c.out(c.ui.ok(`Deleted ${m.name}`, m.id)) : c.out(`Deleted ${m.name} (${m.id}).`));

async function stop(c, { all, yes, pos }) {
  const rows = await c.list();
  if (!all) {
    const id = resolveTarget(pos[0], { machines: rows, events: c.events(), alive: c.alive });
    const m = rows.find((x) => x.id === id);
    await c.provider.delete(id, { sdk: true });
    oneDeleted(c, m ?? { name: id, id });
    if (c.ui.term) c.out(c.ui.next('cloudy-cloud machines'));
    return;
  }
  if (!rows.length) return c.out('No Cloudy Cloud machines running.');
  if (!yes) {
    if (!c.tty) fail(`Deleting all ${rows.length} Cloudy Cloud machines needs --yes when there is no terminal to ask. Run: cloudy-cloud machines stop --all --yes`);
    const names = fitCells(rows.map((m) => m.name).join(', '), Math.max(20, c.ui.width - 30));
    if (!/^y/i.test((await c.ask(`Delete ${rows.length} Cloudy Cloud machine${rows.length === 1 ? '' : 's'} (${names})? [y/N] `)).trim())) return c.out('Nothing deleted.');
  }
  let failed = 0;
  for (const m of rows) {
    try { await c.provider.delete(m.id, { sdk: true }); oneDeleted(c, m); }
    catch (e) { failed++; c.err(`cloudy-cloud machines: could not delete ${m.name} (${m.id}): ${e.message}`); }
  }
  c.out(`Deleted ${rows.length - failed} machine${rows.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
  if (failed) fail(`${failed} of ${rows.length} machines could not be deleted. List what is left: cloudy-cloud machines`);
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
      alive: deps.alive,
      list: async () => {
        let rows;
        try { rows = await (deps.list ?? ours)(env, provider); }
        catch (e) {
          if (e.code === 'no_key') fail(`${Name} is not signed in. Run: cloudy-cloud setup`);
          fail(`Could not list your machines (${e.message}). Check your internet connection and that ${provider.keyName} is still valid.`);
        }
        return clean(rows);
      },
    };
    if (cmd === 'stop') await stop(c, { all, yes, pos });
    else await ls(c);
    return 0;
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud machines: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await run(process.argv.slice(2));
