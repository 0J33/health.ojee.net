import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { parseCsv, parseHevyDate, parseHevy, importHevy } from '../server/hevy.js';
import { muscleOf } from '../server/muscles.js';
import { unified } from '../server/history.js';
import { rig } from './helpers.mjs';

const HEAD = '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';
const row = (title, start, end, ex, i, type, kg, reps, extra = ',,') => `"${title}","${start}","${end}","","${ex}",,"",${i},"${type}",${kg},${reps},${extra}`;
const FILE = [
  HEAD,
  row('Push Day', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Bench Press (Barbell)', 0, 'warmup', 40, 10),
  row('Push Day', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Bench Press (Barbell)', 1, 'normal', 70, 8, ',,8.5'),
  row('Push Day', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Bench Press (Barbell)', 2, 'failure', 70, 6),
  row('Push Day', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Triceps Pushdown', 0, 'dropset', 30, 12),
  row('Push Day', '9 Oct 2026, 15:10', '9 Oct 2026, 16:20', 'Farmer Walk', 0, 'normal', 40, '', '0.05,45,'),
  row('Leg Day', '7 Oct 2026, 07:00', '7 Oct 2026, 08:00', 'Squat (Barbell)', 0, 'normal', 100, 5),
].join('\n');
const TZ = 'Africa/Cairo';   // +03:00 in October 2026
const NOW = Date.parse('2026-10-10T10:00:00Z');

test('CSV: quotes, doubled quotes, commas and newlines inside a field, CRLF, a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, ""y""","line1\nline2"\r\n,\r\n'), [['a', 'b'], ['x, "y"', 'line1\nline2'], ['', '']]);
});

test('dates are read in the person\'s own zone, in every form Hevy has used', () => {
  assert.equal(parseHevyDate('9 Oct 2026, 15:10', TZ), Date.parse('2026-10-09T12:10:00Z'));
  assert.equal(parseHevyDate('9 Oct 2026, 15:10', 'America/New_York'), Date.parse('2026-10-09T19:10:00Z'));
  assert.equal(parseHevyDate('09 Jan 2026, 06:05', TZ), Date.parse('2026-01-09T04:05:00Z'), 'winter: +02:00');
  assert.equal(parseHevyDate('2026-10-09 15:10:30', TZ), Date.parse('2026-10-09T12:10:30Z'));
  assert.equal(parseHevyDate('9 Oct 2026, 3:10 PM', TZ), Date.parse('2026-10-09T12:10:00Z'));
  assert.equal(parseHevyDate('2026-10-09T12:10:00Z', TZ), Date.parse('2026-10-09T12:10:00Z'));
  for (const bad of ['', 'yesterday', '31 Feb 2026, 10:00', '9 Okt 2026, 15:10', '9 Oct 2026, 25:10']) assert.equal(parseHevyDate(bad, TZ), null, bad);
});

test('rows become workouts with exercises and sets; lbs and miles are converted', () => {
  const { workouts, errors } = parseHevy(FILE, TZ);
  assert.deepEqual(errors, []);
  assert.deepEqual(workouts.map((w) => [w.title, w.sets, w.exercises.length]), [['Leg Day', 1, 1], ['Push Day', 5, 3]]);
  const push = workouts[1];
  assert.equal(push.start, Date.parse('2026-10-09T12:10:00Z'));
  assert.equal(push.end - push.start, 70 * 60_000);
  assert.deepEqual(push.exercises[0], { name: 'Bench Press (Barbell)', muscle: 'chest', notes: null, supersetId: null, sets: [
    { index: 0, type: 'warmup', kg: 40, reps: 10, distanceM: null, durationS: null, rpe: null },
    { index: 1, type: 'normal', kg: 70, reps: 8, distanceM: null, durationS: null, rpe: 8.5 },
    { index: 2, type: 'failure', kg: 70, reps: 6, distanceM: null, durationS: null, rpe: null },
  ] });
  assert.deepEqual(push.exercises[2].sets[0], { index: 0, type: 'normal', kg: 40, reps: null, distanceM: 50, durationS: 45, rpe: null });
  const lbs = parseHevy(['"title","start_time","end_time","exercise_title","set_index","set_type","weight_lbs","reps","distance_miles"', '"A","9 Oct 2026, 15:10","","Deadlift (Barbell)",0,"normal",225,5,1'].join('\n'), TZ).workouts[0];
  assert.equal(lbs.exercises[0].sets[0].kg, 102.06);
  assert.equal(lbs.exercises[0].sets[0].distanceM, 1609);
  assert.equal(lbs.end - lbs.start, 3_600_000, 'no end time: an hour');
  assert.throws(() => parseHevy('a,b\n1,2', TZ), /does not look like a Hevy export/);
  assert.throws(() => importHevy({ db: openDb(':memory:'), text: `${HEAD}\n${row('X', 'garbage', '', 'Curl', 0, 'normal', 1, 1)}`, tz: TZ }), /Nothing could be imported. Row 2: could not read the date/);
});

test('muscle groups from names', () => {
  const cases = { 'Bench Press (Barbell)': 'chest', 'Leg Curl (Machine)': 'legs', 'Bicep Curl (Dumbbell)': 'arms', 'Lat Pulldown (Cable)': 'back', 'Overhead Press (Barbell)': 'shoulders', 'Romanian Deadlift (Barbell)': 'legs', 'Cable Crunch': 'core', 'Seated Row (Cable)': 'back', 'Triceps Pushdown': 'arms', 'Jump Rope': 'other' };
  for (const [name, m] of Object.entries(cases)) assert.equal(muscleOf(name), m, name);
});

test('import, then the same file again: nothing changes', () => {
  const db = openDb(':memory:');
  const a = importHevy({ db, text: FILE, tz: TZ, now: NOW });
  assert.deepEqual([a.found, a.imported, a.merged, a.skipped, a.sets, a.toUpload], [2, 2, 0, 0, 6, 0]);
  assert.deepEqual(a.unknownExercises, ['Farmer Walk']);
  const rows = db.workoutsSince(0);
  assert.deepEqual(rows.map((r) => [r.title, r.source, r.status, r.google.state]), [['Leg Day', 'hevy', 'done', 'local'], ['Push Day', 'hevy', 'done', 'local']]);
  assert.equal(db.setsOf(rows[1].id).length, 3);
  const rev = db.rev;
  const b = importHevy({ db, text: FILE, tz: TZ, now: NOW + 5000 });
  assert.deepEqual([b.imported, b.merged, b.skipped, b.sets], [0, 0, 2, 0]);
  assert.deepEqual(b.items.map((i) => i.result), ['skipped', 'skipped']);
  assert.equal(db.workoutsSince(0).length, 2);
  assert.equal(db.rev, rev, 'not a single write');
  assert.equal(db.setsOf(rows[1].id).reduce((n, e) => n + e.sets.length, 0), 5);
  // A workout deleted here stays deleted when the file comes round again.
  const gone = db.workoutGet(rows[0].id); gone.status = 'deleted'; db.workoutPut(gone);
  assert.equal(importHevy({ db, text: FILE, tz: TZ, now: NOW }).skipped, 2);
  assert.equal(db.workoutsDoneFrom(0).length, 1);
  // A dry run reports and stores nothing.
  const fresh = openDb(':memory:');
  const dry = importHevy({ db: fresh, text: FILE, tz: TZ, dryRun: true, now: NOW });
  assert.deepEqual([dry.dryRun, dry.imported], [true, 2]);
  assert.equal(fresh.workoutsSince(0).length, 0);
});

test('a Hevy workout overlapping one already held by half or more is merged into it', () => {
  const db = openDb(':memory:');
  // Detected and confirmed here: 15:20-16:25, overlapping Push Day (15:10-16:20) almost entirely.
  const s = Date.parse('2026-10-09T12:20:00Z');
  const id = db.workoutAdd({ status: 'done', source: 'detected', start: s, end: s + 65 * 60_000, created: s, updated: s, google: { state: 'saved', name: 'users/me/dataTypes/exercise/dataPoints/ojee-w-x' }, prompts: {} });
  // And one that only brushes Leg Day (07:00-08:00): 07:50-09:00, ten minutes of overlap.
  const s2 = Date.parse('2026-10-07T04:50:00Z');
  db.workoutAdd({ status: 'done', source: 'logged', start: s2, end: s2 + 70 * 60_000, created: s2, updated: s2, google: { state: 'local' }, prompts: {} });
  const out = importHevy({ db, text: FILE, tz: TZ, now: NOW });
  assert.deepEqual([out.imported, out.merged, out.skipped], [1, 1, 0]);
  assert.deepEqual(out.items.map((i) => [i.title, i.result, i.mergedInto]), [['Leg Day', 'imported', null], ['Push Day', 'merged', String(id)]]);
  const kept = db.workoutGet(id);
  assert.deepEqual([kept.source, kept.start, kept.title, kept.google.state], ['detected', s, 'Push Day', 'saved'], 'the existing workout keeps its times and its Google point');
  assert.equal(db.setsOf(id).reduce((n, e) => n + e.sets.length, 0), 5);
  assert.equal(db.workoutsDoneFrom(0).length, 3, 'no second Push Day');
  assert.equal(importHevy({ db, text: FILE, tz: TZ, now: NOW }).skipped, 2);
  assert.equal(db.setsOf(id).reduce((n, e) => n + e.sets.length, 0), 5, 'sets are not attached twice');
});

test('upload only when asked, and never for a session Google already has', () => {
  const mk = () => {
    const db = openDb(':memory:');
    // The watch logged the Push Day session itself.
    const s = Date.parse('2026-10-09T12:12:00Z');
    db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/777', date: '2026-10-09', startMs: s, endMs: s + 66 * 60_000, type: 'WEIGHTLIFTING', name: 'Weights' });
    return db;
  };
  let db = mk();
  importHevy({ db, text: FILE, tz: TZ, now: NOW });
  assert.deepEqual(db.workoutsSince(0).map((r) => r.google.state), ['local', 'foreign'], 'not ticked: nothing is owed to Google');
  assert.equal(db.workoutsToFlush().length, 0);
  db = mk();
  const out = importHevy({ db, text: FILE, tz: TZ, upload: true, canWrite: true, now: NOW });
  assert.equal(out.toUpload, 1);
  assert.deepEqual(db.workoutsSince(0).map((r) => [r.title, r.google.state]), [['Leg Day', 'pending'], ['Push Day', 'foreign']]);
  assert.deepEqual(db.workoutsToFlush().map((r) => r.title), ['Leg Day']);
  // In the history the session appears once, as the workout with the sets.
  const hist = unified(db, 0);
  assert.equal(hist.length, 2);
  assert.ok(hist.every((h) => h.local));
  // Ticked without the permission: it waits, it is not dropped.
  db = mk();
  importHevy({ db, text: FILE, tz: TZ, upload: true, canWrite: false, now: NOW });
  assert.equal(db.workoutsSince(0)[0].google.state, 'needs_scope');
});

test('through the API: raw CSV body, 5 MB cap, upload reaches Google once, totals feed strength', async () => {
  const r = await rig();
  try {
    const p = await r.person('lifter', { persona: 'phone' });
    const csv = { raw: FILE, headers: { 'content-type': 'text/csv' } };
    const dry = await p.c.call('POST', '/api/workouts/import/hevy?dryRun=1', csv);
    assert.deepEqual([dry.status, dry.json.dryRun, dry.json.imported], [200, true, 2]);
    assert.equal((await p.c.get('/api/workouts')).json.history.length, 0);
    const created = [];
    r.wrap.fn = async (userId, url, init) => { if (init?.method === 'POST' && url.pathname.endsWith('/exercise/dataPoints')) created.push(JSON.parse(init.body)); return null; };
    const out = await p.c.call('POST', '/api/workouts/import/hevy?upload=1', csv);
    assert.deepEqual([out.json.imported, out.json.toUpload], [2, 2]);
    await new Promise((res) => { setTimeout(res, 150); });
    assert.equal(created.length, 2);
    assert.equal(created[0].exercise.exerciseType, 'STRENGTH_TRAINING');
    assert.match(created[0].exercise.notes, /Imported from Hevy/);
    await p.c.call('POST', '/api/workouts/import/hevy?upload=1', csv);
    await new Promise((res) => { setTimeout(res, 100); });
    assert.equal(created.length, 2, 'a second import uploads nothing');
    const w = (await p.c.get('/api/workouts')).json;
    assert.deepEqual(w.history.map((x) => [x.title, x.source, x.google.state, x.sets.sets]), [['Push Day', 'hevy', 'saved', 5], ['Leg Day', 'hevy', 'saved', 1]]);
    // The week the file's sessions fall in (5-11 Oct), not whatever week today is:
    // this test must not start failing as the calendar moves on.
    const wk = w.strength.weeks.find((x) => x.sets > 0);
    assert.equal(wk.sets, 6);
    assert.equal(wk.byMuscle.chest, 40 * 10 + 70 * 8 + 70 * 6);
    assert.equal(wk.byMuscle.legs, 500);
    assert.ok(w.strength.exercises.some((e) => e.name === 'Bench Press (Barbell)' && e.bestKg === 70));
    const big = await p.c.call('POST', '/api/workouts/import/hevy', { raw: `${HEAD}\n${'x'.repeat(5 * 1024 * 1024 + 10)}`, headers: { 'content-type': 'text/csv' } });
    assert.deepEqual([big.status, big.json.code], [413, 'too_large']);
    assert.equal((await p.c.call('POST', '/api/workouts/import/hevy', { raw: 'not,a,hevy,file\n1,2,3,4' })).status, 400);
  } finally { await r.close(); }
});
