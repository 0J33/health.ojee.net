/* ============================================================
   health.ojee.net — music on a post (server/music.js): the line under
   a post's title that plays a 30-second preview, the sheet that opens
   it in the listener's own app, and the picker that finds a song or
   album by name or reads a pasted link.

   One preview plays at a time, anywhere in the app. Covers and
   previews come through our server; a Spotify player (an iframe) is
   loaded only when somebody presses Play on it.
   ============================================================ */

import { api } from './api.js';
import { html, mount, ic, on, sheet, toast, toastError, busy, info } from './ui.js';

const KIND = { track: 'Song', album: 'Album', playlist: 'Playlist', video: 'Video' };
const SRC = { deezer: 'Deezer', apple: 'Apple Music', spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud' };
const byline = (m) => [m.artist, m.kind !== 'track' ? KIND[m.kind] : null].filter(Boolean).join(' · ');

/* ── one player for the whole app ─────────────────────────────────── */

let audio = null; let playing = null;
// Asked to play and not yet started (loading): the button already says Pause, and a
// second tap stops it rather than asking again.
let pending = false;
const buttons = () => document.querySelectorAll('[data-mplay]');
const isOn = () => Boolean(playing && audio && (pending || !audio.paused));
function paintButtons() {
  const on = isOn();
  for (const b of buttons()) {
    const on_ = on && b.dataset.mplay === playing;
    // Only touch the ones that are wrong: this runs while playing, a few times a second.
    if (b.classList.contains('is-playing') === on_ && b.dataset.mpainted) continue;
    b.dataset.mpainted = '1';
    b.classList.toggle('is-playing', on_);
    b.closest('.mus')?.classList.toggle('is-playing', on_);
    b.setAttribute('aria-label', on_ ? 'Pause the preview' : 'Play a preview');
    const i = b.querySelector('[data-mic]');
    if (i) mount(i, ic(on_ ? 'pause' : 'play', { size: 's' }));
  }
}

/* A preview plays only while you can see where it came from: scrolled out of
   sight, another page, the app in the background (another app, the phone
   locked), it pauses. Its Play button, wherever it is drawn again, says so. */
function inSight(b) {
  if (!b.isConnected || b.closest('[hidden]')) return false;
  // Under an open sheet, only the top sheet's own buttons count: the last one opened (the song
  // picker opened from a post's sheet on a phone is over that sheet, and its previews are in it).
  const sheet = [...document.querySelectorAll('dialog[open]:not(.is-out)')].pop();
  if (sheet && !sheet.contains(b)) return false;
  const r = b.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}
function check() {
  if (!isOn()) return;
  if (document.hidden) { stopPreview(); return; }
  const mine = [...buttons()].filter((b) => b.dataset.mplay === playing);
  if (!mine.some(inSight)) { stopPreview(); return; }
  paintButtons();
}
let checkQueued = false;
const checkSoon = () => { if (checkQueued) return; checkQueued = true; requestAnimationFrame(() => { checkQueued = false; check(); }); };
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPreview(); });
  addEventListener('pagehide', () => stopPreview());
  addEventListener('scroll', () => { if (isOn()) checkSoon(); }, { passive: true, capture: true });
}

/** Play `src` (a /api/music/preview link), or pause it when it is the one playing. */
export function togglePreview(src) {
  if (!src) return;
  if (!audio) {
    audio = new Audio();
    audio.preload = 'none';
    for (const ev of ['play', 'playing', 'pause', 'ended']) audio.addEventListener(ev, paintButtons);
    audio.addEventListener('timeupdate', check);
    audio.addEventListener('error', () => { if (playing && audio.getAttribute('src')) toast('That preview could not be played.'); playing = null; pending = false; paintButtons(); });
  }
  if (playing === src && isOn()) { stopPreview(); return; }
  if (playing !== src) { audio.src = src; playing = src; }
  pending = true;
  const asked = src;
  audio.play()
    .then(() => { if (playing === asked) pending = false; paintButtons(); })
    .catch(() => { if (playing === asked) { pending = false; if (audio.paused) playing = null; } paintButtons(); });
  paintButtons();
}
/** Stop whatever preview is playing (leaving a page, out of sight, in the background). */
export function stopPreview() {
  // Also while it is still loading: a pause now stops the play that was asked for.
  pending = false;
  if (audio) audio.pause();
  paintButtons();
}

/* ── on a post ────────────────────────────────────────────────────── */

const cover = (m, cls = 'mus__art') => (m.art ? html`<img class="${cls}" src="${m.art}" alt="" loading="lazy" decoding="async">` : html`<span class="${cls} mus__art--none">${ic('music', { size: 's' })}</span>`);

/** The music strip of a post: the cover, the title and who it is by (opens the sheet), and Play on the right. */
export function musicChip(m, { postId = '' } = {}) {
  if (!m) return '';
  return html`<div class="mus" data-music="${postId}">
    <button type="button" class="mus__t" data-mopen aria-label="${m.title}${m.artist ? `, ${m.artist}` : ''}: open">
      ${cover(m)}
      <span class="mus__tx"><span class="mus__ti"><span class="mus__eq" aria-hidden="true"><i></i><i></i><i></i></span>${ic('music', { size: 's' })}<b>${m.title}</b></span><small>${byline(m) || SRC[m.src] || ''}</small></span>
    </button>
    ${m.preview ? html`<button type="button" class="mus__btn" data-mplay="${m.preview}" aria-label="Play a preview"><span data-mic>${ic('play', { size: 's' })}</span></button>`
      : html`<button type="button" class="mus__btn mus__btn--out" data-mopen aria-label="Open ${m.title}">${ic('right', { size: 's' })}</button>`}
  </div>`;
}

/** The sheet of a post's music: the cover, Play, the Spotify player, and a link out to each app. */
export function openMusic(m) {
  if (!m) return;
  const s = sheet({
    title: KIND[m.kind] || 'Music',
    cls: 'mus-sheet',
    body: html`<div class="mus-big">
        ${cover(m, 'mus-big__art')}
        <div class="mus-big__t"><b>${m.title}</b><span>${[m.artist, m.album].filter(Boolean).join(' · ')}</span></div>
        ${m.preview ? html`<button type="button" class="pill-btn pill-btn--ink mus-big__play" data-mplay="${m.preview}" aria-label="Play a preview"><span data-mic>${ic('play', { size: 's' })}</span>30-second preview</button>` : ''}
        ${m.embed ? html`<div class="mus-embed" data-embed><button type="button" class="pill-btn pill-btn--ink" data-embed-go>${ic('play', { size: 's' })}Play in Spotify's player</button><small class="muted">Loads Spotify's player here. Spotify sees that you opened it.</small></div>` : ''}
      </div>
      ${m.links?.length ? html`<p class="mus-links__k">Open in</p><ul class="mus-links">${m.links.map((l) => html`<li><a href="${l.url}" target="_blank" rel="noopener noreferrer"><span>${l.app}</span><small>${l.exact ? 'This one' : 'Search for it'}</small>${ic('external', { size: 's' })}</a></li>`)}</ul>` : ''}`,
  });
  paintButtons();
  on(s.el, 'click', '[data-mplay]', (e, b) => togglePreview(b.dataset.mplay));
  s.el.querySelector('[data-embed-go]')?.addEventListener('click', () => {
    stopPreview();
    const slot = s.el.querySelector('[data-embed]');
    const tall = m.kind === 'album' || m.kind === 'playlist';
    mount(slot, html`<iframe class="mus-embed__f ${tall ? 'is-tall' : ''}" src="${m.embed}" title="Spotify player: ${m.title}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`);
  });
}

/** Play and open, for every music line under `root`. `find(postId)` gives the post. */
export function bindMusic(root, find) {
  on(root, 'click', '[data-mplay]', (e, b) => { e.preventDefault(); e.stopPropagation(); togglePreview(b.dataset.mplay); });
  on(root, 'click', '[data-mopen]', (e, b) => {
    e.preventDefault();
    const p = find(b.closest('[data-music]')?.dataset.music);
    if (p?.music) openMusic(p.music);
  });
}

/* ── choosing it ──────────────────────────────────────────────────── */

const isLink = (s) => /^https?:\/\/\S+$/i.test(s.trim());

function row(m, i) {
  return html`<li class="mpick__r">
    ${m.preview ? html`<button type="button" class="mus__play" data-mplay="${m.preview}" aria-label="Play a preview">${cover(m)}<span class="mus__pi" data-mic>${ic('play', { size: 's' })}</span></button>` : cover(m)}
    <button type="button" class="mpick__b" data-choose="${i}"><b>${m.title}</b><small>${byline(m) || SRC[m.src]}</small></button>
  </li>`;
}

/**
 * The picker: search by name, or paste a link from Spotify, Apple Music,
 * YouTube, SoundCloud or Deezer. Resolves to the pick to send
 * ({ deezer } or { url }) and the item to show, or null when closed.
 */
export function pickMusic() {
  return new Promise((resolve) => {
    let found = []; let seq = 0; let timer = null; let done = false;
    const s = sheet({
      title: html`Add music${info('Links from Spotify, Apple Music, YouTube, SoundCloud and Deezer work, playlists too.', { label: 'About adding music' })}`,
      cls: 'mpick-sheet',
      body: html`<div class="mpick">
        <label class="field">
          <input class="input" type="search" name="q" placeholder="Search a song or album, or paste a link" aria-label="Search songs and albums, or paste a link" autocomplete="off" enterkeyhint="search" data-q></label>
        <div data-res></div>
      </div>`,
    });
    s.closed.then(() => { stopPreview(); if (!done) resolve(null); });
    const q = s.el.querySelector('[data-q]');
    const res = s.el.querySelector('[data-res]');
    const show = (content) => { if (res.isConnected) { mount(res, content); paintButtons(); } };
    const run = async () => {
      const v = q.value.trim();
      const my = (seq += 1);
      if (v.length < 2) { found = []; show(''); return; }
      show(html`<p class="muted small mpick__msg">${isLink(v) ? 'Reading the link' : 'Searching'}</p>`);
      try {
        if (isLink(v)) {
          const r = await api.get(`/api/music/resolve?url=${encodeURIComponent(v)}`);
          if (my !== seq) return;
          found = [r.item];
          show(html`<ul class="mpick__l">${row(r.item, 0)}</ul>`);
        } else {
          const r = await api.get(`/api/music/search?q=${encodeURIComponent(v)}`);
          if (my !== seq) return;
          found = [...r.tracks, ...r.albums];
          show(found.length ? html`
            ${r.tracks.length ? html`<p class="mpick__k">Songs</p><ul class="mpick__l">${r.tracks.map((m, i) => row(m, i))}</ul>` : ''}
            ${r.albums.length ? html`<p class="mpick__k">Albums</p><ul class="mpick__l">${r.albums.map((m, i) => row(m, r.tracks.length + i))}</ul>` : ''}
            <p class="muted small mpick__src">Search by Deezer. A playlist: paste its link.</p>`
            : html`<p class="muted small mpick__msg">Nothing found for that. Try other words, or paste a link.</p>`);
        }
      } catch (err) {
        if (my !== seq) return;
        found = [];
        show(html`<p class="small mpick__msg is-bad">${err?.message || 'That could not be found.'}</p>`);
      }
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, isLink(q.value) ? 0 : 300); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
    on(s.el, 'click', '[data-mplay]', (e, b) => togglePreview(b.dataset.mplay));
    on(s.el, 'click', '[data-choose]', (e, b) => {
      const m = found[Number(b.dataset.choose)];
      if (!m) return;
      done = true;
      resolve({ pick: m.pick, item: m });
      s.close();
    });
    setTimeout(() => q.focus(), 50);
  });
}

/**
 * The Music field of a post's sheet: what is on it, Change, Remove.
 * `save(music)` sends { music } (a pick, or null) and returns the post.
 */
export function musicField(p) {
  const m = p.music;
  return html`<div class="field" data-mfield><span class="field__label">Music${info('What you listened to. Friends can play a preview and open it in their app.', { label: 'About music' })}</span>
    ${m ? html`<div class="mfield">${musicChip(m, { postId: p.id })}<span class="mfield__b">
        <button type="button" class="pill-btn pill-btn--soft" data-mchange>Change</button>
        <button type="button" class="pill-btn pill-btn--soft" data-mremove>Remove</button></span></div>`
      : html`<button type="button" class="btn btn--tonal mfield__add" data-mchange>${ic('music', { size: 's' })}Add a song, album or playlist</button>`}</div>`;
}

/** Change and Remove in a Music field under `root`. `save(music)` returns the changed post. */
export function bindMusicField(root, p, save, repaint) {
  on(root, 'click', '[data-mchange]', async (e, b) => {
    const got = await pickMusic();
    if (!got) return;
    await busy(b, async () => {
      try { Object.assign(p, await save(got.pick)); toast('Music added'); repaint(); } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-mremove]', async (e, b) => busy(b, async () => {
    try { stopPreview(); Object.assign(p, await save(null)); repaint(); } catch (err) { toastError(err); }
  }));
  on(root, 'click', '[data-mplay]', (e, b) => togglePreview(b.dataset.mplay));
  on(root, 'click', '[data-mopen]', () => openMusic(p.music));
}
