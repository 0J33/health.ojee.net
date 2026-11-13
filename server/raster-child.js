/* The renderer's own process (raster.js starts it under xvfb-run): MapLibre Native drawing the
   basemap's style. Every file the style names (/api/basemap/f/…) is asked of the parent, which
   has them on disk (basemap.js); nothing is fetched from here. One map per theme, kept. */

import mbgl from '@maplibre/maplibre-gl-native';

const maps = new Map();   // theme -> { map, key }
const asks = new Map();
let n = 0;

/** A file from the parent, as MapLibre Native's request callback wants it. */
function request(req, cb) {
  const m = /\/api\/basemap\/f\/(.+)$/.exec(req.url || '');
  if (!m) { cb(null); return; }   // only the basemap's own files
  const id = ++n;
  asks.set(id, (buf) => cb(null, buf ? { data: Buffer.from(buf) } : {}));
  process.send({ type: 'file', id, path: m[1] });
}

function mapFor(theme, style) {
  const key = JSON.stringify(style.sources);
  const had = maps.get(theme);
  if (had && had.key === key) return had.map;
  if (had) had.map.release();
  const map = new mbgl.Map({ request, ratio: 1 });
  // MapLibre Native wants whole addresses: the style's own (/api/basemap/f/…) given a made-up host.
  map.load(JSON.parse(JSON.stringify(style).replaceAll('"/api/basemap/f/', '"http://basemap.local/api/basemap/f/')));
  maps.set(theme, { map, key });
  return map;
}

process.on('message', (m) => {
  if (m?.type === 'file') { const f = asks.get(m.id); asks.delete(m.id); f?.(m.buf); return; }
  if (m?.type !== 'render') return;
  try {
    const map = mapFor(m.theme, m.style);
    map.render({ zoom: m.zoom, center: m.center, width: m.size, height: m.size }, (err, buf) => {
      process.send(err ? { type: 'error', id: m.id, error: err.message } : { type: 'done', id: m.id, buf });
    });
  } catch (e) { process.send({ type: 'error', id: m.id, error: e.message }); }
});
process.on('disconnect', () => process.exit(0));
