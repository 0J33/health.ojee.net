/* Sleep score, readiness and resilience made to match the Google Health
   app's (server/core/scores.js), checked against what Google's Takeout
   showed for the same inputs. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepFacts, sleepScoreOf, sleepBand, readyX, readinessOf, resilX, resilienceOf, readyBand, resilLabel } from '../server/core/scores.js';
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
const rough = night([['AWAKE', 40], ['LIGHT', 10], ['AWAKE', 15], ['LIGHT', 12], ['DEEP', 20], ['AWAKE', 25], ['LIGHT', 10], ['REM', 15], ['LIGHT', 8], ['AWAKE', 2], ['LIGHT', 60], ['REM', 20]], { short: 9 });

test('a night as Google reads it: awake time inside the night, the long spells over 3, REM over asleep plus awake', () => {
  const f = sleepFacts(good);
  assert.deepEqual([f.asleepMin, f.wasoMin, f.longWakeMin, f.awakenings, f.remMin, f.deepMin], [440, 0, 0, 0, 115, 100], 'the spells before the first sleep and after the last do not count');
  assert.equal(f.remPct, 26.1);
  const r = sleepFacts(rough);
  // 15 + 25 + 2 awake inside the night; the 2-minute one is not a long wake.
  assert.deepEqual([r.wasoMin, r.longWakeMin, r.awakenings], [42, 40, 2]);
  assert.equal(r.longWakes, 40 / 3);
  assert.equal(r.remPct, Math.round((35 / (155 + 42)) * 1000) / 10);
  assert.equal(sleepFacts({ asleepMin: 400, stages: [{ s: 0, e: 1, t: 'ASLEEP' }], summary: {} }), null, 'no stages, no score, as in Google\'s app');
  // Only the totals: the awake minutes not before sleep or after waking.
  const totals = sleepFacts({ asleepMin: 420, stages: [], summary: { stages: { DEEP: 70, REM: 90, LIGHT: 260, AWAKE: 60 }, toFallAsleep: 10, afterWake: 5 } });
  assert.deepEqual([totals.wasoMin, totals.longWakeMin, totals.awakenings], [45, 45, null]);
});

test('the score is duration + composition + revitalization, and the parts add up to it', () => {
  // 50·min(1, 440/420)^0.351 + 9.06 + 0.328·26.14 + 25 = 92.6
  const a = sleepScoreOf(good, { goalMin: 420 });
  assert.equal(a.score, 93);
  assert.deepEqual(a.parts.map((p) => [p.id, p.max]), [['duration', 50], ['composition', 25], ['revitalization', 25]]);
  assert.deepEqual(a.parts.map((p) => p.points), [50, 17.6, 25]);
  assert.equal(Math.round(a.parts.reduce((s, p) => s + p.points, 0)), a.score);
  // Short of the goal costs less than in proportion: 70% of it still keeps most of the 50.
  const short = night([['LIGHT', 30], ['DEEP', 60], ['REM', 60], ['LIGHT', 144]]);
  assert.equal(sleepScoreOf(short, { goalMin: 420 }).parts[0].points, 44.1);
  const b = sleepScoreOf(rough, { goalMin: 420 });
  assert.ok(b.score < a.score - 10, `rough ${b.score}`);
  assert.equal(b.parts[2].points, 22.1, '40 min in long spells is 13.3 long wakes, 2.9 points');
  assert.deepEqual([sleepBand(92), sleepBand(85), sleepBand(70), sleepBand(40)], ['Excellent', 'Good', 'Fair', 'Poor']);
});

test('Google\'s own nights (Takeout, v2): the score lands within 3 of Google\'s', () => {
  // [asleep, REM, in-night awake spells (min), Google's score], goal 420.
  const nights = [[457, 110, [], 94.18], [636, 94, [9, 6, 6, 5, 11, 8], 85.06], [515, 46, [22, 10, 5, 6, 115, 2], 74.94], [287, 40, [], 84.11], [438, 86, [3, 7, 5], 89.65]];
  for (const [asleep, rem, spells, google] of nights) {
    const st = [['LIGHT', asleep - rem - 30], ['DEEP', 30], ['REM', rem]];
    // The awake spells sit between sleep stages: split the light sleep around them.
    const parts = []; const light = st[0][1] / (spells.length + 1);
    for (const w of spells) parts.push(['LIGHT', light], ['AWAKE', w]);
    parts.push(['LIGHT', light], st[1], st[2]);
    const s = sleepScoreOf(night(parts), { goalMin: 420 });
    assert.ok(Math.abs(s.score - google) <= 3, `${asleep} min: ours ${s.score}, Google ${google}`);
  }
});

/** 40 days of a person: steady HRV with a wobble, then whatever `last` says for the last day. */
function history(last = {}) {
  const table = {};
  for (let i = 40; i >= 0; i -= 1) {
    const d = addDays('2026-10-21', -i);
    table[d] = { hrv: 40 + 3 * Math.sin(i), rhr: 60 + (i % 3) - 1, hr_avg: 75, sleep_min: 440, sleep_score: 85, kcal_active: 250, kcal_basal: 1700 };
  }
  Object.assign(table['2026-10-21'], last);
  return table;
}
const D = '2026-10-21';

test('readiness: about 61-65 on an ordinary day, up to about 90 when HRV is well above usual, lower when below', () => {
  const ord = readinessOf(readyX(history({ hrv: 41 }), D, addDays));
  assert.ok(ord >= 61 && ord <= 66, `ordinary ${ord}`);
  const high = readinessOf(readyX(history({ hrv: 48 }), D, addDays));
  assert.ok(high >= 85 && high <= 92, `high HRV ${high}`);
  const low = readinessOf(readyX(history({ hrv: 34 }), D, addDays));
  assert.ok(low < 50, `low HRV ${low}`);
  // A resting heart rate up on its usual takes a little off.
  assert.ok(readinessOf(readyX(history({ hrv: 41, rhr: 64 }), D, addDays)) < ord);
  // A night without stages: Google held it at 65, whatever the HRV.
  assert.equal(readinessOf(readyX(history({ hrv: 48, sleep_score: undefined }), D, addDays)), 65);
  // Nothing before 7 nights of HRV (Google's calibration).
  const young = {}; for (let i = 6; i >= 0; i -= 1) young[addDays(D, -i)] = { hrv: 40, rhr: 60, sleep_score: 85 };
  assert.equal(readyX(young, D, addDays), null);
  young[addDays(D, -7)] = { hrv: 40, rhr: 60 };
  assert.ok(readyX(young, D, addDays));
  assert.deepEqual([readyBand(80), readyBand(40), readyBand(10)], ['High', 'Moderate', 'Low']);
});

test('resilience: a busy week reads Low, a quiet one with HRV up reads Balanced; nothing without the week behind it', () => {
  const quiet = history(); const busy = history();
  for (let i = 1; i <= 7; i += 1) { quiet[addDays(D, -i)].kcal_active = 140; busy[addDays(D, -i)].kcal_active = 600; }
  for (let i = 1; i <= 7; i += 1) quiet[addDays(D, -i)].hrv = 45;
  const q = resilienceOf(resilX(quiet, D, addDays, { goalMin: 420 }));
  const b = resilienceOf(resilX(busy, D, addDays, { goalMin: 420 }));
  assert.equal(resilLabel(q), 'Balanced', `quiet ${q}`);
  assert.equal(resilLabel(b), 'Low', `busy ${b}`);
  // A short night takes some off.
  const shortNight = history(); for (let i = 1; i <= 7; i += 1) { shortNight[addDays(D, -i)].kcal_active = 140; shortNight[addDays(D, -i)].hrv = 45; }
  shortNight[D].sleep_min = 250;
  assert.ok(resilienceOf(resilX(shortNight, D, addDays, { goalMin: 420 })) < q);
  // Without last night, or with fewer than 3 worn days in the week, there is none.
  assert.equal(resilX(history({ sleep_min: undefined }), D, addDays), null);
  const bare = history(); for (let i = 1; i <= 5; i += 1) delete bare[addDays(D, -i)].hr_avg;
  assert.equal(resilX(bare, D, addDays), null);
  assert.deepEqual([resilLabel(70), resilLabel(50), resilLabel(20)], ['Optimal', 'Balanced', 'Low']);
});

test('readiness waits for the day\'s night: none before it, a score after', () => {
  const add = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const today = '2026-06-15';
  const t = {};
  for (let i = 1; i <= 10; i += 1) t[add(today, -i)] = { hrv: 45, rhr: 58, sleep_min: 430, sleep_score: 82 };
  t[today] = { steps: 1200 };
  assert.equal(readyX(t, today, add), null, 'awake, no night yet');
  t[today] = { steps: 1200, sleep_min: 420, sleep_score: 80, hrv: 47, rhr: 57 };
  assert.ok(Number.isFinite(readinessOf(readyX(t, today, add))));
});
