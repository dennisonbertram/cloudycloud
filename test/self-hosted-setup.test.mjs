import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { slotsFor } from '../src/self-hosted-setup.mjs';
import { loadEnv } from '../src/config.mjs';

const script = resolve('src/self-hosted-setup.mjs');
const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
const dockerfile = readFileSync(resolve('docker/worker.Dockerfile'));
const FAKE_TOKEN = 'ghp_' + 'FaKeToKeN0123456789'.repeat(2);
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-sh-'));

// A fake `ssh` on PATH. It decodes the base64 command ssh.mjs sends, answers from a table of
// [regex, { out, err, code }] rows (first match wins), and logs every command with its stdin.
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a.includes('-O')) process.exit(0);
const cmd = Buffer.from(a.at(-1).match(/printf %s ([A-Za-z0-9+/=]+) /)[1], 'base64').toString();
let stdin = Buffer.alloc(0);
process.stdin.on('data', (d) => { stdin = Buffer.concat([stdin, d]); });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, cmd, stdin: stdin.toString('base64') }) + '\\n');
  for (const [re, r] of JSON.parse(fs.readFileSync(process.env.FAKE_TABLE, 'utf8'))) {
    if (new RegExp(re).test(cmd)) { process.stdout.write(r.out || ''); process.stderr.write(r.err || ''); process.exit(r.code || 0); }
  }
  process.stderr.write('fake ssh: no answer for: ' + cmd); process.exit(99);
});
`;

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const df = (availKb) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 971350180 400000000 ${availKb} 45% /System/Volumes/Data\n`;
// A healthy Mac Studio: 16 cores, 128 GB, Docker Desktop's VM has 10 cores and 16 GB.
const mac = (over = {}) => ({
  '^true$': { out: '' },
  'uname -s': { out: 'Darwin\n' },
  'command -v docker': { out: '/usr/local/bin/docker\n' },
  'command -v podman': { out: '', code: 1 },
  'info --format': { out: '27.3.1 10 17179869184\n' },
  'sysctl -n hw.ncpu': { out: '16\n137438953472\n' },
  'df -Pk': { out: df(500000000) },
  'pmset -g': { out: '0\n' },
  'image inspect': { out: `${version}\n` },
  'ps -a --filter': { out: '' },
  'docker.* build ': { out: 'Step 1/9\nSuccessfully tagged\n' },
  ...over,
});

function rig(table, { env = '', files = {} } = {}) {
  const dir = tmp(), bin = join(dir, 'bin'), cfg = join(dir, 'cfg', 'env');
  const log = join(dir, 'log'), tablePath = join(dir, 'table.json');
  spawnSync('mkdir', ['-p', bin, join(dir, 'cfg')]);
  writeFileSync(join(bin, 'ssh'), FAKE_SSH); chmodSync(join(bin, 'ssh'), 0o755);
  writeFileSync(log, '');
  writeFileSync(tablePath, JSON.stringify(Object.entries(table)));
  if (env) writeFileSync(cfg, env, { mode: 0o600 });
  const run = (args, input = '') => {
    const r = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', input, timeout: 60000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: tmpdir(), NO_COLOR: '1', CLOUDY_CLOUD_CONFIG: cfg, FAKE_LOG: log, FAKE_TABLE: tablePath },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
  };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { run, calls, cfg, dir };
}
const SAVED = `CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SSH_HOST=me@mac-studio\nCLOUDY_CLOUD_CONTAINER_RUNTIME=docker\nCLOUDY_CLOUD_CONTAINER_BIN=/usr/local/bin/docker\nCLOUDY_CLOUD_SELF_HOSTED_SLOTS=4\nCLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes\nGH_TOKEN=${FAKE_TOKEN}\n`;
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').sort();

test('slots: min(cpus/2, GiB/4), at least 1', () => {
  assert.equal(slotsFor(16, 128 * 2 ** 30), 8);
  assert.equal(slotsFor(10, 16 * 2 ** 30), 4);
  assert.equal(slotsFor(2, 4 * 2 ** 30), 1);
  assert.equal(slotsFor(1, 1 * 2 ** 30), 1);
});

// ---- doctor ----
test('doctor: not self-hosted says so and exits 0 without calling ssh', () => {
  const g = rig(mac());
  const r = g.run(['doctor']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /Provider is instabox; doctor checks self-hosted boxes only/);
  assert.equal(g.calls().length, 0);
});

test('doctor: healthy Mac prints ok lines, no fail, exit 0', () => {
  const g = rig(mac(), { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 0, r.text);
  console.log('\n--- healthy doctor output ---\n' + r.out);
  assert.match(r.out, /ok\s+SSH: me@mac-studio answered in/);
  assert.match(r.out, /ok\s+Container runtime: docker 27\.3\.1 at \/usr\/local\/bin\/docker/);
  assert.match(r.out, new RegExp(`ok\\s+Worker image: cloudy-cloud-worker:${version.replace(/\./g, '\\.')}`));
  assert.match(r.out, /ok\s+Disk: 476 GB free/);
  assert.match(r.out, /ok\s+Capacity: .*4 subagents at once/);
  assert.match(r.out, /ok\s+Sleep: the Mac does not sleep/);
  assert.match(r.out, /ok\s+Containers: none running/);
  assert.match(r.out, /ok\s+Settings: /);
  assert.ok(!/warn|fail/.test(r.out), r.out);
  assert.ok(!r.text.includes(FAKE_TOKEN));
  for (const c of g.calls()) assert.ok(!c.cmd.includes(FAKE_TOKEN));
});

test('doctor: unreachable host fails with fixes and exit 1', () => {
  const g = rig({ '.': { err: 'ssh: connect to host mac-studio port 22: Operation timed out\n', code: 255 } }, { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /fail\s+SSH: cannot reach me@mac-studio/);
  assert.match(r.out, /Operation timed out/);
  assert.match(r.out, /fix: .*Tailscale/i);
  assert.match(r.out, /fix: .*tailnet/i);
  assert.match(r.out, /fix: .*key/i);
});

test('doctor: missing image fails and says how to build it', () => {
  const g = rig(mac({ 'image inspect': { err: 'Error: No such image\n', code: 1 } }), { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /fail\s+Worker image: cloudy-cloud-worker:\S+ is not on the machine/);
  assert.match(r.out, /fix: cloudy-cloud setup --provider self-hosted/);
});

test('doctor: image label that does not match the package version fails', () => {
  const g = rig(mac({ 'image inspect': { out: '0.0.1\n' } }), { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`fail\\s+Worker image: .*labelled 0\\.0\\.1 but this cloudy-cloud is ${version.replace(/\./g, '\\.')}`));
  assert.match(r.out, /fix: cloudy-cloud setup --provider self-hosted/);
});

test('doctor: low disk warns (exit 0) with a fix', () => {
  const g = rig(mac({ 'df -Pk': { out: df(5 * 1024 * 1024) } }), { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /warn\s+Disk: 5 GB free, under the 20 GB/);
  assert.match(r.out, /fix: /);
});

test('doctor: a container past its deadline warns with the remove command; a fresh one is listed ok', () => {
  const g = rig(mac({ 'ps -a --filter': { out: `cc-old|3 days ago|${PAST}\ncc-new|5 minutes ago|${FUTURE}\n` } }), { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 0, r.text);
  console.log('\n--- stale container doctor output ---\n' + r.out);
  assert.match(r.out, /warn\s+Containers: cc-old is stale \(started 3 days ago, deadline .*passed\)/);
  assert.match(r.out, /fix: ssh me@mac-studio '\/usr\/local\/bin\/docker rm -f cc-old'/);
  assert.match(r.out, /ok\s+Containers: cc-new/);
});

test('doctor: a Mac that sleeps warns and names the setting to change', () => {
  const g = rig(mac({ 'pmset -g': { out: '1\n' } }), { env: SAVED });
  const r = g.run(['doctor']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /warn\s+Sleep: the Mac goes to sleep after 1 minute/);
  assert.match(r.out, /fix: .*Prevent automatic sleeping when the display is off/);
});

test('doctor: slots above what the machine can hold warn; docker not answering fails', () => {
  const g = rig(mac(), { env: SAVED.replace('SLOTS=4', 'SLOTS=9') });
  const r = g.run(['doctor']);
  assert.match(r.out, /warn\s+Capacity: 9 subagents at once is more than this machine suggests \(4\)/);
  const g2 = rig(mac({ 'info --format': { err: 'Cannot connect to the Docker daemon\n', code: 1 } }), { env: SAVED });
  const r2 = g2.run(['doctor']);
  assert.equal(r2.code, 1);
  assert.match(r2.out, /fail\s+Container runtime: .*does not answer/);
  assert.match(r2.out, /fix: .*Docker Desktop or OrbStack/);
});

test('doctor: slow ssh warns about Tailscale re-auth; missing env names are reported', () => {
  const g = rig(mac(), { env: 'CLOUDY_CLOUD_PROVIDER=self-hosted\nCLOUDY_CLOUD_SSH_HOST=me@mac-studio\n' });
  const r = g.run(['doctor']);
  assert.match(r.out, /warn\s+Settings: CLOUDY_CLOUD_SELF_HOSTED_SLOTS is not set/);
  assert.match(r.out, /warn\s+Settings: .*GitHub token/);
  const slow = rig(mac(), { env: SAVED });
  // the round-trip limit is injectable so the test does not wait 5 s
  const r2 = spawnSync(process.execPath, [script, 'doctor'], { encoding: 'utf8', env: { ...process.env, PATH: `${join(slow.dir, 'bin')}:${process.env.PATH}`, HOME: slow.dir, NO_COLOR: '1', CLOUDY_CLOUD_CONFIG: slow.cfg, FAKE_LOG: join(slow.dir, 'log'), FAKE_TABLE: join(slow.dir, 'table.json'), CLOUDY_CLOUD_DOCTOR_SLOW_MS: '0' } });
  assert.match(r2.stdout, /warn\s+SSH: .*Tailscale check mode may be asking for re-auth/);
});

test('doctor: GitHub token consent with no saved token fails', () => {
  const g = rig(mac(), { env: SAVED.replace(/GH_TOKEN=.*\n/, '') });
  const r = g.run(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /fail\s+Settings: .*GH_TOKEN/);
});

// ---- setup ----
const ANSWERS = (token = FAKE_TOKEN) => `me@mac-studio\n/home/me/.ssh/id_ed25519\n\ny\n${token}\n`; // host, key, slots (Enter), allow token, token

test('setup on a Mac: prompts, checks, builds the image, saves settings at mode 600, never prints the token', () => {
  const g = rig(mac());
  const r = g.run(['setup'], ANSWERS());
  assert.equal(r.code, 0, r.text);
  console.log('\n--- setup output ---\n' + r.out);
  assert.match(r.out, /SSH address of your machine/);
  assert.match(r.out, /Remote Login/);
  assert.match(r.out, /Path to your SSH key/);
  assert.match(r.out, /ok\s+SSH: me@mac-studio answered/);
  assert.match(r.out, /ok\s+Container runtime: docker 27\.3\.1 at \/usr\/local\/bin\/docker/);
  assert.match(r.out, /How many subagents may run at once\? \[4\]/);
  assert.match(r.out, /Building the worker image/);
  assert.match(r.out, /ok\s+Worker image: cloudy-cloud-worker:/);
  assert.match(r.out, /Allow the GitHub token on me@mac-studio\? \[y\/N\]/);
  assert.match(r.out, /stored inside each worker container/);
  assert.ok(!r.text.includes(FAKE_TOKEN), 'token echoed');
  assert.deepEqual(lines(g.cfg), [
    'CLOUDY_CLOUD_CONTAINER_BIN=/usr/local/bin/docker',
    'CLOUDY_CLOUD_CONTAINER_RUNTIME=docker',
    'CLOUDY_CLOUD_PROVIDER=self-hosted',
    'CLOUDY_CLOUD_SELF_HOSTED_CPUS=2', // 10 CPUs in the Docker VM / 4 slots
    'CLOUDY_CLOUD_SELF_HOSTED_MEMORY=3276m', // 80% of the VM's 16 GiB / 4 slots
    'CLOUDY_CLOUD_SELF_HOSTED_SLOTS=4',
    'CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes',
    'CLOUDY_CLOUD_SSH_HOST=me@mac-studio',
    'CLOUDY_CLOUD_SSH_KEY=/home/me/.ssh/id_ed25519',
    `GH_TOKEN=${FAKE_TOKEN}`,
  ].sort());
  assert.equal(statSync(g.cfg).mode & 0o777, 0o600);
  // every saved name survives loadEnv (KEYS), so the adapter reads what setup wrote
  const loaded = loadEnv({ CLOUDY_CLOUD_CONFIG: g.cfg });
  for (const l of lines(g.cfg)) assert.equal(`${l.split('=')[0]}=${loaded[l.split('=')[0]]}`, l);
  assert.deepEqual(require_ls(join(g.dir, 'cfg')), ['env']); // no temp file left
  const calls = g.calls();
  const build = calls.find((c) => /build/.test(c.cmd));
  assert.ok(build, 'no build command');
  assert.match(build.cmd, new RegExp(`/usr/local/bin/docker build --build-arg VERSION=${version.replace(/\./g, '\\.')} -t cloudy-cloud-worker:${version.replace(/\./g, '\\.')} -`));
  assert.match(build.cmd, /PATH=/); // credential helpers live next to docker
  assert.ok(Buffer.from(build.stdin, 'base64').equals(dockerfile), 'Dockerfile bytes did not reach ssh stdin');
  assert.deepEqual(build.argv.filter((a) => a === '-i' || a === '/home/me/.ssh/id_ed25519').length, 2);
  for (const c of calls) { assert.ok(!c.cmd.includes(FAKE_TOKEN)); assert.ok(!c.argv.join(' ').includes(FAKE_TOKEN)); }
});
const require_ls = (d) => spawnSync('ls', ['-A', d], { encoding: 'utf8' }).stdout.trim().split('\n');

test('setup: finds docker in a known path when the login shell does not know it, and saves the absolute path', () => {
  const g = rig(mac({
    'command -v docker': { out: '', code: 1 },
    'for p in': { out: '/Users/me/.orbstack/bin/docker\n' },
    'info --format': { out: '27.0.0 8 8589934592\n' },
  }));
  const r = g.run(['setup'], `me@mac-studio\n\n\nn\n`);
  assert.equal(r.code, 0, r.text);
  assert.match(lines(g.cfg).join('\n'), /CLOUDY_CLOUD_CONTAINER_BIN=\/Users\/me\/\.orbstack\/bin\/docker\nCLOUDY_CLOUD_CONTAINER_RUNTIME=docker\n/);
  assert.match(lines(g.cfg).join('\n'), /CLOUDY_CLOUD_SELF_HOSTED_CPUS=4\nCLOUDY_CLOUD_SELF_HOSTED_MEMORY=3276m\n/);
  assert.match(r.out, /How many subagents may run at once\? \[2\]/); // min(8/2, 8 GiB/4)
  assert.ok(g.calls().some((c) => c.cmd.includes('.orbstack/bin/docker')));
});

test('setup: answering No to the token saves no consent and no token, and warns workers cannot push', () => {
  const g = rig(mac());
  const r = g.run(['setup'], `me@mac-studio\n\n\nn\n`);
  assert.equal(r.code, 0, r.text);
  assert.ok(!/TOKEN_ON_BOX|GH_TOKEN/.test(readFileSync(g.cfg, 'utf8')));
  assert.match(r.out, /warn\s+GitHub token: not allowed/);
});

test('setup: a slot override is saved; a bad value falls back to the suggestion', () => {
  const g = rig(mac());
  g.run(['setup'], `me@mac-studio\n\n3\nn\n`);
  assert.match(readFileSync(g.cfg, 'utf8'), /SLOTS=3\n/);
  const g2 = rig(mac());
  const r2 = g2.run(['setup'], `me@mac-studio\n\nlots\nn\n`);
  assert.match(r2.out, /warn\s+"lots" is not a number/);
  assert.match(readFileSync(g2.cfg, 'utf8'), /SLOTS=4\n/);
});

test('setup: unreachable host stops with ssh error and three fixes, saves nothing', () => {
  const g = rig({ '.': { err: 'ssh: connect to host mac-studio port 22: Connection refused\n', code: 255 } });
  const r = g.run(['setup'], 'me@mac-studio\n\n');
  assert.equal(r.code, 1);
  assert.match(r.out, /fail\s+SSH: cannot reach me@mac-studio/);
  assert.match(r.out, /Connection refused/);
  assert.equal((r.out.match(/fix: /g) || []).length, 3);
  assert.ok(!existsSync(g.cfg));
});

test('setup: no docker on the machine stops with a Mac-specific fix', () => {
  const g = rig(mac({ 'command -v docker': { out: '', code: 1 }, 'for p in': { out: '' } }));
  const r = g.run(['setup'], 'me@mac-studio\n\n');
  assert.equal(r.code, 1);
  assert.match(r.out, /fail\s+Container runtime: no docker found/);
  assert.match(r.out, /fix: .*Docker Desktop or OrbStack/);
  assert.ok(!existsSync(g.cfg));
});

test('setup: a failed build shows the last error lines and saves nothing', () => {
  const g = rig(mac({ 'docker.* build ': { err: 'step 3\nE: Unable to locate package nope\n', code: 1 } }));
  const r = g.run(['setup'], 'me@mac-studio\n\n\n');
  assert.equal(r.code, 1);
  assert.match(r.out, /fail\s+Worker image: the build failed/);
  assert.match(r.out, /Unable to locate package nope/);
  assert.ok(!existsSync(g.cfg));
});

test('setup on Linux uses nproc and /proc/meminfo, and checks /var/lib/docker', () => {
  const g = rig(mac({
    'uname -s': { out: 'Linux\n' },
    'nproc': { out: '12\n34359738368\n' }, // 12 cores, 32 GiB
    'info --format': { out: '26.1.0 12 34359738368\n' },
    'pmset': { out: 'pmset must not run on Linux\n', code: 9 },
  }));
  const r = g.run(['setup'], 'me@box\n\n\nn\n');
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /How many subagents may run at once\? \[6\]/); // min(12/2, 32/4=8)
  const cmds = g.calls().map((c) => c.cmd).join('\n');
  assert.match(cmds, /df -Pk \/var\/lib\/docker/);
  assert.ok(!/pmset/.test(cmds));
});

test('setup: saved values are the defaults on a second run; Enter keeps the saved token', () => {
  const g = rig(mac(), { env: SAVED });
  const r = g.run(['setup'], '\n\n\ny\n\n');
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /\[me@mac-studio\]/);
  assert.match(readFileSync(g.cfg, 'utf8'), new RegExp(`GH_TOKEN=${FAKE_TOKEN}\n`));
  assert.match(readFileSync(g.cfg, 'utf8'), /SSH_HOST=me@mac-studio/);
});

test('setup: allowing coordinators saves the consent and the Docker socket; the question names the risk (#41)', () => {
  const g = rig(mac());
  const r = g.run(['setup'], `me@mac-studio\n\n\nn\ny\n`);
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /Coordinators on me@mac-studio can start containers through Docker, which gives them full control of Docker on that machine\. Allow\? \[y\/N\]/);
  const saved = lines(g.cfg).join('\n');
  assert.match(saved, /CLOUDY_CLOUD_DOCKER_SOCKET=\/var\/run\/docker\.sock\n/); // inside the Mac's container VM
  assert.match(saved, /CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes/);
  const loaded = loadEnv({ CLOUDY_CLOUD_CONFIG: g.cfg });
  assert.equal(loaded.CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS, 'yes');
});

test('setup: a Linux box with a rootless socket saves that path; No saves nothing and removes an old consent', () => {
  const lin = rig({ ...mac(), 'uname -s': { out: 'Linux\n' }, 'sysctl -n': { out: '', code: 1 }, 'nproc': { out: '8\n17179869184\n' }, 'context inspect': { out: 'unix:///run/user/1000/docker.sock\n' } });
  assert.equal(lin.run(['setup'], `me@box\n\n\nn\ny\n`).code, 0);
  assert.match(lines(lin.cfg).join('\n'), /CLOUDY_CLOUD_DOCKER_SOCKET=\/run\/user\/1000\/docker\.sock/);
  const g = rig(mac(), { env: 'CLOUDY_CLOUD_SELF_HOSTED_COORDINATORS=yes\nCLOUDY_CLOUD_DOCKER_SOCKET=/var/run/docker.sock\n' });
  const r = g.run(['setup'], `me@mac-studio\n\n\nn\nn\n`);
  assert.equal(r.code, 0, r.text);
  assert.ok(!/COORDINATORS|DOCKER_SOCKET/.test(readFileSync(g.cfg, 'utf8')));
  assert.match(r.out, /coordinators stay off|Coordinators: not allowed/i);
});
