import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

/* One person can never read another's private data through any route.
   Alice and Bob both have full data; Carol's whole account is private. */

let r; let alice; let bob; let carol; let aliceWorkout; let aliceKey; let aliceDevice;
const NOW = Date.now();
const SECRETS = ['ALICE-PRIVATE-NOTE', 'Alice secret session', 'alice@example.com', 'ALICE-SET-NOTE', 'sk-alice-opencode-key-7777'];

before(async () => {
  r = await rig();
  alice = await r.person('alice', { tz: 'Africa/Cairo' });
  r.parts.emailOf.set(alice.id, 'alice@example.com');
  await r.connect(alice.id, 'fitbit');
  bob = await r.person('bob', { tz: 'Europe/London', persona: 'pixel' });
  carol = await r.person('carol', { tz: 'Asia/Tokyo', persona: 'fitbit2', privacy: { account: 'private' } });

  await alice.c.patch('/api/profile', { notes: 'ALICE-PRIVATE-NOTE', bio: 'public bio' });
  const logged = await alice.c.post('/api/workouts/log', {
    start: NOW - 3 * 86_400_000, end: NOW - 3 * 86_400_000 + 50 * 60_000, title: 'Alice secret session',
    exercises: [{ name: 'Bench Press (Barbell)', notes: 'ALICE-SET-NOTE', sets: [{ kg: 61.5, reps: 7 }] }],
  });
  aliceWorkout = logged.json.history.find((w) => w.title === 'Alice secret session').id;
  // Workouts are public for Alice by default; make them private so the title must not leak either.
  await alice.c.patch('/api/settings', { privacy: { workouts: false } });
  await alice.c.put('/api/ai/key', { key: 'sk-alice-opencode-key-7777' });
  aliceKey = (await alice.c.post('/api/link/keys', { label: 'alice box' })).json;
  aliceDevice = (await alice.c.post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/alice-device-1', keys: { p256dh: 'BKey', auth: 'auth' } } })).json.deviceId;
  await bob.c.post('/api/workouts/log', { start: NOW - 2 * 86_400_000, end: NOW - 2 * 86_400_000 + 40 * 60_000, title: 'Bob session' });
});
after(async () => { await r.close(); });

test('every GET route, as Bob and as nobody: nothing of Alice\'s private data comes back', async () => {
  const routes = [
    '/api/me', '/api/data?days=90', '/api/trends?days=365', '/api/workouts?limit=100', `/api/workouts/${aliceWorkout}`, '/api/workouts/1', '/api/workouts/2',
    '/api/summary', '/api/push', '/api/link', '/api/export', '/api/people', '/api/users/alice', '/api/users/bob', '/api/users/carol',
    '/api/compare?with=alice&period=all', '/api/admin', '/api/health', '/auth/me',
    ...['steps', 'active_minutes', 'workouts', 'workout_time', 'distance', 'sleep_consistency'].flatMap((m) => ['today', 'week', 'month', 'all'].map((p) => `/api/leaderboard?metric=${m}&period=${p}`)),
  ];
  for (const who of [bob.c, r.client()]) {
    for (const path of routes) {
      const x = await who.get(path);
      assert.ok(x.status < 500, `${path} -> ${x.status}`);
      for (const s of SECRETS) assert.ok(!x.text.includes(s), `${path} leaked ${s}`);
    }
  }
  // And the control: Alice does see her own.
  const mine = await alice.c.get(`/api/workouts/${aliceWorkout}`);
  assert.equal(mine.json.title, 'Alice secret session');
  assert.equal(mine.json.exercises[0].notes, 'ALICE-SET-NOTE');
  assert.equal((await alice.c.get('/api/me')).json.profile.notes, 'ALICE-PRIVATE-NOTE');
});

test('a workout id is only ever looked up in the asker\'s own store', async () => {
  // The same numeric id exists in both stores: each person gets their own.
  const a = (await alice.c.get('/api/workouts/1')).json;
  const b = (await bob.c.get('/api/workouts/1')).json;
  assert.equal(a.title, 'Alice secret session');
  assert.equal(b.title, 'Bob session');
  assert.notEqual(a.uid, b.uid);
  // Bob editing "1" edits Bob's.
  await bob.c.patch('/api/workouts/1', { title: 'Bob renamed' });
  await bob.c.put('/api/workouts/1/sets', { exercises: [{ name: 'Curl', sets: [{ kg: 10, reps: 10 }] }] });
  assert.equal((await alice.c.get('/api/workouts/1')).json.title, 'Alice secret session');
  assert.equal((await alice.c.get('/api/workouts/1')).json.exercises[0].name, 'Bench Press (Barbell)');
  await bob.c.del('/api/workouts/1');
  assert.equal((await alice.c.get('/api/workouts/1')).status, 200);
});

test('global rows (push devices, link keys) cannot be touched by someone else', async () => {
  assert.equal((await bob.c.patch(`/api/push/devices/${aliceDevice}`, { enabled: false })).status, 404);
  assert.equal((await bob.c.del(`/api/push/devices/${aliceDevice}`)).status, 404);
  assert.equal((await bob.c.post('/api/push/test', { deviceId: aliceDevice })).status, 404);
  assert.equal((await bob.c.del(`/api/link/keys/${aliceKey.keys[0].id}`)).status, 404);
  assert.equal((await alice.c.get('/api/push')).json.devices.length, 1);
  assert.equal((await alice.c.get('/api/link')).json.keys.length, 1);
  // Bob subscribing the SAME browser endpoint takes that browser over; it
  // does not give him Alice's other state.
  const b = await bob.c.post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/alice-device-1', keys: { p256dh: 'BKey2', auth: 'auth2' } } });
  assert.equal(b.json.devices.length, 1);
  assert.equal((await alice.c.get('/api/push')).json.devices.length, 0, 'the browser now belongs to whoever is signed in on it');
});

test('a link key reads and writes its owner\'s data only', async () => {
  const h = { authorization: `Bearer ${aliceKey.key}` };
  const got = (await r.client().get('/api/link/changes', { headers: h })).json;
  assert.ok(got.workouts.some((w) => w.title === 'Alice secret session'));
  assert.ok(!got.workouts.some((w) => /Bob/.test(w.title || '')));
  await r.client().call('POST', '/api/link/changes', { headers: h, origin: null, body: { workouts: [{ uid: 'from-alice-module', updatedAt: NOW, status: 'done', source: 'manual', start: NOW - 9 * 86_400_000, end: NOW - 9 * 86_400_000 + 1_800_000, title: 'Module session' }] } });
  assert.ok((await alice.c.get('/api/workouts?limit=100')).json.history.some((w) => w.title === 'Module session'));
  assert.ok(!(await bob.c.get('/api/workouts?limit=100')).text.includes('Module session'));
  // The stored key is a hash: the key itself is nowhere in the database.
  assert.ok(!JSON.stringify(r.app.app.all('SELECT * FROM link_key')).includes(aliceKey.key));
});

test('a private account: no profile for others, on no board, in no list, and no public rows at all', async () => {
  for (const who of [bob.c, alice.c, r.client()]) {
    const x = await who.get('/api/users/carol');
    assert.equal(x.status, 404);
    // Indistinguishable from someone who does not exist.
    assert.deepEqual(x.json, (await who.get('/api/users/nosuchperson')).json);
  }
  assert.equal((await bob.c.get('/api/compare?with=carol')).status, 404);
  assert.ok(!(await bob.c.get('/api/people')).json.people.some((p) => p.username === 'carol'));
  for (const m of ['steps', 'workouts', 'distance', 'active_minutes']) {
    const lb = (await bob.c.get(`/api/leaderboard?metric=${m}&period=all`)).json;
    assert.ok(lb.entries.length >= 1);
    assert.ok(!lb.entries.some((e) => e.username === 'carol'), m);
  }
  for (const t of ['daily_public', 'public_workout', 'records']) assert.equal(r.app.app.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, carol.id).n, 0, t);
  // Carol herself sees her own profile, marked private, and why she is not ranked.
  const own = (await carol.c.get('/api/users/carol')).json;
  assert.equal(own.me, true); assert.equal(own.private, true);
  const lb = (await carol.c.get('/api/leaderboard?metric=steps&period=week')).json;
  assert.deepEqual([lb.me.listed, lb.me.reason], [false, 'Your account is private']);
  // And she still has all of her own data.
  assert.ok((await carol.c.get('/api/data')).json.series.some((d) => d.steps > 0));
});

test('export is the asker\'s own data, with no token and no key in it', async () => {
  const x = await alice.c.get('/api/export');
  assert.match(x.headers.get('content-disposition'), /attachment; filename="health-alice-\d{4}-\d\d-\d\d\.json"/);
  assert.equal(x.json.account.username, 'alice');
  assert.ok(Object.keys(x.json.daily).length >= 80);
  assert.ok(x.json.workouts.some((w) => w.title === 'Alice secret session' && w.exercises.length === 1));
  assert.ok(!x.text.includes('demo-rt-'), 'no refresh token');
  assert.ok(!x.text.includes('demo-at-'), 'no access token');
  assert.ok(!x.text.includes('sk-alice-opencode-key-7777'), 'no OpenCode key');
  assert.ok(!x.text.includes(aliceKey.key), 'no link key');
  assert.ok(!(await bob.c.get('/api/export')).text.includes('alice'));
});

test('disconnect keeps the history; delete removes the folder and every global row, and the account stays', async () => {
  const d = await r.person('deleter', { persona: 'fitbit' });
  await d.c.post('/api/link/keys', {});
  await d.c.post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/deleter-1', keys: { p256dh: 'k', auth: 'a' } } });
  const dis = await d.c.post('/api/google/disconnect', {});
  assert.equal(dis.json.google.state, 'needs_auth');
  assert.ok((await d.c.get('/api/data')).json.series.some((x) => x.steps > 0), 'history kept');
  assert.equal((await d.c.post('/api/account/delete-data', { confirm: 'someoneelse' })).status, 400);
  assert.deepEqual((await d.c.post('/api/account/delete-data', { confirm: 'deleter' })).json, { ok: true });
  await new Promise((res) => { setTimeout(res, 50); });
  for (const t of ['profile', 'daily_public', 'public_workout', 'records', 'push_sub', 'link_key', 'secret']) assert.equal(r.app.app.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, d.id).n, 0, t);
  assert.equal(r.app.worlds.has(d.id), false, 'the folder is gone');
  // Still an ojee.net account, still signed in, starting over.
  const me = (await d.c.get('/api/me')).json;
  assert.equal(me.user.username, 'deleter');
  assert.equal(me.profile.onboarding, 'profile');
  assert.equal((await d.c.get('/api/data')).json.empty, true);
  assert.ok(await r.app.accounts.byUsername('deleter'));
});
