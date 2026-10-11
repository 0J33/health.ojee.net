/* The analysis charts: the same hand-drawn SVG language as charts.js, for
   the questions the dashboards ask. "Where am I against my usual?" (spark
   with a band, trend with a rolling average), "when?" (hours, weekdays),
   "how spread?" (histogram, scatter), "against whom?" (paired bars).

   Rules (docs/DESIGN.md, Chart language): the person's own data is the
   accent; a rolling average or another person is ink; a baseline is dashed
   grey; a typical range is a soft band. Colour comes from classes in
   kit.css. Every chart is drawn at the pixel width of its box and carries
   role="img" with a sentence; marks carry data-read for the readout line. */

import { esc } from './ui.js';
import { compact, dayShort, dayMed, dow, monthShort, isNum } from './format.js';

const r1 = (n) => Math.round(n * 10) / 10;
const svg = (w, h, label, body) => `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
const frame = (w, h, l, r, t, b) => ({ x0: l, x1: w - r, y0: t, y1: h - b, iw: w - l - r, ih: h - t - b });
const txt = (x, y, s, { a = 'start', cls = '' } = {}) => `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${a}"${cls ? ` class="${cls}"` : ''}>${esc(s)}</text>`;

export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
  return m * p;
}

function pad(lo, hi, by = 0.12) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { lo -= 1; hi += 1; }
  const s = hi - lo;
  return [lo - s * by, hi + s * by];
}

const leftFor = (ticks) => Math.max(28, Math.max(...ticks.map((t) => String(t).length)) * 6.6 + 10);

function yAxis(fr, lo, hi, tick, n = 2) {
  let s = '';
  for (let i = 0; i <= n; i += 1) {
    const v = lo + ((hi - lo) * i) / n;
    const y = r1(fr.y1 - (fr.ih * i) / n);
    s += `<line class="${i === 0 ? 'c-axis' : 'c-grid'}" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>`;
    s += txt(fr.x0 - 6, y + 4, tick(v), { a: 'end' });
  }
  return s;
}

/** Date labels under a time axis: weekdays for a week, dates for a season, months for a year. */
function xDates(fr, dates, xOf) {
  const n = dates.length;
  if (!n) return '';
  const y = fr.y1 + 16;
  if (n <= 8) return dates.map((d, i) => txt(xOf(i), y, dow(d), { a: 'middle' })).join('');
  if (n > 100) {
    let s = ''; let last = ''; let lastX = -99;
    dates.forEach((d, i) => {
      const m = d.slice(0, 7);
      if (m === last) return;
      last = m;
      const x = xOf(i);
      if (i > 0 && x - lastX > 34 && x < fr.x1 - 14) { s += txt(x, y, monthShort(d), { a: 'middle' }); lastX = x; }
    });
    return s;
  }
  const want = fr.iw < 300 ? 3 : fr.iw < 520 ? 4 : 6;
  let s = '';
  for (let k = 0; k < want; k += 1) {
    const i = Math.round((k * (n - 1)) / (want - 1));
    const a = k === 0 ? 'start' : k === want - 1 ? 'end' : 'middle';
    s += txt(k === 0 ? fr.x0 : k === want - 1 ? fr.x1 : xOf(i), y, dayShort(dates[i]), { a });
  }
  return s;
}

function path(values, xOf, yOf, { connect = false } = {}) {
  let d = ''; let pen = false;
  values.forEach((v, i) => {
    if (!isNum(v)) { if (!connect) pen = false; return; }
    d += `${pen ? 'L' : 'M'}${r1(xOf(i))},${r1(yOf(v))}`;
    pen = true;
  });
  return d;
}

/**
 * The main Trends chart. Daily values as bars (things that add up) or a
 * thin line (states), a rolling average in ink, an optional band (two
 * arrays, or constants), an optional goal rule, the best and worst day
 * marked, and the last value labelled.
 * @param {{w:number,h?:number,dates:string[],values:(number|null)[],kind?:'bars'|'line',avg?:(number|null)[],
 *   band?:{lo:(number|null)[]|number,hi:(number|null)[]|number}, base?:(number|null)[], goal?:number, goalLabel?:string,
 *   fmt?:Function,tick?:Function,unit?:string,label:string,zero?:boolean,extremes?:boolean,lowIsBest?:boolean}} o
 */
export function trend({ w, h = 200, dates, values, kind = 'bars', avg = null, band = null, base = null, goal, goalLabel = 'Goal', fmt = (v) => String(Math.round(v)), tick, unit = '', label, zero, extremes = true, lowIsBest = false }) {
  const n = dates.length;
  const have = values.filter(isNum);
  if (!have.length) return '';
  const bandAt = (k, i) => (band ? (Array.isArray(band[k]) ? band[k][i] : band[k]) : null);
  const extra = [];
  if (band) for (let i = 0; i < n; i += 1) { extra.push(bandAt('lo', i), bandAt('hi', i)); }
  if (base) extra.push(...base);
  if (avg) extra.push(...avg);
  const all = [...have, ...extra.filter(isNum), ...(isNum(goal) ? [goal] : [])];
  const fromZero = zero ?? kind === 'bars';
  let lo; let hi;
  if (fromZero) { lo = 0; hi = niceMax(Math.max(...all) * 1.05); } else { [lo, hi] = pad(Math.min(...all), Math.max(...all)); }
  const fine = hi - lo < 6;
  const tk = tick || (fromZero ? compact : (v) => String(fine ? Math.round(v * 10) / 10 : Math.round(v)));
  const fr = frame(w, h, leftFor([tk(lo), tk((lo + hi) / 2), tk(hi)]), kind === 'bars' ? 4 : 12, 18, 24);
  const slot = fr.iw / Math.max(1, n);
  const asBars = kind === 'bars' && slot >= 2.2;
  const xOf = kind === 'bars' ? (i) => fr.x0 + slot * i + slot / 2 : (i) => fr.x0 + (n <= 1 ? fr.iw / 2 : (fr.iw * i) / (n - 1));
  const yOf = (v) => fr.y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * fr.ih;
  let s = '';

  if (band) {
    if (Array.isArray(band.lo)) {
      let top = ''; let bot = ''; let open = false; let segs = '';
      const flush = () => { if (top) segs += `<path class="c-band" d="M${top.slice(1)}${bot}Z"/>`; top = ''; bot = ''; open = false; };
      for (let i = 0; i < n; i += 1) {
        const a = band.lo[i]; const b = band.hi[i];
        if (!isNum(a) || !isNum(b)) { flush(); continue; }
        top += `L${r1(xOf(i))},${r1(yOf(b))}`;
        bot = `L${r1(xOf(i))},${r1(yOf(a))}${bot}`;
        open = true;
      }
      if (open) flush();
      s += segs;
    } else if (isNum(band.lo) && isNum(band.hi)) {
      s += `<rect class="c-band" x="${fr.x0}" y="${r1(yOf(band.hi))}" width="${fr.iw}" height="${r1(Math.max(1, yOf(band.lo) - yOf(band.hi)))}"/>`;
    }
  }
  s += yAxis(fr, lo, hi, tk) + xDates(fr, dates, xOf);

  if (asBars) {
    const bw = Math.max(1.5, Math.min(26, slot * 0.68));
    values.forEach((v, i) => {
      if (!isNum(v)) return;
      const hh = Math.max(v > 0 ? 2 : 0, fr.y1 - yOf(v));
      const met = isNum(goal) ? v >= goal : true;
      s += `<rect class="c-bar${met ? ' c-bar--met' : ''}" x="${r1(xOf(i) - bw / 2)}" y="${r1(fr.y1 - hh)}" width="${r1(bw)}" height="${r1(hh)}" rx="${r1(Math.min(3, bw / 2, hh / 2))}"/>`;
    });
  } else {
    s += `<path class="${avg ? 'c-thin' : 'c-line'}" d="${path(values, xOf, yOf)}"/>`;
    if (!avg && have.length < 15) values.forEach((v, i) => { if (isNum(v)) s += `<circle class="c-dot--s" cx="${r1(xOf(i))}" cy="${r1(yOf(v))}" r="2.5"/>`; });
  }
  if (base) s += `<path class="c-line c-line--2" d="${path(base, xOf, yOf, { connect: true })}"/>`;
  if (isNum(goal)) {
    const y = r1(yOf(goal));
    s += `<line class="c-rule" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>`;
    s += txt(fr.x1, y - 5, `${goalLabel} ${fmt(goal)}`, { a: 'end', cls: 'c-rule-t' });
  }
  if (avg) s += `<path class="c-avg" d="${path(avg, xOf, yOf, { connect: true })}"/>`;

  // Best and worst day, marked directly.
  if (extremes && have.length >= 7) {
    let iMax = -1; let iMin = -1;
    values.forEach((v, i) => { if (!isNum(v)) return; if (iMax < 0 || v > values[iMax]) iMax = i; if (iMin < 0 || v < values[iMin]) iMin = i; });
    const mark = (i, word, above) => {
      const x = xOf(i); const y = yOf(values[i]);
      const a = x < fr.x0 + 44 ? 'start' : x > fr.x1 - 44 ? 'end' : 'middle';
      return `<circle class="c-pin" cx="${r1(x)}" cy="${r1(y)}" r="3"/>${txt(x, above ? Math.max(11, y - 7) : Math.min(fr.y1 - 3, y + 14), `${word} ${fmt(values[i])}`, { a, cls: 'c-mk' })}`;
    };
    if (iMax >= 0 && iMax !== iMin) s += mark(iMax, lowIsBest ? 'High' : 'Best', true);
    if (iMin >= 0 && iMin !== iMax && !fromZero) s += mark(iMin, lowIsBest ? 'Low' : 'Low', false);
  }

  // The last point of a line, emphasised.
  if (!asBars) {
    const src = avg && avg.some(isNum) ? avg : values;
    let last = -1;
    src.forEach((v, i) => { if (isNum(v)) last = i; });
    if (last >= 0) s += `<circle class="${avg ? 'c-dot c-dot--ink' : 'c-dot'}" cx="${r1(xOf(last))}" cy="${r1(yOf(src[last]))}" r="4"/>`;
  }

  const hitW = kind === 'bars' ? slot : (n <= 1 ? fr.iw : fr.iw / (n - 1));
  dates.forEach((d, i) => {
    const bits = [isNum(values[i]) ? `${fmt(values[i])}${unit ? ` ${unit}` : ''}` : 'no data'];
    if (avg && isNum(avg[i])) bits.push(`7-day average ${fmt(avg[i])}`);
    if (base && isNum(base[i])) bits.push(`usual ${fmt(base[i])}`);
    s += `<rect class="c-hit" data-read="${esc(`${dayMed(d)}: ${bits.join(', ')}`)}" x="${r1(xOf(i) - hitW / 2)}" y="${fr.y0}" width="${r1(Math.max(1, hitW))}" height="${fr.ih}"/>`;
  });
  return svg(w, h, label, s);
}

/**
 * A small line with its band, for a row or a module header: no axes, the
 * last point emphasised. `band` is constants or arrays.
 */
export function spark({ w, h = 44, values, band = null, base = null, label, bars = false, goal }) {
  const have = values.filter(isNum);
  if (have.length < 2) return '';
  const n = values.length;
  const at = (k, i) => (band ? (Array.isArray(band[k]) ? band[k][i] : band[k]) : null);
  const all = [...have];
  if (band) for (let i = 0; i < n; i += 1) all.push(at('lo', i), at('hi', i));
  if (base) all.push(...base);
  if (isNum(goal)) all.push(goal);
  const nums = all.filter(isNum);
  let [lo, hi] = bars ? [0, Math.max(...nums) * 1.05] : pad(Math.min(...nums), Math.max(...nums), 0.14);
  if (hi === lo) hi = lo + 1;
  const fr = frame(w, h, 2, 6, 5, 5);
  const xOf = bars ? (i) => fr.x0 + (fr.iw / n) * (i + 0.5) : (i) => fr.x0 + (fr.iw * i) / Math.max(1, n - 1);
  const yOf = (v) => fr.y1 - ((v - lo) / (hi - lo)) * fr.ih;
  let s = '';
  if (band) {
    let top = ''; let bot = '';
    for (let i = 0; i < n; i += 1) {
      const a = at('lo', i); const b = at('hi', i);
      if (!isNum(a) || !isNum(b)) continue;
      top += `L${r1(xOf(i))},${r1(yOf(b))}`; bot = `L${r1(xOf(i))},${r1(yOf(a))}${bot}`;
    }
    if (top) s += `<path class="c-band" d="M${top.slice(1)}${bot}Z"/>`;
  }
  if (base) s += `<path class="c-line c-line--2" d="${path(base, xOf, yOf, { connect: true })}"/>`;
  if (bars) {
    const bw = Math.max(2, (fr.iw / n) * 0.66);
    values.forEach((v, i) => {
      if (!isNum(v)) return;
      const hh = Math.max(v > 0 ? 1.5 : 0, fr.y1 - yOf(v));
      s += `<rect class="c-bar${!isNum(goal) || v >= goal ? ' c-bar--met' : ''}" x="${r1(xOf(i) - bw / 2)}" y="${r1(fr.y1 - hh)}" width="${r1(bw)}" height="${r1(hh)}" rx="${r1(Math.min(2, hh / 2))}"/>`;
    });
    if (isNum(goal)) s += `<line class="c-rule" x1="${fr.x0}" x2="${fr.x1}" y1="${r1(yOf(goal))}" y2="${r1(yOf(goal))}"/>`;
  } else {
    s += `<path class="c-line c-line--s" d="${path(values, xOf, yOf, { connect: true })}"/>`;
    let last = -1;
    values.forEach((v, i) => { if (isNum(v)) last = i; });
    s += `<circle class="c-dot" cx="${r1(xOf(last))}" cy="${r1(yOf(values[last]))}" r="3.5"/>`;
  }
  return svg(w, h, label, s);
}

/**
 * The day by hour: 24 bars. `values` may hold null for hours that have not
 * happened. `range` draws floating bars from lo to hi instead (heart rate),
 * with a tick at the mean.
 */
export function hours({ w, h = 96, values = null, range = null, label, unit = '', fmt = (v) => String(Math.round(v)), nowHour = null }) {
  const src = range ? range.map((x) => (x && isNum(x.hi) ? x.hi : null)) : values;
  const have = src.filter(isNum);
  if (!have.length) return '';
  let lo = 0; let hi = niceMax(Math.max(...have) * 1.02);
  if (range) { [lo, hi] = pad(Math.min(...range.filter((x) => x && isNum(x.lo)).map((x) => x.lo)), Math.max(...have), 0.08); }
  const tk = range ? (v) => String(Math.round(v)) : compact;
  const fr = frame(w, h, leftFor([tk(lo), tk(hi)]), 2, 6, 20);
  const slot = fr.iw / 24;
  const bw = Math.max(2, Math.min(14, slot * 0.64));
  const yOf = (v) => fr.y1 - ((v - lo) / (hi - lo)) * fr.ih;
  let s = `<line class="c-axis" x1="${fr.x0}" x2="${fr.x1}" y1="${fr.y1}" y2="${fr.y1}"/>`;
  s += `<line class="c-grid" x1="${fr.x0}" x2="${fr.x1}" y1="${fr.y0}" y2="${fr.y0}"/>`;
  s += txt(fr.x0 - 6, fr.y0 + 4, tk(hi), { a: 'end' }) + txt(fr.x0 - 6, fr.y1 + 4, tk(lo), { a: 'end' });
  for (const hr of [0, 6, 12, 18]) s += txt(fr.x0 + slot * hr + slot / 2, fr.y1 + 15, `${String(hr).padStart(2, '0')}:00`, { a: hr === 0 ? 'start' : 'middle' });
  for (let i = 0; i < 24; i += 1) {
    const x = fr.x0 + slot * i + slot / 2;
    const hh = `${String(i).padStart(2, '0')}:00`;
    let read = `${hh}: no data`;
    if (range) {
      const g = range[i];
      if (g && isNum(g.lo) && isNum(g.hi)) {
        const y0 = yOf(g.hi); const y1 = yOf(g.lo);
        s += `<rect class="c-bar c-bar--soft" x="${r1(x - bw / 2)}" y="${r1(y0)}" width="${r1(bw)}" height="${r1(Math.max(2, y1 - y0))}" rx="${r1(Math.min(3, bw / 2))}"/>`;
        if (isNum(g.avg)) s += `<line class="c-tick" x1="${r1(x - bw / 2)}" x2="${r1(x + bw / 2)}" y1="${r1(yOf(g.avg))}" y2="${r1(yOf(g.avg))}"/>`;
        read = `${hh}: ${fmt(g.lo)} to ${fmt(g.hi)}${unit ? ` ${unit}` : ''}${isNum(g.avg) ? `, average ${fmt(g.avg)}` : ''}`;
      }
    } else {
      const v = values[i];
      if (isNum(v)) {
        const bh = Math.max(v > 0 ? 2 : 0, fr.y1 - yOf(v));
        s += `<rect class="c-bar${i === nowHour ? ' c-bar--met' : ' c-bar--met'}" x="${r1(x - bw / 2)}" y="${r1(fr.y1 - bh)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(Math.min(3, bw / 2, bh / 2))}"/>`;
        read = `${hh}: ${fmt(v)}${unit ? ` ${unit}` : ''}`;
      } else if (v === null && nowHour !== null && i > nowHour) read = `${hh}: still to come`;
    }
    s += `<rect class="c-hit" data-read="${esc(read)}" x="${r1(fr.x0 + slot * i)}" y="${fr.y0}" width="${r1(slot)}" height="${fr.ih}"/>`;
  }
  if (nowHour !== null && nowHour < 23) {
    const x = r1(fr.x0 + slot * (nowHour + 1));
    s += `<line class="c-now" x1="${x}" x2="${x}" y1="${fr.y0}" y2="${fr.y1}"/>`;
  }
  return svg(w, h, label, s);
}

/**
 * Categories side by side: one or two series of bars over a few labels
 * (this week against last week by weekday; you against someone by day;
 * a weekday pattern with one series). The first series is the accent, the
 * second ink-grey. `mark` highlights one label (today, the best weekday).
 */
export function cats({ w, h = 132, labels, a, b = null, nameA = '', nameB = '', fmt = (v) => String(Math.round(v)), tick = compact, unit = '', label, goal, reads = null, mark = null, dimA = null }) {
  const all = [...a, ...(b || []), ...(isNum(goal) ? [goal] : [])].filter(isNum);
  if (!all.length) return '';
  const hi = niceMax(Math.max(...all) * 1.04);
  const fr = frame(w, h, leftFor([tick(0), tick(hi)]), 2, isNum(goal) ? 16 : 8, 22);
  const n = labels.length;
  const slot = fr.iw / n;
  const two = Boolean(b);
  const bw = Math.max(2, Math.min(two ? 14 : 26, slot * (two ? 0.34 : 0.62)));
  const yOf = (v) => fr.y1 - (v / hi) * fr.ih;
  let s = yAxis(fr, 0, hi, tick, 1);
  const every = Math.ceil(n / Math.max(1, Math.floor(fr.iw / 34)));
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1 && every === 1) s += txt(fr.x0 + slot * i + slot / 2, fr.y1 + 15, l, { a: 'middle', cls: i === mark ? 'c-on' : '' }); });
  const bar = (v, x, cls) => {
    if (!isNum(v)) return '';
    const hh = Math.max(v > 0 ? 2 : 0, fr.y1 - yOf(v));
    return `<rect class="${cls}" x="${r1(x)}" y="${r1(fr.y1 - hh)}" width="${r1(bw)}" height="${r1(hh)}" rx="${r1(Math.min(3, bw / 2, hh / 2))}"/>`;
  };
  for (let i = 0; i < n; i += 1) {
    const cx = fr.x0 + slot * i + slot / 2;
    const dim = dimA ? dimA[i] : false;
    if (two) {
      s += bar(b[i], cx - bw - 1, 'c-bar c-bar--b');
      s += bar(a[i], cx + 1, `c-bar ${dim ? '' : 'c-bar--met'}`);
    } else s += bar(a[i], cx - bw / 2, `c-bar ${mark === null || mark === i ? 'c-bar--met' : ''}`);
    const read = reads ? reads[i] : `${labels[i]}: ${[isNum(a[i]) ? `${nameA ? `${nameA} ` : ''}${fmt(a[i])}${unit ? ` ${unit}` : ''}` : null, two && isNum(b[i]) ? `${nameB ? `${nameB} ` : ''}${fmt(b[i])}${unit ? ` ${unit}` : ''}` : null].filter(Boolean).join(', ') || 'no data'}`;
    s += `<rect class="c-hit" data-read="${esc(read)}" x="${r1(fr.x0 + slot * i)}" y="${fr.y0}" width="${r1(slot)}" height="${fr.ih}"/>`;
  }
  if (isNum(goal)) {
    const y = r1(yOf(goal));
    s += `<line class="c-rule" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>`;
    s += txt(fr.x1, y - 5, `Goal ${fmt(goal)}`, { a: 'end', cls: 'c-rule-t' });
  }
  return svg(w, h, label, s);
}

/**
 * How the days are spread: a histogram with the median, and optionally one
 * value (today, or the latest) marked.
 * @param {{w:number,h?:number,bins:Array<{lo:number,hi:number,n:number}>,median?:number,mark?:number,markLabel?:string,fmt?:Function,label:string,unit?:string}} o
 */
export function histogram({ w, h = 120, bins, median, mark, markLabel = 'Latest', fmt = (v) => String(Math.round(v)), label, unit = '' }) {
  const list = (bins || []).filter((x) => isNum(x.lo) && isNum(x.hi));
  if (!list.length || !list.some((x) => x.n > 0)) return '';
  const lo = list[0].lo; const hi = list[list.length - 1].hi;
  const top = Math.max(...list.map((x) => x.n));
  const fr = frame(w, h, 4, 4, 20, 22);
  const xOf = (v) => fr.x0 + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * fr.iw;
  let s = `<line class="c-axis" x1="${fr.x0}" x2="${fr.x1}" y1="${fr.y1}" y2="${fr.y1}"/>`;
  for (const g of list) {
    const x0 = xOf(g.lo); const x1 = xOf(g.hi);
    const hh = g.n ? Math.max(2, (g.n / top) * fr.ih) : 0;
    const on = isNum(mark) && mark >= g.lo && (mark < g.hi || g === list[list.length - 1]);
    s += `<rect class="c-bar${on ? ' c-bar--met' : ''}" x="${r1(x0 + 1)}" y="${r1(fr.y1 - hh)}" width="${r1(Math.max(1, x1 - x0 - 2))}" height="${r1(hh)}" rx="2"/>`;
    s += `<rect class="c-hit" data-read="${esc(`${fmt(g.lo)} to ${fmt(g.hi)}${unit ? ` ${unit}` : ''}: ${g.n} ${g.n === 1 ? 'day' : 'days'}`)}" x="${r1(x0)}" y="${fr.y0}" width="${r1(x1 - x0)}" height="${fr.ih}"/>`;
  }
  s += txt(fr.x0, fr.y1 + 15, fmt(lo)) + txt(fr.x1, fr.y1 + 15, fmt(hi), { a: 'end' });
  if (isNum(median)) {
    const x = r1(xOf(median));
    s += `<line class="c-rule" x1="${x}" x2="${x}" y1="${fr.y0 - 4}" y2="${fr.y1}"/>`;
    s += txt(x, fr.y0 - 8, `Median ${fmt(median)}`, { a: x < fr.x0 + 50 ? 'start' : x > fr.x1 - 50 ? 'end' : 'middle', cls: 'c-rule-t' });
  }
  if (isNum(mark) && !(isNum(median) && Math.abs(xOf(mark) - xOf(median)) < 60)) {
    const x = r1(xOf(mark));
    s += txt(x, fr.y1 + 15, `${markLabel} ${fmt(mark)}`, { a: x < fr.x0 + 60 ? 'start' : x > fr.x1 - 60 ? 'end' : 'middle', cls: 'c-on' });
  }
  return svg(w, h, label, s);
}

/**
 * Points on two axes, for a relationship. Deliberately plain: dots, two
 * labelled axes, no fitted line (the sentence beside it says how strong).
 */
export function scatter({ w, h = 200, points, xFmt = (v) => String(Math.round(v)), yFmt = (v) => String(Math.round(v)), xLabel = '', yLabel = '', label }) {
  const pts = (points || []).filter((p) => isNum(p[0]) && isNum(p[1]));
  if (pts.length < 3) return '';
  const [x0, x1] = pad(Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), 0.06);
  const [y0, y1] = pad(Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1])), 0.1);
  const fr = frame(w, h, leftFor([yFmt(y0), yFmt(y1)]), 8, 10, 36);
  const xOf = (v) => fr.x0 + ((v - x0) / (x1 - x0)) * fr.iw;
  const yOf = (v) => fr.y1 - ((v - y0) / (y1 - y0)) * fr.ih;
  let s = yAxis(fr, y0, y1, yFmt);
  for (let i = 0; i <= 2; i += 1) {
    const v = x0 + ((x1 - x0) * i) / 2;
    s += txt(xOf(v), fr.y1 + 15, xFmt(v), { a: i === 0 ? 'start' : i === 2 ? 'end' : 'middle' });
  }
  if (xLabel) s += txt(fr.x0 + fr.iw / 2, h - 3, xLabel, { a: 'middle', cls: 'c-cap' });
  for (const p of pts) s += `<circle class="c-pt" data-read="${esc(`${xLabel ? `${xLabel} ` : ''}${xFmt(p[0])}, ${yLabel ? `${yLabel} ` : ''}${yFmt(p[1])}`)}" cx="${r1(xOf(p[0]))}" cy="${r1(yOf(p[1]))}" r="3.5"/>`;
  return svg(w, h, label, s);
}

/**
 * Sleep regularity: bedtime and wake time of every night on one clock
 * axis (evening at the top), with each one's mean and ± 1 SD band. A tight
 * pair of bands is a regular sleeper.
 * @param {{w:number,h?:number,nights:Array<{date:string,bedMin:number,wakeMin:number}>,bedMean:number,bedSd:number,wakeMean:number,wakeSd:number,label:string}} o
 *   bedMin: minutes after 18:00 on the evening before; wakeMin: minutes after 00:00.
 */
export function regularity({ w, h = 220, nights, bedMean, bedSd, wakeMean, wakeSd, label }) {
  const rows = (nights || []).filter((n) => isNum(n.bedMin) && isNum(n.wakeMin));
  if (rows.length < 3) return '';
  // One axis in minutes after 18:00.
  const bed = (n) => n.bedMin; const wake = (n) => n.wakeMin + 360;
  const lo = Math.floor((Math.min(...rows.map(bed)) - 30) / 60) * 60;
  const hi = Math.ceil((Math.max(...rows.map(wake)) + 30) / 60) * 60;
  const fr = frame(w, h, 46, 8, 8, 24);
  const n = rows.length;
  const xOf = (i) => fr.x0 + (n <= 1 ? fr.iw / 2 : (fr.iw * i) / (n - 1));
  const yOf = (m) => fr.y0 + ((m - lo) / (hi - lo)) * fr.ih;
  const clock = (m) => { const x = (((Math.round(m) + 1080) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  let s = '';
  const step = hi - lo > 720 ? 180 : 120;
  for (let m = lo; m <= hi; m += step) {
    const y = r1(yOf(m));
    s += `<line class="c-grid" x1="${fr.x0}" x2="${fr.x1}" y1="${y}" y2="${y}"/>` + txt(fr.x0 - 6, y + 4, clock(m), { a: 'end' });
  }
  const bandOf = (mean, sd) => (isNum(mean) && isNum(sd) ? `<rect class="c-band" x="${fr.x0}" y="${r1(yOf(mean - sd))}" width="${fr.iw}" height="${r1(Math.max(2, yOf(mean + sd) - yOf(mean - sd)))}"/><line class="c-line c-line--2" x1="${fr.x0}" x2="${fr.x1}" y1="${r1(yOf(mean))}" y2="${r1(yOf(mean))}"/>` : '');
  s += bandOf(bedMean, bedSd) + bandOf(isNum(wakeMean) ? wakeMean + 360 : null, wakeSd);
  s += xDates(fr, rows.map((x) => x.date), xOf);
  const rr = n > 120 ? 1.6 : n > 45 ? 2.2 : 3;
  rows.forEach((x, i) => {
    const cx = r1(xOf(i));
    if (n <= 45) s += `<line class="c-stem" x1="${cx}" x2="${cx}" y1="${r1(yOf(bed(x)))}" y2="${r1(yOf(wake(x)))}"/>`;
    s += `<circle class="c-pt c-pt--ink" cx="${cx}" cy="${r1(yOf(bed(x)))}" r="${rr}"/><circle class="c-pt" cx="${cx}" cy="${r1(yOf(wake(x)))}" r="${rr}"/>`;
    const hw = n <= 1 ? fr.iw : fr.iw / (n - 1);
    s += `<rect class="c-hit" data-read="${esc(`${dayMed(x.date)}: asleep ${clock(bed(x))}, up ${clock(wake(x))}`)}" x="${r1(cx - hw / 2)}" y="${fr.y0}" width="${r1(Math.max(1, hw))}" height="${fr.ih}"/>`;
  });
  return svg(w, h, label, s);
}

/**
 * Stacked bars over a few periods (weeks): heart-rate zones, sleep stages.
 * `series` is bottom-to-top; each has a class from the ramp (k0…k4).
 */
export function stacked({ w, h = 150, labels, series, fmt = (v) => String(Math.round(v)), tick = compact, unit = '', label, line = null, lineName = '' }) {
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, se) => a + (isNum(se.values[i]) ? se.values[i] : 0), 0));
  const top = Math.max(...totals, ...(line ? line.filter(isNum) : []));
  if (!(top > 0)) return '';
  const hi = niceMax(top * 1.04);
  const fr = frame(w, h, leftFor([tick(0), tick(hi)]), 2, 8, 22);
  const slot = fr.iw / n;
  const bw = Math.max(3, Math.min(30, slot * 0.66));
  const yOf = (v) => fr.y1 - (v / hi) * fr.ih;
  let s = yAxis(fr, 0, hi, tick, 2);
  const every = Math.ceil(n / Math.max(1, Math.floor(fr.iw / 44)));
  labels.forEach((l, i) => { if ((n - 1 - i) % every === 0) s += txt(fr.x0 + slot * i + slot / 2, fr.y1 + 15, l, { a: 'middle' }); });
  for (let i = 0; i < n; i += 1) {
    const x = fr.x0 + slot * i + slot / 2 - bw / 2;
    let acc = 0;
    const parts = [];
    for (const se of series) {
      const v = isNum(se.values[i]) ? se.values[i] : 0;
      if (v > 0) {
        const y1 = yOf(acc); const y0 = yOf(acc + v);
        s += `<rect class="${se.cls}" x="${r1(x)}" y="${r1(y0)}" width="${r1(bw)}" height="${r1(Math.max(0.8, y1 - y0 - 0.6))}"/>`;
        parts.push(`${se.label} ${fmt(v)}`);
      }
      acc += v;
    }
    s += `<rect class="c-hit" data-read="${esc(`${labels[i]}: ${parts.length ? `${parts.join(', ')}${unit ? ` ${unit}` : ''}` : 'nothing'}${line && isNum(line[i]) ? `, ${lineName} ${fmt(line[i])}` : ''}`)}" x="${r1(fr.x0 + slot * i)}" y="${fr.y0}" width="${r1(slot)}" height="${fr.ih}"/>`;
  }
  if (line) s += `<path class="c-avg" d="${path(line, (i) => fr.x0 + slot * i + slot / 2, yOf, { connect: true })}"/>`;
  return svg(w, h, label, s);
}

/**
 * Two lines over the same days: you (accent) and someone else (ink).
 */
export function duel({ w, h = 170, labels, a, b, nameA, nameB, fmt = (v) => String(Math.round(v)), tick = compact, unit = '', label, cumulative = false }) {
  const acc = (arr) => { if (!cumulative) return arr; let t = 0; let seen = false; return arr.map((v) => { if (isNum(v)) { t += v; seen = true; } return seen && v !== undefined ? (isNum(v) ? t : null) : null; }); };
  const A = acc(a); const B = acc(b);
  const all = [...A, ...B].filter(isNum);
  if (all.length < 2) return '';
  const hi = niceMax(Math.max(...all) * 1.05);
  const fr = frame(w, h, leftFor([tick(0), tick(hi)]), 12, 10, 22);
  const n = labels.length;
  const xOf = (i) => fr.x0 + (n <= 1 ? fr.iw / 2 : (fr.iw * i) / (n - 1));
  const yOf = (v) => fr.y1 - (v / hi) * fr.ih;
  let s = yAxis(fr, 0, hi, tick, 2);
  const every = Math.ceil(n / Math.max(1, Math.floor(fr.iw / 40)));
  labels.forEach((l, i) => { if (i % every === 0) s += txt(xOf(i), fr.y1 + 15, l, { a: i === 0 ? 'start' : 'middle' }); });
  s += `<path class="c-avg" d="${path(B, xOf, yOf)}"/><path class="c-line" d="${path(A, xOf, yOf)}"/>`;
  const end = (arr, cls) => { let last = -1; arr.forEach((v, i) => { if (isNum(v)) last = i; }); return last < 0 ? '' : `<circle class="${cls}" cx="${r1(xOf(last))}" cy="${r1(yOf(arr[last]))}" r="4"/>`; };
  s += end(B, 'c-dot c-dot--ink') + end(A, 'c-dot');
  const hw = n <= 1 ? fr.iw : fr.iw / (n - 1);
  labels.forEach((l, i) => {
    const bits = [isNum(A[i]) ? `${nameA} ${fmt(A[i])}` : null, isNum(B[i]) ? `${nameB} ${fmt(B[i])}` : null].filter(Boolean);
    s += `<rect class="c-hit" data-read="${esc(`${l}: ${bits.length ? `${bits.join(', ')}${unit ? ` ${unit}` : ''}` : 'no data'}`)}" x="${r1(xOf(i) - hw / 2)}" y="${fr.y0}" width="${r1(Math.max(1, hw))}" height="${fr.ih}"/>`;
  });
  return svg(w, h, label, s);
}

/** A heart-rate trace reduced to a few dozen points, for a list row. No axes. */
export function trace({ w, h = 36, values, label }) {
  const have = (values || []).filter(isNum);
  if (have.length < 3) return '';
  const [lo, hi] = pad(Math.min(...have), Math.max(...have), 0.1);
  const n = values.length;
  const xOf = (i) => 1 + ((w - 2) * i) / (n - 1);
  const yOf = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const d = path(values, xOf, yOf, { connect: true });
  return svg(w, h, label, `<path class="c-area" d="${d}L${r1(xOf(n - 1))},${h}L${r1(xOf(0))},${h}Z"/><path class="c-line c-line--s" d="${d}"/>`);
}
