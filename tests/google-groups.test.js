/* The optional scope groups, incremental authorization, the request bodies
   of every point this app writes (checked against the discovery document's
   own field names), and the generic create / patch / delete calls. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GoogleHealth, SCOPES, GROUP_SCOPES, GROUPS, GROUP_IDS, groupById, cleanGroups, build, WRITABLE, pointNameFor, typeOfName, ROLLUP_CAP_14,
} from '../server/core/google.js';

const G = 'https://www.googleapis.com/auth/googlehealth.';
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ojee-health-')), 'google.json');
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fake(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
    calls.push({ url: u, method: init.method || 'GET', body });
    return handler(u, init, body, calls);
  };
  f.calls = calls;
  return f;
}
const make = (o = {}) => new GoogleHealth({ clientId: 'cid', clientSecret: 'shh', redirectUri: 'https://health.example/auth/google/callback', tokenFile: tmpFile(), ...o });
const CORE = Object.values(SCOPES);

test('the groups: stable ids, the scopes the probe settled on, write-only except ECG', () => {
  assert.deepEqual(GROUP_IDS, ['nutrition', 'mindfulness', 'symptoms', 'cycle', 'sleeplog', 'ecg']);
  const scopes = Object.fromEntries(GROUPS.map((g) => [g.id, g.scopes.map((s) => s.replace(G, ''))]));
  assert.deepEqual(scopes, {
    nutrition: ['nutrition.writeonly'], mindfulness: ['mindfulness.writeonly'], symptoms: ['logged_symptoms.writeonly'],
    cycle: ['reproductive_health.writeonly'], sleeplog: ['sleep.writeonly'], ecg: ['ecg.readonly', 'irn.readonly'],
  });
  assert.deepEqual(GROUPS.filter((g) => g.readOnly).map((g) => g.id), ['ecg']);
  assert.deepEqual(GROUPS.filter((g) => g.writeOnly).map((g) => g.id), ['nutrition', 'mindfulness', 'symptoms', 'cycle', 'sleeplog']);
  for (const g of GROUPS) { assert.ok(g.label && g.about && g.note && g.types.length && g.kinds.length, g.id); assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(g.label + g.about + g.note)); }
  assert.deepEqual(groupById('cycle').types, ['menstrual-period', 'ovulation-test']);
  assert.equal(groupById('nope'), null);
  assert.deepEqual(cleanGroups('cycle,bogus,nutrition,cycle'), ['nutrition', 'cycle'], 'known ids only, in the catalogue order');
  assert.deepEqual(cleanGroups(null), []);
});

test('authUrl: no groups asks exactly the core set; groups add their scopes; incremental auth stays on', () => {
  const g = make();
  const plain = new URL(g.authUrl({ state: 's', challenge: 'c' }));
  assert.deepEqual(plain.searchParams.get('scope').split(' '), ['openid', 'email', ...CORE]);
  assert.equal(plain.searchParams.get('include_granted_scopes'), 'true');
  const more = new URL(g.authUrl({ state: 's', challenge: 'c', groups: ['ecg', 'nutrition', 'nonsense'] }));
  assert.deepEqual(more.searchParams.get('scope').split(' '), ['openid', 'email', ...CORE, GROUP_SCOPES.nutritionWrite, GROUP_SCOPES.ecg, GROUP_SCOPES.irn]);
  assert.equal(more.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(more.searchParams.get('prompt'), 'consent');
  // No read scope is ever asked for the four write-only groups.
  const all = new URL(g.authUrl({ state: 's', challenge: 'c', groups: GROUP_IDS })).searchParams.get('scope').split(' ');
  for (const fam of ['nutrition', 'mindfulness', 'logged_symptoms', 'reproductive_health']) assert.ok(!all.includes(`${G}${fam}.readonly`), fam);
  for (const no of ['profile', 'location', 'settings.writeonly']) assert.ok(!all.some((s) => s.includes(no)), `${no} is never asked for`);
  // Writing sleep is asked for only with the group that logs it.
  assert.ok(!plain.searchParams.get('scope').includes('sleep.writeonly') && all.includes(`${G}sleep.writeonly`), 'sleep.writeonly comes with its group only');
});

test('an incremental grant: the token reply lists the combined scopes, and a refresh keeps them', async () => {
  let now = 1_000_000;
  let step = 0;
  const f = fake((u, init, body) => {
    if (body.grant_type === 'authorization_code') {
      step += 1;
      // First connect: the core set. Second: the same plus the nutrition group.
      const scope = step === 1 ? ['openid', ...CORE] : ['openid', ...CORE, GROUP_SCOPES.nutritionWrite];
      return json(200, { access_token: `AT-${step}`, refresh_token: `RT-${step}`, expires_in: 3600, scope: scope.join(' ') });
    }
    // A refresh reply with no `scope` at all, then one that repeats it.
    return json(200, f.calls.length % 2 ? { access_token: 'AT-r', expires_in: 3600 } : { access_token: 'AT-r2', expires_in: 3600, scope: ['openid', ...CORE, GROUP_SCOPES.nutritionWrite].join(' ') });
  });
  const g = make({ fetchImpl: f, now: () => now });
  const connect = async (groups) => { const u = new URL(g.authorizeUrl({ groups })); return g.finishAuth({ code: 'c', state: u.searchParams.get('state') }); };

  let st = await connect([]);
  assert.equal(g.groupGranted('nutrition'), false);
  assert.deepEqual(st.groups.filter((x) => x.granted), []);
  assert.deepEqual(st.missing, [], 'a group nobody asked for is not "missing"');
  assert.equal(st.scopes.length, CORE.length, 'status keeps listing the core scopes, as before');
  assert.equal(g.canWrite('hydration-log'), false);
  assert.equal(g.canWrite('weight'), true);

  st = await connect(['nutrition']);
  assert.equal(g.groupGranted('nutrition'), true);
  assert.equal(g.groupGranted('ecg'), false);
  assert.equal(g.groupGranted('bogus'), false);
  assert.deepEqual(st.groups.filter((x) => x.granted).map((x) => x.id), ['nutrition']);
  assert.deepEqual(st.missing, []);
  assert.ok(CORE.every((s) => g.granted(s)), 'the core scopes are still held');
  assert.equal(g.canWrite('hydration-log'), true);
  assert.equal(g.canWrite('moods'), false);

  for (let i = 0; i < 2; i += 1) {
    now += 3_600_000;
    await g.access();
    assert.equal(g.groupGranted('nutrition'), true, 'still granted after a refresh');
    assert.ok(g.granted(SCOPES.sleep));
    assert.ok(JSON.parse(readFileSync(g.tokenFile, 'utf8')).scopes.includes(GROUP_SCOPES.nutritionWrite), 'and on disk');
  }
});

test('half a group is not the group: ECG needs both of its scopes', () => {
  const g = make();
  g.tok = { refresh: 'RT', scopes: [...CORE, GROUP_SCOPES.ecg] };
  assert.equal(g.groupGranted('ecg'), false);
  g.tok.scopes.push(GROUP_SCOPES.irn);
  assert.equal(g.groupGranted('ecg'), true);
  assert.deepEqual(g.status().groups.find((x) => x.id === 'ecg'), { id: 'ecg', granted: true });
  // A declined core scope is still reported; a missing group never is.
  g.tok.scopes = [SCOPES.activity];
  assert.equal(g.status().missing.length, CORE.length - 1);
});

/* ── request bodies, against the discovery document's field names ───── */

const AT = Date.parse('2026-10-06T07:15:00Z');
const ST = { physicalTime: '2026-10-06T07:15:00.000Z', utcOffset: '10800s' };
const MANUAL = { recordingMethod: 'MANUAL' };

test('builders: samples (weight, body fat, height, glucose, body temperature)', () => {
  assert.deepEqual(build.weight({ grams: 77300, at: AT, offsetSec: 10800, notes: 'after run' }), { weight: { weightGrams: 77300, sampleTime: ST, notes: 'after run' }, dataSource: MANUAL });
  assert.deepEqual(build['body-fat']({ pct: 19.4, at: AT, offsetSec: 10800 }), { bodyFat: { percentage: 19.4, sampleTime: ST }, dataSource: MANUAL });
  assert.deepEqual(build.height({ mm: 1780, at: AT, offsetSec: 10800 }), { height: { heightMillimeters: '1780', sampleTime: ST }, dataSource: MANUAL }, 'int64 goes as a string');
  assert.deepEqual(build['blood-glucose']({ mgdl: 94, timing: 'FASTING', meal: 'BREAKFAST', notes: 'x', at: AT, offsetSec: 10800 }),
    { bloodGlucose: { bloodGlucoseMilligramsPerDeciliter: 94, sampleTime: ST, measurementTiming: 'FASTING', mealType: 'BREAKFAST', notes: 'x' }, dataSource: MANUAL });
  assert.deepEqual(build['blood-glucose']({ mgdl: 94, at: AT, offsetSec: 10800 }), { bloodGlucose: { bloodGlucoseMilligramsPerDeciliter: 94, sampleTime: ST }, dataSource: MANUAL }, 'optional fields are left out, not sent empty');
  assert.deepEqual(build['core-body-temperature']({ celsius: 36.8, location: 'EAR', at: AT, offsetSec: 10800 }),
    { coreBodyTemperature: { temperatureCelsius: 36.8, sampleTime: ST, measurementLocation: 'EAR' }, dataSource: MANUAL });
});

test('builders: sessions and intervals (water, food, period), and the write-only logs (mood, symptoms, ovulation test)', () => {
  const span = { startTime: '2026-10-06T07:15:00.000Z', startUtcOffset: '10800s', endTime: '2026-10-06T07:16:00.000Z', endUtcOffset: '10800s' };
  assert.deepEqual(build['hydration-log']({ ml: 250, at: AT, offsetSec: 10800 }), { hydrationLog: { amountConsumed: { milliliters: 250 }, interval: span }, dataSource: MANUAL });
  assert.deepEqual(build['nutrition-log']({ food: 'Chicken and rice', meal: 'LUNCH', kcal: 640, protein: 46, carbs: 70, fat: 16, at: AT, offsetSec: 10800 }), {
    nutritionLog: {
      foodDisplayName: 'Chicken and rice', mealType: 'LUNCH', energy: { kcal: 640 }, totalFat: { grams: 16 }, totalCarbohydrate: { grams: 70 },
      nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: 46 } }], interval: span,
    },
    dataSource: MANUAL,
  });
  // An anonymous food with only a name and calories: no empty macro objects.
  assert.deepEqual(Object.keys(build['nutrition-log']({ food: 'Tea', kcal: 2, at: AT }).nutritionLog), ['foodDisplayName', 'energy', 'interval']);
  const end = Date.parse('2026-10-10T21:00:00Z');
  assert.deepEqual(build['menstrual-period']({ at: AT, end, offsetSec: 10800, notes: 'light' }), {
    menstrualPeriod: { interval: { startTime: '2026-10-06T07:15:00.000Z', startUtcOffset: '10800s', endTime: '2026-10-10T21:00:00.000Z', endUtcOffset: '10800s' }, notes: 'light' }, dataSource: MANUAL,
  });
  assert.deepEqual(build.moods({ moods: ['CALM', 'CONTENT'], valence: 'PLEASANT', at: AT, offsetSec: 10800 }), { moods: { moods: ['CALM', 'CONTENT'], valences: ['PLEASANT'], sampleTime: ST }, dataSource: MANUAL });
  assert.deepEqual(build.moods({ moods: ['CALM'], at: AT, offsetSec: 10800 }), { moods: { moods: ['CALM'], sampleTime: ST }, dataSource: MANUAL });
  assert.deepEqual(build.symptoms({ symptoms: ['HEADACHE'], at: AT, offsetSec: 10800 }), { symptoms: { symptoms: ['HEADACHE'], sampleTime: ST }, dataSource: MANUAL });
  assert.deepEqual(build['ovulation-test']({ result: 'POSITIVE', at: AT, offsetSec: 10800 }), { ovulationTest: { result: 'POSITIVE', sampleTime: ST }, dataSource: MANUAL });
});

test('every builder names only fields the discovery schemas have, and a client-chosen name goes on top', async () => {
  // The field names (and enums) of the DataPoint schema tree, cut from the
  // discovery document itself.
  const doc = JSON.parse(readFileSync(new URL('./fixtures/discovery-fields.json', import.meta.url), 'utf8'));
  assert.equal(doc.revision, '20261007');
  const args = { grams: 1, pct: 1, mm: 1, mgdl: 1, timing: 'FASTING', meal: 'LUNCH', notes: 'n', celsius: 37, location: 'EAR', ml: 1, food: 'f', kcal: 1, protein: 1, carbs: 1, fat: 1, moods: ['CALM'], valence: 'PLEASANT', symptoms: ['COUGH'], result: 'NEGATIVE', at: AT, end: AT + 1000, offsetSec: 0 };
  assert.deepEqual(Object.keys(build).sort(), Object.keys(WRITABLE).filter((t) => t !== 'exercise').sort(), 'a builder for every writable type but exercise (workouts.js builds that)');
  for (const [type, fn] of Object.entries(build)) {
    const name = pointNameFor(type, 'ojee-test-1234');
    const body = fn({ ...args, name });
    assert.equal(body.name, `users/me/dataTypes/${type}/dataPoints/ojee-test-1234`);
    assert.deepEqual(body.dataSource, MANUAL);
    const keys = Object.keys(body).filter((k) => k !== 'name' && k !== 'dataSource');
    assert.equal(keys.length, 1, type);
    assert.equal(keys[0], type.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()), 'the value sits under the camelCase of the type');
    const check = (obj, schema, path) => {
      const props = doc.schemas[schema].properties;
      for (const [k, v] of Object.entries(obj)) {
        assert.ok(props[k], `${path}.${k} is not a field of ${schema}`);
        assert.ok(!props[k].readOnly, `${path}.${k} is output only`);
        const allowed = props[k].enum || props[k].items?.enum;
        if (allowed) for (const x of Array.isArray(v) ? v : [v]) assert.ok(allowed.includes(x), `${path}.${k}: ${x} is not in the enum`);
        const ref = props[k].$ref || props[k].items?.$ref;
        if (ref && v && typeof v === 'object') for (const x of Array.isArray(v) ? v : [v]) check(x, ref, `${path}.${k}`);
      }
    };
    check(body, 'DataPoint', type);
  }
});

test('names: this app proposes ids Google accepts, and refuses names of another type', () => {
  assert.equal(pointNameFor('hydration-log', 'ojee-water-0B1C6D4E-6f0a-4c59-9a55-3a1d3c1f7e21'), 'users/me/dataTypes/hydration-log/dataPoints/ojee-water-0b1c6d4e-6f0a-4c59-9a55-3a1d3c1f7e21');
  assert.match(pointNameFor('moods', 'x'.repeat(90)).split('/').pop(), /^[a-z0-9-]{4,63}$/);
  assert.throws(() => pointNameFor('moods', 'abc'), /not a data point id/);
  assert.throws(() => pointNameFor('steps', 'abcdef'), /not a data point id/);
  assert.equal(typeOfName('users/me/dataTypes/body-fat/dataPoints/abc'), 'body-fat');
  assert.equal(typeOfName('users/me/dataTypes/body-fat'), null);
  assert.ok(ROLLUP_CAP_14.has('total-calories') && !ROLLUP_CAP_14.has('steps'));
});

test('createPoint / patchPoint / deletePoints: the right URLs and bodies, names validated, the exercise and weight calls still work', async () => {
  const f = fake((u) => (u.hostname === 'oauth2.googleapis.com' ? json(200, { access_token: 'AT', expires_in: 3600 }) : json(200, { name: 'operations/1', done: true })));
  const g = make({ fetchImpl: f });
  g.tok = { refresh: 'RT', access: 'AT', expiresAt: Number.MAX_SAFE_INTEGER, scopes: CORE };
  const api = () => f.calls.filter((c) => c.url.hostname === 'health.googleapis.com');
  const name = 'users/me/dataTypes/hydration-log/dataPoints/ojee-water-1234';

  await g.createPoint('hydration-log', build['hydration-log']({ ml: 250, at: AT, name }));
  assert.deepEqual([api()[0].method, api()[0].url.pathname], ['POST', '/v4/users/me/dataTypes/hydration-log/dataPoints']);
  assert.equal(JSON.parse(api()[0].body).name, name);
  await g.patchPoint(name, build['hydration-log']({ ml: 300, at: AT }));
  assert.deepEqual([api()[1].method, api()[1].url.pathname], ['PATCH', `/v4/${name}`]);
  assert.equal(JSON.parse(api()[1].body).name, name, 'the body carries the name it is patching');
  assert.equal(JSON.parse(api()[1].body).hydrationLog.amountConsumed.milliliters, 300);
  await g.deletePoints('hydration-log', [name]);
  assert.deepEqual([api()[2].method, api()[2].url.pathname, JSON.parse(api()[2].body)], ['POST', '/v4/users/me/dataTypes/hydration-log/dataPoints:batchDelete', { names: [name] }]);

  await assert.rejects(g.createPoint('steps', {}), (e) => e.code === 'bad_type');
  await assert.rejects(g.createPoint('moods', { name }), (e) => e.code === 'bad_name', 'a name of another type');
  await assert.rejects(g.patchPoint('users/me/dataTypes/steps/dataPoints/x', {}), (e) => e.code === 'bad_name');
  await assert.rejects(g.patchPoint('users/me/settings', {}), (e) => e.code === 'bad_name');
  await assert.rejects(g.deletePoints('moods', [name]), (e) => e.code === 'bad_name');
  await assert.rejects(g.deletePoints('hydration-log', []), (e) => e.code === 'bad_name');
  await assert.rejects(g.deletePoints('electrocardiogram', ['users/me/dataTypes/electrocardiogram/dataPoints/abcd']), (e) => e.code === 'bad_type', 'read-only types cannot be written');
  assert.equal(api().length, 3, 'nothing refused here ever reached Google');

  await g.createWeight({ grams: 77300, at: AT, offsetSec: 10800 });
  assert.deepEqual(JSON.parse(api()[3].body), { weight: { weightGrams: 77300, sampleTime: ST }, dataSource: MANUAL });
  await g.createExercise({ exercise: {} });
  await g.patchExercise('users/me/dataTypes/exercise/dataPoints/ojee-w-1', { exercise: {} });
  await g.deleteExercises(['users/me/dataTypes/exercise/dataPoints/ojee-w-1']);
  assert.deepEqual(api().slice(4).map((c) => c.method), ['POST', 'PATCH', 'POST']);
});

test('dailyRollUp splits a range the type does not allow in one call: 14 days for four types, 90 for the rest', async () => {
  const f = fake(() => json(200, { rollupDataPoints: [{}] }));
  const g = make({ fetchImpl: f });
  g.tok = { refresh: 'RT', access: 'AT', expiresAt: Number.MAX_SAFE_INTEGER, scopes: CORE };
  const spans = () => f.calls.splice(0).map((c) => { const { start, end } = JSON.parse(c.body).range; return `${start.date.month}/${start.date.day}-${end.date.month}/${end.date.day}`; });
  assert.equal((await g.dailyRollUp('steps', '2026-07-14', '2026-10-12')).length, 1);
  assert.deepEqual(spans(), ['7/14-10/12'], '90 days of steps: one call');
  await g.dailyRollUp('heart-rate', '2026-09-01', '2026-10-12');
  assert.deepEqual(spans(), ['9/1-9/15', '9/15-9/29', '9/29-10/12'], 'heart rate: 14 days at a time, the last one shorter');
  await g.dailyRollUp('floors', '2026-01-01', '2026-07-01');
  assert.deepEqual(spans(), ['1/1-4/1', '4/1-6/30', '6/30-7/1'], 'even the 90-day types are split past 90');
  await g.dailyRollUp('total-calories', '2026-10-01', '2026-10-15');
  assert.deepEqual(spans(), ['10/1-10/15'], 'exactly 14 days is one call');
});
