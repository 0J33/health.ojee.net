/* ============================================================
   health.ojee.net — one person's poller.

   The device syncs to the phone, the phone to Google, and this reads
   Google: minutes to hours behind the wrist, whatever we do. So it
   is run on a slow clock (20 min, by scheduler.js; `auto` lets one
   instance keep its own timer instead), asks only for what can
   have changed since last time — plus a few days back, because last
   night's HRV and a day's step total are revised after the fact —
   and backs off hard when Google or the network says no.

   One run walks a fixed list of streams. A stream whose scope was not
   granted is skipped, not failed. One stream failing does not stop
   the others; an auth failure, a 429 or a dead network stops the run.
   ============================================================ */

import {
  parseRollup, parseDaily, parseSleep, parseExercise, parseWeight, parseBodyFat, latestHeartRate, pickDevice,
} from './parse.js';
import { SCOPES } from './google.js';
import { today as todayIn, addDays, sleepFor } from './util.js';

export const BACKFILL_DAYS = 90;
const OVERLAP_DAYS = 3;
const ROLLUP_CHUNK = 14;          // total-calories caps a roll-up at 14 days
const BACKOFF_MIN = 2 * 60_000;
const BACKOFF_MAX = 6 * 3_600_000;

export const STREAMS = [
  { key: 'steps', kind: 'rollup', type: 'steps', scope: 'activity' },
  { key: 'azm', kind: 'rollup', type: 'active-zone-minutes', scope: 'activity' },
  { key: 'activeMinutes', kind: 'rollup', type: 'active-minutes', scope: 'activity' },
  { key: 'kcal', kind: 'rollup', type: 'total-calories', scope: 'activity' },
  { key: 'distance', kind: 'rollup', type: 'distance', scope: 'activity' },
  { key: 'rhr', kind: 'daily', type: 'daily-resting-heart-rate', field: 'daily_resting_heart_rate', scope: 'metrics' },
  { key: 'hrv', kind: 'daily', type: 'daily-heart-rate-variability', field: 'daily_heart_rate_variability', scope: 'metrics' },
  { key: 'spo2', kind: 'daily', type: 'daily-oxygen-saturation', field: 'daily_oxygen_saturation', scope: 'metrics' },
  { key: 'temp', kind: 'daily', type: 'daily-sleep-temperature-derivations', field: 'daily_sleep_temperature_derivations', scope: 'metrics' },
  { key: 'sleep', kind: 'sleep', scope: 'sleep' },
  { key: 'exercise', kind: 'exercise', scope: 'activity' },
  { key: 'weight', kind: 'weight', scope: 'metrics' },
  { key: 'bodyfat', kind: 'bodyfat', scope: 'metrics' },
  { key: 'hr', kind: 'hr', scope: 'metrics' },
  { key: 'device', kind: 'device', scope: 'settings' },
];

/** Errors that end a run rather than one stream. */
const FATAL = new Set(['needs_auth', 'rate_limited', 'network', 'unconfigured']);

export class Sync {
  /**
   * @param {object} o
   * @param {import('./google.js').GoogleHealth} o.google
   * @param {object} o.db              a Store
   * @param {number} o.intervalMin     minutes between runs
   * @param {Function} o.onChange      called after any run that wrote data
   * @param {number} o.gapMs           pause between API calls
   */
  constructor({ google, db, intervalMin = 20, onChange = () => {}, now = () => Date.now(), gapMs = 150, log = console, tz = undefined, auto = true } = {}) {
    this.tz = tz;       // the person's zone: which civil day "today" is
    this.auto = auto;   // false: somebody else (the scheduler) decides when
    this.google = google;
    this.db = db;
    this.intervalMin = intervalMin;
    this.onChange = onChange;
    this.now = now;
    this.gapMs = gapMs;
    this.log = log;
    this.timer = null;
    this.running = null;
    const saved = db.meta('sync', {});
    this.state = {
      lastRun: saved.lastRun || null,
      lastOk: saved.lastOk || null,
      lastError: saved.lastError || null,
      failures: saved.failures || 0,
      nextAt: null,
      streams: saved.streams || {},
    };
  }

  #persist() {
    const { nextAt, ...keep } = this.state;
    this.db.setMeta('sync', keep);
  }

  start(firstInMs = 5000) { this.#schedule(firstInMs); }
  stop() { clearTimeout(this.timer); this.timer = null; }

  #schedule(ms) {
    clearTimeout(this.timer);
    this.state.nextAt = this.now() + ms;
    if (!this.auto) return;
    this.timer = setTimeout(() => { this.run().catch(() => {}); }, ms);
    this.timer.unref?.();
  }

  /** The wait after a run: the interval, or a backoff that doubles. */
  nextDelay(result) {
    if (result.ok) return this.intervalMin * 60_000;
    const back = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** Math.max(0, this.state.failures - 1));
    if (result.code === 'needs_auth' || result.code === 'unconfigured') return BACKOFF_MAX;
    if (result.retryAfter) return Math.max(back, result.retryAfter * 1000);
    return back;
  }

  /** Run now. Concurrent callers share the one run in flight. */
  run() {
    this.running ||= this.#run().finally(() => { this.running = null; });
    return this.running;
  }

  async #run() {
    const g = this.google;
    let result;
    if (!g.configured() || !g.connected()) {
      result = { ok: false, code: g.configured() ? 'needs_auth' : 'unconfigured', wrote: 0 };
    } else {
      result = await this.#walk();
    }
    const at = this.now();
    this.state.lastRun = at;
    if (result.ok) {
      this.state.lastOk = at;
      this.state.failures = 0;
      this.state.lastError = null;
    } else if (result.code !== 'unconfigured' && result.code !== 'needs_auth') {
      this.state.failures += 1;
      this.state.lastError = { at, message: result.message || result.code, code: result.code };
    }
    this.#persist();
    this.#schedule(this.nextDelay(result));
    result.nextInMs = this.nextDelay(result);
    if (result.wrote) this.onChange(result);
    return result;
  }

  async #walk() {
    const t = todayIn(this.now(), this.tz);
    let wrote = 0;
    let partial = null;
    for (const s of STREAMS) {
      if (!this.google.granted(SCOPES[s.scope])) {
        this.state.streams[s.key] = { ...(this.state.streams[s.key] || {}), skipped: 'scope not granted' };
        continue;
      }
      try {
        const n = await this.#stream(s, t);
        wrote += n;
        this.state.streams[s.key] = { at: this.now(), rows: n, through: t };
      } catch (e) {
        this.state.streams[s.key] = { ...(this.state.streams[s.key] || {}), error: e.message, errorAt: this.now() };
        if (FATAL.has(e.code)) return { ok: false, code: e.code, message: e.message, retryAfter: e.retryAfter, wrote };
        // A data type this account has nothing for, or one the device does
        // not produce, is not a failed sync.
        if (e.status && e.status >= 500) partial = partial || { code: `http_${e.status}`, message: `${s.key}: ${e.message}` };
        this.log.warn?.(`  sync ${s.key}: ${e.message}`);
      }
      if (this.gapMs) await sleepFor(this.gapMs);
    }
    return partial ? { ok: false, ...partial, wrote } : { ok: true, wrote };
  }

  /** Where a stream starts reading from: a backfill the first time, a few
      days before the last good read after that. */
  #from(key, t) {
    const through = this.state.streams[key]?.through;
    const floor = addDays(t, -(BACKFILL_DAYS - 1));
    if (!through) return floor;
    const f = addDays(through, -OVERLAP_DAYS);
    return f < floor ? floor : f;
  }

  async #stream(s, t) {
    const g = this.google;
    const db = this.db;
    const from = this.#from(s.key, t);
    const fromIso = `${from}T00:00:00Z`;
    let n = 0;
    switch (s.kind) {
      case 'rollup': {
        const end = addDays(t, 1);
        for (let a = from; a < end; a = addDays(a, ROLLUP_CHUNK)) {
          const b = addDays(a, ROLLUP_CHUNK) < end ? addDays(a, ROLLUP_CHUNK) : end;
          const rows = parseRollup(s.type, await g.dailyRollUp(s.type, a, b));
          db.tx(() => { for (const r of rows) for (const [k, v] of Object.entries(r.metrics)) { db.setDaily(r.date, k, v); n += 1; } });
        }
        return n;
      }
      case 'daily': {
        const rows = parseDaily(s.type, await g.list(s.type, { filter: `${s.field}.date >= "${from}"`, pageSize: 1000 }));
        db.tx(() => { for (const r of rows) for (const [k, v] of Object.entries(r.metrics)) { db.setDaily(r.date, k, v); n += 1; } });
        return n;
      }
      case 'sleep': {
        const rows = (await g.list('sleep', { filter: `sleep.interval.end_time >= "${fromIso}"`, pageSize: 25 })).map(parseSleep).filter(Boolean);
        db.tx(() => {
          for (const r of rows) {
            db.upsertSleep(r);
            n += 1;
          }
          // Per night: the main session's numbers as daily metrics, so the
          // trends and readiness read sleep like any other metric.
          const byDate = {};
          for (const r of rows) if (r.main && (!byDate[r.date] || r.asleepMin > byDate[r.date].asleepMin)) byDate[r.date] = r;
          for (const [date, r] of Object.entries(byDate)) {
            db.setDaily(date, 'sleep_min', r.asleepMin);
            db.setDaily(date, 'sleep_period', r.periodMin);
            if (r.summary.stages.DEEP !== undefined) db.setDaily(date, 'sleep_deep', r.summary.stages.DEEP);
            if (r.summary.stages.REM !== undefined) db.setDaily(date, 'sleep_rem', r.summary.stages.REM);
          }
        });
        return n;
      }
      case 'exercise': {
        const rows = (await g.list('exercise', { filter: `exercise.interval.civil_start_time >= "${from}"`, pageSize: 25 })).map(parseExercise).filter(Boolean);
        db.tx(() => { for (const r of rows) { db.upsertExercise(r); n += 1; } });
        return n;
      }
      case 'weight': {
        const rows = (await g.list('weight', { filter: `weight.sample_time.physical_time >= "${fromIso}"`, pageSize: 1000 })).map(parseWeight).filter(Boolean);
        db.tx(() => { for (const r of rows) { db.upsertWeight({ ...r, source: 'google' }); n += 1; } });
        return n;
      }
      case 'bodyfat': {
        const rows = (await g.list('body-fat', { filter: `body_fat.sample_time.physical_time >= "${fromIso}"`, pageSize: 1000 })).map(parseBodyFat).filter(Boolean);
        db.tx(() => { for (const r of rows) { db.setDaily(r.date, 'body_fat', r.pct); n += 1; } });
        return n;
      }
      case 'hr': {
        // The newest sample in the last three hours: what the object's pulse
        // beats at. Older than that and there is nothing live to show.
        const since = new Date(this.now() - 3 * 3_600_000).toISOString();
        const pts = await g.list('heart-rate', { filter: `heart_rate.sample_time.physical_time >= "${since}"`, pageSize: 1000, maxPages: 3 });
        const hr = latestHeartRate(pts);
        if (hr) { db.setMeta('hr', hr); n = 1; }
        // A watch samples every few seconds to a minute; a phone or a spot
        // check gives a handful. Twenty samples in three hours is a device
        // that can carry workout detection. Remembered, because the person
        // may simply not be wearing it during this particular read.
        if (pts.length >= 20) db.setMeta('hrDense', { t: this.now(), n: pts.length });
        return n;
      }
      case 'device': {
        const d = pickDevice(await g.pairedDevices());
        db.setMeta('device', d);
        return d ? 1 : 0;
      }
      default:
        return 0;
    }
  }
}
