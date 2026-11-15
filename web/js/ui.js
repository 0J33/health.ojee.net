/* DOM helpers shared by every screen: safe templating, mounting, toasts,
   sheets, skeletons, empty and error states.

   The page runs under a strict CSP, so nothing here writes a style=""
   attribute or an inline handler. Dynamic values travel as data-style
   ("--p:0.4;--av:#abc") and are applied through the CSSOM in mount(). */

import { icon } from './icons.js';
import { readyChart } from './scrub.js';

/* ── templating ─────────────────────────────────────────────── */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s ?? ''));

function val(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}

/** Tagged template: every interpolation is escaped unless it is html`` or raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += val(vals[i]); });
  return new Raw(out);
}

export const ic = (name, opts) => raw(icon(name, opts));

/* ── mounting ───────────────────────────────────────────────── */

const charts = new Map();
let chartSeq = 0;
let ro = null;

/** A chart slot. `draw(width)` returns SVG markup; it is redrawn on resize. */
export function chart(draw, { cls = '' } = {}) {
  const id = `c${chartSeq += 1}`;
  charts.set(id, draw);
  return raw(`<div class="chart ${cls}" data-cid="${id}"></div>`);
}

function drawChart(el) {
  const draw = charts.get(el.dataset.cid);
  if (!draw) return;
  const w = Math.floor(el.clientWidth);
  if (!w || el.dataset.w === String(w)) return;
  el.dataset.w = String(w);
  el.innerHTML = String(draw(w));
  applyStyles(el);
  readyChart(el);
}

function applyStyles(root) {
  for (const el of root.querySelectorAll('[data-style]')) {
    for (const decl of el.dataset.style.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
    el.removeAttribute('data-style');
  }
}

/* ── one way for anything to arrive ───────────────────────────
   A loading placeholder (.skelstack, the feed's, any [aria-busy]) shows only when
   something keeps one waiting (CSS: it waits, then fades in). When it is replaced by
   what it stood for, that content fades in where it stood: the same short fade on
   every screen and every part of a screen, however fast the data came. Headers and
   controls that were already there stay put. */
export const PLACEHOLDER = '.skelstack, .skel, .feed__skel, [aria-busy="true"]:not(button, .btn, a)';
export const ARRIVE_MS = 220;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pathOf = (node, root) => { const p = []; for (let n = node; n && n !== root; n = n.parentElement) p.unshift([...n.parentElement.children].indexOf(n)); return p; };
const atPath = (root, p) => { let n = root; for (const i of p) { n = n?.children[i]; if (!n) return null; } return n; };
/** Fade `els` in (the content arriving). */
export function arrive(els) {
  if (reducedMotion()) return;
  for (const n of els) {
    if (!n?.animate || n.matches('.head, script, style, template, [data-still]')) continue;
    n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ARRIVE_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' });
  }
}

/* Told of a redraw (content replacing content, not a placeholder) while a screen arrives:
   motion.js carries its counting and filling on in the new drawing. */
let repainted = null;
export const onRepaint = (fn) => { repainted = fn; };

export function mount(el, content) {
  const wasContent = el.childElementCount > 0;
  // Where placeholders stand now, and whether any is already showing.
  const ph = [...el.querySelectorAll(PLACEHOLDER)].filter((n) => !n.parentElement.closest(PLACEHOLDER));
  const shown = ph.some((n) => n.classList.contains('is-shown') || Number(getComputedStyle(n).opacity) > 0.05);
  const spots = ph.map((n) => pathOf(n, el));
  // Pictures already on screen are carried into the new markup: a fresh <img> is decoded
  // again, and for a frame or two shows nothing, which looked like a flicker on a redraw.
  const had = new Map();
  for (const im of el.querySelectorAll('img[src]')) {
    if (!im.complete || !im.naturalWidth) continue;
    const k = im.getAttribute('src');
    if (!had.has(k)) had.set(k, []);
    had.get(k).push(im);
  }
  el.innerHTML = String(content ?? '');
  if (had.size) {
    for (const im of el.querySelectorAll('img[src]')) {
      const old = had.get(im.getAttribute('src'))?.shift();
      if (!old) continue;
      for (const a of [...old.attributes]) if (!im.hasAttribute(a.name)) old.removeAttribute(a.name);
      for (const a of [...im.attributes]) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
      im.replaceWith(old);
    }
  }
  if (spots.length) {
    const fade = new Set();
    for (const p of spots) {
      const n = atPath(el, p);
      if (!n) continue;
      if (n.matches(PLACEHOLDER)) { if (shown) n.classList.add('is-shown'); continue; }   // still loading: no second wait
      // What took the placeholder's place, and whatever came after it.
      for (let x = n; x; x = x.nextElementSibling) if (!x.matches(PLACEHOLDER)) fade.add(x);
    }
    // A placeholder still on screen elsewhere carries on without waiting again.
    if (shown) for (const n of el.querySelectorAll(PLACEHOLDER)) n.classList.add('is-shown');
    arrive([...fade].filter((n) => ![...fade].some((o) => o !== n && o.contains(n))));
  }
  hydrate(el);
  if (wasContent && !spots.length && repainted) repainted(el);
  return el;
}

export function hydrate(el) {
  applyStyles(el);
  if (!ro && 'ResizeObserver' in window) {
    // Redrawn on the next frame: drawing inside the observer's own callback
    // changes sizes it is still reporting ("ResizeObserver loop" errors).
    ro = new ResizeObserver((entries) => { requestAnimationFrame(() => { for (const e of entries) if (e.target.isConnected) drawChart(e.target); }); });
  }
  for (const c of el.querySelectorAll('[data-cid]')) {
    drawChart(c);
    ro?.observe(c);
  }
}

/** Forget chart closures that are no longer in the document, nor in a kept screen (main.js). */
export function sweepCharts(keep = []) {
  for (const id of charts.keys()) {
    const sel = `[data-cid="${id}"]`;
    if (!document.querySelector(sel) && !keep.some((r) => r.querySelector(sel))) charts.delete(id);
  }
}

/**
 * Bring `el` into view. Inside a sheet only the sheet's own scroller moves:
 * scrollIntoView there also scrolls the locked page behind it on an iPhone,
 * and touch scrolling in the sheet then sticks.
 */
export function reveal(el, { block = 'start', smooth = true } = {}) {
  if (!el) return;
  const sc = el.closest('.sheet__body');
  if (!sc) { el.scrollIntoView({ block, behavior: smooth ? 'smooth' : 'auto' }); return; }
  const r = el.getBoundingClientRect(); const b = sc.getBoundingClientRect();
  let top = sc.scrollTop + r.top - b.top - 8;
  if (block === 'nearest') { if (r.top >= b.top && r.bottom <= b.bottom) return; if (r.bottom > b.bottom) top = sc.scrollTop + r.bottom - b.bottom + 8; }
  sc.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

/** A screen's title: kept on its pane (stage.js shows it when the screen shows), and put in the
    window's title only when that screen is the one showing (screens are built out of sight too). */
export function pageTitle(el, text) {
  const pane = el?.closest?.('.pane');
  if (pane) pane.dataset.title = text;
  if (!pane || !pane.classList.contains('is-off')) document.title = text;
}
/** The scroller `el` is in: its screen's pane (stage.js), or the document. */
export const scOf = (el) => el?.closest?.('.pane') || document.scrollingElement;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated listener; returns nothing, the root owns the lifetime. */
export function on(root, type, sel, fn, opts) {
  root.addEventListener(type, (e) => {
    const t = e.target.closest?.(sel);
    if (t && root.contains(t)) fn(e, t);
  }, opts);
}

/* ── small building blocks ──────────────────────────────────── */

export function banner({ tone = '', iconName, title, text, actions = '' }) {
  const name = iconName || (tone === 'bad' || tone === 'warn' ? 'alert' : 'info');
  return html`<div class="banner ${tone ? `banner--${tone}` : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
    <span class="banner__ic">${ic(name)}</span>
    <div class="banner__body">
      ${title ? html`<p class="banner__t">${title}</p>` : ''}
      ${text ? html`<p class="banner__d">${text}</p>` : ''}
      ${actions ? html`<div class="banner__act">${actions}</div>` : ''}
    </div>
  </div>`;
}

export function empty({ iconName = 'info', title, text, action = '', inline = false }) {
  return html`<div class="empty ${inline ? 'empty--inline' : ''}">
    ${inline ? '' : html`<span class="empty__ic">${ic(iconName)}</span>`}
    <p class="empty__t">${title}</p>
    ${text ? html`<p class="empty__d">${text}</p>` : ''}
    ${action}
  </div>`;
}

/** A failed load, with what to do about it. `retry` is a data-action name. */
export function errorState(err, { retry = 'retry' } = {}) {
  const offline = !navigator.onLine || err?.offline;
  const title = offline ? 'You are offline' : err?.status === 429 ? 'Too many requests' : 'This did not load';
  const text = offline
    ? 'Check your connection, then try again. Nothing was lost.'
    : err?.status === 429
      ? 'Wait a minute, then try again.'
      : (err?.message && err.status && err.status < 500 ? err.message : 'The server did not answer properly. Try again in a moment.');
  return html`<div class="group"><div class="empty">
    <span class="empty__ic">${ic(offline ? 'offline' : 'alert')}</span>
    <p class="empty__t">${title}</p>
    <p class="empty__d">${text}</p>
    <button class="btn btn--tonal btn--s" type="button" data-action="${retry}">Try again</button>
  </div></div>`;
}

/* ── while loading: cards shaped like what comes ──────────────────
   A skeleton is cards (.skc) on the page's surface, with the parts inside
   them (.skb: lines, a circle, a big number, chart bars) in a lighter tone
   that a light sweeps across. The sweep runs down the page in a wave: each
   card a little after the one above, each part a little after the one
   before it (app.css). Under reduced motion they stay still. */

const bone = (cls = '') => `<i class="skb ${cls}"></i>`;
/** One card's insides, by what it stands for. Exported for screens that draw their own. */
export const SKEL_CARD = {
  // A list row: a circle, two lines, a little pill at the end.
  row: () => `<div class="skc skc--row">${bone('skb--dot')}<span class="skc__txt">${bone('skb--w55')}${bone('skb--w35 skb--s')}</span>${bone('skb--pill')}</div>`,
  // A module: a label, a big number, two lines under it.
  block: () => `<div class="skc skc--block"><span class="skc__head">${bone('skb--ic')}${bone('skb--w30 skb--s')}</span>${bone('skb--big skb--w45')}${bone('skb--w80')}${bone('skb--w60 skb--s')}</div>`,
  // A chart: a label and a number, then bars of differing heights on a baseline.
  chart: () => `<div class="skc skc--chart"><span class="skc__head">${bone('skb--ic')}${bone('skb--w35 skb--s')}</span>${bone('skb--big skb--w30')}<span class="skc__bars">${[46, 72, 58, 88, 64, 40, 76, 54, 92, 68, 50, 80].map((h) => bone(`skb--bar skb--h${h}`)).join('')}</span><span class="skc__axis">${bone('skb--w20 skb--s')}${bone('skb--w20 skb--s')}</span></div>`,
  // A Today tile: its icon and name, the number, a line of context.
  tile: () => `<div class="skc skc--tile">${'<span class="skc__head">' + bone('skb--ic') + bone('skb--w45 skb--s') + '</span>'}${bone('skb--big skb--w55')}${bone('skb--w40 skb--s')}</div>`,
  // Sleep across the top: words on the left, a ring on the right.
  sleep: () => `<div class="skc skc--sleep"><span class="skc__col"><span class="skc__head">${bone('skb--ic')}${bone('skb--w30 skb--s')}</span>${bone('skb--huge skb--w60')}${bone('skb--w80 skb--s')}${bone('skb--w50 skb--s')}</span>${bone('skb--ring')}</div>`,
  // A post: who and when, its title, a picture, three numbers.
  post: () => `<div class="skc skc--post"><span class="skc__who">${bone('skb--dot')}<span class="skc__txt">${bone('skb--w40')}${bone('skb--w25 skb--s')}</span></span>${bone('skb--title skb--w60')}${bone('skb--pic')}<span class="skc__nums">${[0, 1, 2].map(() => `<span>${bone('skb--big skb--w70')}${bone('skb--w45 skb--s')}</span>`).join('')}</span></div>`,
  // A small square button: its icon over its name (the Log sheet's tiles).
  mini: () => `<div class="skc skc--mini">${bone('skb--ic')}${bone('skb--w60 skb--s')}</div>`,
  // A heading over a screen.
  title: () => `<div class="skt">${bone('skb--title skb--w45')}${bone('skb--w30 skb--s')}</div>`,
  // Today's weather line: the icon, the temperature and the sky, then the day's details.
  // Built like the line itself (today.js weatherLine), so it wraps where the line would: one row on a wide screen, two on a narrow one.
  weather: () => weatherShape() || `<div class="skwx" aria-hidden="true">${bone('skwx__ic')}<span class="skwx__now">${bone('skwx__t')}${bone('skwx__c')}</span><span class="skwx__day">${bone('skwx__d')}${bone('skwx__d skwx__d--s')}${bone('skwx__d skwx__d--p')}</span></div>`,
  // Sub-tabs.
  tabs: () => `<div class="sktabs">${bone('skb--tab')}${bone('skb--tab')}${bone('skb--tab')}</div>`,
};

/** Will Today show the weather (web/js/views/today.js): not hidden in Settings, and not known to have no place. */
function weatherWanted() {
  try {
    if (localStorage.getItem('health.weather') === 'off') return false;
    const c = JSON.parse(localStorage.getItem('health.wx') || 'null');
    return !(c && c.w === null);
  } catch { return true; }
}
/* The weather line's placeholder has the shape of the last line drawn on this phone: the
   same words, hidden under bars (the last weather is kept on this phone already,
   health.wx), so it is exactly as long and wraps where the real one does. The hand-drawn
   one only before any weather was ever seen. */
const WX_SHAPE = 'health.wxshape';
/** Keep the shape of a weather line just drawn (today.js), from its markup. */
export function keepWeatherShape(markup) {
  try {
    if (!markup) { localStorage.removeItem(WX_SHAPE); return; }
    const t = document.createElement('template');
    t.innerHTML = String(markup);
    for (const e of t.content.querySelectorAll('[aria-label], [role]')) { e.removeAttribute('aria-label'); e.removeAttribute('role'); }
    const div = document.createElement('div');
    div.append(t.content);
    localStorage.setItem(WX_SHAPE, div.innerHTML);
  } catch { /* private mode: the drawn placeholder */ }
}
function weatherShape() {
  try { const h = localStorage.getItem(WX_SHAPE); return h ? `<div class="wxsk" aria-hidden="true">${h}</div>` : ''; } catch { return ''; }
}
/** The weather line's skeleton, for its slot while the first answer comes. */
export const weatherSkeleton = () => raw(SKEL_CARD.weather());

/** Sign in and create account: the page's own frame (two provider buttons), so nothing moves when it arrives. */
const skelAuth = () => `<div class="narrow skauth">
  <div class="auth__head"><span class="skauth__brand">${bone('skauth__mark')}${bone('skauth__word')}</span></div>
  <div class="auth__title skauth__t">${bone('skb--title skb--w30')}</div>
  <p class="auth__sub skauth__sub">${bone('skb--w80')}</p>
  <div class="sso">${bone('skauth__btn')}${bone('skauth__btn')}</div>
</div>`;

export function skeleton(kind = 'page') {
  const C = SKEL_CARD;
  const rows = (n) => Array.from({ length: n }, C.row).join('');
  const map = {
    auth: skelAuth(),
    page: C.block() + rows(3),
    // Shaped like Today's tiles, so nothing moves when they arrive.
    today: `${weatherWanted() ? C.weather() : ''}<div class="skel-bento">${C.sleep()}${C.tile()}${C.tile()}${C.tile()}${C.tile()}${C.tile()}${C.tile()}</div>`,
    chart: C.chart() + C.chart(),
    list: rows(5),
    form: rows(3),
    // Browse and a metric page: a title, the sub-tabs, then modules.
    browse: C.title() + C.tabs() + C.chart() + C.block(),
    post: C.post(),
  };
  return raw(`<div class="skelstack" aria-busy="true" aria-label="Loading">${map[kind] || map.page}</div>`);
}
/** A card's insides only, for a box a screen draws itself (a bento tile). */
export const skelBones = (kind) => raw((SKEL_CARD[kind] || SKEL_CARD.tile)().replace(/^<div class="skc[^"]*">/, '').replace(/<\/div>$/, ''));
/** One card skeleton by name (SKEL_CARD), for a screen's own loading state. */
export const skelCard = (kind, n = 1) => raw(Array.from({ length: n }, SKEL_CARD[kind] || SKEL_CARD.row).join(''));

/* Your profile photo, for the Me button (main.js sets it from /api/me). */
let meFace = null;
const FACE = /^\/media\/m_[0-9a-f]{10}$/;
const meInner = () => (meFace ? html`<img class="mebtn__img" src="${meFace}" alt="" decoding="async">` : ic('person'));
/** Set (or clear) the photo on every Me button, the ones on screen included. */
export function setMeFace(url) {
  const next = typeof url === 'string' && FACE.test(url) ? url : null;
  if (next === meFace) return;
  meFace = next;
  for (const b of document.querySelectorAll('.mebtn')) { b.classList.toggle('mebtn--face', !!meFace); b.innerHTML = String(meInner()); }
}

/** The round profile button (Me) at the top right of a tab's first screen: your photo, or the person icon. */
export const meButton = () => html`<a class="mebtn ${meFace ? 'mebtn--face' : ''}" href="/settings" aria-label="Me: profile and settings">${meInner()}</a>`;

/**
 * A page header. A tab's first screen: a small line above (`kick`), the
 * serif title, its actions and the profile button. A deeper screen: a back
 * button and a plain title.
 */
/** The Ask AI button's switch (ai.js setAiFab), read here so the header needs nothing from ai.js. */
const askAiOn = () => { try { return localStorage.getItem('health.aifab') === '1'; } catch { return false; } };

export function head({ title, sub = '', back = '', actions = '', kick = '', me = null }) {
  if (back) {
    return html`<header class="head head--back">
      <div class="head__lead">
        <a class="back" href="${back}" aria-label="Back">${ic('left')}</a>
        <h1 class="head__title" tabindex="-1">${title}</h1>
      </div>
      ${actions ? html`<div class="head__actions">${actions}</div>` : ''}
    </header>`;
  }
  const withMe = me ?? !location.pathname.startsWith('/settings');
  // The Ask AI button, when switched on in Me (ai.js): at the top of each tab, on a phone and a
  // computer alike, in the same small pill as each page's own "Ask" (Sleep, a metric).
  const withAi = withMe && askAiOn();
  return html`<header class="head">
    <div>${kick ? html`<span class="head__kick">${kick}</span>` : ''}<h1 class="head__title" tabindex="-1">${title}</h1>${sub ? html`<p class="head__sub">${sub}</p>` : ''}</div>
    ${actions || withMe ? html`<div class="head__actions">${withAi ? html`<button type="button" class="aibtn head__ai" data-ai="ask">${ic('spark', { size: 's' })}<span>Ask AI</span></button>` : ''}${actions}${withMe ? meButton() : ''}</div>` : ''}
  </header>`;
}

export function seg(name, options, current, { fit = false, label = '' } = {}) {
  return html`<div class="seg ${fit ? 'seg--fit' : ''}" role="group" aria-label="${label || name}">
    ${options.map(([value, text]) => html`<button type="button" class="seg__opt" data-seg="${name}" data-value="${value}" aria-pressed="${String(String(value) === String(current))}">${text}</button>`)}
  </div>`;
}

/** A small circled i that shows `body` (words or html) in a bubble when tapped: for the
    explanation behind something, kept out of the way until someone wants it. Put it right
    after a heading or a label, never inside another button or link. */
export function info(body, { label = 'More about this' } = {}) {
  if (!body) return '';
  return html`<span class="infotip"><button type="button" class="infotip__b" data-infotip aria-expanded="false" aria-label="${label}">${ic('info', { size: 's' })}</button><span class="infotip__t" hidden>${body}</span></span>`;
}

/* The bubble: one at a time, under the i (above when there is no room), inside the
   screen; another tap, a tap anywhere else, Escape, a scroll or a new page closes it. */
let moreOpen = null;
function moreClose() {
  if (!moreOpen) return;
  const { b, el } = moreOpen;
  moreOpen = null;
  b.setAttribute('aria-expanded', 'false');
  b.removeAttribute('aria-controls');
  el.classList.add('is-out');
  setTimeout(() => el.remove(), 140);
}
function moreToggle(b) {
  const same = moreOpen?.b === b;
  moreClose();
  if (same) return;
  const src = b.parentElement.querySelector('.infotip__t');
  if (!src) return;
  const el = document.createElement('div');
  el.className = 'infotip-pop';
  el.id = `infotip${Date.now().toString(36)}`;
  el.setAttribute('role', 'note');
  el.innerHTML = src.innerHTML;
  (b.closest('dialog[open]') || document.body).append(el);
  const r = b.getBoundingClientRect();
  const w = Math.min(300, innerWidth - 24);
  el.style.width = `${w}px`;
  const left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2));
  const h = el.offsetHeight;
  const below = r.bottom + 8 + h <= innerHeight - 12 || r.top - 8 - h < 12;
  // Inside a sheet that moves, "fixed" is measured from the sheet: find where 0,0 lands.
  el.style.left = '0px'; el.style.top = '0px';
  const o = el.getBoundingClientRect();
  el.style.left = `${left - o.left}px`;
  el.style.top = `${(below ? r.bottom + 8 : r.top - 8 - h) - o.top}px`;
  el.style.setProperty('--ax', `${r.left + r.width / 2 - left}px`);
  el.classList.add(below ? 'is-below' : 'is-above');
  b.setAttribute('aria-expanded', 'true');
  b.setAttribute('aria-controls', el.id);
  moreOpen = { b, el };
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-infotip]');
    if (b) { e.preventDefault(); e.stopPropagation(); moreToggle(b); return; }
    if (moreOpen && !e.target.closest?.('.infotip-pop')) moreClose();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && moreOpen) { const { b } = moreOpen; moreClose(); b.focus(); } });
  addEventListener('scroll', moreClose, { passive: true, capture: true });
  addEventListener('resize', moreClose);
  addEventListener('popstate', moreClose);
}

/** A full-width switch of a few options with a thumb that slides to the chosen one (People, Routes, Awards). */
export function segx(name, options, current, label) {
  const i = Math.max(0, options.findIndex(([v]) => String(v) === String(current)));
  return html`<div class="segx" role="group" aria-label="${label}" style="--n:${options.length};--i:${i}">
    ${options.map(([v, t]) => html`<button type="button" class="segx__o" data-seg="${name}" data-value="${v}" aria-pressed="${String(String(v) === String(current))}">${t}</button>`)}
  </div>`;
}
/** Move a segx to `value` without drawing it again, so the thumb slides. */
export function segxTo(root, name, value) {
  const opts = [...root.querySelectorAll(`[data-seg="${name}"]`)];
  opts.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.value === String(value))));
  const box = opts[0]?.parentElement;
  const i = opts.findIndex((o) => o.dataset.value === String(value));
  if (box && i >= 0) box.style.setProperty('--i', String(i));
}

/* The other switches (.seg, .me-sg): options of their own widths, so the
   chosen one's pill slides over from the last one's place, measured on the
   tap. Works whether the view only flips aria-pressed or draws the switch
   again. Nothing to do in each view. */
const SLIDE_GROUP = '.seg, .me-sg';
function slidePill(e) {
  const b = e.target.closest?.('.seg > button, .me-sg > button');
  if (!b || b.getAttribute('aria-pressed') === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = b.parentElement;
  const was = box.querySelector(':scope > [aria-pressed="true"]');
  if (!was) return;
  const name = (el) => el.dataset.seg || el.dataset.sg || '';
  const key = name(b);
  // After a drag (segDrag below) it slides on from where the finger let it go: briefly, without the
  // tap's overshoot, and even when it was let go right over it (the pill then hands over in place).
  const dragged = !!dragFrom;
  const from = dragFrom || was.getBoundingClientRect();
  dragFrom = null;
  const find = () => [...document.querySelectorAll('[aria-pressed="true"]')].find((x) => name(x) === key && x.parentElement?.matches(SLIDE_GROUP));
  // From `from` (a screen rect) to the chosen option, over `ms`; started again in the
  // new switch when the view draws it again partway.
  const slide = (now, from, ms, first = true) => {
    const host = now.parentElement;
    const to = now.getBoundingClientRect();
    if (!to.width || ms < 40 || (first && (Math.abs(to.top - from.top) > 4 || (!dragged && Math.abs(from.left - to.left) < 1)))) return false;
    // Its pill as it will be, not partway into its own fade-in (it has just been chosen): no
    // transition on it until the hand-over.
    now.style.transition = 'none';
    const cs = getComputedStyle(now);
    const at = host.getBoundingClientRect();
    const pill = document.createElement('span');
    pill.className = 'seg-pill';
    pill.setAttribute('aria-hidden', 'true');
    const x0 = from.left - at.left + host.scrollLeft; const x1 = to.left - at.left + host.scrollLeft;
    Object.assign(pill.style, {
      left: `${x1}px`, top: `${to.top - at.top}px`, width: `${to.width}px`, height: `${to.height}px`,
      background: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius,
    });
    host.prepend(pill);
    // Its label in the unchosen colour until the pill is under it (a dark pill has a light label).
    const plain = [...host.children].find((x) => x !== now && x.tagName === 'BUTTON');
    now.classList.add('is-sliding');
    // (After a drag the pill is under it already, and so its label stays as chosen.)
    if (plain && !dragged) now.style.color = getComputedStyle(plain).color;
    const run = pill.animate([{ left: `${x0}px`, width: `${from.width}px` }, { left: `${x1}px`, width: `${to.width}px` }], { duration: ms, easing: dragged || ms < 320 ? 'cubic-bezier(0.23, 1, 0.32, 1)' : 'cubic-bezier(0.34, 1.36, 0.64, 1)' });
    const t0 = performance.now();
    let last = from;
    const done = () => { handOver(now, pill); };
    const watch = () => {
      if (run.playState === 'finished') return;
      if (pill.isConnected) { last = pill.getBoundingClientRect(); requestAnimationFrame(watch); return; }
      run.cancel();
      // Drawn again (sometimes twice, a placeholder first): carry on in the new one, while there is time.
      const retry = () => {
        const left = ms - (performance.now() - t0);
        if (left < 40) return;
        const again = find();
        if (!(again && again !== now && slide(again, last, left, false))) requestAnimationFrame(retry);
      };
      retry();
    };
    run.onfinish = done;
    requestAnimationFrame(watch);
    return true;
  };
  requestAnimationFrame(() => {
    // The same switch, or the one drawn in its place.
    const now = (box.isConnected ? box.querySelector(':scope > [aria-pressed="true"]') : null) || (key ? find() : null);
    if (!now || now === was) return;
    // A tap: the length of the switch's own slide. Let go after a drag: what is left of the way, quickly.
    const ms = dragged ? Math.round(Math.min(220, 120 + Math.abs(now.getBoundingClientRect().left - from.left) * 0.8)) : 320;
    slide(now, from, ms);
  });
}

/**
 * A moving pill hands over to the chosen button's own background, in the same frame: the button's
 * background and shadow come back at once (its CSS would fade them in, and the pill would blink
 * out), only its label's colour eases.
 */
function handOver(btn, pill) {
  btn.style.transition = 'color 160ms';
  btn.classList.remove('is-sliding');
  btn.style.color = '';
  void btn.offsetWidth;
  pill?.remove();
  setTimeout(() => { btn.style.transition = ''; }, 200);
}
if (typeof document !== 'undefined') document.addEventListener('click', slidePill, true);

/* Every switch can be dragged as well as tapped: a finger (or the mouse) on it
   and slid sideways takes the chosen pill along, from option to option, and
   letting go chooses the one under it, as a tap on it would (the view's own
   click handler does the rest). The tab bar does the same (motion.js).
   A switch too long for its row scrolls sideways instead, except from the
   chosen pill itself. The arrow keys move along a switch too. */
const DRAG_GROUP = '.seg, .me-sg, .segx, .evs__seg';
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let dragFrom = null;
let segDrag = null;
const optsOf = (box) => [...box.children].filter((x) => x.tagName === 'BUTTON' && x.hasAttribute('aria-pressed') && !x.disabled);
/** Which option the finger is over, as a position along the switch (fractional), and the nearest. */
function segAt(d, x) {
  const c = d.centres;
  if (x <= c[0]) return { pos: 0, near: 0 };
  if (x >= c[c.length - 1]) return { pos: c.length - 1, near: c.length - 1 };
  let i = 0; while (x > c[i + 1]) i += 1;
  const pos = i + (x - c[i]) / (c[i + 1] - c[i]);
  return { pos, near: Math.round(pos) };
}
/** The label under the pill in the chosen colour, the others in the plain one (eased by their CSS). */
function segLabels(d, near) {
  d.opts.forEach((o, i) => { o.style.color = i === near ? d.on1 : d.off1; });
}
function segPaint(d, pos) {
  if (d.segx) { d.box.style.setProperty('--i', String(pos)); return; }
  const i = Math.floor(pos); const f = pos - i; const a = d.rects[i]; const b = d.rects[Math.min(i + 1, d.rects.length - 1)];
  const left = a.left + (b.left - a.left) * f; const width = a.width + (b.width - a.width) * f;
  d.pill.style.left = `${left - d.at.left + d.box.scrollLeft}px`;
  d.pill.style.width = `${width}px`;
}
function segStart(d) {
  d.on = true;
  d.box.setPointerCapture?.(d.id);
  d.box.classList.add('is-drag');
  d.rects = d.opts.map((o) => o.getBoundingClientRect());
  d.centres = d.rects.map((r) => r.left + r.width / 2);
  d.at = d.box.getBoundingClientRect();
  d.on1 = getComputedStyle(d.cur).color;
  d.off1 = getComputedStyle(d.opts.find((o) => o !== d.cur)).color;
  // Taken from another option than the chosen one: the pill comes to the finger rather than jumping.
  const away = d.start !== d.cur;
  if (d.segx) {
    if (away && !reduced()) { d.box.classList.add('is-catch'); setTimeout(() => d.box.classList.remove('is-catch'), 140); }
    return;
  }
  const cs = getComputedStyle(d.cur);
  const r = d.rects[d.opts.indexOf(d.cur)];
  const pill = document.createElement('span');
  pill.className = 'seg-pill';
  pill.setAttribute('aria-hidden', 'true');
  Object.assign(pill.style, { top: `${r.top - d.at.top}px`, height: `${r.height}px`, background: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius });
  // Where the chosen pill is: then wherever the finger takes it.
  pill.style.left = `${r.left - d.at.left + d.box.scrollLeft}px`;
  pill.style.width = `${r.width}px`;
  d.box.prepend(pill);
  d.pill = pill;
  d.cur.classList.add('is-sliding');
  if (away && !reduced()) {
    pill.style.transition = `left 140ms ${EASE_OUT}, width 140ms ${EASE_OUT}`;
    setTimeout(() => { if (pill.isConnected && segDrag === d) pill.style.transition = ''; }, 140);
  }
}
function segEnd(e, cancel = false) {
  const d = segDrag;
  if (!d || e.pointerId !== d.id) return;
  segDrag = null;
  if (!d.on) return;
  d.box.classList.remove('is-drag');
  // The labels back to their own colours (the chosen one's comes from slidePill or the hand-over).
  d.opts.forEach((o) => { o.style.color = ''; });
  // The click a drag ends with is not a tap.
  const stop = (ev) => { if (ev.isTrusted) { ev.preventDefault(); ev.stopPropagation(); } };
  document.addEventListener('click', stop, true);
  setTimeout(() => document.removeEventListener('click', stop, true), 60);
  const to = cancel ? d.cur : d.opts[d.near];
  if (d.segx) {
    // Settles from where it was let go, as the small switches do: briefly, without the tap's overshoot.
    d.box.classList.add('is-land');
    setTimeout(() => d.box.classList.remove('is-land'), 240);
    d.box.style.setProperty('--i', String(d.opts.indexOf(to)));
  }
  else {
    if (to !== d.cur && d.box.isConnected) dragFrom = d.pill.getBoundingClientRect();
    const { pill, cur } = d;
    if (to === cur) {
      // Back to its place, then the button's own pill again.
      const ms = reduced() ? 0 : 200;
      pill.style.transition = ms ? `left ${ms}ms ${EASE_OUT}, width ${ms}ms ${EASE_OUT}` : 'none';
      segPaint(d, d.opts.indexOf(cur));
      setTimeout(() => handOver(cur, pill), ms);
    } else requestAnimationFrame(() => { pill.remove(); cur.classList.remove('is-sliding'); });
  }
  if (to !== d.cur) {
    // Drawn again while it was held (the page refreshed under the finger): the same option in the new switch.
    const live = to.isConnected ? to : sameOption(to);
    if (live) live.click();
  }
  dragFrom = null;
}
/** The option a switch drawn again has for `old` (a button no longer on the page). */
function sameOption(old) {
  // Its switch's name and its value, however the view spells them (data-seg/-value, data-sg/-v, data-days...).
  const id = (b) => Object.entries(b.dataset).sort(([a], [c]) => (a < c ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const want = id(old);
  return [...document.querySelectorAll(DRAG_GROUP.split(', ').map((g) => `${g} > button`).join(', '))].find((x) => id(x) === want) || null;
}
/** A switch too long for its row scrolls with a finger: marked so only its chosen pill drags (CSS touch-action). */
function markScroll(box) { box.classList.toggle('is-scroll', box.scrollWidth > box.clientWidth + 1); }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    // A second finger while one is dragging a switch: the drag goes on, the new touch is ignored.
    if (!e.isPrimary && segDrag) return;
    segDrag = null;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const b = e.target.closest?.('button');
    const box = b?.parentElement;
    if (!box?.matches?.(DRAG_GROUP)) return;
    const opts = optsOf(box);
    const cur = opts.find((o) => o.getAttribute('aria-pressed') === 'true');
    if (!cur || opts.length < 2 || !opts.includes(b)) return;
    markScroll(box);
    if (box.classList.contains('is-scroll') && b !== cur) return;   // elsewhere it scrolls
    segDrag = { box, opts, cur, start: b, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, sy: scOf(box).scrollTop, id: e.pointerId, on: false, near: opts.indexOf(cur), segx: box.classList.contains('segx') };
  }, true);
  document.addEventListener('pointermove', (e) => {
    const d = segDrag;
    if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.on) {
      const dx = Math.abs(e.clientX - d.x0); const dy = Math.abs(e.clientY - d.y0);
      if (dy > 10 && dy > dx) { segDrag = null; return; }
      if (dx < 6 || dx < dy) return;
      if (!d.box.isConnected) { segDrag = null; return; }
      segStart(d);
    }
    const { pos, near } = segAt(d, e.clientX);
    segPaint(d, pos);
    if (near !== d.near) d.near = near;
    if (d.labelled !== near) { d.labelled = near; segLabels(d, near); }
  }, true);
  const up = (cancel) => (e) => segEnd(e, cancel);
  document.addEventListener('pointerup', up(false), true);
  // A cancel mid-drag is the system's. A long press: the pill stays on the option it was held
  // over, as if let go there. The page taking the touch to scroll (it moved, or the finger went
  // more up and down than along): that was a scroll, and the pill goes back where it was.
  document.addEventListener('pointercancel', (e) => {
    const d = segDrag;
    const scrolled = d && (Math.abs(scOf(d.box).scrollTop - d.sy) > 2 || Math.abs(d.y - d.y0) > Math.abs(d.x - d.x0));
    segEnd(e, Boolean(scrolled));
  }, true);
  // No long-press menu or text selection while a switch is held.
  document.addEventListener('contextmenu', (e) => { if (segDrag && e.target.closest?.(DRAG_GROUP)) e.preventDefault(); }, true);
  // The arrow keys, along a switch.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const b = e.target.closest?.('button');
    const box = b?.parentElement;
    if (!box?.matches?.(DRAG_GROUP)) return;
    const opts = optsOf(box);
    const to = opts[opts.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!to) return;
    e.preventDefault();
    const key = to.dataset.seg || to.dataset.sg || to.dataset.lvh || '';
    to.click();
    // Focus the chosen one, in the switch as drawn again or this one.
    requestAnimationFrame(() => {
      const again = to.isConnected ? to : [...document.querySelectorAll(DRAG_GROUP.split(', ').map((g) => `${g} > [aria-pressed="true"]`).join(', '))].find((x) => (x.dataset.seg || x.dataset.sg || x.dataset.lvh || '') === key);
      again?.focus();
    });
  });
  // Mark the switches too long for their row as they appear and as the screen changes size.
  const ro = 'ResizeObserver' in window ? new ResizeObserver((es) => es.forEach((x) => markScroll(x.target))) : null;
  const seen = new WeakSet();
  let queued = false;
  const scan = () => { queued = false; for (const box of document.querySelectorAll('.seg')) { if (!seen.has(box)) { seen.add(box); ro?.observe(box); markScroll(box); } } };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } }).observe(document.documentElement, { childList: true, subtree: true });
}

export function toggle(name, checked, { label, disabled = false } = {}) {
  return html`<label class="switch">
    <input type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} role="switch" aria-label="${label}">
    <span class="switch__track"></span>
  </label>`;
}

export function row({ href, action, iconName, title, text, value, chevron, danger, attrs = '' }) {
  const tag = href ? 'a' : action ? 'button' : 'div';
  const a = href ? `href="${esc(href)}"` : action ? `type="button" data-action="${esc(action)}"` : '';
  return html`<${raw(tag)} class="row ${danger ? 'row--danger' : ''}" ${raw(a)} ${raw(attrs)}>
    ${iconName ? html`<span class="row__ic">${ic(iconName)}</span>` : ''}
    <span class="row__body"><span class="row__t">${title}</span>${text ? html`<span class="row__d" ${raw('')}>${text}</span>` : ''}</span>
    ${value !== undefined && value !== null && value !== '' ? html`<span class="row__v">${value}</span>` : ''}
    ${(chevron ?? Boolean(href)) ? html`<span class="row__chev">${ic('right', { size: 's' })}</span>` : ''}
  </${raw(tag)}>`;
}

/* ── toasts ─────────────────────────────────────────────────── */

let toastHost = null;
function host() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  return toastHost;
}

/**
 * toast('Saved') · toast('Could not save', { tone: 'bad' })
 * · toast('Workout deleted', { action: 'Undo', onAction })
 */
export function toast(message, { tone = '', action = '', onAction, ms } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${tone ? `toast--${tone}` : ''}`;
  mount(el, html`${tone === 'bad' ? ic('alert', { size: 's' }) : ''}<span class="toast__msg">${message}</span>${action ? html`<button type="button" class="toast__btn">${action}</button>` : ''}`);
  const close = () => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 180);
  };
  el.querySelector('.toast__btn')?.addEventListener('click', () => { close(); onAction?.(); });
  // Flick it up (or sideways) to put it away, like a notification.
  let y0 = null; let x0 = 0; let dy = 0; let dx = 0;
  el.addEventListener('pointerdown', (e) => { if (e.target.closest('.toast__btn')) return; y0 = e.clientY; x0 = e.clientX; dy = 0; dx = 0; el.setPointerCapture?.(e.pointerId); el.classList.add('is-drag'); });
  el.addEventListener('pointermove', (e) => {
    if (y0 === null) return;
    dy = Math.min(0, e.clientY - y0) + Math.max(0, e.clientY - y0) * 0.15; dx = e.clientX - x0;
    el.style.transform = `translate(${dx * 0.6}px, ${dy}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dy) / 120 - Math.abs(dx) / 400));
  });
  const release = () => {
    if (y0 === null) return;
    y0 = null; el.classList.remove('is-drag');
    if (dy < -28 || Math.abs(dx) > 110) { el.style.transform = ''; el.style.opacity = ''; close(); return; }
    el.style.transition = 'transform 360ms var(--spring), opacity 200ms'; el.style.transform = ''; el.style.opacity = '';
    if (Math.abs(dy) < 4 && Math.abs(dx) < 4 && onAction && action) { close(); onAction(); }
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  const h = host();
  while (h.children.length >= 2) h.firstChild.remove();
  h.append(el);
  setTimeout(close, ms ?? (action ? 7000 : tone === 'bad' ? 6000 : 3200));
  return close;
}

/** Friendly text for a failed request. */
export function errText(err, fallback = 'That did not work. Try again.') {
  if (!navigator.onLine || err?.offline) return 'You are offline. Try again when you are connected.';
  if (err?.status === 429) return 'Too many tries. Wait a minute, then try again.';
  if (err?.message && (!err.status || err.status < 500)) return err.message;
  return fallback;
}

export const toastError = (err, fallback) => toast(errText(err, fallback), { tone: 'bad' });

/* ── sheets ─────────────────────────────────────────────────── */

/**
 * A modal sheet: slides up on phones, a centred dialog on wide screens.
 * Built on <dialog>, so focus is trapped, Escape closes it, and focus goes
 * back to whatever opened it.
 *
 *   const s = sheet({ title, body, foot });
 *   s.el  the dialog · s.close(value) · await s.closed
 */
export function sheet({ title, body, foot = '', onOpen, dismissable = true, cls = '' }) {
  const opener = document.activeElement;
  const el = document.createElement('dialog');
  el.className = cls ? `sheet ${cls}` : 'sheet';
  const tid = `sh${Date.now().toString(36)}`;
  el.setAttribute('aria-labelledby', tid);
  mount(el, html`
    <div class="sheet__grab" aria-hidden="true"></div>
    <div class="sheet__head">
      <h2 class="sheet__title" id="${tid}">${title}</h2>
      ${dismissable ? html`<button type="button" class="iconbtn" data-close aria-label="Close">${ic('x')}</button>` : html`<span></span>`}
    </div>
    <div class="sheet__body">${body}</div>
    ${foot ? html`<div class="sheet__foot">${foot}</div>` : ''}`);
  document.body.append(el);
  // A sheet to search in (exercises, songs, foods, anything with a search box) keeps one height
  // whatever the results: a list that grows and shrinks as you type moves what you were about to tap.
  if (el.querySelector('.sheet__body input[type="search"]')) el.classList.add('sheet--tall');
  const unKb = fitKeyboard(el);

  let resolve;
  const closed = new Promise((r) => { resolve = r; });
  let result;
  // It goes the way it came: down off a phone, fading back on a wide screen (shell.css,
  // --t-sheet-out). Escape goes the same way.
  const close = (v) => {
    result = v;
    if (!el.open || el.classList.contains('is-out')) return;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('is-out');
      setTimeout(() => { if (el.open) el.close(); }, 200);
    } else el.close();
  };

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    else if (e.target === el && dismissable) close();   // the backdrop
  });
  el.addEventListener('cancel', (e) => { e.preventDefault(); if (dismissable) close(); });
  lockPage(true);
  const unDrag = dragToClose(el, { dismissable, close });
  // A hairline under the title once the content scrolls beneath it.
  const sb = el.querySelector('.sheet__body');
  sb?.addEventListener('scroll', () => el.classList.toggle('is-scrolled', sb.scrollTop > 2), { passive: true });
  el.addEventListener('close', () => {
    unDrag();
    unKb();
    lockPage(false);
    el.remove();
    // Charts are forgotten only when the screen changes (main.js): a sheet's
    // body can be drawn again (opened twice, or made before it opened).
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    resolve(result);
  });

  // On a phone a sheet opens without the keyboard: the browser's own autofocus in a
  // modal dialog would bring it up over half the sheet before anything is read.
  const wide = matchMedia('(min-width: 600px)').matches;
  if (!wide) {
    for (const x of el.querySelectorAll('[autofocus]')) x.removeAttribute('autofocus');
    // The dialog's own first focus lands on its title, at the top: nothing to scroll to.
    const t = el.querySelector('.sheet__title');
    if (t) { t.setAttribute('tabindex', '-1'); t.setAttribute('autofocus', ''); }
  }
  el.showModal();
  const first = el.querySelector('[autofocus], .sheet__body input:not([type=hidden]), .sheet__body select, .sheet__body textarea');
  // Focus without scrolling: the sheet is still sliding up from below the screen, and
  // Safari scrolls to bring a focused element into view, then the sheet jumps when it lands.
  if (first && wide) first.focus({ preventScroll: true });
  else el.querySelector('.sheet__title')?.focus?.({ preventScroll: true });
  hydrate(el);
  onOpen?.(el, close);
  return { el, close, closed };
}

/**
 * A sheet and the keyboard on a phone. The sheet keeps standing on the bottom of the screen, its
 * own background reaching under the keyboard (a see-through keyboard shows the sheet, never the
 * app behind it), and makes room for the keyboard inside itself (--kb): with the keyboard up it is
 * as tall as the space above it allows (--avail), so the phone has no reason to scroll the page to
 * show the box being typed in, and the sheet's top never goes off the screen. Scrolling what is
 * under the box puts the keyboard away, as a phone's own apps do, so the list is free to tap.
 * Returns the function that stops it. Shared by every sheet, and Ask AI's (ai.js).
 */
export function fitKeyboard(el, { scroller = null } = {}) {
  const vv = window.visualViewport;
  if (!vv || matchMedia('(min-width: 600px)').matches) return () => {};
  let raf = 0;
  const root = document.documentElement;
  const fit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      // The page itself never scrolls (stage.js). The first time a box low on the screen takes
      // focus, iOS scrolls the page to bring it above the keyboard, while the keyboard is still
      // coming up: measured then, the sheet sat too high and the caret was left behind. Whatever
      // it scrolled is put back, and the sheet is sized to what the keyboard leaves.
      if (root.classList.contains('has-stage') && (window.scrollY || root.scrollTop)) window.scrollTo(0, 0);
      const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
      const up = kb > 60;
      el.style.setProperty('--kb', `${up ? kb : 0}px`);
      if (up) el.style.setProperty('--avail', `${Math.round(vv.height)}px`); else el.style.removeProperty('--avail');
      el.classList.toggle('is-kb', up);
    });
  };
  // The keyboard's height arrives in steps on iOS (it animates, then the bar above it settles):
  // measured again over the next moments, not only on the first event.
  const timers = [];
  const settle = () => { for (const t of timers.splice(0)) clearTimeout(t); fit(); for (const ms of [80, 200, 380, 650, 1000]) timers.push(setTimeout(fit, ms)); };
  const onFocus = (e) => { if (e.target?.matches?.('input, textarea, [contenteditable]')) settle(); };
  const onBlur = () => setTimeout(settle, 0);
  el.addEventListener('focusin', onFocus);
  el.addEventListener('focusout', onBlur);
  // A finger dragging the list (not the box, not a tap) puts the keyboard away.
  let y0 = null;
  const start = (e) => { y0 = e.touches?.[0]?.clientY ?? null; };
  const move = (e) => {
    const a = document.activeElement;
    if (y0 === null || !a || !el.contains(a) || !a.matches('input, textarea') || e.target === a) return;
    if (Math.abs((e.touches?.[0]?.clientY ?? y0) - y0) > 12) { a.blur(); y0 = null; }
  };
  const area = scroller || el.querySelector('.sheet__body') || el;
  vv.addEventListener('resize', settle);
  vv.addEventListener('scroll', fit);
  area.addEventListener('touchstart', start, { passive: true });
  area.addEventListener('touchmove', move, { passive: true });
  fit();
  return () => {
    cancelAnimationFrame(raf);
    for (const t of timers.splice(0)) clearTimeout(t);
    el.removeEventListener('focusin', onFocus);
    el.removeEventListener('focusout', onBlur);
    vv.removeEventListener('resize', settle);
    vv.removeEventListener('scroll', fit);
    area.removeEventListener('touchstart', start);
    area.removeEventListener('touchmove', move);
  };
}

/* The page behind an open sheet does not scroll (counted, for a sheet over a sheet).
   Exported for a sheet built by hand (Ask AI, ai.js). */
let locks = 0;
export function lockPage(on) {
  locks = Math.max(0, locks + (on ? 1 : -1));
  document.documentElement.classList.toggle('sheet-open', locks > 0);
}

/**
 * A sheet on a phone follows the finger down, from its handle or head at
 * any time, or from its content once that is scrolled to the top: one
 * swipe scrolls up to the top and carries on into closing it. Let go past a
 * third of its height, or with a flick, and it closes; otherwise it springs
 * back. Nothing behind it moves.
 */
export function dragToClose(el, { dismissable, close, body: scrollBody = null }) {
  const narrow = matchMedia('(max-width: 599px)');
  const body = scrollBody || el.querySelector('.sheet__body');
  let startY = null; let topY = null; let lastY = 0; let lastT = 0; let vel = 0; let samples = []; let dragging = false; let sideways = null; let startX = 0;
  const reset = () => { el.style.transition = 'transform 420ms var(--spring)'; el.style.transform = ''; el.style.removeProperty('--drag'); };
  const scroller = (t) => { for (let n = t; n && n !== el; n = n.parentElement) { if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n; } return null; };
  let sc = null;
  // The touched element is listened to as well (as main.js's swipes do): content drawn again under
  // the finger mid-drag (search results arriving) must not leave the sheet half dragged.
  const seenE = new WeakSet();
  const once = (fn) => (e) => { if (seenE.has(e)) return; seenE.add(e); fn(e); };
  let held = null;
  const release = () => { if (!held) return; held.removeEventListener('touchmove', onMoveT); held.removeEventListener('touchend', onEndT); held.removeEventListener('touchcancel', onCancelT); held = null; };
  const onStart = (e) => {
    release();
    // A second finger (or a new touch) while it was being dragged: it goes back where it was.
    if (dragging) { dragging = false; startY = null; reset(); }
    if (narrow.matches && dismissable && e.touches.length === 1 && e.target !== el) {
      held = e.target;
      held.addEventListener('touchmove', onMoveT, { passive: false });
      held.addEventListener('touchend', onEndT);
      held.addEventListener('touchcancel', onCancelT);
    }
    if (!narrow.matches || !dismissable || e.touches.length !== 1) { startY = null; return; }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; lastY = startY; lastT = e.timeStamp; vel = 0; samples = [[e.timeStamp, startY]];
    topY = null; dragging = false; sideways = null;
    sc = scroller(e.target) || (body.contains(e.target) ? body : null);
    el.style.transition = 'none';
  };
  const onMove = (e) => {
    if (startY === null) { if (e.target === el && e.cancelable) e.preventDefault(); return; }
    const y = e.touches[0].clientY; const x = e.touches[0].clientX;
    // A sideways swipe (the chips, a carousel) is not a drag.
    if (sideways === null && (Math.abs(x - startX) > 8 || Math.abs(y - startY) > 8)) sideways = Math.abs(x - startX) > Math.abs(y - startY);
    if (sideways) return;
    const atTop = !sc || sc.scrollTop <= 0;
    // A drag starts only on a clear pull down (10 px) with the content at its top. Never on the
    // first wobble of a finger: on an iPhone, a touchmove refused at the start of a swipe stops
    // the content scrolling for the whole swipe, and a finger going up often wobbles down first.
    if (!dragging && atTop && sideways === false && y - startY > 10 && y > lastY) { dragging = true; topY = lastY; }
    if (dragging) {
      const d = y - topY;
      if (d < 0) { dragging = false; el.style.transform = ''; el.style.removeProperty('--drag'); }   // back up: the content scrolls again
      else { if (e.cancelable) e.preventDefault(); el.style.transform = `translateY(${d}px)`; el.style.setProperty('--drag', String(Math.min(1, d / el.offsetHeight))); }
    }
    samples.push([e.timeStamp, y]);
    while (samples.length > 2 && e.timeStamp - samples[0][0] > 120) samples.shift();
    lastY = y; lastT = e.timeStamp;
  };
  const onEnd = () => {
    if (startY === null) return;
    startY = null;
    if (!dragging) { el.style.transition = ''; return; }
    dragging = false;
    const d = lastY - topY;
    // A flick: how fast it moved over the last tenth of a second or so (px/ms).
    const [t0, y0] = samples[0] || [lastT, lastY];
    vel = lastT - t0 >= 30 ? (lastY - y0) / (lastT - t0) : 0;
    if (d > el.offsetHeight * 0.3 || (vel > 0.6 && d > 40)) {
      el.style.transition = 'transform 200ms cubic-bezier(.4,0,1,1)';
      el.style.transform = 'translateY(100%)';
      el.style.setProperty('--drag', '1');
      setTimeout(() => { el.classList.add('is-out'); if (el.open) el.close(); }, 190);
    } else reset();
  };
  const onMoveT = once(onMove);
  const onEndT = once((e) => { release(); onEnd(e); });
  // The system took the touch: not a decision to close; it goes back where it was.
  const onCancelT = once(() => { release(); if (startY === null) return; startY = null; if (dragging) { dragging = false; reset(); } });
  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMoveT, { passive: false });
  el.addEventListener('touchend', onEndT);
  el.addEventListener('touchcancel', onCancelT);
  return () => {
    release();
    el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMoveT);
    el.removeEventListener('touchend', onEndT); el.removeEventListener('touchcancel', onCancelT);
  };
}

/** A yes/no question. Resolves true when confirmed. */
export function confirm({ title, text, yes = 'Confirm', no = 'Cancel', danger = false }) {
  const s = sheet({
    title,
    body: html`<p class="prose">${text}</p>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>${no}</button>
      <button type="button" class="btn ${danger ? 'btn--solid-danger' : ''}" data-yes>${yes}</button>`,
  });
  s.el.querySelector('[data-yes]').addEventListener('click', () => s.close(true));
  return s.closed.then((v) => v === true);
}

/* ── forms and busy states ──────────────────────────────────── */

/** Run an async task with a control showing progress and not double-firing. */
export async function busy(btn, task) {
  if (!btn) return task();
  if (btn.classList.contains('is-busy')) return undefined;
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  try { return await task(); } finally {
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  }
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type === 'number' || el.dataset.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

/** Show a message under one field (or clear it with a falsy message). */
export function fieldError(form, name, message) {
  const input = form.elements[name];
  const slot = form.querySelector(`[data-err="${name}"]`);
  if (input?.setAttribute) {
    if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  if (slot) mount(slot, message ? html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>${message}</span></p>` : '');
}

export function field({ label, name, type = 'text', value = '', hint = '', attrs = '', options = null }) {
  const id = `f-${name}`;
  const control = options
    ? html`<select class="select" id="${id}" name="${name}" ${raw(attrs)}>${options.map(([v, t]) => html`<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${t}</option>`)}</select>`
    : type === 'textarea'
      ? html`<textarea class="textarea" id="${id}" name="${name}" ${raw(attrs)}>${value}</textarea>`
      : html`<input class="input" id="${id}" name="${name}" type="${type}" value="${value ?? ''}" ${raw(attrs)}>`;
  return html`<div class="field">
    <label class="field__label" for="${id}">${label}</label>
    ${control}
    ${hint ? html`<p class="field__hint">${hint}</p>` : ''}
    <div data-err="${name}"></div>
  </div>`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy it by hand: select the text and copy.', { tone: 'bad' }); }
}
