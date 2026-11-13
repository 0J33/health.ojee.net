import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rig, ORIGIN } from './helpers.mjs';
import { linkIdentity } from '../server/signin.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

test('sign-up: the username rules and the exact messages mtg and dnd use', async () => {
  const c = r.client();
  const back = await r.viaGoogle(c, { sub: 'g-rules', email: 'rules@example.com' });
  const pending = new URL(back.headers.get('location'), ORIGIN).searchParams.get('pending');
  for (const [username, msg] of [['', 'Username required'], ['a', 'Username must be 2-24 characters'], ['x'.repeat(25), 'Username must be 2-24 characters']]) {
    const x = await c.post('/auth/signin/complete', { pending, username, accept: true });
    assert.equal(x.status, 400);
    assert.equal(x.json.error, msg);
  }
  const ok = await c.post('/auth/signin/complete', { pending, username: '  Sam ', accept: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json.user).sort(), ['id', 'username']);
  assert.equal(ok.json.user.username, 'Sam');
  // Unique ignoring case.
  const dup = await r.signUp('sAM', { sub: 'g-other-sam' });
  assert.equal(dup.done.status, 400);
  assert.equal(dup.done.json.error, 'That username is taken');
});

test('the account is rep.\'s own: kept in app.sqlite, sessions stored hashed; linking takes the password away', async () => {
  const db = r.app.app;
  await r.app.accounts.register({ username: 'cardplayer', password: 'decks123' });
  const mine = db.get('SELECT * FROM account WHERE username = ?', 'cardplayer');
  assert.match(mine.id, /^[0-9a-f]{24}$/, 'an id shaped like the old Mongo ones');
  assert.match(mine.password, /^\$2[aby]\$10\$/, 'bcrypt, cost 10');
  const c = r.client();
  const ok = await c.post('/auth/login', { username: 'CARDPLAYER', password: 'decks123' });
  assert.equal(ok.status, 200);
  // The session: a uuid v4 in the cookie, only its hash kept, thirty days.
  const token = c.cookie.split('=')[1];
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM session WHERE token_hash = ?', token).n, 0, 'never the token itself');
  const s = db.get('SELECT * FROM session WHERE token_hash = ?', createHash('sha256').update(token).digest('hex'));
  assert.equal(s.user_id, mine.id);
  assert.equal(Math.round((s.expires_ms - s.created_ms) / 86_400_000), 30);
  assert.equal((await r.viaGoogle(c, { sub: 'g-cards' }, '?link=1')).status, 302);
  assert.equal(db.get('SELECT password FROM account WHERE id = ?', mine.id).password, '', 'the password is gone');
  // An account made with Google: a username and no password.
  await r.signUp('fromgoogle');
  assert.equal(db.get('SELECT password FROM account WHERE username = ?', 'fromgoogle').password, '');
});

test('the cookie: repSession, httpOnly, secure, SameSite=None, on the site\'s domain, 30 days', async () => {
  const x = (await r.signUp('cookie')).done;
  const sc = x.setCookie[0];
  assert.match(sc, /^repSession=[0-9a-f-]{36};/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=None', 'Domain=.ojee.net', 'Path=/', 'Max-Age=2592000']) assert.ok(sc.includes(part), part);
});

test('password sign-in (accounts from before, and the flagged): wrong password and unknown user answer the same; me follows the cookie; logout ends the session', async () => {
  await r.app.accounts.register({ username: 'lina', password: 'right-one' });
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
  // The same session on another device (the cookie copied).
  const other = r.client(); other.cookie = `repSession=${token}`;
  assert.equal((await other.get('/api/me')).json.user.username, 'lina');
  const out = await c.post('/auth/logout');
  assert.deepEqual(out.json, { success: true });
  assert.match(out.setCookie[0], /repSession=;.*Expires=Thu, 01 Jan 1970/);
  assert.equal(r.app.app.get('SELECT COUNT(*) AS n FROM session WHERE token_hash = ?', createHash('sha256').update(token).digest('hex')).n, 0);
  assert.equal((await other.get('/api/me')).json.user, null, 'gone everywhere');
});

test('an expired session is not a login', async () => {
  const { c } = await r.signUp('expiring');
  const token = c.cookie.split('=')[1];
  r.app.app.run('UPDATE session SET expires_ms = ? WHERE token_hash = ?', Date.now() - 1000, createHash('sha256').update(token).digest('hex'));
  const fresh = r.client(); fresh.cookie = `repSession=${token}`;
  assert.equal((await fresh.get('/api/me')).json.user, null);
});

test('state-changing requests need this site\'s Origin', async () => {
  const c = r.client();
  for (const origin of [null, 'https://evil.example', 'https://health.test.evil.example']) {
    const x = await c.post('/auth/signin/complete', { pending: 'x', username: 'csrf', accept: true }, { origin });
    assert.equal(x.status, 403);
    assert.equal(x.json.code, 'bad_origin');
  }
  const me = await r.person('origincheck');
  assert.equal((await me.c.patch('/api/profile', { bio: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await me.c.post('/auth/logout', undefined, { origin: null })).status, 403);
  assert.equal((await me.c.patch('/api/profile', { bio: 'x' }, { origin: ORIGIN })).status, 200);
});

test('password sign-in and sign-up are rate limited, per address and per username', async () => {
  const c = r.client();
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  let last;
  for (let i = 0; i < 6; i += 1) last = await c.post('/auth/login', { username: 'victim', password: `guess${i}` }, { headers: ip });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate_limited');
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  // Another address is not locked out of other accounts.
  assert.equal((await c.post('/auth/login', { username: 'someoneelse', password: 'x' }, { headers: { 'cf-connecting-ip': '203.0.113.10' } })).status, 401);
  // Ten new accounts an hour from one address.
  const reg = { 'cf-connecting-ip': '203.0.113.50' };
  const make = async (i) => {
    const x = r.client();
    const back = await x.call('GET', '/auth/signin/google/start', { headers: reg });
    const cb = new URL(r.signin.googleApprove(back.headers.get('location'), { sub: `g-flood${i}` }));
    const done = await x.call('GET', cb.pathname + cb.search, { headers: reg });
    const pending = new URL(done.headers.get('location'), ORIGIN).searchParams.get('pending');
    return (await x.post('/auth/signin/complete', { pending, username: `flood${i}`, accept: true }, { headers: reg })).status;
  };
  for (let i = 0; i < 10; i += 1) assert.equal(await make(i), 200);
  assert.equal(await make(10), 429);
});

test('a health profile is made on first sign-in here; closing registration stops new ones, not existing people', async () => {
  const admin = await r.person('ojee');
  const old = await r.person('oldtimer');
  // Someone with an account and no health profile yet (and Google linked).
  const mtg = await r.app.accounts.create({ username: 'frommtg' });
  linkIdentity(r.app.app, { provider: 'google', sub: 'g-frommtg', userId: mtg.user.id });
  assert.equal(r.app.app.profile(mtg.user.id), null);
  const visitor = r.client(); visitor.cookie = `repSession=${mtg.token}`;
  const me = (await visitor.get('/api/me?tz=Asia/Tokyo')).json;
  assert.equal(me.profile.onboarding, 'profile');
  assert.equal(me.profile.tz, 'Asia/Tokyo');
  assert.deepEqual([me.privacy.account, me.privacy.sleep, me.privacy.activity], ['public', 'me', 'everyone']);

  assert.equal((await old.c.post('/api/admin/registration', { open: false })).status, 403, 'not an admin');
  const closed = await admin.c.post('/api/admin/registration', { open: false });
  assert.equal(closed.json.registrationOpen, false);
  const no = await r.viaGoogle(r.client(), { sub: 'g-toolate' });
  assert.match(no.headers.get('location'), /^\/signin\?signin=error&message=There\+is\+no\+rep\.\+account/);
  assert.equal(await r.app.accounts.byUsername('toolate'), null, 'no account was made');
  // Another mtg account can still sign in (it is their ojee.net account),
  // but gets no health profile.
  const lateAcct = await r.app.accounts.create({ username: 'latemtg' });
  linkIdentity(r.app.app, { provider: 'google', sub: 'g-latemtg', userId: lateAcct.user.id });
  const late = r.client();
  assert.equal((await r.viaGoogle(late, { sub: 'g-latemtg' })).status, 302);
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
  await r.viaGoogle(admin, { sub: 'g-ojee' });
  const a = (await admin.get('/api/admin')).json;
  assert.ok(a.people.length >= 3);
  assert.deepEqual(Object.keys(a.people[0]).sort(), ['accent', 'avatar', 'detection', 'displayName', 'google', 'id', 'joinedAt', 'lastSeenAt', 'lastSyncAt', 'linkKeys', 'nextSyncAt', 'private', 'pushDevices', 'suspended', 'syncError', 'username']);
  assert.ok(a.server.version && a.server.worlds.max > 0);
  assert.ok(!JSON.stringify(a).includes('csecret'), 'no secret in the payload');
});
