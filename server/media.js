/* ============================================================
   health.ojee.net — photos and videos: on feed posts, and the
   profile photo.

   Uploads come in pieces. The production nginx takes at most 6 MB in
   one request, so a file is sent as chunks of CHUNK bytes (4 MiB):

     POST /api/media              { kind, postId?, type, size, ... } → { id, chunk }
     PUT  /api/media/:id/chunk?i=N   the raw bytes of chunk N, in order
     PUT  /api/media/:id/thumb       a small preview (≤ 1 MB), optional
     POST /api/media/:id/done        → the finished media object

   The browser has usually already shrunk and re-encoded every photo
   (which also drops its EXIF, the GPS position with it) and taken a
   poster frame of every video. What the server does (mediaproc.js, with
   ffmpeg): a photo the browser could not open (HEIC on Android or a
   computer, AVIF, TIFF…) is made into a JPEG here; every video is read
   for its real length and codecs and kept as MP4 or WebM every browser
   plays (copied when it already is, encoded again as H.264 when not:
   an iPhone's HEVC), with a poster frame when none came. It also checks
   the type is one of a list, the sizes add up, the chunks arrive in
   order, and the finished file starts the way its type says it does.

   Encoding a video again can take minutes: `done` waits up to WAIT_MS,
   then answers { processing: true } and the video joins its post when it
   is ready (state 'processing' until then; picked up again after a
   restart).

   The bytes live in files under <dataDir>/media/<userId>/, named by the
   media id and nothing a person typed. The rows are in the app store
   (appdb.js, `media`). A row deleted there, by any path (a post going,
   a person going, a photo removed), takes its files with it: AppDb calls
   onMediaGone once the deletion is committed.

   An upload not finished within an hour is dropped (sweep(), on a timer
   and on every new upload).

   Who may see a file is decided in app.js, with the post's own rule
   (feed.js) or the profile's.
   ============================================================ */

import { mkdirSync, openSync, writeSync, closeSync, readSync, renameSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortId } from './secrets.js';
import { findTools, probe, videoPlan, copyVideo, encodeVideo, posterOf, photoToJpeg } from './mediaproc.js';

export const CHUNK = 4 * 1024 * 1024;
export const LIMITS = {
  perPost: 10,
  imageBytes: 12 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  avatarBytes: 4 * 1024 * 1024,
  thumbBytes: 1024 * 1024,
  // A photo the server turns into a JPEG (the browser could not): the original, as picked.
  convertBytes: 40 * 1024 * 1024,
  videoMs: 120_000,
  // Everything one person keeps here, finished or on its way.
  personBytes: 2 * 1024 * 1024 * 1024,
  staleMs: 3_600_000,
};
const IMAGE = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
// Photos only the server turns into JPEG; they are never kept as they came.
const CONVERT = { 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif', 'image/tiff': 'tiff', 'image/gif': 'gif', 'image/bmp': 'bmp' };
// Videos taken in; each is kept as MP4 or WebM (the first three only without ffmpeg).
const VIDEO = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'mp4', 'video/3gpp': '3gp', 'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi' };
const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
/** How long `done` waits for a video being encoded again before answering { processing: true }. */
export const WAIT_MS = 45_000;
export const MEDIA_ID = /^m_[0-9a-f]{10}$/;

const bad = (message, status = 400, code) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });

/** Does the start of a file look like its type? (A renamed .exe is not a photo.) */
export function sniff(mime, head) {
  const b = head;
  const at = (i, s) => b.length >= i + s.length && b.toString('latin1', i, i + s.length) === s;
  switch (mime) {
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'video/webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'video/mp4': case 'video/quicktime': case 'video/x-m4v': case 'video/3gpp':
      return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].some((x) => at(4, x));
    case 'video/x-matroska': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'video/x-msvideo': return at(0, 'RIFF') && at(8, 'AVI ');
    case 'image/heic': case 'image/heif': case 'image/avif': return at(4, 'ftyp');
    case 'image/tiff': return at(0, 'II*\0') || at(0, 'MM\0*');
    case 'image/gif': return at(0, 'GIF8');
    case 'image/bmp': return at(0, 'BM');
    default: return false;
  }
}

/** A media row as the API shows it. */
export function mediaView(r) {
  return {
    id: r.id, kind: r.kind === 'video' ? 'video' : 'image',
    // The preview's size in its address: a poster made again (media.js #complete) is a new address, past caches.
    url: `/media/${r.id}`, thumb: r.thumb ? `/media/${r.id}/thumb${r.thumb_bytes ? `?v=${r.thumb_bytes}` : ''}` : r.kind === 'video' ? null : `/media/${r.id}`,
    w: r.w ?? null, h: r.h ?? null,
    duration: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : null,
    ...(r.state === 'processing' ? { processing: true } : {}),
  };
}

/** A post's photos and videos. `strava: false` leaves out those brought in from Strava (its owner's only). */
export function mediaOfPost(app, postId, { strava = true } = {}) {
  return app.all("SELECT * FROM media WHERE post_id = ? AND state = 'ready' ORDER BY pos, created_ms", String(postId))
    .filter((m) => strava || !String(m.name || '').startsWith('strava:')).map(mediaView);
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export class MediaStore {
  /**
   * @param {object} o
   * @param {import('./appdb.js').AppDb} o.app
   * @param {string|null} o.dir  <dataDir>/media, or null (tests in memory: nothing is kept)
   */
  constructor({ app, dir, now = () => Date.now(), log = () => {}, tools = findTools(), onReady = () => {}, waitMs = WAIT_MS }) {
    this.app = app; this.dir = dir; this.now = now; this.log = log;
    // ffmpeg (mediaproc.js): every video is read and kept as MP4 or WebM without its metadata, and photos the
    // browser could not open are made JPEG. null (tests): a video is kept as sent, and such photos are refused.
    this.ff = tools;
    // A video encoded again after `done` answered: (row) once it is on its post, or gone (row.state 'failed').
    this.onReady = onReady; this.waitMs = waitMs;
    this.busy = new Set();
    this.queue = Promise.resolve();   // one encode at a time: the box has other work
    this.jobs = new Map();            // id → its encode's promise
    app.onMediaGone = (rows) => { for (const r of rows) this.#unlink(r); };
    if (dir && tools) {
      // Encodes cut short by a restart start again.
      for (const r of app.all("SELECT * FROM media WHERE state = 'processing'")) this.#enqueue(r);
    }
    if (dir) {
      this.timer = setInterval(() => { try { this.sweep(); } catch (e) { log(`media sweep: ${e.message}`); } }, 10 * 60_000);
      this.timer.unref?.();
    }
  }
  close() { clearInterval(this.timer); }

  /* ── where the bytes are ──────────────────────────────────────── */

  #userDir(userId) { return join(this.dir, String(userId).replace(/[^A-Za-z0-9_-]/g, '_')); }
  file(r) { return join(this.#userDir(r.user_id), `${r.id}.${EXT[r.mime] || 'bin'}`); }
  thumbFile(r) { return r.thumb ? join(this.#userDir(r.user_id), `${r.id}.thumb.${EXT[r.thumb] || 'bin'}`) : null; }
  #part(r) { return join(this.#userDir(r.user_id), `${r.id}.part`); }
  #unlink(r) {
    if (!this.dir) return;
    const part = this.#part(r);
    for (const f of [this.file(r), part, `${part}.out.mp4`, `${part}.out.webm`, `${part}.out.jpg`, `${part}.poster.jpg`,
      ...Object.values(IMAGE).map((x) => join(this.#userDir(r.user_id), `${r.id}.thumb.${x}`))]) rmSync(f, { force: true });
  }
  /** After a person's rows are gone: their folder, and anything left in it. */
  forgetUser(userId) { if (this.dir) rmSync(this.#userDir(userId), { recursive: true, force: true }); }

  /* ── an upload ────────────────────────────────────────────────── */

  row(id) { return MEDIA_ID.test(String(id)) ? this.app.get('SELECT * FROM media WHERE id = ?', String(id)) || null : null; }
  /** The viewer's own upload, else a 404 (somebody else's looks like none). */
  own(userId, id) {
    const r = this.row(id);
    if (!r || r.user_id !== String(userId)) throw bad('There is no such photo or video.', 404);
    return r;
  }

  /**
   * Start one. `post`: the post row it goes on (already checked to be the
   * person's own), or null for a profile photo.
   */
  create(userId, b, post) {
    if (!this.dir) throw bad('Uploads are not available on this server.', 503);
    this.sweep();
    const type = String(b.type || '').toLowerCase().split(';')[0].trim();
    const avatar = b.kind === 'avatar';
    if (!avatar && b.kind !== 'post') throw bad("kind must be 'post' or 'avatar'.");
    const video = !!VIDEO[type] && (!!this.ff || !!EXT[type]);
    // `convert`: the browser could not open this photo, so it comes as picked and is made a JPEG here.
    const convert = !video && (!!CONVERT[type] || (b.convert === true && !!IMAGE[type]));
    if (!IMAGE[type] && !video && !convert) {
      throw bad('Only photos (JPEG, HEIC, WebP, PNG, AVIF, GIF, TIFF) and videos (MP4, MOV, WebM, MKV, 3GP, AVI) can be uploaded.', 415, 'bad_type');
    }
    if (convert && !this.ff) throw bad('This server cannot convert that photo. Save it as a JPEG first.', 415, 'bad_type');
    if (avatar && video) throw bad('A profile photo must be a photo.', 415, 'bad_type');
    const size = int(b.size, 1, Number.MAX_SAFE_INTEGER);
    if (!size) throw bad('size must be the number of bytes, more than 0.');
    const max = convert ? LIMITS.convertBytes : avatar ? LIMITS.avatarBytes : video ? LIMITS.videoBytes : LIMITS.imageBytes;
    if (size > max) throw bad(video ? 'A video can be at most 100 MB.' : `That photo is too large (at most ${Math.round(max / 1048576)} MB).`, 413, 'too_large');
    const w = b.w === undefined || b.w === null ? null : int(b.w, 1, 20000);
    const h = b.h === undefined || b.h === null ? null : int(b.h, 1, 20000);
    if ((b.w != null && !w) || (b.h != null && !h)) throw bad('w and h must be whole numbers of pixels.');
    // A profile photo's square, chosen in the browser: { x, y, w, h } as fractions of the photo. Used when the server converts it.
    let crop = null;
    if (avatar && b.crop != null) {
      const c = b.crop; const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
      if (!c || typeof c !== 'object' || !ok(c.x) || !ok(c.y) || !ok(c.w) || !ok(c.h) || c.w <= 0 || c.h <= 0 || c.x + c.w > 1.0001 || c.y + c.h > 1.0001) {
        throw bad('crop must be { x, y, w, h }: fractions of the photo, from 0 to 1.');
      }
      crop = JSON.stringify({ x: c.x, y: c.y, w: c.w, h: c.h });
    }
    let durationMs = null;
    if (video) {
      // The length is read again from the file; one the browser could not read may be left out.
      const d = b.duration === undefined || b.duration === null ? null : Number(b.duration);
      if (d === null ? !this.ff : (!Number.isFinite(d) || d <= 0)) throw bad('duration (seconds) is needed for a video.');
      if (d !== null && d * 1000 > LIMITS.videoMs + 500) throw bad('A video can be at most 2 minutes long.', 413, 'too_long');
      durationMs = d === null ? null : Math.round(d * 1000);
    }
    if (post) {
      const n = this.app.get("SELECT COUNT(*) AS n FROM media WHERE post_id = ? AND state IN ('ready', 'uploading', 'processing')", post.id).n;
      if (n >= LIMITS.perPost) throw bad(`A post can have at most ${LIMITS.perPost} photos and videos.`, 409, 'too_many');
    }
    const used = this.app.get('SELECT COALESCE(SUM(bytes), 0) AS n FROM media WHERE user_id = ?', String(userId)).n;
    if (used + size > LIMITS.personBytes) throw bad('You have used all the space for photos and videos (2 GB). Remove some first.', 413, 'quota');
    const id = shortId('m');
    const t = this.now();
    this.app.run(`INSERT INTO media (id, user_id, post_id, kind, mime, bytes, w, h, duration_ms, created_ms, touched_ms, state, received, name, convert, crop)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 0, ?, ?, ?)`,
    id, String(userId), post ? post.id : null, avatar ? 'avatar' : video ? 'video' : 'image', type, size, w, h, durationMs, t, t,
    typeof b.name === 'string' ? b.name.slice(0, 120) : null, convert ? 1 : 0, crop);
    const r = this.row(id);
    mkdirSync(this.#userDir(userId), { recursive: true });
    writeFileSync(this.#part(r), Buffer.alloc(0));
    return { id, chunk: CHUNK, chunks: Math.ceil(size / CHUNK) };
  }

  /** Chunk `i` of an upload. Chunks come in order; the one just received may be sent again (a retry). */
  putChunk(userId, id, i, buf) {
    const r = this.own(userId, id);
    if (r.state !== 'uploading') throw bad('This upload is already finished.', 409);
    const chunks = Math.ceil(r.bytes / CHUNK);
    if (!Number.isInteger(i) || i < 0 || i >= chunks) throw bad(`i must be a chunk number from 0 to ${chunks - 1}.`);
    const next = Math.floor(r.received / CHUNK);
    const want = i === chunks - 1 ? r.bytes - i * CHUNK : CHUNK;
    if (buf.length !== want) throw bad(`Chunk ${i} must be ${want} bytes, not ${buf.length}.`);
    if (i < next) return { received: r.received, next };            // already have it
    if (i > next) throw bad(`Chunks must come in order: send chunk ${next} next.`, 409, 'out_of_order');
    if (this.busy.has(r.id)) throw bad('Another chunk of this upload is still being written.', 409, 'busy');
    this.busy.add(r.id);
    try {
      const fd = openSync(this.#part(r), 'r+');
      try { writeSync(fd, buf, 0, buf.length, i * CHUNK); } finally { closeSync(fd); }
      this.app.run('UPDATE media SET received = ?, touched_ms = ? WHERE id = ?', i * CHUNK + buf.length, this.now(), r.id);
    } finally { this.busy.delete(r.id); }
    return { received: i * CHUNK + buf.length, next: i + 1 };
  }

  /** The preview of a photo or the poster of a video: one small image. */
  putThumb(userId, id, type, buf) {
    const r = this.own(userId, id);
    if (r.kind === 'avatar') throw bad('A profile photo has no separate preview.');
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    if (!IMAGE[t]) throw bad('A preview must be a JPEG, WebP or PNG.', 415, 'bad_type');
    if (!buf.length || buf.length > LIMITS.thumbBytes) throw bad('A preview can be at most 1 MB.', 413, 'too_large');
    if (!sniff(t, buf)) throw bad('That preview is not the image its type says.', 415, 'bad_type');
    for (const x of Object.values(IMAGE)) rmSync(join(this.#userDir(r.user_id), `${r.id}.thumb.${x}`), { force: true });
    writeFileSync(join(this.#userDir(r.user_id), `${r.id}.thumb.${IMAGE[t]}`), buf);
    this.app.run('UPDATE media SET thumb = ?, thumb_bytes = ?, touched_ms = ? WHERE id = ?', t, buf.length, this.now(), r.id);
    return { ok: true };
  }

  /**
   * Every byte is here: check it, keep it. For a post, `postOk(postId)`
   * says the post is still there and still the person's; a profile photo
   * replaces the one before (whose files go).
   */
  async finish(userId, id, { postOk = () => true } = {}) {
    const r = this.own(userId, id);
    if (r.state === 'ready' || r.state === 'processing') return mediaView(r);
    if (r.received !== r.bytes) throw bad(`The upload is not complete: ${r.received} of ${r.bytes} bytes arrived.`, 409, 'incomplete');
    const part = this.#part(r);
    const drop = (e) => { this.app.dropMedia('id = ?', r.id); return e; };
    const head = Buffer.alloc(16);
    const fd = openSync(part, 'r');
    try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
    if (!sniff(r.mime, head)) throw drop(bad('That file is not the photo or video its type says.', 415, 'bad_type'));
    if (r.post_id) {
      if (!postOk(r.post_id)) throw drop(bad('That post is gone.', 404));
      const n = this.app.get("SELECT COUNT(*) AS n FROM media WHERE post_id = ? AND state IN ('ready', 'processing') AND id != ?", r.post_id, r.id).n;
      if (n >= LIMITS.perPost) throw drop(bad(`A post can have at most ${LIMITS.perPost} photos and videos.`, 409, 'too_many'));
    }
    const ff = this.dir ? this.ff : null;

    // A photo the browser could not open: a JPEG made here, with its preview.
    const convert = r.kind !== 'video' && (!!r.convert || !!CONVERT[r.mime] || r.bytes > (r.kind === 'avatar' ? LIMITS.avatarBytes : LIMITS.imageBytes));
    if (convert) {
      if (!ff) throw drop(bad('This server cannot convert that photo. Save it as a JPEG first.', 415, 'bad_type'));
      const out = `${part}.out.jpg`;
      try {
        await photoToJpeg(ff, part, out, r.kind === 'avatar' ? { square: 512, crop: r.crop ? JSON.parse(r.crop) : null } : { max: 2048 });
      } catch (e) {
        this.log(`photo convert ${r.id} (${r.mime}): ${e.message} ${e.stderr || ''}`);
        rmSync(out, { force: true });
        throw drop(bad('That photo could not be read. Try another, or save it as a JPEG first.', 415, 'bad_image'));
      }
      const p = await probe(ff, out);
      renameSync(out, part);
      const size = statSync(part).size;
      this.app.run("UPDATE media SET mime = 'image/jpeg', bytes = ?, received = ?, w = ?, h = ? WHERE id = ?", size, size, p?.v?.w ?? null, p?.v?.h ?? null, r.id);
      if (r.kind !== 'avatar') {
        const tf = join(this.#userDir(r.user_id), `${r.id}.thumb.jpg`);
        try { await photoToJpeg(ff, part, tf, { max: 480, quality: 5 }); this.app.run("UPDATE media SET thumb = 'image/jpeg', thumb_bytes = ? WHERE id = ?", statSync(tf).size, r.id); } catch { rmSync(tf, { force: true }); }
      }
    }

    // A video: read for what it really is, then kept as MP4 or WebM every browser plays,
    // without its metadata (where and when, the phone's model) or data tracks.
    if (r.kind === 'video' && ff) {
      const p = await probe(ff, part);
      if (!p?.v) throw drop(bad('That video could not be read. Try another, or save it again from your gallery.', 415, 'bad_video'));
      if (p.duration && p.duration * 1000 > LIMITS.videoMs + 500) throw drop(bad('A video can be at most 2 minutes long.', 413, 'too_long'));
      if (!p.duration && r.duration_ms == null) throw drop(bad('The length of this video could not be read. Try another, or save it again from your gallery.', 415, 'bad_video'));
      this.app.run('UPDATE media SET w = ?, h = ?, duration_ms = ? WHERE id = ?', p.v.w ?? r.w, p.v.h ?? r.h, p.duration ? Math.round(p.duration * 1000) : r.duration_ms, r.id);
      let plan = videoPlan(p);
      if (plan.mode === 'copy') {
        const out = `${part}.out.${plan.ext}`;
        try {
          await copyVideo(ff, part, out, plan.ext);
          renameSync(out, part);
          const size = statSync(part).size;
          this.app.run('UPDATE media SET mime = ?, bytes = ?, received = ? WHERE id = ?', plan.mime, size, size, r.id);
        } catch (e) {
          this.log(`video copy ${r.id}: ${e.message} ${e.stderr || ''}: encoding it instead`);
          rmSync(out, { force: true });
          plan = { mode: 'encode' };
        }
      }
      if (plan.mode === 'encode') {
        // Minutes, maybe: wait a while, then let it join its post when it is ready.
        this.app.run("UPDATE media SET state = 'processing', touched_ms = ? WHERE id = ?", this.now(), r.id);
        const job = this.#enqueue(this.row(r.id));
        let timer;
        const ok = await Promise.race([job, new Promise((res) => { timer = setTimeout(() => res('wait'), this.waitMs); timer.unref?.(); })]);
        clearTimeout(timer);
        const now = this.row(r.id);
        if (ok === false || !now) throw bad('That video could not be read. Try another, or save it again from your gallery.', 415, 'bad_video');
        return mediaView(now);
      }
    }

    // Nothing about where or when it was taken leaves with a JPEG: its EXIF/XMP goes (the app's own
    // upload has none already: this is for any other client).
    if (this.row(r.id).mime === 'image/jpeg' && this.dir) {
      const buf = readFileSync(part);
      const clean = stripJpegMeta(buf);
      if (clean && clean.length !== buf.length) { writeFileSync(part, clean); this.app.run('UPDATE media SET bytes = ?, received = ? WHERE id = ?', clean.length, clean.length, r.id); }
    }
    await this.#complete(this.row(r.id));
    return mediaView(this.row(r.id));
  }

  /** Every check passed: its poster if it has none, the file in place, and on its post (or the profile). */
  async #complete(r) {
    const part = this.#part(r);
    // A video's poster is always made here when ffmpeg is: the phone's is often black (drawn before
    // the browser painted the frame it sought). Theirs stays only when this one cannot be made.
    if (r.kind === 'video' && this.ff && this.dir) {
      const pf = `${part}.poster.jpg`;
      const at = r.duration_ms ? Math.min(1, r.duration_ms / 2000) : 0;
      try {
        await posterOf(this.ff, part, pf, { at });
        const was = this.thumbFile(r);
        if (was && !was.endsWith('.thumb.jpg')) rmSync(was, { force: true });   // the phone's, in another format
        renameSync(pf, join(this.#userDir(r.user_id), `${r.id}.thumb.jpg`));
        this.app.run("UPDATE media SET thumb = 'image/jpeg', thumb_bytes = ? WHERE id = ?", statSync(join(this.#userDir(r.user_id), `${r.id}.thumb.jpg`)).size, r.id);
      } catch (e) { rmSync(pf, { force: true }); this.log(`video poster ${r.id}: ${e.message}`); }
    }
    r = this.row(r.id);
    if (!r) return;
    renameSync(part, this.file(r));
    const pos = r.post_id ? (this.app.get('SELECT COALESCE(MAX(pos), 0) AS n FROM media WHERE post_id = ?', r.post_id).n + 1) : 0;
    this.app.run("UPDATE media SET state = 'ready', pos = ?, touched_ms = ? WHERE id = ?", pos, this.now(), r.id);
    if (r.kind === 'avatar') {
      const before = this.app.profile(r.user_id)?.avatar;
      this.app.patchProfile(r.user_id, { avatar: r.id });
      if (before && before !== r.id) this.app.dropMedia('id = ?', before);
    }
  }

  /** A video to encode again, after any before it. Resolves true once it is on its post, false when it could not be. */
  #enqueue(r) {
    if (this.jobs.has(r.id)) return this.jobs.get(r.id);
    const job = this.queue.then(() => this.#encode(r.id)).catch((e) => { this.log(`video ${r.id}: ${e.message}`); return false; });
    this.queue = job;
    this.jobs.set(r.id, job);
    job.then(() => this.jobs.delete(r.id));
    return job;
  }

  async #encode(id) {
    const r = this.row(id);
    if (!r || r.state !== 'processing') return false;
    const part = this.#part(r);
    const out = `${part}.out.mp4`;
    const fail = (why) => { this.log(`video encode ${id}: ${why}`); rmSync(out, { force: true }); this.app.dropMedia('id = ?', id); this.onReady({ ...r, state: 'failed' }); return false; };
    if (!existsSync(part)) return fail('its upload is gone');
    try { await encodeVideo(this.ff, part, out); } catch (e) { return fail(`${e.message} ${e.stderr || ''}`); }
    if (!this.row(id)) { rmSync(out, { force: true }); return false; }   // taken off while it was encoded
    renameSync(out, part);
    const size = statSync(part).size;
    this.app.run("UPDATE media SET mime = 'video/mp4', bytes = ?, received = ? WHERE id = ?", size, size, id);
    await this.#complete(this.row(id));
    const done = this.row(id);
    if (done) this.onReady(done);
    return !!done;
  }

  /**
   * A photo brought in by the server itself (an activity's photo from
   * Strava) onto one of the person's posts. `name` marks where it came
   * from, so the same one is never brought in twice. JPEG metadata (EXIF,
   * the GPS position with it) is dropped first, as the browser does for an
   * upload. Null when there is no room or it is not a photo.
   */
  importImage(userId, post, buf, { name }) {
    if (!this.dir || !post) return null;
    if (this.app.get('SELECT 1 FROM media WHERE post_id = ? AND name = ?', post.id, name)) return null;
    const type = ['image/jpeg', 'image/png', 'image/webp'].find((t) => sniff(t, buf));
    if (!type) return null;
    const bytes = type === 'image/jpeg' ? stripJpegMeta(buf) : buf;
    if (!bytes) return null;
    try {
      const { id } = this.create(userId, { kind: 'post', type, size: bytes.length, name }, post);
      const r = this.row(id);
      writeFileSync(this.#part(r), bytes);
      this.app.run('UPDATE media SET received = ? WHERE id = ?', bytes.length, id);
      return this.finish(userId, id);
    } catch (e) { this.log(`import photo: ${e.message}`); return null; }
  }

  /** DELETE /api/media/:id: the owner's alone. */
  remove(userId, id) {
    const r = this.own(userId, id);
    this.app.dropMedia('id = ?', r.id);
    return { ok: true, postId: r.post_id, avatar: r.kind === 'avatar' };
  }

  /** Uploads untouched for an hour are dropped. */
  sweep() {
    this.app.dropMedia("state = 'uploading' AND touched_ms < ?", this.now() - LIMITS.staleMs);
  }

  /** Is the file there (a row whose file was lost answers 404, not 500). */
  has(r, thumb = false) { const f = thumb ? this.thumbFile(r) : this.file(r); return !!f && existsSync(f); }
}

/** A JPEG without its metadata segments (APP1 to APP15: EXIF and GPS, XMP), keeping the picture and its colour profile (APP2 ICC is kept). Null when it cannot be read. */
export function stripJpegMeta(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return buf;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); }   // the image data: the rest as it is
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    const meta = marker >= 0xe1 && marker <= 0xef && marker !== 0xe2;
    if (!meta) out.push(seg);
    i += 2 + len;
  }
  return null;   // not a shape it knows: not kept, rather than kept with what it may carry
}
