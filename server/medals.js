/* ============================================================
   health.ojee.net — medals and achievements.

   Medals (web/js/medalcore.js has the rules) are worked out from a
   person's own store in one pass over everything they have done:
     strength  each exercise of each workout against that exercise's
               earlier sessions; and each workout's total volume
     cardio    each run, ride and walk (with a distance) against the
               earlier ones of the same sport: distance, moving time
               and, where there is a GPS track, the fastest 1 km, 5 km…
   Achievements are long-run tallies with four levels each (bronze,
   silver, gold, platinum): workouts, weekly streak, weight lifted,
   distance per sport, step-goal streak, gold medals.

   Read only from the person's own store. What others may see (a
   post's medals, a profile's achievement levels, the medals board)
   is copied into the public tables by social.js, as everything else.
   ============================================================ */

import { strengthPerf, digest, medalsOf, tally, KINDS } from '../web/js/medalcore.js';
import { unified, sportOf, sessionType, sessionDistance, mirrorId } from './history.js';
import { trackStats, routeType, ROUTE_TYPES } from './tracks.js';
import { addDays, today as todayIn, weekOf } from './core/util.js';

const SPORT_TYPE = { run: 'RUNNING', ride: 'BIKING', walk: 'WALKING' };
/** The fastest stretches each sport has a medal for (metres): those tracks.js measures. */
const EFFORTS = { run: [1000, 5000, 10000, 21097, 42195], ride: [10000, 20000, 40000, 100000], walk: [5000] };
const EFF_VERSION = 1;

/** A session's id as GET /api/workouts/:id knows it. */
export const sessionId = (s) => (s.local ? String(s.local.id) : mirrorId(s.ex.id));

/** Fastest stretches of a session's GPS track, kept once worked out (meta eff:<id>). */
function effortsOf(db, s, sport) {
  const id = sessionId(s);
  const key = `eff:${id}`;
  const kept = db.meta(key, null);
  if (kept && kept.v === EFF_VERSION) return kept.e;
  let pts = null; let pauses = [];
  if (s.local) { const t = db.trackGet(s.local.id); pts = t?.points; pauses = t?.pauses || []; } else pts = db.meta(`route:${id}`, null)?.points;
  // No track (yet): nothing kept, so a route read later still counts.
  if (!Array.isArray(pts) || pts.length < 3) return {};
  const e = {};
  try {
    const st = trackStats({ type: SPORT_TYPE[sport], points: pts, pauses, start: s.start, end: s.end, distanceM: sessionDistance(s) });
    for (const x of st.efforts) if (EFFORTS[sport].includes(x.distanceM)) e[x.distanceM] = x.timeS;
  } catch { /* a broken track: no efforts */ }
  db.setMeta(key, { v: EFF_VERSION, e });
  return e;
}

/** Moving time of a session in seconds, as the post and the page show it. */
const movingOf = (s) => {
  const r = s.local;
  const v = r ? r.route?.movingS ?? r.movingS ?? r.strava?.movingS : s.ex.activeSec;
  return Number.isFinite(v) && v > 0 ? v : Math.round((s.end - s.start) / 1000);
};

/** Every working set of every finished workout here, grouped: Map(workoutId -> [{ name, sets }]). */
function setsByWorkout(db) {
  const out = new Map();
  for (const r of db.workoutSetsFull(0)) {
    const id = String(r.workoutId);
    let w = out.get(id);
    if (!w) { w = { t: r.t, ex: new Map() }; out.set(id, w); }
    const key = String(r.exercise).toLowerCase();
    let x = w.ex.get(key);
    if (!x) { x = { name: r.exercise, sets: [] }; w.ex.set(key, x); }
    x.sets.push(r);
  }
  return out;
}

/**
 * Every medal a person has earned, in one pass.
 * @returns {{ by: Map<sessionId, medal[]>, all: medal[] }}  each medal also has
 *   { at, sessionId, exercise?, sport?, effortM? }
 */
export function medalIndex(world, { uni = null } = {}) {
  const db = world.db;
  const sessions = (uni || unified(db, 0)).slice().sort((a, b) => a.start - b.start);
  const by = new Map();
  const add = (id, at, list) => {
    if (!list.length) return;
    const arr = by.get(id) || [];
    for (const m of list) arr.push({ ...m, at, sessionId: id });
    by.set(id, arr);
  };

  // Strength: each exercise against its own earlier sessions; each workout's total.
  const sw = setsByWorkout(db);
  const exPrior = new Map(); const totPrior = [];
  for (const [id, w] of [...sw.entries()].sort((a, b) => a[1].t - b[1].t)) {
    const won = [];
    let total = 0;
    for (const [key, x] of w.ex) {
      const p = strengthPerf(x.sets);
      const prior = exPrior.get(key) || [];
      for (const m of medalsOf(p, digest(prior, w.t))) won.push({ ...m, exercise: x.name });
      prior.push({ t: w.t, p }); exPrior.set(key, prior);
      total += p.volume || 0;
    }
    if (total > 0) {
      const p = { session_volume: Math.round(total) };
      for (const m of medalsOf(p, digest(totPrior, w.t))) won.push(m);
      totPrior.push({ t: w.t, p });
    }
    add(id, w.t, won);
  }

  // Cardio: each sport against its own earlier sessions.
  const cPrior = { run: [], ride: [], walk: [] };
  for (const s of sessions) {
    const sport = sportOf(sessionType(s));
    const dist = sessionDistance(s);
    if (!cPrior[sport] || !dist) continue;
    const p = { distance: Math.round(dist), duration: Math.round(movingOf(s)) };
    for (const [m, sec] of Object.entries(effortsOf(db, s, sport))) p[`effort:${m}`] = sec;
    const won = medalsOf(p, digest(cPrior[sport], s.start)).map((m) => {
      const [kind, eff] = m.kind.split(':');
      return { ...m, kind, sport, ...(eff ? { effortM: Number(eff) } : {}) };
    });
    cPrior[sport].push({ t: s.start, p });
    add(sessionId(s), s.start, won);
  }

  const all = [...by.values()].flat().sort((a, b) => b.at - a.at);
  return { by, all };
}

/** One session's medals, best first. */
export function medalsFor(index, id) {
  return (index.by.get(String(id)) || []).slice();
}

/* ── achievements ────────────────────────────────────────────────── */

/** Each achievement: its levels (bronze, silver, gold, platinum) and what it counts. */
export const ACHIEVEMENTS = [
  { id: 'workouts', label: 'Workouts', unit: 'workouts', icon: 'strength', levels: [10, 50, 150, 365], say: 'Workouts done' },
  { id: 'week_streak', label: 'Every week', unit: 'weeks', icon: 'calendar', levels: [4, 12, 26, 52], say: 'Weeks in a row with a workout, at best' },
  { id: 'lifted', label: 'Lifted', unit: 'kg', icon: 'dumbbell', levels: [10_000, 100_000, 500_000, 1_000_000], say: 'Weight lifted in all' },
  { id: 'run_km', label: 'Runner', unit: 'm', icon: 'run', levels: [50_000, 250_000, 1_000_000, 2_500_000], say: 'Distance run' },
  { id: 'ride_km', label: 'Rider', unit: 'm', icon: 'bike', levels: [100_000, 500_000, 2_500_000, 10_000_000], say: 'Distance ridden' },
  { id: 'walk_km', label: 'Walker', unit: 'm', icon: 'walk', levels: [50_000, 250_000, 1_000_000, 2_500_000], say: 'Distance walked and hiked' },
  { id: 'step_streak', label: 'Step goal', unit: 'days', icon: 'steps', levels: [7, 30, 100, 365], say: 'Days in a row on your step goal, at best' },
  { id: 'golds', label: 'Record breaker', unit: 'medals', icon: 'record', levels: [5, 25, 100, 250], say: 'Gold medals' },
];
export const LEVELS = ['bronze', 'silver', 'gold', 'platinum'];

/** Longest run of true in a list. */
const longest = (flags) => { let best = 0; let cur = 0; for (const f of flags) { cur = f ? cur + 1 : 0; if (cur > best) best = cur; } return best; };

/** The tallies behind the achievements. */
function tallies(world, index, sessions, { tz, weekStart = 1, stepGoal = 8000, now = Date.now() } = {}) {
  const db = world.db;
  const today = todayIn(now, tz);
  const out = { workouts: sessions.length, lifted: 0, run_km: 0, ride_km: 0, walk_km: 0, golds: index.all.filter((m) => m.tier === 'gold').length };
  for (const r of db.workoutSetsFull(0)) if (r.type !== 'warmup' && r.kg > 0 && r.reps > 0) out.lifted += r.kg * r.reps;
  out.lifted = Math.round(out.lifted);
  const weeks = new Set();
  for (const s of sessions) {
    weeks.add(weekOf(todayIn(s.start, tz), weekStart));
    const sport = sportOf(sessionType(s)); const d = sessionDistance(s);
    if (d && out[`${sport}_km`] !== undefined) out[`${sport}_km`] += d;
  }
  for (const k of ['run_km', 'ride_km', 'walk_km']) out[k] = Math.round(out[k]);
  if (weeks.size) {
    const first = [...weeks].sort()[0]; const flags = [];
    for (let w = first; w <= weekOf(today, weekStart); w = addDays(w, 7)) flags.push(weeks.has(w));
    out.week_streak = longest(flags);
  } else out.week_streak = 0;
  const table = db.dailyTable('0000-00-00');
  const dates = Object.keys(table).sort();
  const flags = [];
  if (dates.length) for (let d = dates[0]; d <= today; d = addDays(d, 1)) flags.push((table[d]?.steps ?? 0) >= stepGoal);
  out.step_streak = longest(flags);
  return out;
}

/**
 * The achievements, with the level reached (0 = none yet), the next level and how
 * far along it is, and `fresh` when a level was reached since last seen (meta achSeen).
 */
export function achievements(world, index, { sessions = null, tz, weekStart, stepGoal, now } = {}) {
  const uni = sessions || unified(world.db, 0);
  const t = tallies(world, index, uni, { tz, weekStart, stepGoal, now });
  let seen = world.db.meta('achSeen', null);
  const list = ACHIEVEMENTS.map((a) => {
    const value = t[a.id] || 0;
    const level = a.levels.filter((x) => value >= x).length;
    const next = a.levels[level] ?? null;
    const from = level ? a.levels[level - 1] : 0;
    return {
      id: a.id, label: a.label, say: a.say, unit: a.unit, icon: a.icon, value, level,
      tier: level ? LEVELS[level - 1] : null, levels: a.levels,
      next, progress: next ? Math.max(0, Math.min(1, (value - from) / (next - from))) : 1,
    };
  });
  // The first time: what is already reached is not news.
  if (!seen) { seen = Object.fromEntries(list.map((a) => [a.id, a.level])); world.db.setMeta('achSeen', seen); }
  for (const a of list) a.fresh = a.level > (seen[a.id] || 0);
  return list;
}

/** The levels shown are now seen: no more "new". */
export function markSeen(world, list) {
  world.db.setMeta('achSeen', Object.fromEntries(list.map((a) => [a.id, a.level])));
}

/** For the logger: what each exercise must beat, as of `t` (medalcore digest per exercise). */
export function bestsFor(world, names, t) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  const prior = new Map();
  for (const w of setsByWorkout(world.db).values()) {
    if (w.t >= t) continue;
    for (const [key, x] of w.ex) {
      if (!want.has(key)) continue;
      const arr = prior.get(key) || [];
      arr.push({ t: w.t, p: strengthPerf(x.sets) });
      prior.set(key, arr);
    }
  }
  const out = {};
  for (const [key, arr] of prior) out[key] = digest(arr, t);
  return out;
}

export { tally, KINDS, ROUTE_TYPES, routeType };
