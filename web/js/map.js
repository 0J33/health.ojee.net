/* A route on a map: OpenStreetMap tiles (through this site's server,
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
export function routeMap(el, { line = [], bounds = null, height = 300, follow = false, label = 'Map of the route' } = {}) {
  el.classList.add('map');
  el.style.height = `${height}px`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  mount(el, html`<div class="map__tiles"></div><svg class="map__line" aria-hidden="true"></svg>
    <div class="map__ctl"><button type="button" class="iconbtn map__b" data-z="1" aria-label="Zoom in">${ic('plus', { size: 's' })}</button><button type="button" class="iconbtn map__b" data-z="-1" aria-label="Zoom out">${ic('flat', { size: 's' })}</button>${follow ? html`<button type="button" class="iconbtn map__b" data-z="0" aria-label="Follow me">${ic('locate', { size: 's' })}</button>` : ''}</div>
    <p class="map__attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</p>`);
  const tilesEl = el.querySelector('.map__tiles');
  const svg = el.querySelector('.map__line');
  let pts = line.slice();
  let z = 15; let cx = 0; let cy = 0;   // the centre, in world pixels at zoom z
  let moved = false;

  const boundsOf = (p) => { let s = 90; let w = 180; let n = -90; let e = -180; for (const [la, ln] of p) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); } return { s, w, n, e }; };
  const fit = () => {
    const b = bounds || (pts.length ? boundsOf(pts) : null);
    if (!b) return;
    const W = el.clientWidth || 600; const H = el.clientHeight || height;
    const single = b.n - b.s < 1e-5 && b.e - b.w < 1e-5;
    z = single ? 16 : follow ? Math.max(15, fitZoom(b, W, H)) : fitZoom(b, W, H);
    cx = (lon2x(b.w, z) + lon2x(b.e, z)) / 2; cy = (lat2y(b.n, z) + lat2y(b.s, z)) / 2;
  };
  const centreOnLast = () => { const p = pts[pts.length - 1]; if (p) { cx = lon2x(p[1], z); cy = lat2y(p[0], z); } };

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
    if (pts.length) {
      const xy = pts.map(([la, ln]) => [lon2x(ln, z) - x0, lat2y(la, z) - y0]);
      const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
      const [sx, sy] = xy[0]; const [ex, ey] = xy[xy.length - 1];
      svg.innerHTML = `<path class="map__halo" d="${d}"/><path class="map__path" d="${d}"/><circle class="map__s" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6"/><circle class="${follow ? 'map__me' : 'map__e'}" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${follow ? 8 : 6}"/>`;
    } else svg.innerHTML = '';
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

  // Dragging.
  let drag = null;
  el.addEventListener('pointerdown', (e) => { if (e.target.closest('button, a')) return; drag = { x: e.clientX, y: e.clientY, cx, cy }; el.setPointerCapture(e.pointerId); el.classList.add('is-drag'); });
  el.addEventListener('pointermove', (e) => { if (!drag) return; cx = drag.cx - (e.clientX - drag.x); cy = drag.cy - (e.clientY - drag.y); moved = true; draw(); });
  const up = () => { drag = null; el.classList.remove('is-drag'); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('dblclick', (e) => { const r = el.getBoundingClientRect(); zoomBy(1, e.clientX - r.left, e.clientY - r.top); });
  el.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = el.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  el.querySelector('.map__ctl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    const dz = Number(b.dataset.z);
    if (dz === 0) { moved = false; centreOnLast(); draw(); } else zoomBy(dz);
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);

  fit();
  if (follow) centreOnLast();
  draw();
  return {
    update(next) {
      pts = next.slice();
      if (follow && !moved) centreOnLast();
      if (!follow) fit();
      draw();
    },
    destroy() { ro.disconnect(); },
  };
}
