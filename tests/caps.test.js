import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { openDb } from '../server/core/db.js';
import { computeCaps, readCaps, CAPS, CORE_CAPS, MORE_CAPS } from '../server/caps.js';
import { readinessFor } from '../server/core/metrics.js';
import { addDays } from '../server/core/util.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const on = (caps) => CAPS.filter((k) => caps[k]);

test('nothing is assumed before the first sync', async () => {
  const p = await r.person('fresh');
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(on(me.caps), []);
  const d = (await p.c.get('/api/data')).json;
  assert.deepEqual([d.connected, d.empty], [false, true]);
  assert.equal(d.series.length, 30);
  assert.ok(d.series.every((x) => x.steps === null));
  const w = (await p.c.get('/api/workouts')).json;
  assert.deepEqual([w.detection.available, w.detection.reason], [false, 'Connect Google Health to use workout detection']);
});

test('a Fitbit with everything', async () => {
  const p = await r.person('fitbit', { persona: 'fitbit' });
  const me = (await p.c.get('/api/me')).json;
  // Everything but plain active minutes being the source: zone minutes count as active minutes.
  // The newer ones its sensors carry are on too; the ones a person logs by
  // hand, and the optional groups nobody switched on, are not.
  assert.deepEqual(on(me.caps), [...CORE_CAPS, 'floors', 'caloriesActive', 'respiratoryRate', 'vo2max', 'zones', 'glucose', 'bodyTemp', 'height']);
  assert.deepEqual(me.capsMeta.missing, []);
  assert.deepEqual(me.capsMeta.missingMore, [], 'a group that is off is not called missing');
  assert.equal(me.device.name, 'Fitbit Air');
});

test('a phone: steps and distance only, and the app says what is missing and why', async () => {
  const p = await r.person('phone', { persona: 'phone' });
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(on(me.caps), ['steps', 'distance']);
  assert.deepEqual(me.capsMeta.missingMore.map((m) => m.cap), ['floors', 'caloriesActive', 'respiratoryRate', 'vo2max', 'zones', 'glucose', 'bodyTemp', 'height'], 'none of the newer metrics, and no group asked for');
  assert.match(me.capsMeta.missingMore.find((m) => m.cap === 'height').text, /Log it here/);
  assert.ok(MORE_CAPS.every((k) => me.caps[k] === false));
  assert.equal(me.device, null);
  assert.equal(me.capsMeta.missing.find((m) => m.cap === 'hrv').text, 'Your device does not report HRV');
  const d = (await p.c.get('/api/data')).json;
  // Missing is null, never zero.
  const last = d.series.at(-2);
  assert.ok(last.steps > 0 && last.distanceM > 0);
  for (const k of ['azm', 'activeMin', 'kcal', 'rhr', 'hrv', 'spo2', 'tempDev', 'sleepMin', 'bodyFat']) assert.equal(last[k], null, k);
  assert.equal(d.sleep.lastNight, null);
  assert.equal(d.readiness.level, 'unavailable');
  assert.match(d.readiness.text, /your device reports none of them/);
  assert.deepEqual(d.readiness.used, []);
  // Detection cannot be switched on without minute heart rate.
  const w = (await p.c.get('/api/workouts')).json;
  assert.equal(w.detection.available, false);
  assert.match(w.detection.reason, /minute-by-minute heart rate/);
  const sw = await p.c.post('/api/workouts/settings', { enabled: true });
  assert.equal(sw.status, 409);
  assert.equal((await p.c.get('/api/workouts')).json.detection.settings.enabled, false);
});

test('a watch with no HRV and no stages: readiness uses what there is and says which', async () => {
  const p = await r.person('garmin', { persona: 'garmin' });
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(on(me.caps), ['steps', 'activeMinutes', 'calories', 'distance', 'heartRate', 'heartRateMinute', 'restingHr', 'sleep', 'weight', 'exercise', 'floors', 'caloriesActive']);
  const d = (await p.c.get('/api/data')).json;
  assert.ok(['push', 'normal', 'easy', 'rest'].includes(d.readiness.level));
  assert.deepEqual(d.readiness.used, ['rhr', 'sleep']);
  assert.equal(d.readiness.usedText, 'Based on resting heart rate and sleep');
  // Plain active minutes stand in for zone minutes.
  assert.equal(d.activity.today.azm, null);
  assert.ok(d.series.at(-2).activeMin > 0);
  assert.equal(d.activity.today.activeMinutes, d.activity.today.activeMin);
  // Sleep without stages still has a duration.
  assert.ok(d.sleep.lastNight.asleepMin > 300);
  assert.deepEqual(d.sleep.nights.at(-1).stages, []);
  assert.equal((await p.c.get('/api/workouts')).json.detection.available, true);
});

test('declined scopes: the rest still works, and the app says what to reconnect for', async () => {
  const p = await r.person('partial');
  r.parts.personaOf.set(p.id, 'fitbit');
  const { SCOPES, pkce } = await import('../server/core/google.js');
  await r.app.worlds.hold(p.id, async (w) => {
    const pk = pkce();
    await w.google.exchange({ code: r.parts.issue(pk.challenge), verifier: pk.verifier });
    // What Google sends when the person unticked sleep and both writes.
    w.google.tok.scopes = [SCOPES.activity, SCOPES.metrics, SCOPES.settings];
    r.app.app.patchProfile(p.id, { googleState: 'ok' });
  });
  const res = await r.app.syncUser(p.id);
  assert.equal(res.ok, true);
  const me = (await p.c.get('/api/me')).json;
  assert.equal(me.google.state, 'ok');
  assert.deepEqual(me.google.missing, ['Reconnect to allow reading sleep', 'Reconnect to allow saving your weight', 'Reconnect to allow saving workouts']);
  assert.deepEqual([me.google.canWriteWeight, me.google.canWriteWorkouts], [false, false]);
  assert.equal(me.sync.streams.sleep.skipped, 'scope not granted');
  assert.deepEqual([me.caps.steps, me.caps.hrv, me.caps.sleep], [true, true, false]);
  const wt = await p.c.post('/api/weight', { kg: 80 });
  // Without that permission a weigh-in is kept here, and the reply says how to send it there too.
  assert.deepEqual([wt.status, wt.json.google], [200, 'local']);
  assert.match(wt.json.message, /^Saved here\. Reconnect Google Health and allow saving your weight/);
  // A workout can still be logged; it waits for the permission.
  const lg = await p.c.post('/api/workouts/log', { start: Date.now() - 86_400_000, end: Date.now() - 86_400_000 + 1_800_000 });
  await new Promise((res2) => { setTimeout(res2, 30); });
  const w = (await p.c.get('/api/workouts')).json;
  assert.equal(lg.status, 200);
  assert.deepEqual([w.canWrite, w.needsReconnect], [false, true]);
  assert.equal(w.history.find((x) => x.source === 'logged').google.state, 'needs_scope');
});

test('a capability lapses when the stream goes quiet for 14 days, and zero is not data', () => {
  const db = openDb(':memory:');
  const now = Date.parse('2026-10-10T12:00:00Z');
  db.setDaily('2026-10-09', 'steps', 5000);
  db.setDaily('2026-09-20', 'hrv', 48);        // three weeks ago
  db.setDaily('2026-10-09', 'kcal', 0);        // a roll-up that came back as zero
  db.setMeta('hrDense', { t: now - 20 * 86_400_000, n: 400 });
  db.setMeta('hr', { t: now - 3600_000, bpm: 70 });
  const { caps, meta } = computeCaps(db, { now, tz: 'UTC' });
  assert.deepEqual(CAPS.filter((k) => caps[k]), ['steps', 'heartRate']);
  assert.equal(meta.lastSeen.hrv, '2026-09-20');
  assert.deepEqual(readCaps(db).caps, caps);
});

test('readiness adapts: sleep alone when the device has neither HRV nor resting HR', () => {
  const t = {};
  for (let i = 0; i < 20; i += 1) t[addDays('2026-10-10', -i)] = { sleep_min: 400 };
  t['2026-10-10'] = { sleep_min: 330 };
  const sleepOnly = { hrv: false, restingHr: false, sleep: true };
  const a = readinessFor(t, '2026-10-10', { caps: sleepOnly });
  assert.deepEqual([a.level, a.used, a.usedText], ['easy', ['sleep'], 'Based on sleep']);
  // Without knowing the device (or with a device that does have HRV) the
  // same table is "still learning", as before.
  assert.equal(readinessFor(t, '2026-10-10').level, 'learning');
  assert.equal(readinessFor(t, '2026-10-10', { caps: { hrv: true, restingHr: true, sleep: true } }).level, 'learning');
  assert.equal(readinessFor({}, '2026-10-10', { caps: { hrv: false, restingHr: false, sleep: false } }).level, 'unavailable');
});
