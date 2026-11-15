/* History's filter: /api/workouts?kind= keeps one kind of workout, and says which kinds there are. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

test('History filters by kind, and lists the kinds there are, most first', async () => {
  const p = await r.person('kim');
  const t0 = Date.now() - 10 * 86_400_000;
  const ex = (i, type, extra = {}) => ({ id: `users/me/dataTypes/exercise/dataPoints/k${i}`, date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), startMs: t0 + i * 86_400_000, endMs: t0 + i * 86_400_000 + 40 * 60_000, type, name: type, ...extra });
  await r.app.worlds.hold(p.id, async (w) => {
    w.db.upsertExercise(ex(1, 'RUNNING', { distanceM: 5000 }));
    w.db.upsertExercise(ex(2, 'RUNNING', { distanceM: 6000 }));
    w.db.upsertExercise(ex(3, 'WALKING', { distanceM: 3000 }));
    w.db.upsertExercise(ex(4, 'WEIGHTLIFTING'));
    w.db.upsertExercise(ex(5, 'YOGA'));
  });
  const all = await ok(await p.c.get('/api/workouts?limit=40'));
  assert.equal(all.history.length, 5);
  assert.equal(all.kind, null);
  assert.deepEqual(all.kinds[0], { id: 'run', label: 'Runs', n: 2 });
  assert.deepEqual(all.kinds.map((k) => k.id).sort(), ['YOGA', 'run', 'strength', 'walk']);
  const runs = await ok(await p.c.get('/api/workouts?limit=40&kind=run'));
  assert.equal(runs.kind, 'run');
  assert.deepEqual(runs.history.map((w) => w.type), ['RUNNING', 'RUNNING']);
  assert.equal(runs.kinds.length, 4, 'every kind still listed');
  assert.deepEqual((await ok(await p.c.get('/api/workouts?limit=40&kind=strength'))).history.map((w) => w.type), ['WEIGHTLIFTING']);
  assert.deepEqual((await ok(await p.c.get('/api/workouts?limit=40&kind=YOGA'))).history.map((w) => w.type), ['YOGA']);
  const page = await ok(await p.c.get('/api/workouts?limit=1&kind=run'));
  assert.equal(page.history.length, 1); assert.equal(page.more, true);
  const older = await ok(await p.c.get(`/api/workouts?limit=1&kind=run&before=${page.history[0].start}`));
  assert.deepEqual([older.history.length, older.more], [1, false]);
  // An unknown kind is no filter.
  assert.equal((await ok(await p.c.get('/api/workouts?limit=40&kind=nope'))).history.length, 5);
});
