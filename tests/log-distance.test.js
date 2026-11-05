import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

/* A walk, run, ride or swim typed in by hand: its kind and its distance, kept and changeable. */

let r; let p;
before(async () => { r = await rig(); p = await r.person('walker'); });
after(async () => { await r.close(); });

test('a past walk with its distance; changed, then taken out; a long hike; every kind listed', async () => {
  const start = Date.now() - 3 * 3_600_000;
  const out = (await p.c.post('/api/workouts/log', { start, end: start + 50 * 60_000, type: 'WALKING', distanceM: 4200 })).json;
  const w = out.history.find((x) => x.start === start);
  assert.equal(w.type, 'WALKING');
  assert.equal(w.distanceM, 4200);
  const d = (await p.c.get(`/api/workouts/${w.id}`)).json;
  assert.equal(d.distanceM, 4200);
  // Changed by hand.
  assert.equal((await p.c.patch(`/api/workouts/${w.id}`, { distanceM: 5100 })).status, 200);
  assert.equal((await p.c.get(`/api/workouts/${w.id}`)).json.distanceM, 5100);
  // Nonsense refused.
  assert.equal((await p.c.patch(`/api/workouts/${w.id}`, { distanceM: -3 })).status, 400);
  assert.equal((await p.c.post('/api/workouts/log', { start: start - 86_400_000, end: start - 86_400_000 + 600_000, type: 'RUNNING', distanceM: 5e9 })).status, 400);
  // A hike of 9 hours: longer than a workout started here may run, fine typed in.
  const h = Date.now() - 30 * 3_600_000;
  assert.equal((await p.c.post('/api/workouts/log', { start: h, end: h + 9 * 3_600_000, type: 'HIKING', distanceM: 21_000 })).status, 200);
  const types = (await p.c.get('/api/workouts/types')).json.types;
  assert.ok(types.some((t) => t.id === 'SWIMMING_POOL') && types.some((t) => t.id === 'SOCCER'));
});
