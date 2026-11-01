/* Browse, the metric page, pins and Today's extras through the running
   app, for a person with everything, one with part of it, one with only a
   phone and one with nothing at all. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { METRICS, RANGES, CHART_KINDS, metricById, MAX_PINS } from '../server/catalog.js';
import { GROUP_IDS } from '../server/core/google.js';
import { addDays, today as todayIn, weekOf } from '../server/core/util.js';
import { demoEntries } from '../server/demo.js';
import { addEntry } from '../server/core/entries.js';
/** The scale's numbers on their own: only somebody with a body composition scale has them. */
const SCALE_ONLY = ['muscle_mass', 'body_water', 'skeletal_muscle', 'protein_mass', 'bone_mineral', 'visceral_fat', 'basal_rate', 'body_age', 'body_score'];

let r; let full; let part; let phone; let fresh;
const TZ = 'Africa/Cairo';
const today = () => todayIn(Date.now(), TZ);
const ids = (b) => b.categories.flatMap((c) => c.metrics.map((m) => m.id));
const get = async (p, path) => { const x = await p.c.get(path); assert.equal(x.status, 200, `${path}: ${x.text.slice(0, 200)}`); return x.json; };

before(async () => {
  r = await rig();
  full = await personWith(r, 'full', { groups: GROUP_IDS });
  part = await personWith(r, 'part', { persona: 'pixel', groups: ['nutrition', 'mindfulness'] });
  phone = await personWith(r, 'phoneonly', { persona: 'phone' });
  fresh = await r.person('fresh');
  for (const [p, groups] of [[full, GROUP_IDS], [part, ['nutrition', 'mindfulness']]]) {
    await r.app.worlds.hold(p.id, async (w) => { for (const [kind, fields] of demoEntries(groups, TZ, Date.now())) await addEntry(w, kind, fields); });
  }
});
after(async () => { await r.close(); });

const METRIC_KEYS = ['id', 'label', 'category', 'family', 'icon', 'unit', 'kind', 'latest', 'spark', 'pinned', 'canAdd', 'sensitive', 'group', 'own', 'decimals', 'format', 'signed'];

test('signed out: 401 on every new route', async () => {
  const c = r.client();
  for (const p of ['/api/browse', '/api/metric/steps']) assert.equal((await c.get(p)).status, 401, p);
  for (const p of ['/api/pins', '/api/entries', '/api/google/groups']) assert.equal((await c.post(p, {})).status, 401, p);
  assert.equal((await full.c.post('/api/pins', { id: 'steps', on: true }, { origin: 'https://elsewhere.test' })).status, 403, 'a write needs this site\'s Origin');
});

test('GET /api/browse: somebody with everything has every metric, each with a value and a trend', async () => {
  const b = await get(full, '/api/browse');
  assert.deepEqual(Object.keys(b), ['today', 'tz', 'categories', 'empty', 'pinned', 'shownIsDefault', 'groups']);
  assert.deepEqual([b.today, b.tz, b.pinned], [today(), TZ, []]);
  assert.deepEqual(b.categories.map((c) => [c.id, c.label]), [['activity', 'Activity'], ['heart', 'Heart'], ['sleep', 'Sleep'], ['body', 'Body'], ['vitals', 'Vitals'], ['nutrition', 'Nutrition'], ['mindfulness', 'Mindfulness'], ['cycle', 'Cycle'], ['other', 'Other']]);
  // Everything a Fitbit with all five groups gives. Glucose and body temperature come from its meter and thermometer.
  // Body composition comes from a Xiaomi scale only (tests/xiaomi.test.js);
  // stress and Body Battery from a Garmin read directly (tests/garmin.test.js),
  // and stress can also be logged here.
  assert.deepEqual(ids(b), METRICS.filter((m) => !['body_composition', ...SCALE_ONLY, 'stress', 'body_battery'].includes(m.id)).map((m) => m.id));
  assert.deepEqual(b.empty.map((e) => [e.id, e.canAdd]), [['body_composition', false], ...SCALE_ONLY.map((id) => [id, false]), ['stress', true], ['body_battery', false]]);
  for (const m of b.categories.flatMap((c) => c.metrics)) {
    // A row may carry its reference band (core/ranges.js), last.
    assert.deepEqual(Object.keys(m).filter((k) => k !== 'band' && k !== 'shown'), METRIC_KEYS, m.id);
    assert.equal(typeof m.shown, 'boolean', m.id);
    if (m.band) assert.deepEqual(Object.keys(m.band), ['label', 'tone', 'basis'], m.id);
    const def = metricById(m.id);
    assert.deepEqual([m.label, m.category, m.family, m.icon, m.unit, m.kind, m.sensitive, m.group, m.own], [def.label, def.category, def.family, def.icon, def.unit, def.kind, def.sensitive, def.group, def.own], m.id);
    assert.deepEqual(Object.keys(m.latest), ['value', 'text', 'at', 'date'], m.id);
    assert.ok(typeof m.latest.text === 'string' && m.latest.text.length > 0, `${m.id} text`);
    assert.match(m.latest.date, /^\d{4}-\d{2}-\d{2}$/, m.id);
    assert.ok(m.latest.date <= b.today, m.id);
    assert.ok(Array.isArray(m.spark) && m.spark.length >= 1 && m.spark.length <= 14, `${m.id} spark of ${m.spark.length}`);
    assert.ok(m.spark.every((v) => v === null || Number.isFinite(v)), m.id);
    assert.equal(m.pinned, false);
  }
  const by = Object.fromEntries(b.categories.flatMap((c) => c.metrics).map((m) => [m.id, m]));
  assert.equal(by.steps.spark.length, 14);
  assert.equal(by.cardio_week.spark.length, 12, 'a metric counted by the week trends by the week');
  assert.match(by.steps.latest.text, /^[\d,]+ steps$/);
  assert.match(by.sleep.latest.text, /^\dh \d\dm$/);
  assert.match(by.recovery.latest.text, /your usual$/);
  assert.match(by.food.latest.text, /^[\d,]+ kcal$/);
  assert.ok(by.water.latest.at > 0 && by.mood.latest.at > 0, 'a logged kind says when its last entry was');
  assert.deepEqual(Object.entries(by).filter(([, m]) => m.canAdd).map(([id]) => id), ['sleep', 'weight', 'body_fat', 'height', 'measurements', 'body_temp', 'glucose', 'water', 'food', 'mood', 'period', 'ovulation', 'symptoms']);
  assert.deepEqual(b.groups.map((g) => [g.id, g.mode]), GROUP_IDS.map((id) => [id, 'google']));
});

test('GET /api/browse: a partial device has what it reports; the rest is "no data yet" with who provides it; groups not chosen are off', async () => {
  const b = await get(part, '/api/browse');
  const have = ids(b);
  for (const id of ['steps', 'floors', 'calories_active', 'resting_hr', 'hrv', 'zones', 'vo2max', 'sleep', 'sleep_score', 'sleep_stages', 'resp', 'spo2', 'weight', 'height', 'bmi', 'water', 'food', 'mood', 'cardio_week', 'recovery']) assert.ok(have.includes(id), `pixel should have ${id}`);
  for (const id of ['skin_temp', 'body_fat', 'glucose', 'body_temp', 'swim', 'ecg', 'irn', 'period', 'ovulation', 'symptoms']) assert.ok(!have.includes(id), `pixel should not have ${id}`);
  assert.deepEqual(new Set([...have, ...b.empty.map((e) => e.id)]).size, METRICS.length, 'every metric is in one list or the other');
  const e = Object.fromEntries(b.empty.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(e.skin_temp), ['id', 'label', 'category', 'family', 'icon', 'provides', 'group', 'groupOn', 'canAdd']);
  assert.deepEqual([e.skin_temp.group, e.skin_temp.groupOn, e.skin_temp.canAdd, e.skin_temp.provides], [null, true, false, 'A watch or band with a skin-temperature sensor, worn at night']);
  assert.deepEqual([e.glucose.groupOn, e.glucose.canAdd, e.body_fat.canAdd], [true, true, true], 'what can be logged here says so');
  for (const id of ['ecg', 'irn', 'period', 'ovulation', 'symptoms']) assert.deepEqual([e[id].groupOn, e[id].canAdd, !!e[id].group], [false, false, true], id);
  assert.deepEqual(b.groups.filter((g) => g.chosen).map((g) => g.id), ['nutrition', 'mindfulness']);
});

test('GET /api/browse: a phone has steps and distance and nothing else; a new account has nothing and no errors', async () => {
  const b = await get(phone, '/api/browse');
  assert.deepEqual(ids(b), ['steps', 'distance']);
  assert.equal(b.empty.length, METRICS.length - 2);
  assert.ok(b.empty.filter((e) => e.group).every((e) => e.groupOn === false && e.canAdd === false), 'no optional group, so none of their metrics');
  assert.deepEqual(b.empty.filter((e) => e.canAdd).map((e) => e.id), ['weight', 'body_fat', 'height', 'measurements', 'body_temp', 'glucose', 'stress'], 'connected: the core kinds can be logged');
  const n = await get(fresh, '/api/browse');
  assert.deepEqual([n.categories, n.pinned, n.empty.length], [[], [], METRICS.length]);
  // Without Google the core kinds are kept on this site, weight and tape measurements too.
  assert.deepEqual(n.empty.filter((e) => e.canAdd).map((e) => e.id), ['weight', 'body_fat', 'height', 'measurements', 'body_temp', 'glucose', 'stress']);
  assert.ok(n.groups.every((g) => g.mode === 'off' && !g.usable && !g.canLog));
});

test('GET /api/metric/<id>: every metric, every range, the same shape, a chart of the kind the catalogue names', async () => {
  for (const m of METRICS) {
    for (const range of RANGES) {
      const x = await get(full, `/api/metric/${m.id}?range=${range}`);
      const where = `${m.id} ${range}`;
      assert.deepEqual(Object.keys(x), ['metric', 'range', 'chart', 'stats', 'prev', 'reading', 'entries', 'more', 'add', 'ranges', 'rangeNeeds', ...(m.id === 'body_composition' ? ['body'] : [])], where);
      assert.deepEqual(Object.keys(x.metric), [...METRIC_KEYS, 'about', 'ownNote', 'provides', 'betterWhen', 'goal', 'goalPer'], where);
      assert.deepEqual(Object.keys(x.range), ['id', 'from', 'to', 'prevFrom', 'prevTo', 'prevEnd', 'nextEnd', 'canPrev', 'canNext'], where);
      assert.deepEqual([x.range.id, x.range.to, x.range.canNext], [range, today(), false], where);
      assert.ok(x.range.from <= x.range.to && x.range.prevTo < x.range.from && x.range.prevFrom <= x.range.prevTo, where);
      assert.ok(CHART_KINDS.includes(x.chart.kind), where);
      assert.ok(['hour', 'day', 'week', 'month'].includes(x.chart.bucket), where);
      if (range !== 'day') assert.deepEqual([x.chart.kind, x.chart.bucket], [m.chart[range], range === '6m' ? 'week' : range === 'year' ? 'month' : 'day'], where);
      assert.ok(Array.isArray(x.chart.points), where);
      for (const p of x.chart.points) {
        assert.ok(p.date || p.t, where);
        assert.ok(p.value === null || Number.isFinite(p.value), `${where} point ${JSON.stringify(p)}`);
        if (p.date) assert.ok(p.date >= x.range.from && p.date <= x.range.to, where);
      }
      if (m.kind === 'stack' && x.chart.points.length) {
        assert.deepEqual(x.chart.stackKeys.map((k) => k.key), m.source.parts.map((q) => q.key), where);
        assert.ok(x.chart.points.every((p) => p.parts && Object.keys(p.parts).length === m.source.parts.length), where);
      }
      if (m.kind === 'range' && range !== 'day' && x.chart.points.length) assert.ok(x.chart.points.every((p) => p.lo <= p.value && p.value <= p.hi), where);
      assert.deepEqual(Object.keys(x.stats), ['avg', 'min', 'max', 'latest', 'total', 'count', 'entries'], where);
      assert.ok(typeof x.reading === 'string' && x.reading.length > 5 && x.reading.endsWith('.'), `${where}: ${x.reading}`);
      assert.ok(!/undefined|NaN|null/.test(x.reading), `${where}: ${x.reading}`);
      assert.ok(Array.isArray(x.entries) && x.entries.length <= 50 && typeof x.more === 'boolean', where);
      for (const e of x.entries) for (const k of ['id', 'kind', 'metric', 't', 'date', 'text', 'value', 'unit', 'source', 'device', 'editable', 'deletable', 'google', 'fields', 'inRange']) assert.ok(k in e, `${where} entry ${k}`);
      assert.equal(x.add === null, !m.entry, where);
      assert.equal(x.metric.ownNote === null, !m.own, where);
    }
  }
});

test('one metric of each chart kind, looked at closely', async () => {
  const t = today();
  // Bars with a goal.
  const steps = await get(full, '/api/metric/steps?range=week');
  assert.deepEqual([steps.chart.kind, steps.chart.bucket, steps.chart.goal, steps.chart.band, steps.metric.goal, steps.metric.goalPer], ['bars', 'day', 8000, null, 8000, 'day']);
  assert.deepEqual([steps.range.from, steps.range.prevFrom, steps.range.prevTo], [addDays(t, -6), addDays(t, -13), addDays(t, -7)]);
  assert.equal(steps.chart.points.length, 7);
  assert.ok(steps.chart.points.every((p) => p.goalHit === (p.value >= 8000)));
  assert.equal(steps.stats.total, steps.chart.points.reduce((a, p) => a + p.value, 0));
  assert.equal(steps.stats.count, 7);
  const done = steps.chart.points.slice(0, 6).map((p) => p.value);
  assert.equal(steps.stats.avg, Math.round(done.reduce((a, b) => a + b, 0) / 6), 'today is not over: it is left out of the average, not out of the total');
  assert.ok(steps.prev.avg > 0 && Number.isFinite(steps.prev.deltaPct) && Number.isFinite(steps.prev.deltaAbs));
  assert.match(steps.reading, /^Goal met on \d of 7 days, (\d+% (above|below)|about the same as) the week before\.$/);
  assert.deepEqual([steps.entries[0].id, steps.entries[0].source, steps.entries[0].device, steps.entries[0].editable, steps.entries[0].inRange], [`d-steps-${t}`, 'google', 'Fitbit Air', false, true]);
  assert.equal(steps.entries[7].inRange, false, 'entries go on past the range; each says whether it is inside');

  // Hours: the day by the hour, from the same machinery as /api/day.
  const day = await get(full, '/api/metric/steps?range=day');
  const hours = (await get(full, '/api/day')).hours.filter((h) => !h.future);
  assert.deepEqual([day.chart.kind, day.chart.bucket, day.chart.goal], ['hours', 'hour', null]);
  assert.deepEqual(day.chart.points.map((p) => [p.h, p.value]), hours.map((h) => [h.h, h.steps]));
  assert.match(day.reading, /^[\d,]+ steps so far, /);
  assert.ok(!/the day before/.test(day.reading), 'a day that is not over is not held against a whole one');
  const hr = await get(full, '/api/metric/heart_rate?range=day');
  assert.deepEqual([hr.chart.kind, hr.chart.bucket], ['hours', 'hour']);
  assert.ok(hr.chart.points.length > 0 && hr.chart.points.every((p) => p.lo <= p.value && p.value <= p.hi));
  // A day too old for hourly detail falls back to the day's one value, with the reason.
  const old = await get(full, `/api/metric/steps?range=day&end=${addDays(t, -20)}`);
  assert.deepEqual([old.chart.kind, old.chart.bucket, old.chart.points.length, old.chart.note, old.chart.goal], ['bars', 'day', 1, 'The day by the hour is kept for the last week only', 8000]);
  assert.match(old.reading, /^[\d,]+ steps, .*the day before\.$/);
  // A phone has no hourly heart rate, and a metric it lacks is not an error.
  const none = await get(phone, '/api/metric/heart_rate?range=day');
  assert.deepEqual([none.chart.points, none.metric.latest, none.reading, none.entries, none.prev], [[], null, 'Nothing recorded on this day.', [], null]);
  assert.equal((await get(phone, '/api/metric/hrv?range=month')).reading, 'Not enough days yet.');

  // A line with the person's own usual range.
  const rhr = await get(full, '/api/metric/resting_hr?range=month');
  assert.deepEqual([rhr.chart.kind, rhr.chart.points.length, rhr.stats.total, rhr.chart.goal], ['line', 30, null, null]);
  assert.ok(rhr.chart.band.lo <= rhr.chart.band.hi);
  assert.match(rhr.reading, /(inside|above|below) your usual range\.$/);
  assert.ok(rhr.stats.min.value <= rhr.stats.avg && rhr.stats.avg <= rhr.stats.max.value);

  // A range.
  const spo2 = await get(full, '/api/metric/spo2?range=week');
  assert.equal(spo2.chart.kind, 'range');
  assert.ok(spo2.stats.min.value <= Math.min(...spo2.chart.points.map((p) => p.lo)) + 1e-9);
  assert.ok(spo2.entries[0].details.some((d) => d.label === 'Lowest') && spo2.entries[0].details.some((d) => d.label === 'Spread'));

  // A stack, averaged per day over weeks.
  const st = await get(full, '/api/metric/sleep_stages?range=6m');
  assert.deepEqual([st.chart.kind, st.chart.bucket], ['stack', 'week']);
  assert.deepEqual(st.chart.stackKeys.map((k) => [k.key, k.label, k.tone]), [['deep', 'Deep', 'high'], ['rem', 'REM', 'mid'], ['light', 'Light', 'low'], ['awake', 'Awake', 'muted']]);
  assert.ok(st.chart.points.every((p) => p.date === weekOf(p.date) && p.value < 720), 'a week of nights is an average night, not seven added up');
  const zones = await get(full, '/api/metric/zones?range=6m');
  assert.ok(zones.chart.points.some((p) => p.days === 7 && p.value > 7 * 20), 'minutes in zones do add up over a week');

  // A total with parts.
  const cal = await get(full, '/api/metric/calories?range=week');
  assert.deepEqual(cal.chart.stackKeys.map((k) => k.key), ['active', 'basal']);
  const full1 = cal.chart.points[0];
  assert.equal(full1.parts.active + full1.parts.basal, full1.value);
  const food = await get(full, '/api/metric/food?range=week');
  assert.deepEqual(food.chart.stackKeys.map((k) => [k.key, k.unit]), [['protein', 'g'], ['carbs', 'g'], ['fat', 'g']]);
  assert.ok(food.chart.points.every((p) => p.n >= 1 && p.parts.protein > 0));

  // A log: the day's entries, oldest first.
  const water = await get(full, `/api/metric/water?range=day&end=${addDays(t, -1)}`);
  assert.deepEqual([water.chart.kind, water.metric.goal, water.chart.goal], ['log', 2000, 2000]);
  assert.ok(water.chart.points.length >= 4 && water.chart.points.every((p, i, a) => !i || p.t > a[i - 1].t));
  assert.equal(water.stats.total, water.chart.points.reduce((a, p) => a + p.value, 0));
  assert.match(water.reading, /^[\d,]+ ml, (at your goal of|[\d,]+ ml short of your goal of) 2,000 ml/);
  const mood = await get(full, '/api/metric/mood?range=week');
  assert.deepEqual([mood.chart.kind, mood.stats.entries], ['log', mood.chart.points.reduce((a, p) => a + p.n, 0)]);
  assert.match(mood.reading, /^\d+ entries in this week, \d+ in the week before\.$/);
  const period = await get(full, '/api/metric/period?range=6m');
  assert.equal(period.stats.entries, 3);
  assert.equal(period.reading, '3 periods started in these six months.');
  assert.equal(period.stats.count, 14, 'days inside a period');

  // The week of a metric counted by the week is the calendar week.
  const cw = await get(full, '/api/metric/cardio_week?range=week');
  assert.deepEqual([cw.range.from, cw.range.to, cw.range.prevFrom, cw.range.prevTo, cw.metric.goal, cw.metric.goalPer, cw.chart.goal], [weekOf(t), t, addDays(weekOf(t), -7), addDays(weekOf(t), -1), 150, 'week', null]);
  // The reading only exists once three days of the calendar week do; on a
  // Monday or Tuesday the week cannot have three days yet and the chart says
  // so. Assert the shape where the shape is possible, the honest sentence
  // where it is not.
  const daysInWeek = Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${weekOf(t)}T00:00:00Z`)) / 86400000) + 1;
  if (daysInWeek >= 3) assert.match(cw.reading, /^[\d,]+ min of your 150 min target so far this week, [\d,]+ min in the week before\.$/);
  else assert.equal(cw.reading, 'Not enough days yet.');
  assert.equal(cw.metric.latest.value, cw.stats.total);
  assert.match(cw.metric.ownNote, /^Calculated by this app/);
  const cw6 = await get(full, '/api/metric/cardio_week?range=6m');
  assert.deepEqual([cw6.chart.bucket, cw6.chart.goal], ['week', 150]);
  assert.match(cw6.reading, /^Target met in \d+ of \d+ weeks\.$/);
  assert.equal(cw6.chart.points.filter((p) => p.goalHit).length, Number(/met in (\d+)/.exec(cw6.reading)[1]));

  // The score, a year of it by the month.
  const sc = await get(full, '/api/metric/sleep_score?range=year');
  assert.deepEqual([sc.chart.kind, sc.chart.bucket, sc.metric.kind, sc.metric.own], ['line', 'month', 'score', true]);
  assert.ok(sc.chart.points.every((p) => p.value >= 0 && p.value <= 100 && p.date.endsWith('-01')));
  assert.equal(sc.entries[0].source, 'calculated');
  assert.equal(sc.entries[0].device, null);
});

test('GET /api/metric: the range moves with end, and the arrows say where to', async () => {
  const t = today();
  const back = await get(full, `/api/metric/steps?range=week&end=${addDays(t, -7)}`);
  assert.deepEqual([back.range.to, back.range.from, back.range.canNext, back.range.nextEnd, back.range.prevEnd, back.range.canPrev], [addDays(t, -7), addDays(t, -13), true, t, addDays(t, -14), true]);
  assert.equal(back.entries[0].date, addDays(t, -7), 'entries start at the end of the range');
  const far = await get(full, `/api/metric/steps?range=month&end=${addDays(t, -80)}`);
  assert.equal(far.range.canPrev, false, 'nothing is held before the first day of data');
  assert.equal((await get(full, `/api/metric/steps?range=week&end=${addDays(t, 30)}`)).range.to, t, 'a day in the future is today');
  const y = await get(full, '/api/metric/steps?range=year');
  assert.deepEqual([y.range.from.slice(8), y.range.from.slice(0, 7) < t.slice(0, 7)], ['01', true]);
  const cw = await get(full, `/api/metric/cardio_week?range=week&end=${addDays(t, -7)}`);
  assert.deepEqual([cw.range.from, cw.range.to, cw.range.canNext], [addDays(weekOf(t), -7), addDays(weekOf(t), -1), true]);
  assert.match(cw.reading, /target in this week/);
});

test('GET /api/metric: entries page by `before`, 50 at a time, without overlap', async () => {
  const p1 = await get(full, '/api/metric/steps?range=week');
  assert.deepEqual([p1.entries.length, p1.more], [50, true]);
  const p2 = await get(full, `/api/metric/steps?range=week&before=${p1.entries[49].t}`);
  assert.equal(p2.entries.length, 40, '90 days of history');
  assert.equal(p2.more, false);
  assert.equal(p2.entries[0].date, addDays(p1.entries[49].date, -1));
  assert.equal(new Set([...p1.entries, ...p2.entries].map((e) => e.id)).size, 90);
  // Logged entries page the same way.
  const w1 = await get(full, '/api/metric/water');
  assert.deepEqual([w1.entries.length, w1.more], [50, true]);
  const w2 = await get(full, `/api/metric/water?before=${w1.entries[49].t}`);
  assert.ok(w2.entries.length > 0 && w2.entries[0].t < w1.entries[49].t);
  assert.ok(w1.entries.every((e, i, a) => !i || e.t <= a[i - 1].t), 'newest first');
  const e = w1.entries[0];
  assert.deepEqual([e.kind, e.metric, e.source, e.editable, e.deletable, e.google, e.unit, Object.keys(e.fields)], ['water', 'water', 'app', true, true, 'saved', 'ml', ['at', 'ml']]);
  assert.match(e.id, /^l-[0-9a-f-]{36}$/);
});

test('GET /api/metric: an unknown id is 404, a group that is off is 409, bad parameters are 400', async () => {
  const nope = await full.c.get('/api/metric/blood_type');
  assert.deepEqual([nope.status, nope.json.code], [404, 'not_found']);
  assert.equal((await full.c.get('/api/metric/Steps')).status, 404);
  for (const id of ['water', 'food', 'mood', 'period', 'ovulation', 'symptoms', 'ecg', 'irn']) {
    const x = await phone.c.get(`/api/metric/${id}`);
    assert.deepEqual([x.status, x.json.code, x.json.detail.group], [409, 'group_off', metricById(id).group], id);
  }
  assert.equal((await part.c.get('/api/metric/period')).status, 409);
  assert.equal((await part.c.get('/api/metric/water')).status, 200);
  // Glucose and body temperature are private, not optional: they are there for everybody.
  assert.equal((await phone.c.get('/api/metric/glucose')).status, 200);
  for (const q of ['range=decade', 'end=yesterday', 'end=2026-02-31', 'before=soon', 'before=-5']) {
    const x = await full.c.get(`/api/metric/steps?${q}`);
    assert.deepEqual([x.status, x.json.code], [400, 'bad_request'], q);
  }
});

test('the form of a metric: fields, quick amounts, and where an entry will be kept', async () => {
  const water = (await get(full, '/api/metric/water')).add;
  assert.deepEqual(Object.keys(water), ['kind', 'route', 'fields', 'quick', 'available', 'mode', 'note', 'group']);
  assert.deepEqual([water.kind, water.route, water.available, water.mode], ['water', '/api/entries', true, 'google']);
  assert.deepEqual(water.fields[0], { id: 'ml', label: 'Amount', type: 'number', unit: 'ml', min: 1, max: 5000, step: 10, required: true });
  assert.deepEqual(water.quick, [{ label: '250 ml', fields: { ml: 250 } }, { label: '500 ml', fields: { ml: 500 } }]);
  assert.equal(water.note, 'Saved to Google Health too. What you log in Google\'s own app cannot be read by other apps.');
  assert.equal((await get(full, '/api/metric/glucose')).add.note, 'Saved to Google Health too.');
  const weight = (await get(full, '/api/metric/weight')).add;
  assert.deepEqual([weight.kind, weight.route, weight.available, weight.mode, weight.quick], ['weight', '/api/weight', true, 'google', null]);
  assert.match(weight.note, /changed or removed in the Google Health app/);
  const w = (await get(full, '/api/metric/weight')).entries[0];
  assert.deepEqual([w.kind, w.editable, w.deletable, Object.keys(w.fields)], ['weight', false, false, ['at', 'kg', 'note']]);
  // Without Google: kept here, weight too (and sent to Hevy when it is connected).
  const local = (await get(fresh, '/api/metric/glucose')).add;
  assert.deepEqual([local.available, local.mode, local.note], [true, 'local', 'Kept on this site only: Google Health is not connected.']);
  const nw = (await get(fresh, '/api/metric/weight')).add;
  assert.deepEqual([nw.available, nw.mode], [true, 'local']);
  assert.match(nw.note, /^Kept on this site, and sent to Hevy when it is connected\./);
  assert.equal((await get(full, '/api/metric/steps')).add, null);
  assert.equal((await get(full, '/api/metric/ecg')).add, null, 'an ECG is taken on the watch');
  const mood = (await get(full, '/api/metric/mood')).add;
  assert.deepEqual(mood.fields.map((f) => [f.id, f.type, f.required]), [['moods', 'multi', true], ['valence', 'select', false], ['note', 'text', false], ['at', 'datetime', false]]);
  assert.ok(mood.fields[0].options.length > 60 && mood.fields[0].options[0].label === 'Amazed');
});

test('POST /api/pins: at most eight, unknown ids refused, shown in /api/me, Browse and the brief', async () => {
  const p = await personWith(r, 'pinner', { groups: ['nutrition'] });
  assert.deepEqual((await get(p, '/api/me')).pins, []);
  let x = await p.c.post('/api/pins', { id: 'vo2max', on: true });
  assert.deepEqual([x.status, x.json], [200, { pinned: ['vo2max'] }]);
  x = await p.c.post('/api/pins', { id: 'resp', on: true });
  x = await p.c.post('/api/pins', { id: 'vo2max', on: true });
  assert.deepEqual(x.json.pinned, ['resp', 'vo2max'], 'pinning again moves it to the end, never twice');
  assert.deepEqual((await p.c.post('/api/pins', { id: 'resp', on: false })).json.pinned, ['vo2max']);
  assert.deepEqual((await p.c.post('/api/pins', { id: 'resp', on: false })).json.pinned, ['vo2max'], 'unpinning what is not pinned changes nothing');
  for (const [body, code] of [[{ id: 'blood_type', on: true }, 'bad_metric'], [{ on: true }, 'bad_metric'], [{ id: 'steps', on: 'yes' }, 'bad_request'], [{ id: 'steps' }, 'bad_request']]) {
    x = await p.c.post('/api/pins', body);
    assert.deepEqual([x.status, x.json.code], [400, code], JSON.stringify(body));
  }
  const more = ['steps', 'sleep', 'hrv', 'weight', 'water', 'period', 'spo2'];
  for (const id of more) assert.equal((await p.c.post('/api/pins', { id, on: true })).status, 200, id);
  x = await p.c.post('/api/pins', { id: 'floors', on: true });
  assert.deepEqual([x.status, x.json.code, x.json.error], [400, 'too_many', `At most ${MAX_PINS} metrics can be pinned. Unpin one first.`]);
  const want = ['vo2max', ...more];
  assert.deepEqual((await get(p, '/api/me')).pins, want);
  const b = await get(p, '/api/browse');
  assert.deepEqual(b.pinned, want);
  assert.deepEqual(b.categories.flatMap((c) => c.metrics).filter((m) => m.pinned).map((m) => m.id).sort(), want.filter((id) => !['water', 'period'].includes(id)).sort());
  // The brief carries the pins that have something to show: water has no entry yet, cycle is off.
  const extra = (await get(p, '/api/brief')).extra;
  assert.deepEqual(extra.pinned.map((m) => m.id), ['vo2max', 'steps', 'sleep', 'hrv', 'weight', 'spo2']);
  assert.deepEqual(Object.keys(extra.pinned[0]), METRIC_KEYS);
  assert.equal(extra.pinned[0].pinned, true);
  await p.c.post('/api/entries', { kind: 'water', ml: 250 });
  assert.ok((await get(p, '/api/brief')).extra.pinned.some((m) => m.id === 'water'));
  // Somebody else's pins are their own.
  assert.deepEqual((await get(full, '/api/me')).pins, []);
});

test('GET /api/brief: what Today gains, for a full device', async () => {
  const b = await get(full, '/api/brief');
  const x = b.extra;
  assert.deepEqual(Object.keys(x), ['cardio', 'sleepScore', 'calories', 'floors', 'vitals', 'recovery', 'water', 'food', 'pinned', 'stress']);
  assert.deepEqual(Object.keys(x.cardio), ['minutes', 'target', 'pct', 'source', 'days', 'weeks']);
  assert.deepEqual([x.cardio.target, x.cardio.source, x.cardio.days.length, x.cardio.weeks.length, x.cardio.days[0].date], [150, 'zone minutes', 7, 12, weekOf(b.today)]);
  assert.equal(x.cardio.minutes, x.cardio.days.reduce((a, d) => a + (d.minutes || 0), 0));
  assert.equal(x.cardio.pct, Math.round((x.cardio.minutes / 150) * 100));
  assert.ok(x.cardio.days.filter((d) => d.date > b.today).every((d) => d.minutes === null));
  assert.deepEqual(Object.keys(x.sleepScore), ['score', 'parts', 'basis', 'estimated', 'usual', 'date']);
  assert.ok(x.sleepScore.score >= 0 && x.sleepScore.score <= 100);
  assert.deepEqual(x.sleepScore.parts.map((p) => p.id), ['duration', 'composition', 'revitalization']);
  assert.equal(x.sleepScore.basis, 'time asleep against the goal, REM sleep and long awakenings');
  assert.equal(x.sleepScore.score, (await get(full, '/api/metric/sleep_score?range=day')).stats.latest.value, 'the stored score is the one worked out again from the night');
  assert.ok(x.sleepScore.usual > 0);
  assert.deepEqual(Object.keys(x.calories), ['total', 'active', 'basal', 'usual', 'week']);
  assert.equal(x.calories.basal, x.calories.total - x.calories.active);
  assert.deepEqual([x.calories.week.length, x.calories.week[6].date, Object.keys(x.calories.usual)], [7, b.today, ['total', 'active']]);
  assert.deepEqual(Object.keys(x.floors), ['value', 'usual']);
  assert.deepEqual(x.vitals.map((v) => v.id), ['resp', 'spo2', 'skin_temp', 'vo2max']);
  for (const v of x.vitals) assert.deepEqual(Object.keys(v), ['id', 'label', 'value', 'text', 'unit', 'family', 'icon', 'usual', 'date'], v.id);
  assert.deepEqual(Object.keys(x.recovery), ['label', 'text', 'z', 'parts', 'days']);
  assert.match(x.recovery.label, /^(above|near|below) your usual$/);
  assert.deepEqual([x.recovery.days.length, x.recovery.parts.map((p) => p.id)], [7, ['hrv', 'rhr']]);
  assert.deepEqual([Object.keys(x.water), Object.keys(x.food)], [['ml', 'target', 'entries'], ['kcal', 'protein', 'carbs', 'fat', 'entries']]);
  assert.equal(x.water.target, 2000);
  const w = await get(full, '/api/metric/water?range=day');
  assert.deepEqual([x.water.ml, x.water.entries], [w.stats.total ?? 0, w.chart.points.length]);
  assert.deepEqual(x.pinned, []);
});

test('GET /api/brief: each part is absent for somebody without it, so Today stays short', async () => {
  const ph = (await get(phone, '/api/brief')).extra;
  assert.deepEqual(ph, { cardio: null, sleepScore: null, calories: null, floors: null, vitals: [], recovery: null, water: null, food: null, pinned: [], stress: null });
  assert.deepEqual((await get(fresh, '/api/brief')).extra, ph);
  const px = (await get(part, '/api/brief')).extra;
  assert.deepEqual(px.vitals.map((v) => v.id), ['resp', 'spo2', 'vo2max'], 'a Pixel Watch has no skin temperature');
  assert.ok(px.cardio && px.sleepScore && px.calories && px.floors && px.recovery && px.water && px.food);
  // A Garmin: no HRV, so the trend stands on resting heart rate alone; no zone minutes, so cardio comes from active minutes; sleep without stages.
  const g = await personWith(r, 'garmin', { persona: 'garmin' });
  const gx = (await get(g, '/api/brief')).extra;
  assert.deepEqual([gx.cardio.source, gx.recovery.parts.map((p) => p.id), gx.sleepScore, gx.vitals, gx.water, gx.food], ['active minutes', ['rhr'], null, [], null, null], 'sleep without stages has no score, as in Google\'s app');
  assert.ok(gx.calories.active !== null && gx.floors);
  // Switching nutrition off takes water and food off Today at once.
  const off = await personWith(r, 'nowater', { groups: ['nutrition'] });
  await off.c.post('/api/entries', { kind: 'water', ml: 500 });
  assert.equal((await get(off, '/api/brief')).extra.water.ml, 500);
  await off.c.post('/api/google/groups', { group: 'nutrition', on: false });
  const ox = (await get(off, '/api/brief')).extra;
  assert.deepEqual([ox.water, ox.food], [null, null]);
});

test('PUT /api/shown: Health lists the everyday metrics by default; a choice replaces that, null goes back; pins always show', async () => {
  const p = await personWith(r, 'chooser', { groups: ['nutrition'] });
  const listed = async () => (await get(p, '/api/browse')).categories.flatMap((c) => c.metrics).filter((m) => m.shown).map((m) => m.id);
  const all = (await get(p, '/api/browse')).categories.flatMap((c) => c.metrics).map((m) => m.id);
  const def = await listed();
  assert.ok(def.includes('steps') && def.includes('sleep'), 'the everyday ones');
  assert.ok(def.length < all.length, 'some are hidden by default');
  assert.equal((await get(p, '/api/browse')).shownIsDefault, true);
  let x = await p.c.put('/api/shown', { ids: ['steps', 'floors'] });
  assert.deepEqual([x.status, x.json], [200, { shown: ['steps', 'floors'] }]);
  assert.deepEqual((await listed()).sort(), ['floors', 'steps'].filter((id) => all.includes(id)).sort());
  await p.c.post('/api/pins', { id: 'resp', on: true });
  assert.ok((await listed()).includes('resp'), 'a pin is always listed');
  x = await p.c.put('/api/shown', { ids: ['nope'] });
  assert.equal(x.status, 400);
  x = await p.c.put('/api/shown', { ids: null });
  assert.deepEqual(x.json, { shown: null });
  assert.equal((await get(p, '/api/browse')).shownIsDefault, true);
});
