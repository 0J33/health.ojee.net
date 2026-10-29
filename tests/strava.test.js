/* Strava, through the routes, against the stand-in Strava
   (server/fake-sources.js): the OAuth round trip bound to the session,
   activities in (merged with what is here), the webhook, workouts out. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { decodePolyline, routeShape, googleTypeOf, stravaSportOf, fromActivity } from '../server/strava.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

/** Sign in to Strava as the person, the way a browser would. */
async function connect(p) {
  const start = await p.c.get('/auth/strava/start?return=/settings/connections');
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://strava.test/oauth/authorize');
  assert.deepEqual([to.searchParams.get('client_id'), to.searchParams.get('scope'), to.searchParams.get('response_type')], ['1234', 'read,activity:read_all,activity:write', 'code']);
  const back = await p.c.get(`/auth/strava/callback?state=${to.searchParams.get('state')}&code=${r.strava.approve()}&scope=read,activity:read_all,activity:write`);
  assert.equal(back.status, 302);
  return new URL(back.headers.get('location'), 'https://x');
}
const syncNow = (p) => r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true, only: 'strava' }));

test('connecting: the sign-in belongs to the session that started it; a refused read scope is said', async () => {
  const p = await personWith(r, 'runner1');
  const other = await r.person('stranger');
  const start = new URL((await p.c.get('/auth/strava/start')).headers.get('location'));
  // Carried to another browser: nothing is connected.
  const stolen = await other.c.get(`/auth/strava/callback?state=${start.searchParams.get('state')}&code=${r.strava.approve()}&scope=read,activity:read_all`);
  assert.match(stolen.headers.get('location'), /strava=error/);
  assert.equal(r.app.app.secretRow(other.id, 'strava'), null);
  // Without the activities box ticked.
  const s2 = new URL((await p.c.get('/auth/strava/start')).headers.get('location'));
  const noRead = await p.c.get(`/auth/strava/callback?state=${s2.searchParams.get('state')}&code=${r.strava.approve()}&scope=read`);
  assert.match(new URL(noRead.headers.get('location'), 'https://x').searchParams.get('message'), /permission to read activities/);
  // The real thing.
  const back = await connect(p);
  assert.equal(back.searchParams.get('strava'), 'connected');
  const v = await ok(await p.c.get('/api/strava'));
  assert.deepEqual([v.configured, v.connected, v.athlete.name], [true, true, 'Tess Runner']);
  assert.ok(!JSON.stringify(v).includes('rt-'), 'no token in a reply');
  const me = await ok(await p.c.get('/api/me'));
  assert.deepEqual(me.strava, { configured: true, connected: true });
});

test('activities in: a new one is a workout of its own type; one that overlaps a session here attaches to it; calories from the details', async () => {
  const p = await personWith(r, 'runner2');
  const t0 = Date.now() - 5 * HOUR;
  r.strava.state.activities.clear();
  r.strava.addActivity({ name: 'Lunch Ride', sport: 'Ride', start: t0, minutes: 50, distance: 21000, calories: 520 });
  // A session already here at the time of the second.
  await ok(await p.c.post('/api/workouts/log', { start: t0 + 2 * HOUR, end: t0 + 2 * HOUR + 40 * MIN, title: 'Evening' }));
  r.strava.addActivity({ name: 'Evening Run', sport: 'Run', start: t0 + 2 * HOUR + 2 * MIN, minutes: 36 });
  await connect(p);
  await syncNow(p);
  const list = (await ok(await p.c.get('/api/workouts?limit=40'))).history;
  const ride = list.find((w) => w.title === 'Lunch Ride');
  assert.ok(ride, 'the ride is a workout');
  assert.equal(ride.source, 'strava');
  assert.equal(list.filter((w) => /Evening/.test(w.title || '')).length, 1, 'the run attached to the session here');
  const d = await ok(await p.c.get(`/api/workouts/${ride.id}`));
  const wk = d.workout || d;
  assert.equal(wk.type, 'BIKING');
  assert.equal(wk.strava.distanceM, 21000);
  assert.equal(wk.strava.kcal, 520, 'calories come from the activity\'s details');
  assert.ok(wk.route && wk.route.points.length >= 2, 'the route as a shape to draw');
  // A second pass reads nothing new.
  const again = await syncNow(p);
  assert.deepEqual([again.strava.added, again.strava.merged], [0, 0]);
});

test('the webhook: Strava checks the address with the verify token; events bring an activity in, take a deleted one out, and a revoked grant disconnects', async () => {
  const p = await personWith(r, 'runner3');
  r.strava.state.activities.clear();
  await connect(p);
  await syncNow(p);
  const c = r.client();
  const check = await c.get('/api/strava/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123');
  assert.deepEqual([check.status, check.json], [200, { 'hub.challenge': 'abc123' }]);
  assert.equal((await c.get('/api/strava/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x')).status, 404);
  const a = r.strava.addActivity({ name: 'Hook Run', sport: 'Run', start: Date.now() - 2 * HOUR, minutes: 30 });
  const post = (body) => c.call('POST', '/api/strava/webhook', { body, origin: null });
  assert.equal((await post({ object_type: 'activity', object_id: a.id, aspect_type: 'create', owner_id: 4242, subscription_id: 1, event_time: 1 })).status, 200, 'no cookie and no Origin needed');
  const has = async (title) => (await ok(await p.c.get('/api/workouts?limit=40'))).history.some((w) => w.title === title);
  for (let i = 0; i < 50 && !(await has('Hook Run')); i += 1) await new Promise((res) => { setTimeout(res, 20); });
  assert.ok(await has('Hook Run'), 'created by the event');
  await post({ object_type: 'activity', object_id: a.id, aspect_type: 'delete', owner_id: 4242 });
  for (let i = 0; i < 50 && (await has('Hook Run')); i += 1) await new Promise((res) => { setTimeout(res, 20); });
  assert.equal(await has('Hook Run'), false, 'deleted by the event');
  // An event for an athlete nobody here is: ignored.
  assert.equal((await post({ object_type: 'activity', object_id: 1, aspect_type: 'create', owner_id: 999 })).status, 200);
  await post({ object_type: 'athlete', object_id: 4242, aspect_type: 'update', owner_id: 4242, updates: { authorized: 'false' } });
  for (let i = 0; i < 50 && r.app.app.secretRow(p.id, 'strava'); i += 1) await new Promise((res) => { setTimeout(res, 20); });
  assert.equal(r.app.app.secretRow(p.id, 'strava'), null, 'access revoked on Strava: disconnected here');
});

test('out to Strava: off by default; switched on, a workout finished here is created there once, never one that came from Strava', async () => {
  const p = await personWith(r, 'runner4');
  r.strava.state.activities.clear();
  await connect(p);
  await syncNow(p);
  const start = Date.now() - 3 * HOUR;
  await ok(await p.c.post('/api/workouts/log', { start, end: start + 45 * MIN, title: 'Gym session', exercises: [{ name: 'Squat (Barbell)', sets: [{ kg: 100, reps: 5 }] }] }));
  await syncNow(p);
  assert.equal([...r.strava.state.activities.values()].filter((a) => a.manual).length, 0, 'off by default');
  const s = await ok(await p.c.patch('/api/strava/settings', { toStrava: true }));
  assert.equal(s.settings.toStrava, true);
  await syncNow(p);
  const made = [...r.strava.state.activities.values()].filter((a) => a.manual);
  assert.equal(made.length, 1);
  assert.equal(made[0].name, 'Gym session');
  assert.equal(made[0].sport_type, 'WeightTraining');
  assert.match(made[0].description, /Squat \(Barbell\): 1 set/);
  await syncNow(p);
  await syncNow(p);
  assert.equal([...r.strava.state.activities.values()].filter((a) => a.manual).length, 1, 'once');
  const list = (await ok(await p.c.get('/api/workouts?limit=40'))).history;
  assert.equal(list.filter((w) => w.title === 'Gym session').length, 1, 'and its echo is not a second workout');
});

test('disconnecting gives the grant back to Strava and keeps the workouts', async () => {
  const p = await personWith(r, 'runner5');
  r.strava.state.activities.clear();
  r.strava.addActivity({ name: 'Keep me', sport: 'Walk', start: Date.now() - 4 * HOUR, minutes: 40 });
  await connect(p);
  await syncNow(p);
  const before = r.strava.state.deauthorized;
  const v = await ok(await p.c.post('/api/strava/disconnect', {}));
  assert.equal(v.connected, false);
  assert.equal(r.strava.state.deauthorized, before + 1);
  assert.ok((await ok(await p.c.get('/api/workouts?limit=40'))).history.some((w) => w.title === 'Keep me'));
});

test('the words: sport types both ways, the polyline, an activity summary', () => {
  assert.deepEqual(['Run', 'TrailRun', 'Ride', 'VirtualRide', 'Swim', 'WeightTraining', 'Kitesurf', 'Nonsense'].map(googleTypeOf), ['RUNNING', 'TRAIL_RUN', 'BIKING', 'STATIONARY_BIKE', 'SWIMMING', 'WEIGHTLIFTING', 'KITESURFING', 'WORKOUT']);
  assert.deepEqual(['RUNNING', 'STRENGTH_TRAINING', 'WEIGHT_MACHINES', 'YOGA', 'GOLF'].map(stravaSportOf), ['Run', 'WeightTraining', 'WeightTraining', 'Yoga', 'Workout']);
  // Google's documented example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@').map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const shape = routeShape('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.ok(shape.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  assert.equal(routeShape(null), null);
  const a = fromActivity({ id: 5, name: 'X', sport_type: 'Hike', start_date: '2026-10-01T06:00:00Z', elapsed_time: 3600, distance: 8000 });
  assert.deepEqual([a.type, a.end - a.start, a.distanceM], ['HIKING', HOUR, 8000]);
});

test('not set up on the server: Strava is not offered, and its routes say so', async () => {
  const bare = await rig({ env: { STRAVA_CLIENT_ID: '', STRAVA_CLIENT_SECRET: '' } });
  try {
    const p = await bare.person('nostrava');
    const v = await ok(await p.c.get('/api/strava'));
    assert.deepEqual([v.configured, v.connected], [false, false]);
    const go = await p.c.get('/auth/strava/start');
    assert.match(new URL(go.headers.get('location'), 'https://x').searchParams.get('message'), /not set up on this server/);
  } finally { await bare.close(); }
});
