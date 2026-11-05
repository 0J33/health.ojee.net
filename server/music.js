/* ============================================================
   health.ojee.net — a song, album or playlist on a post: what you
   listened to, the way Instagram puts music on a story.

   Where it comes from, all without a key:
     - search: Deezer's public catalogue (songs and albums, with
       30-second previews and covers);
     - a pasted link: Deezer and Apple Music are looked up in full
       (Apple through the iTunes lookup); Spotify, YouTube (and
       YouTube Music) and SoundCloud through their oEmbed, which gives
       a title and a picture. A Spotify item carries its embed player.

   What the server keeps (post.music) is made here from the source's
   answer, never taken from the browser: the browser sends a pick
   ({ deezer: 'track:123' }) or a link ({ url }), and this resolves it.

   Covers and previews are fetched through this server (art(),
   preview()), from the hosts below only. Friends who look at a post
   do not reach Deezer, Apple or Spotify by looking: only by pressing
   a link out, or Play on a Spotify player.
   ============================================================ */

const UA = 'health.ojee.net/1.0 (+https://health.ojee.net)';
const TTL = 6 * 3600_000;
const bad = (message, status = 400, code = undefined) => Object.assign(new Error(message), { status, expose: true, code });

export const URLS = {
  deezer: 'https://api.deezer.com',
  itunes: 'https://itunes.apple.com',
  spotify: 'https://open.spotify.com/oembed',
  youtube: 'https://www.youtube.com/oembed',
  soundcloud: 'https://soundcloud.com/oembed',
};

/** Hosts a cover may come from, and a preview. */
const ART_HOSTS = [/^cdn-images\.dzcdn\.net$/, /^e-cdns-images\.dzcdn\.net$/, /^is\d+-ssl\.mzstatic\.com$/, /^i\.scdn\.co$/, /^image-cdn-[a-z]+\.spotifycdn\.com$/, /^mosaic\.scdn\.co$/, /^i\.ytimg\.com$/, /^i\d*\.sndcdn\.com$/];
const AUDIO_HOSTS = [/^audio-ssl\.itunes\.apple\.com$/, /^[a-z0-9-]+\.itunes\.apple\.com$/];
const hostOk = (u, list) => { try { const x = new URL(u); return x.protocol === 'https:' && list.some((r) => r.test(x.hostname)); } catch { return false; } };
export const artAllowed = (u) => hostOk(u, ART_HOSTS);

const KINDS = new Set(['track', 'album', 'playlist', 'video']);
const SOURCES = new Set(['deezer', 'apple', 'spotify', 'youtube', 'soundcloud']);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t) : null; };

/** One item as it is stored and sent: checked, so a stored one can be trusted. */
export function cleanItem(x) {
  if (!x || typeof x !== 'object' || !KINDS.has(x.kind) || !SOURCES.has(x.src)) return null;
  const title = clip(x.title, 120);
  if (!title) return null;
  const okUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"<>]+$/.test(u) && u.length < 600 ? u : null);
  return {
    kind: x.kind, src: x.src, id: String(x.id ?? '').slice(0, 80) || null, title,
    artist: clip(x.artist, 120), album: clip(x.album, 120),
    art: okUrl(x.art) && artAllowed(x.art) ? x.art : null,
    url: okUrl(x.url),
    // A preview: Deezer's by the track's id (its links expire, so it is fetched when played), Apple's by its link.
    preview: typeof x.preview === 'string' && (/^deezer:\d{1,20}$/.test(x.preview) || (x.preview.startsWith('apple:') && hostOk(x.preview.slice(6), AUDIO_HOSTS))) ? x.preview : null,
    embed: okUrl(x.embed) && /^https:\/\/open\.spotify\.com\/embed\//.test(x.embed) ? x.embed : null,
    seconds: Number.isFinite(x.seconds) && x.seconds > 0 ? Math.round(x.seconds) : null,
  };
}

/** "Find it in" links for the apps people use, by its name: exact for its own source. */
export function linksOf(m) {
  if (!m) return [];
  const q = encodeURIComponent([m.title, m.artist].filter(Boolean).join(' '));
  const own = { deezer: 'Deezer', apple: 'Apple Music', spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud' }[m.src];
  const out = m.url ? [{ app: own, url: m.url, exact: true }] : [];
  // A playlist or video is somebody's own: only its own link finds it.
  if (m.kind === 'track' || m.kind === 'album') {
    const more = [['spotify', 'Spotify', `https://open.spotify.com/search/${q}`], ['apple', 'Apple Music', `https://music.apple.com/search?term=${q}`], ['ytm', 'YouTube Music', `https://music.youtube.com/search?q=${q}`]];
    for (const [k, app, url] of more) if (k !== m.src) out.push({ app, url, exact: false });
  }
  return out;
}

/** What the browser is sent: covers and previews through this server. */
export function musicView(m) {
  const x = cleanItem(m);
  if (!x) return null;
  return {
    kind: x.kind, src: x.src, title: x.title, artist: x.artist, album: x.album,
    art: x.art ? `/api/music/art?u=${encodeURIComponent(x.art)}` : null,
    preview: x.preview ? `/api/music/preview?p=${encodeURIComponent(x.preview)}` : null,
    embed: x.embed, links: linksOf(x),
  };
}

/* ── the sources ───────────────────────────────────────────────────── */

const big = (u) => (typeof u === 'string' ? u.replace(/\/\d+x\d+(bb)?\./, '/600x600bb.') : null);

function fromDeezerTrack(t) {
  if (!t?.id || !t.title) return null;
  return cleanItem({
    kind: 'track', src: 'deezer', id: `track:${t.id}`, title: t.title, artist: t.artist?.name, album: t.album?.title,
    art: t.album?.cover_big || t.album?.cover_medium || null, url: t.link || `https://www.deezer.com/track/${t.id}`,
    preview: t.readable === false ? null : `deezer:${t.id}`, seconds: t.duration,
  });
}
function fromDeezerAlbum(a) {
  if (!a?.id || !a.title) return null;
  return cleanItem({ kind: 'album', src: 'deezer', id: `album:${a.id}`, title: a.title, artist: a.artist?.name, art: a.cover_big || a.cover_medium, url: a.link || `https://www.deezer.com/album/${a.id}`, preview: a.tracks?.data?.[0]?.id ? `deezer:${a.tracks.data[0].id}` : null });
}
function fromDeezerPlaylist(p) {
  if (!p?.id || !p.title) return null;
  return cleanItem({ kind: 'playlist', src: 'deezer', id: `playlist:${p.id}`, title: p.title, artist: p.creator?.name || p.user?.name, art: p.picture_big || p.picture_medium, url: p.link || `https://www.deezer.com/playlist/${p.id}`, preview: p.tracks?.data?.[0]?.id ? `deezer:${p.tracks.data[0].id}` : null });
}
function fromItunes(r) {
  if (!r) return null;
  const track = r.wrapperType === 'track';
  return cleanItem({
    kind: track ? 'track' : 'album', src: 'apple', id: `${track ? 'track' : 'album'}:${track ? r.trackId : r.collectionId}`,
    title: track ? r.trackName : r.collectionName, artist: r.artistName, album: track ? r.collectionName : null,
    art: big(r.artworkUrl100), url: (track ? r.trackViewUrl : r.collectionViewUrl)?.replace(/[?&]uo=\d+/, ''),
    preview: r.previewUrl ? `apple:${r.previewUrl}` : null, seconds: r.trackTimeMillis ? r.trackTimeMillis / 1000 : null,
  });
}

/** What a pasted link is: its source, kind and id. Null when it is not one we read. */
export function parseLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (h === 'open.spotify.com' || h === 'play.spotify.com') {
    const i = parts.findIndex((x) => ['track', 'album', 'playlist', 'episode'].includes(x));
    if (i < 0 || !/^[A-Za-z0-9]{10,40}$/.test(parts[i + 1] || '')) return null;
    return { src: 'spotify', kind: parts[i] === 'episode' ? 'track' : parts[i], id: parts[i + 1], url: `https://open.spotify.com/${parts[i]}/${parts[i + 1]}` };
  }
  if (h === 'music.apple.com' || h === 'itunes.apple.com') {
    const song = u.searchParams.get('i');
    const last = parts.at(-1)?.replace(/^id/, '');
    if (song && /^\d+$/.test(song)) return { src: 'apple', kind: 'track', id: song };
    if (parts.includes('song') && /^\d+$/.test(last)) return { src: 'apple', kind: 'track', id: last };
    if (parts.includes('album') && /^\d+$/.test(last)) return { src: 'apple', kind: 'album', id: last };
    if (parts.includes('playlist')) return { src: 'apple', kind: 'playlist', id: last, url: u.href };
    return null;
  }
  if (h === 'deezer.com' || h === 'deezer.page.link' || h === 'link.deezer.com') {
    const i = parts.findIndex((x) => ['track', 'album', 'playlist'].includes(x));
    if (i < 0 || !/^\d+$/.test(parts[i + 1] || '')) return null;
    return { src: 'deezer', kind: parts[i], id: parts[i + 1] };
  }
  if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtu.be') {
    const v = h === 'youtu.be' ? parts[0] : u.searchParams.get('v');
    const list = u.searchParams.get('list');
    if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return { src: 'youtube', kind: h === 'music.youtube.com' ? 'track' : 'video', id: v, url: h === 'music.youtube.com' ? `https://music.youtube.com/watch?v=${v}` : `https://www.youtube.com/watch?v=${v}` };
    if (list && /^[A-Za-z0-9_-]{6,60}$/.test(list)) return { src: 'youtube', kind: 'playlist', id: list, url: `https://${h === 'music.youtube.com' ? 'music.youtube.com' : 'www.youtube.com'}/playlist?list=${list}` };
    return null;
  }
  if (h === 'soundcloud.com' || h === 'on.soundcloud.com') {
    if (!parts.length) return null;
    return { src: 'soundcloud', kind: parts[1] === 'sets' ? 'playlist' : 'track', id: parts.join('/').slice(0, 80), url: `https://soundcloud.com/${parts.join('/')}` };
  }
  return null;
}

export class MusicLookup {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, urls = {} } = {}) {
    this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.urls = { ...URLS, ...urls };
    this.cache = new Map();   // answers
    this.covers = new Map();  // covers: url -> { type, body }
    this.clips = new Map();   // previews, a few: they are half a megabyte each
  }
  #keep(map, key, value, max) {
    map.set(key, { at: this.now(), value });
    if (map.size > max) for (const [k] of map) { map.delete(k); if (map.size <= max * 0.75) break; }
  }
  #hit(map, key) { const c = map.get(key); return c && this.now() - c.at < TTL ? c.value : undefined; }
  async #get(url, { json = true } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    t.unref?.();
    try {
      const res = await this.fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*', 'accept-language': 'en-US,en;q=0.8' }, signal: ctl.signal });
      if (res.status === 404 || res.status === 400 || res.status === 401) return null;
      if (!res.ok) throw bad('The music service answered with an error. Try again.', 502, 'upstream');
      if (!json) return { type: res.headers.get('content-type') || '', body: Buffer.from(await res.arrayBuffer()) };
      return await res.json();
    } catch (e) {
      if (e.status) throw e;
      throw bad(e.name === 'AbortError' ? 'The music service did not answer in time.' : 'The music service could not be reached.', 502, 'upstream');
    } finally { clearTimeout(t); }
  }
  async #cached(key, fn) {
    const hit = this.#hit(this.cache, key);
    if (hit !== undefined) return hit;
    const v = await fn();
    this.#keep(this.cache, key, v, 2000);
    return v;
  }

  /** Songs and albums by name. */
  search(q) {
    const needle = String(q || '').trim().slice(0, 100);
    if (needle.length < 2) return Promise.resolve({ tracks: [], albums: [] });
    return this.#cached(`s:${needle.toLowerCase()}`, async () => {
      const qs = (n) => new URLSearchParams({ q: needle, limit: String(n) });
      const [t, a] = await Promise.all([this.#get(`${this.urls.deezer}/search?${qs(12)}`), this.#get(`${this.urls.deezer}/search/album?${qs(6)}`)]);
      return { tracks: (t?.data || []).map(fromDeezerTrack).filter(Boolean), albums: (a?.data || []).map(fromDeezerAlbum).filter(Boolean) };
    });
  }

  /** A pick from the search ({ deezer: 'track:123' }) or a link ({ url }): the item, or a 400/404 in words. */
  async resolve(pick) {
    if (pick?.deezer) {
      const m = /^(track|album|playlist):(\d{1,20})$/.exec(String(pick.deezer));
      if (!m) throw bad('That is not a song, album or playlist we know.');
      return this.#deezer(m[1], m[2]);
    }
    const l = parseLink(pick?.url);
    if (!l) throw bad('Paste a link to a song, album or playlist on Spotify, Apple Music, YouTube, SoundCloud or Deezer.');
    if (l.src === 'deezer') return this.#deezer(l.kind, l.id);
    if (l.src === 'apple') {
      if (l.kind === 'playlist') throw bad('Apple Music playlists cannot be read from a link. Paste a song or an album, or the playlist from Spotify or YouTube.');
      return this.#cached(`a:${l.id}`, async () => {
        const j = await this.#get(`${this.urls.itunes}/lookup?${new URLSearchParams({ id: l.id, country: 'US', entity: l.kind === 'album' ? 'album' : 'song' })}`);
        const r = (j?.results || []).find((x) => String(l.kind === 'album' ? x.collectionId : x.trackId) === l.id) || j?.results?.[0];
        const item = fromItunes(r);
        if (!item) throw bad('Apple Music does not know that link.', 404);
        return item;
      });
    }
    return this.#cached(`o:${l.url}`, async () => {
      const base = { spotify: this.urls.spotify, youtube: this.urls.youtube, soundcloud: this.urls.soundcloud }[l.src];
      const j = await this.#get(`${base}?${new URLSearchParams({ url: l.url, format: 'json' })}`);
      if (!j?.title) throw bad(`${l.src === 'spotify' ? 'Spotify' : l.src === 'youtube' ? 'YouTube' : 'SoundCloud'} does not know that link, or it is private.`, 404);
      let title = j.title; let artist = j.author_name || null;
      // SoundCloud says "Song by Artist"; YouTube's music videos say "Artist - Song".
      if (l.src === 'soundcloud') { const m = /^(.*) by (.*)$/.exec(title); if (m) { title = m[1]; artist = m[2]; } }
      if (l.src === 'youtube') { const m = /^(.+?) - (.+?)(?: \((?:Official|Lyric|Audio)[^)]*\))?$/i.exec(title); if (m) { artist = m[1]; title = m[2]; } else artist = artist?.replace(/(VEVO| - Topic)$/i, '').trim() || null; }
      const item = cleanItem({
        kind: l.kind, src: l.src, id: l.id, title, artist, art: j.thumbnail_url, url: l.url,
        embed: l.src === 'spotify' ? `https://open.spotify.com/embed/${l.kind === 'track' && /episode/.test(l.url) ? 'episode' : l.kind}/${l.id}` : null,
      });
      if (!item) throw bad('That link has no title to show.', 404);
      return item;
    });
  }
  #deezer(kind, id) {
    return this.#cached(`d:${kind}:${id}`, async () => {
      const j = await this.#get(`${this.urls.deezer}/${kind}/${id}`);
      const item = j && !j.error ? (kind === 'track' ? fromDeezerTrack(j) : kind === 'album' ? fromDeezerAlbum(j) : fromDeezerPlaylist(j)) : null;
      if (!item) throw bad('Deezer does not know that one.', 404);
      return item;
    });
  }

  /** A cover, from an allowed host only. { type, body } */
  async art(u) {
    if (!artAllowed(u)) throw bad('That picture is not one of ours.', 404);
    const hit = this.#hit(this.covers, u);
    if (hit) return hit;
    const f = await this.#get(u, { json: false });
    if (!f || !/^image\//.test(f.type) || f.body.length > 2_000_000) throw bad('The cover could not be fetched.', 404);
    this.#keep(this.covers, u, f, 300);
    return f;
  }

  /** A 30-second preview ('deezer:<track id>' or 'apple:<link>'). { type, body } */
  async preview(p) {
    const key = p;
    const hit = this.#hit(this.clips, key);
    if (hit) return hit;
    let link = null;
    if (/^deezer:\d{1,20}$/.test(p)) {
      // Deezer's preview links expire: the track is read again for a fresh one.
      const t = await this.#get(`${this.urls.deezer}/track/${p.slice(7)}`);
      link = t?.preview || null;
      if (link && !/^https:\/\/[a-z0-9-]+\.dzcdn\.net\//.test(link)) link = null;
    } else if (p.startsWith('apple:') && hostOk(p.slice(6), AUDIO_HOSTS)) link = p.slice(6);
    if (!link) throw bad('This one has no preview.', 404);
    const f = await this.#get(link, { json: false });
    if (!f || f.body.length > 6_000_000) throw bad('The preview could not be fetched.', 404);
    const out = { type: /audio|mpeg|mp4|m4a/.test(f.type) ? f.type : (link.includes('.m4a') ? 'audio/mp4' : 'audio/mpeg'), body: f.body };
    // A few kept in memory for a while (a feed plays the same ones), never on disk.
    this.#keep(this.clips, key, out, 40);
    return out;
  }
}
