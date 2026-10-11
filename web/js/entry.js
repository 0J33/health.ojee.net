/* Logging by hand: the one sheet every form goes through, built from the
   server's own description of the form (`add` of GET /api/metric/<id>,
   docs/API.md), plus edit, delete, one-tap presets and the pin toggle.

   Nothing here knows a metric by name: fields, limits, presets and the
   line that says where an entry is saved all come from the payload. Units
   are the person's own (kg / lb, °C / °F) and are converted on the way out. */

import { api } from './api.js';
import { app } from './app.js';
import { html, raw, mount, ic, sheet, confirm, banner, toast, toastError, errText, on } from './ui.js';
import { toApi, fromApi, fieldUnit } from './metrics.js';
import * as f from './format.js';

/* ── what the server said became of an entry ────────────────── */

/** A toast for the reply of POST / PATCH / DELETE /api/entries. */
export function reportSaved(r, done = 'Saved') {
  const g = r?.google;
  if (r?.message) toast(r.message, { tone: g === 'failed' ? 'bad' : '', ms: 7000 });
  else toast(g === 'saved' ? `${done}, and in Google Health too` : done);
}

/* ── one-tap presets ────────────────────────────────────────── */

/**
 * Post a preset of `add.quick` straight away.
 *   await quickAdd(add, add.quick[0])   → the server's reply, or null when it failed (already said in a toast)
 */
export async function quickAdd(add, preset, { label = '' } = {}) {
  try {
    const r = await api.post(add.route, add.route === '/api/weight' ? preset.fields : { kind: add.kind, ...preset.fields });
    reportSaved(r, `${label || preset.label} added`);
    return r;
  } catch (err) { toastError(err, 'That was not saved. Try again.'); return null; }
}

/** The buttons for `add.quick`; handle clicks on [data-quick] (its value is the index). */
export function quickButtons(add, { cls = '' } = {}) {
  if (!add?.available || !add.quick?.length) return '';
  return html`<div class="quick ${cls}" role="group" aria-label="Quick add">${add.quick.map((q, i) => html`<button type="button" class="btn btn--tonal btn--s" data-quick="${i}">${ic('plus', { size: 's' })}${q.label}</button>`)}</div>`;
}

/* ── the form ───────────────────────────────────────────────── */

/* The choices people reach for first in the two long lists; the rest are
   one tap or a few letters away. */
const COMMON = {
  moods: ['HAPPY', 'CALM', 'CONTENT', 'ENERGIZED', 'GRATEFUL', 'PEACEFUL', 'EXCITED', 'PROUD', 'NEUTRAL', 'FATIGUED', 'STRESSED', 'ANXIOUS', 'SAD', 'WORRIED', 'FRUSTRATED', 'IRRITATED', 'OVERWHELMED', 'LONELY'],
  symptoms: ['HEADACHE', 'FATIGUE', 'COUGH', 'FEVER', 'NAUSEA', 'DIZZINESS', 'BACK_PAIN', 'ABDOMINAL_PAIN', 'CRAMPS', 'BLOATED', 'INSOMNIA', 'ANXIETY', 'SICK', 'HEARTBURN', 'JOINT_PAIN', 'OTHER'],
};
const LONG = 18;       // a list longer than this gets a filter and "Show all"
const CHIPS_MAX = 6;   // a single choice up to this many is chips, beyond it a menu

const low = (s) => String(s || '').toLowerCase();
const numText = (v) => (Number.isInteger(v) ? f.int(v) : String(Math.round(v * 10) / 10));
const stepOf = (field) => (field.id === 'kg' || field.id === 'celsius' ? 0.1 : field.step || 1);
const round = (v, step) => { const d = step < 1 ? 1 : 0; return Math.round(v * 10 ** d) / 10 ** d; };

function fieldLabel(field) {
  const u = field.type === 'number' ? fieldUnit(field) : '';
  return `${field.label}${u ? ` (${u})` : ''}${field.required ? '' : ' (optional)'}`;
}

function control(field, value, { first }) {
  const id = `e-${field.id}`;
  const err = html`<div data-err="${field.id}"></div>`;
  const auto = first ? 'autofocus' : '';
  if (field.type === 'number') {
    const step = stepOf(field);
    const lo = round(fromApi(field.id, field.min), step); const hi = round(fromApi(field.id, field.max), step);
    const v = f.isNum(value) ? round(fromApi(field.id, value), step) : '';
    return html`<div class="field"><label class="field__label" for="${id}">${fieldLabel(field)}</label>
      <input class="input" id="${id}" name="${field.id}" type="number" inputmode="${step < 1 ? 'decimal' : 'numeric'}" step="${step < 1 ? step : 'any'}" min="${lo}" max="${hi}" value="${v}" ${field.required ? 'required' : ''} ${raw(auto)} autocomplete="off">
      ${err}</div>`;
  }
  if (field.type === 'text') {
    const long = (field.maxLength || 0) >= 300;
    return html`<div class="field"><label class="field__label" for="${id}">${fieldLabel(field)}</label>
      ${long
        ? html`<textarea class="textarea textarea--s" id="${id}" name="${field.id}" maxlength="${field.maxLength}">${value ?? ''}</textarea>`
        : html`<input class="input" id="${id}" name="${field.id}" type="text" value="${value ?? ''}" maxlength="${field.maxLength || 200}" ${field.required ? 'required' : ''} ${raw(auto)} autocomplete="off">`}
      ${err}</div>`;
  }
  if (field.type === 'select') {
    const opts = field.options || [];
    if (opts.length <= CHIPS_MAX) {
      return html`<div class="field"><span class="field__label" id="${id}-l">${fieldLabel(field)}</span>
        <div class="pick" role="group" aria-labelledby="${id}-l" data-pick="${field.id}" data-one>
          ${opts.map((o) => html`<button type="button" class="chip" data-opt="${o.id}" aria-pressed="${String(o.id === value)}">${o.label}</button>`)}
        </div>${err}</div>`;
    }
    return html`<div class="field"><label class="field__label" for="${id}">${fieldLabel(field)}</label>
      <select class="select" id="${id}" name="${field.id}">${field.required && value ? '' : html`<option value="">${field.required ? 'Choose' : 'Not set'}</option>`}${opts.map((o) => html`<option value="${o.id}" ${o.id === value ? 'selected' : ''}>${o.label}</option>`)}</select>
      ${err}</div>`;
  }
  if (field.type === 'multi') {
    const opts = field.options || [];
    const long = opts.length > LONG;
    const range = field.min === field.max ? `Choose ${field.min}.` : `Choose ${field.min || 1} to ${field.max}.`;
    return html`<div class="field"><span class="field__label" id="${id}-l">${field.label}</span>
      ${long ? html`<input class="input input--s" type="search" data-filter="${field.id}" placeholder="Search ${opts.length} choices" aria-label="Search ${low(field.label)}" autocomplete="off" enterkeyhint="search">` : ''}
      <div class="pick" role="group" aria-labelledby="${id}-l" data-pick="${field.id}"></div>
      ${long ? html`<button type="button" class="btn btn--ghost btn--s pick__more" data-more="${field.id}" aria-expanded="false">Show all ${opts.length}</button>` : ''}
      <p class="field__hint" data-count="${field.id}" aria-live="polite">${range}</p>
      ${err}</div>`;
  }
  if (field.type === 'datetime') {
    const now = Date.now();
    const min = field.maxAgeDays ? f.toLocalInput(now - field.maxAgeDays * 86_400_000) : '';
    const days = field.maxAgeDays;
    return html`<div class="field"><label class="field__label" for="${id}">${field.label}</label>
      <input class="input" id="${id}" name="${field.id}" type="datetime-local" step="60" value="${f.toLocalInput(f.isNum(value) ? value : now)}" max="${f.toLocalInput(now + 60_000)}" ${min ? raw(`min="${min}"`) : ''}>
      <p class="field__hint">${days ? `Now, or any time in the last ${days >= 365 ? 'year' : `${days} days`}.` : 'Now, or earlier.'}</p>
      ${err}</div>`;
  }
  if (field.type === 'date') {
    const today = f.today();
    const min = field.maxAgeDays ? f.addDays(today, -field.maxAgeDays) : '';
    return html`<div class="field"><label class="field__label" for="${id}">${fieldLabel(field)}</label>
      <input class="input" id="${id}" name="${field.id}" type="date" value="${value || (field.required ? today : '')}" max="${today}" ${min ? raw(`min="${min}"`) : ''} ${field.required ? 'required' : ''}>
      ${err}</div>`;
  }
  return '';
}

function setError(form, name, message) {
  const slot = form.querySelector(`[data-err="${name}"]`);
  const input = form.elements[name];
  if (input?.setAttribute) { if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  if (slot) mount(slot, message ? html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>${message}</span></p>` : '');
}

/**
 * The sheet for adding or changing one entry.
 *   entrySheet({ metric, add, entry, onSaved })
 * `metric` and `add` are those of GET /api/metric/<id>; `entry` (optional)
 * is the entry being changed, and its `fields` fill the form. `onSaved(r)`
 * gets the server's reply ({ entry, google, message }).
 */
export function entrySheet({ metric, add, entry = null, onSaved }) {
  const editing = Boolean(entry);
  const title = editing ? `Change ${low(metric.label)} entry` : `Add ${low(metric.label)}`;

  if (!add?.available) {
    const s = sheet({
      title,
      body: html`<div class="stack">${banner({ tone: 'warn', iconName: 'lock', title: 'This cannot be logged right now', text: add?.note || 'Logging is not available for this.' })}</div>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Close</button>${add?.mode === 'off' && metric.group ? html`<button type="button" class="btn" data-on>Turn it on</button>` : ''}`,
    });
    s.el.querySelector('[data-on]')?.addEventListener('click', async () => {
      s.close();
      const { turnOnGroup } = await import('./groups.js');
      if (await turnOnGroup(metric.group, { ret: location.pathname })) onSaved?.(null);
    });
    return s;
  }

  const fields = add.fields || [];
  const init = entry?.fields || {};
  // What is chosen in the chip groups: a Set per multi field, a value per single one.
  const picks = {};
  for (const fd of fields) {
    if (fd.type === 'multi') picks[fd.id] = new Set(Array.isArray(init[fd.id]) ? init[fd.id] : []);
    else if (fd.type === 'select') picks[fd.id] = init[fd.id] ?? null;
  }
  const openAll = {};
  const firstId = fields.find((fd) => fd.type === 'number' || fd.type === 'text')?.id;

  const s = sheet({
    title,
    body: html`<form class="form" id="entry-form" novalidate>
      ${!editing && add.quick?.length ? html`<div class="field"><span class="field__label">One tap</span>${quickButtons(add)}</div><p class="entry__or"><span>or enter it yourself</span></p>` : ''}
      <div data-slot="error"></div>
      ${fields.map((fd) => control(fd, init[fd.id], { first: fd.id === firstId }))}
      <p class="entry__note">${ic(add.mode === 'google' ? 'link' : 'lock', { size: 's' })}<span>${add.note || ''}</span></p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="entry-form">${editing ? 'Save changes' : 'Save'}</button>`,
  });
  const form = s.el.querySelector('form');
  const saveBtn = s.el.querySelector('button[type="submit"]');
  const errSlot = form.querySelector('[data-slot="error"]');

  /* chips */
  function paintPick(fd) {
    const box = form.querySelector(`[data-pick="${fd.id}"]`);
    if (!box || fd.type !== 'multi') return;
    const opts = fd.options || [];
    const chosen = picks[fd.id];
    const q = low(form.querySelector(`[data-filter="${fd.id}"]`)?.value).trim();
    const long = opts.length > LONG;
    let list = opts;
    if (q) list = opts.filter((o) => low(o.label).includes(q));
    else if (long && !openAll[fd.id]) {
      const common = COMMON[fd.id] || opts.slice(0, 16).map((o) => o.id);
      list = opts.filter((o) => common.includes(o.id) || chosen.has(o.id));
      list.sort((a, b) => (common.indexOf(a.id) < 0 ? 99 : common.indexOf(a.id)) - (common.indexOf(b.id) < 0 ? 99 : common.indexOf(b.id)));
    }
    const full = fd.max && chosen.size >= fd.max;
    mount(box, list.length
      ? list.map((o) => html`<button type="button" class="chip" data-opt="${o.id}" aria-pressed="${String(chosen.has(o.id))}" ${full && !chosen.has(o.id) ? 'disabled' : ''}>${o.label}</button>`)
      : html`<p class="muted small">Nothing matches "${q}".</p>`);
    const more = form.querySelector(`[data-more="${fd.id}"]`);
    if (more) { more.hidden = Boolean(q); more.textContent = openAll[fd.id] ? 'Show fewer' : `Show all ${opts.length}`; more.setAttribute('aria-expanded', String(Boolean(openAll[fd.id]))); }
    const count = form.querySelector(`[data-count="${fd.id}"]`);
    if (count) count.textContent = chosen.size ? `${chosen.size} chosen${fd.max ? ` of up to ${fd.max}` : ''}${full ? '. That is the most.' : '.'}` : `Choose ${fd.min || 1} to ${fd.max}.`;
  }
  for (const fd of fields) paintPick(fd);

  on(form, 'click', '[data-opt]', (e, b) => {
    const box = b.closest('[data-pick]');
    const fd = fields.find((x) => x.id === box.dataset.pick);
    setError(form, fd.id, '');
    if (fd.type === 'multi') {
      const set = picks[fd.id];
      if (set.has(b.dataset.opt)) set.delete(b.dataset.opt); else set.add(b.dataset.opt);
      const at = b.dataset.opt;
      paintPick(fd);
      box.querySelector(`[data-opt="${CSS.escape(at)}"]`)?.focus({ preventScroll: true });
    } else {
      const was = picks[fd.id] === b.dataset.opt;
      picks[fd.id] = was && !fd.required ? null : b.dataset.opt;
      for (const c of box.querySelectorAll('[data-opt]')) c.setAttribute('aria-pressed', String(c.dataset.opt === picks[fd.id]));
    }
  });
  on(form, 'input', '[data-filter]', (e, input) => paintPick(fields.find((x) => x.id === input.dataset.filter)));
  on(form, 'keydown', '[data-filter]', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  on(form, 'click', '[data-more]', (e, b) => { openAll[b.dataset.more] = !openAll[b.dataset.more]; paintPick(fields.find((x) => x.id === b.dataset.more)); });
  on(form, 'input', '.input, .textarea, .select', (e, el) => { if (el.name) setError(form, el.name, ''); });

  /* one tap */
  on(form, 'click', '[data-quick]', async (e, b) => {
    if (b.disabled) return;
    for (const x of form.querySelectorAll('[data-quick]')) x.disabled = true;
    b.classList.add('is-busy');
    const r = await quickAdd(add, add.quick[Number(b.dataset.quick)], { label: `${add.quick[Number(b.dataset.quick)].label} of ${low(metric.label)}` });
    b.classList.remove('is-busy');
    for (const x of form.querySelectorAll('[data-quick]')) x.disabled = false;
    if (r) { s.close(); onSaved?.(r); }
  });

  /* read and check, in plain words */
  function read() {
    const out = {}; let bad = null;
    const fail = (fd, msg) => { setError(form, fd.id, msg); bad = bad || fd.id; };
    for (const fd of fields) {
      setError(form, fd.id, '');
      const el = form.elements[fd.id];
      if (fd.type === 'number') {
        const rawV = el.value.trim();
        if (rawV === '') { if (fd.required) fail(fd, `Enter ${low(fd.label)}.`); else out[fd.id] = null; continue; }
        const step = stepOf(fd);
        const v = Number(rawV.replace(',', '.'));
        const lo = round(fromApi(fd.id, fd.min), step); const hi = round(fromApi(fd.id, fd.max), step);
        if (!Number.isFinite(v) || v < lo || v > hi) { fail(fd, `Enter a number from ${numText(lo)} to ${numText(hi)}${fieldUnit(fd) ? ` ${fieldUnit(fd)}` : ''}.`); continue; }
        const apiV = toApi(fd.id, v);
        out[fd.id] = fd.id === 'kg' ? Math.round(apiV * 100) / 100 : fd.id === 'celsius' ? Math.round(apiV * 10) / 10 : apiV;
      } else if (fd.type === 'text') {
        const v = el.value.trim();
        if (!v && fd.required) { fail(fd, `Enter ${low(fd.label) === 'what was it' ? 'what it was' : low(fd.label)}.`); continue; }
        out[fd.id] = v || null;
      } else if (fd.type === 'select') {
        const v = (fd.options || []).length <= CHIPS_MAX ? picks[fd.id] : (el.value || null);
        if (!v && fd.required) { fail(fd, 'Choose one.'); continue; }
        out[fd.id] = v || null;
      } else if (fd.type === 'multi') {
        const v = [...picks[fd.id]];
        if (v.length < (fd.min || (fd.required ? 1 : 0))) { fail(fd, `Choose at least ${fd.min || 1}.`); continue; }
        out[fd.id] = v;
      } else if (fd.type === 'datetime') {
        if (!el.value) { out[fd.id] = undefined; continue; }
        const t = f.fromLocalInput(el.value);
        if (!f.isNum(t)) { fail(fd, 'Enter a date and a time.'); continue; }
        if (t > Date.now() + 60_000) { fail(fd, 'That time is in the future.'); continue; }
        if (fd.maxAgeDays && t < Date.now() - fd.maxAgeDays * 86_400_000) { fail(fd, `That is more than ${fd.maxAgeDays} days ago.`); continue; }
        // Left as it was offered ("now"): let the server stamp the entry itself.
        out[fd.id] = !editing && el.value === el.defaultValue ? undefined : t;
      } else if (fd.type === 'date') {
        const v = el.value || null;
        if (!v && fd.required) { fail(fd, 'Choose a day.'); continue; }
        if (v && v > f.today()) { fail(fd, 'That day has not happened yet.'); continue; }
        out[fd.id] = v;
      }
    }
    // A last day belongs after its first day, and not too long after.
    const st = fields.find((x) => x.id === 'start'); const en = fields.find((x) => x.id === 'end');
    if (st && en && out.start && out.end) {
      if (out.end < out.start) fail(en, 'The last day is before the first day.');
      else if (en.maxDays && (Date.parse(out.end) - Date.parse(out.start)) / 86_400_000 >= en.maxDays) fail(en, `At most ${en.maxDays} days after the first day.`);
    }
    return { out, bad };
  }

  const same = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort()) : (a ?? null) === (b ?? null));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn.disabled) return;
    mount(errSlot, '');
    const { out, bad } = read();
    if (bad) { (form.elements[bad] || form.querySelector(`[data-pick="${bad}"] .chip, [data-filter="${bad}"]`))?.focus?.(); return; }
    let body;
    if (editing) {
      body = {};
      for (const fd of fields) if (out[fd.id] !== undefined && !same(out[fd.id], init[fd.id])) body[fd.id] = out[fd.id];
      if (!Object.keys(body).length) { s.close(); return; }
    } else {
      body = add.route === '/api/weight' ? {} : { kind: add.kind };
      for (const fd of fields) if (out[fd.id] !== undefined && out[fd.id] !== null) body[fd.id] = out[fd.id];
    }
    saveBtn.disabled = true; saveBtn.classList.add('is-busy'); saveBtn.setAttribute('aria-busy', 'true');
    try {
      const r = editing ? await api.patch(`/api/entries/${encodeURIComponent(entry.id)}`, body) : await api.post(add.route, body);
      s.close();
      reportSaved(r, editing ? 'Changes saved' : `${metric.label} saved`);
      onSaved?.(r);
    } catch (err) {
      // The server names the field in its sentence: put it beside that field when we can tell which.
      const msg = errText(err, 'That was not saved. Try again.');
      const hit = err.code === 'bad_entry' ? fields.find((fd) => low(msg).includes(low(fd.label)) || low(msg).includes(low(fd.id))) : null;
      if (hit) { setError(form, hit.id, msg); form.elements[hit.id]?.focus?.(); } else { mount(errSlot, banner({ tone: 'bad', title: msg })); errSlot.scrollIntoView({ block: 'nearest' }); }
    } finally {
      saveBtn.disabled = false; saveBtn.classList.remove('is-busy'); saveBtn.removeAttribute('aria-busy');
    }
  });
  return s;
}

/**
 * Open the form of a metric from anywhere (a Browse row, a Today module):
 * fetches the metric's `add` and opens the sheet.
 *   await addEntry('water', { onSaved })
 */
export async function addEntry(metricId, { onSaved } = {}) {
  try {
    const r = await api.get(`/api/metric/${encodeURIComponent(metricId)}?range=day`);
    if (!r.add) { toast('This one cannot be logged by hand.'); return null; }
    return entrySheet({ metric: r.metric, add: r.add, onSaved });
  } catch (err) {
    if (err.code === 'group_off') {
      const { turnOnGroup } = await import('./groups.js');
      if (await turnOnGroup(err.detail?.group, { ret: location.pathname })) onSaved?.(null);
      return null;
    }
    toastError(err);
    return null;
  }
}

/** Ask, delete, and say what happened at Google. Resolves true when it is gone. */
export async function deleteEntry(metric, entry) {
  const yes = await confirm({
    title: 'Delete this entry?',
    text: `${entry.text || 'This entry'}, ${f.dateTime(entry.t)}. ${entry.google === 'saved' ? 'It is removed from Google Health too.' : entry.google === 'create_only' ? 'It is removed here; the copy in Google Health has to be removed there.' : 'It is removed from this site.'} This cannot be undone.`,
    yes: 'Delete', danger: true,
  });
  if (!yes) return false;
  try {
    const r = await api.del(`/api/entries/${encodeURIComponent(entry.id)}`);
    if (r?.message) toast(r.message, { tone: r.google === 'failed' ? 'bad' : '', ms: 7000 });
    else toast(r?.google === 'saved' ? 'Deleted here and in Google Health' : 'Deleted');
    return true;
  } catch (err) { toastError(err, 'That was not deleted. Try again.'); return false; }
}

/* ── pins ───────────────────────────────────────────────────── */

/**
 * Pin or unpin a metric. Resolves the new list of pinned ids, or null when
 * the server refused (its sentence is shown: "At most 8 metrics…").
 */
export async function togglePin(id, on) {
  try {
    const r = await api.post('/api/pins', { id, on });
    app.me.pins = r.pinned;
    return r.pinned;
  } catch (err) { toastError(err, 'That was not pinned. Try again.'); return null; }
}

/**
 * Make every pin toggle under `root` work (the buttons of metrics.js
 * pinButton). The button flips at once and flips back if the server says no.
 * `changed(pinned, id, on)` runs after a successful change.
 */
export function bindPins(root, { changed } = {}) {
  on(root, 'click', '[data-pin]', async (e, b) => {
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.busy) return;
    const want = b.getAttribute('aria-pressed') !== 'true';
    const all = () => root.querySelectorAll(`[data-pin="${CSS.escape(b.dataset.pin)}"]`);
    const set = (v) => { for (const x of all()) { x.setAttribute('aria-pressed', String(v)); x.title = v ? 'Pinned to Today' : 'Pin to Today'; } };
    b.dataset.busy = '1'; set(want);
    const pinned = await togglePin(b.dataset.pin, want);
    delete b.dataset.busy;
    if (!pinned) { set(!want); return; }
    toast(want ? `${b.dataset.label || 'Pinned'}: pinned to Today` : `${b.dataset.label || 'Unpinned'}: no longer pinned`);
    changed?.(pinned, b.dataset.pin, want);
  });
}
