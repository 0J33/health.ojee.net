/* ============================================================
   health.ojee.net — what the numbers mean.

   Everything here is rule-based and explainable on purpose: each
   verdict carries the facts it was made from, in words, so the page
   never says "easy day" without saying why.

   Baselines are personal and trailing: the mean of the previous 30
   days, never including the day being judged, and only once there are
   at least BASELINE_MIN days of it. Until then the page says it is
   still learning rather than judging against a handful of nights.
   ============================================================ */

import { addDays, daysBetween, stats, round, weekOf } from './util.js';

export const BASELINE_DAYS = 30;
export const BASELINE_MIN = 7;
export const MUSCLES = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'other'];

/** Trailing baseline of a metric for `date`: the BASELINE_DAYS before it. */
export function baseline(table, metric, date, days = BASELINE_DAYS) {
  const vals = [];
  for (let i = 1; i <= days; i += 1) {
    const v = table[addDays(date, -i)]?.[metric];
    if (Number.isFinite(v)) vals.push(v);
  }
  const s = stats(vals);
  return s.n >= BASELINE_MIN ? s : { n: s.n, mean: null, sd: null };
}

const sign = (x, p = 0) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(round(x, p))}`;
export const hm = (min) => (Number.isFinite(min) ? `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m` : '—');

/**
 * The morning verdict for one day.
 *
 * Points, summed:
 *   HRV vs baseline       <= -15%: -2   <= -7%: -1   >= +7%: +1
 *   resting HR vs base    >= +5:   -2   >= +3:  -1   <= -2:  +1
 *   last night asleep     < 6h:    -2   < 7h:   -1   >= 7h30: +1
 *   sleep temperature     >= +0.5 C above baseline: -1
 *
 *   <= -4 rest day · -3..-1 easy day · 0..1 normal day · >= 2 ready to push
 *
 * So the plan's own example, HRV -15% and resting HR +4 bpm (-3), is an easy
 * day; add a short night or a fever-warm one and it becomes a rest day.
 */
const USED_WORDS = { hrv: 'HRV', rhr: 'resting heart rate', sleep: 'sleep', temp: 'sleep temperature' };
const listWords = (w) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);

/**
 * Devices differ: a phone gives none of these, a watch without HRV gives two
 * of the three. `caps` (the person's capabilities, when known) lets the
 * verdict use what there is: with neither HRV nor resting HR on offer it is
 * judged on sleep alone, and with nothing at all it says so instead of
 * "learning" forever. Every verdict lists what it `used`.
 */
export function readinessFor(table, date, { caps = null } = {}) {
  const row = table[date] || {};
  const parts = [];
  let score = 0;
  let inputs = 0;

  const hrvB = baseline(table, 'hrv', date);
  if (Number.isFinite(row.hrv) && hrvB.mean) {
    inputs += 1;
    const pct = ((row.hrv - hrvB.mean) / hrvB.mean) * 100;
    const pts = pct <= -15 ? -2 : pct <= -7 ? -1 : pct >= 7 ? 1 : 0;
    score += pts;
    parts.push({ key: 'hrv', pts, value: row.hrv, base: hrvB.mean, delta: pct, text: `HRV ${sign(pct)}% vs baseline` });
  }
  const rhrB = baseline(table, 'rhr', date);
  if (Number.isFinite(row.rhr) && rhrB.mean) {
    inputs += 1;
    const d = row.rhr - rhrB.mean;
    const pts = d >= 5 ? -2 : d >= 3 ? -1 : d <= -2 ? 1 : 0;
    score += pts;
    parts.push({ key: 'rhr', pts, value: row.rhr, base: rhrB.mean, delta: d, text: `resting HR ${sign(d)} bpm` });
  }
  if (Number.isFinite(row.sleep_min)) {
    inputs += 1;
    const m = row.sleep_min;
    const pts = m < 360 ? -2 : m < 420 ? -1 : m >= 450 ? 1 : 0;
    score += pts;
    parts.push({ key: 'sleep', pts, value: m, text: `slept ${hm(m)}` });
  }
  if (Number.isFinite(row.temp_dev) && row.temp_dev >= 0.5) {
    score -= 1;
    parts.push({ key: 'temp', pts: -1, value: row.temp_dev, text: `sleep temp ${sign(row.temp_dev, 1)} °C` });
  }

  const used = parts.map((p) => p.key);
  const usedText = used.length ? `Based on ${listWords(used.map((k) => USED_WORDS[k]))}` : null;
  const noHeart = !!caps && !caps.hrv && !caps.restingHr;
  if (noHeart && !caps.sleep) {
    return {
      date, level: 'unavailable', label: 'No readiness', score: null, parts: [], used: [], usedText: null,
      text: 'Readiness needs sleep, HRV or resting heart rate, and your device reports none of them',
    };
  }
  if (noHeart && !inputs) {
    return {
      date, level: 'learning', label: 'Waiting for sleep', score: null, parts, used, usedText,
      text: 'Last night\'s sleep has not arrived yet',
    };
  }
  if (!noHeart && (!inputs || (!hrvB.mean && !rhrB.mean))) {
    return {
      date, level: 'learning', label: 'Learning your baseline', score: null, parts, used, usedText,
      text: `Learning your baseline — ${Math.max(hrvB.n, rhrB.n)} of ${BASELINE_MIN} days so far`,
    };
  }
  const level = score <= -4 ? 'rest' : score <= -1 ? 'easy' : score >= 2 ? 'push' : 'normal';
  const label = { rest: 'Rest day', easy: 'Easy day', normal: 'Normal day', push: 'Ready to push' }[level];
  // The sentence names what moved the verdict, biggest effect first; a day
  // where nothing moved it lists what was looked at.
  const said = parts.filter((p) => p.pts !== 0).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  const shown = (said.length ? said : parts).slice(0, 3).map((p) => p.text);
  return { date, level, label, score, parts, used, usedText, text: `${shown.join(', ')}: ${label.toLowerCase()}`.replace(/^./, (c) => c.toUpperCase()) };
}

/** Which day the morning verdict is about: today once today's recovery
    numbers have arrived, else the most recent day that has them. */
export function verdictDay(table, today, { caps = null } = {}) {
  // Without HRV or resting HR on the device, last night's sleep is the signal.
  const sleepOnly = !!caps && !caps.hrv && !caps.restingHr;
  for (let i = 0; i < 4; i += 1) {
    const d = addDays(today, -i);
    const r = table[d];
    if (r && (Number.isFinite(r.hrv) || Number.isFinite(r.rhr) || (sleepOnly && Number.isFinite(r.sleep_min)))) return d;
  }
  return today;
}

/**
 * Early warning. A resting heart rate that stays up is the classic tell a
 * day or so before feeling ill; so is a sleep temperature well above its own
 * baseline. Flags when:
 *   - resting HR >= baseline + 5 bpm on both of the last 2 days, or
 *   - sleep temperature >= +0.8 C over its baseline (or >= 2.5 SD of the
 *     person's own nightly spread, if the API gives it, and at least +0.5), or
 *   - resting HR >= +3 on both days AND sleep temperature >= +0.5 C.
 */
export function illness(table, date) {
  const reasons = [];
  const rhrUp = [0, 1].map((i) => {
    const d = addDays(date, -i);
    const v = table[d]?.rhr;
    const b = baseline(table, 'rhr', d).mean;
    return Number.isFinite(v) && b ? v - b : null;
  });
  const t = table[date]?.temp_dev ?? table[addDays(date, -1)]?.temp_dev;
  const tsd = table[date]?.temp_sd ?? table[addDays(date, -1)]?.temp_sd;
  if (rhrUp.every((d) => d !== null && d >= 5)) {
    reasons.push(`resting HR up ${sign(Math.min(...rhrUp))} bpm or more for 2 days`);
  }
  const tempHigh = Number.isFinite(t) && (t >= 0.8 || (Number.isFinite(tsd) && tsd > 0 && t >= 0.5 && t >= 2.5 * tsd));
  if (tempHigh) reasons.push(`sleep temperature ${sign(t, 1)} °C above baseline`);
  if (!reasons.length && rhrUp.every((d) => d !== null && d >= 3) && Number.isFinite(t) && t >= 0.5) {
    reasons.push(`resting HR ${sign(Math.min(...rhrUp))} bpm for 2 days with sleep temperature ${sign(t, 1)} °C`);
  }
  return {
    flag: reasons.length > 0,
    reasons,
    text: reasons.length ? `Possible illness coming on: ${reasons.join('; ')}. Take it easy and watch for symptoms.` : null,
  };
}

/** Consecutive days meeting a target, ending today if today already has,
    else ending yesterday (today is not over). */
export function streak(table, metric, target, today) {
  if (!(target > 0)) return 0;
  let d = (table[today]?.[metric] ?? 0) >= target ? today : addDays(today, -1);
  let n = 0;
  while ((table[d]?.[metric] ?? -1) >= target && n < 3650) { n += 1; d = addDays(d, -1); }
  return n;
}

/** Bedtime and wake time spread over the last nights' main sleeps, in
    minutes. Bedtimes are measured from noon so 23:30 and 00:30 are an hour
    apart, not twenty-three. */
export function consistency(nights) {
  const main = nights.filter((n) => n.main);
  if (main.length < 3) return null;
  const local = (t, off) => new Date(t + off * 1000);
  const bed = main.map((n) => { const d = local(n.startMs, n.startOff); return ((d.getUTCHours() * 60 + d.getUTCMinutes()) - 720 + 1440) % 1440; });
  const wake = main.map((n) => { const d = local(n.endMs, n.endOff); return d.getUTCHours() * 60 + d.getUTCMinutes(); });
  const b = stats(bed); const w = stats(wake); const a = stats(main.map((n) => n.asleepMin));
  const clock = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return {
    nights: main.length,
    bedtime: clock(b.mean + 720), bedtimeSd: round(b.sd),
    wake: clock(w.mean), wakeSd: round(w.sd),
    asleep: round(a.mean), asleepSd: round(a.sd),
  };
}

/** Weight as a 7-day trailing mean of each day's mean weigh-in. */
export function weightTrend(weights, from, to) {
  const byDay = {};
  for (const w of weights) {
    const d = new Date(w.t + (w.off || 0) * 1000).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(w.grams / 1000);
  }
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const win = [];
    for (let i = 0; i < 7; i += 1) { const v = byDay[addDays(d, -i)]; if (v) win.push(...v); }
    const day = byDay[d] ? stats(byDay[d]).mean : null;
    out.push({ date: d, kg: day !== null ? round(day, 2) : null, avg7: win.length ? round(stats(win).mean, 2) : null });
  }
  return out;
}

export { weekOf };

/**
 * Weekly training volume (kg x reps x sets) per muscle group, beside that
 * week's mean HRV and mean readiness score — the two things the plan wanted
 * on one chart: am I lifting more than I am recovering from?
 */
export function strengthWeeks(sets, table, today, weeks = 12, ws = 1) {
  const first = addDays(weekOf(today, ws), -7 * (weeks - 1));
  const out = [];
  for (let w = first; w <= today; w = addDays(w, 7)) {
    const vol = Object.fromEntries(MUSCLES.map((m) => [m, 0]));
    let nSets = 0;
    for (const s of sets) {
      if (s.date < w || s.date > addDays(w, 6)) continue;
      const m = MUSCLES.includes(s.muscle) ? s.muscle : 'other';
      vol[m] += s.kg * s.reps * (s.sets || 1);
      nSets += s.sets || 1;
    }
    const hrv = []; const score = [];
    for (let i = 0; i < 7; i += 1) {
      const d = addDays(w, i);
      if (d > today) break;
      if (Number.isFinite(table[d]?.hrv)) hrv.push(table[d].hrv);
      const r = readinessFor(table, d);
      if (Number.isFinite(r.score)) score.push(r.score);
    }
    out.push({
      week: w, volume: vol, total: Object.values(vol).reduce((a, b) => a + b, 0), sets: nSets,
      hrv: hrv.length ? round(stats(hrv).mean, 1) : null,
      readiness: score.length ? round(stats(score).mean, 2) : null,
    });
  }
  return out;
}

/**
 * Everything the pages draw, from the store, in one object.
 * @param {object} db     a Store
 * @param {object} o      { today, days, settings, caps, nights }
 *   nights: how many nights of sleep sessions to return (default 14)
 */
export function dashboard(db, { today, days = 90, settings = {}, caps = null, nights: nightCount = 14, stages = true }) {
  const from = addDays(today, -(days + BASELINE_DAYS));
  const table = db.dailyTable(from);
  const shownFrom = addDays(today, -(days - 1));

  const series = [];
  for (let d = shownFrom; d <= today; d = addDays(d, 1)) {
    const r = table[d] || {};
    const hb = baseline(table, 'hrv', d);
    const rb = baseline(table, 'rhr', d);
    series.push({
      date: d,
      steps: r.steps ?? null, distanceM: r.distance_m !== undefined ? Math.round(r.distance_m) : null,
      azm: r.azm ?? null, activeMin: r.active_min ?? null, kcal: r.kcal ?? null,
      rhr: r.rhr ?? null, rhrBase: rb.mean !== null ? round(rb.mean, 1) : null, rhrSd: rb.sd !== null ? round(rb.sd, 2) : null,
      hrv: r.hrv ?? null, hrvBase: hb.mean !== null ? round(hb.mean, 1) : null, hrvSd: hb.sd !== null ? round(hb.sd, 2) : null,
      spo2: r.spo2 ?? null, spo2Lo: r.spo2_lo ?? null, spo2Hi: r.spo2_hi ?? null,
      tempDev: r.temp_dev !== undefined ? round(r.temp_dev, 2) : null, tempSd: r.temp_sd ?? null,
      sleepMin: r.sleep_min ?? null, bodyFat: r.body_fat ?? null,
    });
  }

  const vday = verdictDay(table, today, { caps });
  const ready = readinessFor(table, vday, { caps });
  const ill = illness(table, vday);

  const sleepFrom = addDays(today, -(nightCount - 1));
  const nights = db.sleeps(addDays(today, -(Math.max(days, 30)))).filter((n) => n.date >= addDays(today, -(days - 1)));
  const recent = nights.filter((n) => n.date >= sleepFrom);
  const lastNight = [...nights].reverse().find((n) => n.main) || null;

  const stepTarget = settings.stepTarget || 8000;
  const azmTarget = settings.azmTarget || 22;
  const sleepTarget = settings.sleepTarget || 450;
  const tr = table[today] || {};

  const weights = db.weights(Date.parse(`${addDays(today, -(days + 7))}T00:00:00Z`));
  const wt = weightTrend(weights, shownFrom, today);
  const lastW = [...wt].reverse().find((x) => x.avg7 !== null);
  const monthAgo = wt.find((x) => x.date >= addDays(today, -30) && x.avg7 !== null);

  const exercises = db.exercises(addDays(today, -13));

  return {
    today,
    verdictDay: vday,
    stale: daysBetween(vday, today),
    readiness: ready,
    illness: ill,
    series,
    sleep: {
      nights: recent.map((n) => ({
        id: n.id, date: n.date, main: n.main, startMs: n.startMs, endMs: n.endMs, startOff: n.startOff, endOff: n.endOff,
        asleepMin: n.asleepMin, awakeMin: n.awakeMin, periodMin: n.periodMin, stages: stages ? n.stages : [], summary: n.summary,
      })),
      consistency: consistency(recent),
      lastNight: lastNight ? { date: lastNight.date, asleepMin: lastNight.asleepMin, periodMin: lastNight.periodMin, stages: lastNight.summary.stages, startMs: lastNight.startMs, endMs: lastNight.endMs, startOff: lastNight.startOff, endOff: lastNight.endOff } : null,
    },
    activity: {
      stepTarget, azmTarget, sleepTarget,
      streak: { steps: streak(table, 'steps', stepTarget, today), azm: streak(table, 'azm', azmTarget, today) },
      today: {
        steps: tr.steps ?? null, distanceM: tr.distance_m !== undefined ? Math.round(tr.distance_m) : null,
        azm: tr.azm ?? null, activeMin: tr.active_min ?? null,
        // Whichever the device has: zone minutes, else plain active minutes.
        activeMinutes: tr.azm ?? tr.active_min ?? null,
        kcal: tr.kcal ?? null,
      },
      exercises,
    },
    weight: {
      trend: wt,
      points: weights.filter((w) => w.t >= Date.parse(`${shownFrom}T00:00:00Z`)).map((w) => ({ t: w.t, kg: round(w.grams / 1000, 2), source: w.source })),
      latest: lastW ? { date: lastW.date, avg7: lastW.avg7 } : null,
      change30: lastW && monthAgo ? round(lastW.avg7 - monthAgo.avg7, 2) : null,
    },
    _table: table,
  };
}
