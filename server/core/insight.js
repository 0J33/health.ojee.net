/* ============================================================
   health.ojee.net — the on-demand summary.

   Two halves, kept apart on purpose:

     stats()     every number the summary talks about, computed here,
                 deterministically, from the store. Tested. A language
                 model never does arithmetic on the raw data.

     rules()     a plain-language summary written from those numbers by
                 rules. It is what the page shows when the model cannot
                 be reached, and it is also the floor the model's answer
                 is held to: same structure, same sections.

   prompt() turns the stats and the person's own profile notes into the
   request the model sees, and parseAnswer() checks what comes back.
   Nothing but the stats object and the notes is ever sent.

   What a person logs in an optional group (food, moods, symptoms, a
   cycle, ECG readings) is NOT in the stats: stats() reads the `sample`
   table only for the groups named in `share`, which is the person's
   own per-group switch (off until they turn it on). Glucose and body
   temperature are never read here at all.
   ============================================================ */

import { addDays, daysBetween, stats as meanSd, round } from './util.js';
import { baseline, readinessFor, illness, weightTrend, BASELINE_DAYS } from './metrics.js';
import { GROUPS } from './google.js';

export const WINDOWS = ['night', 7, 30, 90];
export const windowOf = (w) => (w === 'night' ? 'night' : WINDOWS.includes(Number(w)) ? Number(w) : 7);
export const windowLabel = (w) => (w === 'night' ? 'last night' : `the last ${w} days`);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const median = (vals) => {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const sum = (vals) => vals.filter(Number.isFinite).reduce((a, b) => a + b, 0);
const pct = (a, b) => (b ? round((a / b) * 100) : null);
const clock = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const localMin = (t, off) => { const d = new Date(t + (off || 0) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const hm = (min) => (Number.isFinite(min) ? `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m` : '—');

/** Least-squares slope of y over x (per unit x), or null with < 3 points. */
export function slope(points) {
  const p = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (p.length < 3) return null;
  const mx = p.reduce((a, [x]) => a + x, 0) / p.length;
  const my = p.reduce((a, [, y]) => a + y, 0) / p.length;
  const num = p.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  const den = p.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  return den ? num / den : null;
}

/* ── sleep ────────────────────────────────────────────────────────── */

/** Stage minutes in the API's names, folded to four buckets. */
function stageMinutes(n) {
  const s = n.summary?.stages || {};
  const deep = s.DEEP ?? null;
  const rem = s.REM ?? null;
  const light = s.LIGHT ?? null;
  const awake = (s.AWAKE ?? 0) + (s.RESTLESS ?? 0);
  return { deep, rem, light, awake, staged: deep !== null || rem !== null || light !== null };
}

/** Wake bouts inside a night: AWAKE/RESTLESS stretches of at least `minMin`
    minutes, with their local clock time. */
export function wakeBouts(n, minMin = 5) {
  const out = [];
  for (const st of n.stages || []) {
    if (st.t !== 'AWAKE' && st.t !== 'RESTLESS') continue;
    const len = (st.e - st.s) / 60_000;
    // The stretch before falling asleep and after the final wake are not bouts.
    if (st.s <= n.startMs + 60_000 || st.e >= n.endMs - 60_000) continue;
    if (len >= minMin) out.push({ at: clock(localMin(st.s, n.startOff)), min: round(len), hour: Math.floor(localMin(st.s, n.startOff) / 60) });
  }
  return out;
}

function sleepStats(nights, stepTarget) {
  void stepTarget;
  const main = nights.filter((n) => n.main && Number.isFinite(n.asleepMin));
  if (!main.length) return { nights: 0 };
  const asleep = main.map((n) => n.asleepMin);
  const period = main.map((n) => n.periodMin);
  const eff = main.map((n) => (n.periodMin ? (n.asleepMin / n.periodMin) * 100 : null));
  const staged = main.map(stageMinutes).filter((s) => s.staged);
  const stageShare = (k) => (staged.length ? round(meanSd(staged.map((s, i) => {
    const total = (s.deep || 0) + (s.rem || 0) + (s.light || 0) + (s.awake || 0);
    void i;
    return total ? ((s[k] || 0) / total) * 100 : null;
  })).mean) : null);
  const bouts = main.map((n) => wakeBouts(n));
  const allBouts = bouts.flat();
  // Which hours of the night most of the wake time falls in.
  const byHour = {};
  for (const b of allBouts) byHour[b.hour] = (byHour[b.hour] || 0) + b.min;
  const busiest = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
  const bed = main.map((n) => (localMin(n.startMs, n.startOff) - 720 + 1440) % 1440);
  const wake = main.map((n) => localMin(n.endMs, n.endOff));
  const b = meanSd(bed); const w = meanSd(wake);
  const toSleep = main.map((n) => n.summary?.toFallAsleep).filter(Number.isFinite);
  return {
    nights: main.length,
    asleepAvgMin: round(meanSd(asleep).mean),
    asleepMedianMin: round(median(asleep)),
    asleepMinMin: round(Math.min(...asleep)),
    asleepMaxMin: round(Math.max(...asleep)),
    inBedAvgMin: round(meanSd(period).mean),
    efficiencyPct: round(meanSd(eff).mean, 1),
    under7h: asleep.filter((m) => m < 420).length,
    under6h: asleep.filter((m) => m < 360).length,
    stagesPct: staged.length ? { deep: stageShare('deep'), rem: stageShare('rem'), light: stageShare('light'), awake: stageShare('awake') } : null,
    stagedNights: staged.length,
    wakeBoutsPerNight: round(allBouts.length / main.length, 1),
    wakeMinPerNight: round(sum(allBouts.map((x) => x.min)) / main.length),
    wakeCluster: busiest && allBouts.length >= 2 ? `${clock(Number(busiest[0]) * 60)}–${clock((Number(busiest[0]) + 1) * 60)}` : null,
    bedtimeAvg: clock(b.mean + 720),
    bedtimeSdMin: main.length >= 3 ? round(b.sd) : null,
    wakeAvg: clock(w.mean),
    wakeSdMin: main.length >= 3 ? round(w.sd) : null,
    fallAsleepAvgMin: toSleep.length ? round(meanSd(toSleep).mean) : null,
  };
}

/* ── what was logged by hand, when the person shares it ───────────── */

const top = (counts, n = 6) => Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([name, times]) => ({ name, times }));
const lower = (id) => String(id || '').toLowerCase().replace(/_/g, ' ');

/**
 * The logged entries of the groups in `share`, summed up for a window.
 * Returns null when nothing is shared or nothing was logged. Free-text
 * notes are never included; a food's name is, because it is the entry.
 */
export function loggedStats(db, { from, to, share = null }) {
  const on = (id) => !!share && share[id] === true;
  const out = {};
  const rows = (kind) => db.samples(kind, { fromMs: Date.parse(`${addDays(from, -1)}T00:00:00Z`), toMs: Date.parse(`${addDays(to, 2)}T00:00:00Z`), limit: 1000 }).filter((r) => r.date >= from && r.date <= to);
  if (on('nutrition')) {
    const water = db.sampleDays('water', from, to);
    const food = db.sampleDays('food', from, to, ['protein', 'carbs', 'fat']);
    const names = {};
    for (const r of rows('food')) if (r.data?.name) names[r.data.name] = (names[r.data.name] || 0) + 1;
    const avg = (list, k) => (list.length ? round(sum(list.map((d) => d[k])) / list.length, 1) : null);
    if (water.length || food.length) {
      out.nutrition = {
        water: water.length ? { daysLogged: water.length, avgMlPerLoggedDay: avg(water, 'sum'), mostMlInADay: Math.max(...water.map((d) => d.sum)) } : null,
        food: food.length ? { daysLogged: food.length, avgKcalPerLoggedDay: avg(food, 'sum'), avgProteinG: avg(food, 'protein'), avgCarbsG: avg(food, 'carbs'), avgFatG: avg(food, 'fat'), mostLogged: top(names) } : null,
        note: 'only what was logged in this app; a day without entries is a day not logged, not a day without food or water',
      };
    }
  }
  if (on('mindfulness')) {
    const list = rows('mood');
    if (list.length) {
      const moods = {}; const feel = { pleasant: 0, neutral: 0, unpleasant: 0 };
      for (const r of list) {
        for (const m of r.data?.moods || []) moods[lower(m)] = (moods[lower(m)] || 0) + 1;
        if (r.value === 1) feel.pleasant += 1; else if (r.value === 0) feel.neutral += 1; else if (r.value === -1) feel.unpleasant += 1;
      }
      out.mood = { entries: list.length, feel, mostLogged: top(moods) };
    }
  }
  if (on('symptoms')) {
    const list = rows('symptom');
    if (list.length) {
      const counts = {};
      for (const r of list) for (const x of r.data?.symptoms || []) counts[lower(x)] = (counts[lower(x)] || 0) + 1;
      out.symptoms = { entries: list.length, daysWithAny: new Set(list.map((r) => r.date)).size, mostLogged: top(counts) };
    }
  }
  if (on('cycle')) {
    const periods = rows('period').sort((a, b) => a.t - b.t);
    const tests = rows('ovulation').sort((a, b) => a.t - b.t);
    if (periods.length || tests.length) {
      out.cycle = {
        periods: periods.map((r) => ({ start: r.data?.start || r.date, days: r.value })),
        ovulationTests: tests.map((r) => ({ date: r.date, result: lower(r.data?.result) })),
      };
    }
  }
  if (on('ecg')) {
    const ecg = rows('ecg'); const irn = rows('irn');
    if (ecg.length || irn.length) {
      const kinds = {};
      for (const r of ecg) kinds[lower(r.data?.classification) || 'unclassified'] = (kinds[lower(r.data?.classification) || 'unclassified'] || 0) + 1;
      out.ecg = { readings: ecg.length, results: top(kinds), rhythmNotices: irn.length, note: 'as recorded by the watch; not a diagnosis' };
    }
  }
  return Object.keys(out).length ? out : null;
}
/** The kinds loggedStats may read for a `share`: used by a test that no other kind is. */
export const SHARED_KINDS = Object.fromEntries(GROUPS.map((g) => [g.id, g.kinds]));

/* ── the whole picture ────────────────────────────────────────────── */

/**
 * Every number the summary may talk about, for one window.
 * @param {object} db      a Store
 * @param {object} o       { today, window, settings, sets, caps, extras, share }
 *   window: 'night' | 7 | 30 | 90
 *   sets:   the strength log (the person's own, never Google's)
 *   extras: `{ cardio, sleepScore }`, this app's own calculated numbers
 *           (see browse.js summaryExtras); left out when not given
 *   share:  `{ nutrition: true, ... }`, the optional groups the person
 *           lets a summary read. Nothing logged is read without it.
 */
export function stats(db, { today, window = 7, settings = {}, sets = [], caps = null, extras = null, share = null }) {
  const win = windowOf(window);
  const days = win === 'night' ? 1 : win;
  const from = addDays(today, -(days - 1));
  // Complete days end yesterday: today's steps are a running total.
  const completeTo = addDays(today, -1);
  const completeFrom = win === 'night' ? completeTo : addDays(today, -days);
  const table = db.dailyTable(addDays(today, -(days + BASELINE_DAYS + 7)));
  const stepTarget = settings.stepTarget || 8000;
  const azmTarget = settings.azmTarget || 22;

  const dates = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const inWindow = dates(from, today);
  const complete = dates(completeFrom, completeTo);

  /* coverage: how much there is to go on */
  const has = (k, ds) => ds.filter((d) => Number.isFinite(table[d]?.[k])).length;
  const coverage = {
    days,
    stepsDays: has('steps', complete),
    rhrDays: has('rhr', inWindow),
    hrvDays: has('hrv', inWindow),
    sleepNights: has('sleep_min', inWindow),
    firstData: Object.keys(table).sort()[0] || null,
    firstWearable: Object.keys(table).filter((d) => Number.isFinite(table[d].rhr) || Number.isFinite(table[d].hrv) || Number.isFinite(table[d].sleep_min)).sort()[0] || null,
  };

  /* sleep */
  const nights = db.sleeps(addDays(from, -1)).filter((n) => n.date >= from && n.date <= today);
  const sleep = sleepStats(nights, stepTarget);
  if (win === 'night') {
    const last = [...nights].reverse().find((n) => n.main) || null;
    if (last) {
      const sm = stageMinutes(last);
      sleep.lastNight = {
        date: last.date,
        bedtime: clock(localMin(last.startMs, last.startOff)),
        wake: clock(localMin(last.endMs, last.endOff)),
        asleepMin: round(last.asleepMin), inBedMin: round(last.periodMin),
        efficiencyPct: last.periodMin ? round((last.asleepMin / last.periodMin) * 100, 1) : null,
        stagesMin: sm.staged ? { deep: round(sm.deep), rem: round(sm.rem), light: round(sm.light), awake: round(sm.awake) } : null,
        wakeBouts: wakeBouts(last).map(({ at, min }) => ({ at, min })),
      };
    }
  }

  /* heart */
  const heart = {};
  for (const k of ['rhr', 'hrv']) {
    const vals = inWindow.map((d) => table[d]?.[k]);
    const s = meanSd(vals);
    // The baseline is the 30 days BEFORE the window: what "usual" was going in.
    const base = baseline(table, k, from);
    const latestDay = [...inWindow].reverse().find((d) => Number.isFinite(table[d]?.[k]));
    const sl = slope(inWindow.map((d, i) => [i, table[d]?.[k]]));
    heart[k] = {
      days: s.n,
      mean: s.n ? round(s.mean, 1) : null,
      min: s.n ? round(Math.min(...vals.filter(Number.isFinite)), 1) : null,
      max: s.n ? round(Math.max(...vals.filter(Number.isFinite)), 1) : null,
      latest: latestDay ? round(table[latestDay][k], 1) : null,
      latestDate: latestDay || null,
      baseline: base.mean !== null ? round(base.mean, 1) : null,
      baselineDays: base.n,
      vsBaseline: base.mean !== null && s.n ? round(s.mean - base.mean, 1) : null,
      vsBaselinePct: base.mean && s.n ? round(((s.mean - base.mean) / base.mean) * 100) : null,
      perWeek: sl !== null ? round(sl * 7, 2) : null,
    };
  }
  heart.typical = {
    rhr: 'adults at rest: 60–100 bpm is the textbook range; regularly active people often sit at 50–65',
    hrv: 'nightly RMSSD varies a lot between people (roughly 20–80 ms in adults); only your own baseline and trend are meaningful',
  };

  /* activity — complete days only */
  const steps = complete.map((d) => table[d]?.steps).filter(Number.isFinite);
  const azm = complete.map((d) => table[d]?.azm).filter(Number.isFinite);
  const byDow = {};
  for (const d of complete) {
    const v = table[d]?.steps;
    if (!Number.isFinite(v)) continue;
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    (byDow[dow] ||= []).push(v);
  }
  const weekday = Object.entries(byDow).map(([k, v]) => ({ day: WEEKDAYS[k], avg: round(meanSd(v).mean), n: v.length }))
    .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day));
  const ranked = [...weekday].filter((x) => x.n >= 1).sort((a, b) => b.avg - a.avg);
  const workouts = db.exercises(addDays(from, -1)).filter((e) => e.date >= from && e.date <= today);
  const gymDays = [...new Set(sets.filter((s) => s.date >= from && s.date <= today).map((s) => s.date))].sort();
  const gymSets = sets.filter((s) => s.date >= from && s.date <= today);
  const muscles = {};
  for (const s of gymSets) muscles[s.muscle] = (muscles[s.muscle] || 0) + (s.sets || 1);
  const activity = {
    stepTarget, azmTarget,
    completeDays: steps.length,
    stepsAvg: steps.length ? round(meanSd(steps).mean) : null,
    stepsMedian: steps.length ? round(median(steps)) : null,
    stepsMin: steps.length ? Math.min(...steps) : null,
    stepsMax: steps.length ? Math.max(...steps) : null,
    daysUnder5k: steps.filter((v) => v < 5000).length,
    daysUnder7500: steps.filter((v) => v < 7500).length,
    daysAtTarget: steps.filter((v) => v >= stepTarget).length,
    pctUnder5k: pct(steps.filter((v) => v < 5000).length, steps.length),
    weekday,
    bestDay: ranked[0] || null,
    worstDay: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    todaySoFar: Number.isFinite(table[today]?.steps) ? table[today].steps : null,
    yesterday: Number.isFinite(table[completeTo]?.steps) ? table[completeTo].steps : null,
    azmAvg: azm.length ? round(meanSd(azm).mean) : null,
    azmPerWeek: azm.length ? round((sum(azm) / azm.length) * 7) : null,
    azmDaysAtTarget: azm.filter((v) => v >= azmTarget).length,
    azmZones: {
      fatBurn: round(sum(complete.map((d) => table[d]?.azm_fat))),
      cardio: round(sum(complete.map((d) => table[d]?.azm_cardio))),
      peak: round(sum(complete.map((d) => table[d]?.azm_peak))),
    },
    workouts: workouts.map((e) => ({
      date: e.date, type: e.name || e.type || 'workout',
      min: round((e.endMs - e.startMs) / 60_000), kcal: round(e.kcal), azm: round(e.azm), avgHr: round(e.avgHr),
    })).slice(-20),
    gym: {
      days: gymDays,
      sessions: gymDays.length,
      sets: sum(gymSets.map((s) => s.sets || 1)),
      volumeKg: round(sum(gymSets.map((s) => s.kg * s.reps * (s.sets || 1)))),
      muscles,
    },
  };

  /* weight — the caveats matter as much as the number */
  const wts = db.weights(Date.parse(`${addDays(from, -7)}T00:00:00Z`));
  const inWin = wts.filter((x) => new Date(x.t + (x.off || 0) * 1000).toISOString().slice(0, 10) >= from);
  const trend = weightTrend(wts, from, today).filter((x) => x.avg7 !== null);
  const hours = inWin.map((x) => localMin(x.t, x.off) / 60);
  const hourSd = hours.length >= 2 ? meanSd(hours).sd : null;
  const weight = {
    weighIns: inWin.length,
    latestKg: inWin.length ? round(inWin[inWin.length - 1].grams / 1000, 1) : (wts.length ? round(wts[wts.length - 1].grams / 1000, 1) : null),
    firstAvg7: trend.length ? trend[0].avg7 : null,
    lastAvg7: trend.length ? trend[trend.length - 1].avg7 : null,
    change: trend.length >= 2 ? round(trend[trend.length - 1].avg7 - trend[0].avg7, 2) : null,
    perWeek: trend.length >= 7 ? round(((trend[trend.length - 1].avg7 - trend[0].avg7) / Math.max(1, daysBetween(trend[0].date, trend[trend.length - 1].date))) * 7, 2) : null,
    timeOfDaySpreadH: hourSd !== null ? round(hourSd, 1) : null,
    bodyFatLatest: (() => { const d = [...inWindow].reverse().find((x) => Number.isFinite(table[x]?.body_fat)); return d ? round(table[d].body_fat, 1) : null; })(),
    caveats: [],
  };
  if (weight.weighIns < 4) weight.caveats.push(`only ${weight.weighIns} weigh-in${weight.weighIns === 1 ? '' : 's'} in the window — too few for a trend`);
  if (hourSd !== null && hourSd > 2) weight.caveats.push(`weigh-ins taken at different times of day (spread ±${round(hourSd, 1)} h) — compare like with like, ideally mornings after the toilet, before food`);

  /* readiness */
  const levels = { push: 0, normal: 0, easy: 0, rest: 0, learning: 0, unavailable: 0 };
  const scores = [];
  for (const d of inWindow) {
    const r = readinessFor(table, d, { caps });
    const any = Number.isFinite(table[d]?.hrv) || Number.isFinite(table[d]?.rhr) || Number.isFinite(table[d]?.sleep_min);
    if (!any) continue;
    levels[r.level] += 1;
    if (Number.isFinite(r.score)) scores.push(r.score);
  }
  const latestR = readinessFor(table, [...inWindow].reverse().find((d) => Number.isFinite(table[d]?.hrv) || Number.isFinite(table[d]?.rhr)) || today, { caps });
  const ill = illness(table, latestR.date);
  const readiness = {
    latest: { date: latestR.date, level: latestR.level, label: latestR.label, text: latestR.text, score: latestR.score },
    levels,
    avgScore: scores.length ? round(meanSd(scores).mean, 1) : null,
    illness: ill.flag ? ill.text : null,
  };

  /* breathing and fitness: only what the device gives, nothing made up */
  const respVals = inWindow.map((d) => table[d]?.resp).filter(Number.isFinite);
  if (respVals.length) {
    const base = baseline(table, 'resp', from);
    const m = meanSd(respVals).mean;
    heart.resp = {
      days: respVals.length, mean: round(m, 1), latest: round(respVals[respVals.length - 1], 1),
      baseline: base.mean !== null ? round(base.mean, 1) : null, vsBaseline: base.mean !== null ? round(m - base.mean, 1) : null,
      note: 'breaths a minute during sleep',
    };
  }
  const vo2Day = Object.keys(table).sort().reverse().find((d) => d <= today && Number.isFinite(table[d].vo2max ?? table[d].vo2max_run));
  if (vo2Day && daysBetween(vo2Day, today) <= 45) heart.vo2max = { latest: round(table[vo2Day].vo2max ?? table[vo2Day].vo2max_run, 1), date: vo2Day, note: 'the watch\'s estimate, ml/kg/min' };

  /* this app's own numbers, when the caller worked them out */
  if (extras?.cardio && win !== 'night') activity.cardio = extras.cardio;
  if (extras?.sleepScore) sleep.score = extras.sleepScore;

  const out = { window: win, label: windowLabel(win), today, from, to: today, completeFrom, completeTo, coverage, sleep, heart, activity, weight, readiness };
  /* logged by hand: only the groups the person shares */
  const logged = loggedStats(db, { from: win === 'night' ? completeTo : from, to: today, share });
  if (logged) out.logged = logged;
  return out;
}

/* ── the rule-based summary ───────────────────────────────────────── */

const n = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const sgn = (v, p = 0) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(round(v, p))}` : '—');

/** Words the profile notes use, read loosely: enough to pick the advice. */
export function profileFlags(notes = '') {
  const t = String(notes).toLowerCase();
  return {
    desk: /desk|sitting|sit all day|office|computer/.test(t),
    back: /back pain|lower back|back ache|backache/.test(t),
    reflux: /reflux|heartburn|gerd|acid/.test(t),
    fastFood: /fast food|takeaway|junk/.test(t),
    gym: /gym|lift|weights|training/.test(t),
    gymPerWeek: (() => { const m = /gym[^.\n]*?(\d)\s*(?:\+|or more|days?|x|times)/.exec(t) || /(\d)\s*(?:\+|or more)?\s*(?:days?|times)\s*(?:a|per)\s*week/.exec(t); return m ? Number(m[1]) : null; })(),
    earlySleeper: /early (?:to )?bed|sleep(?:s)? early|wake(?:s)? early|early riser/.test(t),
  };
}

/**
 * The summary, by rules, from stats(). Same shape the model is asked for:
 *   { headline, sections: [{ id, title, text }], nextSteps: [..], caveats: [..] }
 */
export function rules(s, notes = '', { caps = null } = {}) {
  const f = profileFlags(notes);
  // A section about something the person's device never reports would only
  // ever say "no data": it is left out instead. Unknown caps = show all.
  const can = (...keys) => !caps || keys.some((k) => caps[k]);
  const sections = [];
  const caveats = [];
  const steps = [];
  const night = s.window === 'night';

  /* coverage */
  if (s.coverage.firstWearable && s.coverage.firstWearable > s.from) {
    caveats.push(`The tracker's sleep and heart data start ${s.coverage.firstWearable}, so ${s.label} only has ${s.coverage.sleepNights} night${s.coverage.sleepNights === 1 ? '' : 's'} of sleep and ${s.coverage.rhrDays} day${s.coverage.rhrDays === 1 ? '' : 's'} of resting heart rate.`);
  }

  /* sleep */
  const sl = s.sleep;
  if (night && sl.lastNight) {
    const L = sl.lastNight;
    const stg = L.stagesMin ? ` Stages: deep ${hm(L.stagesMin.deep)}, REM ${hm(L.stagesMin.rem)}, light ${hm(L.stagesMin.light)}, awake ${hm(L.stagesMin.awake)}.` : '';
    const bouts = L.wakeBouts.length ? ` Woke ${L.wakeBouts.length} time${L.wakeBouts.length === 1 ? '' : 's'} for 5 min or more (${L.wakeBouts.map((b) => `${b.at}, ${b.min} min`).join('; ')}).` : ' No wake-ups of 5 min or more.';
    sections.push({ id: 'sleep', title: 'Sleep', text: `In bed ${L.bedtime} → ${L.wake}: ${hm(L.asleepMin)} asleep of ${hm(L.inBedMin)} in bed (${L.efficiencyPct ?? '—'}% efficiency).${stg}${bouts} ${L.asleepMin >= 420 ? 'That meets the 7-hour mark.' : `That is ${hm(420 - L.asleepMin)} short of 7 hours.`}` });
    if (L.asleepMin < 420) steps.push(f.earlySleeper ? 'You go to bed early by design, so protect the full window: same lights-out tonight, phone out of the bedroom.' : 'Aim for 7+ hours tonight — move lights-out earlier by 30 minutes rather than sleeping in.');
  } else if (sl.nights) {
    const st = sl.stagesPct ? ` On nights with stage data: deep ${sl.stagesPct.deep}%, REM ${sl.stagesPct.rem}%, light ${sl.stagesPct.light}%, awake ${sl.stagesPct.awake}% (typical adults: deep 13–23%, REM 20–25%).` : '';
    const cons = sl.bedtimeSdMin !== null ? ` Bedtime averages ${sl.bedtimeAvg} (±${sl.bedtimeSdMin} min) and wake ${sl.wakeAvg} (±${sl.wakeSdMin} min)${sl.bedtimeSdMin <= 30 ? ' — consistent' : sl.bedtimeSdMin <= 60 ? ' — somewhat variable' : ' — irregular'}.` : ` Bedtime ${sl.bedtimeAvg}, wake ${sl.wakeAvg}.`;
    const wake = sl.wakeBoutsPerNight ? ` About ${sl.wakeBoutsPerNight} wake-ups of 5+ min a night${sl.wakeCluster ? `, mostly around ${sl.wakeCluster}` : ''}.` : '';
    sections.push({ id: 'sleep', title: 'Sleep', text: `${sl.nights} night${sl.nights === 1 ? '' : 's'}: ${hm(sl.asleepAvgMin)} asleep on average (median ${hm(sl.asleepMedianMin)}, range ${hm(sl.asleepMinMin)}–${hm(sl.asleepMaxMin)}), ${sl.efficiencyPct}% sleep efficiency; ${sl.under7h} night${sl.under7h === 1 ? '' : 's'} under 7 h.${st}${cons}${wake}` });
    if (sl.score) sections[sections.length - 1].text += ` Sleep score (calculated by this app): ${sl.score.avg} of 100 on average${sl.score.weakestPart ? `; ${sl.score.weakestPart} is the part that held it back most` : ''}.`;
    if (sl.asleepAvgMin < 420) steps.push(f.earlySleeper ? 'Early nights are your routine now — keep lights-out fixed and count back 7.5 h from your alarm.' : 'Average sleep is under 7 h: bring lights-out forward 30 minutes and keep it the same every night.');
    else if (sl.bedtimeSdMin !== null && sl.bedtimeSdMin > 45) steps.push('Sleep amount is fine; tighten bedtime to within 30 minutes of the same time each night.');
  } else {
    if (can('sleep')) sections.push({ id: 'sleep', title: 'Sleep', text: 'No tracked sleep in this window yet. Wear your device overnight to get duration, stages and wake-ups.' });
  }

  /* heart */
  const h = s.heart;
  const parts = [];
  if (h.rhr.days) {
    parts.push(`Resting HR ${h.rhr.mean} bpm on average (latest ${h.rhr.latest})${h.rhr.baseline !== null ? `, ${sgn(h.rhr.vsBaseline, 1)} bpm vs your baseline of ${h.rhr.baseline}` : ', no personal baseline yet (needs 7+ days)'}; textbook adult range is 60–100, active people often 50–65.`);
    if (h.rhr.perWeek !== null && Math.abs(h.rhr.perWeek) >= 0.5) parts.push(`It is trending ${h.rhr.perWeek < 0 ? 'down' : 'up'} by about ${Math.abs(h.rhr.perWeek)} bpm a week${h.rhr.perWeek < 0 ? ' — a good sign of improving fitness or recovery' : ' — watch for stress, illness or too little recovery'}.`);
  }
  if (h.hrv.days) {
    parts.push(`HRV ${h.hrv.mean} ms on average (latest ${h.hrv.latest})${h.hrv.baseline !== null ? `, ${sgn(h.hrv.vsBaselinePct)}% vs your baseline of ${h.hrv.baseline}` : ' — still learning your baseline'}. HRV is personal; the trend against your own normal is what matters.`);
  }
  // Breathing rate is only worth a sentence when it has moved.
  if (h.resp && h.resp.vsBaseline !== null && Math.abs(h.resp.vsBaseline) >= 1) parts.push(`Breathing rate during sleep ${h.resp.mean} a minute, ${sgn(h.resp.vsBaseline, 1)} against your usual ${h.resp.baseline}.`);
  if (h.vo2max && !night) parts.push(`VO2 max estimate ${h.vo2max.latest} ml/kg/min (${h.vo2max.date}).`);
  if (parts.length || can('restingHr', 'hrv')) sections.push({ id: 'heart', title: 'Heart', text: parts.length ? parts.join(' ') : 'No resting heart rate or HRV in this window yet. Both come from overnight wear.' });

  /* activity */
  const a = s.activity;
  const act = [];
  if (a.completeDays) {
    act.push(`${a.completeDays} complete day${a.completeDays === 1 ? '' : 's'}: ${n(a.stepsAvg)} steps a day on average (median ${n(a.stepsMedian)}, range ${n(a.stepsMin)}–${n(a.stepsMax)}); ${a.daysAtTarget} at your ${n(a.stepTarget)} target, ${a.daysUnder5k} under 5,000 (${a.pctUnder5k}%).`);
    if (a.bestDay && a.worstDay && a.weekday.length >= 4) act.push(`Most active on ${a.bestDay.day} (${n(a.bestDay.avg)}), least on ${a.worstDay.day} (${n(a.worstDay.avg)}).`);
  } else if (Number.isFinite(a.todaySoFar)) {
    act.push(`${n(a.todaySoFar)} steps so far today.`);
  }
  if (a.azmAvg !== null) act.push(`Active zone minutes: ${a.azmAvg} a day, about ${a.azmPerWeek} a week against the ~150 a week guideline${a.azmZones.cardio + a.azmZones.peak ? ` (${a.azmZones.cardio + a.azmZones.peak} min in cardio/peak zones)` : ''}.`);
  if (a.cardio) act.push(`Cardio minutes (calculated by this app from ${a.cardio.source || 'your activity'}): ${a.cardio.thisWeekMin} of your ${a.cardio.targetMin} a week so far this week${a.cardio.lastWeekMin !== null ? `, ${a.cardio.lastWeekMin} last week` : ''}${a.cardio.weeksCounted ? `; target met in ${a.cardio.weeksAtTarget} of the last ${a.cardio.weeksCounted} full weeks` : ''}.`);
  if (a.gym.sessions) act.push(`Strength training (logged here): ${a.gym.sessions} session${a.gym.sessions === 1 ? '' : 's'} (${a.gym.days.join(', ')}), ${a.gym.sets} sets, ${n(a.gym.volumeKg)} kg total volume.`);
  if (a.workouts.length) act.push(`Workouts recorded by the tracker/app: ${a.workouts.length} (${[...new Set(a.workouts.map((w) => w.type))].slice(0, 4).join(', ')}).`);
  sections.push({ id: 'activity', title: 'Activity', text: act.length ? act.join(' ') : 'No complete days of activity in this window.' });
  if (f.desk) steps.push('Desk days: stand and walk 3–5 minutes every 45–60 minutes. It helps the back more than one long walk.');
  if (f.gym && !night) {
    const want = f.gymPerWeek || 3;
    const weeks = Math.max(1, s.coverage.days / 7);
    const rate = a.gym.sessions / weeks;
    steps.push(a.gym.sessions
      ? `Gym: ${a.gym.sessions} session${a.gym.sessions === 1 ? '' : 's'} logged (${round(rate, 1)}/week) vs your ${want}+/week plan — ${rate >= want ? 'on track; add a little load each week' : 'book the remaining days now and log each one here'}.`
      : `Gym: none logged in this window — schedule your ${want} days and log the sets here so the summary can track them.`);
  } else if (a.stepsAvg !== null && a.stepsAvg < 6000) {
    steps.push('Steps are low: a 10-minute walk after lunch and after dinner adds roughly 2,000 a day.');
  }

  /* weight */
  const w = s.weight;
  const wt = [];
  if (w.weighIns) {
    wt.push(`${w.weighIns} weigh-in${w.weighIns === 1 ? '' : 's'}; latest ${w.latestKg} kg${w.change !== null ? `, 7-day average ${sgn(w.change, 2)} kg over the window` : ''}${w.perWeek !== null ? ` (${sgn(w.perWeek, 2)} kg/week)` : ''}.`);
  } else if (w.latestKg !== null) {
    wt.push(`No weigh-ins in this window; the last one was ${w.latestKg} kg.`);
  }
  if (w.bodyFatLatest !== null) wt.push(`Body fat ${w.bodyFatLatest}%.`);
  if (w.caveats.length && (wt.length || can('weight'))) wt.push(`Caveats: ${w.caveats.join('; ')}.`);
  if (wt.length || can('weight', 'bodyFat')) sections.push({ id: 'weight', title: 'Weight', text: wt.length ? wt.join(' ') : 'No weight data.' });
  if (f.fastFood || f.reflux) steps.push(f.reflux ? 'Reflux: finish the last meal 2–3 hours before your (early) bedtime, and swap one fast-food meal a week for a home-cooked one.' : 'Swap one fast-food meal a week for something home-cooked with protein and vegetables.');
  if (w.weighIns < 4 && can('weight')) steps.push('Weigh in 3+ mornings a week, same time and conditions, so the trend means something.');

  /* readiness */
  const r = s.readiness;
  const counted = Object.entries(r.levels).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  if (r.latest.level !== 'unavailable') sections.push({ id: 'readiness', title: 'Readiness', text: `${r.latest.label} on ${r.latest.date}: ${r.latest.text}.${counted && !night ? ` Over the window: ${counted}.` : ''}${r.illness ? ` Early warning: ${r.illness}` : ''}${r.illness && h.resp && h.resp.vsBaseline >= 1.5 ? ` Breathing rate during sleep is also ${h.resp.vsBaseline} a minute above your usual.` : ''}` });
  if (r.illness) steps.unshift('Your body is showing early illness signs: take it easy today, hydrate, and skip hard training until resting HR settles.');
  else if (r.latest.level === 'rest' || r.latest.level === 'easy') steps.unshift(`Readiness says ${r.latest.label.toLowerCase()}: keep today's training light (technique, walking, mobility).`);

  /* logged by hand: present only when the person shares that group */
  const lg = s.logged;
  if (lg) {
    const said = [];
    if (lg.nutrition?.water) said.push(`Water: ${n(lg.nutrition.water.avgMlPerLoggedDay)} ml a day on the ${lg.nutrition.water.daysLogged} day${lg.nutrition.water.daysLogged === 1 ? '' : 's'} you logged it.`);
    if (lg.nutrition?.food) said.push(`Food: ${n(lg.nutrition.food.avgKcalPerLoggedDay)} kcal a day on the ${lg.nutrition.food.daysLogged} day${lg.nutrition.food.daysLogged === 1 ? '' : 's'} you logged it${lg.nutrition.food.avgProteinG ? `, about ${n(lg.nutrition.food.avgProteinG)} g protein` : ''}.`);
    if (lg.mood) said.push(`Mood: ${lg.mood.entries} entr${lg.mood.entries === 1 ? 'y' : 'ies'} (${lg.mood.feel.pleasant} pleasant, ${lg.mood.feel.neutral} neutral, ${lg.mood.feel.unpleasant} unpleasant)${lg.mood.mostLogged.length ? `; most often ${lg.mood.mostLogged.slice(0, 3).map((x) => x.name).join(', ')}` : ''}.`);
    if (lg.symptoms) said.push(`Symptoms logged on ${lg.symptoms.daysWithAny} day${lg.symptoms.daysWithAny === 1 ? '' : 's'}${lg.symptoms.mostLogged.length ? `: ${lg.symptoms.mostLogged.slice(0, 3).map((x) => `${x.name} (${x.times})`).join(', ')}` : ''}.`);
    if (lg.cycle?.periods.length) said.push(`Periods logged: ${lg.cycle.periods.map((p) => `${p.start} (${p.days} day${p.days === 1 ? '' : 's'})`).join(', ')}.`);
    if (lg.ecg) said.push(`ECG readings: ${lg.ecg.readings}${lg.ecg.rhythmNotices ? `; irregular rhythm notices: ${lg.ecg.rhythmNotices}` : ''}, as the watch recorded them.`);
    if (said.length) sections.push({ id: 'logged', title: 'Logged by you', text: said.join(' ') });
  }

  const headline = night
    ? (sl.lastNight ? `${hm(sl.lastNight.asleepMin)} asleep last night · ${r.latest.label.toLowerCase()}` : `${r.latest.label} · no sleep tracked last night`)
    : [sl.nights ? `${hm(sl.asleepAvgMin)} sleep` : (can('sleep') ? 'no sleep data' : null), a.stepsAvg !== null ? `${n(a.stepsAvg)} steps/day` : 'steps n/a', r.latest.level !== 'unavailable' ? r.latest.label.toLowerCase() : null].filter(Boolean).join(' · ');

  return { headline, sections, nextSteps: [...new Set(steps)].slice(0, 5), caveats };
}

/* ── the request to the model, and what it must send back ─────────── */

export const SECTION_IDS = ['sleep', 'heart', 'activity', 'weight', 'readiness'];

export function prompt(s, notes = '', { caps = null } = {}) {
  const lacks = caps ? Object.entries({ sleep: 'sleep', restingHr: 'resting heart rate', hrv: 'HRV', weight: 'weight' }).filter(([k]) => !caps[k]).map(([, v]) => v) : [];
  return [
    'You are writing a short, plain-language health summary for one person from their own health data (read from Google Health; the device may be a watch, a band or just a phone) and their notes about themselves.',
    ...(lacks.length ? [`Their device does not report: ${lacks.join(', ')}. Leave out a section that would have nothing in it, and do not advise them to buy a device.`] : []),
    'All numbers below were already computed exactly. Use them as given; do not invent numbers, and do not do new arithmetic beyond simple comparisons.',
    'Be specific and practical, warm but direct. Compare against their own baseline first, then against typical ranges when given. Say plainly when there is too little data to judge.',
    'This is not medical advice; do not diagnose. If something looks concerning (for example an illness early warning), suggest rest or seeing a doctor in ordinary words.',
    'Do not use any tools. Do not read or write files. Answer with ONE JSON object and nothing else (no markdown fences), exactly in this shape:',
    '{"headline": "one line, <= 90 characters", "sections": [{"id": "sleep", "title": "Sleep", "text": "2-4 sentences"}, {"id": "heart", ...}, {"id": "activity", ...}, {"id": "weight", ...}, {"id": "readiness", ...}], "nextSteps": ["3 to 5 concrete, doable actions for the coming days, tailored to the notes"], "caveats": ["data caveats worth knowing, 0-3 items"]}',
    'Do not use emoji.',
    '',
    `Window: ${s.label} (${s.from} to ${s.to}; complete days for steps: ${s.completeFrom} to ${s.completeTo}). Today is ${s.today}.`,
    '',
    'Their notes about themselves (written by them, may change):',
    String(notes || '(none)').slice(0, 2000),
    '',
    'The numbers (JSON):',
    JSON.stringify(s),
  ].join('\n');
}

/** The model's answer, checked. Returns null when it is not usable. */
export function parseAnswer(text) {
  if (!text) return null;
  const t = String(text).replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  if (!j || typeof j.headline !== 'string' || !Array.isArray(j.sections) || !Array.isArray(j.nextSteps)) return null;
  const clean = (v, max) => String(v ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const sections = j.sections
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({ id: SECTION_IDS.includes(x.id) ? x.id : clean(x.id || 'note', 20).toLowerCase(), title: clean(x.title || x.id, 40), text: clean(x.text, 1200) }))
    .slice(0, 8);
  const nextSteps = j.nextSteps.map((x) => clean(x, 300)).filter(Boolean).slice(0, 6);
  if (!sections.length || nextSteps.length < 2) return null;
  return {
    headline: clean(j.headline, 140),
    sections,
    nextSteps,
    caveats: (Array.isArray(j.caveats) ? j.caveats : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 4),
  };
}
