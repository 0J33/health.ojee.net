import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../server/training.js';
import { MUSCLES } from '../server/muscles.js';
import { rig } from './helpers.mjs';

const MIN = 60_000;
const DAY = 86_400_000;
const set = (date, exercise, kg, reps, o = {}) => ({ date, t: Date.parse(`${date}T16:00:00Z`), exercise, muscle: o.muscle || 'chest', type: o.type || 'normal', kg, reps, sets: o.sets || 1, workoutId: o.workoutId ?? `w-${date}` });

/* ── pure ─────────────────────────────────────────────────────────── */

test('e1rm: Epley, only for 1–12 reps of a real weight', () => {
  assert.equal(T.e1rm(100, 1), 103.3);
  assert.equal(T.e1rm(100, 12), 140);
  assert.equal(T.e1rm(70, 8), 88.7);
  for (const [kg, reps] of [[100, 0], [100, 13], [0, 5], [-20, 5], [100, null], [null, 5], [100, NaN]]) assert.equal(T.e1rm(kg, reps), null, `${kg} x ${reps}`);
});

test('zones: bounds at 50/60/70/80% of reserve; max floored at 170, capped at 205, 190 without traces', () => {
  assert.deepEqual(T.zoneModel(60, []).max, 190);
  assert.deepEqual(T.zoneModel(60, []).bounds, [125, 138, 151, 164]);
  assert.equal(T.zoneModel(60, [150]).max, 170);
  assert.equal(T.zoneModel(60, [182, 176]).max, 182);
  assert.equal(T.zoneModel(60, [230]).max, 205);
  const m = T.zoneModel(50, [200]);
  assert.deepEqual(m.bounds, [125, 140, 155, 170]);
  assert.deepEqual(m.labels, ['Easy', 'Light', 'Moderate', 'Hard', 'Peak']);
  assert.equal(m.note, 'Zones are estimated from your resting heart rate and the highest heart rate recorded in your workouts');
  assert.deepEqual([90, 124, 125, 139, 140, 155, 169, 170, 220].map((b) => T.zoneOf(b, m.bounds)), [0, 0, 1, 1, 2, 3, 3, 4, 4]);
});

test('zone minutes count only the minutes inside the workout that have a heart rate', () => {
  const start = Date.parse('2026-10-08T15:00:00Z'); const end = start + 6 * MIN;
  const bounds = [125, 140, 155, 170];
  const trace = [
    [start - 2 * MIN, 180, 0], [start - MIN, 100, 0],                         // the padding before: not counted
    [start, 100, 0], [start + MIN, 130, 0], [start + 2 * MIN, null, 0],       // below b1 inside the workout is zone 1
    [start + 3 * MIN, 150, 0], [start + 4 * MIN, 160, 0], [start + 5 * MIN, 175, 0],
    [end, 190, 0],                                                             // the padding after
  ];
  assert.deepEqual(T.zoneMinutes(trace, start, end, bounds), [1, 1, 1, 1, 1]);
  assert.equal(T.zoneMinutes([], start, end, bounds), null);
  assert.equal(T.zoneMinutes(null, start, end, bounds), null);
  assert.equal(T.zoneMinutes([[start - MIN, 150, 0]], start, end, bounds), null, 'nothing inside the workout');
  assert.deepEqual(T.sparkOf(trace, start, end), [100, 130, 150, 160, 175]);
  const long = Array.from({ length: 100 }, (_, i) => [start + i * MIN, 100 + i, 0]);
  const spark = T.sparkOf(long, start, start + 100 * MIN);
  assert.equal(spark.length, 32);
  assert.ok(spark[0] < 103 && spark.at(-1) > 196 && spark.every((v, i) => i === 0 || v >= spark[i - 1]));
  assert.equal(T.sparkOf([], start, end), null);
});

test('weeks are Monday weeks in the person\'s own zone', () => {
  // Sunday 23:30 UTC: already Monday in Auckland, still Sunday in Los Angeles.
  const t = Date.parse('2026-10-04T23:30:00Z');
  const nz = T.clockOf('Pacific/Auckland'); const la = T.clockOf('America/Los_Angeles');
  assert.deepEqual([nz.date(t), nz.hour(t)], ['2026-10-05', 12]);
  assert.deepEqual([la.date(t), la.hour(t)], ['2026-10-04', 16]);
  const sess = (clock) => [{ date: clock.date(t), hour: clock.hour(t), start: t, end: t + 45 * MIN, zonesMin: [10, 20, 10, 5, 0] }];
  const a = T.weekBuckets(sess(nz), [set(nz.date(t), 'Bench Press', 60, 10)], '2026-10-06');
  const b = T.weekBuckets(sess(la), [set(la.date(t), 'Bench Press', 60, 10)], '2026-10-06');
  assert.equal(a.length, 12); assert.equal(b.length, 12);
  assert.deepEqual([a[0].week, a.at(-1).week], ['2026-07-20', '2026-10-05']);
  assert.deepEqual([a.at(-1).workouts, a.at(-1).minutes, a.at(-1).sets, a.at(-1).volumeKg, a.at(-2).workouts], [1, 45, 1, 600, 0]);
  assert.deepEqual([b.at(-1).workouts, b.at(-2).workouts, b.at(-2).volumeKg, b.at(-2).byMuscle.chest], [0, 1, 600, 600]);
  assert.deepEqual(b.at(-2).zonesMin, [10, 20, 10, 5, 0]);
  assert.equal(b.at(-1).zonesMin, null, 'a week with no trace has no zones');
  assert.deepEqual(Object.keys(a[0].byMuscle), MUSCLES);
  assert.deepEqual(T.weekdayCounts(sess(nz)).map((x) => x.workouts), [1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(T.weekdayCounts(sess(la)).map((x) => x.workouts), [0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(T.weekdayCounts(sess(la)).map((x) => x.dow), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(T.hourCounts(sess(nz))[12], 1); assert.equal(T.hourCounts(sess(la))[16], 1);
  assert.equal(T.hourCounts(sess(la)).length, 24);
  assert.deepEqual(T.weekdayCounts(sess(la), '2026-10-05').map((x) => x.workouts), [0, 0, 0, 0, 0, 0, 0], 'before the window');
});

test('this week against the mean of the four complete weeks before it', () => {
  const day = (d) => ({ date: d, start: Date.parse(`${d}T10:00:00Z`), end: Date.parse(`${d}T11:00:00Z`), zonesMin: null });
  // Four weeks before this one: 2, 1, 0 and 3 sessions. This week: one.
  const sessions = ['2026-09-07', '2026-09-09', '2026-09-15', '2026-09-28', '2026-09-30', '2026-10-02', '2026-10-06', '2026-08-01'].map(day);
  const sets = [set('2026-09-07', 'Squat', 100, 5, { muscle: 'legs', sets: 4 }), set('2026-10-06', 'Squat', 100, 5, { muscle: 'legs' })];
  const w = T.weekSummary(T.weekBuckets(sessions, sets, '2026-10-08'));
  assert.deepEqual(w, { start: '2026-10-05', workouts: 1, minutes: 60, sets: 1, volumeKg: 500, avg4: { workouts: 1.5, minutes: 90, sets: 1, volumeKg: 500 } });
});

test('balance: every muscle, shares of the last 28 days\' sets add up to 100, days since each was trained', () => {
  const sets = [
    set('2026-10-07', 'Bench Press', 60, 10, { muscle: 'chest', sets: 3 }),
    set('2026-10-05', 'Row', 50, 10, { muscle: 'back', sets: 2 }),
    set('2026-10-01', 'Squat', 100, 5, { muscle: 'legs' }),
    set('2026-08-20', 'Curl', 15, 12, { muscle: 'arms', sets: 5 }),       // outside the window, but remembered
    set('2026-10-02', 'Jump Rope', 0, 0, { muscle: 'cardio-ish' }),        // an unknown group is "other"
  ];
  const b = T.balance(sets, '2026-10-08');
  assert.deepEqual(b.map((x) => x.muscle), MUSCLES);
  const by = Object.fromEntries(b.map((x) => [x.muscle, x]));
  assert.deepEqual([by.chest.sets4w, by.chest.volumeKg4w, by.chest.sharePct, by.chest.daysSince], [3, 1800, 42.9, 1]);
  assert.deepEqual([by.arms.sets4w, by.arms.sharePct, by.arms.daysSince], [0, 0, 49]);
  assert.equal(by.arms.lastAt, Date.parse('2026-08-20T16:00:00Z'));
  assert.deepEqual([by.core.sets4w, by.core.lastAt, by.core.daysSince], [0, null, null]);
  assert.equal(by.other.sets4w, 1);
  const total = b.reduce((a, x) => a + x.sharePct, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `shares sum to ${total}`);
  assert.ok(T.balance([], '2026-10-08').every((x) => x.sets4w === 0 && x.sharePct === 0 && x.daysSince === null));
});

test('records need a previous best: a first-ever lift is not one; warm-ups never count', () => {
  const sets = [
    set('2026-09-01', 'Bench Press', 60, 8),                    // the first ever: sets the bar, breaks nothing
    set('2026-09-01', 'Bench Press', 65, 5),
    set('2026-09-20', 'Bench Press', 90, 5, { type: 'warmup' }),   // a "warm-up" heavier than anything: ignored
    set('2026-09-20', 'Bench Press', 65, 8),                    // same weight, more reps: an e1rm record only
    set('2026-10-05', 'Bench Press', 70, 3),                    // heavier, but a lower e1rm: a weight record only
    set('2026-10-05', 'Squat', 100, 5, { muscle: 'legs' }),     // first ever squat
    set('2026-10-06', 'Bench Press', 70, 20),                   // 20 reps: no e1rm, and 70 is not more than 70
  ];
  const h = T.exerciseHistory(sets);
  const bench = h.get('Bench Press');
  assert.deepEqual(bench.sessions.map((s) => [s.date, s.topKg, s.topReps, s.e1rm, s.prevKg, s.prevE1rm]), [
    ['2026-09-01', 65, 5, 76, null, null], ['2026-09-20', 65, 8, 82.3, 65, 76], ['2026-10-05', 70, 3, 77, 65, 82.3], ['2026-10-06', 70, 20, null, 70, 82.3],
  ]);
  assert.deepEqual([bench.bestKg, bench.bestE1rm], [70, 82.3]);
  assert.equal(bench.sessions[1].sets, 2, 'the warm-up is still a set that was done');
  const prs = T.recentPrs(h, '2026-10-08');
  assert.deepEqual(prs.map((p) => [p.exercise, p.kind, p.value, p.previous, p.date]), [['Bench Press', 'weight', 70, 65, '2026-10-05'], ['Bench Press', 'e1rm', 82.3, 76, '2026-09-20']]);
  assert.deepEqual(Object.keys(prs[0]), ['exercise', 'muscle', 'kind', 'value', 'previous', 'date', 'at', 'workoutId']);
  assert.equal(prs[0].workoutId, 'w-2026-10-05');
  assert.deepEqual(T.recentPrs(h, '2026-10-08', { days: 10 }).map((p) => p.kind), ['weight'], 'only the window');
  assert.deepEqual(T.prCounts(h), { 'w-2026-09-20': 1, 'w-2026-10-05': 1 });
  assert.deepEqual(T.recentPrs(T.exerciseHistory([]), '2026-10-08'), []);
});

test('exercises: the most-trained, sessions oldest first, change of the last three against the first three', () => {
  const sets = [];
  // Bench every week for 8 weeks, 2.5 kg more each time; rows only 3 times.
  for (let i = 0; i < 8; i += 1) sets.push(set(`2026-08-${String(3 + i * 3).padStart(2, '0')}`, 'Bench Press', 60 + i * 2.5, 5), set(`2026-08-${String(3 + i * 3).padStart(2, '0')}`, 'Bench Press', 40, 10, { type: 'warmup' }));
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15']) sets.push(set(d, 'Row', 50, 10, { muscle: 'back' }));
  sets.push(set('2025-01-01', 'Old Lift', 200, 1), set('2025-01-01', 'Bench Press', 100, 1));
  const ex = T.topExercises(T.exerciseHistory(sets), '2026-10-08');
  assert.deepEqual(ex.map((e) => [e.name, e.sessions.length]), [['Bench Press', 8], ['Row', 3]]);
  assert.deepEqual(Object.keys(ex[0]), ['name', 'muscle', 'sessions', 'bestKg', 'bestE1rm', 'changePct']);
  assert.deepEqual(ex[0].sessions[0], { date: '2026-08-03', t: Date.parse('2026-08-03T16:00:00Z'), topKg: 60, topReps: 5, e1rm: 70, volumeKg: 700, sets: 2 });
  assert.ok(ex[0].sessions.every((s, i, a) => i === 0 || s.t > a[i - 1].t));
  // first three: 70, 72.9, 75.8; last three: 84.6, 87.5, 90.4
  assert.equal(ex[0].changePct, 20);
  assert.equal(ex[0].bestKg, 100, 'the best is the best ever, not of the window');
  assert.equal(ex[1].changePct, null, 'under six sessions');
  assert.equal(T.topExercises(T.exerciseHistory(sets), '2026-10-08', { max: 1 }).length, 1);
  const many = Array.from({ length: 30 }, (_, i) => set(new Date(Date.parse('2026-09-01T00:00:00Z') + i * DAY).toISOString().slice(0, 10), 'Curl', 10, 10, { muscle: 'arms' }));
  assert.equal(T.topExercises(T.exerciseHistory(many), '2026-10-08')[0].sessions.length, 24);
  assert.equal(T.topExercises(T.exerciseHistory(many), '2026-10-08')[0].sessions.at(-1).date, '2026-09-30');
});

test('a workout\'s sets: the record set is marked, and each exercise knows its last session', () => {
  const h = T.exerciseHistory([set('2026-09-01', 'Bench Press', 60, 8, { workoutId: '1' }), set('2026-09-10', 'Bench Press', 65, 5, { workoutId: '2' }), set('2026-10-05', 'Bench Press', 70, 6, { workoutId: '3' })]);
  const exercises = [
    { name: 'Bench Press', muscle: 'chest', sets: [{ index: 0, type: 'warmup', kg: 80, reps: 5 }, { index: 1, type: 'normal', kg: 70, reps: 6 }, { index: 2, type: 'normal', kg: 70, reps: 6 }, { index: 3, type: 'normal', kg: 60, reps: 12 }] },
    { name: 'Squat', muscle: 'legs', sets: [{ index: 0, type: 'normal', kg: 100, reps: 5 }] },
  ];
  const out = T.markSets(exercises, h, { workoutId: '3', start: Date.parse('2026-10-05T16:00:00Z') });
  assert.deepEqual(out[0].sets.map((s) => s.pr), [false, true, false, false], 'the first set to reach the best, once; not the warm-up');
  assert.deepEqual(out[0].previous, { date: '2026-09-10', topKg: 65, topReps: 5 });
  assert.deepEqual([out[1].previous, out[1].sets[0].pr], [null, false], 'a first-ever lift');
  assert.equal(out[0].sets[1].kg, 70); assert.equal(out[0].muscle, 'chest');
  // The same workout seen as the first of its kind: nothing to beat.
  const first = T.markSets(exercises, h, { workoutId: '1', start: Date.parse('2026-09-01T16:00:00Z') });
  assert.ok(first.every((e) => e.previous === null && e.sets.every((s) => s.pr === false)));
});

test('the usual session: medians, null when unknown', () => {
  const s = (min, avgHr, volumeKg) => ({ start: 0, end: min * MIN, avgHr, volumeKg });
  assert.deepEqual(T.usualOf([s(40, 110, 3000), s(60, null, null), s(90, 130, 5000)]), { durationMin: 60, avgHr: 120, volumeKg: 4000 });
  assert.deepEqual(T.usualOf([]), { durationMin: null, avgHr: null, volumeKg: null });
});

/* ── through the app ──────────────────────────────────────────────── */

const HEAD = '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';
const row = (title, start, end, ex, i, type, kg, reps) => `"${title}","${start}","${end}","","${ex}",,"",${i},"${type}",${kg},${reps},,,`;
const NOW = Date.parse('2026-10-10T10:00:00Z');   // a Saturday, 13:00 in Cairo
const CSV = [
  HEAD,
  row('Push A', '18 Sep 2026, 18:00', '18 Sep 2026, 19:00', 'Bench Press (Barbell)', 0, 'normal', 60, 8),
  row('Push A', '18 Sep 2026, 18:00', '18 Sep 2026, 19:00', 'Squat (Barbell)', 0, 'normal', 100, 5),
  row('Push B', '29 Sep 2026, 18:00', '29 Sep 2026, 19:10', 'Bench Press (Barbell)', 0, 'warmup', 90, 5),
  row('Push B', '29 Sep 2026, 18:00', '29 Sep 2026, 19:10', 'Bench Press (Barbell)', 1, 'normal', 65, 8),
  row('Push C', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Bench Press (Barbell)', 0, 'normal', 60, 8),
  row('Push C', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Bench Press (Barbell)', 1, 'normal', 70, 8),
  row('Push C', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Lat Pulldown (Cable)', 0, 'normal', 50, 10),
].join('\n');
const TRAINING_KEYS = ['week', 'weeks', 'weekday', 'hours', 'zones', 'balance', 'prs', 'exercises', 'usual'];

test('GET /api/workouts: `training` for a person with sets, with spark, zones and records on the workouts', async () => {
  const r = await rig({ now: () => NOW });
  try {
    const p = await r.person('lifter');
    assert.equal((await p.c.call('POST', '/api/workouts/import/hevy', { raw: CSV, headers: { 'content-type': 'text/csv' } })).status, 200);
    // A trace this app already holds for the last session (15:10–16:20 Cairo = 12:10–13:20 UTC).
    const w = r.app.worlds.get(p.id);
    const last = w.db.workoutsDoneFrom(0).at(-1);
    const trace = [];
    for (let t = last.start - 20 * MIN; t < last.end + 20 * MIN; t += MIN) trace.push([t, t < last.start || t >= last.end ? 80 : t < last.start + 30 * MIN ? 120 : 176, 0]);
    w.db.workoutCache(last.id, { trace });
    let calls = 0;
    r.wrap.fn = () => { calls += 1; return null; };

    const res = await p.c.get('/api/workouts');
    assert.equal(res.status, 200);
    assert.equal(calls, 0, 'the list never asks Google for a trace');
    const t = res.json.training;
    assert.deepEqual(Object.keys(t), TRAINING_KEYS);
    assert.deepEqual(t.week, { start: '2026-10-05', workouts: 1, minutes: 70, sets: 3, volumeKg: 1540, avg4: { workouts: 0.5, minutes: 33, sets: 1, volumeKg: 488 } });
    assert.equal(t.weeks.length, 12);
    assert.deepEqual(Object.keys(t.weeks[0]), ['week', 'workouts', 'minutes', 'sets', 'volumeKg', 'byMuscle', 'zonesMin']);
    assert.deepEqual(t.weeks.at(-1).byMuscle, { chest: 1040, back: 500, shoulders: 0, arms: 0, legs: 0, core: 0, other: 0 });
    assert.deepEqual(t.weeks.at(-1).zonesMin, [30, 0, 0, 0, 40]);
    assert.equal(t.weeks.at(-2).zonesMin, null);
    assert.deepEqual(t.weekday, [0, 1, 0, 0, 2, 0, 0].map((workouts, dow) => ({ dow, workouts })));
    assert.equal(t.hours.length, 24);
    assert.deepEqual([t.hours[18], t.hours[15], t.hours.reduce((a, b) => a + b, 0)], [2, 1, 3]);
    // No resting heart rate yet: 70. The highest minute seen was 176.
    assert.deepEqual([t.zones.rest, t.zones.max, t.zones.bounds], [70, 176, [123, 134, 144, 155]]);
    assert.deepEqual(t.balance.map((b) => b.muscle), MUSCLES);
    assert.ok(Math.abs(t.balance.reduce((a, b) => a + b.sharePct, 0) - 100) < 0.5);
    assert.deepEqual([t.balance[0].sets4w, t.balance[0].daysSince, t.balance[4].daysSince], [5, 1, 22]);
    assert.deepEqual(t.prs.map((x) => [x.exercise, x.kind, x.value, x.previous, x.date, x.workoutId]), [
      ['Bench Press (Barbell)', 'weight', 70, 65, '2026-10-09', String(last.id)],
      ['Bench Press (Barbell)', 'e1rm', 88.7, 82.3, '2026-10-09', String(last.id)],
      ['Bench Press (Barbell)', 'weight', 65, 60, '2026-09-29', t.prs[2].workoutId],
      ['Bench Press (Barbell)', 'e1rm', 82.3, 76, '2026-09-29', t.prs[2].workoutId],
    ]);
    assert.deepEqual(t.exercises.map((e) => [e.name, e.sessions.length, e.bestKg, e.changePct]), [['Bench Press (Barbell)', 3, 70, null], ['Lat Pulldown (Cable)', 1, 50, null], ['Squat (Barbell)', 1, 100, null]]);
    assert.deepEqual(t.usual, { durationMin: 70, avgHr: null, volumeKg: 980 });

    const h = res.json.history;
    assert.deepEqual(h.map((x) => [x.title, x.prCount, x.zonesMin, x.spark === null ? null : x.spark.length]), [['Push C', 2, [30, 0, 0, 0, 40], 32], ['Push B', 2, null, null], ['Push A', 0, null, null]]);
    assert.ok(h[0].spark[0] === 120 && h[0].spark.at(-1) === 176);
    assert.equal(res.json.strength.weeks.length, 12, 'what was there before is still there');

    // The detail: zones of its own trace, the usual session, the record set marked.
    const d = (await p.c.get(`/api/workouts/${last.id}`)).json;
    assert.deepEqual(d.zones, { minutes: [30, 0, 0, 0, 40], bounds: [123, 134, 144, 155], labels: ['Easy', 'Light', 'Moderate', 'Hard', 'Peak'], rest: 70, max: 176, note: t.zones.note });
    assert.deepEqual(d.usual, t.usual);
    assert.deepEqual(d.exercises.map((e) => [e.name, e.previous, e.sets.map((s) => s.pr)]), [
      ['Bench Press (Barbell)', { date: '2026-09-29', topKg: 65, topReps: 8 }, [false, true]],
      ['Lat Pulldown (Cable)', null, [false]],
    ]);
    assert.equal(d.trace.length, trace.length);
    // The one before it has no trace this app holds (no Google): no zones, but its record is marked.
    const b = (await p.c.get(`/api/workouts/${t.prs[2].workoutId}`)).json;
    assert.equal(b.zones, null);
    assert.deepEqual(b.exercises[0].sets.map((s) => [s.type, s.pr]), [['warmup', false], ['normal', true]]);
    // A running workout is in the list with the same three fields.
    const run = (await p.c.post('/api/workouts/start', {})).json;
    assert.deepEqual([run.running.spark, run.running.zonesMin, run.running.prCount], [null, null, 0]);
  } finally { await r.close(); }
});

test('GET /api/workouts: `training` for a person with nothing at all is zeros and nulls', async () => {
  const r = await rig({ now: () => NOW });
  try {
    const p = await r.person('newbie');
    const res = await p.c.get('/api/workouts');
    assert.equal(res.status, 200);
    const t = res.json.training;
    assert.deepEqual(Object.keys(t), TRAINING_KEYS);
    assert.deepEqual(t.week, { start: '2026-10-05', workouts: 0, minutes: 0, sets: 0, volumeKg: 0, avg4: { workouts: 0, minutes: 0, sets: 0, volumeKg: 0 } });
    assert.equal(t.weeks.length, 12);
    assert.ok(t.weeks.every((w) => w.workouts === 0 && w.minutes === 0 && w.sets === 0 && w.volumeKg === 0 && w.zonesMin === null));
    assert.deepEqual(t.weekday.map((x) => x.workouts), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(t.hours, new Array(24).fill(0));
    assert.deepEqual([t.zones.rest, t.zones.max, t.zones.bounds], [70, 190, [130, 142, 154, 166]]);
    assert.deepEqual(t.balance.map((b) => [b.muscle, b.sets4w, b.volumeKg4w, b.sharePct, b.lastAt, b.daysSince]), MUSCLES.map((m) => [m, 0, 0, 0, null, null]));
    assert.deepEqual([t.prs, t.exercises], [[], []]);
    assert.deepEqual(t.usual, { durationMin: null, avgHr: null, volumeKg: null });
    // A logged session with no sets and no trace: counted, nothing invented.
    await p.c.post('/api/workouts/log', { start: NOW - 2 * DAY, end: NOW - 2 * DAY + 45 * MIN, title: 'Walk' });
    const again = (await p.c.get('/api/workouts')).json;
    assert.deepEqual([again.training.week.workouts, again.training.week.minutes, again.training.usual.durationMin], [1, 45, 45]);
    assert.deepEqual([again.history[0].spark, again.history[0].zonesMin, again.history[0].prCount], [null, null, 0]);
    const d = (await p.c.get(`/api/workouts/${again.history[0].id}`)).json;
    assert.deepEqual([d.zones, d.exercises, d.usual.durationMin], [null, [], 45]);
  } finally { await r.close(); }
});

test('a Google exercise with a trace this app has kept: zones in the list, and in its detail', async () => {
  const r = await rig({ now: () => NOW });
  try {
    const p = await r.person('watch', { persona: 'fitbit' });
    const first = (await p.c.get('/api/workouts')).json;
    const g = first.history.find((x) => x.id.startsWith('g-'));
    if (!g) return;   // this persona has no exercise of its own: nothing to check
    assert.deepEqual([g.spark, g.zonesMin, g.prCount], [null, null, 0], 'not opened yet: no trace is held, and none is fetched');
    const d = (await p.c.get(`/api/workouts/${g.id}`)).json;
    assert.deepEqual(d.exercises, []);
    assert.ok('zones' in d && 'usual' in d);
    const after = (await p.c.get('/api/workouts')).json.history.find((x) => x.id === g.id);
    if (d.zones) {
      assert.equal(d.zones.minutes.length, 5);
      assert.deepEqual(after.zonesMin, d.zones.minutes, 'the list shows what the detail cached');
      assert.ok(after.spark.length > 0 && after.spark.length <= 32);
    } else assert.equal(after.zonesMin, null);
  } finally { await r.close(); }
});

test('a synced run with GPS: its route from Google (exportExerciseTcx), kept; without route maps allowed it asks', async () => {
  const { personWith } = await import('./people.mjs');
  const r = await rig({ now: () => NOW });
  try {
    const p = await personWith(r, 'runner');
    const run = (await p.c.get('/api/workouts')).json.history.find((x) => x.id.startsWith('g-') && x.type === 'RUNNING');
    assert.ok(run, 'the persona runs');
    // Location is not asked with the rest: the page says the route is there and asks.
    const before = (await p.c.get(`/api/workouts/${run.id}`)).json;
    assert.deepEqual([before.track, before.routeNeeds], [null, 'location']);
    const start = await p.c.get('/auth/google/start?groups=routes&return=/workouts', { redirect: 'manual' });
    assert.match(decodeURIComponent(start.headers?.get?.('location') || start.location || ''), /location\.readonly/, 'asked only when chosen');
    // Allowed (as Google would after that consent).
    const { pkce, LOCATION_SCOPE } = await import('../server/core/google.js');
    await r.app.worlds.hold(p.id, async (w) => { const pk = pkce(); await w.google.exchange({ code: r.parts.issue(pk.challenge, [...r.parts.scopesFor([]), LOCATION_SCOPE]), verifier: pk.verifier }); });
    const d = (await p.c.get(`/api/workouts/${run.id}`)).json;
    assert.ok(d.track && d.track.distanceM > 500 && d.track.line.length > 10, 'the route, drawn');
    assert.equal(d.routeNeeds, null);
    // Kept: asked once.
    assert.ok(await r.app.worlds.hold(p.id, async (w) => w.db.meta(`route:${run.id}`)?.points?.length > 10));
    const walk = (await p.c.get('/api/workouts')).json.history.find((x) => x.id.startsWith('g-') && x.type === 'WEIGHTLIFTING');
    if (walk) assert.equal((await p.c.get(`/api/workouts/${walk.id}`)).json.track, null, 'weights have no route');
  } finally { await r.close(); }
});
