/* ============================================================
   health.ojee.net — one person's workout history, unified.

   Two places hold workouts: this app's own rows (detected, started
   by hand, logged, imported from Hevy) and the exercises Google
   Health has from the person's watch and other apps. The history
   shows both as one list. A Google exercise that IS one of this
   app's workouts (this app wrote it, or it covers the same session)
   is shown once, as the app's row.
   ============================================================ */

import { EXERCISE_TYPES, EXERCISE_TYPE } from './core/workouts.js';

const MIN = 60_000;
const tail = (name) => String(name || '').split('/').pop();
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const sameSession = (a0, a1, b0, b1) => overlap(a0, a1, b0, b1) >= 0.5 * Math.max(MIN, Math.min(a1 - a0, b1 - b0));

/** "WEIGHT_MACHINES" → "Weight machines", for a type with no label of ours. */
export const typeLabel = (t) => EXERCISE_TYPES[t] || (t ? String(t).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Workout');

/** An id for a Google-only exercise that is safe in a URL path. */
export const mirrorId = (exerciseId) => `g-${tail(exerciseId).replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** A row of this app, as the API shows it. */
export function workoutView(r, { totals = {}, defaultType = EXERCISE_TYPE } = {}) {
  const end = r.end ?? null;
  const g = r.google;
  return {
    id: String(r.id), uid: r.uid, source: r.source, status: r.status,
    start: r.start, end,
    durationMin: end ? Math.round((end - r.start) / MIN) : null,
    title: r.title || typeLabel(r.type || defaultType),
    type: r.type || defaultType,
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
  };
}

/** A Google exercise this app holds no row for, as the API shows it. */
export function mirrorView(e) {
  return {
    // Read only: a session Google holds, or an activity Garmin recorded (garminsync.js).
    id: mirrorId(e.id), uid: null, source: String(e.id).startsWith('garmin-') ? 'garmin' : 'google', status: 'done',
    start: e.startMs, end: e.endMs, durationMin: Math.round((e.endMs - e.startMs) / MIN),
    title: e.name || typeLabel(e.type), type: e.type || 'WORKOUT', notes: null,
    avgHr: e.avgHr ?? null, maxHr: null, steps: e.steps ?? null, kcal: e.kcal ?? null, activeMin: e.azm ?? null,
    google: { state: 'foreign', name: e.id, error: null, dirty: false },
    sets: null, readOnly: true, prompts: {}, lastEnd: e.endMs, autoClosed: null, updatedAt: e.endMs,
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
    return { local: r, ex: null, start: r.start, end: r.end ?? r.start, twinType: twin?.type || null, sets: sets[r.id]?.sets || 0 };
  });
  // The same session from two places (a Garmin watch that also reaches Google
  // through Health Connect, two Google accounts): one copy, the one that says more.
  const detail = (e) => ['avgHr', 'kcal', 'distanceM', 'steps', 'azm', 'zones', 'paceSecPerKm', 'hasGps'].filter((k) => e[k] !== null && e[k] !== undefined && e[k] !== false).length;
  const mirrors = [];
  for (const e of exs) {
    if (e.startMs < fromMs) continue;
    // A blip of a few seconds (a band's phantom "swim") is not a workout.
    if (e.endMs - e.startMs < MIN) continue;
    if (named.has(tail(e.id))) continue;
    if (local.some((r) => sameSession(r.start, r.end ?? r.start, e.startMs, e.endMs))) continue;
    const twin = mirrors.findIndex((m) => sameSession(m.startMs, m.endMs, e.startMs, e.endMs));
    if (twin >= 0) { if (detail(e) > detail(mirrors[twin])) mirrors[twin] = e; continue; }
    mirrors.push(e);
  }
  for (const e of mirrors) out.push({ local: null, ex: e, start: e.startMs, end: e.endMs });
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
export const isGym = (s) => GYM.has(sessionType(s)) || Boolean(s.local && (!s.local.type || s.sets > 0));
/** 'run' | 'ride' | 'walk' | null. */
export const sportOf = (type) => Object.keys(SPORTS).find((k) => SPORTS[k].has(type)) || null;

/** The type of a session of unified(). */
export const sessionType = (s) => (s.local ? (s.local.type && s.local.type !== 'WORKOUT' ? s.local.type : s.twinType || s.local.type || null) : s.ex.type || null);

/** Metres of a session of unified(), or null: a route recorded here first,
    then what the row was given (a GPX file, a Strava activity), then what
    Google or Garmin says. */
export function sessionDistance(s) {
  const r = s.local;
  const m = r ? r.route?.distanceM ?? r.distanceM ?? r.strava?.distanceM : s.ex.distanceM;
  return Number.isFinite(m) && m > 0 ? m : null;
}
