// Select the adapter that owns a listed machine. Single-provider callers retain the old shape.
export function providerFor(provider, machine) {
  const selected = provider?.for?.(machine);
  if (machine?.provider && provider?.for && !selected) {
    throw Object.assign(new Error(`Machine ${machine.id} belongs to provider ${machine.provider}, which is not configured.`), { code: 'not_found' });
  }
  return selected ?? provider;
}

export const machineKey = (machine) => `${machine?.provider ?? ''}\0${machine?.id ?? ''}`;

export function qualifiedMachine(token, rows) {
  const split = String(token).indexOf(':');
  if (split < 1) return undefined;
  const provider = token.slice(0, split), target = token.slice(split + 1);
  const matches = rows.filter((m) => m.provider === provider && (m.id === target || m.name === target || m.cname === target || m.machineName === target));
  if (matches.length > 1) throw Object.assign(new Error(`"${token}" matches multiple machines on ${provider}; use the machine ID.`), { code: 'ambiguous' });
  return matches[0];
}

export function assertProviderListed(rows, providerName, target) {
  const errors = rows?.providerErrors ?? [];
  const known = rows?.providerNames ?? [];
  const relevant = providerName && known.includes(providerName) ? errors.filter((e) => !e.provider || e.provider === providerName) : providerName ? [] : errors;
  if (!relevant.length) return;
  const providers = [...new Set(relevant.map((e) => e.provider).filter(Boolean))].join(', ') || 'a configured provider';
  throw Object.assign(new Error(`Could not list ${providers}, so ${target} cannot be resolved safely. Retry when that provider is reachable, or use provider:id for a provider that was listed.`), { code: 'provider_list_incomplete', provider: providers });
}
