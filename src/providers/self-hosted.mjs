// Self-hosted provider: one Docker (or Podman) container per sandbox on a machine you own, driven over SSH (see ssh.mjs).
// macOS hosts: non-interactive SSH has no /opt/homebrew/bin on PATH, so set CLOUDY_CLOUD_CONTAINER_BIN to the absolute path of
// the docker binary (setup discovers it). Nothing here needs GNU tools on the host: `timeout`, `base64` and `sh` run in the
// container, and only `printf`/`base64` (both in macOS /usr/bin) run on the host through ssh.mjs.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createSsh } from './ssh.mjs';

const PREFIX = 'cloudy-cloud.';
const HOME = '/home/worker';
const SECRETS = '/run/secrets/env';
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const GONE = /No such (container|object)/i;
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProvider(env = process.env, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const runtime = env.CLOUDY_CLOUD_CONTAINER_RUNTIME || 'docker';
  if (runtime !== 'docker' && runtime !== 'podman') throw new Error(`CLOUDY_CLOUD_CONTAINER_RUNTIME must be docker or podman, not "${runtime}"`);
  const bin = env.CLOUDY_CLOUD_CONTAINER_BIN || runtime;
  const host = env.CLOUDY_CLOUD_SSH_HOST;
  const slots = Number(env.CLOUDY_CLOUD_SELF_HOSTED_SLOTS) || 2;
  const cpus = env.CLOUDY_CLOUD_SELF_HOSTED_CPUS || '2';
  const memory = env.CLOUDY_CLOUD_SELF_HOSTED_MEMORY || '4g';
  const image = `cloudy-cloud-worker:${VERSION}`;
  const consented = env.CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX === 'yes';
  const maxTtlSeconds = 86400;

  let ssh;
  const getSsh = () => (ssh ??= deps.ssh ?? createSsh(env, { spawn }));

  // Run `<bin> ...args` on the host. Docker daemon errors become `transient` with a doctor hint.
  async function docker(args, opts = {}) {
    try { return await getSsh().run([q(bin), ...args.map(q)].join(' '), opts); } catch (e) {
      if (/Cannot connect to the (Docker|Podman) daemon|connect to podman/i.test(`${e.stderr ?? ''}${e.message}`))
        throw fail('transient', `${runtime} is not running on ${host}. Check it with: cloudy-cloud doctor`);
      throw e;
    }
  }

  function sandbox(id, name = id) {
    const exec = (inner, opts, flags = ['-i']) => docker(['exec', ...flags, id, 'sh', '-c', inner], opts);
    return {
      id, name, home: HOME,
      files: {
        async write(path, data) {
          const dir = String(path).replace(/\/[^/]*$/, '') || '/';
          await exec(`mkdir -p ${q(dir)} && cat > ${q(path)}`, { stdin: typeof data === 'string' ? data : Buffer.from(data) }, ['-i', '-w', HOME]);
          return true;
        },
        async read(path) { // base64 keeps binary safe through ssh.mjs's utf8 stdout
          const r = await exec(`base64 < ${q(path)}`, {}, ['-i', '-w', HOME]);
          return Buffer.from(r.stdout.replace(/\s/g, ''), 'base64');
        },
      },
      commands: {
        async run(cmd, { cwd, timeoutMs, signal, onStdout } = {}) {
          const marker = randomBytes(8).toString('hex');
          const secs = timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0;
          const inner = `set -a; [ ! -f ${SECRETS} ] || . ${SECRETS}; set +a; CC_RUN=${marker} exec ${secs ? `timeout -k 5 ${secs} ` : ''}sh -c ${q(cmd)}`;
          try {
            return await exec(inner, { signal, onStdout }, ['-i', '-w', cwd || HOME]);
          } catch (e) {
            if (e?.name === 'AbortError') { // ssh only dropped the connection: end the process inside the container
              const scan = `for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -qx CC_RUN=${marker} && kill -TERM \${p#/proc/}; done; true`;
              await exec(scan).catch(() => {});
            } else if (e?.exitCode === 124 && secs) throw fail('timeout', `timed out after ${secs} s`, { exitCode: 124, stdout: e.stdout, stderr: e.stderr });
            throw e;
          }
        },
      },
      kill: () => api.delete(id),
    };
  }

  const writeEnv = (sb, vars) => sb.files.write(SECRETS, Object.entries(vars).map(([k, v]) => `${k}=${q(v)}\n`).join(''));

  const api = {
    name: 'self-hosted',
    keyName: 'CLOUDY_CLOUD_SSH_HOST',
    caps: {
      hasServerTTL: true, hasProxySecrets: false, hasConsentedSecrets: consented, hasSnapshots: false, hasPortForward: true,
      hasPublish: false, maxForegroundMs: Infinity, maxTtlSeconds, startsPerMin: 60, maxConcurrentCalls: 8, uploadMaxBytes: 200 * 1024 * 1024,
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [] }) {
      getSsh();
      const vars = { ...envs };
      // The user allowed the GitHub token on this machine (setup): deliver it like Instabox attaches its GH_TOKEN secret.
      // It goes only into the tmpfs env file through stdin, never argv, labels or `docker inspect`.
      for (const n of consented ? ['GH_TOKEN', ...secrets] : secrets) {
        if (!consented || env[n] === undefined) throw fail('no_key', `The secret ${n} cannot be put on ${host}. ${api.text.githubTokenHelp}`);
        vars[n] = env[n];
      }
      for (const n of Object.keys(vars)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid environment variable name "${n}"`);
      const running = (await docker(['ps', '--filter', `label=${PREFIX}purpose`, '--format', '{{.ID}}'])).stdout.split('\n').filter(Boolean).length;
      if (running >= slots) throw fail('quota_exceeded', `All ${slots} self-hosted slots on ${host} are in use. Stop an agent or raise CLOUDY_CLOUD_SELF_HOSTED_SLOTS.`);
      const have = await docker(['image', 'inspect', '--format', '{{index .Config.Labels "cloudy-cloud.image"}}', image])
        .then((r) => r.stdout.trim(), (e) => { if (e.exitCode !== undefined) return 'missing'; throw e; });
      if (have !== VERSION) throw new Error(`The worker image on ${host} is version ${have} but cloudy-cloud is ${VERSION}. Run: cloudy-cloud setup`);

      const id = `cc-${randomBytes(6).toString('hex')}`;
      const ttl = Math.min(Math.max(1, ttlSeconds || maxTtlSeconds), maxTtlSeconds);
      const now = Date.now();
      const all = { ...labels, ...(name && { name }), deleteAt: new Date(now + ttl * 1000).toISOString(), startedAt: new Date(now).toISOString() };
      const label = Object.entries(all).flatMap(([k, v]) => {
        if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`invalid label name "${k}"`);
        return ['--label', `${PREFIX}${k}=${v}`];
      });
      await docker(['run', '-d', '--rm', '--name', id, '--hostname', id, ...label, '--cpus', cpus, '--memory', memory, '--pids-limit', '2048',
        '--tmpfs', '/run/secrets:mode=700,uid=1000,gid=1000', '--user', 'worker', image, 'timeout', `${ttl}s`, 'sleep', 'infinity']);
      const sb = sandbox(id, name ?? id);
      try {
        await writeEnv(sb, vars);
        await sb.commands.run(`chmod 600 ${SECRETS}`);
      } catch (e) { await api.delete(id).catch(() => {}); throw e; }
      return sb;
    },

    async connect(id) {
      await docker(['inspect', '--format', '{{.Name}}', id]).catch((e) => {
        throw GONE.test(`${e.stderr ?? ''}${e.message}`) ? fail('not_found', `No self-hosted machine ${id}`) : e;
      });
      return sandbox(id);
    },

    async list(labels = {}) {
      const ids = (await docker(['ps', '-a', '--filter', `label=${PREFIX}purpose`, '--format', '{{.ID}}'])).stdout.split('\n').filter(Boolean);
      if (!ids.length) return [];
      const rows = JSON.parse((await docker(['inspect', ...ids])).stdout).map((c) => {
        const l = Object.fromEntries(Object.entries(c.Config?.Labels ?? {}).filter(([k]) => k.startsWith(PREFIX)).map(([k, v]) => [k.slice(PREFIX.length), v]));
        const state = c.State?.Status ?? '';
        const id = String(c.Name).replace(/^\//, '');
        return {
          id, name: l.name ?? id, labels: l, state,
          status: state === 'running' ? 'running' : state === 'created' ? 'starting' : ['exited', 'dead', 'removing'].includes(state) ? 'stopped' : 'failed',
          startedAt: Date.parse(l.startedAt) || Date.parse(c.State?.StartedAt) || 0, deleteAt: l.deleteAt,
        };
      });
      return rows.filter((r) => Object.entries(labels).every(([k, v]) => r.labels[k] === v));
    },

    async delete(id, { retries = 2, log } = {}) {
      for (let attempt = 0; ; attempt++) {
        try { await docker(['rm', '-f', id]); return; } catch (e) {
          if (GONE.test(`${e.stderr ?? ''}${e.message}`)) return;
          if (attempt >= retries) throw e;
          log?.(`delete ${id} failed (${e.message}); retrying`);
          await sleep(500 * (attempt + 1));
        }
      }
    },

    async snapshot() { throw fail('not_found', 'The self-hosted provider has no snapshots yet'); },
    async getSnapshot() { throw fail('not_found', 'The self-hosted provider has no snapshots yet'); },

    // Each local connection runs a tiny node TCP bridge inside the container over ssh stdio. Unlike `ssh -L` to the
    // container IP, this works with Docker Desktop on a Mac, whose container network is not routable from the host.
    // ponytail: one ssh session per connection on the shared master (MaxSessions 10); fine for a browser on a dev server.
    async forwardPort(id, localRemote, { signal } = {}) {
      const [local, remote = local] = String(localRemote).split(':');
      if (!/^\d+$/.test(local) || !/^\d+$/.test(remote)) throw new Error(`port must be a number or local:remote, not "${localRemote}"`);
      await api.connect(id);
      const bridge = `const s=require('net').connect(${remote},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout);s.on('error',(e)=>{console.error(e.message);process.exit(1)})`;
      const argv = getSsh().argvFor([bin, 'exec', '-i', id, 'node', '-e', bridge].map(q).join(' '));
      return new Promise((resolve, reject) => {
        const server = createServer({ allowHalfOpen: true }, (sock) => { // a client may send its request, then half-close
          const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'ignore'] });
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
        server.listen(Number(local), '127.0.0.1');
        signal?.addEventListener('abort', () => server.close(() => resolve(0)), { once: true });
      });
    },
    async publishPort() { throw new Error('self-hosted does not publish links'); },
    async unpublishPort() { return 1; },

    localMachineName: (hostname) => (hostname.startsWith('cc-') ? hostname : ''),

    text: {
      ssh: (machine, cmd) => `ssh${sshOpts().map((o) => ` ${o}`).join('')} -t ${host ?? '<CLOUDY_CLOUD_SSH_HOST>'} ${bin} exec -it ${machine} ${cmd || 'bash'}`,
      listMachines: `ssh${sshOpts().map((o) => ` ${o}`).join('')} ${host ?? '<CLOUDY_CLOUD_SSH_HOST>'} ${bin} ps --filter label=${PREFIX}purpose`,
      noKeyFix: 'Set CLOUDY_CLOUD_SSH_HOST=user@host in ~/.config/cloudy-cloud/env or run: cloudy-cloud setup',
      apiFix: `Check that ${host ?? 'the host'} is reachable: cloudy-cloud doctor`,
      hostLabel: String(host ?? '').split('@').pop(), // the full user@host is the key value, which the core scrubs
      githubTokenHelp: 'Allow the GitHub token on your machine and save one with write access: run cloudy-cloud setup --provider self-hosted and answer yes to the GitHub token question.',
    },
  };
  function sshOpts() {
    return [...(env.CLOUDY_CLOUD_SSH_KEY ? ['-i', env.CLOUDY_CLOUD_SSH_KEY] : []), ...(env.CLOUDY_CLOUD_SSH_PORT ? ['-p', env.CLOUDY_CLOUD_SSH_PORT] : [])];
  }
  return api;
}
