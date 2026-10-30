/* Sleep score, readiness and resilience made to match the Google Health
   app's (server/core/scores.js), and fitting them to a person's own Google
   numbers. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepFacts, sleepScoreOf, sleepBand, readyX, resilX, apply, fit, readyBand, resilLabel, DEFAULTS } from '../server/core/scores.js';
import { addDays } from '../server/core/util.js';

const MIN = 60_000;
/** A night from 23:00, stage by stage: [type, minutes] ... */
function night(spells, { short = 2 } = {}) {
  let t = Date.parse('2026-10-20T23:00:00Z');
  const startMs = t;
  const stages = spells.map(([type, m]) => { const x = { s: t, e: t + m * MIN, t: type }; t += m * MIN; return x; });
  const asleep = spells.filter(([k]) => k !== 'AWAKE').reduce((a, [, m]) => a + m, 0);
  return { date: '2026-10-21', main: true, startMs, endMs: t, asleepMin: asleep, periodMin: (t - startMs) / MIN, stages, summary: { shortAwakenings: short } };
}
const good = night([['AWAKE', 8], ['LIGHT', 20], ['DEEP', 60], ['LIGHT', 40], ['REM', 30], ['LIGHT', 50], ['DEEP', 40], ['LIGHT', 45], ['REM', 45], ['LIGHT', 40], ['REM', 40], ['LIGHT', 30], ['AWAKE', 5]]);
const rough = night([['AWAKE', 40], ['LIGHT', 10], ['AWAKE', 15], ['LIGHT', 12], ['DEEP', 20], ['AWAKE', 25], ['LIGHT', 10], ['REM', 15], ['LIGHT', 8], ['AWAKE', 12], ['LIGHT', 60], ['REM', 20]], { short: 9 });

test('a night\'s six facts: sound sleep, time to it, stirrings, awakenings over 5 minutes and their minutes', () => {
  const f = sleepFacts(good);
  assert.deepEqual([f.asleepMin, f.awakenings, f.interruptMin], [440, 0, 0]);
  assert.equal(f.settleMin, 8, 'the first steady sleep came after 8 minutes');
  assert.ok(f.soundMin >= 400);
  const r = sleepFacts(rough);
  assert.deepEqual([r.awakenings, r.interruptMin], [3, 52], 'three spells over 5 minutes inside the night (not the one before falling asleep)');
  assert.equal(sleepFacts({ asleepMin: 400, stages: [{ s: 0, e: 1, t: 'ASLEEP' }], summary: {} }), null, 'no stages, no score, as in Google\'s app');
});

test('the score lands where Google\'s do: a good night high, a broken one poor; bands as Google\'s', () => {
  const a = sleepScoreOf(good); const b = sleepScoreOf(rough);
  assert.ok(a.score >= 85 && a.score <= 100, `good ${a.score}`);
  assert.ok(b.score < 60, `rough ${b.score}`);
  assert.equal(a.parts.length, 6);
  assert.deepEqual([sleepBand(92), sleepBand(85), sleepBand(70), sleepBand(40)], ['Excellent', 'Good', 'Fair', 'Poor']);
  assert.deepEqual([readyBand(80), readyBand(40), readyBand(10)], ['High', 'Moderate', 'Low']);
  assert.deepEqual([resilLabel(70), resilLabel(50), resilLabel(20)], ['Optimal', 'Balanced', 'Low']);
});

/** 40 days of a person whose HRV and resting heart rate wander. */
function history() {
  const table = {};
  for (let i = 40; i >= 0; i -= 1) {
    const d = addDays('2026-10-21', -i);
    const k = Math.sin(i / 3);
    table[d] = { hrv: 45 + 8 * k, rhr: 58 - 3 * k, hr_avg: 72 - 3 * k, sleep_min: 420 + 30 * k, sleep_score: Math.round(78 + 8 * k), cardio_min: 30 + 20 * Math.cos(i / 4) };
  }
  return table;
}

test('readiness and resilience: nothing before 7 nights; higher with better HRV and lower resting heart rate', () => {
  const t = history();
  assert.equal(readyX({ '2026-10-21': { hrv: 40 } }, '2026-10-21', addDays), null);
  const days = Object.keys(t).slice(-10);
  const scores = days.map((d) => apply('ready', readyX(t, d, addDays)));
  assert.ok(scores.every((s) => s >= 1 && s <= 100));
  // The best HRV day scores above the worst one.
  const byHrv = days.map((d, i) => [t[d].hrv, scores[i]]).sort((a, b) => a[0] - b[0]);
  assert.ok(byHrv.at(-1)[1] > byHrv[0][1]);
  const rs = apply('resil', resilX(t, days.at(-1), addDays));
  assert.ok(rs >= 0 && rs <= 100);
});

test('fitting: Google\'s own numbers pull the weights until the scores match them closely; a handful of days cannot send them anywhere strange', () => {
  const t = history();
  const days = Object.keys(t).slice(-21);
  // A "Google" that weighs HRV harder and has a lower middle than the starting model.
  const truth = { b: 60, w: { ...DEFAULTS.ready.w, hrv: 160, rhr: -4 } };
  const pairs = days.map((d) => ({ x: readyX(t, d, addDays), y: apply('ready', readyX(t, d, addDays), truth) }));
  const before = pairs.reduce((a, p) => a + Math.abs(apply('ready', p.x) - p.y), 0) / pairs.length;
  const m = fit('ready', pairs);
  assert.equal(m.fitted, true);
  assert.ok(m.mae < before / 2 && m.mae <= 3, `average miss ${m.mae} (was ${before.toFixed(1)})`);
  // Two days are not enough to fit anything.
  assert.equal(fit('ready', pairs.slice(0, 2)).fitted, false);
  // Sleep: a Google that is stricter on duration.
  const nights = [good, rough, night([['LIGHT', 30], ['DEEP', 50], ['REM', 40], ['LIGHT', 120], ['REM', 30]]), night([['AWAKE', 20], ['LIGHT', 200], ['REM', 30], ['AWAKE', 8], ['LIGHT', 60]]), night([['LIGHT', 15], ['DEEP', 70], ['LIGHT', 90], ['REM', 60], ['LIGHT', 100], ['REM', 50]])];
  const sp = nights.map((n) => { const x = sleepScoreOf(n).x; return { x, y: Math.max(0, Math.min(100, Math.round(-8 + 58 * x.duration + 20 * x.sound + 5 * x.settle + 8 * x.restless + 8 * x.awakenings + 9 * x.interruptions))) }; });
  const sm = fit('sleep', sp);
  assert.ok(sm.fitted && sm.mae <= 4, `sleep miss ${sm.mae}`);
});
