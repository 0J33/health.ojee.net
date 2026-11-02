/* A route on a map, drawn by MapLibre on CARTO's vector basemaps (the
   look of mapcn): Positron under the light theme, Dark Matter under the
   dark one, their ground and water in the app's own colours, all through
   this site's server (server/basemap.js), so nothing is loaded from
   elsewhere. The route is a line with a casing, start and finish marked
   (one mark for both when they are close) and its direction shown;
   drag and pinch to move and zoom, the buttons too. Also the live map of a
   route being recorded, the map a route is drawn on, and a dot for where
   you are.

   A still map (a card in the feed, a route in a list) is a picture: one
   hidden map draws each in turn and hands back an image, as a page may
   only hold a few live maps at once.

   Without WebGL, the older map of tiles and SVG (map-raster.js). */

import { html, mount, ic } from './ui.js';
import { routeMap as rasterMap, mapKey } from './map-raster.js';

let ML = null;
let loading = null;
/** MapLibre, loaded the first time a map is drawn. */
function lib() {
  if (ML) return Promise.resolve(ML);
  loading ||= import('../vendor/maplibre/maplibre-gl.mjs').then((m) => {
    m.setWorkerUrl(new URL('../vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);
    if (!document.querySelector('link[data-maplibre]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = new URL('../vendor/maplibre/maplibre-gl.css', import.meta.url).href; l.dataset.maplibre = '';
      document.head.append(l);
    }
    ML = m;
    return m;
  });
  return loading;
}
const webgl = (() => { let ok = null; return () => { if (ok === null) { try { const c = document.createElement('canvas'); ok = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { ok = false; } } return ok; }; })();

/** The basemap that goes with the theme showing now. */
export const themeStyle = () => {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || t === 'light' ? t : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
/** The style for a theme, read once, its addresses made whole (MapLibre wants full URLs). */
const styleCache = new Map();
function styleOf(t) {
  if (!styleCache.has(t)) {
    styleCache.set(t, fetch(`/api/basemap/${t}/style.json`, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error('style'); return r.json(); }).then((j) => {
      const abs = (u) => (typeof u === 'string' && u.startsWith('/') ? location.origin + u : u);
      for (const src of Object.values(j.sources || {})) { if (Array.isArray(src.tiles)) src.tiles = src.tiles.map(abs); if (src.url) src.url = abs(src.url); }
      j.glyphs = abs(j.glyphs); if (typeof j.sprite === 'string') j.sprite = abs(j.sprite);
      return j;
    }).catch((e) => { styleCache.delete(t); throw e; }));
  }
  return styleCache.get(t);
}

/** The colours of the route and its marks, from the page's own (train.css, .map). */
function colours(el) {
  const cs = getComputedStyle(el);
  const v = (k, d) => (cs.getPropertyValue(k).trim() || d);
  return { route: v('--route', '#ff6a3d'), casing: v('--route-case', '#ffffff'), ring: v('--mk-ring', '#ffffff'), end: v('--mk-end', '#15130f'), guide: '#6c7cf0', me: '#3a8bff' };
}

const lngLat = (p) => [p[1], p[0]];
const boundsOf = (pts) => { let s = 90; let w = 180; let n = -90; let e = -180; for (const [la, ln] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); } return [[w, s], [e, n]]; };
const fc = (features) => ({ type: 'FeatureCollection', features });
const lineF = (pts) => (pts.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(lngLat) }, properties: {} }] : []);
const pointF = (p, kind) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat(p) }, properties: { kind } });

/* Start, finish and direction, drawn once as images: a green disc with a play mark for the
   start, a checkered disc for the finish, one of each half when they are close together
   (a loop), and a small chevron that rides along the line every so often. */
const IMG_R = 2;
function canvasImage(size, draw) {
  const px = size * IMG_R;
  const cv = document.createElement('canvas'); cv.width = px; cv.height = px;
  const g = cv.getContext('2d'); g.scale(IMG_R, IMG_R); draw(g, size);
  return { img: g.getImageData(0, 0, px, px), pixelRatio: IMG_R };
}
const START_GREEN = '#22a862';
function checker(g, cx, cy, r, from = -Math.PI / 2, to = Math.PI * 1.5) {
  g.save(); g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, from, to); g.closePath(); g.clip();
  const q = r / 2.5;
  for (let y = cy - r; y < cy + r; y += q) for (let x = cx - r; x < cx + r; x += q) {
    g.fillStyle = (Math.round((x - cx + r) / q) + Math.round((y - cy + r) / q)) % 2 ? '#15130f' : '#ffffff';
    g.fillRect(x, y, q + 0.5, q + 0.5);
  }
  g.restore();
}
const play = (g, cx, cy, k) => { g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(cx - k * 0.6, cy - k); g.lineTo(cx + k, cy); g.lineTo(cx - k * 0.6, cy + k); g.closePath(); g.fill(); };
function endImage(kind, size = 26) {
  return canvasImage(size, (g, s) => {
    const c = s / 2; const r = c - 1.5;
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 3; g.shadowOffsetY = 1;
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
    g.shadowColor = 'transparent';
    const ri = r - 2.5;
    if (kind === 'start') { g.fillStyle = START_GREEN; g.beginPath(); g.arc(c, c, ri, 0, Math.PI * 2); g.fill(); play(g, c + 0.8, c, ri * 0.45); }
    if (kind === 'end') checker(g, c, c, ri);
    if (kind === 'both') {
      checker(g, c, c, ri, -Math.PI / 2, Math.PI / 2);
      g.fillStyle = START_GREEN; g.beginPath(); g.moveTo(c, c); g.arc(c, c, ri, Math.PI / 2, Math.PI * 1.5); g.closePath(); g.fill();
      play(g, c - ri * 0.42, c, ri * 0.32);
      g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(c, c - ri); g.lineTo(c, c + ri); g.stroke();
    }
  });
}
const arrowImage = () => canvasImage(16, (g) => {
  g.lineCap = 'round'; g.lineJoin = 'round';
  const path = () => { g.beginPath(); g.moveTo(5.5, 3.5); g.lineTo(11, 8); g.lineTo(5.5, 12.5); };
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 4.6; path(); g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 2.6; path(); g.stroke();
});
let images = null;
function addImages(map) {
  images ||= { 'rt-start': endImage('start'), 'rt-end': endImage('end'), 'rt-both': endImage('both', 30), 'rt-arrow': arrowImage() };
  for (const [k, v] of Object.entries(images)) if (!map.hasImage(k)) map.addImage(k, v.img, { pixelRatio: v.pixelRatio });
}

/** The route's sources and layers on a map: the guide, the line on its casing, its direction, the marks, you. */
function addRouteLayers(map, c) {
  addImages(map);
  map.addSource('guide', { type: 'geojson', data: fc([]) });
  map.addSource('route', { type: 'geojson', data: fc([]) });
  map.addSource('marks', { type: 'geojson', data: fc([]) });
  map.addSource('me', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'guide', type: 'line', source: 'guide', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.guide, 'line-width': 5, 'line-opacity': 0.75, 'line-dasharray': [0.2, 2] } });
  map.addLayer({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.casing, 'line-width': 9 } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.route, 'line-width': 4.5 } });
  // Which way it went: a chevron along the line every 80 px or so, turned with it.
  map.addLayer({ id: 'arrows', type: 'symbol', source: 'route', layout: {
    'symbol-placement': 'line', 'symbol-spacing': 80, 'icon-image': 'rt-arrow', 'icon-size': 1,
    'icon-rotation-alignment': 'map', 'icon-keep-upright': false, 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-padding': 0,
  } });
  map.addLayer({ id: 'marks', type: 'circle', source: 'marks', filter: ['in', ['get', 'kind'], ['literal', ['v', 'end-live']]], paint: {
    'circle-radius': ['match', ['get', 'kind'], 'v', 4, 8],
    'circle-color': ['match', ['get', 'kind'], 'v', c.ring, c.me],
    'circle-stroke-color': ['match', ['get', 'kind'], 'v', c.route, '#ffffff'],
    'circle-stroke-width': ['match', ['get', 'kind'], 'v', 2.5, 3],
  } });
  // Start and finish: the start over the finish where they touch.
  map.addLayer({ id: 'ends', type: 'symbol', source: 'marks', filter: ['in', ['get', 'kind'], ['literal', ['start', 'end', 'both']]], layout: {
    'icon-image': ['concat', 'rt-', ['get', 'kind']], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    'symbol-sort-key': ['match', ['get', 'kind'], 'start', 2, 1], 'symbol-z-order': 'source',
  } });
  map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', filter: ['==', ['get', 'kind'], 'acc'], paint: { 'circle-radius': ['get', 'r'], 'circle-color': 'rgba(58,139,255,0.16)', 'circle-stroke-color': 'rgba(58,139,255,0.45)', 'circle-stroke-width': 1, 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', filter: ['==', ['get', 'kind'], 'me'], paint: { 'circle-radius': 8, 'circle-color': c.me, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
}

/** Metres between two [lat, lng]. */
export const metresBetween = (a, b) => {
  const k = Math.PI / 180; const la = (b[0] - a[0]) * k; const ln = (b[1] - a[1]) * k;
  const h = Math.sin(la / 2) ** 2 + Math.cos(a[0] * k) * Math.cos(b[0] * k) * Math.sin(ln / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
};
/** Start and finish close enough to draw as one: within 40 m, or 5% of the route's span. */
export function endsTogether(pts) {
  if (pts.length < 2) return false;
  const [[w, s], [e, n]] = boundsOf(pts);
  const span = metresBetween([s, w], [n, e]);
  return metresBetween(pts[0], pts[pts.length - 1]) <= Math.max(40, span * 0.05);
}

function setRoute(map, { pts = [], gd = null, closed = false, follow = false }) {
  map.getSource('route')?.setData(fc(lineF(pts)));
  map.getSource('guide')?.setData(fc(gd?.length > 1 ? lineF(gd) : []));
  const marks = [];
  if (pts.length) {
    if (closed) for (const p of pts.slice(1, -1)) marks.push(pointF(p, 'v'));
    if (follow) {
      marks.push(pointF(pts[0], 'start'));
      if (pts.length > 1) marks.push(pointF(pts[pts.length - 1], 'end-live'));
    } else if (pts.length > 1 && endsTogether(pts)) marks.push(pointF(pts[0], 'both'));
    else {
      if (pts.length > 1) marks.push(pointF(pts[pts.length - 1], 'end'));
      marks.push(pointF(pts[0], 'start'));
    }
  }
  map.getSource('marks')?.setData(fc(marks));
  // A line being drawn point by point needs no arrows over its points.
  if (map.getLayer('arrows')) map.setLayoutProperty('arrows', 'visibility', closed ? 'none' : 'visible');
}

/* ── still maps: one hidden map draws each, in turn ──────────────── */

let stillMap = null; let stillTheme = null; const stillQueue = []; let stillBusy = false;
const stillCache = new Map();
async function stillImage({ line, w, h, theme }) {
  const key = `${theme}|${w}x${h}|${line.length}|${line[0]}|${line[line.length - 1]}|${line[line.length >> 1]}`;
  if (stillCache.has(key)) return stillCache.get(key);
  const p = new Promise((resolve) => { stillQueue.push({ line, w, h, theme, resolve }); });
  stillCache.set(key, p);
  if (stillCache.size > 120) stillCache.delete(stillCache.keys().next().value);
  runStill();
  return p;
}
async function runStill() {
  if (stillBusy) return;
  stillBusy = true;
  try {
    const m = await lib();
    while (stillQueue.length) {
      const job = stillQueue.shift();
      try {
        const host = stillMap?.getContainer() || Object.assign(document.createElement('div'), { className: 'map map--offscreen' });
        if (!host.isConnected) document.body.append(host);
        host.style.width = `${job.w}px`; host.style.height = `${job.h}px`;
        host.dataset.basemap = job.theme;
        if (!stillMap) {
          stillMap = new m.Map({ container: host, style: await styleOf(job.theme), interactive: false, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true }, fadeDuration: 0, pixelRatio: Math.min(2, devicePixelRatio || 1) });
          stillTheme = job.theme;
          await new Promise((r) => stillMap.once('load', r));
          addRouteLayers(stillMap, colours(host));
        } else if (stillTheme !== job.theme) {
          stillTheme = job.theme;
          const st = await styleOf(job.theme);
          const ready = new Promise((r) => stillMap.once('style.load', r));
          stillMap.setStyle(st, { diff: false });
          await ready;
          addRouteLayers(stillMap, colours(host));
        }
        stillMap.resize();
        setRoute(stillMap, { pts: job.line });
        // A small picture (a thumbnail) is too small for arrows.
        stillMap.setLayoutProperty('arrows', 'visibility', Math.min(job.w, job.h) < 140 ? 'none' : 'visible');
        stillMap.fitBounds(boundsOf(job.line), { padding: Math.min(24, Math.round(Math.min(job.w, job.h) / 6)), animate: false, maxZoom: 16 });
        await new Promise((r) => { stillMap.once('idle', r); stillMap.triggerRepaint(); });
        job.resolve(stillMap.getCanvas().toDataURL('image/webp', 0.86));
      } catch { job.resolve(null); }
    }
  } finally { stillBusy = false; }
}

/**
 * Draw a map into `el`. `line` is [[lat, lng], ...]. Returns
 * { update(line, { keepView }), goTo(lat, lng, zoom), me(lat, lng, acc), destroy() }.
 * `follow`: the view keeps to the newest point (recording) unless moved by hand.
 * `guide`: a route to follow, dashed under the line. `onTap(lat, lng)`: a tap that
 * was not a drag (drawing). `center`: where to start with no line yet. `closed`:
 * the line is being drawn, so its points are marked. `still`: a picture (a card).
 * Every map that moves has a button back to its whole route (or, following, to you).
 * A map in a page that scrolls (not following, not drawing) moves with two fingers
 * on a phone and Ctrl + wheel on a computer, so one finger or the wheel scrolls the page.
 */
/** The button back: to you when following, else to the whole route. */
export const recentre = (follow) => html`<button type="button" class="iconbtn map__b" data-z="0" aria-label="${follow ? 'Follow me' : 'Back to the whole route'}" title="${follow ? 'Follow me' : 'Recenter'}">${ic(follow ? 'locate' : 'recenter', { size: 's' })}</button>`;

export function routeMap(el, opts = {}) {
  if (!webgl()) return rasterMap(el, opts);
  const { line = [], bounds = null, height = 300, follow = false, still = false, label = 'Map of the route', guide = null, onTap = null, center = null, closed = false, onLocate = null } = opts;
  el.classList.add('map', 'map--gl');
  const coop = !still && !follow && !onTap;
  if (still) el.classList.add('map--still');
  if (coop) el.classList.add('map--coop');
  el.style.height = `${height}px`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  let theme = themeStyle();
  el.dataset.basemap = theme;
  mount(el, html`<div class="map__gl"></div>
    ${!still && !follow && !closed && !onTap && line.length > 1 ? mapKey() : ''}
    ${still ? '' : html`<div class="map__ctl"><button type="button" class="iconbtn map__b" data-z="1" aria-label="Zoom in">${ic('plus', { size: 's' })}</button><button type="button" class="iconbtn map__b" data-z="-1" aria-label="Zoom out">${ic('flat', { size: 's' })}</button>${recentre(follow)}</div>`}
    <p class="map__attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a></p>`);
  const box = el.querySelector('.map__gl');
  let pts = line.slice();
  const gd = Array.isArray(guide) ? guide.slice() : null;
  let me = null; let moved = false; let map = null; let gone = false;
  const pending = [];
  const whenReady = (fn) => { if (map?.isStyleLoaded() && map.getSource('route')) fn(map); else pending.push(fn); };

  /* A still map: a picture of the route, made by the hidden map. */
  if (still) {
    const paint = async () => {
      const w = Math.max(40, Math.round(el.clientWidth || 300)); const h = Math.max(40, Math.round(el.clientHeight || height));
      if (pts.length < 2) return;
      const src = await stillImage({ line: pts, w, h, theme: themeStyle() });
      if (gone || !src) return;
      mount(box, html`<img class="map__img" src="${src}" alt="" width="${w}" height="${h}">`);
    };
    requestAnimationFrame(paint);
    const mo = new MutationObserver(() => { if (themeStyle() !== theme) { theme = themeStyle(); el.dataset.basemap = theme; paint(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return { update(next) { pts = next.slice(); paint(); }, goTo() {}, me() {}, destroy() { gone = true; mo.disconnect(); } };
  }

  const view = ({ animate = false } = {}) => {
    if (!map) return;
    if (follow && !moved) {
      const p = pts[pts.length - 1] || (me ? [me.lat, me.lng] : null);
      if (p) { map.easeTo({ center: lngLat(p), zoom: Math.max(map.getZoom(), 15.5), duration: 600 }); return; }
    }
    const b = bounds ? [[bounds.w, bounds.s], [bounds.e, bounds.n]] : pts.length ? boundsOf(pts) : gd?.length ? boundsOf(gd) : null;
    if (b) map.fitBounds(b, { padding: 36, animate, duration: 500, maxZoom: 16 });
    else if (center) map[animate ? 'easeTo' : 'jumpTo']({ center: lngLat(center), zoom: 14, ...(animate ? { duration: 500 } : {}) });
  };
  const drawNow = (m) => {
    setRoute(m, { pts, gd, closed, follow });
    const feats = [];
    if (me && !(follow && pts.length)) {
      // The GPS's uncertainty, as a radius in pixels at this latitude and zoom.
      const mpp = (40_075_016 * Math.cos((me.lat * Math.PI) / 180)) / (512 * 2 ** m.getZoom());
      feats.push({ ...pointF([me.lat, me.lng], 'acc'), properties: { kind: 'acc', r: Math.min(300, Math.max(0, me.acc / mpp)) } });
      feats.push(pointF([me.lat, me.lng], 'me'));
    }
    m.getSource('me')?.setData(fc(feats));
  };
  const draw = () => whenReady(drawNow);

  Promise.all([lib(), styleOf(theme)]).then(([m, style]) => {
    if (gone) return;
    map = new m.Map({
      container: box, style, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      cooperativeGestures: coop, fadeDuration: 120, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true }, maxZoom: 18.5, minZoom: 2, renderWorldCopies: false,
      center: center ? lngLat(center) : [0, 20], zoom: center ? 14 : 2,
    });
    map.touchZoomRotate.disableRotation();
    el.__map = map;   // for the page's own checks (tests in a browser)
    map.on('load', () => {
      addRouteLayers(map, colours(el));
      view();
      draw();
      for (const fn of pending.splice(0)) fn(map);
    });
    map.on('dragstart', () => { moved = true; });
    map.on('zoomstart', (e) => { if (e.originalEvent) moved = true; });
    if (onTap) map.on('click', (e) => onTap(Math.round(e.lngLat.lat * 1e5) / 1e5, Math.round(e.lngLat.lng * 1e5) / 1e5));
    if (onTap) map.doubleClickZoom.disable();
  }).catch(() => { if (!gone) { el.classList.remove('map--gl'); rasterMap(el, opts); } });

  // Light or dark changed: the other basemap, the route put back on it.
  const mo = new MutationObserver(() => {
    if (!map || themeStyle() === theme) return;
    theme = themeStyle(); el.dataset.basemap = theme;
    styleOf(theme).then((st) => {
      if (!map) return;
      // Listened for before the style is set: a style given whole can be ready at once.
      map.once('style.load', () => { addRouteLayers(map, colours(el)); drawNow(map); for (const fn of pending.splice(0)) fn(map); });
      map.setStyle(st, { diff: false });
    });
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  el.querySelector('.map__ctl')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (!b || !map) return;
    const dz = Number(b.dataset.z);
    if (dz === 1) map.zoomIn();
    else if (dz === -1) map.zoomOut();
    else if (follow) { moved = false; if (pts.length || me) view({ animate: true }); else onLocate?.(); } else { moved = false; view({ animate: true }); }
  });
  const ro = new ResizeObserver(() => map?.resize());
  ro.observe(el);

  return {
    update(next, { keepView = false } = {}) {
      pts = next.slice();
      draw();
      if (follow && !moved) whenReady(() => view());
      else if (!follow && !keepView) whenReady(() => view());
    },
    /** Move the view to [lat, lng] (a "find me" button). */
    goTo(lat, lng, zoom = 15) { whenReady((m) => m.jumpTo({ center: [lng, lat], zoom })); },
    /** Where you are now (a GPS fix): a dot; a map that follows you starts on it. */
    me(lat, lng, acc = 0) {
      const first = !me;
      me = { lat, lng, acc };
      draw();
      if (follow && !moved && !pts.length) whenReady((m) => (first ? m.jumpTo({ center: [lng, lat], zoom: 16 }) : m.easeTo({ center: [lng, lat], duration: 400 })));
    },
    destroy() { gone = true; ro.disconnect(); mo.disconnect(); map?.remove(); map = null; },
  };
}
