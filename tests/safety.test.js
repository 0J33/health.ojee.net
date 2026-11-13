/* Blocking and reporting (server/safety.js): a block hides two people from each other
   everywhere and is not told; a report reaches the admins, who remove or dismiss it. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text.slice(0, 300)); return res.json; };

test('block: friendship gone, posts, comments and profile hidden both ways, no new request; unblock', async () => {
  const a = await personWith(r, 'blocker', { privacy: { account: 'public', workouts: true } });
  const b = await personWith(r, 'blockee', { privacy: { account: 'public', workouts: true } });
  r.befriend(a, b);
  await r.app.publish(a.id, { announce: false });
  await r.app.publish(b.id, { announce: false });
  const bPost = (await ok(await a.c.get('/api/feed?limit=50'))).posts.find((x) => !x.mine);
  assert.ok(bPost, 'a sees the post of b while friends');
  await ok(await b.c.post(`/api/posts/${(await ok(await b.c.get('/api/feed?limit=50'))).posts.find((x) => !x.mine).id}/comments`, { text: 'nice one' })).catch(() => {});

  const res = await ok(await a.c.post('/api/block', { username: 'blockee' }));
  assert.deepEqual(res.list.map((x) => x.username), ['blockee']);
  assert.ok(!(await ok(await a.c.get('/api/feed?limit=50'))).posts.some((x) => !x.mine), 'a sees no post of b');
  assert.ok(!(await ok(await b.c.get('/api/feed?limit=50'))).posts.some((x) => !x.mine), 'b sees no post of a');
  assert.equal((await b.c.get('/api/users/blocker')).status, 404, 'b finds nobody');
  assert.equal((await ok(await a.c.get('/api/users/blockee'))).blocked, true, 'a sees the name, to unblock');
  assert.equal((await b.c.post('/api/friends/request', { username: 'blocker' })).status, 404);
  assert.equal((await b.c.get('/api/friends/find?username=blocker')).status, 404);
  assert.ok(!(await ok(await b.c.get('/api/people'))).people.some((x) => x.username === 'blocker'));
  assert.ok(!(await ok(await a.c.get('/api/friends'))).friends.length);

  await ok(await a.c.post('/api/unblock', { username: 'blockee' }));
  assert.equal((await b.c.get('/api/users/blocker')).status, 200);
});

test('report: only what you can see; the admins see it and remove or dismiss it', async () => {
  const admin = await r.person('ojee');
  const x = await personWith(r, 'poster', { privacy: { account: 'public', workouts: true } });
  const y = await personWith(r, 'reader', { privacy: { account: 'public', workouts: true } });
  const z = await r.person('stranger');
  r.befriend(x, y);
  await r.app.publish(x.id, { announce: false });
  const post = (await ok(await y.c.get('/api/feed?limit=50'))).posts.find((q) => !q.mine);
  assert.ok(post);
  assert.equal((await z.c.post('/api/report', { kind: 'post', id: post.id, reason: 'spam' })).status, 404, 'a stranger cannot see it, so cannot report it');
  assert.equal((await y.c.post('/api/report', { kind: 'post', id: post.id, reason: 'nope' })).status, 400);
  await ok(await y.c.post('/api/report', { kind: 'post', id: post.id, reason: 'harassment', note: 'mean caption' }));
  await ok(await y.c.post('/api/report', { kind: 'person', id: 'poster', reason: 'spam' }));
  const me = await ok(await admin.c.get('/api/me'));
  assert.equal(me.reportsOpen, 2);
  const d = await ok(await admin.c.get('/api/admin'));
  const rep = d.reports.find((q) => q.kind === 'post');
  assert.deepEqual([rep.reason, rep.note, rep.author.username, rep.reporter.username, rep.state], ['harassment', 'mean caption', 'poster', 'reader', 'open']);
  assert.equal((await y.c.get('/api/admin')).status, 403);
  await ok(await admin.c.post(`/api/admin/reports/${rep.id}`, { action: 'remove' }));
  assert.ok(!(await ok(await y.c.get('/api/feed?limit=50'))).posts.some((q) => q.id === post.id), 'removed: friends no longer see it');
  assert.ok((await ok(await x.c.get('/api/feed?limit=50'))).posts.some((q) => q.id === post.id), 'its author still does');
  await r.app.publish(x.id, { announce: false });
  assert.ok(!(await ok(await y.c.get('/api/feed?limit=50'))).posts.some((q) => q.id === post.id), 'and it stays down after the next recompute');
  const pr = (await ok(await admin.c.get('/api/admin'))).reports.find((q) => q.kind === 'person');
  await ok(await admin.c.post(`/api/admin/reports/${pr.id}`, { action: 'dismiss' }));
  assert.equal((await ok(await admin.c.get('/api/me'))).reportsOpen, 0);
  // The reporter's export lists what they reported; everyone's has their posts, media, friends and consents.
  const ex = await ok(await y.c.get('/api/export'));
  assert.equal(ex.social.reportsMade.length, 2);
  for (const k of ['posts', 'media', 'commentsWritten', 'cheersGiven', 'friends', 'blocked', 'circles']) assert.ok(Array.isArray(ex.social[k]), k);
  assert.ok(ex.social.friends.some((f) => f.username === 'poster'));
  assert.ok(ex.consent && typeof ex.tracks === 'object' && Array.isArray(ex.routines));
});

test('consent: the signup box is kept with its time; the rest are asked once and kept', async () => {
  const { c, done: reg } = await r.signUp('agreer');
  assert.equal(reg.status, 200);
  let me = await ok(await c.get('/api/me'));
  assert.ok(me.consent.terms > 0);
  assert.deepEqual(me.consent.needs, ['health']);
  assert.equal(me.consent.ai, null, 'AI off until turned on');
  await ok(await c.patch('/api/consent', { health: true, sharing: true }));
  me = await ok(await c.get('/api/me'));
  assert.deepEqual(me.consent.needs, []);
  assert.ok(me.consent.sharing > 0);
  // Which text each was agreed to under (the policy's date), kept beside the time.
  assert.match(me.consent.policyVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(me.consent.versions, { terms: me.consent.policyVersion, health: me.consent.policyVersion, sharing: me.consent.policyVersion });
  const old = await r.person('fromBefore');
  assert.deepEqual((await ok(await old.c.get('/api/me'))).consent.needs, ['terms', 'health'], 'people from before are asked once');
  // Agreed to the health text before it named the transfer outside Egypt: asked for that one again, once.
  await ok(await old.c.patch('/api/consent', { terms: true, health: true }));
  const prof = r.app.app.profile(old.id);
  r.app.app.patchProfile(old.id, { consent: { ...prof.consent, versions: { terms: prof.consent.versions.terms } } });
  assert.deepEqual((await ok(await old.c.get('/api/me'))).consent.needs, ['health']);
  await ok(await old.c.patch('/api/consent', { health: true }));
  assert.deepEqual((await ok(await old.c.get('/api/me'))).consent.needs, []);
});
