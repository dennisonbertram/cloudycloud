// SSH transport for the self-hosted provider: run one command on CLOUDY_CLOUD_SSH_HOST over a multiplexed
// OpenSSH connection (ControlMaster), stream stdout, feed stdin, enforce a timeout, honour an abort signal.
//
// Failures the caller may retry:  code 'transient'  (exit 255: ssh could not connect or was dropped; ssh did not start).
// Failures that are final:        code 'no_key'     (CLOUDY_CLOUD_SSH_HOST unset), code 'timeout' (timeoutMs passed),
//                                 AbortError (caller aborted), and any other non-zero exit, which rejects with
//                                 { exitCode, stdout, stderr } as the Sandbox contract requires.
// timeoutMs is enforced here by killing the local ssh (a stock Mac has no `timeout` command), so the caller must end
// the remote side itself if it matters. ConnectTimeout makes an unreachable host fail in seconds, not minutes.
// Only the key PATH goes in argv. The remote command is base64 so its text never needs quoting or shows in argv.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLimiter } from '../limits.mjs';

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
// Unix socket paths are limited to ~104 bytes and macOS tmpdir() is long, so keep the private dir short.
// ponytail: the dir is never removed (the ssh master outlives us for ControlPersist); it holds only sockets.
const privateDir = () => mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cc-ssh-'), { mode: 0o700 });

export function createSsh(env = process.env, { spawn = nodeSpawn } = {}) {
  const host = env.CLOUDY_CLOUD_SSH_HOST;
  if (!host) throw fail('no_key', 'Set CLOUDY_CLOUD_SSH_HOST (user@host) or run cloudy-cloud setup');
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@:%-]*$/.test(host)) throw new Error(`invalid CLOUDY_CLOUD_SSH_HOST "${host}"`);
  const dir = privateDir();
  const limiter = createLimiter(8); // OpenSSH MaxSessions defaults to 10 per connection

  const argvFor = (remoteCmd) => {
    const b64 = Buffer.from(remoteCmd).toString('base64');
    return [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/cc-%C`,
      '-o', 'ControlPersist=10m', '-o', 'ServerAliveInterval=15',
      ...(env.CLOUDY_CLOUD_SSH_KEY ? ['-i', env.CLOUDY_CLOUD_SSH_KEY] : []),
      ...(env.CLOUDY_CLOUD_SSH_PORT ? ['-p', String(env.CLOUDY_CLOUD_SSH_PORT)] : []),
      host,
      `sh -c "$(printf %s ${b64} | base64 -d)"`,
    ];
  };

  const once = (remoteCmd, { stdin, onStdout, timeoutMs, signal } = {}) => new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) return reject(aborted());
    const child = spawn('ssh', argvFor(remoteCmd), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const timer = timeoutMs > 0 && setTimeout(() => {
      child.kill();
      finish(reject, fail('timeout', `timed out after ${Math.ceil(timeoutMs / 1000)} s`, { stdout, stderr }));
    }, timeoutMs);
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => { child.kill(); finish(reject, aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', (d) => { d = String(d); stdout += d; try { onStdout?.(d); } catch { /* a bad callback must not kill the call */ } });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, fail('transient', `cannot reach ${host} over ssh: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 255 || code === null) return finish(reject, fail('transient', `cannot reach ${host} over ssh: ${stderr.trim().slice(-300)}`));
      if (code !== 0) return finish(reject, Object.assign(new Error(stderr.trim().slice(-300) || `exit ${code}`), { exitCode: code, stdout, stderr }));
      finish(resolve, { stdout, stderr, exitCode: 0 });
    });
    child.stdin.on('error', () => {}); // EPIPE when the remote command exits before reading all of stdin
    child.stdin.end(stdin);
  });

  return { dir, argvFor, run: (cmd, opts) => limiter.run(() => once(cmd, opts)) };
}
