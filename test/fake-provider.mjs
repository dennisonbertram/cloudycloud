// In-memory provider for tests, plus the fake sandbox the run-subagent tests use (moved from run-subagent.test.mjs).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

// Fake `claude`: behaviour chosen by the first word of the prompt on stdin. Prints stream-json like `claude -p --output-format stream-json --verbose`.
export const SID = '11111111-2222-3333-4444-555555555555';
const FAKE_CLAUDE = `#!/bin/sh
p=$(cat)
echo "$CLAUDE_CODE_DISABLE_BACKGROUND_TASKS $BASH_DEFAULT_TIMEOUT_MS $BASH_MAX_TIMEOUT_MS" >> ../envlog.txt
sid=${SID}
resumed=""
[ "$1" = "-p" ] && [ "$2" = "--resume" ] && resumed="resumed $3 "
reply() {
  printf '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":10,"output_tokens":5}}}\\n'
  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"%s","total_cost_usd":0.01,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":7}}\\n' "$sid" "$1"
}
commit() { git add -A; git -c user.name=x -c user.email=x@x commit -qm "$1"; }
case "$p" in
  OWN-*) n=\${p#OWN-}; echo "$n" > "own-$n.txt"; commit "own $n"; git push -q origin HEAD; reply "own $n" ;;
  UNPUSHED*) echo unpushed > unpushed.txt; commit unpushed; reply "\${resumed}committed only" ;;
  DIRTY*) echo newfile > notes.txt; echo dirty >> a.txt; reply "dirty" ;;
  EDIT2*) echo more > b.txt; commit two; git push -q origin HEAD; reply "\${resumed}edited2" ;;
  EDIT*) echo changed > a.txt; commit edit; git push -q origin HEAD; reply "edited" ;;
  SHOW*) reply "a=$(cat a.txt) untracked=$(ls untracked.txt 2>&1 | tr -d '\\n')" ;;
  SLOW*) sleep 0.5; reply "slow done" ;;
  BADSID*) printf '{"type":"result","is_error":false,"result":"x","session_id":"x; rm -rf /"}\\n' ;;
  RAW*) echo "not json" ;;
  LEAK*) reply "leak $LEAK1 $LEAK2" ;;
  ECHO*) reply "$p" ;;
  FAIL*) echo changed > a.txt; commit fail; echo "boom $ANTHROPIC_API_KEY ghp_secret" >&2; exit 3 ;;
  *) reply "\${resumed}hello" ;;
esac
`;

// Fake `pi`: logs its arguments and prompt, then prints the synthetic fixture (FAKE_PI_FIXTURE, or the error one for prompts starting PIERR).
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const FAKE_PI = `#!/bin/sh
p=$(cat)
echo "ARGS $* DIR=$PI_CODING_AGENT_DIR PROMPT=$p" >> ../pi.log
case "$p" in PIERR*) cat ${FIXTURES}pi-json-error.jsonl ;; *) cat ${FIXTURES}pi-json-sample.jsonl ;; esac
`;

// Fake `omp` (installed by the fake installer below, like the real one): logs argv, agent dir and prompt; the error fixture exits 1.
const FAKE_OMP = `#!/bin/sh
p=$(cat)
echo "ARGS $* DIR=$PI_CODING_AGENT_DIR PROMPT=$p" >> ../omp.log
case "$p" in OMPERR*) cat ${FIXTURES}omp-json-error.jsonl; exit 1 ;; *) cat ${FIXTURES}omp-json-sample.jsonl ;; esac
`;

let currentGithub; // the bare repo of the test being set up (tests in a file run one at a time)
export const setGithub = (g) => { currentGithub = g; };
export const getGithub = () => currentGithub;
export async function fakeSandbox(github = currentGithub) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-sbx-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await mkdir(join(dir, 'home'));
  await writeFile(join(bin, 'claude'), FAKE_CLAUDE);
  await chmod(join(bin, 'claude'), 0o755);
  await writeFile(join(bin, 'pi'), FAKE_PI);
  await chmod(join(bin, 'pi'), 0o755);
  await writeFile(join(bin, 'omp-real'), FAKE_OMP);
  await chmod(join(bin, 'omp-real'), 0o755);
  // fake curl prints an installer script that puts omp in ~/.local/bin (cwd is the home) and logs its arguments
  await writeFile(join(bin, 'curl'), `#!/bin/sh\necho 'echo "install $*" >> install.log; mkdir -p .local/bin && cp ${bin}/omp-real .local/bin/omp'\n`);
  await chmod(join(bin, 'curl'), 0o755);
  await writeFile(join(bin, 'npm'), '#!/bin/sh\necho "npm $*" >> npm.log\n');
  await chmod(join(bin, 'npm'), 0o755);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 0\n'); // fake gh: no-op
  await chmod(join(bin, 'gh'), 0o755);
  const map = (s) => s.replaceAll('/home/user', join(dir, 'home'));
  const sbx = {
    dir,
    killed: false,
    files: {
      write: (p, d) => { sbx.writes.push(p); sbx.writeAt[p] = sbx.cmds.length; return writeFile(map(p), d); },
      read: (p) => readFile(map(p)),
    },
    cmds: [],
    writes: [],
    writeAt: {},
    commands: {
      async run(cmd, { cwd, timeoutMs, onStdout } = {}) {
        assert.ok(timeoutMs > 0, 'timeoutMs must be set');
        sbx.cmds.push(cmd);
        try {
          const r = await exec('sh', ['-c', map(cmd)], {
            cwd: map(cwd),
            env: { ...process.env, ...(github && { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${github}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' }), PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: sbx.envs?.ANTHROPIC_API_KEY ?? '', LEAK1: 'ghp_secret', LEAK2: 'ghp_other' },
          });
          await onStdout?.(r.stdout);
          return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
        } catch (e) {
          throw Object.assign(new Error('exit'), { exitCode: e.code, stdout: e.stdout, stderr: e.stderr });
        }
      },
    },
    kill: async () => { sbx.killed = true; },
  };
  return sbx;
}


// ---- the in-memory Provider (see src/providers/index.mjs for the interface) ----

// Records every call on `log`. Sandboxes are fakeSandbox()es, so commands really run in a temp dir.
export function createFakeProvider(env = { FAKE_API_KEY: 'fake-key' }, { hasSnapshots = true, hasProxySecrets = true, hasConsentedSecrets = false } = {}) {
  const log = { create: [], list: [], delete: [], snapshot: [], getSnapshot: [], connect: [], ports: [] };
  const machines = new Map(); // id -> { id, name, labels, state, status, startedAt, deleteAt }
  const sandboxes = new Map();
  let n = 0;
  const needKey = () => { if (!env.FAKE_API_KEY) throw Object.assign(new Error('FAKE_API_KEY is not set.'), { code: 'no_key' }); };
  const wrap = (sbx, id, name) => Object.assign(sbx, { id, name, home: '/home/user' });
  return {
    name: 'fake', keyName: 'FAKE_API_KEY', log, machines,
    caps: { hasServerTTL: true, hasProxySecrets, hasConsentedSecrets, hasSnapshots, hasPortForward: true, hasPublish: true,
      maxForegroundMs: 600_000, maxTtlSeconds: 86_400, startsPerMin: 25, maxConcurrentCalls: 24, uploadMaxBytes: 10_485_760 },
    async create(opts) {
      needKey();
      log.create.push(opts);
      const id = `fake-${++n}`, name = opts.name ?? `sbx-${n}`;
      const sbx = wrap(await fakeSandbox(), id, name);
      sbx.envs = opts.envs;
      machines.set(id, { id, name, labels: { ...opts.labels }, state: 'running', status: 'running', startedAt: Date.now(), deleteAt: new Date(Date.now() + opts.ttlSeconds * 1000).toISOString() });
      sandboxes.set(id, sbx);
      const kill = sbx.kill;
      sbx.kill = async () => { await kill(); machines.delete(id); };
      return sbx;
    },
    async connect(id) {
      needKey();
      log.connect.push(id);
      if (!sandboxes.has(id)) throw Object.assign(new Error(`machine ${id} not found`), { code: 'not_found' });
      return sandboxes.get(id);
    },
    async list(labels = {}) {
      needKey();
      log.list.push(labels);
      return [...machines.values()].filter((m) => Object.entries(labels).every(([k, v]) => m.labels[k] === v));
    },
    async delete(id) { needKey(); log.delete.push(id); machines.delete(id); },
    async snapshot(sbx, opts) {
      if (!hasSnapshots) throw Object.assign(new Error('This provider has no snapshots.'), { code: 'not_found' });
      log.snapshot.push({ id: sbx.id, ...opts });
      return { id: `snap-${log.snapshot.length}`, status: 'pending' };
    },
    async getSnapshot(id) { log.getSnapshot.push(id); return { id, status: 'ready' }; },
    async forwardPort(id, localRemote) { log.ports.push({ op: 'forward', id, localRemote }); return 0; },
    async publishPort(id, port) { log.ports.push({ op: 'publish', id, port }); return { url: `https://fake.example/${id}/${port}` }; },
    async unpublishPort(id, port) { log.ports.push({ op: 'unpublish', id, port }); return 0; },
    localMachineName: (hostname) => (hostname.startsWith('fake-') ? hostname.slice(5) : ''),
    text: {
      ssh: (machine, cmd) => `fake ssh ${machine} -- ${cmd}`, listMachines: 'fake ls',
      noKeyFix: 'Set FAKE_API_KEY.', apiFix: 'Check FAKE_API_KEY.', githubTokenHelp: 'Create the GH_TOKEN secret.',
    },
  };
}
