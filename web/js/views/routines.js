/* Workouts, Routines: your routines by folder (start one in a tap),
   ready-made programmes to begin with, routines copied from Hevy; the
   routine editor; and the exercise library to browse. */

import { api } from '../api.js';
import { app, go, listen } from '../app.js';
import { html, raw, mount, ic, on, head, banner, toast, toastError, busy, confirm, sheet, errorState, skeleton, field, errText } from '../ui.js';
import * as f from '../format.js';
import { pickExercises, exerciseInfo, thumb, MUSCLE, GROUPS, EQUIP, TYPE_TEXT, clockS } from '../exlib.js';
import { exerciseCard, readInput, nextSet, cycleKind, RESTS } from '../setsui.js';

const MUSCLE_ORDER = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'other'];

/** Start a workout from a routine and open its log. */
export async function startRoutine(id, btn) {
  try {
    const r = await busy(btn, () => api.post('/api/workouts/start', id ? { routineId: id } : { log: true }));
    if (r === undefined) return;
    go(`/workouts/${encodeURIComponent(r.started)}`);
  } catch (err) {
    if (err.status === 409) {
      toast(errText(err), { tone: 'bad', action: 'Open it', onAction: () => go('/workouts') });
    } else toastError(err);
  }
}

/* ── the list ─────────────────────────────────────────────── */

/** A routine as a calm row: name and one line; tap to edit, play to start. */
function routineCard(r, { sorting = false } = {}) {
  if (sorting) {
    return html`<div class="rtrow rtrow--sort" data-rid="${r.id}">
      <span class="rtrow__grip" data-grip aria-hidden="true">${ic('drag', { size: 's' })}</span>
      <span class="rtrow__b"><span class="xrow__t">${r.title}</span></span>
      <button type="button" class="iconbtn iconbtn--s" data-mv="up" aria-label="Move ${r.title} up">${ic('up', { size: 's' })}</button>
      <button type="button" class="iconbtn iconbtn--s" data-mv="down" aria-label="Move ${r.title} down">${ic('down', { size: 's' })}</button>
    </div>`;
  }
  const line = [f.plural(r.exercises, 'exercise'), r.exercises ? `about ${f.dur(r.estimateMin)}` : '', r.lastUsed ? `last ${f.ago(r.lastUsed)}` : '', r.hevy?.linked ? 'Hevy' : ''].filter(Boolean).join(' · ');
  return html`<div class="rtrow" data-rid="${r.id}">
    <a class="rtrow__b" href="/workouts/routines/${encodeURIComponent(r.id)}">
      <span class="xrow__t">${r.title}</span>
      <span class="xrow__d ${r.hevy?.blocked ? 'rtrow__warn' : ''}">${r.hevy?.blocked ? `Not in Hevy yet: ${r.hevy.blocked.join(', ')}` : line}</span>
    </a>
    <button type="button" class="iconbtn iconbtn--s" data-menu="${r.id}" aria-label="More for ${r.title}">${ic('more', { size: 's' })}</button>
    <button type="button" class="b-play" data-start="${r.id}" ${r.exercises ? '' : 'disabled'} aria-label="Start ${r.title}">${ic('play')}</button>
  </div>`;
}

/** A plain row (icon, title, one line, chevron) that opens something. */
const xrow = ({ attrs, icon, title, text, fam = 'workouts' }) => html`<button type="button" class="xrow press" ${raw(attrs)}>
  <span class="xrow__ic fam fam-${fam}">${ic(icon)}</span>
  <span class="xrow__b"><span class="xrow__t">${title}</span>${text ? html`<span class="xrow__d">${text}</span>` : ''}</span>
  <span class="xrow__chev">${ic('right', { size: 's' })}</span></button>`;

/** A ready-made programme: what it is, its routines, and the way to add them. */
function starterSheet(st, d, add) {
  const done = d.routines.some((r) => r.from?.kind === 'starter' && r.from.id === st.id);
  const s = sheet({
    title: st.title,
    body: html`<div class="pg-sh"><p class="pg-sh__note">${st.text}</p>
      <div class="xrows">${st.routines.map((r) => html`<div class="xrow xrow--plain"><span class="xrow__ic fam fam-workouts">${ic('playlist')}</span><span class="xrow__b"><span class="xrow__t">${r.title}</span><span class="xrow__d">${r.exercises.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean).join(', ') || f.plural(r.exercises.length, 'exercise')}</span></span><span class="xrow__v">${f.int(r.exercises.length)}</span></div>`)}</div>
      <p class="pg-sh__note">Weights start empty: your first session fills them in.</p></div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Close</button><button type="button" class="btn" data-add>${done ? 'Add again' : `Add ${st.routines.length > 1 ? `all ${st.routines.length}` : 'it'}`}</button>`,
  });
  s.el.querySelector('[data-add]').addEventListener('click', (e) => add(e.currentTarget, () => s.close()));
}

/**
 * Drag a row by its grip to a new place among its siblings. `done` gets the
 * container once the row is let go somewhere new.
 */
function sortable(root, done) {
  let st = null;
  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || st) return;
    const row = grip.closest('[data-rid]');
    e.preventDefault();
    grip.setPointerCapture?.(e.pointerId);
    st = { row, grip, list: row.parentElement, y: e.clientY, moved: false };
    row.classList.add('is-drag');
  });
  root.addEventListener('pointermove', (e) => {
    if (!st) return;
    const { row, list } = st;
    let dy = e.clientY - st.y;
    // Past the middle of a neighbour: the row takes its place.
    const prev = row.previousElementSibling; const next = row.nextElementSibling;
    if (next && dy > next.offsetHeight / 2) { list.insertBefore(next, row); st.y += next.offsetHeight + 2; st.moved = true; dy = e.clientY - st.y; }
    else if (prev && dy < -prev.offsetHeight / 2) { list.insertBefore(row, prev); st.y -= prev.offsetHeight + 2; st.moved = true; dy = e.clientY - st.y; }
    row.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!st) return;
    const { row, list, moved } = st;
    st = null;
    row.classList.remove('is-drag');
    row.style.transform = '';
    if (moved) done(list);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}

async function listView(ctx) {
  const { root } = ctx;
  document.title = 'Routines · Health';
  let d = null; let sorting = false;
  const paint = () => {
    const by = new Map();
    for (const r of d.routines) { const k = r.folder || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    const folders = [...by.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    const hevy = d.hevy.filter((h) => !h.copied);
    mount(root, html`
      ${head({ title: 'Routines', back: '/workouts', actions: sorting ? html`<button type="button" class="btn btn--s" data-sort>Done</button>` : html`${d.routines.length > 1 ? html`<button type="button" class="iconbtn" data-sort aria-label="Reorder routines">${ic('sort')}</button>` : ''}<a class="btn btn--s" href="/workouts/routines/new">${ic('plus', { size: 's' })}New routine</a>` })}
      <div class="stack trn-deep narrow-l">
        <nav class="trn-links trn-links--ic" aria-label="Start or browse">
          <button type="button" class="press" data-empty>${ic('dumbbell', { size: 's' })}Empty</button>
          <a class="press" href="/workouts/record">${ic('route', { size: 's' })}Route</a>
          <a class="press" href="/workouts/exercises">${ic('book', { size: 's' })}Exercises</a>
        </nav>
        ${!d.routines.length ? html`<p class="rt-intro">A routine is a session you repeat, ready to start with last time's numbers. Make one, or add a programme below.</p>` : ''}
        ${folders.map((k) => html`<div class="bsec"><h2>${k || (d.routines.length > by.get('').length ? 'Not in a folder' : 'Your routines')}</h2>${k ? html`<button type="button" data-folder="${k}">Rename</button>` : ''}</div>
          <div class="xrows" data-sortlist>${by.get(k).map((r) => routineCard(r, { sorting }))}</div>`)}
        ${sorting ? html`<p class="muted small">Drag a routine by its handle, or use the arrows. Each folder keeps its own order.</p>` : ''}
        ${hevy.length ? html`<div class="bsec"><h2>In Hevy</h2><span class="hs-s">Copy one here to start it</span></div>
          <div class="xrows">${hevy.map((h) => html`<div class="rtrow"><span class="rtrow__b"><span class="xrow__t">${h.title}</span><span class="xrow__d">${[h.folder, f.plural(h.exercises, 'exercise'), f.plural(h.sets, 'set')].filter(Boolean).join(' · ')}</span></span><button type="button" class="pill-btn pill-btn--soft" data-hevy="${h.id}">Copy</button></div>`)}</div>` : ''}
        <div class="bsec"><h2>Programmes</h2></div>
        <div class="xrows">${d.starters.map((st) => xrow({ attrs: `data-prog="${st.id}"`, icon: 'playlist', title: st.title, text: d.routines.some((r) => r.from?.kind === 'starter' && r.from.id === st.id) ? `Added · ${st.routines.map((r) => r.title).join(', ')}` : `${f.plural(st.routines.length, 'routine')}: ${st.routines.map((r) => r.title).join(', ')}` }))}</div>
      </div>`);
  };
  const load = async () => {
    try { d = await api.get('/api/routines'); if (ctx.alive()) paint(); } catch (err) { mount(root, html`${head({ title: 'Routines', back: '/workouts' })}${errorState(err)}`); }
  };
  // Reordering: the new order of every routine, as the page shows them.
  const saveOrder = async () => {
    const ids = [...root.querySelectorAll('[data-sortlist] [data-rid]')].map((x) => x.dataset.rid);
    const pos = new Map(ids.map((id, i) => [id, i]));
    d.routines.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    try { d = { ...d, ...(await api.post('/api/routines/order', { ids })) }; } catch (err) { toastError(err); load(); }
  };
  sortable(root, () => saveOrder());
  on(root, 'click', '[data-sort]', () => { sorting = !sorting; paint(); });
  on(root, 'click', '[data-mv]', (e, b) => {
    const row = b.closest('[data-rid]'); const list = row.parentElement;
    if (b.dataset.mv === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    else if (b.dataset.mv === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    else return;
    b.focus();
    saveOrder();
  });
  on(root, 'click', '[data-start]', (e, b) => startRoutine(b.dataset.start, b));
  on(root, 'click', '[data-empty]', (e, b) => startRoutine(null, b));
  on(root, 'click', '[data-prog]', (e, b) => {
    const st = d.starters.find((x) => x.id === b.dataset.prog);
    if (!st) return;
    starterSheet(st, d, async (btn, close) => {
      try { const r = await busy(btn, () => api.post('/api/routines/starter', { id: st.id })); if (!r) return; close(); d = { ...d, ...r }; toast(`${f.plural(r.made.length, 'routine')} added`); paint(); } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-hevy]', async (e, b) => {
    try { const r = await busy(b, () => api.post('/api/routines/from-hevy', { id: b.dataset.hevy })); if (!r) return; toast(`"${r.routine.title}" copied`); load(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-folder]', async (e, b) => {
    const from = b.dataset.folder;
    const to = await askText({ title: 'Rename folder', label: 'Folder name', value: from, hint: 'Leave it empty to take the routines out of the folder.' });
    if (to === null) return;
    try { d = { ...d, ...(await api.patch('/api/routines/folders', { from, to: to || null })) }; paint(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-menu]', (e, b) => routineMenu(d.routines.find((r) => r.id === b.dataset.menu), d.folders, load));
  ctx.onLeave(listen('changed', (what) => { if (what.includes('routines')) load(); }));
  mount(root, html`${head({ title: 'Routines', back: '/workouts' })}${skeleton('page')}`);
  await load();
}

/** A small sheet asking for one line of text. Resolves to the text, or null. */
export function askText({ title, label, value = '', hint = '', save = 'Save', list = [] }) {
  const s = sheet({
    title,
    body: html`<form class="form" id="ask-form" novalidate>${field({ label, name: 'v', value, hint, attrs: `maxlength="80" autocomplete="off" ${list.length ? 'list="ask-list"' : ''}` })}${list.length ? html`<datalist id="ask-list">${list.map((x) => html`<option value="${x}">`)}</datalist>` : ''}</form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="ask-form">${save}</button>`,
  });
  s.el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); s.close(e.target.elements.v.value.trim()); });
  return s.closed.then((v) => (typeof v === 'string' ? v : null));
}

function routineMenu(r, folders, done) {
  if (!r) return;
  const s = sheet({
    title: r.title,
    body: html`<div class="group">
      <a class="row" href="/workouts/routines/${encodeURIComponent(r.id)}"><span class="row__ic">${ic('edit')}</span><span class="row__body"><span class="row__t">Edit</span></span></a>
      <button type="button" class="row" data-m="dup"><span class="row__ic">${ic('copy')}</span><span class="row__body"><span class="row__t">Duplicate</span></span></button>
      <button type="button" class="row" data-m="move"><span class="row__ic">${ic('folder')}</span><span class="row__body"><span class="row__t">Move to a folder</span><span class="row__d">${r.folder || 'Not in a folder'}</span></span></button>
      <button type="button" class="row row--danger" data-m="del"><span class="row__ic">${ic('trash')}</span><span class="row__body"><span class="row__t">Delete</span></span></button>
    </div>`,
  });
  on(s.el, 'click', '[data-m]', async (e, b) => {
    const m = b.dataset.m;
    s.close();
    try {
      if (m === 'dup') { const x = await api.post(`/api/routines/${r.id}/duplicate`, {}); toast(`"${x.routine.title}" made`); }
      if (m === 'move') {
        const to = await askText({ title: 'Move to a folder', label: 'Folder', value: r.folder || '', hint: 'A new name makes a new folder; empty takes it out.', list: folders, save: 'Move' });
        if (to === null) return;
        await api.patch(`/api/routines/${r.id}`, { folder: to || null });
      }
      if (m === 'del') {
        if (!(await confirm({ title: `Delete "${r.title}"?`, text: 'The routine goes. Workouts done with it stay in your log.', yes: 'Delete', danger: true }))) return;
        const x = await api.del(`/api/routines/${r.id}`);
        toast(x?.keptInHevy ? 'Deleted here. It stays in Hevy (Hevy does not let other apps delete routines); delete it there too if you like.' : 'Routine deleted', { ms: x?.keptInHevy ? 9000 : undefined });
      }
      done();
    } catch (err) { toastError(err); }
  });
}

/* ── the editor ───────────────────────────────────────────── */

async function editView(ctx) {
  const { root } = ctx;
  const isNew = ctx.name === 'new';
  let r = { title: '', folder: '', notes: '', exercises: [] };
  let detail = null; let folders = []; let dirty = false; let sorting = false;
  const open = new Set();

  async function load() {
    const list = await api.get('/api/routines');
    folders = list.folders;
    if (!isNew) {
      detail = await api.get(`/api/routines/${encodeURIComponent(ctx.params.rid)}`);
      r = structuredClone(detail.routine);
    } else if (ctx.query.get('folder')) r.folder = ctx.query.get('folder');
    r.exercises.forEach((_, i) => open.add(i));
  }

  const paint = () => {
    document.title = `${isNew ? 'New routine' : r.title || 'Routine'} · Health`;
    const sets = r.exercises.reduce((a, x) => a + x.sets.length, 0);
    mount(root, html`
      ${head({ title: isNew ? 'New routine' : 'Edit routine', back: '/workouts/routines', actions: html`${!isNew && r.exercises.length ? html`<button type="button" class="btn btn--s btn--tonal" data-start>${ic('play', { size: 's' })}Start</button>` : ''}<button type="submit" class="btn btn--s" form="rt-form" data-save>Save</button>` })}
      <form class="rte stack trn-deep" id="rt-form" novalidate data-form>
        <div class="field"><input class="input rte__name" id="rt-title" data-r="title" value="${r.title}" maxlength="80" placeholder="Routine name" aria-label="Routine name" autocomplete="off" required></div>
        <details class="ex-more rte__more" ${r.folder || r.notes ? '' : ''}>
          <summary><span class="ex-more__b"><span class="ex-more__t">Folder and notes</span><span class="ex-more__s">${[r.folder || 'No folder', r.notes || '', detail?.summary?.hevy?.linked ? 'kept the same in Hevy' : ''].filter(Boolean).join(' · ')}</span></span>${ic('right', { size: 's' })}</summary>
          <div class="ex-more__in form">
            <div class="field"><label class="field__label" for="rt-folder">Folder</label><input class="input" id="rt-folder" data-r="folder" value="${r.folder || ''}" maxlength="60" placeholder="e.g. Push Pull Legs" list="rt-folders" autocomplete="off"><datalist id="rt-folders">${folders.map((x) => html`<option value="${x}">`)}</datalist></div>
            <div class="field"><label class="field__label" for="rt-notes">Notes</label><input class="input" id="rt-notes" data-r="notes" value="${r.notes || ''}" maxlength="1000" placeholder="e.g. heavy day" autocomplete="off"></div>
            ${detail?.summary?.hevy?.linked ? html`<p class="entry__note">${ic('refresh', { size: 's' })}<span>Kept the same in Hevy: changes go both ways.</span></p>` : ''}
          </div>
        </details>
        ${detail?.summary?.hevy?.blocked ? banner({ tone: 'warn', title: 'Not in Hevy yet', text: `${detail.summary.hevy.blocked.join(', ')} is not in your Hevy library. Replace it with one Hevy has.` }) : ''}
        ${r.exercises.length ? html`<div class="bsec"><h2>${f.plural(r.exercises.length, 'exercise')}</h2>${r.exercises.length > 1 ? html`<button type="button" data-xsort>${sorting ? 'Done' : 'Reorder'}</button>` : html`<span class="hs-s">${f.plural(sets, 'set')}</span>`}</div>
          ${sorting ? '' : html`<p class="hs-s rte__tip">${f.plural(sets, 'set')} · tap a set number for W, D or F</p>`}` : ''}
        ${sorting ? html`<div class="xrows" data-sortlist>${r.exercises.map((x, i) => html`<div class="rtrow rtrow--sort" data-rid="${i}">
            <span class="rtrow__grip" data-grip aria-hidden="true">${ic('drag', { size: 's' })}</span>
            <span class="rtrow__b"><span class="xrow__t">${x.name}</span><span class="xrow__d">${f.plural(x.sets.length, 'set')}</span></span>
            <button type="button" class="iconbtn iconbtn--s" data-xmv="up" aria-label="Move ${x.name} up">${ic('up', { size: 's' })}</button>
            <button type="button" class="iconbtn iconbtn--s" data-xmv="down" aria-label="Move ${x.name} down">${ic('down', { size: 's' })}</button>
          </div>`)}</div>
          <p class="muted small">Drag an exercise by its handle, or use the arrows.</p>`
        : html`${r.exercises.length ? '' : html`<button type="button" class="xp__newbtn" data-add>${ic('plus', { size: 's' })}<span>Add exercises, here or with the + button</span></button>`}<div class="sxl" data-list>${r.exercises.map((x, i) => exerciseCard(x, i, { open: open.has(i) }))}</div>
        <button type="button" class="rte__fab press" data-add aria-label="Add exercises">${ic('plus')}</button>`}
        ${!isNew && detail?.history?.length ? html`<div class="bsec"><h2>Done with this routine</h2></div>
          <div class="xrows">${detail.history.map((h) => html`<a class="xrow press" href="/workouts/${encodeURIComponent(h.id)}"><span class="xrow__ic fam fam-workouts">${ic('history')}</span><span class="xrow__b"><span class="xrow__t">${f.dateTime(h.start)}</span><span class="xrow__d">${[h.durationMin ? f.dur(h.durationMin) : '', f.isNum(h.sets) ? f.plural(h.sets, 'set') : '', f.isNum(h.volumeKg) ? `${f.volume(h.volumeKg)} lifted` : ''].filter(Boolean).join(' · ')}</span></span><span class="xrow__chev">${ic('right', { size: 's' })}</span></a>`)}</div>` : ''}
        ${!isNew ? html`<div class="rte__end"><button type="button" class="btn btn--ghost btn--s rte__del" data-del>${ic('trash', { size: 's' })}Delete routine</button></div>` : ''}
      </form>`);
  };

  const touch = () => { dirty = true; };
  // Reordering exercises: the folded list's order becomes the routine's.
  const applyOrder = () => {
    const idx = [...root.querySelectorAll('[data-sortlist] [data-rid]')].map((x) => Number(x.dataset.rid));
    if (idx.every((v, i) => v === i)) return;
    const was = new Set(open);
    r.exercises = idx.map((i) => r.exercises[i]);
    open.clear(); idx.forEach((oldI, newI) => { if (was.has(oldI)) open.add(newI); });
    root.querySelectorAll('[data-sortlist] [data-rid]').forEach((x, i) => { x.dataset.rid = String(i); });
    touch();
  };
  sortable(root, applyOrder);
  on(root, 'click', '[data-xsort]', () => { sorting = !sorting; paint(); });
  on(root, 'click', '[data-xmv]', (e, b) => {
    const row = b.closest('[data-rid]'); const list = row.parentElement;
    if (b.dataset.xmv === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    else if (b.dataset.xmv === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    else return;
    b.focus();
    applyOrder();
  });
  on(root, 'input', '[data-r]', (e, input) => { r[input.dataset.r] = input.value; touch(); });
  on(root, 'input', '.sx [data-k]', (e, input) => { const x = r.exercises[Number(input.closest('[data-x]').dataset.x)]; if (x) { readInput(x, input); touch(); } });
  on(root, 'click', '[data-add]', async () => {
    const got = await pickExercises({ title: 'Add exercises' });
    if (!got.length) return;
    for (const g of got) {
      const x = { name: g.name, libId: g.libId, templateId: g.templateId, muscle: g.muscle || 'other', type: g.type || 'weight_reps', image: g.image, restS: 90, notes: null, sets: [] };
      // Three sets to start with; the last time's numbers when there were any.
      let last = [];
      try { last = (await api.get(`/api/exercises/last?name=${encodeURIComponent(g.name)}`)).sets || []; } catch { /* none */ }
      x.sets = last.length ? last.map((s) => ({ type: s.type || 'normal', kg: s.kg ?? null, reps: s.reps ?? null, repsMax: null, durationS: s.durationS ?? null, distanceM: s.distanceM ?? null }))
        : Array.from({ length: x.type === 'distance_duration' ? 1 : 3 }, () => ({ type: 'normal', kg: null, reps: x.type === 'duration' || x.type === 'distance_duration' ? null : 10, repsMax: null, durationS: x.type === 'duration' ? 30 : null, distanceM: null }));
      r.exercises.push(x);
      open.add(r.exercises.length - 1);
    }
    touch(); paint();
    const card = root.querySelector(`[data-x="${r.exercises.length - got.length}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.querySelector('.sx__name')?.focus({ preventScroll: true });
  });
  on(root, 'click', '.sx [data-xa]', async (e, b) => {
    const i = Number(b.closest('[data-x]').dataset.x);
    const x = r.exercises[i];
    const j = Number(b.closest('[data-s]')?.dataset.s);
    const act = b.dataset.xa;
    if (act === 'info') { if (x.libId) exerciseInfo(x.libId); else if (open.has(i)) open.delete(i); else open.add(i); if (!x.libId) paint(); return; }
    if (act === 'kind') { cycleKind(x.sets[j]); }
    else if (act === 'add-set') { x.sets.push(nextSet(x)); }
    else if (act === 'del-set') { x.sets.splice(j, 1); }
    else if (act === 'menu') { await exerciseMenu(r.exercises, i, open); }
    touch(); paint();
    if (act === 'add-set') root.querySelector(`[data-x="${i}"] [data-s="${x.sets.length - 1}"] .sx__in`)?.focus();
  });
  on(root, 'submit', '[data-form]', async (e) => {
    e.preventDefault();
    if (!r.title.trim()) { toast('Give the routine a name.', { tone: 'bad' }); root.querySelector('#rt-title').focus(); return; }
    const body = { title: r.title.trim(), folder: (r.folder || '').trim() || null, notes: (r.notes || '').trim() || null, exercises: r.exercises.map(({ image: _i, last: _l, ...x }) => x) };
    const btn = root.querySelector('[data-save]');
    try {
      const out = await busy(btn, () => (isNew ? api.post('/api/routines', body) : api.put(`/api/routines/${encodeURIComponent(ctx.params.rid)}`, body)));
      if (!out) return;
      dirty = false;
      toast(isNew ? 'Routine saved' : 'Changes saved');
      go(`/workouts/routines/${encodeURIComponent(out.routine.id)}`, { replace: isNew });
      if (!isNew) { detail = out; r = structuredClone(out.routine); paint(); }
    } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-start]', async (e, b) => {
    if (dirty && !(await confirm({ title: 'Start without saving?', text: 'The routine has changes that are not saved. The workout starts from the saved routine.', yes: 'Start anyway' }))) return;
    startRoutine(ctx.params.rid, b);
  });
  on(root, 'click', '[data-del]', async () => {
    if (!(await confirm({ title: `Delete "${r.title}"?`, text: 'The routine goes. Workouts done with it stay in your log.', yes: 'Delete', danger: true }))) return;
    try { const x = await api.del(`/api/routines/${encodeURIComponent(ctx.params.rid)}`); toast(x?.keptInHevy ? 'Deleted here. It stays in Hevy (Hevy does not let other apps delete routines).' : 'Routine deleted', { ms: x?.keptInHevy ? 9000 : undefined }); go('/workouts/routines', { replace: true }); } catch (err) { toastError(err); }
  });
  const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  app.leaveCheck = async () => !dirty || confirm({ title: 'Leave without saving?', text: 'The changes to this routine are not saved.', yes: 'Leave', danger: true });
  ctx.onLeave(() => { window.removeEventListener('beforeunload', warn); app.leaveCheck = null; });

  mount(root, html`${head({ title: isNew ? 'New routine' : 'Routine', back: '/workouts/routines' })}${skeleton('page')}`);
  try { await load(); } catch (err) { mount(root, html`${head({ title: 'Routine', back: '/workouts/routines' })}${errorState(err)}`); return; }
  if (!ctx.alive()) return;
  paint();
  if (isNew && !r.title) setTimeout(() => root.querySelector('#rt-title')?.focus(), 50);
}

/** The menu of one exercise: move, rest, replace, superset, remove. */
export async function exerciseMenu(list, i, open, { log = false, rest = true } = {}) {
  const x = list[i];
  const s = sheet({
    title: x.name,
    body: html`<div class="stack">
      ${rest ? html`<div class="field"><label class="field__label" for="xm-rest">Rest between sets</label>
        <select class="select" id="xm-rest" data-rest>${RESTS.map((v) => html`<option value="${v}" ${v === (x.restS ?? 90) ? 'selected' : ''}>${v ? clockS(v) : 'No rest timer'}</option>`)}</select></div>` : ''}
      <div class="group">
        ${i > 0 ? html`<button type="button" class="row" data-m="up"><span class="row__ic">${ic('up')}</span><span class="row__body"><span class="row__t">Move up</span></span></button>` : ''}
        ${i < list.length - 1 ? html`<button type="button" class="row" data-m="down"><span class="row__ic">${ic('down')}</span><span class="row__body"><span class="row__t">Move down</span></span></button>` : ''}
        <button type="button" class="row" data-m="replace"><span class="row__ic">${ic('sort')}</span><span class="row__body"><span class="row__t">Replace with another exercise</span><span class="row__d">The sets stay</span></span></button>
        ${x.libId ? html`<button type="button" class="row" data-m="info"><span class="row__ic">${ic('info')}</span><span class="row__body"><span class="row__t">How to do it</span></span></button>` : ''}
        <button type="button" class="row row--danger" data-m="remove"><span class="row__ic">${ic('trash')}</span><span class="row__body"><span class="row__t">Remove ${log ? 'from this workout' : 'from the routine'}</span></span></button>
      </div>
    </div>`,
    foot: html`<button type="button" class="btn" data-close>Done</button>`,
  });
  s.el.querySelector('[data-rest]')?.addEventListener('change', (e) => { x.restS = Number(e.target.value); });
  let act = null;
  on(s.el, 'click', '[data-m]', (e, b) => { act = b.dataset.m; s.close(); });
  await s.closed;
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1;
    [list[i], list[j]] = [list[j], list[i]];
    const a = open.has(i); const b = open.has(j);
    if (a) open.add(j); else open.delete(j);
    if (b) open.add(i); else open.delete(i);
  } else if (act === 'remove') {
    if (log && x.sets.some((st) => st.done) && !(await confirm({ title: `Remove ${x.name}?`, text: 'Its ticked sets go too.', yes: 'Remove', danger: true }))) return;
    list.splice(i, 1);
  } else if (act === 'replace') {
    const [g] = await pickExercises({ multi: false, title: `Replace ${x.name}` });
    if (g) Object.assign(x, { name: g.name, libId: g.libId, templateId: g.templateId, muscle: g.muscle || x.muscle, type: g.type || x.type, image: g.image });
  } else if (act === 'info') exerciseInfo(x.libId);
}

/* ── the library ──────────────────────────────────────────── */

async function libraryView(ctx) {
  const { root } = ctx;
  document.title = 'Exercises · Health';
  let q = ctx.query.get('q') || ''; let group = ''; let equipment = ''; let offset = 0; let items = []; let total = 0; let timer = null; let seq = 0;
  mount(root, html`
    ${head({ title: 'Exercises', back: '/workouts' })}
    <div class="stack">
      <div class="xp__bar xp__bar--page">
        <label class="xp__q">${ic('search', { size: 's' })}<input class="input" type="search" data-q value="${q}" placeholder="Search 900 exercises" autocomplete="off" enterkeyhint="search" aria-label="Search exercises"></label>
        <div class="chips" role="group" aria-label="Muscle group">${GROUPS.map(([v, t]) => html`<button type="button" class="chip" data-g="${v}" aria-pressed="${String(v === '')}">${t}</button>`)}</div>
        <select class="select xp__eq" data-eq aria-label="Equipment">${EQUIP.map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select>
      </div>
      <p class="muted small" data-count aria-live="polite"></p>
      <div class="xlib" data-list></div>
      <div data-more></div>
      <p class="muted small">Exercises, photos and instructions from <a class="link" href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noopener">free-exercise-db</a>, in the public domain.</p>
    </div>`);
  const list = root.querySelector('[data-list]');
  const draw = () => {
    mount(root.querySelector('[data-count]'), `${f.int(total)} ${total === 1 ? 'exercise' : 'exercises'}`);
    mount(list, html`${items.map((x) => html`<button type="button" class="xcard" data-lib="${x.id}">
      ${x.images[0] ? html`<img class="xcard__img" src="${x.images[0]}" alt="" loading="lazy" decoding="async">` : html`<span class="xcard__img">${ic('strength')}</span>`}
      <span class="xcard__t">${x.name}</span>
      <span class="xcard__s">${[MUSCLE[x.group], x.equipment ? x.equipment[0].toUpperCase() + x.equipment.slice(1) : '', TYPE_TEXT[x.type]].filter(Boolean).join(' · ')}</span>
    </button>`)}`);
    mount(root.querySelector('[data-more]'), items.length < total ? html`<button type="button" class="btn btn--tonal btn--s" data-more-btn>Show more</button>` : '');
  };
  const load = async ({ more = false } = {}) => {
    const my = ++seq;
    if (!more) offset = 0;
    const p = new URLSearchParams({ q, limit: '48', offset: String(offset) });
    if (group) p.set('group', group);
    if (equipment) p.set('equipment', equipment);
    try {
      const r = await api.get(`/api/library?${p}`);
      if (my !== seq) return;
      items = more ? items.concat(r.exercises) : r.exercises; total = r.total;
      draw();
    } catch (err) { toastError(err); }
  };
  on(root, 'input', '[data-q]', (e, input) => { q = input.value; clearTimeout(timer); timer = setTimeout(load, 180); });
  on(root, 'click', '[data-g]', (e, b) => { group = b.dataset.g; root.querySelectorAll('[data-g]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); load(); });
  on(root, 'change', '[data-eq]', (e, s) => { equipment = s.value; load(); });
  on(root, 'click', '[data-lib]', (e, b) => exerciseInfo(b.dataset.lib));
  on(root, 'click', '[data-more-btn]', (e, b) => { offset = items.length; busy(b, () => load({ more: true })); });
  await load();
}

export default async function routines(ctx) {
  if (ctx.name === 'library') return libraryView(ctx);
  if (ctx.name === 'new' || ctx.name === 'edit') return editView(ctx);
  return listView(ctx);
}

export { MUSCLE_ORDER, thumb };
