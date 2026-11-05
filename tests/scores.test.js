/* This app's own scores (server/core/scores.js): Sleep quality, Recovery
   and Load balance, each from a published rule of thumb over the
   person's own data. Not copies of any other app's. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepFacts, sleepScoreOf, sleepBand, usualBed, readyX, readinessOf, readinessDetail, readyBand, resilX, resilienceOf, resilienceDetail, resilLabel, loadOf } from '../server/core/scores.js';
import { addDays } from '../server/core/util.js';

const MIN = 60_000;
/** A night from 23:00 (or `from`), stage by stage: [type, minutes] ... */
function night(spells, { date = '2026-10-21', from = '2026-10-20T23:00:00Z' } = {}) {
  let t = Date.parse(from);
  const startMs = t;
  const stages = spells.map(([type, m]) => { const x = { s: t, e: t + m * MIN, t: type }; t += m * MIN; return x; });
  const asleep = spells.filter(([k]) => k !== 'AWAKE').reduce((a, [, m]) => a + m, 0);
  return { date, main: true, startMs, endMs: t, startOff: 0, endOff: 0, asleepMin: asleep, periodMin: (t - startMs) / MIN, stages, summary: {} };
}
const good = night([['AWAKE', 8], ['LIGHT', 20], ['DEEP', 60], ['LIGHT', 40], ['REM', 30], ['LIGHT', 50], ['DEEP', 40], ['LIGHT', 45], ['REM', 45], ['LIGHT', 40], ['REM', 40], ['LIGHT', 30], ['AWAKE', 5]]);
const rough = night([['AWAKE', 40], ['LIGHT', 10], ['AWAKE', 15], ['LIGHT', 12], ['DEEP', 20], ['AWAKE', 25], ['LIGHT', 10], ['REM', 15], ['LIGHT', 8], ['AWAKE', 2], ['LIGHT', 60], ['REM', 20]]);
/** Nights before `good`, in bed at `hh`:00 each. */
const before = (hh, n = 7) => Array.from({ length: n }, (_, i) => night([['LIGHT', 420]], { date: addDays('2026-10-21', -(i + 1)), from: `${addDays('2026-10-20', -(i + 1))}T${String(hh).padStart(2, "0")}:00:00Z` }));

test('a night: time asleep and in bed, deep and REM, time awake after first falling asleep', () => {
  const f = sleepFacts(rough);
  assert.equal(f.asleepMin, 155);
  assert.equal(f.inBedMin, 237);
  assert.equal(f.deepMin, 20); assert.equal(f.remMin, 35);
  assert.equal(f.wasoMin, 15 + 25 + 2, 'awake inside the night, not before falling asleep');
  // Only the totals (no stage list): the same from the summary.
  const totals = { ...rough, stages: [], summary: { stages: { DEEP: 20, REM: 35, AWAKE: 82 }, toFallAsleep: 40 } };
  assert.equal(sleepFacts(totals).wasoMin, 42);
  assert.equal(sleepFacts({ asleepMin: 40 }), null, 'under an hour is a device\'s slip, not a night');
});

test('sleep quality: five parts out of their maxima, adding up to the score; a night without stages counts out of the rest', () => {
  const s = sleepScoreOf(good, { prior: before(23) });
  assert.deepEqual(s.parts.map((p) => [p.id, p.max]), [['duration', 40], ['efficiency', 20], ['stages', 20], ['awake', 10], ['regularity', 10]]);
  assert.equal(s.score, Math.round(s.parts.reduce((a, p) => a + p.points, 0)));
  assert.ok(s.score >= 85, `a full, efficient, regular night ${s.score}`);
  assert.equal(s.band, 'Excellent');
  const r = sleepScoreOf(rough, { prior: before(23) });
  assert.ok(r.score < 55, `a short broken night ${r.score}`);
  assert.equal(r.band, 'Poor');
  // No stages: deep and REM is left out and the rest is out of 80, scaled to 100.
  const flat = { ...good, stages: [], summary: { stages: { LIGHT: 440, AWAKE: 13 } } };
  const nf = sleepScoreOf(flat, { prior: before(23) });
  assert.ok(!nf.parts.some((p) => p.id === 'stages'));
  assert.deepEqual(nf.missing.map((m) => m.id), ['stages']);
  assert.ok(nf.score > 80);
  assert.deepEqual([sleepBand(90), sleepBand(75), sleepBand(60), sleepBand(40)], ['Excellent', 'Good', 'Fair', 'Poor']);
});

test('regularity: against the usual bedtime of the 2 weeks before; a nap that was called a main sleep is not a bedtime', () => {
  const at = (hh) => sleepScoreOf(good, { prior: before(hh) }).parts.find((p) => p.id === 'regularity');
  assert.equal(at(23).points, 10, 'the usual time');
  assert.equal(at(1).points, 10 * (120 - 120) / 90, 'two hours off: none');
  assert.ok(at(0).points > 3 && at(0).points < 7, 'an hour off: some');
  assert.equal(sleepScoreOf(good, { prior: before(23, 4) }).parts.find((p) => p.id === 'regularity'), undefined, 'under 5 nights: left out');
  const naps = before(23).map((n) => [n, { ...n, asleepMin: 60, startMs: n.startMs + 17 * 3600_000 }]).flat();
  assert.equal(usualBed(good, naps), usualBed(good, before(23)));
});

function history(last = {}) {
  const table = {};
  for (let i = 40; i >= 0; i -= 1) {
    const d = addDays('2026-10-21', -i);
    table[d] = { hrv: 40 + 3 * Math.sin(i), rhr: 60 + (i % 3) - 1, hr_avg: 75, sleep_min: 440, sleep_score: 75, zone_light: 60, zone_moderate: 20, zone_vigorous: 5, zone_peak: 0 };
  }
  Object.assign(table['2026-10-21'], last);
  return table;
}
const D = '2026-10-21';
const ready = (last) => readinessOf(readyX(history(last), D, addDays));

test('recovery: about 62 on an ordinary morning, high when HRV is up and resting heart rate down, low when the reverse', () => {
  const usual = ready({});
  assert.ok(usual >= 58 && usual <= 66, `usual ${usual}`);
  assert.equal(readyBand(usual), 'Moderate');
  assert.equal(readyBand(ready({ hrv: 50, rhr: 57, sleep_score: 88 })), 'High');
  assert.equal(readyBand(ready({ hrv: 30, rhr: 64, sleep_score: 50 })), 'Low');
  // Each part pulls its own way, and the parts say by how much.
  const d = readinessDetail(readyX(history({ hrv: 46 }), D, addDays));
  assert.ok(d.parts.find((p) => p.id === 'hrv').points > 0);
  assert.ok(ready({ rhr: 63 }) < usual);
  assert.ok(ready({ sleep_score: 50 }) < usual);
  assert.ok(ready({ sleep_score: 95 }) > usual);
  // A raised skin temperature takes a little off, never the whole score.
  assert.equal(ready({ temp_dev: 0.4 }), usual, 'within half a degree: nothing');
  const warm = ready({ temp_dev: 3 });
  assert.ok(warm < usual && warm >= usual - 18, `hot ${warm}`);
  assert.deepEqual([readyBand(80), readyBand(50), readyBand(20)], ['High', 'Moderate', 'Low']);
});

test('recovery waits for the day\'s night and 10 mornings of baseline; without HRV the resting heart rate stands in', () => {
  const t = {};
  for (let i = 1; i <= 10; i += 1) t[addDays('2026-06-15', -i)] = { hrv: 45 + (i % 2), rhr: 58 + (i % 2), sleep_min: 430, sleep_score: 82 };
  t['2026-06-15'] = { steps: 1200 };
  assert.equal(readyX(t, '2026-06-15', addDays), null, 'awake, no night yet');
  t['2026-06-15'] = { sleep_min: 420, sleep_score: 80, hrv: 47, rhr: 57 };
  assert.ok(Number.isFinite(readinessOf(readyX(t, '2026-06-15', addDays))));
  delete t[addDays('2026-06-15', -10)];
  assert.equal(readyX(t, '2026-06-15', addDays), null, '9 mornings: not yet');
  // A watch without HRV: resting heart rate alone, still moving the score.
  const noHrv = history(); for (const r of Object.values(noHrv)) delete r.hrv;
  const calm = readinessDetail(readyX({ ...noHrv, [D]: { ...noHrv[D], rhr: 56 } }, D, addDays));
  assert.deepEqual(calm.parts.map((p) => p.id), ['rhr', 'sleep']);
  assert.ok(calm.score > 62);
});

test('load balance: a steady month is balanced, a spike in load is low, recovery improving on a steady load is optimal', () => {
  const steady = resilienceOf(resilX(history(), D, addDays));
  assert.equal(resilLabel(steady), 'Balanced', `steady ${steady}`);
  // Four times the usual training this week: the acute:chronic ratio well past 1.5.
  const spike = history(); for (let i = 0; i <= 6; i += 1) Object.assign(spike[addDays(D, -i)], { zone_moderate: 90, zone_vigorous: 40, zone_peak: 15 });
  const x = resilX(spike, D, addDays);
  assert.ok(x.acwr > 1.5, `ratio ${x.acwr}`);
  assert.equal(resilLabel(resilienceOf(x)), 'Low');
  // The same load, with HRV up and resting heart rate down over the week.
  const better = history(); for (let i = 0; i <= 6; i += 1) Object.assign(better[addDays(D, -i)], { hrv: 46, rhr: 57 });
  assert.equal(resilLabel(resilienceOf(resilX(better, D, addDays))), 'Optimal');
  const d = resilienceDetail(resilX(better, D, addDays));
  assert.deepEqual(d.parts.map((p) => [p.id, p.max]), [['load', 50], ['trend', 50]]);
  // A load in heart-rate zones, the harder ones counting more.
  assert.equal(loadOf({ zone_light: 10, zone_moderate: 10, zone_vigorous: 10, zone_peak: 10 }), 10 + 20 + 30 + 50);
  assert.equal(loadOf({ steps: 100 }), null);
  // Too few worn days in the four weeks: none.
  const bare = history(); for (let i = 1; i <= 28; i += 1) { const r = bare[addDays(D, -i)]; if (i % 3) { delete r.hr_avg; delete r.zone_light; delete r.zone_moderate; delete r.zone_vigorous; delete r.zone_peak; } }
  assert.equal(resilX(bare, D, addDays), null);
  assert.deepEqual([resilLabel(85), resilLabel(60), resilLabel(30)], ['Optimal', 'Balanced', 'Low']);
});
