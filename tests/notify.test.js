import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { Alerts, TYPES, mergePrefs, inQuiet, wall, toMin } from '../server/core/alerts.js';
import { rig } from './helpers.mjs';

const TZ = 'Africa/Cairo';
const T0 = Date.parse('2026-10-08T08:00:00Z');   // Thursday 11:00 in Cairo

function arig({ dash = {}, auth = { state: 'ok' }, device = null, sync = {}, weekly = null } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const clock = { t: T0 };
  const state = {
    auth, device, sync: { lastOk: T0, lastError: null, ...sync },
    dash: { today: '2026-10-08', readiness: { level: 'easy', label: 'Easy day', text: 'HRV −12% vs baseline' }, sleep: { lastNight: { date: '2026-10-08', asleepMin: 432 } }, activity: { today: { steps: 3000 }, stepTarget: 8000 }, ...dash },
  };
  const a = new Alerts({ db, now: () => clock.t, tz: () => TZ, snapshot: () => state, emit: (type, title, body, extra) => sent.push({ type, title, body, ...extra }), weekly });
  return { a, db, sent, clock, state };
}
const at = (hhmm, date = '2026-10-08') => Date.parse(`${date}T${hhmm}:00+03:00`);

test('the nine types, with their defaults', () => {
  assert.deepEqual(TYPES.map((t) => t.id), ['workout_start', 'workout_end', 'morning', 'weekly', 'step_goal', 'leaderboard', 'record', 'battery', 'connection']);
  assert.deepEqual(Object.entries(mergePrefs().types).filter(([, v]) => !v).map(([k]) => k), ['leaderboard']);
  assert.deepEqual(mergePrefs({ quiet: { from: '25:00', to: '07:00' }, morningAt: 'soon' }), { ...mergePrefs(), quiet: null, morningAt: '07:30' });
  for (const t of TYPES) assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t.label + t.description), 'no emoji');
});

test('wall clock and quiet hours, in the person\'s zone, across midnight', () => {
  assert.deepEqual(wall(T0, TZ), { date: '2026-10-08', dow: 'thu', min: 11 * 60 });
  assert.equal(toMin('07:30'), 450); assert.equal(toMin('24:00'), null);
  const q = { quiet: { from: '22:30', to: '07:00' } };
  assert.equal(inQuiet(q, at('23:00'), TZ), true);
  assert.equal(inQuiet(q, at('06:59'), TZ), true);
  assert.equal(inQuiet(q, at('07:00'), TZ), false);
  assert.equal(inQuiet(q, at('12:00'), TZ), false);
  // The same instant is quiet in Cairo and mid-afternoon in Los Angeles.
  assert.equal(inQuiet(q, at('23:00'), 'America/Los_Angeles'), false);
  assert.equal(inQuiet({ quiet: { from: '13:00', to: '14:00' } }, at('13:30'), TZ), true);
  assert.equal(inQuiet({ quiet: null }, at('23:00'), TZ), false);
});

test('morning: once, at the person\'s time, waiting for last night; skipped when the window has passed', async () => {
  let x = arig();
  x.clock.t = at('07:10'); await x.a.tick();
  assert.equal(x.sent.length, 0, 'before 07:30');
  x.clock.t = at('07:31'); await x.a.tick(); await x.a.tick();
  assert.deepEqual(x.sent.map((s) => [s.type, s.title, s.url]), [['morning', 'Easy day', '/']]);
  assert.match(x.sent[0].body, /HRV −12% vs baseline\. Slept 7h 12m\./);
  // Last night not in Google yet: wait up to three hours, then say so.
  x = arig({ dash: { sleep: { lastNight: { date: '2026-10-07', asleepMin: 400 } } } });
  x.clock.t = at('08:00'); await x.a.tick();
  assert.equal(x.sent.length, 0);
  x.clock.t = at('10:31'); await x.a.tick();
  assert.match(x.sent[0].body, /Last night has not synced yet\./);
  // The server was down all morning: no "good morning" at five in the evening.
  x = arig();
  x.clock.t = at('17:00'); await x.a.tick();
  assert.equal(x.sent.length, 0);
  // Switched off, or a device with nothing to judge a morning by: silence.
  x = arig(); x.a.setPrefs({ types: { morning: false } }); x.clock.t = at('07:31'); await x.a.tick();
  assert.equal(x.sent.length, 0);
  x = arig({ dash: { readiness: { level: 'unavailable', label: 'No readiness', text: 'x' } } }); x.clock.t = at('07:31'); await x.a.tick();
  assert.equal(x.sent.length, 0);
});

test('step goal: once a day, on the person\'s own today', async () => {
  const x = arig({ dash: { activity: { today: { steps: 7999 }, stepTarget: 8000 } } });
  x.a.setPrefs({ types: { morning: false } });
  await x.a.tick();
  assert.equal(x.sent.length, 0);
  x.state.dash.activity.today.steps = 8123;
  await x.a.tick(); await x.a.tick();
  assert.deepEqual(x.sent.map((s) => [s.type, s.body]), [['step_goal', '8,123 steps today. Your goal is 8,000.']]);
  // A late sync showing YESTERDAY over the goal is old news.
  const y = arig({ dash: { today: '2026-10-07', activity: { today: { steps: 20_000 }, stepTarget: 8000 } } });
  y.a.setPrefs({ types: { morning: false } });
  await y.a.tick();
  assert.equal(y.sent.length, 0);
});

test('battery: once per charge; connection: once per loss', async () => {
  const x = arig({ device: { name: 'Fitbit Air', battery: 19 } });
  x.a.setPrefs({ types: { morning: false } });
  await x.a.tick(); await x.a.tick();
  assert.deepEqual(x.sent.map((s) => s.title), ['Fitbit Air battery 19%']);
  x.state.device.battery = 80; await x.a.tick();
  x.state.device.battery = 15; await x.a.tick();
  assert.equal(x.sent.length, 2);
  const y = arig({ auth: { state: 'expired', expiredAt: 111, testingExpiry: true }, dash: null });
  y.state.dash = null;
  await y.a.tick(); await y.a.tick();
  assert.deepEqual(y.sent.map((s) => [s.type, s.url]), [['connection', '/settings/connections']]);
  assert.match(y.sent[0].body, /after 7 days/);
  y.state.auth = { state: 'expired', expiredAt: 222 }; await y.a.tick();
  assert.equal(y.sent.length, 2, 'a new loss is a new notice');
  const z = arig({ sync: { lastOk: T0 - 30 * 3_600_000, lastError: { message: 'HTTP 503' } } });
  await z.a.tick(); await z.a.tick();
  assert.deepEqual(z.sent.filter((s) => s.type === 'connection').map((s) => s.title), ['Syncing has stopped']);
});

test('weekly: on the chosen day and time, once a week', async () => {
  let n = 0;
  const x = arig({ weekly: async () => { n += 1; return { headline: '7h sleep, 9,000 steps', nextSteps: ['Walk after lunch.'] }; } });
  x.a.setPrefs({ weeklyAt: { day: 'thu', time: '18:00' } });
  x.clock.t = at('17:59'); await x.a.tick();
  x.clock.t = at('18:01'); await x.a.tick(); await x.a.tick();
  x.clock.t = at('18:01', '2026-10-09'); await x.a.tick();
  assert.deepEqual([n, x.sent.filter((s) => s.type === 'weekly').length], [1, 1]);
  assert.deepEqual([x.sent.at(-1).title, x.sent.at(-1).url], ['Your week: 7h sleep, 9,000 steps', '/summary']);
});

test('through the app: per type, per device, quiet hours, and a 410 removes the device', async () => {
  const clock = { t: Date.parse('2026-10-08T09:00:00Z') };   // 12:00 in Cairo
  const r = await rig({ now: () => clock.t });
  try {
    const p = await r.person('pusher', { tz: 'Africa/Cairo' });
    const sub = (n) => ({ subscription: { endpoint: `https://push.example/dev-${n}`, keys: { p256dh: 'BPubKey', auth: 'authsecret' } }, label: `Device ${n}` });
    assert.equal((await p.c.post('/api/push/subscribe', { subscription: { endpoint: 'http://not-https', keys: {} } })).status, 400);
    const one = (await p.c.post('/api/push/subscribe', sub(1))).json;
    const two = (await p.c.post('/api/push/subscribe', sub(2))).json;
    assert.equal((await p.c.post('/api/push/subscribe', sub(2))).json.devices.length, 2, 'the same browser again is the same device');
    assert.match(one.publicKey, /^B[A-Za-z0-9_-]{80,}$/);
    assert.equal((await r.client().get('/api/me')).json.push.publicKey, one.publicKey, 'the VAPID key is stable and public');
    assert.ok(!JSON.stringify((await p.c.get('/api/push')).json).includes(r.app.app.meta('vapid').privateKey));
    assert.ok(!JSON.stringify(two.devices).includes('authsecret') && !JSON.stringify(two.devices).includes('push.example'), 'no subscription secrets or endpoints in the list');
    const say = (type) => r.app.notifier.notify(p.id, { type, title: 'T', body: 'B', url: '/x' }, { prefs: r.app.worlds.get(p.id).alerts.prefs(), tz: 'Africa/Cairo' });

    await say('record');
    assert.deepEqual(r.pushed.map((x) => x.endpoint).sort(), ['https://push.example/dev-1', 'https://push.example/dev-2']);
    assert.deepEqual(Object.keys(r.pushed[0].payload).sort(), ['at', 'body', 'tag', 'title', 'type', 'url']);
    // Off by default.
    r.pushed.length = 0; assert.equal((await say('leaderboard')).skipped, 'off'); assert.equal(r.pushed.length, 0);
    // Per type.
    await p.c.put('/api/push/prefs', { types: { record: false } });
    await say('record'); assert.equal(r.pushed.length, 0);
    await p.c.put('/api/push/prefs', { types: { record: true } });
    // Per device: one device opts out of one type; another is switched off altogether.
    await p.c.patch(`/api/push/devices/${one.deviceId}`, { types: { record: false } });
    await say('record'); assert.deepEqual(r.pushed.map((x) => x.endpoint), ['https://push.example/dev-2']);
    r.pushed.length = 0; await say('battery'); assert.equal(r.pushed.length, 2);
    await p.c.patch(`/api/push/devices/${two.deviceId}`, { enabled: false });
    r.pushed.length = 0; await say('battery'); assert.deepEqual(r.pushed.map((x) => x.endpoint), ['https://push.example/dev-1']);
    await p.c.patch(`/api/push/devices/${two.deviceId}`, { enabled: true });
    await p.c.patch(`/api/push/devices/${one.deviceId}`, { types: null });
    // Quiet hours: nothing is pushed; the test button still works.
    await p.c.put('/api/push/prefs', { quiet: { from: '22:00', to: '07:00' } });
    clock.t = Date.parse('2026-10-08T21:30:00Z');   // 00:30 in Cairo
    r.pushed.length = 0; assert.equal((await say('battery')).skipped, 'quiet hours'); assert.equal(r.pushed.length, 0);
    assert.deepEqual((await p.c.post('/api/push/test', {})).json, { sent: 2, failed: 0, removed: 0, errors: [] });
    assert.equal(r.pushed[0].payload.title, 'Notifications are working');
    clock.t = Date.parse('2026-10-08T09:00:00Z');
    assert.equal((await p.c.put('/api/push/prefs', { quiet: { from: '9pm', to: '07:00' } })).status, 400);
    // The push service says the subscription is gone: the device is removed.
    r.push.fail = 410;
    assert.deepEqual((await p.c.post('/api/push/test', { deviceId: one.deviceId })).json, { sent: 0, failed: 0, removed: 1, errors: [] });
    assert.deepEqual((await p.c.get('/api/push')).json.devices.map((d) => d.id), [two.deviceId]);
    // A passing failure keeps the device and records why.
    r.push.fail = 503;
    const f = (await p.c.post('/api/push/test', {})).json;
    assert.deepEqual([f.failed, f.removed, f.errors[0].error], [1, 0, 'push service answered 503']);
    assert.equal((await p.c.get('/api/push')).json.devices[0].lastError, 'push service answered 503');
    r.push.fail = null;
    await p.c.del(`/api/push/devices/${two.deviceId}`);
    assert.equal((await p.c.post('/api/push/test', {})).status, 409);
  } finally { await r.close(); }
});
