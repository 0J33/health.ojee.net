/* The exercise library on the page: a picker (search, muscle group,
   equipment, a photo for each) that can take several at once, and an
   exercise's own sheet (photos, muscles, how to do it, your history).
   Used by the routine editor, the workout logger and the sets editor. */

import { api } from './api.js';
import { html, raw, mount, ic, on, sheet, toast, toastError, busy, confirm } from './ui.js';
import * as f from './format.js';
import { emit } from './app.js';
import { pickFiles, prepImage } from './media.js';

export const GROUPS = [['', 'All'], ['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'], ['arms', 'Arms'], ['legs', 'Legs'], ['core', 'Core']];
export const EQUIP = [['', 'Any equipment'], ['barbell', 'Barbell'], ['dumbbell', 'Dumbbell'], ['machine', 'Machine'], ['cable', 'Cable'], ['body only', 'Body weight'], ['kettlebells', 'Kettlebell'], ['bands', 'Band'], ['e-z curl bar', 'EZ bar'], ['medicine ball', 'Medicine ball'], ['exercise ball', 'Exercise ball'], ['foam roll', 'Foam roller'], ['other', 'Other']];
export const MUSCLE = { chest: 'Chest', back: 'Back', shoulders: 'Shoulders', arms: 'Arms', legs: 'Legs', core: 'Core', other: 'Other' };
/** The muscles an exercise can name, as the library does (server/library.js LIB_MUSCLES). */
export const MUSCLES_FINE = ['chest', 'shoulders', 'triceps', 'biceps', 'forearms', 'lats', 'middle back', 'lower back', 'traps', 'neck', 'abdominals', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors'];
export const TYPE_TEXT = { weight_reps: 'Weight and reps', bodyweight_reps: 'Reps', duration: 'Time', distance_duration: 'Distance and time' };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A small photo, or the muscle group's icon when there is none. */
export function thumb(src, { size = '' } = {}) {
  return src
    ? html`<img class="xthumb ${size ? `xthumb--${size}` : ''}" src="${src}" alt="" loading="lazy" decoding="async" width="48" height="48">`
    : html`<span class="xthumb xthumb--none ${size ? `xthumb--${size}` : ''}">${ic('strength')}</span>`;
}

/**
 * Pick exercises. Resolves to a list of { name, libId, templateId, muscle,
 * type } (one, unless `multi`), or [] when closed.
 */
export function pickExercises({ multi = true, title = 'Add exercises' } = {}) {
  return new Promise((resolve) => {
    let q = ''; let group = ''; let equipment = ''; let items = []; let timer = null; let seq = 0;
    let making = null;   // your own exercise being described: { name, muscle, equipment, type }
    const chosen = new Map();
    const s = sheet({
      title,
      cls: 'sheet--tall',
      body: html`<div class="xp">
        <div class="xp__bar">
          <label class="xp__q">${ic('search', { size: 's' })}<input class="input" type="search" data-q placeholder="Search, or type a new one" autocomplete="off" enterkeyhint="search" aria-label="Search exercises"></label>
          <div class="chips xp__groups" role="group" aria-label="Muscle group">${GROUPS.map(([v, t]) => html`<button type="button" class="chip" data-g="${v}" aria-pressed="${String(v === '')}">${t}</button>`)}</div>
          <select class="select xp__eq" data-eq aria-label="Equipment">${EQUIP.map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select>
        </div>
        <div data-new></div>
        <ul class="xp__list" data-list aria-live="polite"></ul>
        <div data-end></div>
      </div>`,
      foot: multi ? html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-add disabled>Add</button>` : '',
    });
    const el = s.el;
    const input = el.querySelector('[data-q]');
    const list = el.querySelector('[data-list]');
    const addBtn = el.querySelector('[data-add]');
    const key = (x) => x.name.toLowerCase();
    const sync = () => {
      if (!addBtn) return;
      addBtn.disabled = !chosen.size;
      addBtn.textContent = chosen.size ? `Add ${chosen.size}` : 'Add';
    };
    const draw = () => {
      const v = q.trim();
      const exact = items.some((x) => x.name.toLowerCase() === v.toLowerCase());
      const make = making ? makeForm(making) : v && !exact && v.length > 1 ? html`<button type="button" class="xp__newbtn ${items.length ? 'xp__newbtn--end' : ''}" data-make>${ic('plus', { size: 's' })}<span>Not here? Add "<b>${v}</b>" as your own exercise</span></button>` : '';
      // With matches, making a new one comes after them; with none, it is the first thing.
      mount(el.querySelector('[data-new]'), items.length ? '' : make);
      mount(el.querySelector('[data-end]'), items.length ? make : '');
      mount(list, items.length ? html`${items.map((x, i) => {
        const on1 = chosen.has(key(x));
        const sub = [MUSCLE[x.group] || cap(x.muscle || ''), x.equipment ? cap(x.equipment) : '', x.lastAt ? `done ${f.ago(x.lastAt)}` : x.source === 'hevy' ? 'Hevy' : x.source === 'yours' && x.custom ? 'yours' : '', x.by ? `by ${x.by.displayName || x.by.username}` : ''].filter(Boolean).join(' · ');
        return html`<li class="xp__i ${on1 ? 'is-on' : ''}">
          <button type="button" class="xp__pick" data-i="${i}" aria-pressed="${String(on1)}">
            ${thumb(x.image)}
            <span class="xp__body"><span class="xp__t">${x.name}</span><span class="xp__s">${sub}</span></span>
            <span class="xp__tick">${ic(on1 ? 'check' : 'plus', { size: 's' })}</span>
          </button>
          ${x.libId ? html`<button type="button" class="iconbtn xp__info" data-info="${i}" aria-label="About ${x.name}">${ic('info', { size: 's' })}</button>` : ''}
        </li>`;
      })}` : html`<li class="xp__none muted small">${q ? 'Nothing in the library by that name.' : 'Loading…'}</li>`);
    };
    const load = async () => {
      const my = ++seq;
      const p = new URLSearchParams({ q, limit: '60' });
      if (group) p.set('group', group);
      if (equipment) p.set('equipment', equipment);
      try { const r = await api.get(`/api/exercises/pick?${p}`); if (my === seq) { items = r.exercises || []; draw(); } } catch { if (my === seq) { items = []; draw(); } }
    };
    input.addEventListener('input', () => { q = input.value; making = null; clearTimeout(timer); timer = setTimeout(load, 180); });
    on(el, 'click', '[data-g]', (e, b) => { group = b.dataset.g; el.querySelectorAll('[data-g]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); load(); });
    el.querySelector('[data-eq]').addEventListener('change', (e) => { equipment = e.target.value; load(); });
    const done = (list1) => { s.close(); resolve(list1); };
    const asPick = (x) => ({ name: x.name, libId: x.libId || null, templateId: x.templateId || null, muscle: x.group || null, type: x.type || null, image: x.image || null });
    on(el, 'click', '[data-i]', (e, b) => {
      const x = items[Number(b.dataset.i)];
      if (!multi) { done([asPick(x)]); return; }
      if (chosen.has(key(x))) chosen.delete(key(x)); else chosen.set(key(x), asPick(x));
      draw(); sync();
    });
    on(el, 'click', '[data-info]', (e, b) => { const x = items[Number(b.dataset.info)]; if (x?.libId) exerciseInfo(x.libId); });
    // Your own exercise: say what it works, with what, and how it is counted.
    on(el, 'click', '[data-make]', () => {
      making = { name: q.trim().slice(0, 80), muscle: group || 'other', equipment: equipment || '', type: 'weight_reps' };
      draw();
      el.querySelector('.xp__make')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    on(el, 'click', '[data-mm]', (e, b) => { making.muscle = b.dataset.mm; el.querySelectorAll('[data-mm]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
    on(el, 'change', '[data-me]', (e, t) => { making.equipment = t.value; });
    on(el, 'change', '[data-mt]', (e, t) => { making.type = t.value; });
    on(el, 'click', '[data-make-x]', () => { making = null; draw(); });
    // The full form, over the picker: steps, muscles, photos.
    on(el, 'click', '[data-make-more]', async () => {
      const m = making;
      const x = await editExercise({ id: null, name: m.name, group: m.muscle, equipment: m.equipment, type: m.type, images: [], primary: [], secondary: [], steps: [], public: true, _new: true });
      if (!x) return;
      making = null;
      const pick = { name: x.name, libId: x.id, templateId: null, muscle: x.group, type: x.type, image: x.images[0] || null };
      if (!multi) { done([pick]); return; }
      chosen.set(x.name.toLowerCase(), pick);
      items = [{ name: x.name, libId: x.id, group: x.group, equipment: x.equipment, type: x.type, image: x.images[0] || null, custom: true, source: 'yours' }, ...items];
      draw(); sync();
    });
    on(el, 'click', '[data-make-ok]', async (e, b) => {
      const m = making;
      const r = await busy(b, () => api.post('/api/exercises/mine', { name: m.name, muscle: m.muscle, equipment: m.equipment || null, type: m.type })).catch((err) => { toastError(err); });
      if (!r) return;
      const x = r.exercise;
      const pick = { name: x.name, libId: x.id, templateId: null, muscle: x.group, type: x.type, image: null };
      making = null;
      if (!multi) { done([pick]); return; }
      chosen.set(x.name.toLowerCase(), pick);
      items = [{ name: x.name, libId: x.id, group: x.group, equipment: x.equipment, type: x.type, custom: true, source: 'yours' }, ...items];
      draw(); sync();
    });
    addBtn?.addEventListener('click', () => done([...chosen.values()]));
    s.closed.then(() => resolve([...(multi ? [] : [])]));
    load();
    // On a phone the search waits for a tap: a keyboard opened while the sheet
    // is still sliding up throws the page out of place until it closes again.
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 60);
  });
}

/** The little form for an exercise of your own. */
function makeForm(m) {
  return html`<div class="xp__make" role="group" aria-label="Your own exercise">
    <p class="xp__make-t">${ic('plus', { size: 's' })}<span>Your own: <b>${m.name}</b></span></p>
    <div class="field"><span class="field__label">Muscle group</span>
      <div class="chips" role="group" aria-label="Muscle group">${[...GROUPS.slice(1), ['other', 'Other']].map(([v, t]) => html`<button type="button" class="chip" data-mm="${v}" aria-pressed="${String(v === m.muscle)}">${t}</button>`)}</div></div>
    <div class="xp__make-row">
      <div class="field"><label class="field__label" for="xm-eq">Equipment</label>
        <select class="select" id="xm-eq" data-me><option value="">None given</option>${EQUIP.slice(1).map(([v, t]) => html`<option value="${v}" ${v === m.equipment ? 'selected' : ''}>${t}</option>`)}</select></div>
      <div class="field"><label class="field__label" for="xm-type">Counted as</label>
        <select class="select" id="xm-type" data-mt>${Object.entries(TYPE_TEXT).map(([v, t]) => html`<option value="${v}" ${v === m.type ? 'selected' : ''}>${t}</option>`)}</select></div>
    </div>
    <div class="xp__make-act"><button type="button" class="btn btn--ghost btn--s" data-make-more>More details and photos</button><span class="xp__make-sp"></span><button type="button" class="btn btn--tonal btn--s" data-make-x>Cancel</button><button type="button" class="btn btn--s" data-make-ok>Add exercise</button></div>
  </div>`;
}

/** An exercise's own sheet: the photos, muscles, steps and your history of it. */
export async function exerciseInfo(libId) {
  const s = sheet({ title: 'Exercise', body: html`<p class="muted">Loading…</p>` });
  try {
    const r = await api.get(`/api/library/${encodeURIComponent(libId)}`);
    const x = r.exercise;
    s.el.querySelector('.sheet__title, h2')?.replaceChildren(document.createTextNode(x.name));
    const madeBy = x.custom ? html`<p class="xi__by small">${x.mine ? html`${ic('edit', { size: 's' })}<span>Made by you${x.public ? ', shared with everyone' : ', only for you'}</span><button type="button" class="btn btn--tonal btn--s" data-edit>Edit</button>` : html`${ic('users', { size: 's' })}<span>Made by ${x.by ? html`<a class="link" href="/u/${encodeURIComponent(x.by.username)}">${x.by.displayName || x.by.username}</a>` : 'someone'}</span>`}</p>` : '';
    const hist = r.history || [];
    const best = hist.reduce((a, h) => (f.isNum(h.topKg) && (!a || h.topKg > a.topKg) ? h : a), null);
    mount(s.el.querySelector('.sheet__body') || s.el, html`<div class="xi">
      ${madeBy}
      ${x.images.length ? html`<div class="xi__pics">${x.images.map((src, i) => html`<figure><img src="${src}" alt="${x.name}, ${i ? 'end' : 'start'} position" loading="lazy" decoding="async"><figcaption class="muted small">${i ? 'End' : 'Start'}</figcaption></figure>`)}</div>` : ''}
      <div class="chips">
        <span class="badge">${MUSCLE[x.group] || 'Other'}</span>
        ${x.equipment ? html`<span class="badge">${cap(x.equipment)}</span>` : ''}
        ${x.level ? html`<span class="badge">${cap(x.level)}</span>` : ''}
        <span class="badge">${TYPE_TEXT[x.type]}</span>
      </div>
      ${x.primary.length || x.secondary.length ? html`<p class="small"><b>Works</b> ${x.primary.map(cap).join(', ')}${x.secondary.length ? html`<span class="muted">${x.primary.length ? ', and ' : ''}${x.secondary.join(', ')}</span>` : ''}</p>` : ''}
      ${x.notes ? html`<p class="small">${x.notes}</p>` : ''}
      ${hist.length ? html`<div class="group group--pad"><p class="h3">Your history</p>
        <p class="small">${f.plural(hist.length, 'session')}${best ? `, heaviest ${f.weight(best.topKg)} × ${best.reps}` : ''}${r.last ? `, last ${f.dayShort(f.instDay(r.last.t))}: ${r.last.sets.map((st) => (f.isNum(st.kg) && st.kg > 0 ? `${f.weightNum(st.kg)}×${st.reps ?? ''}` : f.isNum(st.reps) ? `${st.reps} reps` : f.isNum(st.durationS) ? `${st.durationS} s` : '')).filter(Boolean).join(', ')}` : ''}</p></div>` : ''}
      ${x.steps?.length ? html`<div><p class="h3">How to do it</p><ol class="xi__steps prose small">${x.steps.map((t) => html`<li>${t}</li>`)}</ol></div>` : ''}
      <p class="muted small">${x.custom ? 'Made in Health by the person named above.' : x.id.startsWith('X_') ? 'Written for Health.' : 'From free-exercise-db, public domain.'}</p>
    </div>`);
    s.el.querySelector('[data-edit]')?.addEventListener('click', () => { s.close(); editExercise(x); });
  } catch (err) { s.close(); toastError(err); }
}

/** Seconds as "1:30" (rest timers, durations in a set). */
export const clockS = (s) => { const v = Math.max(0, Math.round(s)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };

export { busy, toast };

/* ── an exercise of your own: its details and photos ──────── */

/**
 * Make or change an exercise of your own: name, muscle group, equipment,
 * how its sets are counted, the muscles it works, how to do it, photos,
 * and whether everyone can find it. Resolves to the saved exercise, or null.
 */
export async function editExercise(x0 = null, { name = '' } = {}) {
  let x = x0 && x0.id ? { ...x0 } : null;
  const seed = x || x0 || {};
  const v = { name: seed.name || name, muscle: seed.group || 'other', equipment: seed.equipment || '', type: seed.type || 'weight_reps', primary: [...(seed.primary || [])], secondary: [...(seed.secondary || [])], steps: (seed.steps || []).join('\n'), notes: seed.notes || '', public: seed.public !== false };
  const chips = (key, list, attr) => html`<div class="chips xe__chips" role="group">${list.map(([val, t]) => html`<button type="button" class="chip" ${raw(attr)}="${val}" aria-pressed="${String(Array.isArray(v[key]) ? v[key].includes(val) : v[key] === val)}">${t}</button>`)}</div>`;
  const fine = MUSCLES_FINE.map((m) => [m, cap(m)]);
  const photos = () => (x ? html`<div class="xe__pics">${x.images.map((src, i) => html`<figure class="xe__pic"><img src="${src}" alt="Photo ${i + 1}" loading="lazy">
      <span class="xe__pica">${i ? html`<button type="button" class="iconbtn iconbtn--s" data-pfirst="${i}" aria-label="Show this one first">${ic('up', { size: 's' })}</button>` : html`<span class="xe__first">First</span>`}<button type="button" class="iconbtn iconbtn--s" data-pdel="${i}" aria-label="Remove photo ${i + 1}">${ic('trash', { size: 's' })}</button></span></figure>`)}
      ${x.images.length < 6 ? html`<button type="button" class="xe__padd press" data-padd>${ic('camera')}<span>Add a photo</span></button>` : ''}</div>`
    : html`<p class="muted small">Save it first, then add photos.</p>`);
  const s = sheet({
    title: x ? 'Edit exercise' : 'New exercise',
    cls: 'sheet--tall',
    body: html`<form class="form xe" id="xe-form" novalidate>
      <div class="field"><label class="field__label" for="xe-name">Name</label><input class="input" id="xe-name" data-v="name" value="${v.name}" maxlength="80" autocomplete="off" required></div>
      <div class="field"><span class="field__label">Muscle group</span>${chips('muscle', [...GROUPS.slice(1), ['other', 'Other']], 'data-mg')}</div>
      <div class="xp__make-row">
        <div class="field"><label class="field__label" for="xe-eq">Equipment</label><select class="select" id="xe-eq" data-v="equipment"><option value="">None given</option>${EQUIP.slice(1).map(([val, t]) => html`<option value="${val}" ${val === v.equipment ? 'selected' : ''}>${t}</option>`)}</select></div>
        <div class="field"><label class="field__label" for="xe-type">Counted as</label><select class="select" id="xe-type" data-v="type">${Object.entries(TYPE_TEXT).map(([val, t]) => html`<option value="${val}" ${val === v.type ? 'selected' : ''}>${t}</option>`)}</select></div>
      </div>
      <div class="field"><span class="field__label">Works mainly</span>${chips('primary', fine, 'data-mp')}</div>
      <div class="field"><span class="field__label">And also</span>${chips('secondary', fine, 'data-ms')}</div>
      <div class="field"><label class="field__label" for="xe-steps">How to do it</label><textarea class="textarea" id="xe-steps" data-v="steps" rows="4" maxlength="4000" placeholder="One step per line">${v.steps}</textarea></div>
      <div class="field"><label class="field__label" for="xe-notes">Notes</label><input class="input" id="xe-notes" data-v="notes" value="${v.notes}" maxlength="500" placeholder="e.g. seat on 4" autocomplete="off"></div>
      <div class="field"><span class="field__label">Photos</span><div data-photos>${photos()}</div></div>
      <div class="me-srow"><div class="me-srow__b"><p class="me-srow__t">Share with everyone</p><p class="me-srow__d">Anyone can find it and use it in their routines, with your name on it</p></div><label class="switch"><input type="checkbox" data-pub ${v.public ? 'checked' : ''} role="switch" aria-label="Share with everyone"><span class="switch__track"></span></label></div>
      ${x ? html`<button type="button" class="btn btn--ghost btn--s xe__del" data-xdel>${ic('trash', { size: 's' })}Delete this exercise</button>` : ''}
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="xe-form">${x ? 'Save' : 'Make it'}</button>`,
  });
  const el = s.el;
  const repaintPhotos = () => mount(el.querySelector('[data-photos]'), photos());
  const toggleIn = (key, val, b) => { const i = v[key].indexOf(val); if (i >= 0) v[key].splice(i, 1); else v[key].push(val); b.setAttribute('aria-pressed', String(i < 0)); };
  on(el, 'click', '[data-mg]', (e, b) => { v.muscle = b.dataset.mg; el.querySelectorAll('[data-mg]').forEach((y) => y.setAttribute('aria-pressed', String(y === b))); });
  on(el, 'click', '[data-mp]', (e, b) => toggleIn('primary', b.dataset.mp, b));
  on(el, 'click', '[data-ms]', (e, b) => toggleIn('secondary', b.dataset.ms, b));
  on(el, 'input', '[data-v]', (e, t) => { v[t.dataset.v] = t.value; });
  on(el, 'change', '[data-v]', (e, t) => { v[t.dataset.v] = t.value; });
  el.querySelector('[data-pub]').addEventListener('change', (e) => { v.public = e.target.checked; });
  const body = () => ({ name: v.name.trim(), muscle: v.muscle, equipment: v.equipment || null, type: v.type, primary: v.primary, secondary: v.secondary, steps: v.steps, notes: v.notes.trim() || null, public: v.public });
  // Photos go up as they are chosen (the exercise must exist first).
  on(el, 'click', '[data-padd]', async (e, b) => {
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    for (const file of files.slice(0, 6 - x.images.length)) {
      try {
        const prep = await busy(b, () => prepImage(file, { max: 1400 }));
        const r = await busy(b, () => api.post(`/api/exercises/custom/${x.id}/photos`, undefined, { raw: prep.blob, type: 'image/jpeg' }));
        if (r) x = r.exercise;
      } catch (err) { toastError(err); break; }
    }
    repaintPhotos();
  });
  on(el, 'click', '[data-pdel]', async (e, b) => {
    try { x = (await busy(b, () => api.del(`/api/exercises/custom/${x.id}/photos/${b.dataset.pdel}`))).exercise; repaintPhotos(); } catch (err) { toastError(err); }
  });
  on(el, 'click', '[data-pfirst]', async (e, b) => {
    try { x = (await busy(b, () => api.post(`/api/exercises/custom/${x.id}/photos/${b.dataset.pfirst}/first`))).exercise; repaintPhotos(); } catch (err) { toastError(err); }
  });
  el.querySelector('[data-xdel]')?.addEventListener('click', async () => {
    if (!(await confirm({ title: `Delete "${x.name}"?`, text: 'It goes for everyone. Routines and workouts that have it keep its name.', yes: 'Delete', danger: true }))) return;
    try { await api.del(`/api/exercises/custom/${x.id}`); toast('Exercise deleted'); emit('changed', ['exercises']); s.close(null); } catch (err) { toastError(err); }
  });
  let saved = null;
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!v.name.trim()) { toast('Give the exercise a name.', { tone: 'bad' }); el.querySelector('#xe-name').focus(); return; }
    const btn = el.querySelector('button[type="submit"]');
    try {
      const r = await busy(btn, () => (x ? api.patch(`/api/exercises/custom/${x.id}`, body()) : api.post('/api/exercises/custom', body())));
      if (!r) return;
      saved = r.exercise;
      emit('changed', ['exercises']);
      if (!x) { x = saved; toast('Made. Add photos if you like.'); repaintPhotos(); el.querySelector('.sheet__title')?.replaceChildren(document.createTextNode('Edit exercise')); btn.textContent = 'Save'; return; }
      toast('Saved'); s.close(saved);
    } catch (err) { toastError(err); }
  });
  const out = await s.closed;
  return out === null ? null : saved || out || null;
}
