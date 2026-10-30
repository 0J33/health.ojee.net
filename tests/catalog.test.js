/* The catalogue (server/catalog.js): every metric is complete, the flags
   that carry rules are right, the forms agree with the validation, and
   nothing the sync stores is left without a metric that shows it. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith, SENTINELS } from './people.mjs';
import { METRICS, CATEGORIES, FAMILIES, KINDS_OF_METRIC, CHART_KINDS, RANGES, FORMS, metricById, metricOfKind, dailyKeysOf, sampleKindsOf, valueText } from '../server/catalog.js';
import { KINDS, ENTRY_KINDS, SENSITIVE_KINDS, validate, LIMITS } from '../server/core/entries.js';
import { GROUPS, GROUP_IDS } from '../server/core/google.js';
import { addDays, today as todayIn } from '../server/core/util.js';

/** docs/DATA-TYPES.md, "Where each number lands", plus this phase's two. */
const DAILY_KEYS = `steps distance_m azm azm_fat azm_cardio azm_peak active_min kcal kcal_active kcal_basal floors altitude_m sedentary_min swim_strokes
  zone_light zone_moderate zone_vigorous zone_peak zkcal_light zkcal_moderate zkcal_vigorous zkcal_peak level_sedentary level_light level_moderate level_very
  rhr hrv hrv_deep hrv_entropy hrv_nonrem_hr hr_min hr_max hr_avg spo2 spo2_lo spo2_hi spo2_sd spo2_min spo2_mean temp temp_base temp_sd temp_dev
  resp resp_deep resp_light resp_rem vo2max vo2max_run sleep_min sleep_period sleep_awake sleep_efficiency sleep_deep sleep_rem sleep_light body_fat height_mm
  sleep_score cardio_min`.split(/\s+/);
const SAMPLE_KINDS = ['water', 'food', 'mood', 'symptom', 'period', 'ovulation', 'glucose', 'bodytemp', 'height', 'bodyfat', 'vo2', 'ecg', 'irn', 'bodycomp'];
const ICON = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** Product names of Google's that this app's own numbers must never borrow. */
const BORROWED = /fitbit|google|cardio load|readiness|stress|daily readiness|body battery/i;

test('every metric is complete: label, category, family, icon, kind, a chart for each range, about and provides', () => {
  assert.ok(METRICS.length >= 40);
  assert.equal(new Set(METRICS.map((m) => m.id)).size, METRICS.length, 'ids are unique');
  const cats = CATEGORIES.map((c) => c.id);
  assert.deepEqual(cats, ['activity', 'heart', 'sleep', 'body', 'vitals', 'nutrition', 'mindfulness', 'cycle', 'other']);
  for (const m of METRICS) {
    assert.match(m.id, /^[a-z][a-z0-9_]{1,39}$/, m.id);
    assert.ok(m.label && m.label.length <= 32, `${m.id} label`);
    assert.ok(cats.includes(m.category), `${m.id} category`);
    assert.ok(FAMILIES.includes(m.family), `${m.id} family ${m.family}`);
    assert.match(m.icon, ICON, `${m.id} icon`);
    assert.ok(KINDS_OF_METRIC.includes(m.kind), `${m.id} kind`);
    assert.ok(Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= 2, `${m.id} decimals`);
    assert.ok([null, 'higher', 'lower'].includes(m.betterWhen), `${m.id} betterWhen`);
    assert.ok(['sum', 'avg'].includes(m.agg), `${m.id} agg`);
    assert.deepEqual(Object.keys(m.chart), RANGES, `${m.id} has a chart for every range`);
    for (const k of Object.values(m.chart)) assert.ok(CHART_KINDS.includes(k), `${m.id} chart ${k}`);
    for (const rg of ['week', 'month', '6m', 'year']) assert.notEqual(m.chart[rg], 'hours', `${m.id}: only a day is drawn by the hour`);
    assert.ok(m.about.length >= 40 && m.about.length <= 260 && m.about.endsWith('.'), `${m.id} about`);
    assert.ok(m.provides.length >= 8 && !m.provides.endsWith('.'), `${m.id} provides`);
    assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(m)), `${m.id}: no emoji`);
    assert.equal(metricById(m.id), m);
    if (m.kind === 'stack') assert.ok(m.source.parts.length >= 2 && m.source.parts.every((p) => p.key && p.label && p.tone), `${m.id} stack parts`);
  }
  assert.equal(metricById('nope'), null);
  // The ids the design contract names.
  for (const id of ['steps', 'distance', 'floors', 'active', 'cardio_week', 'calories', 'calories_active', 'calories_basal', 'sedentary', 'activity_levels', 'swim', 'workouts',
    'resting_hr', 'hrv', 'heart_rate', 'zones', 'vo2max', 'recovery', 'ecg', 'irn', 'sleep', 'sleep_score', 'sleep_stages', 'sleep_efficiency',
    'weight', 'body_fat', 'height', 'bmi', 'resp', 'spo2', 'skin_temp', 'body_temp', 'glucose', 'water', 'food', 'mood', 'period', 'ovulation', 'symptoms', 'altitude']) assert.ok(metricById(id), id);
  assert.deepEqual([metricById('spo2').kind, metricById('heart_rate').kind, metricById('zones').kind, metricById('activity_levels').kind, metricById('sleep_stages').kind, metricById('sleep_score').kind],
    ['range', 'range', 'stack', 'stack', 'stack', 'score']);
  assert.deepEqual([metricById('steps').chart.day, metricById('heart_rate').chart.day], ['hours', 'hours']);
});

test('the rules the flags carry: group metrics are sensitive, so are glucose and body temperature; own metrics say so and borrow no name', () => {
  for (const m of METRICS) {
    if (m.group) { assert.ok(GROUP_IDS.includes(m.group), m.id); assert.equal(m.sensitive, true, `${m.id}: a group metric is sensitive`); }
    if (m.own) {
      assert.match(m.about, /^Calculated by this app/, `${m.id} about says who calculated it`);
      assert.match(m.ownNote, /^Calculated by this app/, `${m.id} ownNote`);
      assert.ok(m.ownNote.length > 80, `${m.id}: the note names the inputs`);
      assert.ok(!BORROWED.test(m.label), `${m.id} label borrows a product name: ${m.label}`);
      assert.ok(!/fitbit|cardio load|daily readiness|stress|body battery/i.test(`${m.about} ${m.ownNote}`), `${m.id} text borrows a product name`);
    } else assert.equal(m.ownNote, null, m.id);
  }
  assert.deepEqual(METRICS.filter((m) => m.own).map((m) => m.id), ['cardio_week', 'calories_basal', 'recovery', 'sleep_score', 'bmi']);
  assert.deepEqual(METRICS.filter((m) => m.sensitive).map((m) => m.id), ['ecg', 'irn', 'body_temp', 'glucose', 'water', 'food', 'mood', 'period', 'ovulation', 'symptoms']);
  // Each sensitive kind of entries.js is shown by a sensitive metric, and by no other.
  for (const kind of SENSITIVE_KINDS) assert.equal(metricOfKind(kind)?.sensitive, true, kind);
  for (const m of METRICS.filter((x) => !x.sensitive)) for (const k of sampleKindsOf(m)) assert.ok(!SENSITIVE_KINDS.includes(k), `${m.id} reads the sensitive kind ${k}`);
  // A group's kinds all belong to metrics of that group.
  // (Logging sleep is a group of its own, but a logged night is shown with
  // every other night, on the sleep metric, which is not a group's.)
  for (const g of GROUPS) for (const kind of g.kinds) assert.equal(metricOfKind(kind).group, kind === 'sleep' ? null : g.id, kind);
  assert.deepEqual(METRICS.filter((m) => m.goal).map((m) => [m.id, m.goal]), [['steps', 'steps'], ['active', 'active'], ['cardio_week', 'cardio'], ['sleep', 'sleep'], ['water', 'water']]);
});

test('nothing synced is undisplayable: every daily key and every sample kind is reached by some metric', () => {
  const keys = new Set(METRICS.flatMap(dailyKeysOf));
  for (const k of DAILY_KEYS) assert.ok(keys.has(k), `daily key ${k} is shown by no metric`);
  const kinds = new Set(METRICS.flatMap(sampleKindsOf));
  for (const k of SAMPLE_KINDS) assert.ok(kinds.has(k), `sample kind ${k} is shown by no metric`);
  // And nothing in the catalogue reads a key that is never written.
  for (const m of METRICS) for (const k of dailyKeysOf(m)) assert.ok(DAILY_KEYS.includes(k), `${m.id} reads ${k}, which nothing writes`);
});

test('the forms: one per kind that can be logged, with the limits and choices the validation uses', () => {
  assert.deepEqual(Object.keys(FORMS).sort(), [...ENTRY_KINDS, 'weight'].sort());
  for (const m of METRICS.filter((x) => x.entry)) assert.ok(FORMS[m.entry], `${m.id} form`);
  assert.deepEqual(METRICS.filter((m) => m.entry).map((m) => [m.id, m.entry]), [['sleep', 'sleep'], ['weight', 'weight'], ['body_fat', 'bodyfat'], ['height', 'height'], ['measurements', 'measure'],
    ['body_temp', 'bodytemp'], ['glucose', 'glucose'], ['water', 'water'], ['food', 'food'], ['mood', 'mood'], ['period', 'period'], ['ovulation', 'ovulation'], ['symptoms', 'symptom']]);
  for (const [kind, form] of Object.entries(FORMS)) {
    for (const f of form.fields) {
      assert.ok(f.id && f.label && ['number', 'text', 'select', 'multi', 'datetime', 'date'].includes(f.type) && typeof f.required === 'boolean', `${kind}.${f.id}`);
      if (f.type === 'number') assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max) && f.min < f.max && f.unit, `${kind}.${f.id} limits`);
      if (f.type === 'select' || f.type === 'multi') assert.ok(f.options.length >= 2 && f.options.every((o) => o.id && o.label), `${kind}.${f.id} options`);
      // The validator's own range: per field, or (measurements, sleep) per kind of field.
      const own = kind === 'measure' ? LIMITS.measure[f.id === 'lean_mass_kg' ? 'kg' : 'cm'] : kind === 'sleep' && f.id === 'awakeMin' ? LIMITS.sleep.awake : LIMITS[kind]?.[f.id];
      if (f.type === 'number' && kind !== 'weight') assert.deepEqual([f.min, f.max], own, `${kind}.${f.id} is the validator's own range`);
    }
  }
  assert.deepEqual(FORMS.water.quick, [{ label: '250 ml', fields: { ml: 250 } }, { label: '500 ml', fields: { ml: 500 } }]);
  // A form filled with its own minimum, first choices and nothing optional validates.
  const now = Date.parse('2026-06-15T12:00:00Z');
  for (const kind of ENTRY_KINDS) {
    const body = {};
    for (const f of FORMS[kind].fields.filter((x) => x.required)) body[f.id] = f.type === 'number' ? f.min : f.type === 'select' ? f.options[0].id : f.type === 'multi' ? [f.options[0].id] : f.type === 'date' ? '2026-06-10' : f.type === 'datetime' ? now - (f.id === 'start' ? 8 : 1) * 3_600_000 : 'x';
    // Measurements ask for at least one of them, not a particular one.
    if (kind === 'measure') body.waist = FORMS.measure.fields.find((f) => f.id === 'waist').min;
    assert.ok(validate(kind, body, { now, tz: 'UTC' }), kind);
    for (const f of FORMS[kind].fields.filter((x) => x.type === 'number' && x.required)) assert.throws(() => validate(kind, { ...body, [f.id]: f.max + 1 }, { now, tz: 'UTC' }), (e) => e.code === 'bad_entry', `${kind}.${f.id} over its maximum`);
  }
  assert.ok(Object.keys(KINDS).every((k) => FORMS[k]));
});

test('how a value reads', () => {
  assert.equal(valueText(metricById('steps'), 8412), '8,412 steps');
  assert.equal(valueText(metricById('sleep'), 432), '7h 12m');
  assert.equal(valueText(metricById('sedentary'), 45), '45 min');
  assert.equal(valueText(metricById('spo2'), 96.4), '96.4%');
  assert.equal(valueText(metricById('skin_temp'), 0.3), '+0.30 °C');
  assert.equal(valueText(metricById('skin_temp'), -0.12), '-0.12 °C');
  assert.equal(valueText(metricById('mood'), 1), '1.0');
  assert.equal(valueText(metricById('weight'), 80), '80.0 kg');
  assert.equal(valueText(metricById('steps'), null), null);
});

test('against a real sync: every daily metric and sample kind a full account ends up with is in the catalogue', async () => {
  const r = await rig();
  try {
    const p = await personWith(r, 'everything', { groups: GROUP_IDS });
    const today = todayIn(Date.now(), 'Africa/Cairo');
    for (const [kind, s] of Object.entries(SENTINELS)) {
      const body = kind === 'period' ? { ...s.body, start: addDays(today, -9), end: addDays(today, -6) } : s.body;
      const x = await p.c.post('/api/entries', { kind, ...body });
      assert.equal(x.status, 200, `${kind}: ${x.text}`);
    }
    for (const [kind, body] of [['height', { cm: 171.5 }], ['bodyfat', { pct: 21.5 }], ['measure', { waist: 82, chest_cm: 101 }]]) assert.equal((await p.c.post('/api/entries', { kind, ...body })).status, 200);
    await r.app.syncUser(p.id);
    await r.app.worlds.hold(p.id, async (w) => {
      const daily = w.db.db.prepare('SELECT DISTINCT metric FROM daily').all().map((x) => x.metric);
      const kinds = w.db.db.prepare('SELECT DISTINCT kind FROM sample').all().map((x) => x.kind);
      assert.ok(daily.length >= 50, `only ${daily.length} daily metrics`);
      assert.ok(daily.includes('sleep_score') && daily.includes('cardio_min'), 'the app\'s own numbers were stored by the sync');
      const keys = new Set(METRICS.flatMap(dailyKeysOf)); const shown = new Set(METRICS.flatMap(sampleKindsOf));
      for (const k of daily) assert.ok(keys.has(k), `the sync wrote daily ${k}, which no metric shows`);
      for (const k of kinds) assert.ok(shown.has(k), `the store holds sample kind ${k}, which no metric shows`);
      for (const k of SAMPLE_KINDS.filter((x) => x !== 'vo2' && x !== 'bodycomp')) assert.ok(kinds.includes(k), `expected some ${k}`);
    });
    // With everything Google gives, Browse has every metric; only what a
    // scale brings is "no data yet".
    const b = (await p.c.get('/api/browse')).json;
    assert.deepEqual(b.empty.map((e) => e.id), ['body_composition']);
    assert.equal(b.categories.flatMap((c) => c.metrics).length, METRICS.length - 1);
  } finally { await r.close(); }
});
