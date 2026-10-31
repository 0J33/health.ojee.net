/* Every metric, in one place: the catalogue's icon names as our glyphs, a
   metric's numbers in the person's own units, when it was last seen, the
   small chart of a row, and the row itself (Browse, pins, Today).

   The server's objects are the ones of docs/API.md, "Every metric": a
   Metric has { id, label, family, icon, unit, kind, latest, spark, pinned,
   canAdd, own }. Its sentences (`latest.text`, an entry's `text`) are in
   metric units; a number drawn here goes through num() / text() so it
   follows the person's km / mi, kg / lb and °C / °F. */

import { html, raw, ic, chart, esc, on, sheet, mount } from './ui.js';
import { hasIcon } from './icons.js';
import { ib } from './kit.js';
import { spark, sparkDots } from './viz.js';
import { rangeChip } from './ranges.js';
import * as f from './format.js';

/* ── icons ──────────────────────────────────────────────────── */

/* The server names Material Symbols glyphs; these are the ones the app
   already had under its own names. Everything else is generated under the
   server's name (scripts/make-icon-set.mjs). */
const ICON = {
  local_fire_department: 'flame', mode_heat: 'streak', chair: 'sedentary', pool: 'swim', fitness_center: 'strength',
  favorite: 'heart', vital_signs: 'wave', ecg: 'ecg_trace', bedtime: 'moon', monitor_weight: 'scale', body_fat: 'bodyfat',
  water_drop: 'drop', calendar_month: 'cycle', sick: 'symptom',
};
export const metricIcon = (m) => { const n = ICON[m?.icon] || m?.icon; return hasIcon(n) ? n : 'info'; };

/* ── numbers in the person's units ──────────────────────────── */

/* As the server writes them: up to `decimals` places, no trailing zeros (178 cm, 77.1 kg). */
const nf = [0, 1, 2].map((d) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: d }));
const fixed = (v, d) => nf[Math.min(2, Math.max(0, d || 0))].format(v);
const isF = () => f.getPrefs().temp === 'f';

/** The unit a metric is shown in ('' when the value says it itself). */
export function unitOf(m) {
  if (!m) return '';
  if (m.format === 'duration') return '';
  switch (m.id) {
    case 'distance': return f.distUnit();
    case 'weight': return f.weightUnit();
    case 'skin_temp': case 'body_temp': return f.tempUnit();
    default: return m.unit || '';
  }
}

/** An API value (metric units) as a number in the person's unit. */
export function val(m, v) {
  if (!f.isNum(v)) return null;
  switch (m.id) {
    case 'distance': return f.distVal(v);
    case 'weight': return f.weightVal(v);
    case 'skin_temp': return isF() ? v * 1.8 : v;
    case 'body_temp': return isF() ? v * 1.8 + 32 : v;
    default: return v;
  }
}

/** The person's number back in the API's unit, for a form. */
export function toApi(fieldId, v) {
  if (!f.isNum(v)) return v;
  if (fieldId === 'kg') return f.toKg(v);
  if (fieldId === 'celsius' && isF()) return (v - 32) / 1.8;
  return v;
}
/** An API field value in the person's unit, for a form. */
export function fromApi(fieldId, v) {
  if (!f.isNum(v)) return v;
  if (fieldId === 'kg') return f.weightVal(v);
  if (fieldId === 'celsius' && isF()) return v * 1.8 + 32;
  return v;
}
export const fieldUnit = (field) => (field.id === 'kg' ? f.weightUnit() : field.id === 'celsius' ? f.tempUnit() : field.unit || '');

const decimalsOf = (m) => (m.id === 'distance' ? 2 : m.id === 'weight' ? 1 : f.isNum(m.decimals) ? m.decimals : 0);

/** An already-converted number as text, without its unit. `short` is for axis ticks and tight places. */
export function shown(m, cv, { short = false } = {}) {
  if (!f.isNum(cv)) return f.DASH;
  if (m.format === 'duration') return short ? f.durShort(cv) : f.dur(cv);
  const d = decimalsOf(m);
  const s = short && Math.abs(cv) >= 1000 ? f.compact(cv) : fixed(Math.abs(cv), d);
  if (m.signed || m.id === 'recovery') return `${cv > 0 ? '+' : cv < 0 ? '−' : ''}${s}`;
  return cv < 0 ? `−${s}` : s;
}
/** An API value as text, without its unit. */
export const num = (m, v, opts) => shown(m, val(m, v), opts);
/** "61 bpm", "7 h 25 min", "95.4%". */
export function withUnit(m, s) {
  const u = unitOf(m);
  if (!u) return s;
  return u === '%' ? `${s}%` : `${s} ${u}`;
}
export const text = (m, v) => (f.isNum(v) ? withUnit(m, num(m, v)) : f.DASH);

/** A detail of an entry: { label, value, unit } with the unit in words. */
export function detailText(d) {
  if (typeof d.value !== 'number') return String(d.value ?? f.DASH);
  if (d.unit === 'min') return d.value >= 60 ? f.dur(d.value) : `${f.int(d.value)} min`;
  if (d.unit === '%') return `${fixed(d.value, Number.isInteger(d.value) ? 0 : 1)}%`;
  return `${fixed(d.value, Number.isInteger(d.value) ? 0 : 1)}${d.unit ? ` ${d.unit}` : ''}`;
}

const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * What a row or a tile shows for a metric's latest value: { v, u, words }.
 * `words` is true when it is a phrase and not a number (a mood, a log, the
 * recovery trend, which is said in words and never as its number).
 */
export function latestParts(m) {
  const l = m?.latest;
  if (!l) return { v: f.DASH, u: '', words: false };
  if (m.id === 'recovery' || m.kind === 'log' || m.unit === null) return { v: cap1(entryText(m, l)), u: '', words: true };
  if (!f.isNum(l.value)) return { v: cap1(l.text || f.DASH), u: '', words: true };
  return { v: num(m, l.value), u: unitOf(m), words: false };
}

/** An entry's (or a latest's) sentence, with our own units and dates where they differ from the server's. */
export function entryText(m, e) {
  if (!e) return f.DASH;
  if (e.kind === 'period' && e.fields?.start) {
    const a = e.fields.start; const b = e.fields.end;
    if (!b || b === a) return `Started ${f.dayShort(a)}`;
    return `${f.plural(e.value, 'day')}, ${f.dayShort(a)} to ${f.dayShort(b)}`;
  }
  if (m.id === 'period' && /\d{4}-\d{2}-\d{2}/.test(e.text || '')) return e.text.replace(/(\d{4}-\d{2}-\d{2})/g, (d) => f.dayShort(d));
  if (m.id === 'recovery' && e.kind !== 'day') return e.text || f.DASH;
  if (e.kind === 'day') return text(m, e.value);
  if (m.id === 'weight' && f.weightUnit() !== 'kg') return text(m, e.value);
  if (m.id === 'body_temp' && isF()) return `${text(m, e.value)}${(e.text || '').includes(',') ? e.text.slice(e.text.indexOf(',')) : ''}`;
  return e.text || text(m, e.value);
}

/* ── when ───────────────────────────────────────────────────── */

/** "Today", "Last night", "Yesterday", "3 days ago", "22 Sep"; with the time for something logged today. */
export function when(m, today = f.today()) {
  const l = m?.latest;
  if (!l?.date) return '';
  if (m.id === 'cardio_week') return 'This week';
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${l.date}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) {
    if (m.category === 'sleep' || m.id === 'skin_temp' || m.id === 'resp') return 'Last night';
    return l.at ? `Today, ${f.clock(l.at)}` : 'Today';
  }
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return f.dayShort(l.date);
}

/* ── the small chart of a row ───────────────────────────────── */

/**
 * A metric's spark as a chart slot: bars for things that add up, a line for
 * levels, dots for a log. '' when there is too little to draw.
 *   metricSpark(m, { h: 36 })
 */
export function metricSpark(m, { h = 36 } = {}) {
  const raw0 = m?.spark || [];
  const values = raw0.map((v) => val(m, v));
  const have = values.filter(f.isNum);
  const what = m.id === 'cardio_week' ? 'weeks' : m.kind === 'log' || raw0.length < 14 ? 'entries' : 'days';
  const u = unitOf(m);
  const say = (v) => `${shown(m, v)}${u && u !== '%' ? ` ${u}` : u}`;
  const label = `${m.label}, the last ${raw0.length} ${what}${have.length > 1 && m.kind !== 'log' ? `: from ${say(Math.min(...have))} to ${say(Math.max(...have))}` : ''}.`;
  if (m.kind === 'log') return have.length ? chart((w) => sparkDots({ w, h, values, label })) : '';
  if (have.length < 2) return '';
  const bars = m.kind === 'total' || m.kind === 'stack';
  return chart((w) => spark({ w, h, values, bars, label }));
}

/* ── the row ────────────────────────────────────────────────── */

/* What the chip of a row is for, said on hover and to a screen reader's title. */
const BAND_BASIS = { latest: 'Where the latest value falls in its reference range', 'average-7': 'Where the average of the last 7 days falls in its reference range', 'last-week': 'Where last week falls in its reference range' };

/** "Calculated by this app", as a label that is always visible. */
export const ownTag = () => html`<span class="own">Calculated by this app</span>`;

/** The pin toggle of a metric (bound by entry.js bindPins). */
export function pinButton(m, { pinned = m.pinned } = {}) {
  return html`<button type="button" class="iconbtn pinbtn" data-pin="${m.id}" data-label="${m.label}" aria-pressed="${String(Boolean(pinned))}" aria-label="Pin ${m.label} to Today" title="${pinned ? 'Pinned to Today' : 'Pin to Today'}">${raw(icon2('pin'))}</button>`;
}
/** The pin glyph alone (both drawings), for a row that is itself the toggle. */
export const pinGlyph = () => raw(icon2('pin'));
/* Both drawings, so the pressed state swaps the glyph and not only the colour. */
function icon2(name) {
  return `${String(ic(name, { fill: false })).replace('class="ic', 'class="ic ic--off')}${String(ic(name, { fill: true })).replace('class="ic', 'class="ic ic--on')}`;
}

/**
 * One metric as a row: family badge, name, when, a spark, the latest value,
 * and (optionally) its pin toggle. The row is a link to the metric's page.
 *   <ul class="mrows">${list.map((m) => metricRow(m))}</ul>
 */
export function metricRow(m, { pin = true, today, band = false } = {}) {
  const lp = latestParts(m);
  const w = when(m, today);
  // A band that is not about the number beside it says so: today's steps so far
  // are not "Somewhat active", the usual day of the last week is.
  const lead = { 'average-7': 'Usually', 'last-week': 'Last week' }[m.band?.basis] || '';
  const chip = band && m.band ? html`${lead ? html`<span class="rg-lead">${lead}</span>` : ''}${rangeChip(m.band, { title: BAND_BASIS[m.band.basis] || '' })}` : '';
  return html`<li class="mrow fam fam-${m.family}">
    <a class="mrow__a" href="/metric/${encodeURIComponent(m.id)}">
      ${ib(metricIcon(m))}
      <span class="mrow__t">${m.label}</span>
      <span class="mrow__s">${lead ? '' : chip}${chip && !lead ? html`<span class="sr">, </span>` : ''}<span class="mrow__w">${w}${m.own ? html`${w ? raw('<span aria-hidden="true"> · </span>') : ''}${ownTag()}` : ''}</span>${lead && chip ? html`<span class="sr">, </span><span class="rg-usual">${chip}</span>` : ''}</span>
      <span class="mrow__g">${metricSpark(m)}</span>
      <span class="mrow__v ${lp.words ? 'mrow__v--words' : ''}" title="${lp.words ? esc(lp.v) : ''}">${lp.v}${lp.u ? html`<span class="stat__u">${lp.u}</span>` : ''}</span>
    </a>
    ${pin ? pinButton(m) : ''}
  </li>`;
}

/* ── search ─────────────────────────────────────────────────── */

/* Other words people look for a metric by. */
const WORDS = {
  steps: 'walk walking pedometer', distance: 'km miles far walked', floors: 'stairs flights climb', altitude: 'elevation climb height gain',
  active: 'active zone minutes exercise', cardio_week: 'cardio weekly zone minutes aerobic ring', calories: 'calories energy kcal burned burn',
  calories_active: 'calories kcal burn move', calories_basal: 'calories kcal basal bmr rest', sedentary: 'sitting inactive still',
  activity_levels: 'light moderate vigorous sedentary', swim: 'swimming pool laps', workouts: 'exercise sessions training gym run',
  resting_hr: 'rhr pulse bpm', hrv: 'variability rmssd recovery', heart_rate: 'pulse bpm', zones: 'cardio fat burn peak zone',
  zone_calories: 'kcal energy zone', vo2max: 'fitness cardio oxygen', recovery: 'readiness resilience', ecg: 'ekg rhythm afib',
  irn: 'afib irregular notice', sleep: 'asleep night hours duration', sleep_score: 'quality', sleep_stages: 'deep rem light awake',
  sleep_efficiency: 'in bed awake', weight: 'kg lb mass scale', body_fat: 'fat composition', height: 'tall cm', bmi: 'bmi',
  skeletal_muscle: 'smm muscle scale composition', protein_mass: 'protein scale composition', bone_mineral: 'bone mass skeleton scale composition',
  resp: 'breathing respiratory breaths', spo2: 'oxygen saturation', skin_temp: 'temperature wrist night', body_temp: 'temperature fever thermometer',
  glucose: 'sugar diabetes', water: 'hydration drink fluid', food: 'calories nutrition meal eat protein carbs fat kcal diet',
  mood: 'feeling emotion mind mental', stress: 'stress tension calm relaxed garmin mind', body_battery: 'energy reserve garmin recharge tired', period: 'menstruation cycle', ovulation: 'fertility lh test cycle', symptoms: 'illness sick pain headache',
};
/** Does a metric answer a search? Every word typed must be found somewhere. */
export function matches(m, query, categoryLabel = '') {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return true;
  const hay = `${m.label} ${categoryLabel || m.category || ''} ${WORDS[m.id] || ''} ${m.unit || ''} ${m.family || ''}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/* ── calm rows that open the rest (metric, trends, compare, profile) ── */

/* A family as the solid tile it is drawn on (bento.css), or null where
   the family has no tile of its own and the page uses a plain one. */
const TILE = { steps: 'steps', active: 'active', energy: 'energy', workouts: 'energy', heart: 'heart', sleep: 'sleep', body: 'body', water: 'water', nutrition: 'water' };
export const tileOf = (fam) => TILE[fam] || null;
/** The tile classes for a family: its colour, or white with the family's accent. */
export const tileCls = (fam) => (TILE[fam] ? `bt--${TILE[fam]}` : `bt--plain fam fam-${fam || 'steps'} bt--accent`);

/**
 * Rows like Today's "More about today": an icon in a soft circle, a title,
 * one grey line, a chevron. Each row is { key, icon, fam, title, text } and
 * one of: body (html, or a function giving it; opens in a sheet), href (a
 * link) or act (a function run on tap, e.g. Add). `value` puts a short
 * figure on the right instead of only the chevron.
 *   ${moreRows(rows)}   and once:   bindMore(root, () => rows)
 */
export function moreRows(rows, { label = '' } = {}) {
  const list = rows.filter(Boolean);
  if (!list.length) return '';
  const inner = (r) => html`<span class="mrow__ic">${ic(r.icon || 'info')}</span>
    <span class="mrow__b"><span class="mrow__t">${r.title}</span>${r.text ? html`<span class="mrow__d">${r.text}</span>` : ''}</span>
    ${r.value ? html`<span class="mrow__x">${r.value}</span>` : ''}${r.tail ?? ic('right', { size: 's' })}`;
  return html`<div class="blist more-list mx-rows" ${label ? raw(`role="group" aria-label="${esc(label)}"`) : ''}>${list.map((r) => (r.href
    ? html`<a class="mrow ${r.fam ? `fam fam-${r.fam}` : ''}" href="${r.href}">${inner(r)}</a>`
    : html`<button type="button" class="mrow ${r.fam ? `fam fam-${r.fam}` : ''}" data-mx="${r.key}" ${r.attrs ? raw(r.attrs) : ''}>${inner(r)}</button>`))}</div>`;
}

/** Opens a row's sheet (or runs its act). getRows() is read at tap time, so rows can change with the data. */
export function bindMore(root, getRows) {
  on(root, 'click', '[data-mx]', (e, b) => {
    const r = (getRows() || []).find((x) => x && x.key === b.dataset.mx);
    if (!r) return;
    if (r.act) { r.act(b); return; }
    openMore(r);
  });
}

/** One row's detail in a bottom sheet; links inside close it as they go. */
export function openMore(r) {
  const body = typeof r.body === 'function' ? r.body() : r.body;
  const s = sheet({ title: r.sheetTitle || r.title, body: html`<div class="more-sheet mx-sheet ${r.fam ? `fam fam-${r.fam}` : ''}">${body}</div>` });
  s.el.addEventListener('click', (e) => { if (e.target.closest?.('a[href]:not([target])')) s.close(); });
  r.open?.(s, (next) => mount(s.el.querySelector('.mx-sheet'), next));
  return s;
}

/** A section heading over rows or a list, as on Today. */
export const secHead = (title, meta = '') => html`<div class="mx-h"><h2>${title}</h2>${meta ? html`<span class="muted small">${meta}</span>` : ''}</div>`;
