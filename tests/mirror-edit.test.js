/* A watch's workout that only lives in Google Health can be changed here: the
   first change makes it the person's own row, which then stands for the session
   (no duplicate in the list, never uploaded again), and deleting it does not
   bring Google's copy back. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const ok = async (x) => { assert.equal(x.status, 200, x.text.slice(0, 300)); return x.json; };
const MIN = 60_000;

test('changing a Google-only workout makes it one\'s own, once, without doubling it', async () => {
  const p = await personWith(r, 'watcher');
  const start = Date.now() - 2 * 86_400_000;
  const day = new Date(start).toISOString().slice(0, 10);
  await r.app.worlds.hold(p.id, async (w) => {
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/watch-lift', date: day, startMs: start, endMs: start + 50 * MIN, type: 'WEIGHTLIFTING', name: 'Weights', avgHr: 118, kcal: 310 });
  });
  const listed = (await ok(await p.c.get('/api/workouts?limit=100'))).history.filter((x) => x.start === start);
  assert.equal(listed.length, 1);
  const gid = listed[0].id;
  assert.match(gid, /^g-/);
  assert.equal(listed[0].readOnly, true);

  // The first change: a name.
  await ok(await p.c.patch(`/api/workouts/${gid}`, { title: 'Push day', notes: 'felt strong' }));
  const after1 = (await ok(await p.c.get('/api/workouts?limit=100'))).history.filter((x) => x.start === start);
  assert.equal(after1.length, 1, 'one workout for the session, not two');
  assert.match(String(after1[0].id), /^\d+$/);
  assert.equal(after1[0].title, 'Push day');
  assert.equal(after1[0].readOnly, false);
  assert.equal(after1[0].google.state, 'foreign', 'Google already has it: never uploaded again');
  assert.equal(after1[0].avgHr, 118);

  // The old address shows the row now; a second change finds the same row.
  const d = await ok(await p.c.get(`/api/workouts/${gid}`));
  assert.equal(String(d.id), String(after1[0].id));
  const sets = [{ name: 'Bench press', sets: [{ kg: 60, reps: 8 }] }];
  await ok(await p.c.put(`/api/workouts/${gid}/sets`, { exercises: sets }));
  const after2 = (await ok(await p.c.get('/api/workouts?limit=100'))).history.filter((x) => x.start === start);
  assert.equal(after2.length, 1);
  assert.equal(String(after2[0].id), String(after1[0].id));

  // A sync does not bring Google's copy back beside it.
  await r.app.syncUser(p.id);
  assert.equal((await ok(await p.c.get('/api/workouts?limit=100'))).history.filter((x) => x.start === start).length, 1);

  // Deleted: gone from the list, and Google's copy stays hidden.
  await ok(await p.c.del(`/api/workouts/${after1[0].id}`));
  assert.equal((await ok(await p.c.get('/api/workouts?limit=100'))).history.filter((x) => x.start === start).length, 0);
  assert.equal((await p.c.get(`/api/workouts/${gid}`)).status, 404);
});
