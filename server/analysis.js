/* ============================================================
   health.ojee.net — numbers in context.

   A number alone says nothing: 7,412 steps is a good Sunday for one
   person and a poor one for another. Everything here answers
   "against what?" — the person's own usual for this weekday, their
   trailing baseline, the previous period, a goal — and then says the
   few things worth saying, in plain words, ranked.

   Pure functions over what the store already holds: the daily table
   ({ date: { metric: value } }), sleep sessions, confirmed workouts
   ({ start, end }) and weigh-ins. No I/O, no clock of its own: the
   caller passes `today`, `tz` and `now`. Nothing here may throw on
   an empty table.

   The wording rules: plain, exact, no medical claims, no cheering.
   Texts are metric (the API's units); the pages convert the numbers
   they draw, not these sentences.
   ============================================================ */

import { addDays, daysBetween, stats, round, weekOf, monthOf, today as todayIn, localToMs, clockIn, num, ms } from './core/util.js';
import { baseline, streak, verdictDay, readinessFor, weightTrend } from './core/metrics.js';

const MIN = 60_000;
const nf = new Intl.NumberFormat('en-GB');
export const fmt = (n) => nf.format(Math.round(n));

/** Each metric the pages show: where it lives in the daily table, which
    capability carries it, how many decimals it is worth. `activity` metrics
    add up through the day (so today is incomplete); the rest are states. */
export const METRICS = {
  steps: { get: (r) => r.steps, cap: 'steps', p: 0, activity: true },
  activeMinutes: { get: (r) => r.azm ?? r.active_min, cap: 'activeMinutes', p: 0, activity: true },
  kcal: { get: (r) => r.kcal, cap: 'calories', p: 0, activity: true },
  distanceM: { get: (r) => r.distance_m, cap: 'distance', p: 0, activity: true },
  sleepMin: { get: (r) => r.sleep_min, raw: 'sleep_min', cap: 'sleep', p: 0, minSd: 20 },
  rhr: { get: (r) => r.rhr, raw: 'rhr', cap: 'restingHr', p: 1, minSd: 1 },
  hrv: { get: (r) => r.hrv, raw: 'hrv', cap: 'hrv', p: 1, minSd: 2 },
  spo2: { get: (r) => r.spo2, raw: 'spo2', cap: 'spo2', p: 1 },
  tempDev: { get: (r) => r.temp_dev, raw: 'temp_dev', cap: 'skinTemp', p: 2, minSd: 0.15 },
  bodyFat: { get: (r) => r.body_fat, raw: 'body_fat', cap: 'bodyFat', p: 1 },
};
const BRIEF_KEYS = ['steps', 'activeMinutes', 'kcal', 'distanceM', 'sleepMin', 'rhr', 'hrv', 'spo2', 'tempDev'];
const TREND_KEYS = [...BRIEF_KEYS, 'bodyFat'];

/** One metric of one day, or null. */
export function valueOf(table, date, key) {
  const r = table?.[date];
  if (!r) return null;
  const v = METRICS[key].get(r);
  return Number.isFinite(v) ? v : null;
}

const goalOf = (key, s = {}) => ({ steps: s.stepTarget || 8000, activeMinutes: s.azmTarget || 22, sleepMin: s.sleepTarget || 450 }[key] ?? null);
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const pct = (delta, base, p = 1) => (Number.isFinite(delta) && Number.isFinite(base) && base !== 0 ? round((delta / Math.abs(base)) * 100, p) : null);
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${Math.round(n) === 1 ? one : many}`;

/** Linear-interpolated quantile of the finite values, or null. */
export function quantile(values, q) {
  const v = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/** 0 = Monday … 6 = Sunday. */
export const dowOf = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });
const DAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const weekdayName = (date) => WEEKDAY.format(new Date(`${date}T00:00:00Z`));
const dayName = (date) => DAY_LONG.format(new Date(`${date}T00:00:00Z`)).replace(',', '');

/** "25 min", "1h 05m". */
export const dur = (min) => {
  const m = Math.round(Math.abs(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
export const clock = (min) => { const x = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

/* ── the usual ────────────────────────────────────────────────────── */

/** The mean of the same weekday over the weeks before `date` (never the
    day itself). null under 3 of them. */
export function weekdayUsual(table, key, date, weeks = 8) {
  const v = [];
  for (let i = 1; i <= weeks; i += 1) { const x = valueOf(table, addDays(date, -7 * i), key); if (x !== null) v.push(x); }
  return { usual: v.length >= 3 ? mean(v) : null, n: v.length };
}

/** The 25th–75th percentile of the days before `date`. null under 4 days. */
export function typicalRange(table, key, date, days = 28) {
  const v = [];
  for (let i = 1; i <= days; i += 1) { const x = valueOf(table, addDays(date, -i), key); if (x !== null) v.push(x); }
  return v.length >= 4 ? { lo: quantile(v, 0.25), hi: quantile(v, 0.75), n: v.length } : { lo: null, hi: null, n: v.length };
}

/** One metric for the brief: the value and what to hold it against. */
export function metricBrief(table, key, { today, vday = today, settings = {} } = {}) {
  const m = METRICS[key];
  const p = m.p;
  let value; let yesterday; let usual; let usualN; let lo; let hi;
  if (m.activity) {
    value = valueOf(table, today, key);
    yesterday = valueOf(table, addDays(today, -1), key);
    const u = weekdayUsual(table, key, today);
    const t = typicalRange(table, key, today);
    usual = u.usual; usualN = u.n; lo = t.lo; hi = t.hi;
  } else {
    value = valueOf(table, vday, key);
    yesterday = valueOf(table, addDays(vday, -1), key);
    const b = baseline(table, m.raw, vday);
    usual = b.mean; usualN = b.n;
    lo = b.mean !== null ? b.mean - b.sd : null;
    hi = b.mean !== null ? b.mean + b.sd : null;
  }
  const delta = value !== null && usual !== null ? value - usual : null;
  return {
    value: round(value, p), yesterday: round(yesterday, p),
    usual: round(usual, p), usualKind: m.activity ? 'weekday' : 'baseline', usualN,
    lo: round(lo, p), hi: round(hi, p),
    delta: round(delta, p),
    // A deviation from its own baseline has no meaningful percentage.
    deltaPct: key === 'tempDev' ? null : pct(delta, usual),
    goal: goalOf(key, settings),
  };
}

/* ── streaks ──────────────────────────────────────────────────────── */

/** { date: { v } } of one metric, for metrics.streak. */
const column = (table, key) => {
  const out = {};
  for (const d of Object.keys(table || {})) { const v = valueOf(table, d, key); if (v !== null) out[d] = { v }; }
  return out;
};

/** The longest run of days at or above a target in the `cap` days to today. */
export function bestStreak(col, target, today, cap = 400) {
  if (!(target > 0)) return 0;
  let best = 0; let run = 0;
  for (let i = cap - 1; i >= 0; i -= 1) {
    if ((col[addDays(today, -i)]?.v ?? -1) >= target) { run += 1; if (run > best) best = run; } else run = 0;
  }
  return best;
}

const sessionWeeks = (sessions, tz) => new Set((sessions || []).map((s) => weekOf(todayIn(s.start, tz))));

/** Consecutive Monday weeks with a workout: ending this week if it has one,
    else last week (this one is not over). */
export function workoutWeeks(sessions, today, tz, cap = 400) {
  const has = sessionWeeks(sessions, tz);
  const thisWeek = weekOf(today);
  let w = has.has(thisWeek) ? thisWeek : addDays(thisWeek, -7);
  let current = 0;
  while (has.has(w) && current < 520) { current += 1; w = addDays(w, -7); }
  let best = 0; let run = 0;
  for (let x = weekOf(addDays(today, -cap)); x <= thisWeek; x = addDays(x, 7)) {
    if (has.has(x)) { run += 1; if (run > best) best = run; } else run = 0;
  }
  return { current, best: Math.max(best, current), thisWeek: has.has(thisWeek), any: has.size > 0 };
}

export function streaksFor({ table, sessions = [], today, tz, settings = {}, caps = {} }) {
  const out = [];
  const daily = (id, key, label, need) => {
    const col = column(table, key);
    if (!caps[METRICS[key].cap] && !Object.keys(col).length) return;
    const target = goalOf(key, settings);
    const now = col[today]?.v ?? null;
    let current = streak(col, 'v', target, today);
    // A night that came in under the goal cannot be made up later in the day.
    const over = key === 'sleepMin' && now !== null && now < target;
    if (over) current = 0;
    const atRisk = current > 0 && !((now ?? -1) >= target);
    out.push({ id, label, current, best: Math.max(current, bestStreak(col, target, today)), unit: 'days', atRisk, need: atRisk ? need(target - (now ?? 0), now) : null });
  };
  daily('steps', 'steps', 'Step goal', (left) => `${plural(left, 'step')} to go today`);
  daily('active', 'activeMinutes', 'Active minutes goal', (left) => `${plural(left, 'active minute')} to go today`);
  daily('sleep', 'sleepMin', 'Sleep goal', () => 'Last night\'s sleep has not arrived yet');
  const w = workoutWeeks(sessions, today, tz);
  if (w.any || caps.exercise) {
    const atRisk = w.current > 0 && !w.thisWeek;
    out.push({ id: 'workout_weeks', label: 'Weeks with a workout', current: w.current, best: w.best, unit: 'weeks', atRisk, need: atRisk ? 'One workout by Sunday' : null });
  }
  return out;
}

/* ── this week against last ───────────────────────────────────────── */

export function weekFor({ table, sessions = [], today, tz }) {
  const start = weekOf(today);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(start, i);
    const last = addDays(date, -7);
    const future = date > today;
    const v = (k) => (future ? null : valueOf(table, date, k));
    days.push({
      date, future,
      steps: v('steps'), lastSteps: valueOf(table, last, 'steps'),
      activeMinutes: v('activeMinutes'), lastActiveMinutes: valueOf(table, last, 'activeMinutes'),
      sleepMin: v('sleepMin'), lastSleepMin: valueOf(table, last, 'sleepMin'),
    });
  }
  const upto = days.filter((d) => !d.future);
  const total = (now, before, how = 'sum', p = 0) => {
    const f = (list) => { const v = list.filter(Number.isFinite); return v.length ? round(how === 'sum' ? v.reduce((a, b) => a + b, 0) : mean(v), p) : null; };
    const value = f(now); const previous = f(before);
    return { value, previous, deltaPct: value !== null && previous !== null ? pct(value - previous, previous) : null };
  };
  const col = (k, back = 0) => upto.map((d) => valueOf(table, addDays(d.date, -back), k));
  const lastStart = addDays(start, -7);
  const lastEnd = addDays(today, -7);
  const inWeek = (a, b) => (sessions || []).filter((s) => { const d = todayIn(s.start, tz); return d >= a && d <= b; });
  const mine = inWeek(start, today); const theirs = inWeek(lastStart, lastEnd);
  const mins = (list) => Math.round(list.reduce((a, s) => a + Math.max(0, (s.end ?? s.start) - s.start) / MIN, 0));
  const count = (a, b) => ({ value: a, previous: b, deltaPct: pct(a - b, b) });
  return {
    start, days,
    totals: {
      steps: total(col('steps'), col('steps', 7)),
      activeMinutes: total(col('activeMinutes'), col('activeMinutes', 7)),
      distanceM: total(col('distanceM'), col('distanceM', 7)),
      sleepAvgMin: total(col('sleepMin'), col('sleepMin', 7), 'mean'),
      workouts: count(mine.length, theirs.length),
      workoutMin: count(mins(mine), mins(theirs)),
    },
  };
}

/* ── sleep ────────────────────────────────────────────────────────── */

const localMin = (t, off) => { const d = new Date(t + (off || 0) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
/** Minutes after 18:00 local on the evening before: 23:30 is 330, 00:30 is 390. */
export const bedMinOf = (n) => (localMin(n.startMs, n.startOff) - 1080 + 1440) % 1440;
/** Minutes after 00:00 local. */
export const wakeMinOf = (n) => localMin(n.endMs, n.endOff);
const bedClock = (bedMin) => clock(bedMin + 1080);

const STAGES = ['DEEP', 'REM', 'LIGHT', 'AWAKE'];
/** A night's stage minutes, or null when the device gave no stages. */
export function stageMinutes(n) {
  const s = n?.summary?.stages;
  if (!s || !['DEEP', 'REM', 'LIGHT'].some((k) => Number.isFinite(s[k]) && s[k] > 0)) return null;
  const out = Object.fromEntries(STAGES.map((k) => [k, Number.isFinite(s[k]) ? s[k] : 0]));
  out.total = STAGES.reduce((a, k) => a + out[k], 0);
  return out.total > 0 ? out : null;
}

/**
 * How regular bedtime and wake time are: 0–100 from the spread of each over
 * the given main nights (100 = no spread, 0 = an SD of two hours or more),
 * the mean of the two. `score` is null under 3 nights.
 */
export function regularity(nights) {
  const main = (nights || []).filter((n) => n.main && Number.isFinite(n.startMs) && Number.isFinite(n.endMs));
  const list = main.map((n) => ({ date: n.date, bedMin: bedMinOf(n), wakeMin: wakeMinOf(n), asleepMin: n.asleepMin ?? null }));
  if (list.length < 3) return { score: null, bedMean: null, bedSd: null, wakeMean: null, wakeSd: null, nights: list };
  const b = stats(list.map((x) => x.bedMin)); const w = stats(list.map((x) => x.wakeMin));
  const part = (sd) => 100 * (1 - Math.min(sd, 120) / 120);
  return { score: Math.round((part(b.sd) + part(w.sd)) / 2), bedMean: round(b.mean), bedSd: round(b.sd), wakeMean: round(w.mean), wakeSd: round(w.sd), nights: list };
}

/** Sum of what each night fell short of the goal; nights without data ignored. */
export function sleepDebt(values, goal) {
  const v = (values || []).filter(Number.isFinite);
  return v.length ? Math.round(v.reduce((a, x) => a + Math.max(0, goal - x), 0)) : null;
}

export function sleepBrief({ nights = [], table, today, settings = {} }) {
  const main = nights.filter((n) => n.main).sort((a, b) => a.endMs - b.endMs);
  const recent = main.filter((n) => n.date > addDays(today, -14) && n.date <= today);
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  const before = recent.slice(0, -1);
  const goal = goalOf('sleepMin', settings);
  const avg = mean(recent.map((n) => n.asleepMin).filter(Number.isFinite));
  const time = (of, show) => {
    const usual = before.length >= 3 ? mean(before.map(of)) : null;
    return { last: show(of(last)), usual: usual !== null ? show(usual) : null, deltaMin: usual !== null ? Math.round(of(last) - usual) : null };
  };
  let stages = null;
  const mine = stageMinutes(last);
  if (mine) {
    const prev = main.filter((n) => n.endMs < last.endMs).map(stageMinutes).filter(Boolean).slice(-14);
    stages = Object.fromEntries(STAGES.map((k) => [k, {
      min: Math.round(mine[k]), pct: round((mine[k] / mine.total) * 100, 1),
      usualPct: prev.length >= 3 ? round(mean(prev.map((s) => (s[k] / s.total) * 100)), 1) : null,
    }]));
  }
  const week = []; for (let i = 0; i < 7; i += 1) week.push(valueOf(table, addDays(today, -i), 'sleepMin'));
  return {
    nights: recent.length,
    avgMin14: round(avg),
    lastVsAvgMin: avg !== null && Number.isFinite(last.asleepMin) ? Math.round(last.asleepMin - avg) : null,
    bedtime: time(bedMinOf, bedClock),
    wake: time(wakeMinOf, clock),
    stages,
    debt7Min: sleepDebt(week, goal),
    regularity: regularity(recent).score,
  };
}

/* ── what changed since yesterday ─────────────────────────────────── */

export function changesFor({ table, today, vday = today }) {
  const out = [];
  const ref = vday === today ? 'yesterday' : 'the day before';
  const pair = (key, day) => { const to = valueOf(table, day, key); const from = valueOf(table, addDays(day, -1), key); return to === null || from === null ? null : { from, to, d: to - from }; };
  const push = (key, label, x, unit, good, text) => out.push({ key, label, from: round(x.from, METRICS[key].p), to: round(x.to, METRICS[key].p), delta: round(x.d, METRICS[key].p), unit, good, text });
  let x;
  if ((x = pair('rhr', vday)) && Math.abs(x.d) >= 2) push('rhr', 'Resting heart rate', x, 'bpm', x.d < 0, `Resting heart rate is ${Math.round(Math.abs(x.d))} bpm ${x.d > 0 ? 'higher' : 'lower'} than ${ref}`);
  if ((x = pair('hrv', vday)) && x.from > 0 && Math.abs(x.d / x.from) >= 0.05) push('hrv', 'HRV', x, 'ms', x.d > 0, `HRV is ${Math.round(Math.abs(x.d / x.from) * 100)}% ${x.d > 0 ? 'higher' : 'lower'} than ${ref}`);
  if ((x = pair('sleepMin', vday)) && Math.abs(x.d) >= 20) push('sleepMin', 'Sleep', x, 'min', x.d > 0, `You slept ${dur(x.d)} ${x.d > 0 ? 'more' : 'less'} than the night before`);
  if ((x = pair('tempDev', vday)) && Math.abs(x.d) >= 0.3) push('tempDev', 'Sleep temperature', x, '°C', null, `Sleep temperature is ${round(Math.abs(x.d), 1)} °C ${x.d > 0 ? 'higher' : 'lower'} than the night before`);
  const y = addDays(today, -1);
  if ((x = pair('steps', y)) && x.from > 0 && Math.abs(x.d / x.from) >= 0.15) push('steps', 'Steps', x, 'steps', x.d > 0, `Yesterday you took ${Math.round(Math.abs(x.d / x.from) * 100)}% ${x.d > 0 ? 'more' : 'fewer'} steps than the day before`);
  if ((x = pair('activeMinutes', y)) && x.from > 0 && Math.abs(x.d / x.from) >= 0.15 && Math.abs(x.d) >= 5) push('activeMinutes', 'Active minutes', x, 'min', x.d > 0, `Yesterday you had ${fmt(Math.abs(x.d))} ${x.d > 0 ? 'more' : 'fewer'} active ${Math.round(Math.abs(x.d)) === 1 ? 'minute' : 'minutes'} than the day before`);
  return out;
}

/* ── insights ─────────────────────────────────────────────────────── */

const MILESTONES = [7, 14, 21, 30, 50, 75, 100, 150, 200, 250, 300, 365, 500];

/** How many days running a vital has sat outside baseline ± 1 SD, same side. */
export function bandRun(table, key, day) {
  const m = METRICS[key];
  let days = 0; let sum = 0; let dir = 0; let latest = null; let base = null;
  for (let i = 0; i < 14; i += 1) {
    const d = addDays(day, -i);
    const v = valueOf(table, d, key);
    const b = baseline(table, m.raw, d);
    if (v === null || b.mean === null) break;
    const diff = v - b.mean;
    const sd = Math.max(b.sd || 0, m.minSd || 0);
    const side = diff > sd ? 1 : diff < -sd ? -1 : 0;
    if (!side || (dir && side !== dir)) break;
    if (!days) { latest = v; base = b.mean; }
    dir = side; days += 1; sum += diff;
  }
  return days >= 2 ? { days, dir, mean: sum / days, latest, base } : null;
}

/** The best day of a metric in the table: { value, date, n } (latest wins a tie). */
export function recordOf(table, key, today) {
  let best = null; let n = 0;
  for (const d of Object.keys(table || {}).sort()) {
    if (d > today) continue;
    const v = valueOf(table, d, key);
    if (v === null) continue;
    n += 1;
    if (!best || v >= best.value) best = { value: v, date: d };
  }
  return best ? { ...best, n } : null;
}

/** Keep the strongest candidate per subject, strongest first, at most `max`. */
export function rankInsights(candidates, max = 8) {
  const by = new Map();
  for (const c of candidates || []) {
    if (!c) continue;
    const score = Math.max(0, Math.min(100, Math.round(c.score)));
    const have = by.get(c.subject || c.id);
    if (!have || score > have.score) by.set(c.subject || c.id, { ...c, score });
  }
  return [...by.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, max)
    .map(({ id, kind, score, tone, icon, title, text, href }) => ({ id, kind, score, tone, icon, title, text, href }));
}

export function insightsFor({ table, nights = [], weights = [], today, vday = today, settings = {}, streaks = [], week = null, sleep = null }) {
  const c = [];
  const yesterday = addDays(today, -1);

  // A vital that has stayed outside its own band.
  const band = (key, subject, make) => { const r = bandRun(table, key, vday); if (r) { const x = make(r); if (x) c.push({ id: `band_${key}`, kind: 'band', subject, score: 50 + 6 * Math.min(r.days, 6) + (x.tone === 'warn' ? 5 : 0), ...x }); } };
  const side = (r) => (r.dir > 0 ? 'above' : 'below');
  band('rhr', 'rhr', (r) => (Math.round(Math.abs(r.mean)) < 1 ? null : {
    tone: r.dir > 0 ? 'warn' : 'good', icon: 'heart', href: '/trends/heart',
    title: `Resting heart rate has been ${Math.round(Math.abs(r.mean))} bpm ${side(r)} your 30-day average for ${r.days} days`,
    text: `Latest ${round(r.latest)} bpm against an average of ${round(r.base, 1)} bpm.`,
  }));
  band('hrv', 'hrv', (r) => (Math.round(Math.abs(r.mean)) < 1 ? null : {
    tone: r.dir > 0 ? 'good' : 'warn', icon: 'pulse', href: '/trends/heart',
    title: `HRV has been ${Math.round(Math.abs(r.mean))} ms ${side(r)} your 30-day average for ${r.days} days`,
    text: `Latest ${round(r.latest, 1)} ms against an average of ${round(r.base, 1)} ms.`,
  }));
  band('sleepMin', 'sleep:amount', (r) => ({
    tone: r.dir > 0 ? 'good' : 'warn', icon: 'moon', href: '/trends/sleep',
    title: `You have slept ${dur(r.mean)} ${r.dir > 0 ? 'more' : 'less'} than your 30-day average for ${r.days} nights`,
    text: `Last night ${dur(r.latest)} against an average of ${dur(r.base)}.`,
  }));
  band('tempDev', 'temp', (r) => (round(Math.abs(r.mean), 1) < 0.1 ? null : {
    tone: 'info', icon: r.dir > 0 ? 'up' : 'down', href: '/trends/heart',
    title: `Sleep temperature has been ${round(Math.abs(r.mean), 1)} °C ${side(r)} its 30-day average for ${r.days} nights`,
    text: 'Measured on the skin while you sleep, against your own baseline.',
  }));

  // A day against the usual for its weekday.
  const usualDay = (key, day, words) => {
    const v = valueOf(table, day, key);
    const u = weekdayUsual(table, key, day);
    if (v === null || u.usual === null || u.n < 3 || !(u.usual > 0)) return;
    const p = ((v - u.usual) / u.usual) * 100;
    const isToday = day === today;
    // Today is not over: only "already more" can be said about it.
    if (Math.abs(p) < 10 || (isToday && p < 10)) return;
    c.push({
      id: `usual_${key}_${isToday ? 'today' : 'yesterday'}`, kind: 'usual', subject: `${key}:day`, score: (key === 'steps' ? 30 : 24) + Math.min(40, Math.abs(p) / 2) + (isToday ? 4 : 0),
      tone: p > 0 ? 'good' : 'info', icon: key === 'steps' ? 'steps' : 'bolt', href: '/trends/activity',
      title: words(Math.round(Math.abs(p)), p > 0, weekdayName(day), isToday),
      text: `${fmt(v)} against a usual ${fmt(u.usual)}, from the last ${u.n} ${weekdayName(day)}s.`,
    });
  };
  for (const day of [today, yesterday]) {
    usualDay('steps', day, (p, more, wd, t) => (t ? `You have already walked ${p}% more than your usual ${wd}` : `Yesterday you walked ${p}% ${more ? 'more' : 'less'} than your usual ${wd}`));
    usualDay('activeMinutes', day, (p, more, wd, t) => (t ? `You already have ${p}% more active minutes than on your usual ${wd}` : `Yesterday you had ${p}% ${more ? 'more' : 'fewer'} active minutes than on your usual ${wd}`));
  }

  // The week's pace.
  const ws = week?.totals?.steps;
  if (ws && ws.value !== null && ws.previous > 0 && dowOf(today) >= 1 && Math.abs(ws.deltaPct) >= 10) {
    const ahead = ws.deltaPct > 0;
    c.push({
      id: 'week_steps', kind: 'week', subject: 'steps:week', score: 35 + Math.min(30, Math.abs(ws.deltaPct) / 2), tone: ahead ? 'good' : 'info', icon: ahead ? 'up' : 'down', href: '/trends/activity',
      title: `This week you are ${Math.round(Math.abs(ws.deltaPct))}% ${ahead ? 'ahead of' : 'behind'} last week on steps`,
      text: `${fmt(ws.value)} steps by ${weekdayName(today)}, against ${fmt(ws.previous)} by the same day last week.`,
    });
  }

  // Streaks: one about to end, or one that just reached a round number.
  const words = { steps: ['day', 'step', 'at your step goal'], active: ['day', 'active minutes', 'at your active minutes goal'], sleep: ['night', 'sleep', 'at your sleep goal'], workout_weeks: ['week', 'workout', 'with a workout'] };
  const href = { steps: '/trends/activity', active: '/trends/activity', sleep: '/trends/sleep', workout_weeks: '/workouts' };
  for (const s of streaks) {
    const [unit, name, where] = words[s.id] || ['day', s.id, ''];
    const subject = s.id === 'workout_weeks' ? 'streak:workouts' : `goal:${s.id}`;
    if (s.atRisk && s.current >= 2) {
      c.push({ id: `streak_risk_${s.id}`, kind: 'streak_risk', subject, score: 52 + Math.min(36, s.current * 2), tone: 'warn', icon: 'alert', href: href[s.id], title: `Your ${s.current}-${unit} ${name} streak is at risk`, text: `${s.need}.` });
    } else if (!s.atRisk && MILESTONES.includes(s.current)) {
      c.push({ id: `streak_${s.id}_${s.current}`, kind: 'milestone', subject, score: 62 + Math.min(30, s.current / 4), tone: 'good', icon: 'flame', href: href[s.id], title: `${s.current} ${unit}s in a row ${where}`, text: s.best > s.current ? `Your longest is ${s.best}.` : 'That is your longest so far.' });
    }
  }

  // A record in the last week.
  const record = (key, subject, make) => {
    const r = recordOf(table, key, today);
    if (!r || r.n < 30 || daysBetween(r.date, today) > 6) return;
    c.push({ id: `best_${key}`, kind: 'best', subject, score: 72 - 2 * daysBetween(r.date, today), tone: 'good', icon: 'trophy', ...make(r) });
  };
  record('steps', 'steps:best', (r) => ({
    href: '/trends/activity',
    title: r.date === today ? 'Today is already your highest step day on record' : `${dayName(r.date)} was your highest step day on record`,
    text: `${fmt(r.value)} steps, the most in the ${fmt(r.n)} days held here.`,
  }));
  record('sleepMin', 'sleep:best', (r) => ({
    href: '/trends/sleep',
    title: `Your longest sleep on record ended on ${dayName(r.date)}`,
    text: `${dur(r.value)} asleep, the most in the ${fmt(r.n)} nights held here.`,
  }));

  // Sleep: debt, and a bedtime that is drifting.
  const goal = goalOf('sleepMin', settings);
  if (sleep?.debt7Min >= 120) {
    c.push({ id: 'sleep_debt', kind: 'debt', subject: 'sleep:amount', score: 46 + Math.min(34, (sleep.debt7Min - 120) / 8), tone: 'warn', icon: 'moon', href: '/trends/sleep', title: `You are ${dur(sleep.debt7Min)} short of your sleep goal over the last 7 nights`, text: `The goal is ${dur(goal)} a night.` });
  }
  const main = nights.filter((n) => n.main && n.date > addDays(today, -14) && n.date <= today).sort((a, b) => a.endMs - b.endMs);
  if (main.length >= 7) {
    const late = mean(main.slice(-3).map(bedMinOf)); const usual = mean(main.slice(0, -3).map(bedMinOf));
    const d = late - usual;
    if (d >= 40) c.push({ id: 'bedtime_drift', kind: 'bedtime', subject: 'sleep:timing', score: 42 + Math.min(30, (d - 40) / 2), tone: 'warn', icon: 'clock', href: '/trends/sleep', title: `Your last 3 bedtimes were ${dur(d)} later than usual`, text: `Around ${bedClock(late)} against a usual ${bedClock(usual)}.` });
  }

  // How often the goals were met.
  const rate = (key, id, from, subject, make) => {
    const v = []; for (let i = 0; i < 7; i += 1) { const x = valueOf(table, addDays(from, -i), key); if (x !== null) v.push(x); }
    if (v.length < 5) return;
    const hits = v.filter((x) => x >= goalOf(key, settings)).length;
    c.push({ id, kind: 'goal_rate', subject, score: 22 + 2 * Math.abs(hits - v.length / 2), tone: hits / v.length >= 0.7 ? 'good' : 'info', ...make(hits, v.length) });
  };
  rate('steps', 'goal_steps', yesterday, 'goal:steps', (h, n) => ({ icon: 'steps', href: '/trends/activity', title: `You reached your step goal on ${h} of the last ${n} days`, text: `The goal is ${fmt(goalOf('steps', settings))} steps a day.` }));
  rate('sleepMin', 'goal_sleep', today, 'goal:sleep', (h, n) => ({ icon: 'moon', href: '/trends/sleep', title: `You met your sleep goal on ${h} of the last ${n} nights`, text: `The goal is ${dur(goal)} a night.` }));

  // Weight over a month.
  const wt = weightTrend(weights, addDays(today, -30), today).filter((x) => x.avg7 !== null);
  if (wt.length >= 2 && daysBetween(wt[0].date, wt[wt.length - 1].date) >= 14) {
    const d = wt[wt.length - 1].avg7 - wt[0].avg7;
    if (Math.abs(d) >= 0.3) {
      c.push({
        id: 'weight_30', kind: 'weight', subject: 'weight', score: 30 + Math.min(25, Math.abs(d) * 10), tone: 'info', icon: 'scale', href: '/trends/body',
        title: `Your weight trend is ${d < 0 ? 'down' : 'up'} ${round(Math.abs(d), 1)} kg over ${daysBetween(wt[0].date, wt[wt.length - 1].date)} days`,
        text: `A 7-day average of ${round(wt[wt.length - 1].avg7, 1)} kg, from ${round(wt[0].avg7, 1)} kg.`,
      });
    }
  }
  return rankInsights(c);
}

/* ── the one next thing ───────────────────────────────────────────── */

export function nextFor({ table, nights = [], today, tz, now, settings = {}, connected = false, pending = 0, readiness = null, streaks = [], sleep = null }) {
  const empty = !Object.keys(table || {}).length;
  if (pending > 0) return { kind: 'workout', text: pending === 1 ? 'A possible workout is waiting for your answer' : `${pending} possible workouts are waiting for your answer`, href: '/workouts' };
  if (empty && !connected) return { kind: 'connect', text: 'Connect Google Health to start seeing your numbers here', href: '/settings' };
  if (empty) return { kind: 'sync', text: 'Your first sync is on its way. Numbers appear here as they arrive', href: '/settings' };
  if (readiness?.level === 'rest') return { kind: 'rest', text: 'Rest day: keep it light today and let the numbers come back', href: '/trends/heart' };
  if (readiness?.level === 'easy') return { kind: 'rest', text: 'Easy day: keep it light today, a walk is plenty', href: '/trends/heart' };

  const hhmm = clockIn(now, tz);
  const minuteNow = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const steps = valueOf(table, today, 'steps');
  const goal = goalOf('steps', settings);
  if (steps !== null && steps < goal) {
    const left = goal - steps;
    const walk = Math.max(5, Math.round(left / 100 / 5) * 5);
    if (left <= 5000 && walk <= 1440 - minuteNow) return { kind: 'steps', text: `${fmt(left)} steps to your goal, about a ${walk} minute walk`, href: '/trends/activity' };
  }
  const risk = streaks.find((s) => s.atRisk && s.current >= 2 && s.id !== 'sleep');
  if (risk) return { kind: 'streak', text: `${risk.need} to keep your ${risk.current}-${risk.unit === 'weeks' ? 'week' : 'day'} streak`, href: risk.id === 'workout_weeks' ? '/workouts' : '/trends/activity' };

  if (minuteNow >= 20 * 60 && sleep?.debt7Min >= 60) {
    const main = nights.filter((n) => n.main && n.date > addDays(today, -14) && n.date <= today);
    if (main.length >= 3) {
      const wake = mean(main.map(wakeMinOf));
      const target = goalOf('sleepMin', settings);
      return { kind: 'sleep', text: `You are ${dur(sleep.debt7Min)} short on sleep this week. Lights out by ${clock(wake - target - 15)} allows ${dur(target)} before your usual ${clock(wake)}`, href: '/trends/sleep' };
    }
  }
  if (steps !== null && steps >= goal) return { kind: 'done', text: 'Step goal reached. Nothing else needs you today', href: '/trends/activity' };
  return { kind: 'none', text: 'Nothing needs you right now', href: '/trends' };
}

/* ── the brief ────────────────────────────────────────────────────── */

/**
 * Today, in context.
 * @param {object} o
 * @param {string} o.today     civil date in the person's zone
 * @param {object} o.table     dailyTable from at least 400 days back
 * @param {Array}  o.nights    sleep sessions of the last 30 days or more
 * @param {Array}  o.sessions  confirmed workouts { start, end } of the last 400 days
 * @param {Array}  o.weights   weigh-ins { t, off, grams } of the last 40 days
 * @param {Array}  o.missing   capsMeta.missing
 */
export function brief({ today, tz, now = Date.now(), table = {}, nights = [], sessions = [], weights = [], settings = {}, caps = {}, missing = [], connected = false, pending = 0 }) {
  const vday = verdictDay(table, today, { caps });
  const metrics = {};
  for (const k of BRIEF_KEYS) {
    const m = metricBrief(table, k, { today, vday, settings });
    if (caps[METRICS[k].cap] || m.value !== null) metrics[k] = m;
  }
  const week = weekFor({ table, sessions, today, tz });
  const streaks = streaksFor({ table, sessions, today, tz, settings, caps });
  const sleep = sleepBrief({ nights, table, today, settings });
  const empty = !Object.keys(table).length;
  const readiness = empty ? null : readinessFor(table, vday, { caps });
  return {
    today, tz, weekday: weekdayName(today), verdictDay: vday,
    metrics, week, streaks, sleep,
    changes: changesFor({ table, today, vday }),
    insights: insightsFor({ table, nights, weights, today, vday, settings, streaks, week, sleep }),
    next: nextFor({ table, nights, today, tz, now, settings, connected, pending, readiness, streaks, sleep }),
    missing: (missing || []).map((x) => ({ cap: x.cap, text: x.text })),
  };
}

/* ── the day by the hour ──────────────────────────────────────────── */

/** Heart-rate roll-up windows -> [{ start, avg, min, max }] (min/max null
    when Google gave only the average). */
export function parseHrStats(points) {
  const out = [];
  for (const p of points || []) {
    const start = ms(p.startTime);
    const avg = num(p.heartRate?.beatsPerMinuteAvg);
    if (start === null || avg === null) continue;
    out.push({ start, avg, min: num(p.heartRate?.beatsPerMinuteMin), max: num(p.heartRate?.beatsPerMinuteMax) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The instants of a civil day's 25 hour boundaries in a zone. */
export const hourBounds = (date, tz) => Array.from({ length: 25 }, (_, h) => localToMs(date, h * 60, tz));

/**
 * 24 hours of one civil day. Windows of any size are folded into the local
 * hour they start in. `steps` / `hr` null = that stream is not available.
 * An hour that has not started is `future` with every number null.
 */
export function dayHours({ date, tz, now, steps = null, hr = null }) {
  const b = hourBounds(date, tz);
  const hours = [];
  for (let h = 0; h < 24; h += 1) {
    const future = b[h] > now;
    const row = { h, future, steps: null, hrAvg: null, hrMin: null, hrMax: null };
    if (!future) {
      if (steps) row.steps = Math.round(steps.filter((w) => w.start >= b[h] && w.start < b[h + 1]).reduce((a, w) => a + (w.steps || 0), 0));
      const beats = hr ? hr.filter((w) => w.start >= b[h] && w.start < b[h + 1]) : [];
      if (beats.length) {
        row.hrAvg = Math.round(mean(beats.map((w) => w.avg)));
        row.hrMin = Math.round(Math.min(...beats.map((w) => w.min ?? w.avg)));
        row.hrMax = Math.round(Math.max(...beats.map((w) => w.max ?? w.avg)));
      }
    }
    hours.push(row);
  }
  const walked = hours.filter((x) => x.steps > 0);
  const peak = walked.reduce((a, x) => (!a || x.steps > a.steps ? x : a), null);
  return { hours, peakHour: peak ? peak.h : null, activeHours: steps ? hours.filter((x) => x.steps >= 250).length : null };
}

/* ── trends ───────────────────────────────────────────────────────── */

/** A step from 1, 2, 2.5, 5 × 10ⁿ that covers `span` in at most `max` bins. */
export function niceStep(span, max = 10) {
  if (!(span > 0)) return 1;
  const raw = span / max;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * mag >= raw) return f * mag;
  return 10 * mag;
}

/** A histogram with round bin edges, at most `max` bins. The last bin
    includes its upper edge. */
export function histogram(values, max = 10) {
  const v = (values || []).filter(Number.isFinite);
  if (!v.length) return [];
  const lo0 = Math.min(...v); const hi0 = Math.max(...v);
  const fix = (x) => Math.round(x * 1e6) / 1e6;
  let step = niceStep(hi0 - lo0, max);
  let lo; let count;
  const lay = () => {
    lo = Math.floor(fix(lo0 / step)) * step;
    const top = fix((hi0 - lo) / step);
    // A maximum that sits exactly on an edge belongs to the bin below it.
    count = Math.floor(top) + (top > 0 && top % 1 === 0 ? 0 : 1);
  };
  lay();
  // Snapping the lower edge down can ask for a bin too many: take the next step up.
  while (count > max) { step = niceStep(step * 1.01 * max, max); lay(); }
  const bins = Array.from({ length: count }, (_, i) => ({ lo: fix(lo + i * step), hi: fix(lo + (i + 1) * step), n: 0 }));
  for (const x of v) bins[Math.min(count - 1, Math.max(0, Math.floor(fix((x - lo) / step))))].n += 1;
  return bins;
}

/**
 * One metric over a range.
 * @param {Array<{date, value}>} points   the range (nulls allowed)
 * @param {Array<number>} previous        the same number of days before it
 */
export function analyse(points, previous = [], { p = 0, goal = null, band = null } = {}) {
  const have = (points || []).filter((x) => Number.isFinite(x.value));
  if (!have.length) return null;
  const v = have.map((x) => x.value);
  const avg = mean(v);
  const prev = (previous || []).filter(Number.isFinite);
  const prevAvg = prev.length ? mean(prev) : null;
  const pick = (cmp) => have.reduce((a, x) => (cmp(x.value, a.value) ? x : a));
  const lo = pick((a, b) => a < b); const hi = pick((a, b) => a > b);
  const weekday = Array.from({ length: 7 }, (_, dow) => { const w = have.filter((x) => dowOf(x.date) === dow).map((x) => x.value); return { dow, avg: round(mean(w), p), n: w.length }; });
  const goalDays = goal !== null ? v.filter((x) => x >= goal).length : null;
  return {
    n: v.length, avg: round(avg, p), median: round(quantile(v, 0.5), p), p25: round(quantile(v, 0.25), p), p75: round(quantile(v, 0.75), p),
    min: { value: round(lo.value, p), date: lo.date }, max: { value: round(hi.value, p), date: hi.date },
    prevAvg: round(prevAvg, p), delta: prevAvg !== null ? round(avg - prevAvg, p) : null, deltaPct: prevAvg !== null ? pct(avg - prevAvg, prevAvg) : null,
    weekday, histogram: histogram(v),
    goal, goalDays, goalRate: goalDays !== null ? round(goalDays / v.length, 2) : null,
    outOfBand: band ? have.filter((x) => { const b = band[x.date]; return b && Number.isFinite(b.base) && b.sd > 0 && Math.abs(x.value - b.base) > 1.5 * b.sd; }).length : null,
  };
}

/** Trailing 7-day mean ending on a date; null under 4 values. */
export function avg7(table, key, date, p = 0) {
  const v = [];
  for (let i = 0; i < 7; i += 1) { const x = valueOf(table, addDays(date, -i), key); if (x !== null) v.push(x); }
  return v.length >= 4 ? round(mean(v), p) : null;
}

export function pearson(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = mean(pairs.map((q) => q[0])); const my = mean(pairs.map((q) => q[1]));
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Least-squares slope of y over x, or null without two distinct x. */
export function slope(pairs) {
  if (pairs.length < 2) return null;
  const mx = mean(pairs.map((q) => q[0])); const my = mean(pairs.map((q) => q[1]));
  let sxy = 0; let sxx = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : null;
}

export const RELATION_MIN = 14;
const RELATIONS = [
  { id: 'sleep_hrv', x: 'sleepMin', y: 'hrv', shift: 0, xLabel: 'Sleep', yLabel: 'HRV that morning', xUnit: 'min', yUnit: 'ms', words: ['On nights you slept longer, next-morning HRV tended to be', 'higher', 'lower'] },
  { id: 'sleep_next_steps', x: 'sleepMin', y: 'steps', shift: 0, xLabel: 'Sleep', yLabel: 'Steps that day', xUnit: 'min', yUnit: 'steps', words: ['After nights you slept longer, your steps that day tended to be', 'higher', 'lower'] },
  { id: 'steps_sleep', x: 'steps', y: 'sleepMin', shift: 1, xLabel: 'Steps', yLabel: 'Sleep that night', xUnit: 'steps', yUnit: 'min', words: ['On days you walked more, your sleep that night tended to be', 'longer', 'shorter'] },
];

/** One relationship from its pairs: n, r and a careful sentence. */
export function relation(def, pairs) {
  const n = pairs.length;
  const enough = n >= RELATION_MIN;
  const raw = enough ? pearson(pairs) : null;
  const r = raw !== null ? round(raw, 2) : null;
  const text = !enough ? `Not enough days yet (${n} of ${RELATION_MIN}).`
    : r === null || Math.abs(r) < 0.2 ? `No clear relationship in these ${n} days.`
      : `${def.words[0]} ${r > 0 ? def.words[1] : def.words[2]} (r = ${r.toFixed(2)} over ${n} days). A pattern, not a cause.`;
  return { id: def.id, xLabel: def.xLabel, yLabel: def.yLabel, xUnit: def.xUnit, yUnit: def.yUnit, n, enough, r, text, points: pairs.slice(-200) };
}

export function relationsFor({ table, from, today, caps = {} }) {
  const has = (key) => {
    if (caps[METRICS[key].cap]) return true;
    for (let d = from; d <= today; d = addDays(d, 1)) if (valueOf(table, d, key) !== null) return true;
    return false;
  };
  const out = [];
  for (const def of RELATIONS) {
    if (!has(def.x) || !has(def.y)) continue;
    const pairs = [];
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const yd = addDays(d, def.shift);
      // Steps of a day that is not over would understate it.
      if (yd > today || (d === today && def.x === 'steps') || (yd === today && def.y === 'steps')) continue;
      const x = valueOf(table, d, def.x); const y = valueOf(table, yd, def.y);
      if (x !== null && y !== null) pairs.push([round(x, METRICS[def.x].p), round(y, METRICS[def.y].p)]);
    }
    out.push(relation(def, pairs));
  }
  return out;
}

/** Calendar months touching [from, today], oldest first. Only days inside
    the range are counted. */
export function monthBuckets({ table, from, today, sessions = [], weights = [], tz }) {
  const by = new Map();
  const at = (date) => { const m = monthOf(date); if (!by.has(m)) by.set(m, { month: m, dates: [], sessions: [], kg: [] }); return by.get(m); };
  for (let d = from; d <= today; d = addDays(d, 1)) at(d).dates.push(d);
  for (const s of sessions) { const d = todayIn(s.start, tz); if (d >= from && d <= today) at(d).sessions.push(s); }
  for (const w of weights) { const d = new Date(w.t + (w.off || 0) * 1000).toISOString().slice(0, 10); if (d >= from && d <= today) at(d).kg.push(w.grams / 1000); }
  return [...by.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => {
    // A day that is not over would drag the activity averages down.
    const avg = (key, p = 0, skipToday = false) => round(mean(m.dates.filter((d) => !(skipToday && d === today)).map((d) => valueOf(table, d, key)).filter((x) => x !== null)), p);
    return {
      month: m.month,
      days: m.dates.filter((d) => ['steps', 'sleepMin', 'rhr', 'hrv', 'kcal'].some((k) => valueOf(table, d, k) !== null)).length,
      stepsAvg: avg('steps', 0, true), activeMinutesAvg: avg('activeMinutes', 0, true), sleepAvgMin: avg('sleepMin'), rhrAvg: avg('rhr', 1), hrvAvg: avg('hrv', 1),
      workouts: m.sessions.length, workoutMin: Math.round(m.sessions.reduce((a, s) => a + Math.max(0, (s.end ?? s.start) - s.start) / MIN, 0)),
      weightKg: m.kg.length ? round(mean(m.kg), 2) : null,
    };
  });
}

/** Weight over the range: how fast it moves, how far it went, its extremes. */
export function weightStats({ weights = [], from, today }) {
  const recent = weightTrend(weights, addDays(today, -27), today).filter((x) => x.avg7 !== null);
  const rate = recent.length >= 5 ? slope(recent.map((x) => [daysBetween(recent[0].date, x.date), x.avg7])) : null;
  const range = weightTrend(weights, from, today);
  const smooth = range.filter((x) => x.avg7 !== null);
  const days = range.filter((x) => x.kg !== null);
  const pick = (cmp) => (days.length ? (({ kg, date }) => ({ kg, date }))(days.reduce((a, x) => (cmp(x.kg, a.kg) ? x : a))) : null);
  return {
    ratePerWeekKg: rate !== null ? round(rate * 7, 2) : null,
    rangeChangeKg: smooth.length >= 2 ? round(smooth[smooth.length - 1].avg7 - smooth[0].avg7, 2) : null,
    min: pick((a, b) => a < b), max: pick((a, b) => a > b),
  };
}

/** Mean minutes and share of each stage over the nights that have stages. */
export function stagesAverage(nights) {
  const s = (nights || []).filter((n) => n.main).map(stageMinutes).filter(Boolean);
  if (!s.length) return null;
  const m = Object.fromEntries(STAGES.map((k) => [k, mean(s.map((x) => x[k]))]));
  const total = STAGES.reduce((a, k) => a + m[k], 0);
  return Object.fromEntries(STAGES.map((k) => [k, { min: Math.round(m[k]), pct: round((m[k] / total) * 100, 1) }]));
}

/**
 * What /api/trends adds to the dashboard's series.
 * @param {object} o
 * @param {object} o.table    dailyTable from at least 2 × days back
 * @param {Array}  o.series   the dashboard's rows for the range (for the baseline bands)
 * @param {Array}  o.nights   sleep sessions of the range
 * @param {Array}  o.weights  weigh-ins from at least max(days, 28) + 7 days back
 */
export function trendsAnalysis({ today, days, tz, table = {}, series = [], nights = [], sessions = [], weights = [], settings = {}, caps = {} }) {
  const from = addDays(today, -(days - 1));
  const dates = []; for (let d = from; d <= today; d = addDays(d, 1)) dates.push(d);
  const analysis = {};
  for (const key of TREND_KEYS) {
    const m = METRICS[key];
    const points = dates.filter((d) => !(m.activity && d === today)).map((d) => ({ date: d, value: valueOf(table, d, key) }));
    const previous = []; for (let i = 1; i <= days; i += 1) previous.push(valueOf(table, addDays(from, -i), key));
    const band = key === 'rhr' || key === 'hrv' ? Object.fromEntries(series.map((r) => [r.date, { base: r[`${key}Base`], sd: r[`${key}Sd`] }])) : null;
    const a = analyse(points, previous, { p: m.p, goal: goalOf(key, settings), band });
    if (a) analysis[key] = a;
  }
  const rows = dates.map((d) => ({
    stepsAvg7: avg7(table, 'steps', d), sleepAvg7: avg7(table, 'sleepMin', d), rhrAvg7: avg7(table, 'rhr', d, 1), hrvAvg7: avg7(table, 'hrv', d, 1),
    activeMinutes: valueOf(table, d, 'activeMinutes'), activeAvg7: avg7(table, 'activeMinutes', d),
  }));
  const goal = goalOf('sleepMin', settings);
  const slept = dates.map((d) => valueOf(table, d, 'sleepMin'));
  const inRange = nights.filter((n) => n.date >= from && n.date <= today);
  return {
    analysis, rows,
    months: monthBuckets({ table, from, today, sessions, weights, tz }),
    sleep: {
      regularity: regularity(inRange),
      stagesAvg: stagesAverage(inRange),
      debtMin: sleepDebt(slept, goal),
      goalNights: slept.filter((x) => x !== null && x >= goal).length,
    },
    weight: weightStats({ weights, from, today }),
    relations: relationsFor({ table, from, today, caps }),
  };
}
