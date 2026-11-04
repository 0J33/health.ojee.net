import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { forgetBests } from '../server/besttimes.js';

/* Best times beside somebody else's: fair both ways, times only. */

let r; let ann; let ben; let cat; let dan;
const run = (w, date, min, m, id) => w.db.upsertExercise({ id: `users/me/dataTypes/exercise/dataPoints/${id}`, date, startMs: Date.parse(`${date}T07:00:00Z`), endMs: Date.parse(`${date}T07:00:00Z`) + min * 60_000, type: 'RUNNING', name: 'Secret route run', distanceM: m, activeSec: min * 60 });

before(async () => {
  r = await rig();
  ann = await r.person('ann', { privacy: { workouts: 'friends' } });
  ben = await r.person('ben', { privacy: { workouts: 'friends' } });
  cat = await r.person('cat', { privacy: { workouts: 'me' } });          // keeps hers to herself
  dan = await r.person('dan', { privacy: { workouts: 'friends' } });     // public, but not a friend of ann's
  r.befriend(ann, ben, cat);
  await r.app.worlds.hold(ann.id, async (w) => { run(w, '2026-09-01', 32, 5020, 'a1'); run(w, '2026-09-15', 30, 5040, 'a2'); });
  await r.app.worlds.hold(ben.id, async (w) => { run(w, '2026-09-03', 28, 5010, 'b1'); });
  await r.app.worlds.hold(cat.id, async (w) => { run(w, '2026-09-04', 27, 5000, 'c1'); });
  await r.app.worlds.hold(dan.id, async (w) => { run(w, '2026-09-05', 25, 5000, 'd1'); });
  for (const p of [ann, ben, cat, dan]) forgetBests(p.id);
});
after(async () => { await r.close(); });

test('a friend who shares workouts both ways: their times beside yours, never their workouts', async () => {
  const x = (await ann.c.get('/api/best-times?with=ben')).json;
  assert.equal(x.them.who.username, 'ben');
  assert.equal(x.them.hidden, null);
  const five = x.them.sports[0].distances.find((d) => d.m === 5000);
  assert.equal(five.best.timeS, 1677);
  assert.ok(!JSON.stringify(x.them).includes('Secret route run'), 'no titles');
  assert.ok(!JSON.stringify(x.them).includes('dataPoints'), 'no workout ids');
  assert.ok(five.records.every((rec) => !('id' in rec) && !('title' in rec)));
  // Your own side still has its links.
  assert.ok(x.sports[0].distances[0].best.id);
});

test('fair both ways: not when they keep theirs, nor when you keep yours from them', async () => {
  const theirs = (await ann.c.get('/api/best-times?with=cat')).json.them;
  assert.equal(theirs.hidden, 'theirs');
  assert.deepEqual(theirs.sports, []);
  // Cat sees Ann's, but Ann sees none of Cat's: so Cat cannot set Ann's beside hers.
  const yours = (await cat.c.get('/api/best-times?with=ann')).json.them;
  assert.equal(yours.hidden, 'yours');
  assert.deepEqual(yours.sports, []);
  // A public stranger who shares workouts with friends only: there, but not their times.
  assert.equal((await ann.c.get('/api/best-times?with=dan')).json.them.hidden, 'theirs');
  assert.equal((await ann.c.get('/api/best-times?with=nobody')).status, 404);
});

test('the board: you and everybody you may compare with, each one\'s best at each distance', async () => {
  const b = (await ann.c.get('/api/best-times/people?sport=run')).json;
  const names = b.people.map((p) => p.username).sort();
  assert.deepEqual(names, ['ann', 'ben'], 'not cat (keeps hers), not dan (a stranger)');
  assert.equal(b.people.find((p) => p.me).username, 'ann');
  assert.equal(b.people.find((p) => p.username === 'ben').bests[5000], 1677);
  assert.equal((await ann.c.get('/api/best-times/people?sport=swim')).status, 400);
  assert.equal((await r.client().get('/api/best-times/people?sport=run')).status, 401);
});
