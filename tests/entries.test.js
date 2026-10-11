/* Entries logged by hand, written through to the stand-in Google: create,
   read back onto the same row, patch, delete, a point Google names nothing,
   a failure and the flush that mends it, and the rules about groups. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../server/core/db.js';
import { GoogleHealth, SCOPES, GROUP_SCOPES } from '../server/core/google.js';
import { Sync } from '../server/core/sync.js';
import { synthFetch, PERSONAS } from '../server/core/demo.js';
import {
  addEntry, editEntry, removeEntry, flushEntries, validate, fieldsOf, bodyOf, entryOf, target, ENUMS, KINDS, ENTRY_KINDS, SENSITIVE_KINDS, LIMITS,
} from '../server/core/entries.js';

const TZ = 'Africa/Cairo';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const ALL = [...Object.values(SCOPES), ...Object.values(GROUP_SCOPES)];
const ON = { nutrition: true, mindfulness: true, symptoms: true, cycle: true, ecg: true };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A person's deps over the stand-in Google, every request recorded. */
function rig({ scopes = ALL, groups = ON, wrap = null, persona = PERSONAS.phone, connected = true } = {}) {
  const written = [];
  const clock = { t: NOW };
  const held = { scopes: [...scopes] };
  const synth = synthFetch({ now: () => clock.t, tz: TZ, persona, written, scopes: () => held.scopes });
  const calls = [];
  const hook = { fn: wrap };
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(String(u));
    calls.push({ method: init.method || 'GET', path: url.pathname.replace('/v4/users/me/dataTypes/', ''), body: init.body ? JSON.parse(init.body) : null });
    const r = hook.fn && await hook.fn(url, init);
    return r || synth(u, init);
  };
  const google = new GoogleHealth({ clientId: 'c', clientSecret: 's', redirectUri: 'r', fetchImpl, now: () => clock.t });
  if (connected) google.tok = { refresh: 'RT', access: 'AT', expiresAt: Number.MAX_SAFE_INTEGER, scopes: held.scopes };
  const db = openDb(':memory:');
  const chosen = { ...groups };
  const deps = { db, google, groups: () => chosen, tz: TZ, now: () => clock.t };
  const sync = new Sync({ google, db, gapMs: 0, tz: TZ, now: () => clock.t, log: { warn: () => {} }, groups: () => chosen, auto: false });
  return { deps, db, google, written, calls, clock, hook, chosen, held, sync };
}

test('the enums offered are Google\'s own, each with a label; nothing unspecified', () => {
  const doc = JSON.parse(readFileSync(new URL('./fixtures/discovery-fields.json', import.meta.url), 'utf8')).schemas;
  const real = {
    moods: doc.Moods.properties.moods.items.enum, valences: doc.Moods.properties.valences.items.enum, symptoms: doc.Symptoms.properties.symptoms.items.enum,
    glucoseTiming: doc.BloodGlucose.properties.measurementTiming.enum, glucoseMeal: doc.BloodGlucose.properties.mealType.enum,
    tempLocation: doc.CoreBodyTemperature.properties.measurementLocation.enum, mealType: doc.NutritionLog.properties.mealType.enum, ovulation: doc.OvulationTest.properties.result.enum,
  };
  for (const [name, list] of Object.entries(ENUMS)) {
    assert.ok(list.length > 0, name);
    for (const x of list) {
      assert.ok(real[name].includes(x.id), `${name}: ${x.id}`);
      assert.ok(!/UNSPECIFIED/.test(x.id));
      assert.match(x.label, /^[A-Z][A-Za-z :-]+$/, `${name}: "${x.label}" reads as words`);
    }
    assert.equal(new Set(list.map((x) => x.id)).size, list.length);
  }
  // Everything Google has is offered, but for the duplicate spelling and the unspecified value.
  assert.equal(ENUMS.moods.length, real.moods.length - 1);
  assert.equal(ENUMS.symptoms.length, real.symptoms.length - 2);
  assert.deepEqual(ENUMS.mealType.map((x) => x.id), ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);
  assert.equal(ENUMS.moods.find((x) => x.id === 'VERY_SELF_CRITICAL').label, 'Very self critical');
  assert.deepEqual(ENTRY_KINDS, ['water', 'food', 'mood', 'symptom', 'period', 'ovulation', 'glucose', 'bodytemp', 'height', 'bodyfat']);
  for (const k of ['water', 'food', 'mood', 'symptom', 'period', 'ovulation', 'ecg', 'irn', 'glucose', 'bodytemp']) assert.ok(SENSITIVE_KINDS.includes(k), k);
});

test('validate: every kind becomes a row; ranges and choices are refused with a sentence', () => {
  const v = (kind, f) => validate(kind, f, { now: NOW, tz: TZ });
  const at = Date.parse('2026-10-11T06:30:00.700Z');
  assert.deepEqual(v('water', { at, ml: 250 }), { t: at - 700, end: null, off: 10800, date: '2026-10-11', value: 250, data: {} }, 'whole seconds, the civil date of the person\'s zone');
  assert.equal(v('water', { at: Date.parse('2026-10-10T22:30:00Z'), ml: 250 }).date, '2026-10-11', '00:30 in Cairo is already the 11th');
  assert.equal(v('water', { ml: 250 }).t, NOW, 'no time given: now');
  assert.deepEqual(v('food', { at, name: '  Chicken and rice ', meal: 'LUNCH', kcal: '640', protein: 46, fat: '' }), { t: at - 700, end: null, off: 10800, date: '2026-10-11', value: 640, data: { name: 'Chicken and rice', meal: 'LUNCH', protein: 46 } });
  assert.deepEqual(v('mood', { at, moods: ['CALM', 'CONTENT', 'CALM'], valence: 'PLEASANT', note: 'ok' }).data, { moods: ['CALM', 'CONTENT'], valence: 'PLEASANT', note: 'ok' });
  assert.equal(v('mood', { at, moods: ['CALM'], valence: 'UNPLEASANT' }).value, -1);
  assert.equal(v('mood', { at, moods: ['CALM'] }).value, null);
  assert.deepEqual([v('symptom', { at, symptoms: ['HEADACHE', 'FATIGUE'] }).value, v('symptom', { at, symptoms: ['HEADACHE'] }).data], [2, { symptoms: ['HEADACHE'] }]);
  assert.deepEqual(v('glucose', { at, mgdl: 94, timing: 'FASTING', meal: 'BREAKFAST', note: 'x' }).data, { timing: 'FASTING', meal: 'BREAKFAST', note: 'x' });
  assert.deepEqual([v('bodytemp', { at, celsius: 36.8, location: 'EAR' }).value, v('height', { at, cm: 178.2 }).value, v('bodyfat', { at, pct: 19.4 }).value], [36.8, 1782, 19.4]);
  assert.deepEqual([v('ovulation', { at, result: 'NEGATIVE' }).value, v('ovulation', { at, result: 'LUTEINIZING_HORMONE_SURGE' }).value], [0, 1]);
  // A period is whole days in the person's zone: midnight to the midnight after the last day.
  const p = v('period', { start: '2026-10-05', end: '2026-10-09', note: 'light' });
  assert.deepEqual(p, { t: Date.parse('2026-10-04T21:00:00Z'), end: Date.parse('2026-10-09T21:00:00Z'), off: 10800, date: '2026-10-05', value: 5, data: { start: '2026-10-05', end: '2026-10-09', note: 'light' } });
  assert.equal(v('period', { start: '2026-10-11' }).value, 1, 'no last day yet: one day');

  const no = (kind, f, re) => assert.throws(() => v(kind, f), (e) => e.status === 400 && e.code === 'bad_entry' && re.test(e.message), `${kind} ${JSON.stringify(f)}`);
  no('water', {}, /amount is needed/);
  no('water', { ml: 0 }, /between 1 and 5000 ml/);
  no('water', { ml: 'lots' }, /between/);
  no('water', { ml: 250, at: NOW + 3_600_000 }, /future/);
  no('water', { ml: 250, at: NOW - 400 * 86_400_000 }, /more than a year ago/);
  no('water', { ml: 250, at: 'yesterday' }, /not a time/);
  no('food', { meal: 'LUNCH', kcal: 100 }, /name is needed/);
  no('food', { name: 'x', kcal: 100 }, /meal is needed/);
  no('food', { name: 'x', meal: 'BRUNCH', kcal: 100 }, /not one of the choices/);
  no('food', { name: 'x', meal: 'LUNCH', kcal: 100, protein: -1 }, /Protein must be between/);
  no('mood', { moods: [] }, /at least one mood/);
  no('mood', { moods: ['GRUMPY'] }, /not one of the choices/);
  no('mood', { moods: ['CALM'], valence: 'GREAT' }, /not one of the choices/);
  no('symptom', { symptoms: 'HEADACHE' }, /at least one symptom/);
  no('glucose', { mgdl: 5 }, /between 10 and 900 mg\/dL/);
  no('bodytemp', { celsius: 98.6 }, /between 30 and 45 C/);
  no('height', { cm: 17.8 }, /between 50 and 272 cm/);
  no('bodyfat', { pct: 90 }, /between 2 and 75 %/);
  no('ovulation', {}, /result is needed/);
  no('period', { start: '5 Oct' }, /first day is needed/);
  no('period', { start: '2026-10-09', end: '2026-10-05' }, /cannot be before/);
  no('period', { start: '2026-10-12' }, /future/);
  no('period', { start: '2026-08-01', end: '2026-10-01' }, /at most 31 days/);
  assert.throws(() => v('steps', { n: 1 }), (e) => e.code === 'bad_kind');
  assert.ok(LIMITS.water.ml && LIMITS.glucose.mgdl && LIMITS.height.cm, 'the limits are there for a form to show');
});

test('fieldsOf is the reverse of validate, and bodyOf is what Google is sent', () => {
  const at = Date.parse('2026-10-11T06:30:00Z');
  const cases = {
    water: { at, ml: 250 }, food: { at, name: 'Oats', meal: 'BREAKFAST', kcal: 380, protein: 13, carbs: 62, fat: 8 },
    mood: { at, moods: ['CALM'], valence: 'PLEASANT', note: 'fine' }, symptom: { at, symptoms: ['HEADACHE'], note: null },
    glucose: { at, mgdl: 94, timing: 'FASTING', meal: null, note: null }, bodytemp: { at, celsius: 36.8, location: 'EAR' },
    height: { at, cm: 178 }, bodyfat: { at, pct: 19.4 }, period: { start: '2026-10-05', end: '2026-10-09', note: null }, ovulation: { at, result: 'POSITIVE' },
  };
  for (const [kind, f] of Object.entries(cases)) {
    const row = { kind, ...validate(kind, f, { now: NOW, tz: TZ }) };
    assert.deepEqual(fieldsOf(row), f, kind);
    const body = bodyOf(row);
    assert.deepEqual(body.dataSource, { recordingMethod: 'MANUAL' });
    assert.ok(body[KINDS[kind].type.replace(/-([a-z])/g, (_, c) => c.toUpperCase())], kind);
  }
  const mood = bodyOf({ kind: 'mood', ...validate('mood', cases.mood, { now: NOW, tz: TZ }) });
  assert.deepEqual(mood.moods, { moods: ['CALM'], valences: ['PLEASANT'], sampleTime: { physicalTime: '2026-10-11T06:30:00.000Z', utcOffset: '10800s' } }, 'a mood\'s note has no field at Google and is not sent');
  assert.equal(bodyOf({ kind: 'height', ...validate('height', cases.height, { now: NOW, tz: TZ }) }).height.heightMillimeters, '1780');
  assert.deepEqual(entryOf({ id: 'x', data: { name: 'a', _g: { error: 'boom', attempts: 2 } } }), { id: 'x', data: { name: 'a' }, error: 'boom' });
});

test('create: Google first, the name kept, and the next sync reads it back onto the same row', async () => {
  const r = rig();
  const at = NOW - 3_600_000;
  const w = await addEntry(r.deps, 'water', { at, ml: 250 });
  assert.deepEqual([w.google, w.message], ['saved', null]);
  assert.match(w.entry.id, /^l-/);
  assert.equal(w.entry.gname, `users/me/dataTypes/hydration-log/dataPoints/ojee-water-${w.entry.id.slice(2)}`, 'the name this app proposed, which Google accepted');
  assert.deepEqual([w.entry.source, w.entry.value, w.entry.gstate, w.entry.date], ['app', 250, 'saved', '2026-10-11']);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), ['POST hydration-log/dataPoints']);
  assert.deepEqual(r.calls[0].body.hydrationLog.amountConsumed, { milliliters: 250 });
  assert.equal(r.written.length, 1);
  const f = await addEntry(r.deps, 'food', { at, name: 'Oats', meal: 'BREAKFAST', kcal: 380, protein: 13 });
  assert.equal(f.google, 'saved');

  const res = await r.sync.run();
  assert.equal(res.ok, true);
  assert.equal(r.sync.state.streams.water.rows, 1, 'the list returned what this app wrote');
  assert.deepEqual(r.db.samples('water').map((x) => [x.id, x.source, x.gstate]), [[w.entry.id, 'app', 'saved']], 'one row, still this app\'s');
  assert.deepEqual(r.db.samples('food').map((x) => [x.id, x.data.name, x.data.protein]), [[f.entry.id, 'Oats', 13]]);
  const metrics = new Set(Object.values(r.db.dailyTable('0000-00-00')).flatMap((m) => Object.keys(m)));
  assert.deepEqual([...metrics].sort(), ['distance_m', 'steps'], 'the phone\'s steps and distance, and nothing sensitive, are in daily');
});

test('every kind goes to its own data type; mood, symptoms and cycle are written out and never read', async () => {
  const r = rig();
  const at = NOW - 7_200_000;
  const made = {
    mood: await addEntry(r.deps, 'mood', { at, moods: ['CALM'], valence: 'PLEASANT', note: 'kept here' }),
    symptom: await addEntry(r.deps, 'symptom', { at, symptoms: ['HEADACHE'] }),
    period: await addEntry(r.deps, 'period', { start: '2026-10-05', end: '2026-10-09' }),
    ovulation: await addEntry(r.deps, 'ovulation', { at, result: 'POSITIVE' }),
    glucose: await addEntry(r.deps, 'glucose', { at, mgdl: 94, timing: 'FASTING' }),
    bodytemp: await addEntry(r.deps, 'bodytemp', { at, celsius: 36.8 }),
    height: await addEntry(r.deps, 'height', { at, cm: 178 }),
    bodyfat: await addEntry(r.deps, 'bodyfat', { at, pct: 19.4 }),
  };
  for (const [kind, m] of Object.entries(made)) { assert.equal(m.google, 'saved', kind); assert.ok(m.entry.gname.includes(`/dataTypes/${KINDS[kind].type}/dataPoints/ojee-${kind}-`), kind); }
  assert.deepEqual(r.calls.map((c) => c.path), ['moods/dataPoints', 'symptoms/dataPoints', 'menstrual-period/dataPoints', 'ovulation-test/dataPoints', 'blood-glucose/dataPoints', 'core-body-temperature/dataPoints', 'height/dataPoints', 'body-fat/dataPoints']);
  assert.equal(made.mood.entry.data.note, 'kept here');
  assert.equal(r.calls[0].body.moods.notes, undefined);
  // The two that are a daily number as well, and only those.
  assert.deepEqual(r.db.dailyTable('0000-00-00'), { '2026-10-11': { height_mm: 1780, body_fat: 19.4 } });
  // The stand-in refuses to list them, exactly as the real API does.
  await assert.rejects(r.google.list('moods', {}), (e) => e.status === 400 && /List is not supported for data type moods, but the following actions are supported: create, update, batchDelete/.test(e.message));
  r.calls.length = 0;
  await r.sync.run();
  for (const t of ['moods', 'symptoms', 'menstrual-period', 'ovulation-test']) assert.ok(!r.calls.some((c) => c.path.startsWith(`${t}/`)), `no stream reads ${t}`);
  for (const k of ['mood', 'symptom', 'period', 'ovulation', 'glucose', 'bodytemp', 'height', 'bodyfat']) assert.equal(r.db.samples(k).length, 1, `${k}: one row after the sync`);
  assert.deepEqual([r.db.samples('glucose')[0].source, r.db.samples('glucose')[0].id], ['app', made.glucose.entry.id], 'the glucose reading read back is the one logged here');
});

test('patch: an edit replaces the point at Google by its name; delete removes it', async () => {
  const r = rig();
  const w = await addEntry(r.deps, 'water', { at: NOW - 3_600_000, ml: 250 });
  r.calls.length = 0;
  const e = await editEntry(r.deps, w.entry.id, { ml: 400 });
  assert.deepEqual([e.google, e.entry.value, e.entry.id, e.entry.gname], ['saved', 400, w.entry.id, w.entry.gname]);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`PATCH ${w.entry.gname.replace('users/me/dataTypes/', '')}`]);
  assert.equal(r.calls[0].body.name, w.entry.gname);
  assert.equal(r.written[0].body.hydrationLog.amountConsumed.milliliters, 400);
  assert.equal(r.written.length, 1, 'changed in place, not created again');
  // A new time moves the row and the point together.
  const moved = await editEntry(r.deps, w.entry.id, { at: NOW - 30 * 3_600_000 });
  assert.deepEqual([moved.entry.date, moved.entry.value], ['2026-10-10', 400]);
  assert.equal(r.written[0].body.hydrationLog.interval.startTime, new Date(NOW - 30 * 3_600_000).toISOString());
  await assert.rejects(editEntry(r.deps, w.entry.id, { ml: 0 }), (x) => x.code === 'bad_entry');
  assert.equal(r.db.sampleGet(w.entry.id).value, 400, 'a refused edit changes nothing');

  r.calls.length = 0;
  const d = await removeEntry(r.deps, w.entry.id);
  assert.deepEqual(d, { ok: true, google: 'saved', message: null });
  assert.deepEqual([r.calls[0].path, r.calls[0].body], ['hydration-log/dataPoints:batchDelete', { names: [w.entry.gname] }]);
  assert.equal(r.written.length, 0);
  assert.deepEqual(r.db.samples('water'), []);
  await assert.rejects(removeEntry(r.deps, w.entry.id), (x) => x.status === 404);
  await r.sync.run();
  assert.deepEqual(r.db.samples('water'), [], 'and it does not come back');
});

test('what Google holds from elsewhere is read-only here', async () => {
  const r = rig({ persona: PERSONAS.fitbit });
  await r.sync.run();
  const g = r.db.samples('glucose')[0];
  assert.equal(g.source, 'google');
  await assert.rejects(editEntry(r.deps, g.id, { mgdl: 100 }), (e) => e.status === 403 && e.code === 'read_only' && /can only be changed there/.test(e.message));
  await assert.rejects(removeEntry(r.deps, g.id), (e) => e.code === 'read_only');
  await assert.rejects(editEntry(r.deps, 'l-nope', { ml: 1 }), (e) => e.status === 404 && e.code === 'not_found');
});

test('create_only: Google takes the entry but names nothing, so later changes stay here and the reply says so', async () => {
  // A server that refuses a client-chosen name, then creates without returning one.
  const r = rig({ wrap: async (url, init) => {
    if (init.method !== 'POST' || !url.pathname.endsWith('/moods/dataPoints')) return null;
    return JSON.parse(init.body).name ? json(400, { error: { code: 400, message: 'Invalid value at name: client-provided names are not supported for this data type.', status: 'INVALID_ARGUMENT' } }) : json(200, { name: 'operations/9', done: true });
  } });
  const m = await addEntry(r.deps, 'mood', { at: NOW - 1000, moods: ['CALM'] });
  assert.equal(m.google, 'create_only');
  assert.match(m.message, /has to be changed there/);
  assert.deepEqual([m.entry.gname, m.entry.gstate], [null, 'create_only']);
  assert.deepEqual(r.calls.map((c) => [c.method, !!c.body.name]), [['POST', true], ['POST', false]], 'asked once with a name, once without');
  r.calls.length = 0;
  const e = await editEntry(r.deps, m.entry.id, { moods: ['HAPPY'] });
  assert.deepEqual([e.google, e.entry.data.moods], ['create_only', ['HAPPY']]);
  assert.match(e.message, /has to be changed there/);
  assert.deepEqual(await flushEntries(r.deps), { sent: 0, failed: 0, skipped: 0 }, 'nothing is owed: it is never created a second time');
  const d = await removeEntry(r.deps, m.entry.id);
  assert.deepEqual([d.google, /has to be removed there/.test(d.message)], ['create_only', true]);
  assert.equal(r.calls.length, 0, 'no call can change a point with no name');
  assert.deepEqual(r.db.samples('mood'), []);
});

test('a name Google gives of its own is kept; an assumed name that turns out wrong is not created twice', async () => {
  // Names its own points: the Operation's response carries the real name.
  let r = rig({ wrap: async (url, init) => (init.method === 'POST' && url.pathname.endsWith('/symptoms/dataPoints') ? json(200, { name: 'operations/1', done: true, response: { name: 'users/me/dataTypes/symptoms/dataPoints/9f1c2d3e' } }) : null) });
  const s = await addEntry(r.deps, 'symptom', { at: NOW - 1000, symptoms: ['COUGH'] });
  assert.deepEqual([s.google, s.entry.gname], ['saved', 'users/me/dataTypes/symptoms/dataPoints/9f1c2d3e']);

  // Accepts the create without echoing a name, and later has no such point.
  r = rig({ wrap: async (url, init) => {
    if (init.method === 'POST' && url.pathname.endsWith('/symptoms/dataPoints')) return json(200, { name: 'operations/2', done: true });
    if (init.method === 'PATCH') return json(404, { error: { code: 404, message: 'data point not found', status: 'NOT_FOUND' } });
    return null;
  } });
  const a = await addEntry(r.deps, 'symptom', { at: NOW - 1000, symptoms: ['COUGH'] });
  assert.equal(a.google, 'saved');
  assert.match(a.entry.gname, /ojee-symptom-/);
  r.calls.length = 0;
  const e = await editEntry(r.deps, a.entry.id, { symptoms: ['FEVER'] });
  assert.deepEqual([e.google, e.entry.gname], ['create_only', null]);
  assert.deepEqual(r.calls.map((c) => c.method), ['PATCH'], 'not created again: that would leave two copies at Google');

  // A name that was confirmed, and a point since deleted in Google's own app: made again.
  r = rig();
  const w = await addEntry(r.deps, 'water', { at: NOW - 1000, ml: 250 });
  r.written.length = 0;
  const again = await editEntry(r.deps, w.entry.id, { ml: 300 });
  assert.equal(again.google, 'saved');
  assert.equal(r.written.length, 1);
  assert.equal(r.written[0].body.hydrationLog.amountConsumed.milliliters, 300);
});

test('failure: the entry is kept, marked failed, and a later flush sends it', async () => {
  const r = rig();
  r.hook.fn = async () => json(503, { error: { code: 503, message: 'backend unavailable', status: 'UNAVAILABLE' } });
  const w = await addEntry(r.deps, 'water', { at: NOW - 1000, ml: 250 });
  assert.equal(w.google, 'failed');
  assert.match(w.message, /Saved here\. Google Health did not take it \(backend unavailable\); it will be tried again at the next sync\./);
  assert.deepEqual([w.entry.gstate, w.entry.error, w.entry.data], ['failed', 'backend unavailable', {}], 'the bookkeeping is not part of the entry');
  assert.equal(r.db.samples('water').length, 1, 'what was typed is not lost');
  assert.equal(r.db.sampleGet(w.entry.id).data._g.attempts, 1);

  assert.deepEqual(await flushEntries(r.deps), { sent: 0, failed: 1, skipped: 0 });
  assert.equal(r.db.sampleGet(w.entry.id).data._g.attempts, 2);
  r.hook.fn = null;
  assert.deepEqual(await flushEntries(r.deps), { sent: 1, failed: 0, skipped: 0 });
  const row = r.db.sampleGet(w.entry.id);
  assert.deepEqual([row.gstate, !!row.gname, row.data], ['saved', true, {}]);
  assert.equal(r.written.length, 1);
  assert.deepEqual(await flushEntries(r.deps), { sent: 0, failed: 0, skipped: 0 }, 'nothing left to send');
});

test('failed edits and deletes are owed too; a 429 stops the flush without counting against the entry', async () => {
  const r = rig();
  const a = await addEntry(r.deps, 'water', { at: NOW - 3000, ml: 250 });
  const b = await addEntry(r.deps, 'water', { at: NOW - 2000, ml: 300 });
  const c = await addEntry(r.deps, 'food', { at: NOW - 1000, name: 'Tea', meal: 'SNACK', kcal: 2 });
  r.hook.fn = async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
  r.clock.t += 1000;
  assert.equal((await editEntry(r.deps, a.entry.id, { ml: 500 })).google, 'failed');
  r.clock.t += 1000;
  const d = await removeEntry(r.deps, b.entry.id);
  assert.deepEqual([d.google, /will be removed from Google Health/.test(d.message)], ['failed', true]);
  assert.deepEqual(r.db.samples('water').map((x) => x.value), [500], 'the delete took effect here at once');
  r.clock.t += 1000;
  await editEntry(r.deps, c.entry.id, { kcal: 5 });
  r.calls.length = 0;
  assert.deepEqual(await flushEntries(r.deps), { sent: 0, failed: 1, skipped: 0 }, 'stopped at the first "slow down"');
  assert.equal(r.calls.length, 1);
  assert.equal(r.db.sampleGet(a.entry.id).data._g.attempts, undefined, 'being told to wait is not a failed attempt');
  r.hook.fn = null;
  assert.deepEqual(await flushEntries(r.deps), { sent: 3, failed: 0, skipped: 0 });
  assert.deepEqual(r.written.map((w) => w.type).sort(), ['hydration-log', 'nutrition-log']);
  assert.equal(r.written.find((w) => w.type === 'hydration-log').body.hydrationLog.amountConsumed.milliliters, 500);
  assert.equal(r.written.find((w) => w.type === 'nutrition-log').body.nutritionLog.energy.kcal, 5);
});

test('an entry Google keeps refusing is left alone after six tries', async () => {
  const r = rig();
  r.hook.fn = async () => json(400, { error: { code: 400, message: 'Invalid data point.', status: 'INVALID_ARGUMENT' } });
  const w = await addEntry(r.deps, 'water', { at: NOW - 1000, ml: 250 });
  for (let i = 0; i < 8; i += 1) await flushEntries(r.deps);
  assert.equal(r.calls.length, 6);
  assert.deepEqual([r.db.sampleGet(w.entry.id).gstate, r.db.sampleGet(w.entry.id).data._g.attempts], ['failed', 6]);
  assert.equal(r.db.samples('water').length, 1, 'it is still the person\'s entry');
});

test('local: without Google, or without the scope, entries are kept here; they go up once that changes', async () => {
  const r = rig({ connected: false });
  const w = await addEntry(r.deps, 'water', { at: NOW - 1000, ml: 250 });
  assert.deepEqual([w.google, w.entry.gstate, w.entry.gname], ['local', 'local', null]);
  assert.match(w.message, /Kept on this site only: Google Health is not connected\./);
  assert.equal((await editEntry(r.deps, w.entry.id, { ml: 300 })).google, 'local');
  assert.equal(r.calls.length, 0);
  assert.deepEqual(await flushEntries(r.deps), { sent: 0, failed: 0, skipped: 0 });
  const gone = await addEntry(r.deps, 'water', { at: NOW - 500, ml: 100 });
  assert.deepEqual(await removeEntry(r.deps, gone.entry.id), { ok: true, google: 'local', message: null });
  assert.equal(r.db.sampleGet(gone.entry.id), null, 'it never reached Google: nothing to remember');

  // Connected, but only with the core scopes: the nutrition scope is missing.
  r.held.scopes = Object.values(SCOPES);
  r.google.tok = { refresh: 'RT', access: 'AT', expiresAt: Number.MAX_SAFE_INTEGER, scopes: r.held.scopes };
  const f = await addEntry(r.deps, 'food', { at: NOW - 900, name: 'Tea', meal: 'SNACK', kcal: 2 });
  assert.equal(f.google, 'local');
  assert.match(f.message, /has not been given this permission/);
  assert.equal((await addEntry(r.deps, 'glucose', { at: NOW - 800, mgdl: 94 })).google, 'saved', 'a core kind goes up with the core scopes');
  assert.deepEqual(await flushEntries(r.deps), { sent: 0, failed: 0, skipped: 2 });
  assert.deepEqual(target(r.deps, 'water'), { known: true, type: 'hydration-log', group: 'nutrition', chosen: true, connected: true, usable: false });

  // The person grants the group: what was kept local goes up at the next flush.
  r.held.scopes.push(GROUP_SCOPES.nutritionWrite);
  assert.equal(target(r.deps, 'water').usable, true);
  assert.deepEqual(await flushEntries(r.deps), { sent: 2, failed: 0, skipped: 0 });
  assert.deepEqual(r.db.samples('water').map((x) => [x.value, x.gstate]), [[300, 'saved']]);
  assert.equal(r.db.samples('food')[0].gstate, 'saved');
});

test('a group that is switched off refuses its kinds at once, whatever Google granted', async () => {
  const r = rig({ groups: { nutrition: true } });
  const w = await addEntry(r.deps, 'water', { at: NOW - 1000, ml: 250 });
  await assert.rejects(addEntry(r.deps, 'mood', { moods: ['CALM'] }), (e) => e.status === 409 && e.code === 'group_off' && /Switch on mood tracking first/.test(e.message));
  await assert.rejects(addEntry(r.deps, 'period', { start: '2026-10-05' }), (e) => e.code === 'group_off');
  assert.equal((await addEntry(r.deps, 'glucose', { mgdl: 94 })).google, 'saved', 'kinds outside the groups are not affected');
  r.chosen.nutrition = false;
  await assert.rejects(addEntry(r.deps, 'water', { ml: 250 }), (e) => e.code === 'group_off');
  await assert.rejects(editEntry(r.deps, w.entry.id, { ml: 300 }), (e) => e.code === 'group_off');
  r.calls.length = 0;
  await r.sync.run();
  assert.equal(r.sync.state.streams.water.skipped, 'group off');
  assert.ok(!r.calls.some((c) => c.path.startsWith('hydration-log')), 'and its stream is not read');
  // The rows stay until the person asks for them to go.
  assert.equal(r.db.samples('water').length, 1);
  assert.equal(r.db.samplesPurge(['water', 'food']), 1);
});

test('the stand-in Google refuses a write without the write scope', async () => {
  const r = rig({ scopes: Object.values(SCOPES) });
  await assert.rejects(r.google.createPoint('moods', bodyOf({ kind: 'mood', ...validate('mood', { moods: ['CALM'] }, { now: NOW, tz: TZ }) })), (e) => e.status === 403 && e.code === 'PERMISSION_DENIED');
  await assert.rejects(r.google.list('hydration-log', {}), (e) => e.status === 403 && /Required OAuth scope\(s\) are missing/.test(e.message));
  await assert.rejects(r.google.list('electrocardiogram', {}), (e) => e.status === 403);
});
