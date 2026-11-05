const FOREGROUND_MAX_MS = 600_000; // Instabox caps a foreground command at 10 minutes.

// Returns createSandbox(envs, timeoutMs) for run-subagent. `sdk` is injectable for tests.
export function createInstaboxSandbox(env, sdk) {
  return async (envs, timeoutMs) => {
    const { Sandbox } = sdk ?? (await import('@insforge/instabox-sdk'));
    const sbx = await Sandbox.create('agent-browser', {
      apiKey: env.INSTABOX_API_KEY, envs, metadata: { purpose: 'claude-cloud' }, archiveMs: timeoutMs,
    });
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
