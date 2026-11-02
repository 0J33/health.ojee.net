/* ============================================================
   health.ojee.net — rank and rating (docs/CHALLENGES.md, part 3).

   Each shared week (Friday 12:00 UTC to the next) earns a score from
   four things: steps, active minutes, distance and training time. Each
   gives 400 points at its par (a strong week) and up to 800 at twice
   it, so the most a week can earn is 3,200 and a par week is 1,600.

   The rating follows the scores: after each week it moves 30% of the
   way from where it was to that week's score (the first week sets it).
   A big week lifts it, a quiet one lets it slip, and one week alone
   never decides it. Two weeks with numbers place a person.

   The rating gives the rank: Bronze, Silver, Gold, Platinum, Diamond
   (each in three divisions, I to III, one chevron more each) and Champion. Read from the
   public daily table, so a kind kept from everybody counts as nothing.
   ============================================================ */

import { sharedWeek } from './social.js';
import { addDays, daysBetween } from './core/util.js';

export const RATING_CATS = [
  { key: 'steps', label: 'Steps', col: 'steps', par: 70_000, unit: 'steps' },
  { key: 'active', label: 'Active minutes', col: 'active_min', par: 150, unit: 'min' },
  { key: 'distance', label: 'Distance', col: 'distance_m', par: 50_000, unit: 'm' },
  { key: 'training', label: 'Training', col: 'workout_min', par: 180, unit: 'min' },
];
export const PAR_POINTS = 400;
const CAP = 2;
const ALPHA = 0.3;
const WEEKS = 16;
const PLACE_AFTER = 2;

export const RANK_TIERS = [
  { tier: 'bronze', label: 'Bronze', at: 0 },
  { tier: 'silver', label: 'Silver', at: 500 },
  { tier: 'gold', label: 'Gold', at: 900 },
  { tier: 'platinum', label: 'Platinum', at: 1300 },
  { tier: 'diamond', label: 'Diamond', at: 1700 },
  { tier: 'champion', label: 'Champion', at: 2100 },
];
const DIV = ['I', 'II', 'III'];   // climbing: I is where a tier starts, III its top

/** One week's numbers as points: each thing, and the sum. */
export function scoreOf(sums) {
  const cats = RATING_CATS.map((c) => {
    const value = Math.round(sums[c.col] || 0);
    return { key: c.key, label: c.label, unit: c.unit, par: c.par, value, points: Math.round(PAR_POINTS * Math.min(CAP, value / c.par)) };
  });
  return { cats, score: cats.reduce((t, c) => t + c.points, 0) };
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

const step = (rating, score) => (rating === null ? score : Math.round(rating + ALPHA * (score - rating)));

/** A person's rating: its history week by week, this week so far, and where this week is heading. */
export function ratingOf(app, userId, now = Date.now()) {
  const w = sharedWeek(now);
  const first = addDays(w.from, -7 * WEEKS);
  const cols = RATING_CATS.map((c) => c.col);
  const rows = app.all(`SELECT date, ${cols.join(', ')} FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?`, userId, first, w.to);
  const weeks = new Map();
  for (const r of rows) {
    if (cols.every((c) => r[c] === null)) continue;
    const k = addDays(first, Math.floor(daysBetween(first, r.date) / 7) * 7);
    if (!weeks.has(k)) weeks.set(k, Object.fromEntries(cols.map((c) => [c, 0])));
    const s = weeks.get(k);
    for (const c of cols) s[c] += r[c] || 0;
  }
  let rating = null;
  const history = [];
  for (let k = first; k < w.from; k = addDays(k, 7)) {
    if (!weeks.has(k)) continue;
    const { score } = scoreOf(weeks.get(k));
    const was = rating;
    rating = step(rating, score);
    history.push({ week: k, score, rating, delta: was === null ? null : rating - was });
  }
  const placed = history.length >= PLACE_AFTER;
  const cur = scoreOf(weeks.get(w.from) || {});
  // On pace: this week's numbers so far, for the whole week.
  const daysIn = Math.min(7, Math.max(1, daysBetween(w.from, w.last) + 1));
  const paced = scoreOf(Object.fromEntries(cols.map((c) => [c, ((weeks.get(w.from) || {})[c] || 0) * (7 / daysIn)]))).score;
  const projected = step(rating, paced);
  return {
    placed, weeksRated: history.length, weeksToPlace: Math.max(0, PLACE_AFTER - history.length),
    rating: placed ? rating : null, rank: placed ? rankOf(rating) : null,
    delta: placed ? history.at(-1)?.delta ?? null : null,
    best: placed ? Math.max(...history.map((h) => h.rating)) : null,
    history: history.slice(-8),
    week: { from: w.from, to: w.to, resetAt: w.resetAt, cats: cur.cats, score: cur.score, paced, projected: rating === null && !history.length ? null : projected, projectedRank: placed ? rankOf(projected) : null },
  };
}

/** The ladder, for the sheet that explains it. */
export const ladder = () => ({ tiers: RANK_TIERS, cats: RATING_CATS.map(({ key, label, par, unit }) => ({ key, label, par, unit })), parPoints: PAR_POINTS, cap: CAP, alpha: ALPHA, placeAfter: PLACE_AFTER });
