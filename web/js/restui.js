/* The rest timer's settings: on or off in every workout, how long it is for
   an exercise added new, and (opened from a running timer) how long it is for
   that exercise. Kept with the account (PATCH /api/settings `training`), so
   every device does the same. Opened by tapping the timer in a workout, and
   from Settings. */

import { api } from './api.js';
import { app, refreshMe } from './app.js';
import { html, sheet, toggle, toastError } from './ui.js';
import { clockS } from './exlib.js';
import { RESTS } from './setsui.js';

/** { on, s, detail }: is the timer on, the length for an exercise added new, and how precise (sets, or exercises only). */
export function restPrefs() {
  const t = app.me?.training || {};
  return { on: t.restOn !== false, s: Number.isFinite(t.restS) && t.restS > 0 ? t.restS : 90, detail: t.detail === 'exercises' ? 'exercises' : 'sets' };
}

const opts = (cur, { none = false } = {}) => RESTS.filter((v) => none || v > 0)
  .map((v) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${v ? clockS(v) : 'No rest timer'}</option>`);

/**
 * The sheet. `exercise`: { name, restS } of the exercise the timer is running for, and
 * `onExercise(s)` to change its rest; without them only the account-wide settings show.
 * Resolves when it closes.
 */
export function restSheet({ exercise = null, onExercise = null } = {}) {
  const p = restPrefs();
  const s = sheet({
    title: 'Rest timer',
    body: html`<div class="st-sheet rest-sheet">
      <label class="me-srow rest-sheet__row">
        <span class="me-srow__b"><span class="me-srow__t">Rest timer</span><span class="me-srow__d">Counts down after each set you tick, in every workout. Off: no timer at all.</span></span>
        ${toggle('rest-on', p.on, { label: 'Rest timer' })}
      </label>
      <div class="rest-sheet__more" data-more ${p.on ? '' : 'hidden'}>
        ${exercise ? html`<div class="field"><label class="field__label" for="rest-ex">${exercise.name}</label>
          <select class="select" id="rest-ex" data-ex>${opts(exercise.restS ?? p.s, { none: true })}</select>
          <p class="field__hint">This exercise, for the rest of this workout.</p></div>` : ''}
        <div class="field"><label class="field__label" for="rest-def">For exercises you add</label>
          <select class="select" id="rest-def" data-def>${opts(p.s)}</select>
          <p class="field__hint">An exercise in a routine keeps its own rest; change it in the exercise's menu.</p></div>
      </div>
    </div>`,
  });
  const save = async (patch) => {
    try { await api.patch('/api/settings', { training: patch }); await refreshMe(); } catch (err) { toastError(err); }
  };
  s.el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'rest-on') { s.el.querySelector('[data-more]').hidden = !t.checked; save({ restOn: t.checked }); }
    else if (t.matches('[data-def]')) save({ restS: Number(t.value) });
    else if (t.matches('[data-ex]')) onExercise?.(Number(t.value));
  });
  return s.closed;
}
