/* ============================================================
   health.ojee.net — what the server does to an uploaded photo or
   video with ffmpeg (media.js decides when).

   - Every video is read (ffprobe) for its real length, size and codecs.
     One every browser plays (H.264 in MP4 or MOV; VP8, VP9 or AV1 in
     WebM) is copied as it is into MP4 or WebM, quickly and losing
     nothing. Anything else (HEVC, which iPhones record and Chrome or
     Firefox on many computers cannot play; ProRes; MPEG-4; MKV, AVI,
     3GP) is encoded again as H.264 MP4, at most 1920 px on its long side.
   - A photo the browser could not open itself (HEIC from an iPhone on
     Android or a computer, AVIF, TIFF, BMP, GIF; or one too large for it)
     is turned into a JPEG here, as the browser would have: at most
     2048 px, a 480 px preview, or a 512 px square for a profile photo.
   - A video's poster frame, when the browser could not take one.

   Either way the result keeps none of the file's metadata (where and
   when, the phone's make and model), its chapters or its data tracks.

   ffmpeg is found through FFMPEG / FFPROBE, else ~/.local/opt/ffmpeg/bin
   (where the servers keep a recent static build: HEIC needs ffmpeg 7.1
   or later), else the PATH.
   ============================================================ */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where one of ffmpeg's tools is. */
export function findTool(name, env = process.env) {
  const set = env[name.toUpperCase()];
  if (set) return set;
  for (const d of [join(homedir(), '.local/opt/ffmpeg/bin'), '/usr/local/bin', '/usr/bin']) {
    const f = join(d, name);
    if (existsSync(f)) return f;
  }
  return name;
}

/** ffmpeg and ffprobe, or null when there is no ffmpeg (then nothing is converted). */
export function findTools(env = process.env) {
  const t = { ffmpeg: findTool('ffmpeg', env), ffprobe: findTool('ffprobe', env) };
  return t;
}

function run(bin, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(-500); reject(err); } else resolve(String(stdout));
    });
  });
}

/** Can these tools run at all? */
export async function toolsWork(t) {
  try { await run(t.ffmpeg, ['-hide_banner', '-version'], { timeout: 10_000 }); await run(t.ffprobe, ['-hide_banner', '-version'], { timeout: 10_000 }); return true; } catch { return false; }
}

/**
 * What a file holds. Null when ffprobe cannot read it.
 * w and h are as it is shown (a phone video filmed upright says so with a rotation).
 */
export async function probe(t, file) {
  let out;
  try {
    out = JSON.parse(await run(t.ffprobe, ['-v', 'error', '-show_entries',
      'format=format_name,duration:stream=index,codec_type,codec_name,width,height,pix_fmt,duration:stream_side_data=rotation:stream_disposition=attached_pic',
      '-of', 'json', file], { timeout: 30_000 }));
  } catch { return null; }
  const streams = out.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const rot = v?.side_data_list?.find((x) => x.rotation != null)?.rotation;
  const turned = Math.abs(Number(rot || 0)) % 180 === 90;
  const d = Number(out.format?.duration ?? v?.duration);
  return {
    format: String(out.format?.format_name || ''),
    v: v ? { codec: v.codec_name, pix: v.pix_fmt || '', w: (turned ? v.height : v.width) || null, h: (turned ? v.width : v.height) || null } : null,
    a: a ? { codec: a.codec_name } : null,
    duration: Number.isFinite(d) && d > 0 ? d : null,
  };
}

/** How a probed video is kept: copied into MP4 or WebM, or encoded again as H.264 MP4. */
export function videoPlan(p) {
  const mp4 = /(^|,)(mov|mp4)(,|$)/.test(p.format);
  const mkv = /(^|,)(matroska|webm)(,|$)/.test(p.format);
  const pix420 = !p.v.pix || /^yuvj?420p$/.test(p.v.pix);
  if (mp4 && p.v.codec === 'h264' && pix420 && (!p.a || ['aac', 'mp3'].includes(p.a.codec))) return { mode: 'copy', ext: 'mp4', mime: 'video/mp4' };
  if (mkv && ['vp8', 'vp9', 'av1'].includes(p.v.codec) && (!p.a || ['opus', 'vorbis'].includes(p.a.codec))) return { mode: 'copy', ext: 'webm', mime: 'video/webm' };
  return { mode: 'encode', ext: 'mp4', mime: 'video/mp4' };
}

const NO_META = ['-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-fflags', '+bitexact'];

/** Copy the first video and sound streams as they are, without metadata. */
export function copyVideo(t, src, out, ext) {
  return run(t.ffmpeg, ['-v', 'error', '-y', '-i', src, '-map', '0:V:0', '-map', '0:a:0?', '-c', 'copy', ...NO_META,
    ...(ext === 'webm' ? [] : ['-movflags', '+faststart']), '-f', ext === 'webm' ? 'webm' : 'mp4', out], { timeout: 180_000 });
}

/** Encode again as H.264 + AAC in MP4, the way up, at most 1920 px on its long side. Slow: minutes for a long 4K video. */
export function encodeVideo(t, src, out, { threads = 4 } = {}) {
  return run(t.ffmpeg, ['-v', 'error', '-y', '-i', src, '-map', '0:V:0', '-map', '0:a:0?',
    '-vf', 'scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-threads', String(threads),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', ...NO_META, '-movflags', '+faststart', '-f', 'mp4', out], { timeout: 20 * 60_000 });
}

/** One frame of a video, as a JPEG at most `max` px: the most typical of the second or so from `at`
    (ffmpeg's thumbnail filter), so a fade from black or a blurred first frame is passed over. */
export function posterOf(t, src, out, { at = 1, max = 480 } = {}) {
  return run(t.ffmpeg, ['-v', 'error', '-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-update', '1',
    '-vf', `thumbnail=n=30,scale=w=min(${max}\\,iw):h=min(${max}\\,ih):force_original_aspect_ratio=decrease,format=yuvj420p`, '-q:v', '4', ...NO_META, '-f', 'image2', '-c:v', 'mjpeg', out], { timeout: 60_000 });
}

/**
 * A photo as a JPEG: at most `max` px on its long side, or a `square` cut
 * from the middle (or from `crop`). A transparent one is laid on white, as a JPEG has no
 * transparency.
 */
export function photoToJpeg(t, src, out, { max = 2048, square = 0, crop = null, quality = 3 } = {}) {
  // `crop` ({ x, y, w, h }, fractions of the photo as shown): the part chosen; else the middle square.
  const n = (v) => Math.max(0, Math.min(1, Number(v) || 0)).toFixed(5);
  const cut = crop
    ? `crop=iw*${n(crop.w)}:ih*${n(crop.h)}:iw*${n(crop.x)}:ih*${n(crop.y)},crop=min(iw\\,ih):min(iw\\,ih)`
    : 'crop=min(iw\\,ih):min(iw\\,ih)';
  const fit = square
    ? `${cut},scale=w=min(${square}\\,iw):h=min(${square}\\,ih)`
    : `scale=w=min(${max}\\,iw):h=min(${max}\\,ih):force_original_aspect_ratio=decrease`;
  // White under anything transparent, then the size, then JPEG's colours.
  const vf = `format=rgba,split[a][b];[a]drawbox=c=white:t=fill[w];[w][b]overlay=format=auto,${fit},format=yuvj420p`;
  return run(t.ffmpeg, ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-update', '1', '-filter_complex', `[0:V:0]${vf}`,
    '-q:v', String(quality), ...NO_META, '-f', 'image2', '-c:v', 'mjpeg', out], { timeout: 90_000 });
}
