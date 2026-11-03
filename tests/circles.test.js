/* Circles (docs/CIRCLES.md): starting one, asking and inviting, the
   owner's powers, who sees whom, a circle's boards, and the weekly
   winners kept for good. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAppDb } from '../server/appdb.js';
import * as social from '../server/social.js';
import * as circles from '../server/circles.js';
import { lensOf } from '../server/audience.js';
import { addDays } from '../server/core/util.js';
import { rig, befriendAll } from './helpers.mjs';

const ok = (x) => { assert.equal(x.status, 200, `${x.status} ${x.text}`); return x.json; };

test('start, find, ask, accept; invite a friend; leave, remove, hand over, delete: through the API', async () => {
  const r = await rig();
  try {
    const own = await r.person('owner');
    const ann = await r.person('ann');
    const ben = await r.person('ben');
    const cat = await r.person('cat');
    r.befriend(own, ben);
    for (const p of [own, ann, ben]) await p.c.post('/api/push/subscribe', { subscription: { endpoint: `https://push.example/${p.username}`, keys: { p256dh: 'k', auth: 'a' } } });
    const wait = () => new Promise((res) => { setTimeout(res, 30); });

    for (const bad of [{ name: 'x' }, { name: 'x'.repeat(41) }, { name: 'Fine', join: 'open' }, { name: 'Fine', accent: 'red' }]) assert.equal((await own.c.post('/api/circles', bad)).status, 400, JSON.stringify(bad));
    const c = ok(await own.c.post('/api/circles', { name: '  Dawn   patrol ', about: 'Early miles.' }));
    assert.deepEqual([c.name, c.about, c.join, c.role, c.members, c.memberList.map((m) => m.username)], ['Dawn patrol', 'Early miles.', 'request', 'owner', 1, ['owner']]);
    const hidden = ok(await own.c.post('/api/circles', { name: 'Invite only', join: 'invite' }));
    assert.deepEqual((await own.c.get('/api/me')).json.circles.list.map((x) => x.name), ['Dawn patrol', 'Invite only']);

    // Ann finds the listed one (by a word of it), sees no members, and asks.
    const found = ok(await ann.c.get('/api/circles/browse?q=dawn')).circles;
    assert.deepEqual(found.map((x) => [x.name, x.members, x.status]), [['Dawn patrol', 1, null]]);
    // Every circle can be found (v158): an invitation-only one says so, and cannot be asked into.
    assert.deepEqual(ok(await ann.c.get('/api/circles/browse?q=invite')).circles.map((x) => [x.name, x.join]), [['Invite only', 'invite']]);
    const shut = ok(await ann.c.get(`/api/circles/${hidden.id}`));
    assert.ok(!('memberList' in shut), 'never who is in it, from outside');
    assert.equal((await ann.c.post(`/api/circles/${hidden.id}/join`, {})).status, 403);
    // Its link lets anybody in at once; only members can get it.
    assert.equal((await ann.c.get(`/api/circles/${hidden.id}/link`)).status, 403);
    const link = ok(await own.c.get(`/api/circles/${hidden.id}/link`));
    assert.equal(ok(await own.c.get(`/api/circles/${hidden.id}/link`)).code, link.code, 'the same link each time');
    assert.equal((await ann.c.post(`/api/circles/${hidden.id}/join`, { code: 'wrong' })).status, 403);
    assert.equal(ok(await ann.c.post(`/api/circles/${hidden.id}/join`, { code: link.code })).status, 'member');
    ok(await ann.c.post(`/api/circles/${hidden.id}/leave`, {}));
    const outside = ok(await ann.c.get(`/api/circles/${c.id}`));
    assert.ok(!('memberList' in outside) && !('owner' in outside), 'never who is in it, from outside');
    r.pushed.length = 0;
    assert.equal(ok(await ann.c.post(`/api/circles/${c.id}/join`, {})).status, 'pending');
    await wait();
    assert.deepEqual(r.pushed.map((x) => [x.endpoint.split('/').pop(), x.payload.title]), [['owner', 'ann asked to join Dawn patrol']]);
    assert.equal(ok(await own.c.get('/api/me')).circles.list.find((x) => x.id === c.id).waiting, 1);
    assert.deepEqual(ok(await ann.c.get('/api/circles')).requests.map((x) => x.name), ['Dawn patrol']);
    assert.equal((await ann.c.get(`/api/leaderboard?metric=steps&period=week&scope=circle:${c.id}`)).status, 404, 'not in yet: no board');
    // Only the owner says yes.
    assert.equal((await ann.c.post(`/api/circles/${c.id}/members/ann/accept`, {})).status, 403);
    const view = ok(await own.c.get(`/api/circles/${c.id}`));
    assert.deepEqual(view.pending.map((x) => x.username), ['ann']);
    r.pushed.length = 0;
    assert.equal(ok(await own.c.post(`/api/circles/${c.id}/members/ann/accept`, {})).status, 'member');
    await wait();
    assert.deepEqual(r.pushed.map((x) => [x.endpoint.split('/').pop(), x.payload.title]), [['ann', 'You are in Dawn patrol']]);

    // Invite: friends only. Ben accepts by joining.
    // Anybody can be invited by their username, not only friends; somebody outside the circle cannot invite.
    assert.equal((await cat.c.post(`/api/circles/${hidden.id}/invite`, { username: 'ben' })).status, 403);
    assert.equal(ok(await own.c.post(`/api/circles/${hidden.id}/invite`, { username: 'cat' })).status, 'invited');
    ok(await cat.c.post(`/api/circles/${hidden.id}/leave`, {}));
    assert.equal(ok(await own.c.post(`/api/circles/${hidden.id}/invite`, { username: 'ben' })).status, 'invited');
    assert.deepEqual(ok(await ben.c.get('/api/circles')).invites.map((x) => [x.name, x.by.username]), [['Invite only', 'owner']]);
    assert.equal((await ben.c.get(`/api/circles/${hidden.id}`)).status, 200, 'the invited can look');
    assert.equal(ok(await ben.c.post(`/api/circles/${hidden.id}/join`, {})).status, 'member');
    // Cat asks for the listed one; the owner says no; she can ask again.
    await cat.c.post(`/api/circles/${c.id}/join`, {});
    ok(await own.c.post(`/api/circles/${c.id}/members/cat/decline`, {}));
    assert.deepEqual(ok(await cat.c.get('/api/circles')).requests, []);

    // Members see each other (Ann and the owner are not friends) on the circle's board and profiles,
    // even with the owner's account private; Cat, outside, sees the face only.
    await own.c.patch('/api/settings', { privacy: { account: 'private' } });
    const members = ok(await ann.c.get(`/api/circles/${c.id}`)).memberList;
    assert.deepEqual(members.map((m) => [m.username, m.owner, m.friend]), [['owner', true, false], ['ann', false, false]]);
    assert.equal(ok(await ann.c.get('/api/users/owner')).limited, false);
    assert.equal(ok(await cat.c.get('/api/users/owner')).limited, true);

    // The owner cannot leave; hands it to Ann, then leaves; Ann removes nobody but can delete.
    assert.equal((await own.c.post(`/api/circles/${c.id}/leave`, {})).status, 409);
    assert.equal((await own.c.patch(`/api/circles/${c.id}`, { owner: 'cat' })).status, 404, 'the new owner must be in it');
    assert.equal(ok(await own.c.patch(`/api/circles/${c.id}`, { owner: 'ann', name: 'Dawn patrol II', join: 'invite' })).role, 'member');
    assert.equal((await own.c.patch(`/api/circles/${c.id}`, { name: 'Mine again' })).status, 403);
    ok(await own.c.post(`/api/circles/${c.id}/leave`, {}));
    assert.equal(ok(await ann.c.get(`/api/circles/${c.id}`)).name, 'Dawn patrol II');
    const gone = ok(await own.c.get(`/api/circles/${c.id}`));
    assert.deepEqual([gone.join, gone.status, 'memberList' in gone], ['invite', null, false], 'invite only now, and not in it: found, never who is in it');
    assert.equal((await ann.c.del(`/api/circles/${c.id}/members/ann`)).status, 409);
    ok(await ann.c.del(`/api/circles/${c.id}`));
    assert.equal((await ann.c.get(`/api/circles/${c.id}`)).status, 404);
    // Remove: the owner takes Ben out of the other one.
    ok(await own.c.del(`/api/circles/${hidden.id}/members/ben`));
    assert.deepEqual(ok(await ben.c.get('/api/circles')).circles, []);
  } finally { await r.close(); }
});

test('who sees whom, for a private account: circle-mates see the kinds set to circles (or everyone), never friends-only or me', () => {
  const app = openAppDb(':memory:');
  for (const [id, n] of [['a', 'ann'], ['b', 'ben'], ['c', 'cat']]) { app.createProfile({ userId: id, username: n, tz: 'UTC', now: 1 }); app.patchProfile(id, { onboarding: 'done' }); }
  app.patchProfile('b', { privacy: { account: 'private', activity: 'circles', workouts: 'friends', sleep: 'me', heart: 'everyone', body: 'me', feed: true } });
  const ab = () => lensOf(app, 'a');
  assert.equal(ab().knows(app.profile('b')), false);
  const made = circles.create(app, 'b', { name: 'Two of us' }, Date.parse('2026-10-01T00:00:00Z'));
  app.run("INSERT INTO circle_member (circle_id, user_id, status, created_ms, updated_ms) VALUES (?, 'a', 'member', 1, 1)", made.id);
  const L = ab();
  assert.equal(L.knows(app.profile('b')), true);
  assert.deepEqual(['activity', 'workouts', 'sleep', 'heart', 'body'].map((k) => L.sees(app.profile('b'), k)), [true, false, false, true, false]);
  // A request that is only pending is not membership.
  app.run("INSERT INTO circle_member (circle_id, user_id, status, created_ms, updated_ms) VALUES (?, 'c', 'pending', 1, 1)", made.id);
  assert.equal(lensOf(app, 'c').knows(app.profile('b')), false);
  // Friends see friends-only too.
  befriendAll(app, ['a', 'b']);
  assert.equal(lensOf(app, 'a').sees(app.profile('b'), 'workouts'), true);
});

/* A circle with steps in the public table: Ann, Ben and Cat in it, Dan outside. */
function world() {
  const app = openAppDb(':memory:');
  for (const [id, n] of [['a', 'ann'], ['b', 'ben'], ['c', 'cat'], ['d', 'dan']]) app.createProfile({ userId: id, username: n, tz: 'UTC', now: 1 });
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const made = circles.create(app, 'a', { name: 'Steppers' }, t0);
  for (const id of ['b', 'c']) app.run("INSERT INTO circle_member (circle_id, user_id, status, created_ms, updated_ms) VALUES (?, ?, 'member', ?, ?)", made.id, id, t0, t0);
  app.run('DELETE FROM circle_win'); app.run('DELETE FROM circle_week');
  // Every day from 1 Sep to 6 Nov: Ann 5000, Ben 7000 (9000 in the week from 16 Oct), Cat 7000, Dan 99000.
  for (let d = '2026-09-01'; d <= '2026-11-06'; d = addDays(d, 1)) {
    const ben = d >= '2026-10-16' && d <= '2026-10-22' ? 9000 : 7000;
    for (const [id, v] of [['a', 5000], ['b', ben], ['c', 7000], ['d', 99_000]]) app.run('INSERT INTO daily_public (user_id, date, steps) VALUES (?, ?, ?)', id, d, v);
  }
  return { app, id: made.id };
}

test('a circle\'s board: its members only, in the shared week; somebody keeping a kind to friends is not on it', () => {
  const { app, id } = world();
  const now = Date.parse('2026-11-02T10:00:00Z');
  const names = (viewer) => social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: viewer, scope: `circle:${id}`, now }).entries.map((e) => e.username);
  assert.deepEqual(names('a'), ['ben', 'cat', 'ann']);
  assert.throws(() => names('d'), /no such circle/, 'not a member: no board');
  // The viewer's own week does not apply in a circle: the shared one does.
  app.patchProfile('a', { boardWeek: 'own' });
  assert.equal(social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'a', scope: `circle:${id}`, now }).week.shared, true);
  // Cat's activity for friends only: off the circle's board for Ann, who is not her friend; on it for a friend.
  app.patchProfile('c', { privacy: { ...app.profile('c').privacy, activity: 'friends' } });
  assert.deepEqual(names('a'), ['ben', 'ann']);
  befriendAll(app, ['b', 'c']);
  assert.deepEqual(names('b'), ['ben', 'cat', 'ann']);
  assert.match(social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'c', scope: `circle:${id}`, now }).me.reason, /friends only, so this circle does not see it/);
});

test('weekly winners: kept once a week has closed (and settled), ties all win, only kinds the whole circle sees, a snapshot after people leave', () => {
  const { app, id } = world();
  const c = () => circles.circleOf(app, id);
  // Friday 23 Oct 2026, 12:00 UTC: the week of 16-22 Oct closed. Two hours later it is kept.
  const early = Date.parse('2026-10-23T13:00:00Z');
  assert.equal(circles.lastClosedWeek(early), '2026-10-09');
  const at = Date.parse('2026-10-23T14:30:00Z');
  assert.equal(circles.lastClosedWeek(at), '2026-10-16');
  const kept = circles.fillWeeks(app, c(), at);
  // Since the circle started (week of 28 Aug) and four weeks before it.
  assert.deepEqual([kept[0], kept.at(-1), kept.length], ['2026-07-31', '2026-10-16', 12]);
  assert.deepEqual(circles.fillWeeks(app, c(), at), [], 'each week once');
  const won = (week) => app.all('SELECT metric, user_id, value FROM circle_win WHERE circle_id = ? AND week = ? AND place = 1 ORDER BY metric, user_id', id, week).map((x) => [x.metric, x.user_id, x.value]);
  assert.deepEqual(won('2026-10-16'), [['steps', 'b', 63_000]], 'Ben alone');
  assert.deepEqual(won('2026-10-09'), [['steps', 'b', 49_000], ['steps', 'c', 49_000]], 'a tie: both');
  assert.deepEqual(won('2026-07-31'), [], 'nothing in the table then');
  // The hall of fame: newest first, the tally, faces.
  const h = circles.winners(app, 'a', id, { now: at });
  assert.deepEqual([h.weeks[0].week, h.weeks[0].to, h.weeks[0].winners[0].people.map((p) => p.username)], ['2026-10-16', '2026-10-22', ['ben']]);
  assert.deepEqual(h.tally.filter((t) => t.gold).map((t) => [t.username, t.wins]), [['ben', 8], ['cat', 7]]);
  // The podium: second and third with their medals, and a medal table by golds first.
  const steps = h.weeks[0].winners.find((w) => w.metric === 'steps');
  assert.deepEqual(steps.podium.map((p) => [p.tier, p.people.map((x) => x.username), p.value]), [['gold', ['ben'], 63_000], ['silver', ['cat'], 49_000], ['bronze', ['ann'], 35_000]]);
  const tie = h.weeks.find((w) => w.week === '2026-10-09').winners.find((w) => w.metric === 'steps');
  assert.equal(tie.podium[0].people.length, 2, 'a tie for first: both gold');
  assert.equal(tie.podium[1].tier, 'silver', 'the next value down is second');
  assert.deepEqual(Object.keys(h.tally[0]).filter((k) => ['gold', 'silver', 'bronze', 'medals'].includes(k)).sort(), ['bronze', 'gold', 'medals', 'silver']);
  assert.throws(() => circles.winners(app, 'd', id, { now: at }), /no such circle/);
  // Ben leaves: his wins stay; Cat keeps her activity to friends: she does not win the next week.
  app.run("DELETE FROM circle_member WHERE user_id = 'b'");
  app.patchProfile('c', { privacy: { ...app.profile('c').privacy, activity: 'friends' } });
  const next = Date.parse('2026-10-30T15:00:00Z');
  const notes = circles.closeWeeks(app, next);
  assert.deepEqual(won('2026-10-23'), [['steps', 'a', 35_000]]);
  assert.equal(circles.winners(app, 'a', id, { now: next }).tally.find((t) => t.username === 'ben').wins, 8);
  // Told: the winner of the week just closed, once.
  assert.deepEqual(notes.map((n) => [n.userId, n.note.title, n.note.url]), [['a', 'You won the week in Steps', `/circles/${id}/hall`]]);
  assert.deepEqual(circles.closeWeeks(app, next + 60_000), []);
  // A circle's board says who won last week, and each person's wins on it.
  const lb = circles.decorateBoard(app, social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'a', scope: `circle:${id}`, now: next }), { viewerId: 'a', scope: `circle:${id}`, now: next });
  assert.deepEqual([lb.lastWeek.week, lb.lastWeek.people.map((p) => p.username), lb.lastWeek.value], ['2026-10-23', ['ann'], 35_000]);
  assert.equal(lb.entries.find((e) => e.username === 'ann').wins, 1);
});

test('the Friends board says who won last week, worked out for the viewer', () => {
  const { app } = world();
  befriendAll(app, ['a', 'b', 'd']);
  const now = Date.parse('2026-10-24T10:00:00Z');
  const lb = circles.decorateBoard(app, social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'a', scope: 'friends', now }), { viewerId: 'a', scope: 'friends', now });
  assert.deepEqual([lb.lastWeek.week, lb.lastWeek.people.map((p) => p.username), lb.lastWeek.value], ['2026-10-16', ['dan'], 693_000]);
});

test('deleting the owner hands the circle on; deleting the last one in it deletes it', () => {
  const { app, id } = world();
  app.deleteUser('a');
  assert.equal(circles.circleOf(app, id).ownerId, 'b', 'the one in longest');
  const solo = circles.create(app, 'd', { name: 'Just me' }, Date.now());
  app.deleteUser('d');
  assert.equal(circles.circleOf(app, solo.id), null);
});

test('v123 privacy rows come back with the account switch: public as before v123, private where everything was kept', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'health-priv-'));
  try {
    const path = join(dir, 'app.sqlite');
    let app = openAppDb(path);
    for (const id of ['a', 'b', 'c']) app.createProfile({ userId: id, username: `u${id}`, tz: 'UTC', now: 1 });
    const set = (id, v) => app.run('UPDATE profile SET privacy = ? WHERE user_id = ?', JSON.stringify(v), id);
    set('a', { activity: 'circles', workouts: 'circles', sleep: 'friends', heart: 'me', body: 'me', feed: true });
    set('b', { activity: 'me', workouts: 'me', sleep: 'me', heart: 'me', body: 'me', feed: false });
    set('c', { account: 'public', activity: true, workouts: false, sleep: true, heart: false, body: false, feed: true });
    app.close();
    app = openAppDb(path);
    assert.deepEqual(app.profile('a').privacy, { account: 'public', activity: 'everyone', workouts: 'everyone', sleep: 'friends', heart: 'me', body: 'me', feed: true, presence: 'auto' });
    assert.deepEqual(app.profile('b').privacy, { account: 'private', activity: 'me', workouts: 'me', sleep: 'me', heart: 'me', body: 'me', feed: false, presence: 'auto' });
    assert.deepEqual(app.profile('c').privacy, { account: 'public', activity: 'everyone', workouts: 'me', sleep: 'everyone', heart: 'me', body: 'me', feed: true, presence: 'auto' });
    app.close();
    // Once: a choice made afterwards is not changed by the next start.
    app = openAppDb(path);
    app.patchProfile('a', { privacy: { ...app.profile('a').privacy, activity: 'circles' } });
    app.close();
    app = openAppDb(path);
    assert.equal(app.profile('a').privacy.activity, 'circles');
    app.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
