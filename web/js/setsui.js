/* An exercise and its sets, the same in the routine editor (a plan) and
   the workout logger (what was done): the number of a set is a button
   that cycles its kind (warm-up W, normal, drop set D, to failure F), the
   columns follow the exercise's kind (weight and reps, reps, time,
   distance and time), and the logger adds last time's set beside each
   one and a tick to mark it done. The state is plain objects; inputs
   write into it as they are typed, and only adding or removing things
   draws again, so focus never jumps. */

import { html, ic } from './ui.js';
import * as f from './format.js';
import { thumb, MUSCLE, clockS } from './exlib.js';

export const KINDS = ['normal', 'warmup', 'dropset', 'failure'];
const KIND_MARK = { warmup: 'W', dropset: 'D', failure: 'F' };
const KIND_TEXT = { normal: 'Normal set', warmup: 'Warm-up', dropset: 'Drop set', failure: 'To failure' };
export const RESTS = [0, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300];

const w2 = (kg) => (f.isNum(kg) ? String(Math.round(f.weightVal(kg) * 100) / 100) : '');
const km = (m) => (f.isNum(m) ? String(Math.round((f.distVal(m) || 0) * 100) / 100) : '');

/** "1:30", "90", "1m30" -> seconds; '' -> null. */
export function parseTime(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  const m = /^(\d{1,3})[:m.](\d{1,2})s?$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(t.replace(/s$/, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** The column headings for an exercise's kind. */
function cols(type, { log }) {
  const u = f.weightUnit(); const d = f.distUnit();
  const c = type === 'bodyweight_reps' ? ['+' + u, 'Reps'] : type === 'duration' ? ['Time'] : type === 'distance_duration' ? [d, 'Time'] : [u, 'Reps'];
  return ['Set', ...(log ? ['Previous'] : []), ...c, ...(log ? [''] : [''])];
}

/** Last time's set, as a short string ("70 × 8", "1:00"). */
export function prevText(p, type) {
  if (!p) return '';
  if (type === 'duration') return f.isNum(p.durationS) ? clockS(p.durationS) : '';
  if (type === 'distance_duration') return [f.isNum(p.distanceM) && p.distanceM > 0 ? `${km(p.distanceM)} ${f.distUnit()}` : '', f.isNum(p.durationS) ? clockS(p.durationS) : ''].filter(Boolean).join(' · ');
  const wt = f.isNum(p.kg) && p.kg > 0 ? w2(p.kg) : '';
  return wt && f.isNum(p.reps) ? `${wt} × ${p.reps}` : f.isNum(p.reps) ? `${p.reps} reps` : wt;
}

/** The inputs of one set, by the exercise's kind. */
function inputs(x, s, j) {
  const num = (k, v, { mode = 'decimal', label, ph = '', step = 'any' } = {}) => html`<input class="input sx__in" type="text" inputmode="${mode}" data-k="${k}" value="${v}" placeholder="${ph}" aria-label="${label}, set ${j + 1}" autocomplete="off" ${step === 'any' ? '' : ''}>`;
  const reps = () => html`<span class="sx__reps">${num('reps', f.isNum(s.reps) ? s.reps : '', { mode: 'numeric', label: 'Reps', ph: '–' })}${'repsMax' in s && !s._log ? html`<span class="sx__to">to</span>${num('repsMax', f.isNum(s.repsMax) ? s.repsMax : '', { mode: 'numeric', label: 'Top of the rep range', ph: '' })}` : ''}</span>`;
  if (x.type === 'duration') return html`${num('durationS', f.isNum(s.durationS) ? clockS(s.durationS) : '', { mode: 'text', label: 'Time', ph: '0:30' })}`;
  if (x.type === 'distance_duration') return html`${num('distanceM', km(s.distanceM), { label: `Distance in ${f.distUnit()}`, ph: '–' })}${num('durationS', f.isNum(s.durationS) ? clockS(s.durationS) : '', { mode: 'text', label: 'Time', ph: '0:00' })}`;
  return html`${num('kg', w2(s.kg), { label: x.type === 'bodyweight_reps' ? `Added weight in ${f.weightUnit()}` : `Weight in ${f.weightUnit()}`, ph: x.type === 'bodyweight_reps' ? '+0' : '–' })}${reps()}`;
}

/**
 * One exercise as a card. `log` turns on the previous column and the
 * done ticks. `i` is its place in the list.
 */
export function exerciseCard(x, i, { log = false, count = 1, open = true } = {}) {
  const done = x.sets.filter((s) => s.done).length;
  return html`<section class="sx ${log && done && done === x.sets.length ? 'is-done' : ''}" data-x="${i}" aria-label="${x.name}">
    <header class="sx__head">
      <button type="button" class="sx__pic" data-xa="info" aria-label="About ${x.name}">${thumb(x.image)}</button>
      <div class="sx__title">
        <button type="button" class="sx__name" data-xa="info">${x.name}</button>
        <span class="sx__sub">${[MUSCLE[x.muscle] || '', log ? `${done} of ${x.sets.length} done` : f.plural(x.sets.length, 'set'), x.restS ? `rest ${clockS(x.restS)}` : 'no rest timer'].filter(Boolean).join(' · ')}</span>
      </div>
      <button type="button" class="iconbtn" data-xa="menu" aria-label="More for ${x.name}">${ic('more')}</button>
    </header>
    ${open ? html`
    <input class="input sx__note" type="text" data-k="notes" value="${x.notes || ''}" maxlength="500" placeholder="Notes for this exercise" aria-label="Notes for ${x.name}">
    <div class="sx__grid ${log ? 'sx__grid--log' : ''} sx__grid--${x.type}" role="table" aria-label="Sets of ${x.name}">
      <div class="sx__row sx__row--h" role="row">${cols(x.type, { log }).map((c) => html`<span role="columnheader">${c}</span>`)}</div>
      ${x.sets.map((s, j) => {
        const n = x.sets.slice(0, j + 1).filter((t) => t.type !== 'warmup').length;
        return html`<div class="sx__row ${s.done ? 'is-done' : ''} sx__row--${s.type}" role="row" data-s="${j}">
          <button type="button" class="sx__n" data-xa="kind" aria-label="Set ${j + 1}: ${KIND_TEXT[s.type]}. Change its kind">${KIND_MARK[s.type] || n}</button>
          ${log ? html`<button type="button" class="sx__prev" data-xa="prev" ${s._prev ? '' : 'disabled'} aria-label="${s._prev ? `Last time: ${prevText(s._prev, x.type)}. Use it` : 'Nothing last time'}">${prevText(s._prev, x.type) || '–'}</button>` : ''}
          ${inputs(x, { ...s, _log: log }, j)}
          ${log ? html`<button type="button" class="sx__tick" data-xa="tick" aria-pressed="${String(!!s.done)}" aria-label="Set ${j + 1} done">${ic('check')}</button>`
            : html`<button type="button" class="iconbtn sx__del" data-xa="del-set" aria-label="Remove set ${j + 1}">${ic('x', { size: 's' })}</button>`}
        </div>`;
      })}
    </div>
    <div class="sx__foot">
      <button type="button" class="btn btn--tonal btn--s" data-xa="add-set">${ic('plus', { size: 's' })}Add set</button>
      ${log && x.sets.length > 1 ? html`<button type="button" class="btn btn--ghost btn--s" data-xa="del-last">Remove last set</button>` : ''}
    </div>` : ''}
    ${count > 1 && !open ? '' : ''}
  </section>`;
}

/** Read what was typed in one input into the state. */
export function readInput(x, input) {
  const k = input.dataset.k;
  if (k === 'notes') { x.notes = input.value.trim() || null; return; }
  const row = input.closest('[data-s]');
  const s = x.sets[Number(row?.dataset.s)];
  if (!s) return;
  const v = input.value.trim().replace(',', '.');
  if (k === 'kg') { const n = Number(v); s.kg = v === '' || !Number.isFinite(n) ? null : Math.round(f.toKg(n) * 1000) / 1000; }
  else if (k === 'reps' || k === 'repsMax') { const n = Number(v); s[k] = v === '' || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)); }
  else if (k === 'durationS') s.durationS = parseTime(v);
  else if (k === 'distanceM') { const n = Number(v); s.distanceM = v === '' || !Number.isFinite(n) ? null : Math.round(n * (f.distUnit() === 'mi' ? 1609.344 : 1000)); }
}

/** A new set after the last: the same numbers, a normal one. */
export function nextSet(x, { log = false } = {}) {
  const last = x.sets[x.sets.length - 1];
  const s = last ? { type: last.type === 'warmup' ? 'normal' : last.type, kg: last.kg ?? null, reps: last.reps ?? null, repsMax: last.repsMax ?? null, durationS: last.durationS ?? null, distanceM: last.distanceM ?? null }
    : { type: 'normal', kg: null, reps: null, repsMax: null, durationS: null, distanceM: null };
  if (log) { s.done = false; s._prev = x.previous?.[x.sets.length] || null; }
  return s;
}

export const cycleKind = (s) => { s.type = KINDS[(KINDS.indexOf(s.type) + 1) % KINDS.length]; };
