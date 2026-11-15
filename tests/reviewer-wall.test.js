/* The app reviewers' account is walled off (server/safety.js setWalled, config.signin.walled):
   Google's pre-launch robot, signed in as `demo`, tapped "Add" on a real person it was suggested.
   Across the wall nobody is suggested, found, asked, shown or in a circle, either way. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { clearWall } from '../server/safety.js';

let r;
before(async () => { r = await rig({ env: { WALLED_USERS: 'demo' } }); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text.slice(0, 300)); return res.json; };

test('the reviewer account and real people never reach each other', async () => {
  const real = await personWith(r, 'realperson', { privacy: { account: 'public', workouts: 'everyone' } });
  const real2 = await personWith(r, 'realfriend', { privacy: { account: 'public', workouts: 'everyone' } });
  const demo = await personWith(r, 'demo', { privacy: { account: 'public', workouts: 'everyone' } });
  r.befriend(real, real2);
  await r.app.publish(real.id, { announce: false });
  await r.app.publish(demo.id, { announce: false });

  // Not suggested, not found, cannot be asked: either way.
  assert.ok(!(await ok(await demo.c.get('/api/friends'))).suggestions.some((x) => x.username.startsWith('real')), 'nobody real suggested to the reviewer');
  assert.ok(!(await ok(await real.c.get('/api/friends'))).suggestions.some((x) => x.username === 'demo'), 'the reviewer is suggested to nobody');
  assert.equal((await demo.c.get('/api/friends/find?username=realperson')).status, 404);
  assert.equal((await demo.c.post('/api/friends/request', { username: 'realperson' })).status, 404);
  assert.equal((await real.c.post('/api/friends/request', { username: 'demo' })).status, 404);
  assert.equal((await demo.c.get('/api/users/realperson')).status, 404);
  assert.ok(!(await ok(await demo.c.get('/api/people'))).people.some((x) => x.username.startsWith('real')));
  // Nothing in each other's feed.
  assert.ok(!(await ok(await demo.c.get('/api/feed?limit=50'))).posts.some((x) => !x.mine));
  assert.ok(!(await ok(await real.c.get('/api/feed?limit=50'))).posts.some((x) => x.user?.username === 'demo' || x.username === 'demo'));
  // Real people still see each other.
  assert.ok((await ok(await real.c.get('/api/friends'))).friends.some((x) => x.username === 'realfriend'));

  // Circles: a real person's circle is not there for the reviewer, and the reviewer cannot be invited.
  const c = await ok(await real.c.post('/api/circles', { name: 'Morning runners', join: 'request' }));
  const cid = c.id || c.circle?.id;
  assert.ok(cid, JSON.stringify(c).slice(0, 200));
  assert.ok(!(await ok(await demo.c.get('/api/circles/browse'))).circles.some((x) => x.id === cid));
  assert.equal((await demo.c.post(`/api/circles/${cid}/join`, {})).status, 404);
  assert.equal((await real.c.post(`/api/circles/${cid}/invite`, { username: 'demo' })).status, 404);
});

test('what crossed the wall before it was there is taken down', async () => {
  const a = await personWith(r, 'crossedreal', { privacy: { account: 'public' } });
  const demo = r.app.app.profileByName('demo');
  r.app.app.run("INSERT OR REPLACE INTO friend (a, b, status, requester, created_ms, updated_ms) VALUES (?, ?, 'friends', ?, 1, 1)", ...[a.id, demo.userId].sort(), demo.userId);
  assert.equal(clearWall(r.app.app), 1);
  assert.ok(!(await ok(await a.c.get('/api/friends'))).friends.some((x) => x.username === 'demo'));
});
