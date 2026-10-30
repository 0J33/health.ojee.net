/* Workouts, Routines: your routines by folder (start one in a tap),
   ready-made programmes to begin with, routines copied from Hevy; the
   routine editor; and the exercise library to browse. */

import { api } from '../api.js';
import { app, go, listen } from '../app.js';
import { html, mount, ic, on, head, banner, toast, toastError, busy, confirm, sheet, errorState, skeleton, field, errText } from '../ui.js';
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

function routineCard(r) {
  const names = r.names.slice(0, 4).join(', ') + (r.names.length > 4 ? `, and ${r.names.length - 4} more` : '');
  return html`<article class="rt" data-rid="${r.id}">
    <a class="rt__main" href="/workouts/routines/${encodeURIComponent(r.id)}">
      <h3 class="rt__t">${r.title}</h3>
      <p class="rt__x">${names || 'No exercises yet'}</p>
      <p class="rt__m">${[f.plural(r.exercises, 'exercise'), f.plural(r.sets, 'set'), r.exercises ? `about ${f.dur(r.estimateMin)}` : '', r.lastUsed ? `last ${f.ago(r.lastUsed)}` : ''].filter(Boolean).join(' · ')}${r.hevy?.linked ? html` · <span class="rt__hv">${ic('refresh', { size: 's' })}Hevy</span>` : ''}</p>
      ${r.hevy?.blocked ? html`<p class="rt__warn small">Not in Hevy yet: ${r.hevy.blocked.join(', ')} could not be made there.</p>` : ''}
    </a>
    <div class="rt__act">
      <button type="button" class="btn btn--s" data-start="${r.id}" ${r.exercises ? '' : 'disabled'}>${ic('play', { size: 's' })}Start</button>
      <button type="button" class="iconbtn" data-menu="${r.id}" aria-label="More for ${r.title}">${ic('more')}</button>
    </div>
  </article>`;
}

async function listView(ctx) {
  const { root } = ctx;
  document.title = 'Routines · Health';
  let d = null;
  const paint = () => {
    const by = new Map();
    for (const r of d.routines) { const k = r.folder || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    const folders = [...by.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    const hevy = d.hevy.filter((h) => !h.copied);
    mount(root, html`
      ${head({ title: 'Routines', back: '/workouts', actions: html`<a class="btn btn--s" href="/workouts/routines/new">${ic('plus', { size: 's' })}New routine</a>` })}
      <div class="stack stack--l narrow-l">
        <div class="btnrow">
          <button type="button" class="btn btn--tonal btn--s" data-empty>${ic('play', { size: 's' })}Empty workout</button>
          <a class="btn btn--tonal btn--s" href="/workouts/exercises">${ic('book', { size: 's' })}Exercises</a>
          <a class="btn btn--tonal btn--s" href="/workouts/record">${ic('locate', { size: 's' })}Record a route</a>
        </div>
        ${!d.routines.length ? html`<div class="group group--pad"><div class="stack">
          <p class="h3">Plan your sessions</p>
          <p class="prose small">A routine is a session you repeat: its exercises, sets, weights and rest. Start one and it opens with everything filled in, and last time's numbers beside each set. Make your own, or begin with a programme below and change it to suit you.</p>
        </div></div>` : ''}
        ${folders.map((k) => html`<section class="rtf">
          <div class="sec__head"><h2 class="h2 rtf__h">${k ? html`${ic('folder', { size: 's' })}<span>${k}</span>` : d.routines.length > by.get('').length ? 'Not in a folder' : 'Your routines'}</h2>
            ${k ? html`<button type="button" class="btn btn--ghost btn--s" data-folder="${k}">Rename</button>` : ''}</div>
          <div class="rtl">${by.get(k).map(routineCard)}</div>
        </section>`)}
        ${hevy.length ? html`<section>
          <div class="sec__head"><h2 class="h2">In Hevy</h2></div>
          <p class="muted small">Routines from your Hevy account. Copy one here to start it, change it and see its history.</p>
          <div class="group">${hevy.map((h) => html`<div class="row"><span class="row__ic">${ic('playlist')}</span><span class="row__body"><span class="row__t">${h.title}</span><span class="row__d">${[h.folder, f.plural(h.exercises, 'exercise'), f.plural(h.sets, 'set')].filter(Boolean).join(' · ')}</span></span><button type="button" class="btn btn--tonal btn--s" data-hevy="${h.id}">Copy here</button></div>`)}</div>
        </section>` : ''}
        <section>
          <div class="sec__head"><h2 class="h2">Programmes to start from</h2></div>
          <div class="rtl">${d.starters.map((s) => html`<article class="rt rt--starter">
            <div class="rt__main"><h3 class="rt__t">${s.title}</h3><p class="rt__x">${s.text}</p>
              <p class="rt__m">${s.routines.map((r) => `${r.title}: ${f.plural(r.exercises.length, 'exercise')}`).join(' · ')}</p></div>
            <div class="rt__act">${d.routines.some((r) => r.from?.kind === 'starter' && r.from.id === s.id) ? html`<span class="badge badge--ok">${ic('check', { size: 's' })}Added</span><button type="button" class="btn btn--ghost btn--s" data-starter="${s.id}">Add again</button>` : html`<button type="button" class="btn btn--tonal btn--s" data-starter="${s.id}">${ic('plus', { size: 's' })}Add ${s.routines.length > 1 ? `all ${s.routines.length}` : 'it'}</button>`}</div>
          </article>`)}</div>
          <p class="muted small rt__foot">Weights are left empty: the first session fills them in, and the next one shows them.</p>
        </section>
      </div>`);
  };
  const load = async () => {
    try { d = await api.get('/api/routines'); if (ctx.alive()) paint(); } catch (err) { mount(root, html`${head({ title: 'Routines', back: '/workouts' })}${errorState(err)}`); }
  };
  on(root, 'click', '[data-start]', (e, b) => startRoutine(b.dataset.start, b));
  on(root, 'click', '[data-empty]', (e, b) => startRoutine(null, b));
  on(root, 'click', '[data-starter]', async (e, b) => {
    try { const r = await busy(b, () => api.post('/api/routines/starter', { id: b.dataset.starter })); if (!r) return; d = { ...d, ...r }; toast(`${f.plural(r.made.length, 'routine')} added`); paint(); } catch (err) { toastError(err); }
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
  let detail = null; let folders = []; let dirty = false;
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
      ${head({ title: isNew ? 'New routine' : 'Edit routine', back: isNew ? '/workouts/routines' : '/workouts/routines', actions: !isNew && r.exercises.length ? html`<button type="button" class="btn btn--s" data-start>${ic('play', { size: 's' })}Start</button>` : '' })}
      <form class="rte stack" novalidate data-form>
        <div class="group group--pad"><div class="form">
          <div class="field"><label class="field__label" for="rt-title">Name</label><input class="input" id="rt-title" data-r="title" value="${r.title}" maxlength="80" placeholder="e.g. Push day" autocomplete="off" required></div>
          <div class="rte__two">
            <div class="field"><label class="field__label" for="rt-folder">Folder (optional)</label><input class="input" id="rt-folder" data-r="folder" value="${r.folder || ''}" maxlength="60" placeholder="e.g. Push Pull Legs" list="rt-folders" autocomplete="off"><datalist id="rt-folders">${folders.map((x) => html`<option value="${x}">`)}</datalist></div>
            <div class="field"><label class="field__label" for="rt-notes">Notes (optional)</label><input class="input" id="rt-notes" data-r="notes" value="${r.notes || ''}" maxlength="1000" placeholder="e.g. heavy day" autocomplete="off"></div>
          </div>
        </div></div>
        ${detail?.summary?.hevy?.linked ? html`<p class="muted small rte__sum">${ic('refresh', { size: 's' })} Kept the same in Hevy: changes here go there a moment after saving, and changes there come here.</p>` : ''}
        ${detail?.summary?.hevy?.blocked ? banner({ tone: 'warn', title: 'Not in Hevy yet', text: `${detail.summary.hevy.blocked.join(', ')} could not be made in your Hevy library (a limit of the Hevy account?). Replace it with an exercise Hevy has, and the routine goes there.` }) : ''}
        ${r.exercises.length ? html`<p class="muted small rte__sum">${f.plural(r.exercises.length, 'exercise')} · ${f.plural(sets, 'set')}. Tap a set's number to make it a warm-up (W), a drop set (D) or to failure (F). A rep range like 8 to 12 is "as planned" anywhere in it.</p>` : ''}
        <div class="sxl" data-list>${r.exercises.map((x, i) => exerciseCard(x, i, { open: open.has(i) }))}</div>
        <button type="button" class="btn btn--tonal rte__add" data-add>${ic('plus', { size: 's' })}Add exercises</button>
        ${!isNew && detail?.history?.length ? html`<section>
          <div class="sec__head"><h2 class="h2">Done with this routine</h2></div>
          <div class="group">${detail.history.map((h) => html`<a class="row" href="/workouts/${encodeURIComponent(h.id)}"><span class="row__ic">${ic('history')}</span><span class="row__body"><span class="row__t">${f.dateTime(h.start)}</span><span class="row__d">${[h.durationMin ? f.dur(h.durationMin) : '', f.isNum(h.sets) ? f.plural(h.sets, 'set') : '', f.isNum(h.volumeKg) ? `${f.int(f.weightVal(h.volumeKg))} ${f.weightUnit()} lifted` : ''].filter(Boolean).join(' · ')}</span></span>${ic('right', { size: 's' })}</a>`)}</div>
        </section>` : ''}
        <div class="rte__bar">
          ${!isNew ? html`<button type="button" class="btn btn--ghost" data-del>${ic('trash', { size: 's' })}Delete</button>` : html`<a class="btn btn--ghost" href="/workouts/routines">Cancel</a>`}
          <button type="submit" class="btn">${isNew ? 'Save routine' : 'Save changes'}</button>
        </div>
      </form>`);
  };

  const form = () => root.querySelector('[data-form]');
  const touch = () => { dirty = true; };
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
    const btn = form().querySelector('button[type="submit"]');
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
  ctx.onLeave(() => window.removeEventListener('beforeunload', warn));

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
        <label class="xp__q">${ic('search', { size: 's' })}<input class="input" type="search" data-q value="${q}" placeholder="Search 876 exercises" autocomplete="off" enterkeyhint="search" aria-label="Search exercises"></label>
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
