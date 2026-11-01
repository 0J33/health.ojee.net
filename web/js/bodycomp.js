/* The Body composition screen: /metric/body_composition, drawn from the
   payload's `body` (docs/API.md, "Body composition"). The latest weigh-in
   in full: the body score as a ring, weight and body type; the weight
   goals in plain words; then every number the scale sent or we worked out
   from it, each with its range as a small segmented bar, the change since
   the weigh-in before, and its history in a sheet on tap.

   Everything that is not the scale's own number is labelled ours. The
   ranges are the standard ranges the scale's app uses: wellness, not
   medical advice, and drawn in the calm palette (no alarm colours). */

import { html, ic, chart, on, esc } from './ui.js';
import { rings, delta, figure } from './kit.js';
import { tableAlt } from './charts.js';
import { trend } from './viz.js';
import { openMore } from './metrics.js';
import { rangeBar as sharedBar, rangeBadge, bandFacts } from './ranges.js';
import * as f from './format.js';

const N = f.isNum;
const GROUPS = [['main', 'Weight'], ['fat', 'Fat'], ['lean', 'Muscle, water and bone'], ['energy', 'Energy and age']];
const OURS = 'Our estimate';

/* ── numbers in the person's units ──────────────────────────── */

const isKg = (m) => m.unit === 'kg';
const cv = (m, v) => (N(v) ? (isKg(m) ? f.weightVal(v) : v) : null);
const unitOf = (m) => (isKg(m) ? f.weightUnit() : m.unit || '');
const nf = [0, 1, 2].map((d) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt = (m, v) => (N(v) ? nf[Math.min(2, m.decimals ?? 1)].format(v) : f.DASH);
/** A number of a metric, converted, with its unit: "62.1 kg", "18.2%", "1,700 kcal". */
const say = (m, v) => { if (!N(v)) return f.DASH; const u = unitOf(m); const s = fmt(m, cv(m, v)); return !u ? s : u === '%' ? `${s}%` : `${s} ${u}`; };
const kg = (v) => `${f.dec1(f.weightVal(Math.abs(v)))} ${f.weightUnit()}`;

/* ── the range bar (ranges.js, shared with every metric page) ── */

/** A number's bands in the shared shape: the standard band is the 'ok' one. */
const bandsOf = (r) => r.bands.map((b) => ({ label: b.label, lo: b.lo, hi: b.hi, tone: b.std ? 'ok' : 'none' }));

/** The bands as a segmented bar, a dot at the value and the band names under it. */
export function rangeBar(m, { compact = false } = {}) {
  const r = m.range;
  if (!r?.bands?.length) return '';
  return sharedBar({ bands: bandsOf(r), at: r.at, value: m.value, compact, label: `${m.label}: ${say(m, m.value)}, ${r.label || 'outside the ranges'}` });
}

/** The bands in numbers, for a sheet: "Standard  18.5 to 25". */
function bandList(m) {
  const r = m.range;
  if (!r) return '';
  const u = unitOf(m);
  return bandFacts({ bands: bandsOf(r), at: r.at, edge: (v) => fmt(m, cv(m, v)), tail: u ? (u === '%' ? '%' : ` ${u}`) : '' });
}
const badge = (m) => (m.range?.label ? rangeBadge(m.range.label, m.range.bands[m.range.at]?.std ? 'ok' : 'none') : '');

/* ── the pieces ─────────────────────────────────────────────── */

function changeText(m) {
  if (!N(m.change)) return '';
  const c = cv(m, m.change);
  return delta({ abs: c, unit: unitOf(m) === '%' ? (Math.abs(c) >= 0.95 && Math.abs(c) < 1.05 ? 'point' : 'points') : unitOf(m), good: null, digits: m.decimals ? 1 : 0, text: '' });
}

function scoreRing(s, size) {
  return rings([{ fam: 'body', value: s.value, goal: 100, label: 'Body score' }], {
    size, stroke: size > 100 ? 11 : 9,
    inner: `<span class="bc-ring__n">${s.value}</span><span class="bc-ring__u">${esc(s.word || '')}</span>`,
  });
}

function hero(b, metrics) {
  const w = metrics.find((m) => m.id === 'weightKg');
  const when = f.dateTime(b.at);
  return html`<section class="bt bt--body bc-hero" aria-label="Latest weigh-in">
    <div class="bt__row"><span class="bt__lab">${ic('scale')}Latest weigh-in</span><span class="bt__meta">${when}</span></div>
    <div class="bc-hero__b">
      ${b.score ? html`<button type="button" class="bc-hero__ring" data-bc="score" aria-label="Body score ${b.score.value} of 100, ${b.score.word}. ${OURS}. What it is made of">${scoreRing(b.score, 112)}</button>` : ''}
      <div class="bc-hero__t">
        ${w ? html`<p class="n n-hero bc-hero__n">${fmt(w, cv(w, w.value))}<span class="u">${unitOf(w)}</span></p>` : ''}
        ${w && N(w.change) ? html`<p class="bt__sub bc-hero__s">${changeText(w)}<span>since the weigh-in before</span></p>` : ''}
        ${b.bodyType ? html`<button type="button" class="bc-type" data-bc="type"><span class="bc-type__k">Body type</span><span class="bc-type__v">${b.bodyType.label}</span></button>` : ''}
      </div>
    </div>
    ${b.score || b.bodyType?.from === 'estimate' ? html`<p class="bc-hero__own">${b.score ? 'Body score and body type: our estimate, worked out the way the Xiaomi app does' : 'Body type: our estimate, worked out the way the Xiaomi app does'}</p>` : ''}
  </section>`;
}

function needsRow(b) {
  if (!b.needs?.length) return '';
  const want = b.needs.filter((x) => x !== 'height');
  const text = want.length ? 'Add your sex and year of birth for ranges' : 'Add your height for every range';
  const href = want.length ? '/settings/account' : '/metric/height';
  return html`<a class="bc-need" href="${href}">${ic('info', { size: 's' })}<span>${text}</span>${ic('chev_r', { size: 's' })}</a>`;
}

/** The weight goals, in plain words. */
function goals(b) {
  const g = b.goals || {};
  const items = [];
  if (N(g.standardWeight)) {
    const d = g.weightControl;
    items.push({ k: 'Standard weight', v: kg(g.standardWeight), s: !N(d) || Math.abs(d) < 0.1 ? 'You are at it' : `${kg(d)} to ${d > 0 ? 'lose' : 'gain'} to reach it` });
  }
  if (N(g.fatControl)) items.push({ k: 'Fat control', v: Math.abs(g.fatControl) < 0.1 ? 'In range' : `${g.fatControl > 0 ? '−' : '+'}${kg(g.fatControl)}`, s: Math.abs(g.fatControl) < 0.1 ? 'Body fat is in the standard range' : `${kg(g.fatControl)} of fat to ${g.fatControl > 0 ? 'lose' : 'gain'} to reach the standard range` });
  if (N(g.muscleControl)) items.push({ k: 'Muscle control', v: Math.abs(g.muscleControl) < 0.1 ? 'In range' : `+${kg(g.muscleControl)}`, s: Math.abs(g.muscleControl) < 0.1 ? 'Muscle is at or above the standard range' : `${kg(g.muscleControl)} of muscle to gain to reach the standard range` });
  if (!items.length) return '';
  return html`<section class="bt bt--plain fam fam-body bc-goals" aria-labelledby="bc-goals-h">
    <div class="bt__row"><h2 class="bt__lab" id="bc-goals-h">${ic('target')}Weight goals</h2><span class="bt__meta">${OURS}</span></div>
    <ul class="bc-goals__l">${items.map((x) => html`<li><span class="bc-goals__k">${x.k}</span><span class="bc-goals__v n">${x.v}</span><span class="bc-goals__s">${x.s}</span></li>`)}</ul>
  </section>`;
}

function row(m) {
  const tag = m.from === 'tape' ? 'From your tape' : m.sent ? '' : OURS;
  return html`<li><button type="button" class="bc-row" data-bc="m:${m.id}">
    <span class="bc-row__t"><span class="bc-row__k">${m.label}</span>${tag ? html`<span class="bc-row__own">${tag}</span>` : ''}</span>
    <span class="bc-row__v n">${fmt(m, cv(m, m.value))}${unitOf(m) ? html`<span class="u">${unitOf(m) === '%' ? '%' : ` ${unitOf(m)}`}</span>` : ''}</span>
    ${m.range ? html`<span class="bc-row__b">${rangeBar(m, { compact: true })}</span>` : ''}
    <span class="bc-row__s">${badge(m)}${N(m.vsAge) ? html`<span>${m.vsAge === 0 ? 'your age' : `${Math.abs(m.vsAge)} ${Math.abs(m.vsAge) === 1 ? 'year' : 'years'} ${m.vsAge < 0 ? 'under' : 'over'} your age`}</span>` : ''}${changeText(m)}</span>
  </button></li>`;
}

/** The whole screen above the chart: hero, the quiet row, goals, every number. */
export function bodyScreen(b) {
  if (!b) return '';
  const ms = b.metrics || [];
  return html`<div class="bc">
    ${hero(b, ms)}
    ${needsRow(b)}
    ${goals(b)}
    ${GROUPS.map(([g, title]) => { const list = ms.filter((m) => m.group === g); return list.length ? html`<section class="bc-grp" aria-label="${title}"><h2 class="bc-grp__h">${title}</h2><ul class="bc-rows">${list.map(row)}</ul></section>` : ''; })}
    <p class="bc-note">${b.note}</p>
  </div>`;
}

/* ── sheets ─────────────────────────────────────────────────── */

/** One number over the last weigh-ins: a line, one point per day (its last weigh-in). */
function historyFig(b, m) {
  const byDate = new Map();
  for (const h of b.history || []) if (N(h.v[m.id === 'score' ? 'score' : m.id])) byDate.set(h.date, h.v[m.id === 'score' ? 'score' : m.id]);
  const dates = [...byDate.keys()];
  if (dates.length < 2) return html`<p class="chart__note">One weigh-in so far. The chart starts with the next.</p>`;
  const values = dates.map((d) => cv(m, byDate.get(d)));
  const std = m.range?.bands?.find((x) => x.std);
  const band = std && std.lo !== null && std.hi !== null ? { lo: cv(m, std.lo), hi: cv(m, std.hi) } : null;
  const u = unitOf(m);
  const fm = (v) => fmt(m, v);
  return figure(chart((w) => trend({ w, h: w > 420 ? 200 : 168, dates, values, kind: 'line', band, fmt: fm, unit: u, xText: f.dayShort, readDate: f.dayMed, extremes: false,
    label: `${m.label} at each weigh-in, ${f.dayShort(dates[0])} to ${f.dayShort(dates.at(-1))}.${band ? ` The standard range is shaded.` : ''}` })), {
    read: `${dates.length} weigh-ins, from ${say(m, byDate.get(dates[0]))} to ${say(m, byDate.get(dates.at(-1)))}`,
    legendItems: [['sw-met', 'Each weigh-in (the last of its day)'], band ? ['sw-band', 'Standard range'] : null].filter(Boolean),
    table: tableAlt(['Day', `${m.label}${u ? ` (${u})` : ''}`], dates.map((d) => [f.dayMed(d), fm(cv(m, byDate.get(d)))]).reverse()),
  });
}

function metricSheet(b, m) {
  return {
    key: `m:${m.id}`, fam: 'body', title: m.label,
    body: html`<div class="part bc-sheet">
      <p class="bc-sheet__v"><span class="n n-l">${fmt(m, cv(m, m.value))}</span>${unitOf(m) ? html`<span class="bc-sheet__u">${unitOf(m)}</span>` : ''}${badge(m)}</p>
      ${m.range ? rangeBar(m) : ''}
      ${m.from === 'tape' ? '' : historyFig(b, m)}
      ${m.range ? html`<p class="sub">The ranges</p>${bandList(m)}` : ''}
      <p class="prose small">${m.sent ? 'Sent by your Xiaomi scale with each weigh-in.' : m.from === 'tape' ? 'Worked out from your latest tape measurement of waist and hips.' : 'Our estimate, worked out from what your scale sent, the way the Xiaomi app does.'}${m.about ? ` ${m.about}` : ''}${m.range && /^skeletal/.test(m.id) ? ' The ranges are from Janssen, Heymsfield and Ross (2002): skeletal muscle one and two ordinary spreads under the young-adult average, for your sex. A guide, not medical advice.' : ''}${m.range && !/^skeletal/.test(m.id) ? ' The ranges are the standard ranges the scale\'s app uses for your sex, age and height: a guide, not medical advice.' : ''}</p>
    </div>`,
  };
}

function scoreSheet(b) {
  const s = b.score;
  return {
    key: 'score', fam: 'body', title: 'Body score',
    body: html`<div class="part bc-sheet">
      <div class="bc-sheet__ring">${scoreRing(s, 120)}<p class="prose small">Out of 100. Each number takes points off when it is outside its standard range; nothing off means it is in range.${N(s.prev) ? ` ${s.prev === s.value ? 'The same as' : `${s.value > s.prev ? 'Up' : 'Down'} from ${s.prev} at`} the weigh-in before.` : ''}</p></div>
      <ul class="bc-parts">${s.parts.map((p) => html`<li><span>${p.label}</span><span class="n">${p.off ? `−${f.dec1(p.off)}` : 'In range'}</span></li>`)}</ul>
      ${historyFig(b, { id: 'score', label: 'Body score', unit: null, decimals: 0 })}
      <p class="prose small">Our estimate, worked out the way the Xiaomi app does (its method was published by people who studied the app). Xiaomi's own score can differ. A guide for wellness, not medical advice.</p>
    </div>`,
  };
}

function typeSheet(b) {
  const t = b.bodyType;
  const grid = [['Thick-set', 'Overweight', 'Obese'], ['Balanced muscular', 'Balanced', 'Lack of exercise'], ['Skinny muscular', 'Balanced skinny', 'Skinny']];
  return {
    key: 'type', fam: 'body', title: 'Body type',
    body: html`<div class="part bc-sheet">
      <p class="bc-sheet__type">${t.label}</p>
      <p class="prose small">${t.text}.</p>
      ${t.from === 'estimate' ? html`<div class="bc-grid" role="img" aria-label="Nine body types, by body fat (rows: high, standard, low) and muscle (columns: more, standard, less). Yours: ${t.label}.">
        <span class="bc-grid__h">Fat · muscle</span><span class="bc-grid__h">More</span><span class="bc-grid__h">Standard</span><span class="bc-grid__h">Less</span>
        ${grid.map((r, i) => html`<span class="bc-grid__r">${['High', 'Standard', 'Low'][i]}</span>${r.map((x) => html`<span class="bc-grid__c ${x === t.label ? 'is-at' : ''}">${x}</span>`)}`)}
      </div>` : ''}
      <p class="prose small">${t.from === 'scale' ? 'As your Xiaomi scale named it.' : 'Our estimate, worked out the way the Xiaomi app does: where your body fat and muscle mass sit against their standard ranges.'}</p>
    </div>`,
  };
}

/** Taps on the screen open their sheets. getBody() is read at tap time. */
export function bindBody(root, getBody) {
  on(root, 'click', '[data-bc]', (e, btn) => {
    const b = getBody();
    if (!b) return;
    const k = btn.dataset.bc;
    if (k === 'score' && b.score) openMore(scoreSheet(b));
    else if (k === 'type' && b.bodyType) openMore(typeSheet(b));
    else if (k.startsWith('m:')) { const m = (b.metrics || []).find((x) => x.id === k.slice(2)); if (m) openMore(metricSheet(b, m)); }
  });
}
