/* ============================================================
   health.ojee.net — the training log: what a person's own workouts
   and sets add up to. Weeks, heart-rate zones, muscle balance,
   records, progress per exercise.

   The first half is pure: functions over plain sessions, sets and
   heart-rate traces, with the date and the zone passed in. The
   second half reads ONE person's world and hands those functions
   what they need. Like views.js, nothing here can reach anybody
   else's data.

   Heart rate comes only from traces this app already holds (a
   workout's own `trace`, a Google mirror's `trace:<id>` meta). The
   list never asks Google for one.

   docs/API.md ("Workouts") is the contract for every shape below.
   ============================================================ */

import { addDays, weekOf, daysBetween, round, clamp } from './core/util.js';
import { unified, mirrorId } from './history.js';
import { MUSCLES } from './muscles.js';

const MIN = 60_000;
const DAY = 86_400_000;
export const WEEKS = 12;
export const ZONE_LABELS = ['Easy', 'Light', 'Moderate', 'Hard', 'Peak'];
export const ZONE_NOTE = 'Zones are estimated from your resting heart rate and the highest heart rate recorded in your workouts';
const ZONE_AT = [0.5, 0.6, 0.7, 0.8];
const MAX_FLOOR = 170; const MAX_CAP = 205; const MAX_UNKNOWN = 190;

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const dowOf = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;   // 0 = Monday

/* ── strength arithmetic ──────────────────────────────────────────── */

/** Estimated one-rep max (Epley), to 0.1 kg. Only for 1–12 reps of a real weight. */
export function e1rm(kg, reps) {
  if (!(kg > 0) || !Number.isFinite(reps) || reps < 1 || reps > 12) return null;
  return round(kg * (1 + reps / 30), 1);
}

/** Does this set count towards a best: not a warm-up, a real weight, at least one rep. */
const counts = (s) => s.type !== 'warmup' && s.kg > 0 && s.reps >= 1;

/* ── heart-rate zones ─────────────────────────────────────────────── */

/** The beats a trace holds inside the workout itself (the trace has 20 minutes either side). */
export function beatsIn(trace, start, end) {
  const out = [];
  if (!Array.isArray(trace)) return out;
  for (const m of trace) if (m[0] >= start && m[0] < end && Number.isFinite(m[1])) out.push(m[1]);
  return out;
}

/**
 * Zones by heart-rate reserve: bounds at 50/60/70/80% of the way from rest
 * to max. `peaks` are the highest beats seen in workouts; the max is the
 * highest of them, never under 170 nor over 205, and 190 when there are none.
 */
export function zoneModel(rest, peaks = []) {
  const seen = peaks.filter(Number.isFinite);
  const max = seen.length ? clamp(Math.round(seen.reduce((a, b) => Math.max(a, b), 0)), MAX_FLOOR, MAX_CAP) : MAX_UNKNOWN;
  return { rest, max, bounds: ZONE_AT.map((f) => Math.round(rest + f * (max - rest))), labels: ZONE_LABELS, note: ZONE_NOTE };
}

/** 0–4: which zone a heart rate is in. Under the first bound is still zone 1 (index 0). */
export const zoneOf = (bpm, bounds) => bounds.reduce((n, b) => n + (bpm >= b ? 1 : 0), 0);

/** Minutes in each of the five zones during a workout, or null without a trace. */
export function zoneMinutes(trace, start, end, bounds) {
  const beats = beatsIn(trace, start, end);
  if (!beats.length) return null;
  const out = [0, 0, 0, 0, 0];
  for (const b of beats) out[zoneOf(b, bounds)] += 1;
  return out;
}

/** The in-workout trace as at most `n` means, oldest first, or null. */
export function sparkOf(trace, start, end, n = 32) {
  const beats = beatsIn(trace, start, end);
  if (!beats.length) return null;
  if (beats.length <= n) return beats.map((b) => Math.round(b));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const part = beats.slice(Math.floor((i * beats.length) / n), Math.floor(((i + 1) * beats.length) / n));
    out.push(Math.round(mean(part)));
  }
  return out;
}

/* ── weeks ────────────────────────────────────────────────────────── */

/**
 * The last `n` Monday weeks, oldest first.
 * @param sessions [{ date, start, end, zonesMin }] with `date` in the person's zone
 * @param sets     [{ date, muscle, kg, reps, sets }]
 */
export function weekBuckets(sessions, sets, today, n = WEEKS, ws = 1) {
  const first = addDays(weekOf(today, ws), -7 * (n - 1));
  const out = [];
  const at = new Map();
  for (let w = first; w <= today; w = addDays(w, 7)) {
    const x = { week: w, workouts: 0, minutes: 0, sets: 0, volumeKg: 0, byMuscle: Object.fromEntries(MUSCLES.map((m) => [m, 0])), zonesMin: null };
    out.push(x); at.set(w, x);
  }
  for (const s of sessions) {
    const x = at.get(weekOf(s.date, ws));
    if (!x) continue;
    x.workouts += 1;
    x.minutes += Math.max(0, (s.end - s.start) / MIN);
    if (s.zonesMin) { x.zonesMin ||= [0, 0, 0, 0, 0]; s.zonesMin.forEach((v, i) => { x.zonesMin[i] += v; }); }
  }
  for (const s of sets) {
    const x = at.get(weekOf(s.date, ws));
    if (!x) continue;
    const k = s.sets || 1;
    const vol = (s.kg || 0) * (s.reps || 0) * k;
    x.sets += k; x.volumeKg += vol;
    x.byMuscle[MUSCLES.includes(s.muscle) ? s.muscle : 'other'] += vol;
  }
  for (const x of out) {
    x.minutes = Math.round(x.minutes); x.volumeKg = Math.round(x.volumeKg);
    for (const m of MUSCLES) x.byMuscle[m] = Math.round(x.byMuscle[m]);
  }
  return out;
}

/** This week against the mean of the four complete weeks before it. */
export function weekSummary(weeks) {
  const cur = weeks[weeks.length - 1];
  const prior = weeks.slice(-5, -1);
  const avg = (k, p) => (prior.length ? round(mean(prior.map((w) => w[k])), p) : 0);
  return {
    start: cur.week, workouts: cur.workouts, minutes: cur.minutes, sets: cur.sets, volumeKg: cur.volumeKg,
    avg4: { workouts: avg('workouts', 1), minutes: avg('minutes', 0), sets: avg('sets', 1), volumeKg: avg('volumeKg', 0) },
  };
}

/** Sessions per weekday (0 = Monday) among those dated from `from` on. */
export function weekdayCounts(sessions, from = '0000-00-00') {
  const out = Array.from({ length: 7 }, (_, dow) => ({ dow, workouts: 0 }));
  for (const s of sessions) if (s.date >= from) out[dowOf(s.date)].workouts += 1;
  return out;
}

/** Sessions per start hour (0–23, the person's clock) among those dated from `from` on. */
export function hourCounts(sessions, from = '0000-00-00') {
  const out = new Array(24).fill(0);
  for (const s of sessions) if (s.date >= from && Number.isInteger(s.hour) && s.hour >= 0 && s.hour < 24) out[s.hour] += 1;
  return out;
}

/** Medians of what a session usually is, over the sessions given. */
export function usualOf(sessions) {
  const dur = median(sessions.filter((s) => s.end > s.start).map((s) => (s.end - s.start) / MIN));
  const hr = median(sessions.map((s) => s.avgHr));
  const vol = median(sessions.map((s) => s.volumeKg).filter((v) => v > 0));
  return { durationMin: dur === null ? null : Math.round(dur), avgHr: hr === null ? null : Math.round(hr), volumeKg: vol === null ? null : Math.round(vol) };
}

/* ── muscles ──────────────────────────────────────────────────────── */

/** Every muscle group over the last 28 days, with when it was last trained at all. */
export function balance(sets, today) {
  const from = addDays(today, -27);
  const by = Object.fromEntries(MUSCLES.map((m) => [m, { muscle: m, sets4w: 0, volumeKg4w: 0, sharePct: 0, lastAt: null, daysSince: null, _date: null }]));
  let total = 0;
  for (const s of sets) {
    const x = by[MUSCLES.includes(s.muscle) ? s.muscle : 'other'];
    if (s.date <= today && (x._date === null || s.date > x._date || (s.date === x._date && (s.t || 0) > (x.lastAt || 0)))) { x._date = s.date; x.lastAt = s.t ?? null; }
    if (s.date < from || s.date > today) continue;
    const k = s.sets || 1;
    x.sets4w += k; x.volumeKg4w += (s.kg || 0) * (s.reps || 0) * k; total += k;
  }
  return MUSCLES.map((m) => {
    const { _date, ...x } = by[m];
    x.volumeKg4w = Math.round(x.volumeKg4w);
    x.sharePct = total ? round((x.sets4w / total) * 100, 1) : 0;
    x.daysSince = _date ? daysBetween(_date, today) : null;
    return x;
  });
}

/* ── exercises, session by session ────────────────────────────────── */

/**
 * Every exercise as its sessions, oldest first, each knowing the best that
 * stood before it. A session is one workout, or one day of free-standing sets.
 * @param sets [{ date, t, exercise, muscle, type, kg, reps, sets, workoutId }]
 * @returns Map<name, { name, muscle, bestKg, bestE1rm, sessions: [{ workoutId, t, date,
 *   topKg, topReps, e1rm, volumeKg, sets, prevKg, prevE1rm }] }>
 */
export function exerciseHistory(sets) {
  const by = new Map();
  for (const s of sets) {
    let ex = by.get(s.exercise);
    if (!ex) { ex = { name: s.exercise, muscle: s.muscle, bestKg: null, bestE1rm: null, _s: new Map() }; by.set(s.exercise, ex); }
    const key = s.workoutId !== null && s.workoutId !== undefined ? `w${s.workoutId}` : `d${s.date}`;
    let x = ex._s.get(key);
    if (!x) { x = { workoutId: s.workoutId ?? null, t: s.t, date: s.date, topKg: null, topReps: null, e1rm: null, volumeKg: 0, sets: 0, prevKg: null, prevE1rm: null }; ex._s.set(key, x); }
    const k = s.sets || 1;
    x.sets += k; x.volumeKg += (s.kg || 0) * (s.reps || 0) * k;
    if (s.t < x.t) x.t = s.t;
    if (!counts(s)) continue;
    if (x.topKg === null || s.kg > x.topKg || (s.kg === x.topKg && s.reps > x.topReps)) { x.topKg = s.kg; x.topReps = s.reps; }
    const e = e1rm(s.kg, s.reps);
    if (e !== null && (x.e1rm === null || e > x.e1rm)) x.e1rm = e;
  }
  for (const ex of by.values()) {
    ex.sessions = [...ex._s.values()].sort((a, b) => a.t - b.t);
    delete ex._s;
    for (const x of ex.sessions) {
      x.volumeKg = Math.round(x.volumeKg);
      x.prevKg = ex.bestKg; x.prevE1rm = ex.bestE1rm;
      if (x.topKg !== null && (ex.bestKg === null || x.topKg > ex.bestKg)) ex.bestKg = x.topKg;
      if (x.e1rm !== null && (ex.bestE1rm === null || x.e1rm > ex.bestE1rm)) ex.bestE1rm = x.e1rm;
    }
  }
  return by;
}

/** The records one session set: a best beaten, never a first-ever lift. */
function recordsOf(x) {
  const out = [];
  if (x.topKg !== null && x.prevKg !== null && x.topKg > x.prevKg) out.push({ kind: 'weight', value: x.topKg, previous: x.prevKg });
  if (x.e1rm !== null && x.prevE1rm !== null && x.e1rm > x.prevE1rm) out.push({ kind: 'e1rm', value: x.e1rm, previous: x.prevE1rm });
  return out;
}

/** Records set in the last `days` days, newest first. */
export function recentPrs(history, today, { days = 30, max = 12 } = {}) {
  const from = addDays(today, -days);
  const out = [];
  for (const ex of history.values()) {
    for (const x of ex.sessions) {
      if (x.date < from || x.date > today) continue;
      for (const r of recordsOf(x)) out.push({ exercise: ex.name, muscle: ex.muscle, kind: r.kind, value: r.value, previous: r.previous, date: x.date, at: x.t, workoutId: x.workoutId });
    }
  }
  return out.sort((a, b) => b.at - a.at || a.exercise.localeCompare(b.exercise) || (a.kind < b.kind ? 1 : -1)).slice(0, max);
}

/** { workoutId: how many records were set in it }. */
export function prCounts(history) {
  const out = {};
  // One record per exercise that beat its best (heavier, or a higher estimated max), as the workout's own page counts them.
  for (const ex of history.values()) for (const x of ex.sessions) if (x.workoutId !== null && recordsOf(x).length) out[x.workoutId] = (out[x.workoutId] || 0) + 1;
  return out;
}

/** The most-trained exercises of the last `days` days with their sessions. */
export function topExercises(history, today, { days = 180, max = 12, perExercise = 24 } = {}) {
  const from = addDays(today, -(days - 1));
  const rows = [];
  for (const ex of history.values()) {
    const inWindow = ex.sessions.filter((x) => x.date >= from && x.date <= today);
    if (!inWindow.length) continue;
    const sessions = inWindow.slice(-perExercise).map((x) => ({ date: x.date, t: x.t, topKg: x.topKg, topReps: x.topReps, e1rm: x.e1rm, volumeKg: x.volumeKg, sets: x.sets }));
    const e = sessions.map((x) => x.e1rm).filter(Number.isFinite);
    const a = e.length >= 6 ? mean(e.slice(0, 3)) : null;
    rows.push({
      name: ex.name, muscle: ex.muscle, sessions, bestKg: ex.bestKg, bestE1rm: ex.bestE1rm,
      changePct: a ? round(((mean(e.slice(-3)) - a) / a) * 100, 1) : null,
      _n: inWindow.length, _sets: inWindow.reduce((n, x) => n + x.sets, 0),
    });
  }
  return rows.sort((a, b) => b._n - a._n || b._sets - a._sets || a.name.localeCompare(b.name)).slice(0, max).map(({ _n, _sets, ...x }) => x);
}

/**
 * One workout's exercises (as db.setsOf gives them) with `pr` on each set and
 * `previous` on each exercise. A session sets at most one weight record and
 * one estimated-1RM record per exercise; the set marked is the first to reach
 * that session's best.
 */
export function markSets(exercises, history, { workoutId, start }) {
  const id = workoutId === null || workoutId === undefined ? null : String(workoutId);
  const info = new Map();
  for (const ex of exercises) {
    let x = info.get(ex.name);
    if (!x) {
      const prior = (history.get(ex.name)?.sessions || []).filter((s) => (s.workoutId === null || String(s.workoutId) !== id) && s.t < start);
      const best = (k) => prior.reduce((m, s) => (s[k] !== null && (m === null || s[k] > m) ? s[k] : m), null);
      const last = prior[prior.length - 1];
      x = { prevKg: best('topKg'), prevE1rm: best('e1rm'), previous: last ? { date: last.date, topKg: last.topKg, topReps: last.topReps } : null, topKg: null, kgSet: null, e1rm: null, eSet: null };
      info.set(ex.name, x);
    }
    for (const s of ex.sets) {
      if (!counts(s)) continue;
      if (x.topKg === null || s.kg > x.topKg) { x.topKg = s.kg; x.kgSet = s; }
      const e = e1rm(s.kg, s.reps);
      if (e !== null && (x.e1rm === null || e > x.e1rm)) { x.e1rm = e; x.eSet = s; }
    }
  }
  const marked = new Set();
  for (const x of info.values()) {
    if (x.kgSet && x.prevKg !== null && x.topKg > x.prevKg) marked.add(x.kgSet);
    if (x.eSet && x.prevE1rm !== null && x.e1rm > x.prevE1rm) marked.add(x.eSet);
  }
  return exercises.map((ex) => ({ ...ex, previous: info.get(ex.name).previous, sets: ex.sets.map((s) => ({ ...s, pr: marked.has(s) })) }));
}

/* ── one person's world ───────────────────────────────────────────── */

/** Civil date and hour of an instant in a zone, with one formatter for many instants. */
export function clockOf(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const seen = new Map();
  const at = (t) => {
    let x = seen.get(t);
    if (!x) {
      const p = Object.fromEntries(f.formatToParts(new Date(t)).map((v) => [v.type, v.value]));
      x = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
      seen.set(t, x);
    }
    return x;
  };
  return { date: (t) => at(t).date, hour: (t) => at(t).hour };
}

/** Every set a person has done, flat, each on its civil date. */
function allSets(db, clock) {
  return [
    ...db.workoutSets(0).map((s) => ({ date: clock.date(s.t), t: s.t, exercise: s.exercise, muscle: s.muscle, type: s.type || 'normal', kg: s.kg || 0, reps: s.reps || 0, sets: 1, workoutId: String(s.workoutId) })),
    // The console module's free-standing strength log, through the link.
    ...db.sets('0000-00-00').map((s) => ({ date: s.date, t: s.t, exercise: s.exercise, muscle: s.muscle, type: 'normal', kg: s.kg || 0, reps: s.reps || 0, sets: s.sets || 1, workoutId: null })),
  ];
}

/** { workoutId: records set in it }, from a person's store alone: the same
    count the training list shows as `prCount` (the feed's posts use it). */
export function workoutPrCounts(db, tz) {
  return prCounts(exerciseHistory(allSets(db, clockOf(tz))));
}

/**
 * Everything the training log is computed from, read once from a world.
 * @param uni  the result of unified(world.db, 0), when the caller already has it
 */
export function trainingData(world, { uni = null, extraTrace = null } = {}) {
  const now = world.now();
  const clock = clockOf(world.tz);
  const today = clock.date(now);
  const totals = world.db.setTotals();
  const cached = world.db.metaPrefix('trace:');
  const sessions = (uni || unified(world.db, 0)).map((s) => {
    const id = s.local ? String(s.local.id) : mirrorId(s.ex.id);
    const trace = s.local ? s.local.trace : cached[`trace:${id}`]?.trace;
    return {
      id, start: s.start, end: s.end, date: clock.date(s.start), hour: clock.hour(s.start),
      avgHr: (s.local ? s.local.avgHr : s.ex.avgHr) ?? null,
      volumeKg: s.local ? totals[s.local.id]?.volumeKg ?? null : null,
      trace: Array.isArray(trace) && trace.length ? trace : null,
    };
  });
  const peaks = [];
  for (const s of sessions) if (s.trace && s.start >= now - 180 * DAY) peaks.push(...beatsIn(s.trace, s.start, s.end));
  if (extraTrace && extraTrace.start >= now - 180 * DAY) peaks.push(...beatsIn(extraTrace.trace, extraTrace.start, extraTrace.end));
  const model = zoneModel(world.rest(), peaks.length ? [peaks.reduce((a, b) => Math.max(a, b), 0)] : []);
  for (const s of sessions) { s.zonesMin = zoneMinutes(s.trace, s.start, s.end, model.bounds); s.spark = sparkOf(s.trace, s.start, s.end); }
  const sets = allSets(world.db, clock);
  const history = exerciseHistory(sets);
  const first = addDays(weekOf(today, world.weekStart ?? 1), -7 * (WEEKS - 1));
  return { now, today, first, sessions, sets, history, model, usual: usualOf(sessions.filter((s) => s.date >= first)), prCount: prCounts(history) };
}

/**
 * `training` of GET /api/workouts, and what each workout in the lists gains.
 * @returns {{ training: object, extras: (view) => view }}
 */
export function trainingView(world, { uni = null } = {}) {
  const d = trainingData(world, { uni });
  const weeks = weekBuckets(d.sessions, d.sets, d.today, WEEKS, world.weekStart ?? 1);
  const training = {
    week: weekSummary(weeks),
    weeks,
    weekday: weekdayCounts(d.sessions, d.first),
    hours: hourCounts(d.sessions, d.first),
    zones: d.model,
    balance: balance(d.sets, d.today),
    prs: recentPrs(d.history, d.today),
    exercises: topExercises(d.history, d.today),
    usual: d.usual,
  };
  const byId = new Map(d.sessions.map((s) => [s.id, s]));
  /** A workout object of a list, with its trace in brief. `row` is this app's row when it is not in the history yet. */
  const extras = (view, row = null) => {
    const s = byId.get(view.id);
    if (s) return { ...view, spark: s.spark, zonesMin: s.zonesMin, prCount: d.prCount[view.id] || 0 };
    const end = view.end ?? row?.lastEnd ?? d.now;
    const trace = row && Array.isArray(row.trace) ? row.trace : null;
    return { ...view, spark: sparkOf(trace, view.start, end), zonesMin: zoneMinutes(trace, view.start, end, d.model.bounds), prCount: 0 };
  };
  return { training, extras };
}

/** What GET /api/workouts/:id gains: zones of the trace it returns, the usual session, records per set. */
export function detailExtras(world, detail) {
  const end = detail.end ?? detail.lastEnd ?? world.now();
  const d = trainingData(world, { extraTrace: { trace: detail.trace, start: detail.start, end } });
  const minutes = zoneMinutes(detail.trace, detail.start, end, d.model.bounds);
  return {
    zones: minutes ? { minutes, bounds: d.model.bounds, labels: d.model.labels, rest: d.model.rest, max: d.model.max, note: d.model.note } : null,
    usual: d.usual,
    exercises: markSets(detail.exercises || [], d.history, { workoutId: detail.readOnly ? null : detail.id, start: detail.start }),
  };
}
