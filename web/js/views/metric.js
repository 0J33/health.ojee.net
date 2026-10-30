/* One metric: /metric/<id>. The period's headline against the period
   before, the server's reading of it, the chart its kind calls for, the
   working-out as facts, how the number is made, and the entries behind it
   (with add, edit and delete where the payload allows them).

   Data: GET /api/metric/<id>?range=&end=&before= (docs/API.md). The range
   and the end day live in the URL, so a period can be linked and Back
   leaves the page in one step. */

import { api } from '../api.js';
import { listen } from '../app.js';
import { html, raw, mount, ic, errorState, chart, on, seg, toast, esc } from '../ui.js';
import { tableAlt } from '../charts.js';
import { trend, hours, stacked, spans, logStrip } from '../viz.js';
import { mod, stat, delta, facts, figure, ib, meter, rings, split } from '../kit.js';
import { aiButton } from '../ai.js';
import { metricIcon, unitOf, val, num, text, shown, entryText, detailText, ownTag, pinButton } from '../metrics.js';
import { entrySheet, deleteEntry, quickAdd, quickButtons, bindPins } from '../entry.js';
import { turnOnGroup, groupOf, groupGrantToast, ALWAYS_PRIVATE } from '../groups.js';
import * as f from '../format.js';

const RANGES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['6m', '6 mo'], ['year', 'Year']];
const RANGE_NAME = { day: 'day', week: 'week', month: 'month', '6m': 'six months', year: 'year' };
const BEFORE = { day: 'the day before', week: 'the week before', month: 'the month before', '6m': 'the six months before', year: 'the year before' };
const RANGE_KEY = 'health.metric.range';
const FIRST = 10;       // entries shown before "Show more"
const STEP = 20;
const N = f.isNum;

const TONE = { muted: 't-muted', low: 't-low', mid: 't-mid', high: 't-high', peak: 't-peak' };
/* Sleep stages keep the colours they have everywhere else in the app. */
const STAGE_CLS = { deep: 'st-deep', rem: 'st-rem', light: 'st-light', awake: 'st-awake' };
const STAGE_SW = { deep: 'sw-deep', rem: 'sw-rem', light: 'sw-light', awake: 'sw-awake' };

/* ── the period ─────────────────────────────────────────────── */

const year = (d) => d.slice(0, 4);
function periodLabel(r) {
  const today = f.today();
  if (r.id === 'day') return r.to === today ? `Today, ${f.dayShort(r.to)}` : r.to === f.addDays(today, -1) ? `Yesterday, ${f.dayShort(r.to)}` : `${f.dayMed(r.to)} ${year(r.to)}`;
  if (r.id === 'year') return `${f.monthShort(r.from)} ${year(r.from)} to ${f.monthShort(r.to)} ${year(r.to)}`;
  const sameYear = year(r.from) === year(r.to);
  return `${f.dayShort(r.from)}${sameYear ? '' : ` ${year(r.from)}`} to ${f.dayShort(r.to)} ${year(r.to)}`;
}

/** Every bucket of the range, with or without data, oldest first. */
function buckets(r, bucket) {
  const out = [];
  if (bucket === 'month') {
    let [y, m] = r.from.split('-').map(Number);
    for (;;) {
      const d = `${y}-${String(m).padStart(2, '0')}-01`;
      if (d > r.to) break;
      out.push(d);
      m += 1; if (m > 12) { m = 1; y += 1; }
      if (out.length > 40) break;
    }
    return out;
  }
  const step = bucket === 'week' ? 7 : 1;
  for (let d = r.from; d <= r.to && out.length < 400; d = f.addDays(d, step)) out.push(d);
  return out;
}

const dayWord = (m) => (m.category === 'sleep' ? 'night' : 'day');

/** Where a point of a chart leads: the day itself, or its week or month
    (ending on its last day, or today when that is earlier). */
function drillTo(m, bucket, dates, to) {
  return (i) => {
    const d = dates[i];
    if (!d) return null;
    const id = encodeURIComponent(m.id);
    if (bucket === 'month') {
      const [y, mo] = d.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      return `/metric/${id}?range=month&end=${last < to ? last : to}`;
    }
    if (bucket === 'week') { const end = f.addDays(d, 6); return `/metric/${id}?range=week&end=${end < to ? end : to}`; }
    return `/metric/${id}?range=day&end=${d}`;
  };
}

/** A difference in API units, in the person's unit (no offset for a temperature). */
function diffVal(m, d) {
  if (!N(d)) return null;
  if (m.id === 'body_temp' || m.id === 'skin_temp') return f.getPrefs().temp === 'f' ? d * 1.8 : d;
  return val(m, d);
}

/* ── headline ───────────────────────────────────────────────── */

function recoveryWords(v, band) {
  if (!N(v)) return f.DASH;
  const lo = band?.lo ?? -0.3; const hi = band?.hi ?? 0.3;
  return v > hi ? 'Above your usual' : v < lo ? 'Below your usual' : 'Near your usual';
}

function headline(d) {
  const { metric: m, stats: st, range: r, prev, chart: c } = d;
  const u = unitOf(m);
  const day = r.id === 'day';
  const today = r.to === f.today();
  let value; let unit; let extra = '';

  if (m.id === 'recovery') {
    value = day && today && m.latest?.text ? m.latest.text[0].toUpperCase() + m.latest.text.slice(1) : recoveryWords(day ? st.latest?.value : st.avg, c.band);
    unit = day ? '' : `on average this ${RANGE_NAME[r.id]}`;
    return stat({ size: 'l', cls: 'mt-words', value, unit, context: prev && !day ? html`<span>${recoveryWords(prev.avg, c.band)} in ${BEFORE[r.id]}</span>` : '' });
  }
  if (m.kind === 'log') {
    const n = st.entries ?? st.count;
    value = f.int(n);
    unit = m.id === 'period' ? (n === 1 ? 'period' : 'periods') : m.id === 'ecg' ? (n === 1 ? 'reading' : 'readings') : m.id === 'irn' ? (n === 1 ? 'notice' : 'notices') : m.id === 'ovulation' ? (n === 1 ? 'test' : 'tests') : (n === 1 ? 'entry' : 'entries');
    return stat({ size: 'l', value, unit: `${unit} ${day ? 'on this day' : `in this ${RANGE_NAME[r.id]}`}`, context: prev && N(prev.entries) ? html`<span>${f.int(prev.entries)} in ${BEFORE[r.id]}</span>` : '' });
  }

  const weekly = m.goalPer === 'week' && r.id === 'week';
  if (m.kind === 'total' && (day || weekly)) {
    const total = st.total ?? st.avg;
    value = num(m, total);
    unit = N(m.goal) ? `${u ? `${u} ` : ''}of ${num(m, m.goal)}` : u;
    if (N(m.goal) && N(total)) {
      extra = weekly
        ? ''
        : meter({ value: total, goal: m.goal, cls: 'meter--l', label: `${text(m, total)} of your goal of ${text(m, m.goal)}` });
    }
  } else if (day) {
    value = num(m, st.latest?.value ?? st.avg); unit = u;
  } else {
    value = num(m, st.avg);
    unit = m.kind === 'total' ? `${u ? `${u} ` : ''}a ${dayWord(m)}` : `${u ? `${u} ` : ''}on average`;
    if (m.kind === 'total' && m.format === 'duration') unit = `a ${dayWord(m)}`;
  }

  let context = '';
  const running = day && today && m.kind === 'total';
  if (prev && N(prev.avg) && !running) {
    const good = m.betterWhen === 'higher' ? 'up' : m.betterWhen === 'lower' ? 'down' : null;
    const was = weekly ? prev.total : prev.avg;
    const pctFirst = m.kind === 'total' || m.kind === 'stack';
    const chip = pctFirst && N(prev.deltaPct)
      ? delta({ pct: weekly && prev.total ? ((st.total - prev.total) / prev.total) * 100 : prev.deltaPct, good })
      : delta({ abs: diffVal(m, prev.deltaAbs), unit: m.format === 'duration' ? 'min' : (u === '%' || u === 'of 100' ? 'points' : u), good, digits: m.format === 'duration' ? 0 : (m.decimals || m.id === 'weight' ? 1 : 0) });
    context = html`${chip}<span>against ${BEFORE[r.id]} (${text(m, was)})</span>`;
  } else if (!prev && !day) {
    context = html`<span class="muted">Nothing earlier to compare with</span>`;
  }

  const s = stat({ size: 'l', value, unit, context, extra });
  if (weekly && N(m.goal)) {
    const total = st.total ?? 0;
    return html`<div class="ringrow mt-ring">${cardioRing({ minutes: total, target: m.goal, fam: m.family })}${s}</div>`;
  }
  return s;
}

/**
 * The weekly ring: minutes against a weekly target, in a family's colour,
 * with the share in the middle. Used here and fit for Today.
 *   cardioRing({ minutes: 174, target: 180, size: 112 })
 */
export function cardioRing({ minutes, target, fam = 'active', size = 104, stroke = 13 }) {
  const pct = target > 0 ? Math.round(((minutes || 0) / target) * 100) : 0;
  return rings([{ fam, value: minutes || 0, goal: target, label: 'Cardio minutes this week' }], {
    size, stroke,
    inner: `<span class="ring__n">${pct}%</span>`,
  });
}

/* ── the chart ──────────────────────────────────────────────── */

function partsRead(keys, parts) {
  return keys.filter((k) => N(parts?.[k.key])).map((k) => `${k.label.toLowerCase()} ${detailText({ value: parts[k.key], unit: k.unit })}`).join(', ');
}

function figureFor(d) {
  const { metric: m, range: r, chart: c, stats: st } = d;
  const u = unitOf(m);
  const fmt = (cv) => shown(m, cv);
  const tick = (cv) => shown(m, cv, { short: true });
  const pts = c.points || [];
  const keys = c.stackKeys || null;
  const wide = (w) => (w > 620 ? 264 : w > 420 ? 216 : 196);
  const sum = `${m.label} over ${periodLabel(r)}.`;

  // The day by the hour.
  if (c.kind === 'hours') {
    const isRange = pts.some((p) => N(p.lo));
    const byH = new Map(pts.map((p) => [p.h, p]));
    const nowHour = r.to === f.today() && pts.length ? pts[pts.length - 1].h : null;
    const all = Array.from({ length: 24 }, (_, h) => byH.get(h) || null);
    const slot = isRange
      ? chart((w) => hours({ w, h: w > 520 ? 180 : 140, range: all.map((p) => (p ? { lo: p.lo, hi: p.hi, avg: p.value } : null)), unit: u, fmt, nowHour, label: `${sum} Lowest and highest each hour.` }))
      : chart((w) => hours({ w, h: w > 520 ? 180 : 140, values: all.map((p, h) => (p ? val(m, p.value) : (nowHour !== null && h > nowHour ? null : 0))), unit: u, fmt, nowHour, label: `${sum} Each hour of the day.` }));
    const busiest = isRange ? null : pts.reduce((a, p) => (!a || p.value > a.value ? p : a), null);
    return figure(slot, {
      read: isRange ? 'Each bar is an hour: its lowest to its highest, with a tick at the average.' : busiest && busiest.value > 0 ? `Busiest hour: ${String(busiest.h).padStart(2, '0')}:00, ${text(m, busiest.value)}.` : 'Each bar is an hour.',
      note: c.note || '',
      table: tableAlt(['Hour', isRange ? `Lowest (${u})` : `${m.label}${u ? ` (${u})` : ''}`, ...(isRange ? [`Highest (${u})`, `Average (${u})`] : [])],
        pts.map((p) => [`${String(p.h).padStart(2, '0')}:00`, ...(isRange ? [fmt(p.lo), fmt(p.hi), fmt(p.value)] : [fmt(val(m, p.value))])])),
    });
  }

  // One day of something that is not drawn by the hour: its parts, or nothing.
  if (r.id === 'day') {
    const p = pts[0];
    if (!p) return '';
    if (keys && p.parts) {
      const list = keys.filter((k) => N(p.parts[k.key]) && p.parts[k.key] > 0);
      const same = keys.every((k) => k.unit === keys[0].unit);
      return html`<div class="part">
        ${same ? split(list.map((k) => ({ value: p.parts[k.key], cls: m.id === 'sleep_stages' ? STAGE_SW[k.key] : TONE[k.tone], label: k.label }))) : ''}
        ${facts(keys.filter((k) => N(p.parts[k.key])).map((k) => ({ k: html`<span class="legend__sw mt-sw ${m.id === 'sleep_stages' ? STAGE_SW[k.key] : TONE[k.tone]}"></span>${k.label}`, v: detailText({ value: p.parts[k.key], unit: k.unit }) })), { cols: 4, cls: 'facts--s mt-parts' })}
        ${c.note ? html`<p class="chart__note">${c.note}</p>` : ''}
      </div>`;
    }
    if (c.kind === 'range' && N(p.lo) && N(p.hi) && p.hi > p.lo) return html`<p class="mt-span">From <b>${text(m, p.lo)}</b> to <b>${text(m, p.hi)}</b> on this day.${c.note ? ` ${c.note}.` : ''}</p>`;
    return c.note ? html`<p class="chart__note">${c.note}</p>` : '';
  }

  // Buckets over the range. A long range for a short history starts where the data does.
  let dates = buckets(r, c.bucket);
  const byDate = new Map(pts.map((p) => [p.date, p]));
  const firstAt = dates.findIndex((x) => byDate.has(x));
  let since = '';
  if (firstAt > dates.length * 0.2 && dates.length > 8) { since = `Your history of this starts on ${f.dateFull(dates[firstAt])}.`; dates = dates.slice(firstAt); }
  const at = dates.map((x) => byDate.get(x) || null);
  const xText = c.bucket === 'month' ? f.monthShort : c.bucket === 'week' ? f.dayShort : null;
  const readDate = c.bucket === 'month' ? f.monthYear : c.bucket === 'week' ? (x) => `Week of ${f.dayShort(x)}` : f.dayMed;
  const colName = c.bucket === 'month' ? 'Month' : c.bucket === 'week' ? 'Week from' : dayWord(m) === 'night' ? 'Night' : 'Day';
  const colDate = c.bucket === 'month' ? f.monthYear : c.bucket === 'week' ? f.dayShort : f.dayMed;
  const per = c.bucket === 'day' ? `each ${dayWord(m)}` : `each ${c.bucket}`;
  const ex = st.max && st.min && st.count >= 3 && st.max.value !== st.min.value
    ? `Highest ${text(m, st.max.value)} on ${f.dayMed(st.max.date)} · lowest ${text(m, st.min.value)} on ${f.dayMed(st.min.date)}`
    : `One mark for ${per}.`;
  const summed = m.kind === 'total' || m.id === 'zones' || m.id === 'zone_calories';
  const each = c.bucket === 'day' ? '' : `Each ${c.kind === 'line' ? 'point' : 'bar'} is one ${c.bucket}: ${summed ? 'its total' : `an average ${dayWord(m)} in it`}.`;
  const note = [each, since, c.note].filter(Boolean).join(' ');
  const values = at.map((p) => (p ? val(m, p.value) : null));
  const table = (cols, row) => tableAlt([colName, ...cols], dates.map((x, i) => (at[i] ? [colDate(x), ...row(at[i])] : null)).filter(Boolean).reverse());
  const unitCol = `${m.label}${u ? ` (${u})` : ''}`;

  if (c.kind === 'stack' || (c.kind === 'bars' && keys && keys.every((k) => k.unit === (m.unit || '')))) {
    const cls = (k) => (m.id === 'sleep_stages' ? STAGE_CLS[k.key] : TONE[k.tone]) || 't-mid';
    const labels = dates.map((x) => (c.bucket === 'month' ? f.monthShort(x) : c.bucket === 'day' && dates.length <= 8 ? f.dow(x) : f.dayShort(x)));
    return figure(chart((w) => stacked({
      w, h: wide(w), labels, readLabels: dates.map(readDate), go: drillTo(m, c.bucket, dates, r.to),
      series: keys.map((k) => ({ label: k.label, cls: cls(k), values: at.map((p) => (p?.parts && N(p.parts[k.key]) ? p.parts[k.key] : null)) })),
      fmt, tick, unit: m.format === 'duration' ? '' : u, label: `${sum} ${keys.map((k) => k.label).join(', ')}, stacked for ${per}.`,
    })), {
      read: ex, note,
      legendItems: keys.map((k) => [m.id === 'sleep_stages' ? STAGE_SW[k.key] : TONE[k.tone], k.label]),
      table: table([...keys.map((k) => `${k.label} (${k.unit})`), `Total${u ? ` (${u})` : ''}`], (p) => [...keys.map((k) => (N(p.parts?.[k.key]) ? detailText({ value: p.parts[k.key], unit: null }) : f.DASH)), fmt(val(m, p.value))]),
    });
  }

  if (c.kind === 'range') {
    return figure(chart((w) => spans({
      w, h: wide(w), dates, go: drillTo(m, c.bucket, dates, r.to), items: at.map((p) => (p ? { lo: val(m, p.lo ?? p.value), hi: val(m, p.hi ?? p.value), value: val(m, p.value) } : null)),
      band: c.band ? { lo: val(m, c.band.lo), hi: val(m, c.band.hi) } : null, fmt, tick, unit: u, xText, readDate,
      label: `${sum} The lowest and the highest of ${per}, with the average marked.`,
    })), {
      read: `Lowest ${text(m, st.min?.value)} on ${st.min ? f.dayMed(st.min.date) : f.DASH} · highest ${text(m, st.max?.value)} on ${st.max ? f.dayMed(st.max.date) : f.DASH}`, note,
      legendItems: [['sw-under', `Lowest to highest, ${per}`], ['sw-inkline', 'Average'], c.band ? ['sw-band', 'Your usual average'] : null].filter(Boolean),
      table: table([`Lowest (${u})`, `Highest (${u})`, `Average (${u})`], (p) => [fmt(val(m, p.lo ?? p.value)), fmt(val(m, p.hi ?? p.value)), fmt(val(m, p.value))]),
    });
  }

  const bars = c.kind === 'bars';
  const goal = N(c.goal) ? val(m, c.goal) : undefined;
  const band = !bars && c.band ? { lo: val(m, c.band.lo), hi: val(m, c.band.hi) } : null;
  const extraRead = keys ? at.map((p) => (p?.parts ? partsRead(keys, p.parts) : '')) : null;
  return figure(chart((w) => trend({
    w, h: wide(w), dates, values, go: drillTo(m, c.bucket, dates, r.to), kind: bars ? 'bars' : 'line', band, goal, goalLabel: m.goalPer === 'week' ? 'Target' : 'Goal',
    fmt, tick, unit: u, xText, readDate, readExtra: extraRead, lowIsBest: m.betterWhen !== 'higher', zero: bars,
    label: `${sum} One ${bars ? 'bar' : 'point'} for ${per}.${band ? ` Your usual range is ${fmt(band.lo)} to ${fmt(band.hi)}${u ? ` ${u}` : ''}.` : ''}${goal !== undefined ? ` The ${m.goalPer === 'week' ? 'target' : 'goal'} is ${fmt(goal)}${u ? ` ${u}` : ''}.` : ''}`,
  })), {
    read: ex, note,
    legendItems: bars
      ? (goal !== undefined ? [['sw-met', m.goalPer === 'week' ? 'At target' : 'At goal'], ['sw-under', m.goalPer === 'week' ? 'Under target' : 'Under goal']] : null)
      : [['sw-met', `Each ${c.bucket === 'day' ? dayWord(m) : `${c.bucket}'s average`}`], band ? ['sw-band', 'Your usual range'] : null].filter(Boolean),
    table: table([unitCol, ...(keys ? keys.map((k) => `${k.label} (${k.unit})`) : [])], (p) => [fmt(val(m, p.value)), ...(keys ? keys.map((k) => (N(p.parts?.[k.key]) ? f.int(p.parts[k.key]) : f.DASH)) : [])]),
  });
}

/* A log has no chart of values, but when it happened is worth seeing: a
   strip of the period's days, filled where something was logged. */
const LOG_NOUN = { ecg: ['reading', 'readings'], irn: ['notice', 'notices'], ovulation: ['test', 'tests'] };
function logFigure(d) {
  const { metric: m, range: r, chart: c } = d;
  const pts = c.points || [];
  if (r.id === 'day' || !pts.length) return '';
  const dates = buckets(r, c.bucket);
  const idx = new Map(dates.map((x, i) => [x, i]));
  const counts = dates.map(() => 0);
  const period = m.id === 'period';
  for (const p of pts) {
    const i = idx.get(p.date);
    if (i === undefined) continue;
    if (period && c.bucket === 'day') { for (let k = 0; k < Math.max(1, p.days || 1) && i + k < counts.length; k += 1) counts[i + k] = 1; }
    else counts[i] += period ? (p.days || p.value || 1) : (p.n || 1);
  }
  if (!counts.some((x) => x > 0)) return '';
  const unitName = c.bucket === 'day' ? 'day' : c.bucket;
  const readDate = c.bucket === 'month' ? f.monthYear : c.bucket === 'week' ? (x) => `Week of ${f.dayShort(x)}` : f.dayMed;
  const [one, many] = period ? ['period day', 'period days'] : (LOG_NOUN[m.id] || ['entry', 'entries']);
  const reads = dates.map((x, i) => `${readDate(x)}: ${counts[i] > 0 ? (period && c.bucket === 'day' ? 'a period day' : f.plural(counts[i], one, many)) : (period ? 'no period logged' : 'nothing logged')}`);
  const xText = c.bucket === 'month' ? f.monthShort : c.bucket === 'week' ? f.dayShort : null;
  const multi = !period && counts.some((x) => x > 1);
  return figure(chart((w) => logStrip({ w, dates, counts, reads, solid: period, xText, go: drillTo(m, c.bucket, dates, r.to), label: `${m.label} over ${periodLabel(r)}: each square is one ${unitName}, filled where something was logged.` })), {
    read: `Each square is one ${unitName}, filled where ${period ? 'a period was logged' : 'something was logged'}.`,
    legendItems: period ? null : multi ? [['sw-under', `One ${one}`], ['sw-met', 'Two or more']] : null,
  });
}

/* ── facts, about ───────────────────────────────────────────── */

function factList(d) {
  const { metric: m, stats: st, range: r, chart: c } = d;
  const u = unitOf(m);
  const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;
  const log = m.kind === 'log';
  const n = (v) => num(m, v);
  const one = r.id === 'day';
  return facts([
    !log && !one && N(st.avg) ? { k: `Average a ${dayWord(m)}`, v: n(st.avg), u } : null,
    N(st.total) && !one && !log ? { k: 'Total', v: n(st.total), u } : null,
    !log && st.min && st.count > 1 ? { k: 'Lowest', v: n(st.min.value), u, s: f.dayMed(st.min.date) } : null,
    !log && st.max && st.count > 1 ? { k: 'Highest', v: n(st.max.value), u, s: f.dayMed(st.max.date) } : null,
    !log && st.latest ? { k: 'Latest', v: n(st.latest.value), u, s: f.dayRel(st.latest.date) } : null,
    N(m.goal) ? { k: m.goalPer === 'week' ? 'Weekly target' : 'Daily goal', v: n(m.goal), u, s: 'Set in Me, Goals' } : null,
    c.band && m.id !== 'recovery' ? { k: 'Your usual range', v: `${n(c.band.lo)}–${n(c.band.hi)}`, u, s: 'The middle half of the last 90 days' } : null,
    N(st.entries) ? { k: 'Entries', v: f.int(st.entries) } : null,
    !one ? { k: `${dayWord(m) === 'night' ? 'Nights' : 'Days'} with data`, v: `${f.int(st.count)} of ${f.int(days)}` } : null,
  ], { cols: 2, cls: 'facts--s' });
}

function about(d, scored) {
  const m = d.metric;
  const partsBlock = scored?.parts?.length ? html`<div class="part mt-score">
      <p class="sub">${f.dayRel(scored.date) === 'Today' ? 'Last night' : `The night of ${f.dayMed(scored.date)}`}: ${f.int(scored.value)} of 100</p>
      <ul class="mt-partlist">${scored.parts.map((p) => html`<li>
        <span class="mt-part__k">${p.label}</span><span class="mt-part__v">${numTidy(p.points)}<small> of ${f.int(p.max)}</small></span>
        ${meter({ value: p.points, goal: p.max, label: `${p.label}: ${numTidy(p.points)} of ${p.max} points` })}
        ${p.text ? html`<span class="mt-part__d">${p.text}</span>` : ''}
      </li>`)}</ul>
    </div>` : '';
  return mod({
    title: m.own ? 'How this is worked out' : 'About', icon: m.own ? 'spark' : 'info', cls: 'mt-about', id: 'mt-about',
    body: html`
      <p class="prose small">${m.own && m.ownNote ? m.ownNote : m.about}</p>
      ${partsBlock}
      ${m.own && m.ownNote ? html`<p class="prose small">${m.about}</p>` : ''}
      ${m.id === 'recovery' ? html`<p class="prose small">The numbers on this page are in SD: one SD is your own ordinary day-to-day spread, and 0 is your usual.</p>` : ''}
      <ul class="mt-notes">
        ${m.provides ? html`<li>${ic(/^Log /.test(m.provides) ? 'edit' : 'watch', { size: 's' })}<span>${m.provides}</span></li>` : ''}
        ${m.sensitive ? html`<li>${ic('lock', { size: 's' })}<span>Always private: never on your profile, the leaderboard or compare.</span></li>` : ''}
      </ul>`,
  });
}
const numTidy = (v) => (Number.isInteger(v) ? f.int(v) : f.dec1(v));

/* ── entries ────────────────────────────────────────────────── */

const GOOGLE_WORDS = {
  saved: 'also in Google Health', local: 'on this site only', failed: 'not in Google Health yet',
  pending: 'waiting to go to Google Health', create_only: 'also in Google Health, where it can only be changed there',
};

function entryRow(m, e, d) {
  const dayKind = e.kind === 'day';
  const whenText = dayKind ? f.dayRel(e.date) : e.kind === 'period' ? f.dayRel(e.date) : f.dateTime(e.t);
  const src = e.source === 'app' ? 'Logged here' : e.source === 'calculated' ? 'Calculated by this app' : e.source === 'scale' ? 'Xiaomi scale' : `Google Health${e.device ? ` · ${e.device}` : ''}`;
  const g = e.source === 'app' && e.google ? GOOGLE_WORDS[e.google] : '';
  let why = '';
  if (!dayKind && !e.editable) {
    if (e.kind === 'workout') why = html`<a class="link" href="/workouts/${encodeURIComponent(e.id)}">Open it in Workouts to change it</a>`;
    else if (e.source === 'scale') why = 'From your Xiaomi scale: change or remove it in Xiaomi Home.';
    else if (e.kind === 'weight') why = 'Kept in Google Health: change or remove it in the Google Health app.';
    else if (e.source === 'google') why = 'Came from Google Health and can only be changed there.';
    else if (e.source === 'app' && m.group && groupOf(m.group)?.mode === 'off') why = 'Cannot be changed while its group is off.';
  }
  const note = e.fields?.note;
  const details = (e.details || []).filter((x) => x.value !== null && x.value !== undefined);
  return html`<li class="ent" data-entry="${e.id}">
    <div class="ent__b">
      <p class="ent__top"><span class="ent__v">${entryText(m, e)}</span>${dayKind ? html`<span class="ent__when">${whenText}</span>` : ''}</p>
      ${details.length ? html`<p class="ent__det">${details.map((x) => html`<span><span class="muted">${x.label}</span> ${detailText(x)}</span>`)}</p>` : ''}
      ${note ? html`<p class="ent__note">${note}</p>` : ''}
      ${dayKind ? '' : html`<p class="ent__src"><span class="ent__at">${whenText}</span> · ${src}${g ? `, ${g}` : ''}${e.error ? html` <span class="ent__err">(${e.error})</span>` : ''}</p>`}
      ${why ? html`<p class="ent__why">${ic('lock', { size: 's' })}<span>${why}</span></p>` : ''}
    </div>
    ${e.editable || e.deletable ? html`<div class="ent__act">
      ${e.editable && d.add ? html`<button type="button" class="iconbtn" data-edit="${e.id}" aria-label="Change this entry: ${esc(e.text || '')}">${ic('edit', { size: 's' })}</button>` : ''}
      ${e.deletable ? html`<button type="button" class="iconbtn" data-del="${e.id}" aria-label="Delete this entry: ${esc(e.text || '')}">${ic('trash', { size: 's' })}</button>` : ''}
    </div>` : ''}
  </li>`;
}

/* ── the page ───────────────────────────────────────────────── */

export default async function metricPage(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  const asked = ctx.query.get('range');
  let range = RANGES.some(([k]) => k === asked) ? asked : null;
  if (!range) { try { const s = sessionStorage.getItem(RANGE_KEY); if (RANGES.some(([k]) => k === s)) range = s; } catch { /* default */ } }
  range = range || 'week';
  let end = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.get('end') || '') ? ctx.query.get('end') : null;
  let data = null;
  let older = [];           // pages fetched with before=
  let more = false;
  let shownN = FIRST;
  let seq = 0;
  let failed = null;
  const cameFromBrowse = history.state?.from === '/trends';

  const gq = ctx.query.get('google');
  if (gq) {
    const grant = groupGrantToast(gq);
    if (grant) toast(grant.text, { tone: grant.tone, ms: 7000 });
    else if (gq === 'connected') toast('Google allowed it. It is on now.');
    else if (gq === 'cancelled') toast('Nothing was changed at Google.');
    else toast(ctx.query.get('message') || 'Google could not be asked. Try again.', { tone: 'bad', ms: 8000 });
  }

  const url = () => `/metric/${encodeURIComponent(id)}?range=${range}${end ? `&end=${end}` : ''}`;
  const sync = () => { history.replaceState(history.state, '', url()); try { sessionStorage.setItem(RANGE_KEY, range); } catch { /* fine */ } };
  sync();

  const entries = () => [...(data?.entries || []), ...older];

  function header() {
    const m = data?.metric;
    return html`<header class="mt-head ${m ? `fam fam-${m.family}` : ''}">
      <a class="back" href="/trends" data-back aria-label="Back to Browse">${ic('left')}</a>
      ${m ? ib(metricIcon(m), { size: 'l' }) : html`<span class="skel mt-head__skel"></span>`}
      <div class="mt-head__t">
        ${m ? html`<h1 class="head__title" tabindex="-1">${m.label}</h1>` : html`<h1 class="head__title sr" tabindex="-1">Loading</h1><span class="skel skel--title"></span>`}
        ${m ? html`<p class="mt-head__s">${m.own ? ownTag() : (m.category ? m.category[0].toUpperCase() + m.category.slice(1) : '')}</p>` : ''}
      </div>
      ${m ? html`<div class="head__actions">${m.sensitive ? '' : aiButton('metric', { id: m.id, label: 'Ask AI' })}${pinButton(m)}${data.add ? html`<button type="button" class="btn btn--s mt-add" data-action="add">${ic('plus', { size: 's' })}<span>Add</span></button>` : ''}</div>` : ''}
    </header>`;
  }

  function bar() {
    const r = data?.range;
    return html`<div class="mt-bar">
      ${seg('range', RANGES, range, { label: 'Period length' })}
      <div class="mt-nav" role="group" aria-label="Period">
        <button type="button" class="iconbtn" data-step="prev" aria-label="The ${RANGE_NAME[range]} before" ${r?.canPrev ? '' : 'disabled'}>${ic('left')}</button>
        <p class="mt-nav__t" aria-live="polite">${r ? periodLabel(r) : raw('&nbsp;')}</p>
        <button type="button" class="iconbtn" data-step="next" aria-label="The ${RANGE_NAME[range]} after" ${r?.canNext ? '' : 'disabled'}>${ic('right')}</button>
      </div>
    </div>`;
  }

  function mainModule() {
    const d = data; const m = d.metric; const st = d.stats;
    const inRange = d.entries.some((e) => e.inRange);
    const nothing = !st.count && !st.entries && !inRange;
    const thin = /^Not enough/.test(d.reading || '');
    const quick = d.add?.available && d.add.quick?.length ? html`<div class="mt-quick"><span class="sub">One tap</span>${quickButtons(d.add)}</div>` : '';
    if (nothing) {
      const never = !m.latest;
      return mod({
        fam: m.family, cls: 'mt-main', label: m.label,
        body: html`<div class="empty empty--inline mt-empty">
          <p class="empty__t">${never ? 'No data yet' : d.range.id === 'day' ? 'Nothing recorded on this day' : `Nothing recorded in this ${RANGE_NAME[d.range.id]}`}</p>
          <p class="empty__d">${never ? `${m.provides || d.reading}.` : d.range.canPrev ? 'There is something earlier.' : 'Try a longer period.'}</p>
          <div class="btnrow">
            ${d.range.canPrev ? html`<button type="button" class="btn btn--tonal btn--s" data-step="prev">${ic('left', { size: 's' })}The ${RANGE_NAME[d.range.id]} before</button>` : ''}
            ${d.add ? html`<button type="button" class="btn btn--s" data-action="add">${ic('plus', { size: 's' })}Add</button>` : ''}
          </div>
        </div>${quick}`,
      });
    }
    const fig = m.kind === 'log' || d.chart.kind === 'log' ? logFigure(d) : thin
      ? html`<p class="toofew">${ic('clock', { size: 's' })}<span>${d.reading} A chart of so few would mislead; it appears by itself as the days add up.</span></p>`
      : figureFor(d);
    return mod({
      fam: m.family, cls: 'mt-main', label: m.label,
      body: html`
        <div class="mt-hero">${headline(d)}${d.reading && !thin && !(m.kind === 'log' && /^\d+ entr/.test(d.reading)) ? html`<p class="mt-reading">${d.reading}</p>` : ''}</div>
        ${quick}
        ${fig ? html`<div class="mt-fig">${fig}</div>` : ''}`,
    });
  }

  function entriesModule() {
    const d = data; const m = d.metric;
    const all = entries();
    if (!all.length) return '';
    const list = all.slice(0, shownN);
    const inR = list.filter((e) => e.inRange); const out = list.filter((e) => !e.inRange);
    const canMore = all.length > shownN || more;
    const dayKind = all[0].kind === 'day';
    return mod({
      title: dayKind ? (m.category === 'sleep' ? 'Night by night' : 'Day by day') : 'Entries', icon: 'list', cls: 'mt-entries', id: 'mt-entries',
      note: !dayKind ? 'Newest first' : m.own ? 'Newest first. Calculated by this app, so there is nothing to change here.'
        : `Newest first. From Google Health${all[0].device ? ` (${all[0].device})` : ''}; these cannot be changed here.`,
      body: html`
        ${inR.length ? html`<div class="part">${out.length || d.range.id !== 'week' ? html`<p class="sub">In this ${RANGE_NAME[d.range.id]}</p>` : ''}<ul class="ents ${dayKind ? 'ents--days' : ''}">${inR.map((e) => entryRow(m, e, d))}</ul></div>` : ''}
        ${out.length ? html`<div class="part"><p class="sub">Earlier</p><ul class="ents ${dayKind ? 'ents--days' : ''}">${out.map((e) => entryRow(m, e, d))}</ul></div>` : ''}
        ${canMore ? html`<div><button type="button" class="btn btn--tonal btn--s" data-action="more">Show more</button></div>` : ''}`,
    });
  }

  function page() {
    if (failed) return failed;
    if (!data) return html`<div class="skelstack" aria-busy="true" aria-label="Loading"><div class="skel skel--tall"></div><div class="skel skel--block"></div></div>`;
    const scored = data.entries.find((e) => e.inRange && e.parts?.length) || data.entries.find((e) => e.parts?.length);
    return html`<div class="mt-cols">
      <div class="mt-col mt-col--a">${mainModule()}${entriesModule()}</div>
      <div class="mt-col mt-col--b">
        ${data.stats.count || data.stats.entries ? mod({ title: `${data.range.id === '6m' ? (data.range.to === f.today() ? 'These' : 'Those') : (data.range.to === f.today() ? 'This' : 'That')} ${RANGE_NAME[data.range.id]}`, icon: 'trends', fam: data.metric.family, cls: 'mt-facts', id: 'mt-facts', body: factList(data) }) : ''}
        ${about(data, scored)}
      </div>
    </div>`;
  }

  function paint({ keep = false } = {}) {
    const y = window.scrollY;
    mount(root, html`
      ${header()}
      ${failed ? '' : bar()}
      <div class="mt-body ${data ? `fam fam-${data.metric.family}` : ''}">${page()}</div>`);
    if (data) document.title = `${data.metric.label} · Health`;
    for (const c of root.querySelectorAll('.mt-fig .chart')) { c.tabIndex = 0; c.setAttribute('role', 'group'); c.setAttribute('aria-label', 'Chart. Use the left and right arrow keys to read each point.'); }
    if (keep) window.scrollTo(0, y);
  }

  function fail(err) {
    if (err.code === 'group_off') {
      const g = groupOf(err.detail?.group);
      failed = html`<div class="mod"><div class="empty">
        <span class="empty__ic">${ic('lock')}</span>
        <p class="empty__t">${g?.label || 'This'} is off</p>
        <p class="empty__d">${g?.about || 'This belongs to a group of data you have not turned on.'} ${ALWAYS_PRIVATE}</p>
        <div class="btnrow"><a class="btn btn--tonal btn--s" href="/trends">Back to Browse</a>${err.detail?.group ? html`<button type="button" class="btn btn--s" data-group="${err.detail.group}">Turn on</button>` : ''}</div>
      </div></div>`;
    } else if (err.status === 404) {
      failed = html`<div class="mod"><div class="empty"><span class="empty__ic">${ic('help')}</span><p class="empty__t">There is no such metric</p><p class="empty__d">The link may be old or mistyped.</p><a class="btn btn--tonal btn--s" href="/trends">Back to Browse</a></div></div>`;
    } else failed = errorState(err);
  }

  async function load({ quiet = false } = {}) {
    const mine = seq += 1;
    if (!quiet) {
      if (data) root.querySelector('.mt-body')?.classList.add('is-loading');
      else paint();
    }
    try {
      const d = await api.get(`/api/metric/${encodeURIComponent(id)}?range=${range}${end ? `&end=${end}` : ''}`);
      if (!ctx.alive() || mine !== seq) return;
      const first = !data;
      data = d; failed = null; older = []; more = d.more;
      if (!quiet) shownN = FIRST;
      paint({ keep: !first });
    } catch (err) {
      if (!ctx.alive() || mine !== seq) return;
      if (quiet && data) return;
      data = null; fail(err); paint();
    }
  }

  const stepTo = (dir) => {
    const r = data?.range;
    if (!r) return;
    if (dir === 'prev' && r.canPrev) end = r.prevEnd;
    else if (dir === 'next' && r.canNext) end = r.nextEnd >= f.today() ? null : r.nextEnd;
    else return;
    sync(); load();
  };

  on(root, 'click', '[data-seg="range"]', (e, b) => {
    if (b.dataset.value === range) return;
    range = b.dataset.value;
    for (const o of root.querySelectorAll('[data-seg="range"]')) o.setAttribute('aria-pressed', String(o === b));
    sync(); load();
  });
  on(root, 'click', '[data-step]', (e, b) => stepTo(b.dataset.step));
  on(root, 'click', '[data-back]', (e) => {
    // Came from Browse: go back to it as it was (scroll, search). Otherwise the link itself goes there.
    if (cameFromBrowse && history.length > 1) { e.preventDefault(); e.stopPropagation(); history.back(); }
  });
  on(root, 'click', '[data-action="retry"]', () => { failed = null; load(); });
  on(root, 'click', '[data-action="add"]', () => { if (data?.add) entrySheet({ metric: data.metric, add: data.add, onSaved: () => load({ quiet: true }) }); });
  on(root, 'click', '[data-quick]', async (e, b) => {
    if (b.closest('dialog') || b.disabled || !data?.add) return;
    b.disabled = true; b.classList.add('is-busy');
    const r = await quickAdd(data.add, data.add.quick[Number(b.dataset.quick)], { label: `${data.add.quick[Number(b.dataset.quick)].label} of ${data.metric.label.toLowerCase()}` });
    b.disabled = false; b.classList.remove('is-busy');
    if (r) load({ quiet: true });
  });
  on(root, 'click', '[data-edit]', (e, b) => {
    const en = entries().find((x) => x.id === b.dataset.edit);
    if (en && data?.add) entrySheet({ metric: data.metric, add: data.add, entry: en, onSaved: () => load({ quiet: true }) });
  });
  on(root, 'click', '[data-del]', async (e, b) => {
    const en = entries().find((x) => x.id === b.dataset.del);
    if (en && await deleteEntry(data.metric, { ...en, text: entryText(data.metric, en) })) load({ quiet: true });
  });
  on(root, 'click', '[data-action="more"]', async (e, b) => {
    const all = entries();
    if (all.length > shownN) { shownN += STEP; paint({ keep: true }); return; }
    if (!more || b.classList.contains('is-busy')) return;
    b.classList.add('is-busy');
    try {
      const last = all[all.length - 1];
      const d = await api.get(`/api/metric/${encodeURIComponent(id)}?range=${range}${end ? `&end=${end}` : ''}&before=${last.t}`);
      if (!ctx.alive()) return;
      const have = new Set(all.map((x) => x.id));
      older = [...older, ...d.entries.filter((x) => !have.has(x.id))];
      more = d.more;
      shownN += STEP;
      paint({ keep: true });
    } catch (err) { b.classList.remove('is-busy'); toast(err.message || 'Those did not load. Try again.', { tone: 'bad' }); }
  });
  on(root, 'click', '[data-group]', async (e, b) => {
    if (await turnOnGroup(b.dataset.group, { ret: `/metric/${encodeURIComponent(id)}` })) { failed = null; load(); }
  });
  bindPins(root, { changed: (pinned) => { if (data) data.metric.pinned = pinned.includes(id); } });

  ctx.onLeave(listen('changed', (what) => { if (what.includes('data')) load({ quiet: true }); }));
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
  if (!ctx.alive()) return;
  // An unknown range in the address is put right, and the tab bar keeps "Browse" lit through main.js.
  if (data && data.range.id !== range) { range = data.range.id; sync(); }
}
