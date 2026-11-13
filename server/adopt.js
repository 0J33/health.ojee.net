/* A workout the watch recorded and Google (or Garmin) holds, which rep. only shows (a "mirror",
   id g-…), made the person's own: a row here that names Google's session as its twin ('foreign',
   never uploaded again), with the watch's numbers, the routine linked to it and the route and
   heart rate already read. From then on the row stands for the session and Google's copy stays
   hidden (history.js unified), even if the row is deleted. Used when the person changes it
   (app.js) and when it goes to Hevy (hevysync.js pushCardio). */

import { mirrorId, sportOf } from './history.js';

const bad = (message, status) => Object.assign(new Error(message), { status, expose: true, code: status === 404 ? 'not_found' : 'conflict' });

/** The row that already stands for a mirror, if any (deleted ones too). */
export function rowForMirror(db, e) {
  const id = mirrorId(e.id);
  return db.workoutsSince(e.startMs - 86_400_000).find((r) => r.google?.name && mirrorId(r.google.name) === id) || null;
}

/** @returns the row (made now, or the one there already). Throws 404 when the mirror is gone or its row was deleted. */
export function adoptMirrorRow(db, id, { now = Date.now(), log = () => {} } = {}) {
  const e = db.exerciseByTail(String(id).slice(2)) || db.exercises('0000-00-00').find((x) => mirrorId(x.id) === id);
  if (!e) throw bad('No such workout.', 404);
  return adoptExercise(db, e, { now, log });
}

export function adoptExercise(db, e, { now = Date.now(), log = () => {} } = {}) {
  const id = mirrorId(e.id);
  const had = rowForMirror(db, e);
  if (had) {
    if (had.status === 'deleted') throw bad('No such workout.', 404);
    return had;
  }
  const generic = String(e.name || '') === 'Activity' && (e.type === 'CARDIO_WORKOUT' || e.type === 'WORKOUT');
  const rec = {
    status: 'done', source: String(e.id).startsWith('garmin-') ? 'garmin' : 'google',
    start: e.startMs, end: e.endMs, created: now, updated: now, confirmedAt: now,
    title: generic ? null : e.name || null, type: generic ? 'WORKOUT' : e.type || 'WORKOUT', notes: null, prompts: {},
    google: { state: 'foreign', name: e.id },
    // The key the feed knew the session by (feed.js writePosts), so its post, with its photos,
    // music, cheers and comments, stays the same post.
    uid: `g-${String(e.id).split('/').pop()}`,
  };
  if (e.avgHr != null) rec.avgHr = e.avgHr;
  if (e.steps != null) rec.steps = e.steps;
  if (e.kcal != null) rec.kcal = e.kcal;
  if (e.azm != null) rec.activeMin = e.azm;
  const routine = (db.meta('exRoutine', {}) || {})[id];
  if (routine) rec.routineId = routine;
  const route = db.meta(`route:${id}`);
  if (!(route?.points?.length >= 2) && e.distanceM > 0) rec.distanceM = e.distanceM;
  rec.id = db.workoutAdd(rec);
  if (route?.points?.length >= 2) {
    const sport = sportOf(e.type);
    const type = ['RUNNING', 'WALKING', 'BIKING', 'HIKING'].includes(e.type) ? e.type : sport === 'ride' ? 'BIKING' : sport === 'walk' ? 'WALKING' : 'RUNNING';
    db.trackPut(rec.id, { type, points: route.points, pauses: [], start: e.startMs, end: e.endMs, from: 'google' });
  }
  const trace = db.meta(`trace:${id}`);
  if (trace?.trace?.length) db.workoutCache(rec.id, { trace: trace.trace, traceTried: `${e.startMs}-${e.endMs}`, traceReason: trace.reason || null });
  log(`adopted ${id} as workout ${rec.id}`);
  return db.workoutGet(rec.id);
}
