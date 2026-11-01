/* ============================================================
   health.ojee.net — what the pages are told: the payloads of the
   person's own routes, built from their own world.

   Every function here takes ONE person's world (and their own
   profile row). Nothing in this file can reach anybody else's data;
   what others may see is in social.js.

   docs/API.md is the contract for every shape below. Change one,
   change the other.
   ============================================================ */

import { dashboard, strengthWeeks } from './core/metrics.js';
import { addDays, today as todayIn, weekOf, stats, round, localToMs } from './core/util.js';
import { parseStepWindows } from './core/parse.js';
import { maxWindows } from './worlds.js';
import { brief, dayHours, parseHrStats, trendsAnalysis } from './analysis.js';
import { SCOPES, LOCATION_SCOPE } from './core/google.js';
import { DETECT_BOUNDS } from './core/detect.js';
import { EXERCISE_TYPES } from './core/workouts.js';
import { stats as insightStats, WINDOWS } from './core/insight.js';
import { readCaps, MISSING_TEXT } from './caps.js';
import { unified, workoutView, mirrorView, mirrorId, sportOf } from './history.js';
import { MUSCLES } from './muscles.js';
import { trainingView, detailExtras } from './training.js';
import { workoutSummary, differences, previousOf } from './routines.js';
import { libById, libByName, libMatch, libView } from './library.js';
import { trackStats, routeLine, boundsOf, fromTcx, cleanPoints, ROUTE_TYPES } from './tracks.js';
import { readyBand, resilLabel, sleepBand } from './core/scores.js';
import { briefExtra, summaryExtras, entryView } from './browse.js';
import { routeShape } from './strava.js';

const MIN = 60_000;
const TRACE_PAD = 20 * MIN;

export function syncView(world, scheduler) {
  const s = world.sync;
  return {
    running: !!s.running,
    lastRun: s.state.lastRun, lastOk: s.state.lastOk, lastError: s.state.lastError,
    nextAt: scheduler?.dueAt(world.userId) || s.state.nextAt || null,
    backoffUntil: scheduler?.backoffUntil(world.userId) || null,
    streams: Object.fromEntries(Object.entries(s.state.streams).map(([k, v]) => [k, {
      at: v.at || null, rows: v.rows ?? null, error: v.error || null, skipped: v.skipped || null,
      // Google refuses this type for this account: said once, asked again a day later.
      unavailable: !!v.unavailable, message: v.unavailable ? v.message || null : null, unavailableAt: v.unavailable ? v.unavailableAt || null : null,
      // A heavy stream's walk into the past: the earliest civil date read so far.
      backTo: v.backTo || null,
    }])),
  };
}

export function googleView(world) {
  const st = world.google.status();
  const ok = st.state === 'ok';
  return {
    state: st.state, email: st.email, connectedAt: st.connectedAt, lastRefreshAt: st.lastRefreshAt,
    expiredAt: st.expiredAt, testingExpiry: st.testingExpiry, refreshError: st.refreshError,
    scopes: st.scopes,
    canWriteWeight: ok && world.google.granted(SCOPES.weightWrite),
    canWriteWorkouts: ok && world.google.granted(SCOPES.activityWrite),
    missing: st.missing,
    groups: world.groupsView(),
  };
}

export const goalsView = (world) => { const s = world.settings(); return { steps: s.stepTarget, activeMinutes: s.azmTarget, sleepMinutes: s.sleepTarget, cardioWeek: s.cardioTarget, waterMl: s.waterTarget }; };

/** Enough about workouts for a tab badge. */
export function workoutBadge(world) {
  const open = world.workouts.open();
  const run = open.find((r) => r.status === 'running');
  return { running: run ? { id: String(run.id), start: run.start } : null, pending: open.filter((r) => r.status !== 'running').length };
}

/* ── Today ────────────────────────────────────────────────────────── */

/** How far back Today looks for the last readiness and resilience. */
const SCORE_BACK = 14;

export function dataView(world, { days = 30 } = {}) {
  const now = world.now();
  const today = todayIn(now, world.tz);
  const { caps } = readCaps(world.db);
  const d = dashboard(world.db, { today, days, settings: world.settings(), caps });
  // Readiness and resilience made to match Google's (core/scores.js). Each is the
  // newest day that has it, on its own: a night with readiness but too little worn
  // time for resilience still shows the last resilience, with its day.
  let scores = null;
  const t = d._table || {};
  const newest = (k) => {
    for (let i = 0; i < SCORE_BACK; i += 1) { const day = addDays(today, -i); if (Number.isFinite(t[day]?.[k])) return day; }
    return null;
  };
  const rDay = newest('readiness'); const sDay = newest('resilience');
  // The sleep score is the one of the night Today shows, whichever day that was.
  const nDay = d.sleep?.lastNight?.date || null;
  const n = (nDay && t[nDay]) || {};
  if (rDay || sDay || Number.isFinite(n.sleep_score)) {
    const r = t[rDay] || {}; const s = t[sDay] || {};
    scores = {
      date: rDay || sDay || nDay, ready: r.readiness ?? null, readyBand: readyBand(r.readiness),
      sleepDate: Number.isFinite(n.sleep_score) ? nDay : null, sleep: n.sleep_score ?? null, sleepBand: sleepBand(n.sleep_score),
      resilDate: sDay, resil: s.resilience ?? null, resilLabel: resilLabel(s.resilience),
    };
  }
  delete d._table;
  const hr = world.db.meta('hr');
  return {
    today: d.today, tz: world.tz, days,
    // Google or Garmin: anything that brings numbers in.
    connected: world.anySource(),
    empty: !world.db.firstDate(),
    verdictDay: d.verdictDay, stale: d.stale,
    readiness: d.readiness, illness: d.illness, scores,
    series: d.series,
    sleep: { lastNight: d.sleep.lastNight, consistency: d.sleep.consistency, nights: d.sleep.nights },
    activity: d.activity,
    weight: { latest: d.weight.latest, change30: d.weight.change30, trend: d.weight.trend, points: d.weight.points },
    hr: hr && now - hr.t < 3 * 3_600_000 ? hr : null,
    device: world.db.meta('device'),
    // Several accounts: each tracker, for a battery each.
    devices: world.db.meta('devices'),
    caps,
    workout: workoutBadge(world),
  };
}

/** Today in context: every number against the person's own usual, the week
    against last week, streaks, what changed, and the few things worth saying
    (analysis.js). */
export function briefView(world) {
  const now = world.now();
  const today = todayIn(now, world.tz);
  const { caps, meta } = readCaps(world.db);
  const from = addDays(today, -400);
  const b = brief({
    today, tz: world.tz, now,
    table: world.db.dailyTable(from),
    nights: world.db.sleeps(addDays(today, -45)),
    sessions: unified(world.db, Date.parse(`${from}T00:00:00Z`)).map((s) => ({ start: s.start, end: s.end })),
    weights: world.db.weights(Date.parse(`${addDays(today, -40)}T00:00:00Z`)),
    settings: world.settings(), caps, missing: meta.missing,
    connected: world.anySource(),
    pending: workoutBadge(world).pending,
  });
  // What "all the data" adds to Today (browse.js): each part is null or
  // empty for somebody who has nothing for it.
  return { ...b, extra: briefExtra(world) };
}

/* ── One day, hour by hour ────────────────────────────────────────── */

export const DAY_BACK = 6;
const DAY_TTL = 10 * MIN;
const DAY_KEEP = 8;

/** Heart rate by the hour. Hourly windows when Google gives their minimum
    and maximum; otherwise minute windows, folded up by dayHours. */
async function hourlyHr(google, from, to) {
  let pts = [];
  try { pts = parseHrStats(await google.rollUp('heart-rate', from, to, 3600)); } catch (e) { if (['needs_auth', 'rate_limited', 'network'].includes(e.code)) throw e; }
  if (pts.length && pts.every((x) => x.min !== null && x.max !== null)) return pts;
  return parseHrStats(await google.rollUpAll('heart-rate', from, to, 60));
}

/** One read from each account that can be read; an account that fails is
    left out unless they all do. `many`: there is more than one. */
async function fromEach(world, fn) {
  const list = world.readable();
  if (list.length <= 1) return [await fn(list[0]?.google || world.google, false)];
  const out = [];
  let err = null;
  for (const a of list) { try { out.push(await fn(a.google, true)); } catch (e) { err ||= e; } }
  if (!out.length) throw err;
  return out;
}

/** Hourly heart-rate stats from several devices: the mean of the means, the
    lowest low, the highest high. */
function combineStats(lists) {
  const m = new Map();
  for (const list of lists) {
    for (const x of list) {
      const c = m.get(x.start);
      if (!c) { m.set(x.start, { ...x, n: 1 }); continue; }
      c.avg = (c.avg * c.n + x.avg) / (c.n + 1); c.n += 1;
      c.min = c.min === null ? x.min : x.min === null ? c.min : Math.min(c.min, x.min);
      c.max = c.max === null ? x.max : x.max === null ? c.max : Math.max(c.max, x.max);
    }
  }
  return [...m.values()].map(({ n, ...x }) => x).sort((a, b) => a.start - b.start);
}

/**
 * The shape of one civil day: steps and heart rate per local hour, read from
 * Google and kept (ten minutes for today, for good once the day is over).
 * A stream that cannot be shown says why instead of failing the request.
 */
export async function dayView(world, asked = null) {
  const now = world.now();
  const tz = world.tz;
  const today = todayIn(now, tz);
  const date = asked || today;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || addDays(date, 0) !== date) {
    throw Object.assign(new Error('date must be a day as YYYY-MM-DD.'), { status: 400 });
  }
  if (date > today || date < addDays(today, -DAY_BACK)) throw Object.assign(new Error(`date must be today or one of the ${DAY_BACK} days before it.`), { status: 400 });

  const key = `day:${date}`;
  const hit = world.db.meta(key);
  if (hit?.v && (hit.final || now - hit.at < DAY_TTL)) return hit.v;

  const { caps } = readCaps(world.db);
  const from = localToMs(date, 0, tz);
  const to = Math.min(localToMs(date, 1440, tz), now);
  let steps = null; let hr = null; let stepsWhy = null; let hrWhy = null;
  let read = false; let transient = false;
  const failed = (e, what) => { transient = true; return e.code === 'needs_auth' ? 'Google Health access has expired. Connect again to see this' : `${what} could not be read from Google just now`; };
  if (!world.anyConnected() && world.garminIn()) {
    // Garmin alone: its heart rate by the hour was kept by its sync; its
    // steps come as the day's total only.
    stepsWhy = 'Garmin gives the day\'s steps as one total, not hour by hour';
    const row = world.db.samples('hrhours', { fromMs: from - 1, toMs: from + 1, limit: 1 })[0];
    if (row?.data?.hours?.length) { hr = row.data.hours.filter((x) => x.start >= from && x.start < to); read = hr.length > 0; }
    if (!hr?.length) { hr = null; hrWhy = date === today ? 'No heart rate from Garmin yet today' : 'No heart rate from Garmin on this day'; }
  } else if (!world.anyConnected()) { stepsWhy = 'Connect Google Health or Garmin to see the day hour by hour'; hrWhy = stepsWhy; }
  else {
    const nothing = date === today ? 'No steps recorded yet today' : 'No steps were recorded on this day';
    if (to - from < MIN) stepsWhy = nothing;
    else {
      read = true;
      try {
        // Several devices: quarter-hours, the larger of the two in each, so
        // a quarter-hour both counted counts once (as the day's total does).
        const per = await fromEach(world, async (g, many) => parseStepWindows(await g.rollUp('steps', from, to, many ? 900 : 3600)));
        const w = per.length === 1 ? per[0] : maxWindows(per);
        if (w.some((x) => x.steps > 0)) steps = w;
        // A daily total with nothing through the day: the source only reports totals.
        else stepsWhy = world.db.dailyTable(date)[date]?.steps > 0 ? 'Google has a step total for this day but nothing hour by hour' : nothing;
      } catch (e) { stepsWhy = failed(e, 'Steps'); }
    }
    if (!caps.heartRateMinute) hrWhy = 'Your device does not report minute-by-minute heart rate';
    else if (to - from < MIN) hrWhy = 'No heart rate recorded yet today';
    else {
      read = true;
      try {
        const per = await fromEach(world, (g) => hourlyHr(g, from, to));
        const w = per.length === 1 ? per[0] : combineStats(per);
        if (w.length) hr = w; else hrWhy = date === today ? 'No heart rate recorded yet today' : 'No heart rate was recorded on this day';
      } catch (e) { hrWhy = failed(e, 'Heart rate'); }
    }
  }
  const out = {
    date, tz,
    ...dayHours({ date, tz, now, steps, hr }),
    steps: { available: !!steps, reason: stepsWhy },
    hr: { available: !!hr, reason: hrWhy },
    at: now,
  };
  if (read && !transient) {
    // Final once the day is over and its steps are in; a late-syncing device gets asked again.
    world.db.setMeta(key, { at: now, final: date < today && !!steps, v: out });
    const oldest = `day:${addDays(today, -DAY_KEEP)}`;
    for (const k of Object.keys(world.db.metaPrefix('day:'))) if (k < oldest) world.db.db.prepare('DELETE FROM meta WHERE key = ?').run(k);
  }
  return out;
}

/* ── Trends ───────────────────────────────────────────────────────── */

export function trendsView(world, { days = 30 } = {}) {
  const today = todayIn(world.now(), world.tz);
  const { caps } = readCaps(world.db);
  const d = dashboard(world.db, { today, days, settings: world.settings(), caps, nights: days, stages: days <= 30 });
  const from = addDays(today, -(days - 1));
  const sessions = unified(world.db, Date.parse(`${addDays(from, -7)}T00:00:00Z`));
  const weeks = [];
  for (let w = weekOf(from); w <= today; w = addDays(w, 7)) {
    const rows = d.series.filter((x) => x.date >= w && x.date <= addDays(w, 6));
    const have = (k) => rows.map((x) => x[k]).filter(Number.isFinite);
    const sum = (k) => (have(k).length ? have(k).reduce((a, b) => a + b, 0) : null);
    const avg = (k, p = 0) => (have(k).length ? round(stats(have(k)).mean, p) : null);
    const am = rows.map((x) => x.azm ?? x.activeMin).filter(Number.isFinite);
    const ws = sessions.filter((s) => { const dd = todayIn(s.start, world.tz); return dd >= w && dd <= addDays(w, 6); });
    weeks.push({
      week: w,
      days: rows.filter((x) => ['steps', 'sleepMin', 'rhr', 'hrv', 'kcal'].some((k) => Number.isFinite(x[k]))).length,
      steps: sum('steps'), stepsAvg: avg('steps'), distanceM: sum('distanceM'),
      activeMinutes: am.length ? am.reduce((a, b) => a + b, 0) : null,
      kcalAvg: avg('kcal'), sleepAvgMin: avg('sleepMin'), rhrAvg: avg('rhr', 1), hrvAvg: avg('hrv', 1),
      workouts: ws.length, workoutMin: Math.round(ws.reduce((a, s) => a + (s.end - s.start) / MIN, 0)),
    });
  }
  // The analysis looks one more period back (for "against the previous
  // period") than the dashboard's own table does.
  const a = trendsAnalysis({
    today, days, tz: world.tz,
    table: world.db.dailyTable(addDays(from, -(days + 7))),
    series: d.series, nights: d.sleep.nights,
    sessions: sessions.map((s) => ({ start: s.start, end: s.end })),
    weights: world.db.weights(Date.parse(`${addDays(today, -(Math.max(days, 28) + 8))}T00:00:00Z`)),
    settings: world.settings(), caps,
  });
  return {
    today, tz: world.tz, days, from,
    series: d.series.map((row, i) => ({ ...row, ...a.rows[i] })),
    weeks,
    months: a.months,
    analysis: a.analysis,
    relations: a.relations,
    sleep: { nights: d.sleep.nights, consistency: d.sleep.consistency, ...a.sleep },
    weight: { latest: d.weight.latest, change30: d.weight.change30, trend: d.weight.trend, points: d.weight.points, ...a.weight },
    activity: { stepTarget: d.activity.stepTarget, azmTarget: d.activity.azmTarget, sleepTarget: d.activity.sleepTarget, streak: d.activity.streak },
    caps,
  };
}

/* ── Workouts ─────────────────────────────────────────────────────── */

/** Every set the person has, as { date, t, exercise, muscle, kg, reps, sets }. */
export function allSets(world, fromMs = 0) {
  const tz = world.tz;
  const fromDate = fromMs ? todayIn(fromMs, tz) : '0000-00-00';
  return [
    ...world.db.workoutSets(fromMs).map((s) => ({ date: todayIn(s.t, tz), t: s.t, exercise: s.exercise, muscle: s.muscle, kg: s.kg || 0, reps: s.reps || 0, sets: 1, workoutId: s.workoutId })),
    // The console module's free-standing strength log, through the link.
    ...world.db.sets(fromDate).map((s) => ({ date: s.date, t: s.t, exercise: s.exercise, muscle: s.muscle, kg: s.kg, reps: s.reps, sets: s.sets || 1, workoutId: null })),
  ];
}

export function strengthView(world) {
  const today = todayIn(world.now(), world.tz);
  const first = addDays(weekOf(today), -7 * 11);
  const sets = allSets(world, Date.parse(`${first}T00:00:00Z`) - 86_400_000).filter((s) => s.date >= first);
  const table = world.db.dailyTable(addDays(first, -40));
  const sessions = unified(world.db, Date.parse(`${first}T00:00:00Z`) - 86_400_000);
  const weeks = strengthWeeks(sets, table, today, 12).map((w) => ({
    week: w.week, sets: w.sets, volumeKg: Math.round(w.total),
    workouts: sessions.filter((s) => { const d = todayIn(s.start, world.tz); return d >= w.week && d <= addDays(w.week, 6); }).length,
    byMuscle: Object.fromEntries(Object.entries(w.volume).map(([k, v]) => [k, Math.round(v)])),
  }));
  // The last four COMPLETE weeks: this one is still being lifted in.
  const complete = weeks.slice(-5, -1);
  const by = new Map();
  for (const s of sets) {
    const x = by.get(s.exercise) || { name: s.exercise, muscle: s.muscle, sets: 0, bestKg: 0, lastAt: 0 };
    x.sets += s.sets; x.bestKg = Math.max(x.bestKg, s.kg || 0); x.lastAt = Math.max(x.lastAt, s.t || 0);
    by.set(s.exercise, x);
  }
  return {
    muscles: MUSCLES,
    weeks,
    setsPerWeek: complete.length ? round(complete.reduce((a, w) => a + w.sets, 0) / complete.length, 1) : 0,
    exercises: [...by.values()].sort((a, b) => b.sets - a.sets).slice(0, 40),
  };
}

export function detectionView(world) {
  const { caps } = readCaps(world.db);
  const settings = world.detection();
  const rest = world.rest();
  const connected = world.anyConnected();
  const available = connected && !!caps.heartRateMinute;
  return {
    available,
    reason: available ? null : !connected && world.garminOn() ? 'Your Garmin records workouts itself, and they arrive here. Detection reads minute-by-minute heart rate from Google Health'
      : !connected ? 'Connect Google Health to use workout detection'
      : 'Workout detection needs minute-by-minute heart rate, which your device does not report',
    settings,
    bounds: DETECT_BOUNDS,
    rest,
    threshold: rest + settings.plusBpm,
    last: { checkedAt: world.workouts.last.checkedAt, asOf: world.workouts.last.asOf, error: world.workouts.last.error },
  };
}

export function workoutsView(world, { limit = 40, before = null } = {}) {
  const totals = world.db.setTotals();
  const defaultType = world.exerciseType();
  const view = (r) => workoutView(r, { totals, defaultType });
  const open = world.workouts.open();
  const cut = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
  const uni = unified(world.db, 0);
  const all = uni.filter((s) => s.start < cut).reverse();
  // The training log, and what each workout in a list gains from it (its
  // trace in brief, its zones, the records set in it).
  const { training, extras } = trainingView(world, { uni });
  const page = all.slice(0, limit);
  const ok = world.google.connected();
  const canWrite = ok && world.google.granted(SCOPES.activityWrite);
  return {
    running: (() => { const r = open.find((x) => x.status === 'running'); return r ? extras(view(r), r) : null; })(),
    pending: open.filter((r) => r.status !== 'running').sort((a, b) => b.start - a.start).map((r) => extras(view(r), r)),
    history: page.map((s) => extras(s.local ? view(s.local) : mirrorView(s.ex))),
    more: all.length > page.length,
    detection: detectionView(world),
    exerciseType: defaultType,
    exerciseTypes: Object.entries(EXERCISE_TYPES).map(([id, label]) => ({ id, label })),
    canWrite,
    needsReconnect: ok && !canWrite,
    unsaved: world.db.workoutsToFlush(100).filter((r) => r.google?.state !== 'saved').length,
    strength: strengthView(world),
    training,
  };
}

const traceOf = (series, a, b) => series.filter((m) => m.t >= a - TRACE_PAD && m.t < b + TRACE_PAD).map((m) => [m.t, m.hr === null ? null : Math.round(m.hr), m.steps || 0]);

/**
 * One workout with its heart-rate trace and sets. A trace this app already
 * holds is used; otherwise it is read from Google once and kept.
 */
export async function workoutDetail(world, id) {
  const { caps } = readCaps(world.db);
  const defaultType = world.exerciseType();
  const rest = world.rest();
  const threshold = rest + world.detection().plusBpm;
  const noTrace = () => (!world.anyConnected() ? (world.garminIn() ? 'Garmin gives the heart rate of a workout as its average, not minute by minute' : 'Connect Google Health to see heart rate for this workout')
    : !caps.heartRateMinute ? 'Your device does not report minute-by-minute heart rate' : null);

  const fetchTrace = async (start, end) => {
    const why = noTrace();
    if (why) return { trace: [], reason: why };
    // Google keeps minute detail for a while, not for ever.
    if (world.now() - start > 60 * 86_400_000) return { trace: [], reason: 'Heart rate for this period is no longer available' };
    try {
      const t = traceOf(await world.series(start - TRACE_PAD, end + TRACE_PAD), start, end);
      return t.some((x) => x[1] !== null) ? { trace: t, reason: null } : { trace: [], reason: 'No heart rate was recorded during this workout' };
    } catch (e) {
      return { trace: [], reason: 'Heart rate could not be read from Google just now', transient: true, error: e.message };
    }
  };

  if (String(id).startsWith('g-')) {
    const tail = String(id).slice(2);
    const e = world.db.exerciseByTail(tail) || world.db.exercises('0000-00-00').find((x) => mirrorId(x.id) === id);
    if (!e) throw Object.assign(new Error('No such workout.'), { status: 404 });
    const key = `trace:${mirrorId(e.id)}`;
    let got = world.db.meta(key);
    if (!got) { got = await fetchTrace(e.startMs, e.endMs); if (!got.transient) world.db.setMeta(key, { trace: got.trace, reason: got.reason }); }
    const out = { ...mirrorView(e), trace: got.trace, traceReason: got.reason, threshold, exercises: [] };
    const { track, routeNeeds } = await mirrorRoute(world, e);
    return { ...out, ...detailExtras(world, out), track, routeNeeds };
  }

  const r = world.workouts.get(id);
  if (!['ongoing', 'running', 'review', 'done', 'dismissed'].includes(r.status)) throw Object.assign(new Error('No such workout.'), { status: 404 });
  let trace = Array.isArray(r.trace) ? r.trace : null;
  let reason = null;
  if ((!trace || !trace.length) && r.end) {
    if (r.traceTried && r.traceTried === `${r.start}-${r.end}`) { trace = []; reason = r.traceReason || noTrace() || 'No heart rate was recorded during this workout'; }
    else {
      const got = await fetchTrace(r.start, r.end);
      trace = got.trace; reason = got.reason;
      if (!got.transient) {
        world.db.workoutCache(r.id, { trace, traceTried: `${r.start}-${r.end}`, traceReason: reason });
      }
    }
  } else if (!trace || !trace.length) { trace = []; reason = noTrace() || 'The heart-rate trace appears once the workout has ended'; }
  const out = {
    ...workoutView(r, { totals: world.db.setTotals(), defaultType }),
    trace: trace || [], traceReason: trace && trace.length ? null : reason,
    threshold: r.threshold ?? threshold,
    exercises: world.db.setsOf(r.id),
    // Where else it lives: the Strava activity (with its route as a shape
    // to draw, no map tiles) and the Hevy workout.
    strava: r.strava ? (({ polyline: _p, ...x }) => x)(r.strava) : null,
    route: r.strava?.polyline ? routeShape(r.strava.polyline) : null,
    hevy: r.hevy ? { id: r.hevy.id || null, title: r.hevy.title || null, routineId: r.hevy.routineId || null, missing: r.hevy.missing || [], sent: !!world.db.hevyLinkOf(r.id)?.own } : null,
  };
  // Zones of the trace above, the person's usual session, records per set.
  const done = { ...out, ...detailExtras(world, out) };
  // The routine it was, what was planned, and how it went (routines.js).
  const routine = r.routineId ? world.db.routineGet(r.routineId) : null;
  done.routine = r.routineId ? { id: r.routineId, title: routine?.title || r.draft?.routineTitle || null, exists: !!routine } : null;
  done.draft = r.draft ? draftView(world.db, r) : null;
  done.summary = workoutSummary(world.db, r, done.exercises);
  done.differences = routine && done.exercises.length && !r.draft ? differences(routine, done.exercises) : null;
  for (const x of done.exercises) { const l = x.libId ? libById(x.libId) : libMatch(x.name); x.libId = l?.id || null; x.image = l ? libView(l).images[0] : null; }
  // A route: its numbers and the line to draw (tracks.js).
  const t = world.db.trackGet(r.id);
  if (t) {
    const st = trackStats(t);
    done.track = { ...st, line: routeLine(t.points), bounds: boundsOf(t.points) };
  } else done.track = null;
  return done;
}

/**
 * The GPS route of a run, walk or ride synced from Google (exportExerciseTcx),
 * fetched once when its page is first opened and kept. { track, routeNeeds }:
 * routeNeeds is 'location' when it has a route but the person has not allowed
 * route maps.
 */
async function mirrorRoute(world, e) {
  const sport = sportOf(e.type);
  if (!sport || e.hasGps === false) return { track: null, routeNeeds: null };
  const type = ROUTE_TYPES[e.type] ? e.type : sport === 'ride' ? 'BIKING' : sport === 'walk' ? 'WALKING' : 'RUNNING';
  const key = `route:${mirrorId(e.id)}`;
  let got = world.db.meta(key);
  if (!got) {
    // The account that holds it (a second Google account has its own token).
    const acct = [...(world.accounts?.values?.() || [])].find((a) => a.db?.exerciseByTail?.(String(e.id).split('/').pop())) || { google: world.google };
    const g = acct.google;
    if (!g?.connected?.()) return { track: null, routeNeeds: null };
    if (!g.granted(LOCATION_SCOPE)) return { track: null, routeNeeds: e.hasGps ? 'location' : null };
    try {
      const points = cleanPoints(fromTcx(await g.exerciseTcx(e.id)), { type });
      got = { points: points.length >= 2 ? points : [] };
    } catch (err) {
      // No route (or not allowed, or not a GPS workout): remembered, so it is asked once. A network error is tried again next time.
      if (err.code === 'network' || err.status === 429 || err.status >= 500) return { track: null, routeNeeds: null };
      got = { points: [], error: String(err.message || '').slice(0, 200) };
    }
    world.db.setMeta(key, got);
  }
  if (!got.points?.length) return { track: null, routeNeeds: null };
  const t = { type, points: got.points, pauses: [], start: e.startMs, end: e.endMs };
  return { track: { ...trackStats(t), line: routeLine(t.points), bounds: boundsOf(t.points) }, routeNeeds: null };
}

/** A workout being logged set by set, with last time's sets beside each exercise. */
function draftView(db, r) {
  const prev = previousOf(db, r.draft.exercises.map((x) => x.name), { before: r.start });
  return {
    ...r.draft,
    exercises: r.draft.exercises.map((x) => {
      const l = x.libId ? libById(x.libId) : libMatch(x.name);
      return { ...x, libId: l?.id || x.libId || null, image: l ? libView(l).images[0] : null, previous: prev.get(x.name.toLowerCase())?.sets || null };
    }),
  };
}

/* ── Summary ──────────────────────────────────────────────────────── */

export function summaryView(world, { running = null, ai, models }) {
  const latest = {};
  for (const w of WINDOWS) {
    const r = world.db.meta(`insight:${w}`);
    if (r) latest[String(w)] = { window: r.window, at: r.at, ms: r.ms, source: r.source, model: r.model, why: r.why || null, summary: r.summary };
  }
  return { windows: WINDOWS, running, ai: { ...ai, models }, notes: world.db.meta('notes', ''), latest };
}

/**
 * The numbers a summary is written from (insight.js), for one window.
 * What the person logged in an optional group is read only for the groups
 * they share with the summary AND still have switched on: `share` is the
 * one door, and it is shut by default.
 */
export function summaryStats(world, window) {
  const today = todayIn(world.now(), world.tz);
  const { caps } = readCaps(world.db);
  const sets = allSets(world, Date.parse(`${addDays(today, -130)}T00:00:00Z`));
  const on = world.groups(); const ai = world.aiShare();
  const share = Object.fromEntries(Object.keys(ai).map((id) => [id, ai[id] === true && on[id] === true]));
  const days = window === 'night' ? 1 : Number(window) || 7;
  const extras = summaryExtras(world, { today, from: addDays(today, -(days - 1)) });
  return { stats: insightStats(world.db, { today, window, settings: world.settings(), sets, caps, extras, share }), caps };
}

/* ── Export ───────────────────────────────────────────────────────── */

/** Everything this app holds about one person. No tokens, no keys. */
export function exportView(world, { profile, app, me }) {
  const db = world.db;
  const uid = world.userId;
  const insights = {};
  for (const w of WINDOWS) { const r = db.meta(`insight:${w}`); if (r) insights[String(w)] = { window: r.window, at: r.at, source: r.source, model: r.model, summary: r.summary, stats: r.stats }; }
  const totals = db.setTotals();
  return {
    exportedAt: world.now(),
    app: 'health.ojee.net',
    note: 'Everything health.ojee.net holds about you. Times are milliseconds since the epoch; dates are in your time zone. Your Google token and OpenCode key are not included.',
    account: { id: uid, username: profile.username },
    profile: { displayName: profile.displayName, bio: profile.bio, accent: profile.accent, tz: profile.tz, joinedAt: profile.joinedAt, onboarding: profile.onboarding, notes: db.meta('notes', '') },
    units: profile.units, privacy: profile.privacy, goals: me.goals,
    groups: world.groups(), aiShare: world.aiShare(), pins: world.pins(),
    google: { state: me.google.state, email: me.google.email, connectedAt: me.google.connectedAt, scopes: me.google.scopes },
    capabilities: readCaps(db),
    device: db.meta('device'),
    notifications: { prefs: world.alerts.prefs(), devices: app.all('SELECT id, label, enabled, created_ms FROM push_sub WHERE user_id = ?', uid) },
    detection: world.detection(),
    exerciseType: world.exerciseType(),
    daily: db.dailyTable('0000-00-00'),
    sleep: db.sleeps('0000-00-00'),
    weight: db.weights(0).map((w) => ({ t: w.t, kg: round(w.grams / 1000, 2), source: w.source, note: w.note })),
    googleExercises: db.exercises('0000-00-00'),
    workouts: db.workoutsSince(0).filter((r) => r.status !== 'deleted').map((r) => {
      const { trace, statsFor, traceTried, traceReason, linkFrom, ...x } = r;
      return { ...workoutView(r, { totals, defaultType: world.exerciseType() }), source: x.source, exercises: db.setsOf(r.id), trace: trace || [] };
    }),
    strengthSets: db.sets('0000-00-00').map(({ rev, linkFrom, ...s }) => s),
    // Everything logged by hand or read as a single reading, of every kind,
    // without the rows that were deleted and without the sync bookkeeping.
    samples: db.samplesAll().map((r) => { const e = entryView(world, r); return { id: e.id, kind: e.kind, t: e.t, end: e.end, date: e.date, value: r.value, text: e.text, data: (({ _g, ...d }) => d)(r.data || {}), source: e.source, device: e.device, google: e.google }; }),
    summaries: insights,
    public: {
      daily: app.all('SELECT * FROM daily_public WHERE user_id = ? ORDER BY date', uid).map(({ user_id, ...r }) => r),
      workouts: app.all('SELECT * FROM public_workout WHERE user_id = ? ORDER BY start_ms', uid).map(({ user_id, ...r }) => r),
      records: app.all('SELECT kind, value, date FROM records WHERE user_id = ?', uid),
    },
  };
}

export { MISSING_TEXT };
