import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { GoogleHealth, SCOPES, ROLLUP_CAP_14 } from '../server/core/google.js';
import { Sync, STREAMS, BACKFILL_DAYS } from '../server/core/sync.js';
import { synthFetch } from '../server/core/demo.js';
import { dashboard } from '../server/core/metrics.js';
import { today, addDays } from '../server/core/util.js';

const quiet = { warn: () => {} };

/** A connected client whose far end is the demo generator, with every
    request recorded. */
function rig({ scopes = Object.values(SCOPES), wrap } = {}) {
  const synth = synthFetch();
  const urls = [];
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(String(u));
    urls.push({ url, method: init.method || 'GET', body: init.body });
    if (wrap) { const r = await wrap(url, init); if (r) return r; }
    return synth(u, init);
  };
  const g = new GoogleHealth({ clientId: 'c', clientSecret: 's', redirectUri: 'r', fetchImpl });
  g.tok = { refresh: 'RT', access: 'AT', expiresAt: Number.MAX_SAFE_INTEGER, scopes };
  const db = openDb(':memory:');
  const s = new Sync({ google: g, db, gapMs: 0, log: quiet });
  return { g, db, s, urls };
}

test('a first run backfills every stream, and the pages have data in every panel', async () => {
  const { db, s, urls } = rig();
  const r = await s.run();
  s.stop();
  assert.equal(r.ok, true);
  for (const st of STREAMS.filter((x) => !x.group)) assert.ok(s.state.streams[st.key].at, `${st.key} read`);
  for (const st of STREAMS.filter((x) => x.group)) assert.equal(s.state.streams[st.key].skipped, 'group off', `${st.key} is not read: nobody switched its group on`);
  const t = today();
  const first = urls.find((u) => u.url.pathname.endsWith('daily-resting-heart-rate/dataPoints'));
  assert.equal(first.url.searchParams.get('filter'), `daily_resting_heart_rate.date >= "${addDays(t, -(BACKFILL_DAYS - 1))}"`);
  // Roll-ups never ask for more than the type allows: 14 days for the four
  // capped types (so total-calories goes in chunks), 90 for the rest (one call).
  for (const u of urls.filter((x) => x.url.pathname.endsWith(':dailyRollUp'))) {
    const { start, end } = JSON.parse(u.body).range;
    const span = (Date.UTC(end.date.year, end.date.month - 1, end.date.day) - Date.UTC(start.date.year, start.date.month - 1, start.date.day)) / 86_400_000;
    const type = u.url.pathname.split('/').at(-2);
    assert.ok(span >= 1 && span <= (ROLLUP_CAP_14.has(type) ? 14 : 90), `${type}: range of ${span} days`);
  }
  assert.equal(urls.filter((x) => x.url.pathname.endsWith('/total-calories/dataPoints:dailyRollUp')).length, 7, '90 days of calories in 14-day chunks');
  assert.equal(urls.filter((x) => x.url.pathname.endsWith('/steps/dataPoints:dailyRollUp')).length, 1, '90 days of steps in one call');
  const d = dashboard(db, { today: t, days: 30 });
  assert.ok(d.series.filter((x) => x.hrv !== null).length >= 29);
  assert.ok(d.sleep.nights.length >= 13);
  assert.ok(d.sleep.consistency);
  assert.ok(d.weight.latest);
  assert.ok(d.activity.exercises.length > 0);
  assert.equal(db.meta('device').name, 'Fitbit Air');
  assert.equal(d.readiness.level, 'easy', 'the demo opens on an easy day');
});

test('a second run is incremental: it reads from three days before the last good read', async () => {
  const { s, urls } = rig();
  await s.run();
  urls.length = 0;
  await s.run();
  s.stop();
  const t = today();
  const hrv = urls.find((u) => u.url.pathname.endsWith('daily-heart-rate-variability/dataPoints'));
  assert.equal(hrv.url.searchParams.get('filter'), `daily_heart_rate_variability.date >= "${addDays(t, -3)}"`);
  const sleep = urls.find((u) => u.url.pathname.endsWith('/sleep/dataPoints'));
  assert.equal(sleep.url.searchParams.get('filter'), `sleep.interval.end_time >= "${addDays(t, -3)}T00:00:00Z"`);
  assert.ok(urls.filter((u) => u.url.pathname.endsWith(':dailyRollUp')).length <= STREAMS.filter((x) => x.kind === 'rollup').length, 'one small roll-up per type');
});

test('a stream whose scope was not granted is skipped, not failed', async () => {
  const { s, urls } = rig({ scopes: [SCOPES.activity] });
  const r = await s.run();
  s.stop();
  assert.equal(r.ok, true);
  assert.equal(s.state.streams.sleep.skipped, 'scope not granted');
  assert.ok(!urls.some((u) => u.url.pathname.includes('/sleep/')));
  assert.ok(urls.some((u) => u.url.pathname.includes('/steps/')));
});

test('a 5xx on one stream does not stop the others, and the run backs off', async () => {
  const { s } = rig({ wrap: (url) => (url.pathname.includes('/exercise/') ? new Response('{"error":{"message":"boom"}}', { status: 503 }) : null) });
  const r = await s.run();
  s.stop();
  assert.equal(r.ok, false);
  assert.equal(s.state.streams.exercise.error, 'boom');
  assert.ok(s.state.streams.weight.at, 'streams after the failure still ran');
  assert.equal(s.state.failures, 1);
  assert.equal(s.nextDelay(r), 2 * 60_000);
  s.state.failures = 4;
  assert.equal(s.nextDelay(r), 16 * 60_000, 'doubling');
  s.state.failures = 40;
  assert.equal(s.nextDelay(r), 6 * 3_600_000, 'capped at six hours');
  assert.equal(s.nextDelay({ ok: true }), 20 * 60_000);
});

test('a 429 ends the run at once and waits at least Retry-After', async () => {
  const { s, urls } = rig({ wrap: (url) => (url.pathname.includes(':dailyRollUp') ? new Response('{}', { status: 429, headers: { 'retry-after': '900' } }) : null) });
  const r = await s.run();
  s.stop();
  assert.equal(r.code, 'rate_limited');
  assert.equal(urls.length, 1, 'nothing more was asked after the 429');
  assert.ok(s.nextDelay(r) >= 900_000);
});

test('not connected: no requests, and a long wait rather than a tight loop', async () => {
  const { g, s, urls } = rig();
  g.tok = null;
  const r = await s.run();
  s.stop();
  assert.equal(r.code, 'needs_auth');
  assert.equal(urls.length, 0);
  assert.equal(s.nextDelay(r), 6 * 3_600_000);
});

test('sync state survives a restart (it is kept in the store)', async () => {
  const { db, s, g } = rig();
  await s.run();
  s.stop();
  const again = new Sync({ google: g, db, gapMs: 0, log: quiet });
  assert.equal(again.state.lastOk, s.state.lastOk);
  assert.equal(again.state.streams.hrv.through, today());
});
