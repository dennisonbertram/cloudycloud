// microsandbox provider: one local microVM per sandbox on this computer, driven by the `msb` CLI
// (https://microsandbox.dev, Apache-2.0; needs Apple Silicon Mac or Linux with KVM). No ssh, no Docker daemon:
// `msb exec` reaches the guest directly. Secrets stay on this computer: `--secret NAME@hosts` puts a placeholder
// in the guest and msb substitutes the real value — read from the create child's environment — only in requests
// to the named hosts. Values never appear in argv, labels, `-e`, errors or logs: bare `-e NAME` also reads the
// child env (ui::parse_env), so every env value rides in the create child's environment too.
// Every msb child gets a pinned minimal env: MSB_BACKEND=local always selects the local backend (it wins the
// selection ladder unconditionally — config/backend.rs select()), ahead of any saved cloud profile or exported
// MSB_API_KEY; everything else is an allowlist, so a token exported in the parent cannot reach ls/exec/rm.
// Flag syntax from microsandbox source @ 28bdced5 (crates/cli): `msb create <image> --name n -c 2 -m 4G -e NAME
// --label K=V --secret 'NAME:headers=[a,b]@h1,h2' --net-default deny --net-rule allow@dns --net-rule allow@h
// --tls-intercept --max-duration 3600s`; `msb ls --format json --label K=V` (repeatable, AND-matched) returns
// {name,status,created_at,image} rows WITHOUT labels (`msb inspect <n> --format json` carries them in config);
// `msb exec` exits with the guest's exit code.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { createLimiter } from '../limits.mjs';
import { SECRET_HOSTS } from '../errors.mjs';

const PREFIX = 'cloudy-cloud.';
const HOME = '/home/worker';
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const IMAGE = `cloudy-cloud-worker:${VERSION}`;
const DOCKERFILE = fileURLToPath(new URL('../../docker/worker.Dockerfile', import.meta.url));
const GONE = /not found|no such|does not exist|unknown (sandbox|image)/i; // unverified: msb's exact "gone" text
const ALIVE = new Set(['Running', 'Starting', 'Created', 'Paused', 'Draining']); // msb ls statuses still holding a slot
// Egress targets are hostnames (or *.suffix). Upstream parses a bare IPv4 as a /32 rule that bypasses the
// hostname authority check, so literals and malformed DNS labels are rejected here.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/; // 1-63 chars, no leading/trailing hyphen
const egressOk = (h) => {
  const bare = h.startsWith('*.') ? h.slice(2) : h;
  const parts = bare.split('.');
  return !IPV4.test(bare) && !bare.includes(':') && bare.length <= 253 && parts.length > 1 && parts.every((l) => DNS_LABEL.test(l));
};
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote, for commands inside the guest

// Where the msb CLI lives: CLOUDY_CLOUD_MSB_BIN, else the installer's default ~/.local/bin/msb, else msb on
// PATH (the same ladder install.sh --check-only and the launcher use). '' means nothing was found.
const canExec = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
export function resolveMsbBin(env = process.env) {
  if (env.CLOUDY_CLOUD_MSB_BIN) return env.CLOUDY_CLOUD_MSB_BIN;
  const home = env.HOME || homedir();
  if (home && canExec(join(home, '.local/bin/msb'))) return join(home, '.local/bin/msb');
  for (const dir of String(env.PATH ?? process.env.PATH ?? '').split(delimiter)) {
    const p = dir && join(dir, 'msb');
    if (p && canExec(p)) return p;
  }
  return '';
}

export function createProvider(env = process.env, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const bin = resolveMsbBin(env); // '' when microsandbox is not installed anywhere
  const slots = Number(env.CLOUDY_CLOUD_MSB_SLOTS) || 2;
  const maxTtlSeconds = 86400;
  const limiter = createLimiter(8);
  const now = deps.now ?? (() => Date.now()); // test seam: a fake clock
  const hosts = { ...SECRET_HOSTS, OPENAI_API_KEY: 'api.openai.com', GH_TOKEN: 'github.com,api.github.com', ...(deps.secretHosts ?? {}) };
  const hostsFor = (n) => (Array.isArray(hosts[n]) ? hosts[n] : String(hosts[n] ?? '').split(',').map((h) => h.trim()).filter(Boolean));

  // The only environment any msb child sees: names a CLI needs plus any MSB_* config — never process.env
  // wholesale, so an exported token cannot leak into ls/exec/rm. MSB_BACKEND=local pins the local backend.
  // MSB_API_KEY is the cloud credential: pinning local makes it unused, so it is left out of every child.
  // TERM is kept for the interactive `msb exec -t` shell.
  const CHILD_ENV = /^(PATH|HOME|USER|TERM|TMPDIR|LANG|LC_[A-Z_]+|MSB_[A-Z0-9_]+)$/;
  const envAllowed = (k) => CHILD_ENV.test(k) && k !== 'MSB_BACKEND' && k !== 'MSB_API_KEY';
  const childEnv = (extra = {}) => {
    const e = {};
    for (const [k, v] of Object.entries(process.env)) if (envAllowed(k)) e[k] = v;
    return { ...e, ...extra, MSB_BACKEND: 'local' };
  };
  const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

  // One `msb` call: argv only (never a shell). opts.env holds *extra* child env vars — how secret and env
  // values reach `msb create` without appearing in argv.
  const once = (args, { stdin, onStdout, signal, env: extra, onSpawn } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    let child;
    try { child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(extra) }); }
    catch (e) { return reject(fail('transient', `cannot start ${bin}: ${e.message}`)); }
    onSpawn?.();
    let stdout = '', stderr = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => { child.kill(); finish(reject, aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', (d) => { d = String(d); stdout += d; try { onStdout?.(d); } catch { /* a bad callback must not kill the call */ } });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, e?.code === 'ENOENT' ? fail('no_key', api.text.noKeyFix) : fail('transient', `cannot start ${bin}: ${e.message}`)));
    child.on('close', (code) => {
      if (code === null) return finish(reject, fail('transient', `${bin} was killed`));
      if (code !== 0) return finish(reject, Object.assign(new Error(stderr.trim().slice(-300) || `exit ${code}`), { exitCode: code, stdout, stderr }));
      finish(resolve, { stdout, stderr, exitCode: 0 });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
  // Queue through the limiter; an abort while still queued rejects immediately, and a grant that lands after
  // the abort becomes a no-op that releases the slot without spawning.
  const msb = (args, opts) => {
    if (!bin) return Promise.reject(fail('no_key', api.text.noKeyFix));
    const signal = opts?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted());
      const bail = () => reject(aborted());
      signal?.addEventListener('abort', bail, { once: true });
      limiter.run(() => {
        signal?.removeEventListener('abort', bail);
        return signal?.aborted ? Promise.reject(aborted()) : once(args, opts);
      }).then(resolve, reject);
    });
  };

  // `msb ls` carries no labels, so each matching row is inspected for its config.labels. The ownership and
  // selector filters go to `msb ls` (repeatable AND-matched --label); a malformed or failed listing propagates
  // rather than looking like an empty inventory, and only a confirmed concurrent deletion drops a row.
  const lsRows = async (sel = {}) => {
    // ownership filter uses the full purpose value: a bare --label KEY parses to (KEY,'') upstream, which only
    // matches empty-valued labels — every cloudy-cloud sandbox carries purpose=cloudy-cloud
    const args = ['ls', '--format', 'json', '--label', `${PREFIX}purpose=cloudy-cloud`];
    for (const [k, v] of Object.entries(sel)) args.push('--label', `${PREFIX}${k}=${v}`);
    const out = (await msb(args)).stdout;
    try { const j = JSON.parse(out.trim() || '[]'); return Array.isArray(j) ? j : []; }
    catch (e) { throw fail('transient', `msb ls returned invalid JSON: ${e.message}`); }
  };
  const labelsOf = (j) => {
    let l = j?.config?.labels ?? j?.config?.spec?.labels ?? j?.labels ?? {};
    if (Array.isArray(l)) l = Object.fromEntries(l.map((e) => {
      if (typeof e === 'string') { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }
      return [e.key ?? e.name, e.value ?? ''];
    }));
    return l ?? {};
  };
  const rows = async (sel) => Promise.all((await lsRows(sel)).map(async (r) => {
    const x = await msb(['inspect', r.name, '--format', 'json']).catch((e) => {
      if (GONE.test(`${e.stderr ?? ''}${e.message}`)) return null; // deleted between ls and inspect
      throw e;
    });
    if (x === null) return null;
    let j; try { j = JSON.parse(x.stdout); } catch (e) { throw fail('transient', `msb inspect ${r.name} returned invalid JSON: ${e.message}`); }
    const l = Object.fromEntries(Object.entries(labelsOf(j)).filter(([k]) => k.startsWith(PREFIX)).map(([k, v]) => [k.slice(PREFIX.length), v]));
    const state = String(j.status ?? r.status ?? '');
    const status = state === 'Running' ? 'running' : ['Starting', 'Created'].includes(state) ? 'starting'
      : ['Stopped', 'Paused', 'Draining'].includes(state) ? 'stopped' : state === 'Crashed' ? 'failed' : state.toLowerCase() || 'stopped';
    return { id: r.name, name: l.name ?? r.name, machineName: r.name, labels: l, state, status, startedAt: Date.parse(l.startedAt) || Date.parse(r.created_at) || 0, deleteAt: l.deleteAt };
  })).then((a) => a.filter(Boolean));
  const aliveCount = async () => (await lsRows()).filter((r) => ALIVE.has(String(r.status))).length; // counted from ls status rows: no inspects
  const expired = (deleteAt) => deleteAt && Date.parse(deleteAt) <= now();

  const missingImage = () => new Error(`The microsandbox worker image ${IMAGE} is missing. Build and load it (needs Docker running):\n  docker build --build-arg VERSION=${VERSION} -t ${IMAGE} - < ${DOCKERFILE}\n  docker save ${IMAGE} | ${bin} load\nThen call cloud_agent again.`);
  const slotsFull = () => fail('quota_exceeded', `All ${slots} microsandbox slots on this computer are in use.\nNext step: stop an agent with cloud_agent_stop, or raise the limit: add CLOUDY_CLOUD_MSB_SLOTS=<a number over ${slots}> to ~/.config/cloudy-cloud/env.`);

  function sandbox(id, name = id, deleteAt) {
    const exec = (flags, cmd, opts) => msb(['exec', ...flags, id, '--', ...cmd], opts);
    // Past its advertised deadline the sandbox must not serve again — `msb exec` can restart a stopped VM —
    // so every handle operation removes it first and reports not_found.
    const guard = async () => { if (expired(deleteAt)) { await api.delete(id).catch(() => {}); throw fail('not_found', `the microsandbox machine ${id} passed its deleteAt and was removed`); } };
    return {
      id, name, home: HOME,
      files: {
        // stdin is piped through `msb exec` to cat: binary-safe, runs as the image user.
        async write(path, data) {
          await guard();
          const dir = posix.dirname(String(path));
          await exec(['--no-tty'], ['sh', '-c', `mkdir -p -- ${q(dir)} && cat > ${q(path)}`], { stdin: typeof data === 'string' ? data : Buffer.from(data) });
          return true;
        },
        async read(path) { // base64 keeps binary safe through the utf8 stdout pipe
          await guard();
          const r = await exec(['--no-stdin'], ['sh', '-c', `base64 < ${q(path)}`]);
          return Buffer.from(r.stdout.replace(/\s/g, ''), 'base64');
        },
      },
      commands: {
        async run(cmd, { cwd, timeoutMs, signal, onStdout } = {}) {
          await guard();
          const marker = randomBytes(8).toString('hex');
          const secs = timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0;
          // the guest image has coreutils `timeout`; CC_RUN marks the process tree for the abort scan below
          const inner = `CC_RUN=${marker} exec ${secs ? `timeout -k 5 ${secs} ` : ''}sh -c ${q(cmd)}`;
          let spawned = false; // a queued call that never reached msb has nothing to clean up
          try {
            return await exec(['--no-stdin', ...(onStdout ? ['--stream'] : []), '-w', cwd || HOME], ['sh', '-c', inner], { signal, onStdout, onSpawn: () => { spawned = true; } });
          } catch (e) {
            if (e?.name === 'AbortError') { // the local msb died; end the command inside the guest (same marker scan as self-hosted)
              if (spawned) {
                const scan = `for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -qx CC_RUN=${marker} && kill -TERM \${p#/proc/}; done; true`;
                await exec(['--no-stdin'], ['sh', '-c', scan]).catch(() => {});
              }
            } else if (e?.exitCode === 124 && secs) throw fail('timeout', `timed out after ${secs} s`, { exitCode: 124, stdout: e.stdout, stderr: e.stderr });
            throw e;
          }
        },
      },
      kill: () => api.delete(id),
      loadName: async () => id,
    };
  }

  const api = {
    name: 'microsandbox',
    keyName: 'CLOUDY_CLOUD_MSB_BIN',
    caps: {
      // --max-duration stops the sandbox at the deadline but it stays in `msb ls` (Stopped): removal is ours
      // (deleteAt guards below), not trusted to the server, so hasServerTTL is false.
      // localSecrets: a plain credential value in the local env is attached by name automatically — msb
      // substitutes it into matching requests on this computer, so CLOUDY_CLOUD_PROXY_SECRETS is not needed.
      hasServerTTL: false, hasProxySecrets: true, localSecrets: true, hasEgressPolicy: true, hasSnapshots: false, hasPortForward: true,
      hasPublish: false, hasSizes: false, hasShell: true, hasDisplay: false, hasMetrics: false,
      maxForegroundMs: Infinity, maxTtlSeconds, startsPerMin: 60, maxConcurrentCalls: 8, uploadMaxBytes: 200 * 1024 * 1024,
      machineKinds: ['linux'],
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [], image: _ignored, role = labels.role, kind, egress }) {
      if (kind && kind.name !== 'linux') throw fail('machine_kind_unsupported', `microsandbox runs only linux machines, not ${kind.name}. Use machine "linux", or set CLOUDY_CLOUD_PROVIDER=instabox.`);
      if (role === 'coordinator') throw new Error(api.text.coordinatorRefusal);
      if (!bin) throw fail('no_key', api.text.noKeyFix);
      const want = [...new Set(['GH_TOKEN', ...secrets])]; // GH_TOKEN always goes in, like the other providers
      for (const n of Object.keys(envs)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid environment variable name "${n}"`);
        if (want.includes(n)) throw new Error(`the env ${n} is also attached as a secret on the microsandbox provider`);
      }
      const ttl = Math.min(Math.max(1, ttlSeconds || maxTtlSeconds), maxTtlSeconds);
      const t0 = now();
      const all = { ...labels, ...(role && { role }), ...(name && !labels.name && { name }), deleteAt: new Date(t0 + ttl * 1000).toISOString(), startedAt: new Date(t0).toISOString() };
      const label = Object.entries(all).flatMap(([k, v]) => {
        if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`invalid label name "${k}"`);
        return ['--label', `${PREFIX}${k}=${v}`];
      });
      const senv = {}, sargs = [];
      for (const n of want) {
        const hl = hostsFor(n);
        if (!hl.length) throw fail('no_key', n.startsWith('MCP_')
          ? `The secret ${n} has no known host, so microsandbox cannot attach it. MCP server tokens are not supported on the microsandbox provider yet. Next step: remove that server with cloudy-cloud mcp rm ${n.toLowerCase().replace(/_token$/, '')}, or set CLOUDY_CLOUD_PROVIDER=instabox.`
          : `The secret ${n} has no known host, so microsandbox cannot attach it. Next step: set CLOUDY_CLOUD_PROVIDER=instabox, or use a credential name microsandbox knows.`);
        if (env[n] === undefined) throw fail('no_key', `The secret ${n} has no value in ~/.config/cloudy-cloud/env. On the microsandbox provider the value stays on this computer and microsandbox puts it only into requests to ${hl.join(',')}. Next step: add ${n}=... to ~/.config/cloudy-cloud/env, then call cloud_agent again.`);
        senv[n] = env[n]; // secret values go into the create child's environment, nowhere else
        sargs.push('--secret', `${n}:headers=[authorization,x-api-key]@${hl.join(',')}`); // header-option syntax from the docs/source; unverified live
      }
      // values never touch argv: bare `-e NAME` makes msb read the create child's environment (ui::parse_env)
      const enva = Object.keys(envs).flatMap((k) => ['-e', k]);
      const cenv = { ...envs, ...senv };
      const net = [];
      if (egress?.allow) {
        for (const h of egress.allow) if (!egressOk(h)) throw new Error(`invalid egress host "${h}"`);
        // deny-all, then DNS plus each allowed host; --tls-intercept lets the host rules see HTTPS targets (docs example)
        net.push('--net-default', 'deny', ...['dns', ...egress.allow].flatMap((h) => ['--net-rule', `allow@${h}`]), '--tls-intercept');
      }
      await msb(['image', 'inspect', IMAGE]).catch((e) => {
        if (e.code === 'no_key') throw e;
        throw GONE.test(`${e.stderr ?? ''}${e.message}`) ? missingImage() : e; // keep the real cause: a backend error is not "missing image"
      });
      // ponytail: the count is read before create, so two creators can both pass; the post-create re-check below removes the loser.
      if (await aliveCount() >= slots) throw slotsFull();
      const id = `cc-${randomBytes(6).toString('hex')}`;
      // nothing an error echoes may contain a value the create child saw (spawn errors can quote env values)
      const scrub = (e) => {
        for (const f of ['message', 'stdout', 'stderr']) if (typeof e?.[f] === 'string')
          for (const v of Object.values(cenv)) if (typeof v === 'string' && v.length >= 4) e[f] = e[f].split(v).join('<redacted>');
        return e;
      };
      await msb(['create', IMAGE, '--name', id, '-c', '2', '-m', '4G', '--max-duration', `${ttl}s`, ...label, ...enva, ...sargs, ...net], { env: cenv })
        .catch(async (e) => { await api.delete(id).catch(() => {}); throw scrub(e); }); // a half-created VM must not leak
      if (await aliveCount() > slots) { // a parallel create may have won the last slot while ours spawned
        await api.delete(id).catch(() => {});
        throw slotsFull();
      }
      return sandbox(id, name ?? id, all.deleteAt);
    },

    async connect(id) {
      const j = await msb(['inspect', id, '--format', 'json']).then((x) => { try { return JSON.parse(x.stdout); } catch { return {}; } }, (e) => {
        throw GONE.test(`${e.stderr ?? ''}${e.message}`) ? fail('not_found', `No microsandbox machine ${id}`) : e;
      });
      const deleteAt = labelsOf(j)[`${PREFIX}deleteAt`];
      if (expired(deleteAt)) { await api.delete(id).catch(() => {}); throw fail('not_found', `the microsandbox machine ${id} passed its deleteAt and was removed`); }
      return sandbox(id, id, deleteAt);
    },

    async list(labels = {}) {
      const rs = await rows(labels);
      const dead = rs.filter((r) => expired(r.deleteAt));
      await Promise.all(dead.map((r) => api.delete(r.id).catch(() => {}))); // clear expired owned machines
      return rs.filter((r) => !dead.includes(r));
    },

    async delete(id, { retries = 2, log } = {}) {
      for (let attempt = 0; ; attempt++) {
        try { await msb(['rm', '--force', id]); return; } catch (e) {
          if (GONE.test(`${e.stderr ?? ''}${e.message}`)) return;
          if (attempt >= retries) throw e;
          log?.(`delete ${id} failed (${e.message}); retrying`);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    },

    async snapshot() { throw new Error('microsandbox does not support snapshots'); },
    async getSnapshot() { throw new Error('microsandbox does not support snapshots'); },

    // Each local connection runs a tiny node TCP bridge inside the guest over `msb exec --stream` stdio (same idea
    // as the self-hosted docker exec bridge; the microVM's network is not routable from the host).
    async forwardPort(id, localRemote, { signal } = {}) {
      const [lport, remote = lport] = String(localRemote).split(':');
      if (!/^\d+$/.test(lport) || !/^\d+$/.test(remote)) throw new Error(`port must be a number or local:remote, not "${localRemote}"`);
      if (!bin) throw fail('no_key', api.text.noKeyFix);
      if (signal?.aborted) return 0;
      try { // an abort before or during connect resolves the forward rather than hanging it
        await Promise.race([api.connect(id), new Promise((_, rej) => signal?.addEventListener('abort', () => rej(aborted()), { once: true }))]);
      } catch (e) { if (e?.name === 'AbortError') return 0; throw e; }
      const bridge = `const s=require('net').connect(${remote},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout);s.on('error',(e)=>{console.error(e.message);process.exit(1)})`;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return resolve(0); // connect won the race while the abort was already queued
        const socks = new Set(), kids = new Set();
        const server = createServer({ allowHalfOpen: true }, (sock) => { // a client may send its request, then half-close
          if (signal?.aborted) return sock.destroy(); // a connection racing the abort gets no bridge child
          socks.add(sock); sock.on('close', () => socks.delete(sock));
          const child = spawn(bin, ['exec', '--stream', id, '--', 'node', '-e', bridge], { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv() });
          kids.add(child); child.on('close', () => kids.delete(child));
          sock.pipe(child.stdin);
          child.stdout.pipe(sock);
          const end = () => { sock.destroy(); child.kill(); };
          sock.on('error', end);
          sock.on('close', end);
          child.stdin.on('error', end);
          child.on('error', end);
          child.on('close', () => sock.end());
        });
        server.on('error', reject);
        server.listen(Number(lport), '127.0.0.1');
        signal?.addEventListener('abort', () => { // tear down live connections so server.close cannot wait on them
          for (const s of socks) s.destroy();
          for (const k of kids) k.kill();
          server.close(() => resolve(0));
          setTimeout(() => resolve(0), 5000).unref?.(); // never hang the caller if a socket lingers
        }, { once: true });
      });
    },
    async publishPort() { throw new Error('microsandbox does not publish links'); },
    async unpublishPort() { return 1; },

    localMachineName: (hostname) => (hostname.startsWith('cc-') ? hostname : ''),

    // callers merge this over process.env, so undefined masks a name out of the child env: mask EVERY name the
    // allowlist would not pass plus every known secret name, so an arbitrary exported credential cannot reach
    // the msb shell either (MSB_BACKEND is then re-pinned local)
    shellEnv: () => ({
      ...Object.fromEntries(Object.keys(process.env).filter((k) => !envAllowed(k)).map((k) => [k, undefined])),
      ...Object.fromEntries([...Object.keys(hosts), 'MSB_API_KEY'].map((k) => [k, undefined])),
      MSB_BACKEND: 'local',
    }),
    // no command: a login shell on a TTY; a command runs without one unless { tty: true } (a sign-in needs it).
    shellArgv(id, cmd, { tty = false } = {}) {
      const run = !!cmd?.length;
      return [bin || 'msb', 'exec', run ? (tty ? '-t' : '--no-tty') : '-t', id, '--', 'bash', ...(run ? ['-lc', cmd.map(q).join(' ')] : ['-l'])];
    },
    async displayLink() { throw noDisplay(); },
    async revokeDisplayLinks() { throw noDisplay(); },
    async screenshot() { throw noDisplay(); },
    async plan() { return null; }, // no plan: the machine is this computer
    async metrics() { throw fail('metrics_unsupported', 'microsandbox machines have no usage numbers.', { provider: 'microsandbox' }); },

    text: {
      ssh: (machine, cmd) => `${bin || 'msb'} exec -t ${machine} -- ${cmd || 'bash -l'}`,
      listMachines: `${bin || 'msb'} ls --label ${PREFIX}purpose=cloudy-cloud`,
      noKeyFix: 'The microsandbox CLI (msb) was not found.\nInstall it (Apple Silicon Mac or Linux with KVM):\n  curl -fsSL https://install.microsandbox.dev | sh\nIf msb is installed somewhere unusual, add CLOUDY_CLOUD_MSB_BIN=<full path of msb> to ~/.config/cloudy-cloud/env.',
      apiFix: `Check that the microsandbox CLI works:\n  ${bin || 'msb'} --version`,
      githubTokenHelp: 'Add GH_TOKEN=<a token with write access> to ~/.config/cloudy-cloud/env; microsandbox keeps it on this computer and puts it only into requests to github.com.',
      hostLabel: 'this computer',
      coordinatorRefusal: 'Coordinators are not supported on the microsandbox provider yet. Start workers directly from your own session with cloud_agent, or set CLOUDY_CLOUD_PROVIDER=instabox for coordinators.',
    },
  };
  function noDisplay() { return fail('display_unsupported', 'microsandbox machines have no desktop display. Use `cloudy-cloud shell`, or set CLOUDY_CLOUD_PROVIDER=instabox.'); }
  return api;
}
