/* Best times next to other people's (GET /api/best-times?with=, /api/best-times/people).

   Fair both ways, as Compare is (social.js compare): somebody's times are shown only when
   they share their workouts with you, and only while you share yours with them. What is
   shown of them is the times and when they were run: never a workout's id or its title. */

import { lensOf } from './audience.js';
import { bestTimes } from './medals.js';
import { avatarUrl } from './friends.js';

export const SPORTS = ['run', 'ride', 'walk'];
const CACHE_MS = 120_000;
const cache = new Map();   // userId -> { at, sports }

/**
 * Somebody's best times, every sport (kept two minutes: a board reads everybody's). `noStrava`
 * (anybody but their owner sees them): without what Strava gave (its API agreement: a person's
 * Strava data is for them alone), from the watch's own record of each run.
 */
export function bestsOf(worldOf, userId, now = Date.now(), { noStrava = true } = {}) {
  const k = `${userId}:${noStrava ? 'pub' : 'own'}`;
  const c = cache.get(k);
  if (c && now - c.at < CACHE_MS) return c.sports;
  const w = worldOf(userId);
  const sports = w ? SPORTS.map((sp) => bestTimes(w, sp, { noStrava })).filter((x) => x.distances.length) : [];
  cache.set(k, { at: now, sports });
  return sports;
}
/** Forget somebody's (a workout of theirs came, went or changed). */
export const forgetBests = (userId) => { cache.delete(`${userId}:pub`); cache.delete(`${userId}:own`); };

const who = (p) => ({ username: p.username, displayName: p.displayName, accent: p.accent, avatar: avatarUrl(p) });

/** Why `b` cannot be compared with `a`, or '' when they can. */
export function shareWhy(app, a, b) {
  if (!a || !b || a.userId === b.userId) return 'none';
  const L = lensOf(app, a.userId);
  if (!L.knows(b)) return 'none';
  if (!L.sees(b, 'workouts')) return 'theirs';
  if (!lensOf(app, b.userId).sees(a, 'workouts')) return 'yours';
  return '';
}

/** Times only: no workout ids, no titles. */
function plain(sports) {
  return sports.map((s) => ({
    sport: s.sport,
    distances: s.distances.map((d) => ({
      m: d.m, label: d.label,
      efforts: d.efforts.map((e) => ({ at: e.at, timeS: e.timeS, whole: !!e.whole })),
      records: d.records.map((r) => ({ at: r.at, timeS: r.timeS, prevS: r.prevS, whole: !!r.whole })),
      best: d.best && { at: d.best.at, timeS: d.best.timeS, whole: !!d.best.whole },
    })),
  }));
}

/** Somebody's best times for the viewer to set beside their own, or why not. null: no such person. */
export function theirBests(app, worldOf, viewerId, username, now = Date.now()) {
  const a = app.profile(viewerId);
  const b = app.profileByName(String(username || ''));
  const why = shareWhy(app, a, b);
  if (why === 'none') return null;
  if (why) return { who: who(b), hidden: why, sports: [] };
  return { who: who(b), hidden: null, sports: plain(bestsOf(worldOf, b.userId, now)) };
}

/**
 * Everybody the viewer may compare with, and the viewer, with their best at each distance
 * of one sport: { sport, people: [{ username, displayName, accent, avatar, me, bests: { m: s } }] }.
 * People with no times in that sport are left out.
 */
export function bestsBoard(app, worldOf, viewerId, sport, now = Date.now()) {
  const a = app.profile(viewerId);
  if (!a) return { sport, people: [] };
  const people = [];
  const add = (p, me) => {
    const s = bestsOf(worldOf, p.userId, now, { noStrava: !me }).find((x) => x.sport === sport);
    if (!s) return;
    const bests = {};
    for (const d of s.distances) bests[d.m] = d.best.timeS;
    people.push({ ...who(p), me, bests });
  };
  add(a, true);
  for (const p of app.profiles()) if (p.userId !== a.userId && !shareWhy(app, a, p)) add(p, false);
  return { sport, people };
}
