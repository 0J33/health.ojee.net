/* ============================================================
   health.ojee.net — rank and rating (docs/CHALLENGES.md, part 3).

   Each shared week (Friday 12:00 UTC to the next) earns a score from
   four things, each 400 points at its par (a strong week) and 800 at
   most, at twice it: the most a week can earn is 3,200, a par week 1,600.
   Twice par in all four is an athlete's week.

   Each kind of exercise has its own place, so no one activity fills
   them all (v182): walking is the steps, running the running, the gym
   and sports the gym. Active minutes is the one all of them share.

     Steps           70,000 (10,000 a day), the steps taken on runs left
                     out: walking, moving through the day.
     Active minutes  300: time with the heart up, as the device counts it.
     Running         25 km: run km. Rides (km a third) and swims (km four
                     times) count too, up to par: the top half is running.
     Gym & sports    4 h: gym sessions, sports, classes; runs, rides,
                     swims, walks and hikes left out.

   Fair to what is measured:
     - A day counts when it has steps. A week with fewer than four such
       days does not count (the rating stays); one with four to six is
       scaled up to seven, for the steps and active minutes.
     - A device that does not count active minutes (no number on most
       days that have steps) is given the steps' points for them, never
       past par: so a top rank still needs all four measured.
     - Workouts are not scaled: one can always be logged by hand.

   The rating follows the scores: after each week it moves 30% of the
   way from where it was to that week's score, at least a point (the
   first week sets it). Two weeks that count place a person.

   Read from the public daily table, so a kind kept from everybody
   counts as nothing (activity kept back: no week counts at all).
   ============================================================ */

import { sharedWeek } from './social.js';
import { addDays, daysBetween } from './core/util.js';

export const RATING_CATS = [
  { key: 'steps', label: 'Steps', par: 70_000, unit: 'steps', scaled: true, say: 'steps on runs left out' },
  { key: 'active', label: 'Active minutes', par: 300, unit: 'min', scaled: true, device: true },
  { key: 'endurance', label: 'Running', par: 25_000, unit: 'm', say: 'runs; rides ÷ 3 and swims × 4 count up to par' },
  { key: 'training', label: 'Gym & sports', par: 240, unit: 'min', say: 'gym, sports and classes; runs, rides, swims and walks left out' },
];
const COLS = ['steps', 'run_steps', 'active_min', 'run_m', 'ride_m', 'swim_m', 'fit_min'];
/** Rides and swims fill the running up to par, no further. */
const OTHER_UPTO = 25_000;
export const PAR_POINTS = 400;
const CAP = 2;
const ALPHA = 0.3;
const WEEKS = 16;
const PLACE_AFTER = 2;
export const MIN_DAYS = 4;       // days with steps for a week to count
const DEVICE_DAYS = 3;           // days with active minutes for the device to count them

// Closer together low down, further apart at the top: easy to move early, hard to reach the top.
export const RANK_TIERS = [
  { tier: 'bronze', label: 'Bronze', at: 0 },
  { tier: 'silver', label: 'Silver', at: 300 },
  { tier: 'gold', label: 'Gold', at: 600 },
  { tier: 'platinum', label: 'Platinum', at: 950 },
  { tier: 'diamond', label: 'Diamond', at: 1350 },
  { tier: 'master', label: 'Master', at: 1800 },
  { tier: 'grandmaster', label: 'Grandmaster', at: 2300 },
  { tier: 'legend', label: 'Legend', at: 2750 },
  // Every week at the cap: all four at twice par, 800 each.
  { tier: 'champion', label: 'Champion', at: 3200 },
];
const DIV = ['I', 'II', 'III'];   // climbing: I is where a tier starts, III its top

const pointsOf = (value, par) => Math.round(PAR_POINTS * Math.min(CAP, Math.max(0, value) / par));

/**
 * One week's numbers as points. `sums`: the week's totals (steps, run_steps,
 * active_min, run_m, ride_m, swim_m, fit_min); `days`: days with steps, `activeDays`:
 * those with active minutes too (7 and 7 when left out: a whole, measured week).
 */
export function scoreOf(sums, { days = 7, activeDays = days } = {}) {
  const k = days > 0 && days < 7 ? 7 / days : 1;
  const steps = Math.max(0, (sums.steps || 0) - (sums.run_steps || 0)) * k;
  const measured = activeDays >= Math.min(DEVICE_DAYS, days || DEVICE_DAYS) && activeDays > 0;
  const active = measured ? ((sums.active_min || 0) * 7) / Math.max(1, Math.min(7, activeDays)) : null;
  const endurance = (sums.run_m || 0) + Math.min(OTHER_UPTO, (sums.ride_m || 0) / 3 + (sums.swim_m || 0) * 4);
  const training = sums.fit_min || 0;
  const values = { steps, active, endurance, training };
  const cats = RATING_CATS.map((c) => {
    const v = values[c.key];
    const max = c.par * CAP;
    if (v === null) {
      // Not measured by the device: the steps' points, never past par.
      const pts = Math.min(PAR_POINTS, pointsOf(steps, RATING_CATS[0].par));
      return { key: c.key, label: c.label, unit: c.unit, par: c.par, max, value: null, points: pts, maxPoints: PAR_POINTS * CAP, over: 0, filled: true };
    }
    const value = Math.round(v);
    return { key: c.key, label: c.label, unit: c.unit, par: c.par, max, value, points: pointsOf(v, c.par), maxPoints: PAR_POINTS * CAP, over: Math.max(0, value - max), say: c.say || null, scaled: c.scaled && k > 1 ? days : null };
  });
  return { cats, score: cats.reduce((t, c) => t + c.points, 0), maxScore: PAR_POINTS * CAP * RATING_CATS.length, days };
}

/** A week's day rows as totals and the days measured. */
function weekOfRows(rows) {
  const sums = Object.fromEntries(COLS.map((c) => [c, 0]));
  let days = 0; let activeDays = 0;
  for (const r of rows) {
    for (const c of COLS) sums[c] += r[c] || 0;
    if (r.steps !== null && r.steps !== undefined) { days += 1; if (r.active_min !== null && r.active_min !== undefined) activeDays += 1; }
  }
  return { sums, days, activeDays };
}

/** The rank a rating gives: tier, division, and what the next step up needs. */
export function rankOf(rating) {
  if (!Number.isFinite(rating)) return null;
  let i = 0;
  for (let k = 0; k < RANK_TIERS.length; k += 1) if (rating >= RANK_TIERS[k].at) i = k;
  const t = RANK_TIERS[i];
  const up = RANK_TIERS[i + 1];
  if (!up) return { tier: t.tier, label: t.label, division: null, name: t.label, from: t.at, next: null };
  const span = (up.at - t.at) / 3;
  const d = Math.min(2, Math.floor((rating - t.at) / span));
  const nextAt = d < 2 ? Math.round(t.at + span * (d + 1)) : up.at;
  const nextName = d < 2 ? `${t.label} ${DIV[d + 1]}` : up.tier === 'champion' ? up.label : `${up.label} ${DIV[0]}`;
  // from: where this division starts, for the bar towards the next one.
  return { tier: t.tier, label: t.label, division: DIV[d], name: `${t.label} ${DIV[d]}`, from: Math.round(t.at + span * d), next: { name: nextName, at: nextAt, left: Math.max(1, nextAt - Math.round(rating)) } };
}

// At least a point towards the score, so weeks at the cap do reach 3,200 (rounding alone stops at 3,199).
const step = (rating, score) => {
  if (rating === null) return score;
  const to = Math.round(rating + ALPHA * (score - rating));
  return to === rating && score !== rating ? rating + Math.sign(score - rating) : to;
};

/** A person's rating: its history week by week, this week so far, and where this week is heading. */
export function ratingOf(app, userId, now = Date.now()) {
  const w = sharedWeek(now);
  const first = addDays(w.from, -7 * WEEKS);
  const rows = app.all(`SELECT date, ${COLS.join(', ')} FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?`, userId, first, w.to);
  const weeks = new Map();
  for (const r of rows) {
    const k = addDays(first, Math.floor(daysBetween(first, r.date) / 7) * 7);
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(r);
  }
  let rating = null;
  const history = [];
  let last = null; let short = 0; let overWeeks = 0;
  for (let k = first; k < w.from; k = addDays(k, 7)) {
    if (!weeks.has(k)) continue;
    const wk = weekOfRows(weeks.get(k));
    if (wk.days < MIN_DAYS) { if (wk.days > 0) short += 1; continue; }   // too few days to tell: the rating stays
    const sc = scoreOf(wk.sums, wk);
    if (sc.cats.some((c) => c.over > 0)) overWeeks += 1;
    const was = rating;
    rating = step(rating, sc.score);
    last = { week: k, ...sc };
    history.push({ week: k, score: sc.score, rating, delta: was === null ? null : rating - was, rank: history.length + 1 >= PLACE_AFTER ? rankOf(rating) : null });
  }
  const placed = history.length >= PLACE_AFTER;
  const cur = weekOfRows(weeks.get(w.from) || []);
  // So far: what is in; on pace: the days with steps scaled to the week.
  const sofar = scoreOf(cur.sums, { days: 7, activeDays: cur.activeDays >= Math.min(DEVICE_DAYS, cur.days) && cur.activeDays > 0 ? 7 : 0 });
  const paced = cur.days ? scoreOf(Object.fromEntries(COLS.map((c) => [c, ['steps', 'run_steps', 'active_min'].includes(c) ? cur.sums[c] : (cur.sums[c] * 7) / Math.max(1, Math.min(7, daysBetween(w.from, w.last) + 1))])), cur).score : 0;
  const projected = step(rating, paced);
  return {
    placed, weeksRated: history.length, weeksToPlace: Math.max(0, PLACE_AFTER - history.length),
    rating: placed ? rating : null, rank: placed ? rankOf(rating) : null,
    delta: placed ? history.at(-1)?.delta ?? null : null,
    best: placed ? Math.max(...history.map((h) => h.rating)) : null,
    history: history.slice(-16),
    // The last week that counted, thing by thing: what moved the rating most recently.
    last, short, overWeeks, minDays: MIN_DAYS,
    week: { from: w.from, to: w.to, resetAt: w.resetAt, days: cur.days, cats: sofar.cats, score: sofar.score, maxScore: sofar.maxScore, paced, projected: rating === null && !history.length ? null : projected, projectedRank: placed ? rankOf(projected) : null },
  };
}

/** The ladder, for the sheet that explains it. */
export const ladder = () => ({ tiers: RANK_TIERS, max: PAR_POINTS * CAP * RATING_CATS.length, minDays: MIN_DAYS, cats: RATING_CATS.map(({ key, label, par, unit, say }) => ({ key, label, par, unit, say: say || null })), parPoints: PAR_POINTS, cap: CAP, alpha: ALPHA, placeAfter: PLACE_AFTER });
