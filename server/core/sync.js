/* ============================================================
   health.ojee.net — one person's poller.

   The device syncs to the phone, the phone to Google, and this reads
   Google: minutes to hours behind the wrist, whatever we do. So it
   is run on a slow clock (20 min, by scheduler.js; `auto` lets one
   instance keep its own timer instead), asks only for what can
   have changed since last time — plus a few days back, because last
   night's HRV and a day's step total are revised after the fact —
   and backs off hard when Google or the network says no.

   One run walks a fixed list of streams, one per readable data type
   (docs/DATA-TYPES.md says which call each type really answers, and
   why the ones without a stream have none). A stream whose scope was
   not granted is skipped, not failed. One stream failing does not
   stop the others; an auth failure, a 429 or a dead network stops the
   run. A stream Google refuses outright (403, or 400 "not supported")
   is marked unavailable and left alone for a day.

   Three things keep a run small:
     heavy    dense or 14-day-capped types read the recent two weeks
              first and walk back one two-week chunk per later run,
              until the 90 days are covered (`backTo` in its state)
     everyMs  slow-changing types (height, VO2 max, zone thresholds)
              are not asked on every run
     group    the optional groups' streams run only while the person
              has the group switched on and Google granted its scope
   ============================================================ */

import {
  parseRollup, parseDaily, parseSleep, parseExercise, parseWeight, parseBodyFat, latestHeartRate, pickDevice,
  parseActivityLevels, parseRespSleep, parseVo2Level, parseHeartRateZones, reduceSpo2, reduceHrv, SAMPLE_PARSERS,
} from './parse.js';
import { SCOPES, GROUP_SCOPES, groupById } from './google.js';
import { today as todayIn, addDays, sleepFor } from './util.js';

export const BACKFILL_DAYS = 90;
const OVERLAP_DAYS = 3;
export const HEAVY_DAYS = 14;        // a heavy stream's first read, and each step back
const HOUR = 3_600_000;
export const UNAVAILABLE_MS = 24 * HOUR;   // how long a refused stream is left alone
const BACKOFF_MIN = 2 * 60_000;
const BACKOFF_MAX = 6 * 3_600_000;

/**
 * The streams, in the order a run walks them.
 *   kind     which reader handles it (#read)
 *   type     the Google data type; `field` its snake_case name in filters
 *   scope    the core scope it needs, or `group` the optional group
 *   heavy    recent two weeks first, then one chunk back per run
 *   everyMs  at most this often
 *   sample   the `sample` kind its points become (kind 'samples')
 *   time     which filter the type takes: 'sample' (sample_time),
 *            'session' (interval.civil_start_time), 'ecg' (start_time only)
 *   value    the daily metric a daily list is there for: whether the device
 *            sends it decides if a stand-in is worked out from samples
 *   gscope   the one scope of its group this stream needs (ECG and rhythm
 *            notices are granted separately); without it, the whole group's
 *   all      the first read goes back to the beginning, not ninety days
 */
export const STREAMS = [
  { key: 'steps', kind: 'rollup', type: 'steps', scope: 'activity' },
  { key: 'azm', kind: 'rollup', type: 'active-zone-minutes', scope: 'activity' },
  { key: 'activeMinutes', kind: 'rollup', type: 'active-minutes', scope: 'activity' },
  { key: 'kcal', kind: 'rollup', type: 'total-calories', scope: 'activity' },
  { key: 'distance', kind: 'rollup', type: 'distance', scope: 'activity' },
  { key: 'floors', kind: 'rollup', type: 'floors', scope: 'activity' },
  { key: 'kcalActive', kind: 'rollup', type: 'active-energy-burned', scope: 'activity' },
  { key: 'zones', kind: 'rollup', type: 'time-in-heart-rate-zone', scope: 'activity' },
  { key: 'zoneKcal', kind: 'rollup', type: 'calories-in-heart-rate-zone', scope: 'activity', heavy: true, everyMs: HOUR },
  { key: 'sedentary', kind: 'rollup', type: 'sedentary-period', scope: 'activity', everyMs: HOUR },
  { key: 'levels', kind: 'levels', type: 'activity-level', field: 'activity_level', scope: 'activity', heavy: true, everyMs: HOUR },
  { key: 'altitude', kind: 'rollup', type: 'altitude', scope: 'activity', everyMs: 6 * HOUR },
  { key: 'swim', kind: 'rollup', type: 'swim-lengths-data', scope: 'activity', everyMs: 6 * HOUR },
  { key: 'rhr', kind: 'daily', type: 'daily-resting-heart-rate', field: 'daily_resting_heart_rate', scope: 'metrics' },
  { key: 'hrv', kind: 'daily', type: 'daily-heart-rate-variability', field: 'daily_heart_rate_variability', scope: 'metrics', value: 'hrv' },
  { key: 'spo2', kind: 'daily', type: 'daily-oxygen-saturation', field: 'daily_oxygen_saturation', scope: 'metrics', value: 'spo2' },
  { key: 'temp', kind: 'daily', type: 'daily-sleep-temperature-derivations', field: 'daily_sleep_temperature_derivations', scope: 'metrics' },
  { key: 'resp', kind: 'daily', type: 'daily-respiratory-rate', field: 'daily_respiratory_rate', scope: 'metrics', value: 'resp', everyMs: 3 * HOUR },
  { key: 'respSleep', kind: 'respSleep', type: 'respiratory-rate-sleep-summary', field: 'respiratory_rate_sleep_summary', scope: 'metrics', everyMs: 3 * HOUR },
  { key: 'hrDay', kind: 'rollup', type: 'heart-rate', scope: 'metrics', heavy: true, everyMs: HOUR },
  { key: 'hrZones', kind: 'hrZones', type: 'daily-heart-rate-zones', field: 'daily_heart_rate_zones', scope: 'metrics', everyMs: 24 * HOUR },
  { key: 'spo2Samples', kind: 'spo2Samples', type: 'oxygen-saturation', field: 'oxygen_saturation', scope: 'metrics', heavy: true, everyMs: 6 * HOUR },
  { key: 'hrvSamples', kind: 'hrvSamples', type: 'heart-rate-variability', field: 'heart_rate_variability', scope: 'metrics', heavy: true, everyMs: 6 * HOUR },
  { key: 'vo2', kind: 'daily', type: 'daily-vo2-max', field: 'daily_vo2_max', scope: 'activity', value: 'vo2max', everyMs: 6 * HOUR },
  { key: 'vo2Samples', kind: 'samples', type: 'vo2-max', field: 'vo2_max', time: 'sample', sample: 'vo2', scope: 'activity', everyMs: 12 * HOUR },
  { key: 'vo2Run', kind: 'rollup', type: 'run-vo2-max', scope: 'activity', everyMs: 12 * HOUR },
  { key: 'sleep', kind: 'sleep', scope: 'sleep' },
  { key: 'exercise', kind: 'exercise', scope: 'activity' },
  { key: 'weight', kind: 'weight', scope: 'metrics' },
  { key: 'bodyfat', kind: 'bodyfat', scope: 'metrics' },
  { key: 'height', kind: 'samples', type: 'height', field: 'height', time: 'sample', sample: 'height', scope: 'metrics', everyMs: 24 * HOUR, all: true },
  { key: 'glucose', kind: 'samples', type: 'blood-glucose', field: 'blood_glucose', time: 'sample', sample: 'glucose', scope: 'metrics', everyMs: HOUR },
  { key: 'bodytemp', kind: 'samples', type: 'core-body-temperature', field: 'core_body_temperature', time: 'sample', sample: 'bodytemp', scope: 'metrics', everyMs: HOUR },
  { key: 'hr', kind: 'hr', scope: 'metrics' },
  { key: 'device', kind: 'device', scope: 'settings' },
  // The optional groups. Nutrition holds a write scope only, so these two
  // lists return what this app wrote itself (or are refused: both are fine).
  { key: 'water', kind: 'samples', type: 'hydration-log', field: 'hydration_log', time: 'session', sample: 'water', group: 'nutrition' },
  { key: 'food', kind: 'samples', type: 'nutrition-log', field: 'nutrition_log', time: 'session', sample: 'food', group: 'nutrition' },
  { key: 'ecg', kind: 'samples', type: 'electrocardiogram', field: 'electrocardiogram', time: 'ecg', sample: 'ecg', group: 'ecg', gscope: 'ecg', heavy: true, everyMs: 6 * HOUR, pageSize: 25 },
  { key: 'irn', kind: 'samples', type: 'irregular-rhythm-notification', field: 'irregular_rhythm_notification', time: 'session', sample: 'irn', group: 'ecg', gscope: 'irn', everyMs: 6 * HOUR, pageSize: 25 },
];

/** For a daily stream that samples can stand in for: a metric that only the
    daily type itself ever writes. */
const PROOF = { hrv: 'hrv_deep', spo2: 'spo2_lo' };

/** A daily metric kept as the day's latest reading of a sample kind. */
const SAMPLE_DAILY = { height: 'height_mm' };

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
   * @param {Function} o.groups        () => { nutrition: bool, ... }: the optional
   *                                   groups the person has switched on (default: none)
   */
  constructor({ google, db, intervalMin = 20, onChange = () => {}, now = () => Date.now(), gapMs = 150, log = console, tz = undefined, auto = true, groups = () => ({}) } = {}) {
    this.groups = groups;
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
    this.gave = {};
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
    this.gave = {};   // stream key -> did its daily list carry the value (this run)
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

  /** Why a stream is not read this run, or null when it may be. */
  #blocked(s) {
    if (s.group) {
      if (!this.groups()?.[s.group]) return 'group off';
      const need = s.gscope ? [GROUP_SCOPES[s.gscope]] : groupById(s.group).scopes;
      return need.every((x) => this.google.granted(x)) ? null : 'scope not granted';
    }
    return this.google.granted(SCOPES[s.scope]) ? null : 'scope not granted';
  }

  /**
   * What a stream reads this run: `recent` and `back` are [from, to) civil
   * date ranges, either may be null. A heavy stream's first read is the last
   * two weeks; each later run adds one chunk further back until BACKFILL_DAYS
   * are covered. A stream with `everyMs` skips its recent read until that
   * long has passed, but still takes its step back.
   */
  plan(s, t) {
    const st = this.state.streams[s.key] || {};
    const floor = addDays(t, -(BACKFILL_DAYS - 1));
    const end = addDays(t, 1);
    const due = !s.everyMs || !st.at || this.now() - st.at >= s.everyMs;
    if (!s.heavy) return { recent: due ? [this.#from(s.key, t), end] : null, back: null, backTo: undefined };
    if (!st.through) {
      const from = addDays(t, -(HEAVY_DAYS - 1));
      return { recent: [from, end], back: null, backTo: from };
    }
    const cur = st.backTo || floor;
    const back = cur > floor ? [addDays(cur, -HEAVY_DAYS) < floor ? floor : addDays(cur, -HEAVY_DAYS), cur] : null;
    return { recent: due ? [this.#from(s.key, t), end] : null, back, backTo: back ? back[0] : cur };
  }

  async #walk() {
    const t = todayIn(this.now(), this.tz);
    let wrote = 0;
    let partial = null;
    const ran = {};   // stream key -> the earliest civil date it read this run
    for (const s of STREAMS) {
      const st = this.state.streams[s.key] || {};
      const why = this.#blocked(s);
      if (why) {
        this.state.streams[s.key] = { ...st, skipped: why };
        continue;
      }
      // Refused not long ago: it is not asked again until a day has passed.
      if (st.unavailable && this.now() - (st.unavailableAt || 0) < UNAVAILABLE_MS) continue;
      const plan = this.plan(s, t);
      if (!plan.recent && !plan.back) continue;
      try {
        let n = 0;
        if (plan.recent) n += await this.#read(s, t, plan.recent[0], plan.recent[1], false);
        if (plan.back) n += await this.#read(s, t, plan.back[0], plan.back[1], true);
        wrote += n;
        ran[s.key] = plan.back ? plan.back[0] : plan.recent[0];
        const { skipped, error, errorAt, unavailable, unavailableAt, message, ...keep } = st;
        this.state.streams[s.key] = {
          ...keep, rows: n,
          ...(plan.recent ? { at: this.now(), through: t } : {}),
          ...(plan.backTo !== undefined ? { backTo: plan.backTo } : {}),
          ...(this.gave[s.key] ? { valueAt: this.now() } : {}),
        };
      } catch (e) {
        if (FATAL.has(e.code)) {
          this.state.streams[s.key] = { ...st, error: e.message, errorAt: this.now() };
          return { ok: false, code: e.code, message: e.message, retryAfter: e.retryAfter, wrote };
        }
        // The Google account signed in has no Google Health behind it (not the one the
        // Fitbit / Google Health app uses): nothing can be read, so the sync failed, and says why.
        if (/not linked to Google Health/i.test(e.message || '')) {
          this.state.streams[s.key] = { ...st, error: e.message, errorAt: this.now() };
          return { ok: false, code: 'not_linked', message: 'This Google account has no Google Health data. Connect the account your Fitbit or Google Health app uses.', wrote };
        }
        if (e.status === 403 || (e.status === 400 && /not supported/i.test(e.message))) {
          // Google will not give this type to this account (a scope the
          // consent screen did not really carry, a type with no list). Not a
          // failed sync: said once, and asked again tomorrow.
          const { error, errorAt, skipped, ...keep } = st;
          this.state.streams[s.key] = { ...keep, unavailable: true, message: String(e.message).slice(0, 300), unavailableAt: this.now() };
          this.log.warn?.(`  sync ${s.key}: unavailable: ${e.message}`);
        } else {
          this.state.streams[s.key] = { ...st, error: e.message, errorAt: this.now() };
          // A data type this account has nothing for, or one the device does
          // not produce, is not a failed sync.
          if (e.status && e.status >= 500) partial = partial || { code: `http_${e.status}`, message: `${s.key}: ${e.message}` };
          this.log.warn?.(`  sync ${s.key}: ${e.message}`);
        }
      }
      if (this.gapMs) await sleepFor(this.gapMs);
    }
    wrote += this.#basal(ran, t);
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

  /**
   * Resting energy is not something Google rolls up, so it is worked out:
   * a day's total minus its active energy, never below zero, and only for
   * a day that has both. Recomputed over whatever the two streams read.
   */
  #basal(ran, t) {
    const from = [ran.kcal, ran.kcalActive].filter(Boolean).sort()[0];
    if (!from) return 0;
    let n = 0;
    const table = this.db.dailyTable(from);
    this.db.tx(() => {
      for (const [date, m] of Object.entries(table)) {
        if (date > t || !Number.isFinite(m.kcal) || !Number.isFinite(m.kcal_active)) continue;
        this.db.setDaily(date, 'kcal_basal', Math.max(0, Math.round(m.kcal - m.kcal_active)));
        n += 1;
      }
    });
    return n;
  }

  /** Does a daily stream carry its value for this person: it did at some
      read in the last 30 days. A few days off the wrist do not change the
      answer, so a stand-in never overwrites the device's own number. */
  #gives(key) {
    const at = this.gave[key] ? this.now() : this.state.streams[key]?.valueAt;
    if (at && this.now() - at < 30 * 24 * HOUR) return true;
    // A store from before this was remembered: a metric only the daily type
    // writes, seen in the last 30 days, says the same thing.
    const proof = PROOF[key] && this.db.latest(PROOF[key])?.date;
    return !!proof && proof >= addDays(todayIn(this.now(), this.tz), -30);
  }

  /** Write parsed `{ date, metrics }` rows into `daily`. */
  #daily(rows) {
    let n = 0;
    this.db.tx(() => { for (const r of rows) for (const [k, v] of Object.entries(r.metrics)) { this.db.setDaily(r.date, k, v); n += 1; } });
    return n;
  }

  /** Read one stream over [from, to) civil dates. `back` is a step of a
      heavy stream's walk into the past: both ends are then bounded. */
  async #read(s, t, from, to, back) {
    const g = this.google;
    const db = this.db;
    const fromIso = `${from}T00:00:00Z`;
    const toIso = `${to}T00:00:00Z`;
    // A heavy list is always bounded above, so a step back does not re-read
    // everything after it; the other lists keep their open end.
    const bound = s.heavy || back;
    const sampleFilter = `${s.field}.sample_time.physical_time >= "${fromIso}"${bound ? ` AND ${s.field}.sample_time.physical_time < "${toIso}"` : ''}`;
    let n = 0;
    switch (s.kind) {
      case 'rollup':
        return this.#daily(parseRollup(s.type, await g.dailyRollUp(s.type, from, to)));
      case 'daily': {
        const pts = await g.list(s.type, { filter: `${s.field}.date >= "${from}"`, pageSize: 1000 });
        const rows = parseDaily(s.type, pts);
        // Remembered: a device that sends the daily value needs no stand-in
        // worked out from samples (see spo2Samples, hrvSamples, respSleep).
        if (s.value) this.gave[s.key] = rows.some((r) => r.metrics[s.value] !== undefined);
        if (s.type === 'daily-vo2-max') { const lv = parseVo2Level(pts); if (lv) db.setMeta('vo2', lv); }
        return this.#daily(rows);
      }
      case 'levels': {
        const f = `${s.field}.interval.start_time >= "${fromIso}" AND ${s.field}.interval.start_time < "${toIso}"`;
        return this.#daily(parseActivityLevels(await g.list(s.type, { filter: f, pageSize: 10000, maxPages: 6 })));
      }
      case 'respSleep': {
        const rows = parseRespSleep(await g.list(s.type, { filter: sampleFilter, pageSize: 1000 }));
        const standIn = !this.#gives('resp');
        db.tx(() => {
          for (const r of rows) {
            for (const [k, v] of Object.entries(r.metrics)) { db.setDaily(r.date, k, v); n += 1; }
            if (standIn && r.full !== null) { db.setDaily(r.date, 'resp', r.full); n += 1; }
          }
        });
        return n;
      }
      case 'hrZones': {
        // Only the newest thresholds matter: a week back is plenty.
        const z = parseHeartRateZones(await g.list(s.type, { filter: `${s.field}.date >= "${addDays(t, -7)}"`, pageSize: 50 }));
        if (z) { db.setMeta('hrZones', z); return 1; }
        return 0;
      }
      case 'spo2Samples': {
        const rows = reduceSpo2(await g.list(s.type, { filter: sampleFilter, pageSize: 10000, maxPages: 6 }));
        const standIn = !this.#gives('spo2');
        if (standIn) for (const r of rows) r.metrics.spo2 = r.metrics.spo2_mean;
        return this.#daily(rows);
      }
      case 'hrvSamples': {
        // Only for a device with no daily HRV: the night's mean RMSSD stands
        // in for it. With a daily value there is nothing these add.
        if (this.#gives('hrv')) return 0;
        const rows = reduceHrv(await g.list(s.type, { filter: sampleFilter, pageSize: 10000, maxPages: 6 }));
        return this.#daily(rows.map((r) => ({ date: r.date, metrics: { hrv: r.rmssd } })));
      }
      case 'samples': {
        const filter = s.time === 'sample' ? `${s.field}.sample_time.physical_time >= "${s.all && !this.state.streams[s.key]?.through ? '2000-01-01T00:00:00Z' : fromIso}"`
          : s.time === 'ecg' ? `${s.field}.interval.start_time >= "${fromIso}"`
            : `${s.field}.interval.civil_start_time >= "${from}"`;
        const parse = SAMPLE_PARSERS[s.sample];
        const rows = (await g.list(s.type, { filter, pageSize: s.pageSize || 1000 })).map(parse).filter(Boolean);
        const standIn = s.sample === 'vo2' && !this.#gives('vo2');
        db.tx(() => {
          // Oldest first, so the day's latest reading is the one that stays.
          for (const r of rows.sort((a, b) => a.t - b.t)) {
            db.sampleUpsert(r, this.now());
            if (SAMPLE_DAILY[s.sample]) db.setDaily(r.date, SAMPLE_DAILY[s.sample], r.value);
            if (standIn) db.setDaily(r.date, 'vo2max', r.value);
            n += 1;
          }
        });
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
            const st = r.summary.stages;
            db.setDaily(date, 'sleep_min', r.asleepMin);
            db.setDaily(date, 'sleep_period', r.periodMin);
            db.setDaily(date, 'sleep_awake', r.awakeMin);
            if (r.periodMin > 0) db.setDaily(date, 'sleep_efficiency', Math.round((r.asleepMin / r.periodMin) * 1000) / 10);
            if (st.DEEP !== undefined) db.setDaily(date, 'sleep_deep', st.DEEP);
            if (st.REM !== undefined) db.setDaily(date, 'sleep_rem', st.REM);
            if (st.LIGHT !== undefined) db.setDaily(date, 'sleep_light', st.LIGHT);
          }
        });
        return n;
      }
      case 'exercise': {
        const rows = (await g.list('exercise', { filter: `exercise.interval.civil_start_time >= "${from}"`, pageSize: 25 })).map(parseExercise).filter(Boolean);
        // For this window Google's list is the truth: a workout deleted, or
        // merged into another, in the Google Health app is simply absent from
        // it, and must go here too or it lives on as a ghost in history.
        const keep = new Set(rows.map((r) => r.id));
        db.tx(() => {
          for (const r of rows) { db.upsertExercise(r); n += 1; }
          for (const e of db.exercises(from)) if (!keep.has(e.id)) db.deleteExercise(e.id);
        });
        return n;
      }
      case 'weight': {
        const rows = (await g.list('weight', { filter: `weight.sample_time.physical_time >= "${fromIso}"`, pageSize: 1000 })).map(parseWeight).filter(Boolean);
        db.tx(() => { for (const r of rows) { db.upsertWeight({ ...r, source: 'google' }); n += 1; } });
        return n;
      }
      case 'bodyfat': {
        // The day's number for the trends, and a row per reading so the
        // entries can be listed (and one logged here lands on its own row).
        const pts = await g.list('body-fat', { filter: `body_fat.sample_time.physical_time >= "${fromIso}"`, pageSize: 1000 });
        const rows = pts.map(parseBodyFat).filter(Boolean).sort((a, b) => a.t - b.t);
        const samples = pts.map(SAMPLE_PARSERS.bodyfat).filter(Boolean);
        db.tx(() => {
          for (const r of rows) { db.setDaily(r.date, 'body_fat', r.pct); n += 1; }
          for (const r of samples) db.sampleUpsert(r, this.now());
        });
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
