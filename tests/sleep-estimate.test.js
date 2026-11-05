/* A night without sleep stages (a device that could not stage it): sleep
   quality from the parts it has, deep and REM left out, nothing
   estimated from other nights (server/core/scores.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepScoreEstimate, sleepScoreOf } from '../server/core/scores.js';

test('a night without stages is scored out of the parts it has, and nothing is estimated', () => {
  const s = Date.UTC(2026, 9, 14, 23);
  const classic = { date: '2026-10-15', asleepMin: 370, periodMin: 400, startMs: s, endMs: s + 400 * 60000, stages: [{ s, e: s + 370 * 60000, t: 'ASLEEP' }], summary: { stages: { ASLEEP: 370 } } };
  const r = sleepScoreOf(classic);
  assert.deepEqual(r.parts.map((p) => p.id), ['duration', 'efficiency', 'awake']);
  assert.deepEqual(r.missing.map((m) => m.id), ['stages', 'regularity']);
  // 6 h 10 asleep (24.8 of 40: 4 h is 0, 7 h 30 full), 92.5% of the time in bed (20 of 20), not awake inside it (10 of 10): 54.8 of 70.
  assert.equal(r.score, Math.round((54.8 / 70) * 100));
  assert.equal(sleepScoreEstimate(classic, []), null);
});
