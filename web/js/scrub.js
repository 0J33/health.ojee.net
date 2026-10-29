/* Every chart, readable point by point.

   The charts mark each point with an invisible hit area (`.c-hit`, or the
   mark itself for a sleep stage, a heat-map day or a scatter dot) that
   carries `data-read`, the sentence for that point, and optionally
   `data-go` (where the point leads: its day, week or month) and
   `data-cx` / `data-cy` (where a line's point sits). This file gives them
   one behaviour everywhere:

     mouse      hover reads the point under the pointer: a crosshair, a dot
                on the line, a label beside it, and the readout line above
                the chart. A click on a point that leads somewhere goes.
     touch      a tap shows the point and keeps it; tap it again (or the
                label's "Open") to go. Dragging sideways moves through the
                points (the page still scrolls up and down: the charts are
                `touch-action: pan-y`).
     keyboard   every chart with points is focusable; left and right move,
                Home and End jump, Enter opens, Escape lets go.

   Nothing here knows a metric: it reads the marks the charts drew. */

import { go } from './app.js';

const HIT = '.c-hit, [data-read]';
let active = null;   // { chart, hit, pinned }

const hitsOf = (chart) => {
  const own = [...chart.querySelectorAll('.c-hit')];
  return own.length ? own : [...chart.querySelectorAll('[data-read]')];
};
const svgOf = (chart) => chart.querySelector('svg');
const chartOf = (el) => el?.closest?.('.chart');

/** The hit nearest a point on screen: the one under it, else the closest by x. */
function hitAt(chart, clientX, clientY) {
  const under = document.elementFromPoint(clientX, clientY)?.closest?.(HIT);
  if (under && chart.contains(under)) return under;
  const hits = hitsOf(chart);
  let best = null; let dist = Infinity;
  for (const h of hits) {
    const b = h.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    const cx = b.left + b.width / 2;
    const d = clientX >= b.left && clientX <= b.right ? 0 : Math.abs(clientX - cx);
    if (d < dist) { dist = d; best = h; }
  }
  return best;
}

function clear(keepRead = true) {
  if (!active) return;
  const { chart } = active;
  chart.querySelector('.c-cross')?.remove();
  chart.querySelector('.c-focus')?.remove();
  chart.querySelector('.ctip')?.remove();
  for (const h of chart.querySelectorAll('.is-on')) h.classList.remove('is-on');
  if (!keepRead) {
    const out = chart.closest('.chartbox')?.querySelector('.chart__read');
    if (out && out.dataset.def !== undefined) out.textContent = out.dataset.def;
  }
  active = null;
}

/** "Mon 12 Oct: 9,412 steps, 7-day average 8,800" -> head and body. */
function parts(read) {
  const i = read.indexOf(': ');
  return i > 0 && i < 40 ? [read.slice(0, i), read.slice(i + 2)] : ['', read];
}

function show(chart, hit, { pinned = false } = {}) {
  if (!hit) return;
  if (active && active.chart === chart && active.hit === hit) { active.pinned ||= pinned; return; }
  if (active) clear();
  active = { chart, hit, pinned };
  hit.classList.add('is-on');
  const svg = svgOf(chart);
  const read = hit.dataset.read || '';
  const out = chart.closest('.chartbox')?.querySelector('.chart__read');
  if (out) { if (out.dataset.def === undefined) out.dataset.def = out.textContent; out.textContent = read; }
  if (!svg) return;
  // The crosshair and the dot, in the chart's own units.
  const vb = svg.viewBox.baseVal;
  const sx = svg.clientWidth / (vb?.width || svg.clientWidth || 1);
  let x = Number(hit.dataset.cx);
  if (!Number.isFinite(x)) {
    const bb = hit.getBBox?.();
    x = bb ? bb.x + bb.width / 2 : 0;
  }
  const y0 = Number(hit.getAttribute('y')) || 0;
  const hh = Number(hit.getAttribute('height')) || svg.clientHeight;
  if (hit.classList.contains('c-hit')) {
    const NS = 'http://www.w3.org/2000/svg';
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('class', 'c-cross');
    ln.setAttribute('x1', x); ln.setAttribute('x2', x); ln.setAttribute('y1', y0); ln.setAttribute('y2', y0 + hh);
    svg.insertBefore(ln, hit);
    const cy = Number(hit.dataset.cy);
    if (Number.isFinite(cy) && svg.querySelector('.c-line, .c-thin, .c-avg')) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'c-focus');
      dot.setAttribute('cx', x); dot.setAttribute('cy', cy); dot.setAttribute('r', 5);
      svg.append(dot);
    }
  }
  // The label: above the point, kept inside the chart.
  const [headTxt, body] = parts(read);
  const tip = document.createElement('div');
  tip.className = 'ctip';
  tip.setAttribute('aria-hidden', 'true');
  if (headTxt) { const h = document.createElement('span'); h.className = 'ctip__h'; h.textContent = headTxt; tip.append(h); }
  const b = document.createElement('span'); b.className = 'ctip__b'; b.textContent = body; tip.append(b);
  if (hit.dataset.go) {
    const a = document.createElement('a');
    a.className = 'ctip__go'; a.href = hit.dataset.go; a.textContent = 'Open';
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clear(); go(a.getAttribute('href')); });
    tip.append(a);
  }
  chart.append(tip);
  const cw = chart.clientWidth;
  const tw = tip.offsetWidth;
  const px = x * sx;
  tip.style.left = `${Math.max(0, Math.min(cw - tw, px - tw / 2))}px`;
  const cy = Number(hit.dataset.cy);
  const topAt = Number.isFinite(cy) ? cy * sx : y0 * sx;
  tip.classList.toggle('ctip--below', topAt - tip.offsetHeight - 10 < 0);
  tip.style.top = tip.classList.contains('ctip--below') ? `${Math.min(chart.clientHeight - tip.offsetHeight, topAt + 14)}px` : `${topAt - tip.offsetHeight - 10}px`;
}

/* ── pointer ────────────────────────────────────────────────── */

let touch = null;   // { chart, x, y, moved, scrub }

document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (!touch) return;
    const dx = e.clientX - touch.x; const dy = e.clientY - touch.y;
    if (!touch.scrub && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) touch.scrub = true;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) touch.moved = true;
    if (touch.scrub) show(touch.chart, hitAt(touch.chart, e.clientX, e.clientY), { pinned: true });
    return;
  }
  const chart = chartOf(e.target);
  if (!chart) { if (active && !active.pinned) clear(false); return; }
  const hit = hitAt(chart, e.clientX, e.clientY);
  if (hit) show(chart, hit);
}, { passive: true });

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const chart = chartOf(e.target);
  // A tap anywhere else lets a pinned point go.
  if (!chart) { if (active && !e.target.closest?.('.ctip')) clear(false); touch = null; return; }
  touch = { chart, x: e.clientX, y: e.clientY, moved: false, scrub: false, was: active?.chart === chart ? active.hit : null };
}, { passive: true });

document.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch' || !touch) return;
  const t = touch; touch = null;
  if (t.moved) return;
  const hit = hitAt(t.chart, e.clientX, e.clientY);
  if (!hit) return;
  // The same point again: open it, when it leads somewhere.
  if (t.was === hit && hit.dataset.go) { clear(); go(hit.dataset.go); return; }
  show(t.chart, hit, { pinned: true });
});
document.addEventListener('pointercancel', () => { touch = null; });

document.addEventListener('click', (e) => {
  if (e.pointerType === 'touch' || e.detail === 0) return;   // touch is handled above; keyboard below
  const chart = chartOf(e.target);
  if (!chart || e.target.closest('.ctip')) return;
  const hit = e.target.closest(HIT) || hitAt(chart, e.clientX, e.clientY);
  if (hit?.dataset.go) { e.preventDefault(); clear(); go(hit.dataset.go); }
});

document.addEventListener('pointerleave', (e) => { if (e.target === document.documentElement && active && !active.pinned) clear(false); });
document.addEventListener('mouseout', (e) => {
  if (!active || active.pinned) return;
  const to = e.relatedTarget;
  if (!to || !active.chart.contains(to)) { if (chartOf(e.target) === active.chart) clear(false); }
});

/* ── keyboard ───────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  const chart = e.target.closest?.('.chart');
  if (!chart || e.target !== chart) return;
  const hits = hitsOf(chart);
  if (!hits.length) return;
  if (e.key === 'Escape') { clear(false); return; }
  if (e.key === 'Enter' && active?.chart === chart && active.hit.dataset.go) { e.preventDefault(); const to = active.hit.dataset.go; clear(); go(to); return; }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  let i = active?.chart === chart ? hits.indexOf(active.hit) : hits.length;
  i = e.key === 'Home' ? 0 : e.key === 'End' ? hits.length - 1 : Math.min(hits.length - 1, Math.max(0, i + (e.key === 'ArrowLeft' ? -1 : 1)));
  show(chart, hits[i], { pinned: true });
});
document.addEventListener('focusout', (e) => { if (active && e.target === active.chart && !active.chart.contains(e.relatedTarget)) clear(false); });

/** Called after a chart is drawn: focusable when it has points to read. */
export function readyChart(el) {
  const has = el.querySelector(HIT);
  if (has) {
    el.tabIndex = 0;
    if (!el.getAttribute('aria-describedby')) {
      const read = el.closest('.chartbox')?.querySelector('.chart__read');
      if (read) { read.id ||= `cr${Math.random().toString(36).slice(2, 8)}`; el.setAttribute('aria-describedby', read.id); }
    }
    el.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End Enter');
  }
  if (active?.chart === el) active = null;   // redrawn: the old marks are gone
}
