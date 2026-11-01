/* Samsung Health through the Android app's Health Connect (hcsync.js):
   what the phone sends is kept in the shapes Google's sync writes, and a
   Samsung-only person has their numbers, nights and workouts everywhere. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { addDays, today as todayIn, localToMs } from '../server/core/util.js';

const TZ = 'Africa/Cairo';
const HOUR = 3_600_000;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

test('Samsung Health alone: connected, its days, nights, workouts and weigh-ins on every page; checked; and let go of', async () => {
  const p = await r.person('sam', { tz: TZ });
  assert.equal((await p.c.post('/api/hc/upload', { days: [] })).status, 409, 'connect first');
  await ok(await p.c.post('/api/hc/connect', { device: 'Galaxy Watch7' }));
  const today = todayIn(Date.now(), TZ);
  const days = []; const nights = []; const hours = [];
  for (let i = 1; i <= 10; i += 1) {
    const d = addDays(today, -i);
    days.push({ date: d, steps: 8000 + i * 100, distance_m: 6000, kcal: 2300, kcal_active: 500, kcal_basal: 1800, floors: 9, active_min: 40, rhr: 58, hr_min: 50, hr_max: 150, hr_avg: 72, hrv: 45, spo2: 96, resp: 14, nonsense: 5 });
    const bed = localToMs(addDays(d, -1), 23 * 60, TZ);
    nights.push({ startMs: bed, endMs: bed + 7.5 * HOUR, stages: [
      { s: bed, e: bed + 1 * HOUR, stage: 'light' }, { s: bed + HOUR, e: bed + 2.5 * HOUR, stage: 'deep' }, { s: bed + 2.5 * HOUR, e: bed + 2.7 * HOUR, stage: 'awake' },
      { s: bed + 2.7 * HOUR, e: bed + 5 * HOUR, stage: 'rem' }, { s: bed + 5 * HOUR, e: bed + 7.5 * HOUR, stage: 'light' }] });
    hours.push({ date: d, hours: Array.from({ length: 24 }, (_, h) => ({ start: localToMs(d, h * 60, TZ), min: 55, max: 90, avg: 70 })) });
  }
  days.push({ date: addDays(today, -11), steps: -5, rhr: 400 });   // out of range: not kept
  const run = localToMs(addDays(today, -2), 7 * 60, TZ);
  const up = await ok(await p.c.post('/api/hc/upload', {
    days, nights, hours,
    workouts: [{ id: 'abc-1', type: 'running', startMs: run, endMs: run + 40 * 60_000, kcal: 420, distanceM: 6100, avgHr: 150 }, { id: 'bad', type: 'running', startMs: run, endMs: run - 1 }],
    weights: [{ t: run - HOUR, kg: 81.4 }], latest: { t: Date.now() - 60_000, bpm: 64 }, device: 'Galaxy Watch7',
  }));
  assert.deepEqual([up.result.days, up.result.nights, up.result.workouts, up.result.weighIns], [10, 10, 1, 1]);
  const me = await ok(await p.c.get('/api/me'));
  assert.deepEqual([me.hc.connected, me.sources.any, me.hc.device], [true, true, 'Galaxy Watch7']);
  const d = await ok(await p.c.get('/api/data?days=30'));
  assert.deepEqual([d.connected, d.empty], [true, false]);
  assert.ok(d.sleep.nights.length >= 5, 'nights');
  const night = d.sleep.lastNight;
  assert.ok(night && night.asleepMin >= 400 && night.asleepMin <= 450, JSON.stringify(night && { a: night.asleepMin }));
  const wk = await ok(await p.c.get('/api/workouts?limit=50'));
  const w = wk.history.find((x) => x.type === 'RUNNING');
  assert.ok(w && w.readOnly, 'the run, from the watch');
  const steps = await ok(await p.c.get('/api/metric/steps?range=week'));
  assert.ok(steps.chart.points.some((x) => x.value >= 8100), 'steps by day');
  const day = await ok(await p.c.get(`/api/day?date=${addDays(today, -1)}`));
  assert.equal(day.hr.available, true, 'heart rate by the hour');
  // Again: the same, nothing doubled.
  await ok(await p.c.post('/api/hc/upload', { days, nights, workouts: [{ id: 'abc-1', type: 'running', startMs: run, endMs: run + 40 * 60_000, kcal: 420, distanceM: 6100 }] }));
  assert.equal((await ok(await p.c.get('/api/workouts?limit=50'))).history.filter((x) => x.type === 'RUNNING').length, 1);
  // Bad shapes are refused.
  assert.equal((await p.c.post('/api/hc/upload', { days: 'x' })).status, 400);
  // Let go of, and its numbers removed.
  await ok(await p.c.post('/api/hc/disconnect', { keepData: false }));
  const after1 = await ok(await p.c.get('/api/data?days=30'));
  assert.equal(after1.connected, false);
});

test('what Samsung leaves out is worked out: total calories from active ones and the resting burn (weight and body fat); weigh-ins arrive; the permissions are kept', async () => {
  const p = await r.person('sam2', { tz: TZ });
  await ok(await p.c.post('/api/hc/connect', {}));
  const today = todayIn(Date.now(), TZ);
  const d = addDays(today, -2);
  const up = await ok(await p.c.post('/api/hc/upload', {
    days: [{ date: d, steps: 9000, kcal_active: 400, body_fat: 20, active_min: 35 }],
    weights: [{ t: localToMs(addDays(today, -5), 8 * 60, TZ), kg: 80 }],
    perms: { granted: ['steps', 'weight'], denied: ['sleep', 'heartRate'] },
  }));
  assert.equal(up.result.days, 1);
  // Katch-McArdle: 370 + 21.6 × 64 kg lean = 1752; plus 400 active.
  const t = await ok(await p.c.get('/api/metric/calories?range=week'));
  assert.ok(t.chart.points.some((x) => Math.round(x.value) === 2152), JSON.stringify(t.chart.points.map((x) => x.value)));
  const w = await ok(await p.c.get('/api/metric/weight?range=month'));
  assert.ok(w.chart.points.some((x) => Math.round(x.value) === 80), 'the weigh-in reached the main store');
  const hc = await ok(await p.c.get('/api/hc'));
  assert.deepEqual(hc.perms.denied, ['sleep', 'heartRate']);
});
