// Machine kinds: the one `machine` string (cloud_agent argument, `--machine` flag) parsed once for every caller.
// Forms: linux | android | omarchy | gpu[:TYPE[:COUNT]] | macos[:MODEL]. `gpu` is Instabox's `--gpu TYPE[:COUNT]` value.
export const KINDS = ['linux', 'android', 'omarchy', 'gpu', 'macos'];
export const EXPENSIVE = ['gpu', 'macos']; // refused until CLOUDY_CLOUD_ALLOW_MACHINE_KINDS names them

// Price lines shown when asking for consent. Source: https://instabox.sh/docs/account/pricing.md
export const PRICE = {
  gpu: 'GPU machines cost from $0.765 per GPU-hour (L4) to $4.17 per GPU-hour (H100)',
  macos: 'Mac machines cost $0.45 to $1.25 per hour by model, with a 24-hour minimum lease (the API reported $0.85 per hour and a $20.40 minimum on 2026-11-15)',
};

export const FORMS = 'linux, android, omarchy, gpu[:TYPE[:COUNT]] (COUNT 1-8), macos[:MODEL]';
const WORD = /^[a-z0-9-]+$/;

/** @returns {{ name: string, gpu?: string, model?: string, label: string } | { error: string }} */
export function parseMachine(str) {
  const s = String(str ?? '').trim().toLowerCase() || 'linux';
  const [name, a, b, ...rest] = s.split(':');
  const bad = { error: `Unknown machine "${str}". Accepted forms: ${FORMS}.` };
  if (!KINDS.includes(name) || rest.length) return bad;
  if (name === 'gpu') {
    if (a === undefined) return { name, label: s };
    if (!WORD.test(a) || (b !== undefined && !/^[1-8]$/.test(b))) return bad;
    return { name, gpu: b ? `${a}:${b}` : a, label: s };
  }
  if (name === 'macos') {
    if (a === undefined) return { name, label: s };
    return WORD.test(a) && b === undefined ? { name, model: a, label: s } : bad;
  }
  return a === undefined ? { name, label: s } : bad;
}
