/* Hand-drawn SVG charts. Descended from the console module's ui/charts.js,
   with two rules changed for this app:

   - Colour comes from classes in app.css, never from style="" (the CSP
     forbids inline styles), and there is one hue: the accent, in steps.
   - Every chart is drawn at the pixel width of its box (ui.chart() calls
     the draw function again on resize), so 11px labels stay 11px on a
     360px phone.

   Each chart carries role="img" with a sentence that says what it shows,
   marks carry data-read for the tap/hover readout, and tableAlt() gives
   the same numbers as a real table. */

import { esc } from './ui.js';
import { icon } from './icons.js';
import { compact, dayShort, dayMed, dow, dom, monthShort, isNum, clock, durShort, hourLabel } from './format.js';

const F = 11;
const r1 = (n) => Math.round(n * 10) / 10;

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
  return m * p;
}

function padRange(lo, hi, pad = 0.12) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  return [lo - span * pad, hi + span * pad];
}

/** A point that opens something when chosen: ` data-go="/metric/steps?range=day&end=…"`. */
export const goAttr = (go, i) => { const url = go ? go(i) : null; return url ? ` data-go="${esc(url)}"` : ''; };

const svg = (w, h, label, body) => `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;

function gridY(fr, lo, hi, fmt, n = 2) {
  let s = '';
  for (let i = 0; i <= n; i += 1) {
    const v = lo + ((hi - lo) * i) / n;
    const y = r1(fr.y1 - (fr.ih * i) / n);
    s += `<line class="${i === 0 ? 'c-axis' : 'c-grid'}" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>`;
    s += `<text x="${fr.x0 - 6}" y="${y + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  return s;
}

/** Which x positions get a date label: every day for a week, a handful otherwise. */
function xLabels(fr, dates, xOf) {
  const n = dates.length;
  if (!n) return '';
  let s = '';
  if (n <= 8) {
    dates.forEach((d, i) => { s += `<text x="${r1(xOf(i))}" y="${fr.y1 + 16}" text-anchor="middle">${esc(dow(d))}</text>`; });
    return s;
  }
  const want = fr.iw < 300 ? 3 : fr.iw < 520 ? 4 : 6;
  const step = (n - 1) / (want - 1);
  for (let k = 0; k < want; k += 1) {
    const i = Math.round(k * step);
    const anchor = k === 0 ? 'start' : k === want - 1 ? 'end' : 'middle';
    const x = k === 0 ? fr.x0 : k === want - 1 ? fr.x1 : xOf(i);
    s += `<text x="${r1(x)}" y="${fr.y1 + 16}" text-anchor="${anchor}">${esc(dayShort(dates[i]))}</text>`;
  }
  return s;
}

const frame = (w, h, l, r, t, b) => ({ x0: l, x1: w - r, y0: t, y1: h - b, iw: w - l - r, ih: h - t - b });

/**
 * Bars over days against an optional goal line. Days that meet the goal
 * are the full accent; the rest are a lighter step of it.
 * @param {{w:number, dates:string[], values:(number|null)[], goal?:number,
 *          fmt?:Function, tick?:Function, unit?:string, label:string, h?:number}} o
 */
export function bars({ w, h = 176, dates, values, goal, fmt = (v) => String(Math.round(v)), tick = compact, unit = '', label, goalLabel = 'Goal', go = null }) {
  const vals = values.filter(isNum);
  if (!vals.length) return '';
  const hi = niceMax(Math.max(...vals, goal || 0) * 1.04);
  const left = Math.max(30, Math.max(...[0, hi / 2, hi].map((v) => String(tick(v)).length)) * 6.4 + 10);
  const fr = frame(w, h, left, 4, goal ? 16 : 8, 24);
  const n = dates.length;
  const slot = fr.iw / Math.max(1, n);
  const bw = Math.max(2, Math.min(28, slot * (n > 45 ? 0.62 : 0.66)));
  const rx = Math.min(4, bw / 2);
  const xOf = (i) => fr.x0 + slot * i + slot / 2;
  const yOf = (v) => fr.y1 - (v / hi) * fr.ih;
  let s = gridY(fr, 0, hi, tick) + xLabels(fr, dates, xOf);
  values.forEach((v, i) => {
    if (!isNum(v)) return;
    const hh = Math.max(v > 0 ? 2 : 0, fr.y1 - yOf(v));
    const met = goal ? v >= goal : true;
    s += `<rect class="c-bar${met ? ' c-bar--met' : ''}" x="${r1(xOf(i) - bw / 2)}" y="${r1(fr.y1 - hh)}" width="${r1(bw)}" height="${r1(hh)}" rx="${r1(Math.min(rx, hh / 2))}"/>`;
  });
  if (goal) {
    const y = r1(yOf(goal));
    s += `<line class="c-rule" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>`;
    s += `<text class="c-rule-t" x="${fr.x1}" y="${y - 5}" text-anchor="end">${esc(`${goalLabel} ${fmt(goal)}`)}</text>`;
  }
  values.forEach((v, i) => {
    const read = `${dayMed(dates[i])}: ${isNum(v) ? `${fmt(v)}${unit ? ` ${unit}` : ''}` : 'no data'}`;
    s += `<rect class="c-hit" data-read="${esc(read)}"${goAttr(go, i)}${isNum(v) ? ` data-cy="${r1(yOf(v))}"` : ''} x="${r1(fr.x0 + slot * i)}" y="${fr.y0}" width="${r1(slot)}" height="${fr.ih}"/>`;
  });
  return svg(w, h, label, s);
}

/**
 * Lines over days. The first series is the subject: accent, with its last
 * point emphasised. Others are quiet (dashed grey). Gaps break the line.
 * @param {{w:number, dates:string[], series:Array<{values:(number|null)[], label:string, quiet?:boolean, dots?:boolean}>,
 *          band?:{lo:number, hi:number, label?:string}, fmt?:Function, tick?:Function, unit?:string, label:string,
 *          min?:number, max?:number, area?:boolean}} o
 */
export function line({ w, h = 176, dates, series, band, fmt = (v) => String(Math.round(v)), tick, unit = '', label, min, max, area = false, go = null }) {
  const all = [...series.flatMap((se) => se.values), ...(band ? [band.lo, band.hi] : [])].filter(isNum);
  if (!all.length) return '';
  let [lo, hi] = padRange(Math.min(...all), Math.max(...all));
  if (min !== undefined) lo = Math.max(min, lo);
  if (max !== undefined) hi = Math.min(max, hi);
  const fine = hi - lo < 6;
  const tk = tick || ((v) => { const r = fine ? Math.round(v * 10) / 10 : Math.round(v); return `${r === 0 ? 0 : r}`; });
  const left = Math.max(30, Math.max(...[lo, (lo + hi) / 2, hi].map((v) => String(tk(v)).length)) * 6.4 + 10);
  const fr = frame(w, h, left, 10, 10, 24);
  const n = dates.length;
  const xOf = (i) => fr.x0 + (n <= 1 ? fr.iw / 2 : (fr.iw * i) / (n - 1));
  const yOf = (v) => fr.y1 - ((v - lo) / (hi - lo)) * fr.ih;
  let s = '';
  if (band && isNum(band.lo) && isNum(band.hi)) {
    const ya = yOf(Math.min(hi, band.hi)); const yb = yOf(Math.max(lo, band.lo));
    s += `<rect class="c-band" x="${fr.x0}" y="${r1(ya)}" width="${fr.iw}" height="${r1(Math.max(1, yb - ya))}"/>`;
  }
  s += gridY(fr, lo, hi, tk) + xLabels(fr, dates, xOf);

  series.forEach((se, si) => {
    let d = ''; let pen = false; let first = null; let last = null; let count = 0;
    se.values.forEach((v, i) => {
      if (!isNum(v)) { if (!se.connect) pen = false; return; }
      d += `${pen ? 'L' : 'M'}${r1(xOf(i))},${r1(yOf(v))}`;
      pen = true; count += 1;
      if (first === null) first = i;
      last = i;
    });
    if (last === null) return;
    if (se.pointsOnly) {
      se.values.forEach((v, i) => { if (isNum(v)) s += `<circle class="c-dot--q" cx="${r1(xOf(i))}" cy="${r1(yOf(v))}" r="2.5"/>`; });
      return;
    }
    if (area && si === 0 && count > 1) {
      s += `<path class="c-area" d="${d}L${r1(xOf(last))},${fr.y1}L${r1(xOf(first))},${fr.y1}Z"/>`;
    }
    s += `<path class="c-line${se.quiet ? ' c-line--2' : ''}" d="${d}"/>`;
    if (!se.quiet && (se.dots || count < 12)) {
      se.values.forEach((v, i) => { if (isNum(v) && i !== last) s += `<circle class="c-dot--s" cx="${r1(xOf(i))}" cy="${r1(yOf(v))}" r="2.5"/>`; });
    }
    if (!se.quiet) s += `<circle class="c-dot" cx="${r1(xOf(last))}" cy="${r1(yOf(se.values[last]))}" r="4.5"/>`;
  });

  const slot = n <= 1 ? fr.iw : fr.iw / (n - 1);
  dates.forEach((dte, i) => {
    const parts = series.map((se) => (isNum(se.values[i]) ? `${series.length > 1 ? `${se.label} ` : ''}${fmt(se.values[i])}${unit ? ` ${unit}` : ''}` : null)).filter(Boolean);
    const read = `${dayMed(dte)}: ${parts.length ? parts.join(', ') : 'no data'}`;
    const v0 = series[0]?.values[i];
    s += `<rect class="c-hit" data-read="${esc(read)}"${goAttr(go, i)}${isNum(v0) ? ` data-cy="${r1(yOf(v0))}" data-cx="${r1(xOf(i))}"` : ''} x="${r1(xOf(i) - slot / 2)}" y="${fr.y0}" width="${r1(slot)}" height="${fr.ih}"/>`;
  });
  return svg(w, h, label, s);
}

/* ── sleep ──────────────────────────────────────────────────── */

const STAGE = {
  DEEP: { cls: 'st-deep', h: 1, label: 'Deep' },
  REM: { cls: 'st-rem', h: 0.74, label: 'REM' },
  LIGHT: { cls: 'st-light', h: 0.5, label: 'Light' },
  ASLEEP: { cls: 'st-asleep', h: 0.62, label: 'Asleep' },
  RESTLESS: { cls: 'st-light', h: 0.36, label: 'Restless' },
  AWAKE: { cls: 'st-awake', h: 0.26, label: 'Awake' },
};
export const stageInfo = (t) => STAGE[String(t || '').toUpperCase()] || STAGE.ASLEEP;

/**
 * One night as a single strip from bedtime to wake: deeper sleep is a
 * taller, stronger block; awake is an outline.
 * @param {{w:number, start:number, end:number, stages?:Array<{s:number,e:number,t:string}>, label:string}} o
 */
export function sleepNight({ w, h = 92, start, end, stages, label }) {
  if (!isNum(start) || !isNum(end) || end <= start) return '';
  const fr = frame(w, h, 2, 2, 6, 22);
  const xOf = (t) => fr.x0 + ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * fr.iw;
  const segs = stages?.length ? stages : [{ s: start, e: end, t: 'ASLEEP' }];
  let s = `<line class="c-axis" x1="${fr.x0}" x2="${fr.x1}" y1="${fr.y1}" y2="${fr.y1}"/>`;
  for (const g of segs) {
    const st = stageInfo(g.t);
    const x0 = xOf(g.s); const x1 = xOf(g.e);
    if (x1 - x0 < 0.4) continue;
    const hh = fr.ih * st.h;
    const awake = st.cls === 'st-awake';
    s += `<rect class="${st.cls}" data-read="${esc(`${st.label}, ${clock(g.s)} to ${clock(g.e)}`)}" x="${r1(x0 + (awake ? 0.5 : 0))}" y="${r1(fr.y1 - hh)}" width="${r1(Math.max(0.6, x1 - x0 - (awake ? 1 : 0)))}" height="${r1(hh - (awake ? 0.5 : 0))}"/>`;
  }
  s += `<text x="${fr.x0}" y="${fr.y1 + 16}" text-anchor="start">${esc(clock(start))}</text>`;
  s += `<text x="${fr.x1}" y="${fr.y1 + 16}" text-anchor="end">${esc(clock(end))}</text>`;
  return svg(w, h, label, s);
}

/**
 * One row per night on a shared clock (20:00 to 12:00), newest first, so
 * bedtime drift is visible at a glance.
 * @param {{w:number, nights:Array<{date:string, start:number, end:number, minutes:number, stages?:Array, bedMin:number, wakeMin:number}>, label:string}} o
 *   bedMin / wakeMin: minutes after 20:00 local on the evening before `date`.
 */
export function sleepTimeline({ w, nights, label }) {
  const rows = nights.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!rows.length) return '';
  const rowH = 16; const gap = 8;
  const l = 52; const r = 44; const top = 20;
  const h = top + rows.length * (rowH + gap) + 2;
  const iw = w - l - r;
  const SPAN = 16 * 60;
  const xOfMin = (m) => l + (Math.min(SPAN, Math.max(0, m)) / SPAN) * iw;
  let s = '';
  for (let hr = 0; hr <= 16; hr += 4) {
    const x = r1(xOfMin(hr * 60));
    s += `<line class="c-grid" x1="${x}" x2="${x}" y1="${top - 4}" y2="${h - 2}"/>`;
    s += `<text x="${x}" y="${top - 8}" text-anchor="middle">${hourLabel(20 + hr)}</text>`;
  }
  rows.forEach((n, i) => {
    const y = top + i * (rowH + gap);
    s += `<text x="${l - 8}" y="${y + 12}" text-anchor="end">${esc(`${dow(n.date)} ${dom(n.date)}`)}</text>`;
    const mOf = (t) => n.bedMin + (t - n.start) / 60000;
    const segs = n.stages?.length ? n.stages : [{ s: n.start, e: n.end, t: 'ASLEEP' }];
    for (const g of segs) {
      const st = stageInfo(g.t);
      const x0 = xOfMin(mOf(g.s)); const x1 = xOfMin(mOf(g.e));
      if (x1 - x0 < 0.3) continue;
      const hh = rowH * st.h;
      s += `<rect class="${st.cls}" x="${r1(x0)}" y="${r1(y + rowH - hh)}" width="${r1(x1 - x0)}" height="${r1(hh)}"/>`;
    }
    s += `<text class="c-rule-t" x="${w - r + 6}" y="${y + 12}">${esc(durShort(n.minutes))}</text>`;
  });
  return svg(w, h, label, s);
}

/* ── workout heart rate ─────────────────────────────────────── */

/**
 * Heart rate over clock time. `points` is [[t, bpm], …]; the workout
 * itself (start to end) is shaded, with the average as a dashed rule.
 */
export function hrTrace({ w, h = 170, points, start, end, avg, label }) {
  const pts = (points || []).filter((p) => isNum(p[1]));
  if (pts.length < 2) return '';
  const t0 = pts[0][0]; const t1 = pts[pts.length - 1][0];
  const vals = pts.map((p) => p[1]);
  const [lo, hi] = padRange(Math.min(...vals), Math.max(...vals), 0.1);
  const fr = frame(w, h, 34, 10, 10, 24);
  const xOf = (t) => fr.x0 + ((t - t0) / Math.max(1, t1 - t0)) * fr.iw;
  const yOf = (v) => fr.y1 - ((v - lo) / (hi - lo)) * fr.ih;
  let s = gridY(fr, lo, hi, (v) => String(Math.round(v)));
  if (isNum(start)) {
    const a = xOf(Math.max(t0, start)); const b = xOf(Math.min(t1, isNum(end) ? end : t1));
    if (b > a) s += `<rect class="c-zone" x="${r1(a)}" y="${fr.y0}" width="${r1(b - a)}" height="${fr.ih}"/>`;
  }
  if (isNum(avg) && avg > lo && avg < hi) {
    const y = r1(yOf(avg));
    s += `<line class="c-rule" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>`;
    s += `<text class="c-rule-t" x="${fr.x1}" y="${y - 5}" text-anchor="end">Average ${Math.round(avg)}</text>`;
  }
  let d = ''; let pen = false; let prev = null;
  for (const [t, v] of pts) {
    if (prev !== null && t - prev > 4 * 60_000) pen = false;
    d += `${pen ? 'L' : 'M'}${r1(xOf(t))},${r1(yOf(v))}`;
    pen = true; prev = t;
  }
  s += `<path class="c-line" d="${d}"/>`;
  let peak = pts[0];
  for (const p of pts) if (p[1] > peak[1]) peak = p;
  s += `<circle class="c-dot" cx="${r1(xOf(peak[0]))}" cy="${r1(yOf(peak[1]))}" r="4"/>`;
  const marks = [[t0, 'start'], [t1, 'end']];
  if (t1 - t0 > 20 * 60_000) marks.splice(1, 0, [(t0 + t1) / 2, 'middle']);
  for (const [t, anchor] of marks) s += `<text x="${r1(xOf(t))}" y="${fr.y1 + 16}" text-anchor="${anchor}">${esc(clock(t))}</text>`;
  const step = Math.max(1, Math.floor(pts.length / 60));
  for (let i = 0; i < pts.length; i += step) {
    const [t, v] = pts[i];
    const x0 = xOf(t); const x1 = xOf(pts[Math.min(pts.length - 1, i + step)][0]);
    s += `<rect class="c-hit" data-read="${esc(`${clock(t)}: ${Math.round(v)} bpm`)}" data-cx="${r1(x0)}" data-cy="${r1(yOf(v))}" x="${r1(x0)}" y="${fr.y0}" width="${r1(Math.max(2, x1 - x0))}" height="${fr.ih}"/>`;
  }
  return svg(w, h, label, s);
}

/* ── ring ───────────────────────────────────────────────────── */

/** A progress ring. Past 100% a second, darker lap starts. `inner` is trusted markup. */
export function ring({ value, goal, size = 132, stroke = 12, inner = '', label = '' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = goal > 0 && isNum(value) ? value / goal : 0;
  const lap1 = Math.min(1, Math.max(0, p));
  const lap2 = Math.min(1, Math.max(0, p - 1));
  const circ = (cls, frac) => `<circle class="${cls}" cx="${size / 2}" cy="${size / 2}" r="${r1(r)}" stroke-width="${stroke}" stroke-dasharray="${r1(c)}" stroke-dashoffset="${r1(c * (1 - frac))}"/>`;
  return `<div class="ring" ${label ? `role="img" aria-label="${esc(label)}"` : ''}>
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="ring__track" cx="${size / 2}" cy="${size / 2}" r="${r1(r)}" stroke-width="${stroke}"/>
      ${lap1 > 0 ? circ('ring__val', lap1) : ''}
      ${lap2 > 0 ? circ('ring__over', lap2).replace(`stroke-width="${stroke}"`, `stroke-width="${Math.max(2, stroke / 3)}"`) : ''}
    </svg>
    <div class="ring__in">${inner}</div>
  </div>`;
}

/* ── year heat-map ──────────────────────────────────────────── */

/**
 * A year of days, weeks as columns starting Monday.
 * @param {{days:Array<{date:string, level:number, read?:string}>, label:string}} o  level 0–4
 */
export function heatmap({ days, label, go = null }) {
  if (!days.length) return '';
  const cell = 11; const gap = 3; const top = 16; const left = 26;
  const first = new Date(`${days[0].date}T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const weeks = Math.ceil((days.length + lead) / 7);
  const w = left + weeks * (cell + gap);
  const h = top + 7 * (cell + gap);
  let s = '';
  ['Mon', 'Wed', 'Fri'].forEach((d, i) => { s += `<text x="0" y="${top + (i * 2) * (cell + gap) + 9}">${d}</text>`; });
  let lastMonth = '';
  days.forEach((d, i) => {
    const k = i + lead;
    const col = Math.floor(k / 7); const rowi = k % 7;
    const x = left + col * (cell + gap); const y = top + rowi * (cell + gap);
    const m = monthShort(d.date);
    if (m !== lastMonth && (rowi === 0 || i === 0)) {
      if (col < weeks - 1) s += `<text x="${x}" y="10">${m}</text>`;
      lastMonth = m;
    }
    const lv = Math.max(0, Math.min(4, Math.round(d.level || 0)));
    s += `<rect class="h${lv}" data-read="${esc(d.read || dayMed(d.date))}"${goAttr(go, i)} x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5"/>`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${s}</svg>`;
}

/* ── text alternatives ──────────────────────────────────────── */

/** The same data as a table, folded away under the chart. */
export function tableAlt(headers, rows, { summary = 'Show as a table' } = {}) {
  if (!rows.length) return '';
  const th = headers.map((hd, i) => `<th scope="col"${i ? ' class="n"' : ''}>${esc(hd)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<details class="more"><summary>${icon('right', { size: 's' })}${esc(summary)}</summary><div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table class="data"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div></details>`;
}

/** "Lowest 6,120, highest 14,300, average 9,480." for aria-labels. */
export function describe(values, fmt = (v) => String(Math.round(v)), unit = '') {
  const v = values.filter(isNum);
  if (!v.length) return 'No data.';
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const u = unit ? ` ${unit}` : '';
  return `Lowest ${fmt(Math.min(...v))}${u}, highest ${fmt(Math.max(...v))}${u}, average ${fmt(avg)}${u}, over ${v.length} ${v.length === 1 ? 'day' : 'days'}.`;
}
