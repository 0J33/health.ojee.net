/* The app's own numbers (server/core/derived.js): every part of the sleep
   score, the rescaling when a part is missing, cardio minutes by each of
   their three sources, the recovery trend and its thin-data answers,
   calories and body mass index. Pure functions over made-up data. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepScore, usualTimes, weakestPart, cardioDay, cardioWeek, recovery, caloriesDay, caloriesWeek, bmi, bedMin, wakeMin, SLEEP_PARTS } from '../server/core/derived.js';
import { addDays } from '../server/core/util.js';

const H = 3_600_000;
/** A night that ends on `date` (UTC, offset 0): bed at `bed` hours after
    18:00 the evening before, `inBed` minutes long. */
const night = (date, { bed = 5, inBed = 480, asleep = 450, deep = 80, rem = 100, stages = true, main = true } = {}) => {
  const startMs = Date.parse(`${addDays(date, -1)}T18:00:00Z`) + bed * H;
  return {
    date, main, startMs, endMs: startMs + inBed * 60_000, startOff: 0, endOff: 0, asleepMin: asleep, periodMin: inBed, awakeMin: inBed - asleep,
    summary: { stages: stages ? { DEEP: deep, REM: rem, LIGHT: asleep - deep - rem, AWAKE: inBed - asleep } : {} },
  };
};
const part = (s, id) => s.parts.find((p) => p.id === id);

test('sleep score: a full night at the goal, on time, with good stages scores 100, and every part says what it saw', () => {
  const n = night('2026-03-10');
  const s = sleepScore(n, { goalMin: 450, usualBedMin: bedMin(n), usualWakeMin: wakeMin(n) });
  assert.equal(s.score, 100);
  assert.deepEqual(s.parts.map((p) => [p.id, p.points, p.max]), [['duration', 50, 50], ['stages', 20, 20], ['continuity', 15, 15], ['regularity', 15, 15]]);
  assert.equal(s.basis, 'duration, stages, time awake, regularity');
  assert.equal(part(s, 'duration').text, '7h 30m asleep, at your goal of 7h 30m');
  assert.equal(part(s, 'stages').text, '18% deep and 22% REM of the time asleep');
  assert.equal(part(s, 'continuity').text, 'Asleep for 94% of the 8h 00m in bed');
  assert.equal(part(s, 'regularity').text, 'Bedtime 0 min and wake 0 min from your usual');
  assert.deepEqual(Object.values(SLEEP_PARTS).reduce((a, b) => a + b, 0), 100);
});

test('sleep score, duration: linear to the goal; past goal + 90 minutes it loses a point per ten minutes, never under 40', () => {
  const d = (asleep, goalMin = 450) => part(sleepScore(night('2026-03-10', { asleep, inBed: asleep + 10 }), { goalMin }), 'duration').points;
  assert.equal(d(225), 25);
  assert.equal(d(360), 40);
  assert.equal(d(450), 50);
  assert.equal(d(540), 50, 'exactly goal + 90 still earns everything');
  assert.equal(d(560), 48);
  assert.equal(d(640), 40);
  assert.equal(d(900), 40, 'the floor');
  assert.equal(d(240, 480), 25, 'against the person\'s own goal');
  assert.match(part(sleepScore(night('2026-03-10', { asleep: 390 }), { goalMin: 450 }), 'duration').text, /^6h 30m asleep, 1h 00m short of your goal of 7h 30m$/);
});

test('sleep score, stages: deep is full at 13% and nothing at 5%, REM full at 20% and nothing at 8%', () => {
  const st = (deep, rem) => part(sleepScore(night('2026-03-10', { asleep: 400, inBed: 420, deep, rem }), {}), 'stages').points;
  assert.equal(st(52, 80), 20);          // 13% and 20%
  assert.equal(st(20, 32), 0);           // 5% and 8%
  assert.equal(st(36, 80), 15);          // 9% deep is half way: 5 + 10
  assert.equal(st(52, 56), 15);          // 14% REM is half way: 10 + 5
  assert.equal(st(100, 0), 10, 'no REM at all earns nothing for REM');
});

test('sleep score, continuity: full at 90% asleep of the time in bed, nothing at 75%', () => {
  const c = (asleep, inBed) => part(sleepScore(night('2026-03-10', { asleep, inBed }), {}), 'continuity').points;
  assert.equal(c(450, 500), 15);
  assert.equal(c(375, 500), 0);
  assert.equal(c(412.5, 500), 7.5);
  assert.equal(c(300, 500), 0);
});

test('sleep score, regularity: within 30 minutes of the usual is full, two hours off is nothing, the two are averaged', () => {
  const n = night('2026-03-10');
  const r = (bedOff, wakeOff) => part(sleepScore(n, { usualBedMin: bedMin(n) + bedOff, usualWakeMin: wakeMin(n) + wakeOff }), 'regularity').points;
  assert.equal(r(30, -30), 15);
  assert.equal(r(120, 120), 0);
  assert.equal(r(75, 75), 7.5);
  assert.equal(r(0, 120), 7.5, 'a bedtime on time and a wake two hours off');
  assert.equal(r(-300, 10), 7.5);
});

test('sleep score: a part that cannot be worked out is left out and the rest is rescaled', () => {
  // No stages, no usual: duration and continuity only, out of 65.
  const plain = sleepScore(night('2026-03-10', { stages: false, asleep: 360, inBed: 400 }), { goalMin: 450 });
  assert.deepEqual(plain.parts.map((p) => p.id), ['duration', 'continuity']);
  assert.equal(plain.basis, 'duration, time awake');
  assert.equal(plain.score, Math.round(((40 + 15) / 65) * 100));
  // Stages but no usual: out of 85.
  const staged = sleepScore(night('2026-03-10'), { goalMin: 450 });
  assert.deepEqual(staged.parts.map((p) => p.id), ['duration', 'stages', 'continuity']);
  assert.equal(staged.score, 100);
  // One usual without the other is not a usual.
  assert.equal(sleepScore(night('2026-03-10'), { usualBedMin: 300 }).parts.some((p) => p.id === 'regularity'), false);
  // No time in bed: duration alone still gives a score.
  const bare = sleepScore({ asleepMin: 225, summary: {} }, { goalMin: 450 });
  assert.deepEqual([bare.score, bare.basis], [50, 'duration']);
  // Nothing to score.
  for (const x of [null, {}, { asleepMin: 0 }, { asleepMin: NaN }]) assert.deepEqual(sleepScore(x), { score: null, parts: [], basis: null });
});

test('the usual bedtime and wake: medians of the main nights in the 14 days before, null under five of them', () => {
  const dates = [1, 2, 3, 4, 5, 6].map((k) => addDays('2026-03-10', -k));
  const nights = dates.map((d, i) => night(d, { bed: 5 + (i % 2) * 0.5 }));
  const cur = night('2026-03-10');
  assert.deepEqual(usualTimes(nights.slice(0, 4), cur), { usualBedMin: null, usualWakeMin: null, n: 4 });
  const u = usualTimes(nights, cur);
  assert.deepEqual([u.usualBedMin, u.n], [315, 6]);
  // Naps, the night itself, later nights and nights older than 14 days do not count.
  const noise = [night('2026-03-09', { main: false, bed: 12 }), cur, night('2026-03-11', { bed: 9 }), night('2026-02-20', { bed: 9 })];
  assert.deepEqual(usualTimes([...nights, ...noise], cur), u);
  assert.equal(usualTimes([], cur).n, 0);
  // A bedtime after midnight sorts after one before it.
  assert.ok(bedMin(night('2026-03-10', { bed: 6.5 })) > bedMin(night('2026-03-10', { bed: 5.5 })));
  assert.deepEqual(weakestPart(sleepScore(night('2026-03-10', { asleep: 300, inBed: 320 }), { goalMin: 450 }).parts).id, 'duration');
  assert.equal(weakestPart([]), null);
});

test('cardio minutes for a day: zone minutes first, then time in zones, then active minutes', () => {
  assert.deepEqual(cardioDay({ azm: 30, azm_fat: 20, azm_cardio: 8, azm_peak: 2, zone_moderate: 99, active_min: 99 }), { minutes: 30, light: null, moderate: 20, vigorous: 10, source: 'azm' });
  assert.deepEqual(cardioDay({ zone_light: 200, zone_moderate: 20, zone_vigorous: 5, zone_peak: 1, active_min: 99 }), { minutes: 32, light: 200, moderate: 20, vigorous: 6, source: 'zones' });
  assert.deepEqual(cardioDay({ zone_vigorous: 4 }), { minutes: 8, light: null, moderate: 0, vigorous: 4, source: 'zones' });
  assert.deepEqual(cardioDay({ active_min: 25 }), { minutes: 25, light: null, moderate: 25, vigorous: null, source: 'active' });
  assert.deepEqual(cardioDay({ azm: 0 }), { minutes: 0, light: null, moderate: null, vigorous: null, source: 'azm' });
  assert.equal(cardioDay({ zone_light: 300 }), null, 'light time alone is not cardio');
  assert.equal(cardioDay({ steps: 9000 }), null);
  assert.equal(cardioDay(undefined), null);
});

test('a cardio week: Monday to Sunday against the target, nothing counted from the future, twelve weeks of history', () => {
  const today = '2026-03-12';   // a Thursday
  const table = {};
  for (let k = 0; k < 90; k += 1) table[addDays(today, -k)] = { azm: 20 };
  table['2026-03-13'] = { azm: 500 };   // tomorrow: must not count
  const w = cardioWeek({ table, today, target: 100 });
  assert.deepEqual([w.minutes, w.target, w.pct, w.source], [80, 100, 80, 'zone minutes']);
  assert.deepEqual(w.days.map((d) => d.minutes), [20, 20, 20, 20, null, null, null]);
  assert.equal(w.days[0].date, '2026-03-09');
  assert.equal(w.weeks.length, 12);
  assert.deepEqual(w.weeks[11], { week: '2026-03-09', minutes: 80, target: 100, hit: false });
  assert.deepEqual(w.weeks[10], { week: '2026-03-02', minutes: 140, target: 100, hit: true });
  assert.equal(w.weeks[0].week, addDays('2026-03-09', -77));
  // Another week, by its Monday.
  assert.equal(cardioWeek({ table, today, weekStart: '2026-03-02', target: 150 }).minutes, 140);
  // The source is the one most of the week's days came from.
  const mixed = { '2026-03-09': { active_min: 10 }, '2026-03-10': { active_min: 10 }, '2026-03-11': { azm: 5 } };
  assert.equal(cardioWeek({ table: mixed, today, target: 150 }).source, 'active minutes');
  // Nothing at all.
  const none = cardioWeek({ table: {}, today });
  assert.deepEqual([none.minutes, none.pct, none.source, none.target], [null, null, null, 150]);
  assert.ok(none.weeks.every((x) => x.minutes === null && x.hit === false));
  assert.equal(none.days.length, 7);
});

test('the recovery trend: 7 days against the 30 before, up is better, and thin data says so', () => {
  const today = '2026-03-31';
  const make = (hrvNow, rhrNow, { hrv = true, rhr = true, base = 30, recent = 7 } = {}) => {
    const t = {};
    for (let k = 7; k < 7 + base; k += 1) t[addDays(today, -k)] = { ...(hrv ? { hrv: 50 + (k % 2 ? 4 : -4) } : {}), ...(rhr ? { rhr: 60 + (k % 2 ? 2 : -2) } : {}) };
    for (let k = 0; k < recent; k += 1) t[addDays(today, -k)] = { ...(hrv ? { hrv: hrvNow } : {}), ...(rhr ? { rhr: rhrNow } : {}) };
    return t;
  };
  const same = recovery({ table: make(50, 60), today });
  assert.deepEqual([same.available, same.label, same.z], [true, 'near your usual', 0]);
  assert.deepEqual(same.parts.map((p) => [p.id, p.value, p.baseline, p.z]), [['hrv', 50, 50, 0], ['rhr', 60, 60, 0]]);
  assert.equal(same.days.length, 7);
  assert.equal(same.days[6].date, today);

  const good = recovery({ table: make(58, 56), today });
  assert.equal(good.label, 'above your usual');
  assert.ok(good.parts.every((p) => p.z > 0), 'higher HRV and a lower resting heart rate both count as up');
  const poor = recovery({ table: make(42, 64), today });
  assert.equal(poor.label, 'below your usual');
  assert.equal(poor.z, -good.z);
  assert.match(poor.text, /^Your recovery signals over the last 7 days are below your usual: HRV 42 ms against 50, resting heart rate 64 bpm against 60 over the 30 days before\. A trend calculated by this app from HRV and resting heart rate; it measures nothing else\.$/);
  assert.ok(!/stress|score/i.test(poor.text));

  // One signal is enough.
  const only = recovery({ table: make(50, 66, { hrv: false }), today });
  assert.deepEqual([only.available, only.parts.map((p) => p.id), only.label], [true, ['rhr'], 'below your usual']);
  // Thin: under 14 baseline days, or under 3 of the last 7.
  for (const t of [make(58, 56, { base: 13 }), make(58, 56, { recent: 2 }), {}]) {
    const r = recovery({ table: t, today });
    assert.deepEqual([r.available, r.label, r.z, r.parts], [false, null, null, []]);
    assert.match(r.text, /^Not enough days yet/);
    assert.equal(r.days.length, 7);
  }
  // A dead-flat baseline does not turn one beat into a large deviation.
  const flat = {};
  for (let k = 7; k < 37; k += 1) flat[addDays(today, -k)] = { rhr: 60 };
  for (let k = 0; k < 7; k += 1) flat[addDays(today, -k)] = { rhr: 61 };
  assert.equal(recovery({ table: flat, today }).z, -1);
});

test('calories and body mass index', () => {
  assert.deepEqual(caloriesDay({ kcal: 2400.4, kcal_active: 600, kcal_basal: 1800 }), { total: 2400, active: 600, basal: 1800 });
  assert.deepEqual(caloriesDay({ kcal: 2400, kcal_active: 600 }), { total: 2400, active: 600, basal: 1800 }, 'resting = total - active');
  assert.deepEqual(caloriesDay({ kcal: 500, kcal_active: 600 }), { total: 500, active: 600, basal: 0 }, 'never below zero');
  assert.deepEqual(caloriesDay({ kcal: 2100 }), { total: 2100, active: null, basal: null });
  assert.equal(caloriesDay({ steps: 1 }), null);
  assert.equal(caloriesDay(undefined), null);
  const week = caloriesWeek({ '2026-03-10': { kcal: 2000, kcal_active: 400 } }, '2026-03-12');
  assert.equal(week.length, 7);
  assert.deepEqual(week[4], { date: '2026-03-10', total: 2000, active: 400, basal: 1600 });
  assert.deepEqual(week[6], { date: '2026-03-12', total: null, active: null, basal: null });
  assert.equal(bmi(80, 1800), 24.7);
  assert.equal(bmi(60, 1650), 22);
  for (const [kg, mm] of [[null, 1800], [80, null], [0, 1800], [80, 0], [NaN, 1800]]) assert.equal(bmi(kg, mm), null);
});
