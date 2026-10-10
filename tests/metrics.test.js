import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readinessFor, illness, streak, consistency, weightTrend, strengthWeeks, baseline, verdictDay, weekOf,
} from '../server/core/metrics.js';
import { addDays } from '../server/core/util.js';

const D = '2026-10-07';
/** 30 baseline days: HRV alternating 48/52 (mean 50), RHR 57/59 (mean 58). */
function table(overrides = {}) {
  const t = {};
  for (let i = 1; i <= 30; i += 1) t[addDays(D, -i)] = { hrv: i % 2 ? 48 : 52, rhr: i % 2 ? 57 : 59, sleep_min: 440 };
  for (const [d, v] of Object.entries(overrides)) t[d] = { ...(t[d] || {}), ...v };
  return t;
}

test('baseline is the previous 30 days, never the day itself, and needs 7 days', () => {
  const t = table({ [D]: { hrv: 10 } });
  assert.equal(baseline(t, 'hrv', D).mean, 50);
  const thin = { [addDays(D, -1)]: { hrv: 50 }, [addDays(D, -2)]: { hrv: 50 } };
  assert.equal(baseline(thin, 'hrv', D).mean, null);
});

test('readiness: the plan\'s own example — HRV -15%, resting HR +4 bpm is an easy day', () => {
  const r = readinessFor(table({ [D]: { hrv: 42.5, rhr: 62, sleep_min: 430 } }), D);
  assert.equal(r.parts.find((p) => p.key === 'hrv').pts, -2);
  assert.equal(r.parts.find((p) => p.key === 'rhr').pts, -1);
  assert.equal(r.score, -3);
  assert.equal(r.level, 'easy');
  assert.match(r.text, /^HRV −15% vs baseline, resting HR \+4 bpm: easy day$/);
  const worse = readinessFor(table({ [D]: { hrv: 42.5, rhr: 62, sleep_min: 400 } }), D);
  assert.equal(worse.level, 'rest');
});

test('readiness: levels across the range', () => {
  assert.equal(readinessFor(table({ [D]: { hrv: 46, rhr: 61, sleep_min: 430 } }), D).level, 'easy');      // -1 -1 0
  assert.equal(readinessFor(table({ [D]: { hrv: 50, rhr: 58, sleep_min: 430 } }), D).level, 'normal');    // 0 0 0
  assert.equal(readinessFor(table({ [D]: { hrv: 55, rhr: 55, sleep_min: 470 } }), D).level, 'push');      // +1 +1 +1
  const short = readinessFor(table({ [D]: { hrv: 50, rhr: 58, sleep_min: 330 } }), D);
  assert.equal(short.score, -2);
  assert.match(short.text, /^Slept 5h 30m: easy day$/);
  const hot = readinessFor(table({ [D]: { hrv: 50, rhr: 58, sleep_min: 430, temp_dev: 0.6 } }), D);
  assert.equal(hot.score, -1);
});

test('readiness: no baseline yet says so instead of judging', () => {
  const r = readinessFor({ [D]: { hrv: 40, rhr: 70, sleep_min: 300 } }, D);
  assert.equal(r.level, 'learning');
  assert.equal(r.score, null);
  assert.match(r.text, /Learning your baseline/);
});

test('verdict day falls back to the latest day with recovery numbers', () => {
  const t = table();
  assert.equal(verdictDay(t, D), addDays(D, -1));
  t[D] = { rhr: 58 };
  assert.equal(verdictDay(t, D), D);
});

test('illness: resting HR +5 for two days flags; one day does not', () => {
  const one = illness(table({ [D]: { rhr: 64 } }), D);
  assert.equal(one.flag, false);
  const two = illness(table({ [D]: { rhr: 64 }, [addDays(D, -1)]: { rhr: 63.5 } }), D);
  assert.equal(two.flag, true);
  assert.match(two.text, /resting HR up/);
});

test('illness: sleep temperature — absolute, relative to the person\'s spread, and combined', () => {
  assert.equal(illness(table({ [D]: { temp_dev: 0.85 } }), D).flag, true);
  assert.equal(illness(table({ [D]: { temp_dev: 0.6, temp_sd: 0.2 } }), D).flag, true, '0.6 >= 2.5 x 0.2');
  assert.equal(illness(table({ [D]: { temp_dev: 0.6, temp_sd: 0.3 } }), D).flag, false);
  const combined = illness(table({ [D]: { rhr: 61.5, temp_dev: 0.55, temp_sd: 0.4 }, [addDays(D, -1)]: { rhr: 61.2 } }), D);
  assert.equal(combined.flag, true);
  assert.match(combined.text, /with sleep temperature/);
});

test('streaks count back from today only once today has met the target', () => {
  const t = { [D]: { steps: 3000 }, [addDays(D, -1)]: { steps: 9000 }, [addDays(D, -2)]: { steps: 8000 }, [addDays(D, -3)]: { steps: 100 } };
  assert.equal(streak(t, 'steps', 8000, D), 2);
  t[D].steps = 8500;
  assert.equal(streak(t, 'steps', 8000, D), 3);
  assert.equal(streak(t, 'steps', 0, D), 0);
});

test('consistency measures bedtimes across midnight correctly', () => {
  const night = (bedUtc, wakeUtc) => ({ main: true, startMs: Date.parse(bedUtc), endMs: Date.parse(wakeUtc), startOff: 10800, endOff: 10800, asleepMin: 420 });
  // 23:30 and 00:30 local: one hour apart, mean midnight.
  const c = consistency([night('2026-10-01T20:30:00Z', '2026-10-02T04:00:00Z'), night('2026-10-02T21:30:00Z', '2026-10-03T04:00:00Z'), night('2026-10-03T21:00:00Z', '2026-10-04T04:00:00Z')]);
  assert.equal(c.bedtime, '00:00');
  assert.equal(c.bedtimeSd, 30);
  assert.equal(c.wake, '07:00');
  assert.equal(consistency([]), null);
});

test('weight trend is a 7-day trailing mean of daily means', () => {
  const at = (d, h, kg) => ({ t: Date.parse(`${d}T${h}:00:00Z`), grams: kg * 1000, off: 0 });
  const w = [at('2026-10-01', '07', 80), at('2026-10-01', '20', 81), at('2026-10-03', '07', 79)];
  const tr = weightTrend(w, '2026-10-01', '2026-10-03');
  assert.deepEqual(tr.map((x) => x.kg), [80.5, null, 79]);
  assert.equal(tr[2].avg7, 80);
});

test('strength weeks: volume per muscle group (kg x reps x sets) beside that week\'s HRV', () => {
  const t = table({ [D]: { hrv: 50, rhr: 58 } });
  const mon = weekOf(D);
  const sets = [
    { date: mon, muscle: 'chest', kg: 80, reps: 8, sets: 3 },
    { date: mon, muscle: 'legs', kg: 100, reps: 5, sets: 5 },
    { date: mon, muscle: 'neck', kg: 10, reps: 10, sets: 1 },
  ];
  const w = strengthWeeks(sets, t, D, 4);
  assert.equal(w.length, 4);
  const last = w[w.length - 1];
  assert.equal(last.week, mon);
  assert.equal(last.volume.chest, 1920);
  assert.equal(last.volume.legs, 2500);
  assert.equal(last.volume.other, 100, 'an unknown group is counted as other');
  assert.equal(last.total, 4520);
  assert.ok(Number.isFinite(last.hrv));
  assert.equal(weekOf('2026-10-07'), '2026-10-05', 'weeks start on Monday');
});
