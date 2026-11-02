/* Circle goals, events and ranks (docs/CHALLENGES.md): targets from what
   members usually do, trophies at 50/75/100/150%, top contributors, races
   and events done together, and the weekly rating. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAppDb } from '../server/appdb.js';
import * as circles from '../server/circles.js';
import * as ch from '../server/challenges.js';
import { scoreOf, rankOf, ratingOf } from '../server/rating.js';
import { addDays } from '../server/core/util.js';

/* Ann, Ben and Cat in a circle since 1 Sep, Dan outside. Every day: steps, distance; Ben runs. */
function world() {
  const app = openAppDb(':memory:');
  for (const [id, n] of [['a', 'ann'], ['b', 'ben'], ['c', 'cat'], ['d', 'dan']]) app.createProfile({ userId: id, username: n, tz: 'UTC', now: 1 });
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const made = circles.create(app, 'a', { name: 'Crew' }, t0);
  for (const id of ['b', 'c']) app.run("INSERT INTO circle_member (circle_id, user_id, status, created_ms, updated_ms) VALUES (?, ?, 'member', ?, ?)", made.id, id, t0, t0);
  for (let d = '2026-09-01'; d <= '2026-11-30'; d = addDays(d, 1)) {
    for (const [id, steps] of [['a', 5000], ['b', 7000], ['c', 7000], ['d', 99_000]]) app.run('INSERT INTO daily_public (user_id, date, steps, distance_m) VALUES (?, ?, ?, ?)', id, d, steps, steps * 0.7);
  }
  return { app, id: made.id, c: () => circles.circleOf(app, made.id) };
}

test('goal targets: what the members counted usually do, for the goal\'s days, stretched, never under the floor', () => {
  const { app, id } = world();
  const members = circles.memberIds(app, id).map((u) => app.profile(u));
  // 19,000 steps a day between them, 7 days, 1.25: 166,250, up to two figures.
  assert.equal(ch.targetFor(app, 'steps', 'week', '2026-10-30', '2026-11-05', members), 170_000);
  // Nobody has gym time: the floor, 8 min a member a day.
  assert.equal(ch.targetFor(app, 'gym_time', 'week', '2026-10-30', '2026-11-05', members), 210);
  // A month: 30 days, 1.35.
  assert.equal(ch.targetFor(app, 'steps', 'month', '2026-11-01', '2026-11-30', members), 770_000);
});

test('goals: a week\'s and a month\'s made once, the measure in turn; trophies at 50, 75, 100 and 150%; kept when closed', () => {
  const { app, id, c } = world();
  const now = Date.parse('2026-11-03T10:00:00Z');
  ch.ensureGoals(app, c(), now); ch.ensureGoals(app, c(), now);
  const rows = app.all('SELECT kind, metric, start_date, end_date FROM circle_goal ORDER BY kind DESC');
  assert.deepEqual(rows.map((r) => [r.kind, r.start_date, r.end_date]), [['week', '2026-10-30', '2026-11-05'], ['month', '2026-11-01', '2026-11-30']]);
  // Make this week's about steps, at a target the numbers so far reach 75% of.
  const wk = app.get("SELECT * FROM circle_goal WHERE kind = 'week'");
  app.run("UPDATE circle_goal SET metric = 'steps', target = ? WHERE id = ?", (19_000 * 7) / 0.75, wk.id);
  let g = ch.goals(app, 'a', id, { now }).current.find((x) => x.kind === 'week');
  assert.equal(g.total, 133_000);
  assert.equal(g.tier, 'silver');
  assert.deepEqual(g.tiers.map((t) => [t.tier, t.reached]), [['bronze', true], ['silver', true], ['gold', false], ['platinum', false]]);
  assert.equal(g.next.tier, 'gold');
  assert.deepEqual(g.people.map((p) => [p.username, p.value, p.place]), [['ben', 49_000, 1], ['cat', 49_000, 1], ['ann', 35_000, 2]]);
  assert.throws(() => ch.goals(app, 'd', id, { now }), /no such circle/);
  // Cat keeps activity to friends: she is not counted, and is told why on her own view.
  app.patchProfile('c', { privacy: { ...app.profile('c').privacy, activity: 'friends' } });
  g = ch.goals(app, 'c', id, { now }).current.find((x) => x.kind === 'week');
  assert.deepEqual([g.people.map((p) => p.username), g.hidden], [['ben', 'ann'], true]);
  app.patchProfile('c', { privacy: { ...app.profile('c').privacy, activity: 'circles' } });

  // Not closed before the Friday after, 12:00 UTC, and two hours more.
  assert.deepEqual(ch.closeGoals(app, Date.parse('2026-11-06T13:00:00Z')), []);
  const notes = ch.closeGoals(app, Date.parse('2026-11-06T14:30:00Z'));
  const kept = app.get('SELECT * FROM circle_goal WHERE id = ?', wk.id);
  assert.deepEqual([kept.total, kept.tier, kept.counted], [133_000, 'silver', 3]);
  assert.deepEqual(notes.map((n) => [n.userId, n.note.title]).sort(), [['a', 'Crew won a silver trophy'], ['b', 'Crew won a silver trophy'], ['c', 'Crew won a silver trophy']]);
  assert.match(notes.find((n) => n.userId === 'b').note.body, /the top contributor/);
  // A closed goal is read from what was kept, whatever the numbers do after.
  app.run("UPDATE daily_public SET steps = 0 WHERE user_id = 'b'");
  const past = ch.goals(app, 'a', id, { now: Date.parse('2026-11-07T10:00:00Z') }).past.find((x) => x.id === wk.id);
  assert.deepEqual([past.closed, past.total, past.tier, past.people[0].username], [true, 133_000, 'silver', 'ben']);
  assert.deepEqual(ch.cabinet(app, id).trophies, { bronze: 0, silver: 1, gold: 0, platinum: 0 });
  // Honours: the trophy each helped win, and Ben's and Cat's place as the top contributors.
  const h = ch.honours(app, 'b', 'a');
  assert.deepEqual([h.trophies.silver, h.top.gold], [1, 1]);
  assert.equal(ch.honours(app, 'd', 'a'), null);
});

test('events: a race, first to finish every leg; together, the legs once each, pooled; who may start, join and call one off', () => {
  const { app, id } = world();
  const now = Date.parse('2026-11-02T09:00:00Z');
  // Ben runs 7 km a day, Cat 4 km, from 2 Nov.
  for (let d = '2026-11-02'; d <= '2026-11-30'; d = addDays(d, 1)) {
    app.run("UPDATE daily_public SET run_m = 7000 WHERE user_id = 'b' AND date = ?", d);
    app.run("UPDATE daily_public SET run_m = 4000 WHERE user_id = 'c' AND date = ?", d);
  }
  assert.throws(() => ch.createEvent(app, 'a', id, { kind: 'nope' }, now), /Pick an event/);
  assert.throws(() => ch.createEvent(app, 'a', id, { kind: 'marathon', days: 5 }, now), /7, 14 or 28/);
  assert.throws(() => ch.createEvent(app, 'd', id, { kind: 'marathon' }, now), /no such circle/);
  // A marathon race over a week: Ben has 42 km on day 6 (just short) and 49 on day 7, so he finishes on the last day.
  const r = ch.createEvent(app, 'b', id, { kind: 'marathon', mode: 'race', days: 7 }, now);
  assert.deepEqual([r.event.start, r.event.end, r.event.status, r.event.joined], ['2026-11-02', '2026-11-08', 'live', true]);
  assert.deepEqual(r.notes.map((n) => n.userId).sort(), ['a', 'c'], 'the others are told');
  const eid = r.event.id;
  ch.joinEvent(app, 'c', id, eid, now);
  ch.joinEvent(app, 'a', id, eid, now);
  let v = ch.event(app, 'a', id, eid, Date.parse('2026-11-09T10:00:00Z'));
  assert.deepEqual(v.people.map((p) => [p.username, p.finished, p.place, Math.round(p.pct)]), [['ben', '2026-11-08', 1, 100], ['cat', null, null, 66], ['ann', null, null, 0]]);
  // Somebody keeping workouts from circles cannot join.
  app.patchProfile('a', { privacy: { ...app.profile('a').privacy, workouts: 'friends' } });
  assert.equal(ch.event(app, 'a', id, eid, now).shareFirst, false, 'already in: no prompt');
  ch.leaveEvent(app, 'a', id, eid, now);
  assert.equal(ch.event(app, 'a', id, eid, now).shareFirst, true);
  assert.throws(() => ch.joinEvent(app, 'a', id, eid, now), /Share them with circles/);
  app.patchProfile('a', { privacy: { ...app.profile('a').privacy, workouts: 'everyone' } });

  // Together: a half marathon each, pooled: 3 people, 63.3 km between them.
  const t = ch.createEvent(app, 'c', id, { kind: 'half_marathon', mode: 'team', days: 7 }, now).event;
  ch.joinEvent(app, 'b', id, t.id, now); ch.joinEvent(app, 'a', id, t.id, now);
  v = ch.event(app, 'a', id, t.id, Date.parse('2026-11-09T10:00:00Z'));
  assert.equal(v.legs[0].need, 21_097 * 3);
  assert.deepEqual([v.team.done.run, v.team.complete], [77_000, true]);
  assert.deepEqual(v.people.map((p) => [p.username, p.place]), [['ben', 1], ['cat', 2], ['ann', null]]);
  // Only its starter or the owner calls one off; at most three on at once.
  assert.throws(() => ch.endEvent(app, 'b', id, t.id), /Only whoever started it/);
  ch.createEvent(app, 'a', id, { kind: 'ten_k' }, now);
  assert.throws(() => ch.createEvent(app, 'a', id, { kind: 'ten_k' }, now), /at most 3/);

  // Closed the day after the last, 12:00 UTC, two hours on: places kept, medals and finishes in honours.
  const notes = ch.closeEvents(app, Date.parse('2026-11-09T14:30:00Z'));
  assert.ok(notes.some((n) => n.userId === 'b' && n.note.title === 'You finished the Marathon, first'));
  assert.ok(notes.some((n) => n.userId === 'c' && n.note.title === 'Crew finished the Half marathon together'));
  assert.ok(notes.some((n) => n.userId === 'c' && /you did 66%/.test(n.note.title)));
  app.run("UPDATE daily_public SET run_m = 0 WHERE user_id = 'b'");
  v = ch.event(app, 'a', id, eid, Date.parse('2026-11-10T10:00:00Z'));
  assert.deepEqual([v.status, v.people[0].username, v.people[0].place, v.people[0].finished], ['done', 'ben', 1, '2026-11-08']);
  const h = ch.honours(app, 'b', 'a');
  assert.deepEqual([h.eventMedals.gold, h.finishes, h.events[0].circle.name], [2, 2, 'Crew']);
  assert.equal(ch.honours(app, 'b', 'd').events[0].circle, null, 'the circle is named only to people in it');
  assert.equal(ch.cabinet(app, id).events, 1);
  assert.throws(() => ch.endEvent(app, 'c', id, t.id), /over/);
});

test('rating: points per thing at par and capped at twice it; rank tiers and divisions; placed after two weeks, then 30% of the way each week', () => {
  assert.deepEqual(scoreOf({ steps: 70_000, active_min: 150, distance_m: 50_000, workout_min: 180 }).score, 1600);
  assert.equal(scoreOf({ steps: 700_000 }).score, 800, 'capped');
  assert.deepEqual([rankOf(0).name, rankOf(499).name, rankOf(500).name, rankOf(1000).name, rankOf(1100).name, rankOf(2100).name], ['Bronze I', 'Bronze III', 'Silver I', 'Gold I', 'Gold II', 'Champion']);
  assert.deepEqual(rankOf(1100).next, { name: 'Gold III', at: 1167, left: 67 });
  assert.equal(rankOf(1290).next.name, 'Platinum I');

  const app = openAppDb(':memory:');
  app.createProfile({ userId: 'a', username: 'ann', tz: 'UTC', now: 1 });
  const now = Date.parse('2026-11-03T10:00:00Z');   // this shared week: 30 Oct to 5 Nov
  assert.deepEqual([ratingOf(app, 'a', now).placed, ratingOf(app, 'a', now).weeksToPlace], [false, 2]);
  // Two weeks before: 10,000 steps a day (400 points a week), then 20,000 (800).
  for (let d = '2026-10-16'; d <= '2026-10-22'; d = addDays(d, 1)) app.run('INSERT INTO daily_public (user_id, date, steps) VALUES (?, ?, ?)', 'a', d, 10_000);
  for (let d = '2026-10-23'; d <= '2026-10-29'; d = addDays(d, 1)) app.run('INSERT INTO daily_public (user_id, date, steps) VALUES (?, ?, ?)', 'a', d, 20_000);
  const r = ratingOf(app, 'a', now);
  assert.deepEqual([r.placed, r.rating, r.delta, r.rank.name], [true, 520, 120, 'Silver I']);
  assert.deepEqual(r.history.map((h) => [h.week, h.score, h.rating]), [['2026-10-16', 400, 400], ['2026-10-23', 800, 520]]);
  // This week so far: nothing yet; on pace for nothing, so heading down.
  assert.ok(r.week.projected < r.rating);
});
