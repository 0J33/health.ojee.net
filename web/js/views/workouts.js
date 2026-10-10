/* Workouts: the list (running timer, questions, history by week), one
   workout in detail, Hevy import, and detection settings. */

import { api } from '../api.js';
import { app, listen, go, refreshMe } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, empty, banner, chart, on, sheet, confirm, field, formValues, fieldError, busy, toast, toastError, toggle, row, errText } from '../ui.js';
import { hrTrace, tableAlt } from '../charts.js';
import * as f from '../format.js';
import { connectionBanner, runningCard, askCard, runTimers, bindWorkoutActions, startWorkout, timesSheet, workoutTitle, typeLabel, sourceLabel, googleStateText, chartbox } from './shared.js';

const MAX_CSV = 5 * 1024 * 1024;

/* ── list ───────────────────────────────────────────────────── */

function historyRow(w, types) {
  const day = f.instDay(w.start);
  const bits = [f.clock(w.start), sourceLabel(w)];
  if (w.sets?.sets) bits.push(f.plural(w.sets.sets, 'set'));
  return html`<a class="wk" href="/workouts/${encodeURIComponent(w.id)}">
    <span class="wk__date" aria-hidden="true"><span class="wk__dow">${f.dow(day)}</span><br><span class="wk__day">${f.dom(day)}</span></span>
    <span class="wk__body">
      <span class="wk__t">${workoutTitle(w, types)}</span><br>
      <span class="wk__d"><span class="sr">${f.dayMed(day)}, </span>${bits.join(' · ')}</span>
    </span>
    <span class="wk__v">
      <span class="wk__dur">${f.dur(w.durationMin)}</span>
      ${f.isNum(w.avgHr) ? html`<br><span class="wk__d">${Math.round(w.avgHr)} bpm</span>` : ''}
    </span>
    <span class="row__chev">${ic('right', { size: 's' })}</span>
  </a>`;
}

function historyByWeek(list, types) {
  const groups = new Map();
  for (const w of list) {
    const wkStart = f.weekStart(f.instDay(w.start));
    if (!groups.has(wkStart)) groups.set(wkStart, []);
    groups.get(wkStart).push(w);
  }
  return [...groups.entries()].map(([wkStart, items]) => html`
    <div class="week-h"><h3 class="week-h__t">${f.weekLabel(wkStart)}</h3>
      <span class="week-h__s">${f.plural(items.length, 'workout')} · ${f.dur(items.reduce((a, w) => a + (w.durationMin || 0), 0))}</span></div>
    <div class="group">${items.map((w) => historyRow(w, types))}</div>`);
}

function strengthBlock(s) {
  const weeks = s?.weeks || [];
  const cur = weeks[weeks.length - 1];
  if (!weeks.some((w) => w.sets > 0)) return '';
  return html`<section class="sec">
    <div class="sec__head"><h2 class="h2">Strength</h2><span class="sec__note">From your logged sets</span></div>
    <dl class="group kv">
      <div><dt>Sets a week</dt><dd>${f.isNum(s.setsPerWeek) ? f.dec(s.setsPerWeek, 1) : f.DASH}</dd></div>
      <div><dt>Sets this week</dt><dd>${f.int(cur?.sets || 0)}</dd></div>
      <div><dt>Volume this week</dt><dd>${f.int(f.weightVal(cur?.volumeKg || 0))}<span class="unit">${f.weightUnit()}</span></dd></div>
    </dl>
  </section>`;
}

function logSheet(d, done) {
  const now = Date.now();
  const s = sheet({
    title: 'Log a past workout',
    body: html`<form class="form" id="log-form" novalidate>
      <div data-slot="error"></div>
      ${field({ label: 'Started', name: 'start', type: 'datetime-local', value: f.toLocalInput(now - 75 * 60000), attrs: 'required step="60"' })}
      ${field({ label: 'Ended', name: 'end', type: 'datetime-local', value: f.toLocalInput(now - 15 * 60000), attrs: 'required step="60"', hint: 'Between 5 minutes and 6 hours long, in the last 30 days.' })}
      ${field({ label: 'Name (optional)', name: 'title', attrs: 'maxlength="80" autocomplete="off" placeholder="Push day"' })}
      ${d.exerciseTypes?.length ? field({ label: 'Kind', name: 'type', value: d.exerciseType, options: d.exerciseTypes.map((t) => [t.id, t.label]) }) : ''}
      ${field({ label: 'Notes (optional)', name: 'notes', type: 'textarea', attrs: 'maxlength="2000" rows="3"' })}
      <p class="field__hint">${d.canWrite ? 'It is saved to Google Health as well.' : 'It is kept in this app only. Reconnect Google to allow saving workouts there too.'}</p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="log-form">Save workout</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    fieldError(form, 'start', ''); fieldError(form, 'end', '');
    const start = f.fromLocalInput(v.start); const end = f.fromLocalInput(v.end);
    if (!start) { fieldError(form, 'start', 'Enter when it started.'); return; }
    if (!end) { fieldError(form, 'end', 'Enter when it ended.'); return; }
    if (end <= start) { fieldError(form, 'end', 'The end has to be after the start.'); return; }
    if (end > Date.now() + 60000) { fieldError(form, 'end', 'The end cannot be in the future.'); return; }
    const mins = (end - start) / 60000;
    if (mins < 5 || mins > 360) { fieldError(form, 'end', 'A workout has to be between 5 minutes and 6 hours.'); return; }
    try {
      const payload = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/workouts/log', {
        start, end, ...(v.title?.trim() ? { title: v.title.trim() } : {}), ...(v.notes?.trim() ? { notes: v.notes.trim() } : {}), ...(v.type ? { type: v.type } : {}),
      }));
      if (payload === undefined) return;
      s.close();
      toast('Workout saved');
      done(payload);
    } catch (err) {
      mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err, 'Could not save the workout. Try again.') }));
    }
  });
}

async function list(ctx) {
  const { root } = ctx;
  document.title = 'Workouts · Health';
  let d = null; let history = []; let stopTimers = null;

  function paint() {
    const types = d.exerciseTypes;
    const det = d.detection || {};
    mount(root, html`
      ${head({ title: 'Workouts' })}
      <div class="stack">
        ${connectionBanner('/workouts')}
        ${d.needsReconnect ? banner({ tone: 'warn', iconName: 'key', title: 'Workouts are not reaching Google Health', text: `Reconnect to allow saving workouts.${d.unsaved ? ` ${f.plural(d.unsaved, 'workout')} ${d.unsaved === 1 ? 'is' : 'are'} waiting.` : ''}`, actions: html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="/workouts">Reconnect Google</button>` }) : ''}
        ${d.running ? runningCard(d.running) : ''}
        ${(d.pending || []).map((w) => askCard(w))}
        <div class="btnrow">
          ${!d.running ? html`<button type="button" class="btn" data-action="start">${ic('play', { size: 's' })}Start workout</button>` : ''}
          <button type="button" class="btn btn--tonal" data-action="log">${ic('plus', { size: 's' })}Log a past one</button>
        </div>
      </div>

      <section class="sec">
        <h2 class="sr">History</h2>
        ${history.length ? historyByWeek(history, types) : html`<div class="group">${empty({
          iconName: 'workouts', title: 'No workouts yet',
          text: 'Start one when you begin training, log one you already did, or bring your history in from Hevy. Workouts your watch records show up here by themselves.',
        })}</div>`}
        ${d.more ? html`<div class="btnrow" data-style="margin-top:12px;justify-content:center"><button type="button" class="btn btn--tonal btn--s" data-action="more">Show older workouts</button></div>` : ''}
      </section>

      ${strengthBlock(d.strength)}

      <section class="sec">
        <div class="sec__head"><h2 class="h2">More</h2></div>
        <div class="group">
          ${row({ href: '/workouts/import', iconName: 'upload', title: 'Import from Hevy', text: 'Bring in your exercises and sets from a Hevy export' })}
          ${row({ href: '/workouts/detection', iconName: 'wave', title: 'Detection', text: !det.available ? 'Not available on your device' : det.suppressedByLink ? 'Handled by the console module' : det.settings?.enabled ? 'On: asks when your heart rate looks like a workout' : 'Off', value: det.available && !det.suppressedByLink ? (det.settings?.enabled ? 'On' : 'Off') : '' })}
        </div>
      </section>`);
    stopTimers?.();
    stopTimers = d.running ? runTimers(root) : null;
  }

  const take = (payload) => { d = payload; history = payload.history || []; if (ctx.alive()) paint(); };

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, html`${head({ title: 'Workouts' })}${skeleton('list')}`);
    try { take(await api.get('/api/workouts?limit=40')); } catch (err) {
      if (ctx.alive() && !quiet) mount(root, html`${head({ title: 'Workouts' })}${errorState(err)}`);
    }
  }

  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="start"]', (e, btn) => startWorkout(btn, take));
  on(root, 'click', '[data-action="log"]', () => logSheet(d, (p) => { take(p); refreshMe().catch(() => {}); }));
  on(root, 'click', '[data-action="more"]', async (e, btn) => {
    const last = history[history.length - 1];
    if (!last) return;
    try {
      const p = await busy(btn, () => api.get(`/api/workouts?limit=40&before=${last.start}`));
      if (!p) return;
      const seen = new Set(history.map((w) => w.id));
      history = history.concat((p.history || []).filter((w) => !seen.has(w.id)));
      d = { ...d, more: p.more };
      paint();
    } catch (err) { toastError(err); }
  });
  bindWorkoutActions(root, {
    find: (id) => (d?.running?.id === id ? d.running : d?.pending?.find((w) => w.id === id)),
    done: take,
  });
  ctx.onLeave(listen('changed', (what) => { if (what.includes('workouts')) load({ quiet: true }); }));
  ctx.onLeave(() => stopTimers?.());
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}

/* ── detail ─────────────────────────────────────────────────── */

const SET_TYPE = { warmup: 'Warm-up', dropset: 'Drop set', failure: 'To failure' };

function setLine(s) {
  const parts = [];
  if (f.isNum(s.kg) && s.kg > 0) parts.push(`${f.dec(f.weightVal(s.kg), 1).replace(/\.0$/, '')} ${f.weightUnit()}`);
  if (f.isNum(s.reps)) parts.push(`${f.int(s.reps)} reps`);
  if (f.isNum(s.distanceM) && s.distanceM > 0) parts.push(f.dist(s.distanceM));
  if (f.isNum(s.durationS) && s.durationS > 0) parts.push(s.durationS >= 60 ? `${Math.floor(s.durationS / 60)} min ${s.durationS % 60 ? `${s.durationS % 60} s` : ''}`.trim() : `${s.durationS} s`);
  return parts.join(' × ') || f.DASH;
}

function editSheet(w, d, done) {
  const s = sheet({
    title: 'Name and notes',
    body: html`<form class="form" id="edit-form" novalidate>
      <div data-slot="error"></div>
      ${field({ label: 'Name', name: 'title', value: w.title || '', attrs: 'maxlength="80" autocomplete="off"' })}
      ${d?.exerciseTypes?.length ? field({ label: 'Kind', name: 'type', value: w.type, options: [...(d.exerciseTypes.some((t) => t.id === w.type) || !w.type ? [] : [[w.type, typeLabel(w.type)]]), ...d.exerciseTypes.map((t) => [t.id, t.label])] }) : ''}
      ${field({ label: 'Notes', name: 'notes', type: 'textarea', value: w.notes || '', attrs: 'maxlength="2000" rows="4"' })}
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="edit-form">Save</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.patch(`/api/workouts/${encodeURIComponent(w.id)}`, { title: v.title.trim() || null, notes: v.notes.trim() || null, ...(v.type ? { type: v.type } : {}) }));
      if (r === undefined) return;
      s.close(); toast('Saved'); done();
    } catch (err) {
      mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err) }));
    }
  });
}

async function detail(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  const base = `/api/workouts/${encodeURIComponent(id)}`;
  let w = null; let meta = null; let stopTimers = null;
  document.title = 'Workout · Health';

  function paint() {
    const types = meta?.exerciseTypes;
    const title = workoutTitle(w, types);
    document.title = `${title} · Health`;
    const day = f.instDay(w.start);
    const end = w.end ?? w.lastEnd;
    const live = w.status === 'running';
    const waiting = w.status === 'ongoing' || w.status === 'review';
    const stats = [
      ['Duration', live ? html`<span data-timer="${w.start}">${f.stopwatch(Date.now() - w.start)}</span>` : f.dur(w.durationMin ?? (end ? (end - w.start) / 60000 : null))],
      f.isNum(w.avgHr) ? ['Average heart rate', html`${Math.round(w.avgHr)}<span class="unit">bpm</span>`] : null,
      f.isNum(w.maxHr) ? ['Highest heart rate', html`${Math.round(w.maxHr)}<span class="unit">bpm</span>`] : null,
      f.isNum(w.kcal) ? ['Calories', html`${f.int(w.kcal)}<span class="unit">kcal</span>`] : null,
      f.isNum(w.steps) ? ['Steps', f.int(w.steps)] : null,
      f.isNum(w.activeMin) ? ['Active minutes', f.int(w.activeMin)] : null,
    ].filter(Boolean);
    const pts = (w.trace || []).map((p) => [p[0], p[1]]);
    const hasTrace = pts.filter((p) => f.isNum(p[1])).length > 1;
    const gText = googleStateText(w);
    const ex = w.exercises || [];

    mount(root, html`
      ${head({ title, back: '/workouts' })}
      <p class="muted" data-style="margin:-6px 0 16px 4px">${f.dayLong(day)} · ${f.clock(w.start)}${end ? ` to ${f.clock(end)}` : ''}</p>
      <div class="stack">
        ${live ? runningCard(w) : ''}
        ${waiting ? askCard(w) : ''}
        ${w.status === 'dismissed' ? banner({ title: 'This was marked as not a workout', text: 'It is kept out of your history and totals.' }) : ''}

        <dl class="group kv">${stats.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>

        <section class="panel">
          <div class="panel__head"><h2 class="h3">Heart rate</h2></div>
          ${hasTrace
            ? chartbox(chart((cw) => hrTrace({ w: cw, points: pts, start: w.start, end, avg: w.avgHr, label: `Heart rate from ${f.clock(pts[0][0])} to ${f.clock(pts[pts.length - 1][0])}${f.isNum(w.avgHr) ? `, average ${Math.round(w.avgHr)} bpm` : ''}${f.isNum(w.maxHr) ? `, highest ${Math.round(w.maxHr)} bpm` : ''}. The workout itself is shaded.` })), {
              hint: 'Touch the line to read a minute. The shaded part is the workout.',
              table: tableAlt(['Time', 'Heart rate (bpm)'], pts.filter((p) => f.isNum(p[1])).filter((_, i, a) => i % Math.max(1, Math.round(a.length / 30)) === 0).map((p) => [f.clock(p[0]), String(Math.round(p[1]))])),
            })
            : html`<p class="muted small">${w.traceReason || 'There is no minute-by-minute heart rate for this workout.'}</p>`}
        </section>

        ${ex.length ? html`<section>
          <div class="sec__head"><h2 class="h2">Exercises</h2>${w.sets ? html`<span class="sec__note">${f.plural(w.sets.sets, 'set')} · ${f.int(f.weightVal(w.sets.volumeKg))} ${f.weightUnit()}</span>` : ''}</div>
          <div class="group">${ex.map((x) => html`<div class="exercise">
            <h3 class="exercise__t">${x.name}</h3>
            ${x.notes ? html`<p class="exercise__n">${x.notes}</p>` : ''}
            <ol class="sets">${(x.sets || []).map((s, i) => html`<li class="sets__i">${i + 1}</li><li>${setLine(s)}${SET_TYPE[s.type] ? html` <span class="badge">${SET_TYPE[s.type]}</span>` : ''}</li><li class="sets__x">${f.isNum(s.rpe) ? `RPE ${s.rpe}` : ''}</li>`)}</ol>
          </div>`)}</div>
        </section>` : ''}

        ${w.notes ? html`<section class="panel"><h2 class="h3">Notes</h2><p class="prose sumtext" data-style="margin-top:6px">${w.notes}</p></section>` : ''}

        <section>
          <div class="sec__head"><h2 class="h2">About this workout</h2></div>
          <div class="group">
            ${row({ iconName: w.source === 'hevy' ? 'upload' : w.source === 'detected' ? 'wave' : w.source === 'google' ? 'watch' : 'edit', title: 'Where it came from', value: sourceLabel(w) })}
            ${row({ iconName: 'workouts', title: 'Kind', value: typeLabel(w.type, types) })}
            ${gText ? html`<div class="row row--top">
              <span class="row__ic">${ic(w.google.state === 'failed' || w.google.state === 'needs_scope' ? 'alert' : 'link')}</span>
              <span class="row__body"><span class="row__t">Google Health</span><span class="row__d">${gText}</span>
              ${w.google.state === 'failed' ? html`<span class="btnrow" data-style="margin-top:8px"><button type="button" class="btn btn--tonal btn--s" data-action="retry-upload">Try again</button></span>` : ''}
              ${w.google.state === 'needs_scope' ? html`<span class="btnrow" data-style="margin-top:8px"><button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-return="/workouts/${encodeURIComponent(w.id)}">Reconnect Google</button></span>` : ''}
              </span></div>` : ''}
          </div>
        </section>

        ${w.readOnly
          ? html`<p class="muted small" data-style="padding:0 4px">This workout lives in Google Health, recorded by your device or another app. It can be seen here but not changed.</p>`
          : html`<div class="group">
              ${!live && w.status !== 'ongoing' ? row({ action: 'edit-times', iconName: 'clock', title: 'Edit times', chevron: true }) : ''}
              ${row({ action: 'edit', iconName: 'edit', title: 'Name and notes', chevron: true })}
              ${row({ action: 'delete', iconName: 'trash', title: 'Delete workout', danger: true })}
            </div>`}
      </div>`);
    stopTimers?.();
    stopTimers = live ? runTimers(root) : null;
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${skeleton('page')}`);
    try {
      const [one, all] = await Promise.all([api.get(base), meta ? Promise.resolve(meta) : api.get('/api/workouts?limit=1').catch(() => null)]);
      w = one; meta = all;
      if (ctx.alive()) paint();
    } catch (err) {
      if (!ctx.alive() || quiet) return;
      if (err.status === 404) {
        mount(root, html`${head({ title: 'Workout', back: '/workouts' })}<div class="group">${empty({ iconName: 'workouts', title: 'This workout is not here', text: 'It may have been deleted, or the link is old.', action: html`<a class="btn btn--tonal btn--s" href="/workouts">Back to workouts</a>` })}</div>`);
      } else mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${errorState(err)}`);
    }
  }

  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="edit"]', () => editSheet(w, meta, () => load({ quiet: true })));
  on(root, 'click', '[data-action="edit-times"]', async () => {
    const t = await timesSheet({ title: 'Edit times', start: w.start, end: w.end ?? w.lastEnd ?? Date.now(), text: 'The heart rate, steps and calories are worked out again for the new times.' });
    if (!t) return;
    try { await api.post(`${base}/save`, t); toast('Times saved'); refreshMe().catch(() => {}); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-action="retry-upload"]', async (e, btn) => {
    try { const r = await busy(btn, () => api.post(`${base}/retry`)); if (r === undefined) return; toast('Trying again'); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-action="delete"]', async () => {
    const saved = w.google?.state === 'saved';
    const yes = await confirm({ title: 'Delete this workout?', text: saved ? 'It is removed here and from Google Health. This cannot be undone.' : 'It is removed from your history. This cannot be undone.', yes: 'Delete', danger: true });
    if (!yes) return;
    try { await api.del(base); toast('Workout deleted'); refreshMe().catch(() => {}); go('/workouts', { replace: true }); } catch (err) { toastError(err); }
  });
  bindWorkoutActions(root, {
    find: () => w,
    done: (payload) => {
      const still = payload.running?.id === id || payload.pending?.some((x) => x.id === id) || payload.history?.some((x) => x.id === id);
      if (still) load({ quiet: true }); else go('/workouts', { replace: true });
    },
  });
  ctx.onLeave(listen('changed', (what) => { if (what.includes('workouts')) load({ quiet: true }); }));
  ctx.onLeave(() => stopTimers?.());
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}

/* ── Hevy import ────────────────────────────────────────────── */

const RESULT = { imported: ['New', 'badge--accent'], merged: ['Merged', 'badge--ok'], skipped: ['Already here', ''] };

async function importer(ctx) {
  const { root } = ctx;
  document.title = 'Import from Hevy · Health';
  let file = null; let text = null; let preview = null; let result = null; let problem = null; let reading = false;

  function report(r, isPreview) {
    const items = r.items || [];
    return html`
      <dl class="group kv kv--3">
        <div><dt>${isPreview ? 'New' : 'Imported'}</dt><dd>${f.int(r.imported)}</dd></div>
        <div><dt>${isPreview ? 'To merge' : 'Merged'}</dt><dd>${f.int(r.merged)}</dd></div>
        <div><dt>${isPreview ? 'Already here' : 'Skipped'}</dt><dd>${f.int(r.skipped)}</dd></div>
      </dl>
      <p class="muted small" data-style="padding:0 4px">${f.plural(r.found, 'workout')} and ${f.plural(r.sets, 'set')} in the file. Merged means the sets ${isPreview ? 'will be' : 'were'} attached to a workout you already have at that time. Already here means it was imported before, so nothing changes.</p>
      ${r.errors?.length ? banner({ tone: 'warn', title: `${f.plural(r.errors.length, 'row')} could not be read`, text: r.errors.slice(0, 4).join(' ') + (r.errors.length > 4 ? ` And ${r.errors.length - 4} more.` : '') }) : ''}
      ${r.unknownExercises?.length ? banner({ title: 'Some exercises were not recognised', text: `${r.unknownExercises.slice(0, 8).join(', ')}${r.unknownExercises.length > 8 ? ` and ${r.unknownExercises.length - 8} more` : ''}. They are imported all the same and counted under "other" in muscle totals.` }) : ''}
      ${items.length ? html`<div class="group">${items.slice(0, 60).map((it) => {
        const [label, tone] = RESULT[it.result] || [it.result, ''];
        const target = it.id || it.mergedInto;
        const inner = html`<span class="row__body"><span class="row__t">${it.title || 'Workout'}</span><span class="row__d">${f.dayMed(f.instDay(it.start))}, ${f.clock(it.start)} · ${f.plural(it.sets, 'set')}</span></span><span class="badge ${tone}">${label}</span>`;
        return !isPreview && target ? html`<a class="row" href="/workouts/${encodeURIComponent(target)}">${inner}</a>` : html`<div class="row">${inner}</div>`;
      })}</div>${items.length > 60 ? html`<p class="muted small" data-style="padding:0 4px">Showing the first 60 of ${f.int(items.length)}.</p>` : ''}` : ''}`;
  }

  function paint() {
    const canWrite = app.me.google?.canWriteWorkouts === true && app.me.google?.state === 'ok';
    let body;
    if (result) {
      body = html`
        ${banner({ tone: 'ok', iconName: 'check', title: result.imported + result.merged > 0 ? 'Import finished' : 'Nothing new in this file', text: result.imported + result.merged > 0 ? `${f.plural(result.imported, 'workout')} added, ${f.int(result.merged)} merged.${result.toUpload ? ` ${f.plural(result.toUpload, 'workout')} will be saved to Google Health shortly.` : ''}` : 'Everything in it was already imported, so nothing changed.' })}
        ${report(result, false)}
        <div class="btnrow"><a class="btn" href="/workouts">See your workouts</a><button type="button" class="btn btn--tonal" data-action="reset">Import another file</button></div>`;
    } else if (preview) {
      const n = preview.imported + preview.merged;
      body = html`
        <div class="sec__head"><h2 class="h2">${file?.name || 'Your file'}</h2><button type="button" class="btn btn--ghost btn--s" data-action="reset">Choose another</button></div>
        ${report(preview, true)}
        ${n > 0 ? html`<div class="group"><div class="row">
          <span class="row__body"><span class="row__t" id="up-l">Also save these to Google Health</span>
          <span class="row__d">${canWrite ? 'Only the ones Google does not already have. Leave it off to keep them in this app only.' : 'Not available: reconnect Google to allow saving workouts.'}</span></span>
          ${toggle('upload', false, { label: 'Also save these to Google Health', disabled: !canWrite })}
        </div></div>` : ''}
        <div class="btnrow">
          <button type="button" class="btn" data-action="import" ${n > 0 ? '' : 'disabled'}>${n > 0 ? `Import ${f.plural(n, 'workout')}` : 'Nothing to import'}</button>
        </div>`;
    } else {
      body = html`
        <section class="panel">
          <h2 class="h3">Get the file from Hevy</h2>
          <ol class="howto" data-style="margin-top:12px">
            <li><span>Open Hevy and go to your <b>Profile</b>, then <b>Settings</b>.</span></li>
            <li><span>Choose <b>Export &amp; Import Data</b>, then <b>Export Workouts</b>.</span></li>
            <li><span>Hevy gives you a file called <b>workouts.csv</b>. Save it to your phone or send it to yourself.</span></li>
          </ol>
        </section>
        ${problem ? banner({ tone: 'bad', title: problem }) : ''}
        <label class="drop" data-drop>
          <input type="file" accept=".csv,text/csv" data-file>
          <span class="empty__ic">${ic('upload')}</span>
          <span class="drop__t">${reading ? 'Reading the file' : 'Choose your Hevy CSV'}</span>
          <span class="muted small">${reading ? 'This takes a moment for a long history.' : 'Up to 5 MB. You see what would change before anything is saved.'}</span>
        </label>
        <p class="muted small" data-style="padding:0 4px">Importing the same file twice is safe: workouts that are already here are skipped.</p>`;
    }
    mount(root, html`${head({ title: 'Import from Hevy', back: '/workouts' })}<div class="stack">${body}</div>`);
  }

  async function choose(picked) {
    problem = null;
    if (!picked) return;
    if (picked.size > MAX_CSV) { problem = `That file is ${(picked.size / 1048576).toFixed(1)} MB. The limit is 5 MB; export a shorter period from Hevy.`; paint(); return; }
    if (picked.size === 0) { problem = 'That file is empty. Export it from Hevy again.'; paint(); return; }
    reading = true; paint();
    try {
      text = await picked.text();
      file = picked;
      preview = await api.upload('/api/workouts/import/hevy?dryRun=1', text, 'text/csv');
    } catch (err) {
      problem = err.status === 400 ? `${err.message} Check that it is the workouts.csv file from Hevy.` : errText(err, 'The file could not be read. Try again.');
      preview = null;
    }
    reading = false;
    if (ctx.alive()) paint();
  }

  on(root, 'change', '[data-file]', (e, input) => choose(input.files?.[0]));
  on(root, 'dragover', '[data-drop]', (e, el) => { e.preventDefault(); el.classList.add('is-over'); });
  on(root, 'dragleave', '[data-drop]', (e, el) => el.classList.remove('is-over'));
  on(root, 'drop', '[data-drop]', (e) => { e.preventDefault(); choose(e.dataTransfer?.files?.[0]); });
  on(root, 'click', '[data-action="reset"]', () => { file = null; text = null; preview = null; result = null; problem = null; paint(); });
  on(root, 'click', '[data-action="import"]', async (e, btn) => {
    const upload = root.querySelector('input[name="upload"]')?.checked ? 1 : 0;
    try {
      const r = await busy(btn, () => api.upload(`/api/workouts/import/hevy?upload=${upload}`, text, 'text/csv'));
      if (r === undefined) return;
      result = r;
      refreshMe().catch(() => {});
      paint();
      window.scrollTo(0, 0);
    } catch (err) { toastError(err, 'The import did not finish. Nothing was half-saved; try again.'); }
  });
  paint();
}

/* ── detection settings ─────────────────────────────────────── */

const FIELDS = [
  ['plusBpm', 'Heart rate above resting', 'bpm', 'How far above your resting heart rate counts as effort.'],
  ['minStartMin', 'Minutes before it asks', 'min', 'How long the effort has to last before you are asked.'],
  ['minTotalMin', 'Shortest workout', 'min', 'Anything shorter is ignored.'],
  ['calmMin', 'Calm minutes that end it', 'min', 'How long your heart rate has to stay down before it counts as over.'],
  ['walkSteps', 'Walking pace', 'steps a minute', 'At or above this, raised heart rate is treated as a walk, not a workout.'],
  ['autoCloseMin', 'Close a forgotten workout after', 'min', 'A workout you started by hand is closed for review after this long with a calm heart rate.'],
];

async function detection(ctx) {
  const { root } = ctx;
  document.title = 'Workout detection · Health';
  let d = null;

  function paint() {
    const det = d.detection || {};
    const s = det.settings || {};
    const locked = !det.available || det.suppressedByLink;
    const b = det.bounds || {};
    mount(root, html`
      ${head({ title: 'Detection', back: '/workouts' })}
      <div class="stack">
        ${!det.available ? banner({ tone: 'warn', title: 'Not available on your device', text: det.reason || 'Workout detection needs minute-by-minute heart rate, which your device does not report.' }) : ''}
        ${det.available && det.suppressedByLink ? banner({ iconName: 'link', title: 'The console module is doing this', text: 'Your console health module is linked and detecting workouts, so this app is not. The settings below are the module\'s to change. Its questions still show up here.' }) : ''}

        <div class="group">
          <div class="row row--top">
            <span class="row__body"><span class="row__t">Notice workouts from my heart rate</span>
            <span class="row__d">Off unless you turn it on. When your heart rate stays up, you are asked once whether a workout started, and once at the end whether to save it.</span></span>
            ${toggle('enabled', Boolean(s.enabled) && det.available, { label: 'Notice workouts from my heart rate', disabled: locked })}
          </div>
        </div>

        ${det.available ? html`<p class="muted small" data-style="padding:0 4px">Your resting heart rate is taken as ${f.int(det.rest)} bpm, so effort starts at ${f.int(det.threshold)} bpm.${det.last?.checkedAt ? ` Last checked ${f.ago(det.last.checkedAt)}.` : ''}${det.last?.error ? ` The last check failed: ${det.last.error}` : ''}</p>` : ''}

        <form class="form" id="det-form" novalidate>
          <section>
            <div class="sec__head"><h2 class="h2">Thresholds</h2></div>
            <div class="group group--pad"><div class="form">
              ${FIELDS.map(([key, label, unit, hint]) => field({
                label: `${label} (${unit})`, name: key, type: 'number', value: s[key] ?? '',
                attrs: `inputmode="numeric" step="1" ${b[key] ? `min="${b[key][0]}" max="${b[key][1]}"` : ''} ${locked ? 'disabled' : ''}`,
                hint: `${hint}${b[key] ? ` ${b[key][0]} to ${b[key][1]}.` : ''}`,
              }))}
            </div></div>
          </section>
          ${d.exerciseTypes?.length ? html`<section>
            <div class="sec__head"><h2 class="h2">Saved to Google Health as</h2></div>
            <div class="group group--pad">${field({ label: 'Kind of exercise', name: 'exerciseType', value: d.exerciseType, options: d.exerciseTypes.map((t) => [t.id, t.label]), hint: 'Used for workouts you start, log, or that are detected.' })}</div>
          </section>` : ''}
          <div class="btnrow">
            <button type="submit" class="btn">Save</button>
            ${det.available && !det.suppressedByLink && s.enabled ? html`<button type="button" class="btn btn--tonal" data-action="check">Check now</button>` : ''}
          </div>
        </form>
      </div>`);
  }

  async function save(body, okText, btn) {
    try {
      const p = await busy(btn, () => api.post('/api/workouts/settings', body));
      if (p === undefined) return;
      d = p; toast(okText); paint();
    } catch (err) { toastError(err); paint(); }
  }

  on(root, 'change', 'input[name="enabled"]', (e, input) => save({ enabled: input.checked }, input.checked ? 'Detection is on' : 'Detection is off', null));
  on(root, 'submit', '#det-form', (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    const body = {};
    const b = d.detection?.bounds || {};
    let bad = false;
    for (const [key] of FIELDS) {
      if (form.elements[key]?.disabled) continue;
      fieldError(form, key, '');
      if (!f.isNum(v[key])) { fieldError(form, key, 'Enter a number.'); bad = true; continue; }
      if (b[key] && (v[key] < b[key][0] || v[key] > b[key][1])) { fieldError(form, key, `Between ${b[key][0]} and ${b[key][1]}.`); bad = true; continue; }
      body[key] = Math.round(v[key]);
    }
    if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    if (v.exerciseType) body.exerciseType = v.exerciseType;
    save(body, 'Saved', form.querySelector('button[type="submit"]'));
  });
  on(root, 'click', '[data-action="check"]', async (e, btn) => {
    try {
      const p = await busy(btn, () => api.post('/api/workouts/check'));
      if (p === undefined) return;
      d = p; refreshMe().catch(() => {});
      toast(p.pending?.length ? 'Found something. Look at your workouts.' : 'Checked. Nothing that looks like a workout right now.');
      paint();
    } catch (err) { toast(err.status === 429 ? 'Checked a moment ago. Try again in half a minute.' : errText(err), { tone: err.status === 429 ? '' : 'bad' }); }
  });
  on(root, 'click', '[data-action="retry"]', () => load());

  async function load() {
    mount(root, html`${head({ title: 'Detection', back: '/workouts' })}${skeleton('form')}`);
    try { d = await api.get('/api/workouts?limit=1'); if (ctx.alive()) paint(); } catch (err) {
      if (ctx.alive()) mount(root, html`${head({ title: 'Detection', back: '/workouts' })}${errorState(err)}`);
    }
  }
  await load();
}

export default async function workouts(ctx) {
  if (ctx.name === 'detail') return detail(ctx);
  if (ctx.name === 'import') return importer(ctx);
  if (ctx.name === 'detection') return detection(ctx);
  return list(ctx);
}
