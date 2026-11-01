/* A workout logged set by set, the way Hevy does it: the routine's
   exercises with each set filled in, last time's set beside it, a tick
   to mark it done (which starts the rest timer), sets and exercises
   added or taken away as the session goes, and a finish that keeps what
   was ticked. Everything is saved as it changes (PUT …/draft, and a copy
   in this browser), so a closed tab or a dead phone loses nothing. */

import { api } from '../api.js';
import { go, refreshMe } from '../app.js';
import { html, mount, ic, on, toast, toastError, busy, confirm, sheet, errText } from '../ui.js';
import * as f from '../format.js';
import { pickExercises, exerciseInfo, clockS } from '../exlib.js';
import { exerciseCard, readInput, nextSet, cycleKind } from '../setsui.js';
import { exerciseMenu } from './routines.js';
import { runTimers } from './shared.js';
import * as live from '../live.js';
import { restPrefs, restSheet } from '../restui.js';

const store = (id) => `health-draft-${id}`;
const safe = (fn) => { try { return fn(); } catch { return null; } };

/**
 * Mount the logger for a workout with a draft. `reload()` reads the
 * workout again (after finishing or discarding).
 */
export function mountLogger(root, w, { onLeave, reload }) {
  const base = `/api/workouts/${encodeURIComponent(w.id)}`;
  const ex = structuredClone(w.draft.exercises || []);
  // A copy in this browser newer than the server's (saved while offline) wins.
  const local = safe(() => JSON.parse(localStorage.getItem(store(w.id)) || 'null'));
  if (local && local.at > (w.updatedAt || 0) && Array.isArray(local.exercises)) {
    ex.splice(0, ex.length, ...local.exercises.map((x, i) => ({ ...x, image: ex[i]?.image ?? x.image, previous: ex[i]?.previous ?? x.previous })));
  }
  for (const x of ex) x.sets.forEach((s, j) => { s._prev = x.previous?.[j] || null; });
  const open = new Set(ex.map((_, i) => i));
  let restUntil = w.draft.restUntil && w.draft.restUntil > Date.now() ? w.draft.restUntil : null;
  let restFor = 0;
  let restEx = null;   // the exercise the timer is running for
  let saveTimer = null; let saving = Promise.resolve(); let lastSaved = Date.now();

  const body = () => ({ exercises: ex.map(({ image: _i, previous: _p, ...x }) => ({ ...x, sets: x.sets.map(({ _prev: _q, ...s }) => s) })), restUntil });
  const save = ({ now = false } = {}) => {
    safe(() => localStorage.setItem(store(w.id), JSON.stringify({ at: Date.now(), exercises: body().exercises })));
    clearTimeout(saveTimer);
    const go1 = () => { saving = saving.then(() => api.put(`${base}/draft`, body())).then(() => { lastSaved = Date.now(); paintSaved(); }).catch(() => paintSaved(true)); return saving; };
    if (now) return go1();
    saveTimer = setTimeout(go1, 700);
    return null;
  };

  const totals = () => {
    let sets = 0; let vol = 0; let all = 0;
    for (const x of ex) for (const s of x.sets) { all += 1; if (s.done) { sets += 1; if (f.isNum(s.kg) && f.isNum(s.reps)) vol += s.kg * s.reps; } }
    return { sets, vol, all };
  };

  let hrPaint = () => {};
  function paint() {
    const t = totals();
    mount(root, html`<div class="lg">
      <header class="lg__top">
        <div class="lg__now">
          <p class="lg__k">${w.routine?.title || w.draft.routineTitle ? `${w.routine?.title || w.draft.routineTitle}` : 'Workout'}</p>
          <p class="lg__clock"><span data-timer="${w.start}" role="timer" aria-live="off">${f.stopwatch(Date.now() - w.start)}</span></p>
        </div>
        <span data-lg-hr></span>
        <button type="button" class="btn lg__finish" data-lg="finish">${ic('check', { size: 's' })}Finish</button>
      </header>
      <div class="lg__stats" data-stats>${statsHtml(t)}</div>
      <div class="lg__rest" data-rest hidden></div>
      <div class="sxl" data-list>${ex.map((x, i) => exerciseCard(x, i, { log: true, open: open.has(i) }))}</div>
      ${!ex.length ? html`<div class="empty empty--inline"><p class="empty__t">An empty workout</p><p class="empty__d">Add the exercises you do as you go. Each one opens with last time's sets.</p></div>` : ''}
      <div class="lg__end">
        <button type="button" class="btn btn--tonal" data-lg="add">${ic('plus', { size: 's' })}Add exercise</button>
        <button type="button" class="btn btn--ghost" data-lg="discard">${ic('trash', { size: 's' })}Discard workout</button>
      </div>
      <p class="muted small lg__saved" data-saved aria-live="polite"></p>
    </div>`);
    paintRest();
    paintSaved();
    hrPaint(live.get());
  }
  /** One exercise's card drawn again in place, its photo kept as it is (no reload, no flash). */
  function repaintCard(i) {
    const old = root.querySelector(`.sx[data-x="${i}"]`);
    if (!old) { paint(); return; }
    const tmp = document.createElement('div');
    mount(tmp, exerciseCard(ex[i], i, { log: true, open: open.has(i) }));
    const nu = tmp.firstElementChild;
    if (!nu) return;
    const op = old.querySelector('.sx__pic'); const np = nu.querySelector('.sx__pic');
    if (op && np) np.replaceWith(op);
    old.replaceWith(nu);
  }
  const statsHtml = (t) => html`<span><b>${f.int(t.sets)}</b> of ${f.int(t.all)} sets</span><span><b>${f.volume(t.vol, { unit: false })}</b> ${f.volumeUnit() === 't' ? 'tonnes' : f.volumeUnit()} lifted</span><span><b>${ex.length}</b> ${ex.length === 1 ? 'exercise' : 'exercises'}</span>`;
  const paintStats = () => { const el = root.querySelector('[data-stats]'); if (el) mount(el, statsHtml(totals())); };
  function paintSaved(failed = false) {
    const el = root.querySelector('[data-saved]');
    if (el) el.textContent = failed ? 'Not saved to the server yet (offline?). Kept on this device; it is sent when you are back.' : `Saved ${f.clock(lastSaved)}`;
  }

  /* ── the rest timer ── */
  let restTick = null;
  function paintRest() {
    const el = root.querySelector('[data-rest]');
    if (!el) return;
    const left = restUntil ? Math.ceil((restUntil - Date.now()) / 1000) : 0;
    if (left <= 0) {
      el.hidden = true;
      if (restUntil) {
        restUntil = null;
        safe(() => navigator.vibrate?.([200, 100, 200]));
        toast('Rest over: next set');
        save();
      }
      return;
    }
    el.hidden = false;
    const pct = restFor ? Math.max(0, Math.min(100, (left / restFor) * 100)) : 0;
    // Built once; after that only the time and the bar change, so a tap on a button is
    // never lost to the button being drawn again under the finger.
    if (!el.querySelector('.lg__restt')) {
      // Tapping the time opens the timer's settings (off everywhere, lengths).
      mount(el, html`<div class="lg__restbar"></div>
        <button type="button" class="lg__restopen" data-lg="rest-opts"><span class="lg__restk">Rest</span><span class="lg__restt" role="timer"></span>${ic('settings', { size: 's' })}</button>
        <button type="button" class="btn btn--ghost btn--s" data-lg="rest-15">-15 s</button>
        <button type="button" class="btn btn--ghost btn--s" data-lg="rest+15">+15 s</button>
        <button type="button" class="btn btn--tonal btn--s" data-lg="rest-skip">Skip</button>`);
    }
    el.querySelector('.lg__restbar').style.setProperty('--p', `${pct}%`);
    el.querySelector('.lg__restt').textContent = clockS(left);
    el.querySelector('.lg__restopen').setAttribute('aria-label', `Rest timer settings, ${clockS(left)} left`);
  }
  restTick = setInterval(paintRest, 500);

  const startRest = (s, i) => { if (!s || !restPrefs().on) return; restEx = i; restFor = s; restUntil = Date.now() + s * 1000; paintRest(); };

  /* ── typing, ticking, adding ── */
  on(root, 'input', '.sx [data-k]', (e, input) => {
    const x = ex[Number(input.closest('[data-x]').dataset.x)];
    if (!x) return;
    readInput(x, input);
    paintStats();
    save();
  });
  on(root, 'click', '.sx [data-xa]', async (e, b) => {
    const i = Number(b.closest('[data-x]').dataset.x);
    const x = ex[i];
    const j = Number(b.closest('[data-s]')?.dataset.s);
    const s = x.sets[j];
    const act = b.dataset.xa;
    if (act === 'info') { if (x.libId) exerciseInfo(x.libId); return; }
    if (act === 'tick') {
      // An empty set ticked takes last time's numbers (or the planned ones).
      const empty = ![s.kg, s.reps, s.durationS, s.distanceM].some((v) => f.isNum(v) && v > 0);
      if (!s.done && empty && s._prev) Object.assign(s, { kg: s._prev.kg ?? null, reps: s._prev.reps ?? null, durationS: s._prev.durationS ?? null, distanceM: s._prev.distanceM ?? null });
      if (!s.done && ![s.kg, s.reps, s.durationS, s.distanceM].some((v) => f.isNum(v) && v > 0)) { toast('Fill the set in first.'); b.closest('[data-s]').querySelector('.sx__in')?.focus(); return; }
      s.done = !s.done;
      if (s.done) {
        safe(() => navigator.vibrate?.(30));
        // The weight carries on to the sets after it that have none yet.
        if (f.isNum(s.kg) && s.type !== 'warmup') for (const t of x.sets.slice(j + 1)) if (!t.done && !f.isNum(t.kg) && t.type !== 'warmup') t.kg = s.kg;
        // The rest after a set, unless it was the exercise's last.
        if (x.sets.slice(j + 1).some((t) => !t.done) || ex.slice(i + 1).length) startRest(x.restS ?? restPrefs().s, i);
      }
    } else if (act === 'prev') { if (s._prev) Object.assign(s, { kg: s._prev.kg ?? null, reps: s._prev.reps ?? null, durationS: s._prev.durationS ?? null, distanceM: s._prev.distanceM ?? null }); }
    else if (act === 'kind') cycleKind(s);
    else if (act === 'add-set') x.sets.push(nextSet(x, { log: true }));
    else if (act === 'del-last') { const last = x.sets[x.sets.length - 1]; if (last?.done && !(await confirm({ title: 'Remove the last set?', text: 'It is ticked as done.', yes: 'Remove', danger: true }))) return; x.sets.pop(); }
    else if (act === 'menu') {
      // The menu can move, remove or replace exercises: the whole list is drawn again.
      await exerciseMenu(ex, i, open, { log: true });
      const y = window.scrollY;
      paint();
      window.scrollTo(0, y);
      save();
      return;
    }
    // Only this exercise's card is drawn again: nothing else on the screen moves or flashes.
    repaintCard(i);
    paintStats();
    save();
  });
  on(root, 'click', '[data-lg]', async (e, b) => {
    const act = b.dataset.lg;
    if (act === 'rest-15') { restUntil = Math.max(Date.now() + 1000, (restUntil || Date.now()) - 15_000); paintRest(); }
    else if (act === 'rest+15') { restUntil = (restUntil || Date.now()) + 15_000; restFor += 15; paintRest(); }
    else if (act === 'rest-skip') { restUntil = null; paintRest(); }
    else if (act === 'rest-opts') {
      const x = ex[restEx];
      await restSheet({
        exercise: x ? { name: x.name, restS: x.restS ?? restPrefs().s } : null,
        onExercise: (v) => { if (x) { x.restS = v; save(); } },
      });
      // Turned off: the running timer goes too.
      if (!restPrefs().on && restUntil) { restUntil = null; save(); }
      paintRest();
    }
    else if (act === 'add') {
      const got = await pickExercises({ title: 'Add exercises' });
      for (const g of got) {
        let last = [];
        try { last = (await api.get(`/api/exercises/last?name=${encodeURIComponent(g.name)}`)).sets || []; } catch { /* none */ }
        const x = { name: g.name, libId: g.libId, templateId: g.templateId, muscle: g.muscle || 'other', type: g.type || 'weight_reps', image: g.image, restS: restPrefs().s, notes: null, previous: last, sets: [] };
        const n = Math.max(1, Math.min(last.length || 3, 6));
        for (let k = 0; k < n; k += 1) x.sets.push({ type: last[k]?.type || 'normal', kg: last[k]?.kg ?? null, reps: last[k]?.reps ?? null, durationS: last[k]?.durationS ?? null, distanceM: last[k]?.distanceM ?? null, done: false, _prev: last[k] || null });
        ex.push(x);
        open.add(ex.length - 1);
      }
      if (got.length) { paint(); save(); const card = root.querySelector(`[data-x="${ex.length - got.length}"]`); card?.scrollIntoView({ behavior: 'smooth', block: 'start' }); card?.querySelector('.sx__name')?.focus({ preventScroll: true }); }
    } else if (act === 'discard') {
      if (!(await confirm({ title: 'Discard this workout?', text: 'Nothing of it is kept: not the time, not the sets.', yes: 'Discard', danger: true }))) return;
      try { await api.post(`${base}/dismiss`); safe(() => localStorage.removeItem(store(w.id))); toast('Workout discarded'); refreshMe().catch(() => {}); go('/workouts', { replace: true }); } catch (err) { toastError(err); }
    } else if (act === 'finish') finish(b);
  });

  async function finish(btn) {
    await save({ now: true });
    const t = totals();
    const filled = ex.reduce((a, x) => a + x.sets.filter((s) => !s.done && [s.kg, s.reps, s.durationS, s.distanceM].some((v) => f.isNum(v) && v > 0)).length, 0);
    let keep = 'done';
    if (!t.sets && !filled) {
      if (!(await confirm({ title: 'Finish with no sets?', text: 'Nothing is ticked. The workout is kept with its time and heart rate, and no sets.', yes: 'Finish' }))) return;
    } else if (filled) {
      const s = sheet({
        title: 'Finish workout?',
        body: html`<p class="prose">${t.sets ? html`${f.plural(t.sets, 'set')} ticked as done. ${f.plural(filled, 'more set')} ${filled === 1 ? 'is' : 'are'} filled in but not ticked.` : html`None of the ${f.plural(filled, 'set')} filled in ${filled === 1 ? 'is' : 'are'} ticked as done. Keep ${filled === 1 ? 'it' : 'them all'}?`}</p>`,
        // Nothing ticked: keeping "the ticked ones" would keep nothing, so keeping them all is the one way on.
        foot: t.sets ? html`<button type="button" class="btn btn--tonal" data-close>Keep going</button>
          <button type="button" class="btn btn--tonal" data-k="all">Keep all ${t.sets + filled}</button>
          <button type="button" class="btn" data-k="done">Keep the ${t.sets} ticked</button>`
          : html`<button type="button" class="btn btn--tonal" data-close>Keep going</button>
          <button type="button" class="btn" data-k="all">Keep ${filled === 1 ? 'it' : `all ${filled}`}</button>`,
      });
      on(s.el, 'click', '[data-k]', (e, b) => s.close(b.dataset.k));
      keep = await s.closed;
      if (!keep) return;
    }
    try {
      const r = await busy(btn, () => api.post(`${base}/end`, { keep }));
      if (r === undefined) return;
      safe(() => localStorage.removeItem(store(w.id)));
      toast('Workout saved');
      refreshMe().catch(() => {});
      reload({ finished: true });
    } catch (err) {
      if (/at least 5 minutes/.test(err.message || '')) {
        const left = Math.max(1, Math.ceil((w.start + 5 * 60_000 - Date.now()) / 60_000));
        const y = await confirm({ title: 'Under 5 minutes', text: `A workout is kept from 5 minutes on: ${f.plural(left, 'minute')} to go. Keep going, or throw this one away?`, yes: 'Throw it away', no: 'Keep going', danger: true });
        if (y) { try { await api.post(`${base}/dismiss`); safe(() => localStorage.removeItem(store(w.id))); toast('Workout discarded'); go('/workouts', { replace: true }); } catch (e2) { toastError(e2); } }
        return;
      }
      toast(errText(err), { tone: 'bad' });
    }
  }

  paint();
  // Heart rate during the session: a one-tap Connect while no sensor is in use (the pill shows the rest).
  hrPaint = (st) => {
    const el = root.querySelector('[data-lg-hr]');
    if (!el) return;
    const b = st.ble;
    const html1 = st.bpm > 0 || (b.supported && b.status !== 'off') ? ''
      : b.supported ? `<button type="button" class="btn btn--tonal btn--s" data-lg-hrc>${b.remembered ? `Connect ${(b.name || 'heart rate').replace(/[<>&"]/g, '')}` : 'Connect heart rate'}</button>`
        : '<button type="button" class="btn btn--ghost btn--s" data-lg-hrinfo>Heart rate</button>';
    if (el.innerHTML !== html1) el.innerHTML = html1;
  };
  // While a sensor is in use during the session, the screen stays on: a phone
  // pauses Bluetooth for a web page once its screen is off.
  let lock = null;
  const wantLock = () => live.get().ble.status !== 'off' && document.visibilityState === 'visible';
  const keepAwake = async () => {
    if (wantLock() && !lock && navigator.wakeLock) { try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch { lock = null; } }
    else if (!wantLock() && lock) { lock.release().catch(() => {}); lock = null; }
  };
  document.addEventListener('visibilitychange', keepAwake);
  const unHr = live.subscribe((st) => { hrPaint(st); keepAwake(); });
  keepAwake();
  hrPaint(live.get());
  on(root, 'click', '[data-lg-hrinfo]', async () => {
    // A browser without Bluetooth (Safari on iPhone): the ways that do work here.
    const m = await import('./liveui.js');
    const sh = sheet({ title: 'Live heart rate', body: html`${m.liveControl()}` });
    const stopIt = m.bindLive(sh.el);
    sh.closed.then(stopIt);
  });
  on(root, 'click', '[data-lg-hrc]', async (e, b) => {
    b.classList.add('is-busy');
    try { await live.connect({ choose: !live.get().ble.remembered }); } catch { toast('Could not reach the sensor. Check Bluetooth is on and Share heart rate is on in the Google Health app.', { tone: 'bad', ms: 7000 }); } finally { b.classList.remove('is-busy'); }
  });
  // A task with its own controls (Finish at the top, the rest timer at the foot): on a phone
  // no tab bar either, as when recording a route (shell.css, app--task).
  const fab = document.getElementById('fabwrap');
  if (fab) fab.hidden = true;
  const shell = document.querySelector('.app');
  const wasTask = shell?.classList.contains('app--task');
  shell?.classList.add('app--task', 'app--logging');
  const stopTimers = runTimers(root);
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; unHr(); document.removeEventListener('visibilitychange', keepAwake); lock?.release().catch(() => {}); if (fab) fab.hidden = false; if (!wasTask) shell?.classList.remove('app--task'); shell?.classList.remove('app--logging'); clearInterval(restTick); stopTimers(); if (saveTimer) { clearTimeout(saveTimer); api.put(`${base}/draft`, body()).catch(() => {}); } };
  onLeave(stop);
  // A save left in this browser from offline goes up now.
  if (local && local.at > (w.updatedAt || 0)) save();
  return stop;
}
