const ARCHIVE_MS = 8 * 60 * 60_000; // backstop; agents are normally stopped sooner.
const FOREGROUND_MAX_MS = 600_000; // Instabox caps a foreground command at 10 minutes.

const API = 'https://api.instabox.sh/v1/machines';
const SECRET_HELP = 'The GH_TOKEN Instabox secret could not be attached to the sandbox. Create it with claude-cloud-setup-github.';

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

// Returns createSandbox(envs) for run-subagent. `sdk`, `fetchFn` and `timing` are injectable for tests.
export function createInstaboxSandbox(env, sdk, fetchFn = fetch, timing) {
  return async (envs) => {
    if (!env.INSTABOX_API_KEY) throw new Error('INSTABOX_API_KEY is not set.');
    const { Sandbox } = sdk ?? (await import('@insforge/instabox-sdk'));
    const sbx = await Sandbox.create('agent-browser', {
      apiKey: env.INSTABOX_API_KEY, envs, metadata: { purpose: 'claude-cloud' }, archiveMs: ARCHIVE_MS,
    });
    try {
      await attachGithubToken(sbx.sandboxId, env.INSTABOX_API_KEY, fetchFn, timing);
    } catch (e) {
      await sbx.kill().catch(() => {});
      throw e;
    }
    return {
      home: '/data/home',
      files: sbx.files,
      kill: () => sbx.kill(),
      commands: {
        async run(cmd, { timeoutMs: ms, ...opts } = {}) {
          if (!(ms > FOREGROUND_MAX_MS)) return sbx.commands.run(cmd, { ...opts, timeoutMs: ms });
          // The SDK does not enforce a timeout on background jobs, so wait() with a deadline and kill on expiry.
          const job = await sbx.commands.run(cmd, { ...opts, background: true });
          try {
            return await job.wait({ timeoutMs: ms });
          } catch (e) {
            if (e?.code === 'job_wait_timeout') {
              await job.kill().catch(() => {});
              throw Object.assign(new Error(`command timed out after ${ms} ms`), { stderr: e.message });
            }
            // Background output is one combined log in stdout; surface it as stderr for run-subagent.
            if (e?.exitCode !== undefined && !e.stderr) e.stderr = e.stdout;
            throw e;
          }
        },
      },
    };
  };
}
