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
import { unified, sportOf, sessionType, sessionDistance, mirrorId, isGym } from './history.js';
import { trackStats, routeType, ROUTE_TYPES } from './tracks.js';
import { addDays, today as todayIn, weekOf, clockIn } from './core/util.js';

const SPORT_TYPE = { run: 'RUNNING', ride: 'BIKING', walk: 'WALKING' };
/** The fastest stretches each sport has a medal for (metres): those tracks.js measures. */
const EFFORTS = { run: [1000, 1609, 5000, 10000, 15000, 21097, 42195], ride: [10000, 20000, 40000, 100000], walk: [1000, 5000] };
const EFF_VERSION = 2;   // 2: the mile and 15 km for runs, 1 km for walks

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

/**
 * Each achievement: its levels (bronze, silver, gold, platinum), what it counts,
 * the group it is shown in, and `cat`, the kind of data it tells about (it is
 * shown to others only with that kind: audience.js).
 */
export const ACHIEVEMENTS = [
  // Training
  { id: 'workouts', group: 'Training', cat: 'workouts', label: 'Workouts', unit: 'workouts', icon: 'strength', levels: [10, 50, 150, 365], say: 'Workouts done' },
  { id: 'gym_hours', group: 'Training', cat: 'workouts', label: 'Gym regular', unit: 'hours', icon: 'dumbbell', levels: [10, 50, 200, 500], say: 'Hours of strength training' },
  { id: 'lifted', group: 'Training', cat: 'workouts', label: 'Lifted', unit: 'kg', icon: 'layers', levels: [10_000, 100_000, 500_000, 1_000_000], say: 'Weight lifted in all' },
  { id: 'sets', group: 'Training', cat: 'workouts', label: 'Set by set', unit: 'sets', icon: 'stacked_bar_chart', levels: [100, 1_000, 5_000, 15_000], say: 'Sets logged' },
  { id: 'exercises', group: 'Training', cat: 'workouts', label: 'Variety', unit: 'exercises', icon: 'apps', levels: [10, 25, 50, 100], say: 'Different exercises done' },
  { id: 'sports', group: 'Training', cat: 'workouts', label: 'All-rounder', unit: 'kinds', icon: 'sport', levels: [3, 5, 8, 12], say: 'Different kinds of workout' },
  { id: 'heaviest', group: 'Training', cat: 'workouts', label: 'Heavy lifter', unit: 'weight', icon: 'strength', levels: [60, 100, 140, 180], say: 'Heaviest single set' },
  // Moving
  { id: 'steps_total', group: 'Moving', cat: 'activity', label: 'Stepper', unit: 'steps', icon: 'steps', levels: [1_000_000, 5_000_000, 10_000_000, 25_000_000], say: 'Steps in all' },
  { id: 'best_day', group: 'Moving', cat: 'activity', label: 'Big day', unit: 'steps', icon: 'footprint', levels: [20_000, 30_000, 40_000, 50_000], say: 'Most steps in a day' },
  { id: 'goal_days', group: 'Moving', cat: 'activity', label: 'On target', unit: 'days', icon: 'target', levels: [50, 200, 500, 1_000], say: 'Days on your step goal' },
  { id: 'active_min', group: 'Moving', cat: 'activity', label: 'Heart pumping', unit: 'min', icon: 'bolt', levels: [1_000, 5_000, 20_000, 50_000], say: 'Active minutes in all' },
  { id: 'distance', group: 'Moving', cat: 'activity', label: 'Globetrotter', unit: 'm', icon: 'globe', levels: [100_000, 500_000, 2_000_000, 5_000_000], say: 'Distance covered on foot' },
  // Distance
  { id: 'run_km', group: 'Distance', cat: 'workouts', label: 'Runner', unit: 'm', icon: 'run', levels: [50_000, 250_000, 1_000_000, 2_500_000], say: 'Distance run' },
  { id: 'ride_km', group: 'Distance', cat: 'workouts', label: 'Rider', unit: 'm', icon: 'bike', levels: [100_000, 500_000, 2_500_000, 10_000_000], say: 'Distance ridden' },
  { id: 'walk_km', group: 'Distance', cat: 'workouts', label: 'Walker', unit: 'm', icon: 'walk', levels: [50_000, 250_000, 1_000_000, 2_500_000], say: 'Distance walked and hiked' },
  { id: 'long_run', group: 'Distance', cat: 'workouts', label: 'Long run', unit: 'm', icon: 'sprint', levels: [10_000, 21_097, 30_000, 42_195], say: 'Longest run' },
  { id: 'long_ride', group: 'Distance', cat: 'workouts', label: 'Long ride', unit: 'm', icon: 'bike', levels: [50_000, 100_000, 160_000, 200_000], say: 'Longest ride' },
  { id: 'long_walk', group: 'Distance', cat: 'workouts', label: 'Trekker', unit: 'm', icon: 'hike', levels: [15_000, 25_000, 40_000, 60_000], say: 'Longest walk or hike' },
  // Records
  { id: 'golds', group: 'Records', cat: 'workouts', label: 'Record breaker', unit: 'medals', icon: 'record', levels: [5, 25, 100, 250], say: 'Gold medals' },
  { id: 'medals', group: 'Records', cat: 'workouts', label: 'Collector', unit: 'medals', icon: 'medal', levels: [25, 100, 500, 1_000], say: 'Medals of every metal' },
  // Habits
  { id: 'week_streak', group: 'Habits', cat: 'workouts', label: 'Every week', unit: 'weeks', icon: 'calendar', levels: [4, 12, 26, 52], say: 'Weeks in a row with a workout, at best' },
  { id: 'step_streak', group: 'Habits', cat: 'activity', label: 'Step goal', unit: 'days', icon: 'streak', levels: [7, 30, 100, 365], say: 'Days in a row on your step goal, at best' },
  { id: 'early_bird', group: 'Habits', cat: 'workouts', label: 'Early bird', unit: 'workouts', icon: 'sun', levels: [5, 25, 100, 250], say: 'Workouts started before 7 in the morning' },
  { id: 'night_owl', group: 'Habits', cat: 'workouts', label: 'Night owl', unit: 'workouts', icon: 'moon', levels: [5, 25, 100, 250], say: 'Workouts started after 9 at night' },
  { id: 'weekender', group: 'Habits', cat: 'workouts', label: 'Weekender', unit: 'workouts', icon: 'today', levels: [10, 50, 150, 300], say: 'Workouts on a Saturday or a Sunday' },
  { id: 'sleeper', group: 'Habits', cat: 'sleep', label: 'Well rested', unit: 'nights', icon: 'bed', levels: [30, 100, 250, 500], say: 'Nights of 7 hours asleep or more' },
];
export const ACH_GROUPS = ['Training', 'Moving', 'Distance', 'Records', 'Habits'];
export const LEVELS = ['bronze', 'silver', 'gold', 'platinum'];

/** Longest run of true in a list. */
const longest = (flags) => { let best = 0; let cur = 0; for (const f of flags) { cur = f ? cur + 1 : 0; if (cur > best) best = cur; } return best; };

/** The tallies behind the achievements. */
function tallies(world, index, sessions, { tz, weekStart = 1, stepGoal = 8000, now = Date.now() } = {}) {
  const db = world.db;
  const today = todayIn(now, tz);
  const out = { workouts: sessions.length, lifted: 0, run_km: 0, ride_km: 0, walk_km: 0, golds: index.all.filter((m) => m.tier === 'gold').length };
  for (const r of db.workoutSetsFull(0)) if (r.type !== 'warmup' && r.kg > 0 && r.reps > 0) out.lifted += r.kg * r.reps * (r.n || 1);
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
  // Moving: every day there is.
  let steps = 0; let best = 0; let goalDays = 0; let act = 0; let dist = 0;
  for (const d of dates) {
    const r = table[d] || {};
    const st = r.steps ?? 0; steps += st; if (st > best) best = st; if (st >= stepGoal) goalDays += 1;
    act += r.azm ?? r.active_min ?? 0; dist += r.distance_m ?? 0;
  }
  Object.assign(out, { steps_total: Math.round(steps), best_day: Math.round(best), goal_days: goalDays, active_min: Math.round(act), distance: Math.round(dist) });
  // Training: gym time, sets, exercises, kinds of workout, the heaviest set; when and which day.
  let gymMin = 0; let early = 0; let night = 0; let weekend = 0;
  const kinds = new Set();
  const longestOf = { run: 0, ride: 0, walk: 0 };
  for (const s of sessions) {
    const type = sessionType(s);
    if (type) kinds.add(type);
    if (isGym(s)) gymMin += (s.end - s.start) / 60_000;
    const hh = Number(clockIn(s.start, tz).slice(0, 2));
    if (hh < 7) early += 1; else if (hh >= 21) night += 1;
    // The weekend is the last two days of the person's own week (Saturday and Sunday for a week from Monday).
    const dow = new Date(`${todayIn(s.start, tz)}T12:00:00Z`).getUTCDay();
    if (weekendOf(weekStart).includes(dow)) weekend += 1;
    const sport = sportOf(type); const d = sessionDistance(s);
    if (sport && d && d > longestOf[sport]) longestOf[sport] = d;
  }
  let sets = 0; let heaviest = 0; const exs = new Set();
  for (const r of db.workoutSetsFull(0)) {
    if (r.type === 'warmup') continue;
    sets += 1; if (r.exercise) exs.add(String(r.exercise).toLowerCase());
    if (r.kg > heaviest && r.reps > 0) heaviest = r.kg;
  }
  Object.assign(out, {
    gym_hours: Math.floor(gymMin / 60), sets, exercises: exs.size, sports: kinds.size, heaviest: Math.round(heaviest),
    early_bird: early, night_owl: night, weekender: weekend,
    long_run: Math.round(longestOf.run), long_ride: Math.round(longestOf.ride), long_walk: Math.round(longestOf.walk),
    medals: index.all.length,
  });
  // Habits: nights of seven hours or more.
  let nights = 0;
  try { const seen = new Set(); for (const n of db.sleeps('0000-00-00')) { if (!n.main || seen.has(n.date)) continue; seen.add(n.date); if ((n.asleepMin || 0) >= 420) nights += 1; } } catch { nights = 0; }
  out.sleeper = nights;
  return out;
}

/**
 * The achievements, with the level reached (0 = none yet), the next level and how
 * far along it is, and `fresh` when a level was reached since last seen (meta achSeen).
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The two weekend days (0 = Sunday) of a week that starts on `weekStart`: the two before it. */
export const weekendOf = (weekStart = 1) => { const w = Number.isInteger(weekStart) ? weekStart : 1; return [(w + 5) % 7, (w + 6) % 7]; };
const sayOf = (a, weekStart) => (a.id === 'weekender' ? `Workouts on a ${weekendOf(weekStart).map((d) => DAY_NAMES[d]).join(' or a ')}` : a.say);

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
      id: a.id, group: a.group, cat: a.cat, label: a.label, say: sayOf(a, weekStart), unit: a.unit, icon: a.icon, value, level,
      tier: level ? LEVELS[level - 1] : null, levels: a.levels,
      next, progress: next ? Math.max(0, Math.min(1, (value - from) / (next - from))) : 1,
    };
  });
  // The first time: what is already reached is not news.
  if (!seen) { seen = Object.fromEntries(list.map((a) => [a.id, a.level])); world.db.setMeta('achSeen', seen); }
  // An achievement added since (v150): what it has already reached is not news either.
  const added = list.filter((a) => !(a.id in seen));
  if (added.length) { seen = { ...seen, ...Object.fromEntries(added.map((a) => [a.id, a.level])) }; world.db.setMeta('achSeen', seen); }
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

/* ── best times: each distance's fastest, and when each record fell ── */

export const EFFORT_LABELS = { 1000: '1 km', 1609: '1 mile', 5000: '5 km', 10000: '10 km', 15000: '15 km', 20000: '20 km', 40000: '40 km', 100000: '100 km', 21097: 'Half marathon', 42195: 'Marathon' };
/** A session with no GPS track counts for a distance only when it was about that long: its whole time, scaled. */
const WHOLE_SLACK = 0.05;

/**
 * Every effort at each standard distance of one sport, oldest first, and
 * the records among them: the first time, then each one faster than all
 * before it. From the GPS track's fastest stretch (as the medals), or, with
 * no track, from a session within 5% of the distance (marked `whole`).
 * @returns {{ sport, distances: Array<{ m, label, efforts, records, best }> }}
 */
export function bestTimes(world, sport, { sessions = null } = {}) {
  const db = world.db;
  const list = EFFORTS[sport] || [];
  const by = new Map(list.map((m) => [m, []]));
  for (const s of sessions || unified(db, 0)) {
    if (sportOf(sessionType(s)) !== sport) continue;
    const dist = sessionDistance(s);
    if (!dist) continue;
    const eff = effortsOf(db, s, sport);
    const hasTrack = Object.keys(eff).length > 0;
    const title = s.local?.title || s.ex?.name || null;
    for (const m of list) {
      let t = eff[m];
      let whole = false;
      if (!Number.isFinite(t) && !hasTrack && dist >= m && dist <= m * (1 + WHOLE_SLACK)) { t = Math.round(movingOf(s) * (m / dist)); whole = true; }
      if (Number.isFinite(t) && t > 0) by.get(m).push({ at: s.start, id: sessionId(s), timeS: Math.round(t), whole, title });
    }
  }
  const distances = [];
  for (const m of list) {
    const efforts = by.get(m).sort((a, b) => a.at - b.at);
    if (!efforts.length) continue;
    const records = [];
    for (const e of efforts) {
      const prev = records.at(-1);
      if (!prev || e.timeS < prev.timeS) records.push({ ...e, prevS: prev ? prev.timeS : null });
    }
    distances.push({ m, label: EFFORT_LABELS[m] || `${m / 1000} km`, efforts, records, best: records.at(-1) });
  }
  return { sport, distances };
}
