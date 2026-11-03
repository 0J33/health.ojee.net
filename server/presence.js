/* ============================================================
   health.ojee.net — who is here now, and who is working out.

   IN MEMORY, like live.js: nothing is written anywhere, and a
   restart forgets it (open tabs say it again within a minute).

   An open tab says "here" about every 45 s while it is in view
   (POST /api/presence), with the route it is recording, if any.
   The running workout is read from the person's own log when
   it starts, changes or ends, so it stays while the phone is
   locked between sets.

     online    a beat in the last ONLINE_MS
     activity  { kind: 'workout' | 'route', start, ... } until it
               ends, or ACT_MS after the last word of it

   Who may see it is the caller's business (app.js, through the
   viewer's lens and the person's `presence` setting).
   ============================================================ */

export const ONLINE_MS = 100_000;
export const ACT_MS = 3 * 3600_000;
const ROUTE_TYPES = /^[A-Za-z_]{1,32}$/;

export class Presence {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.people = new Map();   // userId -> { at, route, workout }
  }

  #entry(userId) {
    const id = String(userId);
    if (!this.people.has(id)) this.people.set(id, { at: 0, route: null, workout: null });
    return this.people.get(id);
  }

  /** A tab in view said "here", with the route it is recording (or null). */
  beat(userId, { route = null } = {}) {
    const e = this.#entry(userId);
    const t = this.now();
    e.at = t;
    e.route = cleanRoute(route, t);
    // The track so far, kept apart: only a preview asks for it (liveLine).
    e.line = e.route ? cleanLine(route.line) : null;
  }

  /** The route so far as [[lat, lng], ...], the first stretch left off (where it began is often home), or null. */
  line(userId) {
    const e = this.people.get(String(userId));
    if (!e?.route || !e.line || this.now() - e.at > ACT_MS) return null;
    return trimStart(e.line, TRIM_M);
  }

  /** The running workout, as the log has it now (null when none). */
  setWorkout(userId, w) {
    const e = this.#entry(userId);
    e.workout = w ? { ...w, seen: this.now() } : null;
  }

  /** Gone: signed out, or the account deleted. */
  forget(userId) { this.people.delete(String(userId)); }

  /** { online, at, activity } or null when nothing is going on. */
  get(userId) {
    const e = this.people.get(String(userId));
    if (!e) return null;
    const t = this.now();
    const online = t - e.at < ONLINE_MS;
    // A route is only what a tab in view keeps saying; a workout is what the log says.
    const route = e.route && t - e.at < ACT_MS ? e.route : null;
    const workout = e.workout && t - e.workout.seen < ACT_MS * 2 ? e.workout : null;
    const activity = route ? { kind: 'route', ...route } : workout ? { kind: 'workout', ...strip(workout, t) } : null;
    if (!online && !activity) return null;
    return { online, at: e.at || null, activity };
  }

  /** Drop what has gone quiet. */
  sweep() {
    const t = this.now();
    for (const [id, e] of this.people) {
      if (t - e.at > ACT_MS && (!e.workout || t - e.workout.seen > ACT_MS * 2)) this.people.delete(id);
    }
  }
}

/** Without the bookkeeping; resting worked out now, not when it was read. */
export const TRIM_M = 200;
const MAX_POINTS = 800;

/** [[lat, lng], ...] from a tab: numbers on the globe, at most MAX_POINTS, to 5 places. */
function cleanLine(line) {
  if (!Array.isArray(line)) return null;
  const out = [];
  for (const p of line.slice(-MAX_POINTS)) {
    const a = Number(p?.[0]); const b = Number(p?.[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) out.push([Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
  }
  return out.length > 1 ? out : null;
}

const R = 6_371_000;
const metres = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
/** The line from `m` metres in; null until it is longer than that. */
export function trimStart(line, m) {
  let d = 0;
  for (let i = 1; i < line.length; i += 1) {
    d += metres(line[i - 1], line[i]);
    if (d >= m) { const rest = line.slice(i); return rest.length > 1 ? rest : null; }
  }
  return null;
}

const strip = ({ seen: _s, restUntil, ...w }, t = Date.now()) => ({ ...w, resting: !!(restUntil && restUntil > t) });

function cleanRoute(r, t) {
  if (!r || typeof r !== 'object') return null;
  const start = Number(r.start);
  if (!Number.isFinite(start) || start > t + 60_000 || t - start > 24 * 3600_000) return null;
  const m = Number(r.m);
  return {
    type: typeof r.type === 'string' && ROUTE_TYPES.test(r.type) ? r.type : 'walk',
    start,
    m: Number.isFinite(m) && m >= 0 && m < 1e6 ? Math.round(m) : null,
    paused: r.paused === true,
    ms: Number.isFinite(Number(r.ms)) && Number(r.ms) >= 0 ? Math.min(Number(r.ms), 24 * 3600_000) : null,
  };
}

/**
 * A running workout as others see it: what it is and, logged set by set,
 * where they are in it. `r` is the log's record (core/workouts.js).
 */
export function workoutNow(r, { titleFor = () => 'Workout' } = {}) {
  if (!r) return null;
  const ex = r.draft?.exercises || [];
  let doing = null;
  // Only somebody who ticks sets off says where they are: without a tick, the first exercise is a guess.
  if (ex.some((x) => x.done || x.sets?.some((s) => s.done))) {
    const isDone = (x) => x.done || (x.sets?.length && x.sets.every((s) => s.done));
    const cur = ex.find((x) => !isDone(x) && x.sets?.some((s) => s.done)) || ex.find((x) => !isDone(x)) || ex[ex.length - 1];
    const sets = cur.sets || [];
    const done = sets.filter((s) => s.done).length;
    doing = { name: String(cur.name || 'Exercise').slice(0, 60), set: Math.min(done + 1, sets.length || 1), of: sets.length || null };
  }
  const sets = ex.reduce((a, x) => a + (x.sets || []).filter((s) => s.done).length, 0);
  const ticks = sets > 0 || ex.some((x) => x.done);
  // The plan, for a preview: each exercise, its sets, and how many are ticked off (when they tick).
  const list = ex.slice(0, 20).map((x) => ({ name: String(x.name || 'Exercise').slice(0, 60), of: (x.sets || []).length, done: ticks ? (x.done ? (x.sets || []).length : (x.sets || []).filter((s) => s.done).length) : null }));
  return {
    start: r.start,
    title: String(r.title || r.draft?.routineTitle || titleFor(r.type)).slice(0, 80),
    type: r.type || null,
    doing,
    exercises: ex.length || null,
    list: list.length ? list : null,
    sets: ex.length ? sets : null,
    restUntil: Number.isFinite(r.draft?.restUntil) ? r.draft.restUntil : null,
  };
}
