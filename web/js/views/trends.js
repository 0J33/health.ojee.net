/* Trends: analysis. Overview, Sleep, Activity, Heart and Body over 7, 30
   or 90 days, 6 months or a year. Every metric is a module in its family's
   colour: the period average against the period before, the chart (daily
   marks, the 7-day average, the goal or the person's own band, best and
   worst marked), the working-out as facts, and two small multiples
   (weekday pattern, distribution). A metric the device does not report is
   left out, and what is missing is said once at the foot.

   Data: /api/trends?days= (docs/API.md). The range lives in the URL as
   ?range= and is remembered for the session. */

import { api } from '../api.js';
import { app, cap, capText, listen, go } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, chart, on, seg, sheet, field, formValues, fieldError, busy, toast, banner, errText, esc } from '../ui.js';
import { line as lineChart, sleepTimeline, heatmap, tableAlt, describe } from '../charts.js';
import { trend, spark, cats, histogram, scatter, regularity } from '../viz.js';
import { mod, grid, stat, delta, split, facts, tabsub, tooFew, missingNote, legend, figure, ib, rings, meter } from '../kit.js';
import * as f from '../format.js';
import { connectionBanner, sectionTabs } from './shared.js';
import { metricRow } from '../metrics.js';
import { addEntry, bindPins } from '../entry.js';
import { turnOnGroup } from '../groups.js';
import { CAT_FAM, CAT_LABEL, emptyList } from './browse.js';

const TABS = [['overview', 'Overview'], ['sleep', 'Sleep'], ['activity', 'Activity'], ['heart', 'Heart'], ['body', 'Body']];
/* Categories with no analysis view: their page is the category's metrics (Health's tiles open these). */
const LIST_CATS = ['vitals', 'nutrition', 'mindfulness', 'cycle', 'other'];
/* The Browse category whose metrics close each analysis page. */
const TAB_CAT = { sleep: 'sleep', activity: 'activity', heart: 'heart', body: 'body' };
const RANGES = [[7, '7 d'], [30, '30 d'], [90, '90 d'], [180, '6 m'], [365, '1 y']];
const RANGE_Q = { 7: '7d', 30: '30d', 90: '90d', 180: '6m', 365: '1y' };
const Q_RANGE = Object.fromEntries(Object.entries(RANGE_Q).map(([d, q]) => [q, Number(d)]));
const RANGE_KEY = 'health.trends.range';
const PREV = { 7: 'the 7 days before', 30: 'the 30 days before', 90: 'the 90 days before', 180: 'the 6 months before', 365: 'the year before' };
const SPAN = { 7: 'the last 7 days', 30: 'the last 30 days', 90: 'the last 90 days', 180: 'the last 6 months', 365: 'the last year' };
const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const WDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const N = f.isNum;
const count = (vals) => vals.filter(N).length;
const sum = (vals) => vals.filter(N).reduce((a, b) => a + b, 0);
const lastOf = (vals) => { for (let i = vals.length - 1; i >= 0; i -= 1) if (N(vals[i])) return vals[i]; return null; };
const same = (x) => x;
const signed1 = (v) => `${v > 0.049 ? '+' : v < -0.049 ? '−' : ''}${f.dec1(Math.abs(v))}`;
const tempK = () => (f.getPrefs().temp === 'f' ? 1.8 : 1);
const tick1 = (v) => String(Math.round(v * 10) / 10);

/* ── the metrics ────────────────────────────────────────────── */

/* fmt: one day's value. fa: an average. short: the same in a tight place
   (axis ticks, chart marks). conv: API unit → the person's unit. good: the
   better direction, or null when there is none. pct: the change against
   the period before is said as a percentage (things that add up) rather
   than in the metric's own unit (states). */
const M = {
  steps: { tab: 'activity', fam: 'steps', icon: 'steps', name: 'Steps', per: 'a day', unit: 'steps', fmt: f.int, good: 'up', kind: 'bars', avgKey: 'stepsAvg7', pct: true, total: true, tick: f.compact },
  activeMinutes: { tab: 'activity', fam: 'active', icon: 'bolt', name: 'Active minutes', per: 'a day', unit: 'min', fmt: f.int, good: 'up', kind: 'bars', avgKey: 'activeAvg7', pct: true },
  distanceM: { tab: 'activity', fam: 'steps', icon: 'distance', name: 'Distance', per: 'a day', unit: () => f.distUnit(), conv: f.distVal, fmt: (v) => f.dec(v, 1), good: 'up', kind: 'bars', pct: true, total: true, tick: tick1 },
  kcal: { tab: 'activity', fam: 'energy', icon: 'flame', name: 'Calories burned', per: 'a day', unit: 'kcal', fmt: f.int, good: null, kind: 'bars', pct: true, note: 'Resting and active together' },
  sleepMin: { tab: 'sleep', fam: 'sleep', icon: 'moon', name: 'Time asleep', per: 'a night', unit: '', fmt: f.dur, short: f.durShort, good: 'up', kind: 'bars', avgKey: 'sleepAvg7', dunit: 'min', day: 'night', tick: f.durShort },
  rhr: { tab: 'heart', fam: 'heart', icon: 'resting', name: 'Resting heart rate', unit: 'bpm', fmt: f.int, good: 'down', kind: 'line', avgKey: 'rhrAvg7', base: ['rhrBase', 'rhrSd'], digits: 1, note: 'Lower is generally a sign of being better rested.' },
  hrv: { tab: 'heart', fam: 'recovery', icon: 'wave', name: 'Heart rate variability', unit: 'ms', fmt: f.int, good: 'up', kind: 'line', avgKey: 'hrvAvg7', base: ['hrvBase', 'hrvSd'], digits: 1, day: 'night', note: 'Read against your own baseline; it differs a lot between people.' },
  spo2: { tab: 'heart', fam: 'recovery', icon: 'spo2', name: 'Blood oxygen', unit: '%', fmt: f.dec1, good: null, kind: 'line', lohi: ['spo2Lo', 'spo2Hi'], digits: 1, day: 'night', note: 'Average while asleep; the band is each night’s range.', tick: tick1 },
  tempDev: { tab: 'heart', fam: 'energy', icon: 'temp', name: 'Skin temperature', unit: () => f.tempUnit(), conv: (v) => v * tempK(), fmt: signed1, good: null, kind: 'line', sd: 'tempSd', digits: 1, day: 'night', note: 'Difference from your own usual, at night.', tick: tick1 },
  bodyFat: { tab: 'body', fam: 'body', icon: 'bodyfat', name: 'Body fat', unit: '%', fmt: f.dec1, good: null, kind: 'line', sparse: true, digits: 1, day: 'reading', tick: tick1 },
};
const ORDER = ['steps', 'activeMinutes', 'distanceM', 'kcal', 'sleepMin', 'rhr', 'hrv', 'spo2', 'tempDev', 'bodyFat'];
const unitOf = (m) => (typeof m.unit === 'function' ? m.unit() : m.unit);
const cvOf = (m) => m.conv || same;
const withUnit = (m, s) => (unitOf(m) && unitOf(m) !== '%' ? `${s} ${unitOf(m)}` : `${s}${unitOf(m)}`);
const has = (t, key) => Boolean(t.analysis?.[key]?.n);

const col = (rows, key, cv = same) => rows.map((r) => (N(r[key]) ? cv(r[key]) : null));

/** Trailing 7-day mean, for the metrics the server does not smooth. */
function roll7(vals) {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - 6), i + 1).filter(N);
    return w.length >= 4 ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

/** Monday weeks as averages per day, for bars too thin to draw daily. */
function weekly(dates, vals, skip = '') {
  if (!dates.length) return { dates: [], values: [] };
  const map = new Map();
  dates.forEach((d, i) => {
    if (!N(vals[i]) || d === skip) return;
    const w = f.weekStart(d);
    const e = map.get(w) || { s: 0, n: 0 };
    e.s += vals[i]; e.n += 1;
    map.set(w, e);
  });
  const out = { dates: [], values: [] };
  const end = f.weekStart(dates[dates.length - 1]);
  for (let w = f.weekStart(dates[0]); w <= end; w = f.addDays(w, 7)) {
    const e = map.get(w);
    out.dates.push(w); out.values.push(e ? e.s / e.n : null);
  }
  return out;
}

function longestRun(vals, goal) {
  let best = 0; let run = 0;
  for (const v of vals) { if (N(v) && v >= goal) { run += 1; best = Math.max(best, run); } else run = 0; }
  return best;
}

/** The change against the period before, as a chip and a few words. */
function versusPrev(m, a, days, brief = false) {
  if (!N(a.prevAvg)) return html`<span class="muted">Nothing earlier to compare with yet</span>`;
  const cv = cvOf(m);
  const chip = m.pct && N(a.deltaPct)
    ? delta({ pct: a.deltaPct, good: m.good })
    : delta({ abs: cv(a.delta), unit: m.dunit || unitOf(m), good: m.good, digits: m.dunit ? 0 : (m.digits || 0) });
  const fa = m.fa || m.fmt;
  return brief ? html`${chip}<span>from ${fa(cv(a.prevAvg))}</span>` : html`${chip}<span>against ${PREV[days] || 'the period before'} (${fa(cv(a.prevAvg))})</span>`;
}

/** Weekday means of a state as dots around the period mean (bars from zero would all look alike). */
function dotcats({ w, h = 120, labels, values, mark = null, fmt, mean = null, label, reads }) {
  const have = values.filter(N);
  if (!have.length) return '';
  let lo = Math.min(...have, N(mean) ? mean : Infinity); let hi = Math.max(...have, N(mean) ? mean : -Infinity);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const p = (hi - lo) * 0.3; lo -= p; hi += p;
  const left = Math.max(28, Math.max(String(fmt(lo)).length, String(fmt(hi)).length) * 6.6 + 10);
  const x0 = left; const x1 = w - 2; const y0 = 8; const y1 = h - 22;
  const slot = (x1 - x0) / labels.length;
  const yOf = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
  const r = (n) => Math.round(n * 10) / 10;
  let s = `<line class="c-axis" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/><line class="c-grid" x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}"/>`;
  s += `<text x="${x0 - 6}" y="${y0 + 4}" text-anchor="end">${esc(fmt(hi))}</text><text x="${x0 - 6}" y="${y1 + 4}" text-anchor="end">${esc(fmt(lo))}</text>`;
  if (N(mean)) s += `<line class="c-rule" x1="${x0}" x2="${x1}" y1="${r(yOf(mean))}" y2="${r(yOf(mean))}"/>`;
  labels.forEach((l, i) => {
    const cx = r(x0 + slot * i + slot / 2);
    s += `<text x="${cx}" y="${y1 + 15}" text-anchor="middle"${i === mark ? ' class="c-on"' : ''}>${esc(l)}</text>`;
    if (N(values[i])) {
      if (N(mean)) s += `<line class="c-stem" x1="${cx}" x2="${cx}" y1="${r(yOf(mean))}" y2="${r(yOf(values[i]))}"/>`;
      s += i === mark
        ? `<circle class="c-dot--s" cx="${cx}" cy="${r(yOf(values[i]))}" r="5.5"/>`
        : `<circle class="c-pt" cx="${cx}" cy="${r(yOf(values[i]))}" r="4.5"/>`;
    }
    s += `<rect class="c-hit" data-read="${esc(reads[i])}" x="${r(x0 + slot * i)}" y="${y0}" width="${r(slot)}" height="${y1 - y0}"/>`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${s}</svg>`;
}

/* ── one metric ─────────────────────────────────────────────── */

/**
 * Everything a metric module shows, as separate pieces so the wide and the
 * compact layout can arrange them: headline, main figure, facts, weekday
 * pattern, distribution.
 */
function pieces(t, key, opts = {}) {
  const extraFacts = opts.extraFacts || [];
  const m = M[key]; const a = t.analysis?.[key];
  if (!a?.n) return null;
  const cv = cvOf(m); const u = unitOf(m); const days = t.days;
  const short = m.short || m.fmt; const fa = m.fa || m.fmt;
  const tick = m.tick || undefined;
  const dayWord = m.day || 'day';
  const dates = t.series.map((r) => r.date);
  const vals = col(t.series, key, cv);
  const activity = m.tab === 'activity';
  const bars = m.kind === 'bars';
  const need = days <= 7 ? 3 : 7;

  const headline = stat({
    size: 'l', value: fa(cv(a.avg)), unit: [u, m.per || (bars ? '' : 'on average')].filter(Boolean).join(' '),
    context: versusPrev(m, a, days),
  });

  // The main chart: daily marks, or weekly averages when a bar would be a hairline.
  const byWeek = bars && dates.length > 100;
  const wk = byWeek ? weekly(dates, vals, activity ? t.today : '') : null;
  const cd = wk ? wk.dates : dates; const cvs = wk ? wk.values : vals;
  let avg = null; let band = null;
  if (!wk && !m.sparse) {
    avg = m.avgKey ? col(t.series, m.avgKey, cv) : roll7(vals);
    if (count(avg) < 2 || a.n < 8) avg = null;
  }
  if (m.base) {
    const [b, sd] = m.base;
    band = { lo: t.series.map((r) => (N(r[b]) && N(r[sd]) ? r[b] - 1.5 * r[sd] : null)), hi: t.series.map((r) => (N(r[b]) && N(r[sd]) ? r[b] + 1.5 * r[sd] : null)) };
  } else if (m.lohi) {
    band = { lo: col(t.series, m.lohi[0], cv), hi: col(t.series, m.lohi[1], cv) };
  } else if (m.sd) {
    band = { lo: t.series.map((r) => (N(r[m.sd]) ? -cv(r[m.sd]) : null)), hi: t.series.map((r) => (N(r[m.sd]) ? cv(r[m.sd]) : null)) };
  }
  if (band && !band.lo.some(N)) band = null;
  const goal = N(a.goal) ? cv(a.goal) : undefined;
  const hiLabel = m.good === 'up' ? 'Best' : 'Highest';
  const ex = a.max && a.min && a.n >= 3
    ? `${hiLabel}${bars && dates.length > 100 ? ' day' : ''} ${withUnit(m, short(cv(a.max.value)))} on ${f.dayMed(a.max.date)} · lowest ${withUnit(m, short(cv(a.min.value)))} on ${f.dayMed(a.min.date)}`
    : '';
  const lbl = `${m.name} ${wk ? 'as weekly averages' : `per ${dayWord}`} over ${SPAN[days] || 'this range'}. ${describe(vals, short, u)}`;
  const lg = bars
    ? [['sw-met', goal !== undefined ? (wk ? 'Week at goal' : 'At goal') : (wk ? 'Each week' : `Each ${dayWord}`)], goal !== undefined ? ['sw-under', 'Under goal'] : null, avg ? ['sw-inkline', '7-day average'] : null].filter(Boolean)
    : [['sw-under', `Each ${dayWord}`], avg ? ['sw-inkline', '7-day average'] : null, band ? ['sw-band', m.base ? 'Your usual range' : m.lohi ? 'Nightly range' : 'Normal wobble'] : null].filter(Boolean);
  const table = tableAlt(
    [wk ? 'Week from' : dayWord === 'night' ? 'Night' : 'Day', `${m.name}${u ? ` (${u})` : ''}`, ...(avg ? ['7-day average'] : [])],
    cd.map((d, i) => [wk ? f.dayShort(d) : f.dayMed(d), N(cvs[i]) ? short(cvs[i]) : f.DASH, ...(avg ? [N(avg[i]) ? short(avg[i]) : f.DASH] : [])]).reverse(),
  );
  const main = a.n < (m.sparse ? 2 : need)
    ? tooFew(a.n, m.sparse ? 2 : need, `${dayWord}s`)
    : m.sparse ? figure(chart((w) => lineChart({
      w, h: w > 620 ? 240 : 196, dates, series: [{ values: vals, label: m.name, dots: true, connect: true }], fmt: short, tick, unit: u, label: lbl,
    })), { read: ex, table }) : figure(chart((w) => trend({
      w, h: w > 620 ? 280 : w > 420 ? 220 : 196, dates: cd, values: cvs, kind: m.kind, avg, band, goal,
      fmt: short, tick, unit: wk ? `${u ? `${u} ` : ''}a day that week` : u, label: lbl, lowIsBest: m.good !== 'up',
    })), { read: `${wk ? 'Weekly averages. ' : ''}${ex}`, legendItems: lg, table });

  const list = facts([
    { k: 'Median', v: fa(cv(a.median)), u },
    N(a.p25) && N(a.p75) ? { k: 'Typical range', v: `${short(cv(a.p25))}–${short(cv(a.p75))}`, u, s: `The middle half of ${dayWord}s` } : null,
    a.max ? { k: hiLabel, v: short(cv(a.max.value)), u, s: f.dayMed(a.max.date) } : null,
    a.min ? { k: 'Lowest', v: short(cv(a.min.value)), u, s: f.dayMed(a.min.date) } : null,
    N(a.goal) && N(a.goalDays) ? { k: 'At goal', v: `${f.int(a.goalDays)} of ${f.int(a.n)}`, u: `${dayWord}s`, s: `${Math.round((a.goalRate || 0) * 100)}% · goal ${m.fmt(goal)}` } : null,
    N(a.outOfBand) ? { k: 'Outside your usual range', v: `${f.int(a.outOfBand)} of ${f.int(a.n)}`, u: `${dayWord}s`, s: 'More than 1.5 SD from that day’s baseline' } : null,
    m.total ? { k: 'Total', v: m.fmt(sum(activity ? vals.filter((_, i) => dates[i] !== t.today) : vals)), u } : null,
    ...extraFacts,
  ], { cols: opts.cols || 2, cls: 'facts--s' });

  // Small multiples need at least two of each weekday.
  let weekday = ''; let spread = '';
  if (a.n >= 14 && !m.sparse) {
    const wv = (a.weekday || []).map((x) => (N(x.avg) ? cv(x.avg) : null));
    if (count(wv) >= 5) {
      let best = -1;
      wv.forEach((v, i) => { if (N(v) && (best < 0 || (m.good === 'down' ? v < wv[best] : v > wv[best]))) best = i; });
      const reads = wv.map((v, i) => `${WDAY[i]}s: ${N(v) ? withUnit(m, short(v)) : 'no data'}${a.weekday[i]?.n ? ` on average over ${f.plural(a.weekday[i].n, dayWord)}` : ''}`);
      const wl = `${m.name} by weekday, on average. ${reads.join('. ')}.`;
      const slot = bars
        ? chart((w) => cats({ w, h: 118, labels: WD, a: wv, mark: best, fmt: short, tick: tick || f.compact, unit: u, reads, label: wl }))
        : chart((w) => dotcats({ w, h: 118, labels: WD, values: wv, mark: best, fmt: short, mean: cv(a.avg), reads, label: wl }));
      weekday = html`<div class="part"><p class="sub">By weekday</p>${figure(slot, { read: html`${m.good === 'down' ? 'Lowest' : 'Highest'} on <b>${WDAY[best]}s</b>, ${withUnit(m, short(wv[best]))}` })}</div>`;
    }
    const bins = (a.histogram || []).map((b) => ({ lo: cv(b.lo), hi: cv(b.hi), n: b.n }));
    if (bins.length >= 3) {
      const latest = lastOf(activity ? vals.filter((_, i) => dates[i] !== t.today) : vals);
      spread = html`<div class="part"><p class="sub">How the ${dayWord}s spread</p>${figure(chart((w) => histogram({
        w, h: 118, bins, median: cv(a.median), mark: latest, fmt: short, unit: u,
        label: `How ${f.int(a.n)} ${dayWord}s of ${m.name.toLowerCase()} are spread. Median ${short(cv(a.median))}${u ? ` ${u}` : ''}; half fall between ${short(cv(a.p25))} and ${short(cv(a.p75))}.`,
      })), { read: `Half of your ${dayWord}s fall between ${short(cv(a.p25))} and ${short(cv(a.p75))}` })}</div>`;
    }
  }
  const tooShort = !m.sparse && a.n < 14 && a.n >= need ? html`<p class="tr-quiet">Weekday pattern and spread appear with 14 ${dayWord}s. Choose a longer range.</p>` : '';
  return { m, a, headline, main, list, weekday, spread, tooShort };
}

/** A headline metric: the chart wide, its working-out beside it on desktop. */
function wideMetric(t, key, opts = {}) {
  const p = pieces(t, key, opts);
  if (!p) return '';
  const { m } = p;
  return mod({
    title: opts.title || m.name, note: opts.note ?? m.note ?? '', fam: m.fam, icon: m.icon, span: 12, tools: opts.tools || '',
    body: html`<div class="tr-cols">
      <div class="tr-main">${p.headline}${p.main}</div>
      <div class="tr-side">${p.list}${p.weekday}${p.spread}${p.tooShort}${opts.side || ''}</div>
    </div>`,
  });
}

/** A secondary metric: the same pieces in a half-width module. */
function compactMetric(t, key, { span = 6 } = {}) {
  const p = pieces(t, key, { cols: 3 });
  if (!p) return '';
  const { m } = p;
  const small = p.weekday || p.spread ? html`<hr class="rule"><div class="split2">${p.weekday}${p.spread}</div>` : '';   // the wide module above says why, once
  return mod({
    title: m.name, note: m.note || '', fam: m.fam, icon: m.icon, span,
    body: html`${p.headline}${p.main}<hr class="rule">${p.list}${small}`,
  });
}

/* ── relationships ──────────────────────────────────────────── */

const REL_FAM = { sleep_hrv: 'recovery', sleep_next_steps: 'steps', steps_sleep: 'sleep' };
const unitFmt = (u) => (u === 'min' ? f.durShort : u === 'steps' ? f.compact : (v) => f.int(v));

function relation(r) {
  const xf = unitFmt(r.xUnit); const yf = unitFmt(r.yUnit);
  const fig = r.enough && (r.points || []).length >= 3
    ? figure(chart((w) => scatter({
      w, h: 168, points: r.points, xFmt: xf, yFmt: yf,
      xLabel: `${r.xLabel}${r.xUnit === 'min' ? ' (h:min)' : ''}`, yLabel: r.yLabel,
      label: `${r.xLabel} against ${r.yLabel.toLowerCase()}, ${f.int(r.n)} days. ${r.text}`,
    })), { read: `${f.int(r.n)} days, one dot each` })
    : tooFew(r.n || 0, 14, 'days with both');
  return html`<div class="part tr-rel fam fam-${REL_FAM[r.id] || 'recovery'}">
    <p class="sub">${r.xLabel} and ${r.yLabel.toLowerCase()}</p>
    ${fig}
    <p class="tr-rel__t">${r.text}</p>
  </div>`;
}

/* ── tables by week and month ───────────────────────────────── */

function periodTable(rows, kind) {
  const defs = kind === 'month'
    ? [['Steps a day', 'stepsAvg', f.int], ['Active min a day', 'activeMinutesAvg', f.int], ['Sleep', 'sleepAvgMin', f.dur], ['Resting HR', 'rhrAvg', f.dec1], ['HRV', 'hrvAvg', f.int], ['Workouts', 'workouts', f.int], [`Weight (${f.weightUnit()})`, 'weightKg', f.weightNum]]
    : [['Steps a day', 'stepsAvg', f.int], ['Distance', 'distanceM', f.dist], ['Active min', 'activeMinutes', f.int], ['Sleep', 'sleepAvgMin', f.dur], ['Resting HR', 'rhrAvg', f.dec1], ['HRV', 'hrvAvg', f.int], ['Workouts', 'workouts', f.int]];
  const used = defs.filter(([, k]) => rows.some((r) => N(r[k]) && (k !== 'workouts' || r[k] > 0)));
  if (!used.length) return '';
  const best = Object.fromEntries(used.map(([, k]) => [k, Math.max(...rows.map((r) => (N(r[k]) ? r[k] : -Infinity)))]));
  const name = (r) => (kind === 'month' ? html`${f.monthYear(r.month)}${r.days < 26 ? html` <span class="muted">· ${f.plural(r.days, 'day')}</span>` : ''}` : f.weekLabel(r.week));
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table class="data tr-table">
    <thead><tr><th scope="col">${kind === 'month' ? 'Month' : 'Week'}</th>${used.map(([h]) => html`<th scope="col" class="n">${h}</th>`)}</tr></thead>
    <tbody>${rows.slice().reverse().map((r) => html`<tr><td class="nw">${name(r)}</td>${used.map(([, k, fmt]) => html`<td class="n ${k === 'stepsAvg' && rows.length > 2 && r[k] === best[k] ? 'is-top' : ''}">${N(r[k]) ? fmt(r[k]) : f.DASH}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

function periods(t, { span = 12 } = {}) {
  const months = (t.months || []).filter((x) => x.days > 0);
  const weeks = (t.weeks || []).filter((x) => x.days > 0);
  if (t.days > 90 && months.length >= 3) {
    const body = periodTable(months, 'month');
    return body ? mod({ title: 'Month by month', icon: 'calendar', span, note: 'Averages per day; the highest step month is in bold. Part months count only their days in range.', body }) : '';
  }
  if (weeks.length < 2) return '';
  const body = periodTable(weeks.slice(-13), 'week');
  return body ? mod({ title: 'Week by week', icon: 'week', span, note: 'Monday to Sunday; the highest step week is in bold.', body }) : '';
}

/* ── goals, streaks and best days (Activity, and Overview without a watch) ── */

function goalsModule(t, { span = 6 } = {}) {
  const st = t.analysis?.steps; const am = t.analysis?.activeMinutes;
  if (!st?.n) return '';
  const list = [];
  if (N(st.goal)) list.push({ fam: 'steps', icon: 'steps', label: 'Step goal', value: st.goalDays, goal: st.n, a: st });
  if (am?.n && N(am.goal)) list.push({ fam: 'active', icon: 'bolt', label: 'Active minutes goal', value: am.goalDays, goal: am.n, a: am });
  const past = t.series.filter((r) => r.date !== t.today);
  const steps = past.map((r) => r.steps);
  const cur = t.activity?.streak?.steps;
  const run = N(st.goal) ? longestRun(steps, st.goal) : 0;
  const top = past.filter((r) => N(r.steps)).sort((x, y) => y.steps - x.steps).slice(0, 5);
  const curA = t.activity?.streak?.azm;
  const ringBlock = list.length ? html`<div class="ringrow">
    ${rings(list, { size: list.length > 1 ? 124 : 108, stroke: 14 })}
    <ul class="ringkey">${list.map((r) => html`<li class="ringkey__i fam fam-${r.fam}">${ib(r.icon)}<span class="ringkey__k">${r.label}</span><span class="ringkey__v">${Math.round((r.a.goalRate || 0) * 100)}%<small>${f.int(r.value)} of ${f.plural(r.goal, 'day')}</small></span></li>`)}</ul>
  </div>` : '';
  const fl = facts([
    N(cur) ? { k: 'Step streak now', v: f.int(cur), u: cur === 1 ? 'day' : 'days', s: cur > 0 ? 'In a row at your goal' : 'Reach your goal today to start one' } : null,
    am?.n && N(curA) ? { k: 'Active minutes streak now', v: f.int(curA), u: curA === 1 ? 'day' : 'days', s: 'In a row at your goal' } : null,
    run > 0 ? { k: 'Longest run in this range', v: f.int(run), u: run === 1 ? 'day' : 'days', s: `At ${f.int(st.goal)} steps or more` } : null,
  ], { cols: 3, cls: 'facts--s' });
  const bestList = top.length >= 3 ? html`<div class="part"><p class="sub">Best days</p><ol class="tr-best">${top.map((r, i) => html`<li><span class="tr-best__n">${i + 1}</span><span class="tr-best__d">${f.dayLong(r.date)}</span><span class="tr-best__v">${f.int(r.steps)}<small>${N(st.goal) && st.goal > 0 ? `${Math.round((r.steps / st.goal) * 100)}% of goal` : 'steps'}</small></span></li>`)}</ol></div>` : '';
  if (!ringBlock && !fl && !bestList) return '';
  return mod({
    title: 'Goals and best days', icon: 'target', fam: 'steps', span, note: `Over ${SPAN[t.days] || 'this range'}, today left out`,
    body: html`${ringBlock}${fl ? html`${ringBlock ? html`<hr class="rule">` : ''}${fl}` : ''}${bestList ? html`<hr class="rule">${bestList}` : ''}`,
  });
}

/* ── overview ───────────────────────────────────────────────── */

function overviewRow(t, key, q) {
  const m = M[key]; const a = t.analysis[key];
  const cv = cvOf(m); const u = unitOf(m);
  const fa = m.fa || m.fmt;
  const dates = t.series.map((r) => r.date);
  const vals = col(t.series, key, cv);
  const bars = m.kind === 'bars';
  let slot = '';
  if (a.n >= 4) {
    const sl = `${m.name} over ${SPAN[t.days] || 'this range'}. ${describe(vals, m.short || m.fmt, u)}`;
    if (bars) {
      const v = t.days > 30 ? weekly(dates, vals, m.tab === 'activity' ? t.today : '').values : vals;
      slot = chart((w) => spark({ w, h: 40, values: v, bars: true, goal: N(a.goal) ? cv(a.goal) : undefined, label: sl }));
    } else {
      const smooth = t.days > 90 ? (m.avgKey ? col(t.series, m.avgKey, cv) : roll7(vals)) : vals;
      let band = null;
      if (m.base) band = { lo: t.series.map((r) => (N(r[m.base[0]]) && N(r[m.base[1]]) ? r[m.base[0]] - r[m.base[1]] : null)), hi: t.series.map((r) => (N(r[m.base[0]]) && N(r[m.base[1]]) ? r[m.base[0]] + r[m.base[1]] : null)) };
      else if (m.sd) band = { lo: t.series.map((r) => (N(r[m.sd]) ? -cv(r[m.sd]) : null)), hi: t.series.map((r) => (N(r[m.sd]) ? cv(r[m.sd]) : null)) };
      slot = chart((w) => spark({ w, h: 40, values: smooth, band, label: sl }));
    }
  }
  return html`<a class="tr-row fam fam-${m.fam}" href="/trends/${m.tab}${q}">
    <span class="tr-row__k">${ib(m.icon)}<span class="tr-row__n">${m.name}<small>${N(a.goal) ? `Goal ${m.fmt(cv(a.goal))} · ${Math.round((a.goalRate || 0) * 100)}% of ${m.day || 'day'}s` : `Typically ${(m.short || m.fmt)(cv(a.p25))}–${(m.short || m.fmt)(cv(a.p75))}`}</small></span></span>
    <span class="tr-row__v">${fa(cv(a.avg))}${u ? html`<span class="stat__u">${u}</span>` : ''}</span>
    <span class="tr-row__c">${versusPrev(m, a, t.days, true)}</span>
    <span class="tr-row__g">${slot}</span>
  </a>`;
}

function weightRow(t, q) {
  const w = t.weight;
  if (!w?.latest || !N(w.latest.avg7 ?? w.latest.kg)) return '';
  const u = f.weightUnit();
  const avg7 = (w.trend || []).map((r) => (N(r.avg7) ? f.weightVal(r.avg7) : null));
  const ch = w.rangeChangeKg;
  return html`<a class="tr-row fam fam-body" href="/trends/body${q}">
    <span class="tr-row__k">${ib('scale')}<span class="tr-row__n">Weight<small>7-day average${N(w.ratePerWeekKg) ? ` · ${rateWords(w.ratePerWeekKg, true)}` : ''}</small></span></span>
    <span class="tr-row__v">${f.weightNum(w.latest.avg7 ?? w.latest.kg)}<span class="stat__u">${u}</span></span>
    <span class="tr-row__c">${N(ch) ? html`${delta({ abs: f.weightVal(ch), unit: u, good: null, digits: 1 })}<span>over ${SPAN[t.days] || 'this range'}</span>` : html`<span class="muted">Not enough weigh-ins for a change yet</span>`}</span>
    <span class="tr-row__g">${count(avg7) >= 4 ? chart((cw) => spark({ w: cw, h: 40, values: avg7, label: `Weight, 7-day average over ${SPAN[t.days] || 'this range'}. ${describe(avg7, f.dec1, u)}` })) : ''}</span>
  </a>`;
}

function overviewTab(t, q) {
  const keys = ORDER.filter((k) => has(t, k));
  const rows = [...keys.map((k) => overviewRow(t, k, q)), weightRow(t, q)].filter(Boolean);
  const rels = t.relations || [];
  const table = mod({
    title: 'Your averages', icon: 'trends', span: 7, cls: 'tr-ov',
    note: `Each against ${PREV[t.days] || 'the period before'}. The small chart is ${t.days > 30 ? 'the range by week' : 'each day'}, with your goal or usual range.`,
    body: html`<div class="tr-rows">${rows}</div>`,
  });
  const side = rels.length
    ? mod({
      title: 'Patterns', icon: 'idea', span: 5, note: 'How one thing moved with another. Patterns, not causes.',
      body: rels.map((r, i) => html`${i ? html`<hr class="rule">` : ''}${relation(r)}`),
    })
    : goalsModule(t, { span: 5 });
  // Without relationships the list is short: the weeks sit under it, beside the goals.
  if (!rels.length && side) return grid(html`<div class="tr-stack tr-stack--one mod--7">${table}${periods(t)}</div>${side}`);
  return html`${grid(html`${table}${side}`)}${grid(html`${periods(t)}`)}`;
}

/* ── sleep ──────────────────────────────────────────────────── */

const STAGES = [['DEEP', 'Deep', 'sw-deep'], ['REM', 'REM', 'sw-rem'], ['LIGHT', 'Light', 'sw-light'], ['AWAKE', 'Awake', 'sw-awake']];
const clockOf = (min) => { const x = (((Math.round(min) % 1440) + 1440) % 1440); return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

function clockOff(ms, offSec) {
  if (!N(ms)) return f.DASH;
  if (!N(offSec)) return f.clock(ms);
  const d = new Date(ms + offSec * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function stagesModule(t, span) {
  const st = t.sleep?.stagesAvg;
  if (!st || !STAGES.some(([k]) => N(st[k]?.min))) return '';
  const parts = STAGES.filter(([k]) => N(st[k]?.min));
  const deep = st.DEEP; const rem = st.REM;
  return mod({
    title: 'Sleep stages', icon: 'deep', fam: 'sleep', span, note: 'An average night in this range',
    body: html`
      ${N(deep?.min) ? stat({ value: f.dur(deep.min), unit: 'deep a night', context: html`<span>${Math.round(deep.pct)}% of the night${N(rem?.min) ? `, with ${f.dur(rem.min)} of REM (${Math.round(rem.pct)}%)` : ''}</span>` }) : ''}
      <div class="part">${split(parts.map(([k, label, cls]) => ({ value: st[k].pct, cls, label })), { label: `An average night: ${parts.map(([k, label]) => `${label} ${Math.round(st[k].pct)}%`).join(', ')}` })}
      ${facts(parts.map(([k, label, cls]) => ({ k: html`<span class="legend__sw tr-sw ${cls}"></span>${label}`, v: f.dur(st[k].min), s: `${Math.round(st[k].pct)}%` })), { cols: 4, cls: 'facts--s tr-stages' })}</div>`,
  });
}

function nightsModule(t, span) {
  if (t.days > 30) return '';
  const nights = (t.sleep?.nights || []).filter((n) => n.main !== false && N(n.startMs) && N(n.endMs));
  if (!nights.length) return '';
  const stages = cap('sleepStages');
  const recent = nights.slice().sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 14).map((n) => {
    const anchor = Date.parse(`${n.date}T00:00:00Z`) - 4 * 3600_000;
    return {
      date: n.date, start: n.startMs, end: n.endMs, minutes: n.asleepMin, startOff: n.startOff, endOff: n.endOff,
      stages: stages ? n.stages : null,
      bedMin: (n.startMs + (n.startOff || 0) * 1000 - anchor) / 60000,
    };
  });
  return mod({
    title: 'Night by night', icon: 'history', fam: 'sleep', span, note: `The last ${f.plural(recent.length, 'night')} on one clock, newest first`,
    body: html`<div class="chartbox">
      ${chart((w) => sleepTimeline({ w, nights: recent, label: `The last ${recent.length} nights on a shared clock from 20:00 to 12:00, newest first, with time asleep at the end of each row.` }))}
      ${stages ? legend([['sw-deep', 'Deep'], ['sw-rem', 'REM'], ['sw-light', 'Light'], ['sw-awake', 'Awake']]) : ''}
      ${raw(tableAlt(['Night', 'Asleep', 'In bed'], recent.map((n) => [f.dayMed(n.date), f.dur(n.minutes), `${clockOff(n.start, n.startOff)} to ${clockOff(n.end, n.endOff)}`])))}
    </div>`,
  });
}

function regularityModule(t, span) {
  const r = t.sleep?.regularity;
  const n = r?.nights?.length || 0;
  if (!r || !n) return '';
  const words = !N(r.score) ? '' : r.score >= 80 ? 'Very regular' : r.score >= 60 ? 'Fairly regular' : r.score >= 40 ? 'Somewhat irregular' : 'Irregular';
  const bed = N(r.bedMean) ? clockOf(r.bedMean + 18 * 60) : null;
  const wake = N(r.wakeMean) ? clockOf(r.wakeMean) : null;
  const sentence = bed && wake && N(r.bedSd) && N(r.wakeSd)
    ? `You fall asleep within about ±${f.int(r.bedSd)} min of ${bed} and wake within about ±${f.int(r.wakeSd)} min of ${wake}.`
    : '';
  return mod({
    title: 'Regularity', icon: 'clock', fam: 'sleep', span, note: 'How steady your bedtime and wake time are',
    body: n < 3 || !N(r.score)
      ? tooFew(n, 3, 'nights')
      : html`
        ${stat({ size: 'l', value: f.int(r.score), unit: 'of 100', context: html`<span><b>${words}.</b> ${sentence}</span>` })}
        ${figure(chart((w) => regularity({ w, h: w > 520 ? 240 : 210, nights: r.nights, bedMean: r.bedMean, bedSd: r.bedSd, wakeMean: r.wakeMean, wakeSd: r.wakeSd, label: `Bedtime and wake time of ${f.int(n)} nights on one clock. ${sentence}` })), {
        read: 'Each night is a pair: when you fell asleep and when you woke.',
        legendItems: [['sw-dotink', 'Fell asleep'], ['sw-dotacc', 'Woke up'], ['sw-band', 'Usual time ± 1 SD']],
        table: tableAlt(['Night', 'Asleep at', 'Up at'], r.nights.slice(-60).reverse().map((x) => [f.dayMed(x.date), clockOf(x.bedMin + 18 * 60), clockOf(x.wakeMin)]), { summary: n > 60 ? 'Show the last 60 nights as a table' : 'Show as a table' }),
      })}`,
  });
}

function sleepGoalModule(t, span) {
  const a = t.analysis?.sleepMin;
  const goal = a?.goal || t.activity?.sleepTarget;
  if (!a?.n || !N(goal)) return '';
  const nights = a.n; const at = t.sleep?.goalNights ?? a.goalDays ?? 0;
  const debt = t.sleep?.debtMin;
  const diff = a.avg - goal;
  const run = longestRun(t.series.map((r) => r.sleepMin), goal);
  return mod({
    title: 'Against your goal', icon: 'target', fam: 'sleep', span, note: `${f.dur(goal)} a night`,
    body: html`
      ${stat({ value: html`${f.int(at)}<span class="stat__u">of ${f.plural(nights, 'night')} at goal</span>`, context: html`<span>${Math.round((at / nights) * 100)}% of nights. ${Math.abs(diff) < 5 ? 'Your average is right on it.' : `Your average is ${f.dur(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'}.`}</span>`, extra: meter({ value: at, goal: nights, label: `${at} of ${nights} nights at or above your sleep goal` }) })}
      <hr class="rule">
      ${facts([
        N(debt) ? { k: 'Sleep debt', v: debt < 5 ? 'None' : f.dur(debt), s: debt < 5 ? 'Every night met the goal' : `Short of the goal in total, about ${f.dur(debt / nights)} a night` } : null,
        { k: 'Longest run at goal', v: f.int(run), u: run === 1 ? 'night' : 'nights', s: run ? 'In a row, in this range' : 'No night reached it in this range' },
      ], { cols: 2, cls: 'facts--s' })}`,
  });
}

function sleepTab(t) {
  if (!has(t, 'sleepMin')) return tabEmpty('moon', 'No sleep in this range', cap('sleep') ? 'Nothing was recorded in this range. Try a longer one.' : capText('sleep', 'Your device does not report sleep. Wear a watch or band at night and link it to Google Health, and your nights appear here.'));
  const stages = stagesModule(t, 5);
  const nightly = nightsModule(t, 12);
  const goal = sleepGoalModule(t, 5);
  const reg = regularityModule(t, 7);
  // Pair a wide module with a narrow one; whatever is absent lets its partner take the row.
  // Regularity is tall; stages and the goal stack beside it.
  const sideCol = stages || goal ? html`<div class="tr-stack mod--5">${stages}${goal}</div>` : '';
  return html`${grid(wideMetric(t, 'sleepMin'))}
    ${reg || sideCol ? grid(html`${reg}${sideCol}`) : ''}
    ${nightly ? grid(nightly) : ''}`;
}

/* ── activity ───────────────────────────────────────────────── */

function yearMap(t) {
  if (t.days < 365) return '';
  const goal = t.analysis?.steps?.goal || t.activity?.stepTarget || 8000;
  const days = (t.full || t.series).map((r) => {
    const s = r.steps;
    const level = !N(s) || s <= 0 ? 0 : s >= goal * 1.5 ? 4 : s >= goal ? 3 : s >= goal * 0.5 ? 2 : 1;
    return { date: r.date, level, read: `${f.dayMed(r.date)}: ${N(s) ? `${f.int(s)} steps` : 'nothing recorded'}` };
  });
  const active = days.filter((d) => d.level >= 3).length;
  return mod({
    title: 'The year in steps', icon: 'calendar', fam: 'steps', span: 12, note: `${f.plural(active, 'day')} at your goal of ${f.int(goal)}`,
    body: html`<div class="chartbox">
      <p class="chart__read" aria-live="polite">Touch a square to read a day.</p>
      <div class="heat" tabindex="0" role="group" aria-label="Steps on each day of the last year, scrollable">${chart(() => heatmap({ days, label: `Steps on each of the last ${days.length} days against your goal: ${active} days at or above it.` }))}</div>
      ${legend([['sw-h0', 'None'], ['sw-h1', 'Under half'], ['sw-h2', 'Under goal'], ['sw-h3', 'At goal'], ['sw-h4', 'One and a half times']])}
    </div>`,
  });
}

function activityTab(t) {
  if (!['steps', 'activeMinutes', 'distanceM', 'kcal'].some((k) => has(t, k))) return tabEmpty('steps', 'No activity in this range', cap('steps') ? 'Nothing was recorded in this range. Try a longer one.' : 'Steps appear once your phone or watch has synced to Google Health.');
  const second = [has(t, 'activeMinutes') ? compactMetric(t, 'activeMinutes') : '', has(t, 'kcal') ? compactMetric(t, 'kcal') : '', has(t, 'distanceM') ? compactMetric(t, 'distanceM') : '', goalsModule(t)].filter(Boolean);
  return html`${has(t, 'steps') ? grid(wideMetric(t, 'steps')) : ''}
    ${second.length ? grid(html`${second}`, 'grid--rows') : ''}
    ${grid(html`${yearMap(t)}${periods(t)}`)}`;
}

/* ── heart ──────────────────────────────────────────────────── */

function heartTab(t) {
  const keys = ['rhr', 'hrv', 'spo2', 'tempDev'].filter((k) => has(t, k));
  if (!keys.length) return tabEmpty('heart', 'No heart data in this range', cap('restingHr') ? 'Nothing was recorded in this range. Try a longer one.' : capText('restingHr', 'Your device does not report resting heart rate.'));
  const rel = (t.relations || []).find((r) => r.id === 'sleep_hrv');
  const small = [
    has(t, 'spo2') ? compactMetric(t, 'spo2') : '',
    has(t, 'tempDev') ? compactMetric(t, 'tempDev') : '',
  ].filter(Boolean);
  const relMod = rel ? mod({ title: 'Sleep and HRV', icon: 'idea', span: small.length % 2 ? 6 : 12, cls: small.length % 2 ? '' : 'tr-relwide', note: 'A night’s sleep against the HRV of the morning after', body: relation(rel) }) : '';
  return html`${has(t, 'rhr') ? grid(wideMetric(t, 'rhr')) : ''}
    ${has(t, 'hrv') ? grid(wideMetric(t, 'hrv')) : ''}
    ${small.length || relMod ? grid(html`${small}${relMod}`, 'grid--rows') : ''}`;
}

/* ── body ───────────────────────────────────────────────────── */

function rateWords(kgPerWeek, brief = false) {
  const v = f.weightVal(kgPerWeek);
  const u = f.weightUnit();
  if (Math.abs(v) < 0.05) return brief ? 'steady' : 'Holding steady over the last 4 weeks';
  return `${v > 0 ? '+' : '−'}${f.dec1(Math.abs(v))} ${u} a week${brief ? '' : ' over the last 4 weeks'}`;
}

const addBtn = (label = 'Add a weigh-in') => html`<button type="button" class="btn btn--tonal btn--s" data-action="add-weight">${ic('plus', { size: 's' })}${label}</button>`;

function weightModule(t) {
  const w = t.weight || {};
  let tr = w.trend || [];
  const first = tr.findIndex((r) => N(r.kg) || N(r.avg7));
  const u = f.weightUnit();
  if (first < 0) {
    return mod({
      title: 'Weight', icon: 'scale', fam: 'body', span: 12,
      body: html`<div class="empty empty--inline">
        <p class="empty__t">No weigh-ins ${cap('weight') ? 'in this range' : 'yet'}</p>
        <p class="empty__d">${cap('weight') ? 'Try a longer range, or add one now.' : 'Add your weight here, or use a smart scale that sends it to Google Health. Either way it is saved to Google Health too. After a week of weigh-ins a smoothed line and a rate per week appear.'}</p>
        ${addBtn()}
      </div>`,
    });
  }
  if (first > tr.length * 0.2) tr = tr.slice(first);
  const dates = tr.map((r) => r.date);
  const kg = tr.map((r) => (N(r.kg) ? f.weightVal(r.kg) : null));
  const avg7 = tr.map((r) => (N(r.avg7) ? f.weightVal(r.avg7) : null));
  const latest = w.latest?.avg7 ?? lastOf(tr.map((r) => r.avg7 ?? r.kg));
  const ch = w.rangeChangeKg;
  const pts = (w.points || []).slice().sort((a, b) => b.t - a.t);
  const nW = count(kg);
  const context = html`${N(w.ratePerWeekKg) ? html`<span><b>${rateWords(w.ratePerWeekKg)}.</b></span>` : html`<span class="muted">A rate per week appears after five days with a weigh-in.</span>`}${N(ch) ? html`<span>${Math.abs(f.weightVal(ch)) < 0.05 ? 'No change' : `${ch > 0 ? 'Up' : 'Down'} ${f.dec1(Math.abs(f.weightVal(ch)))} ${u}`} over ${dates.length < t.days * 0.8 ? `the ${f.int(dates.length)} days since ${f.dayShort(dates[0])}` : SPAN[t.days] || 'this range'}.</span>` : ''}`;
  const main = nW < 2
    ? tooFew(nW, 2, 'weigh-ins')
    : figure(chart((cw) => lineChart({
      w: cw, h: cw > 620 ? 280 : cw > 420 ? 220 : 196, dates,
      series: [{ values: avg7, label: '7-day average' }, { values: kg, label: 'Weigh-in', quiet: true, pointsOnly: true }],
      fmt: f.dec1, unit: u, label: `Weight: the 7-day average and each weigh-in. ${describe(kg, f.dec1, u)}`,
    })), {
      read: 'Dots are weigh-ins; the line is their 7-day average.',
      legendItems: [['sw-met', '7-day average'], ['sw-dot', 'Each weigh-in']],
      table: tableAlt(['Day', `Weight (${u})`, '7-day average'], dates.map((d, i) => (N(kg[i]) ? [f.dayMed(d), f.dec1(kg[i]), N(avg7[i]) ? f.dec1(avg7[i]) : f.DASH] : null)).filter(Boolean).reverse()),
    });
  const list = facts([
    N(ch) ? { k: 'Change in range', v: signed1(f.weightVal(ch)), u, s: `Since ${f.dayShort(dates[0])}` } : null,
    N(w.ratePerWeekKg) ? { k: 'Rate', v: signed1(f.weightVal(w.ratePerWeekKg)), u: `${u} a week`, s: 'Slope of the last 4 weeks' } : null,
    w.min ? { k: 'Lightest', v: f.weightNum(w.min.kg), u, s: f.dayMed(w.min.date) } : null,
    w.max ? { k: 'Heaviest', v: f.weightNum(w.max.kg), u, s: f.dayMed(w.max.date) } : null,
    { k: 'Weigh-ins', v: f.int(nW), u: nW === 1 ? 'day' : 'days', s: `Of ${f.int(dates.length)} in range` },
    N(w.change30) && t.days !== 30 ? { k: 'Last 30 days', v: signed1(f.weightVal(w.change30)), u } : null,
  ], { cols: 2, cls: 'facts--s' });
  const recent = pts.slice(0, 5);
  return mod({
    title: 'Weight', icon: 'scale', fam: 'body', span: 12, tools: addBtn('Add'),
    body: html`<div class="tr-cols">
      <div class="tr-main">${stat({ size: 'l', value: f.weightNum(latest), unit: `${u} · 7-day average`, context })}${main}</div>
      <div class="tr-side">${list}
        ${recent.length ? html`<div class="part"><p class="sub">Latest weigh-ins</p><ul class="tr-best tr-best--plain">${recent.map((p) => html`<li><span class="tr-best__d">${f.dateTime(p.t)}${p.note ? html`<small>${p.note}</small>` : ''}</span><span class="tr-best__v">${f.weightNum(p.kg)}<small>${u}</small></span></li>`)}</ul></div>` : ''}
      </div>
    </div>`,
  });
}

function bodyTab(t) {
  const fat = has(t, 'bodyFat') ? wideMetric(t, 'bodyFat', { note: 'From a smart scale, on the days it measured' }) : '';
  return html`${grid(weightModule(t))}${fat ? grid(fat) : ''}`;
}

function addWeight(onSaved, ret) {
  const u = f.weightUnit();
  const canWrite = app.me.google?.canWriteWeight !== false;
  const s = sheet({
    title: 'Add weight',
    body: html`<form class="form" id="weight-form" novalidate>
      ${!canWrite ? banner({ tone: 'warn', title: 'Saving is not allowed yet', text: 'Reconnect to allow saving your weight.', actions: html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="${ret}">Reconnect Google</button>` }) : ''}
      <div data-slot="error"></div>
      ${field({ label: `Weight (${u})`, name: 'weight', type: 'number', attrs: `inputmode="decimal" step="0.1" min="${u === 'lb' ? 44 : 20}" max="${u === 'lb' ? 880 : 400}" required autofocus placeholder="${u === 'lb' ? '170.0' : '77.0'}"` })}
      ${field({ label: 'When', name: 'at', type: 'datetime-local', value: f.toLocalInput(Date.now()), attrs: 'step="60"', hint: 'Now, or any time in the last 30 days.' })}
      ${field({ label: 'Note (optional)', name: 'note', attrs: 'maxlength="80" autocomplete="off"' })}
      <p class="field__hint">It is saved to Google Health as well, so your other apps see it.</p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="weight-form">Save</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    fieldError(form, 'weight', ''); fieldError(form, 'at', '');
    const kg = f.toKg(v.weight);
    if (!N(kg) || kg < 20 || kg > 400) { fieldError(form, 'weight', `Enter a weight between ${u === 'lb' ? '44 and 880 lb' : '20 and 400 kg'}.`); return; }
    const at = v.at ? f.fromLocalInput(v.at) : Date.now();
    if (at > Date.now() + 60000) { fieldError(form, 'at', 'That time is in the future.'); return; }
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/weight', { kg: Math.round(kg * 100) / 100, at, ...(v.note ? { note: v.note } : {}) }));
      if (r === undefined) return;
      s.close();
      toast('Weight saved');
      onSaved();
    } catch (err) {
      mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err, 'Could not save your weight. Try again.') }));
    }
  });
}

/* ── empty states ───────────────────────────────────────────── */

function tabEmpty(iconName, title, text) {
  return grid(mod({ span: 12, label: title, body: html`<div class="empty"><span class="empty__ic">${ic(iconName)}</span><p class="empty__t">${title}</p><p class="empty__d">${text}</p></div>` }));
}

/** Nothing at all yet: say what this screen becomes. */
function noHistory(connected) {
  const will = [
    ['steps', 'steps', 'Activity', 'Steps, distance, active minutes and calories by day against your goal, with your best days and weekday pattern.'],
    ['sleep', 'moon', 'Sleep', 'Time asleep, stages, how regular your bedtime is, and what you owe your goal.'],
    ['heart', 'resting', 'Heart', 'Resting heart rate and HRV inside your own usual range, blood oxygen and skin temperature.'],
    ['body', 'scale', 'Body', 'Weigh-ins with a smoothed line and a rate per week. You can add these by hand.'],
  ];
  return grid(mod({
    span: 12, title: connected ? 'Nothing has arrived yet' : 'No history yet', icon: 'trends',
    note: connected
      ? 'Your first sync is still filling in. Averages show after a few days; weekday patterns after two weeks.'
      : 'Trends are drawn from your Google Health history. Connect Google and up to a year fills in, as far as your device reports it.',
    body: html`<div class="part"><p class="sub">What will appear here</p><ul class="tr-will">${will.map(([fam, icon, name, text]) => html`<li class="fam fam-${fam}">${ib(icon)}<span><b>${name}</b><span>${text}</span></span></li>`)}</ul></div>
      <div>${addBtn()}</div>`,
  }));
}

/* ── a category's metrics (from /api/browse) ────────────────── */

let browseCache = null;   // { uid, data }
async function browseData({ fresh = false } = {}) {
  const uid = app.me.user?.id;
  if (!fresh && browseCache?.uid === uid) return browseCache.data;
  const data = await api.get('/api/browse');
  browseCache = { uid, data };
  return data;
}

/** Every metric of one category, as Browse lists them, and what it could also hold. */
function catMetrics(b, cat, { title } = {}) {
  if (!b) return '';
  const c = (b.categories || []).find((x) => x.id === cat);
  const none = (b.empty || []).filter((e) => e.category === cat);
  if (!c && !none.length) return '';
  return html`${c ? mod({
    title: title || `All ${CAT_LABEL[cat].toLowerCase()} data`, fam: CAT_FAM[cat] || '', cls: 'br-cat tr-cat', span: 12,
    tools: html`<span class="br-count">${c.metrics.length}<span class="sr"> metrics</span></span>`,
    body: html`<ul class="mrows">${c.metrics.map((m) => metricRow(m, { today: b.today }))}</ul>`,
  }) : ''}
  ${none.length ? mod({ title: 'No data yet', cls: 'br-cat br-none tr-cat', span: 12, note: 'What this app can also hold here. Each line says what gives it.', body: emptyList(none) }) : ''}`;
}

/** /trends/vitals, /nutrition, /mindfulness, /cycle, /other: the category's metrics. */
async function listPage(ctx, cat) {
  const { root } = ctx;
  const label = CAT_LABEL[cat];
  document.title = `${label} · Health`;
  let b = null;
  const chrome = (body) => html`${head({ title: label, back: '/trends' })}<div class="tr-body tr-list fam fam-${CAT_FAM[cat] || 'steps'}">${body}</div>`;
  const paint = () => {
    const y = window.scrollY;
    const has = (b.categories || []).some((c) => c.id === cat) || (b.empty || []).some((e) => e.category === cat);
    const addable = ((b.categories || []).find((c) => c.id === cat)?.metrics || []).filter((m) => m.canAdd);
    const adds = addable.length ? html`<div class="tr-adds">${addable.map((m) => html`<button type="button" class="pill-btn pill-btn--soft" data-add="${m.id}">${ic('plus', { size: 's' })}${m.label}</button>`)}</div>` : '';
    mount(root, chrome(has ? html`${adds}${catMetrics(b, cat, { title: label === 'Other' ? 'Everything else' : `Every ${label.toLowerCase()} metric` })}`
      : tabEmpty('info', `No ${label.toLowerCase()} data`, 'Nothing in this category yet.')));
    window.scrollTo(0, y);
  };
  async function load({ quiet = false } = {}) {
    if (!quiet && !b) mount(root, chrome(skeleton('list')));
    try {
      b = await browseData({ fresh: quiet || !b });
      if (ctx.alive()) paint();
    } catch (err) { if (ctx.alive() && !quiet) mount(root, chrome(errorState(err))); }
  }
  bindListActions(root, () => load({ quiet: true }), `/trends/${cat}`);
  bindPins(root, { changed: () => load({ quiet: true }) });
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('data') || what.includes('me')) load({ quiet: true }); }));
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}

function bindListActions(root, reload, ret) {
  on(root, 'click', '[data-add]', (e, x) => { x.classList.add('is-busy'); addEntry(x.dataset.add, { onSaved: reload }).finally(() => x.classList.remove('is-busy')); });
  on(root, 'click', '[data-group]', async (e, x) => {
    if (x.classList.contains('is-busy')) return;
    x.classList.add('is-busy');
    const ok = await turnOnGroup(x.dataset.group, { ret });
    x.classList.remove('is-busy');
    if (ok) reload();
  });
}

/* ── the page ───────────────────────────────────────────────── */

const TAB_CAPS = {
  sleep: ['sleep', 'sleepStages'],
  activity: ['steps', 'distance', 'activeMinutes', 'calories'],
  heart: ['restingHr', 'hrv', 'spo2', 'skinTemp'],
  body: ['weight', 'bodyFat'],
};
const TAB_KEYS = { sleep: ['sleepMin'], activity: ['steps', 'activeMinutes', 'distanceM', 'kcal'], heart: ['rhr', 'hrv', 'spo2', 'tempDev'], body: ['bodyFat'] };

export default async function trends(ctx) {
  const { root } = ctx;
  // `/trends` itself is Browse (views/browse.js); the analysis lives at /trends/<section>.
  const tab = ctx.params.tab || 'overview';
  if (LIST_CATS.includes(tab)) { await listPage(ctx, tab); return; }
  if (!TABS.some(([id]) => id === tab)) { go('/trends', { replace: true }); return; }

  let days = 30;
  const asked = Q_RANGE[ctx.query?.get('range') || ''];
  if (asked) days = asked;
  else { try { const s = Number(sessionStorage.getItem(RANGE_KEY)); if (RANGE_Q[s]) days = s; } catch { /* default */ } }
  const remember = () => { try { sessionStorage.setItem(RANGE_KEY, String(days)); } catch { /* fine */ } };
  remember();

  let data = null; let cats = null;
  let seq = 0;
  document.title = tab === 'overview' ? 'Trends · Health' : `${TABS.find(([id]) => id === tab)[1]} trends · Health`;

  const q = () => `?range=${RANGE_Q[days]}`;
  const path = () => `/trends/${tab}`;
  const hasWeight = () => Boolean(data?.weight?.latest) || (data?.weight?.trend || []).some((r) => N(r.kg));

  /** Browse, Overview, plus the sections this person has anything for (and the one they are on). */
  const tabsFor = () => sectionTabs(tab, {
    q: q(),
    also: (id) => Boolean(data && TAB_KEYS[id] && (TAB_KEYS[id].some((k) => has(data, k)) || (id === 'body' && hasWeight()))),
  }).filter(([, , id]) => id !== 'browse');   // the back arrow goes there
  const title = TABS.find(([id]) => id === tab)[1];
  const span = () => `${f.dayShort(f.addDays(f.today(), -(days - 1)))} to ${f.dayShort(f.today())}`;

  const chrome = (body, { loading = false } = {}) => html`
    ${head({ title, back: '/trends' })}
    <div class="tr-tabs">${tabsub(tabsFor(), tab, { label: 'Trends' })}</div>
    <div class="tr-bar">${seg('range', RANGES, days, { label: 'Range' })}<p class="tr-span" data-span>${span()}</p></div>
    <div class="tr-body ${loading ? 'is-loading' : ''}" ${raw(loading ? 'aria-busy="true"' : '')}>${connectionBanner(`${path()}${q()}`)}${body}</div>`;

  function paint() {
    const t = data;
    const g = app.me.google?.state;
    const any = t.series?.some((r) => Object.entries(r).some(([k, v]) => k !== 'date' && N(v))) || hasWeight();
    let body;
    if (!any && tab !== 'body') body = noHistory(g === 'ok');
    else {
      body = tab === 'overview' ? overviewTab(t, q()) : tab === 'sleep' ? sleepTab(t) : tab === 'activity' ? activityTab(t) : tab === 'heart' ? heartTab(t) : bodyTab(t);
      // What the device does not report, once: everything on the overview, the tab's own gaps elsewhere.
      const missing = (app.me.capsMeta?.missing || []).filter((x) => (tab === 'overview' ? !['exercise', 'deviceBattery', 'heartRateMinute', 'heartRate'].includes(x.cap) : TAB_CAPS[tab].includes(x.cap)));
      const since = t.since ? html`<p class="tr-quiet">Your history starts on ${f.dateFull(t.since)}, so that is where these charts begin.</p>` : '';
      const weigh = tab === 'overview' && !hasWeight() ? html`<div class="tr-foot"><span>Weight is the one thing you can add by hand.</span>${addBtn()}</div>` : '';
      body = html`${body}${since}${weigh}${missingNote(missing)}`;
    }
    const y = window.scrollY;
    mount(root, chrome(html`${body}${TAB_CAT[tab] ? html`<div class="tr-cats">${catMetrics(cats, TAB_CAT[tab])}</div>` : ''}`));
    window.scrollTo(0, y);
  }

  /* A long range for someone with a short history: start the charts where the data does. */
  function trim(t) {
    t.full = t.series;
    if (t.days <= 90 || !t.series?.length) return t;
    const i = t.series.findIndex((r) => ['steps', 'sleepMin', 'rhr', 'hrv', 'kcal', 'distanceM', 'spo2', 'bodyFat'].some((k) => N(r[k])));
    if (i > t.series.length * 0.2) { t.since = t.series[i].date; t.series = t.series.slice(i); }
    return t;
  }

  async function load({ quiet = false } = {}) {
    const mine = seq += 1;
    if (!quiet) {
      if (data) root.querySelector('.tr-body')?.classList.add('is-loading');   // keep the page (and the scroll position) while the new range arrives
      else mount(root, chrome(skeleton('chart'), { loading: true }));
    }
    try {
      const [t, b] = await Promise.all([api.get(`/api/trends?days=${days}`).then(trim), TAB_CAT[tab] ? browseData({ fresh: quiet }).catch(() => cats) : null]);
      if (!ctx.alive() || mine !== seq) return;
      data = t; cats = b;
      paint();
    } catch (err) {
      if (ctx.alive() && mine === seq && !quiet) { data = null; mount(root, chrome(errorState(err))); }
    }
  }

  on(root, 'click', '[data-seg="range"]', (e, b) => {
    const next = Number(b.dataset.value);
    if (!RANGE_Q[next] || next === days) return;
    days = next;
    remember();
    history.replaceState(history.state, '', `${path()}${q()}`);
    for (const o of root.querySelectorAll('[data-seg="range"]')) o.setAttribute('aria-pressed', String(o === b));
    for (const a of root.querySelectorAll('.tabsub__i')) { const h = a.getAttribute('href').split('?')[0]; a.setAttribute('href', h === '/trends' ? h : `${h}${q()}`); }
    const sp = root.querySelector('[data-span]'); if (sp) sp.textContent = span();
    load();
  });
  bindListActions(root, () => load({ quiet: true }), path());
  bindPins(root, { changed: () => load({ quiet: true }) });
  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="add-weight"]', () => addWeight(() => load({ quiet: true }), `/trends/body${q()}`));
  ctx.onLeave(listen('changed', (what) => { if (what.includes('data')) load({ quiet: true }); }));
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}
