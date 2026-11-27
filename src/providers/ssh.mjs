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
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLimiter } from '../limits.mjs';

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
// Unix socket paths are limited to ~104 bytes and macOS tmpdir() is long, so keep the private dir short.
// close() (also run once at process exit) stops the ssh master and removes the dir, so no /tmp/cc-ssh-* dir is left behind.
const privateDir = () => mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cc-ssh-'), { mode: 0o700 });

const open = new Set();
process.on('exit', () => { for (const close of [...open]) close(); });

export function createSsh(env = process.env, { spawn = nodeSpawn, spawnSync = nodeSpawnSync } = {}) {
  const host = env.CLOUDY_CLOUD_SSH_HOST;
  if (!host) throw fail('no_key', 'Set CLOUDY_CLOUD_SSH_HOST (user@host) or run cloudy-cloud setup');
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@:%-]*$/.test(host)) throw new Error(`invalid CLOUDY_CLOUD_SSH_HOST "${host}"`);
  const dir = privateDir();
  const limiter = createLimiter(8); // OpenSSH MaxSessions defaults to 10 per connection

  const argvFor = (remoteCmd, tag) => {
    const b64 = Buffer.from(remoteCmd).toString('base64');
    return [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/cc-%C`,
      '-o', 'ControlPersist=10m', '-o', 'ServerAliveInterval=15',
      ...(env.CLOUDY_CLOUD_SSH_KEY ? ['-i', env.CLOUDY_CLOUD_SSH_KEY] : []),
      ...(env.CLOUDY_CLOUD_SSH_PORT ? ['-p', String(env.CLOUDY_CLOUD_SSH_PORT)] : []),
      host,
      // The exit marker proves the remote command ran: ssh's own 255 (a transport failure) is then told
      // apart from a remote command that legitimately exits 255.
      `sh -c "$(printf %s ${b64} | base64 -d)"${tag ? `; s=$?; printf '\\nCCSSH_EXIT_${tag}=%s\\n' "$s" >&2; exit $s` : ''}`,
    ];
  };

  const once = (remoteCmd, { stdin, onStdout, onStderr, timeoutMs, signal } = {}) => new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) return reject(aborted());
    const tag = randomBytes(8).toString('hex');
    const child = spawn('ssh', argvFor(remoteCmd, tag), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', done = false;
    const marker = new RegExp(`CCSSH_EXIT_${tag}=(\\d+)`);
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
    // The exit marker arrives as the last stderr bytes, possibly split across chunks or followed by ssh's
    // own trailer (a dropped connection can still print after it): the last bytes are held back until
    // close so the marker is found and stripped before the stream reaches callers.
    child.stderr.on('data', (d) => {
      pending += String(d);
      const emit = pending.slice(0, -256);
      pending = pending.slice(-256);
      if (emit) { stderr += emit; try { onStderr?.(emit); } catch { /* a bad callback must not kill the call */ } }
    });
    child.on('error', (e) => finish(reject, fail('transient', `cannot reach ${host} over ssh: ${e.message}`)));
    child.on('close', (code) => {
      const m = marker.exec(pending);
      const rest = m ? pending.slice(0, m.index) : pending;
      if (rest) { stderr += rest; try { onStderr?.(rest); } catch { /* a bad callback must not kill the call */ } }
      pending = '';
      if (m) { // the remote command ran and finished: its real exit code, even a genuine 255
        const remote = Number(m[1]);
        if (remote !== 0) return finish(reject, Object.assign(new Error(stderr.trim().slice(-300) || `exit ${remote}`), { exitCode: remote, stdout, stderr }));
        return finish(resolve, { stdout, stderr, exitCode: 0 });
      }
      if (code === 255 || code === null) return finish(reject, fail('transient', `cannot reach ${host} over ssh: ${stderr.trim().slice(-300)}`));
      if (code !== 0) return finish(reject, Object.assign(new Error(stderr.trim().slice(-300) || `exit ${code}`), { exitCode: code, stdout, stderr }));
      finish(resolve, { stdout, stderr, exitCode: 0 });
    });
    child.stdin.on('error', () => {}); // EPIPE when the remote command exits before reading all of stdin
    child.stdin.end(stdin);
  });

  // Stop the ssh master (only if one started: its socket is in the dir) and remove the private dir. Safe to call twice.
  const close = () => {
    open.delete(close);
    try {
      if (readdirSync(dir).length) spawnSync('ssh', ['-o', `ControlPath=${dir}/cc-%C`, '-O', 'exit', ...(env.CLOUDY_CLOUD_SSH_PORT ? ['-p', String(env.CLOUDY_CLOUD_SSH_PORT)] : []), host], { stdio: 'ignore' });
    } catch { /* dir already gone */ }
    rmSync(dir, { recursive: true, force: true });
  };
  open.add(close);

  return { dir, argvFor, close, run: (cmd, opts) => limiter.run(() => once(cmd, opts)) };
}
