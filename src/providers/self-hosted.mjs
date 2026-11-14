// Self-hosted provider: one Docker (or Podman) container per sandbox on a machine you own, driven over SSH (see ssh.mjs).
// macOS hosts: non-interactive SSH has no /opt/homebrew/bin on PATH, so set CLOUDY_CLOUD_CONTAINER_BIN to the absolute path of
// the docker binary (setup discovers it). Nothing here needs GNU tools on the host: `timeout`, `base64` and `sh` run in the
// container, and only `printf`/`base64` (both in macOS /usr/bin) run on the host through ssh.mjs.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createSsh } from './ssh.mjs';
import { createLocal } from './local.mjs';
import { PROVIDER_KEY } from '../config.mjs';

const PREFIX = 'cloudy-cloud.';
const HOME = '/home/worker';
const SECRETS = '/run/secrets/env';
const COORD = 'cloudy-cloud-coordinator:'; // coordinator images made by snapshot(); a commit never includes the /run/secrets tmpfs
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const GONE = /No such (container|object|image)/i;
const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // POSIX single-quote
const SOCK_IN = '/var/run/docker.sock'; // where a coordinator container sees the box's Docker socket
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProvider(env = process.env, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const runtime = env.CLOUDY_CLOUD_CONTAINER_RUNTIME || 'docker';
  if (runtime !== 'docker' && runtime !== 'podman') throw new Error(`CLOUDY_CLOUD_CONTAINER_RUNTIME must be docker or podman, not "${runtime}"`);
  const bin = env.CLOUDY_CLOUD_CONTAINER_BIN || runtime;
  const host = env.CLOUDY_CLOUD_SSH_HOST;
  // Inside a coordinator container (setup consent, #41): docker runs locally against the mounted socket, with no ssh and no key.
  const local = env.CLOUDY_CLOUD_SELF_HOSTED_LOCAL === '1';
  const coordsOk = env.CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS === 'yes';
  const sock = env.CLOUDY_CLOUD_DOCKER_SOCKET || SOCK_IN; // the path on the box (inside the container VM on a Mac)
  const slots = Number(env.CLOUDY_CLOUD_SELF_HOSTED_SLOTS) || 2;
  const cpus = env.CLOUDY_CLOUD_SELF_HOSTED_CPUS || '2';
  const memory = env.CLOUDY_CLOUD_SELF_HOSTED_MEMORY || '4g';
  const image = `cloudy-cloud-worker:${VERSION}`;
  const consented = env.CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX === 'yes';
  const maxTtlSeconds = 86400;

  let ssh;
  let reserved = 0; // creates in this process that passed the slot check but whose container is not running yet
  const getSsh = () => (ssh ??= deps.ssh ?? (local ? createLocal({ spawn }) : createSsh(env, { spawn }))); // either transport: run(cmd, opts), close()

  // Run `<bin> ...args` on the host. Docker daemon errors become `transient` with a doctor hint.
  async function docker(args, opts = {}) {
    try { return await getSsh().run([q(bin), ...args.map(q)].join(' '), opts); } catch (e) {
      if (/Cannot connect to the (Docker|Podman) daemon|connect to podman/i.test(`${e.stderr ?? ''}${e.message}`))
        throw fail('transient', `${runtime} is not running on ${host ?? 'the box'}. Check it with: cloudy-cloud doctor`);
      if (local && e.exitCode === 127) throw new Error(`The docker CLI is missing in this coordinator's image. On your computer run: cloudy-cloud setup --provider self-hosted (it rebuilds the worker image), then cloudy-cloud coordinator image.`);
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
      loadName: async () => id, // the container name; `docker exec` and text.ssh need it, not the label name
    };
  }

  const writeEnv = (sb, vars) => sb.files.write(SECRETS, Object.entries(vars).map(([k, v]) => `${k}=${q(v)}\n`).join(''));

  const api = {
    name: 'self-hosted',
    keyName: local ? 'CLOUDY_CLOUD_DOCKER_SOCKET' : 'CLOUDY_CLOUD_SSH_HOST', // a coordinator has no SSH host; the socket path is its "key" (not secret)
    caps: {
      hasServerTTL: true, hasProxySecrets: false, hasConsentedSecrets: consented, hasSnapshots: true, hasPortForward: true,
      hasPublish: false, maxForegroundMs: Infinity, maxTtlSeconds, startsPerMin: 60, maxConcurrentCalls: 8, uploadMaxBytes: 200 * 1024 * 1024,
    },

    async create({ envs = {}, labels = {}, name, ttlSeconds, secrets = [], image: from }) {
      getSsh();
      const vars = { ...envs };
      // The GitHub token consent (setup) covers GH_TOKEN only; it goes in like Instabox's GH_TOKEN secret. Any other secret is
      // an MCP token the core asked for after the user allowed that server (--allow-literal); it comes from this machine's env.
      // Values go only into the tmpfs env file through stdin, never argv, labels or `docker inspect`.
      for (const n of [...(consented ? ['GH_TOKEN'] : []), ...secrets]) {
        if ((n === 'GH_TOKEN' && !consented) || env[n] === undefined) throw fail('no_key', `The secret ${n} cannot be put on ${host}. ${api.text.githubTokenHelp}`);
        vars[n] = env[n];
      }
      for (const n of Object.keys(vars)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`invalid environment variable name "${n}"`);
      const running = (await docker(['ps', '--filter', `label=${PREFIX}purpose`, '--format', '{{.ID}}'])).stdout.split('\n').filter(Boolean).length;
      if (running + reserved >= slots) throw fail('quota_exceeded', `All ${slots} self-hosted slots on ${host} are in use. Stop an agent or raise CLOUDY_CLOUD_SELF_HOSTED_SLOTS.`);
      reserved++; // the remote count above is the cross-process check; this counter stops concurrent creates here from both taking the last slot
      let img = image, id, ttl;
      try {
        if (from?.startsWith(COORD)) { // a coordinator snapshot: used as is, it carries its own version
          await api.getSnapshot(from);
          img = from;
        } else {
          const have = await docker(['image', 'inspect', '--format', '{{index .Config.Labels "cloudy-cloud.image"}}', image])
            .then((r) => r.stdout.trim(), (e) => { if (e.exitCode !== undefined) return 'missing'; throw e; });
          if (have !== VERSION) throw new Error(`The worker image on ${host} is version ${have} but cloudy-cloud is ${VERSION}. Run: cloudy-cloud setup`);
        }

        // A coordinator (and only a coordinator) gets the box's Docker socket, so it can start its workers as siblings. The socket's
        // group is added to the worker user; on Docker Desktop and OrbStack it is root (gid 0), on Linux usually docker.
        let socket = [];
        if (labels.role === 'coordinator') {
          if (!coordsOk) throw new Error(api.text.coordinatorRefusal);
          const gid = (await docker(['run', '--rm', '--entrypoint', 'stat', '-v', `${sock}:${SOCK_IN}`, img, '-c', '%g', SOCK_IN])).stdout.trim();
          if (!/^\d+$/.test(gid)) throw new Error(`Could not read the group of the Docker socket ${sock} on ${host ?? 'the box'}. Run: cloudy-cloud doctor`);
          socket = ['-v', `${sock}:${SOCK_IN}`, '--group-add', gid];
        }

        id = `cc-${randomBytes(6).toString('hex')}`;
        ttl = Math.min(Math.max(1, ttlSeconds || maxTtlSeconds), maxTtlSeconds);
        const now = Date.now();
        const all = { ...labels, ...(name && { name }), deleteAt: new Date(now + ttl * 1000).toISOString(), startedAt: new Date(now).toISOString() };
        const label = Object.entries(all).flatMap(([k, v]) => {
          if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`invalid label name "${k}"`);
          return ['--label', `${PREFIX}${k}=${v}`];
        });
        await docker(['run', '-d', '--rm', '--name', id, '--hostname', id, ...label, '--cpus', cpus, '--memory', memory, '--pids-limit', '2048',
          '--tmpfs', '/run/secrets:mode=700,uid=1000,gid=1000', ...socket, '--user', 'worker', img, 'timeout', `${ttl}s`, 'sleep', 'infinity']);
      } finally { reserved--; }
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

    // Coordinator image: `docker commit` of the sandbox. It keeps the Claude login under /home/worker/.claude; /run/secrets is a
    // tmpfs mount, so the env file (and any token in it) is not part of the image. The container is paused for a consistent copy.
    async snapshot(sb, { name, description = 'cloudy-cloud coordinator image' } = {}) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(name))) throw new Error(`invalid snapshot name "${name}"`);
      const id = COORD + name;
      await docker(['commit', '--pause=true', '-m', description, '--change', `LABEL ${PREFIX}snapshot=${name}`, sb.id, id]);
      return { id, status: 'ready' };
    },
    async getSnapshot(id) {
      if (!String(id).startsWith(COORD)) throw fail('not_found', `No self-hosted snapshot ${id}`);
      await docker(['image', 'inspect', '--format', '{{.Id}}', id]).catch((e) => {
        throw GONE.test(`${e.stderr ?? ''}${e.message}`) ? fail('not_found', `No self-hosted snapshot ${id} on ${host}`) : e;
      });
      return { id, status: 'ready' };
    },
    async listSnapshots() {
      const out = (await docker(['image', 'ls', '--filter', `reference=${COORD}*`, '--format', '{{.Repository}}:{{.Tag}}'])).stdout;
      return out.split('\n').filter(Boolean).map((id) => ({ id, status: 'ready' }));
    },
    async deleteSnapshot(id) {
      if (!String(id).startsWith(COORD)) throw new Error('deleteSnapshot only deletes coordinator images');
      await docker(['rmi', id]).catch((e) => { if (!GONE.test(`${e.stderr ?? ''}${e.message}`)) throw e; });
    },
    close: () => ssh?.close(),

    // Each local connection runs a tiny node TCP bridge inside the container over ssh stdio. Unlike `ssh -L` to the
    // container IP, this works with Docker Desktop on a Mac, whose container network is not routable from the host.
    // ponytail: one ssh session per connection on the shared master (MaxSessions 10); fine for a browser on a dev server.
    async forwardPort(id, localRemote, { signal } = {}) {
      if (local) throw new Error('cloudy-cloud open is not available from a coordinator; run it on your own computer.');
      const [lport, remote = lport] = String(localRemote).split(':');
      if (!/^\d+$/.test(lport) || !/^\d+$/.test(remote)) throw new Error(`port must be a number or local:remote, not "${localRemote}"`);
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
        server.listen(Number(lport), '127.0.0.1');
        signal?.addEventListener('abort', () => server.close(() => resolve(0)), { once: true });
      });
    },
    async publishPort() { throw new Error('self-hosted does not publish links'); },
    async unpublishPort() { return 1; },

    localMachineName: (hostname) => (hostname.startsWith('cc-') ? hostname : ''),

    // Names for the env file of a coordinator container (src/run-subagent.mjs installCoordinator, src/coordinator.mjs). Local mode, the
    // socket and the settings that size the box go in; the SSH host, key and port never do, so no SSH key leaves the laptop.
    // GH_TOKEN goes in only with the token consent, as for workers.
    coordinatorEnv(e = env) {
      const names = ['CLOUDY_CLOUD_CONTAINER_RUNTIME', 'CLOUDY_CLOUD_SELF_HOSTED_SLOTS', 'CLOUDY_CLOUD_SELF_HOSTED_CPUS', 'CLOUDY_CLOUD_SELF_HOSTED_MEMORY',
        ...(consented ? ['CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX', 'GH_TOKEN'] : []), e.CLAUDE_CODE_OAUTH_TOKEN ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY',
        ...Object.keys(e).filter((k) => PROVIDER_KEY.test(k) && !['ANTHROPIC_API_KEY', 'INSTABOX_API_KEY'].includes(k))];
      return [
        'CLOUDY_CLOUD_PROVIDER=self-hosted', 'CLOUDY_CLOUD_SELF_HOSTED_LOCAL=1', 'CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes',
        `CLOUDY_CLOUD_DOCKER_SOCKET=${sock}`, `CLOUDY_CLOUD_CONTAINER_BIN=${runtime}`, // the CLI inside the container is on PATH, not at the box's path
        ...names.filter((k) => e[k]).map((k) => `${k}=${e[k]}`),
      ];
    },

    text: {
      ssh: (machine, cmd) => (local ? `${bin} exec -it ${machine} ${cmd || 'bash'}`
        : `ssh${sshOpts().map((o) => ` ${o}`).join('')} -t ${host ?? '<CLOUDY_CLOUD_SSH_HOST>'} ${bin} exec -it ${machine} ${cmd || 'bash'}`),
      listMachines: local ? `${bin} ps --filter label=${PREFIX}purpose`
        : `ssh${sshOpts().map((o) => ` ${o}`).join('')} ${host ?? '<CLOUDY_CLOUD_SSH_HOST>'} ${bin} ps --filter label=${PREFIX}purpose`,
      noKeyFix: 'Set CLOUDY_CLOUD_SSH_HOST=user@host in ~/.config/cloudy-cloud/env or run: cloudy-cloud setup',
      apiFix: `Check that ${host ?? 'the host'} is reachable: cloudy-cloud doctor`,
      hostLabel: local ? 'the Docker host' : String(host ?? '').split('@').pop(), // the full user@host is the key value, which the core scrubs
      // A coordinator's containers need the box's Docker socket, which gives them full control of Docker there: setup asks once.
      ...(!coordsOk && { coordinatorRefusal: `Coordinators on ${host ?? 'your machine'} are not allowed yet: a coordinator starts its workers through the Docker socket on that machine, which gives it full control of Docker there. To allow it, run: cloudy-cloud setup --provider self-hosted and answer yes to the coordinators question. Until then start workers directly from your own session with cloud_agent.` }),
      githubTokenHelp: 'Allow the GitHub token on your machine and save one with write access: run cloudy-cloud setup --provider self-hosted and answer yes to the GitHub token question.',
    },
  };
  function sshOpts() {
    return [...(env.CLOUDY_CLOUD_SSH_KEY ? ['-i', env.CLOUDY_CLOUD_SSH_KEY] : []), ...(env.CLOUDY_CLOUD_SSH_PORT ? ['-p', env.CLOUDY_CLOUD_SSH_PORT] : [])];
  }
  return api;
}
