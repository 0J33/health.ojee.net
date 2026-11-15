/* Photos and videos: on your own feed posts, and your profile photo.

   Everything heavy happens here, in the browser, before a byte is sent:
   a photo is decoded, shrunk to 2048 px on its longest side and saved
   again as JPEG (with a 480 px preview beside it); a profile photo is cut
   square from the middle at 512 px; a video is checked for its type,
   size (100 MB) and length (2 minutes) and a poster frame is taken from
   about one second in.

   What this browser cannot open is sent as it was picked, and the server
   does it instead (server/mediaproc.js): a HEIC photo on Android or a
   computer, AVIF, TIFF…, made a JPEG there; a video this browser cannot
   play, read there for its length and poster. The server also keeps
   every video as MP4 or WebM any browser plays (an iPhone's HEVC is
   encoded again as H.264), which can take a minute or two: then `done`
   answers { processing: true } and the video joins its post when ready.

   Then the file goes up in 4 MB pieces (the site's proxy takes 6 MB a
   request at most): POST /api/media, PUT …/chunk?i=N for each piece in
   order, PUT …/thumb, POST …/done. docs/API.md has the details.

   Also here: the strip of photos on a post card, the full-screen viewer,
   the sheet that shows each upload's progress, the post's edit grid, and
   changing or removing the profile photo. */

import { api, ApiError } from './api.js';
import { app, setMe } from './app.js';
import { html, mount, ic, sheet, toast, toastError, confirm, busy, on, info } from './ui.js';

export const MAX_PER_POST = 10;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_S = 120;
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', mkv: 'video/x-matroska', avi: 'video/x-msvideo' };
const VIDEO_MIME = [...Object.values(VIDEO_TYPES), 'video/x-m4v'];
// Photos the server can make a JPEG of when this browser cannot open them (the original goes, up to 40 MB).
const PHOTO_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif', bmp: 'image/bmp' };
const MAX_RAW_PHOTO = 40 * 1024 * 1024;
const ext = (file) => (/\.([a-z0-9]+)$/i.exec(file.name || '')?.[1] || '').toLowerCase();
const photoType = (file) => (Object.values(PHOTO_TYPES).includes(file.type) ? file.type : PHOTO_TYPES[ext(file)] || null);
/** What the picker offers: everything a phone or camera saves (some pickers hide HEIC behind image/* alone). */
export const ACCEPT_PHOTOS = 'image/*,.heic,.heif,.avif';
export const ACCEPT_MEDIA = `${ACCEPT_PHOTOS},video/*,.mkv,.3gp`;

/* ── picking ────────────────────────────────────────────────── */

/** The system file picker. Resolves the chosen files, or [] when cancelled. */
export function pickFiles({ accept = ACCEPT_MEDIA, multiple = true } = {}) {
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

const isVideo = (file) => /^video\//.test(file.type) || /\.(mp4|m4v|mov|qt|webm|3gp|mkv|avi)$/i.test(file.name || '');
const videoType = (file) => (VIDEO_MIME.includes(file.type) ? file.type : VIDEO_TYPES[ext(file)] || null);
const words = (file) => (isVideo(file) ? 'This video' : 'This photo');
const fail = (message) => Object.assign(new Error(message), { mine: true });

/* ── getting a file ready ───────────────────────────────────── */

/** Decode a picked photo, the right way up. Throws a sentence when the browser cannot read it (some HEIC files on a desktop). */
async function decode(file) {
  if (file.size > 60 * 1024 * 1024) throw fail(`${words(file)} is too large to open.`);
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
export async function prepImage(file, { max = 2048, square = 0, raw = false } = {}) {
  let src;
  try { src = await decode(file); } catch (err) {
    // The server makes the JPEG instead (and drops the metadata there), for uploads to posts and the profile photo.
    const type = raw && photoType(file);
    if (!type) throw err;
    if (file.size > MAX_RAW_PHOTO) throw fail(`This photo is ${Math.round(file.size / 1048576)} MB, and this browser cannot make it smaller. Photos like this can be up to 40 MB.`);
    return { blob: file, type, w: null, h: null, thumb: null, preview: null, convert: true };
  }
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
  if (!type) throw fail('Only MP4, MOV, WebM, MKV, 3GP and AVI videos can be added.');
  if (file.size > MAX_VIDEO_BYTES) throw fail(`This video is ${Math.round(file.size / 1048576)} MB. Videos can be up to 100 MB.`);
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', '');
  v.src = url;
  try {
    // Not playable here (HEVC on some computers, MKV, AVI…): the server reads its length and takes its poster.
    const unread = { blob: file, type, w: null, h: null, duration: null, thumb: null, preview: null };
    try { await once(v, 'loadedmetadata', 'error', 15_000); } catch { return unread; }
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) return unread;
    if (duration > MAX_VIDEO_S + 0.5) throw fail(`This video is ${clock(duration)} long. Videos can be up to 2 minutes.`);
    const W = v.videoWidth; const H = v.videoHeight;
    let thumb = null;
    try {
      v.currentTime = Math.min(1, duration / 2);
      await once(v, 'seeked', 'error', 6000);
      // Drawn right after seeking, phones often give a black frame: wait until one is shown.
      await new Promise((res) => { const t = setTimeout(res, 400); if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { clearTimeout(t); res(); }); });
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
  const start = await api.post('/api/media', { kind, postId, type: prep.type, size: total, w: prep.w, h: prep.h, duration: prep.duration ?? null, name, ...(prep.convert ? { convert: true } : {}) });
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
    more in one row of up to three,
    with how many more on the last. Any of them opens the viewer there, to swipe through all. */
export function mediaStrip(media) {
  if (!Array.isArray(media) || !media.length) return '';
  const n = media.length;
  const one = n === 1;
  const shown = Math.min(n, 3);
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
    if (p?.media?.length) openViewer(p.media, Number(b.dataset.mediaOpen) || 0, { report: !p.mine });
  });
}

/** Full screen, one at a time: swipe or the arrows between them, a video with its controls. */
/* ── zooming a photo in the viewer ─────────────────────────────
   Pinch, or double-tap where you want to look closer (again to come back out); a laptop
   double-clicks, scrolls the wheel or pinches its trackpad. Zoomed in, a finger or the mouse
   moves the photo about, held to its edges; zoomed out, swiping turns the photos and dragging
   down closes, as before. Touch events, not pointer events, for the fingers: only they can
   stop the browser taking two fingers as its own pinch or the track's scroll. */
const ZMAX = 5;
const ZTAP = 2.5;
function zoomable(d, track, current, still) {
  let z = 1; let tx = 0; let ty = 0;
  let pinch = null; let pan = null; let lastTap = null; let moved = false; let swallowUntil = 0;
  const el = () => current();
  const apply = (anim = false) => {
    const im = el(); if (!im) return;
    im.style.transition = anim && !still ? 'transform 260ms cubic-bezier(0.23, 1, 0.32, 1)' : 'none';
    im.style.transform = z === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
    im.style.cursor = z > 1 ? 'grab' : '';
    d.classList.toggle('is-zoomed', z > 1.01);
  };
  // How far the photo may move: the picture itself (object-fit: contain), not its box.
  const limits = (zz = z) => {
    const im = el(); if (!im) return { x: 0, y: 0 };
    const bw = im.clientWidth; const bh = im.clientHeight;
    const ar = im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : bw / Math.max(1, bh);
    const cw = Math.min(bw, bh * ar); const ch = Math.min(bh, bw / ar);
    return { x: Math.max(0, (cw * zz - bw) / 2), y: Math.max(0, (ch * zz - bh) / 2) };
  };
  const clampT = (rubber = false) => {
    const L = limits();
    const c = (v, m) => {
      if (Math.abs(v) <= m) return v;
      const over = Math.abs(v) - m;
      return Math.sign(v) * (m + (rubber ? over * 0.35 : 0));
    };
    tx = c(tx, L.x); ty = c(ty, L.y);
  };
  const centre = () => { const r = el().getBoundingClientRect(); return { x: r.left + r.width / 2 - tx, y: r.top + r.height / 2 - ty }; };
  // Zoom to `nz`, keeping the point (px, py) on the screen where it is.
  const zoomAt = (nz, px, py, anim) => {
    const im = el(); if (!im) return;
    const c = centre();
    const qx = (px - c.x - tx) / z; const qy = (py - c.y - ty) / z;
    z = nz; tx = px - c.x - z * qx; ty = py - c.y - z * qy;
    if (z <= 1) { z = 1; tx = 0; ty = 0; }
    clampT();
    apply(anim);
  };
  const toggleAt = (px, py) => {
    if (z > 1.01) { z = 1; tx = 0; ty = 0; apply(true); } else zoomAt(ZTAP, px, py, true);
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  track.addEventListener('touchstart', (e) => {
    const im = el();
    if (!im || !e.target.closest('.mview__s')) return;
    moved = false;
    if (e.touches.length === 2) {
      const m = mid(e.touches); const c = centre();
      pinch = { d0: dist(e.touches), z0: z, qx: (m.x - c.x - tx) / z, qy: (m.y - c.y - ty) / z };
      pan = null; lastTap = null;
    } else if (e.touches.length === 1 && z > 1.01) {
      pan = { x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty };
    }
  }, { passive: true });
  track.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault(); moved = true;
      const m = mid(e.touches); const c = centre();
      // Past the ends it gives a little, then springs back on letting go.
      let nz = pinch.z0 * (dist(e.touches) / pinch.d0);
      if (nz > ZMAX) nz = ZMAX + (nz - ZMAX) * 0.25;
      if (nz < 1) nz = 1 - (1 - nz) * 0.4;
      z = nz; tx = m.x - c.x - z * pinch.qx; ty = m.y - c.y - z * pinch.qy;
      if (z > 1) clampT(true);
      apply();
    } else if (pan && e.touches.length === 1) {
      e.preventDefault(); moved = true;
      tx = e.touches[0].clientX - pan.x; ty = e.touches[0].clientY - pan.y;
      clampT(true); apply();
    } else if (e.touches.length === 1) moved = moved || false;
  }, { passive: false });
  const settle = () => {
    if (z < 1.01) { z = 1; tx = 0; ty = 0; } else if (z > ZMAX) z = ZMAX;
    clampT(); apply(true);
  };
  track.addEventListener('touchend', (e) => {
    if (pinch) {
      if (e.touches.length < 2) {
        pinch = null; swallowUntil = performance.now() + 350; settle();
        // One finger still down on a zoomed photo carries on moving it.
        if (e.touches.length === 1 && z > 1.01) pan = { x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty };
      }
      return;
    }
    if (pan && !e.touches.length) { pan = null; settle(); }
    // A tap: a second one soon after, near the first, zooms in or out there.
    if (moved || e.touches.length || e.changedTouches.length !== 1 || !el() || !e.target.closest('.mview__s img')) { lastTap = null; return; }
    const t = e.changedTouches[0]; const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 32) {
      e.preventDefault(); lastTap = null; swallowUntil = now + 350;
      toggleAt(t.clientX, t.clientY);
    } else lastTap = { t: now, x: t.clientX, y: t.clientY };
  });
  track.addEventListener('touchcancel', () => { pinch = null; pan = null; settle(); });

  // A laptop: double-click, the wheel (a trackpad's pinch comes as the wheel with ctrlKey),
  // and dragging with the mouse once zoomed in.
  track.addEventListener('dblclick', (e) => {
    if (!el() || !e.target.closest('.mview__s img')) return;
    e.preventDefault(); swallowUntil = performance.now() + 350;
    toggleAt(e.clientX, e.clientY);
  });
  track.addEventListener('wheel', (e) => {
    if (!el() || !e.target.closest('.mview__s')) return;
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // sideways: turn the photos
    e.preventDefault();
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
    zoomAt(Math.min(ZMAX, Math.max(1, z * k)), e.clientX, e.clientY, false);
  }, { passive: false });
  let mouse = null;
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || z <= 1.01 || !el()) return;
    e.preventDefault();
    mouse = { id: e.pointerId, x: e.clientX - tx, y: e.clientY - ty, sx: e.clientX, sy: e.clientY };
    try { track.setPointerCapture(e.pointerId); } catch { /* gone */ }
    el().style.cursor = 'grabbing';
  });
  track.addEventListener('pointermove', (e) => {
    if (!mouse || e.pointerId !== mouse.id) return;
    tx = e.clientX - mouse.x; ty = e.clientY - mouse.y; clampT(true); apply();
  });
  const mouseUp = (e) => {
    if (!mouse || e.pointerId !== mouse.id) return;
    if (Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 4) swallowUntil = performance.now() + 350;
    mouse = null; settle();
  };
  track.addEventListener('pointerup', mouseUp);
  track.addEventListener('pointercancel', mouseUp);

  return {
    /** Zoomed in, or two fingers down: swiping and drag-to-close stand aside. */
    busy: () => z > 1.01 || Boolean(pinch) || Boolean(mouse),
    /** A click that was really the end of a zoom gesture. */
    swallow: () => performance.now() < swallowUntil,
    step: (k) => { const im = el(); if (!im) return; const r = im.getBoundingClientRect(); zoomAt(Math.min(ZMAX, Math.max(1, z * k)), r.left + r.width / 2, r.top + r.height / 2, true); },
    reset: (anim) => { if (z === 1 && !tx && !ty) return; z = 1; tx = 0; ty = 0; apply(anim); track.querySelectorAll('.mview__s img').forEach((im) => { if (im !== el()) { im.style.transform = ''; im.style.transition = ''; } }); },
  };
}

export function openViewer(items, start = 0, { report = false } = {}) {
  const d = document.createElement('dialog');
  d.className = 'mview';
  d.setAttribute('aria-label', 'Photos and videos');
  mount(d, html`
    <div class="mview__track" data-track>${items.map((m, i) => html`<div class="mview__s" data-i="${i}">${m.kind === 'video'
      ? html`<video src="${m.url}" ${m.thumb ? html`poster="${m.thumb}"` : ''} controls playsinline preload="metadata"></video>`
      : html`<img src="${m.url}" draggable="false" alt="${items.length > 1 ? `Photo ${i + 1} of ${items.length}` : 'Photo'}" decoding="async">`}</div>`)}</div>
    <div class="mview__top"><span class="mview__n n" data-n aria-live="polite"></span>${report ? html`<button type="button" class="mview__x" data-mv-report aria-label="Report this photo or video">${ic('flag')}</button>` : ''}<button type="button" class="mview__x" data-close aria-label="Close">${ic('x')}</button></div>
    ${items.length > 1 ? html`<button type="button" class="mview__nav mview__nav--p" data-nav="-1" aria-label="Previous">${ic('left')}</button>
      <button type="button" class="mview__nav mview__nav--n" data-nav="1" aria-label="Next">${ic('right')}</button>` : ''}`);
  document.body.append(d);
  const track = d.querySelector('[data-track]');
  const counter = d.querySelector('[data-n]');
  // Somebody else's: report the one shown (safety.js).
  d.querySelector('[data-mv-report]')?.addEventListener('click', () => { const m = items[Math.max(0, at)]; if (m?.id) import('./safety.js').then(({ reportMedia }) => reportMedia(m.id)); });
  let at = -1;
  const show = () => {
    const i = Math.max(0, Math.min(items.length - 1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
    if (i === at) return;
    zoom.reset(false);
    at = i;
    counter.textContent = items.length > 1 ? `${i + 1} of ${items.length}` : '';
    d.querySelectorAll('video').forEach((v, k) => { if (k !== i || items[i].kind !== 'video') v.pause(); });
    d.querySelector('[data-nav="-1"]')?.toggleAttribute('disabled', i === 0);
    d.querySelector('[data-nav="1"]')?.toggleAttribute('disabled', i === items.length - 1);
  };
  const goTo = (i, smooth = true) => track.scrollTo({ left: Math.max(0, Math.min(items.length - 1, i)) * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  let raf = 0;
  track.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(show); }, { passive: true });
  // Drag down to close: the photo follows the finger and the dark fades to the page; let go far
  // enough (or flick) and it goes, else it springs back. Sideways stays the swipe between them.
  let drag = null; let swallow = false;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const piece = () => track.children[at]?.firstElementChild;
  const zoom = zoomable(d, track, () => (items[at]?.kind === 'video' ? null : piece()), still);
  const paint = (dy, settle = false) => {
    const el = piece(); if (!el) return;
    const p = Math.min(1, Math.max(0, dy) / (track.clientHeight || 600));
    el.style.transition = settle && !still ? 'transform 220ms var(--ease, ease)' : 'none';
    d.style.transition = settle && !still ? 'background-color 220ms' : 'none';
    el.style.transform = dy ? `translateY(${dy}px) scale(${1 - p * 0.3})` : '';
    d.style.setProperty('--mv-a', String(1 - Math.min(1, p * 1.6)));
    d.classList.toggle('is-dragging', dy > 0);
  };
  track.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || zoom.busy()) return;
    // A video can be dragged down too, but not from its controls (the bar along its bottom, the scrubber),
    // and not with a mouse (it clicks them).
    const vid = e.target.closest('video');
    if (vid && (e.pointerType === 'mouse' || e.clientY > vid.getBoundingClientRect().bottom - 80)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dy: 0, v: 0, way: '' };
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (zoom.busy()) { if (drag.way) paint(0, true); drag = null; return; }
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (!drag.way) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { drag = null; return; }
      if (dy > 10 && dy > Math.abs(dx) * 1.2) { drag.way = 'down'; try { track.setPointerCapture(e.pointerId); } catch { /* gone */ } } else return;
    }
    const dt = Math.max(1, e.timeStamp - drag.lt || 16);
    drag.v = (dy - drag.dy) / dt; drag.dy = dy; drag.lt = e.timeStamp;
    paint(Math.max(0, dy));
  });
  const letGo = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const g = drag; drag = null;
    if (g.way !== 'down') return;
    swallow = true; setTimeout(() => { swallow = false; }, 50);
    if (e.type === 'pointerup' && (g.dy > Math.min(140, track.clientHeight * 0.18) || (g.v > 0.6 && g.dy > 30))) {
      if (still) { d.close(); return; }
      paint(track.clientHeight, true);
      setTimeout(() => d.close(), 200);
    } else paint(0, true);
  };
  track.addEventListener('pointerup', letGo);
  track.addEventListener('pointercancel', letGo);
  d.addEventListener('click', (e) => {
    if (swallow || zoom.swallow()) { swallow = false; return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { goTo(at + Number(nav.dataset.nav)); return; }
    // The close button, or a tap beside the photo.
    if (e.target.closest('[data-close]') || e.target.classList.contains('mview__s')) d.close();
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(at + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(at - 1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom.step(1.6); } else if (e.key === '-') { e.preventDefault(); zoom.step(1 / 1.6); }
    else if (e.key === '0') { e.preventDefault(); zoom.reset(true); }
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
    title: html`${files.length === 1 ? (isVideo(files[0]) ? 'Adding a video' : 'Adding a photo') : `Adding ${files.length} photos and videos`}${info('Photos are made smaller and their location data is removed on this device before they are sent (a photo this browser cannot open, like HEIC, is converted on rep.\'s server instead). Videos lose their location data on the server, and are converted there when some browsers could not play them. Friends who see this post see them too.', { label: 'About uploads' })}`,
    body: html`<ul class="mup">${files.map((file, i) => html`<li class="mup__i" data-i="${i}">
      <span class="mup__th" data-th>${ic(isVideo(file) ? 'play' : 'camera', { size: 's' })}</span>
      <span class="mup__b"><span class="mup__n">${file.name || (isVideo(file) ? 'Video' : 'Photo')}</span>
        <span class="mup__s" data-s>Waiting</span>
        <span class="mup__bar" aria-hidden="true"><i data-bar></i></span></span>
    </li>`)}</ul>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close data-foot>Hide</button>`,
  });
  const row = (i) => s.el.querySelector(`[data-i="${i}"]`);
  const set = (i, text, tone = '') => { const r = row(i); if (!r) return; r.querySelector('[data-s]').textContent = text; r.classList.toggle('is-bad', tone === 'bad'); r.classList.toggle('is-ok', tone === 'ok'); };
  const bar = (i, p) => { const b = row(i)?.querySelector('[data-bar]'); if (b) b.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`; };
  let ok = 0; let bad = 0; let slow = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    row(i)?.classList.add('is-on');
    set(i, 'Getting it ready');
    let prep = null;
    try {
      prep = isVideo(file) ? await prepVideo(file) : await prepImage(file, { raw: true });
      const th = row(i)?.querySelector('[data-th]');
      if (th && prep.preview) mount(th, html`<img src="${prep.preview}" alt="">`);
      set(i, 'Uploading');
      const done = await upload({ kind: 'post', postId: post.id, prep, name: file.name || null }, (p) => { bar(i, p); set(i, p >= 0.99 ? (prep.convert || isVideo(file) ? 'Converting' : 'Finishing') : `Uploading, ${Math.round(p * 100)}%`); });
      set(i, done?.processing ? 'Uploaded. It shows on the post once it is converted, in a minute or two.' : 'Added', 'ok');
      if (done?.processing) slow += 1;
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
  if (!bad && !slow) setTimeout(() => s.close(), 500);
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

/**
 * A square to cut from a photo, moved and sized by hand: drag it (a finger
 * or the mouse), pinch, scroll or use the slider to zoom, the arrow keys to
 * move and + / − to zoom. The circle shows what the boards and the feed
 * show of it. `crop()` answers the square in the photo's own pixels.
 */
function cropper(stage, src, W, H) {
  const img = stage.querySelector('img');
  const zoom = stage.parentElement.querySelector('[data-zoom]');
  const S = () => stage.clientWidth || 280;
  let z = 1; let cx = W / 2; let cy = H / 2;   // zoom (1: the photo's short side fills the square) and the centre, in photo pixels
  const side = () => Math.min(W, H) / z;        // the square's side, in photo pixels
  const clamp = () => {
    z = Math.max(1, Math.min(6, z));
    const h = side() / 2;
    cx = Math.max(h, Math.min(W - h, cx)); cy = Math.max(h, Math.min(H - h, cy));
  };
  const paint = () => {
    clamp();
    const k = S() / side();   // screen px per photo px
    img.style.width = `${W * k}px`; img.style.height = `${H * k}px`;
    img.style.transform = `translate(${S() / 2 - cx * k}px, ${S() / 2 - cy * k}px)`;
    if (zoom && Number(zoom.value) !== z) zoom.value = String(z);
  };
  /** Zoom by `f` keeping the photo point under (px, py) on the stage where it is. */
  const zoomAt = (f, px = S() / 2, py = S() / 2) => {
    const k = S() / side();
    const ax = cx + (px - S() / 2) / k; const ay = cy + (py - S() / 2) / k;
    z *= f; clamp();
    const k2 = S() / side();
    cx = ax - (px - S() / 2) / k2; cy = ay - (py - S() / 2) / k2;
    paint();
  };
  const pts = new Map(); let last = null;
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, local(e)); last = pts.size === 2 ? mid() : local(e); stage.classList.add('is-drag'); e.preventDefault(); });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    const k = S() / side();
    if (pts.size >= 2) {
      const m = mid();
      if (last?.d) zoomAt(m.d / last.d, m.x, m.y);
      cx -= (m.x - last.x) / (S() / side()); cy -= (m.y - last.y) / (S() / side());
      last = m;
    } else {
      const p = local(e);
      cx -= (p.x - last.x) / k; cy -= (p.y - last.y) / k;
      last = p;
    }
    paint();
  });
  const up = (e) => { pts.delete(e.pointerId); last = pts.size === 2 ? mid() : pts.size === 1 ? [...pts.values()][0] : null; if (!pts.size) stage.classList.remove('is-drag'); };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  // The sheet's own pull-down never starts here.
  for (const t of ['touchstart', 'touchmove']) stage.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y); }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    const step = side() * 0.05;
    const keys = { ArrowLeft: () => { cx -= step; }, ArrowRight: () => { cx += step; }, ArrowUp: () => { cy -= step; }, ArrowDown: () => { cy += step; }, '+': () => zoomAt(1.15), '=': () => zoomAt(1.15), '-': () => zoomAt(1 / 1.15) };
    if (!keys[e.key]) return;
    e.preventDefault(); keys[e.key](); paint();
  });
  zoom?.addEventListener('input', () => zoomAt(Number(zoom.value) / z));
  new ResizeObserver(paint).observe(stage);
  paint();
  return {
    crop: () => { clamp(); const sd = side(); return { sx: cx - sd / 2, sy: cy - sd / 2, side: sd }; },
    reset: () => { z = 1; cx = W / 2; cy = H / 2; paint(); },
  };
}

/** Choose a photo, place the square, use it. */
async function choosePhoto() {
  const [file] = await pickFiles({ accept: ACCEPT_PHOTOS, multiple: false });
  if (!file) return;
  // Opened here when it can be: the square is chosen by hand and cut on this device.
  // When this browser cannot open it (HEIC on Android or a computer), the server cuts the middle.
  let src = null; let prep = null; let view = null;
  try { src = await decode(file); } catch {
    try { prep = await prepImage(file, { square: 512, raw: true }); } catch (err) { toast(err.mine ? err.message : 'That photo could not be read.', { tone: 'bad' }); return; }
  }
  const W = src ? src.width || src.naturalWidth : 0; const H = src ? src.height || src.naturalHeight : 0;
  if (src && (!W || !H)) { toast('That photo could not be read.', { tone: 'bad' }); return; }
  if (src) {
    // What is shown while it is placed: a smaller copy, quick to move about.
    const k = Math.min(1, 1600 / Math.max(W, H));
    view = URL.createObjectURL(await draw(src, { sw: W, sh: H, w: Math.round(W * k), h: Math.round(H * k), quality: 0.85 }));
  }
  const s = sheet({
    title: html`Profile photo${info(html`<p>${src ? 'Drag to move it, pinch, scroll or use the slider to zoom. ' : ''}Its location data is removed before it is kept.</p><p>Whoever can see your profile sees it: on the boards, in the feed, next to your comments.</p>`, { label: 'About your profile photo' })}`,
    body: src
      ? html`<div class="avcrop">
          <div class="avcrop__st" data-stage tabindex="0" role="application" aria-label="The photo. Drag or use the arrow keys to move it, plus and minus to zoom."><img src="${view}" alt="" draggable="false"></div>
          <label class="avcrop__z">${ic('flat', { size: 's' })}<input type="range" min="1" max="6" step="0.01" value="1" data-zoom aria-label="Zoom">${ic('plus', { size: 's' })}</label>
          <p class="mup__s" data-s aria-live="polite"></p></div>`
      : html`<div class="avpick"><span class="avpick__c"><span class="avpick__none">${ic('camera')}<span>${file.name || 'Photo'}: this browser cannot show it, so it is converted on upload and cut square from the middle.</span></span></span>
          <p class="mup__s" data-s aria-live="polite"></p></div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-use>Use this photo</button>`,
  });
  const crop = src ? cropper(s.el.querySelector('[data-stage]'), src, W, H) : null;
  s.el.querySelector('[data-use]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = s.el.querySelector('[data-s]');
    try {
      let ready = prep;
      if (crop) {
        const { sx, sy, side } = crop.crop();
        const out = Math.max(1, Math.min(512, Math.round(side)));
        const blob = await draw(src, { sx, sy, sw: side, sh: side, w: out, h: out, quality: 0.88 });
        ready = { blob, type: 'image/jpeg', w: out, h: out, thumb: null, preview: null };
      }
      await upload({ kind: 'avatar', prep: ready, name: file.name || null }, (p) => { st.textContent = `Uploading, ${Math.round(p * 100)}%`; });
      setMe(await api.get('/api/me'));
      toast('Profile photo updated');
      s.close();
    } catch (err) { st.textContent = ''; toastError(err); }
  }));
  s.closed.then(() => setTimeout(() => { if (view) URL.revokeObjectURL(view); src?.close?.(); }, 1000));
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
