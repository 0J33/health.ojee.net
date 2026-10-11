import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { Alerts, TYPES, mergePrefs, inQuiet, wall, toMin, availability, stepsInHour, sittingActive, SITTING_DEFAULTS } from '../server/core/alerts.js';
import { rig } from './helpers.mjs';

const TZ = 'Africa/Cairo';
const T0 = Date.parse('2026-10-08T08:00:00Z');   // Thursday 11:00 in Cairo

function arig({ dash = {}, auth = { state: 'ok' }, device = null, sync = {}, weekly = null, tz = TZ, t = T0, windows = null, lastSync = undefined, extra = {} } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const clock = { t };
  const feed = { windows, lastSync, reads: 0 };
  const state = {
    ...extra,
    auth, device, sync: { lastOk: T0, lastError: null, ...sync },
    dash: { today: '2026-10-08', readiness: { level: 'easy', label: 'Easy day', text: 'HRV −12% vs baseline' }, sleep: { lastNight: { date: '2026-10-08', asleepMin: 432 } }, activity: { today: { steps: 3000 }, stepTarget: 8000 }, ...dash },
  };
  const a = new Alerts({
    db, now: () => clock.t, tz: () => tz, snapshot: () => state, emit: (type, title, body, more) => sent.push({ type, title, body, ...more }), weekly,
    // The step windows follow the clock unless a test pins them.
    intraday: async () => { feed.reads += 1; const ls = feed.lastSync === undefined ? clock.t - 5 * 60_000 : feed.lastSync; return { windows: typeof feed.windows === 'function' ? feed.windows(clock.t) : (feed.windows || []), device: ls === null ? null : { lastSync: ls } }; },
  });
  /** What the scheduler does for somebody whose nudge may speak: read, then judge. */
  const poll = async () => { await a.readSteps(); await a.tick(); };
  return { a, db, sent, clock, state, feed, poll };
}
const at = (hhmm, date = '2026-10-08') => Date.parse(`${date}T${hhmm}:00+03:00`);

test('the eleven types, with their defaults', () => {
  assert.deepEqual(TYPES.map((t) => t.id), ['workout_start', 'workout_end', 'morning', 'illness', 'weekly', 'step_goal', 'sitting', 'leaderboard', 'record', 'battery', 'connection']);
  // The sitting nudge is opt-in; the illness early warning is on.
  assert.deepEqual(Object.entries(mergePrefs().types).filter(([, v]) => !v).map(([k]) => k), ['sitting', 'leaderboard']);
  assert.deepEqual(mergePrefs().sitting, { from: '09:00', to: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], threshold: 250 });
  // Nonsense that reached the store falls back to the defaults, piece by piece.
  assert.deepEqual(mergePrefs({ sitting: { from: '18:00', to: '09:00', days: ['someday'], threshold: 5 } }).sitting, SITTING_DEFAULTS);
  assert.deepEqual(mergePrefs({ sitting: { from: '8:30', to: '12:00', days: ['sat', 'mon', 'mon'], threshold: 400 } }).sitting, { from: '08:30', to: '12:00', days: ['mon', 'sat'], threshold: 400 });
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

/* ── illness early warning ────────────────────────────────────────── */

const ill = (o = {}) => ({ verdictDay: '2026-10-08', stale: 0, illness: { flag: true, reasons: ['resting HR up +6 bpm or more for 2 days', 'sleep temperature +0.9 °C above baseline'], text: 'Possible illness coming on: …' }, ...o });
const quietTypes = { morning: false, step_goal: false };

test('illness: once per day the flag is raised; off means off; the words are not a diagnosis', async () => {
  const x = arig({ dash: ill() });
  x.a.setPrefs({ types: quietTypes });
  await x.a.tick(); await x.a.tick();
  assert.deepEqual(x.sent.map((s) => [s.type, s.title, s.url, s.tag]), [['illness', 'Your body looks under strain', '/', 'illness:2026-10-08']]);
  assert.equal(x.sent[0].body, 'Resting HR up +6 bpm or more for 2 days; sleep temperature +0.9 °C above baseline. It may be worth taking it easy today.');
  assert.ok(!/illness|ill\b|sick|infection|fever|diagnos|virus|symptom/i.test(x.sent[0].title + x.sent[0].body), 'says what changed, names no condition');
  // Still raised the next day: said again, once.
  x.state.dash.verdictDay = '2026-10-09'; x.clock.t += 86_400_000;
  await x.a.tick(); await x.a.tick();
  assert.equal(x.sent.length, 2);
  // Not raised: nothing. Raised but switched off: nothing.
  const calm = arig({ dash: ill({ illness: { flag: false, reasons: [], text: null } }) });
  calm.a.setPrefs({ types: quietTypes }); await calm.a.tick();
  assert.equal(calm.sent.length, 0);
  const off = arig({ dash: ill() });
  off.a.setPrefs({ types: { ...quietTypes, illness: false } }); await off.a.tick();
  assert.equal(off.sent.length, 0);
  // A restart repeats nothing: what was said is in the person's own store.
  const again = new Alerts({ db: x.db, now: () => x.clock.t, tz: () => TZ, snapshot: () => x.state, emit: (type) => x.sent.push({ type }) });
  await again.tick();
  assert.equal(x.sent.length, 2);
});

test('illness: silent when the device reports none of its signals, and on numbers from days ago', async () => {
  const none = arig({ dash: ill(), extra: { avail: availability({ steps: true }) } });
  none.a.setPrefs({ types: quietTypes }); await none.a.tick();
  assert.equal(none.sent.length, 0);
  const some = arig({ dash: ill(), extra: { avail: availability({ steps: true, restingHr: true }) } });
  some.a.setPrefs({ types: quietTypes }); await some.a.tick();
  assert.equal(some.sent.length, 1);
  const old = arig({ dash: ill({ verdictDay: '2026-10-04', stale: 4 }) });
  old.a.setPrefs({ types: quietTypes }); await old.a.tick();
  assert.equal(old.sent.length, 0);
});

test('availability: by what the device reports, with a reason to show', () => {
  const all = availability({ steps: true, restingHr: true });
  assert.deepEqual([all.illness, all.sitting, all.morning], [{ available: true, reason: null }, { available: true, reason: null }, { available: true, reason: null }]);
  for (const cap of ['restingHr', 'hrv', 'skinTemp']) assert.equal(availability({ [cap]: true }).illness.available, true, cap);
  const phone = availability({ steps: true, distance: true });
  assert.deepEqual(phone.illness, { available: false, reason: 'Needs resting heart rate, HRV or sleep temperature, which your device does not report' });
  assert.equal(phone.sitting.available, true);
  assert.match(availability({ restingHr: true }).sitting.reason, /none are arriving/);
  // Daily totals only: known once Google has been asked.
  assert.equal(availability({ steps: true }, { intraday: null }).sitting.available, true);
  assert.deepEqual(availability({ steps: true }, { intraday: false }).sitting, { available: false, reason: 'Needs steps through the day, and your device only reports a daily total' });
  const out = availability({ steps: true, restingHr: true }, { connected: false });
  assert.deepEqual([out.illness.available, out.sitting.available], [false, false]);
  assert.match(out.sitting.reason, /^Connect Google Health/);
});

/* ── sitting nudge ────────────────────────────────────────────────── */

const Q = 15 * 60_000;
/** Five quarter-hours ending at `end`, `steps` in each. */
const quarters = (end, steps = 20) => [0, 1, 2, 3, 4].map((i) => ({ start: end - (5 - i) * Q, end: end - (4 - i) * Q, steps }));
const sitOn = (x, more = {}) => x.a.setPrefs({ types: { ...quietTypes, sitting: true }, ...more });

test('steps in the last hour: windows partly inside count in proportion', () => {
  const end = T0;
  assert.equal(stepsInHour(quarters(end, 20), end), 80);
  assert.equal(stepsInHour(quarters(end, 20), end - 5 * 60_000), 80);
  assert.equal(stepsInHour([{ start: end - 90 * 60_000, end: end - 30 * 60_000, steps: 600 }], end), 300);
  assert.equal(stepsInHour([], end), 0);
  assert.equal(stepsInHour([{ start: end, end, steps: 50 }], end), 0);
});

test('sitting: opt-in; nudges under the threshold in the chosen hours, at most hourly; says why it is silent', async () => {
  const feed = (t) => quarters(t - 5 * 60_000, 20);
  // Off unless the person switched it on, however little they moved.
  const def = arig({ windows: feed });
  def.a.setPrefs({ types: quietTypes });
  await def.poll();
  assert.deepEqual([def.sent.length, def.a.view().state], [0, 'off']);

  const x = arig({ windows: feed });
  sitOn(x);
  await x.poll(); await x.a.tick();
  assert.deepEqual(x.sent.map((s) => [s.type, s.title, s.url, s.tag]), [['sitting', 'Time to stand up', '/', 'sitting']]);
  assert.equal(x.sent[0].body, '80 steps in the hour to 10:55. A few minutes on your feet would break it up.');
  assert.deepEqual([x.a.view().state, x.a.view().steps, x.a.view().asOf], ['low', 80, T0 - 5 * 60_000]);
  // Not again within the hour, with fresh readings all the way.
  for (const m of [15, 30, 45, 59]) { x.clock.t = T0 + m * 60_000; await x.poll(); }
  assert.equal(x.sent.length, 1);
  x.clock.t = T0 + 61 * 60_000; await x.poll();
  assert.equal(x.sent.length, 2, 'an hour on, still sitting: once more');
  // A restart does not forget when it last spoke.
  const again = new Alerts({ db: x.db, now: () => x.clock.t, tz: () => TZ, snapshot: () => x.state, emit: (type) => x.sent.push({ type }), intraday: async () => ({ windows: feed(x.clock.t), device: { lastSync: x.clock.t - 60_000 } }) });
  await again.readSteps(); await again.tick();
  assert.equal(x.sent.length, 2);

  // Moving enough: nothing to say.
  const active = arig({ windows: (t) => quarters(t - 5 * 60_000, 200) });
  sitOn(active); await active.poll();
  assert.deepEqual([active.sent.length, active.a.view().state, active.a.view().steps], [0, 'ok', 800]);
  // The person's own threshold.
  const strict = arig({ windows: (t) => quarters(t - 5 * 60_000, 200) });
  sitOn(strict, { sitting: { threshold: 1000 } }); await strict.poll();
  assert.equal(strict.sent.length, 1);
});

test('sitting: never from stale data, and never without a recent reading', async () => {
  // The tracker last reached the phone 50 minutes ago: it cannot know.
  const stale = arig({ windows: quarters(T0 - 50 * 60_000, 20), lastSync: T0 - 50 * 60_000 });
  sitOn(stale); await stale.poll();
  assert.deepEqual([stale.sent.length, stale.a.view().state, stale.a.view().steps], [0, 'stale', null]);
  assert.match(stale.a.view().note, /over 20 minutes old/);
  // 19 minutes is fresh enough; 21 is not.
  const edge = arig({ windows: quarters(T0 - 19 * 60_000, 20), lastSync: T0 - 19 * 60_000 });
  sitOn(edge); await edge.poll();
  assert.equal(edge.sent.length, 1);
  const over = arig({ windows: quarters(T0 - 21 * 60_000, 20), lastSync: T0 - 21 * 60_000 });
  sitOn(over); await over.poll();
  assert.equal(over.sent.length, 0);
  // No paired tracker (a phone, Health Connect): the step data is its own
  // evidence. A quarter-hour with steps that began 10 minutes ago is fresh;
  // nothing at all for the last hour is silence, not "you sat".
  const phone = arig({ lastSync: null, windows: [{ start: T0 - 40 * 60_000, end: T0 - 25 * 60_000, steps: 30 }, { start: T0 - 10 * 60_000, end: T0, steps: 12 }] });
  sitOn(phone); await phone.poll();
  assert.deepEqual([phone.sent.length, phone.a.view().steps], [1, 42]);
  const dark = arig({ lastSync: null, windows: [{ start: T0 - 90 * 60_000, end: T0 - 75 * 60_000, steps: 30 }] });
  sitOn(dark); await dark.poll();
  assert.deepEqual([dark.sent.length, dark.a.view().state], [0, 'stale']);
  const empty = arig({ lastSync: null, windows: [] });
  sitOn(empty); await empty.poll();
  assert.deepEqual([empty.sent.length, empty.a.view().state, empty.a.view().note], [0, 'stale', 'no recent step data']);
  // Switched on but never read (or the last reading is old): it waits. The
  // minute pass alone never nudges from an old reading.
  const unread = arig({ windows: (t) => quarters(t - 5 * 60_000, 20) });
  sitOn(unread); await unread.a.tick();
  assert.deepEqual([unread.sent.length, unread.a.view().state, unread.feed.reads], [0, 'waiting', 0]);
  await unread.a.readSteps(); unread.clock.t = T0 + 21 * 60_000; await unread.a.tick();
  assert.deepEqual([unread.sent.length, unread.a.view().state], [0, 'waiting']);
});

test('sitting: the person\'s own days, hours and time zone; not in the first hour', async () => {
  const feed = (t) => quarters(t - 5 * 60_000, 20);
  // Saturday is not one of the default days.
  const weekend = arig({ windows: feed, t: Date.parse('2026-10-10T08:00:00Z') });
  sitOn(weekend); await weekend.poll();
  assert.deepEqual([weekend.sent.length, weekend.a.view().state, weekend.a.view().note], [0, 'outside', 'outside your hours']);
  sitOn(weekend, { sitting: { days: ['sat', 'sun'] } }); await weekend.poll();
  assert.equal(weekend.sent.length, 1);
  // Before and after the window, and the first hour of it.
  for (const [hhmm, state, n] of [['08:59', 'outside', 0], ['09:30', 'warming', 0], ['09:59', 'warming', 0], ['10:00', 'low', 1], ['17:59', 'low', 1], ['18:00', 'outside', 0]]) {
    const x = arig({ windows: feed, t: at(hhmm) });
    sitOn(x); await x.poll();
    assert.deepEqual([hhmm, x.a.view().state, x.sent.length], [hhmm, state, n]);
  }
  // 11:00 in Cairo is 01:00 in Los Angeles: the same instant, somebody else's night.
  const la = arig({ windows: feed, tz: 'America/Los_Angeles' });
  sitOn(la); await la.poll();
  assert.deepEqual([la.sent.length, la.a.view().state], [0, 'outside']);
  la.clock.t = Date.parse('2026-10-08T11:00:00-07:00'); await la.poll();
  assert.equal(la.sent.length, 1);
  assert.match(la.sent[0].body, /in the hour to 10:55\./, 'the clock in the body is theirs');
  // Their own hours.
  const late = arig({ windows: feed, t: at('20:30') });
  sitOn(late, { sitting: { from: '19:00', to: '23:00' } }); await late.poll();
  assert.equal(late.sent.length, 1);
  assert.deepEqual(sittingActive(late.a.prefs(), at('18:30'), TZ), { active: false, state: 'outside', note: 'outside your hours' });
  assert.equal(sittingActive(late.a.prefs(), at('19:00'), TZ).active, true);
  assert.equal(sittingActive(mergePrefs(), at('11:00'), TZ).state, 'off');
});

test('sitting: never in quiet hours, never while a workout is running, never when the device cannot carry it', async () => {
  const feed = (t) => quarters(t - 5 * 60_000, 20);
  const q = arig({ windows: feed });
  sitOn(q, { quiet: { from: '10:30', to: '11:30' } });
  await q.poll();
  assert.deepEqual([q.sent.length, q.a.view().state, q.a.view().note], [0, 'quiet', 'quiet hours']);
  // Quiet hours over: it speaks, and the silence did not use up the hour.
  q.clock.t = at('11:31'); await q.poll();
  assert.equal(q.sent.length, 1);
  // Quiet hours across midnight, inside a late window.
  const night = arig({ windows: feed, t: at('22:45') });
  sitOn(night, { sitting: { from: '20:00', to: '23:30' }, quiet: { from: '22:30', to: '07:00' } }); await night.poll();
  assert.equal(night.sent.length, 0);

  const gym = arig({ windows: feed, extra: { workout: true } });
  sitOn(gym); await gym.poll();
  assert.deepEqual([gym.sent.length, gym.a.view().state], [0, 'workout']);
  gym.state.workout = false; await gym.a.tick();
  assert.equal(gym.sent.length, 1, 'the workout is over');

  const cannot = arig({ windows: feed, extra: { avail: availability({ steps: true }, { intraday: false }) } });
  sitOn(cannot); await cannot.poll();
  assert.deepEqual([cannot.sent.length, cannot.a.view().state], [0, 'unavailable']);
  assert.match(cannot.a.view().note, /only reports a daily total/);
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

/* ── the two device-dependent types, through the app ──────────────── */

const stepsRollUp = (url, init) => /\/steps\/dataPoints:rollUp$/.test(url.pathname) && JSON.parse(init?.body || '{}').windowSize === '900s';
const sub = (name) => ({ subscription: { endpoint: `https://push.example/${name}`, keys: { p256dh: 'BPubKey', auth: 'authsecret' } }, label: name });
const typeOf = (payload, id) => payload.types.find((t) => t.id === id);

test('through the app: what the settings payload says, by device; the nudge is opt-in and validated', async () => {
  const clock = { t: Date.parse('2026-10-08T09:00:00Z') };   // Thursday 12:00 in Cairo
  const r = await rig({ now: () => clock.t });
  try {
    // Not connected: neither can be used, and the nudge cannot be switched on.
    const fresh = await r.person('nogoogle');
    let d = (await fresh.c.get('/api/push')).json;
    assert.deepEqual([typeOf(d, 'illness').available, typeOf(d, 'sitting').available, typeOf(d, 'morning').available], [false, false, true]);
    assert.match(typeOf(d, 'sitting').reason, /^Connect Google Health/);
    const no = await fresh.c.put('/api/push/prefs', { types: { sitting: true } });
    assert.deepEqual([no.status, no.json.code], [409, 'conflict']);
    assert.equal((await fresh.c.get('/api/push')).json.prefs.types.sitting, false);

    // A phone: steps but no resting HR, HRV or sleep temperature.
    const phone = await r.person('phoneonly', { persona: 'phone' });
    d = (await phone.c.get('/api/push')).json;
    assert.deepEqual(typeOf(d, 'illness'), { id: 'illness', label: 'Illness early warning', description: typeOf(d, 'illness').description, default: true, available: false, reason: 'Needs resting heart rate, HRV or sleep temperature, which your device does not report' });
    assert.deepEqual([typeOf(d, 'sitting').available, typeOf(d, 'sitting').default, d.prefs.types.sitting, d.prefs.types.illness], [true, false, false, true]);
    assert.deepEqual(d.prefs.sitting, { from: '09:00', to: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], threshold: 250 });
    assert.deepEqual(d.limits.sitting.threshold, { min: 50, max: 2000, step: 50 });
    assert.equal(d.status.sitting.state, 'off');

    // A Fitbit: both. Opting in, and the parameters.
    const fit = await r.person('fitbitone', { persona: 'fitbit' });
    d = (await fit.c.get('/api/push')).json;
    assert.deepEqual([typeOf(d, 'illness').available, typeOf(d, 'sitting').available], [true, true]);
    assert.equal(r.app.app.profile(fit.id).nudge, null);
    d = (await fit.c.put('/api/push/prefs', { types: { sitting: true }, sitting: { from: '08:30', to: '17:00', days: ['sun', 'mon', 'wed'], threshold: 300 } })).json;
    assert.deepEqual([d.prefs.types.sitting, d.prefs.sitting], [true, { from: '08:30', to: '17:00', days: ['sun', 'mon', 'wed'], threshold: 300 }]);
    assert.deepEqual(r.app.app.profile(fit.id).nudge, { sitting: d.prefs.sitting, quiet: null });
    // One parameter at a time keeps the others.
    d = (await fit.c.put('/api/push/prefs', { sitting: { threshold: 500 } })).json;
    assert.deepEqual(d.prefs.sitting, { from: '08:30', to: '17:00', days: ['sun', 'mon', 'wed'], threshold: 500 });
    for (const bad of [
      { from: '9am' }, { to: '25:00' }, { to: '08:30' }, { from: '17:00' }, { from: '18:00', to: '09:00' },
      { days: [] }, { days: ['monday'] }, { days: 'mon' },
      { threshold: 49 }, { threshold: 2001 }, { threshold: 250.5 }, { threshold: '250' },
    ]) {
      const x = await fit.c.put('/api/push/prefs', { sitting: bad });
      assert.deepEqual([JSON.stringify(bad), x.status], [JSON.stringify(bad), 400]);
    }
    assert.equal((await fit.c.put('/api/push/prefs', { sitting: 'on' })).status, 400);
    assert.equal((await fit.c.put('/api/push/prefs', { types: ['sitting'] })).status, 400);
    assert.deepEqual((await fit.c.get('/api/push')).json.prefs.sitting, { from: '08:30', to: '17:00', days: ['sun', 'mon', 'wed'], threshold: 500 }, 'a refused change changes nothing');
    // Quiet hours travel with it; off clears it.
    await fit.c.put('/api/push/prefs', { quiet: { from: '22:00', to: '07:00' } });
    assert.deepEqual(r.app.app.profile(fit.id).nudge.quiet, { from: '22:00', to: '07:00' });
    await fit.c.put('/api/push/prefs', { types: { sitting: false } });
    assert.equal(r.app.app.profile(fit.id).nudge, null);
    // A device can opt out of either type by itself.
    const dev = (await fit.c.post('/api/push/subscribe', sub('fit-1'))).json.deviceId;
    d = (await fit.c.patch(`/api/push/devices/${dev}`, { types: { illness: false, sitting: false } })).json;
    assert.deepEqual(d.devices[0].types, { illness: false, sitting: false });
    const say = (type) => r.app.notifier.notify(fit.id, { type, title: 'T', body: 'B' }, { prefs: r.app.worlds.get(fit.id).alerts.prefs(), tz: 'Africa/Cairo' });
    assert.equal((await say('illness')).skipped, 'no device');
    await fit.c.patch(`/api/push/devices/${dev}`, { types: null });
    assert.equal((await say('illness')).sent, 1);
    assert.equal(r.pushed.at(-1).payload.url, '/');
    assert.equal((await say('sitting')).skipped, 'off');

    // Daily totals only: Google has steps, but none through the day.
    const daily = await r.person('dailyonly', { persona: 'fitbit' });
    r.wrap.fn = async (userId, url, init) => (userId === daily.id && stepsRollUp(url, init) ? new Response(JSON.stringify({ rollupDataPoints: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) : null);
    const refused = await daily.c.put('/api/push/prefs', { types: { sitting: true } });
    assert.deepEqual([refused.status, refused.json.error], [409, 'Needs steps through the day, and your device only reports a daily total']);
    d = (await daily.c.get('/api/push')).json;
    assert.deepEqual([d.prefs.types.sitting, typeOf(d, 'sitting').available, typeOf(d, 'sitting').reason], [false, false, 'Needs steps through the day, and your device only reports a daily total']);
    assert.equal(r.app.app.profile(daily.id).nudge, null);
    // Google cannot be asked right now: the benefit of the doubt.
    const doubt = await r.person('doubt', { persona: 'fitbit' });
    r.wrap.fn = async (userId, url, init) => (userId === doubt.id && stepsRollUp(url, init) ? new Response('{}', { status: 503 }) : null);
    assert.equal((await doubt.c.put('/api/push/prefs', { types: { sitting: true } })).json.prefs.types.sitting, true);
  } finally { await r.close(); }
});

test('through the app: extra step reads only for opted-in people inside their window; a nudge reaches that person alone', async () => {
  const clock = { t: Date.parse('2026-10-08T09:00:00Z') };   // Thursday 12:00 in Cairo
  const r = await rig({ now: () => clock.t });
  try {
    const sitter = await r.person('sitter', { persona: 'fitbit' });
    const walker = await r.person('walker', { persona: 'fitbit' });
    const abroad = await r.person('abroad', { persona: 'fitbit', tz: 'America/Los_Angeles' });   // 02:00 there
    for (const p of [sitter, walker, abroad]) await p.c.post('/api/push/subscribe', sub(`${p.username}-1`));
    await sitter.c.put('/api/push/prefs', { types: { sitting: true, morning: false, step_goal: false, record: false, illness: false, battery: false } });
    await abroad.c.put('/api/push/prefs', { types: { sitting: true, morning: false, step_goal: false, record: false, illness: false, battery: false } });
    await walker.c.put('/api/push/prefs', { types: { morning: false, step_goal: false, record: false, illness: false, battery: false } });
    const reads = { [sitter.id]: 0, [walker.id]: 0, [abroad.id]: 0 };
    const mode = { status: 200, steps: 10 };
    r.wrap.fn = async (userId, url, init) => {
      if (!stepsRollUp(url, init)) return null;
      reads[userId] += 1;
      if (mode.status !== 200) return new Response('{}', { status: mode.status, headers: { 'retry-after': '1800' } });
      const body = JSON.parse(init.body);
      const a = Date.parse(body.range.startTime); const b = Date.parse(body.range.endTime);
      const pts = [];
      for (let t = a; t < b; t += 900_000) pts.push({ startTime: new Date(t).toISOString(), endTime: new Date(Math.min(b, t + 900_000)).toISOString(), steps: { countSum: String(mode.steps) } });
      return new Response(JSON.stringify({ rollupDataPoints: pts }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const s = r.app.scheduler;
    // The scheduler spreads first reads at random over five minutes; here they are due at once.
    s.random = () => 0;
    // Until nothing is in flight: a sync now reads many more streams, and a
    // step read queued behind one must not be judged before it has run.
    const pause = (ms) => new Promise((res) => { setTimeout(res, ms); });
    const settle = async () => { await pause(40); for (let i = 0; i < 200 && s.inFlight.size; i += 1) await pause(25); await pause(20); };
    /** Let the scheduler look a few times, a quarter-minute apart. */
    const run = async (n = 3) => { for (let i = 0; i < n; i += 1) { clock.t += 15_000; await s.tick(); await settle(); } };
    r.pushed.length = 0;
    await s.tick(); clock.t += 6 * 60_000; await run();
    assert.deepEqual([reads[sitter.id], reads[walker.id], reads[abroad.id]], [1, 0, 0], 'one read, for the one person it is for');
    const nudges = () => r.pushed.filter((x) => x.payload.type === 'sitting');
    assert.deepEqual(nudges().map((x) => [x.endpoint, x.payload.title, x.payload.url]), [['https://push.example/sitter-1', 'Time to stand up', '/']]);
    assert.match(nudges()[0].payload.body, /^40 steps in the hour to 12:\d\d\. /);
    assert.equal((await sitter.c.get('/api/push')).json.status.sitting.state, 'low');
    assert.equal((await walker.c.get('/api/push')).json.status.sitting.state, 'off', 'nobody else sees it, or anything about it');
    assert.ok(!JSON.stringify((await walker.c.get('/api/data')).json).includes('Time to stand up'));
    // A quarter of an hour on: read again, but said only once an hour.
    clock.t += 16 * 60_000; await run();
    assert.deepEqual([reads[sitter.id], reads[walker.id], reads[abroad.id], nudges().length], [2, 0, 0, 1]);
    // A workout is running: the reads go on, the nudge does not.
    clock.t += 50 * 60_000;
    const w = (await sitter.c.post('/api/workouts/start', {})).json;
    await run();
    assert.equal(nudges().length, 1);
    assert.equal((await sitter.c.get('/api/push')).json.status.sitting.state, 'workout');
    void w;
    // Google says 429 to the step read: that person waits, and only them.
    mode.status = 429; const before = reads[sitter.id];
    clock.t += 16 * 60_000; await run();
    assert.equal(reads[sitter.id], before + 1);
    assert.ok(s.backoffUntil(sitter.id) >= clock.t + 25 * 60_000);
    assert.equal(s.backoffUntil(walker.id), null);
    clock.t += 20 * 60_000; await run();
    assert.equal(reads[sitter.id], before + 1, 'not asked again while waiting');
    mode.status = 200;
    // Quiet hours: no reads at all.
    await sitter.c.put('/api/push/prefs', { quiet: { from: '13:00', to: '23:00' } });
    clock.t += 60 * 60_000; const q = reads[sitter.id]; await run();
    assert.equal(reads[sitter.id], q);
    await sitter.c.put('/api/push/prefs', { quiet: null });
    // After six in the evening: outside the window, no reads.
    clock.t = Date.parse('2026-10-08T16:00:00Z'); const eve = reads[sitter.id];   // 19:00 in Cairo, 09:00 in Los Angeles
    await s.tick(); clock.t += 6 * 60_000; await run();
    assert.equal(reads[sitter.id], eve);
    // And now it is the other person's morning: their turn, nobody else's.
    assert.equal(reads[abroad.id], 1);
    assert.equal(reads[walker.id], 0);
    // Nowhere to send it (no device, no open tab): nothing is read.
    const dev = (await abroad.c.get('/api/push')).json.devices[0].id;
    await abroad.c.del(`/api/push/devices/${dev}`);
    clock.t += 16 * 60_000; await run();
    assert.equal(reads[abroad.id], 1);
  } finally { await r.close(); }
});

test('through the app: the illness early warning, once, to the person it is about', async () => {
  const clock = { t: Date.parse('2026-10-08T09:00:00Z') };
  const r = await rig({ now: () => clock.t });
  try {
    const a = await r.person('strained', { persona: 'fitbit' });
    const b = await r.person('steady', { persona: 'fitbit' });
    for (const p of [a, b]) await p.c.post('/api/push/subscribe', sub(`${p.username}-1`));
    // Two days of resting heart rate well over A's own baseline.
    const wa = r.app.worlds.get(a.id);
    const day = (await a.c.get('/api/data')).json.verdictDay;
    const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const base = (await a.c.get('/api/data')).json.series.find((x) => x.date === day).rhrBase;
    wa.db.setDaily(day, 'rhr', base + 9); wa.db.setDaily(prev, 'rhr', base + 8);
    const flagged = (await a.c.get('/api/data')).json.illness;
    assert.equal(flagged.flag, true);
    r.pushed.length = 0;
    await wa.alerts.tick(); await wa.alerts.tick(); await r.app.worlds.get(b.id).alerts.tick();
    await new Promise((res) => { setTimeout(res, 40); });
    const got = r.pushed.filter((x) => x.payload.type === 'illness');
    assert.deepEqual(got.map((x) => [x.endpoint, x.payload.title, x.payload.url, x.payload.tag]), [['https://push.example/strained-1', 'Your body looks under strain', '/', `illness:${day}`]]);
    assert.match(got[0].payload.body, /^Resting HR up \+\d+ bpm or more for 2 days\. It may be worth taking it easy today\.$/);
    assert.equal((await b.c.get('/api/data')).json.illness.flag, false);
  } finally { await r.close(); }
});
