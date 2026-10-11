/* ============================================================
   health.ojee.net — the numbers this app works out itself.

   Google Health has scores of its own under product names. This app
   reads none of them and imitates none of them. What is here is
   plain arithmetic over the person's own data, with every input
   named, so the page can always say "calculated by this app from
   ..." and show the parts:

     sleepScore   a night out of 100, from how long, which stages,
                  how much of the time in bed was sleep, and how close
                  bedtime and wake were to the person's own usual
     cardioWeek   minutes of heart-raising activity in a Monday week,
                  against a weekly target
     recovery     a 7-day trend of HRV and resting heart rate against
                  the person's own 30 days before. A trend of two
                  signals; it is not a stress score and is never
                  called one
     calories     total, active and resting energy for a day
     bmi          weight over height squared

   Pure functions: no store, no clock, no I/O. Nothing here may throw
   on missing data; a part that cannot be worked out is left out and
   the result says which parts it stands on.
   ============================================================ */

import { addDays, stats, round, weekOf } from './util.js';

const fin = Number.isFinite;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** 0 at `zero`, 1 at `full`, linear between (either direction). */
const ramp = (x, zero, full) => clamp01((x - zero) / (full - zero));
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const median = (vals) => {
  const v = vals.filter(fin).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
/** Two decimals, and never a negative zero. */
const z2 = (x) => { const v = round(x, 2); return v === 0 ? 0 : v; };
const hm = (min) => { const m = Math.round(Math.abs(min)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

/* ── sleep score ──────────────────────────────────────────────────── */

export const SLEEP_PARTS = { duration: 50, stages: 20, continuity: 15, regularity: 15 };
export const SLEEP_PART_LABELS = { duration: 'Duration', stages: 'Stages', continuity: 'Time awake', regularity: 'Regularity' };
const BASIS_WORD = { duration: 'duration', stages: 'stages', continuity: 'time awake', regularity: 'regularity' };
/** How many earlier nights, and over how many days, a "usual" needs. */
export const USUAL_NIGHTS = 5;
export const USUAL_DAYS = 14;

const localMin = (t, off) => { const d = new Date(t + (off || 0) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
/** Minutes after 18:00 local on the evening before, so 23:30 and 00:30
    are an hour apart. */
export const bedMin = (n) => (localMin(n.startMs, n.startOff) - 1080 + 1440) % 1440;
/** Minutes after local midnight. */
export const wakeMin = (n) => localMin(n.endMs, n.endOff);

/**
 * A person's usual bedtime and wake for one night: the medians over
 * their main nights in the USUAL_DAYS before it. Both null under
 * USUAL_NIGHTS of them.
 */
export function usualTimes(nights, night) {
  const from = addDays(night.date, -USUAL_DAYS);
  const before = (nights || []).filter((n) => n.main && n.date >= from && n.date < night.date && fin(n.startMs) && fin(n.endMs));
  if (before.length < USUAL_NIGHTS) return { usualBedMin: null, usualWakeMin: null, n: before.length };
  return { usualBedMin: median(before.map(bedMin)), usualWakeMin: median(before.map(wakeMin)), n: before.length };
}

/**
 * One night out of 100.
 * @param {object} night  a row of the sleep table: asleepMin, periodMin,
 *                        startMs/startOff, endMs/endOff, summary.stages
 * @param {object} o      goalMin (the person's sleep goal), usualBedMin,
 *                        usualWakeMin (see usualTimes; null = not known)
 * @returns {{ score: number|null, parts: Array<{id,label,points,max,text}>, basis: string|null }}
 *   Parts that cannot be worked out are left out and the score is the
 *   points earned over the points possible, times 100.
 */
export function sleepScore(night, { goalMin = 450, usualBedMin = null, usualWakeMin = null } = {}) {
  const parts = [];
  const asleep = night?.asleepMin;
  if (!night || !fin(asleep) || asleep <= 0) return { score: null, parts, basis: null };
  const goal = goalMin > 0 ? goalMin : 450;
  const part = (id, points, text) => parts.push({ id, label: SLEEP_PART_LABELS[id], points: round(points, 1), max: SLEEP_PARTS[id], text });

  // Duration: linear up to the goal. Well past it stops being better.
  let d = SLEEP_PARTS.duration * Math.min(1, asleep / goal);
  const over = asleep - (goal + 90);
  if (over > 0) d = Math.max(40, SLEEP_PARTS.duration - over / 10);
  part('duration', d, asleep >= goal ? `${hm(asleep)} asleep, at your goal of ${hm(goal)}` : `${hm(asleep)} asleep, ${hm(goal - asleep)} short of your goal of ${hm(goal)}`);

  // Stages: only for a night that has them.
  const s = night.summary?.stages;
  if (s && (s.DEEP > 0 || s.REM > 0)) {
    const deep = ((s.DEEP || 0) / asleep) * 100;
    const rem = ((s.REM || 0) / asleep) * 100;
    part('stages', 10 * ramp(deep, 5, 13) + 10 * ramp(rem, 8, 20), `${round(deep)}% deep and ${round(rem)}% REM of the time asleep`);
  }

  // Continuity: how much of the time in bed was sleep.
  if (fin(night.periodMin) && night.periodMin > 0) {
    const eff = Math.min(100, (asleep / night.periodMin) * 100);
    part('continuity', SLEEP_PARTS.continuity * ramp(eff, 75, 90), `Asleep for ${round(eff)}% of the ${hm(night.periodMin)} in bed`);
  }

  // Regularity: bedtime and wake against the person's own median.
  if (fin(usualBedMin) && fin(usualWakeMin) && fin(night.startMs) && fin(night.endMs)) {
    const bedOff = Math.abs(bedMin(night) - usualBedMin);
    const wakeOff = Math.abs(wakeMin(night) - usualWakeMin);
    const one = (off) => ramp(off, 120, 30);
    part('regularity', SLEEP_PARTS.regularity * ((one(bedOff) + one(wakeOff)) / 2), `Bedtime ${hm(bedOff)} and wake ${hm(wakeOff)} from your usual`);
  }

  const max = parts.reduce((a, p) => a + p.max, 0);
  const got = parts.reduce((a, p) => a + p.points, 0);
  return { score: Math.round((got / max) * 100), parts, basis: parts.map((p) => BASIS_WORD[p.id]).join(', ') };
}

/** The part that earned the smallest share of its points, or null. */
export function weakestPart(parts) {
  let worst = null;
  for (const p of parts || []) { const share = p.points / p.max; if (!worst || share < worst.share) worst = { id: p.id, label: p.label, share: round(share, 2) }; }
  return worst;
}

/* ── cardio minutes ───────────────────────────────────────────────── */

export const CARDIO_SOURCES = { azm: 'zone minutes', zones: 'time in heart-rate zones', active: 'active minutes' };

/**
 * One day's cardio minutes from a row of the daily table, by the first
 * source that exists:
 *   zone minutes               the device's own count (1 a minute in the
 *                              fat-burn zone, 2 a minute above it)
 *   time in heart-rate zones   moderate + 2 x (vigorous + peak)
 *   active minutes             moderate + vigorous, counted once
 * @returns {{ minutes, light, moderate, vigorous, source } | null}
 *   `light`, `moderate`, `vigorous` are the source's own numbers (null
 *   where it has none); `minutes` is what counts toward the week.
 */
export function cardioDay(r) {
  if (!r) return null;
  if (fin(r.azm)) {
    const hard = (fin(r.azm_cardio) ? r.azm_cardio : 0) + (fin(r.azm_peak) ? r.azm_peak : 0);
    return { minutes: round(r.azm), light: null, moderate: fin(r.azm_fat) ? round(r.azm_fat) : null, vigorous: fin(r.azm_cardio) || fin(r.azm_peak) ? round(hard) : null, source: 'azm' };
  }
  if ([r.zone_moderate, r.zone_vigorous, r.zone_peak].some(fin)) {
    const mod = fin(r.zone_moderate) ? r.zone_moderate : 0;
    const hard = (fin(r.zone_vigorous) ? r.zone_vigorous : 0) + (fin(r.zone_peak) ? r.zone_peak : 0);
    return { minutes: round(mod + 2 * hard), light: fin(r.zone_light) ? round(r.zone_light) : null, moderate: round(mod), vigorous: round(hard), source: 'zones' };
  }
  if (fin(r.active_min)) return { minutes: round(r.active_min), light: null, moderate: round(r.active_min), vigorous: null, source: 'active' };
  return null;
}

/**
 * A Monday week of cardio minutes against a target, and the eleven weeks
 * before it.
 * @returns {{ minutes, target, pct, days: Array, source: string|null, weeks: Array }}
 *   `days` is always seven (a day that has not come, or has nothing, has
 *   null minutes); `weeks` is twelve, oldest first, the last being this
 *   week; `source` names where most of the week's days came from.
 */
export function cardioWeek({ table = {}, weekStart = null, today, target = 150 }) {
  const start = weekStart || weekOf(today);
  const goal = target > 0 ? target : 150;
  const days = [];
  const seen = {};
  let minutes = 0; let any = false;
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(start, i);
    const c = date <= today ? cardioDay(table[date]) : null;
    if (c) { minutes += c.minutes; any = true; seen[c.source] = (seen[c.source] || 0) + 1; }
    days.push({ date, minutes: c ? c.minutes : null, light: c ? c.light : null, moderate: c ? c.moderate : null, vigorous: c ? c.vigorous : null });
  }
  const weeks = [];
  for (let k = 11; k >= 0; k -= 1) {
    const w = addDays(start, -7 * k);
    let m = 0; let has = false;
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(w, i);
      const c = date <= today ? cardioDay(table[date]) : null;
      if (c) { m += c.minutes; has = true; if (!any) seen[c.source] = (seen[c.source] || 0) + 1; }
    }
    weeks.push({ week: w, minutes: has ? m : null, target: goal, hit: has && m >= goal });
  }
  const top = Object.entries(seen).sort((a, b) => b[1] - a[1])[0];
  return {
    minutes: any ? minutes : null, target: goal, pct: any ? Math.round((minutes / goal) * 100) : null,
    days, source: top ? CARDIO_SOURCES[top[0]] : null, weeks,
  };
}

/* ── recovery trend ───────────────────────────────────────────────── */

export const RECOVERY_DAYS = 7;
export const RECOVERY_BASE_DAYS = 30;
export const RECOVERY_MIN_BASE = 14;
export const RECOVERY_MIN_DAYS = 3;
/** A spread smaller than this is treated as this: a week of identical
    readings must not turn one beat into a large deviation. */
const MIN_SD = { hrv: 2, rhr: 1 };
const SIGNALS = [{ id: 'hrv', key: 'hrv', dir: 1, name: 'HRV', unit: 'ms', p: 1 }, { id: 'rhr', key: 'rhr', dir: -1, name: 'resting heart rate', unit: 'bpm', p: 1 }];

/**
 * The last seven days of HRV and resting heart rate against the thirty
 * days before those seven. Each day's value becomes a deviation from the
 * person's own mean in units of their own spread, turned so that up is
 * better (higher HRV, lower resting heart rate); the two are averaged.
 * @returns {{ available, label, z, parts, days, text }}
 */
export function recovery({ table = {}, today }) {
  const first = addDays(today, -(RECOVERY_DAYS - 1));
  const parts = [];
  const perDay = {};
  for (const s of SIGNALS) {
    const base = [];
    for (let i = 1; i <= RECOVERY_BASE_DAYS; i += 1) { const v = table[addDays(first, -i)]?.[s.key]; if (fin(v)) base.push(v); }
    if (base.length < RECOVERY_MIN_BASE) continue;
    const b = stats(base);
    const sd = Math.max(b.sd || 0, MIN_SD[s.id]);
    const vals = [];
    for (let i = 0; i < RECOVERY_DAYS; i += 1) {
      const d = addDays(first, i);
      const v = table[d]?.[s.key];
      if (!fin(v)) continue;
      vals.push(v);
      (perDay[d] ||= []).push(s.dir * ((v - b.mean) / sd));
    }
    if (!vals.length) continue;
    const m = mean(vals);
    parts.push({ id: s.id, value: round(m, s.p), baseline: round(b.mean, s.p), z: z2(s.dir * ((m - b.mean) / sd)) });
  }
  const days = [];
  for (let i = 0; i < RECOVERY_DAYS; i += 1) { const d = addDays(first, i); days.push({ date: d, z: perDay[d] ? z2(mean(perDay[d])) : null }); }
  const have = days.filter((d) => d.z !== null);
  if (!parts.length || have.length < RECOVERY_MIN_DAYS) {
    return { available: false, label: null, z: null, parts: [], days, text: 'Not enough days yet: this needs two weeks of HRV or resting heart rate, and three of the last seven days.' };
  }
  const z = z2(mean(have.map((d) => d.z)));
  const label = z >= 0.5 ? 'above your usual' : z <= -0.5 ? 'below your usual' : 'near your usual';
  const said = parts.map((p) => { const s = SIGNALS.find((x) => x.id === p.id); return `${s.name} ${p.value} ${s.unit} against ${p.baseline}`; }).join(', ');
  return {
    available: true, label, z, parts, days,
    text: `Your recovery signals over the last 7 days are ${label}: ${said} over the 30 days before. A trend calculated by this app from ${parts.map((p) => SIGNALS.find((x) => x.id === p.id).name).join(' and ')}; it measures nothing else.`,
  };
}

/* ── calories, body mass index ────────────────────────────────────── */

/** A day's energy from a row of the daily table. Resting energy is the
    stored value, else total minus active (never below zero). */
export function caloriesDay(r) {
  if (!r || ![r.kcal, r.kcal_active, r.kcal_basal].some(fin)) return null;
  const total = fin(r.kcal) ? round(r.kcal) : null;
  const active = fin(r.kcal_active) ? round(r.kcal_active) : null;
  const basal = fin(r.kcal_basal) ? round(r.kcal_basal) : (total !== null && active !== null ? Math.max(0, total - active) : null);
  return { total, active, basal };
}

/** Seven days of energy ending on a date, oldest first. */
export function caloriesWeek(table, today) {
  const out = [];
  for (let i = 6; i >= 0; i -= 1) { const date = addDays(today, -i); const c = caloriesDay(table?.[date]); out.push({ date, total: c?.total ?? null, active: c?.active ?? null, basal: c?.basal ?? null }); }
  return out;
}

/** Body mass index: kilograms over metres squared. null without both. */
export function bmi(kg, heightMm) {
  if (!fin(kg) || !fin(heightMm) || kg <= 0 || heightMm <= 0) return null;
  const m = heightMm / 1000;
  return round(kg / (m * m), 1);
}
