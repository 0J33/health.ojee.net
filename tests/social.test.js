import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAppDb } from '../server/appdb.js';
import { openDb } from '../server/core/db.js';
import * as social from '../server/social.js';
import { addDays } from '../server/core/util.js';
import { rig } from './helpers.mjs';

/* A person's own store with a few weeks of everything. */
function store({ today, days = 30, steps = () => 9000, tz = 'UTC' }) {
  const db = openDb(':memory:');
  for (let i = 0; i < days; i += 1) {
    const d = addDays(today, -i);
    db.setDaily(d, 'steps', steps(i, d)); db.setDaily(d, 'azm', 25); db.setDaily(d, 'kcal', 2200); db.setDaily(d, 'distance_m', 6000);
    db.setDaily(d, 'rhr', 58); db.setDaily(d, 'hrv', 50); db.setDaily(d, 'body_fat', 19); db.setDaily(d, 'sleep_min', 430);
    const end = Date.parse(`${d}T05:00:00Z`) + (i % 3) * 20 * 60_000;
    db.upsertSleep({ id: `s${i}`, date: d, startMs: end - 7.5 * 3_600_000, endMs: end, startOff: 0, endOff: 0, main: true, asleepMin: 430, awakeMin: 20, periodMin: 450, stages: [], summary: { stages: {} } });
    db.upsertWeight({ t: Date.parse(`${d}T06:00:00Z`), grams: 77_000, off: 0 });
  }
  const start = Date.parse(`${addDays(today, -2)}T16:00:00Z`);
  db.workoutAdd({ status: 'done', source: 'logged', start, end: start + 50 * 60_000, created: start, updated: start, title: 'Evening lift', google: { state: 'local' }, prompts: {} });
  void tz;
  return db;
}
const mk = (app, userId, username, tz, privacy = {}) => {
  app.createProfile({ userId, username, tz, now: 1 });
  return app.patchProfile(userId, { privacy: { ...app.profile(userId).privacy, ...privacy } });
};
const NOW = Date.parse('2026-10-08T12:00:00Z');   // a Thursday
const row = (app, id, date) => app.get('SELECT * FROM daily_public WHERE user_id = ? AND date = ?', id, date);

test('privacy at write time: a private category is NULL in daily_public, a private account has no rows', () => {
  const app = openAppDb(':memory:');
  const db = store({ today: '2026-10-08' });
  let p = mk(app, 'u1', 'ann', 'UTC');   // defaults: activity + workouts public; sleep, heart, body private
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  let r = row(app, 'u1', '2026-10-07');
  assert.equal(r.steps, 9000); assert.equal(r.active_min, 25); assert.equal(r.distance_m, 6000);
  for (const k of ['sleep_min', 'bed_min', 'wake_min', 'rhr', 'hrv', 'weight_kg', 'body_fat']) assert.equal(r[k], null, k);
  assert.equal(row(app, 'u1', '2026-10-06').workouts, 1);
  assert.equal(app.all('SELECT * FROM public_workout WHERE user_id = ?', 'u1').length, 1);

  // Each category, switched on, appears; switched off again, is gone.
  p = app.patchProfile('u1', { privacy: { ...p.privacy, sleep: true, heart: true, body: true, activity: false, workouts: false } });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  r = row(app, 'u1', '2026-10-07');
  for (const k of ['steps', 'active_min', 'kcal', 'distance_m', 'workouts', 'workout_min']) assert.equal(r[k], null, k);
  assert.equal(r.sleep_min, 430); assert.equal(r.rhr, 58); assert.equal(r.hrv, 50); assert.equal(r.weight_kg, 77); assert.equal(r.body_fat, 19);
  assert.equal(app.all('SELECT * FROM public_workout WHERE user_id = ?', 'u1').length, 0);
  assert.ok(!app.all('SELECT kind FROM records WHERE user_id = ?', 'u1').some((x) => /steps|workout/.test(x.kind)), 'records follow their category');

  p = app.patchProfile('u1', { privacy: { ...p.privacy, account: 'private' } });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  for (const t of ['daily_public', 'public_workout', 'records']) assert.equal(app.get(`SELECT COUNT(*) AS n FROM ${t}`).n, 0, t);
});

test('privacy at read time: a stale public row is not shown once the flag is off', () => {
  const app = openAppDb(':memory:');
  const db = store({ today: '2026-10-08' });
  let p = mk(app, 'u1', 'ann', 'UTC', { sleep: true, heart: true, body: true });
  mk(app, 'u2', 'viewer', 'UTC');
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  assert.equal(social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'u2', now: NOW }).entries.length, 1);
  assert.ok(social.publicProfile(app, { username: 'ann', now: NOW }).sleep.avgMin7 > 0);
  // The flags change, but (say the rewrite has not run yet) the rows are still there.
  p = app.patchProfile('u1', { privacy: { ...p.privacy, activity: false, sleep: false, heart: false, body: false, workouts: false } });
  assert.ok(row(app, 'u1', '2026-10-07').steps > 0, 'the stale row exists');
  for (const metric of Object.keys(social.METRICS)) assert.equal(social.leaderboard(app, { metric, period: 'all', viewerId: 'u2', now: NOW }).entries.length, 0, metric);
  const prof = social.publicProfile(app, { username: 'ann', viewerId: 'u2', now: NOW });
  assert.deepEqual(prof.sections, { activity: false, workouts: false, sleep: false, heart: false, body: false });
  assert.equal(prof.sleep, null); assert.equal(prof.heart, null); assert.equal(prof.body, null); assert.equal(prof.device, null);
  assert.deepEqual(prof.records, []); assert.deepEqual(prof.recentWorkouts, []);
  assert.deepEqual(prof.streaks, { stepGoal: null, workoutWeeks: null });
  assert.ok(prof.heatmap.every((d) => d.steps === null && d.workouts === 0 && d.level === 0));
  assert.deepEqual(Object.values(prof.week.thisWeek), [null, null, null, null, null, null]);
  assert.ok(social.compare(app, { viewerId: 'u2', username: 'ann', period: 'week', now: NOW }).metrics.every((m) => m.b === null));
  // The whole account private, rows still lying around: no profile at all.
  app.patchProfile('u1', { privacy: { ...p.privacy, account: 'private' } });
  assert.equal(social.publicProfile(app, { username: 'ann', viewerId: 'u2', now: NOW }), null);
  assert.equal(social.compare(app, { viewerId: 'u2', username: 'ann', period: 'week', now: NOW }), null);
  assert.deepEqual(social.people(app, 'u2').map((x) => x.username), ['viewer']);
  assert.equal(social.publicProfile(app, { username: 'ann', viewerId: 'u1', now: NOW }).private, true, 'her own view still works');
});

test('periods are each person\'s own: today, Monday weeks and months in their zone', () => {
  // 2026-10-04 23:30 UTC, a Sunday night. In Auckland (+13) it is already
  // Monday the 5th, 12:30: a new week. In Los Angeles (-7) it is still
  // Sunday the 4th, 16:30: the old week's last day.
  const now = Date.parse('2026-10-04T23:30:00Z');
  assert.deepEqual(social.periodRange('today', 'Pacific/Auckland', now), { from: '2026-10-05', to: '2026-10-05', prev: { from: '2026-10-04', to: '2026-10-04' } });
  assert.deepEqual(social.periodRange('today', 'America/Los_Angeles', now).from, '2026-10-04');
  assert.deepEqual(social.periodRange('week', 'Pacific/Auckland', now), { from: '2026-10-05', to: '2026-10-05', prev: { from: '2026-09-28', to: '2026-09-28' } });
  assert.deepEqual(social.periodRange('week', 'America/Los_Angeles', now), { from: '2026-09-28', to: '2026-10-04', prev: { from: '2026-09-21', to: '2026-09-27' } });
  // Month: Kiritimati (+14) is on the 1st while UTC is still on the 30th.
  const eom = Date.parse('2026-09-30T11:00:00Z');
  assert.deepEqual(social.periodRange('month', 'Pacific/Kiritimati', eom), { from: '2026-10-01', to: '2026-10-01', prev: { from: '2026-09-01', to: '2026-09-01' } });
  assert.deepEqual(social.periodRange('month', 'UTC', eom), { from: '2026-09-01', to: '2026-09-30', prev: { from: '2026-08-01', to: '2026-08-30' } });
  // A 31-day month compared with a 30-day one never runs past its end.
  assert.deepEqual(social.periodRange('month', 'UTC', Date.parse('2026-10-31T12:00:00Z')).prev, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(social.periodRange('all', 'UTC', now).prev, null);

  const app = openAppDb(':memory:');
  mk(app, 'nz', 'kiwi', 'Pacific/Auckland'); mk(app, 'la', 'angeleno', 'America/Los_Angeles');
  const put = (id, date, steps) => app.run('INSERT INTO daily_public (user_id, date, steps) VALUES (?, ?, ?)', id, date, steps);
  // Both walked 10,000 a day all last week; kiwi has 2,000 so far this Monday.
  for (let d = '2026-09-28'; d <= '2026-10-04'; d = addDays(d, 1)) { put('nz', d, 10_000); put('la', d, 10_000); }
  put('nz', '2026-10-05', 2000);
  const week = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'la', now });
  // LA's week is the full old one; NZ's week is one morning old. Each is
  // ranked on its own week, not on a server-wide one.
  assert.deepEqual(week.entries.map((e) => [e.username, e.value, e.previous]), [['angeleno', 70_000, null], ['kiwi', 2000, 10_000]]);
  assert.equal(week.entries[1].trend, -80);
  assert.deepEqual([week.me.rank, week.me.listed], [1, true]);
  const today = social.leaderboard(app, { metric: 'steps', period: 'today', viewerId: 'nz', now });
  assert.deepEqual(today.entries.map((e) => [e.username, e.value]), [['angeleno', 10_000], ['kiwi', 2000]]);
  // A few hours later LA rolls into Monday too, with nothing yet: not listed.
  const later = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'la', now: now + 8 * 3_600_000 });
  assert.deepEqual(later.entries.map((e) => e.username), ['kiwi']);
  assert.deepEqual([later.me.listed, later.me.reason], [false, 'Nothing yet for this period']);
});

test('ranks: ties share a rank; trend is against the same span of the period before', () => {
  const app = openAppDb(':memory:');
  for (const [id, n] of [['a', 'ann'], ['b', 'ben'], ['c', 'cat']]) mk(app, id, n, 'UTC');
  const put = (id, date, steps, w = null, wm = null) => app.run('INSERT INTO daily_public (user_id, date, steps, workouts, workout_min) VALUES (?, ?, ?, ?, ?)', id, date, steps, w, wm);
  // Thursday 8 Oct: Mon-Thu this week against Mon-Thu last week.
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) { put('a', d, 5000, 1, 30); put('b', d, 5000); put('c', d, 2500); }
  for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']) { put('a', d, 4000); put('b', d, 10_000); }
  const lb = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'c', now: NOW });
  assert.deepEqual(lb.entries.map((e) => [e.rank, e.username, e.value, e.previous, e.trend]), [[1, 'ann', 20_000, 16_000, 25], [1, 'ben', 20_000, 40_000, -50], [3, 'cat', 10_000, null, null]]);
  assert.equal(lb.total, 3);
  const w = social.leaderboard(app, { metric: 'workout_time', period: 'week', viewerId: 'c', now: NOW });
  assert.deepEqual(w.entries.map((e) => [e.username, e.value]), [['ann', 120]]);
  assert.equal(w.unit, 'min');
});

test('sleep consistency: steadier nights score higher; fewer than three nights is no score', () => {
  const app = openAppDb(':memory:');
  mk(app, 'a', 'steady', 'UTC', { sleep: true }); mk(app, 'b', 'erratic', 'UTC', { sleep: true }); mk(app, 'c', 'newbie', 'UTC', { sleep: true });
  const put = (id, date, bed, wake) => app.run('INSERT INTO daily_public (user_id, date, sleep_min, bed_min, wake_min) VALUES (?, ?, 430, ?, ?)', id, date, bed, wake);
  ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].forEach((d, i) => { put('a', d, 690 + (i % 2) * 6, 420 + (i % 2) * 6); put('b', d, 600 + i * 70, 380 + i * 60); });
  put('c', '2026-10-08', 690, 420);
  const lb = social.leaderboard(app, { metric: 'sleep_consistency', period: 'week', viewerId: 'c', now: NOW });
  assert.deepEqual(lb.entries.map((e) => e.username), ['steady', 'erratic']);
  assert.ok(lb.entries[0].value > 90 && lb.entries[1].value < 60, JSON.stringify(lb.entries.map((e) => e.value)));
  assert.deepEqual(Object.keys(lb.entries[0].detail), ['nights', 'bedtimeOffMin', 'wakeOffMin']);
  assert.equal(lb.me.reason, 'Nothing yet for this period');
});

test('records and streaks: best day, best week, longest workout, step-goal and workout-week streaks', () => {
  const app = openAppDb(':memory:');
  // Goal 8000; met on the last 5 days, missed on the 6th back, met for 9 before that.
  const db = store({ today: '2026-10-08', days: 40, steps: (i) => (i === 5 ? 3000 : i === 20 ? 21_000 : i <= 14 ? 9000 : 6000) });
  const p = mk(app, 'u1', 'ann', 'UTC');
  social.recompute(app, { profile: p, db, settings: { stepTarget: 8000 }, now: NOW });
  const rec = Object.fromEntries(app.all('SELECT kind, value, date FROM records WHERE user_id = ?', 'u1').map((r) => [r.kind, r]));
  assert.deepEqual([rec.best_day_steps.value, rec.best_day_steps.date], [21_000, '2026-09-18']);
  assert.equal(rec.best_week_steps.date, '2026-09-14', 'the Monday of the best week');
  assert.deepEqual([rec.longest_workout.value, rec.longest_workout.date], [50, '2026-10-06']);
  assert.equal(rec.streak_steps_current.value, 5);
  assert.equal(rec.streak_steps_best.value, 9);
  assert.equal(rec.streak_weeks_current.value, 1);
  const prof = social.publicProfile(app, { username: 'ann', now: NOW });
  assert.deepEqual(prof.streaks, { stepGoal: { current: 5, best: 9 }, workoutWeeks: { current: 1, best: 1 } });
  assert.equal(prof.heatmap.length, 365);
  assert.equal(prof.heatmap.at(-1).date, '2026-10-08');
  assert.deepEqual(prof.heatmap.find((d) => d.date === '2026-10-06'), { date: '2026-10-06', level: 4, steps: 9000, workouts: 1 });
  assert.equal(prof.recentWorkouts[0].title, 'Evening lift');
});

test('a new record and an overtake are reported once, to the right people (through the app)', async () => {
  const r = await rig();
  try {
    const a = await r.person('ann', { persona: 'fitbit' });
    const b = await r.person('ben', { persona: 'phone' });
    for (const p of [a, b]) {
      await p.c.post('/api/push/subscribe', { subscription: { endpoint: `https://push.example/${p.username}`, keys: { p256dh: 'k', auth: 'a' } } });
      await p.c.put('/api/push/prefs', { types: { leaderboard: true, record: true } });
    }
    r.pushed.length = 0;
    // Ben has a huge day: a new best for Ben, and he passes Ann on the week.
    const wb = r.app.worlds.get(b.id);
    const today = Object.keys(wb.db.dailyTable('0000-00-00')).sort().at(-1);
    wb.db.setDaily(today, 'steps', 250_000);
    await r.app.publish(b.id);
    await new Promise((res) => { setTimeout(res, 30); });
    const got = r.pushed.map((x) => [x.endpoint.split('/').pop(), x.payload.type]);
    assert.deepEqual(got.sort(), [['ann', 'leaderboard'], ['ben', 'record'], ['ben', 'record']].sort());
    assert.match(r.pushed.find((x) => x.payload.type === 'leaderboard').payload.body, /ben passed you on this week's steps/);
    assert.equal(r.pushed.find((x) => x.payload.type === 'leaderboard').payload.url, '/ranks');
    // The same state again: nothing more is said.
    r.pushed.length = 0;
    await r.app.publish(b.id);
    await new Promise((res) => { setTimeout(res, 30); });
    assert.equal(r.pushed.length, 0);
  } finally { await r.close(); }
});

test('gym boards count strength sessions only; the workouts board counts walks too', async () => {
  const { isGym } = await import('../server/history.js');
  assert.equal(isGym({ local: null, ex: { type: 'STRENGTH_TRAINING' } }), true);
  assert.equal(isGym({ local: null, ex: { type: 'WEIGHTLIFTING' } }), true);
  assert.equal(isGym({ local: null, ex: { type: 'WALKING' } }), false);
  assert.equal(isGym({ local: null, ex: { type: 'RUNNING' } }), false);
  assert.equal(isGym({ local: { type: null }, ex: null }), true, 'logged here without a type: a strength workout');
  const app = openAppDb(':memory:');
  for (const [id, n] of [['a', 'ann'], ['b', 'ben']]) mk(app, id, n, 'UTC');
  const put = (id, date, w, wm, g, gm) => app.run('INSERT INTO daily_public (user_id, date, workouts, workout_min, gym_n, gym_min) VALUES (?, ?, ?, ?, ?, ?)', id, date, w, wm, g, gm);
  put('a', '2026-10-06', 3, 120, null, null);   // three walks
  put('b', '2026-10-06', 1, 60, 1, 60);         // one gym session
  assert.deepEqual(social.leaderboard(app, { metric: 'workouts', period: 'week', viewerId: 'a', now: NOW }).entries.map((e) => [e.username, e.value]), [['ann', 3], ['ben', 1]]);
  assert.deepEqual(social.leaderboard(app, { metric: 'gym', period: 'week', viewerId: 'a', now: NOW }).entries.map((e) => [e.username, e.value]), [['ben', 1]]);
  assert.deepEqual(social.leaderboard(app, { metric: 'gym_time', period: 'week', viewerId: 'a', now: NOW }).entries.map((e) => [e.username, e.value]), [['ben', 60]]);
});

test('the week starts on each person\'s own day: weekOf, and the week board counts everyone over the viewer\'s week', async () => {
  const { weekOf } = await import('../server/core/util.js');
  // Thursday 8 Oct 2026.
  assert.equal(weekOf('2026-10-08'), '2026-10-05', 'Monday by default');
  assert.equal(weekOf('2026-10-08', 0), '2026-10-04', 'Sunday');
  assert.equal(weekOf('2026-10-08', 6), '2026-10-03', 'Saturday');
  assert.equal(weekOf('2026-10-08', 4), '2026-10-08', 'Thursday: the day itself');
  assert.equal(weekOf('2026-10-04', 0), '2026-10-04');
  const app = openAppDb(':memory:');
  mk(app, 'a', 'mon', 'UTC'); mk(app, 'b', 'sat', 'UTC');
  app.patchProfile('b', { weekStart: 6 });
  assert.equal(app.profile('b').weekStart, 6);
  assert.equal(app.profile('a').weekStart, 1);
  // 1000 steps on each day from Saturday 3 to Thursday 8 October.
  for (const id of ['a', 'b']) for (let d = '2026-10-03'; d <= '2026-10-08'; d = addDays(d, 1)) app.run('INSERT INTO daily_public (user_id, date, steps) VALUES (?, ?, 1000)', id, d);
  // The Monday person sees everyone from Monday; the Saturday person sees everyone from Saturday.
  const lb = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'a', now: NOW });
  assert.deepEqual(lb.entries.map((e) => [e.username, e.value]).sort(), [['mon', 4000], ['sat', 4000]], 'Monday to Thursday for both');
  const lb2 = social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'b', now: NOW });
  assert.deepEqual(lb2.entries.map((e) => [e.username, e.value]).sort(), [['mon', 6000], ['sat', 6000]], 'Saturday to Thursday for both');
  const bs = social.boards(app, { period: 'week', viewerId: 'b', scope: 'everyone', now: NOW }).boards.find((x) => x.metric === 'steps');
  assert.equal(bs.leader.value, 6000);
});

test('PATCH /api/profile: week start, city and country, checked', async () => {
  const r = await rig({ now: () => NOW });
  try {
    const p = await r.person('placed');
    let x = await p.c.patch('/api/profile', { weekStart: 0, city: '  Alexandria ', country: 'EG' });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual([x.json.profile.weekStart, x.json.profile.city, x.json.profile.country], [0, 'Alexandria', 'EG']);
    for (const bad of [{ weekStart: 7 }, { weekStart: 1.5 }, { country: 'Egypt' }, { city: 'x'.repeat(61) }]) assert.equal((await p.c.patch('/api/profile', bad)).status, 400, JSON.stringify(bad));
    x = await p.c.patch('/api/profile', { city: null, country: null });
    assert.deepEqual([x.json.profile.city, x.json.profile.country], [null, null]);
  } finally { await r.close(); }
});

test('a workout kept as plain "Workout" counts as gym when the watch called the same session weight machines, or when it has sets', async () => {
  const { openDb } = await import('../server/core/db.js');
  const { unified, isGym, sessionType } = await import('../server/history.js');
  const db = openDb(':memory:');
  const t = Date.parse('2026-10-20T16:00:00Z');
  db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/w1', date: '2026-10-20', startMs: t, endMs: t + 60 * 60_000, type: 'WEIGHT_MACHINES', name: 'Weights' });
  const s = { local: { id: 1, type: 'WORKOUT' }, ex: null, twinType: 'WEIGHT_MACHINES', sets: 0 };
  assert.equal(sessionType(s), 'WEIGHT_MACHINES');
  assert.equal(isGym(s), true);
  assert.equal(isGym({ local: { id: 2, type: 'WORKOUT' }, ex: null, twinType: null, sets: 12 }), true, 'sets logged: a gym session');
  assert.equal(isGym({ local: { id: 3, type: 'WORKOUT' }, ex: null, twinType: null, sets: 0 }), false);
  assert.equal(isGym({ local: { id: 4, type: 'WALKING' }, ex: null, twinType: 'WEIGHT_MACHINES', sets: 0 }), false, 'its own specific type wins');
  assert.deepEqual(unified(db, 0).map((x) => x.ex?.type), ['WEIGHT_MACHINES']);
  db.close();
});

test('sleep consistency: one lie-in does not decide it, nobody irregular drops off, and a week without three nights uses the last 7', () => {
  const app = openAppDb(':memory:');
  mk(app, 'a', 'lier', 'UTC', { sleep: true }); mk(app, 'b', 'owl', 'UTC', { sleep: true }); mk(app, 'c', 'sunday', 'UTC', { sleep: true });
  app.patchProfile('c', { weekStart: 4 });   // a Thursday week: on Thursday 8 Oct it has one night, for everyone it looks at
  const put = (id, date, bed, wake) => app.run('INSERT INTO daily_public (user_id, date, sleep_min, bed_min, wake_min) VALUES (?, ?, 430, ?, ?)', id, date, bed, wake);
  // The same bed and wake every night, and one lie-in of four hours.
  for (const [i, d] of ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].entries()) {
    put('a', d, 660, i === 3 ? 660 : 420);
    put('b', d, 600 + i * 150, 300 + i * 160);   // all over the place
    put('c', d, 660, 420);
  }
  const lb = social.leaderboard(app, { metric: 'sleep_consistency', period: 'week', viewerId: 'a', now: NOW });
  const by = Object.fromEntries(lb.entries.map((e) => [e.username, e]));
  assert.ok(by.lier.value >= 95, `one lie-in: ${by.lier.value}`);
  assert.ok(by.owl && by.owl.value >= 1 && by.owl.value < 20, 'irregular, still on the board');
  assert.equal(by.sunday.value, 100);
  assert.equal(by.lier.detail.lastNights, undefined);
  // Seen by the Thursday-week person, everyone's week has one night: the last 7 nights for all.
  const thu = Object.fromEntries(social.leaderboard(app, { metric: 'sleep_consistency', period: 'week', viewerId: 'c', now: NOW }).entries.map((e) => [e.username, e]));
  assert.equal(thu.sunday.detail.lastNights, true, 'its week has one night: the last 7 nights');
  assert.equal(thu.lier.detail.lastNights, true);
});
