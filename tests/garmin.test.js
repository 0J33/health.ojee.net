/* Garmin, read directly (server/garmin.js, server/garminsync.js), against
   the stand-in Personal API (server/fake-sources.js): the key swapped for
   a token, the readers on good and odd answers, what a pass writes and
   where, history a week at a time, a 429 and a refused read, a key that
   stops working, Google and Garmin together, the routes, and the key and
   token never leaving. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { openDb } from '../server/core/db.js';
import { addDays, today as todayIn } from '../server/core/util.js';
import {
  swapKey, jwtExp, keyShape, gmt, GarminApi, GarminError, readDays, readStress, readSteps, readHrv, readBattery, readSleep, readHeart, readSpo2, readWeights, readActivities,
} from '../server/garmin.js';
import { syncGarmin, garminMeta, setGarminMeta, GARMIN_DAILY } from '../server/garminsync.js';
import { fakeGarmin, GARMIN_TEST_KEY } from '../server/fake-sources.js';
import { mergeAll } from '../server/core/merge.js';
import { briefing } from '../server/ai.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };
const TZ = 'Africa/Cairo';
const jwt = (o) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(o)).toString('base64url')}.x`;

/** A person with Garmin connected, history read in full. */
async function garminPerson(name, { passes = 4, body = {} } = {}) {
  const p = await r.person(name, { tz: TZ });
  const v = await ok(await p.c.post('/api/garmin/connect', { key: GARMIN_TEST_KEY, keyDays: 90, ...body }));
  assert.equal(v.connected, true);
  for (let i = 0; i < passes; i += 1) await r.app.syncUser(p.id);
  return p;
}

/* ── the token ───────────────────────────────────────────────────────── */

test('the key is swapped for a token: its exp read from the JWT, a refusal said plainly', async () => {
  const g = fakeGarmin({ now: () => Date.now() });
  const t = await swapKey(GARMIN_TEST_KEY, { fetchImpl: g.fetch });
  assert.ok(t.token.split('.').length === 3 && t.expKnown);
  assert.ok(Math.abs(t.expiresAt - (Date.now() + 24 * 3_600_000)) < 2000, 'a day, from the token itself');
  assert.equal(g.state.calls[0], 'POST /personalapitoken-service/personal-api/personal-api-key/token');
  await assert.rejects(swapKey('wrong-key-wrong-key-1', { fetchImpl: g.fetch }), (e) => e instanceof GarminError && e.code === 'garmin_key' && /expired or been deleted/.test(e.message));
  // A 429 carries Garmin's Retry-After.
  const limited = async () => new Response('', { status: 429, headers: { 'retry-after': '90' } });
  await assert.rejects(swapKey(GARMIN_TEST_KEY, { fetchImpl: limited }), (e) => e.code === 'rate_limited' && e.retryAfterMs === 90_000);
  await assert.rejects(swapKey(GARMIN_TEST_KEY, { fetchImpl: async () => { throw new Error('down'); } }), (e) => e.code === 'network');
  // A token that is not a JWT is still used, for a little under a day.
  const plain = await swapKey(GARMIN_TEST_KEY, { fetchImpl: async () => new Response('opaque-token-123') });
  assert.equal(plain.expKnown, false);
  assert.ok(plain.expiresAt > Date.now() + 22 * 3_600_000);
  assert.equal(jwtExp(jwt({ exp: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(jwtExp('not.a-jwt'), null);
  assert.ok(keyShape(GARMIN_TEST_KEY) && !keyShape('short') && !keyShape('has spaces in it here'));
});

test('a token Garmin stops taking is swapped again once; a second refusal is the key', async () => {
  const g = fakeGarmin({ now: () => Date.now() });
  const tokens = [];
  const api = new GarminApi({ key: GARMIN_TEST_KEY, fetchImpl: g.fetch, gapMs: 0, onToken: (t) => tokens.push(t) });
  assert.ok((await api.profile()).id);
  g.expireTokens();
  assert.ok((await api.profile()).id, 'swapped again and carried on');
  assert.equal(tokens.length, 2);
  g.expireTokens(); g.refuseKey();
  await assert.rejects(api.profile(), (e) => e.code === 'garmin_key');
  // A token near its end is not used: it is swapped before.
  g.acceptKey();
  const late = new GarminApi({ key: GARMIN_TEST_KEY, token: { token: 'old', expiresAt: Date.now() + 30 * 60_000 }, fetchImpl: g.fetch, gapMs: 0 });
  await late.profile();
  assert.notEqual(late.tok.token, 'old');
});

/* ── the readers ─────────────────────────────────────────────────────── */

test('the readers: Garmin Connect\'s shapes become this site\'s rows', () => {
  const days = readDays({ data: [{ calendarDate: '2026-10-30', totalSteps: 9120, totalDistanceMeters: 6931, totalKilocalories: 2210, activeKilocalories: 520, bmrKilocalories: 1690, floorsAscended: 7.6,
    moderateIntensityMinutes: 20, vigorousIntensityMinutes: 10, restingHeartRate: 55, minHeartRate: 49, maxHeartRate: 161, averageStressLevel: 31, maxStressLevel: 88,
    restStressDuration: 21600, lowStressDuration: 14400, mediumStressDuration: 3600, highStressDuration: 900, bodyBatteryHighestValue: 92, bodyBatteryLowestValue: 15,
    bodyBatteryChargedValue: 70, bodyBatteryDrainedValue: 66, averageSpo2: 95, lowestSpo2: 88, sedentarySeconds: 36000 }] });
  assert.deepEqual(days['2026-10-30'], {
    steps: 9120, distance_m: 6931, kcal: 2210, kcal_active: 520, kcal_basal: 1690, floors: 8, active_min: 30, azm: 40, rhr: 55, hr_min: 49, hr_max: 161,
    stress: 31, stress_max: 88, stress_rest: 360, stress_low: 240, stress_medium: 60, stress_high: 15, bb_high: 92, bb_low: 15, bb_charged: 70, bb_drained: 66, spo2: 95, spo2_min: 88, sedentary_min: 600,
  });
  for (const k of Object.keys(days['2026-10-30'])) assert.ok(GARMIN_DAILY.includes(k), k);
  // "Not enough data" is -1 or -2 at Garmin: not a number here.
  assert.equal(readDays([{ calendarDate: '2026-10-29', averageStressLevel: -1, totalSteps: 10 }])['2026-10-29'].stress, undefined);
  assert.deepEqual(readStress([{ calendarDate: '2026-10-30', values: { overallStressLevel: 27, restStressDuration: 600, lowStressDuration: 1200, mediumStressDuration: 0, highStressDuration: 60 } }])['2026-10-30'],
    { stress: 27, stress_rest: 10, stress_low: 20, stress_medium: 0, stress_high: 1 });
  assert.deepEqual(readSteps([{ calendarDate: '2026-10-30', totalSteps: 5, totalDistance: 4 }]), { '2026-10-30': { steps: 5, distance_m: 4 } });
  assert.deepEqual(readHrv({ hrvSummaries: [{ calendarDate: '2026-10-30', lastNightAvg: 47, weeklyAvg: 45, status: 'BALANCED' }] }), { '2026-10-30': { hrv: 47 } });
  // Body Battery: with its descriptors, or as plain [t, level] pairs.
  const t0 = Date.parse('2026-10-30T00:00:00Z');
  const bb = readBattery([{ date: '2026-10-30', charged: 50, drained: 40, bodyBatteryValuesArray: [[t0, 'MEASURED', 30, 3], [t0 + 3_600_000, 'MEASURED', 80, 3]],
    bodyBatteryValueDescriptorDTOList: [{ bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: 'timestamp' }, { bodyBatteryValueDescriptorIndex: 2, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' }] }]);
  assert.deepEqual(bb['2026-10-30'], { points: [[t0, 30], [t0 + 3_600_000, 80]], bb_charged: 50, bb_drained: 40, bb_high: 80, bb_low: 30 });
  assert.deepEqual(readBattery([{ date: '2026-10-31', bodyBatteryValuesArray: [[t0, 44]] }])['2026-10-31'].points, [[t0, 44]]);
  // A night: stages from the levels (0 deep, 1 light, 2 REM, 3 awake), the offset from the local times.
  const s0 = Date.parse('2026-10-29T21:00:00Z');
  const night = readSleep({
    dailySleepDTO: { calendarDate: '2026-10-30', sleepStartTimestampGMT: s0, sleepEndTimestampGMT: s0 + 8 * 3_600_000, sleepStartTimestampLocal: s0 + 2 * 3_600_000, sleepEndTimestampLocal: s0 + 10 * 3_600_000,
      sleepTimeSeconds: 7 * 3600, deepSleepSeconds: 5400, lightSleepSeconds: 14400, remSleepSeconds: 5400, awakeSleepSeconds: 3600, awakeCount: 2, averageRespirationValue: 14.2, averageSpO2Value: 94, lowestSpO2Value: 87,
      sleepScores: { overall: { value: 81, qualifierKey: 'GOOD' } } },
    sleepLevels: [{ startGMT: '2026-10-29T21:00:00.0', endGMT: '2026-10-29T22:00:00.0', activityLevel: 1 }, { startGMT: '2026-10-29T22:00:00.0', endGMT: '2026-10-29T23:30:00.0', activityLevel: 0 }, { startGMT: '2026-10-29T23:30:00.0', endGMT: '2026-10-30T00:00:00.0', activityLevel: 2 }],
    restingHeartRate: 53, avgOvernightHrv: 49,
  });
  assert.equal(night.date, '2026-10-30');
  assert.deepEqual([night.row.startOff, night.row.endOff, night.row.asleepMin, night.row.awakeMin, night.row.periodMin, night.row.main], [7200, 7200, 420, 60, 480, true]);
  assert.deepEqual(night.row.stages.map((x) => x.t), ['LIGHT', 'DEEP', 'REM']);
  assert.deepEqual(night.row.summary.stages, { DEEP: 90, LIGHT: 240, REM: 90, AWAKE: 60 });
  assert.equal(night.row.summary.deviceScore, 81);
  assert.deepEqual(night.night, { resp: 14.2, spo2: 94, spo2_min: 87, rhr: 53, hrv: 49, garmin_sleep_score: 81 });
  // A day's heart rate by the hour.
  const h0 = Date.parse('2026-10-30T10:00:00Z');
  const hr = readHeart({ calendarDate: '2026-10-30', restingHeartRate: 55, heartRateValues: [[h0, 60], [h0 + 120_000, 80], [h0 + 3_600_000, 100], [h0 + 3_700_000, null]] });
  assert.deepEqual(hr.daily, { rhr: 55, hr_min: 60, hr_max: 100, hr_avg: 80 });
  assert.deepEqual(hr.hours.map((x) => [x.min, x.max, x.avg]), [[60, 80, 70], [100, 100, 100]]);
  assert.deepEqual(hr.latest, { t: h0 + 3_600_000, bpm: 100 });
  assert.deepEqual(readSpo2({ calendarDate: '2026-10-30', avgSleepSpO2: 94, lowestSpO2: 86 }), { date: '2026-10-30', spo2: 94, spo2_min: 86 });
  // Weigh-ins in grams (Garmin's own), or in kilograms.
  assert.deepEqual(readWeights({ dailyWeightSummaries: [{ allWeightMetrics: [{ samplePk: 1, timestampGMT: t0, weight: 72400, bodyFat: 18.2 }, { timestampGMT: t0 + 1, weight: 72.1 }] }] }).map((w) => [w.grams, w.fatPct]), [[72400, 18.2], [72100, null]]);
  // An activity: its type in Google's words, zones, moving time, pace for a run.
  const [a] = readActivities([{ activityId: 42, activityName: 'Morning Run', activityType: { typeKey: 'trail_running' }, startTimeGMT: '2026-10-30 05:00:00', startTimeLocal: '2026-10-30 07:00:00',
    elapsedDuration: 1800, movingDuration: 1700, calories: 300, averageHR: 150, distance: 5000, averageSpeed: 2.9, steps: 4800, hrTimeInZone_1: 60, hrTimeInZone_2: 120, hrTimeInZone_3: 600, hrTimeInZone_4: 900, hrTimeInZone_5: 120 }]);
  assert.deepEqual([a.id, a.type, a.name, a.date, a.endMs - a.startMs, a.kcal, a.avgHr, a.distanceM, a.activeSec, a.paceSecPerKm, a.device], ['garmin-42', 'RUNNING', 'Morning Run', '2026-10-30', 1_800_000, 300, 150, 5000, 1700, 345, 'Garmin']);
  assert.deepEqual(a.zones, { light: 3, moderate: 10, vigorous: 15, peak: 2 });
  assert.equal(readActivities([{ activityId: 7, activityType: { typeKey: 'underwater_basket_weaving' }, startTimeGMT: '2026-10-30 05:00:00', duration: 600 }])[0].type, 'WORKOUT');
  assert.equal(gmt('2026-10-30 05:00:00'), Date.parse('2026-10-30T05:00:00Z'));
  assert.equal(gmt(1_793_000_000), 1_793_000_000_000);
});

test('odd answers never throw: a shape that is not as expected is noted by its keys only', () => {
  const notes = [];
  const note = (where, v) => notes.push([where, Object.keys(v || {}).join(',')]);
  for (const odd of [null, {}, { unexpected: { secret: 'x' } }, 'text', 42, [null, 7, 'x', { calendarDate: 'not a date' }]]) {
    assert.doesNotThrow(() => {
      readDays(odd, note); readStress(odd, note); readSteps(odd, note); readHrv(odd, note); readBattery(odd, note); readSleep(odd, { note }); readHeart(odd, note);
      readSpo2(odd, note); readWeights(odd, note); readActivities(odd, { note });
    });
  }
  assert.ok(notes.some(([w, k]) => w === 'dailysummaries' && k === 'unexpected'));
  assert.ok(notes.every(([, k]) => !/secret|x$/.test(k) || k === 'unexpected'), 'keys, never values');
  // A day whose fields are all renamed gives nothing rather than wrong numbers.
  assert.deepEqual(readDays([{ calendarDate: '2026-10-30', stepsWalked: 9 }]), { '2026-10-30': {} });
});

/* ── a pass ──────────────────────────────────────────────────────────── */

test('a pass writes Garmin\'s numbers into the Garmin store, in the shapes Google\'s sync uses', async () => {
  const now = Date.now();
  const g = fakeGarmin({ now: () => now, tz: TZ });
  const main = openDb(':memory:'); const src = openDb(':memory:');
  setGarminMeta(main, { connected: true });
  const logs = [];
  const api = new GarminApi({ key: GARMIN_TEST_KEY, fetchImpl: g.fetch, gapMs: 0 });
  const out = await syncGarmin({ main, src, api, tz: TZ, now: () => now, log: (m) => logs.push(m) });
  assert.equal(out.ok, true, out.message);
  const today = todayIn(now, TZ);
  const t = src.dailyTable(addDays(today, -40));
  const y = t[addDays(today, -1)];
  for (const k of ['steps', 'kcal', 'kcal_active', 'rhr', 'hrv', 'spo2', 'resp', 'stress', 'stress_rest', 'stress_high', 'bb_high', 'bb_low', 'hr_avg', 'garmin_sleep_score', 'azm', 'active_min', 'floors']) assert.ok(Number.isFinite(y[k]), `yesterday ${k}`);
  assert.ok(Object.keys(t).every((d) => d >= addDays(today, -9)), 'the first pass reads the last week and a little more');
  const nights = src.sleeps('0000-00-00');
  assert.ok(nights.length >= 2 && nights.every((n) => n.id.startsWith('garmin-sleep-') && n.stages.length > 3 && n.summary.stages.DEEP > 0));
  const ex = src.exercises('0000-00-00');
  assert.ok(ex.length >= 1 && ex.every((e) => e.id.startsWith('garmin-') && ['BIKING', 'RUNNING'].includes(e.type) && e.avgHr > 0 && e.device === 'Garmin'));
  assert.ok(src.weights(0).every((w) => w.source === 'garmin'));
  assert.ok(src.samples('hrhours', { limit: 10 }).length >= 2 && src.samples('bbday', { limit: 10 }).length >= 2);
  assert.ok(src.samples('hrhours', { limit: 1 })[0].source === 'garmin');
  assert.ok(src.meta('hr')?.bpm > 0 && src.meta('hrDense'), 'the newest pulse, and a watch\'s density');
  assert.equal(src.meta('device').name, 'Garmin');
  const m = garminMeta(main);
  assert.ok(m.lastSync && m.backTo && m.lastResult.ok);
  assert.ok(out.calls > 10 && out.calls < 60, `${out.calls} calls`);
  assert.deepEqual(logs, [], 'nothing odd to say about the stand-in\'s answers');
  // Once the history is in, the same pass again changes nothing.
  for (let i = 0; i < 5; i += 1) await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  const again = await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  assert.equal(again.wrote, 0);
});

test('history comes a week at a time until the chosen span is in; a 429 waits; a refused read is left for a day', async () => {
  let now = Date.now();
  const g = fakeGarmin({ now: () => now, tz: TZ });
  const main = openDb(':memory:'); const src = openDb(':memory:');
  setGarminMeta(main, { connected: true, settings: { backfill: 30 } });
  const api = new GarminApi({ key: GARMIN_TEST_KEY, fetchImpl: g.fetch, gapMs: 0, now: () => now });
  const today = todayIn(now, TZ);
  const target = addDays(today, -29);
  const backs = [];
  for (let i = 0; i < 6; i += 1) { await syncGarmin({ main, src, api, tz: TZ, now: () => now }); backs.push(garminMeta(main).backTo); }
  assert.deepEqual(backs, [addDays(today, -9), addDays(today, -16), addDays(today, -23), addDays(today, -29), target, target]);
  assert.ok(src.sleeps(target).some((n) => n.date === target), 'the oldest night asked for is in');
  assert.ok(!src.sleeps('0000-00-00').some((n) => n.date < target), 'and nothing older');
  // A 429: the pass stops, keeps what it read, and waits Garmin's Retry-After.
  g.limit(1, 600);
  const lim = await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  assert.deepEqual([lim.ok, lim.code], [false, 'rate_limited']);
  assert.equal(garminMeta(main).retryAt, now + 600_000);
  const skip = await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  assert.deepEqual([skip.skipped, skip.calls], [true, 0], 'the next pass does not knock');
  now += 601_000;
  assert.equal((await syncGarmin({ main, src, api, tz: TZ, now: () => now })).ok, true);
  assert.equal(garminMeta(main).retryAt, null);
  // HRV refused: the rest carries on, HRV is left a day.
  g.breakService('hrv-service');
  const part = await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  assert.equal(part.ok, true);
  assert.deepEqual(garminMeta(main).unavailable, { hrv: now });
  const before = g.state.calls.filter((c) => c.includes('hrv-service')).length;
  await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  assert.equal(g.state.calls.filter((c) => c.includes('hrv-service')).length, before, 'not asked again the same day');
  // An activity deleted in Garmin Connect goes here too.
  const gone = src.exercises('0000-00-00').at(-1);
  g.deleteActivity(Number(gone.id.slice(7)));
  await syncGarmin({ main, src, api, tz: TZ, now: () => now });
  assert.ok(!src.exercises('0000-00-00').some((e) => e.id === gone.id));
});

/* ── Google and Garmin together ──────────────────────────────────────── */

test('the fold: Garmin first or Google first, nothing added up, sessions once, Garmin\'s own numbers either way', () => {
  const main = openDb(':memory:'); const goog = openDb(':memory:'); const gar = openDb(':memory:');
  const d = '2026-10-30';
  goog.setDaily(d, 'steps', 3000); goog.setDaily(d, 'floors', 4); goog.setDaily(d, 'rhr', 60);
  gar.setDaily(d, 'steps', 9000); gar.setDaily(d, 'rhr', 55); gar.setDaily(d, 'stress', 30);
  const s0 = Date.parse('2026-10-29T21:00:00Z');
  goog.upsertSleep({ id: 'g-night', date: d, startMs: s0, endMs: s0 + 8 * 3_600_000, startOff: 0, endOff: 0, main: true, asleepMin: 450, awakeMin: 30, periodMin: 480, stages: [], summary: { stages: { DEEP: 60, REM: 80, LIGHT: 310 } } });
  gar.upsertSleep({ id: 'garmin-sleep-1', date: d, startMs: s0 + 600_000, endMs: s0 + 8 * 3_600_000, startOff: 0, endOff: 0, main: true, asleepMin: 420, awakeMin: 40, periodMin: 470, stages: [], summary: { stages: { DEEP: 70, REM: 90, LIGHT: 260 } } });
  const e0 = Date.parse('2026-10-30T15:00:00Z');
  goog.upsertExercise({ id: 'users/me/dataPoints/x1', date: d, startMs: e0, endMs: e0 + 3_600_000, type: 'BIKING', kcal: 400, avgHr: 130 });
  gar.upsertExercise({ id: 'garmin-1', date: d, startMs: e0 + 60_000, endMs: e0 + 3_600_000, type: 'BIKING', kcal: 420, avgHr: 132, device: 'Garmin' });
  const srcs = [{ id: 'main', db: goog, label: '' }];
  mergeAll(main, srcs, { extra: [{ id: 'garmin', db: gar, label: 'Garmin', first: true }] });
  let row = main.dailyTable(d)[d];
  assert.deepEqual([row.steps, row.floors, row.rhr, row.stress], [9000, 4, 55, 30], 'Garmin first; Google fills the floors Garmin lacks; never 12,000 steps');
  assert.deepEqual(main.sleeps('0000-00-00').map((n) => n.id), ['garmin-sleep-1'], 'one night, Garmin\'s');
  assert.equal(main.dailyTable(d)[d].sleep_min, 420);
  assert.deepEqual(main.exercises('0000-00-00').map((e) => e.id), ['garmin-1'], 'one ride');
  mergeAll(main, srcs, { extra: [{ id: 'garmin', db: gar, label: 'Garmin', first: false }] });
  row = main.dailyTable(d)[d];
  assert.deepEqual([row.steps, row.floors, row.rhr, row.stress, row.sleep_min], [3000, 4, 60, 30, 450], 'Google first: Google\'s numbers, Garmin\'s stress all the same');
  assert.deepEqual(main.sleeps('0000-00-00').map((n) => n.id), ['g-night']);
  assert.deepEqual(main.exercises('0000-00-00').map((e) => e.id), ['users/me/dataPoints/x1']);
  // Garmin let go of, without its data: what only it had goes.
  mergeAll(main, srcs, { gone: [gar] });
  row = main.dailyTable(d)[d];
  assert.deepEqual([row.steps, row.rhr, row.stress], [3000, 60, undefined]);
});

test('a person with Google and Garmin: Garmin first by default, the choice in Connections, and back again', async () => {
  const p = await r.person('both', { tz: TZ, persona: 'fitbit' });
  await ok(await p.c.post('/api/garmin/connect', { key: GARMIN_TEST_KEY }));
  await r.app.syncUser(p.id);
  const today = todayIn(Date.now(), TZ);
  const y = addDays(today, -1);
  const read = () => r.app.worlds.hold(p.id, async (w) => ({ main: w.db.dailyTable(y)[y], g: w.accounts.get('main').db.dailyTable(y)[y], gm: w.garminDb().dailyTable(y)[y] }));
  let x = await read();
  assert.equal(x.main.steps, x.gm.steps, 'Garmin\'s steps');
  assert.ok(x.main.steps !== x.g.steps + x.gm.steps);
  assert.equal(x.main.stress, x.gm.stress);
  const me = await ok(await p.c.get('/api/me'));
  assert.deepEqual(me.sources, { google: true, garmin: true, any: true });
  const v = await ok(await p.c.patch('/api/garmin/settings', { prefer: 'google' }));
  assert.equal(v.settings.prefer, 'google');
  x = await read();
  assert.equal(x.main.steps, x.g.steps, 'Google\'s steps now');
  assert.equal(x.main.stress, x.gm.stress, 'stress is Garmin\'s either way');
  assert.equal((await p.c.patch('/api/garmin/settings', { prefer: 'both' })).status, 400);
  // Let go of without its data: stress goes, Google's numbers stay.
  await ok(await p.c.post('/api/garmin/disconnect', { keepData: false }));
  x = await read();
  assert.equal(x.main.stress, undefined);
  assert.equal(x.main.steps, x.g.steps);
  assert.equal((await ok(await p.c.get('/api/browse'))).categories.flatMap((c) => c.metrics).some((m) => m.id === 'body_battery'), false);
});

/* ── a Garmin-only person, through the routes ────────────────────────── */

test('Garmin alone: connected for every page, the routes, and the key never leaves', async () => {
  const p = await garminPerson('gina');
  const texts = [];
  const get = async (path) => { const res = await p.c.get(path); assert.equal(res.status, 200, `${path}: ${res.text}`); texts.push(res.text); return res.json; };
  const g = await get('/api/garmin');
  assert.deepEqual([g.connected, g.last4, g.settings.prefer, g.backfill.done], [true, GARMIN_TEST_KEY.slice(-4), 'garmin', true]);
  assert.ok(g.counts.days >= 30 && g.counts.nights >= 25 && g.counts.activities > 5 && g.counts.stressDays >= 30);
  assert.ok(g.keyExpiresAt > Date.now() + 89 * 86_400_000 && g.keyExpiresKnown === false, 'from the lifetime the person gave');
  const me = await get('/api/me');
  assert.deepEqual([me.google.state, me.garmin.connected, me.sources.any], ['needs_auth', true, true]);
  for (const k of ['steps', 'heartRate', 'heartRateMinute', 'restingHr', 'hrv', 'spo2', 'sleep', 'sleepStages', 'floors', 'respiratoryRate', 'stress', 'bodyBattery', 'exercise', 'weight']) assert.equal(me.caps[k], true, k);
  for (const k of ['skinTemp', 'deviceBattery', 'vo2max']) assert.equal(me.caps[k], false, k);
  assert.match(me.capsMeta.missing.find((x) => x.cap === 'deviceBattery').text, /Garmin/);
  const d = await get('/api/data?days=30');
  assert.deepEqual([d.connected, d.empty], [true, false]);
  assert.ok(d.sleep.nights.length >= 5 && d.sleep.lastNight);
  const brief = await get('/api/brief');
  assert.ok(brief.extra.stress.device.value >= 0 && brief.extra.stress.battery.now > 0);
  const day = await get(`/api/day?date=${addDays(todayIn(Date.now(), TZ), -1)}`);
  assert.deepEqual([day.steps.available, day.hr.available], [false, true]);
  assert.match(day.steps.reason, /Garmin/);
  const stress = await get('/api/metric/stress?range=week');
  assert.ok(stress.chart.points.length >= 6 && stress.chart.stackKeys.map((k) => k.key).join() === 'rest,low,medium,high');
  assert.ok(stress.entries.every((e) => e.source === 'garmin' && e.device === 'Garmin'));
  const bb = await get('/api/metric/body_battery?range=day');
  assert.ok(['hours', 'range'].includes(bb.chart.kind));
  const wk = await get('/api/workouts?limit=50');
  assert.ok(wk.history.some((w) => w.source === 'garmin' && w.readOnly));
  await get('/api/browse'); await get('/api/export');
  for (const t of texts) {
    assert.ok(!t.includes(GARMIN_TEST_KEY), 'the key is never sent back');
    assert.ok(!/eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9/.test(t), 'nor the token');
  }
  // Sync now, from a Garmin-only person, through the shared route too.
  const s = await ok(await p.c.post('/api/garmin/sync', {}));
  assert.equal(s.result.ok, true);
  assert.equal((await p.c.post('/api/garmin/sync', {})).status, 429, 'half a minute between');
  assert.equal((await p.c.post('/api/sync', {})).status, 200);
  // Nobody else sees any of it.
  const other = await r.person('notgina', { tz: TZ });
  assert.equal((await ok(await other.c.get('/api/garmin'))).connected, false);
  assert.equal((await other.c.post('/api/garmin/sync', {})).status, 409);
});

test('connect: a key that is not one, a key Garmin refuses, the choices checked; the key sealed', async () => {
  const p = await r.person('keys', { tz: TZ });
  const bad = async (body, status, code) => { const res = await p.c.post('/api/garmin/connect', body); assert.equal(res.status, status, res.text); if (code) assert.equal(res.json.code, code); return res.json; };
  await bad({ key: 'short' }, 400, 'bad_key');
  assert.match((await bad({ key: 'not-the-right-key-at-all' }, 400, 'bad_key')).error, /Garmin did not accept this key/);
  await bad({ key: GARMIN_TEST_KEY, keyDays: 45 }, 400);
  await bad({ key: GARMIN_TEST_KEY, backfill: 7 }, 400);
  assert.equal((await ok(await p.c.get('/api/garmin'))).connected, false, 'nothing was kept');
  // "ApiKey " pasted with it, and spaces around it, are taken off.
  const v = await ok(await p.c.post('/api/garmin/connect', { key: ` ApiKey ${GARMIN_TEST_KEY} `, backfill: 90 }));
  assert.deepEqual([v.connected, v.settings.backfill, v.keyExpiresAt], [true, 90, null]);
  const row = r.app.app.secretRow(p.id, 'garmin');
  assert.ok(row && row.last4 === GARMIN_TEST_KEY.slice(-4));
  assert.ok(!JSON.stringify(row).includes(GARMIN_TEST_KEY), 'sealed, not stored as it was typed');
  assert.equal(r.app.vault.open(row, `${p.id}:garmin`), GARMIN_TEST_KEY);
});

test('a key Garmin stops taking: Garmin is let go of, what it brought stays, and the page says so', async () => {
  const p = await garminPerson('expiring', { passes: 1 });
  r.garmin.expireTokens(); r.garmin.refuseKey();
  try {
    await r.app.syncUser(p.id);
    const g = await ok(await p.c.get('/api/garmin'));
    assert.deepEqual([g.connected, g.kept, !!g.lost], [false, true, true]);
    assert.match(g.lost.message, /make a new one/i);
    assert.equal(r.app.app.secretRow(p.id, 'garmin'), null, 'a key that no longer works is not kept');
    const me = await ok(await p.c.get('/api/me'));
    assert.deepEqual([me.garmin.connected, me.garmin.lost], [false, true]);
    assert.ok((await ok(await p.c.get('/api/metric/stress?range=week'))).chart.points.length > 0, 'the history stays');
  } finally { r.garmin.acceptKey(); }
  // A new key carries on where it was.
  await ok(await p.c.post('/api/garmin/connect', { key: GARMIN_TEST_KEY }));
  assert.equal((await ok(await p.c.get('/api/garmin'))).connected, true);
});

test('disconnect: keep what it brought, or remove it; delete my data takes the key too', async () => {
  const p = await garminPerson('leaver', { passes: 1 });
  const kept = await ok(await p.c.post('/api/garmin/disconnect', { keepData: true }));
  assert.deepEqual([kept.connected, kept.kept], [false, true]);
  assert.equal(r.app.app.secretRow(p.id, 'garmin'), null);
  assert.ok((await ok(await p.c.get('/api/metric/stress?range=week'))).chart.points.length > 0);
  await ok(await p.c.post('/api/garmin/connect', { key: GARMIN_TEST_KEY }));
  const gone = await ok(await p.c.post('/api/garmin/disconnect', { keepData: false }));
  assert.deepEqual([gone.connected, gone.kept, gone.counts.days], [false, false, 0]);
  const b = await ok(await p.c.get('/api/browse'));
  assert.ok(!b.categories.flatMap((c) => c.metrics).some((m) => ['stress', 'body_battery', 'sleep', 'steps'].includes(m.id)), 'nothing of Garmin\'s is left');
  await ok(await p.c.post('/api/garmin/connect', { key: GARMIN_TEST_KEY }));
  await ok(await p.c.post('/api/account/delete-data', { confirm: 'leaver' }));
  assert.equal(r.app.app.secretRow(p.id, 'garmin'), null);
});

/* ── stress logged by hand ───────────────────────────────────────────── */

test('stress logged by hand: for everyone, kept here only, on its own scale, beside the watch\'s', async () => {
  const p = await r.person('feeler', { tz: TZ, persona: 'fitbit' });
  const res = await ok(await p.c.post('/api/entries', { kind: 'stress', level: 4, note: 'Deadline' }));
  assert.deepEqual([res.entry.kind, res.entry.value, res.entry.unit, res.entry.text, res.google], ['stress', 4, 'of 5', 'Stressed', 'local']);
  assert.match(res.message, /Google Health has no place for stress/);
  assert.equal((await p.c.post('/api/entries', { kind: 'stress', level: 6 })).status, 400);
  assert.equal((await p.c.post('/api/entries', { kind: 'stress' })).status, 400);
  const m = await ok(await p.c.get('/api/metric/stress?range=week'));
  assert.deepEqual([m.logged.count, m.logged.word, m.stats.count], [1, 'Stressed', 0]);
  assert.match(m.reading, /Logged once/);
  assert.equal(m.add.kind, 'stress');
  assert.match(m.add.note, /no stress type/);
  assert.equal(m.entries[0].source, 'app');
  assert.equal(m.entries[0].editable, true);
  // The Log sheet has it, with nothing to switch on.
  const log = await ok(await p.c.get('/api/log'));
  const k = log.kinds.find((x) => x.id === 'stress');
  assert.deepEqual([k.available, k.mode, k.last.text], [true, 'local', 'Stressed']);
  // Health shows it, Today's brief has it, the summary may read it.
  const b = await ok(await p.c.get('/api/browse'));
  assert.equal(b.categories.find((c) => c.id === 'mindfulness').metrics.find((x) => x.id === 'stress').latest.text, 'Stressed');
  assert.equal((await ok(await p.c.get('/api/brief'))).extra.stress.logged.word, 'Stressed');
  await r.app.worlds.hold(p.id, async (w) => {
    const text = briefing(w, { topic: 'ask', now: Date.now() });
    assert.match(text, /Stress the person logged/);
    assert.match(text, /: 4 \(stressed\), note: Deadline/);
  });
  // Changed and removed like any entry; in the export.
  const id = m.entries[0].id;
  assert.equal((await ok(await p.c.patch(`/api/entries/${id}`, { level: 2 }))).entry.text, 'Calm');
  const ex = await ok(await p.c.get('/api/export'));
  assert.ok(JSON.stringify(ex).includes('"kind":"stress"'));
  assert.equal((await p.c.del(`/api/entries/${id}`)).status, 200);
});

test('stress is never public: not on the profile, the leaderboard or compare', async () => {
  const p = await garminPerson('openbook', { passes: 1 });
  await ok(await p.c.patch('/api/settings', { privacy: { account: 'public', activity: true, workouts: true, sleep: true, heart: true, body: true } }));
  await ok(await p.c.post('/api/entries', { kind: 'stress', level: 5, note: 'stressnote-qzx' }));
  await r.app.publish(p.id);
  const viewer = await r.person('viewer', { tz: TZ });
  const texts = [
    (await viewer.c.get('/api/users/openbook')).text,
    (await viewer.c.get('/api/leaderboard?metric=steps&period=week')).text,
    (await viewer.c.get('/api/compare?with=openbook')).text,
  ];
  for (const t of texts) assert.ok(!/stress|bb_high|body battery|stressnote-qzx/i.test(t), t.slice(0, 200));
});

test('readDays: the v2 daily summary, each family nested (as Garmin answers it now)', () => {
  const d = readDays({ data: [{
    uuid: 'x', calendarDate: '2026-10-24', source: 'GARMIN', includesWellnessData: true,
    movement: { steps: { goal: 3370, value: 8158, distanceInMeters: 6771 }, floorsAscended: { goal: 10, value: 3, distanceInMeters: 9.14 } },
    calories: { burnedResting: 2138, burnedActive: 448, burnedTotal: 2586 },
    heartRate: { minValue: 65, maxValue: 138, restingValue: 75 },
    intensityMinutes: { goal: 150, moderate: 1, vigorous: 2 },
    stress: { avgLevel: 36, maxLevel: 94, restDurationInMillis: 7_320_000, lowStressDurationInMillis: 12_240_000, mediumStressDurationInMillis: 3_480_000, highStressDurationInMillis: 600_000 },
    bodyBattery: { minValue: 29, maxValue: 68, chargedValue: 0, drainedValue: 39 },
    pulseOx: {}, hydration: {},
  }] })['2026-10-24'];
  assert.deepEqual(
    [d.steps, d.distance_m, d.kcal, d.kcal_active, d.kcal_basal, d.floors, d.active_min, d.azm, d.rhr, d.hr_min, d.hr_max, d.stress, d.stress_rest, d.stress_low, d.stress_medium, d.stress_high, d.bb_high, d.bb_low, d.bb_drained],
    [8158, 6771, 2586, 448, 2138, 3, 3, 5, 75, 65, 138, 36, 122, 204, 58, 10, 68, 29, 39],
  );
});
