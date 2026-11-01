/* ============================================================
   health.ojee.net — the basemap behind every map: CARTO's vector maps
   (Positron for the light theme, Dark Matter for the dark one; map data
   © OpenStreetMap contributors, ODbL; style © CARTO), drawn by MapLibre
   in the page (web/js/map.js).

   The page loads nothing from elsewhere (its CSP), so this server fetches
   the style, the vector tiles, the fonts and the sprite, and serves them
   from /api/basemap/…; the style is rewritten to point there, and its
   colours are brought to the app's own (the light map on the warm paper,
   the dark one on the near-black). Tiles and fonts are kept on disk for
   30 days.
   ============================================================ */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const UPSTREAM = 'https://tiles.basemaps.cartocdn.com/';
const KEEP_MS = 30 * 86_400_000;
const STYLE_MS = 24 * 3_600_000;

/** The app's colours for the map's ground and water, per theme. */
const PAINT = {
  light: { background: '#F2EDE5', water: '#D9E1E3', earth: '#F2EDE5' },
  dark: { background: '#0E0D0C', water: '#16191B', earth: '#0E0D0C' },
};

export class Basemap {
  constructor({ dir = null, fetchImpl = globalThis.fetch, userAgent = 'health.ojee.net/1.0 (+https://health.ojee.net)' } = {}) {
    this.dir = dir; this.fetch = fetchImpl; this.ua = userAgent;
    this.styles = new Map();   // theme -> { at, json }
    this.mem = new Map();
    this.inflight = new Map();
  }

  async #get(url, { timeout = 15_000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout); t.unref?.();
    try {
      const res = await this.fetch(url, { headers: { 'user-agent': this.ua, referer: 'https://health.ojee.net/' }, signal: ctl.signal });
      if (!res.ok) return null;
      return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
    } catch { return null; } finally { clearTimeout(t); }
  }

  /** Where an upstream path is served here. */
  static local(url) {
    if (!url.startsWith(UPSTREAM)) return url;
    return `/api/basemap/f/${url.slice(UPSTREAM.length)}`;
  }

  /** The style for a theme, its URLs pointing here and its ground and water in the app's colours. */
  async style(theme) {
    if (!STYLES[theme]) return null;
    const cur = this.styles.get(theme);
    if (cur && Date.now() - cur.at < STYLE_MS) return cur.json;
    const got = await this.#get(STYLES[theme]);
    let j = null;
    try { j = got ? JSON.parse(got.buf.toString('utf8')) : null; } catch { j = null; }
    if (!j) return cur?.json || null;
    for (const src of Object.values(j.sources || {})) {
      if (Array.isArray(src.tiles)) src.tiles = src.tiles.map(Basemap.local);
      if (src.url) src.url = Basemap.local(src.url);
    }
    if (j.glyphs) j.glyphs = Basemap.local(j.glyphs);
    if (j.sprite) j.sprite = typeof j.sprite === 'string' ? Basemap.local(j.sprite) : j.sprite;
    const p = PAINT[theme];
    for (const l of j.layers || []) {
      if (l.type === 'background') l.paint = { ...(l.paint || {}), 'background-color': p.background };
      else if (/water/i.test(l.id) && l.type === 'fill') l.paint = { ...(l.paint || {}), 'fill-color': p.water };
      else if (/^(earth|landcover_?base|land)$/i.test(l.id) && l.type === 'fill') l.paint = { ...(l.paint || {}), 'fill-color': p.earth };
    }
    this.styles.set(theme, { at: Date.now(), json: j });
    return j;
  }

  /**
   * A tile, font range or sprite file, by its path upstream (checked:
   * only CARTO's tiles host, only these kinds of file). Kept on disk.
   * @returns {{ buf: Buffer, type: string } | null}
   */
  async file(path) {
    if (!/^[A-Za-z0-9._\-/%, ]{1,200}$/.test(path) || path.includes('..')) return null;
    if (!/\.(mvt|pbf|png|json)$/.test(path) && !/\/sprite(@2x)?$/.test(path)) return null;
    const type = path.endsWith('.png') ? 'image/png' : path.endsWith('.json') ? 'application/json' : 'application/x-protobuf';
    const file = this.dir ? join(this.dir, ...path.split('/').map((x) => decodeURIComponent(x).replace(/[^A-Za-z0-9._\-, ]/g, '_'))) : null;
    if (file && existsSync(file) && Date.now() - statSync(file).mtimeMs < KEEP_MS) return { buf: readFileSync(file), type };
    if (!file && this.mem.has(path)) return this.mem.get(path);
    if (this.inflight.has(path)) return this.inflight.get(path);
    const run = (async () => {
      const got = await this.#get(UPSTREAM + path);
      if (!got) return file && existsSync(file) ? { buf: readFileSync(file), type } : null;
      const out = { buf: got.buf, type };
      if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.part`, got.buf); renameSync(`${file}.part`, file); }
      else { if (this.mem.size > 500) this.mem.delete(this.mem.keys().next().value); this.mem.set(path, out); }
      return out;
    })().finally(() => this.inflight.delete(path));
    this.inflight.set(path, run);
    return run;
  }
}
