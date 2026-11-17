// Tests every provider must pass. Usage: contractSuite('name', ({ withKey }) => provider).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CAPS = ['hasServerTTL', 'hasProxySecrets', 'hasSnapshots', 'hasPortForward', 'hasPublish', 'maxForegroundMs', 'maxTtlSeconds', 'startsPerMin', 'maxConcurrentCalls', 'uploadMaxBytes'];
const create = (p, labels, extra = {}) => p.create({ image: 'agent-browser', envs: {}, labels, ttlSeconds: 3600, ...extra });

// kindsSkip: a reason to skip the kinds check explicitly (shown as skipped) for an adapter that does not have the caps yet.
export function contractSuite(name, makeProvider, { kindsSkip } = {}) {
  test(`${name}: provider has a name, key name, caps and the full method set`, () => {
    const p = makeProvider({ withKey: true });
    assert.ok(p.name && p.keyName);
    for (const c of CAPS) assert.ok(c in p.caps, `caps.${c}`);
    for (const m of ['create', 'connect', 'list', 'delete', 'snapshot', 'getSnapshot', 'forwardPort', 'publishPort', 'unpublishPort', 'localMachineName'])
      assert.equal(typeof p[m], 'function', m);
    for (const t of ['ssh']) assert.equal(typeof p.text[t], 'function');
    for (const t of ['listMachines', 'noKeyFix', 'apiFix', 'githubTokenHelp']) assert.equal(typeof p.text[t], 'string', t);
  });

  test(`${name}: kinds, shell and display follow the caps`, { skip: kindsSkip }, async () => {
    const p = makeProvider({ withKey: true });
    assert.ok(p.caps.machineKinds, 'caps.machineKinds');
    assert.ok(Array.isArray(p.caps.machineKinds) && p.caps.machineKinds.includes('linux'));
    assert.equal(typeof p.caps.hasShell, 'boolean');
    assert.equal(typeof p.caps.hasDisplay, 'boolean');
    for (const m of ['shellArgv', 'displayLink', 'revokeDisplayLinks', 'screenshot']) assert.equal(typeof p[m], 'function', m);
    if (p.caps.hasShell) assert.ok(p.shellArgv('m1').every((a) => typeof a === 'string'));
    const bad = ['linux', 'android', 'omarchy', 'gpu', 'macos'].find((k) => !p.caps.machineKinds.includes(k));
    if (bad) await assert.rejects(create(p, {}, { kind: { name: bad } }), (e) => e.code === 'machine_kind_unsupported');
    if (!p.caps.hasDisplay) await assert.rejects(p.displayLink('m1', {}), (e) => e.code === 'display_unsupported');
  });

  test(`${name}: create returns a Sandbox`, async () => {
    const s = await create(makeProvider({ withKey: true }), { purpose: 'cloudy-cloud' });
    try {
      assert.equal(typeof s.id, 'string');
      assert.equal(typeof s.home, 'string');
      assert.equal(typeof s.files.write, 'function');
      assert.equal(typeof s.files.read, 'function');
      assert.equal(typeof s.commands.run, 'function');
      assert.equal(typeof s.kill, 'function');
    } finally { await s.kill(); }
  });

  test(`${name}: list filters by every label given`, async () => {
    const p = makeProvider({ withKey: true });
    const a = await create(p, { purpose: 'cloudy-cloud', owner: 'o1' });
    const b = await create(p, { purpose: 'cloudy-cloud', owner: 'o2' });
    try {
      const ids = async (l) => (await p.list(l)).map((m) => m.id);
      assert.deepEqual(await ids({ owner: 'o1' }), [a.id]);
      assert.deepEqual((await ids({ purpose: 'cloudy-cloud' })).sort(), [a.id, b.id].sort());
      assert.deepEqual(await ids({ purpose: 'cloudy-cloud', owner: 'o2' }), [b.id]);
      assert.deepEqual(await ids({ purpose: 'cloudy-cloud', owner: 'none' }), []);
      const row = (await p.list({ owner: 'o1' }))[0];
      assert.ok(['starting', 'running', 'stopped', 'failed'].includes(row.status));
    } finally { await a.kill(); await b.kill(); }
  });

  test(`${name}: metrics follows caps.hasMetrics`, async () => {
    const p = makeProvider({ withKey: true });
    assert.equal(typeof p.metrics, 'function');
    assert.equal(typeof p.caps.hasMetrics, 'boolean');
    if (!p.caps.hasMetrics) await assert.rejects(p.metrics('m1'), (e) => e.code === 'metrics_unsupported');
  });

  test(`${name}: plan resolves an object or null`, async () => {
    const r = await makeProvider({ withKey: true }).plan();
    assert.ok(r === null || typeof r.startsPerMinute === 'number');
  });

  test(`${name}: delete of an unknown id resolves`, async () => {
    await makeProvider({ withKey: true }).delete('no-such-machine');
  });

  test(`${name}: snapshot follows caps.hasSnapshots`, async () => {
    const p = makeProvider({ withKey: true });
    const s = await create(p, { purpose: 'cloudy-cloud' });
    try {
      if (p.caps.hasSnapshots) {
        const snap = await p.snapshot(s, { name: 'n', description: 'd' });
        assert.ok(snap.id && snap.status);
        assert.equal((await p.getSnapshot(snap.id)).id, snap.id);
      } else await assert.rejects(p.snapshot(s, { name: 'n' }));
    } finally { await s.kill(); }
  });

  test(`${name}: a missing key throws code no_key`, async () => {
    const p = makeProvider({ withKey: false });
    await assert.rejects(create(p, {}), (e) => e.code === 'no_key');
  });
}
