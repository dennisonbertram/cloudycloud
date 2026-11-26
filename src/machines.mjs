// `cloudy-cloud machines [ls]` lists the Cloudy Cloud machines of the active provider (the label
// purpose=cloudy-cloud). `machines stop <id-or-name>` deletes one, `machines stop --all` deletes
// them all. Machines without the cloudy-cloud label are never listed or deleted.
import { helpText } from './cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from './config.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { loadProvider } from './providers/index.mjs';
import { providerFor, machineKey, qualifiedMachine, assertProviderListed } from './provider-lookup.mjs';
import { resolveMsbBin } from './providers/microsandbox.mjs';
import { safeText } from './terminal.mjs';
import { cellWidth, fitCells, makeUi, nextFit, statusLine, wrapText } from './ui.mjs';

export const USAGE = helpText('machines', true);

const fail = (m, fields) => { throw Object.assign(new Error(m), { ...fields, local: true }); };

// Anything from outside (names, labels, provider errors) prints on one line: control sequences
// stripped, and \r\n folded to spaces so a field cannot smuggle extra lines into the output.
const one = (v) => safeText(v ?? '').replace(/[\r\n]+/g, ' ');

// Live machines this tool made: label purpose=cloudy-cloud, or the historical purpose=claude-cloud
// from before the rename. The provider also accepts the key under its CLOUDY_CLOUD_-prefixed name
// (a coordinator holds it as a proxy secret). The msb "key" is its binary, also found at
// ~/.local/bin/msb or on PATH without the variable — the same readiness test dashboard's
// listMachines uses, so machines works everywhere shell, display and open do.
const OUR_PURPOSES = ['cloudy-cloud', 'claude-cloud'];
const ours = async (env, provider) => {
  if (!provider.providers && !env[provider.keyName] && !env[`CLOUDY_CLOUD_${provider.keyName}`] && !(provider.name === 'microsandbox' && resolveMsbBin(env))) throw Object.assign(new Error(`${provider.keyName} is not set.`), { code: 'no_key' });
  const errors = [];
  const rows = [];
  for (const purpose of OUR_PURPOSES) rows.push(...await provider.list({ purpose }, { sdk: true, onError: (e) => errors.push(e) }));
  Object.defineProperty(rows, 'providerErrors', { value: errors });
  Object.defineProperty(rows, 'providerNames', { value: (provider.providers ?? [provider]).map((p) => p.name) });
  return rows;
};

// The label is checked again on the rows, so a provider that ignored the list filter still cannot
// put a foreign machine in the list, and every displayed field is normalised and safe to print.
// `id` stays raw: it is the value provider.delete is called with.
const clean = (rows, defaultProvider) => {
  const out = rows.filter((m) => OUR_PURPOSES.includes(m.labels?.purpose)).map((m) => ({
    id: m.id, provider: m.provider ?? defaultProvider, name: one(m.labels?.name ?? m.name ?? m.id) || one(m.id),
    agent: m.labels?.agent, cname: one(m.labels?.name), machineName: one(m.name ?? m.id),
    role: m.labels?.role === 'coordinator-image' ? 'image' : one(m.labels?.role ?? 'machine'),
    state: one(m.state ?? '') || 'unknown', status: m.status, startedAt: m.startedAt, deleteAt: m.deleteAt,
  }));
  Object.defineProperties(out, { providerErrors: { value: rows.providerErrors ?? [] }, providerNames: { value: rows.providerNames ?? [defaultProvider] } });
  return out;
};

const when = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : 'unknown'; };
const deleted = (m) => (m.deleteAt ? when(m.deleteAt) : 'never');

const askOnce = async (q) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await rl.question(q); } finally { rl.close(); }
};

// One guidance layer, the same frame coordinator errors use: a ✖ headline (the message's first line,
// wrapped whole-word), the rest of the message dim underneath, then one → Next. Guidance — `e.next`,
// `e.short`, `e.fallback` and "Run:"-style or indented lines lifted from the message — is trusted only
// from an error this file made (`local`). Anything else is provider or SDK text: it prints as dim
// diagnostics under a fixed headline with the fixed Next, never as our instructions. Everything is
// already control-stripped by safeText.
const errScreen = (u, e) => {
  const ours = e?.local === true;
  let next = ours ? e.next : undefined;
  const body = [];
  for (const l of safeText(e?.message ?? e).split('\n')) {
    const t = l.trim();
    if (ours && next && t === String(next).trim()) continue;
    if (ours && !next && t) {
      const m = l.match(/^(?:Run|Next step|Next): (.+)$/) ?? l.match(/^\s{2,}(\S.*)$/);
      if (m) { next = m[1].trim(); continue; }
    }
    body.push(l);
  }
  const head = ours ? (e.short ?? body.shift() ?? 'Something failed.') : 'Something failed.';
  // The headline's first line carries the mark ('  ✖ ', wider '  [x] ' under LANG=C): budget what it renders.
  const markW = cellWidth(u.err(''));
  return [
    ...wrapText(u, head, u.width - markW).map((l, i) => (i ? `    ${u.dim(l)}` : u.err(l))),
    ...body.flatMap((l) => (l.trim() ? wrapText(u, l) : [''])).map((l) => (l ? `    ${u.dim(l)}` : '')),
    nextFit(u, next ?? (ours ? e.fallback : undefined) ?? 'cloudy-cloud machines ls'),
  ].join('\n');
};

// "(a, b, +K more)": as many names as fit `room` cells, the rest just counted.
const nameList = (names, room) => {
  let s = '', used = 0;
  for (const n of names) {
    const cand = used ? `${s}, ${n}` : n;
    const rest = names.length - used - 1;
    if (cellWidth(`(${cand}${rest ? `, +${rest} more` : ''})`) > room) break;
    s = cand; used++;
  }
  if (!used) { s = fitCells(names[0], Math.max(8, room - 2 - cellWidth(names.length > 1 ? `, +${names.length - 1} more` : ''))); used = 1; }
  const rest = names.length - used;
  return `(${s}${rest ? `, +${rest} more` : ''})`;
};

async function ls(c) {
  const rows = await c.list();
  if (!rows.length) return c.out('No Cloudy Cloud machines running.');
  const showProvider = rows.providerNames.length > 1;
  if (!c.ui.term) {
    const headers = showProvider ? ['NAME', 'PROVIDER', 'ROLE', 'STATE', 'STARTED', 'DELETES', 'ID'] : ['NAME', 'ROLE', 'STATE', 'STARTED', 'DELETES', 'ID'];
    c.out(headers.join('\t'));
    for (const m of rows) c.out((showProvider
      ? [m.name, m.provider ?? '', m.role, m.state, when(m.startedAt), deleted(m), one(m.id)]
      : [m.name, m.role, m.state, when(m.startedAt), deleted(m), one(m.id)]).join('\t'));
    return;
  }
  const u = c.ui, color = { running: u.col.ok, creating: u.col.warn, starting: u.col.warn, suspended: u.col.warn, paused: u.col.warn };
  const rel = (v) => (Number.isFinite(new Date(v).getTime()) ? u.rel(v) : 'unknown');
  const headers = showProvider ? ['NAME', 'PROVIDER', 'ROLE', 'STATE', 'AGE', 'DELETES'] : ['NAME', 'ROLE', 'STATE', 'AGE', 'DELETES'];
  const cells = rows.map((m) => showProvider
    ? [m.name, m.provider ?? '', m.role, [[m.state, color[m.state] ?? u.col.err]], rel(m.startedAt), m.deleteAt ? [[rel(m.deleteAt)]] : [['never', u.col.dim]]]
    : [m.name, m.role, [[m.state, color[m.state] ?? u.col.err]], rel(m.startedAt), m.deleteAt ? [[rel(m.deleteAt)]] : [['never', u.col.dim]]]);
  // NAME takes the cells the fixed columns leave, so it uses the whole terminal width.
  const wOf = (v) => (Array.isArray(v) ? v : [[String(v)]]).reduce((n, [t]) => n + cellWidth(t), 0);
  const fixed = headers.slice(1).map((h, i) => Math.max(h.length, ...cells.map((r) => wOf(r[i + 1]))));
  const nameRoom = u.width - 2 - 3 * 4 - fixed.reduce((a, b) => a + b, 0);
  const running = rows.filter((m) => m.status === 'running').length;
  const count = running === rows.length ? `${running} running.` : `${running} of ${rows.length} running.`;
  const foot = ['', `  ${count}`, nextFit(u, 'cloudy-cloud machines stop NAME')];
  if (nameRoom < 8) {
    // Too narrow for the table: a fitted line per machine, the id on a wrapped sub-line.
    return c.out([...rows.flatMap((m) => [
      `  ${fitCells(m.name, Math.max(4, u.width - 3 - cellWidth(m.state)))} ${u.paint(color[m.state] ?? u.col.err, m.state)}`,
      ...wrapText(u, `${showProvider && m.provider ? `${m.provider} ` : ''}id ${one(m.id)}`, u.width - 4).map((l) => `    ${u.dim(l)}`),
    ]), ...foot].join('\n'));
  }
  const fitted = cells.map((r) => [fitCells(r[0], nameRoom), ...r.slice(1)]);
  c.out([u.table(headers, fitted), ...foot].join('\n'));
}

// The one machine a token means, in precedence order: an exact machine id first (so a machine can
// never hide behind another's id), then an agent id (the `agent` label, or the event log's
// agent→machine record), then a name (the coordinator `name` label or the provider's machine
// name). A name matching more than one machine is refused, not guessed. Any listed state matches:
// machines are deleted, not connected to, so a non-running state is not a reason to refuse.
function resolve(token, rows, events) {
  let placement;
  for (const e of events) if (e.type === 'machine' && e.id === token && e.machine) placement = { machine: e.machine, provider: e.provider };
  const hasDirect = rows.some((m) => m.id === token || m.agent === token);
  const scope = token.includes(':') ? token.slice(0, token.indexOf(':')) : (!hasDirect ? placement?.provider : undefined);
  assertProviderListed(rows, scope, `machine target "${one(token)}"`);
  const qualified = qualifiedMachine(token, rows);
  if (qualified) return qualified;
  const unique = (found, kind) => {
    if (found.length > 1) fail(`"${one(token)}" matches multiple machines by ${kind}; use the provider shown in the machine list.`, { next: 'cloudy-cloud machines ls' });
    return found[0];
  };
  const byId = unique(rows.filter((m) => m.id === token), 'id');
  if (byId) return byId;
  const byAgent = unique(rows.filter((m) => m.agent === token), 'agent id');
  if (byAgent) return byAgent;
  const machineId = placement?.machine;
  if (machineId) {
    const m = unique(rows.filter((x) => x.id === machineId && (!placement.provider || x.provider === placement.provider)), 'recorded machine id');
    if (m) return m;
    fail(`Agent ${one(token)} is not running (its machine is gone).`, { next: 'cloudy-cloud machines ls' });
  }
  const named = rows.filter((m) => m.cname === token || m.machineName === token);
  if (named.length > 1) fail(`"${one(token)}" is the name of ${named.length} machines (${named.map((m) => one(m.id)).join(', ')}).\nStop one by id instead.`, { next: 'cloudy-cloud machines ls' });
  if (named.length) return named[0];
  fail(`Unknown id "${one(token)}".\nRunning machines: ${rows.map((m) => m.name).join(', ') || 'none'}.`, { next: 'cloudy-cloud machines ls' });
}

const oneDeleted = (c, m) => (c.ui.term
  ? c.out(statusLine(c.ui, 'ok', `Deleted ${fitCells(m.name, Math.max(8, c.ui.width - 14))}`, [one(m.id)]))
  : c.out(`Deleted ${m.name} (${one(m.id)}).`));

// A coordinator's workers are not deleted with it — say so once per stop that removed one. The hint
// is terminal-only: piped output keeps exactly the lines scripts already parse.
const WORKER_HINT = 'Its workers go with its cleanup or at their own deadline.';
const workerHint = (c) => { if (c.ui.term) c.out(c.ui.hint(WORKER_HINT)); };

async function stop(c, { all, yes, pos }) {
  const rows = await c.list();
  if (all) assertProviderListed(rows, undefined, 'stop --all');
  if (!all) {
    const m = resolve(pos[0], rows, c.events());
    // List again right before deleting: the resolved row may have changed or gone since it was read.
    const still = (await c.list()).find((x) => machineKey(x) === machineKey(m));
    if (!still) return c.out(`${m.name} (${one(m.id)}) is already gone; nothing to delete.`);
    try { await providerFor(c.provider, still).delete(still.id, { sdk: true }); }
    catch (e) { fail(`Could not delete ${still.name}.\n${one(e.message)}`, { next: 'cloudy-cloud machines ls' }); }
    oneDeleted(c, still);
    if (still.role === 'coordinator') workerHint(c);
    if (c.ui.term) c.out(nextFit(c.ui, 'cloudy-cloud machines'));
    return;
  }
  if (!rows.length) return c.out('No Cloudy Cloud machines running.');
  if (!yes) {
    if (!c.tty) fail(`Deleting all ${rows.length} Cloudy Cloud machines needs --yes when there is no terminal to ask.\nRun: cloudy-cloud machines stop --all --yes`);
    const q = [`Delete ${rows.length} Cloudy Cloud machine${rows.length === 1 ? '' : 's'}?`,
      `    ${nameList(rows.map((m) => m.name), c.ui.width - 4)}`, '  [y/N] '].join('\n');
    if (!/^y/i.test((await c.ask(q)).trim())) return c.out('Nothing deleted.');
  }
  // The confirmed list can be stale by the time the user answers: re-list and delete only the
  // shown ids that are still there (still purpose-filtered by list()).
  const shown = new Set(rows.map(machineKey));
  const del = (await c.list()).filter((m) => shown.has(machineKey(m)));
  if (!del.length) return c.out('All those machines were already deleted.');
  let failed = 0, coord = false;
  for (const m of del) {
    try { await providerFor(c.provider, m).delete(m.id, { sdk: true }); coord ||= m.role === 'coordinator'; oneDeleted(c, m); }
    catch (e) {
      failed++;
      if (!c.ui.term) c.err(`cloudy-cloud machines: could not delete ${m.name} (${one(m.id)}): ${one(e.message)}`);
      else {
        // The id's width counts against the name budget; the provider diagnostic wraps on its own
        // dim lines so the reason is never cut.
        const id = `(${one(m.id)})`, markW = cellWidth(c.ui.err(''));
        const head = `Could not delete ${fitCells(m.name, Math.max(8, c.ui.width - markW - 18 - cellWidth(id)))} ${id}`;
        c.err([...wrapText(c.ui, head, c.ui.width - markW).map((l, i) => (i ? `    ${c.ui.dim(l)}` : c.ui.err(l))),
          ...wrapText(c.ui, one(e.message)).map((l) => `    ${c.ui.dim(l)}`)].join('\n'));
      }
    }
  }
  c.out(`Deleted ${del.length - failed} machine${del.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
  if (coord) workerHint(c);
  if (failed) fail(`${failed} of ${del.length} machines could not be deleted. List what is left: cloudy-cloud machines`, { next: 'cloudy-cloud machines' });
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? loadEnv();
  const out = deps.out ?? ((s) => console.log(s)), err = deps.err ?? ((s) => console.error(s));
  const ui = deps.ui ?? makeUi();
  const [cmd, ...args] = argv;
  if (cmd === '--help' || cmd === '-h') { out(helpText('machines')); return 0; }
  const flags = args.filter((a) => a.startsWith('--')), pos = args.filter((a) => !a.startsWith('--'));
  const all = flags.includes('--all'), yes = flags.includes('--yes');
  const badFlag = flags.find((f) => f !== '--all' && f !== '--yes');
  let bad = Boolean(badFlag);
  if (cmd === 'ls') bad ||= args.length > 0;
  else if (cmd === 'stop') bad ||= all ? pos.length !== 0 : pos.length !== 1;
  else if (cmd !== undefined) bad = true;
  if (bad) {
    if (!ui.term) { err(USAGE); return 2; }
    const short = badFlag ? `Unknown option ${one(badFlag)}.`
      : cmd === 'ls' ? 'machines ls takes no arguments.'
      : cmd === 'stop' ? (all ? 'machines stop --all takes no names.' : 'machines stop needs one machine name or id (or --all).')
      : `"${one(cmd)}" is not a machines subcommand.`;
    err([ui.err(short), USAGE, nextFit(ui, 'cloudy-cloud machines --help')].join('\n'));
    return 2;
  }
  try {
    const provider = deps.provider ?? await loadProvider(env);
    const c = {
      env, provider, out, err, ui,
      tty: deps.tty ?? !!process.stdin.isTTY,
      ask: deps.ask ?? askOnce,
      events: deps.events ?? (() => readEvents(eventsFile(env))),
      list: async () => {
        let rows;
        try { rows = await (deps.list ?? ours)(env, provider); }
        catch (e) {
          // The provider's own fix text names the real recovery (setup, an install line or an env var);
          // "is not signed in" is wrong for every provider whose key is not a sign-in.
          if (e.code === 'no_key') fail(provider.text.noKeyFix, { fallback: 'cloudy-cloud setup' });
          fail(`Could not list your machines (${one(e.message)}). Check your internet connection and that ${provider.keyName} is still valid.`, { next: 'cloudy-cloud machines ls' });
        }
        const reported = new Set();
        for (const e of rows.providerErrors ?? []) {
          const key = `${e.provider ?? ''}:${e.code ?? ''}`;
          if (reported.has(key)) continue;
          reported.add(key);
          err(`cloudy-cloud machines: could not list ${one(e.provider ?? 'a provider')}: ${one(e.message)}`);
        }
        return clean(rows, provider.name);
      },
    };
    if (cmd === 'stop') await stop(c, { all, yes, pos });
    else await ls(c);
    return 0;
  } catch (e) {
    // The raw-print Usage shortcut is only for errors this file made; a foreign "Usage"-looking
    // message is sanitised like any other.
    const usage = e?.local === true && String(e?.message ?? '').startsWith('Usage');
    err(usage ? e.message : ui.term ? errScreen(ui, e) : `cloudy-cloud machines: ${one(e?.message ?? e)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await run(process.argv.slice(2));
