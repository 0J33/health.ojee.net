/* ============================================================
   health.ojee.net — the scheduler: everybody's sync, on one clock.

   For each person with Google connected:
     - sync every 20 minutes; people who have not opened the app for
       14 days drop to every 6 hours;
     - first runs are staggered and every run has jitter, so a
       restart does not fire everyone at Google at once;
     - at most N syncs are in flight;
     - a 429 (or any failure) backs off THAT person only, by what the
       poller itself says (core/sync.js nextDelay: Retry-After, or a
       doubling backoff), and nobody else waits for it.

   After a sync the app recomputes that person's capabilities, public
   rows, records and notifications (app.afterSync).

   The sitting nudge needs fresher steps than that. For the people who
   switched it on, and only while it may speak (their days, their hours,
   not their quiet hours: `steps` on the person), their recent step
   windows are read about every 15 minutes: staggered, inside the same
   in-flight limit, after the syncs that are due, and never while that
   person is waiting out a 429. Everyone else costs nothing extra.

   A second, lighter pass every minute runs the workout check for the
   people who opted in to detection (or have a workout open), and the
   time-of-day notifications.
   ============================================================ */

export class Scheduler {
  /**
   * @param {object} o
   * @param {Function} o.people      () => [{ userId, googleState, lastSeenAt, detect, extra }]  (extra: Hevy or Strava to read)
   * @param {Function} o.sync        async (userId) => { ok, code, nextInMs }
   * @param {Function} o.minute      async (userId, { detect }) => void
   * @param {Function} o.steps       async (userId) => { ok, code, nextInMs } — the step-window read;
   *                                 run for people() entries with `steps: true`
   */
  constructor({ people, sync, minute, steps = null, stepsEveryMs = 15 * 60_000, intervalMs = 20 * 60_000, idleMs = 6 * 3_600_000, idleAfterMs = 14 * 86_400_000, maxInFlight = 3, now = () => Date.now(), random = Math.random, log = () => {} }) {
    Object.assign(this, { people, syncFn: sync, minuteFn: minute, stepsFn: steps, stepsEveryMs, intervalMs, idleMs, idleAfterMs, maxInFlight, now, random, log });
    this.nextAt = new Map();     // userId -> when their next sync is due
    this.backoff = new Map();    // userId -> until when Google asked them to wait
    this.stepsAt = new Map();    // userId -> when their next step-window read is due
    this.inFlight = new Set();
    this.stats = { runs: 0, failures: 0, lastRunAt: null, stepReads: 0 };
    this.timer = null; this.minuteTimer = null; this.minuteBusy = false;
  }

  start(tickMs = 15_000) {
    this.stop();
    this.timer = setInterval(() => { this.tick().catch((e) => this.log(`scheduler: ${e.message}`)); }, tickMs);
    this.timer.unref?.();
    this.minuteTimer = setInterval(() => { this.minute().catch((e) => this.log(`scheduler: ${e.message}`)); }, 60_000);
    this.minuteTimer.unref?.();
  }
  stop() { clearInterval(this.timer); clearInterval(this.minuteTimer); this.timer = null; this.minuteTimer = null; }

  /** How long between this person's syncs when all is well. */
  intervalFor(p) {
    const idle = this.now() - (p.lastSeenAt || 0) > this.idleAfterMs;
    return idle ? this.idleMs : this.intervalMs;
  }
  #jitter(ms) { return Math.round(ms * (0.9 + 0.2 * this.random())); }

  /** Make somebody due now (they just connected, or pressed Sync). */
  poke(userId) { this.nextAt.set(String(userId), 0); }
  forget(userId) { this.nextAt.delete(String(userId)); this.backoff.delete(String(userId)); this.stepsAt.delete(String(userId)); }
  dueAt(userId) { return this.nextAt.get(String(userId)) ?? null; }
  backoffUntil(userId) { const t = this.backoff.get(String(userId)); return t && t > this.now() ? t : null; }

  /** Record a run's outcome (also used when a sync was started by hand). */
  settle(p, result) {
    const id = String(p.userId);
    this.stats.runs += 1; this.stats.lastRunAt = this.now();
    if (result?.ok) {
      this.backoff.delete(id);
      this.nextAt.set(id, this.now() + this.#jitter(this.intervalFor(p)));
      return;
    }
    this.stats.failures += 1;
    // The poller's own backoff: Retry-After for a 429, doubling otherwise,
    // six hours for a grant that needs the person.
    const wait = Math.max(60_000, result?.nextInMs || 2 * 60_000);
    this.nextAt.set(id, this.now() + wait);
    if (result?.code === 'rate_limited') this.backoff.set(id, this.now() + wait);
  }

  async tick() {
    const now = this.now();
    // Google connected, or another source to read (Hevy, Strava) even without it.
    const people = this.people().filter((p) => p.googleState === 'ok' || p.extra);
    const known = new Set(people.map((p) => String(p.userId)));
    for (const id of this.nextAt.keys()) if (!known.has(id)) this.nextAt.delete(id);
    for (const id of this.stepsAt.keys()) if (!known.has(id)) this.stepsAt.delete(id);
    // Somebody new to the clock: spread first runs over the first two minutes.
    for (const p of people) if (!this.nextAt.has(String(p.userId))) this.nextAt.set(String(p.userId), now + Math.round(this.random() * 120_000));
    const due = people.filter((p) => !this.inFlight.has(String(p.userId)) && this.nextAt.get(String(p.userId)) <= now)
      .sort((a, b) => this.nextAt.get(String(a.userId)) - this.nextAt.get(String(b.userId)));
    const started = [];
    for (const p of due) {
      if (this.inFlight.size >= this.maxInFlight) break;
      started.push(this.#run(p));
    }
    if (this.stepsFn) {
      const want = people.filter((p) => p.steps);
      for (const p of want) {
        const id = String(p.userId);
        const at = this.stepsAt.get(id);
        // New to this clock, or back after hours away: spread the first read
        // over a third of the interval, so nine o'clock is not a stampede.
        if (at === undefined || at < now - this.stepsEveryMs) this.stepsAt.set(id, now + Math.round(this.random() * this.stepsEveryMs / 3));
      }
      const ready = want.filter((p) => { const id = String(p.userId); return !this.inFlight.has(id) && this.stepsAt.get(id) <= now && !this.backoffUntil(id); })
        .sort((a, b) => this.stepsAt.get(String(a.userId)) - this.stepsAt.get(String(b.userId)));
      for (const p of ready) {
        if (this.inFlight.size >= this.maxInFlight) break;
        started.push(this.#runSteps(p));
      }
    }
    return Promise.all(started);
  }

  async #runSteps(p) {
    const id = String(p.userId);
    this.inFlight.add(id);
    let result;
    try {
      result = await this.stepsFn(id);
    } catch (e) {
      result = { ok: false, code: 'error', message: e.message };
      this.log(`steps ${id.slice(-6)}: ${e.message}`);
    } finally {
      this.inFlight.delete(id);
    }
    const now = this.now();
    this.stats.stepReads += 1;
    if (result?.code === 'rate_limited') {
      // Google asked this person to wait: their sync waits with it.
      const wait = Math.max(60_000, result.nextInMs || 2 * 60_000);
      this.backoff.set(id, now + wait);
      this.stepsAt.set(id, now + wait);
      this.nextAt.set(id, Math.max(this.nextAt.get(id) || 0, now + wait));
    } else {
      this.stepsAt.set(id, now + this.#jitter(this.stepsEveryMs));
    }
    return result;
  }

  async #run(p) {
    const id = String(p.userId);
    this.inFlight.add(id);
    let result;
    try {
      result = await this.syncFn(id);
    } catch (e) {
      result = { ok: false, code: 'error', message: e.message };
      this.log(`sync ${id.slice(-6)}: ${e.message}`);
    } finally {
      this.inFlight.delete(id);
    }
    this.settle(p, result);
    return result;
  }

  async minute() {
    if (this.minuteBusy) return;
    this.minuteBusy = true;
    try {
      for (const p of this.people()) {
        if (p.googleState !== 'ok' && p.googleState !== 'expired') continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.minuteFn(String(p.userId), { detect: !!p.detect });
        } catch (e) { this.log(`minute ${String(p.userId).slice(-6)}: ${e.message}`); }
      }
    } finally { this.minuteBusy = false; }
  }
}
