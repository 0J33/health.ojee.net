/* Every format a phone or camera saves goes up and comes out as something
   every browser shows (media.js, mediaproc.js, with a real ffmpeg):
   an iPhone's HEVC video encoded again as H.264 MP4, H.264 copied as it is
   and kept the right way up, MKV/AVI/3GP taken in, the real length read
   from the file (and a lie about it refused), a poster made when the
   browser sent none; photos the browser could not open (HEIC, GIF, TIFF,
   BMP…) made JPEG with a preview, or a 512 px square for a profile photo.
   Skipped where there is no ffmpeg; HEIC only with ffmpeg 7.1 or later. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rig } from './helpers.mjs';
import { CHUNK } from '../server/media.js';
import { findTools } from '../server/mediaproc.js';

const ff = findTools();
let have = true;
try { execFileSync(ff.ffmpeg, ['-version'], { stdio: 'ignore' }); execFileSync(ff.ffprobe, ['-version'], { stdio: 'ignore' }); } catch { have = false; }
const has = (kind, name) => { try { return execFileSync(ff.ffmpeg, ['-hide_banner', `-${kind}`], { encoding: 'utf8' }).includes(` ${name} `); } catch { return false; } };

const dir = mkdtempSync(join(tmpdir(), 'fmt-'));
const make = (name, args) => { const f = join(dir, name); execFileSync(ff.ffmpeg, ['-v', 'error', '-y', ...args, f]); return readFileSync(f); };
const probeBuf = (buf, ext) => {
  const f = join(dir, `probe-${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(f, buf);
  return JSON.parse(execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', f], { encoding: 'utf8' })).streams;
};

async function upload(c, meta, bytes) {
  const s = await c.post('/api/media', { ...meta, size: bytes.length });
  if (s.status !== 200) return s;
  for (let i = 0; i * CHUNK < bytes.length; i += 1) {
    const r = await c.call('PUT', `/api/media/${s.json.id}/chunk?i=${i}`, { raw: bytes.subarray(i * CHUNK, (i + 1) * CHUNK), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 200, r.text);
  }
  return c.post(`/api/media/${s.json.id}/done`, {});
}
function postFor(t, who, n = 1) {
  const id = `post${String(n).padStart(8, '0')}`;
  const end = Date.now() - 3_600_000;
  t.app.app.run("INSERT INTO post (id, user_id, uid, kind, start_ms, end_ms, data, created_ms) VALUES (?, ?, ?, 'workout', ?, ?, ?, ?)",
    id, who.id, `uid${n}`, end - 1_800_000, end, JSON.stringify({ type: 'RUNNING', title: 'Run', durationMin: 30 }), end);
  return id;
}
const fetchBuf = async (t, c, path) => { const r = await fetch(t.base + path, { headers: { cookie: c.c.cookie } }); return { type: r.headers.get('content-type'), status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };

test('videos: HEVC encoded again as H.264, H.264 copied the right way up, MKV taken in, the real length checked, a poster made', { skip: !have || !has('encoders', 'libx265') ? 'needs ffmpeg with libx265' : false }, async () => {
  const hevc = make('in.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest',
    '-metadata', 'location=+30.0444+031.2357/', '-metadata', 'make=PhoneMakerQzx']);
  const h264 = make('h.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const upright = make('up.mp4', ['-display_rotation', '90', '-i', join(dir, 'h.mp4'), '-c', 'copy']);
  const mkv = make('in.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const long = make('long.mp4', ['-f', 'lavfi', '-i', 'color=s=16x16:r=1:d=130', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const t = await rig({ env: { VIDEO_CLEAN: 'on' } });
  try {
    const ann = await t.person('fmtann');
    const pid = postFor(t, ann);

    // An iPhone video, which this browser could not play: no length, no size, no poster sent.
    const v = await upload(ann.c, { kind: 'post', postId: pid, type: 'video/quicktime', name: 'IMG_0001.MOV' }, hevc);
    assert.equal(v.status, 200, v.text);
    assert.deepEqual([v.json.kind, v.json.w, v.json.h, v.json.duration, !!v.json.thumb, v.json.processing], ['video', 640, 360, 2, true, undefined]);
    const got = await fetchBuf(t, ann, v.json.url);
    assert.equal(got.type, 'video/mp4');
    const s = probeBuf(got.buf, 'mp4');
    assert.equal(s.find((x) => x.width).codec_name, 'h264');
    assert.equal(s.find((x) => x.width).pix_fmt, 'yuv420p');
    for (const mark of ['+30.0444', 'PhoneMakerQzx']) assert.ok(!got.buf.includes(mark), mark);
    assert.equal((await fetchBuf(t, ann, v.json.thumb)).type, 'image/jpeg');

    // H.264 is copied as it is (bytes nearly the same), and a phone held upright stays upright.
    const u = await upload(ann.c, { kind: 'post', postId: pid, type: 'video/mp4', w: 1, h: 1, duration: 2 }, upright);
    assert.equal(u.status, 200, u.text);
    assert.deepEqual([u.json.w, u.json.h], [240, 320]);
    const c = await upload(ann.c, { kind: 'post', postId: pid, type: 'video/mp4', duration: 2 }, h264);
    assert.ok(Math.abs((await fetchBuf(t, ann, c.json.url)).buf.length - h264.length) < 4096, 'copied, not encoded');

    // The phone's poster was black (drawn before the frame was painted): the server's own replaces it.
    const black = make('black.jpg', ['-f', 'lavfi', '-i', 'color=c=black:s=320x240', '-frames:v', '1']);
    const bv = await ann.c.post('/api/media', { kind: 'post', postId: pid, type: 'video/mp4', duration: 2, w: 320, h: 240, size: h264.length });
    assert.equal(bv.status, 200, bv.text);
    assert.equal((await ann.c.call('PUT', `/api/media/${bv.json.id}/chunk?i=0`, { raw: h264, headers: { 'content-type': 'application/octet-stream' } })).status, 200);
    assert.equal((await ann.c.call('PUT', `/api/media/${bv.json.id}/thumb`, { raw: black, headers: { 'content-type': 'image/jpeg' } })).status, 200);
    const bd = await ann.c.post(`/api/media/${bv.json.id}/done`, {});
    assert.equal(bd.status, 200, bd.text);
    const pf = join(dir, 'poster-out.jpg'); writeFileSync(pf, (await fetchBuf(t, ann, bd.json.thumb)).buf);
    const yavg = Number(/YAVG=([0-9.]+)/.exec(execFileSync(ff.ffmpeg, ['-v', 'error', '-i', pf, '-vf', 'signalstats,metadata=mode=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' }))?.[1]);
    assert.ok(yavg > 20, `a real frame, not black (YAVG ${yavg})`);

    // MKV in, WebM/MP4 out.
    const k = await upload(ann.c, { kind: 'post', postId: pid, type: 'video/x-matroska' }, mkv);
    assert.equal(k.status, 200, k.text);
    assert.equal((await fetchBuf(t, ann, k.json.url)).type, 'video/mp4');

    // Says ten seconds, is 130: refused, and nothing is left behind.
    const l = await upload(ann.c, { kind: 'post', postId: pid, type: 'video/mp4', duration: 10 }, long);
    assert.equal(l.status, 413);
    assert.equal(l.json.code, 'too_long');

    // A slow encode answers { processing: true } and joins the post when ready.
    t.app.media.waitMs = 0;
    const p = await upload(ann.c, { kind: 'post', postId: pid, type: 'video/quicktime' }, hevc);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.processing, true);
    assert.ok(!(await ann.c.get('/api/feed')).json.posts.find((x) => x.id === pid).media.some((m) => m.id === p.json.id), 'not shown while processing');
    for (let i = 0; i < 100 && t.app.media.row(p.json.id)?.state !== 'ready'; i += 1) await new Promise((r) => { setTimeout(r, 100); });
    assert.equal(t.app.media.row(p.json.id).state, 'ready');
    assert.ok((await ann.c.get('/api/feed')).json.posts.find((x) => x.id === pid).media.some((m) => m.id === p.json.id));
    const files = readdirSync(join(t.dir, 'data', 'media', ann.id));
    assert.ok(!files.some((f) => /\.(part|out\.|poster)/.test(f)), files.join(' '));
  } finally { await t.close(); }
});

test('photos the browser could not open (HEIC, GIF, TIFF, BMP, a transparent PNG) are made JPEG on the server; a profile photo is cut square', { skip: !have ? 'no ffmpeg' : false }, async () => {
  const gif = make('a.gif', ['-f', 'lavfi', '-i', 'testsrc2=s=300x200', '-frames:v', '1']);
  const tiff = make('a.tiff', ['-f', 'lavfi', '-i', 'testsrc2=s=3000x2000', '-frames:v', '1']);
  const bmp = make('a.bmp', ['-f', 'lavfi', '-i', 'testsrc2=s=400x900', '-frames:v', '1']);
  const png = make('t.png', ['-f', 'lavfi', '-i', 'color=c=red@0.0:s=64x64,format=rgba', '-frames:v', '1']);
  const t = await rig({ env: { VIDEO_CLEAN: 'on' } });
  try {
    const ann = await t.person('phann');
    const pid = postFor(t, ann);
    for (const [type, buf, w, h] of [['image/gif', gif, 300, 200], ['image/tiff', tiff, 2048, 1365], ['image/bmp', bmp, 400, 900]]) {
      const r = await upload(ann.c, { kind: 'post', postId: pid, type }, buf);
      assert.equal(r.status, 200, `${type}: ${r.text}`);
      assert.deepEqual([r.json.kind, r.json.w, r.json.h], ['image', w, h], type);
      const f = await fetchBuf(t, ann, r.json.url);
      assert.equal(f.type, 'image/jpeg');
      assert.equal(f.buf[0], 0xff);
      assert.equal((await fetchBuf(t, ann, r.json.thumb)).type, 'image/jpeg');
    }
    // A PNG the browser could not open comes with convert: true; transparent is laid on white.
    const tp = await upload(ann.c, { kind: 'post', postId: pid, type: 'image/png', convert: true }, png);
    assert.equal(tp.status, 200, tp.text);
    const raw = execFileSync(ff.ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: (await fetchBuf(t, ann, tp.json.url)).buf });
    assert.ok(raw[0] > 240 && raw[1] > 240 && raw[2] > 240, 'white');

    // A profile photo: a square, at most 512 px.
    const av = await upload(ann.c, { kind: 'avatar', type: 'image/tiff' }, tiff);
    assert.equal(av.status, 200, av.text);
    assert.deepEqual([av.json.w, av.json.h], [512, 512]);
    assert.ok(JSON.stringify((await ann.c.get('/api/me')).json.profile.avatar).includes(av.json.id), 'is the profile photo');

    // The square chosen in the browser: its right half, top. A left-to-right gradient shows which part was kept.
    const grad = make('g.tiff', ['-f', 'lavfi', '-i', 'gradients=s=2000x1000:c0=black:c1=white:x0=0:y0=0:x1=2000:y1=0:n=2', '-frames:v', '1']);
    const cr = await upload(ann.c, { kind: 'avatar', type: 'image/tiff', crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, grad);
    assert.equal(cr.status, 200, cr.text);
    assert.deepEqual([cr.json.w, cr.json.h], [512, 512]);
    const px = execFileSync(ff.ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { input: (await fetchBuf(t, ann, cr.json.url)).buf });
    assert.ok(px[512 * 256 + 2] > 110, `the right half: its left edge is mid grey, not black (${px[512 * 256 + 2]})`);
    assert.equal((await ann.c.post('/api/media', { kind: 'avatar', type: 'image/tiff', size: 10, crop: { x: 0.8, y: 0, w: 0.5, h: 1 } })).status, 400);

    // Not a photo at all.
    const bad = await upload(ann.c, { kind: 'post', postId: pid, type: 'image/heic' }, Buffer.concat([Buffer.from('\0\0\0\x18ftypheic'), Buffer.alloc(500, 1)]));
    assert.equal(bad.status, 415);
  } finally { await t.close(); }
});

test('an iPhone HEIC photo is made a JPEG', { skip: !have || !has('demuxers', 'mov,mp4,m4a,3gp,3g2,mj2') ? 'no ffmpeg' : false }, async (tt) => {
  // HEIC needs ffmpeg 7.1 or later; a still HEVC image written as HEIF by ffmpeg itself is not possible, so a sample is made with libheif when it is here.
  let heic = null;
  try { execFileSync('heif-enc', ['--version'], { stdio: 'ignore' }); make('h.png', ['-f', 'lavfi', '-i', 'testsrc2=s=1200x900', '-frames:v', '1']); execFileSync('heif-enc', ['-q', '60', '-o', join(dir, 'h.heic'), join(dir, 'h.png')], { stdio: 'ignore' }); heic = readFileSync(join(dir, 'h.heic')); } catch { /* none */ }
  if (!heic && process.env.HEIC_SAMPLE) heic = readFileSync(process.env.HEIC_SAMPLE);
  if (!heic) { tt.skip('no HEIC sample (heif-enc, or HEIC_SAMPLE=<file>)'); return; }
  const t = await rig({ env: { VIDEO_CLEAN: 'on' } });
  try {
    const ann = await t.person('heicann');
    const pid = postFor(t, ann);
    const r = await upload(ann.c, { kind: 'post', postId: pid, type: 'image/heic', name: 'IMG_0002.HEIC' }, heic);
    if (r.status === 415 && r.json.code === 'bad_image') { tt.skip(`this ffmpeg (${ff.ffmpeg}) cannot read HEIC: 7.1 or later is needed`); return; }
    assert.equal(r.status, 200, r.text);
    assert.equal((await fetchBuf(t, ann, r.json.url)).type, 'image/jpeg');
    assert.ok(r.json.w > 0 && r.json.h > 0);
  } finally { await t.close(); }
});

test('without ffmpeg, a HEIC photo is refused when it is started', async () => {
  const t = await rig();
  try {
    const ann = await t.person('noffann');
    const pid = postFor(t, ann);
    const r = await ann.c.post('/api/media', { kind: 'post', postId: pid, type: 'image/heic', size: 1000 });
    assert.equal(r.status, 415);
  } finally { await t.close(); }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
