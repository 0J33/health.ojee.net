/* Photos and videos: on your own feed posts, and your profile photo.

   Everything heavy happens here, in the browser, before a byte is sent:
   a photo is decoded, shrunk to 2048 px on its longest side and saved
   again as JPEG (with a 480 px preview beside it); a profile photo is cut
   square from the middle at 512 px; a video is checked for its type,
   size (100 MB) and length (2 minutes) and a poster frame is taken from
   about one second in. The server re-encodes nothing.

   Then the file goes up in 4 MB pieces (the site's proxy takes 6 MB a
   request at most): POST /api/media, PUT …/chunk?i=N for each piece in
   order, PUT …/thumb, POST …/done. docs/API.md has the details.

   Also here: the strip of photos on a post card, the full-screen viewer,
   the sheet that shows each upload's progress, the post's edit grid, and
   changing or removing the profile photo. */

import { api, ApiError } from './api.js';
import { app, setMe } from './app.js';
import { html, mount, ic, sheet, toast, toastError, confirm, busy, on } from './ui.js';

export const MAX_PER_POST = 10;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_S = 120;
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm' };

/* ── picking ────────────────────────────────────────────────── */

/** The system file picker. Resolves the chosen files, or [] when cancelled. */
export function pickFiles({ accept = 'image/*,video/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.hidden = true;
    document.body.append(input);
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files || [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    input.click();
  });
}

const isVideo = (file) => /^video\//.test(file.type) || /\.(mp4|m4v|mov|qt|webm)$/i.test(file.name || '');
const videoType = (file) => (Object.values(VIDEO_TYPES).includes(file.type) ? file.type : VIDEO_TYPES[(/\.([a-z0-9]+)$/i.exec(file.name || '')?.[1] || '').toLowerCase()] || null);
const words = (file) => (isVideo(file) ? 'This video' : 'This photo');
const fail = (message) => Object.assign(new Error(message), { mine: true });

/* ── getting a file ready ───────────────────────────────────── */

/** Decode a picked photo, the right way up. Throws a sentence when the browser cannot read it (some HEIC files on a desktop). */
async function decode(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* try an <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw fail(`${words(file)} could not be opened in this browser. Try a JPEG or PNG${/hei[cf]/i.test(file.type + file.name) ? ' (on an iPhone, choose it from Photos rather than Files)' : ''}.`);
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

const toJpeg = (canvas, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(fail('This photo could not be saved for upload.'))), 'image/jpeg', quality);
});

/** Draw (part of) a source at a size, as JPEG. */
async function draw(src, { sx = 0, sy = 0, sw, sh, w, h, quality = 0.85 }) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const blob = await toJpeg(c, quality);
  c.width = 0; c.height = 0;   // let the memory go at once (an iPhone keeps little)
  return blob;
}

/**
 * A photo, shrunk and saved again. `square`: a profile photo, that many
 * pixels, cut from the middle.
 *
 * Privacy: drawing the photo onto a canvas and saving that keeps only its
 * pixels. The EXIF data a phone writes into a photo (where it was taken,
 * to a few metres; the device; the time) is not carried over, so it never
 * leaves this device.
 */
export async function prepImage(file, { max = 2048, square = 0 } = {}) {
  const src = await decode(file);
  const W = src.width || src.naturalWidth; const H = src.height || src.naturalHeight;
  if (!W || !H) throw fail(`${words(file)} could not be opened in this browser.`);
  try {
    if (square) {
      const s = Math.min(W, H); const out = Math.min(square, s);
      const blob = await draw(src, { sx: (W - s) / 2, sy: (H - s) / 2, sw: s, sh: s, w: out, h: out, quality: 0.88 });
      return { blob, type: 'image/jpeg', w: out, h: out, thumb: null, preview: URL.createObjectURL(blob) };
    }
    const k = Math.min(1, max / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k)); const h = Math.max(1, Math.round(H * k));
    const blob = await draw(src, { sw: W, sh: H, w, h, quality: 0.85 });
    const t = Math.min(1, 480 / Math.max(W, H));
    const thumb = await draw(src, { sw: W, sh: H, w: Math.max(1, Math.round(W * t)), h: Math.max(1, Math.round(H * t)), quality: 0.8 });
    return { blob, type: 'image/jpeg', w, h, thumb, preview: URL.createObjectURL(thumb) };
  } finally { src.close?.(); }
}

/** Wait for one event, or give up. */
const once = (el, ok, bad, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { clean(); reject(new Error('timeout')); }, ms);
  const yes = () => { clean(); resolve(); };
  const no = () => { clean(); reject(new Error('error')); };
  const clean = () => { clearTimeout(t); el.removeEventListener(ok, yes); if (bad) el.removeEventListener(bad, no); };
  el.addEventListener(ok, yes); if (bad) el.addEventListener(bad, no);
});

/** A video: its type, size and length checked here, and a poster frame from about a second in. */
export async function prepVideo(file) {
  const type = videoType(file);
  if (!type) throw fail('Only MP4, MOV and WebM videos can be added.');
  if (file.size > MAX_VIDEO_BYTES) throw fail(`This video is ${Math.round(file.size / 1048576)} MB. Videos can be up to 100 MB.`);
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', '');
  v.src = url;
  try {
    try { await once(v, 'loadedmetadata', 'error', 15_000); } catch { throw fail('This video cannot be played in this browser, so it cannot be checked. Try an MP4.'); }
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw fail('The length of this video could not be read. Try an MP4.');
    if (duration > MAX_VIDEO_S + 0.5) throw fail(`This video is ${clock(duration)} long. Videos can be up to 2 minutes.`);
    const W = v.videoWidth; const H = v.videoHeight;
    let thumb = null;
    try {
      v.currentTime = Math.min(1, duration / 2);
      await once(v, 'seeked', 'error', 6000);
      if (W && H) { const k = Math.min(1, 480 / Math.max(W, H)); thumb = await draw(v, { sw: W, sh: H, w: Math.round(W * k), h: Math.round(H * k), quality: 0.8 }); }
    } catch { thumb = null; }   // no poster: the strip shows a plain tile with the play mark
    return { blob: file, type, w: W || null, h: H || null, duration: Math.round(duration * 10) / 10, thumb, preview: thumb ? URL.createObjectURL(thumb) : null };
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}

/* ── sending ────────────────────────────────────────────────── */

/** One request with upload progress (fetch has none). */
function xhr(method, url, body, type, onUp) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.setRequestHeader('content-type', type);
    x.setRequestHeader('accept', 'application/json');
    if (onUp) x.upload.onprogress = (e) => onUp(e.loaded);
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new ApiError(d?.error || (x.status === 413 ? 'That piece was too large for the server.' : 'The upload did not go through.'), { status: x.status, code: d?.code || '' }));
    };
    x.onerror = () => reject(new ApiError('Could not reach the server. Check your connection and try again.', { offline: true }));
    x.send(body);
  });
}

/**
 * Send a prepared file in pieces. `onProgress(0..1)` as bytes go out.
 * A piece that fails on the network is tried again twice; anything else
 * stops the upload, and what was sent is dropped.
 */
export async function upload({ kind, postId = null, prep, name = null }, onProgress = () => {}) {
  const total = prep.blob.size;
  const start = await api.post('/api/media', { kind, postId, type: prep.type, size: total, w: prep.w, h: prep.h, duration: prep.duration ?? null, name });
  const { id, chunk } = start;
  try {
    for (let i = 0; i * chunk < total; i += 1) {
      const part = prep.blob.slice(i * chunk, Math.min(total, (i + 1) * chunk));
      for (let tries = 0; ; tries += 1) {
        try { await xhr('PUT', `/api/media/${id}/chunk?i=${i}`, part, 'application/octet-stream', (n) => onProgress(Math.min(0.99, (i * chunk + n) / total))); break; } catch (err) {
          if (tries >= 2 || !(err.offline || err.status >= 500)) throw err;
          await new Promise((r) => { setTimeout(r, 800 * (tries + 1)); });
        }
      }
    }
    if (prep.thumb) await xhr('PUT', `/api/media/${id}/thumb`, prep.thumb, 'image/jpeg').catch(() => null);
    const done = await api.post(`/api/media/${id}/done`);
    onProgress(1);
    return done;
  } catch (err) {
    api.del(`/api/media/${id}`).catch(() => {});
    throw err;
  }
}

/* ── on a post ──────────────────────────────────────────────── */

const clock = (s) => { const t = Math.max(0, Math.round(s || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const ratio = (m) => (m.w > 0 && m.h > 0 ? `${m.w} / ${m.h}` : '4 / 3');

/** The photos and videos of a post, above its numbers: one full width in its own shape;
    two side by side, three as one large and two small, four or more as a square of four
    with how many more on the last. Any of them opens the viewer there, to swipe through all. */
export function mediaStrip(media) {
  if (!Array.isArray(media) || !media.length) return '';
  const n = media.length;
  const one = n === 1;
  const shown = Math.min(n, 4);
  const more = n - shown;
  const item = (m, i) => {
    const extra = i === shown - 1 && more > 0 ? more : 0;
    const label = `${m.kind === 'video' ? `Video, ${clock(m.duration)}` : 'Photo'}${one ? '' : `, ${i + 1} of ${n}`}${extra ? `, and ${extra} more` : ''}`;
    const pic = m.kind === 'video'
      ? (m.thumb ? html`<img src="${m.thumb}" alt="" loading="lazy" decoding="async">` : '')
      : one && m.thumb && m.thumb !== m.url
        ? html`<img src="${m.thumb}" srcset="${m.thumb} 480w, ${m.url} ${m.w || 2048}w" sizes="(min-width: 700px) 640px, 100vw" alt="" loading="lazy" decoding="async">`
        : html`<img src="${m.thumb || m.url}" alt="" loading="lazy" decoding="async">`;
    return html`<button type="button" class="pm__i ${m.kind === 'video' ? 'pm__i--v' : ''}" data-media-open="${i}" ${one ? html`data-style="--ar:${ratio(m)}"` : ''} aria-label="${label}">${pic}${m.kind === 'video' && !extra ? html`<span class="pm__play" aria-hidden="true">${ic('play')}</span><span class="pm__dur n">${clock(m.duration)}</span>` : ''}${extra ? html`<span class="pm__more n" aria-hidden="true">+${extra}</span>` : ''}</button>`;
  };
  return one
    ? html`<div class="pm pm--one">${item(media[0], 0)}</div>`
    : html`<div class="pm pm--grid pm--n${shown}">${media.slice(0, shown).map(item)}</div>`;
}

/** Taps on a strip under `root` open the viewer at that item. `find(postId)` → the post. */
export function bindStrips(root, find) {
  on(root, 'click', '[data-media-open]', (e, b) => {
    e.preventDefault();
    const p = find(b.closest('[data-post]')?.dataset.post);
    if (p?.media?.length) openViewer(p.media, Number(b.dataset.mediaOpen) || 0);
  });
}

/** Full screen, one at a time: swipe or the arrows between them, a video with its controls. */
export function openViewer(items, start = 0) {
  const d = document.createElement('dialog');
  d.className = 'mview';
  d.setAttribute('aria-label', 'Photos and videos');
  mount(d, html`
    <div class="mview__track" data-track>${items.map((m, i) => html`<div class="mview__s" data-i="${i}">${m.kind === 'video'
      ? html`<video src="${m.url}" ${m.thumb ? html`poster="${m.thumb}"` : ''} controls playsinline preload="metadata"></video>`
      : html`<img src="${m.url}" alt="${items.length > 1 ? `Photo ${i + 1} of ${items.length}` : 'Photo'}" decoding="async">`}</div>`)}</div>
    <div class="mview__top"><span class="mview__n n" data-n aria-live="polite"></span><button type="button" class="mview__x" data-close aria-label="Close">${ic('x')}</button></div>
    ${items.length > 1 ? html`<button type="button" class="mview__nav mview__nav--p" data-nav="-1" aria-label="Previous">${ic('left')}</button>
      <button type="button" class="mview__nav mview__nav--n" data-nav="1" aria-label="Next">${ic('right')}</button>` : ''}`);
  document.body.append(d);
  const track = d.querySelector('[data-track]');
  const counter = d.querySelector('[data-n]');
  let at = -1;
  const show = () => {
    const i = Math.max(0, Math.min(items.length - 1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
    if (i === at) return;
    at = i;
    counter.textContent = items.length > 1 ? `${i + 1} of ${items.length}` : '';
    d.querySelectorAll('video').forEach((v, k) => { if (k !== i || items[i].kind !== 'video') v.pause(); });
    d.querySelector('[data-nav="-1"]')?.toggleAttribute('disabled', i === 0);
    d.querySelector('[data-nav="1"]')?.toggleAttribute('disabled', i === items.length - 1);
  };
  const goTo = (i, smooth = true) => track.scrollTo({ left: Math.max(0, Math.min(items.length - 1, i)) * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  let raf = 0;
  track.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(show); }, { passive: true });
  d.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { goTo(at + Number(nav.dataset.nav)); return; }
    // The close button, or a tap beside the photo.
    if (e.target.closest('[data-close]') || e.target.classList.contains('mview__s')) d.close();
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(at + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(at - 1); }
  });
  const wasOpen = document.documentElement.classList.contains('sheet-open');
  d.addEventListener('close', () => {
    d.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
    d.remove();
    if (!wasOpen && !document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
  });
  document.documentElement.classList.add('sheet-open');
  d.showModal();
  requestAnimationFrame(() => { goTo(start, false); show(); d.querySelector('[data-close]')?.focus({ preventScroll: true }); });
  // Turning a phone changes the width of a slide: stay on the same one.
  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => { if (at >= 0) goTo(at, false); }) : null;
  ro?.observe(track);
  d.addEventListener('close', () => ro?.disconnect());
  return d;
}

/**
 * Add photos and videos to one of your posts: the picker, then a sheet
 * with each one getting ready and going up, a bar each. `onDone()` once
 * they are all through (also when the sheet was closed in the meantime).
 */
export async function addToPost(post, { onDone = () => {} } = {}) {
  const left = MAX_PER_POST - (post.media?.length || 0);
  if (left <= 0) { toast(`A post can have ${MAX_PER_POST} photos and videos. Remove one to add another.`); return; }
  let files = await pickFiles();
  if (!files.length) return;
  if (files.length > left) { toast(`Only ${left} more fit on this post, so the first ${left} are added.`); files = files.slice(0, left); }
  const s = sheet({
    title: files.length === 1 ? (isVideo(files[0]) ? 'Adding a video' : 'Adding a photo') : `Adding ${files.length} photos and videos`,
    body: html`<ul class="mup">${files.map((file, i) => html`<li class="mup__i" data-i="${i}">
      <span class="mup__th" data-th>${ic(isVideo(file) ? 'play' : 'camera', { size: 's' })}</span>
      <span class="mup__b"><span class="mup__n">${file.name || (isVideo(file) ? 'Video' : 'Photo')}</span>
        <span class="mup__s" data-s>Waiting</span>
        <span class="mup__bar" aria-hidden="true"><i data-bar></i></span></span>
    </li>`)}</ul>
    <p class="muted small mup__note">Photos are made smaller and their location data is removed on this device before they are sent. Friends who see this post see them too.</p>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close data-foot>Hide</button>`,
  });
  const row = (i) => s.el.querySelector(`[data-i="${i}"]`);
  const set = (i, text, tone = '') => { const r = row(i); if (!r) return; r.querySelector('[data-s]').textContent = text; r.classList.toggle('is-bad', tone === 'bad'); r.classList.toggle('is-ok', tone === 'ok'); };
  const bar = (i, p) => { const b = row(i)?.querySelector('[data-bar]'); if (b) b.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`; };
  let ok = 0; let bad = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    row(i)?.classList.add('is-on');
    set(i, 'Getting it ready');
    let prep = null;
    try {
      prep = isVideo(file) ? await prepVideo(file) : await prepImage(file);
      const th = row(i)?.querySelector('[data-th]');
      if (th && prep.preview) mount(th, html`<img src="${prep.preview}" alt="">`);
      set(i, 'Uploading');
      await upload({ kind: 'post', postId: post.id, prep, name: file.name || null }, (p) => { bar(i, p); set(i, `Uploading, ${Math.round(p * 100)}%`); });
      set(i, 'Added', 'ok');
      ok += 1;
    } catch (err) {
      bad += 1;
      set(i, err.mine ? err.message : (err.message || 'This one did not upload. Try again.'), 'bad');
      bar(i, 0);
    } finally {
      row(i)?.classList.remove('is-on');
      if (prep?.preview) setTimeout(() => URL.revokeObjectURL(prep.preview), 60_000);
    }
  }
  const foot = s.el.querySelector('[data-foot]');
  if (foot) foot.textContent = 'Done';
  if (ok) onDone();
  if (!bad) setTimeout(() => s.close(), 500);
  if (!s.el.isConnected) toast(bad ? `${ok} added, ${bad} did not upload` : ok === 1 ? 'Added to your post' : `${ok} added to your post`, bad ? { tone: 'bad' } : {});
}

/** The edit sheet's grid: each photo or video with a small x to take it off. */
export function editGrid(post) {
  const media = post.media || [];
  return html`<div class="mgrid" data-mgrid>
    ${media.map((m) => html`<div class="mgrid__i" data-mid="${m.id}">
      ${m.thumb ? html`<img src="${m.thumb}" alt="" loading="lazy" decoding="async">` : html`<span class="mgrid__ph">${ic('play', { size: 's' })}</span>`}
      ${m.kind === 'video' ? html`<span class="pm__dur n">${clock(m.duration)}</span>` : ''}
      <button type="button" class="mgrid__x" data-mdel aria-label="Remove this ${m.kind === 'video' ? 'video' : 'photo'}">${ic('x', { size: 's' })}</button>
    </div>`)}
    ${media.length < MAX_PER_POST ? html`<button type="button" class="mgrid__add" data-madd>${ic('plus')}<span>${media.length ? 'Add more' : 'Add photos or videos'}</span></button>` : ''}
  </div>`;
}

/** Wire an editGrid inside `el`: remove one, add more. `changed()` after either. */
export function bindEditGrid(el, post, changed) {
  on(el, 'click', '[data-mdel]', async (e, b) => {
    const tile = b.closest('[data-mid]');
    const id = tile?.dataset.mid;
    if (!id) return;
    await busy(b, async () => {
      try {
        await api.del(`/api/media/${encodeURIComponent(id)}`);
        post.media = (post.media || []).filter((m) => m.id !== id);
        const grid = el.querySelector('[data-mgrid]');
        if (grid) grid.outerHTML = String(editGrid(post));
        changed();
      } catch (err) { toastError(err); }
    });
  });
  on(el, 'click', '[data-madd]', () => addToPost(post, { onDone: changed }));
}

/* ── the profile photo ──────────────────────────────────────── */

/** Choose a photo, see it cut square, use it. */
async function choosePhoto() {
  const [file] = await pickFiles({ accept: 'image/*', multiple: false });
  if (!file) return;
  let prep;
  try { prep = await prepImage(file, { square: 512 }); } catch (err) { toast(err.mine ? err.message : 'That photo could not be read.', { tone: 'bad' }); return; }
  const s = sheet({
    title: 'Profile photo',
    body: html`<div class="avpick"><span class="avpick__c"><img src="${prep.preview}" alt="The photo, cut square"></span>
      <p class="muted small">Cut square from the middle. Its location data is removed on this device. Whoever can see your profile sees it: on the boards, in the feed, next to your comments.</p>
      <p class="mup__s" data-s aria-live="polite"></p></div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-use>Use this photo</button>`,
  });
  s.el.querySelector('[data-use]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = s.el.querySelector('[data-s]');
    try {
      await upload({ kind: 'avatar', prep, name: file.name || null }, (p) => { st.textContent = `Uploading, ${Math.round(p * 100)}%`; });
      setMe(await api.get('/api/me'));
      toast('Profile photo updated');
      s.close();
    } catch (err) { st.textContent = ''; toastError(err); }
  }));
  s.closed.then(() => setTimeout(() => URL.revokeObjectURL(prep.preview), 1000));
}

export async function removePhoto() {
  if (!(await confirm({ title: 'Remove your profile photo?', text: 'Your initials show in its place, everywhere.', yes: 'Remove', danger: true }))) return;
  try { setMe(await api.patch('/api/profile', { avatar: null })); toast('Profile photo removed'); } catch (err) { toastError(err); }
}

/** Change or remove the profile photo: straight to the picker when there is none yet. */
export function photoMenu() {
  if (!app.me?.profile?.avatar) { choosePhoto(); return; }
  const s = sheet({
    title: 'Profile photo',
    body: html`<div class="st-grp">
      <button type="button" class="st-row" data-ph="change"><span class="st-ic">${ic('camera')}</span><span class="st-b"><span class="st-t">Choose a new photo</span></span></button>
      <button type="button" class="st-row st-row--danger" data-ph="remove"><span class="st-ic">${ic('trash')}</span><span class="st-b"><span class="st-t">Remove photo</span></span></button>
    </div>`,
  });
  on(s.el, 'click', '[data-ph]', (e, b) => { s.close(); if (b.dataset.ph === 'change') choosePhoto(); else removePhoto(); });
}
