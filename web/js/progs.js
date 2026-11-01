/* Routines and programmes people share (server/sharedlib.js), as cards:
   who shares it, its routines and their exercises; a sheet to look at one
   routine set by set; and Add, which copies them into your own routines.
   On the Browse screen (views/routines.js) and on a profile. */

import { api } from './api.js';
import { go, hasProfile } from './app.js';
import { html, ic, on, sheet, toast, toastError, busy } from './ui.js';
import * as f from './format.js';
import { avatar } from './views/shared.js';

const setText = (x, s) => {
  if (x.type === 'duration') return f.isNum(s.durationS) ? `${s.durationS} s` : '';
  if (x.type === 'distance_duration') return [f.isNum(s.distanceM) ? f.dist(s.distanceM) : '', f.isNum(s.durationS) ? f.dur(s.durationS / 60) : ''].filter(Boolean).join(' in ');
  const reps = f.isNum(s.reps) ? (f.isNum(s.repsMax) ? `${s.reps}-${s.repsMax}` : `${s.reps}`) : '';
  return f.isNum(s.kg) && s.kg > 0 ? `${f.weightNum(s.kg)} ${f.weightUnit()} × ${reps}` : reps ? `${reps} reps` : '';
};

/** Cards, one per programme (a maker's folder) or lone routine. `by`: show who shares it. */
export function programmeList(progs, { by = true } = {}) {
  if (!progs?.length) return '';
  return html`<div class="prg-list">${progs.map((p, i) => {
    const title = p.folder || p.routines[0].title;
    const many = p.routines.length > 1 || p.folder;
    return html`<article class="prg fam fam-workouts">
      <div class="prg__h">
        <span class="prg__ic">${ic(many ? 'playlist' : 'dumbbell')}</span>
        <div class="prg__t"><h3>${title}</h3>
          <p class="prg__s">${[many ? f.plural(p.routines.length, 'routine') : f.plural(p.routines[0].exercises, 'exercise'), !many ? `about ${f.dur(p.routines[0].estimateMin)}` : ''].filter(Boolean).join(' · ')}</p></div>
        ${hasProfile() ? html`<button type="button" class="btn btn--s" data-prg-add="${i}">${ic('plus', { size: 's' })}Add</button>` : ''}
      </div>
      ${by && p.by ? html`<a class="prg__by" href="/u/${encodeURIComponent(p.by.username)}">${avatar(p.by)}<span>${p.by.displayName || p.by.username}</span></a>` : ''}
      <div class="prg__rts">${p.routines.map((r) => html`<button type="button" class="prg__rt press" data-prg-look="${r.id}">
        <span class="prg__rtb"><span class="prg__rtt">${r.title}</span><span class="prg__rtd">${r.names.slice(0, 5).join(', ')}${r.names.length > 5 ? `, and ${r.names.length - 5} more` : ''}</span></span>
        ${ic('right', { size: 's' })}</button>`)}</div>
    </article>`;
  })}</div>`;
}

async function addRoutines(btn, ids, label) {
  try {
    const r = await busy(btn, () => api.post('/api/routines/copy', { ids }));
    if (!r) return false;
    toast(`${label} added to your routines`, { action: 'Open', onAction: () => go(r.made.length === 1 ? `/workouts/routines/${encodeURIComponent(r.made[0])}` : '/workouts/routines') });
    return true;
  } catch (err) { toastError(err); return false; }
}

/** One shared routine, set by set, with Add. */
export async function lookSheet(id) {
  let d;
  try { d = await api.get(`/api/routines/shared/${encodeURIComponent(id)}`); } catch (err) { toastError(err); return; }
  const r = d.routine;
  const s = sheet({
    title: d.title,
    body: html`<div class="prg-look">
      ${d.by ? html`<a class="prg__by" href="/u/${encodeURIComponent(d.by.username)}">${avatar(d.by)}<span>${d.folder ? `${d.folder}, by ` : 'By '}${d.by.displayName || d.by.username}</span></a>` : ''}
      <p class="muted small">${[f.plural(d.exercises, 'exercise'), f.plural(d.sets, 'set'), `about ${f.dur(d.estimateMin)}`].join(' · ')}</p>
      ${r.notes ? html`<p class="small">${r.notes}</p>` : ''}
      <ol class="prg-ex">${r.exercises.map((x) => html`<li>
        <span class="prg-ex__n">${x.name}</span>
        <span class="prg-ex__s">${x.sets.map((st) => setText(x, st)).filter(Boolean).join(', ') || f.plural(x.sets.length, 'set')}</span>
        ${x.notes ? html`<span class="prg-ex__note">${x.notes}</span>` : ''}
      </li>`)}</ol>
    </div>`,
    foot: hasProfile() && !d.mine ? html`<button type="button" class="btn btn--tonal" data-close>Close</button><button type="button" class="btn" data-add>${ic('plus', { size: 's' })}Add to my routines</button>` : '',
  });
  s.el.querySelector('[data-add]')?.addEventListener('click', async (e) => { if (await addRoutines(e.currentTarget, [d.id], `"${d.title}"`)) s.close(); });
}

/** Wire the cards under `root`; `list()` gives the programmes as drawn. */
export function bindProgrammes(root, list) {
  on(root, 'click', '[data-prg-look]', (e, b) => lookSheet(b.dataset.prgLook));
  on(root, 'click', '[data-prg-add]', (e, b) => {
    const p = list()[Number(b.dataset.prgAdd)];
    if (!p) return;
    addRoutines(b, p.routines.map((r) => r.id), p.folder ? `"${p.folder}" (${f.plural(p.routines.length, 'routine')})` : `"${p.routines[0].title}"`);
  });
}
