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

export function mount(el, content) {
  el.innerHTML = String(content ?? '');
  hydrate(el);
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

/** Forget chart closures that are no longer in the document. */
export function sweepCharts() {
  for (const id of charts.keys()) {
    if (!document.querySelector(`[data-cid="${id}"]`)) charts.delete(id);
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

export function skeleton(kind = 'page') {
  const b = (c) => `<div class="skel ${c}"></div>`;
  const map = {
    page: b('skel--block') + b('skel--row') + b('skel--row') + b('skel--row'),
    // Shaped like Today's tiles, so nothing moves when they arrive.
    today: `${b('skel--note')}<div class="skel-bento">${b('skel--sleep')}${b('skel--t1')}${b('skel--t1')}${b('skel--t2')}${b('skel--t2')}${b('skel--t2')}${b('skel--t2')}</div>`,
    chart: b('skel--tall') + b('skel--tall'),
    list: b('skel--row') + b('skel--row') + b('skel--row') + b('skel--row') + b('skel--row'),
    form: b('skel--row') + b('skel--row') + b('skel--row'),
    // Browse and a metric page: a title, the sub-tabs, a field, then modules.
    browse: b('skel--title') + b('skel--line') + b('skel--row') + b('skel--tall') + b('skel--tall'),
  };
  return raw(`<div class="skelstack" aria-busy="true" aria-label="Loading">${map[kind] || map.page}</div>`);
}

/** The round profile button (Me) at the top right of a tab's first screen. */
export const meButton = () => html`<a class="mebtn" href="/settings" aria-label="Me: profile and settings">${ic('person')}</a>`;

/**
 * A page header. A tab's first screen: a small line above (`kick`), the
 * serif title, its actions and the profile button. A deeper screen: a back
 * button and a plain title.
 */
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
  return html`<header class="head">
    <div>${kick ? html`<span class="head__kick">${kick}</span>` : ''}<h1 class="head__title" tabindex="-1">${title}</h1>${sub ? html`<p class="head__sub">${sub}</p>` : ''}</div>
    ${actions || withMe ? html`<div class="head__actions">${actions}${withMe ? meButton() : ''}</div>` : ''}
  </header>`;
}

export function seg(name, options, current, { fit = false, label = '' } = {}) {
  return html`<div class="seg ${fit ? 'seg--fit' : ''}" role="group" aria-label="${label || name}">
    ${options.map(([value, text]) => html`<button type="button" class="seg__opt" data-seg="${name}" data-value="${value}" aria-pressed="${String(String(value) === String(current))}">${text}</button>`)}
  </div>`;
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
export function sheet({ title, body, foot = '', onOpen, dismissable = true }) {
  const opener = document.activeElement;
  const el = document.createElement('dialog');
  el.className = 'sheet';
  const tid = `sh${Date.now().toString(36)}`;
  el.setAttribute('aria-labelledby', tid);
  mount(el, html`
    <div class="sheet__grab" aria-hidden="true"></div>
    <div class="sheet__head">
      <h2 class="sheet__title" id="${tid}">${title}</h2>
      ${dismissable ? html`<button type="button" class="iconbtn" data-close aria-label="Close">${ic('x')}</button>` : '<span></span>'}
    </div>
    <div class="sheet__body">${body}</div>
    ${foot ? html`<div class="sheet__foot">${foot}</div>` : ''}`);
  document.body.append(el);

  let resolve;
  const closed = new Promise((r) => { resolve = r; });
  let result;
  // On a phone the sheet slides down before it goes.
  const close = (v) => {
    result = v;
    if (!el.open || el.classList.contains('is-out')) return;
    if (matchMedia('(max-width: 599px)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('is-out');
      setTimeout(() => { if (el.open) el.close(); }, 230);
    } else el.close();
  };

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    else if (e.target === el && dismissable) close();   // the backdrop
  });
  el.addEventListener('cancel', (e) => { if (!dismissable) e.preventDefault(); });
  lockPage(true);
  const unDrag = dragToClose(el, { dismissable, close });
  // A hairline under the title once the content scrolls beneath it.
  const sb = el.querySelector('.sheet__body');
  sb?.addEventListener('scroll', () => el.classList.toggle('is-scrolled', sb.scrollTop > 2), { passive: true });
  el.addEventListener('close', () => {
    unDrag();
    lockPage(false);
    el.remove();
    sweepCharts();
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    resolve(result);
  });

  el.showModal();
  const first = el.querySelector('[autofocus], .sheet__body input:not([type=hidden]), .sheet__body select, .sheet__body textarea');
  if (first && matchMedia('(min-width: 600px)').matches) first.focus();
  else el.querySelector('.sheet__title')?.focus?.();
  hydrate(el);
  onOpen?.(el, close);
  return { el, close, closed };
}

/* The page behind an open sheet does not scroll (counted, for a sheet over a sheet). */
let locks = 0;
function lockPage(on) {
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
function dragToClose(el, { dismissable, close }) {
  const narrow = matchMedia('(max-width: 599px)');
  const body = el.querySelector('.sheet__body');
  let startY = null; let topY = null; let lastY = 0; let lastT = 0; let vel = 0; let samples = []; let dragging = false; let sideways = null; let startX = 0;
  const reset = () => { el.style.transition = 'transform 420ms var(--spring)'; el.style.transform = ''; el.style.removeProperty('--drag'); };
  const scroller = (t) => { for (let n = t; n && n !== el; n = n.parentElement) { if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n; } return null; };
  let sc = null;
  const onStart = (e) => {
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
    if (!dragging && atTop && y > lastY) { dragging = true; topY = lastY; }   // from where the content reached its top
    if (dragging) {
      const d = y - topY;
      if (d < 0) { dragging = false; el.style.transform = ''; }   // back up: the content scrolls again
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
  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd);
  el.addEventListener('touchcancel', onEnd);
  return () => {
    el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd);
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
