/* The older map, for devices without WebGL (map.js uses it then). A route on a map: OpenStreetMap tiles (through this site's server,
   /api/tiles, so nothing is loaded from elsewhere) with the route drawn
   over them, start and finish marked. Drag to move, the buttons or a
   double tap to zoom. Also the live map of a route being recorded. */

import { html, mount, ic } from './ui.js';

const T = 256;
const lon2x = (lng, z) => ((lng + 180) / 360) * T * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * T * 2 ** z; };

/** The zoom that fits the bounds into w × h pixels, with a margin. */
function fitZoom(b, w, h) {
  for (let z = 18; z >= 2; z -= 1) {
    const dx = lon2x(b.e, z) - lon2x(b.w, z); const dy = lat2y(b.s, z) - lat2y(b.n, z);
    if (dx <= w - 48 && dy <= h - 48) return z;
  }
  return 2;
}

/**
 * Draw a map into `el`. `line` is [[lat, lng], ...]. Returns
 * { update(line), destroy() } (update for a route being recorded:
 * the view follows the newest point unless it was moved by hand).
 */
export function routeMap(el, { line = [], bounds = null, height = 300, follow = false, still = false, label = 'Map of the route', guide = null, onTap = null, center = null, closed = false, onLocate = null } = {}) {
  // `guide`: a route to follow, drawn faint under the line. `onTap(lat, lng)`: a tap
  // that was not a drag (drawing a route). `center`: [lat, lng] to start on when there
  // is no line yet. `closed`: the line is being drawn, so its points are marked.
  // `still`: a picture of the route (a feed card): no dragging, no buttons; a tap goes to whatever holds it.
  el.classList.add('map', 'map--raster');
  // In a page that scrolls (not following, not drawing): one finger scrolls the page, two move the map.
  const coop = !still && !follow && !onTap;
  if (still) el.classList.add('map--still');
  if (coop) el.classList.add('map--coop');
  el.style.height = `${height}px`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  mount(el, html`<div class="map__tiles"></div><svg class="map__line" aria-hidden="true"></svg>
    ${still ? '' : html`<div class="map__ctl"><button type="button" class="iconbtn map__b" data-z="1" aria-label="Zoom in">${ic('plus', { size: 's' })}</button><button type="button" class="iconbtn map__b" data-z="-1" aria-label="Zoom out">${ic('flat', { size: 's' })}</button><button type="button" class="iconbtn map__b" data-z="0" aria-label="${follow ? 'Follow me' : 'Back to the whole route'}" title="${follow ? 'Follow me' : 'Recenter'}">${ic(follow ? 'locate' : 'recenter', { size: 's' })}</button></div>`}
    <p class="map__attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</p>`);
  const tilesEl = el.querySelector('.map__tiles');
  const svg = el.querySelector('.map__line');
  let pts = line.slice();
  let gd = Array.isArray(guide) ? guide.slice() : null;
  let z = 15; let cx = 0; let cy = 0;   // the centre, in world pixels at zoom z
  let moved = false;
  let me = null;   // where you are now: { lat, lng, acc } (recording)

  const boundsOf = (p) => { let s = 90; let w = 180; let n = -90; let e = -180; for (const [la, ln] of p) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); } return { s, w, n, e }; };
  const fit = () => {
    const b = bounds || (pts.length ? boundsOf(pts) : gd?.length ? boundsOf(gd) : null);
    if (!b) { if (center) { z = 14; cx = lon2x(center[1], z); cy = lat2y(center[0], z); } else { z = 2; cx = lon2x(0, z); cy = lat2y(20, z); } return; }
    const W = el.clientWidth || 600; const H = el.clientHeight || height;
    const single = b.n - b.s < 1e-5 && b.e - b.w < 1e-5;
    z = single ? 16 : follow ? Math.max(15, fitZoom(b, W, H)) : fitZoom(b, W, H);
    cx = (lon2x(b.w, z) + lon2x(b.e, z)) / 2; cy = (lat2y(b.n, z) + lat2y(b.s, z)) / 2;
  };
  const centreOnLast = () => {
    const p = pts[pts.length - 1] || (me ? [me.lat, me.lng] : null);
    if (!p) return false;
    if (!pts.length && z < 15) z = 16;
    cx = lon2x(p[1], z); cy = lat2y(p[0], z);
    return true;
  };

  const tileCache = new Map();
  function draw() {
    const W = el.clientWidth || 600; const H = el.clientHeight || height;
    const x0 = cx - W / 2; const y0 = cy - H / 2;
    const n = 2 ** z;
    const want = new Set();
    for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + H) / T); ty += 1) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + W) / T); tx += 1) {
        const wx = ((tx % n) + n) % n;
        const key = `${z}/${wx}/${ty}/${tx}`;
        want.add(key);
        let img = tileCache.get(key);
        if (!img) {
          img = document.createElement('img');
          img.className = 'map__t'; img.alt = ''; img.decoding = 'async'; img.draggable = false;
          img.src = `/api/tiles/${z}/${wx}/${ty}.png`;
          tileCache.set(key, img);
          tilesEl.append(img);
        }
        img.style.transform = `translate(${Math.round(tx * T - x0)}px, ${Math.round(ty * T - y0)}px)`;
      }
    }
    for (const [k, img] of tileCache) if (!want.has(k)) { img.remove(); tileCache.delete(k); }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const pathOf = (list) => list.map(([la, ln], i) => `${i ? 'L' : 'M'}${(lon2x(ln, z) - x0).toFixed(1)},${(lat2y(la, z) - y0).toFixed(1)}`).join('');
    let out = gd?.length > 1 ? `<path class="map__guide" d="${pathOf(gd)}"/>` : '';
    if (pts.length) {
      const xy = pts.map(([la, ln]) => [lon2x(ln, z) - x0, lat2y(la, z) - y0]);
      const d = pathOf(pts);
      const [sx, sy] = xy[0]; const [ex, ey] = xy[xy.length - 1];
      out += pts.length > 1 ? `<path class="map__halo" d="${d}"/><path class="map__path" d="${d}"/>` : '';
      if (closed) out += xy.slice(1, -1).map(([x, y]) => `<circle class="map__v" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>`).join('');
      out += `<circle class="map__s" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6"/>${pts.length > 1 ? `<circle class="${follow ? 'map__me' : 'map__e'}" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${follow ? 8 : 6}"/>` : ''}`;
    }
    // You, before the route starts (or away from it): a dot and how sure the GPS is.
    if (me && !(follow && pts.length)) {
      const mx = lon2x(me.lng, z) - x0; const my = lat2y(me.lat, z) - y0;
      const mPerPx = (40_075_016 * Math.cos((me.lat * Math.PI) / 180)) / (T * 2 ** z);
      const acc = Math.min(Math.max(me.acc / mPerPx, 0), 400);
      out += `${acc > 10 ? `<circle class="map__acc" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${acc.toFixed(1)}"/>` : ''}<circle class="map__me" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="8"/>`;
    }
    svg.innerHTML = out;
  }

  const zoomBy = (dz, ax = null, ay = null) => {
    const nz = Math.max(2, Math.min(18, z + dz));
    if (nz === z) return;
    const W = el.clientWidth; const H = el.clientHeight;
    // Keep the point under the finger where it is.
    const px = ax === null ? W / 2 : ax; const py = ay === null ? H / 2 : ay;
    const wx = cx - W / 2 + px; const wy = cy - H / 2 + py;
    const k = 2 ** (nz - z);
    cx = wx * k - px + W / 2; cy = wy * k - py + H / 2;
    z = nz;
    draw();
  };

  // Dragging with one finger; two fingers pinch to zoom (shown scaled while
  // they move, then drawn at the nearest whole zoom when they let go).
  let drag = null;
  const fingers = new Map();
  let pinch = null;
  const layers = () => [tilesEl, svg];
  const spread = () => { const [a, b] = [...fingers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  if (!still) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a')) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture(e.pointerId);
    if (fingers.size === 2) {
      const r = el.getBoundingClientRect(); const g = spread();
      pinch = { d0: Math.max(g.d, 1), x0: g.x - r.left, y0: g.y - r.top, s: 1, tx: 0, ty: 0 };
      drag = null;
      for (const l of layers()) l.style.transformOrigin = `${pinch.x0}px ${pinch.y0}px`;
      return;
    }
    if (fingers.size > 2 || pinch) return;
    if (coop && e.pointerType === 'touch') return;
    drag = { x: e.clientX, y: e.clientY, cx, cy, far: false }; el.classList.add('is-drag');
  });
  el.addEventListener('pointermove', (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && fingers.size >= 2) {
      const r = el.getBoundingClientRect(); const g = spread();
      pinch.s = Math.max(0.25, Math.min(4, g.d / pinch.d0)); pinch.tx = g.x - r.left - pinch.x0; pinch.ty = g.y - r.top - pinch.y0;
      for (const l of layers()) l.style.transform = `translate(${pinch.tx}px, ${pinch.ty}px) scale(${pinch.s})`;
      moved = true;
      return;
    }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.far = true;
    cx = drag.cx - (e.clientX - drag.x); cy = drag.cy - (e.clientY - drag.y); moved = true; draw();
  });
  const endPinch = () => {
    const p = pinch; pinch = null;
    for (const l of layers()) { l.style.transform = ''; l.style.transformOrigin = ''; }
    cx -= p.tx; cy -= p.ty;
    const lg = Math.log2(p.s);
    const dz = lg > 0 ? Math.floor(lg + 0.6) : -Math.floor(-lg + 0.6);
    if (dz) zoomBy(dz, p.x0 + p.tx, p.y0 + p.ty); else draw();
  };
  const up = (e) => {
    fingers.delete(e?.pointerId);
    if (pinch) { if (fingers.size < 2) endPinch(); drag = null; el.classList.remove('is-drag'); return; }
    // A tap, not a drag: a point where it landed (drawing a route).
    if (drag && !drag.far && onTap && e?.type === 'pointerup') {
      const r = el.getBoundingClientRect(); const W = el.clientWidth; const H = el.clientHeight;
      const wx = cx - W / 2 + (e.clientX - r.left); const wy = cy - H / 2 + (e.clientY - r.top);
      const n = T * 2 ** z;
      const lng = (wx / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / n))) * 180) / Math.PI;
      onTap(Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5);
    }
    drag = null; el.classList.remove('is-drag');
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  if (!onTap) el.addEventListener('dblclick', (e) => { const r = el.getBoundingClientRect(); zoomBy(1, e.clientX - r.left, e.clientY - r.top); });
  el.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = el.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  el.querySelector('.map__ctl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    const dz = Number(b.dataset.z);
    if (dz === 0) { moved = false; if (!follow) { fit(); draw(); } else if (centreOnLast()) draw(); else onLocate?.(); } else zoomBy(dz);
  });
  }
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);

  fit();
  if (follow) centreOnLast();
  draw();
  return {
    update(next, { keepView = false } = {}) {
      pts = next.slice();
      if (follow && !moved) centreOnLast();
      if (!follow && !keepView) fit();
      draw();
    },
    /** Move the view to [lat, lng] (a "find me" button). */
    goTo(lat, lng, zoom = 15) { z = zoom; cx = lon2x(lng, z); cy = lat2y(lat, z); draw(); },
    /** Where you are now (a GPS fix): a dot; a map that follows you starts on it. */
    me(lat, lng, acc = 0) {
      const first = !me;
      me = { lat, lng, acc };
      if (follow && !moved && !pts.length) { if (first) z = Math.max(z, 16); centreOnLast(); }
      draw();
    },
    destroy() { ro.disconnect(); },
  };
}
