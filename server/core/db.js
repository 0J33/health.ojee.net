/* ============================================================
   health.ojee.net — one person's store. SQLite through node:sqlite.

   One file per person (data/users/<id>/health.sqlite). Nothing in it
   is ever read on behalf of anybody else: leaderboards and profiles
   are built from the global app database, which this person's own
   sync writes to (see social.js).

   Shape follows how the data is read, not how Google sends it:

     daily     one number per (civil date, metric): steps, rhr, hrv,
               spo2, temperature, … the thing every trend is drawn from
     sleep     one row per sleep session, stages as JSON
     weight    one row per weigh-in (keyed by its instant, so a weight
               this app wrote and later reads back is the same row)
     exercise  one row per exercise session Google holds
     workout   detected / started / logged / imported workouts and what
               became of them (prompts sent, answers, the Google point)
     wset      the sets of a workout (Hevy import, or typed in)
     strength  free-standing sets: the console module's own strength
               log, which arrives through the link
     hevy_seen what has been imported, so a second import changes nothing
     meta      cursors, settings, the last device reading

   Workouts and free-standing sets carry a stable `uid` and a `rev`:
   a per-person counter bumped on every write, which is the cursor of
   the console-module link (link.js).
   ============================================================ */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS daily (
  date TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (date, metric)
);
CREATE TABLE IF NOT EXISTS sleep (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  start_off INTEGER NOT NULL DEFAULT 0, end_off INTEGER NOT NULL DEFAULT 0,
  main INTEGER NOT NULL DEFAULT 1, asleep_min REAL, awake_min REAL, period_min REAL,
  stages TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sleep_date ON sleep (date);
CREATE TABLE IF NOT EXISTS weight (
  t_ms INTEGER PRIMARY KEY, grams REAL NOT NULL, off INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'google', note TEXT
);
CREATE TABLE IF NOT EXISTS exercise (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  type TEXT, name TEXT, kcal REAL, azm REAL, avg_hr REAL, steps REAL, distance_m REAL
);
CREATE INDEX IF NOT EXISTS exercise_start ON exercise (start_ms);
CREATE TABLE IF NOT EXISTS strength (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, t_ms INTEGER NOT NULL,
  exercise TEXT NOT NULL, muscle TEXT NOT NULL, kg REAL NOT NULL, reps INTEGER NOT NULL,
  sets INTEGER NOT NULL DEFAULT 1, note TEXT,
  uid TEXT, updated_ms INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0, link_from TEXT
);
CREATE INDEX IF NOT EXISTS strength_date ON strength (date);
CREATE UNIQUE INDEX IF NOT EXISTS strength_uid ON strength (uid);
CREATE TABLE IF NOT EXISTS workout (
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, source TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  uid TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS workout_start ON workout (start_ms);
CREATE UNIQUE INDEX IF NOT EXISTS workout_uid ON workout (uid);
CREATE INDEX IF NOT EXISTS workout_rev ON workout (rev);
CREATE TABLE IF NOT EXISTS wset (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workout_id INTEGER NOT NULL,
  ex_idx INTEGER NOT NULL, set_idx INTEGER NOT NULL,
  exercise TEXT NOT NULL, muscle TEXT NOT NULL, notes TEXT, superset TEXT,
  type TEXT NOT NULL DEFAULT 'normal', kg REAL, reps INTEGER, distance_m REAL, duration_s REAL, rpe REAL
);
CREATE INDEX IF NOT EXISTS wset_workout ON wset (workout_id);
CREATE TABLE IF NOT EXISTS hevy_seen (key TEXT PRIMARY KEY, workout_id INTEGER, at_ms INTEGER NOT NULL);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return new Store(db);
}

const WCOLS = new Set(['id', 'status', 'source', 'start', 'end', 'created', 'updated', 'uid', 'rev', 'linkFrom']);

class Store {
  constructor(db) {
    this.db = db;
    this.closed = false;
    const p = (sql) => db.prepare(sql);
    this.q = {
      metaGet: p('SELECT value FROM meta WHERE key = ?'),
      metaSet: p('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      metaLike: p('SELECT key, value FROM meta WHERE key LIKE ?'),
      dailySet: p('INSERT INTO daily (date, metric, value) VALUES (?, ?, ?) ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value'),
      dailyFrom: p('SELECT date, metric, value FROM daily WHERE date >= ? ORDER BY date'),
      dailyLatest: p('SELECT date, value FROM daily WHERE metric = ? ORDER BY date DESC LIMIT 1'),
      dailyLast: p('SELECT metric, MAX(date) AS date FROM daily WHERE value > 0 GROUP BY metric'),
      dailyFirst: p('SELECT MIN(date) AS date FROM daily'),
      sleepSet: p(`INSERT INTO sleep (id, date, start_ms, end_ms, start_off, end_off, main, asleep_min, awake_min, period_min, stages, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET date = excluded.date, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
          start_off = excluded.start_off, end_off = excluded.end_off, main = excluded.main, asleep_min = excluded.asleep_min,
          awake_min = excluded.awake_min, period_min = excluded.period_min, stages = excluded.stages, summary = excluded.summary`),
      sleepFrom: p('SELECT * FROM sleep WHERE date >= ? ORDER BY start_ms'),
      sleepLast: p('SELECT MAX(date) AS date FROM sleep'),
      weightSet: p(`INSERT INTO weight (t_ms, grams, off, source, note) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(t_ms) DO UPDATE SET grams = excluded.grams, off = excluded.off, note = COALESCE(excluded.note, weight.note)`),
      weightFrom: p('SELECT * FROM weight WHERE t_ms >= ? ORDER BY t_ms'),
      weightLast: p('SELECT MAX(t_ms) AS t FROM weight'),
      exSet: p(`INSERT INTO exercise (id, date, start_ms, end_ms, type, name, kcal, azm, avg_hr, steps, distance_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET date = excluded.date, start_ms = excluded.start_ms, end_ms = excluded.end_ms, type = excluded.type,
          name = excluded.name, kcal = excluded.kcal, azm = excluded.azm, avg_hr = excluded.avg_hr, steps = excluded.steps, distance_m = excluded.distance_m`),
      exFrom: p('SELECT * FROM exercise WHERE date >= ? ORDER BY start_ms'),
      exLast: p('SELECT MAX(date) AS date FROM exercise'),
      exTail: p('SELECT * FROM exercise WHERE id = ? OR id LIKE ? LIMIT 1'),
      exDel: p('DELETE FROM exercise WHERE id = ? OR id LIKE ?'),
      setAdd: p('INSERT INTO strength (date, t_ms, exercise, muscle, kg, reps, sets, note, uid, updated_ms, deleted, rev, link_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      setPut: p('UPDATE strength SET date = ?, t_ms = ?, exercise = ?, muscle = ?, kg = ?, reps = ?, sets = ?, note = ?, updated_ms = ?, deleted = ?, rev = ?, link_from = ? WHERE uid = ?'),
      setByUid: p('SELECT * FROM strength WHERE uid = ?'),
      setsFrom: p('SELECT * FROM strength WHERE date >= ? AND deleted = 0 ORDER BY date, t_ms, id'),
      setsRev: p('SELECT * FROM strength WHERE rev > ? ORDER BY rev LIMIT ?'),
      setsCount: p('SELECT COUNT(*) AS n FROM strength WHERE deleted = 0'),
      wAdd: p('INSERT INTO workout (status, source, start_ms, end_ms, created_ms, updated_ms, uid, rev, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      wPut: p('UPDATE workout SET status = ?, source = ?, start_ms = ?, end_ms = ?, updated_ms = ?, rev = ?, data = ? WHERE id = ?'),
      wGet: p('SELECT * FROM workout WHERE id = ?'),
      wCache: p('UPDATE workout SET data = ? WHERE id = ?'),
      wUid: p('SELECT * FROM workout WHERE uid = ?'),
      wSince: p(`SELECT * FROM workout WHERE start_ms >= ? OR status IN ('ongoing', 'running', 'review') ORDER BY start_ms, id`),
      wRev: p('SELECT * FROM workout WHERE rev > ? ORDER BY rev LIMIT ?'),
      wFlush: p(`SELECT * FROM workout WHERE status = 'done' AND (
          json_extract(data, '$.google.state') IN ('pending', 'failed', 'needs_scope')
          OR json_extract(data, '$.google.dirty') = 1) ORDER BY start_ms DESC LIMIT ?`),
      wDone: p(`SELECT * FROM workout WHERE status = 'done' AND start_ms < ? ORDER BY start_ms DESC LIMIT ?`),
      wDoneFrom: p(`SELECT * FROM workout WHERE status = 'done' AND start_ms >= ? ORDER BY start_ms`),
      wsAdd: p('INSERT INTO wset (workout_id, ex_idx, set_idx, exercise, muscle, notes, superset, type, kg, reps, distance_m, duration_s, rpe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      wsDel: p('DELETE FROM wset WHERE workout_id = ?'),
      wsOf: p('SELECT * FROM wset WHERE workout_id = ? ORDER BY ex_idx, set_idx, id'),
      wsSum: p('SELECT workout_id, COUNT(*) AS sets, COUNT(DISTINCT ex_idx) AS exercises, SUM(COALESCE(kg, 0) * COALESCE(reps, 0)) AS volume FROM wset GROUP BY workout_id'),
      wsAll: p(`SELECT s.*, w.start_ms AS w_start FROM wset s JOIN workout w ON w.id = s.workout_id WHERE w.status = 'done' AND w.start_ms >= ? ORDER BY w.start_ms, s.ex_idx, s.set_idx`),
      hevyGet: p('SELECT * FROM hevy_seen WHERE key = ?'),
      hevySet: p('INSERT OR REPLACE INTO hevy_seen (key, workout_id, at_ms) VALUES (?, ?, ?)'),
    };
    this.rev = Number(this.meta('rev', 0)) || 0;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  meta(key, fallback = null) {
    const r = this.q.metaGet.get(key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch { return fallback; }
  }
  setMeta(key, value) { this.q.metaSet.run(key, JSON.stringify(value)); }
  /** { key: value } for every meta key starting with a prefix. */
  metaPrefix(prefix) {
    const out = {};
    for (const r of this.q.metaLike.all(`${prefix}%`)) { try { out[r.key] = JSON.parse(r.value); } catch { /* skip */ } }
    return out;
  }

  /** The link cursor: bumped on every write to a workout or a set. */
  nextRev() { this.rev += 1; this.setMeta('rev', this.rev); return this.rev; }

  setDaily(date, metric, value) {
    if (date && Number.isFinite(value)) this.q.dailySet.run(date, metric, value);
  }
  /** { 'YYYY-MM-DD': { metric: value } } from a date on. */
  dailyTable(from) {
    const out = {};
    for (const r of this.q.dailyFrom.all(from)) (out[r.date] ||= {})[r.metric] = r.value;
    return out;
  }
  latest(metric) { return this.q.dailyLatest.get(metric) || null; }
  /** { metric: last civil date it has a value for }. */
  lastDates() { return Object.fromEntries(this.q.dailyLast.all().map((r) => [r.metric, r.date])); }
  firstDate() { return this.q.dailyFirst.get()?.date || null; }

  upsertSleep(s) {
    this.q.sleepSet.run(s.id, s.date, s.startMs, s.endMs, s.startOff, s.endOff, s.main ? 1 : 0,
      s.asleepMin, s.awakeMin, s.periodMin, JSON.stringify(s.stages || []), JSON.stringify(s.summary || {}));
  }
  sleeps(from) {
    return this.q.sleepFrom.all(from).map((r) => ({
      id: r.id, date: r.date, startMs: r.start_ms, endMs: r.end_ms, startOff: r.start_off, endOff: r.end_off,
      main: !!r.main, asleepMin: r.asleep_min, awakeMin: r.awake_min, periodMin: r.period_min,
      stages: JSON.parse(r.stages), summary: JSON.parse(r.summary),
    }));
  }
  lastSleepDate() { return this.q.sleepLast.get()?.date || null; }

  upsertWeight(w) { this.q.weightSet.run(w.t, w.grams, w.off || 0, w.source || 'google', w.note ?? null); }
  weights(fromMs) { return this.q.weightFrom.all(fromMs).map((r) => ({ t: r.t_ms, grams: r.grams, off: r.off, source: r.source, note: r.note })); }
  lastWeightMs() { return this.q.weightLast.get()?.t || null; }

  #ex(r) {
    return r && { id: r.id, date: r.date, startMs: r.start_ms, endMs: r.end_ms, type: r.type, name: r.name, kcal: r.kcal, azm: r.azm, avgHr: r.avg_hr, steps: r.steps, distanceM: r.distance_m };
  }
  upsertExercise(e) {
    this.q.exSet.run(e.id, e.date, e.startMs, e.endMs, e.type ?? null, e.name ?? null, e.kcal ?? null, e.azm ?? null, e.avgHr ?? null, e.steps ?? null, e.distanceM ?? null);
  }
  exercises(from) { return this.q.exFrom.all(from).map((r) => this.#ex(r)); }
  lastExerciseDate() { return this.q.exLast.get()?.date || null; }
  /** One exercise by its full name or just the last path segment. */
  exerciseByTail(tail) { return this.#ex(this.q.exTail.get(tail, `%/${tail}`)) || null; }

  /** Forget one exercise row (a workout this app deleted from Google). */
  deleteExercise(id) { return this.q.exDel.run(id, `%/${String(id).split('/').pop()}`).changes; }

  /* Workouts: the columns that are queried, the rest as JSON. */
  #w(r) {
    if (!r) return null;
    let data = {};
    try { data = JSON.parse(r.data); } catch { /* keep {} */ }
    return { ...data, id: r.id, uid: r.uid, rev: r.rev, status: r.status, source: r.source, start: r.start_ms, end: r.end_ms ?? null, created: r.created_ms, updated: r.updated_ms };
  }
  #wData(w, from) {
    const data = {};
    for (const [k, v] of Object.entries(w)) if (!WCOLS.has(k)) data[k] = v;
    // Who wrote this revision: a link key id when it came from the console
    // module (so it is not echoed back to it), nothing for a change made here.
    if (from) data.linkFrom = from;
    return JSON.stringify(data);
  }
  workoutAdd(w, { from = null } = {}) {
    w.uid ||= randomUUID();
    w.rev = this.nextRev();
    const r = this.q.wAdd.run(w.status, w.source, w.start, w.end ?? null, w.created, w.updated ?? w.created, w.uid, w.rev, this.#wData(w, from));
    return Number(r.lastInsertRowid);
  }
  workoutPut(w, { from = null } = {}) {
    w.rev = this.nextRev();
    w.linkFrom = from || undefined;
    this.q.wPut.run(w.status, w.source, w.start, w.end ?? null, w.updated, w.rev, this.#wData(w, from), w.id);
  }
  workoutGet(id) { return this.#w(this.q.wGet.get(id)); }
  /** Keep derived data on a row (a cached chart) without it counting as a
      change: `updated` and the link cursor stay where they were. */
  workoutCache(id, patch) {
    const r = this.q.wGet.get(id);
    if (!r) return;
    let data = {};
    try { data = JSON.parse(r.data); } catch { /* keep {} */ }
    this.q.wCache.run(JSON.stringify({ ...data, ...patch }), id);
  }
  workoutByUid(uid) { return this.#w(this.q.wUid.get(uid)); }
  /** Every workout starting at or after a time, plus every open one. */
  workoutsSince(ms) { return this.q.wSince.all(ms).map((r) => this.#w(r)); }
  /** Workouts changed after a link cursor, oldest change first. */
  workoutsAfterRev(rev, limit = 200) { return this.q.wRev.all(rev, limit).map((r) => this.#w(r)); }
  /** Confirmed workouts still owed to Google (or edited since they went). */
  workoutsToFlush(limit = 20) { return this.q.wFlush.all(limit).map((r) => this.#w(r)); }
  /** Confirmed workouts before a time, newest first. */
  workoutsDone(before = Number.MAX_SAFE_INTEGER, limit = 40) { return this.q.wDone.all(before, limit).map((r) => this.#w(r)); }
  workoutsDoneFrom(ms) { return this.q.wDoneFrom.all(ms).map((r) => this.#w(r)); }

  /* Sets of a workout, grouped by exercise in the order they were done. */
  setsOf(workoutId) {
    const out = [];
    for (const r of this.q.wsOf.all(workoutId)) {
      let ex = out[out.length - 1];
      if (!ex || ex._idx !== r.ex_idx) { ex = { _idx: r.ex_idx, name: r.exercise, muscle: r.muscle, notes: r.notes, supersetId: r.superset, sets: [] }; out.push(ex); }
      ex.sets.push({ index: r.set_idx, type: r.type, kg: r.kg, reps: r.reps, distanceM: r.distance_m, durationS: r.duration_s, rpe: r.rpe });
    }
    return out.map(({ _idx, ...x }) => x);
  }
  /** Replace (or, with append, add to) a workout's exercises and sets. */
  putSets(workoutId, exercises, { append = false } = {}) {
    let base = 0;
    if (append) base = this.setsOf(workoutId).length;
    else this.q.wsDel.run(workoutId);
    let n = 0;
    exercises.forEach((ex, i) => {
      ex.sets.forEach((s, j) => {
        this.q.wsAdd.run(workoutId, base + i, s.index ?? j, ex.name, ex.muscle, ex.notes ?? null, ex.supersetId ?? null, s.type || 'normal',
          s.kg ?? null, s.reps ?? null, s.distanceM ?? null, s.durationS ?? null, s.rpe ?? null);
        n += 1;
      });
    });
    return n;
  }
  /** { workoutId: { exercises, sets, volumeKg } } */
  setTotals() {
    return Object.fromEntries(this.q.wsSum.all().map((r) => [r.workout_id, { exercises: r.exercises, sets: r.sets, volumeKg: Math.round(r.volume || 0) }]));
  }
  /** Every set of every confirmed workout from a time on, flat. */
  workoutSets(fromMs = 0) {
    return this.q.wsAll.all(fromMs).map((r) => ({ workoutId: r.workout_id, t: r.w_start, exercise: r.exercise, muscle: r.muscle, type: r.type, kg: r.kg, reps: r.reps }));
  }

  /* Free-standing sets (the console module's strength log). */
  #set(r) {
    return r && { id: r.id, uid: r.uid, date: r.date, t: r.t_ms, exercise: r.exercise, muscle: r.muscle, kg: r.kg, reps: r.reps, sets: r.sets, note: r.note, updated: r.updated_ms, deleted: !!r.deleted, rev: r.rev, linkFrom: r.link_from };
  }
  addSet(s, { from = null } = {}) {
    const uid = s.uid || `s-${randomUUID()}`;
    const r = this.q.setAdd.run(s.date, s.t, s.exercise, s.muscle, s.kg, s.reps, s.sets || 1, s.note ?? null, uid, s.updated ?? s.t, s.deleted ? 1 : 0, this.nextRev(), from);
    return Number(r.lastInsertRowid);
  }
  putSet(s, { from = null } = {}) {
    this.q.setPut.run(s.date, s.t, s.exercise, s.muscle, s.kg, s.reps, s.sets || 1, s.note ?? null, s.updated, s.deleted ? 1 : 0, this.nextRev(), from, s.uid);
  }
  setByUid(uid) { return this.#set(this.q.setByUid.get(uid)) || null; }
  sets(from) { return this.q.setsFrom.all(from).map((r) => this.#set(r)); }
  setsAfterRev(rev, limit = 200) { return this.q.setsRev.all(rev, limit).map((r) => this.#set(r)); }
  setCount() { return this.q.setsCount.get().n; }

  hevySeen(key) { return this.q.hevyGet.get(key) || null; }
  markHevy(key, workoutId, at) { this.q.hevySet.run(key, workoutId, at); }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
