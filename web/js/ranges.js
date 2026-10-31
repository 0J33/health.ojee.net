/* Reference ranges, drawn: the segmented bar with a dot at the value, the
   badge of the band the value is in, and the bands in numbers for a
   sheet. One component for the Body composition screen (bodycomp.js) and
   every metric page (views/metric.js); the chip of a row of the list is
   rangeChip().

   A band here is { label, lo, hi, tone, hiShown?, over? } in the units it
   is shown in: lo inclusive, hi exclusive, null at an open end. Tones:
   'good', 'ok' (the typical or standard band), 'low' and 'high' (drawn
   quietly, never as an alarm). The server's ranges (core/ranges.js) have
   `from` / `to`; fromServer() turns them into these.

   A guide, not medical advice: the sheet always says so and names the
   source. */

import { html, raw } from './ui.js';
import { facts } from './kit.js';

const fin = Number.isFinite;
const TONES = new Set(['good', 'ok', 'low', 'high']);
const toneCls = (t) => (TONES.has(t) ? t : 'none');

/** Where a value sits along equal-width bands, 0 to 100 (open ends get the width of the band next to them). */
export function markAt(bands, at, v) {
  const n = bands.length;
  if (at < 0 || !fin(v)) return null;
  const b = bands[at];
  let lo = b.lo; let hi = b.hi;
  // An open bottom with no natural floor (a waist under 94 cm) is given room: at least a fifth of its edge.
  if (lo === null && hi !== null) { const nb = bands[at + 1]; lo = hi - Math.max(nb && nb.hi !== null ? nb.hi - nb.lo : 0, Math.abs(hi) * 0.2) || hi - 1; }
  if (hi === null && lo !== null) { const pb = bands[at - 1]; hi = lo + (pb && pb.lo !== null ? pb.hi - pb.lo : Math.abs(lo) * 0.25 || 1); }
  const inside = hi > lo ? Math.min(0.96, Math.max(0.04, (v - lo) / (hi - lo))) : 0.5;
  return ((at + inside) / n) * 100;
}

/**
 * The bands as a segmented bar, a dot at the value and the band names
 * under it.
 *   rangeBar({ bands, at, value, label: 'Resting heart rate: 58 bpm, Low' })
 */
export function rangeBar({ bands, at, value, label = '', compact = false, names = true }) {
  if (!bands?.length) return '';
  const x = markAt(bands, at, value);
  const aria = `${label}${label ? '. ' : ''}Ranges: ${bands.map((b) => b.label).join(', ')}.`;
  return html`<span class="bc-range ${compact ? 'bc-range--c' : ''}" role="img" aria-label="${aria}">
    <span class="bc-range__bar">${bands.map((b, i) => html`<span class="bc-seg bc-seg--${toneCls(b.tone)} ${i === at ? 'is-at' : ''}"></span>`)}
      ${x !== null ? raw(`<span class="bc-range__dot" data-style="--x:${x.toFixed(1)}%"></span>`) : ''}</span>
    ${names ? html`<span class="bc-range__lab" aria-hidden="true">${bands.map((b, i) => html`<span class="${i === at ? 'is-at' : ''}">${b.label}</span>`)}</span>` : ''}
  </span>`;
}

/** The name of the band a value is in, as a small badge. */
export const rangeBadge = (label, tone) => (label ? html`<span class="bc-badge bc-badge--${toneCls(tone)}">${label}</span>` : '');

/** The same, for a row of a list: smaller, and never wider than its place. */
export const rangeChip = (band, { title = '' } = {}) => (band?.label ? html`<span class="rg-chip rg-chip--${toneCls(band.tone)}" title="${title}">${band.label}</span>` : '');

/**
 * The bands in numbers, for a sheet: "Typical  60 to 100 bpm".
 * edge(v) writes a number (already in the shown unit); tail is its unit.
 */
export function bandFacts({ bands, at, edge, tail = '' }) {
  const t = (s) => `${s}${tail}`;
  return facts(bands.map((b, i) => ({
    k: html`${b.label}${i === at ? html` <span class="bc-you">you</span>` : ''}`,
    v: b.lo === null ? (fin(b.hiShown) ? `up to ${t(edge(b.hiShown))}` : `under ${t(edge(b.hi))}`)
      : b.hi === null ? (fin(b.over) ? `over ${t(edge(b.over))}` : `${t(edge(b.lo))} and up`)
        : `${edge(b.lo)} to ${t(edge(fin(b.hiShown) ? b.hiShown : b.hi))}`,
  })), { cols: 2, cls: 'facts--s bc-bands' });
}

/** A server range's bands (core/ranges.js: from, to, toShown, over) in shown units, through conv(v). */
export function fromServer(r, conv = (v) => v) {
  const c = (v) => (fin(v) ? conv(v) : null);
  return r.bands.map((b) => ({ label: b.label, tone: b.tone, lo: c(b.from), hi: c(b.to), hiShown: c(b.toShown), over: c(b.over) }));
}
