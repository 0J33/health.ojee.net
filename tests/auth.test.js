import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ORIGIN } from './helpers.mjs';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

test('register: the rules and the exact messages mtg and dnd use', async () => {
  const c = r.client();
  const cases = [
    [{ username: '', password: '' }, 'Username and password required'],
    [{ username: 'a', password: 'abcd' }, 'Username must be 2-24 characters'],
    [{ username: 'x'.repeat(25), password: 'abcd' }, 'Username must be 2-24 characters'],
    [{ username: 'sam', password: 'abc' }, 'Password must be at least 4 characters'],
  ];
  for (const [body, msg] of cases) {
    const x = await c.post('/auth/register', body);
    assert.equal(x.status, 400);
    assert.equal(x.json.error, msg);
  }
  const ok = await c.post('/auth/register', { username: '  Sam ', password: 'abcd' });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json.user).sort(), ['id', 'username']);
  assert.equal(ok.json.user.username, 'Sam');
  // Unique ignoring case.
  const dup = await r.client().post('/auth/register', { username: 'sAM', password: 'abcd' });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, 'That username is taken');
});

test('the account is written the way the other two sites expect, and nothing else is touched', async () => {
  const users = r.parts.mongo.collection('users');
  // An account made on mtg, with mtg's own fields.
  await r.client().post('/auth/register', { username: 'cardplayer', password: 'decks123' });
  const mine = users.docs.find((u) => u.username === 'cardplayer');
  assert.deepEqual(Object.keys(mine).sort(), ['_id', 'createdAt', 'lastLogin', 'password', 'username']);
  assert.match(mine.password, /^\$2[aby]\$10\$/, 'bcrypt, cost 10');
  assert.ok(mine.createdAt instanceof Date && mine.lastLogin instanceof Date);
  mine.decks = ['d1', 'd2']; mine.preferences = { cardSize: 'large' }; mine.lastLogin = new Date(0);
  const c = r.client();
  const ok = await c.post('/auth/login', { username: 'CARDPLAYER', password: 'decks123' });
  assert.equal(ok.status, 200);
  const after = users.docs.find((u) => u.username === 'cardplayer');
  assert.deepEqual(after.decks, ['d1', 'd2']);
  assert.deepEqual(after.preferences, { cardSize: 'large' });
  assert.ok(after.lastLogin.getTime() > 0, 'lastLogin moved');
  // The session: a uuid v4, the user's ObjectId, thirty days.
  const s = r.parts.mongo.collection('sessions').docs.at(-1);
  assert.match(s.sessionToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(String(s.userId), String(after._id));
  assert.equal(Math.round((s.expiresAt - s.createdAt) / 86_400_000), 30);
  assert.deepEqual([...r.parts.mongo.cols.keys()].sort(), ['sessions', 'users'], 'only these two collections');
});

test('the cookie: ojeeSession, httpOnly, secure, SameSite=None, on the shared domain, 30 days', async () => {
  const c = r.client();
  const x = await c.post('/auth/register', { username: 'cookie', password: 'abcd' });
  const sc = x.setCookie[0];
  assert.match(sc, /^ojeeSession=[0-9a-f-]{36};/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=None', 'Domain=.ojee.net', 'Path=/', 'Max-Age=2592000']) assert.ok(sc.includes(part), part);
});

test('login: wrong password and unknown user answer the same; me follows the cookie; logout ends the shared session', async () => {
  await r.client().post('/auth/register', { username: 'lina', password: 'right-one' });
  const c = r.client();
  for (const body of [{ username: 'lina', password: 'wrong' }, { username: 'nobody', password: 'whatever' }]) {
    const x = await c.post('/auth/login', body);
    assert.equal(x.status, 401);
    assert.equal(x.json.error, 'Wrong username or password');
  }
  assert.deepEqual((await c.get('/auth/me')).json, { user: null });
  assert.equal((await c.get('/api/me')).json.user, null);
  assert.equal((await c.get('/api/data')).status, 401);
  assert.equal((await c.get('/api/data')).json.error, 'Not logged in');
  const ok = await c.post('/auth/login', { username: 'lina', password: 'right-one' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/auth/me')).json.user.username, 'lina');
  const token = c.cookie.split('=')[1];
  // A session made by mtg (same store) signs in here too.
  const other = r.client(); other.cookie = `ojeeSession=${token}`;
  assert.equal((await other.get('/api/me')).json.user.username, 'lina');
  const out = await c.post('/auth/logout');
  assert.deepEqual(out.json, { success: true });
  assert.match(out.setCookie[0], /ojeeSession=;.*Expires=Thu, 01 Jan 1970/);
  assert.equal(await r.parts.mongo.collection('sessions').findOne({ sessionToken: token }), null);
  assert.equal((await other.get('/api/me')).json.user, null, 'gone everywhere');
});

test('an expired session is not a login', async () => {
  const c = r.client();
  await c.post('/auth/register', { username: 'expiring', password: 'abcd' });
  const token = c.cookie.split('=')[1];
  r.parts.mongo.collection('sessions').docs.find((s) => s.sessionToken === token).expiresAt = new Date(Date.now() - 1000);
  const fresh = r.client(); fresh.cookie = `ojeeSession=${token}`;
  assert.equal((await fresh.get('/api/me')).json.user, null);
});

test('state-changing requests need this site\'s Origin', async () => {
  const c = r.client();
  for (const origin of [null, 'https://evil.example', 'https://health.test.evil.example']) {
    const x = await c.post('/auth/register', { username: 'csrf', password: 'abcd' }, { origin });
    assert.equal(x.status, 403);
    assert.equal(x.json.code, 'bad_origin');
  }
  const me = await r.person('origincheck');
  assert.equal((await me.c.patch('/api/profile', { bio: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await me.c.post('/auth/logout', undefined, { origin: null })).status, 403);
  assert.equal((await me.c.patch('/api/profile', { bio: 'x' }, { origin: ORIGIN })).status, 200);
});

test('login and register are rate limited, per address and per username', async () => {
  const c = r.client();
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  let last;
  for (let i = 0; i < 6; i += 1) last = await c.post('/auth/login', { username: 'victim', password: `guess${i}` }, { headers: ip });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate_limited');
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  // Another address is not locked out of other accounts.
  assert.equal((await c.post('/auth/login', { username: 'someoneelse', password: 'x' }, { headers: { 'cf-connecting-ip': '203.0.113.10' } })).status, 401);
  const reg = { 'cf-connecting-ip': '203.0.113.50' };
  for (let i = 0; i < 5; i += 1) assert.equal((await r.client().post('/auth/register', { username: `flood${i}`, password: 'abcd' }, { headers: reg })).status, 200);
  assert.equal((await r.client().post('/auth/register', { username: 'flood6', password: 'abcd' }, { headers: reg })).status, 429);
});

test('a health profile is made on first sign-in here; closing registration stops new ones, not existing people', async () => {
  const admin = await r.person('ojee');
  const old = await r.person('oldtimer');
  // Someone with an mtg account who has never been here.
  const mtg = await r.app.accounts.register({ username: 'frommtg', password: 'abcd' });
  assert.equal(r.app.app.profile(mtg.user.id), null);
  const visitor = r.client(); visitor.cookie = `ojeeSession=${mtg.token}`;
  const me = (await visitor.get('/api/me?tz=Asia/Tokyo')).json;
  assert.equal(me.profile.onboarding, 'profile');
  assert.equal(me.profile.tz, 'Asia/Tokyo');
  assert.equal(me.privacy.sleep, false);

  assert.equal((await old.c.post('/api/admin/registration', { open: false })).status, 403, 'not an admin');
  const closed = await admin.c.post('/api/admin/registration', { open: false });
  assert.equal(closed.json.registrationOpen, false);
  const no = await r.client().post('/auth/register', { username: 'toolate', password: 'abcd' });
  assert.equal(no.status, 403);
  assert.equal(no.json.error, 'Registration is closed');
  assert.equal(await r.app.accounts.byUsername('toolate'), null, 'no account was made');
  // Another mtg account can still sign in (it is their ojee.net account),
  // but gets no health profile.
  await r.app.accounts.register({ username: 'latemtg', password: 'abcd' });
  const late = r.client();
  assert.equal((await late.post('/auth/login', { username: 'latemtg', password: 'abcd' })).status, 200);
  const lm = (await late.get('/api/me')).json;
  assert.equal(lm.user.username, 'latemtg');
  assert.equal(lm.profile, null);
  assert.equal(lm.registrationOpen, false);
  const blocked = await late.get('/api/data');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'closed');
  // Existing people carry on.
  assert.equal((await old.c.get('/api/data')).status, 200);
  await admin.c.post('/api/admin/registration', { open: true });
  assert.equal((await late.get('/api/me')).json.profile.onboarding, 'profile');
});

test('admin: people and connection state, never health data', async () => {
  const admin = r.client();
  await admin.post('/auth/login', { username: 'ojee', password: 'pass1234' });
  const a = (await admin.get('/api/admin')).json;
  assert.ok(a.people.length >= 3);
  assert.deepEqual(Object.keys(a.people[0]).sort(), ['aiKey', 'detection', 'displayName', 'google', 'id', 'joinedAt', 'lastSeenAt', 'lastSyncAt', 'linkKeys', 'nextSyncAt', 'private', 'pushDevices', 'syncError', 'username']);
  assert.ok(a.server.version && a.server.worlds.max > 0);
  assert.ok(!JSON.stringify(a).includes('csecret'), 'no secret in the payload');
});
