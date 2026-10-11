/* The `sample` table, and the upgrade of a database made before it existed. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../server/core/db.js';

/* The schema exactly as the code before "all the data" created it (commit
   d86b0fa). Kept here as text: a real old file has these tables and no more. */
const OLD_SCHEMA = `
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

test('a database made by the old code is upgraded in place: every row is still there, the new table and column exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-migrate-'));
  const file = join(dir, 'health.sqlite');
  try {
    // Made and filled the way the old code did it.
    const old = new DatabaseSync(file);
    old.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    old.exec(OLD_SCHEMA);
    old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('settings', JSON.stringify({ stepTarget: 9000 }));
    old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('rev', '7');
    old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('sync', JSON.stringify({ lastOk: 5, streams: { steps: { at: 5, rows: 3, through: '2026-10-09' } } }));
    for (let d = 1; d <= 9; d += 1) old.prepare('INSERT INTO daily (date, metric, value) VALUES (?, ?, ?)').run(`2026-10-0${d}`, 'steps', 8000 + d);
    old.prepare('INSERT INTO daily (date, metric, value) VALUES (?, ?, ?)').run('2026-10-09', 'body_fat', 19.4);
    old.prepare('INSERT INTO sleep (id, date, start_ms, end_ms, main, asleep_min, awake_min, period_min, stages, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('users/me/dataTypes/sleep/dataPoints/s1', '2026-10-09', 1000, 2000, 1, 420, 30, 450, '[{"s":1000,"e":2000,"t":"LIGHT"}]', '{"stages":{"LIGHT":420}}');
    old.prepare('INSERT INTO weight (t_ms, grams, off, source, note) VALUES (?, ?, ?, ?, ?)').run(1_760_000_000_000, 77300, 10800, 'app', 'after run');
    old.prepare('INSERT INTO exercise (id, date, start_ms, end_ms, type, name, kcal, azm, avg_hr, steps, distance_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('users/me/dataTypes/exercise/dataPoints/e1', '2026-10-08', 3000, 4000, 'RUNNING', 'Run', 420, 52, 152, 5600, 6048);
    old.prepare('INSERT INTO workout (status, source, start_ms, end_ms, created_ms, updated_ms, uid, rev, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('done', 'hevy', 3000, 4000, 3000, 4000, 'uid-1', 6, '{"title":"Push Day","google":{"state":"saved","name":"users/me/dataTypes/exercise/dataPoints/ojee-w-uid-1"}}');
    old.prepare('INSERT INTO wset (workout_id, ex_idx, set_idx, exercise, muscle, type, kg, reps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 0, 0, 'Bench press', 'chest', 'normal', 70, 8);
    old.prepare('INSERT INTO strength (date, t_ms, exercise, muscle, kg, reps, sets, uid, updated_ms, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('2026-10-08', 3500, 'Pull-up', 'back', 10, 8, 3, 's-1', 3500, 7);
    old.prepare('INSERT INTO hevy_seen (key, workout_id, at_ms) VALUES (?, ?, ?)').run('k1', 1, 4000);
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sample'").get().n, 0);
    old.close();

    // Opened by the new code: twice, because the upgrade must be safe to repeat.
    for (let pass = 0; pass < 2; pass += 1) {
      const db = openDb(file);
      assert.equal(db.meta('schema'), SCHEMA_VERSION);
      assert.deepEqual(db.meta('settings'), { stepTarget: 9000 });
      assert.equal(db.meta('sync').streams.steps.through, '2026-10-09', 'the sync cursors survive, so nothing is backfilled again');
      assert.equal(db.rev, 7 + pass, 'the link cursor carries on from where it was');
      const table = db.dailyTable('0000-00-00');
      assert.equal(Object.keys(table).length, 9);
      assert.deepEqual(table['2026-10-09'], { steps: 8009, body_fat: 19.4 });
      const [sl] = db.sleeps('0000-00-00');
      assert.deepEqual([sl.id, sl.asleepMin, sl.stages.length, sl.summary.stages.LIGHT], ['users/me/dataTypes/sleep/dataPoints/s1', 420, 1, 420]);
      assert.deepEqual(db.weights(0), [{ t: 1_760_000_000_000, grams: 77300, off: 10800, source: 'app', note: 'after run' }]);
      const [ex] = db.exercises('0000-00-00');
      assert.deepEqual([ex.id, ex.kcal, ex.distanceM], ['users/me/dataTypes/exercise/dataPoints/e1', 420, 6048]);
      if (!pass) assert.deepEqual([ex.zones, ex.activeSec, ex.paceSecPerKm, ex.device], [null, null, null, null], 'an old exercise row reads with the new fields empty');
      const w = db.workoutByUid('uid-1');
      assert.deepEqual([w.title, w.google.state, w.rev], ['Push Day', 'saved', 6]);
      assert.equal(db.setsOf(w.id)[0].sets[0].kg, 70);
      assert.equal(db.setByUid('s-1').reps, 8);
      assert.equal(db.hevySeen('k1').workout_id, 1);
      // The new parts work on the old file.
      assert.deepEqual(db.samples('water'), pass ? [db.sampleGet('l-fixed')] : []);
      if (!pass) db.sampleAdd({ id: 'l-fixed', kind: 'water', t: 5000, off: 0, date: '2026-10-09', value: 250, gstate: 'local' }, 5000);
      db.upsertExercise({ ...ex, zones: { light: 1, moderate: 2, vigorous: 3, peak: 0 }, activeSec: 900, paceSecPerKm: 346, device: 'Fitbit Air' });
      assert.deepEqual(db.exercises('0000-00-00')[0].zones, { light: 1, moderate: 2, vigorous: 3, peak: 0 });
      db.nextRev();
      db.close();
    }
    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sample'").get().n, 1);
    assert.equal(raw.prepare('PRAGMA table_info(exercise)').all().filter((c) => c.name === 'extra').length, 1, 'the column was added once');
    raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sample table has exactly the contract\'s columns', () => {
  const db = openDb();
  const cols = db.db.prepare('PRAGMA table_info(sample)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'kind', 't_ms', 'end_ms', 'off', 'date', 'value', 'data', 'source', 'device', 'gname', 'gstate', 'updated_ms', 'deleted']);
  assert.equal(db.meta('schema'), SCHEMA_VERSION, 'a new database starts at the current version');
  db.close();
});

const T0 = Date.parse('2026-10-06T07:00:00Z');
const NAME = (n) => `users/me/dataTypes/hydration-log/dataPoints/${n}`;

test('add, get, patch, list newest first and paged, latest, stats', () => {
  const db = openDb();
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push(db.sampleAdd({ kind: 'water', t: T0 + i * 3_600_000, off: 10800, date: i < 5 ? '2026-10-06' : '2026-10-07', value: 250 + i, gstate: 'local' }, 100 + i));
  db.sampleAdd({ kind: 'mood', t: T0, off: 10800, date: '2026-10-06', value: 1, data: { moods: ['CALM'], valence: 'PLEASANT' }, gstate: 'local' }, 100);
  assert.match(ids[0], /^l-[0-9a-f-]{36}$/);
  const row = db.sampleGet(ids[0]);
  assert.deepEqual(row, { id: ids[0], kind: 'water', t: T0, end: null, off: 10800, date: '2026-10-06', value: 250, data: {}, source: 'app', device: null, gname: null, gstate: 'local', updated: 100, deleted: false });
  assert.equal(db.sampleGet('nope'), null);

  assert.deepEqual(db.samples('water', { limit: 3 }).map((r) => r.value), [256, 255, 254]);
  assert.deepEqual(db.samples('water', { limit: 3, offset: 3 }).map((r) => r.value), [253, 252, 251]);
  assert.deepEqual(db.samples('water', { limit: 3, offset: 6 }).map((r) => r.value), [250]);
  assert.deepEqual(db.samples('water', { fromMs: T0 + 3_600_000, toMs: T0 + 3 * 3_600_000 }).map((r) => r.value), [252, 251], 'from inclusive, to exclusive');
  assert.equal(db.samples('mood')[0].data.valence, 'PLEASANT');
  assert.equal(db.sampleLatest('water').value, 256);
  assert.equal(db.sampleLatest('food'), null);

  const p = db.samplePatch(ids[0], { value: 300, data: { x: 1 }, gstate: 'pending', nonsense: 5 }, 900);
  assert.deepEqual([p.value, p.data, p.gstate, p.updated, p.t], [300, { x: 1 }, 'pending', 900, T0]);
  assert.deepEqual(db.sampleStats(), {
    mood: { n: 1, first: '2026-10-06', last: '2026-10-06', lastMs: T0 },
    water: { n: 7, first: '2026-10-06', last: '2026-10-07', lastMs: T0 + 6 * 3_600_000 },
  });
  db.close();
});

test('per-day sums of a kind are a query, with sums of fields inside data', () => {
  const db = openDb();
  db.sampleAdd({ kind: 'water', t: T0, date: '2026-10-06', value: 250 });
  db.sampleAdd({ kind: 'water', t: T0 + 1, date: '2026-10-06', value: 500 });
  db.sampleAdd({ kind: 'water', t: T0 + 2, date: '2026-10-07', value: 330 });
  const gone = db.sampleAdd({ kind: 'water', t: T0 + 3, date: '2026-10-07', value: 999 });
  db.sampleDelete(gone);
  db.sampleAdd({ kind: 'food', t: T0, date: '2026-10-06', value: 640, data: { name: 'Chicken and rice', protein: 46, carbs: 70, fat: 16 } });
  db.sampleAdd({ kind: 'food', t: T0 + 1, date: '2026-10-06', value: 380, data: { name: 'Oats', protein: 13, carbs: 62 } });
  assert.deepEqual(db.sampleDays('water', '2026-10-01', '2026-10-31'), [
    { date: '2026-10-06', n: 2, sum: 750, avg: 375, min: 250, max: 500 },
    { date: '2026-10-07', n: 1, sum: 330, avg: 330, min: 330, max: 330 },
  ]);
  assert.deepEqual(db.sampleDays('water', '2026-10-07', '2026-10-07').map((r) => r.sum), [330], 'both ends inclusive');
  assert.deepEqual(db.sampleDays('food', '2026-10-01', '2026-10-31', ['protein', 'carbs', 'fat', "x'); DROP TABLE sample; --"]), [
    { date: '2026-10-06', n: 2, sum: 1020, avg: 510, min: 380, max: 640, protein: 59, carbs: 132, fat: 16 },
  ]);
  // None of it ever reached the table that publishing and summaries read.
  assert.deepEqual(db.dailyTable('0000-00-00'), {});
  db.close();
});

test('a point read back from Google lands on the row this app wrote: by name, else by kind and instant', () => {
  const db = openDb();
  // Written here, saved to Google under a name.
  const a = db.sampleAdd({ kind: 'water', t: T0, off: 10800, date: '2026-10-06', value: 250, gname: NAME('ojee-water-a'), gstate: 'saved', data: { note: 'kept here only' } }, 1);
  // Written here, Google named nothing: it can only be matched by its instant.
  const b = db.sampleAdd({ kind: 'water', t: T0 + 60_000, off: 10800, date: '2026-10-06', value: 500, gstate: 'create_only' }, 1);
  const read = (t, value, gname) => ({ kind: 'water', t, end: t + 60_000, off: 10800, date: '2026-10-06', value, data: {}, device: 'Logged by hand', gname });

  assert.deepEqual(db.sampleUpsert(read(T0, 250, NAME('ojee-water-a')), 50), { id: a, created: false });
  assert.deepEqual(db.sampleUpsert(read(T0 + 60_000, 500, NAME('srv-77')), 50), { id: b, created: false });
  assert.equal(db.samples('water').length, 2, 'no second copies');
  const rb = db.sampleGet(b);
  assert.deepEqual([rb.gname, rb.gstate, rb.source], [NAME('srv-77'), 'saved', 'app'], 'the name Google gave it is learned, so it can be edited after all');
  assert.deepEqual(db.sampleGet(a).data, { note: 'kept here only' }, 'what only this site knows is not overwritten');

  // Something logged elsewhere: a new row, named for the Google point.
  const c = db.sampleUpsert(read(T0 + 7_200_000, 330, NAME('other-app-1')), 60);
  assert.deepEqual(c, { id: NAME('other-app-1'), created: true });
  assert.deepEqual([db.sampleGet(c.id).source, db.sampleGet(c.id).gstate, db.sampleGet(c.id).device], ['google', null, 'Logged by hand']);
  // Read again with a corrected amount: Google's own rows follow Google.
  db.sampleUpsert(read(T0 + 7_200_000, 350, NAME('other-app-1')), 70);
  assert.equal(db.sampleGet(c.id).value, 350);
  // A point with no name at all gets a stable id of its own.
  const d = db.sampleUpsert({ kind: 'glucose', t: T0, off: 0, date: '2026-10-06', value: 94, data: { timing: 'FASTING' }, gname: null }, 80);
  assert.equal(d.id, `g-glucose-${T0}`);
  assert.equal(db.sampleUpsert({ kind: 'glucose', t: T0, off: 0, date: '2026-10-06', value: 95, data: {}, gname: null }, 81).created, false);
  assert.equal(db.samples('glucose').length, 1);
  db.close();
});

test('an edit or a delete still owed to Google is not undone by reading Google\'s old copy', () => {
  const db = openDb();
  const edited = db.sampleAdd({ kind: 'water', t: T0, date: '2026-10-06', value: 400, gname: NAME('e1'), gstate: 'pending' }, 1);
  const deleted = db.sampleAdd({ kind: 'water', t: T0 + 1000, date: '2026-10-06', value: 250, gname: NAME('d1'), gstate: 'saved' }, 1);
  db.sampleDelete(deleted, 2, 'pending');
  db.sampleUpsert({ kind: 'water', t: T0, date: '2026-10-06', value: 250, data: {}, gname: NAME('e1') }, 3);
  db.sampleUpsert({ kind: 'water', t: T0 + 1000, date: '2026-10-06', value: 250, data: {}, gname: NAME('d1') }, 3);
  assert.deepEqual([db.sampleGet(edited).value, db.sampleGet(edited).gstate], [400, 'pending']);
  assert.deepEqual([db.sampleGet(deleted).deleted, db.sampleGet(deleted).gstate], [true, 'pending']);
  assert.deepEqual(db.samples('water').map((r) => r.id), [edited], 'a deleted row is in no list');
  db.close();
});

test('what is owed to Google, soft delete, drop, purge by kind', () => {
  const db = openDb();
  const mk = (kind, gstate, extra = {}, at = 1) => db.sampleAdd({ kind, t: T0 + at, date: '2026-10-06', value: 1, gstate, ...extra }, at);
  const pending = mk('water', 'pending', {}, 3);
  const failed = mk('food', 'failed', { data: { _g: { attempts: 2, error: 'boom' } } }, 2);
  const local = mk('mood', 'local', {}, 4);
  const spent = mk('food', 'failed', { data: { _g: { attempts: 6 } } }, 1);
  mk('water', 'saved', { gname: NAME('ok') }, 5);
  mk('symptom', 'create_only', {}, 6);
  db.sampleUpsert({ kind: 'glucose', t: T0, date: '2026-10-06', value: 94, data: {}, gname: null }, 7);
  const tomb = mk('water', 'saved', { gname: NAME('gone') }, 8);
  db.sampleDelete(tomb, 9, 'pending');

  assert.deepEqual(db.samplesOwed().map((r) => r.id), [failed, pending, local, tomb], 'oldest change first; a spent row, a saved one and Google\'s own are not owed');
  assert.deepEqual(db.samplesOwed(2).map((r) => r.id), [failed, pending]);
  assert.ok(db.samplesOwed(20, 99).some((r) => r.id === spent), 'the attempt limit is the caller\'s');
  assert.equal(db.sampleGet(tomb).deleted, true);
  assert.equal(db.samplesAll().some((r) => r.id === tomb), false, 'the export leaves tombstones out');
  assert.equal(db.samplesAll().length, 7);

  assert.equal(db.sampleDrop(pending), 1);
  assert.equal(db.sampleGet(pending), null);
  assert.equal(db.samplesPurge(['water', 'food']), 4, 'tombstones go too');
  assert.deepEqual(Object.keys(db.sampleStats()).sort(), ['glucose', 'mood', 'symptom']);
  assert.equal(db.samplesPurge([]), 0);
  db.close();
});
