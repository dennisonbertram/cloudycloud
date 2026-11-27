import './tmp-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/open.mjs';
import { run as openRun } from '../src/open.mjs';
import { run as shellRun } from '../src/shell.mjs';
import { run as machinesRun } from '../src/machines.mjs';

const routedProviders = (calls) => {
  const primary = { name: 'instabox', keyName: 'INSTABOX_API_KEY', caps: { hasShell: false, hasPortForward: false }, text: { noKeyFix: 'setup', apiFix: 'retry', listMachines: 'list' }, delete: async (id) => calls.push(['instabox-delete', id]) };
  const secondary = {
    name: 'boat', keyName: 'BOAT_API_KEY', caps: { hasShell: true, hasPortForward: true, hasPublish: false }, text: { noKeyFix: 'setup boat', apiFix: 'retry boat', listMachines: 'boat list' },
    shellArgv: (id, cmd) => (calls.push(['boat-shell-argv', id, cmd]), ['fake-ssh', id, ...(cmd ?? [])]),
    async forwardPort(id, ports) { calls.push(['boat-open', id, ports]); return 0; },
    async delete(id) { calls.push(['boat-delete', id]); },
  };
  return { ...primary, providers: [primary, secondary], for: (row) => (row.provider === 'boat' ? secondary : primary) };
};

test('a machine event selects the recorded provider when raw machine ids collide', () => {
  const machines = [
    { id: 'same-id', provider: 'instabox', name: 'box-one', status: 'running', state: 'running' },
    { id: 'same-id', provider: 'boat', name: 'box-two', status: 'running', state: 'running' },
  ];
  const events = [
    { t: 1, id: 'agent-1', type: 'agent' },
    { t: 2, id: 'agent-1', type: 'machine', provider: 'boat', machine: 'same-id' },
  ];
  assert.deepEqual(resolveTarget('agent-1', { machines, events, alive: () => true }), machines[1]);
  assert.deepEqual(resolveTarget('boat:same-id', { machines, events: [], alive: () => true }), machines[1]);
  assert.deepEqual(resolveTarget('boat:box-two', { machines, events: [], alive: () => true }), machines[1]);
});

test('a legacy machine event with a colliding raw id refuses to guess a provider', () => {
  const machines = [
    { id: 'same-id', provider: 'instabox', name: 'box-one', status: 'running', state: 'running' },
    { id: 'same-id', provider: 'boat', name: 'box-two', status: 'running', state: 'running' },
  ];
  const events = [
    { t: 1, id: 'agent-1', type: 'agent' },
    { t: 2, id: 'agent-1', type: 'machine', machine: 'same-id' },
  ];
  assert.throws(() => resolveTarget('agent-1', { machines, events, alive: () => true }), /ambiguous|provider/i);
});

test('a conflicting machine name is ambiguous unless provider-qualified', () => {
  const machines = [
    { id: 'id-one', provider: 'instabox', name: 'same-name', status: 'running', state: 'running' },
    { id: 'id-two', provider: 'boat', name: 'same-name', status: 'running', state: 'running' },
  ];
  assert.throws(() => resolveTarget('same-name', { machines, events: [], alive: () => true }), /more than one provider|ambiguous/i);
  assert.equal(resolveTarget('boat:same-name', { machines, events: [], alive: () => true }).id, 'id-two');
});

test('partial lists block bare targets but allow a completed recorded owner', () => {
  const machines = [
    { id: 'shared', provider: 'boat', name: 'box-b', status: 'running', state: 'running' },
  ];
  Object.defineProperties(machines, {
    providerNames: { value: ['instabox', 'boat'] },
    providerErrors: { value: [{ provider: 'instabox', code: 'transient' }] },
  });
  assert.throws(() => resolveTarget('shared', { machines, events: [], alive: () => true }), /Could not list instabox/);
  assert.equal(resolveTarget('boat:shared', { machines, events: [], alive: () => true }).provider, 'boat');
  const events = [{ type: 'agent', id: 'agent-b', t: 1 }, { type: 'machine', id: 'agent-b', t: 2, provider: 'boat', machine: 'shared' }];
  assert.equal(resolveTarget('agent-b', { machines, events, alive: () => true }).provider, 'boat');
  const failedOwner = Object.defineProperties([...machines], { providerNames: { value: ['instabox', 'boat'] }, providerErrors: { value: [{ provider: 'boat', code: 'transient' }] } });
  assert.throws(() => resolveTarget('boat:shared', { machines: failedOwner, events: [], alive: () => true }), /Could not list boat/);
});

test('shell, open, and machine stop call the adapter named by the resolved machine row', async () => {
  const calls = [], provider = routedProviders(calls);
  const rows = [{ id: 'native-1', provider: 'boat', name: 'worker', state: 'running', status: 'running', labels: { purpose: 'cloudy-cloud' } }];
  const events = [{ type: 'agent', id: 'agent-boat', t: 1 }, { type: 'machine', id: 'agent-boat', t: 2, provider: 'boat', machine: 'native-1' }];
  const common = { provider, env: {}, list: async () => rows, events: () => events, alive: () => true, out: () => {}, err: () => {} };
  assert.equal(await shellRun(['agent-boat', '--', 'pwd'], { ...common, spawn: (argv) => (calls.push(['spawn', ...argv]), { status: 0 }) }), 0);
  assert.equal(await openRun(['agent-boat', '8080'], common), 0);
  assert.equal(await machinesRun(['stop', 'boat:native-1'], { ...common, tty: false, out: () => {}, err: () => {} }), 0);
  assert.ok(calls.some((x) => x[0] === 'boat-shell-argv' && x[1] === 'native-1'));
  assert.ok(calls.some((x) => x[0] === 'boat-open' && x[1] === 'native-1'));
  assert.ok(calls.some((x) => x[0] === 'boat-delete' && x[1] === 'native-1'));
  assert.equal(calls.some((x) => x[0] === 'instabox-delete'), false);
});
