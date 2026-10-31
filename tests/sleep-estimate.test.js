import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepScoreEstimate, sleepScoreOf } from '../server/core/scores.js';

const H = 3_600_000;
const staged = (day, rem = 90, deep = 70) => {
  const s = Date.UTC(2026, 9, day, 23);
  const st = [{ s, e: s + 60 * 60000, t: 'LIGHT' }, { s: s + 60 * 60000, e: s + (60 + deep) * 60000, t: 'DEEP' }, { s: s + (60 + deep) * 60000, e: s + (60 + deep + rem) * 60000, t: 'REM' }, { s: s + (60 + deep + rem) * 60000, e: s + 7 * H, t: 'LIGHT' }];
  return { date: `2026-10-${String(day + 1).padStart(2, '0')}`, asleepMin: 420, stages: st, summary: {} };
};

test('a night without stages gets an estimate from the usual nights, said so', () => {
  const prior = [staged(10), staged(11), staged(12), staged(13)];
  const classic = { date: '2026-10-15', asleepMin: 370, stages: [{ s: 0, e: 370 * 60000, t: 'ASLEEP' }], summary: { stages: { ASLEEP: 370 } } };
  assert.equal(sleepScoreOf(classic).score, null, 'no stages: no real score');
  const e = sleepScoreEstimate(classic, prior, { goalMin: 450 });
  assert.ok(e && e.estimated);
  assert.ok(e.score > 50 && e.score < 100, `score ${e.score}`);
  assert.equal(e.parts.length, 3);
  assert.equal(sleepScoreEstimate(classic, prior.slice(0, 2)), null, 'too few staged nights to say');
  assert.equal(sleepScoreEstimate(prior[0], prior), null, 'a staged night has its real score instead');
});
