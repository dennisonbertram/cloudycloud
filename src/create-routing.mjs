import { classifyProviderError, isQuotaExceeded, isRateLimited } from './limits.mjs';

// A create can be retried on another provider only when the adapter identifies a refusal that
// happens before allocation. Transport failures need exact-label reconciliation first.
export function classifyCreateFailure(error) {
  const code = String(error?.code ?? '');
  // An explicit uncertain-create code wins over message text: a transient error that merely
  // mentions quota or rate limits still needs exact-label reconciliation first.
  if (['transient', 'create_unknown', 'ambiguous'].includes(code)) return 'reconcile';
  if (isRateLimited(error) || isQuotaExceeded(error) || ['no_key', 'machine_no_capacity',
    'size_not_allowed', 'machine_not_on_plan', 'machine_gpu_limit'].includes(code)) return 'next';
  if (!code && classifyProviderError(error?.message)?.kind === 'connection') return 'reconcile';
  return undefined;
}

const ambiguous = (provider, message, extra = {}) => Object.assign(
  new Error(message), { code: 'ambiguous', provider: provider.name, ...extra },
);

// Reconcile a failed create with labels that identify exactly one owned machine. Never return
// a bare ID: provider identity is part of the selector because IDs can collide across adapters.
export async function reconcileCreate(provider, labels) {
  let rows;
  let listError;
  try {
    rows = await provider.list(labels, { onError: (error) => { listError ??= error; } });
    if (listError) throw listError;
  } catch (error) {
    throw ambiguous(provider, `Provider ${provider.name} returned an uncertain create and its machines could not be listed; refusing another create.`, { cause: error });
  }
  const matches = rows.filter((machine) => Object.entries(labels).every(([key, value]) => machine.labels?.[key] === value));
  if (matches.length !== 1) {
    const ids = matches.map((machine) => String(machine.id));
    const owners = ids.map((machine_id) => ({ provider: provider.name, machine_id, selector: `${provider.name}:${machine_id}` }));
    const label = labels.agent ? `agent ${labels.agent}` : `owner ${labels.owner ?? 'labels'}`;
    throw ambiguous(provider, matches.length
      ? `Provider ${provider.name} returned an uncertain create and multiple machines carry ${label}; refusing to select one.`
      : `Provider ${provider.name} returned an uncertain create and no matching machine could be confirmed; refusing another create.`,
    { machineIds: ids, owners });
  }
  let sandbox;
  try { sandbox = await provider.connect(matches[0].id); }
  catch (error) {
    const machineId = String(matches[0].id);
    throw ambiguous(provider, `Provider ${provider.name} returned an uncertain create; machine ${machineId} could not be connected, so another create was refused.`, {
      machineIds: [machineId], owners: [{ provider: provider.name, machine_id: machineId, selector: `${provider.name}:${machineId}` }], cause: error,
    });
  }
  const machineId = String(matches[0].id);
  return {
    sandbox,
    machine: matches[0],
    owner: { provider: provider.name, machine_id: machineId, selector: `${provider.name}:${machineId}` },
    reconciled: true,
  };
}
