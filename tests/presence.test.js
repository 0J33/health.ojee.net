/* Who is here now, and who is working out (server/presence.js, GET /api/now). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { Presence, workoutNow, ONLINE_MS, ACT_MS } from '../server/presence.js';
import { presenceOn, normPrivacy } from '../server/audience.js';

test('presence: online for a while after a beat; a route until the beats stop; a workout from the log', () => {
  let t = 1_000_000_000;
  const p = new Presence({ now: () => t });
  assert.equal(p.get('a'), null);
  p.beat('a', { route: { type: 'RUNNING', start: t - 60_000, m: 812.4, ms: 55_000, paused: false } });
  assert.deepEqual(p.get('a'), { online: true, at: t, activity: { kind: 'route', type: 'RUNNING', start: t - 60_000, m: 812, paused: false, ms: 55_000 } });
  t += ONLINE_MS + 1;
  assert.equal(p.get('a').online, false);
  assert.equal(p.get('a').activity.kind, 'route');
  t += ACT_MS;
  assert.equal(p.get('a'), null);
  // A bad route is no route.
  p.beat('b', { route: { type: '<x>', start: 'soon' } });
  assert.equal(p.get('b').activity, null);
  // A workout stays while the phone is locked, and goes when the log says it ended.
  p.setWorkout('c', { start: t - 600_000, title: 'Push day', type: 'STRENGTH_TRAINING', doing: null, exercises: null, sets: null, restUntil: t + 30_000 });
  assert.equal(p.get('c').online, false);
  assert.equal(p.get('c').activity.title, 'Push day');
  assert.equal(p.get('c').activity.resting, true);
  t += 31_000;
  assert.equal(p.get('c').activity.resting, false);
  p.setWorkout('c', null);
  assert.equal(p.get('c'), null);
});

test('workoutNow: the exercise under way and its set', () => {
  const r = { start: 5, type: 'STRENGTH_TRAINING', draft: { routineTitle: 'Legs', exercises: [
    { name: 'Squat', sets: [{ done: true }, { done: true }, { done: true }] },
    { name: 'Lunge', sets: [{ done: true }, { done: false }, { done: false }] },
    { name: 'Calf raise', sets: [{ done: false }] },
  ] } };
  const w = workoutNow(r);
  assert.equal(w.title, 'Legs');
  assert.deepEqual(w.doing, { name: 'Lunge', set: 2, of: 3 });
  assert.equal(w.sets, 4);
  assert.equal(workoutNow(null), null);
  assert.equal(workoutNow({ start: 1, type: 'RUNNING' }, { titleFor: () => 'Run' }).title, 'Run');
});

test('the setting: on by default for a public account, off for a private one, either way once chosen', () => {
  assert.equal(presenceOn({ privacy: normPrivacy({}) }), true);
  assert.equal(presenceOn({ privacy: normPrivacy({ account: 'private' }) }), false);
  assert.equal(presenceOn({ privacy: normPrivacy({ presence: false }) }), false);
  assert.equal(presenceOn({ privacy: normPrivacy({ account: 'private', presence: true }) }), true);
});

let r; let ann; let bob; let cy;
before(async () => {
  r = await rig();
  ann = await r.person('ann');
  bob = await r.person('bob');
  cy = await r.person('cy', { privacy: { account: 'private' } });
});
after(() => r.close());

test('GET /api/now: who others may see, what they are doing, and nobody who turned it off', async () => {
  const start = Date.now() - 120_000;
  assert.equal((await ann.c.post('/api/presence', { route: { type: 'RUNNING', start, m: 400, ms: 110_000 } })).status, 200);
  await cy.c.post('/api/presence', {});
  const seen = await bob.c.get('/api/now');
  assert.equal(seen.status, 200);
  const a = seen.json.people.find((p) => p.username === 'ann');
  assert.equal(a.online, true);
  assert.deepEqual({ kind: a.activity.kind, type: a.activity.type, m: a.activity.m }, { kind: 'route', type: 'RUNNING', m: 400 });
  assert.equal(a.bpm, null);   // her heart is hers
  // Private, and not a friend: not there at all. Nor is one's own self.
  assert.ok(!seen.json.people.some((p) => p.username === 'cy' || p.username === 'bob'));
  assert.equal(seen.json.me.shown, true);
  // Yourself, first in the strip, as friends see you.
  const mine = (await ann.c.get('/api/now')).json.self;
  assert.equal(mine.username, 'ann');
  assert.equal(mine.activity.kind, 'route');
  assert.equal((await ann.c.get('/api/users/ann')).json.now.activity.kind, 'route');
  // Her workouts kept to herself: only that she is working out.
  await ann.c.patch('/api/settings', { privacy: { workouts: 'me' } });
  const half = (await bob.c.get('/api/now')).json.people.find((p) => p.username === 'ann');
  assert.deepEqual(Object.keys(half.activity).sort(), ['kind', 'paused', 'start']);
  // Turned off: gone, and from her profile too.
  await ann.c.patch('/api/settings', { privacy: { presence: false } });
  assert.ok(!(await bob.c.get('/api/now')).json.people.some((p) => p.username === 'ann'));
  assert.equal((await bob.c.get('/api/users/ann')).json.now, null);
  assert.equal((await ann.c.patch('/api/settings', { privacy: { presence: 'maybe' } })).status, 400);
  await ann.c.patch('/api/settings', { privacy: { presence: true } });
  assert.equal((await bob.c.get('/api/users/ann')).json.now.online, true);
  // Signed out: nothing.
  assert.equal((await r.client().get('/api/now')).status, 401);
});

test('a running workout shows from the log: started, the set under way, ended', async () => {
  const s = await bob.c.post('/api/workouts/start', { log: true });
  assert.equal(s.status, 200);
  const id = s.json.started;
  assert.ok(id);
  const seen = () => ann.c.get('/api/now').then((x) => x.json.people.find((p) => p.username === 'bob'));
  assert.equal((await seen()).activity.kind, 'workout');
  assert.equal((await bob.c.put(`/api/workouts/${id}/draft`, { exercises: [{ name: 'Bench Press', sets: [{ kg: 60, reps: 8, done: true }, { kg: 60, reps: 8 }] }] })).status, 200);
  assert.deepEqual((await seen()).activity.doing, { name: 'Bench Press', set: 2, of: 2 });
  await bob.c.post(`/api/workouts/${id}/dismiss`, {});
  assert.equal((await seen())?.activity ?? null, null);
});
