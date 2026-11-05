/* Music on a post (server/music.js): searching, reading a pasted link,
   what is stored (made by the server, never the browser's), who sees
   it, and the covers and previews fetched through the server. Nothing
   here reaches Deezer, Apple or Spotify: the rig's musicFetch answers. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { parseLink, cleanItem, linksOf, musicView, MusicLookup } from '../server/music.js';

const MP3 = Buffer.alloc(5000, 7);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const TRACK = { id: 908604612, title: 'Blinding Lights', duration: 200, link: 'https://www.deezer.com/track/908604612', preview: 'https://cdnt-preview.dzcdn.net/api/1/x.mp3?hdnea=exp=1', artist: { name: 'The Weeknd' }, album: { title: 'After Hours', cover_big: 'https://cdn-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg' } };

/** A stand-in for the music services. Counts what was asked. */
function services(asked = []) {
  return async (u) => {
    asked.push(u.href);
    if (u.hostname === 'api.deezer.com') {
      if (u.pathname === '/search') return json({ data: [TRACK, { id: 1 }] });
      if (u.pathname === '/search/album') return json({ data: [{ id: 137272602, title: 'After Hours', link: 'https://www.deezer.com/album/137272602', cover_big: 'https://cdn-images.dzcdn.net/images/cover/f52/500x500.jpg', artist: { name: 'The Weeknd' } }] });
      if (u.pathname === '/track/908604612') return json(TRACK);
      if (u.pathname === '/track/1') return json({ error: { code: 800 } });
    }
    if (u.hostname === 'open.spotify.com' && u.pathname === '/oembed') {
      if (u.searchParams.get('url').includes('/playlist/37i9dQZF1DX76Wlfdnj7AP')) return json({ title: 'Beast Mode', thumbnail_url: 'https://i.scdn.co/image/ab67', type: 'rich' });
      return new Response('', { status: 404 });
    }
    if (u.hostname === 'itunes.apple.com' && u.pathname === '/lookup') return json({ results: [{ wrapperType: 'track', trackId: 1488408568, collectionId: 1488408555, trackName: 'Blinding Lights', artistName: 'The Weeknd', collectionName: 'After Hours', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg', previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/p.m4a', trackViewUrl: 'https://music.apple.com/us/album/x/1488408555?i=1488408568&uo=4' }] });
    if (u.hostname === 'cdnt-preview.dzcdn.net') return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
    if (u.hostname === 'cdn-images.dzcdn.net' || u.hostname === 'i.scdn.co') return new Response(JPG, { headers: { 'content-type': 'image/jpeg' } });
    return null;
  };
}

test('links: each service\'s song, album and playlist links are read; anything else is not', () => {
  assert.deepEqual(parseLink('https://open.spotify.com/intl-de/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc'), { src: 'spotify', kind: 'track', id: '0VjIjW4GlUZAMYd2vXMi3b', url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b' });
  assert.equal(parseLink('https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP').kind, 'playlist');
  assert.deepEqual(parseLink('https://music.apple.com/us/album/blinding-lights/1488408555?i=1488408568'), { src: 'apple', kind: 'track', id: '1488408568' });
  assert.deepEqual(parseLink('https://music.apple.com/us/album/after-hours/1499378108'), { src: 'apple', kind: 'album', id: '1499378108' });
  assert.equal(parseLink('https://youtu.be/4NRXx6U8ABQ').kind, 'video');
  assert.equal(parseLink('https://music.youtube.com/watch?v=4NRXx6U8ABQ').kind, 'track');
  assert.equal(parseLink('https://www.youtube.com/playlist?list=PL1234567890').kind, 'playlist');
  assert.equal(parseLink('https://soundcloud.com/artist/sets/mix').kind, 'playlist');
  assert.deepEqual(parseLink('https://www.deezer.com/en/album/137272602'), { src: 'deezer', kind: 'album', id: '137272602' });
  for (const bad of ['https://example.com/track/1', 'javascript:alert(1)', 'not a link', 'https://open.spotify.com/user/x']) assert.equal(parseLink(bad), null, bad);
});

test('what is kept: titles cut down, covers and previews only from the services\' own hosts', () => {
  const ok = cleanItem({ kind: 'track', src: 'deezer', id: 'track:1', title: 'x'.repeat(300), artist: 'A', art: 'https://cdn-images.dzcdn.net/a.jpg', url: 'https://www.deezer.com/track/1', preview: 'deezer:1' });
  assert.equal(ok.title.length, 120);
  assert.equal(ok.art, 'https://cdn-images.dzcdn.net/a.jpg');
  const evil = cleanItem({ kind: 'track', src: 'deezer', title: 'T', art: 'https://evil.example/a.jpg', preview: 'apple:https://evil.example/a.m4a', embed: 'https://evil.example/embed', url: 'javascript:alert(1)' });
  assert.deepEqual([evil.art, evil.preview, evil.embed, evil.url], [null, null, null, null]);
  assert.equal(cleanItem({ kind: 'podcast', src: 'deezer', title: 'T' }), null);
  // The browser gets our own addresses for the cover and the preview.
  const v = musicView(ok);
  assert.ok(v.art.startsWith('/api/music/art?u=') && v.preview === '/api/music/preview?p=deezer%3A1');
  // A song: its own link first, then a search in the other apps. A playlist: only its own.
  assert.deepEqual(linksOf(ok).map((l) => [l.app, l.exact]), [['Deezer', true], ['Spotify', false], ['Apple Music', false], ['YouTube Music', false]]);
  assert.deepEqual(linksOf({ ...ok, kind: 'playlist', src: 'spotify', url: 'https://open.spotify.com/playlist/x' }).map((l) => l.app), ['Spotify']);
});

test('a cover from a host that is not a music service is never fetched', async () => {
  const asked = [];
  const L = new MusicLookup({ fetchImpl: async (u) => { asked.push(String(u)); return new Response(JPG, { headers: { 'content-type': 'image/jpeg' } }); } });
  await assert.rejects(L.art('https://169.254.169.254/latest/meta-data'), /not one of ours/);
  await assert.rejects(L.art('http://cdn-images.dzcdn.net/a.jpg'), /not one of ours/);
  await assert.rejects(L.preview('apple:https://evil.example/a.m4a'), /no preview/);
  assert.deepEqual(asked, []);
});

test('music on a post: search, choose, friends see it and play the preview, the author removes it', async () => {
  const t = await rig();
  try {
    const asked = [];
    t.music.fn = services(asked);
    const ann = await t.person('ann'); const ben = await t.person('ben'); const cat = await t.person('cat');
    assert.equal((await ann.c.post('/api/friends/request', { username: 'ben' })).status, 200);
    assert.equal((await ben.c.post('/api/friends/accept', { username: 'ann' })).status, 200);
    const end = Date.now() - 3_600_000;
    t.app.app.run("INSERT INTO post (id, user_id, uid, kind, start_ms, end_ms, data, created_ms) VALUES (?, ?, ?, 'workout', ?, ?, ?, ?)",
      'post00000001', ann.id, 'uid1', end - 1_800_000, end, JSON.stringify({ type: 'RUNNING', title: 'Run', durationMin: 30 }), end);

    const s = (await ann.c.get('/api/music/search?q=blinding')).json;
    assert.deepEqual(s.tracks.map((x) => [x.title, x.artist]), [['Blinding Lights', 'The Weeknd']], 'a hit without a title is left out');
    assert.deepEqual(s.tracks[0].pick, { deezer: 'track:908604612' });
    assert.equal(s.albums[0].kind, 'album');

    // The browser's own idea of the item is ignored: only the pick is read, and resolved here.
    const r = await ann.c.patch('/api/posts/post00000001', { music: { ...s.tracks[0].pick, title: 'Hacked', art: 'https://evil.example/x.jpg' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.music.title, 'Blinding Lights');
    assert.ok(r.json.music.art.startsWith('/api/music/art?u=https%3A%2F%2Fcdn-images.dzcdn.net'));
    assert.equal(r.json.music.links[0].url, 'https://www.deezer.com/track/908604612');

    // A friend sees it on the feed and plays it, in parts as Safari asks for it.
    const seen = (await ben.c.get('/api/feed')).json.posts.find((x) => x.id === 'post00000001');
    assert.equal(seen.music.title, 'Blinding Lights');
    const whole = await fetch(t.base + seen.music.preview, { headers: { cookie: ben.c.cookie } });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await whole.arrayBuffer()).byteLength, MP3.length);
    const part = await fetch(t.base + seen.music.preview, { headers: { cookie: ben.c.cookie, range: 'bytes=0-1' } });
    assert.deepEqual([part.status, part.headers.get('content-range'), (await part.arrayBuffer()).byteLength], [206, `bytes 0-1/${MP3.length}`, 2]);
    const art = await fetch(t.base + seen.music.art, { headers: { cookie: ben.c.cookie } });
    assert.deepEqual([art.status, art.headers.get('content-type')], [200, 'image/jpeg']);
    // Played twice, fetched once: Deezer's fresh link and the file, then from memory.
    assert.equal(asked.filter((u) => u.includes('dzcdn.net/api/1/x.mp3')).length, 1);

    // Not a friend: no post, so no music. Not logged in: nothing.
    assert.equal((await cat.c.get('/api/feed')).json.posts.some((x) => x.id === 'post00000001'), false);
    assert.equal((await fetch(t.base + seen.music.preview)).status, 401);
    // Only the author changes it.
    assert.equal((await ben.c.patch('/api/posts/post00000001', { music: null })).status, 403);

    // A pasted Spotify playlist: its player, and only its own link.
    const link = 'https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP?si=1';
    const got = (await ann.c.get(`/api/music/resolve?url=${encodeURIComponent(link)}`)).json.item;
    assert.deepEqual([got.kind, got.title, got.embed, got.preview, got.links.length], ['playlist', 'Beast Mode', 'https://open.spotify.com/embed/playlist/37i9dQZF1DX76Wlfdnj7AP', null, 1]);
    assert.equal((await ann.c.patch('/api/posts/post00000001', { music: got.pick })).json.music.title, 'Beast Mode');
    // Links it cannot read, in words.
    const no = await ann.c.get(`/api/music/resolve?url=${encodeURIComponent('https://example.com/song')}`);
    assert.equal(no.status, 400);
    assert.match(no.json.error, /Spotify, Apple Music, YouTube, SoundCloud or Deezer/);
    assert.equal((await ann.c.get(`/api/music/resolve?url=${encodeURIComponent('https://open.spotify.com/track/0000000000000000000000')}`)).status, 404);

    const off = (await ann.c.patch('/api/posts/post00000001', { music: null })).json;
    assert.equal(off.music, null);
  } finally { await t.close(); }
});
