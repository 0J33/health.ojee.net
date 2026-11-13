/* Work hours (server/workhours.js): the watch's own guesses while at work are not workouts,
   ones started on purpose still are, and the day's totals are untouched. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { unified } from '../server/history.js';
import { atWork, hiddenAtWork, normWorkHours } from '../server/workhours.js';

const at = (iso) => Date.parse(iso);
const MIN = 60_000;

test('in work hours or not: days, times, a shift past midnight, the time zone', () => {
  const wh = normWorkHours({ on: true, days: ['sun', 'mon', 'tue', 'wed', 'thu'], from: '08:00', to: '17:00' }, 'Africa/Cairo');
  assert.equal(atWork(wh, at('2026-11-09T08:30:00Z')), true, 'Monday 10:30 in Cairo');
  assert.equal(atWork(wh, at('2026-11-09T15:30:00Z')), false, 'Monday 17:30 in Cairo');
  assert.equal(atWork(wh, at('2026-11-13T08:30:00Z')), false, 'Friday');
  const night = normWorkHours({ on: true, days: ['mon'], from: '22:00', to: '06:00' }, 'UTC');
  assert.equal(atWork(night, at('2026-11-09T23:00:00Z')), true, 'Monday night');
  assert.equal(atWork(night, at('2026-11-10T05:00:00Z')), true, 'Tuesday early, the same shift');
  assert.equal(atWork(night, at('2026-11-10T23:00:00Z')), false, 'Tuesday night is not a work night');
  assert.throws(() => normWorkHours({ on: true, days: [], from: '08:00', to: '17:00' }, 'UTC'), /at least one/);
});

test('the watch\'s own volleyball at work is not a workout; one started on purpose is; off, all are', () => {
  const db = openDb(':memory:');
  const ex = (id, iso, minutes, type, method) => db.upsertExercise({ id: `users/me/dataTypes/exercise/dataPoints/${id}`, date: iso.slice(0, 10), startMs: at(iso), endMs: at(iso) + minutes * MIN, type, name: type, steps: 2000, distanceM: 1500, device: 'Fitbit Air', method });
  ex('work-vb', '2026-11-09T08:00:00Z', 62, 'VOLLEYBALL', 'PASSIVELY_MEASURED');   // 10:00 in Cairo, a Monday
  ex('work-old', '2026-11-09T11:00:00Z', 40, 'WORKOUT', null);                       // recorded before the method was kept
  ex('work-run', '2026-11-09T09:30:00Z', 30, 'RUNNING', 'ACTIVELY_MEASURED');        // started on purpose, at work
  ex('evening', '2026-11-09T17:00:00Z', 50, 'STRENGTH_TRAINING', 'PASSIVELY_MEASURED'); // 19:00, after work
  const types = () => unified(db, 0).map((s) => s.ex?.type).sort();
  assert.deepEqual(types(), ['RUNNING', 'STRENGTH_TRAINING', 'VOLLEYBALL', 'WORKOUT']);
  db.setMeta('workHours', normWorkHours({ on: true, days: ['sun', 'mon', 'tue', 'wed', 'thu'], from: '08:00', to: '17:00' }, 'Africa/Cairo'));
  assert.deepEqual(types(), ['RUNNING', 'STRENGTH_TRAINING']);
  assert.equal(hiddenAtWork({ startMs: at('2026-11-09T08:00:00Z'), endMs: at('2026-11-09T09:00:00Z'), device: 'Logged by hand' }, db.meta('workHours')), false, 'logged by hand stays');
  // The sessions are still kept (their steps and distance are in the day either way).
  assert.equal(db.exercises('2026-11-01').length, 4);
  db.setMeta('workHours', { ...db.meta('workHours'), on: false });
  assert.equal(types().length, 4);
});
