/* WHOOP (server/whoop.js): its records as this site's rows, the token
   refreshed (WHOOP's refresh token works once), pages and the rate limit,
   a pass into the WHOOP store and out of it again, the signed webhook, and
   through the routes: hidden when the server has no WHOOP app, the sign-in
   bound to the session, the data folded in, and disconnect removing it. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rig } from './helpers.mjs';
import { openDb } from '../server/core/db.js';
import { mergeAll } from '../server/core/merge.js';
import {
  WhoopApi, WhoopBudget, whoopExchange, whoopSigned, syncWhoop, whoopMeta, setWhoopMeta,
  fromSleep, fromRecovery, fromCycle, fromWorkout, whoopTypeOf, offsetSec, WHOOP_DAILY,
} from '../server/whoop.js';
import { METRICS, dailyKeysOf } from '../server/catalog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (t) => new Date(t).toISOString();
const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/* ── WHOOP's records, as the v2 API gives them ── */

function sleepRec(id, end, { hours = 8, nap = false, cycle = 1, perf = 91, state = 'SCORED' } = {}) {
  const start = end - hours * HOUR;
  return {
    id, cycle_id: cycle, user_id: 77, start: iso(start), end: iso(end), timezone_offset: '+02:00', nap, score_state: state, updated_at: iso(end),
    score: state !== 'SCORED' ? undefined : {
      stage_summary: { total_in_bed_time_milli: hours * HOUR, total_awake_time_milli: 30 * MIN, total_no_data_time_milli: 0, total_light_sleep_time_milli: (hours * 60 - 30 - 90 - 100) * MIN, total_slow_wave_sleep_time_milli: 90 * MIN, total_rem_sleep_time_milli: 100 * MIN, sleep_cycle_count: 4, disturbance_count: 9 },
      respiratory_rate: 15.234, sleep_performance_percentage: perf, sleep_consistency_percentage: 80, sleep_efficiency_percentage: 93.75,
    },
  };
}
const recoveryRec = (sleepId, cycle, { score = 66, rhr = 52, hrv = 61.37, spo2 = 96.4, temp = 33.6 } = {}) => ({
  cycle_id: cycle, sleep_id: sleepId, user_id: 77, created_at: iso(Date.now()), updated_at: iso(Date.now()), score_state: 'SCORED',
  score: { user_calibrating: false, recovery_score: score, resting_heart_rate: rhr, hrv_rmssd_milli: hrv, spo2_percentage: spo2, skin_temp_celsius: temp },
});
const cycleRec = (id, start, { strain = 12.34, kj = 10460, avg = 71, max = 168, steps = 9876 } = {}) => ({
  id, user_id: 77, start: iso(start), end: iso(start + DAY), timezone_offset: '+02:00', score_state: 'SCORED', step_count: steps,
  score: { strain, kilojoule: kj, average_heart_rate: avg, max_heart_rate: max },
});
const workoutRec = (id, start, { sport = 'running', minutes = 40, dist = 8000, kj = 2092 } = {}) => ({
  id, user_id: 77, start: iso(start), end: iso(start + minutes * MIN), timezone_offset: '+02:00', sport_name: sport, score_state: 'SCORED',
  score: { strain: 11.2, average_heart_rate: 151, max_heart_rate: 182, kilojoule: kj, percent_recorded: 100, distance_meter: dist, altitude_gain_meter: 12, altitude_change_meter: 1,
    zone_durations: { zone_zero_milli: 0, zone_one_milli: 2 * MIN, zone_two_milli: 4 * MIN, zone_three_milli: 10 * MIN, zone_four_milli: 20 * MIN, zone_five_milli: 4 * MIN } },
});

/**
 * A stand-in WHOOP: OAuth tokens (each refresh token works once, as WHOOP's
 * do), the four collections two records a page, profile and body, revoke.
 */
function fakeWhoop({ now = () => Date.now() } = {}) {
  const st = { sleeps: [], recoveries: [], cycles: [], workouts: [], codes: new Set(), refresh: new Map(), access: new Set(), revoked: 0, refreshed: 0, bodies: { height_meter: 1.81, weight_kilogram: 80.4, max_heart_rate: 191 }, remaining: 90, tokenBodies: [] };
  let n = 0;
  const issue = () => { n += 1; const a = `at-${n}`; const r = `rt-${n}`; st.access.add(a); st.refresh.set(r, true); return { access_token: a, refresh_token: r, expires_in: 3600, scope: 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement', token_type: 'bearer' }; };
  const approve = () => { const c = `code-${Math.random().toString(36).slice(2)}`; st.codes.add(c); return c; };
  const page = (list, u) => {
    const s = Date.parse(u.searchParams.get('start') || '1970-01-01'); const e = u.searchParams.get('end') ? Date.parse(u.searchParams.get('end')) : Infinity;
    const all = list.filter((x) => { const t = Date.parse(x.start || x.created_at); return t >= s && t <= e; });
    const at = Number(u.searchParams.get('nextToken') || 0);
    const records = all.slice(at, at + 2);
    return json({ records, next_token: at + 2 < all.length ? String(at + 2) : null }, { headers: { 'x-ratelimit-limit': '100, 100;window=60, 10000;window=86400', 'x-ratelimit-remaining': String(st.remaining), 'x-ratelimit-reset': '30' } });
  };
  async function fetch(u, init = {}) {
    u = new URL(String(u));
    if (u.pathname === '/oauth/oauth2/token') {
      const b = new URLSearchParams(String(init.body));
      st.tokenBodies.push(Object.fromEntries(b));
      if (b.get('client_id') !== 'whoop-id' || b.get('client_secret') !== 'whoop-secret') return json({ error: 'invalid_client' }, { status: 401 });
      if (b.get('grant_type') === 'authorization_code') {
        if (!st.codes.delete(b.get('code'))) return json({ error: 'invalid_grant' }, { status: 400 });
        return json(issue());
      }
      if (b.get('grant_type') === 'refresh_token') {
        if (!st.refresh.get(b.get('refresh_token'))) return json({ error: 'invalid_grant' }, { status: 400 });
        st.refresh.set(b.get('refresh_token'), false);   // used once
        st.refreshed += 1;
        return json(issue());
      }
      return json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    const tok = /^Bearer (.+)$/.exec(String(init.headers?.authorization || ''))?.[1];
    if (!st.access.has(tok)) return json({ message: 'unauthorized' }, { status: 401 });
    const p = u.pathname.replace(/^\/developer/, '');
    if (p === '/v2/user/access' && init.method === 'DELETE') { st.revoked += 1; st.access.clear(); st.refresh.clear(); return new Response(null, { status: 204 }); }
    if (p === '/v2/user/profile/basic') return json({ user_id: 77, email: 'w@example.com', first_name: 'Wanda', last_name: 'Hoop' });
    if (p === '/v2/user/measurement/body') return json(st.bodies);
    if (p === '/v2/activity/sleep') return page(st.sleeps, u);
    if (p === '/v2/activity/workout') return page(st.workouts, u);
    if (p === '/v2/cycle') return page(st.cycles, u);
    if (p === '/v2/recovery') return page(st.recoveries, u);
    let m;
    if ((m = /^\/v2\/activity\/sleep\/(.+)$/.exec(p))) { const x = st.sleeps.find((s) => s.id === m[1]); return x ? json(x) : json({}, { status: 404 }); }
    if ((m = /^\/v2\/activity\/workout\/(.+)$/.exec(p))) { const x = st.workouts.find((s) => s.id === m[1]); return x ? json(x) : json({}, { status: 404 }); }
    if ((m = /^\/v2\/cycle\/(\d+)\/recovery$/.exec(p))) { const x = st.recoveries.find((s) => String(s.cycle_id) === m[1]); return x ? json(x) : json({}, { status: 404 }); }
    return json({}, { status: 404 });
  }
  return { st, fetch, approve, tokens: () => { const t = issue(); return { access: t.access_token, refresh: t.refresh_token, expiresAt: now() + 3600_000 }; } };
}

/** A few days of one person's WHOOP, ending `now`. */
function seed(fk, now) {
  const end1 = now - 2 * DAY; const end2 = now - DAY;
  fk.st.sleeps.push(sleepRec('s-1', end1, { cycle: 11 }), sleepRec('s-2', end2, { cycle: 12, perf: 77 }), sleepRec('nap-1', end2 + 6 * HOUR, { hours: 1, nap: true, cycle: 12 }));
  fk.st.cycles.push(cycleRec(11, end1), cycleRec(12, end2, { strain: 15.01, steps: 12000 }));
  fk.st.recoveries.push({ ...recoveryRec('s-1', 11), created_at: iso(end1) }, { ...recoveryRec('s-2', 12, { score: 34, rhr: 58, hrv: 40.2 }), created_at: iso(end2) });
  fk.st.workouts.push(workoutRec('w-run', end1 + 3 * HOUR), workoutRec('w-sauna', end1 + 5 * HOUR, { sport: 'sauna', dist: 0 }), workoutRec('w-odd', end2 + 3 * HOUR, { sport: 'spikeball', dist: 0 }));
  return { end1, end2 };
}

/* ── the readers ── */

test('the readers: WHOOP\'s records become this site\'s rows, in the catalogue\'s own metric ids', () => {
  assert.deepEqual([offsetSec('+02:00'), offsetSec('-05:30'), offsetSec('Z'), offsetSec('nope')], [7200, -19800, 0, null]);
  const end = Date.UTC(2026, 10, 10, 4, 30);   // 06:30 in +02:00
  const s = fromSleep(sleepRec('abc', end));
  assert.equal(s.row.id, 'whoop-abc');
  assert.equal(s.date, '2026-11-10', 'dated by the morning woken, in WHOOP\'s own offset');
  assert.deepEqual(s.row.summary.stages, { DEEP: 90, LIGHT: 260, REM: 100, AWAKE: 30 });
  assert.deepEqual([s.row.asleepMin, s.row.awakeMin, s.row.periodMin, s.row.main, s.row.startOff], [450, 30, 480, true, 7200]);
  assert.deepEqual(s.night, { resp: 15.2, whoop_sleep_score: 91 });
  assert.equal(s.row.summary.deviceScore, 91);
  const nap = fromSleep(sleepRec('n', end, { hours: 1, nap: true }));
  assert.deepEqual([nap.row.main, nap.row.summary.nap, nap.night], [false, true, {}], 'a nap is no night of its own');
  assert.equal(fromSleep(sleepRec('p', end, { state: 'PENDING_SCORE' })), null, 'unscored: read again once WHOOP has scored it');

  const r = fromRecovery(recoveryRec('abc', 5));
  assert.deepEqual(r.metrics, { whoop_recovery: 66, rhr: 52, hrv: 61.4, spo2: 96.4, temp: 33.6 });
  assert.equal(r.sleepId, 'abc');
  assert.equal(fromRecovery({ ...recoveryRec('x', 1), score_state: 'PENDING_SCORE', score: null }), null);

  const c = fromCycle(cycleRec(9, Date.UTC(2026, 10, 10, 5)));
  assert.deepEqual(c, { id: 9, date: '2026-11-10', metrics: { steps: 9876, whoop_strain: 12.3, kcal: 2500, hr_avg: 71, hr_max: 168 } });

  const w = fromWorkout(workoutRec('w1', Date.UTC(2026, 10, 10, 15)));
  assert.equal(w.id, 'whoop-w1');
  assert.deepEqual([w.type, w.kcal, w.avgHr, w.distanceM, w.paceSecPerKm, w.device, w.name], ['RUNNING', 500, 151, 8000, 300, 'WHOOP', null]);
  assert.deepEqual(w.zones, { light: 6, moderate: 10, vigorous: 20, peak: 4 }, 'zones 1-2 are light, as Garmin\'s are');
  assert.equal(fromWorkout(workoutRec('s', Date.UTC(2026, 10, 10), { sport: 'sauna' })), null, 'a sauna is not a workout');
  const odd = fromWorkout(workoutRec('o', Date.UTC(2026, 10, 10), { sport: 'spikeball' }));
  assert.deepEqual([odd.type, odd.name], ['SPORT', null]);
  assert.deepEqual(['hiking/rucking', 'Track & Field', 'functional-fitness', 'spin', 'something new'].map((x) => whoopTypeOf(x)), ['HIKING', 'TRACK_AND_FIELD', 'FUNCTIONAL_STRENGTH_TRAINING', 'SPINNING', 'WORKOUT']);
  // Every number WHOOP's store writes is shown by some metric.
  const shown = new Set(METRICS.flatMap((m) => dailyKeysOf(m)));
  for (const k of WHOOP_DAILY) assert.ok(shown.has(k), `${k} is shown by a metric`);
});

/* ── the client ── */

test('the token is refreshed before it runs out, the new pair kept at once; a refused refresh is the connection lost', async () => {
  let t = Date.UTC(2026, 10, 10);
  const fk = fakeWhoop({ now: () => t });
  const first = fk.tokens();
  const kept = [];
  const api = new WhoopApi({ clientId: 'whoop-id', clientSecret: 'whoop-secret', tokens: { ...first, expiresAt: t + 2 * MIN }, onTokens: (x) => kept.push(x), fetchImpl: fk.fetch, urls: { api: 'https://whoop.test/developer', token: 'https://whoop.test/oauth/oauth2/token' }, now: () => t });
  const p = await api.profile();
  assert.equal(p.user_id, 77);
  assert.equal(fk.st.refreshed, 1, 'under five minutes left: refreshed first');
  const body = fk.st.tokenBodies.at(-1);
  assert.deepEqual([body.grant_type, body.refresh_token, body.scope], ['refresh_token', first.refresh, 'offline']);
  assert.equal(kept.length, 1);
  assert.notEqual(kept[0].refresh, first.refresh, 'the new refresh token kept: the old one works no more');
  assert.equal(kept[0].expiresAt, t + 3600_000);
  await api.profile();
  assert.equal(fk.st.refreshed, 1, 'a fresh token is used as it is');
  // An hour on: refreshed again, with the newest refresh token.
  t += 3600_000;
  await api.profile();
  assert.equal(fk.st.refreshed, 2);
  // The old refresh token alone: WHOOP refuses it, and that is the connection gone.
  const stale = new WhoopApi({ clientId: 'whoop-id', clientSecret: 'whoop-secret', tokens: { access: null, refresh: first.refresh, expiresAt: 0 }, fetchImpl: fk.fetch, urls: { api: 'https://whoop.test/developer', token: 'https://whoop.test/oauth/oauth2/token' }, now: () => t });
  await assert.rejects(stale.profile(), (e) => e.code === 'whoop_auth');
  // The code exchange: a refresh token is required (the offline permission).
  const ex = await whoopExchange({ clientId: 'whoop-id', clientSecret: 'whoop-secret', code: fk.approve(), redirectUri: 'https://x/cb', fetchImpl: fk.fetch, tokenUrl: 'https://whoop.test/oauth/oauth2/token', now: t });
  assert.ok(ex.tokens.refresh && ex.tokens.access);
  assert.equal(fk.st.tokenBodies.at(-1).redirect_uri, 'https://x/cb');
  await assert.rejects(whoopExchange({ clientId: 'whoop-id', clientSecret: 'whoop-secret', code: 'nope', redirectUri: 'x', fetchImpl: fk.fetch, tokenUrl: 'https://whoop.test/oauth/oauth2/token' }), (e) => e.code === 'whoop_auth');
});

test('pages are followed to the end; WHOOP\'s remaining count is kept, and a 429 stops everyone until its reset', async () => {
  let t = Date.UTC(2026, 10, 10);
  const fk = fakeWhoop({ now: () => t });
  for (let i = 0; i < 5; i += 1) fk.st.workouts.push(workoutRec(`w${i}`, t - (i + 1) * DAY));
  const budget = new WhoopBudget({ now: () => t });
  const api = new WhoopApi({ clientId: 'whoop-id', clientSecret: 'whoop-secret', tokens: fk.tokens(), budget, fetchImpl: fk.fetch, urls: { api: 'https://whoop.test/developer' }, now: () => t });
  const got = await api.list('workout', { start: t - 10 * DAY, end: t });
  assert.equal(got.records.length, 5);
  assert.equal(got.complete, true);
  assert.equal(api.calls, 3, 'two a page: three pages');
  assert.deepEqual([budget.view().remaining, budget.view().limit], [90, 100]);
  fk.st.remaining = 8;
  await api.list('workout', { start: t - 2 * DAY, end: t });
  assert.equal(budget.room(), false, 'nearly used up: passes stand aside');
  t += 31_000;
  assert.equal(budget.room(), true, 'after WHOOP\'s reset');
  const slow = new WhoopApi({ clientId: 'whoop-id', clientSecret: 'whoop-secret', tokens: fk.tokens(), budget, now: () => t, urls: { api: 'https://whoop.test/developer' },
    fetchImpl: async () => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '45' } }) });
  await assert.rejects(slow.profile(), (e) => e.code === 'rate_limited' && e.retryAfter === 45);
  assert.equal(budget.room(), false);
  await assert.rejects(api.profile(), (e) => e.code === 'rate_limited', 'everyone waits, without calling');
});

test('the webhook signature: WHOOP\'s HMAC of the timestamp and the body, recent, nothing else', () => {
  const body = Buffer.from('{"user_id":77,"id":"w1","type":"workout.updated"}');
  const ts = String(Date.UTC(2026, 10, 10));
  const sig = createHmac('sha256', 'whoop-secret').update(ts + body.toString()).digest('base64');
  const now = Number(ts) + MIN;
  assert.equal(whoopSigned({ secret: 'whoop-secret', signature: sig, timestamp: ts, body, now }), true);
  assert.equal(whoopSigned({ secret: 'other', signature: sig, timestamp: ts, body, now }), false);
  assert.equal(whoopSigned({ secret: 'whoop-secret', signature: sig, timestamp: ts, body: Buffer.from(`${body} `), now }), false);
  assert.equal(whoopSigned({ secret: 'whoop-secret', signature: sig, timestamp: ts, body, now: now + HOUR }), false, 'an old one is not taken again');
  assert.equal(whoopSigned({ secret: 'whoop-secret', signature: null, timestamp: ts, body, now }), false);
});

/* ── a pass ── */

test('a pass: the week into the WHOOP store, folded in; recovery dated by its sleep; what WHOOP deletes goes from both stores', async () => {
  const now = Date.now();
  const fk = fakeWhoop();
  const { end2 } = seed(fk, now);
  const main = openDb(':memory:'); const src = openDb(':memory:');
  setWhoopMeta(main, { connected: true, connectedAt: now });
  const mk = () => new WhoopApi({ clientId: 'whoop-id', clientSecret: 'whoop-secret', tokens: fk.tokens(), fetchImpl: fk.fetch, urls: { api: 'https://whoop.test/developer' } });
  const fold = () => mergeAll(main, [], { extra: [{ id: 'whoop', db: src, label: 'WHOOP', first: true }] });
  const out = await syncWhoop({ main, src, api: mk(), tz: 'Africa/Cairo', force: true });
  assert.equal(out.ok, true, out.message);
  assert.deepEqual([out.nights, out.workouts], [2, 2], 'two nights (the nap is a sleep, not a night), two workouts (no sauna)');
  fold();
  const d2 = new Date(end2 + 2 * HOUR).toISOString().slice(0, 10);
  const t = main.dailyTable('0000-00-00');
  assert.deepEqual([t[d2].whoop_recovery, t[d2].rhr, t[d2].hrv, t[d2].whoop_sleep_score, t[d2].resp], [34, 58, 40.2, 77, 15.2], 'the recovery on the morning of its sleep');
  assert.deepEqual([t[d2].whoop_strain, t[d2].steps, t[d2].kcal, t[d2].hr_max], [15, 12000, 2500, 168]);
  assert.equal(t[d2].sleep_min, 450, 'the night\'s sums worked out by the fold');
  assert.equal(t[d2].sleep_deep, 90);
  assert.ok(main.exercises('0000-00-00').some((e) => e.id === 'whoop-w-run' && e.type === 'RUNNING'));
  assert.equal(main.weights(0).length, 1, 'WHOOP\'s weight: one weigh-in');
  assert.equal(main.weights(0)[0].source, 'whoop');
  assert.equal(Object.values(t).find((x) => x.height_mm)?.height_mm, 1810);
  assert.equal(whoopMeta(main).body.maxHr, 191);
  assert.equal(whoopMeta(main).user.name, 'Wanda Hoop');
  assert.equal(main.meta('device')?.name, 'WHOOP');

  // Nothing new: nothing written again, and the weight is not weighed twice.
  const again = await syncWhoop({ main, src, api: mk(), tz: 'Africa/Cairo', force: true });
  assert.equal(again.wrote, 0);
  assert.equal(main.weights(0).length, 1);

  // Deleted on WHOOP: the night (and its recovery) and the run go, here and from the person's store.
  fk.st.sleeps = fk.st.sleeps.filter((s) => s.id !== 's-2');
  fk.st.recoveries = fk.st.recoveries.filter((r) => r.sleep_id !== 's-2');
  fk.st.workouts = fk.st.workouts.filter((w) => w.id !== 'w-run');
  const gone = await syncWhoop({ main, src, api: mk(), tz: 'Africa/Cairo', force: true });
  assert.ok(gone.removed >= 2);
  fold();
  const t2 = main.dailyTable('0000-00-00');
  assert.equal(t2[d2]?.whoop_recovery, undefined);
  assert.equal(t2[d2]?.sleep_min, undefined);
  assert.equal(t2[d2]?.whoop_strain, 15, 'the day\'s strain is the cycle\'s, which stays');
  assert.ok(!main.sleeps('0000-00-00').some((s) => s.id === 'whoop-s-2'));
  assert.ok(!main.exercises('0000-00-00').some((e) => e.id === 'whoop-w-run'));
});

test('a webhook\'s one record: in at once, or out at once', async () => {
  const now = Date.now();
  const fk = fakeWhoop();
  seed(fk, now);
  const main = openDb(':memory:'); const src = openDb(':memory:');
  setWhoopMeta(main, { connected: true, connectedAt: now });
  const api = new WhoopApi({ clientId: 'whoop-id', clientSecret: 'whoop-secret', tokens: fk.tokens(), fetchImpl: fk.fetch, urls: { api: 'https://whoop.test/developer' } });
  let r = await syncWhoop({ main, src, api, tz: 'Africa/Cairo', only: { type: 'workout.updated', id: 'w-run' } });
  assert.equal(r.workouts, 1);
  assert.equal(api.calls, 1, 'one call');
  r = await syncWhoop({ main, src, api, tz: 'Africa/Cairo', only: { type: 'recovery.updated', id: 's-1' } });
  assert.equal(r.nights, 1);
  const s1 = src.sleeps('0000-00-00').find((s) => s.id === 'whoop-s-1');
  assert.equal(src.dailyValue(s1.date, 'whoop_recovery'), 66, 'the sleep, then its cycle\'s recovery');
  mergeAll(main, [], { extra: [{ id: 'whoop', db: src, label: 'WHOOP', first: true }] });
  r = await syncWhoop({ main, src, api, tz: 'Africa/Cairo', only: { type: 'recovery.deleted', id: 's-1' } });
  assert.equal(src.dailyValue(s1.date, 'whoop_recovery'), null);
  assert.equal(main.dailyValue(s1.date, 'whoop_recovery'), null, 'from the person\'s store too');
  assert.ok(src.sleeps('0000-00-00').some((s) => s.id === 'whoop-s-1'), 'the sleep itself stays');
  await syncWhoop({ main, src, api, tz: 'Africa/Cairo', only: { type: 'workout.deleted', id: 'w-run' } });
  assert.equal(src.exercises('0000-00-00').length, 0);
  assert.equal(main.exercises('0000-00-00').length, 0);
});

/* ── through the routes ── */

test('no WHOOP app on the server: nothing is offered, and nothing breaks', async () => {
  const r = await rig();
  try {
    const p = await r.person('nowhoop');
    const me = (await p.c.get('/api/me')).json;
    assert.deepEqual([me.whoop.configured, me.whoop.connected, me.sources.any], [false, false, false]);
    const v = (await p.c.get('/api/whoop')).json;
    assert.deepEqual([v.configured, v.connected], [false, false]);
    const start = await p.c.get('/auth/whoop/start');
    assert.match(start.headers.get('location'), /whoop=error/);
    assert.equal((await p.c.post('/api/whoop/sync', {})).status, 409);
    assert.equal((await p.c.post('/api/whoop/webhook', {}, { origin: null })).status, 404);
    assert.equal(r.whoop.calls.length, 0, 'WHOOP is never called');
  } finally { await r.close(); }
});

test('connect, read, a signed webhook, and disconnect: WHOOP\'s grant given back and everything it brought removed', async () => {
  const r = await rig({ env: { WHOOP_CLIENT_ID: 'whoop-id', WHOOP_CLIENT_SECRET: 'whoop-secret' } });
  const fk = fakeWhoop();
  r.whoop.fn = (u, init) => fk.fetch(u, init);
  try {
    const now = Date.now();
    seed(fk, now);
    const p = await r.person('whooper');
    const other = await r.person('notme');
    const me0 = (await p.c.get('/api/me')).json;
    assert.deepEqual([me0.whoop.configured, me0.whoop.connected, me0.sources.any], [true, false, false]);
    // The sign-in: WHOOP's page with the scopes, the state bound to this session.
    const start = await p.c.get('/auth/whoop/start?return=/settings/connections/accounts/whoop');
    const to = new URL(start.headers.get('location'));
    assert.equal(to.origin + to.pathname, 'https://whoop.test/oauth/oauth2/auth');
    assert.equal(to.searchParams.get('redirect_uri'), 'https://health.test/auth/whoop/callback');
    assert.match(to.searchParams.get('scope'), /offline/);
    assert.ok(to.searchParams.get('state').length >= 8, 'WHOOP wants a state of eight characters or more');
    const stolen = await other.c.get(`/auth/whoop/callback?state=${to.searchParams.get('state')}&code=${fk.approve()}`);
    assert.match(stolen.headers.get('location'), /whoop=error/);
    assert.equal(r.app.app.secretRow(other.id, 'whoop'), null);
    const s2 = new URL((await p.c.get('/auth/whoop/start')).headers.get('location'));
    const back = await p.c.get(`/auth/whoop/callback?state=${s2.searchParams.get('state')}&code=${fk.approve()}`);
    assert.match(back.headers.get('location'), /whoop=connected/);
    const row = r.app.app.secretRow(p.id, 'whoop');
    assert.ok(row && !JSON.stringify(row).includes('rt-'), 'the tokens are sealed');
    // The first read (in the background), then a read on request.
    const sync = await p.c.post('/api/whoop/sync', {});
    assert.equal(sync.status, 200, sync.text);
    const v = (await p.c.get('/api/whoop')).json;
    assert.deepEqual([v.connected, v.user.name, v.counts.nights, v.counts.workouts], [true, 'Wanda Hoop', 2, 2]);
    assert.ok(!JSON.stringify(v).includes('at-') && !JSON.stringify(v).includes('rt-'), 'no token in a reply');
    const me = (await p.c.get('/api/me')).json;
    assert.deepEqual([me.whoop.connected, me.sources.any], [true, true], 'WHOOP alone is a source');
    const list = (await p.c.get('/api/workouts?limit=40')).json.history;
    const run = list.find((x) => x.source === 'whoop');
    assert.ok(run, 'WHOOP\'s run is in the workouts, as WHOOP\'s');
    await r.app.worlds.hold(p.id, (w) => { assert.ok(Object.values(w.db.dailyTable('0000-00-00')).some((x) => x.whoop_recovery === 66)); });

    // A webhook: unsigned is refused; signed, the workout deleted on WHOOP goes.
    const ev = JSON.stringify({ user_id: 77, id: 'w-odd', type: 'workout.deleted', trace_id: 't' });
    assert.equal((await p.c.call('POST', '/api/whoop/webhook', { raw: ev, origin: null, headers: { 'content-type': 'application/json' } })).status, 401);
    const ts = String(Date.now());
    const sig = createHmac('sha256', 'whoop-secret').update(ts + ev).digest('base64');
    const hook = await r.client().call('POST', '/api/whoop/webhook', { raw: ev, origin: null, headers: { 'content-type': 'application/json', 'x-whoop-signature': sig, 'x-whoop-signature-timestamp': ts } });
    assert.equal(hook.status, 200, hook.text);
    for (let i = 0; i < 50 && (await r.app.worlds.hold(p.id, (w) => w.whoopDb().exercises('0000-00-00').length)) > 1; i += 1) await new Promise((res) => { setTimeout(res, 20); });
    await r.app.worlds.hold(p.id, (w) => {
      assert.deepEqual(w.whoopDb().exercises('0000-00-00').map((e) => e.id), ['whoop-w-run']);
      assert.ok(!w.db.exercises('0000-00-00').some((e) => e.id === 'whoop-w-odd'));
    });

    // Disconnect: the grant given back, the tokens gone, and nothing of WHOOP's left.
    const off = await p.c.post('/api/whoop/disconnect', {});
    assert.equal(off.status, 200, off.text);
    assert.deepEqual([off.json.connected, off.json.counts.nights], [false, 0]);
    assert.equal(fk.st.revoked, 1);
    assert.equal(r.app.app.secretRow(p.id, 'whoop'), null);
    await r.app.worlds.hold(p.id, (w) => {
      const t = w.db.dailyTable('0000-00-00');
      for (const k of ['whoop_recovery', 'whoop_strain', 'whoop_sleep_score', 'hrv', 'rhr', 'sleep_min', 'kcal', 'height_mm']) assert.ok(!Object.values(t).some((x) => x[k] !== undefined), `${k} removed`);
      assert.equal(w.db.sleeps('0000-00-00').length, 0);
      assert.equal(w.db.exercises('0000-00-00').length, 0);
      assert.equal(w.db.weights(0).length, 0);
      assert.equal(w.whoopDb().sleeps('0000-00-00').length, 0);
    });
    const after = (await p.c.get('/api/me')).json;
    assert.deepEqual([after.whoop.connected, after.sources.any], [false, false]);
    // A webhook for them now finds nobody.
    assert.equal(r.app.app.meta('whoopUsers', {})['77'], undefined);
  } finally { await r.close(); }
});
