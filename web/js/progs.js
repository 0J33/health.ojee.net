/* Routines and programmes people share (server/sharedlib.js), as cards:
   who shares it, its routines and their exercises; a sheet to look at one
   routine set by set; and Add, which copies them into your own routines.
   On the Browse screen (views/routines.js) and on a profile. */

import { api } from './api.js';
import { go, hasProfile } from './app.js';
import { html, ic, on, sheet, toast, toastError, busy } from './ui.js';
import * as f from './format.js';
import { avatar } from './views/shared.js';
import { restPrefs } from './restui.js';

const setText = (x, s) => {
  if (x.type === 'duration') return f.isNum(s.durationS) ? `${s.durationS} s` : '';
  if (x.type === 'distance_duration') return [f.isNum(s.distanceM) ? f.dist(s.distanceM) : '', f.isNum(s.durationS) ? f.dur(s.durationS / 60) : ''].filter(Boolean).join(' in ');
  const reps = f.isNum(s.reps) ? (f.isNum(s.repsMax) ? `${s.reps}-${s.repsMax}` : `${s.reps}`) : '';
  return f.isNum(s.kg) && s.kg > 0 ? `${f.weightNum(s.kg)} ${f.weightUnit()} × ${reps}` : reps ? `${reps} reps` : '';
};

const MUSCLE_NAME = (m) => { const t = String(m || '').trim(); return t && t !== 'other' ? t[0].toUpperCase() + t.slice(1) : ''; };
/** The muscles a programme works most, in order: "Chest, Back, Legs". */
function musclesOf(routines, max = 4) {
  const score = new Map();
  for (const r of routines) (r.muscles || []).forEach((m, i) => { const k = MUSCLE_NAME(m); if (k) score.set(k, (score.get(k) || 0) + (10 - Math.min(i, 9))); });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

/**
 * Cards, one per programme (a maker's folder) or lone routine. `by`: show who shares it.
 * `mine`: they are the viewer's own, so no Add, and each routine opens itself to change.
 */
export function programmeList(progs, { by = true, mine = false } = {}) {
  if (!progs?.length) return '';
  const noSets = restPrefs().detail === 'exercises';
  return html`<div class="prg-list">${progs.map((p, i) => {
    const many = p.routines.length > 1 || !!p.folder;
    const title = p.folder || p.routines[0].title;
    const total = p.routines.reduce((t, r) => t + (r.estimateMin || 0), 0);
    const muscles = musclesOf(p.routines);
    const sub = [many ? f.plural(p.routines.length, 'routine') : f.plural(p.routines[0].exercises, 'exercise'), total ? `about ${f.dur(total)}` : ''].filter(Boolean).join(' · ');
    const action = mine
      ? html`<span class="prg__tag">${ic('check', { size: 's' })}Shared</span>`
      : hasProfile() ? html`<button type="button" class="btn btn--s" data-prg-add="${i}">${ic('plus', { size: 's' })}${many && p.routines.length > 1 ? `Add all ${p.routines.length}` : 'Add'}</button>` : '';
    const row = (r) => {
      const meta = [many ? f.plural(r.exercises, 'exercise') : '', noSets ? '' : f.plural(r.sets, 'set'), many && r.estimateMin ? `about ${f.dur(r.estimateMin)}` : ''].filter(Boolean).join(' · ');
      const inner = html`<span class="prg__rtb"><span class="prg__rtt">${many ? r.title : 'Exercises'}${meta ? html`<span class="prg__rtm n">${meta}</span>` : ''}</span><span class="prg__rtd">${r.names.join(', ')}</span></span>${ic('right', { size: 's' })}`;
      return mine
        ? html`<a class="prg__rt press" href="/workouts/routines/${encodeURIComponent(r.id)}" aria-label="${r.title}, change it">${inner}</a>`
        : html`<button type="button" class="prg__rt press" data-prg-look="${r.id}" aria-label="${r.title}, see it set by set">${inner}</button>`;
    };
    return html`<article class="prg fam fam-workouts">
      <div class="prg__h">
        <span class="prg__ic">${ic(many ? 'playlist' : 'dumbbell')}</span>
        <div class="prg__t"><h3>${title}</h3><p class="prg__s n">${sub}</p></div>
        ${action}
      </div>
      ${muscles.length ? html`<div class="prg__mus">${muscles.map((m) => html`<span class="prg__chip">${m}</span>`)}</div>` : ''}
      ${by && p.by ? html`<a class="prg__by" href="/u/${encodeURIComponent(p.by.username)}">${avatar(p.by)}<span>${p.by.displayName || p.by.username}</span></a>` : ''}
      <div class="prg__rts">${p.routines.map(row)}</div>
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
  // Sets and reps turned off (Train, how much to log): the exercises only.
  const noSets = restPrefs().detail === 'exercises';
  const s = sheet({
    title: d.title,
    body: html`<div class="prg-look">
      ${d.by ? html`<a class="prg__by" href="/u/${encodeURIComponent(d.by.username)}">${avatar(d.by)}<span>${d.folder ? `${d.folder}, by ` : 'By '}${d.by.displayName || d.by.username}</span></a>` : ''}
      <p class="muted small">${[f.plural(d.exercises, 'exercise'), noSets ? '' : f.plural(d.sets, 'set'), `about ${f.dur(d.estimateMin)}`].filter(Boolean).join(' · ')}</p>
      ${r.notes ? html`<p class="small">${r.notes}</p>` : ''}
      <ol class="prg-ex">${r.exercises.map((x) => html`<li>
        <span class="prg-ex__n">${x.name}</span>
        ${noSets ? '' : html`<span class="prg-ex__s">${x.sets.map((st) => setText(x, st)).filter(Boolean).join(', ') || f.plural(x.sets.length, 'set')}</span>`}
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
