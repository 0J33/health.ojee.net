/* ============================================================
   health.ojee.net — map tiles for routes.

   OpenStreetMap's standard tiles (tile.openstreetmap.org, © OpenStreetMap
   contributors, ODbL), fetched by this server and kept on disk for 30
   days, so the page loads them from its own origin (its CSP allows no
   other) and each tile is asked of OpenStreetMap once, as its tile usage
   policy asks: a real User-Agent, caching, no bulk downloads. Only zoom
   levels 2 to 18 and only for signed-in people.
   ============================================================ */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TILE_URL = 'https://tile.openstreetmap.org';
const KEEP_MS = 30 * 86_400_000;

export class TileCache {
  constructor({ dir, fetchImpl = globalThis.fetch, base = TILE_URL, userAgent = 'health.ojee.net/1.0 (+https://health.ojee.net)' } = {}) {
    this.dir = dir; this.fetch = fetchImpl; this.base = base; this.ua = userAgent;
    this.inflight = new Map();
    this.mem = new Map();
  }

  static valid(z, x, y) { return Number.isInteger(z) && z >= 2 && z <= 18 && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z; }

  /** The PNG bytes of a tile, or null. */
  async get(z, x, y) {
    if (!TileCache.valid(z, x, y)) return null;
    const key = `${z}/${x}/${y}`;
    const file = this.dir ? join(this.dir, String(z), String(x), `${y}.png`) : null;
    if (file && existsSync(file) && Date.now() - statSync(file).mtimeMs < KEEP_MS) return readFileSync(file);
    if (!file && this.mem.has(key)) return this.mem.get(key);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const run = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      timer.unref?.();
      try {
        const res = await this.fetch(`${this.base}/${key}.png`, { headers: { 'user-agent': this.ua, referer: 'https://health.ojee.net/' }, signal: ctl.signal });
        if (!res.ok) return file && existsSync(file) ? readFileSync(file) : null;   // an old copy beats none
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
        if (file) {
          mkdirSync(join(this.dir, String(z), String(x)), { recursive: true });
          writeFileSync(`${file}.part`, buf);
          renameSync(`${file}.part`, file);
        } else {
          if (this.mem.size > 300) this.mem.delete(this.mem.keys().next().value);
          this.mem.set(key, buf);
        }
        return buf;
      } catch { return file && existsSync(file) ? readFileSync(file) : null; } finally { clearTimeout(timer); this.inflight.delete(key); }
    })();
    this.inflight.set(key, run);
    return run;
  }
}
