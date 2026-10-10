/* ============================================================
   health.ojee.net — the console-module link: two-way sync of
   workouts (and the module's free-standing strength sets) between
   this app and ojee's single-user health module.

   The module polls with a bearer key:
     POST /api/link/changes   its changes
     GET  /api/link/changes   ours, after a cursor

   The rules (docs/API.md has the record shapes):
     - a record has a stable `uid` and an `updatedAt`; the newer one
       wins, and the winner's `updatedAt` is stored as it is, so both
       sides settle on the same value;
     - a deletion is a tombstone, kept, so a late copy cannot bring
       the workout back;
     - the cursor is this person's `rev` counter (core/db.js). What
       the module itself sent is not sent back to it;
     - no double upload to Google: the side on which a workout became
       done uploads it and says `pending`; the other side waits. The
       data point's name is derived from the uid, so even a race can
       only produce one point.

   WHO ASKS. While the link is healthy this app is the one that
   detects workouts and sends the started?/ended? questions: every
   reply says `prompter: "web"`, and the module stops its own
   detection and mirrors these rows. It falls back to detecting by
   itself only after the link has failed for 30 minutes.
   ============================================================ */

import { sha256, newLinkKey, shortId } from './secrets.js';
import { MUSCLES, muscleOf } from './muscles.js';
import { EXERCISE_TYPES } from './core/workouts.js';

export const LINK_ACTIVE_MS = 10 * 60_000;
const STATUSES = new Set(['ongoing', 'running', 'review', 'done', 'dismissed', 'cancelled', 'discarded', 'superseded', 'merged']);
const SOURCES = new Set(['detected', 'manual', 'logged', 'hevy']);
const UID = /^[A-Za-z0-9_-]{8,64}$/;
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));

/* ── keys ─────────────────────────────────────────────────────────── */

export function listKeys(app, userId) {
  return app.all('SELECT * FROM link_key WHERE user_id = ? ORDER BY created_ms', String(userId))
    .map((r) => ({ id: r.id, label: r.label, last4: r.last4, createdAt: r.created_ms, lastSeenAt: r.last_seen_ms, moduleVersion: r.module_version }));
}
export function linkState(app, userId, now = Date.now()) {
  const keys = listKeys(app, userId);
  return { keys: keys.length, active: keys.some((k) => k.lastSeenAt && now - k.lastSeenAt < LINK_ACTIVE_MS), prompter: 'web' };
}
/** Make a key. The plain key is returned once and only its hash is kept. */
export function createKey(app, userId, label, now = Date.now()) {
  if (listKeys(app, userId).length >= 5) throw Object.assign(new Error('You already have 5 link keys. Remove one first.'), { status: 409 });
  const key = newLinkKey();
  const id = shortId('k');
  app.run('INSERT INTO link_key (id, user_id, hash, last4, label, created_ms) VALUES (?, ?, ?, ?, ?, ?)', id, String(userId), sha256(key), key.slice(-4), str(label, 40) || 'Console health module', now);
  return { id, key };
}
export function deleteKey(app, userId, id) { return app.run('DELETE FROM link_key WHERE id = ? AND user_id = ?', String(id), String(userId)).changes > 0; }

/** The key row a bearer token belongs to, or null. Looked up by hash, so
    the comparison is one indexed equality on a value an attacker cannot
    steer byte by byte. */
export function keyFor(app, bearer, now = Date.now()) {
  if (typeof bearer !== 'string' || !/^hlk_[A-Za-z0-9_-]{20,100}$/.test(bearer)) return null;
  const r = app.get('SELECT * FROM link_key WHERE hash = ?', sha256(bearer));
  if (!r) return null;
  app.run('UPDATE link_key SET last_seen_ms = ? WHERE id = ?', now, r.id);
  return { id: r.id, userId: r.user_id };
}

/* ── our changes, for the module ──────────────────────────────────── */

/** A workout row as a link record. */
export function workoutRecord(db, r) {
  if (r.status === 'deleted') {
    return { uid: r.uid, updatedAt: r.updated, deleted: true, google: r.google?.name ? { name: r.google.name, state: 'deleted' } : null };
  }
  const g = r.google;
  // What the other side needs to know about Google: is there a point, and
  // who is uploading. `remote` here means "you are" — sent back as pending
  // would be a lie, so it goes as null state with any name there is.
  let google = null;
  if (g) {
    const state = ['saved', 'foreign', 'local', 'deleted'].includes(g.state) ? g.state
      : ['pending', 'failed', 'needs_scope'].includes(g.state) ? 'pending' : null;
    if (state || g.name) google = { name: g.name || null, state };
  }
  return {
    uid: r.uid, updatedAt: r.updated, deleted: false,
    status: r.status, source: r.source, start: r.start, end: r.end ?? null, lastEnd: r.lastEnd ?? null,
    title: r.title ?? null, notes: r.notes ?? null, exerciseType: r.type ?? null,
    avgHr: r.avgHr ?? null, maxHr: r.maxHr ?? null, steps: r.steps ?? null, kcal: r.kcal ?? null, activeMin: r.activeMin ?? null, threshold: r.threshold ?? null,
    startEdited: !!r.startEdited, endEdited: !!r.endEdited, autoClosed: r.autoClosed || null,
    prompts: r.prompts || {},
    google,
    exercises: db.setsOf(r.id),
  };
}
const setRecord = (s) => (s.deleted ? { uid: s.uid, updatedAt: s.updated, deleted: true }
  : { uid: s.uid, updatedAt: s.updated, deleted: false, date: s.date, t: s.t, exercise: s.exercise, muscle: s.muscle, kg: s.kg, reps: s.reps, sets: s.sets, note: s.note });

export function changesSince(db, since, keyId, limit = 200) {
  const from = Math.max(0, Math.floor(Number(since)) || 0);
  // Both kinds share one counter, so one ordered walk covers them.
  const rows = [
    ...db.workoutsAfterRev(from, limit + 1).map((r) => ({ rev: r.rev, w: r })),
    ...db.setsAfterRev(from, limit + 1).map((s) => ({ rev: s.rev, s })),
  ].sort((a, b) => a.rev - b.rev);
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  const workouts = []; const sets = [];
  for (const x of page) {
    // What this very key sent us is not news to it.
    if (x.w) { if (x.w.linkFrom !== keyId) workouts.push(workoutRecord(db, x.w)); }
    else if (x.s.linkFrom !== keyId) sets.push(setRecord(x.s));
  }
  const cursor = page.length ? page[page.length - 1].rev : Math.max(from, more ? from : db.rev);
  return { cursor: String(cursor), workouts, sets, more };
}

/* ── the module's changes, applied here ───────────────────────────── */

function cleanExercises(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 60).map((e) => ({
    name: String(e?.name || 'Exercise').slice(0, 80),
    muscle: MUSCLES.includes(e?.muscle) ? e.muscle : muscleOf(e?.name),
    notes: str(e?.notes, 500), supersetId: str(e?.supersetId, 40),
    sets: (Array.isArray(e?.sets) ? e.sets : []).slice(0, 100).map((s, i) => ({
      index: Number.isFinite(Number(s?.index)) ? Number(s.index) : i,
      type: ['normal', 'warmup', 'dropset', 'failure'].includes(s?.type) ? s.type : 'normal',
      kg: numOrNull(s?.kg), reps: numOrNull(s?.reps) !== null ? Math.round(numOrNull(s.reps)) : null,
      distanceM: numOrNull(s?.distanceM), durationS: numOrNull(s?.durationS), rpe: numOrNull(s?.rpe),
    })),
  }));
}

function applyWorkout(db, rec, keyId) {
  if (!rec || !UID.test(String(rec.uid || ''))) return { result: 'invalid', error: 'uid must be 8-64 characters of A-Z a-z 0-9 _ -' };
  const updatedAt = Number(rec.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return { result: 'invalid', error: 'updatedAt is required (ms)' };
  const cur = db.workoutByUid(rec.uid);
  // Last write wins. A tie changes nothing, so two sides holding the same
  // record never ping-pong it.
  if (cur && updatedAt <= cur.updated) return { result: 'stale' };

  if (rec.deleted) {
    if (!cur) {
      // A tombstone for something never seen here is still kept: the
      // workout must not appear later from an older copy.
      const start = numOrNull(rec.start) ?? updatedAt;
      db.workoutAdd({ uid: rec.uid, status: 'deleted', source: 'manual', start, end: start, created: updatedAt, updated: updatedAt, prompts: {}, google: rec.google?.name ? { name: rec.google.name, state: 'deleted' } : null }, { from: keyId });
      return { result: 'applied' };
    }
    const name = rec.google?.name || cur.google?.name;
    // The sender already removed the point from Google; forget our mirror row.
    if (name) db.deleteExercise(name);
    cur.status = 'deleted';
    cur.google = name ? { name, state: 'deleted' } : cur.google;
    cur.updated = updatedAt;
    db.workoutPut(cur, { from: keyId });
    return { result: 'applied' };
  }

  const start = numOrNull(rec.start);
  if (start === null) return { result: 'invalid', error: 'start is required' };
  const status = String(rec.status || '');
  if (!STATUSES.has(status)) return { result: 'invalid', error: `status "${status.slice(0, 20)}" is not one of ${[...STATUSES].join(', ')}` };
  const end = numOrNull(rec.end);
  if (end !== null && end < start) return { result: 'invalid', error: 'end is before start' };
  if (status === 'done' && end === null) return { result: 'invalid', error: 'a done workout needs an end' };

  // Google: a name means the point exists (never upload). `pending` means
  // the SENDER uploads: here that is `remote`, which flush() leaves alone.
  const g = rec.google;
  let google = null;
  if (g && typeof g === 'object') {
    const name = typeof g.name === 'string' && /^users\/[^/]+\/dataTypes\/exercise\/dataPoints\/[^/]+$/.test(g.name) ? g.name : null;
    if (g.state === 'saved' && name) google = { state: 'saved', name, by: 'link' };
    else if (g.state === 'foreign') google = { state: 'foreign', name };
    else if (g.state === 'local') google = { state: 'local' };
    else if (g.state === 'deleted') google = { state: 'deleted', name };
    else google = { state: 'remote', ...(name ? { name } : {}) };
  } else if (status === 'done') google = { state: 'remote' };
  // Our own upload already landed: an older idea of the state does not undo it.
  if (cur?.google?.state === 'saved' && cur.google.name && (!google || google.state === 'remote')) google = cur.google;

  const next = {
    ...(cur || {}),
    uid: rec.uid, status, source: SOURCES.has(rec.source) ? rec.source : (cur?.source || 'manual'),
    start, end, lastEnd: numOrNull(rec.lastEnd),
    title: str(rec.title, 80), notes: str(rec.notes, 2000),
    type: EXERCISE_TYPES[rec.exerciseType] ? rec.exerciseType : (cur?.type ?? null),
    avgHr: numOrNull(rec.avgHr), maxHr: numOrNull(rec.maxHr), steps: numOrNull(rec.steps), kcal: numOrNull(rec.kcal),
    activeMin: numOrNull(rec.activeMin), threshold: numOrNull(rec.threshold),
    startEdited: !!rec.startEdited, endEdited: !!rec.endEdited, autoClosed: str(rec.autoClosed, 40),
    // Prompts are merged, never dropped: a question asked on either side has
    // been asked.
    prompts: { ...(cur?.prompts || {}), ...(rec.prompts && typeof rec.prompts === 'object' ? Object.fromEntries(Object.entries(rec.prompts).filter(([k]) => k === 'start' || k === 'end')) : {}) },
    google,
    updated: updatedAt,
  };
  if (cur) db.workoutPut(next, { from: keyId });
  else { next.created = updatedAt; next.id = db.workoutAdd(next, { from: keyId }); }
  // Present = the whole list, replacing ours; absent = ours stays.
  const ex = cleanExercises(rec.exercises);
  if (ex) db.putSets(next.id, ex);
  return { result: 'applied' };
}

function applySet(db, rec, keyId) {
  if (!rec || !UID.test(String(rec.uid || ''))) return { result: 'invalid', error: 'uid must be 8-64 characters of A-Z a-z 0-9 _ -' };
  const updatedAt = Number(rec.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return { result: 'invalid', error: 'updatedAt is required (ms)' };
  const cur = db.setByUid(rec.uid);
  if (cur && updatedAt <= cur.updated) return { result: 'stale' };
  if (rec.deleted) {
    if (cur) db.putSet({ ...cur, deleted: true, updated: updatedAt }, { from: keyId });
    else db.addSet({ uid: rec.uid, date: '1970-01-01', t: 0, exercise: '-', muscle: 'other', kg: 0, reps: 0, sets: 1, deleted: true, updated: updatedAt }, { from: keyId });
    return { result: 'applied' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.date || ''))) return { result: 'invalid', error: 'date must be YYYY-MM-DD' };
  const exercise = str(rec.exercise, 60);
  if (!exercise) return { result: 'invalid', error: 'exercise is required' };
  const kg = numOrNull(rec.kg); const reps = numOrNull(rec.reps);
  if (kg === null || kg < 0 || kg > 1000 || reps === null || reps < 0 || reps > 500) return { result: 'invalid', error: 'kg must be 0-1000 and reps 0-500' };
  const s = {
    uid: rec.uid, date: rec.date, t: numOrNull(rec.t) ?? Date.parse(`${rec.date}T12:00:00Z`), exercise,
    muscle: MUSCLES.includes(rec.muscle) ? rec.muscle : muscleOf(exercise), kg, reps: Math.round(reps),
    sets: Math.min(50, Math.max(1, Math.round(numOrNull(rec.sets) ?? 1))), note: str(rec.note, 200), deleted: false, updated: updatedAt,
  };
  if (cur) db.putSet(s, { from: keyId }); else db.addSet(s, { from: keyId });
  return { result: 'applied' };
}

/** Apply a POST from the module. Each record stands or falls on its own. */
export function applyChanges(db, body, keyId) {
  const workouts = Array.isArray(body?.workouts) ? body.workouts : [];
  const sets = Array.isArray(body?.sets) ? body.sets : [];
  if (workouts.length + sets.length > 500) throw Object.assign(new Error('At most 500 records per request. Send the rest in the next one.'), { status: 413 });
  const results = [];
  db.tx(() => {
    for (const w of workouts) results.push({ uid: String(w?.uid ?? '').slice(0, 64), kind: 'workout', ...applyWorkout(db, w, keyId) });
    for (const s of sets) results.push({ uid: String(s?.uid ?? '').slice(0, 64), kind: 'set', ...applySet(db, s, keyId) });
  });
  return {
    applied: results.filter((r) => r.result === 'applied').length,
    ignored: results.filter((r) => r.result !== 'applied').length,
    results,
  };
}
