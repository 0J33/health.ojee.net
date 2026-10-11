import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseRollup, parseDaily, parseSleep, parseExercise, parseWeight, parseBodyFat, latestHeartRate, pickDevice,
} from '../server/core/parse.js';
import { durSec, ymd, addDays, daysBetween } from '../server/core/util.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('util: google durations, civil dates', () => {
  assert.equal(durSec('10800s'), 10800);
  assert.equal(durSec('-3600.5s'), -3600.5);
  assert.equal(durSec(undefined), 0);
  assert.equal(ymd({ year: 2026, month: 3, day: 9 }), '2026-03-09');
  assert.equal(addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(daysBetween('2026-09-30', '2026-10-07'), 7);
});

test('roll-ups: steps (int64 strings), an empty window, zone minutes, calories', () => {
  assert.deepEqual(parseRollup('steps', fx('rollup-steps.json').rollupDataPoints), [
    { date: '2026-10-05', metrics: { steps: 8123 } },
    { date: '2026-10-06', metrics: { steps: 0 } },
  ]);
  const [azm] = parseRollup('active-zone-minutes', fx('rollup-azm.json').rollupDataPoints);
  assert.deepEqual(azm, { date: '2026-10-06', metrics: { azm_fat: 12, azm_cardio: 8, azm_peak: 2, azm: 22 } });
  const [kcal] = parseRollup('total-calories', fx('rollup-calories.json').rollupDataPoints);
  assert.equal(kcal.metrics.kcal, 2412.6);
});

test('daily types: RHR, HRV (and an HRV day with only entropy), SpO2, temperature deviation', () => {
  const d = fx('list-daily.json');
  assert.deepEqual(parseDaily('daily-resting-heart-rate', d['daily-resting-heart-rate'].dataPoints), [{ date: '2026-10-06', metrics: { rhr: 58 } }]);
  const hrv = parseDaily('daily-heart-rate-variability', d['daily-heart-rate-variability'].dataPoints);
  assert.equal(hrv.length, 2);
  assert.equal(hrv[0].metrics.hrv, 47.3);
  assert.equal(hrv[0].metrics.hrv_deep, 55.1);
  assert.equal(hrv[1].metrics.hrv, undefined, 'a day with no RMSSD has no `hrv`');
  assert.ok(Object.keys(hrv[1].metrics).every((k) => k === 'hrv_entropy' || k === 'hrv_nonrem_hr'), 'only what that day carries');
  const [sp] = parseDaily('daily-oxygen-saturation', d['daily-oxygen-saturation'].dataPoints);
  assert.deepEqual(sp.metrics, { spo2: 96.4, spo2_lo: 94.1, spo2_hi: 98 });
  const [t] = parseDaily('daily-sleep-temperature-derivations', d['daily-sleep-temperature-derivations'].dataPoints);
  assert.ok(Math.abs(t.metrics.temp_dev - 0.52) < 1e-9);
  assert.equal(t.metrics.temp_sd, 0.2);
});

test('sleep: stages sorted, summary used, wake date is civil end date; a nap without summary is derived', () => {
  const [main, nap] = fx('list-sleep.json').dataPoints.map(parseSleep);
  assert.equal(main.id, 'users/me/dataTypes/sleep/dataPoints/a1b2c3d4-e5f6-7890-1234-567890abcdef');
  assert.equal(main.date, '2026-10-06');
  assert.equal(main.main, true);
  assert.equal(main.asleepMin, 438);
  assert.equal(main.periodMin, 450);
  assert.equal(main.startOff, 10800);
  assert.deepEqual(main.stages.map((s) => s.t), ['AWAKE', 'LIGHT', 'DEEP', 'REM']);
  assert.equal(main.summary.stages.DEEP, 40);
  assert.equal(nap.main, false);
  assert.equal(nap.periodMin, 40);
  assert.equal(nap.date, '2026-10-06', 'civil date derived from the offset when not given');
  assert.equal(parseSleep({ sleep: {} }), null);
});

test('samples: weight in grams (zero refused), body fat, the newest valid heart rate', () => {
  const s = fx('list-samples.json');
  const w = s.weight.dataPoints.map(parseWeight);
  assert.deepEqual(w[0], { t: Date.parse('2026-10-06T04:10:00Z'), off: 10800, date: '2026-10-06', grams: 78400, note: 'after run' });
  assert.equal(w[1], null);
  const bf = parseBodyFat(s['body-fat'].dataPoints[0]);
  assert.equal(bf.date, '2026-10-06', '22:30Z at +3 is the next civil day');
  assert.equal(bf.pct, 19.2);
  assert.deepEqual(latestHeartRate(s['heart-rate'].dataPoints), { t: Date.parse('2026-10-06T10:05:00Z'), bpm: 66 });
});

test('exercise and paired devices', () => {
  const s = fx('list-samples.json');
  const e = parseExercise(s.exercise.dataPoints[0]);
  assert.equal(e.date, '2026-10-05');
  assert.equal(e.type, 'WEIGHTLIFTING');
  assert.equal(e.azm, 14);
  assert.equal(e.avgHr, 108);
  const d = pickDevice(fx('paired-devices.json').pairedDevices);
  assert.equal(d.name, 'Fitbit Air', 'the tracker wins over a scale synced more recently');
  assert.equal(d.battery, 64);
  assert.equal(pickDevice([]), null);
});
