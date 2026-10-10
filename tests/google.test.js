import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleHealth, SCOPES } from '../server/core/google.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ojee-health-')), 'google.json');
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

/** A fake Google: records every call, answers from a handler. */
function fake(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
    calls.push({ url: u, method: init.method || 'GET', body, headers: init.headers || {} });
    return handler(u, init, body, calls);
  };
  f.calls = calls;
  return f;
}

const make = (o = {}) => new GoogleHealth({
  clientId: 'cid', clientSecret: 'shh', redirectUri: 'https://console.example/health/auth/callback', tokenFile: tmpFile(), ...o,
});

async function connect(g, extra = {}) {
  const u = new URL(g.authorizeUrl());
  return g.finishAuth({ code: 'the-code', state: u.searchParams.get('state'), ...extra });
}

test('authorizeUrl: offline + consent (refresh token), PKCE S256, read scopes + weight and workout write, a state', () => {
  const g = make();
  const u = new URL(g.authorizeUrl());
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://console.example/health/auth/callback');
  const scopes = u.searchParams.get('scope').split(' ');
  for (const s of Object.values(SCOPES)) assert.ok(scopes.includes(s), s);
  assert.ok(!scopes.some((s) => /writeonly/.test(s) && s !== SCOPES.weightWrite && s !== SCOPES.activityWrite), 'no write scope but weight and workouts');
  assert.ok(scopes.includes('https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly'));
  assert.ok(g.pending.has(u.searchParams.get('state')));
  assert.equal(u.searchParams.get('client_secret'), null, 'the secret never goes in a URL');
});

test('unconfigured: no client id/secret means no sign-in link', () => {
  const g = make({ clientSecret: '' });
  assert.equal(g.status().state, 'unconfigured');
  assert.throws(() => g.authorizeUrl(), /not set/);
});

test('finishAuth: exchanges with secret + verifier, stores the token 0600, and status() leaks no token', async () => {
  const f = fake((u, init, body) => json(200, {
    access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3599, token_type: 'Bearer',
    scope: `openid ${SCOPES.activity} ${SCOPES.sleep} https://www.googleapis.com/auth/userinfo.email`, id_token: idToken('me@example.com'),
  }));
  const g = make({ fetchImpl: f });
  const st = await connect(g);
  const call = f.calls[0];
  assert.equal(call.url.href, 'https://oauth2.googleapis.com/token');
  assert.equal(call.body.grant_type, 'authorization_code');
  assert.equal(call.body.client_secret, 'shh');
  assert.match(call.body.code_verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(statSync(g.tokenFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(g.tokenFile, 'utf8')).refresh, 'RT-1');
  assert.equal(st.state, 'ok');
  assert.equal(st.email, 'me@example.com');
  const wire = JSON.stringify(st);
  assert.ok(!wire.includes('RT-1') && !wire.includes('AT-1'), 'no token in status');
  assert.deepEqual(st.scopes.filter((s) => s.granted).map((s) => s.scope), ['activity_and_fitness.readonly', 'sleep.readonly']);
});

test('finishAuth: a forged state, and a reply without a refresh token, are refused', async () => {
  const g = make({ fetchImpl: fake(() => json(200, { access_token: 'a', expires_in: 3600 })) });
  await assert.rejects(g.finishAuth({ code: 'c', state: 'forged' }), /expired/);
  await assert.rejects(connect(g), /did not return a refresh token/);
});

test('access: refreshes only when within a minute of expiry; concurrent callers share one refresh', async () => {
  let now = 1_000_000;
  const f = fake((u, init, body) => {
    if (body?.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: SCOPES.activity });
    return json(200, { access_token: `AT-${f.calls.length}`, expires_in: 3600 });
  });
  const g = make({ fetchImpl: f, now: () => now });
  await connect(g);
  assert.equal(await g.access(), 'AT-1');
  assert.equal(f.calls.length, 1, 'no refresh while the token is fresh');
  now += 3600_000 - 30_000;
  const [a, b] = await Promise.all([g.access(), g.access()]);
  assert.equal(a, b);
  assert.equal(f.calls.length, 2, 'one refresh for two callers');
  assert.equal(f.calls[1].body.grant_type, 'refresh_token');
  assert.equal(f.calls[1].body.refresh_token, 'RT-1');
  assert.equal(f.calls[1].body.client_secret, 'shh');
  assert.equal(g.tok.refresh, 'RT-1', 'Google sent no new refresh token; the old one is kept');
  assert.equal(g.tok.lastRefreshAt, now);
});

test('invalid_grant at ~7 days: the token is dropped and the Testing-mode expiry is named', async () => {
  let now = 0;
  const f = fake((u, init, body) => (body.grant_type === 'authorization_code'
    ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: SCOPES.metrics, id_token: idToken('me@example.com') })
    : json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })));
  const g = make({ fetchImpl: f, now: () => now });
  await connect(g);
  now += 7 * 86_400_000 + 3_600_000;
  await assert.rejects(g.access(), (e) => e.code === 'needs_auth');
  const st = g.status();
  assert.equal(st.state, 'expired');
  assert.equal(st.testingExpiry, true);
  assert.equal(st.email, 'me@example.com', 'who it was is kept, to say who to reconnect');
  assert.equal(g.connected(), false);
  assert.ok(!readFileSync(g.tokenFile, 'utf8').includes('"RT"'), 'the dead token is not kept on disk');
});

test('invalid_grant after 2 days is a revocation, not the Testing limit', async () => {
  let now = 0;
  const f = fake((u, init, body) => (body.grant_type === 'authorization_code'
    ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: SCOPES.metrics })
    : json(400, { error: 'invalid_grant' })));
  const g = make({ fetchImpl: f, now: () => now });
  await connect(g);
  now += 2 * 86_400_000;
  await assert.rejects(g.access());
  assert.equal(g.status().testingExpiry, false);
});

test('a transient refresh failure keeps the refresh token and records the error', async () => {
  let now = 0;
  const f = fake((u, init, body) => (body.grant_type === 'authorization_code'
    ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    : json(503, { error: 'temporarily_unavailable' })));
  const g = make({ fetchImpl: f, now: () => now });
  await connect(g);
  now += 2 * 3_600_000;
  await assert.rejects(g.access());
  assert.equal(g.connected(), true);
  assert.equal(g.status().refreshError, 'temporarily_unavailable');
});

test('API calls: bearer token, a 401 refreshes once and retries, a 429 carries Retry-After', async () => {
  let n401 = 0;
  const f = fake((u, init, body) => {
    if (u.hostname === 'oauth2.googleapis.com') {
      return json(200, body.grant_type === 'authorization_code'
        ? { access_token: 'AT-old', refresh_token: 'RT', expires_in: 3600 }
        : { access_token: 'AT-new', expires_in: 3600 });
    }
    if (u.pathname.endsWith('/steps/dataPoints')) {
      if (init.headers.authorization === 'Bearer AT-old') { n401 += 1; return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }); }
      return json(200, { dataPoints: [{ steps: { count: '5' } }] });
    }
    return json(429, { error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '120' });
  });
  const g = make({ fetchImpl: f });
  await connect(g);
  const pts = await g.list('steps', { filter: 'steps.interval.start_time >= "2026-10-01T00:00:00Z"' });
  assert.equal(pts.length, 1);
  assert.equal(n401, 1);
  const listCall = f.calls.find((c) => c.url.pathname.endsWith('/steps/dataPoints') && c.headers.authorization === 'Bearer AT-new');
  assert.equal(listCall.url.origin + listCall.url.pathname, 'https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints');
  assert.equal(listCall.url.searchParams.get('filter'), 'steps.interval.start_time >= "2026-10-01T00:00:00Z"');
  await assert.rejects(g.pairedDevices(), (e) => e.code === 'rate_limited' && e.retryAfter === 120);
});

test('dailyRollUp posts a civil range with one-day windows and follows pages', async () => {
  const f = fake((u, init, body) => {
    if (u.hostname === 'oauth2.googleapis.com') return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    const b = JSON.parse(init.body);
    return json(200, b.pageToken ? { rollupDataPoints: [{ n: 2 }] } : { rollupDataPoints: [{ n: 1 }], nextPageToken: 'p2' });
  });
  const g = make({ fetchImpl: f });
  await connect(g);
  const out = await g.dailyRollUp('steps', '2026-09-28', '2026-10-08');
  assert.equal(out.length, 2);
  const c = f.calls.filter((x) => x.url.hostname === 'health.googleapis.com');
  assert.equal(c[0].url.pathname, '/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp');
  assert.equal(c[0].method, 'POST');
  assert.deepEqual(JSON.parse(c[0].body), { range: { start: { date: { year: 2026, month: 9, day: 28 } }, end: { date: { year: 2026, month: 10, day: 8 } } }, windowSizeDays: 1 });
});

test('a token file from a previous run is picked up; disconnect deletes and revokes it', async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ refresh: 'RT-saved', access: null, expiresAt: 0, scopes: [SCOPES.sleep], obtainedAt: 1 }));
  const f = fake(() => json(200, {}));
  const g = make({ tokenFile: file, fetchImpl: f });
  assert.equal(g.connected(), true);
  await g.disconnect();
  assert.equal(g.connected(), false);
  assert.equal(readFileSync(file, 'utf8'), 'null');
  assert.equal(f.calls[0].url.href, 'https://oauth2.googleapis.com/revoke');
  assert.equal(f.calls[0].body.token, 'RT-saved');
});
