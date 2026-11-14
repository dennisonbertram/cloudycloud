// Local transport for the self-hosted provider, used inside a coordinator container: the same run(cmd, opts) as ssh.mjs, but the
// command runs here with `sh -c`, so docker talks to the box's socket mounted into this container. No ssh, no key.
// Failures match ssh.mjs: { exitCode, stdout, stderr } for a non-zero exit, code 'timeout', AbortError, code 'transient'.
import { spawn as nodeSpawn } from 'node:child_process';
import { createLimiter } from '../limits.mjs';

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

export function createLocal({ spawn = nodeSpawn } = {}) {
  const limiter = createLimiter(8);
  const once = (cmd, { stdin, onStdout, timeoutMs, signal } = {}) => new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) return reject(aborted());
    let child;
    try { child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return reject(fail('transient', `cannot start a local command: ${e.message}`)); }
    let stdout = '', stderr = '', done = false;
    const timer = timeoutMs > 0 && setTimeout(() => { child.kill(); finish(reject, fail('timeout', `timed out after ${Math.ceil(timeoutMs / 1000)} s`, { stdout, stderr })); }, timeoutMs);
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => { child.kill(); finish(reject, aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', (d) => { d = String(d); stdout += d; try { onStdout?.(d); } catch { /* a bad callback must not kill the call */ } });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, fail('transient', `cannot start a local command: ${e.message}`)));
    child.on('close', (code) => {
      if (code === null) return finish(reject, fail('transient', 'the local command was killed'));
      if (code !== 0) return finish(reject, Object.assign(new Error(stderr.trim().slice(-300) || `exit ${code}`), { exitCode: code, stdout, stderr }));
      finish(resolve, { stdout, stderr, exitCode: 0 });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
  return { run: (cmd, opts) => limiter.run(() => once(cmd, opts)), close() {} };
}
