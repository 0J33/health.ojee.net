/* Photos and videos on posts, and profile photos: chunked uploads (the
   production nginx takes 6 MB a request), who may see each file (the
   post's own rule, the profile's), Range replies for video, and the
   files going with whatever they belonged to. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rig } from './helpers.mjs';
import { CHUNK } from '../server/media.js';

const jpeg = (n, fill = 7) => { const b = Buffer.alloc(n, fill); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b; };
const mp4 = (n) => { const b = Buffer.alloc(n, 3); b.write('ftypisom', 4, 'latin1'); for (let i = 0; i < n; i += 4096) b[i + 100] = (i / 4096) & 0xff; return b; };

/** The browser's steps: start, every chunk in order, a preview, done. */
async function upload(c, meta, bytes, { thumb = null } = {}) {
  const s = await c.post('/api/media', { ...meta, size: bytes.length });
  if (s.status !== 200) return s;
  assert.equal(s.json.chunk, CHUNK);
  for (let i = 0; i * CHUNK < bytes.length; i += 1) {
    const r = await c.call('PUT', `/api/media/${s.json.id}/chunk?i=${i}`, { raw: bytes.subarray(i * CHUNK, (i + 1) * CHUNK), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 200, r.text);
  }
  if (thumb) assert.equal((await c.call('PUT', `/api/media/${s.json.id}/thumb`, { raw: thumb, headers: { 'content-type': 'image/jpeg' } })).status, 200);
  return c.post(`/api/media/${s.json.id}/done`, {});
}

/** A post of `who`'s, written as their sync would. */
function postFor(t, who, n = 1) {
  const id = `post${String(n).padStart(8, '0')}`;
  const end = Date.now() - 3_600_000;
  t.app.app.run("INSERT INTO post (id, user_id, uid, kind, start_ms, end_ms, data, created_ms) VALUES (?, ?, ?, 'workout', ?, ?, ?, ?)",
    id, who.id, `uid${n}`, end - 1_800_000, end, JSON.stringify({ type: 'RUNNING', title: 'Run', durationMin: 30 }), end);
  return id;
}
async function befriend(a, b) {
  assert.equal((await a.c.post('/api/friends/request', { username: b.username })).status, 200);
  assert.equal((await b.c.post('/api/friends/accept', { username: a.username })).status, 200);
}
const get = (c, path, headers = {}) => fetch(c.base + path, { headers: { cookie: c.cl.cookie, ...headers } });

test('a photo and a video, in chunks: friends and the author see them, strangers do not; Range replies for video', async () => {
  const t = await rig();
  try {
    const ann = await t.person('ann'); const ben = await t.person('ben'); const cat = await t.person('cat');
    await befriend(ann, ben);
    const pid = postFor(t, ann);
    const photo = jpeg(CHUNK + 1234);   // two chunks
    const done = await upload(ann.c, { kind: 'post', postId: pid, type: 'image/jpeg', w: 2048, h: 1536, name: 'IMG_1.jpg' }, photo, { thumb: jpeg(2000, 9) });
    assert.equal(done.status, 200, done.text);
    const m = done.json;
    assert.deepEqual(m, { id: m.id, kind: 'image', url: `/media/${m.id}`, thumb: `/media/${m.id}/thumb`, w: 2048, h: 1536, duration: null });
    const video = mp4(2 * CHUNK + 777);   // three chunks
    const v = (await upload(ann.c, { kind: 'post', postId: pid, type: 'video/mp4', w: 1280, h: 720, duration: 31.4 }, video)).json;
    assert.deepEqual([v.kind, v.duration, v.thumb], ['video', 31.4, null]);

    // The feed and the post carry them, in order.
    const fb = (await ben.c.get('/api/feed')).json.posts.find((p) => p.id === pid);
    assert.deepEqual(fb.media.map((x) => x.id), [m.id, v.id]);
    assert.deepEqual((await ann.c.get(`/api/posts/${pid}`)).json.media.map((x) => x.kind), ['image', 'video']);

    const as = (who) => ({ base: t.base, cl: who.c });
    // The author and a friend: the bytes, with the stored type, nosniff, a private immutable cache.
    for (const who of [ann, ben]) {
      const r = await get(as(who), m.url);
      assert.equal(r.status, 200);
      assert.deepEqual([r.headers.get('content-type'), r.headers.get('x-content-type-options'), r.headers.get('cache-control'), r.headers.get('accept-ranges')], ['image/jpeg', 'nosniff', 'private, max-age=31536000, immutable', 'bytes']);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(photo));
    }
    assert.equal((await get(as(ben), m.thumb)).status, 200);
    // A stranger, and nobody signed in: the same 404 as no such file.
    assert.equal((await get(as(cat), m.url)).status, 404);
    assert.equal((await get(as(cat), m.thumb)).status, 404);
    assert.equal((await fetch(t.base + m.url)).status, 404);
    assert.equal((await get(as(ben), '/media/m_0000000000')).status, 404);
    // Hidden from friends: only the author.
    await ann.c.patch(`/api/posts/${pid}`, { shared: false });
    assert.equal((await get(as(ben), m.url)).status, 404);
    assert.equal((await get(as(ann), m.url)).status, 200);
    await ann.c.patch(`/api/posts/${pid}`, { shared: true });

    // Range: a slice is 206 with its bytes; the end; past the end is 416.
    let r = await get(as(ben), v.url, { range: 'bytes=4194300-4194319' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 4194300-4194319/${video.length}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(video.subarray(4194300, 4194320)));
    r = await get(as(ben), v.url, { range: 'bytes=-10' });
    assert.equal(r.status, 206);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(video.subarray(video.length - 10)));
    r = await get(as(ben), v.url, { range: 'bytes=0-' });
    assert.deepEqual([r.status, Number(r.headers.get('content-length'))], [206, video.length]);
    await r.arrayBuffer();
    r = await get(as(ben), v.url, { range: `bytes=${video.length}-` });
    assert.equal(r.status, 416);
    assert.equal((await get(as(cat), v.url, { range: 'bytes=0-9' })).status, 404);

    // Reorder: every id once.
    assert.deepEqual((await ann.c.patch(`/api/posts/${pid}`, { media: [v.id, m.id] })).json.media.map((x) => x.id), [v.id, m.id]);
    assert.equal((await ann.c.patch(`/api/posts/${pid}`, { media: [v.id] })).status, 400);
  } finally { await t.close(); }
});

test('uploads refuse what does not add up: type, size, order, length, other people\'s posts, more than ten', async () => {
  const t = await rig();
  try {
    const ann = await t.person('ann'); const ben = await t.person('ben'); const cat = await t.person('cat');
    await befriend(ann, ben);
    const pid = postFor(t, ann);
    const start = (c, o) => c.post('/api/media', { kind: 'post', postId: pid, type: 'image/jpeg', size: 1000, ...o });
    assert.equal((await start(ann.c, { type: 'image/svg+xml' })).status, 415);
    assert.equal((await start(ann.c, { type: 'text/html' })).status, 415);
    assert.equal((await start(ann.c, { size: 13 * 1024 * 1024 })).status, 413);
    assert.equal((await start(ann.c, { type: 'video/mp4', size: 101 * 1024 * 1024, duration: 10 })).status, 413);
    assert.equal((await start(ann.c, { type: 'video/mp4', size: 1000, duration: 125 })).status, 413, 'over two minutes');
    assert.equal((await start(ann.c, { type: 'video/mp4', size: 1000 })).status, 400, 'a video says how long it is');
    assert.equal((await start(ann.c, { size: 0 })).status, 400);
    assert.equal((await start(ann.c, { kind: 'banner' })).status, 400);
    assert.equal((await ann.c.post('/api/media', { kind: 'avatar', type: 'video/mp4', size: 10, duration: 1 })).status, 415);
    assert.equal((await start(ben.c)).status, 403, 'a friend\'s post');
    assert.equal((await start(cat.c)).status, 404, 'a post you cannot see');
    assert.equal((await start(ann.c, { postId: 'nopenopenope' })).status, 404);
    // A request with no Origin (another site) is refused.
    assert.equal((await ann.c.call('POST', '/api/media', { body: { kind: 'avatar', type: 'image/jpeg', size: 10 }, origin: null })).status, 403);

    // Chunks: in order, each exactly its size; done only when all arrived.
    const big = jpeg(CHUNK + 10);
    const s = (await start(ann.c, { size: big.length })).json;
    const put = (c, i, buf) => c.call('PUT', `/api/media/${s.id}/chunk?i=${i}`, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal((await put(ann.c, 1, big.subarray(CHUNK))).status, 409, 'out of order');
    assert.equal((await put(ann.c, 0, big.subarray(0, 100))).status, 400, 'a short chunk');
    assert.equal((await put(ann.c, 2, big.subarray(0, 10))).status, 400, 'past the end');
    assert.equal((await ann.c.call('PUT', `/api/media/${s.id}/chunk`, { raw: big.subarray(0, 10) })).status, 400, 'no chunk number');
    assert.equal((await put(ben.c, 0, big.subarray(0, CHUNK))).status, 404, 'somebody else\'s upload');
    assert.equal((await put(ann.c, 0, Buffer.concat([big.subarray(0, CHUNK), Buffer.alloc(5)]))).status, 413, 'more than a chunk');
    assert.equal((await ann.c.post(`/api/media/${s.id}/done`, {})).status, 409, 'nothing arrived');
    assert.equal((await put(ann.c, 0, big.subarray(0, CHUNK))).status, 200);
    assert.equal((await put(ann.c, 0, big.subarray(0, CHUNK))).status, 200, 'a retry of the last chunk');
    assert.equal((await ann.c.post(`/api/media/${s.id}/done`, {})).status, 409, 'one chunk missing');
    assert.equal((await put(ann.c, 1, big.subarray(CHUNK))).status, 200);
    assert.equal((await ann.c.post(`/api/media/${s.id}/done`, {})).status, 200);
    assert.equal((await put(ann.c, 1, big.subarray(CHUNK))).status, 409, 'finished');

    // A file that is not what its type says is refused and dropped.
    const fake = await upload(ann.c, { kind: 'post', postId: pid, type: 'image/jpeg' }, Buffer.from('<html><script>alert(1)</script></html>'));
    assert.equal(fake.status, 415);
    // Ten at most on a post: nine more fit, the eleventh does not.
    for (let i = 0; i < 9; i += 1) assert.equal((await upload(ann.c, { kind: 'post', postId: pid, type: 'image/jpeg' }, jpeg(500))).status, 200);
    assert.equal((await start(ann.c)).status, 409);
    assert.equal((await ann.c.get(`/api/posts/${pid}`)).json.media.length, 10);
  } finally { await t.close(); }
});

test('removing a photo, a post going with its workout, an upload left for an hour, and a person deleted: the files go too', async () => {
  let clock = Date.now();
  const t = await rig({ now: () => clock });
  try {
    const ann = await t.person('ann'); const ben = await t.person('ben');
    await befriend(ann, ben);
    const pid = postFor(t, ann);
    const folder = join(t.dir, 'data', 'media', ann.id);
    const files = () => (existsSync(folder) ? readdirSync(folder).sort() : []);
    const a = (await upload(ann.c, { kind: 'post', postId: pid, type: 'image/jpeg' }, jpeg(900), { thumb: jpeg(100) })).json;
    const b = (await upload(ann.c, { kind: 'post', postId: pid, type: 'image/jpeg' }, jpeg(800))).json;
    assert.deepEqual(files(), [`${a.id}.jpg`, `${a.id}.thumb.jpg`, `${b.id}.jpg`].sort());
    // Only the owner removes one.
    assert.equal((await ben.c.del(`/api/media/${a.id}`)).status, 404);
    assert.equal((await ann.c.del(`/api/media/${a.id}`)).status, 200);
    assert.deepEqual(files(), [`${b.id}.jpg`]);
    assert.equal((await fetch(t.base + a.url, { headers: { cookie: ann.c.cookie } })).status, 404);

    // An upload left unfinished for over an hour is dropped.
    const half = (await ann.c.post('/api/media', { kind: 'post', postId: pid, type: 'image/jpeg', size: 2000 })).json;
    assert.ok(files().includes(`${half.id}.part`));
    clock += 61 * 60_000;
    t.app.media.sweep();
    assert.ok(!files().includes(`${half.id}.part`));
    assert.equal(t.app.app.get('SELECT COUNT(*) AS n FROM media WHERE id = ?', half.id).n, 0);

    // The workout is gone (her sync has no such session): the post goes, its photos with it.
    await t.app.publish(ann.id, { announce: false });
    assert.equal(t.app.app.get('SELECT COUNT(*) AS n FROM post WHERE id = ?', pid).n, 0);
    assert.deepEqual(files(), []);

    // A profile photo, then the whole person.
    assert.equal((await upload(ann.c, { kind: 'avatar', type: 'image/jpeg', w: 512, h: 512 }, jpeg(700))).status, 200);
    assert.equal(files().length, 1);
    assert.equal((await ann.c.post('/api/account/delete-data', { confirm: 'ann' })).status, 200);
    assert.ok(!existsSync(folder), 'the folder is gone');
    assert.equal(t.app.app.get('SELECT COUNT(*) AS n FROM media WHERE user_id = ?', ann.id).n, 0);
  } finally { await t.close(); }
});

test('profile photos: on every face the API returns, seen while the profile is public, replaced and removed', async () => {
  const t = await rig();
  try {
    const ann = await t.person('ann'); const ben = await t.person('ben'); const cat = await t.person('cat');
    await befriend(ann, ben);
    const pid = postFor(t, ann);
    assert.equal((await ann.c.get('/api/me')).json.profile.avatar, null);
    const first = (await upload(ann.c, { kind: 'avatar', type: 'image/jpeg', w: 512, h: 512 }, jpeg(600))).json;
    const url = first.url;
    // Your own, in /api/me; ann's, everywhere a face is shown.
    assert.deepEqual([(await ann.c.get('/api/me')).json.profile.avatar, (await ann.c.get('/api/me')).json.profile.avatarId], [url, first.id]);
    assert.equal((await ben.c.get('/api/friends')).json.friends.find((p) => p.username === 'ann').avatar, url);
    assert.equal((await cat.c.get('/api/friends')).json.suggestions.find((p) => p.username === 'ann').avatar, url);
    assert.equal((await ben.c.get('/api/feed')).json.posts.find((p) => p.id === pid).author.avatar, url);
    assert.equal((await ben.c.get('/api/users/ann')).json.avatar, url);
    assert.equal((await ben.c.get('/api/people')).json.people.find((p) => p.username === 'ann').avatar, url);
    assert.equal((await ben.c.get('/api/compare?with=ann&period=week')).json.b.avatar, url);
    await ann.c.post(`/api/posts/${pid}/cheer`, {});
    await ann.c.post(`/api/posts/${pid}/comments`, { text: 'Felt good' });
    const post = (await ben.c.get(`/api/posts/${pid}`)).json;
    assert.deepEqual([post.cheerers[0].avatar, post.comments[0].author.avatar], [url, url]);
    assert.equal((await ben.c.get('/api/friends')).json.friends[0].avatar, url);
    assert.equal((await ann.c.get('/api/friends')).json.friends.find((p) => p.username === 'ben').avatar, null);

    // Public profile: anyone signed in sees it. Signed out: no.
    const see = async (c) => (await fetch(t.base + url, { headers: c ? { cookie: c.cookie } : {} })).status;
    assert.deepEqual([await see(ann.c), await see(ben.c), await see(cat.c), await see(null)], [200, 200, 200, 404]);
    // Private: only herself.
    await ann.c.patch('/api/settings', { privacy: { account: 'private' } });
    assert.deepEqual([await see(ann.c), await see(ben.c), await see(cat.c)], [200, 404, 404]);
    await ann.c.patch('/api/settings', { privacy: { account: 'public' } });

    // A new one replaces it: the old address stops answering and its file goes.
    const second = (await upload(ann.c, { kind: 'avatar', type: 'image/jpeg', w: 512, h: 512 }, jpeg(650, 1))).json;
    assert.notEqual(second.id, first.id);
    assert.equal(await see(ann.c), 404);
    assert.equal((await ann.c.get('/api/me')).json.profile.avatar, second.url);
    assert.deepEqual(readdirSync(join(t.dir, 'data', 'media', ann.id)), [`${second.id}.jpg`]);
    // Removed: back to the initials.
    assert.equal((await ann.c.patch('/api/profile', { avatar: 'x' })).status, 400);
    assert.equal((await ann.c.patch('/api/profile', { avatar: null })).json.profile.avatar, null);
    assert.equal((await ben.c.get('/api/users/ann')).json.avatar, null);
    assert.deepEqual(readdirSync(join(t.dir, 'data', 'media', ann.id)), []);
  } finally { await t.close(); }
});
