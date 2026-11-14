// Read-only, rate-limited reader for what a cloudy-cloud machine keeps: stream files, meta.json, a coordinator's
// events.jsonl, and its live tmux pane. Uses only the provider contract (connect, commands.run) and runs two fixed
// commands: a tail of one whitelisted file, and `tmux capture-pane`. Nothing is written on a machine; no key is sent.
// Every string returned or cached is redacted, with the env's key values removed too. Errors carry a `code`:
// invalid_path | not_listed | not_found (machine gone) | transient. Budget limits never throw: they return the cache.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactText } from './events.mjs';
import { secretValues } from './run-subagent.mjs';
import { pruneStreams, redactLine } from './stream.mjs';

const CHUNK = 262_144;
const LIST_MS = 10_000;
const RUN_MS = 30_000;
const TRUNCATED = '{"type":"cloudy-cloud","note":"truncated"}\n';
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const NAME = /^(?:stream\/t\d{1,4}\.jsonl|stream\/meta\.json|events\.jsonl|streams\/[0-9a-f]{8}\/t\d{1,4}\.jsonl)$/;
const PANE_CMD = "tmux capture-pane -p -J -t claude -S -200 2>&1 || echo 'no tmux session named claude'";
const err = (code, message) => Object.assign(new Error(message), { code });

export function createMachineReader(provider, env, { now = Date.now, maxConcurrent = 4, minIntervalMs = 3000, cacheMs = 2500, cacheDir = join(homedir(), '.config/cloudy-cloud/streams/remote'), cacheCap = 20 * 1024 * 1024, literals = [] } = {}) {
  // `literals` (consented MCP token values) is read at each call, so values added later are covered.
  const scrub = (s) => secretValues(env ?? {}, provider.keyName, [...literals]).reduce((t, v) => t.split(v).join('[redacted]'), s);
  const clean = (text) => text.split('\n').map((l) => (l ? redactLine(l, scrub) : l)).join('\n');
  const machines = new Map(); // id -> { sbx (connect promise), last (time of the last command), inflight: Map, results: Map }
  const written = new Map(); // cache file -> raw offset its content ends at
  const skipping = new Set(); // machine/name pairs inside an oversize line being skipped
  let pruned = false;
  let listed, listing, active = 0;
  const waiting = [];

  const state = (id) => { let m = machines.get(id); if (!m) machines.set(id, m = { inflight: new Map(), results: new Map(), sizes: new Map() }); return m; };
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

  // Budget. Calls to one machine run one after another; each rechecks the interval after its turn, so concurrent
  // requests cannot skip it. Inside the interval a call returns the cached result (or `empty()`). Old results are dropped.
  async function limited(id, key, empty, call) {
    const m = state(id);
    if (m.inflight.has(key)) return m.inflight.get(key);
    for (const [k, r] of m.results) if (now() - r.at > Math.max(cacheMs, minIntervalMs)) m.results.delete(k);
    const p = (m.chain ?? Promise.resolve()).then(async () => {
      const hit = m.results.get(key), recent = m.last !== undefined && now() - m.last < minIntervalMs;
      if (hit && (now() - hit.at < cacheMs || recent)) return hit.value;
      if (recent) return empty();
      const value = await call();
      m.results.set(key, { value, at: now() });
      return value;
    }).finally(() => m.inflight.delete(key));
    m.chain = p.catch(() => {});
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
      if (!pruned) { pruned = true; pruneStreams(cacheDir); }
      if (from > 0) {
        let size = 0;
        try { size = statSync(f).size; } catch { /* new file */ }
        if (size + Buffer.byteLength(data) > cacheCap) return; // the cache stops growing; the machine still has the data
        appendFileSync(f, data, { mode: 0o600 });
      } else writeFileSync(f, Buffer.byteLength(data) > cacheCap ? TRUNCATED : data, { mode: 0o600 });
      written.set(f, next);
    } catch { /* the cache is best effort */ }
  };

  return {
    async readTail(machineId, name, fromByte = 0) {
      check(machineId, name, fromByte);
      await checkListed(machineId);
      const key = `${name}@${fromByte}`;
      const m = state(machineId), skipKey = `${machineId}/${name}`;
      return limited(machineId, key, () => ({ data: '', from: fromByte, next: fromByte, size: m.sizes.get(name) ?? fromByte, fetchedAt: now(), source: 'cache' }), async () => {
        const f = `"$HOME/.config/cloudy-cloud/${name}"`;
        const { stdout } = await exec(machineId, `sz=$(wc -c < ${f}); tail -c +${fromByte + 1} ${f} | head -c ${CHUNK}; echo; echo "SIZE $sz"`);
        const i = stdout.lastIndexOf('\nSIZE ');
        const size = Number.parseInt(stdout.slice(i + 6), 10) || 0;
        let raw = i < 0 ? '' : stdout.slice(0, i); // the echo before SIZE is not part of the file
        m.sizes.set(name, size);
        let off = fromByte, marker = '';
        if (skipping.has(skipKey)) { // inside an oversize line: drop up to its end
          const nl = raw.indexOf('\n');
          if (nl < 0) { off += Buffer.byteLength(raw); raw = ''; } else { off += Buffer.byteLength(raw.slice(0, nl + 1)); raw = raw.slice(nl + 1); skipping.delete(skipKey); }
        }
        const nl = raw.lastIndexOf('\n');
        if (nl >= 0) raw = raw.slice(0, nl + 1);
        else if (Buffer.byteLength(raw) >= CHUNK) { skipping.add(skipKey); marker = TRUNCATED; off += Buffer.byteLength(raw); raw = ''; } // one line longer than a chunk: no fragments
        else if (skipping.has(skipKey)) raw = '';
        else raw = ''; // an unfinished last line waits for its newline
        const next = off + Buffer.byteLength(raw);
        const data = marker + clean(raw);
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
    // What this laptop already stored for a file, even after the machine is gone: the last `maxBytes` (from a line start).
    async readCached(machineId, name, { maxBytes = 1024 * 1024 } = {}) {
      check(machineId, name);
      let fd;
      try {
        const f = cachePath(machineId, name);
        fd = openSync(f, 'r');
        const st = statSync(f), start = Math.max(0, st.size - maxBytes), buf = Buffer.alloc(st.size - start);
        readSync(fd, buf, 0, buf.length, start);
        let data = buf.toString('utf8');
        if (start > 0) { const nl = data.indexOf('\n'); data = nl < 0 ? '' : data.slice(nl + 1); }
        return { data, source: 'cache', fetchedAt: st.mtimeMs };
      } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
    },
  };
}
