// Error guidance: every tool error says what happened, the likely cause, the next step and, when only the human can
// fix it, what to tell the user. guide(code, detail) returns the text; guideObj returns the same as fields.
// detail: { id, message, seconds, profiles, secret, host, secrets: [values to redact] }.

// Hosts that each secret is swapped for on the way out (Instabox proxy secrets).
export const SECRET_HOSTS = { CLAUDE_CODE_OAUTH_TOKEN: 'api.anthropic.com', ANTHROPIC_API_KEY: 'api.anthropic.com', PARTICLE_API_KEY: 'api.particle.ai', OPENROUTER_API_KEY: 'openrouter.ai', CLOUDY_CLOUD_INSTABOX_API_KEY: 'api.instabox.sh' };

export const setCmd = (d) => `printf %s "$KEY" | npx --yes instabox@latest secrets set ${d.secret} --host ${d.host ?? SECRET_HOSTS[d.secret] ?? '<host>'}`;
const SETTINGS = 'Add it in cloudy-cloud setup: run `cloudy-cloud setup`.';

// [what, cause, next, tell]. Cause text contains "likely" when it is not certain.
const T = {
  model_not_found: (d) => ['The model is not available on this provider.', 'Likely a typo in the model name, or the key has no access to this model.', `Retry once after a wait, or call cloud_agent with another profile (known profiles: ${d.profiles ?? 'see cloud_agent'}).`, 'The key has no access to this model; pick another model or check the provider plan.'],
  rate_limited: (d) => ['The provider is limiting how fast machines or requests start.', 'Likely too many agents started at once.', `Wait ${d.seconds ?? 60} seconds, then retry cloud_agent. Free capacity sooner with cloud_agent_stop on idle agents (see cloud_agent_list).`],
  quota_exceeded: () => ['The provider machine limit is reached.', 'The plan allows no more machines at once.', 'Call cloud_agent_list, then cloud_agent_stop on idle agents, then retry cloud_agent.', 'The plan machine limit is reached; upgrade the plan or wait for machines to finish.'],
  spend_limit: () => ['The Claude spend limit is reached, so no turn can run.', 'The account hit its usage cap.', 'Do not retry now. Call cloud_agent_list to see which agents are affected, and cloud_agent_stop on those you no longer need.', 'Your Claude spend limit is reached; raise it in your Claude usage settings or wait for the reset.'],
  turn_timeout: (d) => ['The turn ran out of time before the agent finished.', 'Likely the task was too large for one turn.', `Call cloud_agent_message with agent_id ${d.id ?? '<id>'} and the message "continue".`],
  login_required: () => ['Claude Code on the machine is not logged in.', 'No valid Claude token reached the machine.', 'Run `claude setup-token`, then `cloudy-cloud setup` and replace the Claude token. Then start the agent again with cloud_agent.', 'Claude login is missing; run `claude setup-token`, then `cloudy-cloud setup`.'],
  mcp_prompt_blocked: () => ['Claude Code is waiting on an interactive prompt that nobody can answer.', 'Likely an MCP server needs approval or a login.', 'Run `cloudy-cloud setup`, then start the agent again with cloud_agent.', 'An MCP server needs approval; approve it in Claude Code or remove it from the repo MCP config.'],
  push_failed: (d) => ['The agent branch could not be pushed to GitHub.', 'Likely the GitHub token cannot write to this repo.', `Call cloud_agent_message with agent_id ${d.id ?? '<id>'} and ask it to commit and push.`, 'The GitHub token cannot write to this repo; run `cloudy-cloud setup` and check the token repository list.'],
  no_origin: () => ['This repo has no origin remote on github.com.', 'Each agent pushes its branch to origin, so one is required.', 'Run `git remote add origin https://github.com/OWNER/REPO.git`, then retry cloud_agent.'],
  token_missing: () => ['The GitHub token is missing.', 'The GH_TOKEN secret was never set up.', 'Run `cloudy-cloud setup` and enter the GitHub token.', 'A GitHub token is needed; create one with write access to this repo and enter it in `cloudy-cloud setup`.'],
  agent_busy: (d) => [`Agent ${d.id ?? ''} is still working.`.replace('  ', ' '), 'Messages are not queued while a turn runs.', `Call cloud_agent_wait with agent_ids ["${d.id ?? '<id>'}"], then send the message.`],
  agent_gone: (d) => [`Agent ${d.id ?? ''} is not open.`.replace('  ', ' '), 'Likely it was stopped, idle for 60 minutes, or never existed.', `Call cloud_agent_list to see open agents. Work it pushed is on origin cloudy-cloud/${d.id ?? '<id>'}: run \`git fetch origin cloudy-cloud/${d.id ?? '<id>'}\`.`],
  agent_failed: (d) => [`Agent ${d.id ?? ''} failed and cannot take messages.`.replace('  ', ' '), 'Its first turn failed or its machine is gone.', `Call cloud_agent_result with agent_id ${d.id ?? '<id>'} to read the error, then cloud_agent_stop.`],
  agent_result_pending: (d) => [`Agent ${d.id ?? ''} has no result yet (status ${d.status ?? 'running'}).`.replace('  ', ' '), 'The current turn has not finished.', `Call cloud_agent_wait with agent_ids ["${d.id ?? '<id>'}"].`],
  invalid_args: (d) => ['The call was not accepted (see the message).', 'The arguments of the call, or the state it needs, were not accepted.', `Correct the call as the message says, then call ${d.tool ?? 'cloud_agent'} again.`],
  worker_error: (d) => [`The turn of agent ${d.id ?? ''} ended with an error (details above).`.replace('  ', ' '), 'See the error text above.', `Call cloud_agent_message with agent_id ${d.id ?? '<id>'} to retry or fix it, or cloud_agent_stop if the agent is not needed.`],
  secret_missing: (d) => [`The Instabox secret ${d.secret} is not in your org.`, 'The secret was never created, or it was created under another name.', `Run \`cloudy-cloud setup\` or: \`${setCmd(d)}\`.`, `The ${d.secret} secret is missing; paste the key when \`cloudy-cloud setup\` asks.`],
  secret_not_applied: (d) => ['Instabox did not apply the secrets to the machine in 60 seconds.', 'Likely Instabox is slow right now.', `Retry cloud_agent. If it repeats, run \`npx instabox@latest secrets show ${d.id ?? '<machine>'}\`.`],
  secret_host_mismatch: (d) => [`The provider host ${d.host ?? '<host>'} is not in the host list of secret ${d.secret}.`, 'Likely the secret was created for other hosts, so the placeholder reached the provider unswapped (HTTP 401).', `Run \`${setCmd(d)}\` with every host the secret needs, and paste the key again.`, `The ${d.secret} secret does not cover ${d.host ?? 'this provider'}; paste the key again when asked.`],
  key_on_machine_refused: (d) => ['A real key was about to be placed on a machine whose provider keeps keys off machines.', 'The key was passed the old way, not as a proxy secret.', d.secret
    ? `Run \`${setCmd(d)}\`, add ${d.secret} to CLOUDY_CLOUD_PROXY_SECRETS in ~/.config/cloudy-cloud/env (comma-separated), then delete the plain ${d.secret}= line from that file. (\`cloudy-cloud setup\` only moves the built-in keys.)`
    : 'Run `cloudy-cloud setup`, which stores keys as proxy secrets.'],
  secret_set_needs_login: () => ['Instabox refused to create the secret (missing_scope).', 'An API key cannot create secrets; a logged-in session can.', 'Run `npx --yes instabox@latest login`, then run `cloudy-cloud setup` again.', 'Instabox needs you to log in; run `npx --yes instabox@latest login` in your terminal.'],
};
export const CODES = Object.keys(T);
export const HUMAN_CODES = CODES.filter((c) => T[c]({})[3]);
export const UNCERTAIN_CODES = CODES.filter((c) => /likely/i.test(T[c]({})[1]));

const scrubber = (d) => (s) => (d.secrets ?? []).filter(Boolean).reduce((t, v) => t.split(v).join('[redacted]'), String(s));

export function guideObj(code, d = {}) {
  const s = scrubber(d);
  const [what, cause, next, tell] = T[code]?.(d) ?? [
    `Something failed: ${d.message ?? 'unknown error'}`, 'Likely a cause cloudy-cloud does not recognise.',
    'Call cloud_agent_list to see the state of every agent, then retry. If it repeats, report it at https://github.com/dennisonbertram/cloudycloud/issues with the message above.',
    'An unexpected error occurred; if it repeats, report it with the message above.'];
  return { code: T[code] ? code : 'unknown', whatHappened: s(what), likelyCause: s(cause), nextStep: s(next), tellUser: tell ? s(tell) : undefined };
}

export function guide(code, d = {}) {
  const o = guideObj(code, d);
  return [`What happened: ${o.whatHappened}`, `Likely cause: ${o.likelyCause}`, `Next step: ${o.nextStep}`, o.tellUser && `Tell the user: ${o.tellUser}`].filter(Boolean).join('\n');
}

// Maps raw error text to a code.
export function classify(text) {
  const s = String(text);
  if (/spend limit|usage limit/i.test(s)) return 'spend_limit';
  if (/quota_exceeded/.test(s)) return 'quota_exceeded';
  if (/rate_limited/.test(s)) return 'rate_limited';
  if (/model.{0,20}not found|not_found_error/i.test(s)) return 'model_not_found';
  if (/not logged in|\/login/i.test(s)) return 'login_required';
  return 'unknown';
}
