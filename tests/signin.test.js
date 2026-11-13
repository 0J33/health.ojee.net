/* Sign in with Google and Apple (server/signin.js): new accounts with a
   username, existing ones, the apps' ticket through the system browser,
   Apple's native token and its web form_post, accounts from before that
   must link one, linking both, unlinking, and what deletion takes along. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rig, ORIGIN } from './helpers.mjs';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const sha = (s) => createHash('sha256').update(s).digest('hex');
const loc = (x) => new URL(x.headers.get('location'), ORIGIN);
const SECRET = 'app-secret-0123456789-abcdefghij';
/** Apple's page said yes; its answer posted back the way Apple posts it. */
async function appleBack(c, authUrl, who) {
  const { action, form } = r.signin.appleApprove(authUrl, who);
  return c.call('POST', new URL(action).pathname, { raw: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, origin: 'https://appleid.apple.com' });
}

test('Google: only who you are is asked; somebody new chooses a username and accepts, and is signed in', async () => {
  const c = r.client();
  const start = await c.get('/auth/signin/google/start?next=/sleep');
  assert.equal(start.status, 302);
  const q = loc(start).searchParams;
  assert.equal(loc(start).origin + loc(start).pathname, r.signin.urls.googleAuth);
  assert.equal(q.get('scope'), 'openid email profile', 'no health scopes');
  assert.equal(q.get('client_id'), 'cid', 'the same client as Google Health');
  assert.equal(q.get('redirect_uri'), `${ORIGIN}/auth/signin/google/callback`);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('nonce') && q.get('state'));
  const cb = new URL(r.signin.googleApprove(start.headers.get('location'), { sub: 'g-newbie', email: 'newbie@gmail.com' }));
  const back = await c.get(cb.pathname + cb.search);
  assert.equal(back.status, 302);
  assert.equal(loc(back).pathname, '/register');
  assert.equal(loc(back).searchParams.get('next'), '/sleep');
  const pending = loc(back).searchParams.get('pending');
  assert.deepEqual((await c.get(`/auth/signin/pending?k=${pending}`)).json, { provider: 'google', email: 'newbie@gmail.com' });
  assert.equal((await c.get('/api/me')).json.user, null, 'not signed in before the username');
  const noBox = await c.post('/auth/signin/complete', { pending, username: 'newbie' });
  assert.equal(noBox.status, 400); assert.equal(noBox.json.code, 'accept');
  const done = await c.post('/auth/signin/complete', { pending, username: 'newbie', accept: true, tz: 'Asia/Tokyo' });
  assert.equal(done.status, 200);
  const me = (await c.get('/api/me')).json;
  assert.equal(me.user.username, 'newbie');
  assert.equal(me.profile.tz, 'Asia/Tokyo');
  assert.ok(me.consent.terms > 0, 'the sign-up box is kept');
  assert.deepEqual(me.signin.methods.map((m) => [m.provider, m.email]), [['google', 'newbie@gmail.com']]);
  assert.equal(me.signin.linkRequired, false);
  assert.equal((await c.post('/auth/signin/complete', { pending, username: 'newbie2', accept: true })).status, 410, 'a pending sign-up is used once');
  // Connect Google Health then suggests the same Google account: one tap.
  const health = await c.get('/auth/google/start');
  assert.equal(loc(health).searchParams.get('login_hint'), 'newbie@gmail.com');
});

test('Google: an existing account is signed in straight away, to where it was going', async () => {
  await r.signUp('returner', { sub: 'g-returner' });
  const c = r.client();
  const back = await r.viaGoogle(c, { sub: 'g-returner' }, '?next=/workouts');
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/workouts');
  assert.match(back.setCookie[0], /^repSession=[0-9a-f-]{36};/);
  assert.equal((await c.get('/api/me')).json.user.username, 'returner');
});

test('Google: a replayed or forged answer, an unverified email, or a cancel signs nobody in', async () => {
  const c = r.client();
  const start = await c.get('/auth/signin/google/start');
  const cb = new URL(r.signin.googleApprove(start.headers.get('location'), { sub: 'g-replay' }));
  assert.equal(loc(await c.get(cb.pathname + cb.search)).pathname, '/register');
  const again = await c.get(cb.pathname + cb.search);
  assert.equal(loc(again).pathname, '/signin');
  assert.equal(loc(again).searchParams.get('signin'), 'error', 'the state is used once');
  const s2 = await c.get('/auth/signin/google/start');
  const unverified = new URL(r.signin.googleApprove(s2.headers.get('location'), { sub: 'g-unverified', emailVerified: false }));
  assert.match(loc(await c.get(unverified.pathname + unverified.search)).searchParams.get('message'), /not verified/);
  const s3 = await c.get('/auth/signin/google/start');
  const st = loc(s3).searchParams.get('state');
  assert.equal(loc(await c.get(`/auth/signin/google/callback?state=${st}&error=access_denied`)).searchParams.get('message'), 'Nothing was signed in.');
  assert.equal((await c.get('/api/me')).json.user, null);
});

test('the apps: a ticket for the system browser, polled with the app\'s secret, used once', async () => {
  const appC = r.client();
  const browser = r.client();
  assert.equal((await appC.post('/auth/signin/ticket', { provider: 'google', secret: 'short' })).status, 400);
  const t = (await appC.post('/auth/signin/ticket', { provider: 'google', secret: SECRET })).json;
  assert.match(t.path, /^\/auth\/signin\/google\/start\?ticket=/);
  assert.deepEqual((await appC.post('/auth/signin/ticket/poll', { ticket: t.ticket, secret: SECRET })).json, { state: 'waiting' });
  const start = await browser.get(t.path);
  assert.equal(start.status, 302);
  assert.equal((await r.client().get(t.path)).status, 410, 'the start address works once');
  const cb = new URL(r.signin.googleApprove(start.headers.get('location'), { sub: 'g-appuser', email: 'app@example.com' }));
  const page = await browser.get(cb.pathname + cb.search);
  assert.equal(page.status, 200);
  assert.match(page.text, /Go back to the rep\. app to choose your username/);
  assert.equal(page.setCookie.length, 0, 'the browser is not signed in');
  // Somebody else's poll (the secret is the app's) gets nothing.
  assert.equal((await r.client().post('/auth/signin/ticket/poll', { ticket: t.ticket, secret: `${SECRET}x` })).status, 410);
  const got = (await appC.post('/auth/signin/ticket/poll', { ticket: t.ticket, secret: SECRET })).json;
  assert.equal(got.state, 'pending');
  assert.equal(got.email, 'app@example.com');
  const replay = await appC.post('/auth/signin/ticket/poll', { ticket: t.ticket, secret: SECRET });
  assert.equal(replay.status, 410); assert.equal(replay.json.code, 'ticket_gone');
  assert.equal((await appC.post('/auth/signin/complete', { pending: got.pending, username: 'appuser', accept: true })).status, 200);
  assert.equal((await appC.get('/api/me')).json.user.username, 'appuser');

  // The next time, on another phone: the poll itself signs the app in.
  const phone = r.client();
  const t2 = (await phone.post('/auth/signin/ticket', { provider: 'google', secret: SECRET })).json;
  const s2 = await browser.get(t2.path);
  const cb2 = new URL(r.signin.googleApprove(s2.headers.get('location'), { sub: 'g-appuser' }));
  assert.match((await browser.get(cb2.pathname + cb2.search)).text, /You are signed in/);
  const done = await phone.post('/auth/signin/ticket/poll', { ticket: t2.ticket, secret: SECRET });
  assert.equal(done.json.state, 'done');
  assert.match(done.setCookie[0], /^repSession=/);
  assert.equal((await phone.get('/api/me')).json.user.username, 'appuser');
  assert.equal((await phone.post('/auth/signin/ticket/poll', { ticket: t2.ticket, secret: SECRET })).status, 410, 'a replayed ticket signs nobody in');
  assert.equal((await browser.get('/api/me')).json.user, null, 'the browser never was');
});

test('Apple in the iPhone app: the token is checked for our app, our nonce, and its time', async () => {
  const c = r.client();
  const nonce = async () => (await c.post('/auth/signin/nonce')).json;
  const n1 = await nonce();
  assert.equal(n1.hashed, sha(n1.nonce));
  const call = (tok, n) => c.post('/auth/signin/apple/native', { identityToken: tok, nonce: n });
  // Another app's token.
  const badAud = await call(r.signin.idToken('apple', { aud: 'com.example.other', sub: 'a-native', nonce: n1.hashed }), n1.nonce);
  assert.equal(badAud.status, 401); assert.equal(badAud.json.code, 'bad_token');
  // A token made for another nonce.
  const n2 = await nonce();
  assert.equal((await call(r.signin.idToken('apple', { sub: 'a-native', nonce: sha('somebody-elses') }), n2.nonce)).status, 401);
  // Expired.
  const n3 = await nonce();
  const old = Math.floor(Date.now() / 1000) - 7200;
  assert.equal((await call(r.signin.idToken('apple', { sub: 'a-native', nonce: n3.hashed, iat: old, exp: old + 600 }), n3.nonce)).status, 401);
  // A nonce this server never gave, or one used already.
  assert.equal((await call(r.signin.idToken('apple', { sub: 'a-native', nonce: sha('made-up') }), 'made-up')).status, 410);
  assert.equal((await call(r.signin.idToken('apple', { sub: 'a-native', nonce: n1.hashed }), n1.nonce)).status, 410, 'each nonce once');
  // Signed by somebody else's key.
  const n4 = await nonce();
  const forged = r.signin.idToken('google', { iss: 'https://appleid.apple.com', aud: 'net.ojee.health', sub: 'a-native', nonce: n4.hashed });
  assert.equal((await call(forged, n4.nonce)).status, 401);
  // Good.
  const n5 = await nonce();
  const ok = await call(r.signin.idToken('apple', { sub: 'a-native', email: 'x7@privaterelay.appleid.com', nonce: n5.hashed }), n5.nonce);
  assert.equal(ok.json.state, 'pending');
  assert.equal(ok.json.email, 'x7@privaterelay.appleid.com', 'a private relay address is kept as it came');
  assert.equal((await c.post('/auth/signin/complete', { pending: ok.json.pending, username: 'applefan', accept: true })).status, 200);
  // Next time it signs in.
  const n6 = await nonce();
  const fresh = r.client();
  const again = await fresh.post('/auth/signin/apple/native', { identityToken: r.signin.idToken('apple', { sub: 'a-native', nonce: n6.hashed }), nonce: n6.nonce });
  assert.equal(again.json.state, 'done');
  assert.equal((await fresh.get('/api/me')).json.user.username, 'applefan');
});

test('Apple on the web: Apple\'s page posts its answer back (form_post), from appleid.apple.com', async () => {
  const c = r.client();
  const start = await c.get('/auth/signin/apple/start');
  const u = loc(start);
  assert.equal(u.origin + u.pathname, r.signin.urls.appleAuth);
  assert.equal(u.searchParams.get('client_id'), 'net.ojee.health.signin', 'the web Services ID');
  assert.equal(u.searchParams.get('response_mode'), 'form_post');
  assert.equal(u.searchParams.get('response_type'), 'code id_token');
  assert.equal(u.searchParams.get('redirect_uri'), `${ORIGIN}/auth/signin/apple/callback`);
  const back = await appleBack(c, start.headers.get('location'), { sub: 'a-web' });
  assert.equal(back.status, 303);
  assert.equal(loc(back).pathname, '/register');
  const pending = loc(back).searchParams.get('pending');
  assert.equal((await c.post('/auth/signin/complete', { pending, username: 'webapple', accept: true })).status, 200);
  // The native app's audience is not good for the web, nor the other way round.
  const s2 = await r.client().get('/auth/signin/apple/start');
  const wrong = await appleBack(r.client(), s2.headers.get('location'), { sub: 'a-web', claims: { aud: 'net.ojee.health' } });
  assert.equal(loc(wrong).searchParams.get('signin'), 'error');
  // Signing in again: straight in.
  const d = r.client();
  const s3 = await d.get('/auth/signin/apple/start');
  const in3 = await appleBack(d, s3.headers.get('location'), { sub: 'a-web', first: false });
  assert.equal(in3.status, 303);
  assert.equal(in3.headers.get('location'), '/');
  assert.equal((await d.get('/api/me')).json.user.username, 'webapple');
});

test('an account from before: blocked with link_required until it links Google or Apple; then its password is gone', async () => {
  const old = await r.person('oldie', { legacy: true, password: 'old-pass' });
  const blocked = await old.c.get('/api/data');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'link_required');
  assert.equal((await old.c.patch('/api/profile', { bio: 'x' })).json.code, 'link_required');
  const me = (await old.c.get('/api/me')).json;
  assert.equal(me.user.username, 'oldie');
  assert.equal(me.signin.linkRequired, true);
  // Signed out, its password still gets it in, to the same step.
  const elsewhere = r.client();
  assert.equal((await elsewhere.post('/auth/login', { username: 'oldie', password: 'old-pass' })).status, 200);
  assert.equal((await elsewhere.get('/api/data')).json.code, 'link_required');
  // Linking keeps the account and its username.
  const linked = await r.viaGoogle(old.c, { sub: 'g-oldie', email: 'oldie@example.com' }, '?link=1&return=/');
  assert.equal(loc(linked).pathname, '/');
  assert.equal(loc(linked).searchParams.get('signin'), 'linked');
  assert.equal((await old.c.get('/api/data')).status, 200);
  assert.equal((await old.c.get('/api/me')).json.user.username, 'oldie');
  assert.equal((await r.app.accounts.byUsername('oldie')).password, '', 'the password hash is cleared');
  const tryPw = await r.client().post('/auth/login', { username: 'oldie', password: 'old-pass' });
  assert.equal(tryPw.status, 401, 'the old password no longer works');
  // Google now signs in to the same account.
  const g = r.client();
  await r.viaGoogle(g, { sub: 'g-oldie' });
  assert.equal((await g.get('/api/me')).json.user.id, old.id);
});

test('the reviewers\' demo account keeps its password and is never asked to link', async () => {
  const demo = await r.person('demo', { legacy: true, password: 'demo' });
  assert.equal((await demo.c.get('/api/data')).status, 200);
  assert.equal((await demo.c.get('/api/me')).json.signin.passwordLogin, true);
  await r.viaGoogle(demo.c, { sub: 'g-demo' }, '?link=1');
  assert.equal((await r.client().post('/auth/login', { username: 'demo', password: 'demo' })).status, 200, 'still works after linking');
  // Anybody else with Google linked cannot use a password, even if one were somehow there.
  const p = await r.person('pwagain');
  r.app.app.run('UPDATE account SET password = ? WHERE username = ?', (await r.app.accounts.byUsername('demo')).password, 'pwagain');
  const x = await r.client().post('/auth/login', { username: 'pwagain', password: 'demo' });
  assert.equal(x.status, 403); assert.equal(x.json.code, 'use_provider');
  assert.ok(p.id);
});

test('both linked, either signs in; the last one cannot be unlinked; one identity is never on two accounts', async () => {
  const p = await r.person('both');
  const last = await p.c.post('/api/signin/unlink', { provider: 'google' });
  assert.equal(last.status, 409); assert.equal(last.json.code, 'last_method');
  const start = await p.c.get('/auth/signin/apple/start?link=1');
  const back = await appleBack(p.c, start.headers.get('location'), { sub: 'a-both', email: 'both@icloud.com' });
  assert.equal(back.headers.get('location'), '/settings/account?signin=linked&provider=apple');
  assert.deepEqual((await p.c.get('/api/signin')).json.methods.map((m) => m.provider).sort(), ['apple', 'google']);
  const viaApple = r.client();
  const s = await viaApple.get('/auth/signin/apple/start');
  await appleBack(viaApple, s.headers.get('location'), { sub: 'a-both', first: false });
  assert.equal((await viaApple.get('/api/me')).json.user.id, p.id);
  const after = (await p.c.post('/api/signin/unlink', { provider: 'google' })).json;
  assert.deepEqual(after.methods.map((m) => m.provider), ['apple']);
  assert.equal((await p.c.post('/api/signin/unlink', { provider: 'apple' })).json.code, 'last_method');

  // Somebody else's Google is refused, with a reason.
  const other = await r.person('someoneelse');
  const taken = await r.viaGoogle(p.c, { sub: 'g-someoneelse' }, '?link=1');
  assert.equal(loc(taken).searchParams.get('signin'), 'error');
  assert.match(loc(taken).searchParams.get('message'), /already used to sign in to another rep\. account/);
  assert.equal((await other.c.get('/api/me')).json.signin.methods.length, 1);
  assert.equal((await p.c.get('/api/me')).json.signin.methods.length, 1, 'nothing was linked');
  // A second Google account on the same rep. account is refused too.
  await r.viaGoogle(p.c, { sub: 'g-both-2' }, '?link=1');
  const twice = await r.viaGoogle(p.c, { sub: 'g-both-3' }, '?link=1');
  assert.match(loc(twice).searchParams.get('message'), /already signs in with another Google account/);
});

test('linking from the app goes through a ticket too; export lists the sign-ins; deleting the account removes them', async () => {
  const p = await r.person('exporter');
  const t = (await p.c.post('/auth/signin/ticket', { provider: 'apple', secret: SECRET, link: true })).json;
  const browser = r.client();
  const s = await browser.get(t.path);
  const page = await appleBack(browser, s.headers.get('location'), { sub: 'a-exporter', email: 'ex@privaterelay.appleid.com' });
  assert.match(page.text, /Apple is linked/);
  assert.equal((await p.c.post('/auth/signin/ticket/poll', { ticket: t.ticket, secret: SECRET })).json.state, 'linked');
  const ex = (await p.c.get('/api/export')).json;
  assert.deepEqual(ex.signIn.map((m) => [m.provider, m.email]), [['google', 'exporter@example.com'], ['apple', 'ex@privaterelay.appleid.com']]);
  assert.deepEqual((await p.c.post('/api/account/delete', { confirm: 'exporter' })).json, { ok: true });
  assert.equal(r.app.app.get('SELECT COUNT(*) AS n FROM identity WHERE user_id = ?', p.id).n, 0);
});
