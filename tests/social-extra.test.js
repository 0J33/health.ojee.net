import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAppDb } from '../server/appdb.js';
import * as social from '../server/social.js';
import { standings, groupOf, placeOf, scoreOf, dayValues } from '../server/social-extra.js';
import { addDays } from '../server/core/util.js';
import { rig } from './helpers.mjs';

const NOW = Date.parse('2026-10-08T12:00:00Z');   // a Thursday
const mk = (app, userId, username, tz = 'UTC', privacy = {}) => {
  app.createProfile({ userId, username, tz, now: 1 });
  return app.patchProfile(userId, { privacy: { ...app.profile(userId).privacy, ...privacy } });
};
const put = (app, id, date, steps, wm = null) => app.run('INSERT INTO daily_public (user_id, date, steps, workouts, workout_min) VALUES (?, ?, ?, ?, ?)', id, date, steps, wm ? 1 : null, wm);
const THIS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
const LAST = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];

/* Ann, Ben and Cat are public. Dan's whole account is private and Eve keeps
   her activity private, yet both have rows lying around in the public table
   (as if the rewrite had not run yet): the read side must hide them alone. */
function board() {
  const app = openAppDb(':memory:');
  mk(app, 'a', 'ann'); mk(app, 'b', 'ben'); mk(app, 'c', 'cat');
  mk(app, 'd', 'dan', 'UTC', { account: 'private' }); mk(app, 'e', 'eve', 'UTC', { activity: false });
  for (const d of THIS) { put(app, 'a', d, 5000, 30); put(app, 'b', d, 4000); put(app, 'c', d, 2500); put(app, 'd', d, 90_000, 60); put(app, 'e', d, 80_000, 45); }
  for (const d of LAST) { put(app, 'a', d, 2000); put(app, 'b', d, 10_000); put(app, 'd', d, 90_000); put(app, 'e', d, 80_000); }
  return app;
}

/* ── pure ─────────────────────────────────────────────────────────── */

test('standings: previous rank among the people listed, places moved, the gap to the nearest higher value', () => {
  const e = (username, value, previous, rank) => ({ username, displayName: username, value, previous, rank });
  const rows = standings([e('a', 50, 10, 1), e('b', 40, 30, 2), e('c', 40, 30, 2), e('d', 10, null, 4)]);
  assert.deepEqual(rows.map((x) => [x.username, x.prevRank, x.move, x.gapToNext]), [['a', 3, 2, null], ['b', 1, -1, 10], ['c', 1, -1, 10], ['d', null, null, 30]]);
  const g = groupOf(rows);
  assert.deepEqual(g, { n: 4, median: 40, mean: 35, total: 140, best: 50 });
  assert.deepEqual(groupOf([]), { n: 0, median: null, mean: null, total: 0, best: null });
  assert.deepEqual(placeOf(rows, rows[1], g), { vsMedianPct: 0, ahead: { username: 'a', displayName: 'a', by: 10 }, behind: { username: 'd', displayName: 'd', by: 30 } }, 'somebody level with you is neither ahead nor behind');
  assert.deepEqual(placeOf(rows, rows[0], g), { vsMedianPct: 25, ahead: null, behind: { username: 'b', displayName: 'b', by: 10 } });
  assert.deepEqual(placeOf(rows, null, g), { vsMedianPct: null, ahead: null, behind: null });
  assert.deepEqual(scoreOf([{ a: 3, b: 1 }, { a: 1, b: 3 }, { a: 2, b: 2 }, { a: null, b: 9 }, { a: 4, b: null }, { a: 5, b: 1 }]), { a: 2, b: 1, ties: 1 });
  assert.throws(() => dayValues(openAppDb(':memory:'), 'a', 'rhr', '2026-10-01', '2026-10-02'), /not a public series/);
});

/* ── leaderboard ──────────────────────────────────────────────────── */

test('leaderboard: movement, sparkline, the group, and who is ahead of and behind you', () => {
  const app = board();
  const lb = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'b', now: NOW });
  assert.deepEqual(lb.entries.map((e) => [e.rank, e.username, e.value, e.prevRank, e.move, e.gapToNext]), [[1, 'ann', 20_000, 2, 1, null], [2, 'ben', 16_000, 1, -1, 4000], [3, 'cat', 10_000, null, null, 6000]]);
  assert.deepEqual(lb.entries[0].spark, [null, null, null, 5000, 5000, 5000, 5000]);
  assert.deepEqual(lb.entries[1].spark, [null, null, null, 4000, 4000, 4000, 4000]);
  assert.deepEqual(lb.group, { n: 3, median: 16_000, mean: 15_333, total: 46_000, best: 20_000 });
  assert.deepEqual(lb.me, { rank: 2, value: 16_000, previous: 40_000, trend: -60, listed: true, reason: null, vsMedianPct: 0, ahead: { username: 'ann', displayName: 'ann', by: 4000 }, behind: { username: 'cat', displayName: 'cat', by: 6000 } });
  assert.equal(social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'c', now: NOW }).me.behind, null);
  assert.equal(social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'c', now: NOW }).me.vsMedianPct, -37);
  // All time has no period before it: nobody moved.
  const all = social.leaderboard(app, { metric: 'steps', period: 'all', viewerId: 'b', now: NOW });
  assert.deepEqual(all.entries.map((e) => [e.username, e.prevRank, e.move]), [['ben', null, null], ['ann', null, null], ['cat', null, null]]);
  assert.equal(all.entries[0].spark.length, 7);
  // Today: the last seven days end on each person's own today.
  assert.deepEqual(social.leaderboard(app, { metric: 'steps', period: 'today', viewerId: 'b', now: NOW }).entries[0].spark.at(-1), 5000);
  // Workout time has its own column; sleep consistency has no daily series.
  assert.deepEqual(social.leaderboard(app, { metric: 'workout_time', period: 'week', viewerId: 'b', now: NOW }).entries.map((e) => [e.username, e.spark]), [['eve', [null, null, null, 45, 45, 45, 45]], ['ann', [null, null, null, 30, 30, 30, 30]]]);
  const sl = social.leaderboard(app, { metric: 'sleep_consistency', period: 'week', viewerId: 'b', now: NOW });
  assert.deepEqual([sl.entries, sl.group, sl.me.ahead, sl.me.vsMedianPct], [[], { n: 0, median: null, mean: null, total: 0, best: null }, null, null]);
});

test('PRIVACY, leaderboard: a private account or category is in no entry, spark, group, ahead or behind', () => {
  const app = board();
  for (const viewerId of ['a', 'b', 'c', 'd', 'e']) {
    for (const period of ['today', 'week', 'month', 'all']) {
      for (const metric of ['steps', 'active_minutes', 'distance']) {
        const lb = social.leaderboard(app, { metric, period, viewerId, now: NOW });
        // ("everyone", the scope, would match /eve/.)
        const text = JSON.stringify({ ...lb, scope: undefined });
        assert.ok(!/dan|eve/.test(text), `${metric}/${period} as ${viewerId}: ${text}`);
        assert.ok(lb.entries.every((e) => e.value < 80_000) && (lb.group.best ?? 0) < 80_000);
      }
      // Dan is private outright: not on the workouts boards either. Eve shares workouts, so she is.
      for (const metric of ['workouts', 'workout_time']) {
        const lb = social.leaderboard(app, { metric, period, viewerId, now: NOW });
        assert.ok(!JSON.stringify(lb).includes('dan'), `${metric}/${period} as ${viewerId}`);
      }
    }
  }
  // Their own row says why, and places them nowhere.
  const dan = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'd', now: NOW }).me;
  assert.deepEqual([dan.listed, dan.reason, dan.vsMedianPct, dan.ahead, dan.behind], [false, 'Your account is private', null, null, null]);
  const eve = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'e', now: NOW }).me;
  assert.deepEqual([eve.listed, eve.reason, eve.vsMedianPct, eve.ahead, eve.behind], [false, 'Your activity is private', null, null, null]);
});

/* ── compare ──────────────────────────────────────────────────────── */

test('compare: day-by-day series for the period, and who leads on how many metrics', () => {
  const app = board();
  const week = social.compare(app, { viewerId: 'a', username: 'ben', period: 'week', now: NOW });
  assert.deepEqual(Object.keys(week.series), ['steps', 'active_minutes', 'distance', 'workout_time', 'run_distance', 'ride_distance', 'walk_distance', 'gym_time']);
  assert.deepEqual(week.series.steps, { labels: THIS, a: [5000, 5000, 5000, 5000], b: [4000, 4000, 4000, 4000] });
  assert.deepEqual(week.series.workout_time, { labels: THIS, a: [30, 30, 30, 30], b: [null, null, null, null] }, 'shared, but nothing recorded: nulls, not a null side');
  assert.deepEqual(week.score, { a: 1, b: 0, ties: 0 }, 'only metrics both sides have a value for');
  const today = social.compare(app, { viewerId: 'a', username: 'ben', period: 'today', now: NOW }).series.steps;
  assert.deepEqual(today, { labels: ['2026-10-02', '2026-10-03', '2026-10-04', ...THIS], a: [null, null, null, 5000, 5000, 5000, 5000], b: [null, null, null, 4000, 4000, 4000, 4000] });
  const month = social.compare(app, { viewerId: 'a', username: 'ben', period: 'month', now: NOW }).series.steps;
  assert.deepEqual(month.labels, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', ...THIS]);
  assert.deepEqual(month.a, [2000, null, null, null, 5000, 5000, 5000, 5000]);
  const all = social.compare(app, { viewerId: 'a', username: 'ben', period: 'all', now: NOW }).series.steps;
  assert.equal(all.labels.length, 12);
  assert.deepEqual([all.labels[0], all.labels.at(-1)], ['2026-07-20', '2026-10-05']);
  assert.deepEqual(all.a.slice(-3), [null, 8000, 20_000]);
  assert.deepEqual(all.b.slice(-3), [null, 40_000, 16_000]);
  assert.deepEqual(social.compare(app, { viewerId: 'b', username: 'ann', period: 'all', now: NOW }).score, { a: 1, b: 0, ties: 0 });

  // Each side is its own person's days. Sunday 23:30 UTC: Auckland is on
  // Monday (a week one day old), Los Angeles still on Sunday (a full week).
  const now = Date.parse('2026-10-04T23:30:00Z');
  mk(app, 'nz', 'kiwi', 'Pacific/Auckland'); mk(app, 'la', 'angeleno', 'America/Los_Angeles');
  for (let d = '2026-09-28'; d <= '2026-10-04'; d = addDays(d, 1)) { put(app, 'nz', d, 10_000); put(app, 'la', d, 7000); }
  put(app, 'nz', '2026-10-05', 2000);
  const s = social.compare(app, { viewerId: 'nz', username: 'angeleno', period: 'week', now }).series.steps;
  assert.deepEqual(s.a, [2000, null, null, null, null, null, null]);
  assert.deepEqual(s.b, [7000, 7000, 7000, 7000, 7000, 7000, 7000]);
  assert.deepEqual([s.labels.length, s.labels[0]], [7, '2026-10-05'], 'labels are side a\'s dates');
});

test('PRIVACY, compare: a private category is a null side, yours included; a private account is no comparison', () => {
  const app = board();
  // Viewing Eve, who keeps activity private (her rows are still in the table).
  const v = social.compare(app, { viewerId: 'a', username: 'eve', period: 'week', now: NOW });
  for (const k of ['steps', 'active_minutes', 'distance']) {
    assert.equal(v.series[k].b, null, k);
    assert.ok(Array.isArray(v.series[k].a), `${k}: Ann's own side is still hers to show`);
  }
  assert.deepEqual(v.series.workout_time.b, [45, 45, 45, 45], 'she shares workouts');
  assert.equal(v.metrics.find((m) => m.metric === 'steps').b, null);
  assert.deepEqual(v.score, { a: 0, b: 1, ties: 1 }, 'workout time to Eve, workouts level; steps are not scored: one side is private');
  // Eve as side a: her own side is null too.
  const own = social.compare(app, { viewerId: 'e', username: 'ann', period: 'week', now: NOW });
  for (const k of ['steps', 'active_minutes', 'distance']) { assert.equal(own.series[k].a, null, k); assert.ok(Array.isArray(own.series[k].b)); }
  assert.deepEqual(own.series.steps.labels, THIS);
  for (const period of ['today', 'week', 'month', 'all']) {
    assert.ok(!JSON.stringify(social.compare(app, { viewerId: 'e', username: 'ann', period, now: NOW }).series.steps.a).includes('80000'));
    assert.equal(social.compare(app, { viewerId: 'a', username: 'eve', period, now: NOW }).series.steps.b, null, period);
    // Dan, private outright: nothing to compare with, and as the viewer every side of his is null.
    assert.equal(social.compare(app, { viewerId: 'a', username: 'dan', period, now: NOW }), null);
    const d = social.compare(app, { viewerId: 'd', username: 'ann', period, now: NOW });
    assert.ok(Object.values(d.series).every((x) => x.a === null), period);
    assert.ok(d.metrics.every((m) => m.a === null));
    assert.deepEqual(d.score, { a: 0, b: 0, ties: 0 });
  }
});

/* ── profile ──────────────────────────────────────────────────────── */

test('profile: the year, the last twelve weeks, the usual steps per weekday, and how long ago each record was', () => {
  const app = board();
  app.run('INSERT INTO records (user_id, kind, value, date) VALUES (?, ?, ?, ?)', 'a', 'best_day_steps', 5000, '2026-10-01');
  app.run('INSERT INTO daily_public (user_id, date, steps, distance_m) VALUES (?, ?, ?, ?)', 'a', '2026-08-10', 9000, 7000);
  app.run('INSERT INTO daily_public (user_id, date, steps) VALUES (?, ?, ?)', 'a', '2025-10-01', 99_000);   // more than a year ago
  const p = social.publicProfile(app, { username: 'ann', viewerId: 'b', now: NOW });
  assert.deepEqual(p.year, { activeDays: 9, steps: 37_000, distanceM: 7000, workouts: 4, workoutMin: 120, bestMonth: { month: '2026-10', steps: 22_000 } });
  assert.equal(p.weeks.length, 12);
  assert.deepEqual([p.weeks[0].week, p.weeks.at(-1)], ['2026-07-20', { week: '2026-10-05', steps: 20_000, activeMinutes: 0, workouts: 4, workoutMin: 120 }]);
  assert.deepEqual(p.weeks.at(-2), { week: '2026-09-28', steps: 8000, activeMinutes: 0, workouts: 0, workoutMin: 0 });
  assert.equal(p.weeks.find((w) => w.week === '2026-08-10').steps, 9000);
  // Monday to Wednesday: one day of each week. Thursday: last week's only (today is not over).
  assert.deepEqual(p.weekday, [5333, 3500, 3500, 2000, null, null, null]);
  assert.deepEqual(p.records, [{ kind: 'best_day_steps', label: 'Most steps in a day', value: 5000, unit: 'steps', date: '2026-10-01', daysAgo: 7 }]);
  assert.ok(!('vs' in p));
  // Somebody with nothing in the table at all: zeros, not a throw.
  mk(app, 'n', 'nobody');
  const n = social.publicProfile(app, { username: 'nobody', now: NOW });
  assert.deepEqual(n.year, { activeDays: 0, steps: 0, distanceM: 0, workouts: 0, workoutMin: 0, bestMonth: null });
  assert.deepEqual(n.weekday, [null, null, null, null, null, null, null]);
  assert.ok(n.weeks.length === 12 && n.weeks.every((w) => w.steps === 0 && w.workouts === 0));
});

test('PRIVACY, profile: a private category is null in the year, in every week and in the weekdays', () => {
  const app = board();
  for (const viewerId of ['a', 'e', null]) {
    const p = social.publicProfile(app, { username: 'eve', viewerId, now: NOW });
    assert.deepEqual(p.year, { activeDays: null, steps: null, distanceM: null, workouts: 4, workoutMin: 180, bestMonth: null }, `as ${viewerId}`);
    assert.ok(p.weeks.every((w) => w.steps === null && w.activeMinutes === null));
    assert.deepEqual([p.weeks.at(-1).workouts, p.weeks.at(-1).workoutMin], [4, 180]);
    assert.equal(p.weekday, null);
    assert.ok(!JSON.stringify(p).includes('80000'));
  }
  // The other way round: workouts private, activity shared.
  app.patchProfile('e', { privacy: { ...app.profile('e').privacy, activity: true, workouts: false } });
  const q = social.publicProfile(app, { username: 'eve', now: NOW });
  assert.deepEqual([q.year.workouts, q.year.workoutMin, q.year.steps], [null, null, 640_000]);
  assert.ok(q.weeks.every((w) => w.workouts === null && w.workoutMin === null));
  assert.equal(q.weekday.length, 7);
  // A private account is nothing at all, to anyone but its owner.
  assert.equal(social.publicProfile(app, { username: 'dan', viewerId: 'a', now: NOW }), null);
  assert.equal(social.publicProfile(app, { username: 'dan', now: NOW }), null);
});

/* ── through the app ──────────────────────────────────────────────── */

test('the three routes carry the new fields, and nobody else\'s own database is opened to answer them', async () => {
  const r = await rig();
  try {
    const ann = await r.person('ann', { persona: 'fitbit' });
    const ben = await r.person('ben', { persona: 'pixel', tz: 'Europe/London' });
    const eve = await r.person('eve', { persona: 'fitbit2', privacy: { activity: false } });
    const dan = await r.person('dan', { persona: 'phone', privacy: { account: 'private' } });
    await new Promise((res) => { setTimeout(res, 50); });
    // Every world shut: from here on, whatever is open was opened by a request.
    r.app.worlds.closeAll();
    const opened = () => [...r.app.worlds.map.keys()].sort();

    const lb = await ann.c.get('/api/leaderboard?metric=steps&period=week&scope=everyone');
    assert.equal(lb.status, 200);
    assert.equal(lb.json.scope, 'everyone');
    assert.deepEqual(lb.json.entries.map((e) => e.username).sort(), ['ann', 'ben']);
    for (const e of lb.json.entries) {
      for (const k of ['prevRank', 'move', 'spark', 'gapToNext']) assert.ok(k in e, k);
      assert.equal(e.spark.length, 7);
      assert.ok(e.spark.some((v) => v > 0));
    }
    assert.equal(lb.json.entries[0].gapToNext, null);
    assert.deepEqual(Object.keys(lb.json.group), ['n', 'median', 'mean', 'total', 'best']);
    assert.equal(lb.json.group.n, 2);
    assert.ok('vsMedianPct' in lb.json.me && 'ahead' in lb.json.me && 'behind' in lb.json.me);
    const other = lb.json.me.ahead || lb.json.me.behind;
    assert.equal(other.username, 'ben');
    assert.ok(other.by >= 0);
    assert.ok(!/eve|dan/.test(lb.text.replace('"everyone"', '')));
    assert.equal((await ann.c.get('/api/leaderboard?metric=sleep_consistency&period=week')).status, 200);

    const cmp = await ann.c.get('/api/compare?with=ben&period=week');
    assert.equal(cmp.status, 200);
    assert.deepEqual(Object.keys(cmp.json.series), ['steps', 'active_minutes', 'distance', 'workout_time', 'run_distance', 'ride_distance', 'walk_distance', 'gym_time']);
    const s = cmp.json.series.steps;
    assert.ok(s.labels.length >= 1 && s.labels.length <= 7 && s.a.length === s.labels.length && s.b.length === s.labels.length);
    assert.deepEqual(Object.keys(cmp.json.score), ['a', 'b', 'ties']);
    assert.ok(cmp.json.score.a + cmp.json.score.b + cmp.json.score.ties >= 1);
    for (const [period, n] of [['today', 7], ['all', 12]]) assert.equal((await ann.c.get(`/api/compare?with=ben&period=${period}`)).json.series.steps.labels.length, n, period);
    // Eve keeps activity private: her side is null whether she is looked at or looking.
    assert.equal((await ann.c.get('/api/compare?with=eve&period=week')).json.series.steps.b, null);
    assert.equal((await eve.c.get('/api/compare?with=ann&period=week')).json.series.steps.a, null);
    assert.ok(Array.isArray((await eve.c.get('/api/compare?with=ann&period=week')).json.series.steps.b));
    assert.equal((await ann.c.get('/api/compare?with=dan&period=week')).status, 404);

    const prof = await ann.c.get('/api/users/ben');
    assert.equal(prof.status, 200);
    assert.deepEqual(Object.keys(prof.json.year), ['activeDays', 'steps', 'distanceM', 'workouts', 'workoutMin', 'bestMonth']);
    assert.ok(prof.json.year.steps > 0 && prof.json.year.activeDays > 0 && /^\d{4}-\d{2}$/.test(prof.json.year.bestMonth.month));
    assert.equal(prof.json.weeks.length, 12);
    assert.deepEqual(Object.keys(prof.json.weeks[0]), ['week', 'steps', 'activeMinutes', 'workouts', 'workoutMin']);
    assert.equal(prof.json.weekday.length, 7);
    assert.ok(prof.json.weekday.some((v) => v > 0));
    assert.ok(prof.json.records.length > 0 && prof.json.records.every((x) => Number.isInteger(x.daysAgo) && x.daysAgo >= 0));
    const pe = (await ann.c.get('/api/users/eve')).json;
    assert.deepEqual([pe.year.steps, pe.year.activeDays, pe.year.distanceM, pe.year.bestMonth, pe.weekday], [null, null, null, null, null]);
    assert.ok(pe.weeks.every((w) => w.steps === null && w.activeMinutes === null));
    assert.equal((await ann.c.get('/api/users/dan')).status, 404);
    // Signed out: the same public profile, the same 404.
    const out = r.client();
    assert.equal((await out.get('/api/users/ben')).json.weeks.length, 12);
    assert.equal((await out.get('/api/users/eve')).json.year.steps, null);
    assert.equal((await out.get('/api/users/dan')).status, 404);

    // Ann and Eve asked; Ben's and Dan's stores were never opened for them.
    assert.deepEqual(opened(), [ann.id, eve.id].sort());
    assert.ok(!opened().includes(ben.id) && !opened().includes(dan.id));
  } finally { await r.close(); }
});
