/* ============================================================
   health.ojee.net — the map as plain pictures, drawn here.

   A device that cannot draw the vector map (no WebGL: map-raster.js)
   gets 256-pixel PNG tiles. They are drawn on this server from the same
   map the others see: OpenFreeMap's vector tiles and styles (basemap.js,
   which fetches and keeps them), in the app's colours, light or dark, by
   MapLibre Native in a child process (raster-child.js) under a virtual X
   display (xvfb-run). The tiles are kept a week (tiles.js), so they are
   drawn again from OpenFreeMap's weekly rebuild of OpenStreetMap.

   Off unless RASTER_RENDER=1 (it needs the optional
   @maplibre/maplibre-gl-native and xvfb-run on the box). When it is off
   or fails, tiles.js falls back to OpenStreetMap's own tiles.
   ============================================================ */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const CHILD = fileURLToPath(new URL('./raster-child.js', import.meta.url));

/** The centre of slippy tile z/x/y as [lng, lat]. */
export function tileCenter(z, x, y) {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return [lng, lat];
}

/** A PNG from straight (not premultiplied) RGBA pixels. */
export function encodePng(rgba, w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let r = 0; r < h; r += 1) {
    raw[r * (w * 4 + 1)] = 0;
    rgba.copy(raw, r * (w * 4 + 1) + 1, r * w * 4, (r + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The middle size×size of a premultiplied RGBA picture full×full, made straight. */
export function cropMiddle(premul, full, size) {
  const off = (full - size) / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const i = ((r + off) * full + (c + off)) * 4; const o = (r * size + c) * 4;
      const a = premul[i + 3];
      out[o + 3] = a;
      for (let k = 0; k < 3; k += 1) out[o + k] = a ? Math.min(255, Math.round((premul[i + k] * 255) / a)) : 0;
    }
  }
  return out;
}

export class RasterRenderer {
  /**
   * @param {object} o
   * @param {import('./basemap.js').Basemap} o.basemap  the styles and every file they name
   * @param {Function} [o.log]
   */
  constructor({ basemap, log = () => {} }) {
    this.basemap = basemap; this.log = log;
    this.child = null; this.n = 0; this.waiting = new Map();
    this.failedAt = 0; this.queue = Promise.resolve();
  }

  #start() {
    if (this.child) return this.child;
    const c = spawn('xvfb-run', ['-a', '-s', '-screen 0 640x480x24', process.execPath, CHILD], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    c.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !/Failed to open X display, retrying/.test(s)) this.log(`raster: ${s.slice(0, 200)}`); });
    c.on('message', (m) => this.#onMessage(m));
    const gone = (why) => {
      if (this.child !== c) return;
      this.child = null; this.failedAt = Date.now();
      for (const w of this.waiting.values()) w.reject(new Error(`renderer stopped (${why})`));
      this.waiting.clear();
    };
    c.on('exit', (code) => gone(`exit ${code}`));
    c.on('error', (e) => gone(e.message));
    this.child = c;
    return c;
  }

  async #onMessage(m) {
    if (m?.type === 'file') {
      // The child asks for a style's file (a vector tile, a font range, the sprite): basemap.js has it.
      let buf = null;
      try { const f = await this.basemap.file(String(m.path)); buf = f?.buf || null; } catch { buf = null; }
      this.child?.send({ type: 'file', id: m.id, buf });
      return;
    }
    const w = this.waiting.get(m?.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.type === 'done' && m.buf) w.resolve(Buffer.from(m.buf)); else w.reject(new Error(m.error || 'render failed'));
  }

  /** The PNG of tile z/x/y in a theme, or null when it cannot be drawn here now. */
  async tile(theme, z, x, y) {
    if (this.failedAt && Date.now() - this.failedAt < 60_000 && !this.child) return null;   // just died: give it a minute
    const style = await this.basemap.style(theme).catch(() => null);
    if (!style) return null;
    // One at a time: MapLibre Native draws one picture per map at once.
    const run = this.queue.then(async () => {
      const c = this.#start();
      const id = ++this.n;
      const FULL = 512; const SIZE = 256;
      const got = new Promise((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        setTimeout(() => { if (this.waiting.delete(id)) reject(new Error('render timed out')); }, 30_000).unref?.();
      });
      // A 256-pixel tile at z is MapLibre's zoom z-1; drawn twice as wide and cropped, so labels at its edges match its neighbours'.
      c.send({ type: 'render', id, theme, style, zoom: z - 1, center: tileCenter(z, x, y), size: FULL });
      const raw = await got;
      return encodePng(cropMiddle(raw, FULL, SIZE), SIZE, SIZE);
    });
    this.queue = run.catch(() => {});
    try { return await run; } catch (e) { this.log(`raster ${theme} ${z}/${x}/${y}: ${e.message}`); return null; }
  }

  close() { try { this.child?.kill(); } catch { /* gone */ } this.child = null; }
}
