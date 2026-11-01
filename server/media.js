/* ============================================================
   health.ojee.net — photos and videos: on feed posts, and the
   profile photo.

   Uploads come in pieces. The production nginx takes at most 6 MB in
   one request, so a file is sent as chunks of CHUNK bytes (4 MiB):

     POST /api/media              { kind, postId?, type, size, ... } → { id, chunk }
     PUT  /api/media/:id/chunk?i=N   the raw bytes of chunk N, in order
     PUT  /api/media/:id/thumb       a small preview (≤ 1 MB), optional
     POST /api/media/:id/done        → the finished media object

   The browser has already shrunk and re-encoded every photo (which also
   drops its EXIF, the GPS position with it) and taken a poster frame of
   every video; the server re-encodes nothing. What it does check: the
   type is one of a short list, the sizes add up, the chunks arrive in
   order, and the finished file starts the way its type says it does.

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

import { mkdirSync, openSync, writeSync, closeSync, readSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { shortId } from './secrets.js';

export const CHUNK = 4 * 1024 * 1024;
export const LIMITS = {
  perPost: 10,
  imageBytes: 12 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  avatarBytes: 4 * 1024 * 1024,
  thumbBytes: 1024 * 1024,
  videoMs: 120_000,
  // Everything one person keeps here, finished or on its way.
  personBytes: 2 * 1024 * 1024 * 1024,
  staleMs: 3_600_000,
};
const IMAGE = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
const VIDEO = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const EXT = { ...IMAGE, ...VIDEO };
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
    case 'video/mp4': case 'video/quicktime': return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].some((x) => at(4, x));
    default: return false;
  }
}

/** A media row as the API shows it. */
export function mediaView(r) {
  return {
    id: r.id, kind: r.kind === 'video' ? 'video' : 'image',
    url: `/media/${r.id}`, thumb: r.thumb ? `/media/${r.id}/thumb` : r.kind === 'video' ? null : `/media/${r.id}`,
    w: r.w ?? null, h: r.h ?? null,
    duration: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : null,
  };
}

/** The finished photos and videos of a post, in order. */
export function mediaOfPost(app, postId) {
  return app.all("SELECT * FROM media WHERE post_id = ? AND state = 'ready' ORDER BY pos, created_ms", String(postId)).map(mediaView);
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export class MediaStore {
  /**
   * @param {object} o
   * @param {import('./appdb.js').AppDb} o.app
   * @param {string|null} o.dir  <dataDir>/media, or null (tests in memory: nothing is kept)
   */
  constructor({ app, dir, now = () => Date.now(), log = () => {} }) {
    this.app = app; this.dir = dir; this.now = now; this.log = log;
    this.busy = new Set();
    app.onMediaGone = (rows) => { for (const r of rows) this.#unlink(r); };
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
    for (const f of [this.file(r), this.#part(r), ...Object.values(IMAGE).map((x) => join(this.#userDir(r.user_id), `${r.id}.thumb.${x}`))]) rmSync(f, { force: true });
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
    const video = !!VIDEO[type];
    if (!IMAGE[type] && !video) throw bad('Only photos (JPEG, WebP, PNG) and videos (MP4, MOV, WebM) can be uploaded.', 415, 'bad_type');
    if (avatar && video) throw bad('A profile photo must be a photo.', 415, 'bad_type');
    const size = int(b.size, 1, Number.MAX_SAFE_INTEGER);
    if (!size) throw bad('size must be the number of bytes, more than 0.');
    const max = avatar ? LIMITS.avatarBytes : video ? LIMITS.videoBytes : LIMITS.imageBytes;
    if (size > max) throw bad(video ? 'A video can be at most 100 MB.' : `That photo is too large (at most ${Math.round(max / 1048576)} MB).`, 413, 'too_large');
    const w = b.w === undefined || b.w === null ? null : int(b.w, 1, 20000);
    const h = b.h === undefined || b.h === null ? null : int(b.h, 1, 20000);
    if ((b.w != null && !w) || (b.h != null && !h)) throw bad('w and h must be whole numbers of pixels.');
    let durationMs = null;
    if (video) {
      const d = Number(b.duration);
      if (!Number.isFinite(d) || d <= 0) throw bad('duration (seconds) is needed for a video.');
      if (d * 1000 > LIMITS.videoMs + 500) throw bad('A video can be at most 2 minutes long.', 413, 'too_long');
      durationMs = Math.round(d * 1000);
    }
    if (post) {
      const n = this.app.get("SELECT COUNT(*) AS n FROM media WHERE post_id = ? AND state IN ('ready', 'uploading')", post.id).n;
      if (n >= LIMITS.perPost) throw bad(`A post can have at most ${LIMITS.perPost} photos and videos.`, 409, 'too_many');
    }
    const used = this.app.get('SELECT COALESCE(SUM(bytes), 0) AS n FROM media WHERE user_id = ?', String(userId)).n;
    if (used + size > LIMITS.personBytes) throw bad('You have used all the space for photos and videos (2 GB). Remove some first.', 413, 'quota');
    const id = shortId('m');
    const t = this.now();
    this.app.run(`INSERT INTO media (id, user_id, post_id, kind, mime, bytes, w, h, duration_ms, created_ms, touched_ms, state, received, name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 0, ?)`,
    id, String(userId), post ? post.id : null, avatar ? 'avatar' : video ? 'video' : 'image', type, size, w, h, durationMs, t, t,
    typeof b.name === 'string' ? b.name.slice(0, 120) : null);
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
  finish(userId, id, { postOk = () => true } = {}) {
    const r = this.own(userId, id);
    if (r.state === 'ready') return mediaView(r);
    if (r.received !== r.bytes) throw bad(`The upload is not complete: ${r.received} of ${r.bytes} bytes arrived.`, 409, 'incomplete');
    const head = Buffer.alloc(16);
    const fd = openSync(this.#part(r), 'r');
    try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
    if (!sniff(r.mime, head)) { this.app.dropMedia('id = ?', r.id); throw bad('That file is not the photo or video its type says.', 415, 'bad_type'); }
    if (r.post_id) {
      if (!postOk(r.post_id)) { this.app.dropMedia('id = ?', r.id); throw bad('That post is gone.', 404); }
      const n = this.app.get("SELECT COUNT(*) AS n FROM media WHERE post_id = ? AND state = 'ready'", r.post_id).n;
      if (n >= LIMITS.perPost) { this.app.dropMedia('id = ?', r.id); throw bad(`A post can have at most ${LIMITS.perPost} photos and videos.`, 409, 'too_many'); }
    }
    renameSync(this.#part(r), this.file(r));
    const pos = r.post_id ? (this.app.get('SELECT COALESCE(MAX(pos), 0) AS n FROM media WHERE post_id = ?', r.post_id).n + 1) : 0;
    this.app.run("UPDATE media SET state = 'ready', pos = ?, touched_ms = ? WHERE id = ?", pos, this.now(), r.id);
    if (r.kind === 'avatar') {
      const before = this.app.profile(r.user_id)?.avatar;
      this.app.patchProfile(r.user_id, { avatar: r.id });
      if (before && before !== r.id) this.app.dropMedia('id = ?', before);
    }
    return mediaView(this.row(r.id));
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
