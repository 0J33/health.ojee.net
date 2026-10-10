import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../server/scheduler.js';
import { rig } from './helpers.mjs';

const MIN = 60_000;

function srig({ people, results = {}, maxInFlight = 3, random = () => 0.5 }) {
  const clock = { t: 1_000_000_000_000 };
  const ran = [];
  const gates = [];
  const s = new Scheduler({
    now: () => clock.t, random, maxInFlight,
    people: () => people,
    sync: async (id) => { ran.push(id); if (results[id]?.hold) await new Promise((r) => { gates.push(r); }); return typeof results[id] === 'function' ? results[id]() : (results[id] || { ok: true }); },
    minute: async () => {},
  });
  return { s, clock, ran, gates };
}
const P = (id, o = {}) => ({ userId: id, googleState: 'ok', lastSeenAt: 1_000_000_000_000, detect: false, ...o });

test('only connected people are synced; first runs are staggered; then every 20 minutes with jitter', async () => {
  const people = [P('a'), P('b', { googleState: 'needs_auth' }), P('c', { googleState: 'expired' })];
  const { s, clock, ran } = srig({ people });
  await s.tick();
  assert.deepEqual(ran, [], 'nobody fires the instant the server starts');
  assert.ok(s.dueAt('a') > clock.t && s.dueAt('a') <= clock.t + 2 * MIN);
  assert.equal(s.dueAt('b'), null);
  clock.t += 2 * MIN; await s.tick();
  assert.deepEqual(ran, ['a']);
  const wait = s.dueAt('a') - clock.t;
  assert.ok(wait >= 18 * MIN && wait <= 22 * MIN, `next in ${wait / MIN} min`);
  clock.t += 17 * MIN; await s.tick();
  assert.equal(ran.length, 1);
  clock.t += 6 * MIN; await s.tick();
  assert.equal(ran.length, 2);
});

test('someone who has not opened the app for 14 days drops to every 6 hours', async () => {
  const idle = P('idle', { lastSeenAt: 1_000_000_000_000 - 15 * 86_400_000 });
  const { s, clock, ran } = srig({ people: [idle, P('active')] });
  await s.tick(); clock.t += 2 * MIN; await s.tick();
  assert.deepEqual(ran.sort(), ['active', 'idle']);
  const h = (id) => (s.dueAt(id) - clock.t) / 3_600_000;
  assert.ok(h('idle') > 5.3 && h('idle') < 6.7);
  assert.ok(h('active') < 0.4);
  // They come back: the next settle puts them on the short clock again.
  idle.lastSeenAt = clock.t;
  s.settle(idle, { ok: true });
  assert.ok(h('idle') < 0.4);
});

test('a 429 backs off that person only, by what Google asked; everyone else carries on', async () => {
  const people = [P('limited'), P('fine')];
  const results = { limited: () => ({ ok: false, code: 'rate_limited', nextInMs: 45 * MIN }) };
  const { s, clock, ran } = srig({ people, results });
  await s.tick(); clock.t += 2 * MIN; await s.tick();
  assert.deepEqual(ran.sort(), ['fine', 'limited']);
  assert.equal(s.backoffUntil('limited'), clock.t + 45 * MIN);
  assert.equal(s.backoffUntil('fine'), null);
  ran.length = 0;
  clock.t += 22 * MIN; await s.tick();
  assert.deepEqual(ran, ['fine'], 'the limited one is still waiting');
  clock.t += 24 * MIN; await s.tick();
  assert.deepEqual(ran.sort(), ['fine', 'fine', 'limited'].sort());
  // A failure of any other kind retries on the poller's own backoff, never sooner than a minute.
  s.settle(P('x'), { ok: false, code: 'network', nextInMs: 5 });
  assert.equal(s.dueAt('x'), clock.t + MIN);
  assert.equal(s.stats.failures, 3);
});

test('at most N in flight; a slow sync does not hold anybody\'s place twice', async () => {
  const people = ['a', 'b', 'c', 'd', 'e'].map((id) => P(id));
  const results = Object.fromEntries(people.map((p) => [p.userId, { hold: true, ok: true }]));
  const { s, clock, ran, gates } = srig({ people, results, maxInFlight: 2, random: () => 0 });
  const first = s.tick();
  await new Promise((r) => { setImmediate(r); });
  assert.equal(ran.length, 2);
  assert.equal(s.inFlight.size, 2);
  s.tick();   // nothing more may start while two are running
  await new Promise((r) => { setImmediate(r); });
  assert.equal(ran.length, 2);
  gates.splice(0).forEach((g) => g());
  await first;
  const second = s.tick();
  await new Promise((r) => { setImmediate(r); });
  assert.deepEqual(ran.length, 4);
  assert.equal(new Set(ran).size, 4, 'nobody twice');
  gates.splice(0).forEach((g) => g());
  await second;
  void clock;
});

/* ── tokens, through the app ──────────────────────────────────────── */

test('each person has their own token file, 0600, and nobody else\'s tokens', async () => {
  const r = await rig();
  try {
    const a = await r.person('tokena', { persona: 'fitbit' });
    const b = await r.person('tokenb', { persona: 'phone' });
    for (const p of [a, b]) {
      const f = join(r.config.dataDir, 'users', p.id, 'google.json');
      assert.equal(statSync(f).mode & 0o777, 0o600);
      const tok = JSON.parse(readFileSync(f, 'utf8'));
      assert.equal(tok.refresh, `demo-rt-${p.id}`);
      assert.ok(existsSync(join(r.config.dataDir, 'users', p.id, 'health.sqlite')));
    }
    assert.ok(!(await a.c.get('/api/me')).text.includes('demo-rt-'), 'the token never reaches the browser');
  } finally { await r.close(); }
});

test('the OAuth round trip is bound to the session that started it (PKCE + state)', async () => {
  const r = await rig();
  try {
    const p = await r.person('oauth');
    r.parts.personaOf.set(p.id, 'fitbit');
    assert.equal((await r.client().get('/auth/google/start')).headers.get('location'), '/', 'signed out: nowhere to go');
    const start = await p.c.get('/auth/google/start?return=/onboarding/google');
    const consent = new URL(start.headers.get('location'));
    assert.equal(consent.searchParams.get('redirect_uri'), 'https://health.test/auth/google/callback');
    assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(consent.searchParams.get('access_type'), 'offline');
    for (const s of ['activity_and_fitness.readonly', 'sleep.readonly', 'health_metrics_and_measurements.writeonly', 'activity_and_fitness.writeonly']) assert.ok(consent.searchParams.get('scope').includes(s), s);
    const back = new URL((await p.c.get(consent.pathname + consent.search)).headers.get('location'));
    const cb = back.pathname + back.search;
    // Somebody else (or a signed-out browser) carrying the same link connects nothing.
    const other = await r.person('thief');
    for (const who of [other.c, r.client()]) {
      const x = await who.get(cb);
      assert.match(x.headers.get('location'), /google=error&message=This\+sign-in\+link\+has\+expired/);
    }
    assert.equal((await other.c.get('/api/me')).json.google.state, 'needs_auth');
    // It was single use: the rightful owner has to start again too.
    assert.match((await p.c.get(cb)).headers.get('location'), /google=error/);
    const again = new URL((await p.c.get('/auth/google/start?return=/onboarding/google')).headers.get('location'));
    const back2 = new URL((await p.c.get(again.pathname + again.search)).headers.get('location'));
    const done = await p.c.get(back2.pathname + back2.search);
    assert.equal(done.headers.get('location'), '/onboarding/google?google=connected');
    await new Promise((res) => { setTimeout(res, 200); });
    const me = (await p.c.get('/api/me')).json;
    assert.deepEqual([me.google.state, !!me.sync.lastOk, me.caps.steps], ['ok', true, true]);
    // Cancel at Google, and an open redirect attempt.
    const s3 = new URL((await p.c.get('/auth/google/start?return=//evil.example/x')).headers.get('location'));
    const denied = await p.c.get(`/auth/google/callback?error=access_denied&state=${s3.searchParams.get('state')}`);
    assert.equal(denied.headers.get('location'), '/settings/connections?google=cancelled');
  } finally { await r.close(); }
});

test('a revoked or expired grant: that person is marked expired, told once, and nobody else is affected', async () => {
  const clock = { skew: 0 };
  const r = await rig({ now: () => Date.now() + clock.skew });
  try {
    const a = await r.person('revoked', { persona: 'fitbit' });
    const b = await r.person('healthy', { persona: 'fitbit' });
    await a.c.post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/revoked', keys: { p256dh: 'k', auth: 'a' } } });
    // Seven days on, Google refuses A's refresh token (the Testing-mode expiry).
    clock.skew = 7 * 86_400_000;
    r.wrap.fn = async (userId, url, init) => {
      if (userId === a.id && url.pathname === '/token' && String(init.body).includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return null;
    };
    const ra = await r.app.syncUser(a.id);
    assert.deepEqual([ra.ok, ra.code], [false, 'needs_auth']);
    const me = (await a.c.get('/api/me')).json;
    assert.deepEqual([me.google.state, me.google.testingExpiry, me.google.canWriteWorkouts], ['expired', true, false]);
    assert.ok(me.google.expiredAt > 0);
    assert.equal(r.app.app.profile(a.id).googleState, 'expired');
    assert.ok(!existsSync(join(r.config.dataDir, 'users', a.id, 'google.json')) || !JSON.parse(readFileSync(join(r.config.dataDir, 'users', a.id, 'google.json'), 'utf8')).refresh, 'the dead token is gone');
    // The history is still there, and the routes say what to do.
    assert.ok((await a.c.get('/api/data')).json.series.some((d) => d.steps > 0));
    const s = await a.c.post('/api/sync', {});
    assert.deepEqual([s.status, s.json.code], [409, 'needs_google']);
    await new Promise((res) => { setTimeout(res, 30); });
    assert.deepEqual(r.pushed.filter((x) => x.payload.type === 'connection').map((x) => x.payload.url), ['/settings/connections']);
    await r.app.syncUser(a.id);
    await new Promise((res) => { setTimeout(res, 30); });
    assert.equal(r.pushed.filter((x) => x.payload.type === 'connection').length, 1, 'said once');
    // The scheduler stops syncing them until they reconnect.
    assert.deepEqual(r.app.app.profiles().filter((p) => p.googleState === 'ok').map((p) => p.username), ['healthy']);
    // B is untouched.
    const rb = await r.app.syncUser(b.id);
    assert.equal(rb.ok, true);
    assert.equal((await b.c.get('/api/me')).json.google.state, 'ok');
  } finally { await r.close(); }
});

test('Google saying 429 to one person: their sync fails with Retry-After, their data stays, others sync', async () => {
  const r = await rig();
  try {
    const a = await r.person('limited', { persona: 'fitbit' });
    const b = await r.person('unlimited', { persona: 'fitbit' });
    r.wrap.fn = async (userId, url) => (userId === a.id && url.pathname.startsWith('/v4/') ? new Response('{}', { status: 429, headers: { 'retry-after': '1800' } }) : null);
    const ra = await r.app.syncUser(a.id);
    assert.deepEqual([ra.ok, ra.code, ra.retryAfter], [false, 'rate_limited', 1800]);
    assert.ok(ra.nextInMs >= 1800_000);
    r.app.scheduler.settle(r.app.app.profile(a.id), ra);
    const me = (await a.c.get('/api/me')).json;
    assert.equal(me.sync.lastError.code, 'rate_limited');
    assert.ok(me.sync.backoffUntil > Date.now() + 25 * MIN);
    assert.equal(me.google.state, 'ok', 'a rate limit is not a lost connection');
    assert.ok((await a.c.get('/api/data')).json.series.some((d) => d.steps > 0));
    assert.equal((await r.app.syncUser(b.id)).ok, true);
    assert.equal((await b.c.get('/api/me')).json.sync.backoffUntil, null);
  } finally { await r.close(); }
});

test('a 403 on one data type skips that stream; the rest of the sync is good', async () => {
  const r = await rig();
  try {
    const a = await r.person('forbidden');
    r.wrap.fn = async (userId, url) => (url.pathname.includes('/daily-heart-rate-variability/') ? new Response(JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }), { status: 403, headers: { 'content-type': 'application/json' } }) : null);
    const res = await r.connect(a.id, 'fitbit');
    assert.equal(res.ok, true);
    const me = (await a.c.get('/api/me')).json;
    assert.match(me.sync.streams.hrv.error, /insufficient authentication scopes/);
    assert.deepEqual([me.caps.hrv, me.caps.restingHr, me.caps.steps], [false, true, true]);
    assert.deepEqual((await a.c.get('/api/data')).json.readiness.used.includes('hrv'), false);
  } finally { await r.close(); }
});
