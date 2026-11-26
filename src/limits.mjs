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
export function createStartQueue({ perMin = 25, now = Date.now, sleep = realSleep, quotaRetryMs = QUOTA_RETRY_MS, quotaGiveUpMs = QUOTA_GIVE_UP_MS, maxTries = MAX_START_TRIES, liveCount, maxRunning, tierName, profileBusy, softPollMs = 5000, softWaitMs = 10 * MINUTE } = {}) {
  const waiting = []; // { a, grant, reject }
  const stamps = []; // times of recent create attempts
  const sleeping = new Map(); // agent -> cancel function while it sleeps between retries
  let pumping = false;
  const rate = () => (typeof perMin === 'function' ? perMin() : perMin); // read on every grant, so a rate learned later applies
  const reasons = new Map(); // current queue wait reason per agent
  let wake; // ends the pump's wait for the oldest start to age out
  const q = { waiting, pace: rate, poke: () => wake?.() }; // poke: the rate changed, so recheck now
  // A global machine cap or start-rate cap holds the whole queue. A profile cap holds only that profile's requests, so an
  // eligible request behind it can start. The first eligible request wins, preserving FIFO among requests that can start.
  // Capacity waits are local and bounded by softWaitMs; after that the API decides.
  const full = (e) => { const max = maxRunning?.(); return max > 0 && now() - e.t0 < softWaitMs && liveCount?.(e.a) >= max; };
  // Give every waiting agent the note it would show in cloud_agent_list (same wording as queuedText in run-subagent.mjs) and emit it only when it changes; the dashboard reads the note from the event.
  const labelWaiting = (notes) => waiting.forEach(({ a }, i) => {
    const why = notes[i];
    const n = why && (i ? `queued, ${i} ahead: ${why}` : why);
    if (why) reasons.set(a, why); else reasons.delete(a);
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
      const headFull = full(head);
      const profileNotes = headFull ? waiting.map(() => undefined) : waiting.map(({ a }) => profileBusy?.(a));
      const rateFull = stamps.length >= rate();
      const eligibleIndex = profileNotes.findIndex((note) => !note);
      const candidateFull = !headFull && eligibleIndex >= 0 && full(waiting[eligibleIndex]);
      const machineFull = headFull || candidateFull;
      const blockedBy = headFull ? head : candidateFull ? waiting[eligibleIndex] : undefined;
      const machineNote = blockedBy && `waiting for a free machine slot (${liveCount(blockedBy.a, true)} running on the ${tierName?.() ? `${tierName()} ` : ''}plan)`;
      const grantIndex = machineFull || rateFull ? -1 : eligibleIndex;
      if (grantIndex >= 0) {
        const entry = waiting.splice(grantIndex, 1)[0];
        reasons.delete(entry.a);
        if (entry.a.queueNote) { delete entry.a.queueNote; entry.a.emit?.({ type: 'status', status: 'starting' }); }
        stamps.push(now()); entry.grant(); await new Promise(setImmediate); /* let the create start before the next grant */
      } else {
        labelWaiting(waiting.map((_, i) => machineNote || profileNotes[i]));
        if (machineFull || profileNotes.some(Boolean)) ms = softPollMs;
        else if (rateFull) ms = stamps[0] + MINUTE - now();
        if (ms !== undefined) await Promise.race([sleep(ms), new Promise((r) => { wake = r; })]);
      }
    }
    pumping = false;
  };
  const slot = (a) => new Promise((grant, reject) => { waiting.push({ a, grant, reject, t0: now() }); if (pumping) wake?.(); pump(); });
  const nap = (a, ms) => new Promise((resolve, reject) => {
    sleeping.set(a, () => reject(new Error('cancelled')));
    sleep(ms).then(resolve, reject);
  }).finally(() => sleeping.delete(a));
  // Agents ahead of a in line; undefined when a is not waiting for a slot (it is retrying later or running).
  q.ahead = (a) => { const i = waiting.findIndex((e) => e.a === a); return i < 0 ? undefined : i; };
  q.reason = (a) => (waiting.some((e) => e.a === a) ? reasons.get(a) : undefined);
  q.cancel = (a) => {
    a.cancelled = true;
    const i = waiting.findIndex((e) => e.a === a);
    if (i >= 0) { waiting.splice(i, 1)[0].reject(new Error('cancelled')); reasons.delete(a); wake?.(); }
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

// Provider errors in a worker's final text (pi, omp, codex, opencode). Harness-neutral: it only reads the words.
// Retryable: model_not_found (a busy or rate-limited model), 429, 5xx and connection errors. Not retryable: 400, 401, 403.
export function classifyProviderError(text) {
  const s = String(text ?? '');
  const status = Number(/\b([45]\d\d)\b/.exec(s)?.[1]) || undefined;
  if (/model_not_found|model[ _]not[ _]found/i.test(s)) return { kind: 'model_not_found', status: status ?? 404, retryable: true };
  if (status === 401 || status === 403 || status === 400) return { kind: 'rejected', status, retryable: false };
  if (status === 429 || /rate.?limit|too many requests/i.test(s)) return { kind: 'rate_limited', status: status ?? 429, retryable: true };
  if (status >= 500) return { kind: 'server_error', status, retryable: true };
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|overloaded|connection (error|reset|refused)/i.test(s)) return { kind: 'connection', status: undefined, retryable: true };
  return null;
}
// One short line for the result: "Provider status: 404 model_not_found". The text is scrubbed by the caller.
export const providerDetail = (text) => {
  const c = classifyProviderError(text);
  return c ? `Provider status: ${[c.status, c.kind].filter(Boolean).join(' ')}` : '';
};
