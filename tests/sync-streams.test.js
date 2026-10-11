/* The streams added with "all the data": what each writes, a refused stream,
   the walk back of the heavy ones, the slow ones, the optional groups, how
   many Google calls a first and a routine sync cost, and that the stand-in
   Google has the real API's limits. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { GoogleHealth, SCOPES, GROUP_SCOPES } from '../server/core/google.js';
import { Sync, STREAMS, BACKFILL_DAYS, HEAVY_DAYS, UNAVAILABLE_MS } from '../server/core/sync.js';
import { synthFetch, PERSONAS, persona, FAKE_TYPES } from '../server/core/demo.js';
import { today, addDays } from '../server/core/util.js';

const TZ = 'Africa/Cairo';
const T0 = Date.parse('2026-10-11T12:00:00Z');
const CORE = Object.values(SCOPES);
const ALL = [...CORE, ...Object.values(GROUP_SCOPES)];
const ALL_ON = { nutrition: true, mindfulness: true, symptoms: true, cycle: true, ecg: true };
const MIN = 60_000;
const HOUR = 3_600_000;
const deny = () => new Response(JSON.stringify({ error: { code: 403, message: 'Required OAuth scope(s) are missing for this operation.', status: 'PERMISSION_DENIED' } }), { status: 403, headers: { 'content-type': 'application/json' } });

function rig({ scopes = ALL, groups = {}, who = PERSONAS.fitbit, wrap = null } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const synth = synthFetch({ now, tz: TZ, persona: who, scopes: () => scopes });
  const calls = [];
  const hook = { fn: wrap };
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(String(u));
    const path = url.pathname.replace('/v4/users/me/', '').replace('dataTypes/', '');
    calls.push({ path, type: path.split('/')[0], method: init.method || 'GET', filter: url.searchParams.get('filter'), body: init.body ? JSON.parse(init.body) : null });
    const r = hook.fn && await hook.fn(url, init);
    return r || synth(u, init);
  };
  const g = new GoogleHealth({ clientId: 'c', clientSecret: 's', redirectUri: 'r', fetchImpl, now });
  g.tok = { refresh: 'RT', access: 'AT', expiresAt: Number.MAX_SAFE_INTEGER, scopes };
  const db = openDb(':memory:');
  const chosen = { ...groups };
  const s = new Sync({ google: g, db, gapMs: 0, tz: TZ, now, log: { warn: () => {} }, groups: () => chosen, auto: false });
  const metrics = () => { const n = {}; for (const m of Object.values(db.dailyTable('0000-00-00'))) for (const k of Object.keys(m)) n[k] = (n[k] || 0) + 1; return n; };
  return { g, db, s, calls, clock, hook, chosen, metrics, day: () => today(clock.t, TZ) };
}
const span = (c) => { const d = (x) => `${x.date.year}-${String(x.date.month).padStart(2, '0')}-${String(x.date.day).padStart(2, '0')}`; return [d(c.body.range.start), d(c.body.range.end)]; };

test('the full persona: every new stream writes its daily metrics or its rows', async () => {
  const { db, s, metrics, day } = rig({ groups: { ecg: true } });
  const r = await s.run();
  assert.equal(r.ok, true);
  const n = metrics();
  // Ninety days from one roll-up call each.
  for (const k of ['floors', 'kcal_active', 'kcal_basal', 'sedentary_min', 'zone_light', 'zone_moderate', 'zone_vigorous', 'zone_peak', 'resp', 'resp_deep', 'resp_light', 'resp_rem', 'vo2max', 'hrv_entropy', 'hrv_nonrem_hr', 'spo2_sd', 'sleep_light', 'sleep_awake', 'sleep_efficiency']) assert.equal(n[k], BACKFILL_DAYS, k);
  assert.ok(n.altitude_m > 80 && n.swim_strokes > 3 && n.vo2max_run >= 10);
  // The heavy ones: the last two weeks so far (today's activity levels are not over yet).
  for (const k of ['hr_min', 'hr_max', 'hr_avg', 'zkcal_light', 'spo2_min', 'spo2_mean']) assert.equal(n[k], HEAVY_DAYS, k);
  assert.ok(n.level_sedentary >= HEAVY_DAYS - 1 && n.level_sedentary <= HEAVY_DAYS);
  assert.equal(n.height_mm, 1);

  const y = addDays(day(), -1);
  const d = db.dailyTable(y)[y];
  assert.equal(d.kcal_basal, Math.round(d.kcal - d.kcal_active), 'resting energy is total minus active');
  assert.ok(d.kcal_basal > 1000 && d.kcal_active > 100);
  assert.ok(d.hr_min < d.hr_avg && d.hr_avg < d.hr_max);
  assert.ok(d.spo2_min <= d.spo2_mean && d.spo2_mean <= 100);
  assert.ok(Math.abs(d.spo2 - d.spo2_mean) < 3, 'the daily value is Google\'s own, not the mean of the samples');
  assert.equal(d.level_sedentary, d.sedentary_min, 'the same minutes by two routes in the stand-in');
  assert.ok(d.sleep_efficiency > 80 && d.sleep_efficiency <= 100);
  assert.equal(d.height_mm, undefined);

  // Readings and events are rows, with where they came from.
  const st = db.sampleStats();
  assert.deepEqual(Object.keys(st).sort(), ['bodyfat', 'bodytemp', 'ecg', 'glucose', 'height', 'irn', 'vo2']);
  assert.ok(st.glucose.n >= 3 && st.bodytemp.n >= 2 && st.bodyfat.n > 10 && st.vo2.n >= 12);
  assert.deepEqual([st.height.n, st.irn.n], [1, 1], 'one height, and one rhythm notice at most');
  const h = db.sampleLatest('height');
  assert.deepEqual([h.value, h.source, h.device, h.gname], [1780, 'google', 'Logged by hand', 'users/me/dataTypes/height/dataPoints/demo-height']);
  assert.equal(db.latest('height_mm').value, 1780);
  const gl = db.sampleLatest('glucose');
  assert.deepEqual([gl.data.timing, gl.device, gl.source], ['FASTING', 'Health Connect', 'google']);
  assert.equal(db.sampleLatest('bodytemp').device, 'Ear thermometer');
  const e = db.sampleLatest('ecg');
  assert.deepEqual([e.value, e.data.classification, e.data.durationSec, e.data.samples, e.device], [66, 'NORMAL_SINUS_RHYTHM', 30, 2500, 'Fitbit Air']);
  assert.ok(JSON.stringify(e).length < 600, 'no waveform was kept');
  assert.equal(db.sampleLatest('bodyfat').value, db.latest('body_fat').value, 'body fat is a row and still a daily number');
  assert.deepEqual(db.meta('hrZones').zones.map((z) => z.type), ['light', 'moderate', 'vigorous', 'peak']);
  assert.equal(db.meta('hrZones').date, day());
  assert.deepEqual(Object.keys(db.meta('vo2')), ['date', 'value', 'level', 'estimated']);
  // Sleep and exercise carry their extra fields.
  const night = db.sleeps(y).at(-1);
  assert.ok(night.summary.shortAwakenings >= 1 && night.summary.stagesStatus === 'SUCCEEDED' && Number.isFinite(night.summary.afterWake));
  const run = db.exercises('0000-00-00').filter((x) => x.type === 'RUNNING').at(-1);
  assert.ok(run.zones.vigorous > 0 && run.activeSec > 0 && run.paceSecPerKm > 200 && run.device === 'Fitbit Air');

  // Glucose, body temperature and the groups' data are in `sample` and nowhere in `daily`.
  for (const k of Object.keys(n)) assert.ok(!/^(glucose|bodytemp|body_temp|ecg|irn|water|food|mood|symptom|period|ovulation|cycle)/.test(k), `${k} must not be a daily metric`);
});

test('a phone has none of the new metrics; a Pixel, a Garmin and an Apple Watch each have their own part', async () => {
  const NEW = ['floors', 'altitude_m', 'kcal_active', 'kcal_basal', 'sedentary_min', 'zone_light', 'zkcal_light', 'level_sedentary', 'hr_min', 'resp', 'resp_deep', 'vo2max', 'vo2max_run', 'spo2_min', 'height_mm', 'swim_strokes', 'hrv_entropy', 'spo2_sd'];
  const got = async (who, groups = ALL_ON) => { const x = rig({ who: PERSONAS[who], groups }); const r = await x.s.run(); assert.equal(r.ok, true, who); const n = x.metrics(); return { has: NEW.filter((k) => n[k]), kinds: Object.keys(x.db.sampleStats()).sort(), x }; };

  const phone = await got('phone');
  assert.deepEqual(phone.has, []);
  assert.deepEqual(phone.kinds, []);
  assert.deepEqual(Object.keys(phone.x.metrics()).sort(), ['distance_m', 'steps']);
  assert.equal(phone.x.db.meta('hrZones'), null);

  const pixel = await got('pixel');
  assert.deepEqual(pixel.has, NEW.filter((k) => k !== 'swim_strokes'), 'everything but the pool');
  assert.deepEqual(pixel.kinds, ['ecg', 'height', 'vo2'], 'no glucose meter, no thermometer, no body fat, no rhythm notices');
  assert.equal(pixel.x.metrics().temp, undefined);
  assert.equal(pixel.x.db.sampleLatest('ecg').device, 'Pixel Watch 4');

  const garmin = await got('garmin');
  assert.deepEqual(garmin.has, ['floors', 'kcal_active', 'kcal_basal', 'sedentary_min', 'hr_min'], 'floors and energy, no VO2 max, no breathing rate');
  assert.deepEqual(garmin.kinds, []);

  const apple = await got('apple');
  assert.deepEqual(apple.has, ['floors', 'kcal_active', 'kcal_basal', 'hr_min', 'resp', 'resp_deep', 'vo2max', 'vo2max_run', 'height_mm', 'hrv_entropy', 'spo2_sd']);
  assert.deepEqual(apple.kinds, ['height', 'vo2']);
  assert.equal(apple.x.db.sampleLatest('height').value, 1690);
});

test('a 403 marks that one stream unavailable; the run is good, the rest carry on, and it is not asked again for a day', async () => {
  const x = rig({ wrap: (url) => (url.pathname.includes('/floors/') ? deny() : null) });
  let r = await x.s.run();
  assert.equal(r.ok, true, 'a refused type is not a failed sync');
  assert.equal(x.s.state.failures, 0);
  const st = x.s.state.streams.floors;
  assert.deepEqual([st.unavailable, st.message, st.unavailableAt, st.error], [true, 'Required OAuth scope(s) are missing for this operation.', T0, undefined]);
  assert.equal(x.metrics().floors, undefined);
  for (const k of ['steps', 'kcalActive', 'zones', 'sleep', 'weight', 'height', 'device']) assert.ok(x.s.state.streams[k].at, `${k} still ran`);
  assert.equal(x.calls.filter((c) => c.type === 'floors').length, 1);

  // Twenty minutes later, and most of a day later: not asked.
  for (const wait of [20 * MIN, 23 * HOUR]) {
    x.clock.t += wait; x.calls.length = 0;
    r = await x.s.run();
    assert.equal(r.ok, true);
    assert.equal(x.calls.filter((c) => c.type === 'floors').length, 0);
    assert.equal(x.s.state.streams.floors.unavailable, true);
  }
  // A day after the refusal it is asked once more; still refused, and noted afresh.
  x.clock.t = T0 + UNAVAILABLE_MS + MIN; x.calls.length = 0;
  await x.s.run();
  assert.equal(x.calls.filter((c) => c.type === 'floors').length, 1);
  assert.equal(x.s.state.streams.floors.unavailableAt, x.clock.t);
  // And once Google allows it, the stream is a normal stream again with its full backfill.
  x.hook.fn = null; x.clock.t += UNAVAILABLE_MS + MIN; x.calls.length = 0;
  await x.s.run();
  const ok = x.s.state.streams.floors;
  assert.deepEqual([ok.unavailable, ok.message, !!ok.at], [undefined, undefined, true]);
  assert.equal(x.metrics().floors, BACKFILL_DAYS);
});

test('a 400 "not supported" is the same refusal; any other 400 is an ordinary stream error', async () => {
  const x = rig({ wrap: (url) => {
    const e = (message) => new Response(JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }), { status: 400 });
    if (url.pathname.includes('/nutrition-log/')) return e('List is not supported for data type nutrition-log, but the following actions are supported: create, update, batchDelete');
    if (url.pathname.includes('/blood-glucose/')) return e('Invalid data point filter.');
    return null;
  }, groups: { nutrition: true } });
  const r = await x.s.run();
  assert.equal(r.ok, true);
  assert.equal(x.s.state.streams.food.unavailable, true);
  assert.match(x.s.state.streams.food.message, /List is not supported for data type nutrition-log/);
  assert.ok(x.s.state.streams.water.at, 'the other stream of the group is read');
  assert.deepEqual([x.s.state.streams.glucose.unavailable, x.s.state.streams.glucose.error], [undefined, 'Invalid data point filter.']);
  x.clock.t += 2 * HOUR; x.calls.length = 0;
  await x.s.run();
  assert.equal(x.calls.filter((c) => c.type === 'nutrition-log').length, 0, 'the refused one waits a day');
  assert.equal(x.calls.filter((c) => c.type === 'blood-glucose').length, 1, 'an ordinary error is tried again');
});

test('a 429 in the middle of the new streams still ends the run there', async () => {
  const x = rig({ wrap: (url) => (url.pathname.includes('/time-in-heart-rate-zone/') ? new Response('{}', { status: 429, headers: { 'retry-after': '300' } }) : null) });
  const r = await x.s.run();
  assert.deepEqual([r.ok, r.code, r.retryAfter], [false, 'rate_limited', 300]);
  assert.equal(x.calls.at(-1).type, 'time-in-heart-rate-zone', 'nothing was asked after it');
  assert.equal(x.s.state.streams.sleep, undefined);
  assert.equal(x.s.state.streams.zones.unavailable, undefined);
  assert.ok(x.s.nextDelay(r) >= 300_000);
  assert.equal(x.metrics().kcal_basal, undefined, 'and nothing was derived from a run that did not finish');
});

test('heavy streams read the last two weeks first, then walk back one chunk a run until ninety days are covered', async () => {
  const x = rig();
  const t = x.day();
  const floor = addDays(t, -(BACKFILL_DAYS - 1));
  await x.s.run();
  const first = x.calls.filter((c) => c.type === 'heart-rate' && c.path.endsWith(':dailyRollUp'));
  assert.deepEqual(first.map(span), [[addDays(t, -13), addDays(t, 1)]], 'one call, fourteen days');
  assert.equal(x.s.state.streams.hrDay.backTo, addDays(t, -13));
  assert.equal(x.metrics().hr_min, 14);
  const lv = x.calls.find((c) => c.type === 'activity-level');
  assert.equal(lv.filter, `activity_level.interval.start_time >= "${addDays(t, -13)}T00:00:00Z" AND activity_level.interval.start_time < "${addDays(t, 1)}T00:00:00Z"`, 'an interval filter with both ends');

  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    x.clock.t += 20 * MIN; x.calls.length = 0;
    const r = await x.s.run();
    assert.equal(r.ok, true);
    const hr = x.calls.filter((c) => c.type === 'heart-rate' && c.path.endsWith(':dailyRollUp')).map(span);
    seen.push(hr);
    for (const [a, b] of hr) assert.ok(a >= floor && b <= addDays(t, 1));
  }
  // Twenty minutes apart the recent read is not due (hourly); the step back is taken every run.
  const back = (n) => [addDays(t, -13 - 14 * n) < floor ? floor : addDays(t, -13 - 14 * n), addDays(t, -13 - 14 * (n - 1))];
  assert.deepEqual(seen[0], [back(1)]);
  assert.deepEqual(seen[1], [back(2)]);
  assert.deepEqual(seen[2], [[addDays(t, -3), addDays(t, 1)], back(3)], 'an hour on, the recent days are read again as well');
  assert.deepEqual(seen[5].at(-1), [floor, addDays(t, -13 - 14 * 5)], 'the last step is the short one, down to the ninety-day floor');
  assert.deepEqual(seen[6].filter(([a]) => a < addDays(t, -3)), [], 'and then there is nothing further back to read');
  assert.deepEqual(seen[7].filter(([a]) => a < addDays(t, -3)), []);
  assert.equal(x.s.state.streams.hrDay.backTo, floor);
  const n = x.metrics();
  for (const k of ['hr_min', 'zkcal_light', 'spo2_min', 'level_sedentary']) assert.ok(n[k] >= BACKFILL_DAYS - 1, `${k}: ${n[k]} days after the walk`);
  // The state, and so the walk, survives a restart.
  const again = new Sync({ google: x.g, db: x.db, gapMs: 0, tz: TZ, now: () => x.clock.t, log: { warn: () => {} }, auto: false });
  assert.equal(again.state.streams.hrDay.backTo, floor);
  assert.deepEqual(again.plan(STREAMS.find((s) => s.key === 'hrDay'), t).back, null);
});

test('slow-changing streams are not asked on every run', async () => {
  const x = rig({ groups: { ecg: true } });
  await x.s.run();
  const slow = STREAMS.filter((s) => s.everyMs && !s.heavy && !s.group).map((s) => s.type);
  assert.ok(slow.includes('height') && slow.includes('daily-vo2-max') && slow.includes('daily-heart-rate-zones'));
  for (const type of slow) assert.equal(x.calls.filter((c) => c.type === type).length, 1, `${type} on the first run`);
  x.clock.t += 20 * MIN; x.calls.length = 0;
  await x.s.run();
  for (const type of slow) assert.equal(x.calls.filter((c) => c.type === type).length, 0, `${type} twenty minutes later`);
  assert.equal(x.calls.filter((c) => c.type === 'steps').length, 1, 'the fast ones are');
  const at = x.s.state.streams.height.at;
  assert.equal(at, T0, 'a stream that was not asked keeps its last read time');
  // After a day every one of them is due again; height then reads only the recent days.
  x.clock.t = T0 + 25 * HOUR; x.calls.length = 0;
  await x.s.run();
  for (const type of slow) assert.equal(x.calls.filter((c) => c.type === type).length, 1, `${type} a day later`);
  assert.match(x.calls.find((c) => c.type === 'height').filter, /^height\.sample_time\.physical_time >= "2026-10-0\dT00:00:00Z"$/);
  assert.equal(x.db.samples('height').length, 1, 'still the one height');
});

test('height is read from the beginning the first time: it was measured long before any sync window', async () => {
  const x = rig();
  await x.s.run();
  assert.equal(x.calls.find((c) => c.type === 'height').filter, 'height.sample_time.physical_time >= "2000-01-01T00:00:00Z"');
  assert.ok(x.db.sampleLatest('height').date < addDays(x.day(), -BACKFILL_DAYS));
});

test('group streams run only when the group is chosen and its scope granted', async () => {
  const types = ['hydration-log', 'nutrition-log', 'electrocardiogram', 'irregular-rhythm-notification'];
  const asked = (x) => types.filter((t) => x.calls.some((c) => c.type === t));
  // Granted by Google, but nobody chose them.
  let x = rig({ scopes: ALL, groups: {} });
  await x.s.run();
  assert.deepEqual(asked(x), []);
  for (const k of ['water', 'food', 'ecg', 'irn']) assert.equal(x.s.state.streams[k].skipped, 'group off');
  assert.deepEqual(Object.keys(x.db.sampleStats()).filter((k) => ['ecg', 'irn', 'water', 'food'].includes(k)), []);
  // Chosen, but Google was never asked for the scope.
  x = rig({ scopes: CORE, groups: ALL_ON });
  assert.equal((await x.s.run()).ok, true);
  assert.deepEqual(asked(x), []);
  for (const k of ['water', 'food', 'ecg', 'irn']) assert.equal(x.s.state.streams[k].skipped, 'scope not granted');
  // ECG granted without the rhythm-notice scope: each stream by its own scope.
  x = rig({ scopes: [...CORE, GROUP_SCOPES.ecg], groups: { ecg: true } });
  await x.s.run();
  assert.deepEqual(asked(x), ['electrocardiogram']);
  assert.equal(x.s.state.streams.irn.skipped, 'scope not granted');
  // Both.
  x = rig({ scopes: ALL, groups: { ecg: true, nutrition: true } });
  await x.s.run();
  assert.deepEqual(asked(x), types);
  assert.equal(x.calls.find((c) => c.type === 'electrocardiogram').filter, `electrocardiogram.interval.start_time >= "${addDays(x.day(), -13)}T00:00:00Z"`, 'the only filter ECG takes');
  assert.equal(x.calls.find((c) => c.type === 'hydration-log').filter, `hydration_log.interval.civil_start_time >= "${addDays(x.day(), -(BACKFILL_DAYS - 1))}"`);
  for (const k of ['water', 'food', 'ecg', 'irn']) assert.equal(x.s.state.streams[k].skipped, undefined);
  // Switched off again: skipped from the very next run, the rows left alone.
  x.chosen.ecg = false; x.clock.t += 7 * HOUR; x.calls.length = 0;
  await x.s.run();
  assert.deepEqual(asked(x), ['hydration-log', 'nutrition-log']);
  assert.equal(x.s.state.streams.ecg.skipped, 'group off');
  assert.equal(x.db.samples('ecg').length, 1);
});

test('no stream reads a write-only type, and every stream reads a type the API can list or roll up', () => {
  for (const s of STREAMS.filter((x) => x.type)) {
    const T = FAKE_TYPES[s.type];
    assert.ok(T, s.type);
    if (s.kind === 'rollup') assert.equal(T.daily, true, `${s.type} has a daily roll-up`);
    else assert.notEqual(T.list, false, `${s.type} can be listed`);
  }
  const read = new Set(STREAMS.map((s) => s.type));
  for (const t of ['moods', 'symptoms', 'menstrual-period', 'ovulation-test', 'food', 'food-measurement-unit']) assert.ok(!read.has(t), t);
  assert.equal(new Set(STREAMS.map((s) => s.key)).size, STREAMS.length);
});

test('a first sync of the full persona with every group on stays under 70 Google calls; a routine one under 30', async () => {
  const x = rig({ scopes: ALL, groups: ALL_ON });
  const r = await x.s.run();
  assert.equal(r.ok, true);
  const first = x.calls.length;
  // 55 as measured: 7 + 7 for the two 14-day roll-ups that are backfilled in
  // full, 4 pages of sleep, 3 of exercise, one call for everything else.
  assert.equal(first, 55, `first sync: ${first} calls`);
  assert.ok(first <= 70);
  assert.ok(x.calls.filter((c) => c.path.endsWith(':dailyRollUp')).length <= 30);

  // Twenty minutes later: the fast streams, plus one step back per heavy one.
  x.clock.t += 20 * MIN; x.calls.length = 0;
  await x.s.run();
  const routine = x.calls.length;
  assert.equal(routine, 25, `routine sync: ${routine} calls`);
  assert.ok(routine <= 30);

  // Once the walk back is done and nothing slow is due: the fast streams alone.
  for (let i = 0; i < 8; i += 1) { x.clock.t += 20 * MIN; await x.s.run(); }
  x.clock.t += 20 * MIN; x.calls.length = 0;
  await x.s.run();
  assert.ok(x.calls.length <= 26, `settled sync: ${x.calls.length} calls`);
  const settled = x.calls.length;
  x.clock.t += 20 * MIN; x.calls.length = 0;
  await x.s.run();
  assert.equal(x.calls.length, 20, `between the hourly reads: ${x.calls.length} calls (settled: ${settled})`);

  // Without the groups, and for a phone, it is fewer still.
  const plain = rig({ scopes: CORE });
  await plain.s.run();
  assert.equal(plain.calls.length, 51);
  const phone = rig({ scopes: CORE, who: PERSONAS.phone });
  await phone.s.run();
  assert.ok(phone.calls.length <= 50, `a phone: ${phone.calls.length} calls`);
});

test('a device with samples but no daily value: the night\'s mean stands in, and is never asked for otherwise', async () => {
  // Samples of HRV and SpO2, a breathing rate per sleep and weekly VO2 max
  // readings, and none of the four daily types.
  const who = persona({ seed: 'samples', device: null, platform: 'HEALTH_CONNECT', has: ['steps', 'sleep', 'sleepStages', 'hrvSamples', 'spo2Samples', 'resp', 'vo2'] });
  const only = rig({ who, wrap: (url) => (/\/daily-(respiratory-rate|vo2-max)\//.test(url.pathname) ? new Response(JSON.stringify({ dataPoints: [] })) : null) });
  await only.s.run();
  const n = only.metrics();
  assert.equal(n.hrv, HEAVY_DAYS, 'a nightly mean RMSSD became hrv');
  assert.equal(n.hrv_deep, undefined);
  assert.deepEqual([n.spo2, n.spo2_min, n.spo2_mean], [HEAVY_DAYS, HEAVY_DAYS, HEAVY_DAYS]);
  assert.equal(n.spo2_lo, undefined);
  assert.equal(n.resp, BACKFILL_DAYS, 'the whole-night breathing rate became resp');
  assert.ok(n.vo2max >= 12, 'each VO2 max reading became that day\'s vo2max');
  const y = addDays(only.day(), -1);
  const d = only.db.dailyTable(y)[y];
  assert.equal(d.spo2, d.spo2_mean);
  assert.ok(d.hrv > 15 && d.hrv < 120);

  // The full Fitbit sends the daily values: its HRV samples are never asked
  // for, and the stand-ins leave Google's own numbers alone.
  const full = rig();
  await full.s.run();
  assert.equal(full.calls.filter((c) => c.type === 'heart-rate-variability').length, 0);
  const fy = full.db.dailyTable(y)[y];
  assert.notEqual(fy.spo2, fy.spo2_mean);
  assert.ok(Math.abs(fy.resp - (fy.resp_light - 0.1)) < 0.11, 'resp is the daily value, not replaced');
  // A few days off the wrist do not turn the stand-in on.
  full.hook.fn = (url) => (url.pathname.includes('/daily-heart-rate-variability/') ? new Response(JSON.stringify({ dataPoints: [] })) : null);
  full.clock.t += 7 * HOUR; full.calls.length = 0;
  await full.s.run();
  assert.equal(full.calls.filter((c) => c.type === 'heart-rate-variability').length, 0);
});

test('the stand-in Google has the limits the real API showed', async () => {
  const x = rig({ scopes: ALL });
  const err = async (p) => { try { await p; return null; } catch (e) { return `${e.status} ${e.code} ${e.message}`; } };
  assert.equal(await err(x.g.list('floors', {})), '400 INVALID_ARGUMENT List is not supported for data type floors, but the following actions are supported: reconcile, rollup, dailyRollup');
  assert.equal(await err(x.g.list('total-calories', {})), '400 INVALID_ARGUMENT List is not supported for data type total-calories, but the following actions are supported: rollup, dailyRollup');
  assert.equal(await err(x.g.list('calories-in-heart-rate-zone', {})), '400 INVALID_ARGUMENT List is not supported for data type calories-in-heart-rate-zone, but the following actions are supported: rollup, dailyRollup');
  for (const t of ['moods', 'symptoms', 'menstrual-period', 'ovulation-test']) assert.equal(await err(x.g.list(t, {})), `400 INVALID_ARGUMENT List is not supported for data type ${t}, but the following actions are supported: create, update, batchDelete`);
  for (const t of ['basal-energy-burned', 'activity-level', 'daily-resting-heart-rate', 'daily-heart-rate-variability', 'daily-respiratory-rate', 'daily-vo2-max', 'oxygen-saturation']) {
    assert.equal(await err(x.g.dailyRollUp(t, '2026-10-01', '2026-10-08')), `400 INVALID_ARGUMENT DailyRollup is not supported for data type ${t}, but the following actions are supported: list, reconcile`);
  }
  assert.equal(await err(x.g.dailyRollUp('resting-heart-rate-personal-range', '2026-10-01', '2026-10-08')), '400 INVALID_ARGUMENT Invalid data type ID referenced in the parent data type collection: resting-heart-rate-personal-range');
  assert.equal(await err(x.g.list('activity-level', { filter: 'activity_level.date >= "2026-10-01"' })), '400 INVALID_ARGUMENT Invalid data point filter: INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER.');
  assert.match(await err(x.g.list('electrocardiogram', { filter: 'electrocardiogram.interval.start_time >= "2026-10-01T00:00:00Z" AND electrocardiogram.interval.start_time < "2026-10-08T00:00:00Z"' })), /^400 /);
  assert.deepEqual(await x.g.list('basal-energy-burned', {}), [], 'accepted, and empty, as for the probed account');
  // More than the allowed range in one call is refused (google.js never sends one).
  const raw = await x.g.fetch('http://google.demo/v4/users/me/dataTypes/heart-rate/dataPoints:dailyRollUp', { method: 'POST', body: JSON.stringify({ range: { start: { date: { year: 2026, month: 9, day: 1 } }, end: { date: { year: 2026, month: 10, day: 1 } } } }) });
  assert.equal(raw.status, 400);

  // Without a scope: 403 for that family, and only that family.
  const core = rig({ scopes: CORE });
  for (const t of ['hydration-log', 'nutrition-log', 'electrocardiogram', 'irregular-rhythm-notification']) assert.equal(await err(core.g.list(t, {})), '403 PERMISSION_DENIED Required OAuth scope(s) are missing for this operation.');
  assert.equal(await err(core.g.dailyRollUp('hydration-log', '2026-10-01', '2026-10-08')), '403 PERMISSION_DENIED Required OAuth scope(s) are missing for this operation.');
  assert.ok((await core.g.list('weight', { filter: 'weight.sample_time.physical_time >= "2026-10-01T00:00:00Z"' })).length > 0);
  const noSleep = rig({ scopes: [SCOPES.activity] });
  assert.match(await err(noSleep.g.list('sleep', {})), /^403 /);

  // The shapes: int64 as strings, durations as "123s", a dataSource with the device.
  const [fl] = await x.g.dailyRollUp('floors', '2026-10-05', '2026-10-06');
  assert.deepEqual(Object.keys(fl).sort(), ['civilEndTime', 'civilStartTime', 'floors']);
  assert.equal(typeof fl.floors.countSum, 'string');
  const [sed] = await x.g.dailyRollUp('sedentary-period', '2026-10-05', '2026-10-06');
  assert.match(sed.sedentaryPeriod.durationSum, /^\d+s$/);
  const [zone] = await x.g.dailyRollUp('time-in-heart-rate-zone', '2026-10-05', '2026-10-06');
  assert.deepEqual(Object.keys(zone.timeInHeartRateZone.timeInHeartRateZones[0]).sort(), ['duration', 'heartRateZone']);
  const [lv] = await x.g.list('activity-level', { filter: 'activity_level.interval.start_time >= "2026-10-05T00:00:00Z" AND activity_level.interval.start_time < "2026-10-06T00:00:00Z"' });
  assert.deepEqual(Object.keys(lv.activityLevel).sort(), ['activityLevelType', 'interval']);
  assert.deepEqual(Object.keys(lv.activityLevel.interval).sort(), ['civilEndTime', 'civilStartTime', 'endTime', 'endUtcOffset', 'startTime', 'startUtcOffset']);
  assert.deepEqual(Object.keys(lv.dataSource).sort(), ['application', 'device', 'platform', 'recordingMethod']);
  assert.deepEqual(Object.keys(lv.dataSource.device).sort(), ['displayName', 'formFactor', 'manufacturer']);
  const [rs] = await x.g.list('respiratory-rate-sleep-summary', { filter: 'respiratory_rate_sleep_summary.sample_time.physical_time >= "2026-10-05T00:00:00Z"' });
  assert.deepEqual(Object.keys(rs.respiratoryRateSleepSummary).sort(), ['deepSleepStats', 'fullSleepStats', 'lightSleepStats', 'remSleepStats', 'sampleTime']);
  assert.deepEqual(Object.keys(rs.respiratoryRateSleepSummary.fullSleepStats).sort(), ['breathsPerMinute', 'signalToNoise', 'standardDeviation']);
  assert.ok(rs.name);
  const [hz] = await x.g.list('daily-heart-rate-zones', { filter: 'daily_heart_rate_zones.date >= "2026-10-05"' });
  assert.deepEqual(Object.keys(hz.dailyHeartRateZones.heartRateZones[0]).sort(), ['heartRateZoneType', 'maxBeatsPerMinute', 'minBeatsPerMinute']);
  assert.equal(typeof hz.dailyHeartRateZones.heartRateZones[0].minBeatsPerMinute, 'string');
});
