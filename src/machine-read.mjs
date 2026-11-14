// Read-only, rate-limited reader for what a cloudy-cloud machine keeps: stream files, meta.json, a coordinator's
// events.jsonl, and its live tmux pane. Uses only the provider contract (connect, commands.run) and runs two fixed
// commands: a tail of one whitelisted file, and `tmux capture-pane`. Nothing is written on a machine; no key is sent.
// Every string returned or cached is redacted, with the env's key values removed too. Errors carry a `code`:
// invalid_path | not_listed | not_found (machine gone) | transient. Budget limits never throw: they return the cache.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROVIDER_KEY } from './config.mjs';
import { redactText } from './events.mjs';
import { SECRETS } from './run-subagent.mjs';
import { redactLine } from './stream.mjs';

const CHUNK = 262_144;
const LIST_MS = 10_000;
const RUN_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const NAME = /^(?:stream\/t\d{1,4}\.jsonl|stream\/meta\.json|events\.jsonl|streams\/[0-9a-f]{8}\/t\d{1,4}\.jsonl)$/;
const PANE_CMD = "tmux capture-pane -p -t claude -S -200 2>&1 || echo 'no tmux session named claude'";
const err = (code, message) => Object.assign(new Error(message), { code });

export function createMachineReader(provider, env, { now = Date.now, maxConcurrent = 4, minIntervalMs = 3000, cacheMs = 2500, cacheDir = join(homedir(), '.config/cloudy-cloud/streams/remote') } = {}) {
  const values = [...SECRETS, provider.keyName, ...Object.keys(env ?? {}).filter((k) => PROVIDER_KEY.test(k))].map((k) => env?.[k]).filter(Boolean);
  const scrub = (s) => values.reduce((t, v) => t.split(v).join('[redacted]'), s);
  const clean = (text) => text.split('\n').map((l) => (l ? redactLine(l, scrub) : l)).join('\n');
  const machines = new Map(); // id -> { sbx (connect promise), last (time of the last command), inflight: Map, results: Map }
  const written = new Map(); // cache file -> raw offset its content ends at
  let listed, listing, active = 0;
  const waiting = [];

  const state = (id) => { let m = machines.get(id); if (!m) machines.set(id, m = { inflight: new Map(), results: new Map() }); return m; };
  const wrap = (e) => (e?.code && ['invalid_path', 'not_listed', 'not_found', 'transient'].includes(e.code) ? e : err(e?.code === 'not_found' ? 'not_found' : 'transient', scrub(String(e?.message ?? e))));

  async function checkListed(id) {
    if (!listed || now() - listed.at > LIST_MS) {
      listing ??= provider.list({ purpose: 'cloudy-cloud' }).then((ms) => { listed = { at: now(), ids: new Set(ms.map((m) => m.id)) }; }).finally(() => { listing = undefined; });
      try { await listing; } catch (e) { throw wrap(e); }
    }
    if (!listed.ids.has(id)) throw err('not_listed', `Machine ${id} is not one of your cloudy-cloud machines.`);
  }
  const slot = async () => { if (active >= maxConcurrent) await new Promise((r) => waiting.push(r)); active++; };
  const release = () => { active--; waiting.shift()?.(); };

  // One command on one machine: connect (cached), run, release. A not_found drops the cached connection.
  async function exec(id, cmd) {
    const m = state(id);
    await slot();
    try {
      m.sbx ??= provider.connect(id);
      const sbx = await m.sbx.catch((e) => { m.sbx = undefined; throw e; });
      m.last = now();
      return await sbx.commands.run(cmd, { cwd: sbx.home ?? '/home/user', timeoutMs: RUN_MS });
    } catch (e) {
      if (e?.code === 'not_found') m.sbx = undefined;
      throw wrap(e);
    } finally { release(); }
  }

  // Budget: share an in-flight call; inside the interval return what we have; otherwise call.
  async function limited(id, key, empty, call) {
    const m = state(id);
    if (m.inflight.has(key)) return m.inflight.get(key);
    const hit = m.results.get(key);
    const recent = m.last !== undefined && now() - m.last < minIntervalMs;
    if (hit && (now() - hit.at < cacheMs || recent)) return hit.value;
    if (recent) return empty();
    const p = call().then((value) => { m.results.set(key, { value, at: now() }); return value; }).finally(() => m.inflight.delete(key));
    m.inflight.set(key, p);
    return p;
  }

  const check = (id, name, from = 0) => {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) throw err('invalid_path', 'Machine id is not valid.');
    if (name !== undefined && !NAME.test(String(name))) throw err('invalid_path', `Not a readable file: ${name}`);
    if (!Number.isSafeInteger(from) || from < 0) throw err('invalid_path', 'fromByte must be a whole number from 0.');
  };
  const cachePath = (id, name) => join(cacheDir, id, name);
  const store = (id, name, from, data, next) => {
    try {
      const f = cachePath(id, name);
      if (from > 0 && (written.get(f) ?? 0) >= next) return; // this part is already stored
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      (from === 0 ? writeFileSync : appendFileSync)(f, data, { mode: 0o600 });
      written.set(f, next);
    } catch { /* the cache is best effort */ }
  };

  return {
    async readTail(machineId, name, fromByte = 0) {
      check(machineId, name, fromByte);
      await checkListed(machineId);
      const key = `${name}@${fromByte}`;
      const known = state(machineId).results.get(`size:${name}`)?.value;
      return limited(machineId, key, () => ({ data: '', from: fromByte, next: fromByte, size: known ?? fromByte, fetchedAt: now(), source: 'cache' }), async () => {
        const f = `"$HOME/.config/cloudy-cloud/${name}"`;
        const { stdout } = await exec(machineId, `sz=$(wc -c < ${f}); tail -c +${fromByte + 1} ${f} | head -c ${CHUNK}; echo; echo "SIZE $sz"`);
        const i = stdout.lastIndexOf('\nSIZE ');
        const size = Number.parseInt(stdout.slice(i + 6), 10) || 0;
        let raw = i < 0 ? '' : stdout.slice(0, i); // the echo before SIZE is not part of the file
        if (Buffer.byteLength(raw) >= CHUNK || fromByte + Buffer.byteLength(raw) < size) { const nl = raw.lastIndexOf('\n'); if (nl >= 0) raw = raw.slice(0, nl + 1); } // never cut a line in half
        const next = fromByte + Buffer.byteLength(raw);
        const data = clean(raw);
        state(machineId).results.set(`size:${name}`, { value: size, at: now() });
        store(machineId, name, fromByte, data, next);
        return { data, from: fromByte, next, size, fetchedAt: now() };
      });
    },
    async capturePane(machineId) {
      check(machineId);
      await checkListed(machineId);
      return limited(machineId, 'pane', () => ({ lines: [], fetchedAt: now() }), async () => {
        const { stdout } = await exec(machineId, PANE_CMD);
        return { lines: scrub(redactText(stdout)).replace(/\n$/, '').split('\n'), fetchedAt: now() };
      });
    },
    // What this laptop already stored for a file, even after the machine is gone. null when nothing is stored.
    async readCached(machineId, name) {
      check(machineId, name);
      try {
        const f = cachePath(machineId, name);
        return { data: readFileSync(f, 'utf8'), source: 'cache', fetchedAt: statSync(f).mtimeMs };
      } catch { return null; }
    },
  };
}
