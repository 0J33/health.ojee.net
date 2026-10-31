/* Reference ranges (core/ranges.js): each metric's bands at their
   boundaries, the ones that change with sex and age, the person's own
   usual range, and what the metric page and the list carry, for the
   person alone. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rangeFor, rangeNeeds, bandIndex, ownBaseline, vo2Cuts, sleepHours, RANGED, NOTE } from '../server/core/ranges.js';
import { METRICS, metricById } from '../server/catalog.js';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';

const at = (id, v, p, o) => rangeFor(id, v, p, o)?.current ?? null;
const M35 = { sex: 'male', age: 35 };
const F25 = { sex: 'female', age: 25 };

/* ── the module ─────────────────────────────────────────────────────── */

test('every ranged id is a metric of the catalogue, and every range has a source and the wellness note', () => {
  const p = { sex: 'female', age: 40, heightCm: 168, weightKg: 62 };
  const sample = { resting_hr: 60, hrv: 50, vo2max: 35, recovery: 0, readiness: 60, resilience: 50, steps: 8000, active: 30, cardio_week: 200, sleep: 450, sleep_score: 85, sleep_stages: null,
    sleep_efficiency: 90, weight: 62, body_fat: 25, measurements: 75, muscle_mass: 40, body_water: 55, visceral_fat: 5, basal_rate: 1300, body_score: 85, bmi: 22, resp: 14, spo2: 97, skin_temp: 0, body_temp: 36.8, glucose: 90, stress: 30, body_battery: 80 };
  const base = Array.from({ length: 20 }, (_, i) => 48 + (i % 5));
  for (const id of RANGED) {
    assert.ok(metricById(id), id);
    if (id === 'sleep_stages') continue;   // ranged by its parts, deep and rem
    const r = rangeFor(id, sample[id], p, { baseline: id === 'skin_temp' ? base.map((x) => (x - 50) / 10) : base });
    assert.ok(r, id);
    assert.ok(r.bands.length >= 2, id);
    assert.ok(r.source?.name, id);
    assert.ok(r.note.endsWith(NOTE), id);
    assert.ok(r.bands.every((b) => ['good', 'ok', 'low', 'high'].includes(b.tone)), id);
    assert.ok(r.current, `${id}: ${sample[id]} falls in a band`);
    // Bands are in order and touch.
    for (let i = 1; i < r.bands.length; i += 1) assert.equal(r.bands[i].from, r.bands[i - 1].to, `${id} band ${i}`);
    assert.equal(r.bands[0].from, null); assert.equal(r.bands.at(-1).to, null);
  }
  for (const id of ['deep', 'rem']) assert.ok(rangeFor(id, 20));
});

test('metrics with no sensible range have none, and no word of diagnosis or alarm is used', () => {
  for (const id of ['heart_rate', 'distance', 'floors', 'altitude', 'calories', 'calories_active', 'calories_basal', 'sedentary', 'activity_levels', 'swim', 'workouts', 'zones', 'zone_calories',
    'ecg', 'irn', 'height', 'body_composition', 'body_age', 'water', 'food', 'mood', 'period', 'ovulation', 'symptoms']) assert.equal(rangeFor(id, 50, M35), null, id);
  for (const m of METRICS) assert.equal(RANGED.includes(m.id) || rangeFor(m.id, 50, M35) === null, true, m.id);
  const words = RANGED.flatMap((id) => { const r = rangeFor(id, 50, { sex: 'male', age: 40, heightCm: 180, weightKg: 80 }, { baseline: Array(12).fill(50).map((x, i) => x + i) }); return r ? [r.note, ...r.bands.map((b) => b.label)] : []; }).join(' ');
  assert.doesNotMatch(words, /diabet|prediabet|hypertens|obes|disease|danger|risk|tachycard|bradycard|hypox|apnea|apnoea|emergency/i);
  assert.equal(rangeFor('steps', NaN), null);
});

test('resting heart rate: AHA 60 to 100 is typical, below 60 low, under 40 very low', () => {
  assert.equal(at('resting_hr', 39), 'Very low');
  assert.equal(at('resting_hr', 40), 'Low');
  assert.equal(at('resting_hr', 59), 'Low');
  assert.equal(at('resting_hr', 60), 'Typical');
  assert.equal(at('resting_hr', 100), 'Typical');
  assert.equal(at('resting_hr', 101), 'High');
  const r = rangeFor('resting_hr', 58);
  assert.equal(r.tone, 'good');
  assert.equal(r.source.name, 'American Heart Association');
  assert.deepEqual([r.bands[2].toShown, r.bands[3].over], [100, 100], 'written as 60 to 100, over 100');
});

test('steps: Tudor-Locke\'s five bands', () => {
  assert.deepEqual([4999, 5000, 7499, 7500, 9999, 10000, 12499, 12500].map((v) => at('steps', v)),
    ['Sedentary', 'Low active', 'Low active', 'Somewhat active', 'Somewhat active', 'Active', 'Active', 'Highly active']);
});

test('active minutes a day and cardio minutes a week: the WHO\'s 150 to 300 a week', () => {
  assert.deepEqual([149, 150, 299, 300].map((v) => at('cardio_week', v)), ['Under guideline', 'Meets guideline', 'Meets guideline', 'Above guideline']);
  assert.deepEqual([21, 22, 42, 43].map((v) => at('active', v)), ['Under guideline', 'Meets guideline', 'Meets guideline', 'Above guideline']);
});

test('VO2 max: the Cooper Institute\'s norms, by sex and age; none without both', () => {
  assert.deepEqual(vo2Cuts('male', 25), [41.7, 45.4, 51.1, 55.4]);
  assert.deepEqual(vo2Cuts('female', 25), [36.1, 39.5, 43.9, 49.6]);
  assert.deepEqual(vo2Cuts('male', 45), [38.5, 42.4, 46.4, 52.5]);
  assert.deepEqual(vo2Cuts('female', 85), [25.9, 28.1, 30.9, 36.7], 'over 79: the 70s row');
  assert.deepEqual(vo2Cuts('male', 18), vo2Cuts('male', 25), 'under 20: the 20s row');
  assert.equal(vo2Cuts('male', 12), null);
  assert.deepEqual([40.4, 40.5, 43.9, 44, 48.3, 54].map((v) => at('vo2max', v, M35)), ['Poor', 'Fair', 'Fair', 'Good', 'Excellent', 'Superior']);
  assert.equal(at('vo2max', 44, F25), 'Excellent');
  assert.equal(at('vo2max', 40, F25), 'Good');
  assert.equal(at('vo2max', 44, { sex: 'female', age: 65 }), 'Superior', 'the same number is rated by age');
  assert.equal(rangeFor('vo2max', 44, { sex: 'male' }), null);
  assert.equal(rangeFor('vo2max', 44, { age: 30 }), null);
  assert.deepEqual(rangeNeeds('vo2max', {}), ['sex', 'age']);
  assert.deepEqual(rangeNeeds('vo2max', M35), []);
  assert.match(rangeFor('vo2max', 44, M35).note, /men aged 30 to 39/);
});

test('sleep: the National Sleep Foundation\'s hours, by age when it is known', () => {
  assert.deepEqual(sleepHours(null), [6, 7, 9, 10]);
  assert.deepEqual(sleepHours(16), [7, 8, 10, 11]);
  assert.deepEqual(sleepHours(20), [6, 7, 9, 11]);
  assert.deepEqual(sleepHours(70), [5, 7, 8, 9]);
  const h = (x) => x * 60;
  assert.deepEqual([h(5.9), h(6), h(7), h(9) - 1, h(9), h(10)].map((v) => at('sleep', v, { age: 40 })), ['Short', 'May be enough', 'Recommended', 'Recommended', 'May be enough', 'Long']);
  assert.equal(at('sleep', h(8.5), { age: 70 }), 'May be enough', 'over 8 hours at 70');
  assert.equal(at('sleep', h(7.5), { age: 16 }), 'May be enough', 'under 8 hours at 16');
  assert.equal(at('sleep', h(7.5)), 'Recommended', 'without an age: the adult hours');
  assert.deepEqual(rangeNeeds('sleep', {}), []);
});

test('sleep score, readiness, resilience, body score, recovery: the app\'s own bands', () => {
  assert.deepEqual([59, 60, 79, 80, 89, 90].map((v) => at('sleep_score', v)), ['Poor', 'Fair', 'Fair', 'Good', 'Good', 'Excellent']);
  assert.deepEqual([29, 30, 64, 65].map((v) => at('readiness', v)), ['Low', 'Moderate', 'Moderate', 'High']);
  assert.deepEqual([34, 35, 64, 65].map((v) => at('resilience', v)), ['Low', 'Balanced', 'Balanced', 'Optimal']);
  assert.deepEqual([59, 60, 80, 90].map((v) => at('body_score', v)), ['Low', 'Fair', 'Good', 'Excellent']);
  assert.deepEqual([-0.6, -0.5, 0.4, 0.5].map((v) => at('recovery', v)), ['Below your usual', 'Near your usual', 'Near your usual', 'Above your usual']);
  assert.equal(rangeFor('readiness', 50).source.url, null);
});

test('sleep efficiency and stages', () => {
  assert.deepEqual([74, 75, 84, 85].map((v) => at('sleep_efficiency', v)), ['Low', 'Fair', 'Fair', 'Good']);
  assert.deepEqual([12.9, 13, 24.9, 25].map((v) => at('deep', v)), ['Below typical', 'Typical', 'Typical', 'Above typical']);
  assert.deepEqual([19.9, 20, 25, 25.6].map((v) => at('rem', v)), ['Below typical', 'Typical', 'Typical', 'Above typical']);
  assert.equal(rangeFor('deep', 20).title, 'Deep sleep');
});

test('vitals: breathing, blood oxygen, body temperature, glucose', () => {
  assert.deepEqual([11.9, 12, 18, 18.1].map((v) => at('resp', v)), ['Below typical', 'Typical', 'Typical', 'Above typical']);
  assert.deepEqual([91.9, 92, 94.9, 95, 100].map((v) => at('spo2', v)), ['Low', 'Below typical', 'Below typical', 'Typical', 'Typical']);
  assert.deepEqual([36.4, 36.5, 37.3, 37.4, 38].map((v) => at('body_temp', v)), ['Below typical', 'Typical', 'Typical', 'Slightly raised', 'Raised']);
  assert.deepEqual([69, 70, 99, 100, 125, 126].map((v) => at('glucose', v)), ['Low', 'Typical', 'Typical', 'Above typical', 'Above typical', 'High']);
  const g = rangeFor('glucose', 90);
  assert.equal(g.title, 'For a fasting reading');
  assert.match(g.note, /fasting/);
  assert.equal(g.source.name, 'American Diabetes Association');
});

test('Garmin\'s stress and Body Battery levels', () => {
  assert.deepEqual([25, 26, 50, 51, 75, 76].map((v) => at('stress', v)), ['Rest', 'Low', 'Low', 'Medium', 'Medium', 'High']);
  assert.deepEqual([25, 26, 50, 51, 75, 76].map((v) => at('body_battery', v)), ['Very low', 'Low', 'Low', 'Medium', 'Medium', 'High']);
});

test('body: the scale app\'s ranges (core/bodycomp.js), the WHO\'s waist and waist-to-hip; each needs what it needs', () => {
  assert.deepEqual([18.4, 18.5, 24.9, 25, 28, 32].map((v) => at('bmi', v)), ['Low', 'Standard', 'Standard', 'High', 'Very high', 'Very high']);
  assert.equal(at('weight', 70, { heightCm: 180 }), 'Standard');
  assert.equal(at('weight', 85, { heightCm: 180 }), 'High');
  assert.equal(rangeFor('weight', 70, {}), null);
  assert.deepEqual(rangeNeeds('weight', {}), ['height']);
  assert.equal(at('body_fat', 20, M35), 'Standard');
  assert.equal(at('body_fat', 20, F25), 'Low', 'the same body fat, a woman\'s ranges');
  assert.equal(at('body_fat', 24, F25), 'Lean');
  assert.equal(rangeFor('body_fat', 24, F25).tone, 'good');
  assert.equal(rangeFor('body_fat', 20, { sex: 'male' }), null);
  assert.equal(at('muscle_mass', 62, { sex: 'male', heightCm: 178 }), 'High');
  assert.equal(rangeFor('muscle_mass', 62, { sex: 'male', heightCm: 178 }).tone, 'good', 'more muscle is not a worry');
  assert.equal(at('visceral_fat', 9), 'Standard');
  assert.equal(at('visceral_fat', 10), 'High');
  assert.deepEqual(rangeNeeds('basal_rate', { sex: 'male', age: 30 }), ['weight']);
  assert.deepEqual([93.9, 94, 101.9, 102].map((v) => at('measurements', v, { sex: 'male' })), ['Standard', 'Raised', 'Raised', 'High']);
  assert.deepEqual([79.9, 80, 88].map((v) => at('measurements', v, { sex: 'female' })), ['Standard', 'Raised', 'High']);
  assert.equal(rangeFor('measurements', 90, {}), null);
  assert.deepEqual([0.89, 0.9].map((v) => at('whr', v, { sex: 'male' })), ['Standard', 'High']);
  assert.deepEqual([0.84, 0.85].map((v) => at('whr', v, { sex: 'female' })), ['Standard', 'High']);
});

test('HRV and sleep temperature: the person\'s own last 30 days, never a population range', () => {
  assert.equal(ownBaseline([1, 2, 3]), null, 'under 10 days: none');
  assert.equal(rangeFor('hrv', 50, {}, { baseline: [50, 51] }), null);
  const base = [40, 42, 44, 46, 48, 50, 52, 54, 56, 58];
  const b = ownBaseline(base);
  assert.equal(b.mean, 49);
  const r = rangeFor('hrv', 49, {}, { baseline: base });
  assert.equal(r.current, 'Your usual');
  assert.equal(r.source.name, 'Your own last 30 days');
  assert.equal(r.bands[0].to, Math.round((49 - b.sd) * 100) / 100);
  assert.equal(at('hrv', 40, {}, { baseline: base }), 'Below your usual');
  assert.equal(at('hrv', 60, {}, { baseline: base }), 'Above your usual');
  assert.equal(rangeFor('hrv', 60, {}, { baseline: base }).tone, 'good');
  // A flat baseline still has a band to be in.
  assert.equal(at('hrv', 50, {}, { baseline: Array(12).fill(50) }), 'Your usual');
  assert.equal(at('skin_temp', 0.6, {}, { baseline: Array.from({ length: 14 }, (_, i) => (i % 3) / 10 - 0.1) }), 'Above your usual');
});

test('bandIndex: a value on a cut-off is in the band above', () => {
  const bands = [{ from: null, to: 10 }, { from: 10, to: 20 }, { from: 20, to: null }];
  assert.deepEqual([9.99, 10, 19.99, 20, -5, 1e6].map((v) => bandIndex(bands, v)), [0, 1, 1, 2, 0, 2]);
  assert.equal(bandIndex(bands, NaN), -1);
});

/* ── through the app ────────────────────────────────────────────────── */

let r; let full; let friend;
before(async () => {
  r = await rig();
  full = await personWith(r, 'ranger', { persona: 'fitbit' });
  friend = await personWith(r, 'rangefriend', { persona: 'fitbit' });
});
after(async () => { await r.close(); });

const keysOf = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); } return out; };

test('the metric page carries the range of the number it leads with; the list carries a band per row', async () => {
  const day = (await full.c.get('/api/metric/resting_hr?range=day')).json;
  assert.equal(day.ranges.length, 1);
  const rg = day.ranges[0];
  assert.deepEqual(Object.keys(rg), ['id', 'title', 'value', 'bands', 'at', 'current', 'tone', 'source', 'note', 'basis']);
  assert.equal(rg.value, day.stats.latest.value, 'a day: its own value');
  assert.equal(rg.basis, 'day');
  const week = (await full.c.get('/api/metric/resting_hr?range=week')).json;
  assert.equal(week.ranges[0].value, week.stats.avg, 'a week: the average day, as the hero shows');
  assert.equal(week.ranges[0].basis, 'average');
  assert.deepEqual(week.rangeNeeds, []);
  const steps = (await full.c.get('/api/metric/steps?range=day')).json;
  assert.equal(steps.ranges[0].basis, 'day-so-far', 'today\'s steps are a day not over');
  const cardio = (await full.c.get('/api/metric/cardio_week?range=week')).json;
  if (cardio.stats.count) { assert.equal(cardio.ranges[0].value, cardio.stats.total); assert.equal(cardio.ranges[0].basis, 'week'); }
  const stages = (await full.c.get('/api/metric/sleep_stages?range=week')).json;
  assert.deepEqual(stages.ranges.map((x) => x.id), ['deep', 'rem']);
  const hr = (await full.c.get('/api/metric/heart_rate?range=week')).json;
  assert.deepEqual([hr.ranges, hr.rangeNeeds], [[], []], 'heart rate across a day has no range');

  const b = (await full.c.get('/api/browse')).json;
  const rows = Object.fromEntries(b.categories.flatMap((c) => c.metrics).map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(rows.resting_hr.band), ['label', 'tone', 'basis']);
  assert.equal(rows.resting_hr.band.label, rangeFor('resting_hr', rows.resting_hr.latest.value).current);
  assert.equal(rows.steps.band.basis, 'average-7', 'a running total is judged on the 7 days before today');
  assert.equal(rows.heart_rate.band, undefined);
  assert.equal(rows.sleep_stages.band, undefined);
  // Pins on Today carry no band: the list alone shows it.
  await full.c.post('/api/pins', { id: 'resting_hr', on: true });
  const brief = (await full.c.get('/api/brief')).json;
  for (const p of brief.extra?.pinned || []) assert.equal(p.band, undefined);
});

test('sex and age change the ranges, and are never in a range payload nor in anything of anybody else\'s', async () => {
  const before0 = (await full.c.get('/api/metric/vo2max?range=week')).json;
  assert.ok(before0.stats.count, 'the persona has VO2 max this week');
  assert.deepEqual([before0.ranges, before0.rangeNeeds], [[], ['sex', 'age']]);
  const year = new Date().getUTCFullYear();
  assert.equal((await full.c.patch('/api/settings', { body: { sex: 'female', birthYear: year - 34 } })).status, 200);
  const after0 = (await full.c.get('/api/metric/vo2max?range=week')).json;
  assert.equal(after0.ranges.length, 1);
  assert.equal(after0.ranges[0].source.name, 'The Cooper Institute');
  assert.match(after0.ranges[0].note, /women aged 30 to 39/);
  assert.deepEqual(after0.rangeNeeds, []);
  // The person's own payloads: no sex, birth year or age keys, outside the body composition page that has always had them.
  for (const path of ['/api/browse', '/api/metric/vo2max?range=week', '/api/metric/body_fat?range=week', '/api/metric/sleep?range=month']) {
    const keys = [...keysOf((await full.c.get(path)).json)];
    assert.deepEqual(keys.filter((k) => /^(sex|birthYear|birth|age|gender)$/i.test(k)), [], path);
  }
  // Nobody else sees a range or a band of theirs.
  for (const path of ['/api/users/ranger', '/api/people', '/api/feed?limit=50', '/api/boards?period=week']) {
    const x = await friend.c.get(path);
    assert.ok(x.status < 500, path);
    const keys = [...keysOf(x.json)];
    assert.deepEqual(keys.filter((k) => /^(ranges|rangeNeeds|band|sex|birthYear)$/.test(k)), [], path);
  }
  await full.c.patch('/api/settings', { body: { sex: null, birthYear: null } });
});
