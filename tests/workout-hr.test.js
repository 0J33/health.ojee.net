/* A workout's heart-rate graph on its post: seen by others only from a fully public person, who can switch it off. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import * as friends from '../server/friends.js';

let r;
before(async () => { r = await rig(); });
after(() => r.close());
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

test('the graph is on the post page only while the account, workouts and heart are all public, and not switched off', async () => {
  const a = await r.person('hrauthor'); const b = await r.person('hrviewer');
  const start = Date.now() - 2 * 3600_000; const end = start + 30 * 60_000;
  const list = await ok(await a.c.post('/api/workouts/log', { start, end, title: 'Graph day', type: 'WALKING' }));
  const id = Object.values(list).flat().find((x) => x?.title === 'Graph day').id;
  const trace = Array.from({ length: 30 }, (_, i) => [start + i * 60_000, 120 + i, 0]);
  r.app.worlds.get(a.id).db.workoutCache(Number(id), { trace });
  const app = r.app.app; const t = Date.now();
  friends.request(app, a.id, app.profile(b.id).username, t); friends.accept(app, b.id, app.profile(a.id).username, t);
  const set = async (privacy) => { await ok(await a.c.patch('/api/settings', { privacy })); await r.app.publish(a.id, { announce: false }); };
  await set({ workouts: 'everyone', heart: 'me' });
  const postId = r.app.app.all('SELECT id FROM post WHERE user_id = ?', a.id)[0].id;
  const read = async () => { const res = await b.c.get(`/api/posts/${postId}`); assert.equal(res.status, 200, res.text); return res.json.post || res.json; };
  assert.equal((await read()).hr, undefined, 'heart kept private: no graph');
  await set({ heart: 'friends' });
  assert.equal((await read()).hr, undefined, 'heart for friends only: not fully public');
  await set({ heart: 'everyone' });
  const shown = await read();
  assert.equal(shown.hr.length, 30);
  assert.deepEqual(shown.hr[0], [start, 120]);
  await set({ workoutHr: false });
  assert.equal((await read()).hr, undefined, 'switched off');
  await set({ workoutHr: true, account: 'private' });
  const res = await b.c.get(`/api/posts/${postId}`);
  assert.ok(res.status !== 200 || (res.json.post || res.json).hr === undefined, 'a private account: no graph');
});
