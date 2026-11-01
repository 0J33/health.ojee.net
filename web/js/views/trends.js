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
import { metricRow, moreRows, bindMore, tileCls, secHead } from '../metrics.js';
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
const PREV = { 0: 'before', 7: 'the 7 days before', 30: 'the 30 days before', 90: 'the 90 days before', 180: 'the 6 months before', 365: 'the year before' };
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

/** Weeks (from the person's week start) as averages per day, for bars too thin to draw daily. */
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

/* ── glance first: a hero tile, one chart, calm rows ─────────── */

/* The metric page each analysed series belongs to. */
const METRIC_ID = { steps: 'steps', activeMinutes: 'active', distanceM: 'distance', kcal: 'calories', sleepMin: 'sleep', rhr: 'resting_hr', hrv: 'hrv', spo2: 'spo2', tempDev: 'skin_temp', bodyFat: 'body_fat' };
const LAST = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 180: 'Last 6 months', 365: 'Last year' };

/** The change against the period before, as a chip and three words (the hero's state line). */
function versusShort(m, a, days) {
  if (!N(a.prevAvg)) return html`<span>Nothing earlier to compare with yet</span>`;
  const cv = cvOf(m);
  const chip = m.pct && N(a.deltaPct)
    ? delta({ pct: a.deltaPct, good: m.good })
    : delta({ abs: cv(a.delta), unit: m.dunit || unitOf(m), good: m.good, digits: m.dunit ? 0 : (m.digits || 0) });
  return html`${chip}<span>on ${PREV[days] || 'the period before'}</span>`;
}
/** The same change in plain words, for a row's grey line. */
function versusWords(m, a, days, { short = false } = {}) {
  if (!N(a.prevAvg)) return short ? 'Nothing earlier yet' : 'Nothing earlier to compare with yet';
  if (short) days = 0;
  const on = short ? 'vs' : 'on';
  const cv = cvOf(m);
  if (m.pct && N(a.deltaPct)) { const p = Math.round(a.deltaPct); return p === 0 ? `Same as ${PREV[days]}` : `${p > 0 ? '+' : '−'}${Math.abs(p)}% ${on} ${PREV[days]}`; }
  const d = cv(a.delta); const u = m.dunit || unitOf(m);
  const sz = m.dunit ? f.int(Math.abs(d)) : f.dec(Math.abs(d), m.digits || 0);
  return Math.abs(d) < (m.dunit ? 1 : 0.05) ? (short ? 'No change' : `No change on ${PREV[days]}`) : `${d > 0 ? '+' : '−'}${sz}${u === '%' ? '%' : ` ${u}`} ${on} ${PREV[days]}`;
}
const bigNum = (v) => {
  const t = String(v);
  const hm = /^(\d+) h(?: (\d+)(?: min)?)?$/.exec(t);
  if (hm) return raw(`${hm[1]}<span class="u">h</span>${hm[2] ? `&thinsp;${hm[2]}<span class="u">m</span>` : ''}`);
  const mn = /^(\d+) min$/.exec(t);
  return mn ? raw(`${mn[1]}<span class="u">min</span>`) : t;
};

/** A hero tile: the section's number in its family's colour, opening that metric's page. */
function hero({ fam, icon, label, value, unit = '', state = '', sub = '', href = '', meta = '' }) {
  const tag = href ? 'a' : 'section';
  return html`<${raw(tag)} class="bt ${tileCls(fam)} tr-hero" ${href ? raw(`href="${esc(href)}"`) : ''}>
    <div class="bt__row"><span class="bt__lab">${ic(icon)}${label}</span>${meta ? html`<span class="bt__meta">${meta}</span>` : href ? ic('right', { size: 's' }) : ''}</div>
    <div class="tr-hero__b">
      <p class="n n-hero tr-hero__n">${bigNum(value)}${unit ? html`<span class="u tr-hero__u">${unit}</span>` : ''}</p>
      ${state ? html`<p class="bt__sub tr-hero__s">${state}</p>` : ''}
      ${sub ? html`<p class="bt__sub tr-hero__s">${sub}</p>` : ''}
    </div>
  </${raw(tag)}>`;
}

/** A metric's hero, from its analysis. */
function metricHero(t, key, { label = '' } = {}) {
  const m = M[key]; const a = t.analysis?.[key];
  if (!a?.n) return '';
  const cv = cvOf(m); const fa = m.fa || m.fmt;
  return hero({
    fam: m.fam, icon: m.icon, label: label || `${m.name} · ${LAST[t.days] || ''}`, href: `/metric/${METRIC_ID[key]}`,
    value: fa(cv(a.avg)), unit: [unitOf(m) === '%' ? '%' : unitOf(m), m.per || (m.kind === 'bars' ? '' : 'on average')].filter(Boolean).join(' '),
    state: versusShort(m, a, t.days),
  });
}

/** The one chart under the hero, in a plain card. */
const chartCard = (inner, fam = '', title = '') => (inner ? html`<section class="bt bt--plain tr-chart ${fam ? `fam fam-${fam}` : ''}">${title ? html`<p class="tr-chart__t">${title}</p>` : ''}${inner}</section>` : '');

/** The working-out of the hero's metric (median, range, best, weekdays, spread), as a row. */
function detailRow(t, key, p) {
  const m = M[key]; const a = p.a; const cv = cvOf(m); const short = m.short || m.fmt;
  const fa = m.fa || m.fmt;
  const prev = N(a.prevAvg) ? facts([{ k: PREV[t.days][0].toUpperCase() + PREV[t.days].slice(1), v: fa(cv(a.prevAvg)), u: unitOf(m), s: 'On average' }], { cols: 2, cls: 'facts--s' }) : '';
  return {
    key: `d-${key}`, icon: 'list', fam: m.fam, title: `${m.name}: the numbers`, sheetTitle: m.name,
    text: [N(a.median) ? `Median ${withUnit(m, short(cv(a.median)))}` : '', p.weekday ? 'by weekday' : '', p.spread ? 'spread' : ''].filter(Boolean).join(' · '),
    body: html`${p.list}${prev}${p.weekday}${p.spread}${p.tooShort}`,
  };
}

/** Another metric of the section as a row; its whole module opens in a sheet. */
function metricMore(t, key) {
  const p = pieces(t, key, { cols: 2 });
  if (!p) return null;
  const { m, a } = p; const cv = cvOf(m); const fa = m.fa || m.fmt; const u = unitOf(m);
  return {
    key: `m-${key}`, icon: m.icon, fam: m.fam, title: m.name, text: versusWords(m, a, t.days),
    value: html`${fa(cv(a.avg))}${u ? html`<small>${u}</small>` : ''}`,
    body: html`${m.note ? html`<p class="tr-quiet">${m.note}</p>` : ''}${p.headline}${p.main}${p.list}${p.weekday}${p.spread}${p.tooShort}
      <a class="btn btn--tonal btn--s tr-open" href="/metric/${METRIC_ID[key]}">Open ${m.name.toLowerCase()}${ic('right', { size: 's' })}</a>`,
  };
}

/** A whole module (built with mod()) as a row: its title is the sheet's. */
const modRow = (key, icon, fam, title, text, body) => (body ? { key, icon, fam, title, text, body } : null);

/** The page: hero and chart, then the rows, then the quiet notes. */
let lastRows = [];        // the rows on screen, read when one is tapped
let addWeightNow = null;  // set by the page: opens "Add weight"
function glance({ heroHtml = '', chartHtml = '', rows = [], lead = '' }) {
  const list = rows.filter(Boolean);
  lastRows = list;
  return html`<div class="tr-glance">
    <div class="tr-glance__a">${lead}${heroHtml}${chartHtml}</div>
    <div class="tr-glance__b">${moreRows(list, { label: 'More' })}</div>
  </div>`;
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
  return body ? mod({ title: 'Week by week', icon: 'week', span, note: `${f.WEEKDAYS[f.weekStartDay()]} to ${f.WEEKDAYS[(f.weekStartDay() + 6) % 7]}; the highest step week is in bold.`, body }) : '';
}

/** Week by week (or month by month) as a row. */
function periodsRow(t) {
  const body = periods(t);
  if (!body) return null;
  const monthly = t.days > 90 && (t.months || []).filter((x) => x.days > 0).length >= 3;
  return { key: 'periods', icon: monthly ? 'calendar' : 'week', fam: '', title: monthly ? 'Month by month' : 'Week by week', text: 'Steps, distance, sleep, heart and workouts per ' + (monthly ? 'month' : 'week'), body };
}

/** Goals, streaks and best days as a row. */
function goalRow(t) {
  const body = goalsModule(t, { span: 12 });
  if (!body) return null;
  const st = t.analysis?.steps; const cur = t.activity?.streak?.steps;
  const bits = [N(st?.goal) && N(st?.goalDays) ? `Step goal on ${f.int(st.goalDays)} of ${f.plural(st.n, 'day')}` : '', N(cur) && cur > 0 ? `${f.plural(cur, 'day')} streak` : ''].filter(Boolean);
  return { key: 'goals', icon: 'target', fam: 'steps', title: 'Goals and best days', text: bits.join(' · ') || 'Your goals, streaks and best days', body };
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
    <span class="tr-row__k">${ib(m.icon)}<span class="tr-row__n">${m.name}<small>${versusWords(m, a, t.days, { short: true })}</small></span></span>
    <span class="tr-row__v">${bigNum(fa(cv(a.avg)))}${u ? html`<span class="stat__u">${u}</span>` : ''}</span>
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
    <span class="tr-row__k">${ib('scale')}<span class="tr-row__n">Weight<small>${N(ch) ? `${Math.abs(f.weightVal(ch)) < 0.05 ? 'No change' : `${ch > 0 ? '+' : '−'}${f.dec1(Math.abs(f.weightVal(ch)))} ${u}`} over ${SPAN[t.days] || 'this range'}` : 'Not enough weigh-ins for a change yet'}${N(w.ratePerWeekKg) ? ` · ${rateWords(w.ratePerWeekKg, true)}` : ''}</small></span></span>
    <span class="tr-row__v">${f.weightNum(w.latest.avg7 ?? w.latest.kg)}<span class="stat__u">${u}</span></span>
    <span class="tr-row__g">${count(avg7) >= 4 ? chart((cw) => spark({ w: cw, h: 40, values: avg7, label: `Weight, 7-day average over ${SPAN[t.days] || 'this range'}. ${describe(avg7, f.dec1, u)}` })) : ''}</span>
  </a>`;
}

function overviewTab(t, q) {
  const keys = ORDER.filter((k) => has(t, k));
  const list = [...keys.map((k) => overviewRow(t, k, q)), weightRow(t, q)].filter(Boolean);
  const rels = t.relations || [];
  const card = html`<section class="bt bt--plain tr-ov2" aria-label="Your averages">
    <div class="bt__row"><span class="bt__lab">${ic('trends')}Your averages</span><span class="bt__meta">a day, ${(LAST[t.days] || '').toLowerCase()}</span></div>
    <div class="tr-rows">${list}</div>
  </section>`;
  const rows = [
    ...rels.map((r) => ({ key: `rel-${r.id}`, icon: 'idea', fam: REL_FAM[r.id] || 'recovery', title: `${r.xLabel} and ${r.yLabel.toLowerCase()}`, text: r.text, body: html`<p class="tr-quiet">How one thing moved with another. Patterns, not causes.</p>${relation(r)}` })),
    goalRow(t),
    periodsRow(t),
  ];
  return glance({ heroHtml: card, rows });
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
  const p = pieces(t, 'sleepMin');
  const a = t.analysis.sleepMin;
  const goal = a?.goal || t.activity?.sleepTarget;
  const at = t.sleep?.goalNights ?? a.goalDays ?? 0;
  const r = t.sleep?.regularity;
  const st = t.sleep?.stagesAvg;
  return glance({
    heroHtml: metricHero(t, 'sleepMin'),
    chartHtml: chartCard(p.main, 'sleep'),
    rows: [
      detailRow(t, 'sleepMin', p),
      modRow('goal', 'target', 'sleep', 'Against your goal', N(goal) ? `${f.int(at)} of ${f.plural(a.n, 'night')} at ${f.dur(goal)} or more` : '', sleepGoalModule(t, 12)),
      modRow('reg', 'clock', 'sleep', 'Regularity', N(r?.score) ? `${f.int(r.score)} of 100 · how steady your bedtime and wake time are` : 'How steady your bedtime and wake time are', regularityModule(t, 12)),
      modRow('stages', 'deep', 'sleep', 'Sleep stages', N(st?.DEEP?.min) ? `${f.dur(st.DEEP.min)} deep in an average night, ${Math.round(st.DEEP.pct)}%` : 'An average night in this range', stagesModule(t, 12)),
      modRow('nights', 'history', 'sleep', 'Night by night', 'Recent nights on one clock, newest first', nightsModule(t, 12)),
    ],
  });
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
  const keys = ['steps', 'activeMinutes', 'kcal', 'distanceM'].filter((k) => has(t, k));
  const lead = keys[0]; const p = pieces(t, lead);
  const year = yearMap(t);
  return glance({
    heroHtml: metricHero(t, lead),
    chartHtml: chartCard(p.main, M[lead].fam),
    rows: [
      detailRow(t, lead, p),
      ...keys.slice(1).map((k) => metricMore(t, k)),
      goalRow(t),
      year ? modRow('year', 'calendar', 'steps', 'The year in steps', 'Every day of the last year against your goal', year) : null,
      periodsRow(t),
    ],
  });
}

/* ── heart ──────────────────────────────────────────────────── */

function heartTab(t) {
  const keys = ['rhr', 'hrv', 'spo2', 'tempDev'].filter((k) => has(t, k));
  if (!keys.length) return tabEmpty('heart', 'No heart data in this range', cap('restingHr') ? 'Nothing was recorded in this range. Try a longer one.' : capText('restingHr', 'Your device does not report resting heart rate.'));
  const rel = (t.relations || []).find((r) => r.id === 'sleep_hrv');
  const lead = keys[0]; const p = pieces(t, lead);
  return glance({
    heroHtml: metricHero(t, lead),
    chartHtml: chartCard(html`${M[lead].note ? html`<p class="tr-chart__note">${M[lead].note}</p>` : ''}${p.main}`, M[lead].fam),
    rows: [
      detailRow(t, lead, p),
      ...keys.slice(1).map((k) => metricMore(t, k)),
      rel ? { key: 'rel', icon: 'idea', fam: 'recovery', title: 'Sleep and HRV', text: rel.text, body: html`<p class="tr-quiet">A night’s sleep against the HRV of the morning after. Patterns, not causes.</p>${relation(rel)}` } : null,
    ],
  });
}

/* ── body ───────────────────────────────────────────────────── */

function rateWords(kgPerWeek, brief = false) {
  const v = f.weightVal(kgPerWeek);
  const u = f.weightUnit();
  if (Math.abs(v) < 0.05) return brief ? 'steady' : 'Holding steady over the last 4 weeks';
  return `${v > 0 ? '+' : '−'}${f.dec1(Math.abs(v))} ${u} a week${brief ? '' : ' over the last 4 weeks'}`;
}

const addBtn = (label = 'Add a weigh-in') => html`<button type="button" class="btn btn--tonal btn--s" data-action="add-weight">${ic('plus', { size: 's' })}${label}</button>`;

/** Weight, in pieces for the Body page: hero, chart, numbers, latest weigh-ins. Null without weigh-ins. */
function weightParts(t) {
  const w = t.weight || {};
  let tr = w.trend || [];
  const first = tr.findIndex((r) => N(r.kg) || N(r.avg7));
  const u = f.weightUnit();
  if (first < 0) return null;
  if (first > tr.length * 0.2) tr = tr.slice(first);
  const dates = tr.map((r) => r.date);
  const kg = tr.map((r) => (N(r.kg) ? f.weightVal(r.kg) : null));
  const avg7 = tr.map((r) => (N(r.avg7) ? f.weightVal(r.avg7) : null));
  const latest = w.latest?.avg7 ?? lastOf(tr.map((r) => r.avg7 ?? r.kg));
  const ch = w.rangeChangeKg;
  const pts = (w.points || []).slice().sort((x, y) => y.t - x.t);
  const nW = count(kg);
  const overWhat = dates.length < t.days * 0.8 ? `the ${f.int(dates.length)} days since ${f.dayShort(dates[0])}` : SPAN[t.days] || 'this range';
  const state = N(ch)
    ? html`${delta({ abs: f.weightVal(ch), unit: u, good: null, digits: 1 })}<span>over ${overWhat}</span>`
    : html`<span>Not enough weigh-ins for a change yet</span>`;
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
    N(w.ratePerWeekKg) ? { k: 'Rate', v: signed1(f.weightVal(w.ratePerWeekKg)), u: `${u} a week`, s: 'Slope of the last 4 weeks' } : { k: 'Rate', v: f.DASH, s: 'Appears after five days with a weigh-in' },
    w.min ? { k: 'Lightest', v: f.weightNum(w.min.kg), u, s: f.dayMed(w.min.date) } : null,
    w.max ? { k: 'Heaviest', v: f.weightNum(w.max.kg), u, s: f.dayMed(w.max.date) } : null,
    { k: 'Weigh-ins', v: f.int(nW), u: nW === 1 ? 'day' : 'days', s: `Of ${f.int(dates.length)} in range` },
    N(w.change30) && t.days !== 30 ? { k: 'Last 30 days', v: signed1(f.weightVal(w.change30)), u } : null,
  ], { cols: 2, cls: 'facts--s' });
  const recent = pts.slice(0, 5).length ? html`<div class="part"><p class="sub">Latest weigh-ins</p><ul class="tr-best tr-best--plain">${pts.slice(0, 5).map((x) => html`<li><span class="tr-best__d">${f.dateTime(x.t)}${x.note ? html`<small>${x.note}</small>` : ''}</span><span class="tr-best__v">${f.weightNum(x.kg)}<small>${u}</small></span></li>`)}</ul></div>` : '';
  return {
    hero: hero({ fam: 'body', icon: 'scale', label: 'Weight · 7-day average', href: '/metric/weight', value: f.weightNum(latest), unit: u, state, sub: N(w.ratePerWeekKg) ? rateWords(w.ratePerWeekKg) : '' }),
    main, list, recent,
    summary: [N(w.ratePerWeekKg) ? rateWords(w.ratePerWeekKg, true) : '', `${f.plural(nW, 'weigh-in')}`, w.min && w.max ? `${f.weightNum(w.min.kg)}–${f.weightNum(w.max.kg)} ${u}` : ''].filter(Boolean).join(' · '),
  };
}

function bodyTab(t) {
  const w = weightParts(t);
  const fat = has(t, 'bodyFat') ? metricMore(t, 'bodyFat') : null;
  if (fat) fat.text = `${fat.text} · from a smart scale, on the days it measured`;
  const add = { key: 'add-weight', icon: 'plus', fam: 'body', title: 'Add a weigh-in', text: 'Saved to Google Health as well', act: () => addWeightNow?.() };
  if (!w) {
    return glance({
      heroHtml: hero({ fam: 'body', icon: 'scale', label: 'Weight', value: 'No weigh-ins', sub: cap('weight') ? 'None in this range. Try a longer range, or add one now.' : 'Add your weight here, or use a smart scale that sends it to Google Health. After a week of weigh-ins a smoothed line and a rate per week appear.' }),
      rows: [add, fat],
    });
  }
  return glance({
    heroHtml: w.hero,
    chartHtml: chartCard(w.main, 'body'),
    rows: [
      { key: 'w-num', icon: 'list', fam: 'body', title: 'Weight: the numbers', sheetTitle: 'Weight', text: w.summary, body: html`${w.list}${w.recent}` },
      add,
      fat,
    ],
  });
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
    rowsHere = lastRows;
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
  const openAdd = () => addWeight(() => load({ quiet: true }), `/trends/body${q()}`);
  on(root, 'click', '[data-action="add-weight"]', openAdd);
  addWeightNow = openAdd;
  ctx.onLeave(() => { if (addWeightNow === openAdd) addWeightNow = null; });
  let rowsHere = [];
  bindMore(root, () => rowsHere);
  ctx.onLeave(listen('changed', (what) => { if (what.includes('data')) load({ quiet: true }); }));
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}
