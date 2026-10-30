/* ============================================================
   health.ojee.net — one person's workouts: detected, started by
   hand, logged after the fact or imported, and saved to Google
   Health under the exercise type that person chose.

   One row per workout (db `workout`), and its status says where it
   is. Every prompt sent is written on the row, so a restart or a
   resync never says the same thing twice.

     ongoing     detected, still going; "started?" may have been asked
     running     started by hand, or a detection the person confirmed
     review      over; waiting for "save" (the "ended?" prompt)
     done        confirmed — saved, or waiting to be saved, to Google
     dismissed   "not a workout" (that period stays quiet)
     cancelled   a hand-started one thrown away
     discarded   a detection that fizzled out before it was a workout
     superseded  the same period turned up in Google from elsewhere
     merged      replaced by a workout started or logged by hand
     deleted     removed (and deleted from Google, if it was saved)

   Every status but `ongoing` and a confirmed detection's `running`
   is an edge the detector never crosses (detect.js), so nothing it
   holds is detected twice. Ends are found from the data; a workout
   started by hand is only closed by hand — or, forgotten, after a
   long calm, for the person to confirm.

   When the console module is linked, THIS app stays the one that
   detects and asks: the module mirrors these rows through link.js
   and stops its own detection while the link is healthy.

   Heart rate reaches Google only when the device syncs to the phone and
   the phone to Google. Every "now" here is "as far as the data
   goes", and a start that is only seen after the end is never asked
   about — the end prompt carries both times.
   ============================================================ */

import {
  detect, detectSettings, startWorthy, workoutWorthy, calmSince, dataEnd, MIN,
} from './detect.js';
import { utcOffsetSec, clockIn } from './util.js';

/** The exercise types a person can save workouts as (Google Health's
    `exerciseType` enum, from the API's discovery document). */
export const EXERCISE_TYPES = {
  STRENGTH_TRAINING: 'Strength training',
  WEIGHT_MACHINES: 'Weight machines',
  FREE_WEIGHTS: 'Free weights',
  WEIGHTLIFTING: 'Weightlifting',
  FUNCTIONAL_STRENGTH_TRAINING: 'Functional strength training',
  BODY_WEIGHT: 'Bodyweight',
  CIRCUIT_TRAINING: 'Circuit training',
  CROSSFIT: 'CrossFit',
  CARDIO_WORKOUT: 'Cardio workout',
  WORKOUT: 'Workout',
};
export const EXERCISE_TYPE = 'STRENGTH_TRAINING';   // the default for a new person
/** Every exercise type Google Health takes (the enum in its discovery
    document, 181 of them). The ten above are what a person picks from; a
    workout brought in from Strava keeps its own (RUNNING, BIKING, ...). */
export const GOOGLE_EXERCISE_TYPES = new Set((
  'AEROBIC_WORKOUT ARCHERY ASSAULT_BIKE BACKPACKING BADMINTON BALLET BALLROOM_DANCE BARRE_CLASS BASEBALL ' +
  'BASKETBALL BIKING BILLIARDS BODY_WEIGHT BOOTCAMP BOWLING BOXING BREAKDANCING CALISTHENICS CANOEING ' +
  'CARDIO_SCULPT CARDIO_WORKOUT CARPENTRY CHEERLEADING CIRCUIT_TRAINING CLEANING CLIMBING CORE_TRAINING ' +
  'CRICKET CROQUET CROSS_COUNTRY_SKI CROSS_TRAINING CROSSFIT CURLING DANCING DIVING ELECTRIC_BIKE ' +
  'ELECTRIC_SCOOTER ELLIPTICAL EQUESTRIAN_SPORTS EXERCISE_CLASS FENCING FIELD_HOCKEY FISHING FITNESS_GAMING ' +
  'FOILING FOOTBALL_AMERICAN FOOTBALL_AUSTRALIAN FREE_WEIGHTS FRISBEE_PLAYING_GENERAL ' +
  'FUNCTIONAL_STRENGTH_TRAINING GARDENING GOLF GYMNASTICS HANDBALL HAND_CYCLING HIIT HIKING HIP_HOP HOCKEY ' +
  'HOEING HOUSEHOLD_CHORES HUNTING ICE_SKATING INCLINE_RUN INCLINE_WALK INDOOR_CLIMBING INTERVAL_WORKOUT ' +
  'JAZZ_DANCE JIU_JITSU JUMPING_ROPE KARATE KAYAKING KICKBOXING KITESURFING LACROSSE MARTIAL_ARTS MEDITATE ' +
  'MODERN_DANCE MOTOCROSS MOTORCYCLE MOUNTAIN_BIKE MOWING_LAWN MUAY_THAI MULTISPORT MUSICAL_PERFORMANCE ' +
  'NORDIC_WALKING ORIENTEERING OTHER OUTDOOR_BIKE OUTDOOR_WORKOUT PADDLEBOARDING PADEL PAINTING PARAGLIDING ' +
  'PARKOUR PICKELBALL PILATES POLO POWERLIFTING POWER_WALKING RACKET_SPORTS RACQUETBALL RESISTANCE_BANDS ' +
  'ROCK_CLIMBING ROLLERBLADING ROLLER_SKATING ROWING ROWING_MACHINE RUCKING RUGBY RUNNING SAILING ' +
  'SCOOTERING SCUBA_DIVING SHOOTING SHOVELING SKATEBOARDING SKATING SKIING SKYDIVING SNORKELING ' +
  'SNOWBOARDING SNOWMOBILING SNOWSHOEING SNOW_SPORT SOCCER SOFTBALL SPEED_SKATING SPINNING SPORT SQUASH ' +
  'STAIRCLIMBER STATIONARY_BIKE STEP_TRAINING STRENGTH_TRAINING STRETCHING STROLLER_WALK SURFING SWIMMING ' +
  'SWIMMING_OPEN_WATER SWIMMING_POOL SYNCHRONIZED_SWIMMING TABATA_WORKOUT TABLE_TENNIS TAEKWONDO TAI_CHI ' +
  'TANGO TENNIS TRACK_AND_FIELD TRAIL_RUN TRAMPOLINE TREADMILL TREADMILL_WALK TRX ULTIMATE_FRISBEE ' +
  'UNICYCLING VOLLEYBALL VOLLEYBALL_BEACH WAKEBOARDING WALKING WALK_WITH_WEIGHTS WATER_AEROBICS ' +
  'WATER_JOGGING WATER_POLO WATER_SKIING WATER_SPORT WATER_VOLLEYBALL WEEDING WEIGHTLIFTING WEIGHT_MACHINES ' +
  'WEIGHTS WHEELCHAIR WINDSURFING WORKOUT WRESTLING YOGA YOGA_BIKRAM YOGA_HATHA YOGA_POWER YOGA_VINYASA ' +
  'ZUMBA'
).trim().split(/\s+/));
const NAMES = { HIIT: 'HIIT', TRX: 'TRX', PICKELBALL: 'Pickleball', FOOTBALL_AMERICAN: 'American football', FOOTBALL_AUSTRALIAN: 'Australian football' };
/** "TRAIL_RUN" -> "Trail run". */
export const typeName = (t) => EXERCISE_TYPES[t] || NAMES[t] || (t ? `${t[0]}${t.slice(1).toLowerCase().replace(/_/g, ' ')}` : '');
export const validType = (t) => !!EXERCISE_TYPES[t] || GOOGLE_EXERCISE_TYPES.has(t);
export const EXERCISE_NAME = EXERCISE_TYPES[EXERCISE_TYPE];
/** The Google data point a workout is saved under. Derived from the uid and
    nothing else, so this app and the linked console module can only ever
    create ONE point for a workout: the second create is a 409. */
export const pointName = (uid) => `users/me/dataTypes/exercise/dataPoints/ojee-w-${uid}`;

const HOUR = 60 * MIN;
const WINDOW = 8 * HOUR;            // how far back each check reads
const TRACE_PAD = 20 * MIN;         // the chart around a workout
const STALE_START = 60 * MIN;       // older than this, "started?" is not asked
const NIGHT = [0, 5];               // local hours a start is never asked about
const MAX_RUN = 6 * HOUR;           // a hand-started workout is closed after this
const RETRY_AFTER = 15 * MIN;
const MAX_TRIES = 5;

// Followed by the detector rather than walled off: a detection still going,
// one the person confirmed, and one they called "not a workout" while it
// was going (kept quiet until that stretch is over, then walled off).
// Getting there: a session of one of these next to a stretch is the walk or
// ride to the gym, not the workout itself.
const LOCOMOTION = /WALK|RUN|BIK|HIK|CYCL|SCOOT|STROLL|RUCK|SKAT|TREADMILL|ELLIPTICAL/;

const TRACKED = (r) => r.status === 'ongoing' || (r.status === 'running' && r.source === 'detected') || (r.status === 'dismissed' && r.quiet === 'open');
const OPEN = new Set(['ongoing', 'running', 'review']);
const tailOf = (name) => String(name || '').split('/').pop();
const overlapMs = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const iso = (t) => new Date(Math.round(t / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/**
 * The exercise DataPoint for a workout, as POSTed to
 * users/me/dataTypes/exercise/dataPoints. Only numbers that came from the
 * wearer's own data go into metricsSummary.
 */
export function exercisePayload(w, { tz = undefined, name, type = EXERCISE_TYPE } = {}) {
  const exType = validType(w.type) ? w.type : (EXERCISE_TYPES[type] ? type : EXERCISE_TYPE);
  const s = Math.round(w.start / 1000) * 1000;
  const e = Math.round(w.end / 1000) * 1000;
  const m = {};
  if (Number.isFinite(w.avgHr)) m.averageHeartRateBeatsPerMinute = String(Math.round(w.avgHr));
  if (Number.isFinite(w.steps)) m.steps = String(Math.round(w.steps));
  if (Number.isFinite(w.kcal) && w.kcal > 0) m.caloriesKcal = Math.round(w.kcal * 10) / 10;
  // A route's distance and pace (recorded here, or a GPX file).
  if (Number.isFinite(w.distanceM) && w.distanceM > 0) {
    m.distanceMillimeters = String(Math.round(w.distanceM * 1000));
    if (Number.isFinite(w.movingS) && w.movingS > 0) m.averagePaceSecondsPerMeter = Math.round((w.movingS / w.distanceM) * 10000) / 10000;
  }
  return {
    ...(name ? { name } : {}),
    dataSource: { recordingMethod: 'MANUAL' },
    exercise: {
      interval: {
        startTime: iso(s), startUtcOffset: `${utcOffsetSec(s, tz)}s`,
        endTime: iso(e), endUtcOffset: `${utcOffsetSec(e, tz)}s`,
      },
      exerciseType: exType,
      displayName: String(w.title || typeName(exType)).slice(0, 80),
      activeDuration: `${Math.round((e - s) / 1000)}s`,
      metricsSummary: m,
      notes: w.source === 'detected' ? 'Detected from heart rate and confirmed in health.ojee.net'
        : w.source === 'hevy' ? 'Imported from Hevy by health.ojee.net'
          : w.source === 'recorded' ? 'Recorded with GPS in health.ojee.net' : w.source === 'gpx' ? 'Imported from a GPX file by health.ojee.net' : 'Logged in health.ojee.net',
    },
  };
}

/** Average and peak heart rate and steps over [start, end). */
export function statsOver(series, start, end) {
  let n = 0; let sum = 0; let mx = null; let steps = 0; let any = false;
  for (const m of series) {
    if (m.t < start || m.t >= end) continue;
    any = true;
    steps += m.steps || 0;
    if (m.hr === null) continue;
    n += 1; sum += m.hr;
    const top = m.hrMax ?? m.hr;
    mx = mx === null ? top : Math.max(mx, top);
  }
  return { avgHr: n ? Math.round(sum / n) : null, maxHr: mx === null ? null : Math.round(mx), steps: any ? Math.round(steps) : null, hrMinutes: n };
}

/** The minutes around a workout, compact, for its chart: [t, hr, steps]. */
const traceOf = (series, a, b) => series.filter((m) => m.t >= a - TRACE_PAD && m.t < b + TRACE_PAD).map((m) => [m.t, m.hr === null ? null : Math.round(m.hr), m.steps || 0]);

export class Workouts {
  /**
   * @param {object} o
   * @param {object} o.db          a Store
   * @param {object} o.api         { series(from,to), device(), calories(from,to), create(dp), patch(name,dp), remove(names), findOwn(start) }
   * @param {Function} o.settings  () => detection settings (detectSettings shape)
   * @param {Function} o.rest      () => resting heart rate, bpm
   * @param {Function} o.external  (fromMs) => [{ start, end, kind: 'exercise'|'sleep', id }]
   * @param {Function} o.emit      (typeId, title, body, extra) => void  — a notification
   * @param {Function} o.notifyOn  (typeId) => boolean — the console has it switched on
   * @param {Function} o.canWrite  () => boolean — the write scope is granted
   */
  constructor({ db, api, settings, rest, external, emit = () => {}, notifyOn = () => true, canWrite = () => false, now = () => Date.now(), tz = undefined, log = () => {}, onChange = () => {}, exerciseType = () => EXERCISE_TYPE }) {
    Object.assign(this, { db, api, settingsFn: settings, restFn: rest, external, emit, notifyOn, canWrite, now, tz, log, onChange, exerciseTypeFn: exerciseType });
    this.last = db.meta('workouts:last', { checkedAt: null, asOf: null, fetchedAt: 0, deviceSync: null, error: null });
    this.timer = null;
    this.busy = null;
    this.flushing = null;
  }

  settings() { return detectSettings(this.settingsFn?.() || {}); }
  rest() { const r = Number(this.restFn?.()); return Number.isFinite(r) && r > 30 ? r : 70; }

  #put(r) { r.updated = this.now(); this.db.workoutPut(r); }
  #add(r) {
    const t = this.now();
    const w = { prompts: {}, google: null, ...r, created: t, updated: t };
    w.id = this.db.workoutAdd(w);
    return w;
  }
  get(id) {
    const r = this.db.workoutGet(Number(id));
    if (!r) throw bad('No such workout.', 404);
    return r;
  }
  open() { return this.db.workoutsSince(this.now() + HOUR).filter((r) => OPEN.has(r.status)); }
  running() { return this.open().find((r) => r.status === 'running') || null; }

  /* ── the clock ───────────────────────────────────────────────────── */

  /**
   * Check every minute; read Google when the phone has synced the Air since
   * the last read (or every 30 min regardless, 5 at the least).
   * @param {Function} active  () => boolean — this instance is the one shown
   */
  start(active = () => true, everyMs = 60_000) {
    this.stop();
    const tick = () => { if (active()) this.tick().catch((e) => this.log(`workouts: ${e.message}`)); };
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
    setTimeout(tick, 20_000).unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async tick({ force = false } = {}) {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      try {
        const s = this.settings();
        const now = this.now();
        const hasOpen = this.open().length > 0;
        if (s.enabled || hasOpen) {
          const since = now - (this.last.fetchedAt || 0);
          let due = force || since >= 30 * MIN;
          if (!due && since >= 5 * MIN) {
            // Cheap first: has the phone synced the Air since the last read?
            const dev = await this.api.device().catch(() => null);
            const ls = dev?.lastSync || null;
            due = !ls || ls !== this.last.deviceSync;
            if (ls) this.last.deviceSync = ls;
          }
          if (due) await this.check();
        }
        await this.flush();
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  /** Read the last hours from Google and judge them. */
  async check() {
    const now = this.now();
    this.last.fetchedAt = now;
    try {
      const series = await this.api.series(now - WINDOW, now);
      const changed = this.evaluate(series, { now });
      this.last = { ...this.last, checkedAt: now, asOf: dataEnd(series), error: null };
      if (changed) this.onChange();
    } catch (e) {
      this.last = { ...this.last, checkedAt: now, error: e.message };
    }
    this.db.setMeta('workouts:last', this.last);
  }

  /* ── judging the data ────────────────────────────────────────────── */

  /**
   * One pass over a minute series: new detections, ends, the "started?" and
   * "ended?" prompts (each at most once per workout), forgotten hand-started
   * workouts. Returns whether anything changed.
   */
  evaluate(series, { now = this.now(), asOf = dataEnd(series) } = {}) {
    const s = this.settings();
    const rest = this.rest();
    const from = series.length ? series[0].t : now - WINDOW;
    const recs = this.db.workoutsSince(from - 24 * HOUR);
    // Google's own sessions (the Air, an app, a manual log in Google Health)
    // and sleep. A blip of a few seconds (a phantom "swim") is not a session.
    const ours = new Set(recs.map((r) => r.google?.name && tailOf(r.google.name)).filter(Boolean));
    const foreign = (this.external?.(from - 12 * HOUR) || [])
      .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
      .filter((x) => x.kind === 'sleep' || (x.end - x.start >= 5 * MIN && !ours.has(tailOf(x.id))));
    let changed = false;
    const save = (r) => { this.#put(r); changed = true; };
    const end0 = (r) => r.end ?? r.lastEnd ?? asOf ?? now;

    // 1. Something open turned up in Google from elsewhere: that copy wins.
    for (const r of recs) {
      if (!(r.status === 'ongoing' || r.status === 'review' || (r.status === 'running' && r.source === 'detected'))) continue;
      const len = Math.max(MIN, end0(r) - r.start);
      const hit = foreign.find((x) => x.kind === 'exercise' && overlapMs(x.start, x.end, r.start, end0(r)) >= Math.min(10 * MIN, len / 2));
      if (hit) { r.status = 'superseded'; r.supersededBy = hit.name || tailOf(hit.id); save(r); }
    }

    const tracked = recs.filter(TRACKED);
    const exclusions = [
      ...foreign.map((x) => ({ start: x.start, end: x.end })),
      ...recs.filter((r) => !TRACKED(r)).map((r) => ({
        start: r.start,
        end: r.status === 'running' ? Number.MAX_SAFE_INTEGER : (r.end ?? r.lastEnd ?? r.start + MIN),
      })),
    ];
    const matched = new Set();

    // 2. Detection.
    if (s.enabled) {
      for (const g of detect(series, { ...s, rest, exclusions, asOf })) {
        const r = tracked.find((t) => !matched.has(t.id) && t.start < g.end && g.start < (t.lastEnd ?? t.start) + s.calmMin * MIN);
        if (r) {
          matched.add(r.id);
          if (this.#advance(r, g, s, series, asOf)) save(r);
          continue;
        }
        // Heart rate stays up for a while after a session (and on the walk
        // home): a rise soon after a workout ends is its tail, not another.
        const after = recs.some((x) => x.status !== 'discarded' && x.status !== 'merged' && Number.isFinite(x.end ?? x.lastEnd)
          && g.start >= (x.end ?? x.lastEnd) - MIN && g.start - (x.end ?? x.lastEnd) <= 3 * s.calmMin * MIN);
        if (after) continue;
        // Right next to a session Google already has (a gym log started late
        // or ended early): the same workout.
        const beside = foreign.some((x) => x.kind === 'exercise' && !LOCOMOTION.test(String(x.type || ''))
          && g.start <= x.end + s.calmMin * MIN && x.start <= g.end + s.calmMin * MIN);
        if (beside) continue;
        if (g.ongoing) {
          if (!startWorthy(g, s)) continue;
          const r2 = this.#add({ status: 'ongoing', source: 'detected', start: g.start, end: null, lastEnd: g.end, activeMin: g.activeMin, avgHr: g.avgHr, maxHr: g.maxHr, steps: g.steps, threshold: rest + s.plusBpm, trace: traceOf(series, g.start, asOf ?? g.end) });
          const why = this.#startBlocked(g, now);
          if (why) r2.prompts.start = `skipped: ${why}`;
          else this.#prompt(r2, 'start');
          save(r2);
        } else {
          if (!workoutWorthy(g, s) || now - g.end > 12 * HOUR) continue;
          // Only seen once it was over (the phone synced late): one prompt,
          // the end, with both times.
          const r2 = this.#add({ status: 'review', source: 'detected', start: g.start, end: g.end, lastEnd: g.end, activeMin: g.activeMin, avgHr: g.avgHr, maxHr: g.maxHr, steps: g.steps, threshold: rest + s.plusBpm, trace: traceOf(series, g.start, g.end) });
          r2.prompts.start = 'skipped: seen only after it ended';
          this.#prompt(r2, 'end');
          save(r2);
        }
      }
    }

    // 3. Tracked workouts the detector no longer sees (data revised, a stretch
    //    cut by something new): judge them on what is known, once calm.
    for (const r of tracked) {
      if (matched.has(r.id)) continue;
      const lastEnd = r.lastEnd ?? r.start;
      if (asOf === null || asOf - lastEnd < s.calmMin * MIN) continue;
      if (r.status === 'dismissed') { r.quiet = 'closed'; r.end = lastEnd; save(r); continue; }
      if (!OPEN.has(r.status)) continue;
      const worthy = (r.activeMin || 0) >= s.minStartMin && lastEnd - r.start >= s.minTotalMin * MIN;
      if (r.status === 'ongoing' && !worthy) { r.status = 'discarded'; r.end = lastEnd; save(r); continue; }
      r.status = 'review'; r.end = r.endEdited ? r.end : lastEnd;
      this.#prompt(r, 'end');
      save(r);
    }

    // 4. Hand-started workouts left running: calm for long (or six hours
    //    in), close them for review — never saved without a yes.
    for (const r of recs) {
      if (r.status !== 'running' || r.source === 'detected') continue;
      const c = calmSince(series, { from: r.start, rest, plusBpm: s.plusBpm, autoCloseMin: s.autoCloseMin, asOf });
      const calmLong = c.calm && asOf - r.start >= s.autoCloseMin * MIN;
      if (!calmLong && now - r.start < MAX_RUN) continue;
      r.end = Math.min(now, Math.max(r.start + 5 * MIN, c.lastActive ?? (r.start + s.minTotalMin * MIN)));
      r.status = 'review';
      r.autoClosed = c.lastActive ? 'calm' : 'no raised heart rate seen';
      Object.assign(r, statsOver(series, r.start, r.end));
      r.trace = traceOf(series, r.start, r.end);
      this.#prompt(r, 'end');
      save(r);
    }
    return changed;
  }

  /** A detection's stretch, seen again. Returns whether the row changed. */
  #advance(r, g, s, series, asOf) {
    if (r.status === 'dismissed') {
      // "Not a workout": follow it in silence until it is over.
      r.lastEnd = g.end; r.end = Math.max(r.end || 0, g.end);
      if (!g.ongoing) r.quiet = 'closed';
      return true;
    }
    if (!r.startEdited && g.start < r.start) r.start = g.start;
    r.lastEnd = g.end;
    r.activeMin = Math.max(r.activeMin || 0, g.activeMin);
    Object.assign(r, statsOver(series, r.start, g.end));
    r.trace = traceOf(series, r.start, g.ongoing ? (asOf ?? g.end) : g.end);
    if (!g.ongoing) {
      if (r.status === 'ongoing' && !workoutWorthy(g, s)) {
        r.status = 'discarded'; r.end = g.end;
      } else {
        r.status = 'review';
        if (!r.endEdited) r.end = g.end;
        this.#prompt(r, 'end');
      }
    }
    return true;
  }

  /** Why a "started?" prompt would be pointless: too old, or at night. */
  #startBlocked(g, now) {
    if (now - g.start > STALE_START) return 'it started over an hour before the data arrived';
    const h = Number(clockIn(g.start, this.tz).slice(0, 2));
    if (h >= NIGHT[0] && h < NIGHT[1]) return 'night';
    return null;
  }

  /** Send a workout's start or end prompt — once, ever. */
  #prompt(r, kind) {
    r.prompts ||= {};
    if (r.prompts[kind]) return;
    const id = `workout_${kind}`;
    if (!this.notifyOn(id)) { r.prompts[kind] = 'off'; return; }
    const a = clockIn(r.start, this.tz);
    let title; let body;
    if (kind === 'start') {
      title = 'Workout started?';
      body = `Looks like a workout started at ${a}. Tap to confirm.`;
    } else {
      const b = clockIn(r.end, this.tz);
      const min = Math.round((r.end - r.start) / MIN);
      const save = this.canWrite() ? 'Tap to save it.' : 'Tap to review it (saving to Google Health needs a reconnect).';
      if (r.autoClosed) {
        title = 'Workout ended?';
        body = `You started a workout at ${a}${r.autoClosed === 'calm' ? ` and have been calm since ${b}` : ''}. End it at ${b} (${min} min)? Tap to confirm the end time.`;
      } else {
        title = 'Workout ended?';
        body = `Workout ${a} to ${b} (${min} min). ${save}`;
      }
    }
    try {
      this.emit(id, title, body, { tag: `workout:${r.id}`, url: `/workouts/${r.id}` });
    } catch (e) { this.log(`workout prompt: ${e.message}`); }
    r.prompts[kind] = this.now();
  }

  /* ── answers and actions ─────────────────────────────────────────── */

  #times(start, end, { open = false, route = false } = {}) {
    const now = this.now();
    const s = Number(start); const e = end === undefined || end === null ? null : Number(end);
    if (!Number.isFinite(s)) throw bad('start is required');
    if (s > now + 2 * MIN) throw bad('A workout cannot start in the future.');
    // A route (a GPX file) may be years old; a workout typed in, a month.
    if (s < now - (route ? 3650 : 30) * 24 * HOUR) throw bad(route ? 'That is more than ten years ago.' : 'That is more than 30 days ago.');
    if (open && e === null) return { start: s, end: null };
    if (!Number.isFinite(e)) throw bad('end is required');
    if (e > now + 2 * MIN) throw bad('A workout cannot end in the future.');
    if (e - s < (route ? 1 : 5) * MIN) throw Object.assign(bad(route ? 'A route must be at least a minute long.' : 'A workout must be at least 5 minutes long.'), { code: 'too_short' });
    if (e - s > (route ? 24 * HOUR : MAX_RUN)) throw bad(route ? 'A route cannot be longer than 24 hours.' : 'A workout cannot be longer than 6 hours.');
    return { start: s, end: e };
  }

  /** Start now (by hand). An open detection becomes part of it. */
  startNow(at) {
    const t = at === undefined ? this.now() : this.#times(at, null, { open: true }).start;
    const run = this.running();
    if (run) throw bad(`A workout is already running (started ${clockIn(run.start, this.tz)}).`, 409);
    const r = this.#add({ status: 'running', source: 'manual', start: t, end: null });
    for (const o of this.open()) {
      if (o.status === 'ongoing') { o.status = 'merged'; o.mergedInto = r.id; o.end = Math.max(o.start + MIN, Math.min(t, o.lastEnd ?? t)); this.#put(o); }
    }
    this.onChange();
    return r;
  }

  /** "Yes, I'm working out" — the answer to "started?". Late answers are
      harmless: on a workout already over it only notes the yes. */
  confirmStart(id, { start } = {}) {
    const r = this.get(id);
    if (r.status === 'ongoing') {
      if (start !== undefined && start !== null) { r.start = this.#times(start, null, { open: true }).start; r.startEdited = true; }
      r.status = 'running';
      r.startConfirmed = this.now();
    } else if (OPEN.has(r.status) || r.status === 'done') {
      r.startConfirmed ||= this.now();
    } else {
      throw bad(`This one was already answered (${r.status}).`, 409);
    }
    this.#put(r);
    this.onChange();
    return r;
  }

  /** End (by hand) now or at a time: saved straight away. */
  end(id, at) {
    const r = this.get(id);
    if (r.status === 'done') return r;
    if (!['running', 'ongoing', 'review'].includes(r.status)) throw bad(`This workout is ${r.status}.`, 409);
    const e = r.status === 'review' && at === undefined ? r.end : (at === undefined ? Math.max(this.now(), r.start + 5 * MIN) : Number(at));
    const t = this.#times(r.start, Math.min(e, this.now() + MIN));
    r.end = t.end; r.endEdited = true; r.status = 'done'; r.endedBy = 'hand';
    r.google = { state: 'pending' };
    this.#put(r);
    this.onChange();
    return r;
  }

  /** Confirm (and maybe adjust) a workout; also edits a saved one's times. */
  save(id, { start, end } = {}) {
    const r = this.get(id);
    if (!['ongoing', 'running', 'review', 'done'].includes(r.status)) throw bad(`This workout is ${r.status}.`, 409);
    const t = this.#times(start ?? r.start, end ?? r.end ?? r.lastEnd);
    const moved = t.start !== r.start || t.end !== r.end;
    if (r.status === 'done' && !moved) return r;
    this.#clash(t, r.id);
    if (moved) { r.statsFor = null; r.startEdited = r.startEdited || t.start !== r.start; r.endEdited = true; }
    r.start = t.start; r.end = t.end;
    const wasSaved = r.status === 'done' && r.google?.state === 'saved';
    r.status = 'done';
    r.confirmedAt = this.now();
    r.google = wasSaved ? { ...r.google, dirty: true } : { state: 'pending' };
    this.#put(r);
    this.onChange();
    return r;
  }

  /** "Not a workout" (or throw away a hand-started one). */
  dismiss(id) {
    const r = this.get(id);
    if (r.status === 'running' && r.source !== 'detected') r.status = 'cancelled';
    else if (['ongoing', 'running', 'review'].includes(r.status)) {
      // Still going: stay quiet for the rest of this stretch too.
      if (r.status !== 'review') r.quiet = 'open';
      r.status = 'dismissed';
      r.end ||= r.lastEnd ?? this.now();
    }
    else if (r.status === 'dismissed' || r.status === 'cancelled') return r;
    else throw bad(`This workout is ${r.status}; delete it instead.`, 409);
    r.end ||= this.now();
    this.#put(r);
    this.onChange();
    return r;
  }

  /** A workout that overlaps another one the person holds is refused. */
  #clash({ start, end }, self = null) {
    for (const o of this.db.workoutsSince(start - 12 * HOUR)) {
      if (o.id === self || !['done', 'running'].includes(o.status)) continue;
      const oe = o.end ?? this.now();
      if (overlapMs(start, end, o.start, oe) > 0) throw bad(`That overlaps the workout at ${clockIn(o.start, this.tz)}.`, 409);
    }
  }

  /** Log a past workout. Open detections in its period are folded into it. */
  logPast({ start, end, title, notes, type, route = false }) {
    const t = this.#times(start, end, { route });
    this.#clash(t);
    const r = this.#add({
      status: 'done', source: 'logged', start: t.start, end: t.end, google: { state: 'pending' }, confirmedAt: this.now(),
      ...(title ? { title: String(title).slice(0, 80) } : {}), ...(notes ? { notes: String(notes).slice(0, 2000) } : {}), ...(validType(type) ? { type } : {}),
    });
    for (const o of this.db.workoutsSince(t.start - 12 * HOUR)) {
      if ((o.status === 'ongoing' || o.status === 'review') && overlapMs(t.start, t.end, o.start, o.end ?? o.lastEnd ?? this.now()) > 0) {
        o.status = 'merged'; o.mergedInto = r.id; o.end ||= o.lastEnd ?? t.end; this.#put(o);
      }
    }
    this.onChange();
    return r;
  }

  /** Delete: from Google first (only what this module wrote), then here. */
  async remove(id) {
    const r = this.get(id);
    if (r.status === 'deleted') return r;
    if (r.status === 'running' || r.status === 'ongoing' || r.status === 'review') return this.dismiss(id);
    if (r.google?.state === 'saved' && r.google.name) {
      try {
        await this.api.remove([r.google.name], r.google.acct);
      } catch (e) {
        if (e.status !== 404) throw bad(`Google Health refused the delete: ${e.message}`, e.status === 403 ? 409 : 502);
      }
      this.db.deleteExercise(r.google.name);
    }
    r.status = 'deleted';
    r.google = r.google ? { ...r.google, state: r.google.state === 'saved' ? 'deleted' : r.google.state } : null;
    this.#put(r);
    this.onChange();
    return r;
  }

  retry(id) {
    const r = this.get(id);
    if (r.status !== 'done') throw bad('Only a confirmed workout is saved.', 409);
    if (r.google?.state === 'saved' && !r.google.dirty) return r;
    r.google = { ...(r.google || {}), state: r.google?.state === 'saved' ? 'saved' : 'pending', attempts: 0 };
    this.#put(r);
    return r;
  }

  /* ── to Google ───────────────────────────────────────────────────── */

  /** Save every confirmed workout not yet in Google (or edited since). */
  async flush({ force = false } = {}) {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      let n = 0;
      // At most twenty a pass: a big Hevy import sent to Google goes up over
      // a few passes instead of in one burst that earns a 429.
      for (const r of this.db.workoutsToFlush(20)) {
        const g = r.google || {};
        if (g.state === 'saved' && !g.dirty) continue;
        // Kept here only, uploaded by the linked module, or already in Google
        // from the device: nothing for this app to write.
        if (g.state === 'local' || g.state === 'remote' || g.state === 'foreign') continue;
        // Brought in from Hevy or Strava: those apps may send the same session
        // to Google themselves (through Health Connect), so it waits a while,
        // and goes only if Google still has nothing for that time.
        if (g.notBefore && this.now() < g.notBefore) continue;
        if (r.source === 'hevy' || r.source === 'strava') {
          const theirs = this.#googleCopy(r);
          if (theirs) { r.google = { state: 'foreign', name: theirs.id }; this.#put(r); n += 1; continue; }
        }
        if (!this.canWrite()) {
          if (g.state !== 'needs_scope') { r.google = { ...g, state: 'needs_scope' }; this.#put(r); n += 1; }
          continue;
        }
        if (g.state === 'failed' && !force && ((g.attempts || 0) >= MAX_TRIES || this.now() - (g.at || 0) < RETRY_AFTER)) continue;
        await this.#write(r);
        n += 1;
      }
      if (n) this.onChange();
      return n;
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** An exercise Google already holds for this workout's time (half or more
      of the shorter one), written by anything but this app. */
  #googleCopy(r) {
    const s = r.start; const e = r.end ?? r.lastEnd ?? r.start + MIN;
    const from = new Date(s - 2 * 86_400_000).toISOString().slice(0, 10);
    return this.db.exercises(from).find((x) => {
      if (x.id === r.google?.name) return false;
      const ov = Math.max(0, Math.min(e, x.endMs) - Math.max(s, x.startMs));
      return ov >= 0.5 * Math.max(MIN, Math.min(e - s, x.endMs - x.startMs));
    }) || null;
  }

  async #write(r) {
    const key = `${r.start}-${r.end}`;
    try {
      // The numbers that go with it: the wearer's own, for exactly this period.
      if (r.statsFor !== key) {
        try {
          const series = await this.api.series(r.start - TRACE_PAD, r.end + TRACE_PAD);
          const st = statsOver(series, r.start, r.end);
          r.avgHr = st.avgHr; r.maxHr = st.maxHr; r.steps = st.steps;
          r.trace = traceOf(series, r.start, r.end);
        } catch (e) { this.log(`workout stats: ${e.message}`); }
        try { r.kcal = await this.api.calories(r.start, r.end); } catch { r.kcal = null; }
        r.statsFor = key;
      }
      const g = r.google || {};
      const named = pointName(r.uid);
      const type = this.exerciseTypeFn();
      let name = null;
      // The Google account it is in: the one it was saved to, or for a new
      // point the main account (several accounts: worlds.js).
      let acct = this.api.acct?.() ?? null;
      if (g.state === 'saved' && g.dirty && g.name) {
        try {
          const op = await this.api.patch(g.name, exercisePayload(r, { tz: this.tz, type }), g.acct);
          name = op?.response?.name || g.name;
          acct = g.acct ?? null;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      if (!name) {
        let op;
        try {
          op = await this.api.create(exercisePayload(r, { tz: this.tz, name: named, type }));
          name = op?.response?.name || (op?.done === false ? named : null);
        } catch (e) {
          if (e.status === 409) name = named;                     // a retry of a create that did land
          else if (e.status === 400 && /name/i.test(e.message)) { // a server that names its own points
            op = await this.api.create(exercisePayload(r, { tz: this.tz, type }));
            name = op?.response?.name || null;
          } else throw e;
        }
        if (!name && this.api.findOwn) name = await this.api.findOwn(r.start).catch(() => null);
        name ||= named;
      }
      r.google = { state: 'saved', name, at: this.now(), dirty: false, ...(acct ? { acct } : {}) };
    } catch (e) {
      const g = r.google || {};
      r.google = { ...g, state: 'failed', error: String(e.message || e).slice(0, 300), at: this.now(), attempts: (g.attempts || 0) + 1, dirty: g.dirty };
      if (g.state === 'saved') r.google.name = g.name;
      this.log(`workout ${r.id} not saved: ${e.message}`);
    }
    this.#put(r);
  }

  /* ── what the page sees ──────────────────────────────────────────── */

  view() {
    const s = this.settings();
    const rest = this.rest();
    const all = this.db.workoutsSince(this.now() - 60 * 24 * HOUR);
    const pub = (r) => {
      const { statsFor, ...x } = r;
      return x;
    };
    const SHOWN = new Set(['done', 'superseded']);
    return {
      settings: s,
      rest,
      threshold: rest + s.plusBpm,
      canWrite: !!this.canWrite(),
      exerciseType: this.exerciseTypeFn(),
      running: (() => { const r = all.find((x) => x.status === 'running'); return r ? pub(r) : null; })(),
      pending: all.filter((r) => r.status === 'ongoing' || r.status === 'review').map(pub),
      history: all.filter((r) => SHOWN.has(r.status)).sort((a, b) => b.start - a.start).slice(0, 40).map(pub),
      last: { checkedAt: this.last.checkedAt, asOf: this.last.asOf, error: this.last.error },
      unsaved: all.filter((r) => r.status === 'done' && r.google?.state !== 'saved').length,
    };
  }
}
