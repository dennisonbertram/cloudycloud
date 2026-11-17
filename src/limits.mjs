// Two small schedulers. Both take an injected clock and sleep so tests can run them on fake time.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const MINUTE = 60_000;
export const MAX_START_TRIES = 5; // rate_limited retries per agent
export const QUOTA_RETRY_MS = 60_000;
export const QUOTA_GIVE_UP_MS = 30 * MINUTE;

// Global cap on concurrent provider command/file calls. FIFO. run(fn) holds one slot while fn runs.
export function createLimiter(max) {
  const waiting = [];
  const l = { active: 0, peak: 0 };
  const next = () => {
    while (l.active < max && waiting.length) {
      l.active++;
      l.peak = Math.max(l.peak, l.active);
      waiting.shift()();
    }
  };
  l.run = async (fn) => {
    await new Promise((r) => { waiting.push(r); next(); });
    try { return await fn(); } finally { l.active--; next(); }
  };
  return l;
}

const code = (e) => `${e?.code ?? ''} ${e?.message ?? ''}`;
export const isRateLimited = (e) => /rate_limited/.test(code(e));
export const isQuotaExceeded = (e) => /quota_exceeded|concurrency_limit/.test(code(e)); // concurrency_limit: too many machines running at once (#129), retried the same way

// Start queue: at most perMin (a number or a function returning one) machine creates per rolling minute, in arrival order.
// create(a, fn) waits for a slot, runs fn (the machine create) and retries it on rate_limited / quota_exceeded.
// a.status is 'queued' while it waits and 'starting' while fn runs. cancel(a) makes a pending create() reject.
export function createStartQueue({ perMin = 25, now = Date.now, sleep = realSleep, quotaRetryMs = QUOTA_RETRY_MS, quotaGiveUpMs = QUOTA_GIVE_UP_MS, maxTries = MAX_START_TRIES, liveCount, maxRunning, tierName, softPollMs = 5000, softWaitMs = 10 * MINUTE } = {}) {
  const waiting = []; // { a, grant, reject }
  const stamps = []; // times of recent create attempts
  const sleeping = new Map(); // agent -> cancel function while it sleeps between retries
  let pumping = false;
  const rate = () => (typeof perMin === 'function' ? perMin() : perMin); // read on every grant, so a rate learned later applies
  let capNote; // why the head waits when the plan's running limit holds the line; everyone behind it waits for the same reason
  let wake; // ends the pump's wait for the oldest start to age out
  const q = { waiting, pace: rate, poke: () => wake?.() }; // poke: the rate changed, so recheck now
  // Admission is strictly FIFO: only the head is checked. It needs a free rate slot and, when the plan caps running machines,
  // free capacity (live count excludes the head's own agent). Capacity waits are local and bounded by softWaitMs; after that the API decides.
  const full = (e) => { const max = maxRunning?.(); return max > 0 && now() - e.t0 < softWaitMs && liveCount?.(e.a) >= max; };
  // Give every waiting agent the note it would show in cloud_agent_list (same wording as queuedText in run-subagent.mjs) and emit it only when it changes; the dashboard reads the note from the event.
  const labelWaiting = () => waiting.forEach(({ a }, i) => {
    const n = capNote && (i ? `queued, ${i} ahead: ${capNote}` : capNote);
    if (a.queueNote === n || (!a.queueNote && !n)) return;
    if (n) a.queueNote = n; else delete a.queueNote;
    a.emit?.({ type: 'status', status: 'queued', ...(n && { note: n }) });
  });
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (waiting.length) {
      const head = waiting[0];
      while (stamps.length && now() - stamps[0] >= MINUTE) stamps.shift();
      let ms;
      if (full(head)) {
        capNote = `waiting for a free machine slot (${liveCount(head.a, true)} running on the ${tierName?.() ? `${tierName()} ` : ''}plan)`;
        ms = softPollMs;
      } else if (stamps.length >= rate()) ms = stamps[0] + MINUTE - now();
      if (!full(head)) capNote = undefined;
      if (ms !== undefined) labelWaiting();
      else if (head.a.queueNote) { delete head.a.queueNote; head.a.emit?.({ type: 'status', status: 'starting' }); } // the note ends when the machine starts; the dashboard clears it from this event
      if (ms === undefined) { stamps.push(now()); waiting.shift().grant(); await new Promise(setImmediate); /* let the create start before the next grant */ } else await Promise.race([sleep(ms), new Promise((r) => { wake = r; })]);
    }
    pumping = false;
  };
  const slot = (a) => new Promise((grant, reject) => { waiting.push({ a, grant, reject, t0: now() }); if (pumping) labelWaiting(); pump(); });
  const nap = (a, ms) => new Promise((resolve, reject) => {
    sleeping.set(a, () => reject(new Error('cancelled')));
    sleep(ms).then(resolve, reject);
  }).finally(() => sleeping.delete(a));
  // Agents ahead of a in line; undefined when a is not waiting for a slot (it is retrying later or running).
  q.ahead = (a) => { const i = waiting.findIndex((e) => e.a === a); return i < 0 ? undefined : i; };
  q.reason = (a) => (capNote && waiting.some((e) => e.a === a) ? capNote : undefined);
  q.cancel = (a) => {
    a.cancelled = true;
    const i = waiting.findIndex((e) => e.a === a);
    if (i >= 0) { waiting.splice(i, 1)[0].reject(new Error('cancelled')); wake?.(); }
    sleeping.get(a)?.();
  };
  q.create = async (a, fn) => {
    let tries = 0, quotaSince;
    for (;;) {
      if (a.cancelled) throw new Error('cancelled');
      a.status = 'queued';
      await slot(a);
      if (a.cancelled) throw new Error('cancelled');
      a.status = 'starting';
      try {
        return await fn();
      } catch (e) {
        if (a.cancelled) throw e;
        if (isRateLimited(e) && ++tries < maxTries) {
          const s = e.retryAfterSeconds ?? e.retryAfter;
          a.status = 'queued';
          await nap(a, (typeof s === 'number' && s > 0 ? s : 60) * 1000 * tries); // backoff: 1x, 2x, 3x ...
        } else if (isQuotaExceeded(e) && now() - (quotaSince ??= now()) < quotaGiveUpMs) {
          a.status = 'queued';
          await nap(a, quotaRetryMs);
        } else throw e;
      }
    }
  };
  return q;
}
