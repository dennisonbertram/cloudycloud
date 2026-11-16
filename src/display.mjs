// `cloudy-cloud display <agent|machine|coordinator> [--control] [--ttl SECONDS] [--screenshot FILE] [--unshare]`: see a cloud machine's desktop.
// The link is a bearer token: it goes to stdout only, never to the event log, a file or stderr.
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { loadEnv } from './config.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { listMachines } from './dashboard.mjs';
import { loadProvider } from './providers/index.mjs';
import { ID_RE, ID_ERR, resolveTarget } from './open.mjs';
import { guide } from './errors.mjs';

export const USAGE = `Usage: cloudy-cloud display <agent-id-or-machine> [--control] [--ttl SECONDS]
       cloudy-cloud display <agent-id-or-machine> --screenshot FILE
       cloudy-cloud display <agent-id-or-machine> --unshare
Print a link to the machine's desktop (android, omarchy, gpu, macos); only the link goes to stdout.
  (default)         view-only link for 1 hour
  --control         let the viewer click and type
  --ttl SECONDS     link lifetime, 60 to 86400
  --screenshot FILE write a PNG of the screen to FILE and print the path
  --unshare         revoke every display link for the machine`;

const fail = (m) => { throw new Error(m); };

export function parseArgs(argv) {
  const a = { control: false, ttl: 3600, screenshot: undefined, unshare: false }, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--control') a.control = true;
    else if (f === '--unshare') a.unshare = true;
    else if (f === '--ttl') { const v = argv[++i]; a.ttl = /^\d+$/.test(v ?? '') ? +v : NaN; a.ttlSet = true; }
    else if (f === '--screenshot') { a.screenshot = argv[++i]; if (!a.screenshot || a.screenshot.startsWith('--')) fail(`--screenshot needs a file name.\n${USAGE}`); }
    else if (f.startsWith('--')) fail(`Unknown option ${f}.\n${USAGE}`);
    else pos.push(f);
  }
  if (pos.length !== 1) fail(USAGE);
  if (!ID_RE.test(pos[0])) fail(ID_ERR);
  if (!(a.ttl >= 60 && a.ttl <= 86400)) fail(`--ttl must be a whole number of seconds from 60 to 86400.`);
  if (a.unshare && (a.control || a.ttlSet || a.screenshot)) fail('--unshare cannot be combined with other options.');
  if (a.screenshot && (a.control || a.ttlSet)) fail('--screenshot cannot be combined with --control or --ttl.');
  return { id: pos[0], control: a.control, ttl: a.ttl, screenshot: a.screenshot, unshare: a.unshare };
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
    let machine;
    try { machine = resolveTarget(a.id, { machines, events, alive: deps.alive }); } catch (e) {
      if (/is not running/.test(e.message)) fail(`${e.message}\n${guide('machine_not_running', { id: a.id })}`);
      throw e;
    }
    if (!provider.caps.hasDisplay) fail(guide('display_unsupported', { provider: provider.name }));
    // Provider errors with a display code get that code's plain next step; the raw message never carries the link.
    const call = async (fn) => {
      try { return await fn(); } catch (e) {
        if (['desktop_unavailable', 'display_forbidden'].includes(e.code)) fail(guide(e.code, { kind: e.kind }));
        fail(e.message);
      }
    };
    if (a.unshare) {
      await call(() => provider.revokeDisplayLinks(machine));
      err(`Revoked every display link for ${a.id}.`);
      return 0;
    }
    if (a.screenshot) {
      const png = await call(() => provider.screenshot(machine));
      await writeFile(a.screenshot, png);
      out(a.screenshot);
      return 0;
    }
    // The first desktop start can be slow (gpu installs one, about two minutes), so say so if it takes a while.
    const timer = setTimeout(() => err('Starting the desktop; this can take about two minutes the first time.'), deps.slowMs ?? 5000);
    let r;
    try { r = await call(() => provider.displayLink(machine, { control: a.control, ttlSeconds: a.ttl })); } finally { clearTimeout(timer); }
    out(r.url);
    err(`Anyone with the link can ${a.control ? 'view and control' : 'view'} the screen until it expires (${new Date(r.expiresAt).toISOString()}). Revoke it with: cloudy-cloud display ${a.id} --unshare`);
    return 0;
  } catch (e) {
    err(e.message.startsWith('Usage') ? e.message : `cloudy-cloud display: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
