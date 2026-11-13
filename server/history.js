/* ============================================================
   health.ojee.net — one person's workout history, unified.

   Two places hold workouts: this app's own rows (detected, started
   by hand, logged, imported from Hevy) and the exercises Google
   Health has from the person's watch and other apps. The history
   shows both as one list. A Google exercise that IS one of this
   app's workouts (this app wrote it, or it covers the same session)
   is shown once, as the app's row.
   ============================================================ */

import { EXERCISE_TYPES, EXERCISE_TYPE, titleFor } from './core/workouts.js';
import { workHoursOf, hiddenAtWork } from './workhours.js';
export { titleFor };

const MIN = 60_000;
const tail = (name) => String(name || '').split('/').pop();
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
export const sameSession = (a0, a1, b0, b1) => overlap(a0, a1, b0, b1) >= 0.5 * Math.max(MIN, Math.min(a1 - a0, b1 - b0));

/** "WEIGHT_MACHINES" → "Weight machines", for a type with no label of ours. */
export const typeLabel = (t) => EXERCISE_TYPES[t] || (t ? String(t).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Workout');

/** An id for a Google-only exercise that is safe in a URL path. */
export const mirrorId = (exerciseId) => `g-${tail(exerciseId).replace(/[^A-Za-z0-9_-]/g, '_')}`;

/**
 * A watch's own "Activity" (Fitbit's word for movement it noticed but could
 * not name, Google's CARDIO_WORKOUT) that came back here through Strava or
 * detection as an unnamed "Workout": it was not a workout, and it says so,
 * until the person makes it one (a routine, sets, a type or a name of
 * their own).
 */
const AUTO_TITLE = /^((Morning|Lunch|Afternoon|Evening|Night) )?(Workout|Activity)$/;
/** Strava's own names for what it was given ("Afternoon Walk"): nobody typed them. */
const STRAVA_AUTO = /^((Morning|Lunch|Afternoon|Evening|Night) )?(Workout|Activity|Walk|Run|Ride|Hike|Swim)$/;
/** Strava had it from Google Health or the Fitbit itself: the watch's own record knows better what it was. */
const fromGoogle = (r) => r.source === 'strava' && /google|fitbit/i.test(String(r.strava?.device || ''));
/** Untouched by the person: no type of theirs, name, routine or sets. */
function untouched(r, sets) {
  if (r.routineId || sets > 0 || r.draft) return false;
  if (fromGoogle(r)) return !r.title || STRAVA_AUTO.test(String(r.title));
  if (r.type && r.type !== 'WORKOUT') return false;
  return !r.title || AUTO_TITLE.test(String(r.title));
}
export function isGeneric(r, twin, sets = 0) {
  if (!r || !twin) return false;
  if (!(String(twin.name || '') === 'Activity' && (twin.type === 'CARDIO_WORKOUT' || twin.type === 'WORKOUT'))) return false;
  return untouched(r, sets);
}
/**
 * What an untouched, unnamed "Workout" (from Strava or detection) shows as:
 * the watch's own name and type for the same session ("Power walk"), or
 * "Activity" for the watch's own generic one. Null when it is the person's
 * (named, a type chosen, a routine or sets) or the watch had no name for it.
 */
export function shownAs(r, twin, sets = 0) {
  if (!r || !twin || !untouched(r, sets)) return null;
  if (isGeneric(r, twin, sets)) return { title: 'Activity', type: 'ACTIVITY', generic: true };
  if (!twin.type || twin.type === 'WORKOUT') return null;
  return { title: String(twin.name || typeLabel(twin.type)), type: twin.type, generic: false };
}
const genericWatch = (e) => String(e?.name || '') === 'Activity' && (e?.type === 'CARDIO_WORKOUT' || e?.type === 'WORKOUT');

/** A distance worth showing: none for 0 (Strava says 0 for a workout without GPS). */
const pos = (m) => (Number.isFinite(m) && m > 0 ? m : null);
/** How far one of this app's rows went: its route, the row itself, then Strava, the first that is more than 0. */
export const rowDistance = (r) => pos(r?.route?.distanceM) ?? pos(r?.distanceM) ?? pos(r?.strava?.distanceM);

/** A row of this app, as the API shows it. */
export function workoutView(r, { totals = {}, defaultType = EXERCISE_TYPE, as = null } = {}) {
  const generic = !!as?.generic;
  const end = r.end ?? null;
  const g = r.google;
  return {
    id: String(r.id), uid: r.uid, source: r.source, status: r.status,
    start: r.start, end,
    durationMin: end ? Math.round((end - r.start) / MIN) : null,
    title: as ? as.title : r.title || titleFor(r.type || defaultType),
    type: as ? as.type : r.type || defaultType,
    generic,
    notes: r.notes ?? null,
    avgHr: r.avgHr ?? null, maxHr: r.maxHr ?? null, steps: r.steps ?? null, kcal: r.kcal ?? null, activeMin: r.activeMin ?? null,
    google: g ? { state: g.state || null, name: g.name || null, error: g.error || null, dirty: !!g.dirty } : null,
    sets: totals[r.id] || null,
    readOnly: false,
    prompts: r.prompts || {},
    lastEnd: r.lastEnd ?? null,
    autoClosed: r.autoClosed || null,
    updatedAt: r.updated,
    // Logged from a routine; logged set by set right now; a route.
    routineId: r.routineId || null,
    logging: !!r.draft,
    gps: r.route || null,
    // How far, wherever it came from: the route, the row itself (detected, logged), Strava.
    distanceM: rowDistance(r),
  };
}

/** A Google exercise this app holds no row for, as the API shows it. */
export function mirrorView(e) {
  return {
    // Read only: a session Google holds, or an activity Garmin recorded (garminsync.js).
    id: mirrorId(e.id), uid: null, source: String(e.id).startsWith('garmin-') ? 'garmin' : 'google', status: 'done',
    start: e.startMs, end: e.endMs, durationMin: Math.round((e.endMs - e.startMs) / MIN),
    title: e.name || typeLabel(e.type), type: genericWatch(e) ? 'ACTIVITY' : e.type || 'WORKOUT', generic: genericWatch(e), notes: null,
    avgHr: e.avgHr ?? null, maxHr: null, steps: e.steps ?? null, kcal: e.kcal ?? null, activeMin: e.azm ?? null,
    google: { state: 'foreign', name: e.id, error: null, dirty: false },
    sets: null, readOnly: true, prompts: {}, lastEnd: e.endMs, autoClosed: null, updatedAt: e.endMs,
    distanceM: pos(e.distanceM),
  };
}

/**
 * Confirmed workouts from a time on, both kinds, oldest first.
 * @returns {Array<{ local: object|null, ex: object|null, start: number, end: number }>}
 */
export function unified(db, fromMs = 0) {
  const local = db.workoutsDoneFrom(fromMs);
  // Every row that names a Google point, whatever became of it: a workout
  // deleted here must not come back as "Google's".
  const named = new Set(db.workoutsSince(fromMs - 86_400_000).map((r) => r.google?.name && tail(r.google.name)).filter(Boolean));
  const fromDate = new Date(Math.max(0, fromMs - 86_400_000)).toISOString().slice(0, 10);
  const exs = db.exercises(fromDate);
  const sets = db.setTotals?.() || {};
  // A workout kept here stands for the watch's record of the same session; when
  // it says only "Workout", the watch's own type ("Weight machines") is what it was.
  const out = local.map((r) => {
    const twin = exs.find((e) => sameSession(r.start, r.end ?? r.start, e.startMs, e.endMs) && e.type && e.type !== 'WORKOUT');
    const n = sets[r.id]?.sets || 0;
    const as = shownAs(r, twin, n);
    const s = { local: r, ex: null, start: r.start, end: r.end ?? r.start, twinType: twin?.type || null, sets: n, generic: !!as?.generic, as };
    // Treadmill, "Running", "Walking" in the sets (core/foot.js): a workout of only those is a run
    // or a walk; in a gym session their metres still count for the run and walk boards.
    const foot = sets[r.id]?.foot;
    if (foot) {
      s.foot = { run: foot.run.m, walk: foot.walk.m };
      const untyped = !r.type || r.type === 'WORKOUT' || GYM.has(r.type);
      if (untyped && sets[r.id].cardioOnly && foot.run.s + foot.walk.s + foot.run.m + foot.walk.m > 0) {
        const run = foot.run.s + foot.run.m / 3 >= foot.walk.s + foot.walk.m / 2;
        s.footType = run ? 'TREADMILL' : 'TREADMILL_WALK';
        s.footM = run ? foot.run.m : foot.walk.m;
      }
    }
    return s;
  });
  // The same session from two places (a Garmin watch that also reaches Google
  // through Health Connect, two Google accounts): one copy, the one that says more.
  const detail = (e) => ['avgHr', 'kcal', 'distanceM', 'steps', 'azm', 'zones', 'paceSecPerKm', 'hasGps'].filter((k) => e[k] !== null && e[k] !== undefined && e[k] !== false).length;
  const mirrors = [];
  // Work hours (workhours.js): the watch's own guesses while at work are activity, not workouts.
  const wh = workHoursOf(db);
  for (const e of exs) {
    if (e.startMs < fromMs) continue;
    if (hiddenAtWork(e, wh)) continue;
    // A blip of a few seconds (a band's phantom "swim") is not a workout.
    if (e.endMs - e.startMs < MIN) continue;
    if (named.has(tail(e.id))) continue;
    if (local.some((r) => sameSession(r.start, r.end ?? r.start, e.startMs, e.endMs))) continue;
    const twin = mirrors.findIndex((m) => sameSession(m.startMs, m.endMs, e.startMs, e.endMs));
    if (twin >= 0) { if (detail(e) > detail(mirrors[twin])) mirrors[twin] = e; continue; }
    mirrors.push(e);
  }
  for (const e of mirrors) out.push({ local: null, ex: e, start: e.startMs, end: e.endMs, generic: genericWatch(e) });
  return out.sort((a, b) => a.start - b.start);
}

/* ── distance sports: the running, cycling and walking boards, and the feed ── */

/** Which exercise types count as a run, a ride, a walk or hike. An e-bike is
    not a ride (the motor did part of it), water jogging is not a run. */
export const SPORTS = {
  run: new Set(['RUNNING', 'TRAIL_RUN', 'TREADMILL', 'INCLINE_RUN', 'TRACK_AND_FIELD']),
  ride: new Set(['BIKING', 'OUTDOOR_BIKE', 'MOUNTAIN_BIKE', 'STATIONARY_BIKE', 'SPINNING', 'HAND_CYCLING']),
  walk: new Set(['WALKING', 'HIKING', 'NORDIC_WALKING', 'POWER_WALKING', 'RUCKING', 'TREADMILL_WALK', 'INCLINE_WALK', 'BACKPACKING', 'STROLLER_WALK', 'WALK_WITH_WEIGHTS', 'SNOWSHOEING']),
};
/** Gym sessions: strength work, for the gym boards (walks and runs are workouts too, but not these). */
export const GYM = new Set(['STRENGTH_TRAINING', 'WEIGHTLIFTING', 'WEIGHT_MACHINES', 'WEIGHTS', 'FREE_WEIGHTS', 'WEIGHT_TRAINING', 'CROSSFIT', 'CALISTHENICS', 'BODYWEIGHT_TRAINING', 'CIRCUIT_TRAINING', 'FUNCTIONAL_TRAINING', 'POWERLIFTING', 'KETTLEBELL']);
/** A gym session of unified(): its type says so, or it was logged here with no type (a strength workout, as the feed has it). */
export const isGym = (s) => !s.footType && (GYM.has(sessionType(s)) || Boolean(s.local && (!s.local.type || s.sets > 0)));
/** 'run' | 'ride' | 'walk' | null. */
export const sportOf = (type) => Object.keys(SPORTS).find((k) => SPORTS[k].has(type)) || null;

/** The type of a session of unified(). */
// What it was: as shown (an untouched copy takes the watch's own type), else its own, else the watch's.
export const sessionType = (s) => s.footType || (s.local ? (s.as ? (s.as.generic ? s.twinType || 'WORKOUT' : s.as.type) : s.local.type && s.local.type !== 'WORKOUT' ? s.local.type : s.twinType || s.local.type || null) : s.ex.type || null);

/** Metres of a session of unified(), or null: a route recorded here first,
    then what the row was given (a GPX file, a Strava activity), then what
    Google or Garmin says. */
export function sessionDistance(s) {
  return s.local ? rowDistance(s.local) ?? (s.footType ? pos(s.footM) : null) : pos(s.ex?.distanceM);
}
/** The distance others may be shown (boards): not one read from Strava (Strava's API agreement:
    a person's Strava data is for them alone). A session from Strava has none for others. */
export function publicDistance(s) {
  const r = s.local;
  if (!r) return pos(s.ex?.distanceM);
  if (r.source === 'strava') return null;
  return pos(r.route?.from === 'strava' ? null : r.route?.distanceM) ?? pos(r.distanceM) ?? (s.footType ? pos(s.footM) : null);
}
