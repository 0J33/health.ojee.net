/* The dashboard vocabulary (docs/DESIGN.md, Components): module, stat,
   delta, range bar, meter, fact list, insight, sub-tabs. Every screen is
   built from these, so a number always arrives with its context and a
   module always has the same anatomy.

   Like ui.js, nothing here writes style="": dynamic values travel as
   data-style and are applied through the CSSOM by mount(). */

import { html, raw, ic, esc } from './ui.js';
import * as f from './format.js';

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/* ── module ─────────────────────────────────────────────────── */

/**
 * The unit of a dashboard.
 *   mod({ title, note, link: { href, text }, body, foot, span: 7, cls, label })
 * `span` is the desktop column span (4–12); phones stack. `tools` sits on
 * the right of the header in place of a link (a segmented control, a button).
 * `fam` is the metric family (steps, active, energy, heart, sleep, recovery,
 * body, workouts): it colours the title, the icon badge, the headline number
 * and every chart mark inside. `icon` is the glyph for the header badge.
 */
export function mod({ title = '', note = '', link = null, tools = '', body = '', foot = '', span = 12, cls = '', label = '', id = '', level = 2, fam = '', icon = '' }) {
  const hid = id || (title ? `m-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '');
  const H = `h${level}`;
  const head = title || link || tools
    ? html`<header class="mod__head">
        <div class="mod__titles">${title ? html`<${raw(H)} class="mod__title" ${hid ? raw(`id="${esc(hid)}"`) : ''}>${icon ? ib(icon, { plain: !fam }) : ''}<span>${title}</span></${raw(H)}>` : ''}${note ? html`<p class="mod__note">${note}</p>` : ''}</div>
        ${tools ? html`<div class="mod__tools">${tools}${link ? html`<a class="mod__link" href="${link.href}">${link.text}${ic('right', { size: 's' })}</a>` : ''}</div>` : link ? html`<a class="mod__link" href="${link.href}">${link.text}${ic('right', { size: 's' })}</a>` : ''}
      </header>`
    : '';
  const aria = title && hid ? `aria-labelledby="${esc(hid)}"` : label ? `aria-label="${esc(label)}"` : '';
  return html`<section class="mod mod--${span} ${fam ? `fam fam-${fam}` : ''} ${cls}" ${raw(aria)}>${head}<div class="mod__body">${body}</div>${foot ? html`<footer class="mod__foot">${foot}</footer>` : ''}</section>`;
}

/** The metric families and their glyphs (docs/DESIGN.md, Colour). */
export const FAM = {
  steps: { icon: 'steps', label: 'Steps' },
  active: { icon: 'bolt', label: 'Active minutes' },
  energy: { icon: 'flame', label: 'Calories' },
  heart: { icon: 'heart', label: 'Heart' },
  sleep: { icon: 'moon', label: 'Sleep' },
  recovery: { icon: 'readiness', label: 'Recovery' },
  body: { icon: 'scale', label: 'Body' },
  workouts: { icon: 'strength', label: 'Workouts' },
};

/**
 * An icon on a soft tint of its family's colour. Inside a `.fam` element it
 * takes that family; pass `fam` to set one here.
 */
export function ib(name, { fam = '', size = '', plain = false } = {}) {
  return html`<span class="ib ${size ? `ib--${size}` : ''} ${plain ? 'ib--plain' : ''} ${fam ? `fam fam-${fam}` : ''}">${ic(name)}</span>`;
}

/**
 * Concentric goal rings, outermost first.
 *   rings([{ fam: 'steps', value, goal, label }], { size, inner })
 * Each ring is its family's colour over a soft track of the same hue.
 */
export function rings(list, { size = 132, stroke = 13, gap = 3, inner = '' } = {}) {
  const c = size / 2;
  let s = '';
  list.forEach((r, i) => {
    const rad = c - stroke / 2 - i * (stroke + gap);
    if (rad <= stroke / 2) return;
    const len = 2 * Math.PI * rad;
    const p = r.goal > 0 && f.isNum(r.value) ? Math.min(1, Math.max(0, r.value / r.goal)) : 0;
    s += `<g class="fam fam-${r.fam}"><circle class="rings__track" cx="${c}" cy="${c}" r="${rad.toFixed(1)}" stroke-width="${stroke}"/>${p > 0.004 ? `<circle class="rings__val" cx="${c}" cy="${c}" r="${rad.toFixed(1)}" stroke-width="${stroke}" stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${(len * (1 - p)).toFixed(1)}"/>` : ''}</g>`;
  });
  const label = list.map((r) => `${r.label}: ${Math.round(r.goal > 0 ? ((r.value || 0) / r.goal) * 100 : 0)}% of goal`).join('. ');
  return raw(`<div class="rings" role="img" aria-label="${esc(label)}"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${s}</svg>${inner ? `<div class="rings__in">${inner}</div>` : ''}</div>`);
}

/** The 12-column grid modules sit on. */
export const grid = (content, cls = '') => html`<div class="grid ${cls}">${content}</div>`;

/* ── delta ──────────────────────────────────────────────────── */

/**
 * An arrow and an amount. `good` says which direction is better: 'up',
 * 'down', or null for a neutral fact (calories burned, bedtime).
 *   delta({ pct: 12, good: 'up' }) · delta({ abs: -3, unit: 'bpm', good: 'down' })
 */
export function delta({ pct = null, abs = null, unit = '', good = 'up', digits = 0, text = '' } = {}) {
  const v = f.isNum(abs) ? abs : pct;
  if (!f.isNum(v)) return '';
  const shown = f.isNum(abs)
    ? `${digits ? f.dec1(Math.abs(abs)) : f.int(Math.abs(abs))}${unit ? ` ${unit}` : ''}`
    : `${Math.abs(Math.round(pct))}%`;
  const zero = f.isNum(abs) ? Math.abs(abs) < (digits ? 0.05 : 0.5) : Math.round(pct) === 0;
  if (zero) return html`<span class="delta">${ic('flat', { size: 's' })}<span>${text || 'No change'}</span></span>`;
  const up = v > 0;
  const tone = good === null ? '' : (up === (good === 'up') ? 'delta--good' : 'delta--bad');
  return html`<span class="delta ${tone}">${ic(up ? 'up' : 'down', { size: 's' })}<span>${shown}${text ? ` ${text}` : ''}</span></span>`;
}

/* ── stat ───────────────────────────────────────────────────── */

/**
 * A number with its context.
 *   stat({ label, value, unit, context, size: 's'|''|'l'|'xl', icon, href })
 * `context` is the line that says what the number means (a delta and a few
 * words); `extra` goes under it (a range bar, a spark).
 */
export function stat({ label = '', value, unit = '', context = '', extra = '', size = '', icon = '', href = '', cls = '' }) {
  const tag = href ? 'a' : 'div';
  return html`<${raw(tag)} class="stat ${size ? `stat--${size}` : ''} ${cls}" ${href ? raw(`href="${esc(href)}"`) : ''}>
    ${label ? html`<p class="stat__k">${icon ? ic(icon, { size: 's' }) : ''}<span>${label}</span></p>` : ''}
    <p class="stat__v">${value}${unit ? html`<span class="stat__u">${unit}</span>` : ''}</p>
    ${context ? html`<p class="stat__c">${context}</p>` : ''}
    ${extra}
  </${raw(tag)}>`;
}

/**
 * The words for a /api/brief metric against its usual:
 * "12% above your usual Sunday" / "3 bpm above your 30-day average".
 * `m` = { value, usual, usualKind, usualN, delta, deltaPct }.
 */
export function versus(m, { weekday = '', unit = '', good = 'up', abs = false, digits = 0, noun = '' } = {}) {
  if (!m || !f.isNum(m.value)) return '';
  if (!f.isNum(m.usual)) return html`<span class="muted">${m.usualKind === 'weekday' ? 'Not enough history for a usual yet' : 'Still learning your usual'}</span>`;
  const what = m.usualKind === 'weekday' ? `your usual ${weekday || 'day'}` : (noun || 'your 30-day average');
  const d = abs ? m.delta : m.deltaPct;
  if (!f.isNum(d)) return html`<span class="muted">Usual ${noun || ''}</span>`;
  const small = abs ? Math.abs(d) < (digits ? 0.05 : 0.5) : Math.abs(d) < 3;
  if (small) return html`<span class="delta">${ic('flat', { size: 's' })}<span>In line with ${what}</span></span>`;
  const up = d > 0;
  const tone = good === null ? '' : (up === (good === 'up') ? 'delta--good' : 'delta--bad');
  const amt = abs ? `${digits ? f.dec1(Math.abs(d)) : f.int(Math.abs(d))}${unit ? ` ${unit}` : ''}` : `${Math.abs(Math.round(d))}%`;
  return html`<span class="delta ${tone}">${ic(up ? 'up' : 'down', { size: 's' })}<span>${amt} ${up ? 'above' : 'below'} ${what}</span></span>`;
}

/* ── range bar ──────────────────────────────────────────────── */

/**
 * Where a value sits against the person's own typical range: a track, a
 * band from `lo` to `hi`, a tick at `tick` (the usual, or a goal) and a dot
 * at `value`. The scale is chosen to hold all of them with a margin.
 */
export function range({ value, lo, hi, tick = null, label = '', min = null, max = null }) {
  if (!f.isNum(value)) return '';
  const pts = [value, lo, hi, tick].filter(f.isNum);
  let a = min ?? Math.min(...pts); let b = max ?? Math.max(...pts);
  if (min === null || max === null) {
    const span = (b - a) || Math.abs(b) * 0.2 || 1;
    if (min === null) a -= span * 0.35;
    if (max === null) b += span * 0.35;
  }
  const p = (v) => (clamp01((v - a) / (b - a)) * 100).toFixed(1);
  const band = f.isNum(lo) && f.isNum(hi) ? `<span class="range__band" data-style="--a:${p(lo)}%;--b:${p(hi)}%"></span>` : '';
  const tk = f.isNum(tick) ? `<span class="range__tick" data-style="--x:${p(tick)}%"></span>` : '';
  return raw(`<span class="range" role="img" aria-label="${esc(label)}">${band}${tk}<span class="range__dot" data-style="--x:${p(value)}%"></span></span>`);
}

/**
 * Progress against a goal, with an optional tick for where the person
 * usually ends up. Past the goal the bar is full and says so in words.
 */
export function meter({ value, goal, mark = null, label = '', cls = '' }) {
  const top = Math.max(goal || 0, f.isNum(mark) ? mark : 0, 1) * (f.isNum(mark) && mark > goal ? 1.04 : 1);
  const p = clamp01((value || 0) / top).toFixed(3);
  const tick = (v, c) => (f.isNum(v) && v > 0 && v <= top ? `<span class="meter__tick ${c}" data-style="--x:${(clamp01(v / top) * 100).toFixed(1)}%"></span>` : '');
  return raw(`<div class="meter ${cls}" role="img" aria-label="${esc(label)}"><div class="meter__v" data-style="--p:${p}"></div>${top > goal ? tick(goal, 'meter__tick--goal') : ''}${tick(mark, 'meter__tick--usual')}</div>`);
}

/**
 * One horizontal bar split into labelled parts (stage shares, zones).
 * parts: [{ value, cls, label }]
 */
export function split(parts, { label = '' } = {}) {
  const total = parts.reduce((a, p) => a + (f.isNum(p.value) && p.value > 0 ? p.value : 0), 0);
  if (!(total > 0)) return '';
  return raw(`<div class="split" role="img" aria-label="${esc(label || parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', '))}">${parts.filter((p) => p.value > 0).map((p) => `<span class="split__p ${p.cls}" data-style="--f:${(p.value / total).toFixed(4)}"></span>`).join('')}</div>`);
}

/* ── lists ──────────────────────────────────────────────────── */

/**
 * Label / value pairs under a headline.
 * items: [{ k, v, s }] — s is a small line under the value. cols: 2 | 3 | 4.
 */
export function facts(items, { cols = 2, cls = '' } = {}) {
  const list = items.filter(Boolean);
  if (!list.length) return '';
  return html`<dl class="facts facts--${cols} ${cls}">${list.map((x) => html`<div class="facts__i"><dt>${x.k}</dt><dd>${x.v}${x.u ? html`<span class="facts__u">${x.u}</span>` : ''}</dd>${x.s ? html`<dd class="facts__s">${x.s}</dd>` : ''}</div>`)}</dl>`;
}

const TONE_ICON = { good: 'up', warn: 'alert', info: 'info' };
/* The server names a few glyphs by their old names. */
const ICON_ALIAS = { trophy: 'record', workouts: 'strength', pulse: 'wave' };
/** One ranked insight from /api/brief. */
export function insight(i) {
  const tag = i.href ? 'a' : 'div';
  return html`<${raw(tag)} class="insight insight--${i.tone || 'info'}" ${i.href ? raw(`href="${esc(i.href)}"`) : ''}>
    <span class="insight__ic">${ic(ICON_ALIAS[i.icon] || i.icon || TONE_ICON[i.tone] || 'info')}</span>
    <span class="insight__body"><span class="insight__t">${i.title}</span>${i.text ? html`<span class="insight__d">${i.text}</span>` : ''}</span>
    ${i.href ? html`<span class="row__chev">${ic('right', { size: 's' })}</span>` : ''}
  </${raw(tag)}>`;
}

/** Underlined text tabs for a screen's sections. items: [[href, label, key]] */
export function tabsub(items, current, { label = 'Sections' } = {}) {
  return html`<nav class="tabsub" aria-label="${label}">${items.map(([href, text, key]) => html`<a class="tabsub__i" href="${href}" ${key === current ? raw('aria-current="page"') : ''}>${text}</a>`)}</nav>`;
}

/** A sentence that stands in for a chart there is not enough data for. */
export function tooFew(have, need, what = 'days') {
  return html`<p class="toofew">${ic('clock', { size: 's' })}<span>Not enough ${what} yet (${f.int(have)} of ${f.int(need)}). This fills in by itself.</span></p>`;
}

/** What the device does not report, said once. `missing` = [{ cap, text }]. */
export function missingNote(missing, { title = 'Not on your device' } = {}) {
  const list = (missing || []).filter((m) => m?.text);
  if (!list.length) return '';
  return html`<details class="missing"><summary>${ic('info', { size: 's' })}<span>${title}: ${list.length} ${list.length === 1 ? 'thing' : 'things'} this app could show with another device</span></summary>
    <ul>${list.map((m) => html`<li>${m.text}</li>`)}</ul></details>`;
}

/** A legend row. items: [[swatchClass, text]] */
export const legend = (items) => raw(`<div class="legend">${items.map(([cls, text]) => `<span class="legend__i"><span class="legend__sw ${cls}"></span>${esc(text)}</span>`).join('')}</div>`);

/** A chart with its readout line. `read` is the default sentence. */
export function figure(slot, { read = '', legendItems = null, note = '', table = '' } = {}) {
  return html`<div class="chartbox">
    <p class="chart__read" aria-live="polite">${read}</p>
    ${slot}
    ${legendItems ? legend(legendItems) : ''}
    ${note ? html`<p class="chart__note">${note}</p>` : ''}
    ${table ? raw(table) : ''}
  </div>`;
}
