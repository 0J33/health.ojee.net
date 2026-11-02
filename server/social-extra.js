/* ============================================================
   health.ojee.net — the livelier half of the social side: movement
   and sparklines on a board, day-by-day series in a comparison, a
   profile's year and its last twelve weeks.

   The rule of social.js holds here without exception: everything is
   read from `daily_public` in the global store, and nothing else.
   No function in this file is given a person's own database, and
   none decides what is private: social.js checks the person's flags
   (`shares`, `on`) and passes the answer in. A category that is not
   shared comes out as null, the viewer's own side included.
   ============================================================ */

import { addDays, weekOf, monthOf, daysBetween } from './core/util.js';

/** The columns of daily_public a series may be read from. */
const COLS = new Set(['steps', 'active_min', 'distance_m', 'workouts', 'workout_min', 'run_m', 'ride_m', 'walk_m', 'gym_n', 'gym_min', 'medals']);
/** The metrics a comparison is drawn day by day for → their column. */
export const SERIES = { steps: 'steps', active_minutes: 'active_min', distance: 'distance_m', workout_time: 'workout_min', run_distance: 'run_m', ride_distance: 'ride_m', walk_distance: 'walk_m', gym_time: 'gym_min' };
const WEEKS = 12;

const dowOf = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;   // 0 = Monday
const medianOf = (values) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/** One public column, a value per civil day from..to (null where there is no number). */
export function dayValues(app, userId, col, from, to) {
  if (!COLS.has(col)) throw new Error(`not a public series: ${col}`);
  const rows = new Map(app.all(`SELECT date, ${col} AS v FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?`, userId, from, to).map((r) => [r.date, r.v]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const v = rows.get(d); out.push(v === null || v === undefined ? null : Math.round(v)); }
  return out;
}

/* ── leaderboard ──────────────────────────────────────────────────── */

/**
 * Movement on a board. `entries` are sorted and ranked, each with `value`
 * and `previous`. Adds `prevRank` (the rank among the people listed now, on
 * their previous-period values), `move` (places gained) and `gapToNext`
 * (how far behind the nearest higher value).
 */
export function standings(entries) {
  const before = entries.filter((e) => e.previous !== null && e.previous !== undefined).sort((a, b) => b.previous - a.previous);
  const prevRank = new Map();
  before.forEach((e, i) => { prevRank.set(e, i > 0 && before[i - 1].previous === e.previous ? prevRank.get(before[i - 1]) : i + 1); });
  let above = null;   // the nearest strictly higher value
  entries.forEach((e, i) => {
    if (i > 0 && entries[i - 1].value > e.value) above = entries[i - 1].value;
    e.prevRank = prevRank.get(e) ?? null;
    e.move = e.prevRank === null ? null : e.prevRank - e.rank;
    e.gapToNext = above === null ? null : above - e.value;
  });
  return entries;
}

/** The listed values as a group. */
export function groupOf(entries) {
  const v = entries.map((e) => e.value);
  if (!v.length) return { n: 0, median: null, mean: null, total: 0, best: null };
  const total = v.reduce((a, b) => a + b, 0);
  return { n: v.length, median: Math.round(medianOf(v)), mean: Math.round(total / v.length), total, best: Math.max(...v) };
}

/** Where one listed entry sits: against the median, the person ahead, the person behind. */
export function placeOf(entries, mine, group) {
  if (!mine) return { vsMedianPct: null, ahead: null, behind: null };
  const i = entries.indexOf(mine);
  const who = (e, by) => ({ username: e.username, displayName: e.displayName, by });
  let ahead = null; let behind = null;
  for (let k = i - 1; k >= 0 && !ahead; k -= 1) if (entries[k].value > mine.value) ahead = who(entries[k], entries[k].value - mine.value);
  for (let k = i + 1; k < entries.length && !behind; k += 1) if (entries[k].value < mine.value) behind = who(entries[k], mine.value - entries[k].value);
  return { vsMedianPct: group.median > 0 ? Math.round(((mine.value - group.median) / group.median) * 100) : null, ahead, behind };
}

/* ── compare ──────────────────────────────────────────────────────── */

/** Where a period's series starts for a person whose civil day is `today`, and how it steps. */
function seriesStart(period, today, ws = 1) {
  if (period === 'today') return { from: addDays(today, -6), step: 1 };
  if (period === 'week') return { from: weekOf(today, ws), step: 1 };
  if (period === 'month') return { from: monthOf(today), step: 1 };
  return { from: addDays(weekOf(today, ws), -7 * (WEEKS - 1)), step: 7 };
}

/** One person's values for a period: a number per day, or per week for `all`. */
export function sideSeries(app, userId, col, period, today, ws = 1) {
  const { from, step } = seriesStart(period, today, ws);
  const days = dayValues(app, userId, col, from, today);
  if (step === 1) return days;
  const out = [];
  for (let i = 0; i < days.length; i += 7) {
    const have = days.slice(i, i + 7).filter((x) => x !== null);
    out.push(have.length ? have.reduce((a, b) => a + b, 0) : null);
  }
  return out;
}

/**
 * The paired series of a comparison. Each side is its own person's days in
 * their own zone (position 0 is the first day of THEIR period); `labels`
 * are the dates of side a. A side whose category is not shared is null.
 * @param a, b { userId, today, on: (metric) => boolean }
 */
export function compareSeries(app, period, a, b) {
  const out = {};
  for (const [metric, col] of Object.entries(SERIES)) {
    const va = a.on(metric) ? sideSeries(app, a.userId, col, period, a.today, a.weekStart) : null;
    const vb = b.on(metric) ? sideSeries(app, b.userId, col, period, b.today, b.weekStart) : null;
    const { from, step } = seriesStart(period, a.today, a.weekStart);
    const own = Math.floor(daysBetween(from, a.today) / step) + 1;
    const n = Math.max(own, va ? va.length : 0, vb ? vb.length : 0);
    const pad = (v) => (v ? [...v, ...new Array(n - v.length).fill(null)] : null);
    out[metric] = { labels: Array.from({ length: n }, (_, i) => addDays(from, i * step)), a: pad(va), b: pad(vb) };
  }
  return out;
}

/** How many metrics each side leads, among those both sides have a value for. */
export function scoreOf(metrics) {
  const s = { a: 0, b: 0, ties: 0 };
  for (const m of metrics) {
    if (m.a === null || m.b === null) continue;
    if (m.a === m.b) s.ties += 1; else if ((m.a > m.b) === (m.higherIsBetter !== false)) s.a += 1; else s.b += 1;
  }
  return s;
}

/* ── profile ──────────────────────────────────────────────────────── */

/**
 * A profile's year, its last twelve Monday weeks and its usual steps per
 * weekday, from the public table. `act` / `wk`: are activity and workouts
 * shared. Whatever is not shared is null.
 */
export function profileExtras(app, userId, { today, act, wk, weekStart = 1 }) {
  const from = addDays(today, -364);
  const rows = app.all('SELECT date, steps, active_min, distance_m, workouts, workout_min FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', userId, from, today);
  const sum = (list, k) => Math.round(list.reduce((a, r) => a + (r[k] || 0), 0));

  const months = {};
  if (act) for (const r of rows) if (r.steps !== null) months[r.date.slice(0, 7)] = (months[r.date.slice(0, 7)] || 0) + r.steps;
  const best = Object.entries(months).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1))[0];
  const year = {
    activeDays: act ? rows.filter((r) => r.steps > 0).length : null,
    steps: act ? sum(rows, 'steps') : null,
    distanceM: act ? sum(rows, 'distance_m') : null,
    workouts: wk ? sum(rows, 'workouts') : null,
    workoutMin: wk ? sum(rows, 'workout_min') : null,
    bestMonth: act && best && best[1] > 0 ? { month: best[0], steps: Math.round(best[1]) } : null,
  };

  const first = addDays(weekOf(today, weekStart), -7 * (WEEKS - 1));
  const weeks = [];
  for (let w = first; w <= today; w = addDays(w, 7)) {
    const part = rows.filter((r) => r.date >= w && r.date <= addDays(w, 6));
    weeks.push({
      week: w,
      steps: act ? sum(part, 'steps') : null, activeMinutes: act ? sum(part, 'active_min') : null,
      workouts: wk ? sum(part, 'workouts') : null, workoutMin: wk ? sum(part, 'workout_min') : null,
    });
  }

  let weekday = null;
  if (act) {
    const by = Array.from({ length: 7 }, () => []);
    // Today is not over, so it would drag its weekday down.
    for (const r of rows) if (r.date >= first && r.date < today && r.steps !== null) by[dowOf(r.date)].push(r.steps);
    weekday = by.map((v) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null));
  }
  return { year, weeks, weekday };
}
