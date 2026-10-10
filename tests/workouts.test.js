import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { detect, detectSettings, minuteSeries, calmSince, MIN } from '../server/core/detect.js';
import { Workouts, exercisePayload, EXERCISE_TYPE, pointName } from '../server/core/workouts.js';
import { parseHrWindows } from '../server/core/parse.js';
import { utcOffsetSec } from '../server/core/util.js';

const TZ = 'Africa/Cairo';
const T0 = Date.parse('2026-10-08T14:00:00Z');       // 17:00 in Cairo (EEST, +03:00)
const at = (i) => T0 + i * MIN;

/* A day, minute by minute: desk 17:00–17:59, machines 18:00–19:09
   (three-minute sets at 125, a one-minute dip to 100 between them, now
   and then a minute walking to the next machine), desk again after. */
const desk = () => [80, 0];
const gym = (i) => (i % 5 === 3 ? [100, 0] : i % 15 === 14 ? [112, 85] : [125, 5]);
function day(fn, n = 240) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const v = fn(i);
    if (v) out.push({ t: at(i), hr: v[0], hrMax: v[0] + 4, steps: v[1] });
  }
  return out;
}
const session = (i) => (i >= 60 && i < 130 ? gym(i - 60) : desk());
const upTo = (series, k) => series.filter((m) => m.t < at(k));

function rig({ settings = {}, external = [], canWrite = true, rest = 72, api = {} } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const clock = { t: at(0) };
  const written = { create: [], patch: [], remove: [] };
  const w = new Workouts({
    db,
    tz: TZ,
    now: () => clock.t,
    settings: () => settings,
    rest: () => rest,
    external: () => external,
    emit: (id, title, body, extra) => sent.push({ id, title, body, ...extra }),
    canWrite: () => (typeof canWrite === 'function' ? canWrite() : canWrite),
    api: {
      series: async (a, b) => day(session).filter((m) => m.t >= a && m.t < b),
      calories: async () => 412.5,
      device: async () => ({ lastSync: clock.t }),
      create: async (dp) => { written.create.push(dp); return { done: true, response: { name: dp.name || 'users/me/dataTypes/exercise/dataPoints/server-1' } }; },
      patch: async (name, dp) => { written.patch.push({ name, dp }); return { done: true, response: { name } }; },
      remove: async (names) => { written.remove.push(names); return { done: true }; },
      ...api,
    },
  });
  /** Data up to minute k, arriving `lag` minutes later. */
  const poll = (series, k, lag = 3) => { clock.t = at(k + lag); return w.evaluate(upTo(series, k), { now: clock.t }); };
  return { db, w, sent, clock, poll, written };
}
const rows = (db) => db.workoutsSince(0);

/* ── detection ───────────────────────────────────────────────────── */

test('a machines session with set/rest dips is one workout with the right start and end', () => {
  const g = detect(day(session), { rest: 72 });
  assert.equal(g.length, 1);
  assert.equal(g[0].start, at(60));
  assert.equal(g[0].end, at(130));
  assert.equal(g[0].ongoing, false);
  assert.ok(g[0].avgHr > 110 && g[0].maxHr >= 125);
});

test('a brisk walk is not a workout: heart rate up, but every minute is walking', () => {
  const walk = day((i) => (i >= 60 && i < 110 ? [118, 110] : desk()));
  assert.deepEqual(detect(walk, { rest: 72 }), []);
});

test('a short spike is not a workout', () => {
  const spike = day((i) => (i >= 60 && i < 66 ? [130, 0] : desk()));
  const g = detect(spike, { rest: 72 });
  assert.ok(g.every((x) => x.activeMin < 10));
  const { w, poll, sent } = rig();
  poll(spike, 120);
  assert.equal(rows(w.db).length, 0);
  assert.equal(sent.length, 0);
});

test('a desk day of isolated raised minutes is not strung into a session', () => {
  // A raised minute every 8 minutes, all afternoon: under the 50% density rule.
  const s = day((i) => (i % 8 === 0 ? [115, 0] : [85, 0]));
  assert.deepEqual(detect(s, { rest: 72 }), []);
});

test('an Air session over the same period hides it from detection', () => {
  const air = [{ start: at(55), end: at(135), kind: 'exercise', id: 'users/1/dataTypes/exercise/dataPoints/9' }];
  const { w, poll, sent } = rig({ external: air });
  for (let k = 70; k <= 160; k += 10) poll(day(session), k);
  assert.equal(rows(w.db).length, 0);
  assert.equal(sent.length, 0);
});

test('next to a gym session already in Google (logged late): the rest of it is not asked about', () => {
  const logged = [{ start: at(70), end: at(130), kind: 'exercise', type: 'WEIGHT_MACHINES', id: 'users/1/dataTypes/exercise/dataPoints/5' }];
  const { w, poll, sent } = rig({ external: logged });
  for (let k = 62; k <= 160; k += 2) poll(day(session), k);
  assert.equal(rows(w.db).length, 0);
  assert.equal(sent.length, 0);
});

test('the walk to the gym, recorded by the Air, right before the session does not hide it', () => {
  const walk = [{ start: at(35), end: at(60) - 6000, kind: 'exercise', type: 'POWER_WALKING', id: 'users/1/dataTypes/exercise/dataPoints/6' }];
  const s = day((i) => (i >= 35 && i < 60 ? [125, 110] : session(i)));
  const { w, poll, sent } = rig({ external: walk });
  for (let k = 62; k <= 160; k += 2) poll(s, k);
  const r = rows(w.db);
  assert.equal(r.length, 1);
  assert.equal(r[0].start, at(60));
  assert.deepEqual(sent.map((x) => x.id), ['workout_start', 'workout_end']);
});

test('a phantom 3-second session does not cut a workout in two', () => {
  const blip = [{ start: at(90), end: at(90) + 3000, kind: 'exercise', id: 'x/9' }];
  const { w, poll } = rig({ external: blip });
  for (let k = 70; k <= 160; k += 10) poll(day(session), k);
  const r = rows(w.db);
  assert.equal(r.length, 1);
  assert.equal(r[0].start, at(60));
  assert.equal(r[0].end, at(130));
});

test('settings are clamped', () => {
  const s = detectSettings({ plusBpm: 500, calmMin: 1, enabled: 'false' });
  assert.equal(s.plusBpm, 60);
  assert.equal(s.calmMin, 5);
  assert.equal(s.enabled, false);
});

test('roll-up windows become a minute series', () => {
  const hr = parseHrWindows([
    { startTime: '2026-10-08T15:01:00Z', endTime: '2026-10-08T15:02:00Z', heartRate: { beatsPerMinuteAvg: 120.5, beatsPerMinuteMax: 131 } },
    { startTime: '2026-10-08T15:00:00Z', endTime: '2026-10-08T15:01:00Z', heartRate: {} },
  ]);
  const s = minuteSeries(hr, [{ start: Date.parse('2026-10-08T15:00:00Z'), end: 0, steps: 12 }]);
  assert.deepEqual(s.map((m) => [m.hr, m.steps]), [[null, 12], [120.5, 0]]);
});

/* ── the prompts ─────────────────────────────────────────────────── */

test('"started?" once while it is going, "ended?" once when calm — and a restart says nothing again', () => {
  const s = day(session);
  const { db, w, poll, sent } = rig();
  poll(s, 66);                                   // 6 active minutes: not yet
  assert.equal(sent.length, 0);
  poll(s, 75);
  assert.deepEqual(sent.map((x) => x.id), ['workout_start']);
  assert.match(sent[0].body, /started at 18:00/);
  assert.match(sent[0].url, /^\/workouts\/\d+$/);
  for (let k = 80; k <= 135; k += 5) poll(s, k);  // through the end, not calm long enough yet
  assert.equal(sent.length, 1);
  poll(s, 141);
  assert.deepEqual(sent.map((x) => x.id), ['workout_start', 'workout_end']);
  assert.match(sent[1].body, /18:00 to 19:10 \(70 min\)/);
  assert.equal(sent[0].tag, sent[1].tag);         // the end replaces the start on the phone
  // A restart: a new instance on the same store, the same data, polled again.
  const again = new Workouts({ db, tz: TZ, now: () => at(150), settings: () => ({}), rest: () => 72, external: () => [], emit: (...a) => sent.push(a), canWrite: () => true, api: {} });
  again.evaluate(upTo(s, 150), { now: at(150) });
  again.evaluate(upTo(s, 160), { now: at(160) });
  poll(s, 170);
  assert.equal(sent.length, 2);
  const r = rows(db);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'review');
});

test('a start seen only after it ended (late phone sync): no "started?", one "ended?" with both times', () => {
  const { w, poll, sent } = rig();
  poll(day(session), 150, 2);
  assert.deepEqual(sent.map((x) => x.id), ['workout_end']);
  assert.match(sent[0].body, /18:00 to 19:10/);
  assert.equal(rows(w.db)[0].status, 'review');
});

test('a start that arrives over an hour late is not asked about; the end is', () => {
  const { poll, sent, w } = rig();
  // Data up to minute 100 (still going), but it is 19:45 now: the phone was offline.
  poll(day(session), 100, 50);
  assert.equal(sent.length, 0);
  assert.match(rows(w.db)[0].prompts.start, /skipped/);
  poll(day(session), 150, 5);
  assert.deepEqual(sent.map((x) => x.id), ['workout_end']);
});

test('no "started?" in the middle of the night', () => {
  // 02:00 Cairo = 23:00Z the day before.
  const night = Date.parse('2026-10-07T23:00:00Z');
  const s = day(session).map((m) => ({ ...m, t: m.t - T0 + night - 60 * MIN }));
  const { w, sent, clock } = rig();
  clock.t = night + 20 * MIN;
  w.evaluate(s.filter((m) => m.t < night + 17 * MIN), { now: clock.t });
  assert.equal(sent.length, 0);
  assert.equal(rows(w.db).length, 1);
  assert.equal(rows(w.db)[0].prompts.start, 'skipped: night');
});

test('rest dips do not end it; a rise right after it ended is its tail, not a second workout', () => {
  // The session, then 20 min calm, then 15 min at 112 bpm sitting (recovery,
  // the drive home) — inside 3 × calm of the end.
  const s = day((i) => (i >= 60 && i < 130 ? gym(i - 60) : i >= 142 && i < 157 ? [112, 0] : desk()));
  const { w, poll, sent } = rig();
  for (let k = 70; k <= 200; k += 5) poll(s, k);
  assert.equal(rows(w.db).length, 1);
  assert.deepEqual(sent.map((x) => x.id), ['workout_start', 'workout_end']);
});

test('a second real session later the same day is its own workout', () => {
  const s = day((i) => (i >= 60 && i < 130 ? gym(i - 60) : i >= 200 && i < 240 ? gym(i - 200) : desk()), 300);
  const { w, poll } = rig();
  for (let k = 70; k <= 290; k += 5) poll(s, k);
  assert.equal(rows(w.db).length, 2);
});

test('the same period logged elsewhere meanwhile: the pending one steps aside, no "ended?"', () => {
  const ext = [];
  const { w, poll, sent } = rig({ external: ext });
  poll(day(session), 80);
  assert.equal(sent.length, 1);
  ext.push({ start: at(58), end: at(131), kind: 'exercise', id: 'users/1/dataTypes/exercise/dataPoints/77' });
  for (let k = 90; k <= 160; k += 10) poll(day(session), k);
  assert.equal(sent.length, 1);
  assert.equal(rows(w.db)[0].status, 'superseded');
});

/* ── by hand ─────────────────────────────────────────────────────── */

test('a workout started by hand covers its time: no "started?", no second detection, no "ended?" after ending it', () => {
  const s = day(session);
  const { w, poll, sent, clock } = rig();
  clock.t = at(58);
  const r = w.startNow();
  assert.throws(() => w.startNow(), /already running/);
  for (let k = 70; k <= 128; k += 5) poll(s, k);
  assert.equal(sent.length, 0);
  clock.t = at(131);
  w.end(r.id);
  for (let k = 135; k <= 200; k += 5) poll(s, k);
  assert.equal(sent.length, 0);
  const all = rows(w.db);
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'done');
  assert.equal(all[0].google.state, 'pending');
});

test('starting by hand while a detection is open folds it in', () => {
  const s = day(session);
  const { w, poll, sent, clock } = rig();
  poll(s, 75);
  assert.equal(sent.length, 1);
  clock.t = at(79);
  w.startNow();
  for (let k = 80; k <= 180; k += 5) poll(s, k);
  const st = rows(w.db).map((x) => x.status).sort();
  assert.deepEqual(st, ['merged', 'running']);
  assert.equal(sent.length, 1);
});

test('a confirmed start is followed to its end, asked once', () => {
  const s = day(session);
  const { w, poll, sent } = rig();
  poll(s, 75);
  const id = rows(w.db)[0].id;
  w.confirmStart(id);
  assert.equal(w.get(id).status, 'running');
  for (let k = 80; k <= 170; k += 5) poll(s, k);
  assert.deepEqual(sent.map((x) => x.id), ['workout_start', 'workout_end']);
  assert.equal(w.get(id).status, 'review');
  assert.equal(w.get(id).end, at(130));
});

test('answering "started?" after the end was found does not duplicate anything', () => {
  const s = day(session);
  const { w, poll } = rig();
  poll(s, 75);
  for (let k = 80; k <= 150; k += 5) poll(s, k);
  const id = rows(w.db)[0].id;
  const r = w.confirmStart(id);
  assert.equal(r.status, 'review');
  w.confirmStart(id);
  w.save(id, {});
  w.confirmStart(id);
  assert.equal(rows(w.db).length, 1);
  assert.equal(w.get(id).status, 'done');
});

test('"not a workout" while it is going: quiet for the rest of it, and afterwards', () => {
  const s = day(session);
  const { w, poll, sent } = rig();
  poll(s, 75);
  w.dismiss(rows(w.db)[0].id);
  for (let k = 80; k <= 200; k += 5) poll(s, k);
  assert.equal(sent.length, 1);
  const r = rows(w.db);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'dismissed');
  assert.equal(r[0].quiet, 'closed');
  assert.equal(r[0].end, at(130));
});

test('a hand-started workout left running is closed after a long calm — for review, never saved silently', () => {
  const s = day(session, 300);
  const { w, poll, sent, clock } = rig();
  clock.t = at(60);
  const r = w.startNow();
  for (let k = 70; k <= 185; k += 5) poll(s, k);
  assert.equal(w.get(r.id).status, 'running');     // calm since 19:10, but not for 60 min yet
  for (let k = 190; k <= 260; k += 5) poll(s, k);
  const x = w.get(r.id);
  assert.equal(x.status, 'review');
  assert.equal(x.end, at(130));
  assert.equal(x.autoClosed, 'calm');
  assert.deepEqual(sent.map((y) => y.id), ['workout_end']);
  assert.match(sent[0].body, /calm since 19:10/);
  assert.equal(x.google, null);
});

test('calmSince finds the last raised minute after a start', () => {
  const c = calmSince(day(session), { from: at(60), rest: 72, plusBpm: 35, autoCloseMin: 60 });
  assert.equal(c.lastActive, at(130));
  assert.equal(c.calm, true);
});

test('log a past workout; overlaps are refused; times are validated', () => {
  const { w, clock } = rig();
  clock.t = at(300);
  const r = w.logPast({ start: at(60), end: at(130) });
  assert.equal(r.status, 'done');
  assert.throws(() => w.logPast({ start: at(100), end: at(160) }), /overlaps/);
  assert.throws(() => w.logPast({ start: at(200), end: at(202) }), /at least 5 minutes/);
  assert.throws(() => w.logPast({ start: at(250), end: at(400) }), /future/);
});

/* ── to Google ───────────────────────────────────────────────────── */

test('the write payload: the person\'s exercise type, the interval with Cairo offsets, only real numbers', () => {
  const w0 = { start: Date.parse('2026-10-08T15:00:00Z'), end: Date.parse('2026-10-08T16:10:00Z'), avgHr: 118.4, steps: 412, kcal: null, source: 'detected' };
  const p = exercisePayload(w0, { tz: TZ, name: pointName('0b1c6d4e-6f0a-4c59-9a55-3a1d3c1f7e21'), type: 'WEIGHT_MACHINES' });
  assert.equal(p.exercise.exerciseType, 'WEIGHT_MACHINES');
  assert.equal(p.exercise.displayName, 'Weight machines');
  // A new person's default is generic strength; a type that is not in the
  // enum falls back to it rather than reaching Google.
  assert.equal(EXERCISE_TYPE, 'STRENGTH_TRAINING');
  assert.equal(exercisePayload(w0, { tz: TZ }).exercise.exerciseType, 'STRENGTH_TRAINING');
  assert.equal(exercisePayload(w0, { tz: TZ, type: 'NOT_A_TYPE' }).exercise.exerciseType, 'STRENGTH_TRAINING');
  // A type set on the workout itself wins over the person's default.
  assert.equal(exercisePayload({ ...w0, type: 'CROSSFIT', title: 'Friday WOD' }, { tz: TZ }).exercise.displayName, 'Friday WOD');
  assert.deepEqual(p.exercise.interval, { startTime: '2026-10-08T15:00:00Z', startUtcOffset: '10800s', endTime: '2026-10-08T16:10:00Z', endUtcOffset: '10800s' });
  assert.equal(p.exercise.activeDuration, '4200s');
  assert.deepEqual(p.exercise.metricsSummary, { averageHeartRateBeatsPerMinute: '118', steps: '412' });
  assert.equal(p.dataSource.recordingMethod, 'MANUAL');
  assert.match(p.name, /^users\/me\/dataTypes\/exercise\/dataPoints\/[a-z0-9-]{4,63}$/);
  // Winter: Cairo is +02:00.
  assert.equal(utcOffsetSec(Date.parse('2026-01-10T12:00:00Z'), TZ), 7200);
});

test('saving waits for the write permission, then goes; edits patch, delete removes', async () => {
  let granted = false;
  const { w, written, clock } = rig({ canWrite: () => granted });
  clock.t = at(300);
  const r = w.logPast({ start: at(60), end: at(130) });
  await w.flush();
  assert.equal(w.get(r.id).google.state, 'needs_scope');
  assert.equal(written.create.length, 0);
  granted = true;
  await w.flush();
  const x = w.get(r.id);
  assert.equal(x.google.state, 'saved');
  assert.equal(written.create.length, 1);
  const dp = written.create[0];
  assert.equal(dp.exercise.exerciseType, 'STRENGTH_TRAINING');
  // Named from the uid alone: the linked console module derives the same
  // name, so the two can never create two points for one workout.
  assert.equal(dp.name, pointName(x.uid));
  assert.equal(dp.exercise.metricsSummary.caloriesKcal, 412.5);
  assert.ok(Number(dp.exercise.metricsSummary.averageHeartRateBeatsPerMinute) > 100);
  assert.equal(x.google.name, dp.name);
  await w.flush();
  assert.equal(written.create.length, 1);          // nothing twice
  w.save(r.id, { start: at(62), end: at(130) });
  await w.flush();
  assert.equal(written.patch.length, 1);
  assert.equal(written.patch[0].name, x.google.name);
  assert.equal(written.patch[0].dp.exercise.interval.startTime, new Date(at(62)).toISOString().replace('.000Z', 'Z'));
  await w.remove(r.id);
  assert.deepEqual(written.remove, [[x.google.name]]);
  assert.equal(w.get(r.id).status, 'deleted');
});

test('a failed write is kept with its reason and retried later', async () => {
  let fail = true;
  const { w, clock, written } = rig({ api: { create: async (dp) => { if (fail) throw Object.assign(new Error('backend error'), { status: 500 }); written.create.push(dp); return { done: true, response: { name: dp.name } }; } } });
  clock.t = at(300);
  const r = w.logPast({ start: at(60), end: at(130) });
  await w.flush();
  assert.equal(w.get(r.id).google.state, 'failed');
  assert.equal(w.get(r.id).google.error, 'backend error');
  fail = false;
  await w.flush();
  assert.equal(w.get(r.id).google.state, 'failed');  // backing off
  clock.t += 16 * MIN;
  await w.flush();
  assert.equal(w.get(r.id).google.state, 'saved');
});

test('the console switched a prompt off: nothing is sent, and it is not sent later either', () => {
  const s = day(session);
  const db = openDb(':memory:');
  const sent = [];
  let on = false;
  const w = new Workouts({ db, tz: TZ, now: () => at(80), settings: () => ({}), rest: () => 72, external: () => [], emit: (...a) => sent.push(a), notifyOn: () => on, canWrite: () => true, api: {} });
  w.evaluate(upTo(s, 76), { now: at(80) });
  on = true;
  w.evaluate(upTo(s, 78), { now: at(80) });
  assert.equal(sent.length, 0);
  assert.equal(rows(db)[0].prompts.start, 'off');
});

test('detection off: nothing is detected, but hand-started workouts still work', () => {
  const { w, poll, sent, clock } = rig({ settings: { enabled: false } });
  for (let k = 70; k <= 160; k += 10) poll(day(session), k);
  assert.equal(rows(w.db).length, 0);
  clock.t = at(170);
  w.startNow();
  assert.equal(rows(w.db).length, 1);
  assert.equal(sent.length, 0);
});
