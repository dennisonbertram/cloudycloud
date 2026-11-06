import { createLimiter } from './limits.mjs';

const ARCHIVE_MS = 8 * 60 * 60_000; // backstop; agents are normally stopped sooner.
const FOREGROUND_MAX_MS = 600_000; // Instabox caps a foreground command at 10 minutes.
const WAIT_SLICE_MS = 20_000; // one job.wait() holds a request slot, so wait in short slices.
const MAX_429_TRIES = 8;

const API = 'https://api.instabox.sh/v1/machines';
const SECRET_HELP = 'The GH_TOKEN Instabox secret could not be attached to the sandbox. Create it as described in docs/RUNBOOK.md, step 2.4.';

// Attach the org's GH_TOKEN secret (a proxy placeholder) and wait until Instabox has applied it.
async function attachGithubToken(id, apiKey, fetchFn, { pollMs = 2000, timeoutMs = 60_000 } = {}) {
  const url = `${API}/${encodeURIComponent(id)}/secrets`;
  const call = async (method, body) => {
    const res = await fetchFn(url, {
      method, headers: { 'X-API-Key': apiKey, ...(body && { 'Content-Type': 'application/json' }) }, body,
    }).catch((e) => { throw new Error(`${SECRET_HELP} (${method}: ${e?.message})`); });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let j = {};
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      const e = j.error && typeof j.error === 'object' ? j.error : j;
      const detail = e.code || e.message ? `code ${e.code ?? '?'}: ${e.message ?? ''}${e.hint ? ` (${e.hint})` : ''}` : t.slice(0, 200);
      throw new Error(`${SECRET_HELP} (${method} returned HTTP ${res.status}, ${detail})`);
    }
    return res;
  };
  await call('PATCH', JSON.stringify({ secrets: ['GH_TOKEN'] }));
  const applied = (x) => x?.appliedRevision >= x?.revision;
  for (const deadline = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, pollMs))) {
    const d = await (await call('GET')).json().catch(() => ({}));
    if (applied(d.proxy) && applied(d.guest)) return;
    if (Date.now() >= deadline) throw new Error(`${SECRET_HELP} (not applied within ${timeoutMs / 1000} s)`);
  }
}

let shared; // one limiter for the whole server process
const sharedLimiter = (env) => (shared ??= createLimiter(Number(env.CLAUDE_CLOUD_MAX_INSTABOX_CALLS) > 0 ? Number(env.CLAUDE_CLOUD_MAX_INSTABOX_CALLS) : 24));

// Returns createSandbox(envs) for run-subagent. `owner` is the server instance id the reaper deletes by.
// `sdk`, `fetchFn` and `timing` are injectable for tests. `rt` = { limiter, now, sleep, sliceMs } is too.
// Every command, file and job-wait call goes through one limiter (Instabox allows 32 concurrent requests per account);
// a 429 is retried after a short backoff, outside the slot.
export function createInstaboxSandbox(env, sdk, fetchFn = fetch, timing, owner, rt = {}) {
  const limiter = rt.limiter ?? sharedLimiter(env);
  const now = rt.now ?? Date.now;
  const sleep = rt.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sliceMs = rt.sliceMs ?? WAIT_SLICE_MS;
  const call = async (fn) => {
    for (let n = 1; ; n++) {
      try {
        return await limiter.run(fn);
      } catch (e) {
        if (e?.status !== 429 || n >= MAX_429_TRIES) throw e;
        await sleep(Math.min(1000 * 2 ** (n - 1), 10_000));
      }
    }
  };
  return async (envs) => {
    if (!env.INSTABOX_API_KEY) throw new Error('INSTABOX_API_KEY is not set.');
    const { Sandbox } = sdk ?? (await import('@insforge/instabox-sdk'));
    const sbx = await Sandbox.create('agent-browser', {
      apiKey: env.INSTABOX_API_KEY, envs, metadata: { purpose: 'claude-cloud', owner }, archiveMs: ARCHIVE_MS,
    });
    try {
      await attachGithubToken(sbx.sandboxId, env.INSTABOX_API_KEY, fetchFn, timing);
    } catch (e) {
      await sbx.kill().catch(() => {});
      throw e;
    }
    return {
      home: '/data/home',
      files: { write: (...a) => call(() => sbx.files.write(...a)), read: (...a) => call(() => sbx.files.read(...a)) },
      kill: () => sbx.kill(),
      commands: {
        // opts.onStdout receives output as it is written. opts.signal stops the command (a background job is killed).
        async run(cmd, { timeoutMs: ms, onStdout, signal, ...opts } = {}) {
          if (!(ms > FOREGROUND_MAX_MS)) return call(() => sbx.commands.run(cmd, { ...opts, onStdout, signal, timeoutMs: ms }));
          // The SDK does not enforce a timeout on background jobs, so wait with a deadline and kill on expiry.
          const job = await call(() => sbx.commands.run(cmd, { ...opts, background: true }));
          const kill = () => job.kill().catch(() => {});
          if (signal?.aborted) await kill();
          else signal?.addEventListener('abort', kill, { once: true });
          // wait() replays the whole log from the start on every call, so count the characters already delivered
          // and pass only the new tail to onStdout.
          let delivered = 0;
          const deadline = now() + ms;
          try {
            for (;;) {
              const left = deadline - now();
              if (left <= 0) {
                await kill();
                throw Object.assign(new Error(`command timed out after ${ms} ms`), { stderr: `job still running after ${ms} ms` });
              }
              let pos = 0;
              const fresh = (chunk) => {
                const end = pos + chunk.length, skip = Math.max(0, delivered - pos);
                pos = end;
                if (end <= delivered) return;
                delivered = end;
                return onStdout?.(skip ? chunk.slice(skip) : chunk);
              };
              try {
                return await call(() => { pos = 0; return job.wait({ timeoutMs: Math.min(sliceMs, left), onStdout: fresh }); });
              } catch (e) {
                if (e?.code !== 'job_wait_timeout') throw e; // a slice ended; the job keeps running
              }
            }
          } catch (e) {
            // Background output is one combined log in stdout; surface it as stderr for run-subagent.
            if (e?.exitCode !== undefined && !e.stderr) e.stderr = e.stdout;
            throw e;
          } finally {
            signal?.removeEventListener('abort', kill);
          }
        },
      },
    };
  };
}
